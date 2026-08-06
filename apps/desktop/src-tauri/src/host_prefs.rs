//! Host-attested operator preferences (native app data).
//!
//! Computer Use opt-in and Bypass permission mode must not live only in
//! webview localStorage (XSS / DevTools can flip them). Source of truth is
//! `host_prefs.json` under the Tauri app data dir (single path, process cache).

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};

const PREFS_FILE: &str = "host_prefs.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostPrefs {
    /// Operator enabled Computer Use (desktop control) in Settings.
    #[serde(default)]
    pub computer_use_enabled: bool,
    /// Permission mode: default | auto | bypass (host-attested for bypass).
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    /// Optional override for FE mid-turn idle (minutes).
    #[serde(default)]
    pub prompt_idle_minutes: Option<u32>,
    /// Optional override for absolute turn ceiling (hours).
    #[serde(default)]
    pub prompt_absolute_hours: Option<u32>,
    /// One-shot latch: FE→host CU migration already ran (0.2.25).
    /// Without this, re-enabling localStorage after intentional host opt-out
    /// silently re-opens the host gate on every boot (review P1).
    #[serde(default)]
    pub computer_use_fe_migrated: bool,
}

fn default_permission_mode() -> String {
    "auto".into()
}

static PREFS_CACHE: Mutex<Option<HostPrefs>> = Mutex::new(None);
/// Single data dir for this process (set from AppHandle at startup / first command).
static PREFS_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

fn prefs_path_from_dir(app_data: &Path) -> PathBuf {
    app_data.join(PREFS_FILE)
}

/// Pin the only prefs directory this process will use (0.2.20).
pub fn set_data_dir(dir: PathBuf) {
    if let Ok(mut guard) = PREFS_DIR.lock() {
        *guard = Some(dir);
    }
}

/// Gate read: env-independent; only process cache (filled by load/save).
pub fn is_computer_use_enabled() -> bool {
    PREFS_CACHE
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|p| p.computer_use_enabled))
        .unwrap_or(false)
}

pub fn load_prefs(app_data: &Path) -> HostPrefs {
    set_data_dir(app_data.to_path_buf());
    let path = prefs_path_from_dir(app_data);
    let prefs = match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => HostPrefs::default(),
    };
    if let Ok(mut guard) = PREFS_CACHE.lock() {
        *guard = Some(prefs.clone());
    }
    prefs
}

pub fn save_prefs(app_data: &Path, prefs: &HostPrefs) -> Result<(), String> {
    set_data_dir(app_data.to_path_buf());
    fs::create_dir_all(app_data).map_err(|e| format!("无法创建 app data 目录：{e}"))?;
    let path = prefs_path_from_dir(app_data);
    let raw = serde_json::to_string_pretty(prefs).map_err(|e| format!("序列化 host_prefs：{e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, raw.as_bytes()).map_err(|e| format!("写入 host_prefs 失败：{e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("提交 host_prefs 失败：{e}"))?;
    if let Ok(mut guard) = PREFS_CACHE.lock() {
        *guard = Some(prefs.clone());
    }
    Ok(())
}

/// Silent one-shot migration: FE had CU on, host never set (0.2.20).
/// After the first migration attempt, `computer_use_fe_migrated` stays true so
/// later boots cannot re-open the host gate from localStorage alone.
pub fn migrate_computer_use_from_fe(app_data: &Path, fe_enabled: bool) -> Result<HostPrefs, String> {
    let mut prefs = load_prefs(app_data);
    if prefs.computer_use_fe_migrated {
        return Ok(prefs);
    }
    if fe_enabled && !prefs.computer_use_enabled {
        prefs.computer_use_enabled = true;
    }
    prefs.computer_use_fe_migrated = true;
    save_prefs(app_data, &prefs)?;
    Ok(prefs)
}

pub fn normalize_permission_mode(mode: &str) -> Option<&'static str> {
    match mode.trim() {
        "default" => Some("default"),
        "auto" => Some("auto"),
        "bypass" => Some("bypass"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("grox-host-prefs-test-{n}"))
    }

    #[test]
    fn roundtrip_and_gate_cache() {
        let dir = temp_dir();
        let _ = fs::remove_dir_all(&dir);
        let mut p = HostPrefs::default();
        assert!(!is_computer_use_enabled());
        p.computer_use_enabled = true;
        save_prefs(&dir, &p).expect("save");
        assert!(is_computer_use_enabled());
        // Clear cache and reload from disk.
        if let Ok(mut g) = PREFS_CACHE.lock() {
            *g = None;
        }
        let loaded = load_prefs(&dir);
        assert!(loaded.computer_use_enabled);
        assert!(is_computer_use_enabled());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrate_only_when_host_off() {
        let dir = temp_dir();
        let _ = fs::remove_dir_all(&dir);
        let p = HostPrefs::default();
        save_prefs(&dir, &p).unwrap();
        let out = migrate_computer_use_from_fe(&dir, true).unwrap();
        assert!(out.computer_use_enabled);
        assert!(out.computer_use_fe_migrated);
        // Second migrate is no-op keep true.
        let out2 = migrate_computer_use_from_fe(&dir, false).unwrap();
        assert!(out2.computer_use_enabled);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrate_does_not_reopen_after_host_opt_out() {
        let dir = temp_dir();
        let _ = fs::remove_dir_all(&dir);
        // First boot: FE had CU on → migrate opens host gate once.
        let out = migrate_computer_use_from_fe(&dir, true).unwrap();
        assert!(out.computer_use_enabled);
        // Operator opts out on host.
        let mut off = out;
        off.computer_use_enabled = false;
        save_prefs(&dir, &off).unwrap();
        // localStorage still "1" must not re-open gate.
        let again = migrate_computer_use_from_fe(&dir, true).unwrap();
        assert!(!again.computer_use_enabled);
        assert!(again.computer_use_fe_migrated);
        let _ = fs::remove_dir_all(&dir);
    }
}
