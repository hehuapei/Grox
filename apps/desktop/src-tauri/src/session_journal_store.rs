//! 应用会话 journal 的原生语义仓储。
//!
//! 写入在会话存储租约内进行；Host 校验身份并拒绝非递增的 savedAt 覆盖磁盘
//! 快照。旧版裸 Session 只允许读取迁移，不能重新写入。

use std::{fs, path::Path};

use serde_json::Value;

use crate::{atomic_write_bounded_private, read_bounded_text};

#[derive(Default)]
pub(crate) struct SessionJournalStore;

pub(crate) enum SessionJournalWriteError {
    InvalidIncoming(String),
    Conflict(String),
    Storage(String),
}

impl SessionJournalStore {
    pub(crate) fn read(
        &self,
        source: &Path,
        id: &str,
        max_bytes: u64,
    ) -> Result<Option<String>, String> {
        if !source.is_file() {
            return Ok(None);
        }
        let content = read_bounded_text(source, max_bytes)
            .map_err(|error| format!("无法读取应用会话 journal：{error}"))?;
        if content.trim().is_empty() {
            return Err("应用会话 journal 为空，拒绝当作没有历史继续".into());
        }
        validate_readable_journal(&content, id)?;
        Ok(Some(content))
    }

    pub(crate) fn write(
        &self,
        path: &Path,
        legacy: &Path,
        id: &str,
        content: &str,
        max_bytes: u64,
    ) -> Result<(), SessionJournalWriteError> {
        if content.len() as u64 > max_bytes {
            return Err(SessionJournalWriteError::InvalidIncoming(format!(
                "应用会话 journal 不能超过 {} MB",
                max_bytes / 1024 / 1024
            )));
        }
        let incoming_saved_at = validate_current_journal(content, id)
            .map_err(SessionJournalWriteError::InvalidIncoming)?;
        if path.is_file() {
            let current = read_bounded_text(path, max_bytes)
                .map_err(|error| {
                    SessionJournalWriteError::Storage(format!(
                        "无法读取现有应用会话 journal：{error}"
                    ))
                })?;
            let current_saved_at = validate_current_journal(&current, id)
                .map_err(SessionJournalWriteError::Storage)?;
            if current_saved_at >= incoming_saved_at {
                return Err(SessionJournalWriteError::Conflict(format!(
                    "应用会话 journal 写入冲突：磁盘版本 {current_saved_at} 不早于提交版本 {incoming_saved_at}"
                )));
            }
        }

        atomic_write_bounded_private(path, content, max_bytes)
            .map_err(SessionJournalWriteError::Storage)?;
        if legacy.is_file() {
            if let Err(error) = fs::remove_file(legacy) {
                // 新版 journal 已经持久化；保留旧文件并通过状态诊断暴露即可。
                eprintln!("grox: 新版 journal 已写入，但无法清理旧版会话缓存：{error}");
            }
        }
        Ok(())
    }
}

fn parse_journal(content: &str) -> Result<Value, String> {
    serde_json::from_str(content).map_err(|error| format!("应用会话 journal 必须是 JSON：{error}"))
}

fn validate_readable_journal(content: &str, id: &str) -> Result<(), String> {
    let value = parse_journal(content)?;
    if value.get("version").and_then(Value::as_u64) == Some(1) {
        validate_current_value(&value, id).map(|_| ())
    } else if value.get("id").and_then(Value::as_str) == Some(id)
        && value.get("blocks").is_some_and(Value::is_array)
    {
        Ok(())
    } else {
        Err("应用会话 journal 格式无效或会话身份不匹配".into())
    }
}

pub(crate) fn validate_current_journal(content: &str, id: &str) -> Result<u64, String> {
    let value = parse_journal(content)?;
    validate_current_value(&value, id)
}

fn validate_current_value(value: &Value, id: &str) -> Result<u64, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "应用会话 journal 必须是 JSON 对象".to_string())?;
    let saved_at = object.get("savedAt").and_then(Value::as_u64);
    if object.get("version").and_then(Value::as_u64) != Some(1)
        || object.get("appSessionId").and_then(Value::as_str) != Some(id)
        || object
            .get("agentSessionId")
            .and_then(Value::as_str)
            .is_none()
        || saved_at.is_none()
        || !matches!(
            object.get("turnState").and_then(Value::as_str),
            Some("active" | "settled")
        )
        || object
            .get("session")
            .and_then(Value::as_object)
            .and_then(|session| session.get("id"))
            .and_then(Value::as_str)
            != Some(id)
        || !object
            .get("session")
            .and_then(Value::as_object)
            .and_then(|session| session.get("blocks"))
            .is_some_and(Value::is_array)
    {
        return Err("应用会话 journal 格式无效或会话身份不匹配".into());
    }
    Ok(saved_at.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn journal(id: &str, saved_at: u64, text: &str) -> String {
        serde_json::json!({
            "version": 1,
            "appSessionId": id,
            "agentSessionId": id,
            "savedAt": saved_at,
            "turnState": "settled",
            "session": { "id": id, "blocks": [{ "type": "user", "text": text }] },
        })
        .to_string()
    }

    fn temp_file(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "grox-journal-store-{name}-{}-{}.json",
            std::process::id(),
            crate::CONFIG_WRITE_NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }

    #[test]
    fn stale_snapshot_cannot_overwrite_newer_journal() {
        let path = temp_file("stale");
        let legacy = temp_file("legacy");
        fs::write(&path, journal("session-1", 20, "new")).unwrap();
        let store = SessionJournalStore;

        assert!(store
            .write(
                &path,
                &legacy,
                "session-1",
                &journal("session-1", 10, "old"),
                1024 * 1024,
            )
            .is_err());
        assert!(fs::read_to_string(&path).unwrap().contains("new"));

        assert!(store
            .write(
                &path,
                &legacy,
                "session-1",
                &journal("session-1", 20, "same-revision"),
                1024 * 1024,
            )
            .is_err());
        assert!(fs::read_to_string(&path).unwrap().contains("new"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn corrupt_existing_journal_is_not_silently_replaced() {
        let path = temp_file("corrupt");
        let legacy = temp_file("legacy");
        fs::write(&path, "not-json").unwrap();
        let store = SessionJournalStore;

        assert!(store
            .write(
                &path,
                &legacy,
                "session-1",
                &journal("session-1", 10, "replacement"),
                1024 * 1024,
            )
            .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "not-json");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn empty_existing_journal_is_not_missing_history() {
        let path = temp_file("empty");
        fs::write(&path, "").unwrap();
        assert!(SessionJournalStore
            .read(&path, "session-1", 1024 * 1024)
            .unwrap_err()
            .contains("journal 为空"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn legacy_bare_session_remains_readable_for_migration() {
        let path = temp_file("legacy-read");
        fs::write(
            &path,
            serde_json::json!({ "id": "session-1", "blocks": [] }).to_string(),
        )
        .unwrap();
        let store = SessionJournalStore;

        assert!(store
            .read(&path, "session-1", 1024 * 1024)
            .unwrap()
            .is_some());
        let _ = fs::remove_file(path);
    }
}
