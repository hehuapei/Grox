//! Grok Build ACP 连接握手。
//!
//! 进程、请求表和就绪代次都属于 Host；WebView 只消费这次连接的能力与认证快照。
//! 交互式 OAuth 仍由显式用户操作触发，避免后台连接擅自打开浏览器。

use serde_json::{json, Value};

use crate::{
    acp_host::AcpHostError, request_acp_json, AcpState, McpLeaseStore, UPSTREAM_CLI_CLIENT_NAME,
};

const INITIALIZE_TIMEOUT_MS: u64 = 15_000;
const AUTHENTICATE_TIMEOUT_MS: u64 = 10_000;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentAuthenticationState {
    pub(crate) required: bool,
    pub(crate) in_progress: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) method_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentRuntimeConnection {
    pub(crate) generation: u64,
    pub(crate) initialize: Value,
    pub(crate) auth: AgentAuthenticationState,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AuthenticationPlan {
    method_id: Option<String>,
    interactive_method_id: Option<String>,
    interactive_label: Option<String>,
    requires_interaction_first: bool,
}

pub(crate) async fn initialize(
    state: &AcpState,
    leases: &McpLeaseStore,
    generation: u64,
    client_version: Option<&str>,
) -> Result<Value, AcpHostError> {
    request_acp_json(
        state,
        leases,
        "initialize",
        initialize_params(client_version),
        generation,
        INITIALIZE_TIMEOUT_MS,
        None,
    )
    .await
}

pub(crate) async fn authenticate(
    state: &AcpState,
    leases: &McpLeaseStore,
    generation: u64,
    initialize: &Value,
) -> AgentAuthenticationState {
    let plan = authentication_plan(initialize);
    if plan.requires_interaction_first {
        return interactive_auth_state(&plan, None);
    }
    let Some(method_id) = plan.method_id.as_deref() else {
        return AgentAuthenticationState {
            required: false,
            in_progress: false,
            method_id: None,
            label: None,
            error: None,
        };
    };

    match request_acp_json(
        state,
        leases,
        "authenticate",
        json!({ "methodId": method_id }),
        generation,
        AUTHENTICATE_TIMEOUT_MS,
        None,
    )
    .await
    {
        Ok(_) => AgentAuthenticationState {
            required: false,
            in_progress: false,
            method_id: Some(method_id.to_string()),
            label: None,
            error: None,
        },
        Err(_error) if plan.interactive_method_id.is_some() => interactive_auth_state(&plan, None),
        Err(error) => AgentAuthenticationState {
            required: false,
            in_progress: false,
            method_id: None,
            label: None,
            error: Some(error.message),
        },
    }
}

fn interactive_auth_state(
    plan: &AuthenticationPlan,
    error: Option<String>,
) -> AgentAuthenticationState {
    AgentAuthenticationState {
        required: plan.interactive_method_id.is_some(),
        in_progress: false,
        method_id: plan.interactive_method_id.clone(),
        label: plan
            .interactive_label
            .clone()
            .or_else(|| Some("Sign in to Grok".into())),
        error,
    }
}

fn initialize_params(client_version: Option<&str>) -> Value {
    let mut params = json!({
        "protocolVersion": 1,
        "clientCapabilities": {
            "fs": { "readTextFile": true, "writeTextFile": true },
            "terminal": false,
        },
        "clientInfo": {
            "name": UPSTREAM_CLI_CLIENT_NAME,
            "title": "Grok Build CLI",
            "version": client_version.unwrap_or(crate::CLIENT_VERSION),
        },
        "_meta": {
            "clientIdentifier": UPSTREAM_CLI_CLIENT_NAME,
            "clientType": "shell",
        },
    });
    if let Some(client_version) = client_version {
        params["_meta"]["clientVersion"] = Value::String(client_version.to_string());
    }
    params
}

fn authentication_plan(initialize: &Value) -> AuthenticationPlan {
    let methods = initialize
        .get("authMethods")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let first = methods.first();
    let first_id = first
        .and_then(|method| method.get("id"))
        .and_then(Value::as_str);
    let interactive = methods.iter().find(|method| {
        matches!(
            method.get("id").and_then(Value::as_str),
            Some("grok.com" | "oidc")
        )
    });
    let interactive_method_id = interactive
        .and_then(|method| method.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let interactive_label = interactive
        .and_then(|method| method.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let default_id = initialize
        .pointer("/_meta/defaultAuthMethodId")
        .and_then(Value::as_str)
        .filter(|default_id| {
            methods
                .iter()
                .any(|method| method.get("id").and_then(Value::as_str) == Some(*default_id))
        });
    let requires_interaction_first = matches!(first_id, Some("grok.com" | "oidc"));
    let method_id = if requires_interaction_first {
        first_id
    } else {
        default_id.or(first_id)
    }
    .map(str::to_string);

    AuthenticationPlan {
        method_id,
        interactive_method_id,
        interactive_label,
        requires_interaction_first,
    }
}

pub(crate) fn interactive_auth_method(initialize: &Value) -> Option<(String, String)> {
    let plan = authentication_plan(initialize);
    Some((
        plan.interactive_method_id?,
        plan.interactive_label
            .unwrap_or_else(|| "Sign in to Grok".into()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_preserves_official_cli_identity() {
        let params = initialize_params(Some("0.2.106"));
        assert_eq!(params["clientInfo"]["name"], "grok-shell");
        assert_eq!(params["clientInfo"]["version"], "0.2.106");
        assert_eq!(params["_meta"]["clientIdentifier"], "grok-shell");
        assert_eq!(params["_meta"]["clientVersion"], "0.2.106");
    }

    #[test]
    fn unknown_cli_version_is_not_asserted_in_proxy_metadata() {
        let params = initialize_params(None);
        assert_eq!(params["clientInfo"]["version"], crate::CLIENT_VERSION);
        assert!(params["_meta"].get("clientVersion").is_none());
    }

    #[test]
    fn empty_auth_methods_mean_no_authentication() {
        assert_eq!(
            authentication_plan(&json!({ "authMethods": [] })),
            AuthenticationPlan {
                method_id: None,
                interactive_method_id: None,
                interactive_label: None,
                requires_interaction_first: false,
            }
        );
    }

    #[test]
    fn cached_auth_uses_default_and_keeps_interactive_recovery() {
        assert_eq!(
            authentication_plan(&json!({
                "authMethods": [
                    { "id": "api_key", "name": "API key" },
                    { "id": "cached_token", "name": "Cached token" },
                    { "id": "grok.com", "name": "Grok account" }
                ],
                "_meta": { "defaultAuthMethodId": "cached_token" }
            })),
            AuthenticationPlan {
                method_id: Some("cached_token".into()),
                interactive_method_id: Some("grok.com".into()),
                interactive_label: Some("Grok account".into()),
                requires_interaction_first: false,
            }
        );
    }

    #[test]
    fn leading_oauth_never_starts_without_user_action() {
        let plan = authentication_plan(&json!({
            "authMethods": [
                { "id": "oidc", "name": "Sign in" },
                { "id": "cached_token", "name": "Cached token" }
            ]
        }));
        assert!(plan.requires_interaction_first);
        assert_eq!(plan.method_id.as_deref(), Some("oidc"));
        assert_eq!(plan.interactive_method_id.as_deref(), Some("oidc"));
    }

    #[test]
    fn interactive_method_is_derived_from_host_initialize_snapshot() {
        assert_eq!(
            interactive_auth_method(&json!({
                "authMethods": [
                    { "id": "api_key", "name": "API key" },
                    { "id": "grok.com", "name": "Grok account" }
                ]
            })),
            Some(("grok.com".into(), "Grok account".into()))
        );
    }
}
