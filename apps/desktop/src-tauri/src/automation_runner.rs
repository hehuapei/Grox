//! 进程级自动化调度器。
//!
//! Host 负责时钟、运行时门禁和持久化认领；WebView 只执行已经携带租约的派发。
//! 这样页面重载不会重置调度时钟，也不能通过本地状态重复消费同一个任务。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use tauri::{AppHandle, Emitter, Manager};

use crate::{
    acp_host::AcpHostError,
    automation_store::{AutomationCompletion, AutomationDispatch, AutomationStore},
    automations_path, AcpState, AUTOMATIONS_MAX_BYTES,
};

const BOOT_DELAY_MS: u64 = 2_000;
const TICK_INTERVAL_MS: u64 = 30_000;

#[derive(Default)]
pub(crate) struct AutomationRunner {
    started: AtomicBool,
    ready_generation: AtomicU64,
    last_tick_at: AtomicU64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationRunnerStatus {
    pub(crate) checked_at: Option<u64>,
    pub(crate) runtime_ready: bool,
    pub(crate) runtime_busy: bool,
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

    pub(crate) async fn mark_runtime_ready(
        &self,
        state: &AcpState,
        generation: u64,
    ) -> Result<(), AcpHostError> {
        let process = state.process.lock().await;
        if !process
            .as_ref()
            .is_some_and(|process| process.generation == generation)
        {
            return Err(AcpHostError::environment(
                "AUTOMATION_RUNTIME_GENERATION_STALE",
                "自动化运行时就绪信号属于已替换的 ACP 通道",
                false,
                false,
                "等待 Agent 重连完成后重试",
            ));
        }
        self.ready_generation.store(generation, Ordering::Release);
        Ok(())
    }

    pub(crate) fn mark_runtime_unready(&self) {
        self.ready_generation.store(0, Ordering::Release);
    }

    pub(crate) fn mark_generation_unready(&self, generation: u64) {
        let _ = self.ready_generation.compare_exchange(
            generation,
            0,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
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
        if !self.runtime_ready(state).await {
            return Err(AcpHostError::environment(
                "AUTOMATION_RUNTIME_NOT_READY",
                "Grok Build 运行时尚未连接，无法启动自动化任务",
                false,
                false,
                "等待运行时连接完成后重试",
            ));
        }
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
        let ready_generation = self.ready_generation.load(Ordering::Acquire);
        if ready_generation == 0 {
            return false;
        }
        state
            .process
            .lock()
            .await
            .as_ref()
            .is_some_and(|process| process.generation == ready_generation)
    }
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
