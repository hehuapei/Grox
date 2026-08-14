//! ACP JSON-RPC 请求归属。
//!
//! stdio 子进程属于原生 Host，因此请求与响应的关联、超时和进程退出清算也必须
//! 留在 Host。WebView 只消费已经归属完成的响应和主动事件，不能成为运行时真相源。

use std::collections::BTreeMap;

use tokio::sync::{oneshot, Mutex};

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcpHostError {
    pub(crate) domain: &'static str,
    pub(crate) code: &'static str,
    pub(crate) message: String,
    pub(crate) recoverable: bool,
    pub(crate) fatal: bool,
    pub(crate) hold_queue: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) action: Option<&'static str>,
}

impl AcpHostError {
    pub(crate) fn protocol(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            domain: "protocol",
            code,
            message: message.into(),
            recoverable: true,
            fatal: false,
            hold_queue: false,
            action: Some("若持续出现，请升级 Grok Build CLI 并导出会话诊断"),
        }
    }

    pub(crate) fn operation(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            domain: "operation",
            code,
            message: message.into(),
            recoverable: true,
            fatal: false,
            hold_queue: false,
            action: None,
        }
    }

    pub(crate) fn environment(
        code: &'static str,
        message: impl Into<String>,
        fatal: bool,
        hold_queue: bool,
        action: &'static str,
    ) -> Self {
        Self {
            domain: "environment",
            code,
            message: message.into(),
            recoverable: true,
            fatal,
            hold_queue,
            action: Some(action),
        }
    }

    fn for_method(mut self, method: &str) -> Self {
        self.message = format!("{} · {method}", self.message);
        self
    }
}

struct PendingRequest {
    generation: u64,
    method: String,
    reply: oneshot::Sender<Result<String, AcpHostError>>,
}

#[derive(Default)]
pub(crate) struct AcpRequestBroker {
    pending: Mutex<BTreeMap<u64, PendingRequest>>,
}

impl AcpRequestBroker {
    pub(crate) async fn register(
        &self,
        request_id: u64,
        generation: u64,
        method: String,
    ) -> Result<oneshot::Receiver<Result<String, AcpHostError>>, AcpHostError> {
        let (reply, receiver) = oneshot::channel();
        let mut pending = self.pending.lock().await;
        if pending.contains_key(&request_id) {
            return Err(AcpHostError::protocol(
                "ACP_DUPLICATE_REQUEST",
                format!("ACP 请求编号重复：{request_id}"),
            ));
        }
        pending.insert(
            request_id,
            PendingRequest {
                generation,
                method,
                reply,
            },
        );
        Ok(receiver)
    }

    /// 消费属于当前 Host 请求的响应。未知响应继续交给事件通道报告协议异常。
    pub(crate) async fn resolve_response(&self, generation: u64, line: &str) -> bool {
        let Ok(message) = serde_json::from_str::<serde_json::Value>(line) else {
            return false;
        };
        if message.get("method").is_some() {
            return false;
        }
        let Some(request_id) = message.get("id").and_then(serde_json::Value::as_u64) else {
            return false;
        };

        let request = {
            let mut pending = self.pending.lock().await;
            if pending
                .get(&request_id)
                .is_some_and(|request| request.generation == generation)
            {
                pending.remove(&request_id)
            } else {
                None
            }
        };
        let Some(request) = request else {
            return false;
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
            let mut pending = self.pending.lock().await;
            if pending
                .get(&request_id)
                .is_some_and(|request| request.generation == generation)
            {
                pending.remove(&request_id)
            } else {
                None
            }
        };
        let Some(request) = request else {
            return false;
        };
        let _ = request.reply.send(Err(error));
        true
    }

    pub(crate) async fn reject_generation(&self, generation: u64, error: AcpHostError) {
        let requests = {
            let mut pending = self.pending.lock().await;
            let ids = pending
                .iter()
                .filter_map(|(id, request)| (request.generation == generation).then_some(*id))
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| pending.remove(&id))
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
            let mut pending = self.pending.lock().await;
            std::mem::take(&mut *pending)
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
        self.pending.lock().await.len()
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
