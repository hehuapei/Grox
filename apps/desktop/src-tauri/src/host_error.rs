//! Host 到 WebView 的统一错误契约。
//!
//! 协议、操作和环境错误必须在原生边界完成分类；前端只负责展示，不能再根据
//! 中文或英文错误文本推断是否重试、暂停队列或要求用户修复环境。

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostError {
    pub(crate) domain: String,
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) recoverable: bool,
    pub(crate) fatal: bool,
    pub(crate) hold_queue: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) action: Option<String>,
}

impl HostError {
    pub(crate) fn protocol(code: &'static str, message: impl Into<String>) -> Self {
        Self::protocol_with_action(
            code,
            message,
            "若持续出现，请升级 Grok Build CLI 并导出会话诊断",
        )
    }

    pub(crate) fn protocol_with_action(
        code: &'static str,
        message: impl Into<String>,
        action: &'static str,
    ) -> Self {
        Self {
            domain: "protocol".into(),
            code: code.into(),
            message: message.into(),
            recoverable: true,
            fatal: false,
            hold_queue: false,
            action: Some(action.into()),
        }
    }

    pub(crate) fn operation(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            domain: "operation".into(),
            code: code.into(),
            message: message.into(),
            recoverable: true,
            fatal: false,
            hold_queue: false,
            action: None,
        }
    }

    pub(crate) fn environment(
        code: &'static str,
        message: impl Into<String>,
        fatal: bool,
        hold_queue: bool,
        action: &'static str,
    ) -> Self {
        Self {
            domain: "environment".into(),
            code: code.into(),
            message: message.into(),
            recoverable: true,
            fatal,
            hold_queue,
            action: Some(action.into()),
        }
    }

    pub(crate) fn recoverable_environment(
        code: &'static str,
        message: impl Into<String>,
        action: &'static str,
    ) -> Self {
        Self::environment(code, message, false, false, action)
    }

    pub(crate) fn for_method(mut self, method: &str) -> Self {
        self.message = format!("{} · {method}", self.message);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_the_shared_frontend_contract() {
        let error = HostError::environment(
            "SECRET_STORE_UNAVAILABLE",
            "无法读取系统凭据库",
            false,
            true,
            "解锁系统凭据库后重试",
        );
        let value = serde_json::to_value(error).unwrap();
        assert_eq!(value["domain"], "environment");
        assert_eq!(value["code"], "SECRET_STORE_UNAVAILABLE");
        assert_eq!(value["recoverable"], true);
        assert_eq!(value["fatal"], false);
        assert_eq!(value["holdQueue"], true);
    }
}
