//! ACP JSON-RPC 请求归属。
//!
//! stdio 子进程属于原生 Host，因此请求与响应的关联、超时和进程退出清算也必须
//! 留在 Host。WebView 只消费已经归属完成的响应和主动事件，不能成为运行时真相源。

use std::collections::{BTreeMap, BTreeSet};

use tokio::sync::{oneshot, Mutex};

use crate::acp_inbound::AcpInbound;

pub(crate) type AcpHostError = crate::host_error::HostError;

struct PendingRequest {
    generation: u64,
    method: String,
    reply: oneshot::Sender<Result<String, AcpHostError>>,
}

#[derive(Default)]
struct RequestBrokerState {
    pending: BTreeMap<u64, PendingRequest>,
    /// 主动取消后 Agent 仍可能返回原请求结果；只吞掉一次精确匹配的迟到响应。
    retired: BTreeSet<(u64, u64)>,
}

#[derive(Default)]
pub(crate) struct AcpRequestBroker {
    state: Mutex<RequestBrokerState>,
}

const MAX_RETIRED_REQUESTS: usize = 256;

fn remember_retired(state: &mut RequestBrokerState, generation: u64, request_id: u64) {
    state.retired.insert((generation, request_id));
    while state.retired.len() > MAX_RETIRED_REQUESTS {
        let Some(oldest) = state.retired.first().copied() else {
            break;
        };
        state.retired.remove(&oldest);
    }
}

impl AcpRequestBroker {
    pub(crate) async fn register(
        &self,
        request_id: u64,
        generation: u64,
        method: String,
    ) -> Result<oneshot::Receiver<Result<String, AcpHostError>>, AcpHostError> {
        let (reply, receiver) = oneshot::channel();
        let mut state = self.state.lock().await;
        if state.pending.contains_key(&request_id) {
            return Err(AcpHostError::protocol(
                "ACP_DUPLICATE_REQUEST",
                format!("ACP 请求编号重复：{request_id}"),
            ));
        }
        state.retired.remove(&(generation, request_id));
        state.pending.insert(
            request_id,
            PendingRequest {
                generation,
                method,
                reply,
            },
        );
        Ok(receiver)
    }

    #[cfg(test)]
    pub(crate) async fn resolve_response(&self, generation: u64, line: &str) -> bool {
        let Ok(message) = AcpInbound::parse(line) else {
            return false;
        };
        self.resolve_decoded_response(generation, line, &message)
            .await
    }

    /// 消费属于当前 Host 请求的已解码响应。未知响应继续交给事件通道报告协议异常。
    pub(crate) async fn resolve_decoded_response(
        &self,
        generation: u64,
        line: &str,
        message: &AcpInbound,
    ) -> bool {
        if message.method().is_some() {
            return false;
        }
        let Some(request_id) = message.id().and_then(serde_json::Value::as_u64) else {
            return false;
        };

        let (request, retired) = {
            let mut state = self.state.lock().await;
            let request = if state
                .pending
                .get(&request_id)
                .is_some_and(|request| request.generation == generation)
            {
                state.pending.remove(&request_id)
            } else {
                None
            };
            let retired = request.is_none() && state.retired.remove(&(generation, request_id));
            (request, retired)
        };
        let Some(request) = request else {
            return retired;
        };
        let _ = request.reply.send(Ok(line.to_string()));
        true
    }

    pub(crate) async fn reject(
        &self,
        request_id: u64,
        generation: u64,
        error: AcpHostError,
    ) -> bool {
        let request = {
            let mut state = self.state.lock().await;
            let request = if state
                .pending
                .get(&request_id)
                .is_some_and(|request| request.generation == generation)
            {
                state.pending.remove(&request_id)
            } else {
                None
            };
            if request.is_some() {
                remember_retired(&mut state, generation, request_id);
            }
            request
        };
        let Some(request) = request else {
            return false;
        };
        let _ = request.reply.send(Err(error));
        true
    }

    pub(crate) async fn reject_generation(&self, generation: u64, error: AcpHostError) {
        let requests = {
            let mut state = self.state.lock().await;
            let ids = state
                .pending
                .iter()
                .filter_map(|(id, request)| (request.generation == generation).then_some(*id))
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| state.pending.remove(&id))
                .collect::<Vec<_>>()
        };
        for request in requests {
            let _ = request
                .reply
                .send(Err(error.clone().for_method(&request.method)));
        }
    }

    pub(crate) async fn reject_all(&self, error: AcpHostError) {
        let requests = {
            let mut state = self.state.lock().await;
            std::mem::take(&mut state.pending)
                .into_values()
                .collect::<Vec<_>>()
        };
        for request in requests {
            let _ = request
                .reply
                .send(Err(error.clone().for_method(&request.method)));
        }
    }

    pub(crate) async fn len(&self) -> usize {
        self.state.lock().await.pending.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_is_delivered_only_to_matching_generation() {
        tauri::async_runtime::block_on(async {
            let broker = AcpRequestBroker::default();
            let receiver = broker.register(7, 3, "session/list".into()).await.unwrap();

            assert!(
                !broker
                    .resolve_response(2, r#"{"jsonrpc":"2.0","id":7,"result":[]}"#)
                    .await
            );
            assert!(
                broker
                    .resolve_response(3, r#"{"jsonrpc":"2.0","id":7,"result":[]}"#)
                    .await
            );
            assert_eq!(
                receiver.await.unwrap().unwrap(),
                r#"{"jsonrpc":"2.0","id":7,"result":[]}"#
            );
        });
    }

    #[test]
    fn notifications_and_server_requests_are_not_consumed() {
        tauri::async_runtime::block_on(async {
            let broker = AcpRequestBroker::default();
            assert!(
                !broker
                    .resolve_response(1, r#"{"jsonrpc":"2.0","method":"session/update"}"#)
                    .await
            );
            assert!(
                !broker
                    .resolve_response(
                        1,
                        r#"{"jsonrpc":"2.0","id":9,"method":"session/request_permission"}"#,
                    )
                    .await
            );
        });
    }

    #[test]
    fn process_exit_rejects_every_request_in_that_generation() {
        tauri::async_runtime::block_on(async {
            let broker = AcpRequestBroker::default();
            let first = broker.register(1, 4, "initialize".into()).await.unwrap();
            let second = broker
                .register(2, 5, "session/prompt".into())
                .await
                .unwrap();

            broker
                .reject_generation(
                    4,
                    AcpHostError::environment(
                        "ACP_PROCESS_EXITED",
                        "Agent 已退出",
                        true,
                        true,
                        "检查运行时",
                    ),
                )
                .await;
            assert_eq!(
                first.await.unwrap().unwrap_err().message,
                "Agent 已退出 · initialize"
            );
            assert_eq!(broker.len().await, 1);

            assert!(
                broker
                    .resolve_response(5, r#"{"jsonrpc":"2.0","id":2,"result":{}}"#)
                    .await
            );
            assert!(second.await.unwrap().is_ok());
        });
    }

    #[test]
    fn duplicate_ids_and_cross_generation_cancel_are_rejected() {
        tauri::async_runtime::block_on(async {
            let broker = AcpRequestBroker::default();
            let receiver = broker.register(11, 6, "session/load".into()).await.unwrap();
            assert!(broker
                .register(11, 6, "session/prompt".into())
                .await
                .is_err());
            assert!(
                !broker
                    .reject(
                        11,
                        5,
                        AcpHostError::operation("ACP_REQUEST_CANCELLED", "旧进程取消"),
                    )
                    .await
            );
            assert!(
                broker
                    .reject(
                        11,
                        6,
                        AcpHostError::operation("ACP_REQUEST_CANCELLED", "用户停止"),
                    )
                    .await
            );
            assert_eq!(receiver.await.unwrap().unwrap_err().message, "用户停止");
        });
    }

    #[test]
    fn cancelled_request_consumes_exactly_one_late_response() {
        tauri::async_runtime::block_on(async {
            let broker = AcpRequestBroker::default();
            let receiver = broker
                .register(21, 8, "session/prompt".into())
                .await
                .unwrap();
            assert!(
                broker
                    .reject(
                        21,
                        8,
                        AcpHostError::operation("SESSION_PROMPT_CANCELLED", "用户停止"),
                    )
                    .await
            );
            assert_eq!(receiver.await.unwrap().unwrap_err().message, "用户停止");

            let response = r#"{"jsonrpc":"2.0","id":21,"result":{"stopReason":"cancelled"}}"#;
            assert!(broker.resolve_response(8, response).await);
            assert!(!broker.resolve_response(8, response).await);
            assert!(!broker.resolve_response(9, response).await);
        });
    }

    #[test]
    fn host_error_serializes_the_frontend_error_contract() {
        let value = serde_json::to_value(AcpHostError::environment(
            "ACP_PROCESS_EXITED",
            "Agent 已退出",
            true,
            true,
            "检查最后一轮结果",
        ))
        .unwrap();
        assert_eq!(value["domain"], "environment");
        assert_eq!(value["code"], "ACP_PROCESS_EXITED");
        assert_eq!(value["holdQueue"], true);
        assert_eq!(value["action"], "检查最后一轮结果");
    }
}
