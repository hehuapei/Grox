//! 共享 ACP 进程的会话并发协调器。
//!
//! `session/new`、`session/load` 与原生会话 fork 会改变进程级上下文；`session/prompt` 则占用
//! 一个具体会话。许可必须由原生 Host 签发并校验，WebView 只负责在操作结束时
//! 归还 token，不能自行声明运行时是否空闲。

use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use tokio::sync::{watch, Notify};

use crate::acp_host::AcpHostError;

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRuntimeOccupancy {
    pub(crate) active_turn_session_ids: Vec<String>,
    pub(crate) lifecycle_active: bool,
    pub(crate) pending_lifecycle: usize,
}

#[derive(Default)]
struct CoordinatorState {
    generation: u64,
    active_turns: BTreeMap<String, u64>,
    lifecycle_active: Option<u64>,
    lifecycle_queue: VecDeque<u64>,
}

pub(crate) struct SessionCoordinator {
    state: Mutex<CoordinatorState>,
    changed: Notify,
    next_token: AtomicU64,
    occupancy: watch::Sender<SessionRuntimeOccupancy>,
}

/// Host 自有许可在成功、失败和取消路径都会自动释放。
/// WebView 调用仍使用显式 token，但原生事务不能依赖后续 IPC 才完成清理。
pub(crate) struct SessionPermit {
    coordinator: Arc<SessionCoordinator>,
    token: u64,
    generation: u64,
}

impl SessionPermit {
    pub(crate) fn token(&self) -> u64 {
        self.token
    }
}

impl Drop for SessionPermit {
    fn drop(&mut self) {
        self.coordinator.release(self.token, self.generation);
    }
}

impl Default for SessionCoordinator {
    fn default() -> Self {
        let (occupancy, _) = watch::channel(SessionRuntimeOccupancy::default());
        Self {
            state: Mutex::new(CoordinatorState::default()),
            changed: Notify::new(),
            next_token: AtomicU64::new(0),
            occupancy,
        }
    }
}

impl SessionCoordinator {
    pub(crate) fn subscribe(&self) -> watch::Receiver<SessionRuntimeOccupancy> {
        self.occupancy.subscribe()
    }

    pub(crate) fn snapshot(&self) -> SessionRuntimeOccupancy {
        let state = self.lock_state();
        Self::snapshot_locked(&state)
    }

    /// 切换进程代次会原子清空旧许可并唤醒所有等待者。
    pub(crate) fn reset(&self, generation: u64) {
        let mut state = self.lock_state();
        state.generation = generation;
        state.active_turns.clear();
        state.lifecycle_active = None;
        state.lifecycle_queue.clear();
        self.publish_locked(&state);
    }

    pub(crate) async fn enter_turn(
        self: &Arc<Self>,
        session_id: String,
        generation: u64,
    ) -> Result<u64, AcpHostError> {
        let session_id = session_id.trim().to_string();
        if session_id.is_empty() {
            return Err(AcpHostError::operation(
                "SESSION_GATE_INVALID_SESSION",
                "ACP 回合缺少 sessionId",
            ));
        }

        loop {
            // 先注册通知再检查状态，避免释放发生在检查与 await 之间。
            let changed = self.changed.notified();
            {
                let mut state = self.lock_state();
                Self::ensure_generation(&state, generation)?;
                if state.active_turns.contains_key(&session_id) {
                    return Err(AcpHostError::operation(
                        "SESSION_TURN_ALREADY_ACTIVE",
                        format!("会话已有活动回合：{session_id}"),
                    ));
                }
                if state.lifecycle_active.is_none() && state.lifecycle_queue.is_empty() {
                    let token = self.issue_token();
                    state.active_turns.insert(session_id, token);
                    self.publish_locked(&state);
                    return Ok(token);
                }
            }
            changed.await;
        }
    }

    pub(crate) async fn acquire_turn(
        self: &Arc<Self>,
        session_id: String,
        generation: u64,
    ) -> Result<SessionPermit, AcpHostError> {
        let token = self.enter_turn(session_id, generation).await?;
        Ok(SessionPermit {
            coordinator: Arc::clone(self),
            token,
            generation,
        })
    }

    pub(crate) async fn enter_lifecycle(
        self: &Arc<Self>,
        generation: u64,
    ) -> Result<u64, AcpHostError> {
        let ticket = self.issue_token();
        {
            let mut state = self.lock_state();
            Self::ensure_generation(&state, generation)?;
            state.lifecycle_queue.push_back(ticket);
            self.publish_locked(&state);
        }
        let mut queued = QueuedLifecycle {
            coordinator: Arc::clone(self),
            generation,
            ticket,
            active: true,
        };

        loop {
            let changed = self.changed.notified();
            {
                let mut state = self.lock_state();
                Self::ensure_generation(&state, generation)?;
                let is_front = state.lifecycle_queue.front().copied() == Some(ticket);
                if is_front && state.lifecycle_active.is_none() && state.active_turns.is_empty() {
                    state.lifecycle_queue.pop_front();
                    state.lifecycle_active = Some(ticket);
                    queued.active = false;
                    self.publish_locked(&state);
                    return Ok(ticket);
                }
            }
            changed.await;
        }
    }

    pub(crate) async fn acquire_lifecycle(
        self: &Arc<Self>,
        generation: u64,
    ) -> Result<SessionPermit, AcpHostError> {
        let token = self.enter_lifecycle(generation).await?;
        Ok(SessionPermit {
            coordinator: Arc::clone(self),
            token,
            generation,
        })
    }

    pub(crate) fn release(&self, token: u64, generation: u64) -> bool {
        let mut state = self.lock_state();
        if state.generation != generation {
            return false;
        }
        let removed = if state.lifecycle_active == Some(token) {
            state.lifecycle_active = None;
            true
        } else {
            let session = state
                .active_turns
                .iter()
                .find_map(|(session_id, active_token)| {
                    (*active_token == token).then(|| session_id.clone())
                });
            session
                .and_then(|session_id| state.active_turns.remove(&session_id))
                .is_some()
        };
        if removed {
            self.publish_locked(&state);
        }
        removed
    }

    /// 敏感 ACP 方法必须携带当前代次内由 Host 签发的匹配许可。
    pub(crate) fn verify_request(
        &self,
        method: &str,
        params: &serde_json::Value,
        gate_token: Option<u64>,
        generation: u64,
    ) -> Result<(), AcpHostError> {
        let method = method
            .strip_prefix("_x.ai/")
            .map(|suffix| format!("x.ai/{suffix}"))
            .unwrap_or_else(|| method.to_string());
        let requirement = match method.as_str() {
            "session/new" | "session/load" | "x.ai/session/fork" => {
                GateRequirement::Lifecycle
            }
            "session/prompt" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        AcpHostError::protocol(
                            "ACP_INVALID_REQUEST",
                            "session/prompt 缺少 sessionId",
                        )
                    })?;
                GateRequirement::Turn(session_id)
            }
            _ => return Ok(()),
        };
        let token = gate_token.ok_or_else(|| {
            AcpHostError::operation(
                "SESSION_GATE_REQUIRED",
                format!("{method} 必须先取得原生会话许可"),
            )
        })?;
        let state = self.lock_state();
        Self::ensure_generation(&state, generation)?;
        let valid = match requirement {
            GateRequirement::Lifecycle => state.lifecycle_active == Some(token),
            GateRequirement::Turn(session_id) => {
                state.active_turns.get(session_id).copied() == Some(token)
            }
        };
        if valid {
            Ok(())
        } else {
            Err(AcpHostError::operation(
                "SESSION_GATE_MISMATCH",
                format!("{method} 的原生会话许可无效或不匹配"),
            ))
        }
    }

    fn cancel_lifecycle_waiter(&self, generation: u64, ticket: u64) {
        let mut state = self.lock_state();
        if state.generation != generation {
            return;
        }
        let Some(index) = state
            .lifecycle_queue
            .iter()
            .position(|queued| *queued == ticket)
        else {
            return;
        };
        state.lifecycle_queue.remove(index);
        self.publish_locked(&state);
    }

    fn issue_token(&self) -> u64 {
        self.next_token.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn ensure_generation(state: &CoordinatorState, generation: u64) -> Result<(), AcpHostError> {
        if state.generation == generation {
            Ok(())
        } else {
            Err(AcpHostError::environment(
                "ACP_CHANNEL_REPLACED",
                "ACP 通道已切换，旧会话许可已失效",
                true,
                true,
                "Agent 重连后重新发送当前操作",
            ))
        }
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, CoordinatorState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn snapshot_locked(state: &CoordinatorState) -> SessionRuntimeOccupancy {
        SessionRuntimeOccupancy {
            active_turn_session_ids: state.active_turns.keys().cloned().collect(),
            lifecycle_active: state.lifecycle_active.is_some(),
            pending_lifecycle: state.lifecycle_queue.len(),
        }
    }

    fn publish_locked(&self, state: &CoordinatorState) {
        self.occupancy.send_replace(Self::snapshot_locked(state));
        self.changed.notify_waiters();
    }
}

enum GateRequirement<'a> {
    Turn(&'a str),
    Lifecycle,
}

struct QueuedLifecycle {
    coordinator: Arc<SessionCoordinator>,
    generation: u64,
    ticket: u64,
    active: bool,
}

impl Drop for QueuedLifecycle {
    fn drop(&mut self) {
        if self.active {
            self.coordinator
                .cancel_lifecycle_waiter(self.generation, self.ticket);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn different_sessions_can_run_concurrently() {
        tauri::async_runtime::block_on(async {
            let coordinator = Arc::new(SessionCoordinator::default());
            coordinator.reset(3);
            let first = coordinator.enter_turn("b".into(), 3).await.unwrap();
            let second = coordinator.enter_turn("a".into(), 3).await.unwrap();

            assert_eq!(
                coordinator.snapshot(),
                SessionRuntimeOccupancy {
                    active_turn_session_ids: vec!["a".into(), "b".into()],
                    lifecycle_active: false,
                    pending_lifecycle: 0,
                }
            );
            assert!(coordinator.release(first, 3));
            assert!(coordinator.release(second, 3));
        });
    }

    #[test]
    fn duplicate_turn_for_same_session_fails_immediately() {
        tauri::async_runtime::block_on(async {
            let coordinator = Arc::new(SessionCoordinator::default());
            coordinator.reset(5);
            let token = coordinator.enter_turn("session-a".into(), 5).await.unwrap();

            assert_eq!(
                coordinator
                    .enter_turn("session-a".into(), 5)
                    .await
                    .unwrap_err()
                    .code,
                "SESSION_TURN_ALREADY_ACTIVE"
            );
            assert!(coordinator.release(token, 5));
        });
    }

    #[test]
    fn queued_lifecycle_is_fifo_and_blocks_new_turns() {
        tauri::async_runtime::block_on(async {
            let coordinator = Arc::new(SessionCoordinator::default());
            coordinator.reset(7);
            let active = coordinator.enter_turn("active".into(), 7).await.unwrap();

            let first_coordinator = Arc::clone(&coordinator);
            let first = tauri::async_runtime::spawn(async move {
                first_coordinator.enter_lifecycle(7).await.unwrap()
            });
            while coordinator.snapshot().pending_lifecycle < 1 {
                tokio::task::yield_now().await;
            }
            let second_coordinator = Arc::clone(&coordinator);
            let second = tauri::async_runtime::spawn(async move {
                second_coordinator.enter_lifecycle(7).await.unwrap()
            });
            while coordinator.snapshot().pending_lifecycle < 2 {
                tokio::task::yield_now().await;
            }
            let turn_coordinator = Arc::clone(&coordinator);
            let turn = tauri::async_runtime::spawn(async move {
                turn_coordinator.enter_turn("late".into(), 7).await.unwrap()
            });

            assert!(coordinator.release(active, 7));
            let first_token = first.await.unwrap();
            assert!(coordinator.snapshot().lifecycle_active);
            assert_eq!(coordinator.snapshot().pending_lifecycle, 1);
            assert!(coordinator.release(first_token, 7));
            let second_token = second.await.unwrap();
            assert!(coordinator.release(second_token, 7));
            let turn_token = turn.await.unwrap();
            assert_eq!(coordinator.snapshot().active_turn_session_ids, ["late"]);
            assert!(coordinator.release(turn_token, 7));
        });
    }

    #[test]
    fn cancelled_lifecycle_waiter_does_not_leave_phantom_occupancy() {
        tauri::async_runtime::block_on(async {
            let coordinator = Arc::new(SessionCoordinator::default());
            coordinator.reset(4);
            let active = coordinator.enter_turn("active".into(), 4).await.unwrap();
            let waiting_coordinator = Arc::clone(&coordinator);
            let waiting =
                tauri::async_runtime::spawn(
                    async move { waiting_coordinator.enter_lifecycle(4).await },
                );
            while coordinator.snapshot().pending_lifecycle == 0 {
                tokio::task::yield_now().await;
            }

            waiting.abort();
            let _ = waiting.await;
            while coordinator.snapshot().pending_lifecycle != 0 {
                tokio::task::yield_now().await;
            }
            assert!(coordinator.release(active, 4));
        });
    }

    #[test]
    fn reset_invalidates_active_and_waiting_permits() {
        tauri::async_runtime::block_on(async {
            let coordinator = Arc::new(SessionCoordinator::default());
            coordinator.reset(8);
            let active = coordinator.enter_turn("active".into(), 8).await.unwrap();
            let waiting_coordinator = Arc::clone(&coordinator);
            let waiting =
                tauri::async_runtime::spawn(
                    async move { waiting_coordinator.enter_lifecycle(8).await },
                );
            while coordinator.snapshot().pending_lifecycle == 0 {
                tokio::task::yield_now().await;
            }

            coordinator.reset(9);
            assert_eq!(
                waiting.await.unwrap().unwrap_err().code,
                "ACP_CHANNEL_REPLACED"
            );
            assert!(!coordinator.release(active, 8));
            assert_eq!(coordinator.snapshot(), SessionRuntimeOccupancy::default());
        });
    }

    #[test]
    fn sensitive_methods_require_matching_native_permit() {
        tauri::async_runtime::block_on(async {
            let coordinator = Arc::new(SessionCoordinator::default());
            coordinator.reset(2);
            let turn = coordinator.enter_turn("session-a".into(), 2).await.unwrap();
            let prompt = serde_json::json!({ "sessionId": "session-a" });
            assert!(coordinator
                .verify_request("session/prompt", &prompt, Some(turn), 2)
                .is_ok());
            assert_eq!(
                coordinator
                    .verify_request(
                        "session/prompt",
                        &serde_json::json!({ "sessionId": "session-b" }),
                        Some(turn),
                        2,
                    )
                    .unwrap_err()
                    .code,
                "SESSION_GATE_MISMATCH"
            );
            assert_eq!(
                coordinator
                    .verify_request("session/new", &serde_json::json!({}), None, 2)
                    .unwrap_err()
                    .code,
                "SESSION_GATE_REQUIRED"
            );
        });
    }

    #[test]
    fn host_permit_releases_on_drop() {
        tauri::async_runtime::block_on(async {
            let coordinator = Arc::new(SessionCoordinator::default());
            coordinator.reset(6);
            {
                let permit = coordinator.acquire_lifecycle(6).await.unwrap();
                assert!(coordinator
                    .verify_request(
                        "session/new",
                        &serde_json::json!({}),
                        Some(permit.token()),
                        6
                    )
                    .is_ok());
                assert!(coordinator
                    .verify_request(
                        "_x.ai/session/fork",
                        &serde_json::json!({}),
                        Some(permit.token()),
                        6
                    )
                    .is_ok());
            }
            assert!(!coordinator.snapshot().lifecycle_active);
        });
    }
}
