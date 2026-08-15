//! Host 权限策略的唯一词汇与裁决规则。
//!
//! WebView、队列和自动化只能请求权限模式；当前 Host 偏好是能力上限。
//! 所有会话入口都必须经过 [`restrict_requested_mode`]，不能各自解释字符串。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PermissionMode {
    Default,
    #[default]
    Auto,
    Bypass,
}

impl PermissionMode {
    pub(crate) fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "default" => Some(Self::Default),
            "auto" => Some(Self::Auto),
            "bypass" => Some(Self::Bypass),
            _ => None,
        }
    }

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Auto => "auto",
            Self::Bypass => "bypass",
        }
    }

    const fn rank(self) -> u8 {
        match self {
            Self::Default => 0,
            Self::Auto => 1,
            Self::Bypass => 2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PermissionRestriction {
    pub(crate) effective: PermissionMode,
    pub(crate) reduced: bool,
}

/// 请求值只可降低当前 Host 授权，不能扩大它。
pub(crate) fn restrict_requested_mode(
    host: PermissionMode,
    requested: &str,
) -> Result<PermissionRestriction, ()> {
    let requested = PermissionMode::parse(requested).ok_or(())?;
    let effective = if requested.rank() <= host.rank() {
        requested
    } else {
        host
    };
    Ok(PermissionRestriction {
        effective,
        reduced: effective != requested,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requested_mode_never_exceeds_host_authority() {
        assert_eq!(
            restrict_requested_mode(PermissionMode::Default, "auto").unwrap(),
            PermissionRestriction {
                effective: PermissionMode::Default,
                reduced: true,
            }
        );
        assert_eq!(
            restrict_requested_mode(PermissionMode::Auto, "bypass").unwrap(),
            PermissionRestriction {
                effective: PermissionMode::Auto,
                reduced: true,
            }
        );
        assert_eq!(
            restrict_requested_mode(PermissionMode::Bypass, "default").unwrap(),
            PermissionRestriction {
                effective: PermissionMode::Default,
                reduced: false,
            }
        );
    }

    #[test]
    fn rejects_unknown_permission_vocabulary() {
        assert!(PermissionMode::parse("always-approve").is_none());
        assert!(restrict_requested_mode(PermissionMode::Bypass, "unknown").is_err());
    }
}
