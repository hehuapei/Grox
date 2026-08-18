//! Debug/test-only ACP 子进程夹具。
//!
//! 真实进程边界（stdin/stdout/EOF）不能由纯解析单元测试覆盖。测试二进制
//! 使用显式参数进入这个模式，不初始化 Tauri、配置或用户目录。

use std::io::{self, BufRead as _, Write as _};

use serde_json::{json, Value};

const FLAG: &str = "--mock-acp-fixture";

pub(crate) fn try_run(arguments: &[String]) -> bool {
    let Some(index) = arguments.iter().position(|argument| argument == FLAG) else {
        return false;
    };
    let scenario = arguments
        .get(index + 1)
        .map(String::as_str)
        .unwrap_or("interleaved");
    if let Err(error) = run(scenario) {
        eprintln!("mock-acp-fixture: {error}");
        std::process::exit(23);
    }
    true
}

fn run(scenario: &str) -> Result<(), String> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut pending_prompt: Option<(Value, String)> = None;
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| format!("read stdin: {error}"))?;
        let message = serde_json::from_str::<Value>(&line)
            .map_err(|error| format!("invalid request: {error}"))?;
        let method = message.get("method").and_then(Value::as_str);
        match method {
            Some("initialize") => write_json(
                &mut stdout,
                &json!({
                    "jsonrpc": "2.0",
                    "id": message.get("id").cloned().unwrap_or(Value::Null),
                    "result": {
                        "protocolVersion": 1,
                        "agentCapabilities": {},
                        "authMethods": []
                    }
                }),
            )?,
            Some("session/prompt") => {
                let id = message.get("id").cloned().unwrap_or(Value::Null);
                let session_id = message
                    .pointer("/params/sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("session-primary")
                    .to_string();
                if scenario == "partial-json-eof" {
                    stdout
                        .write_all(br#"{"jsonrpc":"2.0","method":"session/update""#)
                        .map_err(|error| format!("write partial stdout: {error}"))?;
                    stdout
                        .flush()
                        .map_err(|error| format!("flush partial stdout: {error}"))?;
                    return Ok(());
                }
                stdout
                    .write_all(b"not-json\n")
                    .map_err(|error| format!("write malformed event: {error}"))?;
                write_json(
                    &mut stdout,
                    &session_update(
                        &session_id,
                        "agent_message_chunk",
                        json!({
                            "content": { "type": "text", "text": "primary-a" }
                        }),
                    ),
                )?;
                write_json(
                    &mut stdout,
                    &session_update(
                        "session-secondary",
                        "agent_thought_chunk",
                        json!({
                            "content": { "type": "text", "text": "secondary-b" }
                        }),
                    ),
                )?;
                write_json(
                    &mut stdout,
                    &json!({
                        "jsonrpc": "2.0",
                        "id": "gate-1",
                        "method": "session/request_permission",
                        "params": {
                            "sessionId": session_id,
                            "toolCall": {
                                "toolCallId": "tool-1",
                                "title": "Run fixture",
                                "kind": "execute"
                            },
                            "options": [
                                { "optionId": "allow-once", "kind": "allow_once" },
                                { "optionId": "reject-once", "kind": "reject_once" }
                            ]
                        }
                    }),
                )?;
                pending_prompt = Some((id, session_id));
                if scenario == "permission-eof" {
                    return Ok(());
                }
            }
            None if message.get("id") == Some(&Value::String("gate-1".into())) => {
                let Some((prompt_id, session_id)) = pending_prompt.take() else {
                    return Err("permission reply arrived without pending prompt".into());
                };
                write_json(
                    &mut stdout,
                    &session_update(
                        &session_id,
                        "tool_call_update",
                        json!({
                            "toolCallId": "tool-1",
                            "status": "completed"
                        }),
                    ),
                )?;
                write_json(
                    &mut stdout,
                    &session_update(
                        &session_id,
                        "turn_completed",
                        json!({
                            "usage": { "inputTokens": 1, "outputTokens": 2 }
                        }),
                    ),
                )?;
                write_json(
                    &mut stdout,
                    &json!({
                        "jsonrpc": "2.0",
                        "id": prompt_id,
                        "result": { "stopReason": "end_turn" }
                    }),
                )?;
            }
            Some(method) => {
                write_json(
                    &mut stdout,
                    &json!({
                        "jsonrpc": "2.0",
                        "id": message.get("id").cloned().unwrap_or(Value::Null),
                        "error": { "code": -32601, "message": format!("unsupported fixture method: {method}") }
                    }),
                )?;
            }
            None => {}
        }
    }
    Ok(())
}

fn session_update(session_id: &str, update_type: &str, extra: Value) -> Value {
    let mut update = extra.as_object().cloned().unwrap_or_default();
    update.insert("sessionUpdate".into(), Value::String(update_type.into()));
    json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": { "sessionId": session_id, "update": update }
    })
}

fn write_json(writer: &mut impl io::Write, value: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, value)
        .map_err(|error| format!("encode stdout: {error}"))?;
    writer
        .write_all(b"\n")
        .and_then(|_| writer.flush())
        .map_err(|error| format!("write stdout: {error}"))
}
