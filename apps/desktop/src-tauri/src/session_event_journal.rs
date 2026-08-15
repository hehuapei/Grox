//! ACP 入站事件的 Host 权威解码、顺序与短期重放。
//!
//! WebView 可能在 Agent 仍运行时重载。原先裸 `app.emit` 没有序号和补放，
//! 页面消失期间的流片段会永久丢失。这里为所有需要投影给页面的消息分配
//! 单调序号并保留有界窗口；页面先订阅再按游标补放，因而不会留下竞态窗口。
//! JSON-RPC 与 x.ai 扩展封装只在 Host 解码，页面不会收到原始 wire 行或 rpc id。

use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::{json, Value};

use crate::acp_inbound::{AcpInbound, AcpInboundError};

const MAX_RETAINED_EVENTS: usize = 8_192;
const MAX_RETAINED_BYTES: usize = 16 * 1024 * 1024;
const MAX_REPLAY_EVENTS: usize = 1_000;
const MAX_RETAINED_EVENT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostSessionEvent {
    stream_id: String,
    sequence: u64,
    generation: u64,
    received_at: u64,
    session_id: Option<String>,
    method: Option<String>,
    update_type: Option<String>,
    projection: HostSessionProjection,
    #[serde(skip)]
    wire_bytes: usize,
    #[serde(skip)]
    unsupported_response: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum HostSessionProjection {
    SessionUpdate {
        channel: &'static str,
        session_id: String,
        update_type: Option<String>,
        update: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    UnsupportedRequest {
        method: String,
    },
    OrphanResponse,
    ProtocolError {
        code: &'static str,
        message: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostSessionEventReplay {
    stream_id: String,
    events: Vec<HostSessionEvent>,
    earliest_sequence: u64,
    latest_sequence: u64,
    truncated: bool,
    reset: bool,
    has_more: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostSessionEventStatus {
    stream_id: String,
    earliest_sequence: u64,
    latest_sequence: u64,
    retained_events: usize,
    retained_bytes: usize,
    dropped_through: u64,
}

struct JournalState {
    stream_id: String,
    next_sequence: u64,
    dropped_through: u64,
    retained_bytes: usize,
    events: VecDeque<HostSessionEvent>,
}

pub(crate) struct SessionEventJournal {
    state: Mutex<JournalState>,
}

impl Default for SessionEventJournal {
    fn default() -> Self {
        Self {
            state: Mutex::new(JournalState {
                stream_id: new_stream_id(),
                next_sequence: 1,
                dropped_through: 0,
                retained_bytes: 0,
                events: VecDeque::new(),
            }),
        }
    }
}

impl SessionEventJournal {
    #[cfg(test)]
    pub(crate) fn append(&self, generation: u64, line: String) -> HostSessionEvent {
        let wire_bytes = line.len();
        let inbound = AcpInbound::parse(&line);
        self.append_inbound(generation, wire_bytes, inbound.as_ref())
    }

    pub(crate) fn append_inbound(
        &self,
        generation: u64,
        wire_bytes: usize,
        inbound: Result<&AcpInbound, &AcpInboundError>,
    ) -> HostSessionEvent {
        let decoded = decode_inbound(inbound);
        let mut state = self.lock();
        let sequence = state.next_sequence;
        state.next_sequence = state.next_sequence.saturating_add(1);
        let event = HostSessionEvent {
            stream_id: state.stream_id.clone(),
            sequence,
            generation,
            received_at: unix_time_ms(),
            session_id: decoded.session_id,
            method: decoded.method,
            update_type: decoded.update_type,
            projection: decoded.projection,
            wire_bytes,
            unsupported_response: decoded.unsupported_response,
        };

        let event_bytes = event.wire_bytes;
        if event_bytes > MAX_RETAINED_EVENT_BYTES {
            // 超大多模态消息仍实时投影，但不允许单条消息吃掉整个补放窗口。
            state.dropped_through = sequence;
            tracing::warn!(
                target: "grox::session_events",
                generation,
                sequence,
                session_id = ?event.session_id,
                bytes = event_bytes,
                "ACP event exceeds replay retention limit"
            );
            return event;
        }
        state.retained_bytes = state.retained_bytes.saturating_add(event_bytes);
        state.events.push_back(event.clone());
        while state.events.len() > MAX_RETAINED_EVENTS || state.retained_bytes > MAX_RETAINED_BYTES
        {
            let Some(dropped) = state.events.pop_front() else {
                break;
            };
            state.retained_bytes = state.retained_bytes.saturating_sub(dropped.wire_bytes);
            state.dropped_through = state.dropped_through.max(dropped.sequence);
        }
        event
    }

    pub(crate) fn replay(
        &self,
        requested_stream_id: Option<&str>,
        after_sequence: u64,
        limit: Option<usize>,
    ) -> HostSessionEventReplay {
        let state = self.lock();
        let reset = requested_stream_id != Some(state.stream_id.as_str());
        let after_sequence = if reset { 0 } else { after_sequence };
        let limit = limit
            .unwrap_or(MAX_REPLAY_EVENTS)
            .clamp(1, MAX_REPLAY_EVENTS);
        let latest_sequence = state.next_sequence.saturating_sub(1);
        let earliest_sequence = state
            .events
            .front()
            .map(|event| event.sequence)
            .unwrap_or_else(|| latest_sequence.saturating_add(1));
        let mut matching = state
            .events
            .iter()
            .filter(|event| event.sequence > after_sequence);
        let events = matching.by_ref().take(limit).cloned().collect::<Vec<_>>();
        let has_more = matching.next().is_some();
        let truncated = after_sequence < state.dropped_through;
        if truncated {
            tracing::warn!(
                target: "grox::session_events",
                requested_after = after_sequence,
                dropped_through = state.dropped_through,
                latest_sequence,
                "ACP event replay requested beyond retained window"
            );
        }

        HostSessionEventReplay {
            stream_id: state.stream_id.clone(),
            events,
            earliest_sequence,
            latest_sequence,
            truncated,
            reset,
            has_more,
        }
    }

    pub(crate) fn status(&self) -> HostSessionEventStatus {
        let state = self.lock();
        let latest_sequence = state.next_sequence.saturating_sub(1);
        HostSessionEventStatus {
            stream_id: state.stream_id.clone(),
            earliest_sequence: state
                .events
                .front()
                .map(|event| event.sequence)
                .unwrap_or_else(|| latest_sequence.saturating_add(1)),
            latest_sequence,
            retained_events: state.events.len(),
            retained_bytes: state.retained_bytes,
            dropped_through: state.dropped_through,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, JournalState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
}

impl HostSessionEvent {
    pub(crate) fn unsupported_response(&self) -> Option<&str> {
        self.unsupported_response.as_deref()
    }
}

struct DecodedInbound {
    session_id: Option<String>,
    method: Option<String>,
    update_type: Option<String>,
    projection: HostSessionProjection,
    unsupported_response: Option<String>,
}

#[cfg(test)]
fn decode(line: &str) -> DecodedInbound {
    let inbound = AcpInbound::parse(line);
    decode_inbound(inbound.as_ref())
}

fn decode_inbound(
    inbound: Result<&AcpInbound, &AcpInboundError>,
) -> DecodedInbound {
    let inbound = match inbound {
        Ok(inbound) => inbound,
        Err(error) => return protocol_error(error.code(), error.message()),
    };
    let Some(raw_method) = inbound.method() else {
        return if inbound.has_id() {
            DecodedInbound {
                session_id: None,
                method: None,
                update_type: None,
                projection: HostSessionProjection::OrphanResponse,
                unsupported_response: None,
            }
        } else {
            protocol_error("ACP_INVALID_MESSAGE", "ACP 消息既不是请求、通知也不是响应")
        };
    };
    let method = raw_method.to_string();
    let params = inbound.params();

    if inbound.has_id() {
        let id = inbound.id().unwrap_or(&Value::Null);
        let response = json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("Unsupported client method: {method}") },
        })
        .to_string();
        return DecodedInbound {
            session_id: session_id(params),
            method: Some(method.clone()),
            update_type: None,
            projection: HostSessionProjection::UnsupportedRequest { method },
            unsupported_response: Some(response),
        };
    }

    if matches!(
        method.as_str(),
        "session/update" | "x.ai/session/update" | "x.ai/session_notification"
    ) {
        let update = params.get("update").cloned();
        let Some(session_id) =
            session_id(params).or_else(|| update.as_ref().and_then(|update| session_id(update)))
        else {
            return DecodedInbound {
                session_id: None,
                method: Some(method.clone()),
                update_type: None,
                projection: HostSessionProjection::ProtocolError {
                    code: "ACP_MISSING_SESSION_ID",
                    message: format!("{method} 缺少 sessionId，事件已被隔离"),
                },
                unsupported_response: None,
            };
        };
        let Some(update) = update else {
            return DecodedInbound {
                session_id: Some(session_id),
                method: Some(method.clone()),
                update_type: None,
                projection: HostSessionProjection::ProtocolError {
                    code: "ACP_INVALID_SESSION_UPDATE",
                    message: format!("{method} 缺少 update，事件已被隔离"),
                },
                unsupported_response: None,
            };
        };
        if !update.is_object() {
            return DecodedInbound {
                session_id: Some(session_id),
                method: Some(method.clone()),
                update_type: None,
                projection: HostSessionProjection::ProtocolError {
                    code: "ACP_INVALID_SESSION_UPDATE",
                    message: format!("{method} 的 update 不是对象，事件已被隔离"),
                },
                unsupported_response: None,
            };
        }
        let update_type = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .map(str::to_string);
        let channel = if method == "x.ai/session_notification" {
            "notification"
        } else {
            "session"
        };
        return DecodedInbound {
            session_id: Some(session_id.clone()),
            method: Some(method),
            update_type: update_type.clone(),
            projection: HostSessionProjection::SessionUpdate {
                channel,
                session_id,
                update_type,
                update,
            },
            unsupported_response: None,
        };
    }

    DecodedInbound {
        session_id: session_id(params),
        method: Some(method.clone()),
        update_type: None,
        projection: HostSessionProjection::Notification {
            method,
            params: params.clone(),
        },
        unsupported_response: None,
    }
}

fn session_id(params: &Value) -> Option<String> {
    params
        .get("sessionId")
        .or_else(|| params.get("session_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.chars().count() <= 512)
        .map(str::to_string)
}

fn protocol_error(code: &'static str, message: impl Into<String>) -> DecodedInbound {
    DecodedInbound {
        session_id: None,
        method: None,
        update_type: None,
        projection: HostSessionProjection::ProtocolError {
            code,
            message: message.into(),
        },
        unsupported_response: None,
    }
}

fn new_stream_id() -> String {
    let mut bytes = [0_u8; 16];
    if getrandom::fill(&mut bytes).is_ok() {
        return bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    }
    format!("fallback-{}-{}", std::process::id(), unix_time_ms())
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assigns_monotonic_sequence_and_extracts_session_identity() {
        let journal = SessionEventJournal::default();
        let first = journal.append(
            7,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk"}}}"#.into(),
        );
        let second = journal.append(
            7,
            r#"{"jsonrpc":"2.0","method":"x.ai/session_notification","params":{"sessionId":"s2","update":{"sessionUpdate":"turn_completed"}}}"#.into(),
        );

        assert_eq!(first.sequence, 1);
        assert_eq!(first.session_id.as_deref(), Some("s1"));
        assert_eq!(first.update_type.as_deref(), Some("agent_message_chunk"));
        assert_eq!(second.sequence, 2);
        assert_eq!(second.session_id.as_deref(), Some("s2"));
    }

    #[test]
    fn normalizes_wrapped_extension_metadata() {
        let decoded = decode(
            r#"{"method":"_x.ai/wrapped","params":{"method":"x.ai/session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call"}}}}"#,
        );
        assert_eq!(decoded.method.as_deref(), Some("x.ai/session/update"));
        assert_eq!(decoded.update_type.as_deref(), Some("tool_call"));
        assert!(matches!(
            decoded.projection,
            HostSessionProjection::SessionUpdate {
                channel: "session",
                session_id,
                ..
            } if session_id == "s1"
        ));
    }

    #[test]
    fn replay_resets_foreign_stream_and_pages_without_duplicates() {
        let journal = SessionEventJournal::default();
        for index in 0..3 {
            journal.append(1, format!(r#"{{"method":"notice/{index}"}}"#));
        }

        let first = journal.replay(Some("old-process"), 99, Some(2));
        assert!(first.reset);
        assert_eq!(first.events.len(), 2);
        assert!(first.has_more);
        let cursor = first.events.last().unwrap().sequence;
        let second = journal.replay(Some(&first.stream_id), cursor, Some(2));
        assert!(!second.reset);
        assert_eq!(second.events.len(), 1);
        assert_eq!(second.events[0].sequence, 3);
        assert!(!second.has_more);
    }

    #[test]
    fn malformed_json_remains_visible_but_is_classified() {
        let journal = SessionEventJournal::default();
        let event = journal.append(1, "not-json".into());
        assert!(matches!(
            &event.projection,
            HostSessionProjection::ProtocolError {
                code: "ACP_INVALID_JSON",
                ..
            }
        ));
        assert_eq!(
            journal.replay(Some(&event.stream_id), 0, None).events.len(),
            1
        );
    }

    #[test]
    fn unknown_client_request_is_rejected_without_exposing_rpc_id() {
        let journal = SessionEventJournal::default();
        let event = journal.append(
            4,
            r#"{"jsonrpc":"2.0","id":17,"method":"x.ai/unknown","params":{"sessionId":"s1"}}"#
                .into(),
        );

        assert!(matches!(
            &event.projection,
            HostSessionProjection::UnsupportedRequest { method }
                if method == "x.ai/unknown"
        ));
        assert_eq!(
            serde_json::from_str::<Value>(event.unsupported_response().unwrap()).unwrap()["id"],
            json!(17)
        );
        let public = serde_json::to_value(&event).unwrap();
        assert!(public.get("line").is_none());
        assert!(public.pointer("/projection/id").is_none());
    }

    #[test]
    fn status_exposes_replay_window_without_event_bodies() {
        let journal = SessionEventJournal::default();
        journal.append(1, r#"{"method":"notice"}"#.into());
        let status = journal.status();
        assert_eq!(status.earliest_sequence, 1);
        assert_eq!(status.latest_sequence, 1);
        assert_eq!(status.retained_events, 1);
        assert!(status.retained_bytes > 0);
        assert_eq!(status.dropped_through, 0);
    }
}
