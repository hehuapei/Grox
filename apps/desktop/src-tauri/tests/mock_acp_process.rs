use std::{
    io::{BufRead as _, BufReader, Read as _, Write as _},
    process::{Command, Stdio},
};

use serde_json::{json, Value};

fn spawn_fixture(scenario: &str) -> std::process::Child {
    Command::new(env!("CARGO_BIN_EXE_grox-desktop"))
        .args(["--mock-acp-fixture", scenario])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn mock ACP fixture")
}

fn write_line(child: &mut std::process::Child, value: Value) {
    let stdin = child.stdin.as_mut().expect("fixture stdin");
    serde_json::to_writer(&mut *stdin, &value).unwrap();
    stdin.write_all(b"\n").unwrap();
    stdin.flush().unwrap();
}

fn read_json(reader: &mut BufReader<std::process::ChildStdout>) -> Value {
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    serde_json::from_str(line.trim()).unwrap()
}

#[test]
fn subprocess_interleaves_sessions_gates_and_finishes_after_permission() {
    let mut child = spawn_fixture("interleaved");
    write_line(
        &mut child,
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }),
    );
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    assert_eq!(read_json(&mut stdout)["id"], 1);

    write_line(
        &mut child,
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/prompt",
            "params": { "sessionId": "session-primary", "prompt": [] }
        }),
    );
    let mut malformed = String::new();
    stdout.read_line(&mut malformed).unwrap();
    assert_eq!(malformed.trim(), "not-json");
    let primary = read_json(&mut stdout);
    let secondary = read_json(&mut stdout);
    let permission = read_json(&mut stdout);
    assert_eq!(primary["params"]["sessionId"], "session-primary");
    assert_eq!(secondary["params"]["sessionId"], "session-secondary");
    assert_eq!(permission["method"], "session/request_permission");

    write_line(
        &mut child,
        json!({
            "jsonrpc": "2.0",
            "id": "gate-1",
            "result": { "outcome": { "outcome": "selected", "optionId": "allow-once" } }
        }),
    );
    assert_eq!(
        read_json(&mut stdout)["params"]["update"]["status"],
        "completed"
    );
    assert_eq!(
        read_json(&mut stdout)["params"]["update"]["sessionUpdate"],
        "turn_completed"
    );
    let prompt_result = read_json(&mut stdout);
    assert_eq!(prompt_result["id"], 2);
    assert_eq!(prompt_result["result"]["stopReason"], "end_turn");
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
}

#[test]
fn subprocess_exposes_partial_json_eof_without_hanging() {
    let mut child = spawn_fixture("partial-json-eof");
    write_line(
        &mut child,
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }),
    );
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    assert_eq!(read_json(&mut stdout)["id"], 1);
    write_line(
        &mut child,
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/prompt",
            "params": { "sessionId": "session-primary", "prompt": [] }
        }),
    );
    drop(child.stdin.take());
    let mut partial = String::new();
    stdout.read_to_string(&mut partial).unwrap();
    assert_eq!(partial, r#"{"jsonrpc":"2.0","method":"session/update""#);
    assert!(child.wait().unwrap().success());
}

#[test]
fn subprocess_permission_eof_leaves_prompt_without_false_success() {
    let mut child = spawn_fixture("permission-eof");
    write_line(
        &mut child,
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }),
    );
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    assert_eq!(read_json(&mut stdout)["id"], 1);
    write_line(
        &mut child,
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/prompt",
            "params": { "sessionId": "session-primary", "prompt": [] }
        }),
    );
    drop(child.stdin.take());
    let mut output = String::new();
    stdout.read_to_string(&mut output).unwrap();
    assert!(output.contains("session/request_permission"));
    assert!(!output.lines().any(|line| {
        serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|value| value.get("id").cloned())
            == Some(json!(2))
    }));
    assert!(child.wait().unwrap().success());
}
