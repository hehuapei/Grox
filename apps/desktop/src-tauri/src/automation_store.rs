//! 自动化定义的原生事务仓储。
//!
//! UI 提交按 automation id 计算的 patch；Host 在锁内合并不同任务的变更，
//! 不允许两个独立任务通过整包数组互相覆盖。

use std::{collections::BTreeSet, path::Path, sync::Mutex};

use chrono::{Datelike, Days, Local, LocalResult, NaiveTime, TimeZone};
use serde::Serialize;
use serde_json::Value;

use crate::{atomic_write, read_bounded_text, restrict_private_file};

const MAX_AUTOMATIONS: usize = 2_000;
const HOST_RUNTIME_KEY: &str = "_hostRuntime";
const CLAIM_LEASE_MS: u64 = 2 * 60 * 1_000;
const FAILURE_RETRY_MS: u64 = 5 * 60 * 1_000;

#[derive(Default)]
pub(crate) struct AutomationStore {
    transaction: Mutex<()>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AutomationDispatchSource {
    Scheduled,
    RunNow,
}

impl AutomationDispatchSource {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Scheduled => "scheduled",
            Self::RunNow => "run_now",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "scheduled" => Some(Self::Scheduled),
            "run_now" => Some(Self::RunNow),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationDispatch {
    pub(crate) token: String,
    pub(crate) source: AutomationDispatchSource,
    pub(crate) claimed_at: u64,
    pub(crate) lease_expires_at: u64,
    pub(crate) automation: Value,
}

pub(crate) struct AutomationCompletion<'a> {
    pub(crate) session_id: Option<&'a str>,
    pub(crate) error: Option<&'a str>,
    pub(crate) completed_at: u64,
}

pub(crate) struct ClaimedAutomation {
    pub(crate) automation: Value,
    pub(crate) lease_expires_at: u64,
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
        // `_hostRuntime` 只由 Host 写入。WebView 的普通编辑既不能伪造租约，
        // 也不能在保存标题等字段时擦掉正在执行的认领。
        let upserts = validated_automations(
            upserts
                .into_iter()
                .map(without_host_runtime)
                .collect::<Vec<_>>(),
        )?;
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
        for (id, mut automation) in upserts {
            if let Some(index) = automations
                .iter()
                .position(|current| automation_id(current) == Some(id.as_str()))
            {
                if let Some(runtime) = automations[index].get(HOST_RUNTIME_KEY).cloned() {
                    automation
                        .as_object_mut()
                        .expect("validated automation must be an object")
                        .insert(HOST_RUNTIME_KEY.to_string(), runtime);
                }
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

    /// 原子认领最早到期的任务。到期判断和租约写入必须处在同一个文件事务里。
    pub(crate) fn claim_due(
        &self,
        path: &Path,
        now_ms: u64,
        max_bytes: u64,
    ) -> Result<Option<AutomationDispatch>, String> {
        let _transaction = self.lock_transaction();
        let mut automations = self.read_locked(path, max_bytes)?;
        if automations
            .iter()
            .any(|automation| has_live_claim(automation, now_ms))
        {
            return Ok(None);
        }
        let Some(index) = automations
            .iter()
            .enumerate()
            .filter(|(_, automation)| scheduled_claimable(automation, now_ms))
            .min_by_key(|(_, automation)| {
                timestamp_field(automation, "nextRunAt").unwrap_or(u64::MAX)
            })
            .map(|(index, _)| index)
        else {
            return Ok(None);
        };
        let dispatch = self.claim_locked(
            &mut automations[index],
            AutomationDispatchSource::Scheduled,
            now_ms,
        )?;
        self.write_locked(path, automations, max_bytes)?;
        Ok(Some(dispatch))
    }

    pub(crate) fn claim_now(
        &self,
        path: &Path,
        id: &str,
        now_ms: u64,
        max_bytes: u64,
    ) -> Result<AutomationDispatch, String> {
        validate_automation_id(id)?;
        let _transaction = self.lock_transaction();
        let mut automations = self.read_locked(path, max_bytes)?;
        if automations
            .iter()
            .any(|automation| has_live_claim(automation, now_ms))
        {
            return Err("已有自动化任务正在执行".into());
        }
        let automation = automations
            .iter_mut()
            .find(|automation| automation_id(automation) == Some(id))
            .ok_or_else(|| format!("自动化任务不存在：{id}"))?;
        let dispatch = self.claim_locked(automation, AutomationDispatchSource::RunNow, now_ms)?;
        self.write_locked(path, automations, max_bytes)?;
        Ok(dispatch)
    }

    pub(crate) fn renew_claim(
        &self,
        path: &Path,
        id: &str,
        token: &str,
        now_ms: u64,
        max_bytes: u64,
    ) -> Result<u64, String> {
        validate_claim_token(token)?;
        let _transaction = self.lock_transaction();
        let mut automations = self.read_locked(path, max_bytes)?;
        let automation = automations
            .iter_mut()
            .find(|automation| automation_id(automation) == Some(id))
            .ok_or_else(|| format!("自动化任务不存在：{id}"))?;
        let expires_at = renew_claim_runtime(automation, token, now_ms)?;
        self.write_locked(path, automations, max_bytes)?;
        Ok(expires_at)
    }

    /// WebView 创建完带本机能力租约的会话后，将执行权原子移交给 Host。
    /// 读取配置、校验 token 和首次续租必须在同一事务内，不能让前端提交另一份配置快照。
    pub(crate) fn begin_execution(
        &self,
        path: &Path,
        id: &str,
        token: &str,
        now_ms: u64,
        max_bytes: u64,
    ) -> Result<ClaimedAutomation, String> {
        validate_automation_id(id)?;
        validate_claim_token(token)?;
        let _transaction = self.lock_transaction();
        let mut automations = self.read_locked(path, max_bytes)?;
        let automation = automations
            .iter_mut()
            .find(|automation| automation_id(automation) == Some(id))
            .ok_or_else(|| format!("自动化任务不存在：{id}"))?;
        let lease_expires_at = renew_claim_runtime(automation, token, now_ms)?;
        let mut payload = automation.clone();
        payload
            .as_object_mut()
            .expect("validated automation must be an object")
            .remove(HOST_RUNTIME_KEY);
        self.write_locked(path, automations, max_bytes)?;
        Ok(ClaimedAutomation {
            automation: payload,
            lease_expires_at,
        })
    }

    pub(crate) fn complete_claim(
        &self,
        path: &Path,
        id: &str,
        token: &str,
        completion: AutomationCompletion<'_>,
        max_bytes: u64,
    ) -> Result<Value, String> {
        let AutomationCompletion {
            session_id,
            error,
            completed_at: now_ms,
        } = completion;
        validate_claim_token(token)?;
        if let Some(session_id) = session_id {
            if session_id.trim().is_empty()
                || session_id.len() > 256
                || session_id.chars().any(char::is_control)
            {
                return Err("自动化结果包含无效会话 ID".into());
            }
        }
        if error.is_some_and(|message| message.chars().count() > 4_000) {
            return Err("自动化错误详情不能超过 4000 个字符".into());
        }

        let _transaction = self.lock_transaction();
        let mut automations = self.read_locked(path, max_bytes)?;
        let automation = automations
            .iter_mut()
            .find(|automation| automation_id(automation) == Some(id))
            .ok_or_else(|| format!("自动化任务不存在：{id}"))?;
        let runtime = claim_runtime(automation, token)?;
        let source = runtime
            .get("source")
            .and_then(Value::as_str)
            .and_then(AutomationDispatchSource::from_str)
            .ok_or_else(|| "自动化认领来源无效".to_string())?;
        let previous_retry_at = timestamp_field(runtime, "retryAfterAt");
        let scheduled_frequency = automation
            .get("frequency")
            .and_then(Value::as_str)
            .map(str::to_string);
        // 一旦已经创建后台会话，后续失败可能发生在 prompt 写入之后。
        // 此时自动重试会复制工作；只对“尚未创建会话”的失败做退避重试。
        let scheduled_consumed = matches!(source, AutomationDispatchSource::Scheduled)
            && (error.is_none() || session_id.is_some());
        let next_run_at = if scheduled_consumed && scheduled_frequency.as_deref() != Some("once") {
            Some(next_automation_run(
                automation,
                now_ms.saturating_add(1_000),
            )?)
        } else {
            None
        };

        let item = automation
            .as_object_mut()
            .expect("validated automation must be an object");
        item.remove(HOST_RUNTIME_KEY);
        if let Some(session_id) = session_id {
            item.insert("lastSessionId".to_string(), Value::from(session_id));
        }
        if scheduled_consumed {
            item.insert("lastRunAt".to_string(), Value::from(now_ms));
            if scheduled_frequency.as_deref() == Some("once") {
                item.insert("enabled".to_string(), Value::Bool(false));
            } else if let Some(next_run_at) = next_run_at {
                item.insert("nextRunAt".to_string(), Value::from(next_run_at));
            }
        }
        if let Some(error) = error {
            item.insert("lastError".to_string(), Value::from(error));
            let retry_at = match source {
                AutomationDispatchSource::Scheduled if !scheduled_consumed => {
                    Some(now_ms.saturating_add(FAILURE_RETRY_MS))
                }
                AutomationDispatchSource::Scheduled => None,
                AutomationDispatchSource::RunNow => {
                    previous_retry_at.filter(|retry| *retry > now_ms)
                }
            };
            if let Some(retry_at) = retry_at {
                item.insert(
                    HOST_RUNTIME_KEY.to_string(),
                    serde_json::json!({ "retryAfterAt": retry_at }),
                );
            }
        } else {
            item.remove("lastError");
            if matches!(source, AutomationDispatchSource::RunNow) {
                item.insert("lastRunAt".to_string(), Value::from(now_ms));
            }
            if matches!(source, AutomationDispatchSource::RunNow) {
                if let Some(retry_at) = previous_retry_at.filter(|retry| *retry > now_ms) {
                    item.insert(
                        HOST_RUNTIME_KEY.to_string(),
                        serde_json::json!({ "retryAfterAt": retry_at }),
                    );
                }
            }
        }
        let updated = automation.clone();
        self.write_locked(path, automations, max_bytes)?;
        Ok(updated)
    }

    fn claim_locked(
        &self,
        automation: &mut Value,
        source: AutomationDispatchSource,
        now_ms: u64,
    ) -> Result<AutomationDispatch, String> {
        validate_automation(automation)?;
        let id = automation_id(automation).ok_or_else(|| "自动化任务缺少 id".to_string())?;
        let id = id.to_string();
        let mut token_bytes = [0_u8; 16];
        getrandom::fill(&mut token_bytes)
            .map_err(|error| format!("无法创建自动化认领 token：{error}"))?;
        let token = token_bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let lease_expires_at = now_ms.saturating_add(CLAIM_LEASE_MS);
        let previous_retry_at = automation
            .get(HOST_RUNTIME_KEY)
            .and_then(|runtime| timestamp_field(runtime, "retryAfterAt"));
        let mut runtime = serde_json::json!({
            "token": token,
            "source": source.as_str(),
            "claimedAt": now_ms,
            "leaseExpiresAt": lease_expires_at,
        });
        if let Some(retry_at) = previous_retry_at {
            runtime
                .as_object_mut()
                .expect("runtime must be an object")
                .insert("retryAfterAt".to_string(), Value::from(retry_at));
        }
        automation
            .as_object_mut()
            .expect("validated automation must be an object")
            .insert(HOST_RUNTIME_KEY.to_string(), runtime);
        let mut payload = automation.clone();
        payload
            .as_object_mut()
            .expect("validated automation must be an object")
            .remove(HOST_RUNTIME_KEY);
        debug_assert_eq!(automation_id(&payload), Some(id.as_str()));
        Ok(AutomationDispatch {
            token,
            source,
            claimed_at: now_ms,
            lease_expires_at,
            automation: payload,
        })
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
    if timestamp_field(value, "nextRunAt").is_none() {
        return Err(format!("自动化 {id} 的 nextRunAt 无效"));
    }
    if let Some(weekday) = item.get("weekday") {
        if !weekday.as_u64().is_some_and(|weekday| weekday <= 6) {
            return Err(format!("自动化 {id} 的 weekday 无效"));
        }
    }
    if item.contains_key("lastRunAt") && timestamp_field(value, "lastRunAt").is_none() {
        return Err(format!("自动化 {id} 的 lastRunAt 无效"));
    }
    for key in ["lastSessionId", "lastError"] {
        if item.get(key).is_some_and(|value| !value.is_string()) {
            return Err(format!("自动化 {id} 的 {key} 无效"));
        }
    }
    if let Some(runtime) = item.get(HOST_RUNTIME_KEY) {
        validate_host_runtime(runtime, id)?;
    }
    Ok(())
}

fn validate_host_runtime(value: &Value, id: &str) -> Result<(), String> {
    let runtime = value
        .as_object()
        .ok_or_else(|| format!("自动化 {id} 的 Host 运行状态无效"))?;
    if let Some(token) = runtime.get("token") {
        validate_claim_token(
            token
                .as_str()
                .ok_or_else(|| format!("自动化 {id} 的认领 token 无效"))?,
        )?;
        if !runtime
            .get("source")
            .and_then(Value::as_str)
            .is_some_and(|source| matches!(source, "scheduled" | "run_now"))
        {
            return Err(format!("自动化 {id} 的认领来源无效"));
        }
        for key in ["claimedAt", "leaseExpiresAt"] {
            if timestamp_field(value, key).is_none() {
                return Err(format!("自动化 {id} 的 {key} 无效"));
            }
        }
    } else if runtime.contains_key("source")
        || runtime.contains_key("claimedAt")
        || runtime.contains_key("leaseExpiresAt")
    {
        return Err(format!("自动化 {id} 的 Host 认领状态不完整"));
    }
    if runtime.contains_key("retryAfterAt") && timestamp_field(value, "retryAfterAt").is_none() {
        return Err(format!("自动化 {id} 的 retryAfterAt 无效"));
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

fn timestamp_field(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64).or_else(|| {
        value
            .get(key)
            .and_then(Value::as_f64)
            .filter(|number| number.is_finite() && *number >= 0.0 && number.fract() == 0.0)
            .map(|number| number as u64)
    })
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

fn without_host_runtime(mut automation: Value) -> Value {
    if let Some(item) = automation.as_object_mut() {
        item.remove(HOST_RUNTIME_KEY);
    }
    automation
}

fn has_live_claim(automation: &Value, now_ms: u64) -> bool {
    automation
        .get(HOST_RUNTIME_KEY)
        .and_then(|runtime| {
            runtime
                .get("token")
                .and_then(Value::as_str)
                .map(|_| runtime)
        })
        .and_then(|runtime| timestamp_field(runtime, "leaseExpiresAt"))
        .is_some_and(|expires_at| expires_at > now_ms)
}

fn scheduled_claimable(automation: &Value, now_ms: u64) -> bool {
    automation.get("enabled").and_then(Value::as_bool) == Some(true)
        && timestamp_field(automation, "nextRunAt").is_some_and(|next| next <= now_ms)
        && !has_live_claim(automation, now_ms)
        && !automation
            .get(HOST_RUNTIME_KEY)
            .and_then(|runtime| timestamp_field(runtime, "retryAfterAt"))
            .is_some_and(|retry_at| retry_at > now_ms)
}

fn claim_runtime<'a>(automation: &'a Value, token: &str) -> Result<&'a Value, String> {
    let runtime = automation
        .get(HOST_RUNTIME_KEY)
        .ok_or_else(|| "自动化认领已失效".to_string())?;
    if runtime.get("token").and_then(Value::as_str) == Some(token) {
        Ok(runtime)
    } else {
        Err("自动化认领 token 不匹配或已失效".into())
    }
}

fn claim_runtime_mut<'a>(
    automation: &'a mut Value,
    token: &str,
) -> Result<&'a mut serde_json::Map<String, Value>, String> {
    let runtime = automation
        .get_mut(HOST_RUNTIME_KEY)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "自动化认领已失效".to_string())?;
    if runtime.get("token").and_then(Value::as_str) == Some(token) {
        Ok(runtime)
    } else {
        Err("自动化认领 token 不匹配或已失效".into())
    }
}

fn renew_claim_runtime(automation: &mut Value, token: &str, now_ms: u64) -> Result<u64, String> {
    let runtime = claim_runtime_mut(automation, token)?;
    let expires_at = now_ms.saturating_add(CLAIM_LEASE_MS);
    runtime.insert("leaseExpiresAt".to_string(), Value::from(expires_at));
    Ok(expires_at)
}

fn validate_claim_token(token: &str) -> Result<(), String> {
    if token.is_empty()
        || token.len() > 192
        || token
            .bytes()
            .any(|byte| !byte.is_ascii_alphanumeric() && byte != b'-')
    {
        Err("自动化认领 token 无效".into())
    } else {
        Ok(())
    }
}

fn next_automation_run(automation: &Value, after_ms: u64) -> Result<u64, String> {
    let frequency = string_field(automation, "frequency")?;
    let time = string_field(automation, "time")?;
    let local_after = Local
        .timestamp_millis_opt(after_ms as i64)
        .single()
        .ok_or_else(|| "无法计算自动化的本地排程时间".to_string())?;
    let local_time =
        NaiveTime::parse_from_str(time, "%H:%M").map_err(|_| "自动化排程时间无效".to_string())?;
    let weekly_day = automation
        .get("weekday")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| local_after.weekday().num_days_from_sunday() as u64);
    for offset in 0..=8 {
        let Some(date) = local_after.date_naive().checked_add_days(Days::new(offset)) else {
            break;
        };
        let weekday = date.weekday().num_days_from_sunday() as u64;
        let allowed = match frequency {
            "daily" => true,
            "weekdays" => (1..=5).contains(&weekday),
            "weekly" => weekday == weekly_day,
            _ => false,
        };
        if !allowed {
            continue;
        }
        let local = match Local.from_local_datetime(&date.and_time(local_time)) {
            LocalResult::Single(value) => Some(value),
            LocalResult::Ambiguous(first, second) => [first, second]
                .into_iter()
                .find(|value| *value > local_after),
            // 夏令时跳过的墙钟时间不能被偷偷挪到另一个小时。
            LocalResult::None => None,
        };
        if let Some(candidate) = local.filter(|candidate| *candidate > local_after) {
            return Ok(candidate.timestamp_millis() as u64);
        }
    }
    Err("无法计算自动化的下一次运行时间".into())
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
        let mut fractional_time = automation("a", true);
        fractional_time["nextRunAt"] = serde_json::json!(1.5);
        assert!(store
            .patch(&path, vec![fractional_time], vec![], 1024 * 1024)
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

    #[test]
    fn due_claim_is_durable_and_blocks_a_second_dispatch() {
        let path = temp_file("claim");
        fs::write(
            &path,
            serde_json::json!([automation("a", true)]).to_string(),
        )
        .unwrap();
        let store = AutomationStore::default();

        let dispatch = store.claim_due(&path, 10, 1024 * 1024).unwrap().unwrap();
        assert_eq!(dispatch.automation["id"], "a");
        assert_eq!(dispatch.source.as_str(), "scheduled");
        assert!(store.claim_due(&path, 11, 1024 * 1024).unwrap().is_none());

        let persisted: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(persisted[0][HOST_RUNTIME_KEY]["token"], dispatch.token);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn begin_execution_reads_claimed_config_and_renews_in_one_transaction() {
        let path = temp_file("begin-execution");
        fs::write(
            &path,
            serde_json::json!([automation("a", true)]).to_string(),
        )
        .unwrap();
        let store = AutomationStore::default();
        let dispatch = store.claim_due(&path, 10, 1024 * 1024).unwrap().unwrap();

        let claimed = store
            .begin_execution(&path, "a", &dispatch.token, 40, 1024 * 1024)
            .unwrap();

        assert_eq!(claimed.automation["id"], "a");
        assert!(claimed.automation.get(HOST_RUNTIME_KEY).is_none());
        assert_eq!(claimed.lease_expires_at, 40 + CLAIM_LEASE_MS);
        let persisted: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            persisted[0][HOST_RUNTIME_KEY]["leaseExpiresAt"],
            40 + CLAIM_LEASE_MS
        );
        assert!(store
            .begin_execution(&path, "a", "stale-token", 50, 1024 * 1024)
            .is_err());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn ordinary_patch_cannot_erase_or_forge_host_claim() {
        let path = temp_file("claim-patch");
        fs::write(
            &path,
            serde_json::json!([automation("a", true)]).to_string(),
        )
        .unwrap();
        let store = AutomationStore::default();
        let dispatch = store.claim_due(&path, 10, 1024 * 1024).unwrap().unwrap();
        let mut edited = automation("a", false);
        edited.as_object_mut().unwrap().insert(
            HOST_RUNTIME_KEY.to_string(),
            serde_json::json!({
                "token": "forged",
                "source": "run_now",
                "claimedAt": 99,
                "leaseExpiresAt": 999,
            }),
        );

        store
            .patch(&path, vec![edited], vec![], 1024 * 1024)
            .unwrap();
        let persisted: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(persisted[0]["enabled"], false);
        assert_eq!(persisted[0][HOST_RUNTIME_KEY]["token"], dispatch.token);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn expired_claim_can_be_recovered_after_webview_crash() {
        let path = temp_file("claim-expiry");
        fs::write(
            &path,
            serde_json::json!([automation("a", true)]).to_string(),
        )
        .unwrap();
        let store = AutomationStore::default();
        let first = store.claim_due(&path, 10, 1024 * 1024).unwrap().unwrap();
        let recovered = store
            .claim_due(&path, 10 + CLAIM_LEASE_MS + 1, 1024 * 1024)
            .unwrap()
            .unwrap();

        assert_ne!(recovered.token, first.token);
        assert_eq!(recovered.automation["id"], "a");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn scheduled_success_advances_only_in_host_transaction() {
        let path = temp_file("complete");
        fs::write(
            &path,
            serde_json::json!([automation("a", true)]).to_string(),
        )
        .unwrap();
        let store = AutomationStore::default();
        let dispatch = store.claim_due(&path, 10, 1024 * 1024).unwrap().unwrap();
        let updated = store
            .complete_claim(
                &path,
                "a",
                &dispatch.token,
                AutomationCompletion {
                    session_id: Some("session-a"),
                    error: None,
                    completed_at: 20,
                },
                1024 * 1024,
            )
            .unwrap();

        assert_eq!(updated["lastRunAt"], 20);
        assert_eq!(updated["lastSessionId"], "session-a");
        assert!(updated["nextRunAt"].as_u64().unwrap() > 20);
        assert!(updated.get(HOST_RUNTIME_KEY).is_none());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn once_schedule_is_disabled_only_after_successful_host_completion() {
        let path = temp_file("once");
        let mut once = automation("a", true);
        once["frequency"] = Value::from("once");
        fs::write(&path, serde_json::json!([once]).to_string()).unwrap();
        let store = AutomationStore::default();
        let dispatch = store.claim_due(&path, 10, 1024 * 1024).unwrap().unwrap();

        let updated = store
            .complete_claim(
                &path,
                "a",
                &dispatch.token,
                AutomationCompletion {
                    session_id: Some("session-once"),
                    error: None,
                    completed_at: 20,
                },
                1024 * 1024,
            )
            .unwrap();

        assert_eq!(updated["enabled"], false);
        assert_eq!(updated["nextRunAt"], 1);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn scheduled_failure_uses_backoff_but_manual_run_does_not_consume_schedule() {
        let path = temp_file("failure");
        fs::write(
            &path,
            serde_json::json!([automation("a", true)]).to_string(),
        )
        .unwrap();
        let store = AutomationStore::default();
        let scheduled = store.claim_due(&path, 10, 1024 * 1024).unwrap().unwrap();
        let failed = store
            .complete_claim(
                &path,
                "a",
                &scheduled.token,
                AutomationCompletion {
                    session_id: None,
                    error: Some("runtime offline"),
                    completed_at: 20,
                },
                1024 * 1024,
            )
            .unwrap();
        assert_eq!(failed["nextRunAt"], 1);
        assert_eq!(
            failed[HOST_RUNTIME_KEY]["retryAfterAt"],
            20 + FAILURE_RETRY_MS
        );
        assert!(store
            .claim_due(&path, 20 + FAILURE_RETRY_MS - 1, 1024 * 1024)
            .unwrap()
            .is_none());

        let manual = store.claim_now(&path, "a", 30, 1024 * 1024).unwrap();
        let completed = store
            .complete_claim(
                &path,
                "a",
                &manual.token,
                AutomationCompletion {
                    session_id: Some("manual-session"),
                    error: None,
                    completed_at: 40,
                },
                1024 * 1024,
            )
            .unwrap();
        assert_eq!(completed["nextRunAt"], 1);
        assert_eq!(
            completed[HOST_RUNTIME_KEY]["retryAfterAt"],
            20 + FAILURE_RETRY_MS
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn failure_after_session_creation_is_not_automatically_duplicated() {
        let path = temp_file("ambiguous-failure");
        fs::write(
            &path,
            serde_json::json!([automation("a", true)]).to_string(),
        )
        .unwrap();
        let store = AutomationStore::default();
        let dispatch = store.claim_due(&path, 10, 1024 * 1024).unwrap().unwrap();

        let failed = store
            .complete_claim(
                &path,
                "a",
                &dispatch.token,
                AutomationCompletion {
                    session_id: Some("possibly-started-session"),
                    error: Some("connection closed"),
                    completed_at: 20,
                },
                1024 * 1024,
            )
            .unwrap();

        assert_eq!(failed["lastRunAt"], 20);
        assert_eq!(failed["lastSessionId"], "possibly-started-session");
        assert!(failed["nextRunAt"].as_u64().unwrap() > 20);
        assert!(failed.get(HOST_RUNTIME_KEY).is_none());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn host_weekday_schedule_skips_the_weekend_in_local_time() {
        let mut task = automation("a", true);
        task["frequency"] = Value::from("weekdays");
        let friday_evening = Local
            .with_ymd_and_hms(2026, 8, 14, 18, 0, 0)
            .single()
            .unwrap();

        let next = next_automation_run(&task, friday_evening.timestamp_millis() as u64).unwrap();
        let next = Local.timestamp_millis_opt(next as i64).single().unwrap();

        assert_eq!(next.weekday(), chrono::Weekday::Mon);
        assert_eq!(next.format("%H:%M").to_string(), "09:30");
    }

    #[test]
    fn stale_completion_cannot_settle_a_recovered_claim() {
        let path = temp_file("stale");
        fs::write(
            &path,
            serde_json::json!([automation("a", true)]).to_string(),
        )
        .unwrap();
        let store = AutomationStore::default();
        let first = store.claim_due(&path, 10, 1024 * 1024).unwrap().unwrap();
        let recovered = store
            .claim_due(&path, 10 + CLAIM_LEASE_MS + 1, 1024 * 1024)
            .unwrap()
            .unwrap();
        assert!(store
            .complete_claim(
                &path,
                "a",
                &first.token,
                AutomationCompletion {
                    session_id: None,
                    error: None,
                    completed_at: 10 + CLAIM_LEASE_MS + 2,
                },
                1024 * 1024,
            )
            .is_err());
        let persisted: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(persisted[0][HOST_RUNTIME_KEY]["token"], recovered.token);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn concurrent_manual_claims_allow_only_one_background_dispatch() {
        let path = temp_file("claim-concurrent");
        fs::write(
            &path,
            serde_json::json!([automation("a", true), automation("b", true)]).to_string(),
        )
        .unwrap();
        let store = Arc::new(AutomationStore::default());
        let first_store = Arc::clone(&store);
        let first_path = path.clone();
        let first = thread::spawn(move || {
            first_store
                .claim_now(&first_path, "a", 10, 1024 * 1024)
                .is_ok()
        });
        let second_store = Arc::clone(&store);
        let second_path = path.clone();
        let second = thread::spawn(move || {
            second_store
                .claim_now(&second_path, "b", 10, 1024 * 1024)
                .is_ok()
        });

        assert_ne!(first.join().unwrap(), second.join().unwrap());
        let persisted: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            persisted
                .as_array()
                .unwrap()
                .iter()
                .filter(|automation| automation.get(HOST_RUNTIME_KEY).is_some())
                .count(),
            1
        );
        let _ = fs::remove_file(path);
    }
}
