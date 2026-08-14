//! 提示队列的原生事务仓储。
//!
//! 前端只提交发生变化的会话队列；Host 在同一把锁内读取、合并并原子替换文件，
//! 避免一个会话的整包快照覆盖另一个会话刚写入的数据。

use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::Mutex,
};

use serde_json::{Map, Value};

use crate::{atomic_write, read_bounded_text, restrict_private_file};

const MAX_QUEUE_ITEMS_PER_SESSION: usize = 1_000;
const MAX_ATTACHMENTS_PER_ITEM: usize = 64;

#[derive(Default)]
pub(crate) struct PromptQueueStore {
    transaction: Mutex<()>,
}

impl PromptQueueStore {
    pub(crate) fn read(&self, path: &Path, max_bytes: u64) -> Result<Option<String>, String> {
        let _transaction = self.lock_transaction();
        if !path.is_file() {
            return Ok(None);
        }
        read_bounded_text(path, max_bytes)
            .map(|content| (!content.trim().is_empty()).then_some(content))
            .map_err(|error| format!("无法读取提示队列：{error}"))
    }

    pub(crate) fn patch(
        &self,
        path: &Path,
        upserts: BTreeMap<String, Value>,
        deletes: Vec<String>,
        max_bytes: u64,
    ) -> Result<(), String> {
        let delete_ids = deletes.into_iter().collect::<BTreeSet<_>>();
        if upserts.keys().any(|id| delete_ids.contains(id)) {
            return Err("同一提示队列 patch 不能同时更新和删除一个会话".into());
        }
        for (session_id, rows) in &upserts {
            validate_session_queue(session_id, rows)?;
        }

        let _transaction = self.lock_transaction();
        let mut queues = self.read_locked(path, max_bytes)?;
        for session_id in delete_ids {
            queues.remove(&session_id);
        }
        for (session_id, rows) in upserts {
            if rows.as_array().is_some_and(Vec::is_empty) {
                queues.remove(&session_id);
            } else {
                queues.insert(session_id, rows);
            }
        }
        self.write_locked(path, queues, max_bytes)
    }

    pub(crate) fn delete_sessions(
        &self,
        path: &Path,
        session_ids: &[String],
        max_bytes: u64,
    ) -> Result<(), String> {
        if session_ids.is_empty() {
            return Ok(());
        }
        let _transaction = self.lock_transaction();
        if !path.is_file() {
            // 空对象也是“原生仓储已初始化”标记，阻止重启后再次导入旧 localStorage。
            return self.write_locked(path, Map::new(), max_bytes);
        }
        let mut queues = self.read_locked(path, max_bytes)?;
        let mut changed = false;
        for session_id in session_ids {
            changed |= queues.remove(session_id).is_some();
        }
        if changed {
            self.write_locked(path, queues, max_bytes)?;
        }
        Ok(())
    }

    fn read_locked(&self, path: &Path, max_bytes: u64) -> Result<Map<String, Value>, String> {
        if !path.is_file() {
            return Ok(Map::new());
        }
        let content = read_bounded_text(path, max_bytes)
            .map_err(|error| format!("无法读取提示队列：{error}"))?;
        if content.trim().is_empty() {
            return Ok(Map::new());
        }
        let queues = serde_json::from_str::<Value>(&content)
            .map_err(|error| format!("提示队列文件不是有效 JSON：{error}"))?
            .as_object()
            .cloned()
            .ok_or_else(|| "提示队列文件必须是 JSON 对象".to_string())?;
        for (session_id, rows) in &queues {
            validate_session_queue(session_id, rows)?;
        }
        Ok(queues)
    }

    fn write_locked(
        &self,
        path: &Path,
        queues: Map<String, Value>,
        max_bytes: u64,
    ) -> Result<(), String> {
        let content = serde_json::to_string(&queues)
            .map_err(|error| format!("无法序列化提示队列：{error}"))?;
        if content.len() as u64 > max_bytes {
            return Err(format!("提示队列不能超过 {} MB", max_bytes / 1024 / 1024));
        }
        atomic_write(path, &content)?;
        restrict_private_file(path)
    }

    fn lock_transaction(&self) -> std::sync::MutexGuard<'_, ()> {
        self.transaction
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn validate_session_queue(session_id: &str, rows: &Value) -> Result<(), String> {
    let rows = rows
        .as_array()
        .ok_or_else(|| format!("会话 {session_id} 的提示队列必须是数组"))?;
    if rows.len() > MAX_QUEUE_ITEMS_PER_SESSION {
        return Err(format!(
            "会话 {session_id} 的提示队列不能超过 {MAX_QUEUE_ITEMS_PER_SESSION} 条"
        ));
    }
    let mut ids = BTreeSet::new();
    for row in rows {
        let item = row
            .as_object()
            .ok_or_else(|| format!("会话 {session_id} 的提示队列包含无效条目"))?;
        let id = required_string(item, "id", session_id)?;
        if !ids.insert(id) {
            return Err(format!("会话 {session_id} 的提示队列包含重复 id"));
        }
        required_text(item, "text", session_id)?;
        required_string(item, "model", session_id)?;
        required_enum(
            item,
            "effort",
            &["low", "medium", "high", "xhigh", "max"],
            session_id,
        )?;
        required_enum(item, "mode", &["agent", "plan", "ask"], session_id)?;
        required_enum(
            item,
            "permissionMode",
            &["default", "auto", "bypass"],
            session_id,
        )?;
        if item.get("createdAt").and_then(Value::as_f64).is_none() {
            return Err(format!("会话 {session_id} 的提示队列缺少 createdAt"));
        }
        if let Some(source) = item.get("source") {
            if !matches!(source.as_str(), Some("local" | "cli")) {
                return Err(format!("会话 {session_id} 的提示队列 source 无效"));
            }
        }
        if let Some(state) = item.get("state") {
            if !matches!(state.as_str(), Some("queued" | "interjected" | "sending")) {
                return Err(format!("会话 {session_id} 的提示队列 state 无效"));
            }
        }
        if item
            .get("heldByCli")
            .is_some_and(|value| !value.is_boolean())
        {
            return Err(format!("会话 {session_id} 的提示队列 heldByCli 无效"));
        }
        let attachments = item
            .get("attachments")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("会话 {session_id} 的提示队列缺少 attachments"))?;
        if attachments.len() > MAX_ATTACHMENTS_PER_ITEM {
            return Err(format!(
                "会话 {session_id} 的单条提示不能超过 {MAX_ATTACHMENTS_PER_ITEM} 个附件"
            ));
        }
        for attachment in attachments {
            validate_attachment(session_id, attachment)?;
        }
    }
    Ok(())
}

fn validate_attachment(session_id: &str, value: &Value) -> Result<(), String> {
    let attachment = value
        .as_object()
        .ok_or_else(|| format!("会话 {session_id} 的提示队列包含无效附件"))?;
    required_string(attachment, "id", session_id)?;
    required_enum(attachment, "kind", &["image", "text", "binary"], session_id)?;
    required_string(attachment, "name", session_id)?;
    required_string(attachment, "mime", session_id)?;
    if !attachment
        .get("size")
        .and_then(Value::as_f64)
        .is_some_and(|size| size >= 0.0)
    {
        return Err(format!("会话 {session_id} 的提示队列附件缺少 size"));
    }
    for optional in ["text", "data"] {
        if attachment
            .get(optional)
            .is_some_and(|value| !value.is_string())
        {
            return Err(format!("会话 {session_id} 的提示队列附件 {optional} 无效"));
        }
    }
    Ok(())
}

fn required_text<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    session_id: &str,
) -> Result<&'a str, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("会话 {session_id} 的提示队列缺少 {key}"))
}

fn required_string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    session_id: &str,
) -> Result<&'a str, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("会话 {session_id} 的提示队列缺少 {key}"))
}

fn required_enum(
    object: &Map<String, Value>,
    key: &str,
    allowed: &[&str],
    session_id: &str,
) -> Result<(), String> {
    let value = required_string(object, key, session_id)?;
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(format!("会话 {session_id} 的提示队列 {key} 无效"))
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, sync::Arc, thread};

    use super::*;

    fn row(id: &str) -> Value {
        serde_json::json!({
            "id": id,
            "text": id,
            "attachments": [],
            "model": "grok-build",
            "effort": "high",
            "mode": "agent",
            "permissionMode": "auto",
            "createdAt": 1,
        })
    }

    fn temp_file(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "grox-prompt-queue-{name}-{}-{}.json",
            std::process::id(),
            crate::CONFIG_WRITE_NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }

    #[test]
    fn patch_preserves_unrelated_sessions() {
        let path = temp_file("preserve");
        fs::write(&path, serde_json::json!({ "a": [row("a1")] }).to_string()).unwrap();
        let store = PromptQueueStore::default();
        store
            .patch(
                &path,
                BTreeMap::from([("b".into(), serde_json::json!([row("b1")]))]),
                vec![],
                1024 * 1024,
            )
            .unwrap();

        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["a"][0]["id"], "a1");
        assert_eq!(value["b"][0]["id"], "b1");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn concurrent_session_patches_do_not_overwrite_each_other() {
        let path = temp_file("concurrent");
        let store = Arc::new(PromptQueueStore::default());
        let first_store = Arc::clone(&store);
        let first_path = path.clone();
        let first = thread::spawn(move || {
            first_store
                .patch(
                    &first_path,
                    BTreeMap::from([("a".into(), serde_json::json!([row("a1")]))]),
                    vec![],
                    1024 * 1024,
                )
                .unwrap();
        });
        let second_store = Arc::clone(&store);
        let second_path = path.clone();
        let second = thread::spawn(move || {
            second_store
                .patch(
                    &second_path,
                    BTreeMap::from([("b".into(), serde_json::json!([row("b1")]))]),
                    vec![],
                    1024 * 1024,
                )
                .unwrap();
        });
        first.join().unwrap();
        second.join().unwrap();

        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 2);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn deletion_and_validation_are_transactional() {
        let path = temp_file("delete");
        let store = PromptQueueStore::default();
        fs::write(
            &path,
            serde_json::json!({ "a": [row("a1")], "b": [row("b1")] }).to_string(),
        )
        .unwrap();
        store
            .delete_sessions(&path, &["a".into()], 1024 * 1024)
            .unwrap();
        assert!(store
            .patch(
                &path,
                BTreeMap::from([("b".into(), serde_json::json!([{"id":"bad"}]))]),
                vec![],
                1024 * 1024,
            )
            .is_err());

        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(value.get("a").is_none());
        assert_eq!(value["b"][0]["id"], "b1");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn deletion_initializes_an_empty_native_store() {
        let path = temp_file("empty-delete");
        let store = PromptQueueStore::default();
        store
            .delete_sessions(&path, &["deleted-session".into()], 1024 * 1024)
            .unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "{}");
        let _ = fs::remove_file(path);
    }
}
