//! 进程级自动化调度器。
//!
//! Host 负责时钟、运行时门禁和持久化认领；WebView 只执行已经携带租约的派发。
//! 这样页面重载不会重置调度时钟，也不能通过本地状态重复消费同一个任务。

use std::{
    path::Path,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::Duration,
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::{
    acp_host::AcpHostError,
    automation_store::{AutomationCompletion, AutomationDispatch, AutomationStore},
    automations_path,
    mcp_leases::McpLeaseStore,
    request_acp_json,
    turn_runtime::{
        bind_mode, bind_model, complete_deep_research_prompt, effort_fallback_chain,
        is_invalid_reasoning_effort, prompt_result_invalid_effort,
    },
    AcpState, AUTOMATIONS_MAX_BYTES, UPSTREAM_CLI_CLIENT_NAME,
};

const BOOT_DELAY_MS: u64 = 2_000;
const TICK_INTERVAL_MS: u64 = 30_000;
const CLAIM_RENEW_INTERVAL_MS: u64 = 30_000;

#[derive(Default)]
pub(crate) struct AutomationRunner {
    started: AtomicBool,
    last_tick_at: AtomicU64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationRunnerStatus {
    pub(crate) checked_at: Option<u64>,
    pub(crate) runtime_ready: bool,
    pub(crate) runtime_busy: bool,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationSessionSettled {
    pub(crate) session_id: String,
    pub(crate) model: Option<String>,
    pub(crate) mode: Option<String>,
    pub(crate) requested_effort: Option<String>,
    pub(crate) effective_effort: Option<String>,
    pub(crate) usage: Option<Value>,
    pub(crate) error: Option<AcpHostError>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationSessionResult {
    pub(crate) automation: Option<Value>,
    pub(crate) effective_effort: String,
    pub(crate) error: Option<AcpHostError>,
}

struct AutomationTurnResult {
    effective_effort: String,
    usage: Option<Value>,
}

impl AutomationRunner {
    pub(crate) fn start(&self, app: AppHandle) {
        if self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(BOOT_DELAY_MS)).await;
            loop {
                if let Err(error) = tick(&app).await {
                    eprintln!("grox: 自动化 Host 调度失败：{}", error.message);
                    let _ = app.emit("automation-runner-error", error);
                }
                tokio::time::sleep(std::time::Duration::from_millis(TICK_INTERVAL_MS)).await;
            }
        });
    }

    pub(crate) async fn status(&self, state: &AcpState) -> AutomationRunnerStatus {
        let occupancy = state.sessions.snapshot();
        AutomationRunnerStatus {
            checked_at: match self.last_tick_at.load(Ordering::Acquire) {
                0 => None,
                value => Some(value),
            },
            runtime_ready: self.runtime_ready(state).await,
            runtime_busy: !occupancy.active_turn_session_ids.is_empty()
                || occupancy.lifecycle_active
                || occupancy.pending_lifecycle > 0,
        }
    }

    pub(crate) async fn ensure_dispatchable(&self, state: &AcpState) -> Result<(), AcpHostError> {
        self.ready_generation(state).await?;
        let occupancy = state.sessions.snapshot();
        if !occupancy.active_turn_session_ids.is_empty()
            || occupancy.lifecycle_active
            || occupancy.pending_lifecycle > 0
        {
            return Err(AcpHostError::operation(
                "AUTOMATION_RUNTIME_BUSY",
                "已有会话、门禁或恢复流程占用 Agent 运行时",
            ));
        }
        Ok(())
    }

    pub(crate) async fn ready_generation(&self, state: &AcpState) -> Result<u64, AcpHostError> {
        let ready_generation = state.ready_generation.load(Ordering::Acquire);
        if ready_generation != 0
            && state
                .process
                .lock()
                .await
                .as_ref()
                .is_some_and(|process| process.generation == ready_generation)
        {
            return Ok(ready_generation);
        }
        Err(AcpHostError::environment(
            "AUTOMATION_RUNTIME_NOT_READY",
            "Grok Build 运行时尚未连接，无法启动自动化任务",
            false,
            false,
            "等待运行时连接完成后重试",
        ))
    }

    pub(crate) fn emit_dispatch(
        &self,
        app: &AppHandle,
        dispatch: AutomationDispatch,
    ) -> Result<(), AcpHostError> {
        let window = app.get_webview_window("main").ok_or_else(|| {
            AcpHostError::environment(
                "AUTOMATION_WINDOW_UNAVAILABLE",
                "主窗口不存在，无法消费自动化派发",
                false,
                false,
                "重新打开 Grox 主窗口后等待 Host 恢复任务",
            )
        })?;
        window
            .emit("automation-dispatch", dispatch)
            .map_err(|error| {
                AcpHostError::environment(
                    "AUTOMATION_DISPATCH_FAILED",
                    format!("无法把已认领任务交给桌面运行时：{error}"),
                    false,
                    false,
                    "保持 Grox 打开并重新运行任务",
                )
            })
    }

    async fn runtime_ready(&self, state: &AcpState) -> bool {
        self.ready_generation(state).await.is_ok()
    }
}

pub(crate) async fn execute_claimed_session(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &AcpState,
    leases: &McpLeaseStore,
    runner: &AutomationRunner,
    store: &AutomationStore,
    id: &str,
    token: &str,
    session_id: &str,
) -> Result<AutomationSessionResult, AcpHostError> {
    let path = automations_path(app).map_err(storage_error)?;
    let claimed = store
        .begin_execution(&path, id, token, unix_time_ms(), AUTOMATIONS_MAX_BYTES)
        .map_err(crate::automation_claim_error)?;
    debug_assert!(claimed.lease_expires_at > unix_time_ms());
    let automation = &claimed.automation;
    let model = automation_string(automation, "model")?;
    let mode = automation_string(automation, "mode")?;
    let requested_effort = automation_string(automation, "effort")?;
    let permission_mode = automation_string(automation, "permissionMode")?;
    let prompt = automation_string(automation, "prompt")?;

    let turn = run_claimed_turn(
        state,
        leases,
        runner,
        store,
        &path,
        id,
        token,
        session_id,
        &model,
        &mode,
        &requested_effort,
        &permission_mode,
        &prompt,
    )
    .await;
    let (effective_effort, usage, execution_error) = match turn {
        Ok(turn) => (turn.effective_effort, turn.usage, None),
        Err(error) => (requested_effort.clone(), None, Some(error)),
    };

    let settled = AutomationSessionSettled {
        session_id: session_id.to_string(),
        model: Some(model),
        mode: Some(mode),
        requested_effort: Some(requested_effort),
        effective_effort: Some(effective_effort.clone()),
        usage,
        error: execution_error.clone(),
    };
    if let Err(error) = window.emit("automation-session-settled", settled) {
        eprintln!("grox: 无法投影自动化会话终态：{error}");
    }

    let error_detail = execution_error
        .as_ref()
        .map(|error| error.message.chars().take(3_500).collect::<String>());
    let settlement = store.complete_claim(
        &path,
        id,
        token,
        AutomationCompletion {
            session_id: Some(session_id),
            error: error_detail.as_deref(),
            completed_at: unix_time_ms(),
        },
        AUTOMATIONS_MAX_BYTES,
    );
    match settlement {
        Ok(updated) => Ok(AutomationSessionResult {
            automation: Some(updated),
            effective_effort,
            error: execution_error,
        }),
        Err(error) => Ok(AutomationSessionResult {
            automation: None,
            effective_effort,
            error: Some(crate::automation_claim_error(error)),
        }),
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_claimed_turn(
    state: &AcpState,
    leases: &McpLeaseStore,
    runner: &AutomationRunner,
    store: &AutomationStore,
    path: &Path,
    id: &str,
    token: &str,
    session_id: &str,
    model: &str,
    mode: &str,
    requested_effort: &str,
    permission_mode: &str,
    prompt: &str,
) -> Result<AutomationTurnResult, AcpHostError> {
    let generation = runner.ready_generation(state).await?;
    let permit = state
        .sessions
        .acquire_turn(session_id.to_string(), generation)
        .await?;
    let gate_token = permit.token();

    renew_execution_claim(store, path, id, token)?;
    let mut effective_effort = bind_model(
        state,
        leases,
        session_id,
        model,
        requested_effort,
        generation,
        gate_token,
        None,
    )
    .await?;
    renew_execution_claim(store, path, id, token)?;
    bind_mode(
        state, leases, session_id, mode, generation, gate_token, None,
    )
    .await?;

    let dispatch_prompt = complete_deep_research_prompt(prompt);
    let mut attempted = std::collections::BTreeSet::new();
    attempted.insert(effective_effort.clone());
    let mut response = prompt_with_claim_renewal(
        state,
        leases,
        store,
        path,
        id,
        token,
        session_id,
        &dispatch_prompt,
        &effective_effort,
        permission_mode,
        generation,
        gate_token,
    )
    .await;

    if response
        .as_ref()
        .err()
        .is_some_and(is_invalid_reasoning_effort)
        || response
            .as_ref()
            .ok()
            .and_then(prompt_result_invalid_effort)
            .is_some()
    {
        response = Err(response.err().unwrap_or_else(|| {
            AcpHostError::protocol(
                "ACP_INVALID_REASONING_EFFORT",
                "当前模型或 API 拒绝了推理强度",
            )
        }));
        for candidate in effort_fallback_chain(requested_effort) {
            let bound = bind_model(
                state, leases, session_id, model, candidate, generation, gate_token, None,
            )
            .await?;
            if !attempted.insert(bound.clone()) {
                continue;
            }
            effective_effort = bound;
            match prompt_with_claim_renewal(
                state,
                leases,
                store,
                path,
                id,
                token,
                session_id,
                &dispatch_prompt,
                &effective_effort,
                permission_mode,
                generation,
                gate_token,
            )
            .await
            {
                Ok(value) if prompt_result_invalid_effort(&value).is_none() => {
                    response = Ok(value);
                    break;
                }
                Ok(value) => {
                    response = Err(AcpHostError::protocol(
                        "ACP_INVALID_REASONING_EFFORT",
                        prompt_result_invalid_effort(&value)
                            .unwrap_or_else(|| "当前模型或 API 拒绝了推理强度".into()),
                    ));
                }
                Err(error) if is_invalid_reasoning_effort(&error) => {
                    response = Err(error);
                }
                Err(error) => return Err(error),
            }
        }
    }

    let response = response?;
    let usage = response
        .get("_meta")
        .and_then(|meta| meta.get("usage"))
        .cloned();
    Ok(AutomationTurnResult {
        effective_effort,
        usage,
    })
}

#[allow(clippy::too_many_arguments)]
async fn prompt_with_claim_renewal(
    state: &AcpState,
    leases: &McpLeaseStore,
    store: &AutomationStore,
    path: &Path,
    id: &str,
    token: &str,
    session_id: &str,
    prompt: &str,
    effort: &str,
    permission_mode: &str,
    generation: u64,
    gate_token: u64,
) -> Result<Value, AcpHostError> {
    renew_execution_claim(store, path, id, token)?;
    let request = request_acp_json(
        state,
        leases,
        "session/prompt",
        json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": prompt }],
            "_meta": {
                "reasoningEffort": effort,
                "clientIdentifier": UPSTREAM_CLI_CLIENT_NAME,
                "yoloMode": permission_mode == "bypass",
                "autoMode": permission_mode == "auto",
            },
        }),
        generation,
        0,
        Some(gate_token),
    );
    tokio::pin!(request);
    let mut renewal_error = None;
    loop {
        match tokio::time::timeout(Duration::from_millis(CLAIM_RENEW_INTERVAL_MS), &mut request)
            .await
        {
            Ok(result) => {
                if renewal_error.is_some() {
                    // Prompt 已经有权威结果时再做一次同步续租；若文件系统只是瞬时
                    // 抖动，最终结算不应被误记为 Agent 回合失败。
                    renew_execution_claim(store, path, id, token)?;
                }
                return result;
            }
            Err(_) => {
                match store.renew_claim(path, id, token, unix_time_ms(), AUTOMATIONS_MAX_BYTES) {
                    Ok(_) => renewal_error = None,
                    Err(error) => renewal_error = Some(error),
                }
            }
        }
    }
}

fn renew_execution_claim(
    store: &AutomationStore,
    path: &Path,
    id: &str,
    token: &str,
) -> Result<u64, AcpHostError> {
    store
        .renew_claim(path, id, token, unix_time_ms(), AUTOMATIONS_MAX_BYTES)
        .map_err(crate::automation_claim_error)
}

fn automation_string(automation: &Value, key: &str) -> Result<String, AcpHostError> {
    automation
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            AcpHostError::protocol(
                "AUTOMATION_INVALID_RESULT",
                format!("Host 认领的自动化缺少 {key}"),
            )
        })
}

async fn tick(app: &AppHandle) -> Result<(), AcpHostError> {
    let runner = app.state::<AutomationRunner>();
    let state = app.state::<std::sync::Arc<AcpState>>();
    let checked_at = unix_time_ms();
    runner.last_tick_at.store(checked_at, Ordering::Release);
    let status = runner.status(state.inner()).await;
    let _ = app.emit("automation-runner-tick", status.clone());
    if !status.runtime_ready || status.runtime_busy {
        return Ok(());
    }

    let path = automations_path(app).map_err(storage_error)?;
    let store = app.state::<AutomationStore>();
    if let Some(dispatch) = store
        .claim_due(&path, checked_at, AUTOMATIONS_MAX_BYTES)
        .map_err(storage_error)?
    {
        if let Err(error) = runner.emit_dispatch(app, dispatch.clone()) {
            let id = dispatch
                .automation
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            if let Err(settle_error) = store.complete_claim(
                &path,
                id,
                &dispatch.token,
                AutomationCompletion {
                    session_id: None,
                    error: Some(&error.message),
                    completed_at: checked_at,
                },
                AUTOMATIONS_MAX_BYTES,
            ) {
                return Err(storage_error(format!(
                    "{}；派发失败后的租约结算也失败：{settle_error}",
                    error.message
                )));
            }
            return Err(error);
        }
    }
    Ok(())
}

pub(crate) fn unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

pub(crate) fn storage_error(message: String) -> AcpHostError {
    AcpHostError::environment(
        "AUTOMATION_STORAGE_FAILED",
        message,
        false,
        false,
        "检查应用数据目录的权限和磁盘空间后重试",
    )
}
