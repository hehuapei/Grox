//! 自动化定义的原生事务仓储。
//!
//! UI 提交按 automation id 计算的 patch；Host 在锁内合并不同任务的变更，
//! 不允许两个独立任务通过整包数组互相覆盖。

use std::{collections::BTreeSet, path::Path, sync::Mutex};

use serde_json::Value;

use crate::{atomic_write, read_bounded_text, restrict_private_file};

const MAX_AUTOMATIONS: usize = 2_000;

#[derive(Default)]
pub(crate) struct AutomationStore {
    transaction: Mutex<()>,
}

impl AutomationStore {
    pub(crate) fn read(&self, path: &Path, max_bytes: u64) -> Result<Option<String>, String> {
        let _transaction = self.lock_transaction();
        if !path.is_file() {
            return Ok(None);
        }
        let content = read_bounded_text(path, max_bytes)
            .map_err(|error| format!("无法读取自动化文件：{error}"))?;
        if content.trim().is_empty() {
            return Ok(None);
        }
        let automations = serde_json::from_str::<Value>(&content)
            .map_err(|error| format!("自动化文件不是有效 JSON：{error}"))?
            .as_array()
            .cloned()
            .ok_or_else(|| "自动化文件必须是 JSON 数组".to_string())?;
        let _ = validated_automations(automations)?;
        Ok(Some(content))
    }

    pub(crate) fn patch(
        &self,
        path: &Path,
        upserts: Vec<Value>,
        deletes: Vec<String>,
        max_bytes: u64,
    ) -> Result<(), String> {
        let upserts = validated_automations(upserts)?;
        let delete_ids = deletes.into_iter().collect::<BTreeSet<_>>();
        for id in &delete_ids {
            validate_automation_id(id)?;
        }
        if upserts.iter().any(|(id, _)| delete_ids.contains(id)) {
            return Err("同一自动化 patch 不能同时更新和删除一个任务".into());
        }

        let _transaction = self.lock_transaction();
        let mut automations = self.read_locked(path, max_bytes)?;
        automations.retain(|automation| {
            automation_id(automation).is_some_and(|id| !delete_ids.contains(id))
        });
        for (id, automation) in upserts {
            if let Some(index) = automations
                .iter()
                .position(|current| automation_id(current) == Some(id.as_str()))
            {
                automations[index] = automation;
            } else {
                automations.push(automation);
            }
        }
        if automations.len() > MAX_AUTOMATIONS {
            return Err(format!("自动化任务不能超过 {MAX_AUTOMATIONS} 个"));
        }
        self.write_locked(path, automations, max_bytes)
    }

    fn read_locked(&self, path: &Path, max_bytes: u64) -> Result<Vec<Value>, String> {
        if !path.is_file() {
            return Ok(Vec::new());
        }
        let content = read_bounded_text(path, max_bytes)
            .map_err(|error| format!("无法读取自动化文件：{error}"))?;
        if content.trim().is_empty() {
            return Ok(Vec::new());
        }
        let automations = serde_json::from_str::<Value>(&content)
            .map_err(|error| format!("自动化文件不是有效 JSON：{error}"))?
            .as_array()
            .cloned()
            .ok_or_else(|| "自动化文件必须是 JSON 数组".to_string())?;
        let _ = validated_automations(automations.clone())?;
        Ok(automations)
    }

    fn write_locked(
        &self,
        path: &Path,
        automations: Vec<Value>,
        max_bytes: u64,
    ) -> Result<(), String> {
        let content = serde_json::to_string(&automations)
            .map_err(|error| format!("无法序列化自动化文件：{error}"))?;
        if content.len() as u64 > max_bytes {
            return Err(format!("自动化文件不能超过 {} MB", max_bytes / 1024 / 1024));
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

fn validated_automations(values: Vec<Value>) -> Result<Vec<(String, Value)>, String> {
    if values.len() > MAX_AUTOMATIONS {
        return Err(format!("自动化任务不能超过 {MAX_AUTOMATIONS} 个"));
    }
    let mut ids = BTreeSet::new();
    let mut validated = Vec::with_capacity(values.len());
    for value in values {
        validate_automation(&value)?;
        let id = automation_id(&value)
            .ok_or_else(|| "自动化任务缺少 id".to_string())?
            .to_string();
        if !ids.insert(id.clone()) {
            return Err(format!("自动化文件包含重复 id：{id}"));
        }
        validated.push((id, value));
    }
    Ok(validated)
}

fn validate_automation(value: &Value) -> Result<(), String> {
    let item = value
        .as_object()
        .ok_or_else(|| "自动化任务必须是 JSON 对象".to_string())?;
    let id = non_empty_string(value, "id")?;
    validate_automation_id(id)?;
    for key in ["title", "prompt", "cwd", "model"] {
        string_field(value, key).map_err(|_| format!("自动化 {id} 的 {key} 无效"))?;
    }
    enum_field(
        value,
        "effort",
        &["low", "medium", "high", "xhigh", "max"],
        id,
    )?;
    enum_field(value, "mode", &["agent", "plan", "ask"], id)?;
    enum_field(value, "permissionMode", &["default", "auto", "bypass"], id)?;
    enum_field(
        value,
        "frequency",
        &["once", "daily", "weekdays", "weekly"],
        id,
    )?;
    let time = string_field(value, "time")?;
    if !valid_time(time) {
        return Err(format!("自动化 {id} 的 time 无效"));
    }
    if item.get("enabled").and_then(Value::as_bool).is_none() {
        return Err(format!("自动化 {id} 的 enabled 无效"));
    }
    if !number_field(value, "nextRunAt").is_some_and(|time| time >= 0.0) {
        return Err(format!("自动化 {id} 的 nextRunAt 无效"));
    }
    if let Some(weekday) = item.get("weekday") {
        if !weekday.as_u64().is_some_and(|weekday| weekday <= 6) {
            return Err(format!("自动化 {id} 的 weekday 无效"));
        }
    }
    if let Some(last_run_at) = item.get("lastRunAt") {
        if !last_run_at.as_f64().is_some_and(|time| time >= 0.0) {
            return Err(format!("自动化 {id} 的 lastRunAt 无效"));
        }
    }
    for key in ["lastSessionId", "lastError"] {
        if item.get(key).is_some_and(|value| !value.is_string()) {
            return Err(format!("自动化 {id} 的 {key} 无效"));
        }
    }
    Ok(())
}

fn validate_automation_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
        Err("自动化任务 id 无效".into())
    } else {
        Ok(())
    }
}

fn automation_id(value: &Value) -> Option<&str> {
    value.get("id").and_then(Value::as_str)
}

fn non_empty_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    string_field(value, key).and_then(|field| {
        (!field.is_empty())
            .then_some(field)
            .ok_or_else(|| format!("自动化任务缺少 {key}"))
    })
}

fn string_field<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("自动化任务缺少 {key}"))
}

fn number_field(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn enum_field(value: &Value, key: &str, allowed: &[&str], id: &str) -> Result<(), String> {
    let field = string_field(value, key)?;
    if allowed.contains(&field) {
        Ok(())
    } else {
        Err(format!("自动化 {id} 的 {key} 无效"))
    }
}

fn valid_time(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 5
        || bytes[2] != b':'
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 2 || byte.is_ascii_digit())
    {
        return false;
    }
    let hour = (bytes[0] - b'0') * 10 + (bytes[1] - b'0');
    let minute = (bytes[3] - b'0') * 10 + (bytes[4] - b'0');
    hour < 24 && minute < 60
}

#[cfg(test)]
mod tests {
    use std::{fs, sync::Arc, thread};

    use super::*;

    fn automation(id: &str, enabled: bool) -> Value {
        serde_json::json!({
            "id": id,
            "title": id,
            "prompt": "review",
            "cwd": "/tmp/repo",
            "model": "grok-build",
            "effort": "high",
            "mode": "agent",
            "permissionMode": "auto",
            "frequency": "daily",
            "time": "09:30",
            "enabled": enabled,
            "nextRunAt": 1,
        })
    }

    fn temp_file(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "grox-automations-{name}-{}-{}.json",
            std::process::id(),
            crate::CONFIG_WRITE_NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }

    #[test]
    fn patch_preserves_unrelated_automation_and_order() {
        let path = temp_file("preserve");
        fs::write(
            &path,
            serde_json::json!([automation("a", true)]).to_string(),
        )
        .unwrap();
        let store = AutomationStore::default();
        store
            .patch(&path, vec![automation("b", false)], vec![], 1024 * 1024)
            .unwrap();
        store
            .patch(&path, vec![automation("a", false)], vec![], 1024 * 1024)
            .unwrap();

        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value[0]["id"], "a");
        assert_eq!(value[0]["enabled"], false);
        assert_eq!(value[1]["id"], "b");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn concurrent_updates_for_different_ids_do_not_overwrite() {
        let path = temp_file("concurrent");
        let store = Arc::new(AutomationStore::default());
        let first_store = Arc::clone(&store);
        let first_path = path.clone();
        let first = thread::spawn(move || {
            first_store
                .patch(
                    &first_path,
                    vec![automation("a", true)],
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
                    vec![automation("b", true)],
                    vec![],
                    1024 * 1024,
                )
                .unwrap();
        });
        first.join().unwrap();
        second.join().unwrap();

        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value.as_array().unwrap().len(), 2);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn invalid_patch_does_not_modify_existing_file() {
        let path = temp_file("invalid");
        let original = serde_json::json!([automation("a", true)]).to_string();
        fs::write(&path, &original).unwrap();
        let store = AutomationStore::default();
        assert!(store
            .patch(
                &path,
                vec![serde_json::json!({"id":"bad"})],
                vec![],
                1024 * 1024,
            )
            .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn patch_preserves_new_automation_order() {
        let path = temp_file("order");
        let store = AutomationStore::default();
        store
            .patch(
                &path,
                vec![automation("z", true), automation("a", true)],
                vec![],
                1024 * 1024,
            )
            .unwrap();

        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value[0]["id"], "z");
        assert_eq!(value[1]["id"], "a");
        let _ = fs::remove_file(path);
    }
}
