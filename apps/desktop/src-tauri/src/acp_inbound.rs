//! ACP 入站 JSON-RPC 的一次性规范化。
//!
//! stdout 主循环只构造一个 `AcpInbound`，请求表、回合监控、callback、交互
//! 与会话投影读取同一份 method/params/id，避免各自解释 x.ai wrapper。

use serde_json::Value;

#[derive(Debug)]
pub(crate) struct AcpInbound {
    method: Option<String>,
    params: Value,
    id: Option<Value>,
    has_id: bool,
}

#[derive(Debug)]
pub(crate) enum AcpInboundError {
    InvalidJson(String),
    InvalidMessage(String),
}

impl AcpInbound {
    pub(crate) fn parse(line: &str) -> Result<Self, AcpInboundError> {
        let message = match serde_json::from_str::<Value>(line) {
            Ok(Value::Object(message)) => message,
            Ok(_) => {
                return Err(AcpInboundError::InvalidMessage(
                    "Grok Build 返回的 ACP 消息不是 JSON 对象".into(),
                ))
            }
            Err(error) => {
                return Err(AcpInboundError::InvalidJson(format!(
                    "Grok Build 返回了无法解析的 ACP 消息：{error}"
                )))
            }
        };
        let has_id = message.contains_key("id");
        let id = message.get("id").cloned();
        let raw_method = message.get("method").and_then(Value::as_str);
        if message.contains_key("method") && raw_method.is_none() {
            return Err(AcpInboundError::InvalidMessage(
                "Grok Build 返回的 ACP method 不是字符串".into(),
            ));
        }
        let raw_params = message.get("params").cloned().unwrap_or(Value::Null);
        let (method, params) = match raw_method {
            Some(method) if method.starts_with("_x.ai/") => {
                let nested = raw_params
                    .get("method")
                    .and_then(Value::as_str)
                    .zip(raw_params.get("params"));
                match nested {
                    Some((method, params)) if method.starts_with("x.ai/") => {
                        (Some(method.to_string()), params.clone())
                    }
                    _ => (Some(method[1..].to_string()), raw_params),
                }
            }
            Some(method) => (Some(method.to_string()), raw_params),
            None => (None, raw_params),
        };
        if method.as_deref().is_some_and(|method| {
            method.is_empty()
                || method.chars().count() > 512
                || method.chars().any(char::is_control)
        }) {
            return Err(AcpInboundError::InvalidMessage(
                "Grok Build 返回的 ACP method 无效".into(),
            ));
        }
        Ok(Self {
            method,
            params,
            id,
            has_id,
        })
    }

    pub(crate) fn method(&self) -> Option<&str> {
        self.method.as_deref()
    }

    pub(crate) fn params(&self) -> &Value {
        &self.params
    }

    pub(crate) fn id(&self) -> Option<&Value> {
        self.id.as_ref()
    }

    pub(crate) fn has_id(&self) -> bool {
        self.has_id
    }
}

impl AcpInboundError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::InvalidJson(_) => "ACP_INVALID_JSON",
            Self::InvalidMessage(_) => "ACP_INVALID_MESSAGE",
        }
    }

    pub(crate) fn message(&self) -> &str {
        match self {
            Self::InvalidJson(message) | Self::InvalidMessage(message) => message,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unwraps_xai_extension_once() {
        let inbound = AcpInbound::parse(
            r#"{"jsonrpc":"2.0","method":"_x.ai/wrapped","params":{"method":"x.ai/session/update","params":{"sessionId":"s1"}}}"#,
        )
        .unwrap();
        assert_eq!(inbound.method(), Some("x.ai/session/update"));
        assert_eq!(inbound.params()["sessionId"], "s1");
        assert!(!inbound.has_id());
    }

    #[test]
    fn preserves_null_request_id_presence() {
        let inbound = AcpInbound::parse(
            r#"{"jsonrpc":"2.0","id":null,"method":"x.ai/unknown","params":{}}"#,
        )
        .unwrap();
        assert!(inbound.has_id());
        assert_eq!(inbound.id(), Some(&Value::Null));
    }

    #[test]
    fn rejects_oversized_method_before_any_domain_router_sees_it() {
        let line = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "x".repeat(513),
            "params": {},
        })
        .to_string();
        assert!(matches!(
            AcpInbound::parse(&line),
            Err(AcpInboundError::InvalidMessage(_))
        ));
    }
}
