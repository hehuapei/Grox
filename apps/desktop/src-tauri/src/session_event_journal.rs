//! ACP 入站事件的 Host 权威顺序与短期重放。
//!
//! WebView 可能在 Agent 仍运行时重载。原先裸 `app.emit` 没有序号和补放，
//! 页面消失期间的流片段会永久丢失。这里为所有需要投影给页面的消息分配
//! 单调序号并保留有界窗口；页面先订阅再按游标补放，因而不会留下竞态窗口。

use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::Value;

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
    valid_json: bool,
    line: String,
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
    pub(crate) fn append(&self, generation: u64, line: String) -> HostSessionEvent {
        let (session_id, method, update_type, valid_json) = classify(&line);
        let mut state = self.lock();
        let sequence = state.next_sequence;
        state.next_sequence = state.next_sequence.saturating_add(1);
        let event = HostSessionEvent {
            stream_id: state.stream_id.clone(),
            sequence,
            generation,
            received_at: unix_time_ms(),
            session_id,
            method,
            update_type,
            valid_json,
            line,
        };

        let event_bytes = event.line.len();
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
            state.retained_bytes = state.retained_bytes.saturating_sub(dropped.line.len());
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

fn classify(line: &str) -> (Option<String>, Option<String>, Option<String>, bool) {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return (None, None, None, false);
    };
    let Some(message) = message.as_object() else {
        return (None, None, None, false);
    };
    let raw_method = message.get("method").and_then(Value::as_str);
    let raw_params = message.get("params");
    let (method, params) = match raw_method {
        Some(method) if method.starts_with("_x.ai/") => {
            let envelope = raw_params.and_then(Value::as_object);
            match (
                envelope
                    .and_then(|value| value.get("method"))
                    .and_then(Value::as_str),
                envelope.and_then(|value| value.get("params")),
            ) {
                (Some(nested), Some(params)) if nested.starts_with("x.ai/") => {
                    (Some(nested.to_string()), Some(params))
                }
                _ => (Some(method[1..].to_string()), raw_params),
            }
        }
        Some(method) => (Some(method.to_string()), raw_params),
        None => (None, raw_params),
    };
    let params = params.and_then(Value::as_object);
    let update = params
        .and_then(|value| value.get("update"))
        .and_then(Value::as_object);
    let session_id = params
        .and_then(|value| value.get("sessionId"))
        .and_then(Value::as_str)
        .or_else(|| {
            update
                .and_then(|value| value.get("sessionId"))
                .and_then(Value::as_str)
        })
        .map(str::to_string);
    let update_type = update
        .and_then(|value| value.get("sessionUpdate"))
        .and_then(Value::as_str)
        .map(str::to_string);
    (session_id, method, update_type, true)
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
        let (_, method, update_type, valid) = classify(
            r#"{"method":"_x.ai/wrapped","params":{"method":"x.ai/session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call"}}}}"#,
        );
        assert!(valid);
        assert_eq!(method.as_deref(), Some("x.ai/session/update"));
        assert_eq!(update_type.as_deref(), Some("tool_call"));
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
        assert!(!event.valid_json);
        assert_eq!(
            journal.replay(Some(&event.stream_id), 0, None).events.len(),
            1
        );
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
