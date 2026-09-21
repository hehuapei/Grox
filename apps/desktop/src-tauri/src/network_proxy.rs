//! 本机 HTTP/HTTPS 代理：持久化设置，并注入 CLI / Git / HTTP 客户端。
//!
//! 只允许回环地址，避免把流量送到任意远程代理。

use crate::host_core::{atomic_write, grok_home, read_bounded_text, restrict_private_file};
use crate::provider_service::is_loopback_host;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::process::Command;

const GROX_NETWORK_PROXY_FILE: &str = "grox-network-proxy.json";
const DEFAULT_NETWORK_PROXY_URL: &str = "http://127.0.0.1:1080";
const PROXY_ENV_KEYS: [&str; 6] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
];
const NO_PROXY_VALUE: &str = "localhost,127.0.0.1,::1";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetworkProxyConfig {
    pub(crate) enabled: bool,
    pub(crate) url: String,
}

impl Default for NetworkProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            url: DEFAULT_NETWORK_PROXY_URL.into(),
        }
    }
}

fn network_proxy_path() -> Result<std::path::PathBuf, String> {
    Ok(grok_home()?.join(GROX_NETWORK_PROXY_FILE))
}

pub(crate) fn checked_network_proxy(
    mut value: NetworkProxyConfig,
) -> Result<NetworkProxyConfig, String> {
    value.url = value.url.trim().to_string();
    if value.url.is_empty() && !value.enabled {
        value.url = DEFAULT_NETWORK_PROXY_URL.into();
        return Ok(value);
    }
    let parsed =
        url::Url::parse(&value.url).map_err(|error| format!("无效的本地代理地址：{error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("本地代理仅支持 http:// 或 https:// 地址".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("本地代理地址不能包含用户名或密码".into());
    }
    if !is_loopback_host(parsed.host_str()) {
        return Err("代理必须指向本机 localhost、127.0.0.1 或 ::1".into());
    }
    if parsed.port().is_none() {
        return Err("本地代理地址必须包含端口".into());
    }
    if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("本地代理地址不能包含路径、查询参数或片段".into());
    }
    value.url = parsed.as_str().trim_end_matches('/').to_string();
    Ok(value)
}

fn read_network_proxy_file() -> Result<NetworkProxyConfig, String> {
    let path = network_proxy_path()?;
    if !path.exists() {
        return Ok(NetworkProxyConfig::default());
    }
    let content = read_bounded_text(&path, 16 * 1024)?;
    let value = serde_json::from_str(&content)
        .map_err(|error| format!("无法读取网络代理设置 {}：{error}", path.display()))?;
    checked_network_proxy(value)
}

fn write_network_proxy_file(value: NetworkProxyConfig) -> Result<NetworkProxyConfig, String> {
    let value = checked_network_proxy(value)?;
    let path = network_proxy_path()?;
    let content = serde_json::to_string_pretty(&value)
        .map_err(|error| format!("无法序列化网络代理设置：{error}"))?;
    atomic_write(&path, &content)?;
    restrict_private_file(&path)?;
    Ok(value)
}

#[tauri::command]
pub(crate) fn read_network_proxy() -> Result<NetworkProxyConfig, String> {
    read_network_proxy_file()
}

#[tauri::command]
pub(crate) fn write_network_proxy(
    request: NetworkProxyConfig,
) -> Result<NetworkProxyConfig, String> {
    write_network_proxy_file(request)
}

pub(crate) fn apply_network_proxy_environment(command: &mut Command) -> Result<(), String> {
    let value = read_network_proxy_file()?;
    for key in PROXY_ENV_KEYS {
        command.env_remove(key);
    }
    if value.enabled {
        for key in PROXY_ENV_KEYS {
            command.env(key, &value.url);
        }
        command.env("NO_PROXY", NO_PROXY_VALUE);
        command.env("no_proxy", NO_PROXY_VALUE);
    }
    Ok(())
}

pub(crate) fn apply_network_proxy_environment_std(
    command: &mut std::process::Command,
) -> Result<(), String> {
    let value = read_network_proxy_file()?;
    for key in PROXY_ENV_KEYS {
        command.env_remove(key);
    }
    if value.enabled {
        for key in PROXY_ENV_KEYS {
            command.env(key, &value.url);
        }
        command.env("NO_PROXY", NO_PROXY_VALUE);
        command.env("no_proxy", NO_PROXY_VALUE);
    }
    Ok(())
}

pub(crate) fn network_client_builder(
    timeout: Duration,
) -> Result<reqwest::ClientBuilder, String> {
    let value = read_network_proxy_file()?;
    let mut builder = reqwest::Client::builder()
        .user_agent(format!("Grox/{}", crate::CLIENT_VERSION))
        .timeout(timeout);
    if value.enabled {
        let proxy = reqwest::Proxy::all(&value.url)
            .map_err(|error| format!("无法应用网络代理：{error}"))?
            .no_proxy(reqwest::NoProxy::from_string(NO_PROXY_VALUE));
        builder = builder.proxy(proxy);
    }
    Ok(builder)
}

pub(crate) fn network_http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    network_client_builder(timeout)?
        .build()
        .map_err(|error| format!("无法创建网络客户端：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_network_proxy_requires_a_loopback_http_endpoint() {
        let valid = checked_network_proxy(NetworkProxyConfig {
            enabled: true,
            url: "http://127.0.0.1:1080/".into(),
        })
        .expect("loopback HTTP proxy is valid");
        assert_eq!(valid.url, "http://127.0.0.1:1080");
        assert!(checked_network_proxy(NetworkProxyConfig {
            enabled: true,
            url: "socks5://127.0.0.1:1080".into(),
        })
        .is_err());
        assert!(checked_network_proxy(NetworkProxyConfig {
            enabled: true,
            url: "http://proxy.example:1080".into(),
        })
        .is_err());
        assert!(checked_network_proxy(NetworkProxyConfig {
            enabled: true,
            url: "http://127.0.0.1".into(),
        })
        .is_err());
    }
}
