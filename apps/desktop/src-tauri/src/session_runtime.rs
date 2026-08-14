//! 会话创建、恢复与本机能力资源的 Host 事务边界。

use std::{path::Path, sync::Arc};

use serde::{Deserialize, Serialize};

use crate::{
    acp_host::AcpHostError,
    browser_mcp, checked_reasoning_effort, computer_mcp, computer_use_gate_open, config_path,
    ensure_computer_plugin, ensure_main_acp_owner, host_prefs, host_prefs_dir_for_app,
    mcp_leases::{self, McpLeaseStore, SessionLeaseBinding},
    path_sandbox::{checked_workspace, path_for_webview},
    read_bounded_text, request_acp_json, AcpState, MAX_CONFIG_BYTES, UPSTREAM_CLI_CLIENT_NAME,
};

struct ComputerSessionExtensions {
    plugin_dirs: Vec<String>,
    lease_id: String,
}

struct BrowserSessionExtensions {
    lease_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenAgentSessionRequest {
    cwd: String,
    generation: u64,
    session_id: Option<String>,
    preferred_model: Option<String>,
    reasoning_effort: Option<String>,
    permission_mode: String,
    computer_use_enabled: bool,
    browser_use_enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenAgentSessionResult {
    response: serde_json::Value,
    warnings: Vec<AcpHostError>,
}

#[derive(Default)]
struct SessionExtensionAttempt {
    plugin_dirs: Vec<String>,
    leases: SessionLeaseBinding,
}

fn start_computer_session_extensions(
    leases: &McpLeaseStore,
) -> Result<ComputerSessionExtensions, String> {
    // Host 偏好是桌面控制能力的最终门禁；调用者只能表达是否需要挂载。
    if !computer_use_gate_open() {
        return Ok(ComputerSessionExtensions {
            plugin_dirs: Vec::new(),
            lease_id: String::new(),
        });
    }
    let mut lease_bytes = [0_u8; 16];
    getrandom::fill(&mut lease_bytes)
        .map_err(|error| format!("无法创建 Computer Use 租约：{error}"))?;
    let lease_id = lease_bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    computer_mcp::clear_emergency_stop(&lease_id)?;
    // 只要 Host 能观察桌面就挂载真实 harness；Windows 提供完整 UIA，
    // macOS/Linux 保持相同 MCP 表面并按平台能力降级。
    let plugin = ensure_computer_plugin()?;
    let endpoint = computer_mcp::serve_http(lease_id.clone())?;
    if let Err(error) = leases.put_computer(
        lease_id.clone(),
        mcp_leases::computer_server_config(&endpoint.url, &endpoint.token),
    ) {
        computer_mcp::shutdown_http(&lease_id);
        return Err(error);
    }
    Ok(ComputerSessionExtensions {
        plugin_dirs: vec![path_for_webview(&plugin)],
        lease_id,
    })
}

fn shutdown_computer_lease(leases: &McpLeaseStore, lease_id: &str) {
    leases.remove_computer(lease_id);
    computer_mcp::shutdown_http(lease_id);
}

fn shutdown_browser_lease(leases: &McpLeaseStore, lease_id: &str) {
    leases.remove_browser(lease_id);
    browser_mcp::shutdown_http(lease_id);
}

fn shutdown_session_resources(leases: &McpLeaseStore, session_id: &str) {
    let binding = leases.take_session(session_id);
    if let Some(lease_id) = binding.computer {
        let _ = computer_mcp::clear_emergency_stop(&lease_id);
        shutdown_computer_lease(leases, &lease_id);
    }
    if let Some(lease_id) = binding.browser {
        shutdown_browser_lease(leases, &lease_id);
    }
}
pub(crate) fn shutdown_all_mcp_resources(leases: &McpLeaseStore) {
    let (computer, browser) = leases.drain_all();
    for lease_id in computer {
        let _ = computer_mcp::clear_emergency_stop(&lease_id);
        computer_mcp::shutdown_http(&lease_id);
    }
    for lease_id in browser {
        browser_mcp::shutdown_http(&lease_id);
    }
}

#[tauri::command]
pub(crate) fn computer_shutdown_all_leases(
    window: tauri::WebviewWindow,
    leases: tauri::State<'_, Arc<McpLeaseStore>>,
) -> Result<(), String> {
    ensure_main_acp_owner(window.label())?;
    for lease_id in leases.drain_computer() {
        let _ = computer_mcp::mark_emergency_stop(&lease_id);
        computer_mcp::shutdown_http(&lease_id);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn computer_emergency_stop_session(
    window: tauri::WebviewWindow,
    leases: tauri::State<'_, Arc<McpLeaseStore>>,
    session_id: String,
) -> Result<(), String> {
    ensure_main_acp_owner(window.label())?;
    let Some(lease_id) = leases.computer_for_session(session_id.trim()) else {
        return Ok(());
    };
    computer_mcp::mark_emergency_stop(&lease_id)?;
    shutdown_computer_lease(leases.inner(), &lease_id);
    Ok(())
}

fn discard_session_extension_attempt(
    leases: &McpLeaseStore,
    attempt: &mut SessionExtensionAttempt,
) {
    if let Some(lease_id) = attempt.leases.computer.take() {
        shutdown_computer_lease(leases, &lease_id);
    }
    if let Some(lease_id) = attempt.leases.browser.take() {
        shutdown_browser_lease(leases, &lease_id);
    }
    attempt.plugin_dirs.clear();
}

fn shutdown_replaced_session_resources(
    leases: &McpLeaseStore,
    previous: SessionLeaseBinding,
    current: &SessionLeaseBinding,
) {
    if let Some(lease_id) = previous.computer {
        if current.computer.as_deref() != Some(lease_id.as_str()) {
            let _ = computer_mcp::clear_emergency_stop(&lease_id);
            shutdown_computer_lease(leases, &lease_id);
        }
    }
    if let Some(lease_id) = previous.browser {
        if current.browser.as_deref() != Some(lease_id.as_str()) {
            shutdown_browser_lease(leases, &lease_id);
        }
    }
}

#[tauri::command]
pub(crate) fn browser_shutdown_all_leases(
    window: tauri::WebviewWindow,
    leases: tauri::State<'_, Arc<McpLeaseStore>>,
) -> Result<(), String> {
    ensure_main_acp_owner(window.label())?;
    for lease_id in leases.drain_browser() {
        browser_mcp::shutdown_http(&lease_id);
    }
    Ok(())
}

fn start_browser_session_extensions(
    leases: &McpLeaseStore,
) -> Result<BrowserSessionExtensions, String> {
    let mut lease_bytes = [0_u8; 16];
    getrandom::fill(&mut lease_bytes)
        .map_err(|error| format!("无法创建 Browser Use 租约：{error}"))?;
    let lease_id = lease_bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let endpoint = browser_mcp::serve_http(lease_id.clone())?;
    if let Err(error) = leases.put_browser(
        lease_id.clone(),
        mcp_leases::browser_server_config(&endpoint.url, &endpoint.token),
    ) {
        browser_mcp::shutdown_http(&lease_id);
        return Err(error);
    }
    Ok(BrowserSessionExtensions { lease_id })
}

fn checked_session_value(
    value: &str,
    field: &'static str,
    max_chars: usize,
) -> Result<String, AcpHostError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max_chars || value.chars().any(char::is_control)
    {
        return Err(AcpHostError::protocol(
            "ACP_INVALID_REQUEST",
            format!("{field} 无效"),
        ));
    }
    Ok(value.to_string())
}

fn effective_session_permission_mode(
    requested: &str,
    host_attested: &str,
) -> Result<(&'static str, bool), AcpHostError> {
    let requested = host_prefs::normalize_permission_mode(requested)
        .ok_or_else(|| AcpHostError::protocol("ACP_INVALID_PERMISSION_MODE", "无效的权限模式"))?;
    let bypass_rejected = requested == "bypass"
        && host_prefs::normalize_permission_mode(host_attested) != Some("bypass");
    Ok((
        if bypass_rejected {
            "default"
        } else {
            requested
        },
        bypass_rejected,
    ))
}

fn session_open_params(
    cwd: &Path,
    session_id: Option<&str>,
    preferred_model: Option<&str>,
    reasoning_effort: Option<&str>,
    permission_mode: &str,
    system_prompt: Option<&str>,
    attempt: &SessionExtensionAttempt,
) -> serde_json::Value {
    let mut meta = serde_json::Map::new();
    meta.insert(
        "clientIdentifier".into(),
        serde_json::Value::String(UPSTREAM_CLI_CLIENT_NAME.into()),
    );
    meta.insert(
        "yoloMode".into(),
        serde_json::Value::Bool(permission_mode == "bypass"),
    );
    meta.insert(
        "autoMode".into(),
        serde_json::Value::Bool(permission_mode == "auto"),
    );
    if let Some(system_prompt) = system_prompt {
        meta.insert(
            "systemPromptOverride".into(),
            serde_json::Value::String(system_prompt.into()),
        );
    }
    if session_id.is_none() {
        if let Some(model) = preferred_model {
            meta.insert("modelId".into(), serde_json::Value::String(model.into()));
        }
        if let Some(effort) = reasoning_effort {
            meta.insert(
                "reasoningEffort".into(),
                serde_json::Value::String(effort.into()),
            );
        }
    }
    if !attempt.plugin_dirs.is_empty() {
        meta.insert("pluginDirs".into(), serde_json::json!(attempt.plugin_dirs));
    }
    if let Some(lease_id) = attempt.leases.computer.as_deref() {
        meta.insert(
            "groxComputerLeaseId".into(),
            serde_json::Value::String(lease_id.into()),
        );
    }
    if let Some(lease_id) = attempt.leases.browser.as_deref() {
        meta.insert(
            "groxBrowserLeaseId".into(),
            serde_json::Value::String(lease_id.into()),
        );
    }

    let mut params = serde_json::Map::new();
    params.insert(
        "cwd".into(),
        serde_json::Value::String(path_for_webview(cwd)),
    );
    params.insert("mcpServers".into(), serde_json::Value::Array(Vec::new()));
    params.insert("_meta".into(), serde_json::Value::Object(meta));
    if let Some(session_id) = session_id {
        params.insert(
            "sessionId".into(),
            serde_json::Value::String(session_id.into()),
        );
    }
    serde_json::Value::Object(params)
}

fn prepare_session_extensions(
    leases: &McpLeaseStore,
    request: &OpenAgentSessionRequest,
    permission_mode: &str,
    warnings: &mut Vec<AcpHostError>,
) -> Result<SessionExtensionAttempt, AcpHostError> {
    let mut attempt = SessionExtensionAttempt::default();
    if request.computer_use_enabled && permission_mode != "bypass" {
        let computer = start_computer_session_extensions(leases).map_err(|error| {
            AcpHostError::environment(
                "COMPUTER_MCP_START_FAILED",
                error,
                false,
                false,
                "检查 Computer Use 系统权限，或在设置中关闭后重试",
            )
        })?;
        attempt.plugin_dirs = computer.plugin_dirs;
        if computer.lease_id.is_empty() {
            warnings.push(AcpHostError::operation(
                "COMPUTER_USE_NOT_AUTHORIZED",
                "Computer Use 未获 Host 授权，本会话未挂载桌面控制能力",
            ));
        } else {
            attempt.leases.computer = Some(computer.lease_id);
        }
    }
    if request.browser_use_enabled {
        match start_browser_session_extensions(leases) {
            Ok(browser) => attempt.leases.browser = Some(browser.lease_id),
            Err(error) => warnings.push(AcpHostError::environment(
                "BROWSER_MCP_START_FAILED",
                error,
                false,
                false,
                "检查本机 Chrome/Edge 是否可用，或在设置中关闭 Browser Use",
            )),
        }
    }
    Ok(attempt)
}

/// Host 完整拥有 session/new|load：配置、能力租约、生命周期互斥、兼容重试与绑定。
#[tauri::command]
pub(crate) async fn open_agent_session(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AcpState>>,
    leases: tauri::State<'_, Arc<McpLeaseStore>>,
    request: OpenAgentSessionRequest,
) -> Result<OpenAgentSessionResult, AcpHostError> {
    ensure_main_acp_owner(window.label())
        .map_err(|error| AcpHostError::operation("ACP_WINDOW_NOT_OWNER", error))?;
    {
        let process = state.process.lock().await;
        if !process
            .as_ref()
            .is_some_and(|process| process.generation == request.generation)
        {
            return Err(AcpHostError::environment(
                "ACP_CHANNEL_REPLACED",
                "ACP 通道已切换，无法在旧运行时打开会话",
                true,
                true,
                "等待 Agent 重连完成后重新打开会话",
            ));
        }
    }
    let cwd = checked_workspace(&request.cwd).map_err(|error| {
        AcpHostError::environment(
            "SESSION_WORKSPACE_INVALID",
            error,
            false,
            false,
            "重新选择一个可访问的项目目录",
        )
    })?;
    let session_id = request
        .session_id
        .as_deref()
        .map(|value| checked_session_value(value, "sessionId", 512))
        .transpose()?;
    let preferred_model = request
        .preferred_model
        .as_deref()
        .map(|value| checked_session_value(value, "modelId", 256))
        .transpose()?;
    let reasoning_effort = checked_reasoning_effort(request.reasoning_effort.clone())
        .map_err(|error| AcpHostError::protocol("ACP_INVALID_REASONING_EFFORT", error))?;
    let host_permission_mode =
        host_prefs::load_prefs(&host_prefs_dir_for_app(&app)).permission_mode;
    let (permission_mode, bypass_rejected) =
        effective_session_permission_mode(&request.permission_mode, &host_permission_mode)?;
    let (system_prompt_path, _, _) = config_path("system-prompt", &cwd).map_err(|error| {
        AcpHostError::environment(
            "SESSION_SYSTEM_PROMPT_UNAVAILABLE",
            error,
            false,
            false,
            "检查 Grok 配置目录后重试",
        )
    })?;
    let system_prompt = read_bounded_text(&system_prompt_path, MAX_CONFIG_BYTES)
        .map_err(|error| {
            AcpHostError::environment(
                "SESSION_SYSTEM_PROMPT_READ_FAILED",
                error,
                false,
                false,
                "修复系统提示词文件权限或内容后重试",
            )
        })?
        .trim()
        .to_string();

    let permit = state.sessions.acquire_lifecycle(request.generation).await?;
    let mut warnings = Vec::new();
    if bypass_rejected {
        warnings.push(AcpHostError::operation(
            "PERMISSION_BYPASS_NOT_AUTHORIZED",
            "Host 未确认 Bypass/YOLO，本会话已使用默认审批模式",
        ));
    }
    let mut attempt =
        prepare_session_extensions(leases.inner(), &request, permission_mode, &mut warnings)?;
    let method = if session_id.is_some() {
        "session/load"
    } else {
        "session/new"
    };
    let timeout_ms = if session_id.is_some() {
        2 * 60_000
    } else {
        30_000
    };
    let send = |attempt: &SessionExtensionAttempt| {
        request_acp_json(
            state.inner(),
            leases.inner(),
            method,
            session_open_params(
                &cwd,
                session_id.as_deref(),
                preferred_model.as_deref(),
                reasoning_effort.as_deref(),
                permission_mode,
                (!system_prompt.is_empty()).then_some(system_prompt.as_str()),
                attempt,
            ),
            request.generation,
            timeout_ms,
            Some(permit.token()),
        )
    };

    let had_extensions = attempt.leases.computer.is_some()
        || attempt.leases.browser.is_some()
        || !attempt.plugin_dirs.is_empty();
    let response = match send(&attempt).await {
        Ok(response) => response,
        Err(error) if error.code == "ACP_RPC_INVALID_PARAMS" && had_extensions => {
            discard_session_extension_attempt(leases.inner(), &mut attempt);
            warnings.push(AcpHostError::protocol(
                "ACP_SESSION_EXTENSIONS_UNSUPPORTED",
                "当前 Grok Build 不接受桌面扩展参数，本会话已不挂载 Computer/Browser Use",
            ));
            send(&attempt).await?
        }
        Err(error) => {
            discard_session_extension_attempt(leases.inner(), &mut attempt);
            return Err(error);
        }
    };
    let bound_session_id = match session_id {
        Some(session_id) => Ok(session_id),
        None => response
            .get("sessionId")
            .and_then(serde_json::Value::as_str)
            .map(|value| checked_session_value(value, "session/new sessionId", 512))
            .transpose()
            .and_then(|value| {
                value.ok_or_else(|| {
                    AcpHostError::protocol("ACP_INVALID_RESPONSE", "session/new 未返回 sessionId")
                })
            }),
    };
    let bound_session_id = match bound_session_id {
        Ok(session_id) => session_id,
        Err(error) => {
            discard_session_extension_attempt(leases.inner(), &mut attempt);
            return Err(error);
        }
    };
    let binding = std::mem::take(&mut attempt.leases);
    let previous = leases.bind_session(bound_session_id, binding.clone());
    shutdown_replaced_session_resources(leases.inner(), previous, &binding);
    Ok(OpenAgentSessionResult { response, warnings })
}

#[tauri::command]
pub(crate) async fn close_agent_session(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AcpState>>,
    leases: tauri::State<'_, Arc<McpLeaseStore>>,
    session_id: String,
    generation: u64,
) -> Result<(), AcpHostError> {
    ensure_main_acp_owner(window.label())
        .map_err(|error| AcpHostError::operation("ACP_WINDOW_NOT_OWNER", error))?;
    let session_id = checked_session_value(&session_id, "sessionId", 512)?;
    match request_acp_json(
        state.inner(),
        leases.inner(),
        "session/close",
        serde_json::json!({ "sessionId": session_id }),
        generation,
        30_000,
        None,
    )
    .await
    {
        Ok(_) => {}
        Err(error) if error.code == "ACP_RPC_METHOD_NOT_FOUND" => {
            request_acp_json(
                state.inner(),
                leases.inner(),
                "x.ai/session/close",
                serde_json::json!({ "sessionId": session_id }),
                generation,
                30_000,
                None,
            )
            .await?;
        }
        Err(error) => return Err(error),
    }
    shutdown_session_resources(leases.inner(), &session_id);
    Ok(())
}

#[tauri::command]
pub(crate) async fn delete_agent_session(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AcpState>>,
    leases: tauri::State<'_, Arc<McpLeaseStore>>,
    session_id: String,
    cwd: String,
    generation: u64,
) -> Result<(), AcpHostError> {
    ensure_main_acp_owner(window.label())
        .map_err(|error| AcpHostError::operation("ACP_WINDOW_NOT_OWNER", error))?;
    let session_id = checked_session_value(&session_id, "sessionId", 512)?;
    let cwd = checked_workspace(&cwd).map_err(|error| {
        AcpHostError::environment(
            "SESSION_WORKSPACE_INVALID",
            error,
            false,
            false,
            "重新选择一个可访问的项目目录",
        )
    })?;
    request_acp_json(
        state.inner(),
        leases.inner(),
        "x.ai/session/delete",
        serde_json::json!({
            "sessionId": session_id,
            "cwd": path_for_webview(&cwd),
            "kind": "build",
        }),
        generation,
        30_000,
        None,
    )
    .await?;
    shutdown_session_resources(leases.inner(), &session_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_session_open_params_scope_new_options_and_native_leases() {
        let cwd = std::env::temp_dir();
        let attempt = SessionExtensionAttempt {
            plugin_dirs: vec!["/native/plugin".into()],
            leases: SessionLeaseBinding {
                computer: Some("computer-lease".into()),
                browser: Some("browser-lease".into()),
            },
        };
        let new_params = session_open_params(
            &cwd,
            None,
            Some("grok-build"),
            Some("high"),
            "auto",
            Some("system"),
            &attempt,
        );
        assert_eq!(new_params["mcpServers"], serde_json::json!([]));
        assert_eq!(new_params["_meta"]["modelId"], "grok-build");
        assert_eq!(new_params["_meta"]["reasoningEffort"], "high");
        assert_eq!(new_params["_meta"]["groxComputerLeaseId"], "computer-lease");
        assert_eq!(new_params["_meta"]["groxBrowserLeaseId"], "browser-lease");

        let load_params = session_open_params(
            &cwd,
            Some("session-a"),
            Some("must-not-bind-on-load"),
            Some("max"),
            "default",
            None,
            &SessionExtensionAttempt::default(),
        );
        assert_eq!(load_params["sessionId"], "session-a");
        assert!(load_params["_meta"].get("modelId").is_none());
        assert!(load_params["_meta"].get("reasoningEffort").is_none());
    }

    #[test]
    fn host_session_identifiers_reject_control_characters_and_oversize_values() {
        assert_eq!(
            checked_session_value(" session-a ", "sessionId", 32).unwrap(),
            "session-a"
        );
        assert!(checked_session_value("session\npoison", "sessionId", 32).is_err());
        assert!(checked_session_value(&"x".repeat(33), "sessionId", 32).is_err());
    }

    #[test]
    fn session_bypass_requires_host_attestation() {
        assert_eq!(
            effective_session_permission_mode("bypass", "auto").unwrap(),
            ("default", true)
        );
        assert_eq!(
            effective_session_permission_mode("bypass", "bypass").unwrap(),
            ("bypass", false)
        );
        assert_eq!(
            effective_session_permission_mode("auto", "bypass").unwrap(),
            ("auto", false)
        );
    }
}
