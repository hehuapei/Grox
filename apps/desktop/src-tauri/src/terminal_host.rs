//! ACP `terminal/*` Client 能力的 Host 生命周期。
//!
//! Agent 只持有不透明 terminal id；进程、输出、退出状态和进程树都属于
//! 当前 ACP generation。WebView 不参与命令执行，也不能在页面重载后接管
//! 旧进程。输出按 ACP 约定保留尾部，并始终受 Host 硬上限约束。

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use serde_json::{json, Map, Value};
use tokio::{
    io::{AsyncReadExt, BufReader},
    process::{Child, ChildStderr, ChildStdout, Command},
    sync::{Mutex, Notify},
};

use crate::path_sandbox::{checked_workspace_file, path_for_webview};

const DEFAULT_OUTPUT_BYTE_LIMIT: usize = 30_000;
// JSON 转义最坏会把一个原始字节扩成六个字符；该上限保证响应仍低于
// Client callback 的 8 MiB wire 上限。
const MAX_OUTPUT_BYTE_LIMIT: usize = 1024 * 1024;
const MAX_COMMAND_BYTES: usize = 256 * 1024;
const MAX_ARGUMENTS: usize = 4_096;
const MAX_ENV_VARS: usize = 4_096;
const MAX_ARGUMENT_ENV_BYTES: usize = 1024 * 1024;
const MAX_TERMINAL_ID_CHARS: usize = 512;
const READ_BUFFER_BYTES: usize = 8 * 1024;
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(20);
const PIPE_DRAIN_TIMEOUT: Duration = Duration::from_millis(750);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TerminalMethod {
    Create,
    Output,
    WaitForExit,
    Kill,
    Release,
}

impl TerminalMethod {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Create => "terminal/create",
            Self::Output => "terminal/output",
            Self::WaitForExit => "terminal/wait_for_exit",
            Self::Kill => "terminal/kill",
            Self::Release => "terminal/release",
        }
    }
}

#[derive(Debug)]
pub(crate) struct TerminalFailure {
    pub(crate) code: i64,
    pub(crate) message: String,
}

impl TerminalFailure {
    fn params(message: impl Into<String>) -> Self {
        Self {
            code: -32602,
            message: message.into(),
        }
    }

    fn operation(message: impl Into<String>) -> Self {
        Self {
            code: -32000,
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct TerminalExitStatus {
    exit_code: Option<u32>,
    signal: Option<String>,
}

#[derive(Default)]
struct OutputState {
    output: Vec<u8>,
    truncated: bool,
    exit_status: Option<TerminalExitStatus>,
}

struct TerminalProcess {
    child: Child,
    pid: u32,
    #[cfg(windows)]
    job: crate::process_job::ProcessJob,
}

struct TerminalEntry {
    generation: u64,
    session_id: String,
    owner_token: Option<u64>,
    process: Mutex<TerminalProcess>,
    output: Mutex<OutputState>,
    exit_notify: Notify,
}

#[derive(Default)]
struct TerminalRegistryState {
    generation: u64,
    entries: BTreeMap<(String, String), std::sync::Arc<TerminalEntry>>,
}

#[derive(Default)]
pub(crate) struct TerminalHost {
    state: Mutex<TerminalRegistryState>,
    next_id: AtomicU64,
}

impl TerminalHost {
    pub(crate) async fn reset(&self, generation: u64) {
        let entries = {
            let mut state = self.state.lock().await;
            state.generation = generation;
            std::mem::take(&mut state.entries)
                .into_values()
                .collect::<Vec<_>>()
        };
        for entry in entries {
            if let Err(error) = terminate_entry(&entry).await {
                tracing::warn!(
                    target: "grox::terminal",
                    generation = entry.generation,
                    session_id = %entry.session_id,
                    error = %error,
                    "terminal reset teardown failed"
                );
            }
        }
    }

    pub(crate) async fn release_session(&self, generation: u64, session_id: &str) {
        let entries = self
            .drain_matching(generation, |entry| entry.session_id == session_id)
            .await;
        for entry in entries {
            if let Err(error) = terminate_entry(&entry).await {
                tracing::warn!(
                    target: "grox::terminal",
                    generation,
                    session_id,
                    error = %error,
                    "terminal session teardown failed"
                );
            }
        }
    }

    pub(crate) async fn release_owner(&self, generation: u64, owner_token: u64) {
        let entries = self
            .drain_matching(generation, |entry| entry.owner_token == Some(owner_token))
            .await;
        for entry in entries {
            if let Err(error) = terminate_entry(&entry).await {
                tracing::warn!(
                    target: "grox::terminal",
                    generation,
                    owner_token,
                    session_id = %entry.session_id,
                    error = %error,
                    "provisional terminal teardown failed"
                );
            }
        }
    }

    pub(crate) async fn len(&self) -> usize {
        self.state.lock().await.entries.len()
    }

    pub(crate) async fn execute(
        &self,
        generation: u64,
        session_id: &str,
        workspace: &Path,
        owner_token: Option<u64>,
        method: TerminalMethod,
        params: &Map<String, Value>,
    ) -> Result<Value, TerminalFailure> {
        match method {
            TerminalMethod::Create => {
                self.create(generation, session_id, workspace, owner_token, params)
                    .await
            }
            TerminalMethod::Output => self.output(generation, session_id, params).await,
            TerminalMethod::WaitForExit => self.wait_for_exit(generation, session_id, params).await,
            TerminalMethod::Kill => self.kill(generation, session_id, params).await,
            TerminalMethod::Release => self.release(generation, session_id, params).await,
        }
    }

    async fn create(
        &self,
        generation: u64,
        session_id: &str,
        workspace: &Path,
        owner_token: Option<u64>,
        params: &Map<String, Value>,
    ) -> Result<Value, TerminalFailure> {
        let request = CreateRequest::parse(workspace, params)?;
        let terminal_id = format!(
            "term_{generation}_{}",
            self.next_id.fetch_add(1, Ordering::Relaxed) + 1
        );

        // Spawn and registry insertion share the generation lock. A concurrent
        // reset therefore either runs first (this request is rejected) or drains
        // the newly inserted child; it can never miss an unregistered process.
        let entry = {
            let mut state = self.state.lock().await;
            if state.generation != generation {
                return Err(TerminalFailure::operation(
                    "终端创建属于已替换的 Agent 进程",
                ));
            }
            let (process, stdout, stderr) = spawn_command(&request)?;
            let entry = std::sync::Arc::new(TerminalEntry {
                generation,
                session_id: session_id.to_string(),
                owner_token,
                process: Mutex::new(process),
                output: Mutex::new(OutputState::default()),
                exit_notify: Notify::new(),
            });
            state.entries.insert(
                (session_id.to_string(), terminal_id.clone()),
                std::sync::Arc::clone(&entry),
            );
            tokio::spawn(collect_process_output(
                std::sync::Arc::clone(&entry),
                stdout,
                stderr,
                request.output_byte_limit,
            ));
            entry
        };
        debug_assert_eq!(entry.generation, generation);
        Ok(json!({ "terminalId": terminal_id }))
    }

    async fn output(
        &self,
        generation: u64,
        session_id: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, TerminalFailure> {
        let entry = self.entry(generation, session_id, params).await?;
        let output = entry.output.lock().await;
        Ok(json!({
            "output": String::from_utf8_lossy(&output.output),
            "truncated": output.truncated,
            "exitStatus": output.exit_status.as_ref().map(exit_status_json),
        }))
    }

    async fn wait_for_exit(
        &self,
        generation: u64,
        session_id: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, TerminalFailure> {
        let entry = self.entry(generation, session_id, params).await?;
        loop {
            // Register before checking so a completion between the check and
            // await cannot be lost; Notify itself need not retain a permit.
            let notified = entry.exit_notify.notified();
            if let Some(status) = entry.output.lock().await.exit_status.clone() {
                return Ok(exit_status_json(&status));
            }
            notified.await;
        }
    }

    async fn kill(
        &self,
        generation: u64,
        session_id: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, TerminalFailure> {
        let entry = self.entry(generation, session_id, params).await?;
        terminate_entry(&entry)
            .await
            .map_err(TerminalFailure::operation)?;
        Ok(json!({}))
    }

    async fn release(
        &self,
        generation: u64,
        session_id: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, TerminalFailure> {
        let terminal_id = terminal_id(params)?;
        let entry = {
            let mut state = self.state.lock().await;
            if state.generation != generation {
                return Err(TerminalFailure::operation(
                    "终端释放属于已替换的 Agent 进程",
                ));
            }
            state
                .entries
                .remove(&(session_id.to_string(), terminal_id.to_string()))
        };
        // 与 Grok Build 的扩展实现保持幂等：重复 release 不复活资源。
        if let Some(entry) = entry {
            terminate_entry(&entry)
                .await
                .map_err(TerminalFailure::operation)?;
        }
        Ok(json!({}))
    }

    async fn entry(
        &self,
        generation: u64,
        session_id: &str,
        params: &Map<String, Value>,
    ) -> Result<std::sync::Arc<TerminalEntry>, TerminalFailure> {
        let terminal_id = terminal_id(params)?;
        let state = self.state.lock().await;
        if state.generation != generation {
            return Err(TerminalFailure::operation(
                "终端请求属于已替换的 Agent 进程",
            ));
        }
        state
            .entries
            .get(&(session_id.to_string(), terminal_id.to_string()))
            .cloned()
            .ok_or_else(|| TerminalFailure::operation("终端不存在或不属于当前会话"))
    }

    async fn drain_matching(
        &self,
        generation: u64,
        predicate: impl Fn(&TerminalEntry) -> bool,
    ) -> Vec<std::sync::Arc<TerminalEntry>> {
        let mut state = self.state.lock().await;
        if state.generation != generation {
            return Vec::new();
        }
        let keys = state
            .entries
            .iter()
            .filter_map(|(key, entry)| predicate(entry).then_some(key.clone()))
            .collect::<Vec<_>>();
        keys.into_iter()
            .filter_map(|key| state.entries.remove(&key))
            .collect()
    }
}

struct CreateRequest {
    command: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
    cwd: PathBuf,
    output_byte_limit: usize,
}

impl CreateRequest {
    fn parse(workspace: &Path, params: &Map<String, Value>) -> Result<Self, TerminalFailure> {
        let command = params
            .get("command")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| TerminalFailure::params("terminal/create 缺少 command"))?;
        if command.len() > MAX_COMMAND_BYTES || command.contains('\0') {
            return Err(TerminalFailure::params("终端 command 为空、过长或包含 NUL"));
        }

        let args = optional_array(params, "args")?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .filter(|value| !value.contains('\0'))
                    .map(str::to_string)
                    .ok_or_else(|| TerminalFailure::params("终端 args 必须是字符串数组"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        if args.len() > MAX_ARGUMENTS {
            return Err(TerminalFailure::params("终端 args 数量超过上限"));
        }

        let env = optional_array(params, "env")?
            .iter()
            .map(|value| {
                let value = value
                    .as_object()
                    .ok_or_else(|| TerminalFailure::params("终端 env 必须是 {name,value} 数组"))?;
                let name = value
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty() && !name.contains('=') && !name.contains('\0'))
                    .ok_or_else(|| TerminalFailure::params("终端环境变量名不合法"))?;
                let value = value
                    .get("value")
                    .and_then(Value::as_str)
                    .filter(|value| !value.contains('\0'))
                    .ok_or_else(|| TerminalFailure::params("终端环境变量值必须是字符串"))?;
                Ok((name.to_string(), value.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        if env.len() > MAX_ENV_VARS {
            return Err(TerminalFailure::params("终端环境变量数量超过上限"));
        }
        let aggregate_bytes = args.iter().map(String::len).sum::<usize>()
            + env
                .iter()
                .map(|(name, value)| name.len() + value.len())
                .sum::<usize>();
        if aggregate_bytes > MAX_ARGUMENT_ENV_BYTES {
            return Err(TerminalFailure::params(
                "终端参数与环境变量合计超过 1 MiB 上限",
            ));
        }

        let cwd = params
            .get("cwd")
            .filter(|value| !value.is_null())
            .map(|value| {
                value
                    .as_str()
                    .filter(|cwd| !cwd.is_empty() && !cwd.contains('\0'))
                    .ok_or_else(|| TerminalFailure::params("终端 cwd 必须是非空路径"))
                    .and_then(|cwd| {
                        checked_workspace_file(workspace, cwd).map_err(TerminalFailure::operation)
                    })
            })
            .transpose()?
            .unwrap_or_else(|| workspace.to_path_buf());
        if !cwd.is_dir() {
            return Err(TerminalFailure::operation(format!(
                "终端 cwd 不是目录：{}",
                path_for_webview(&cwd)
            )));
        }

        let output_byte_limit = params
            .get("outputByteLimit")
            .or_else(|| params.get("output_byte_limit"))
            .filter(|value| !value.is_null())
            .map(|value| {
                value
                    .as_u64()
                    .and_then(|value| usize::try_from(value).ok())
                    .ok_or_else(|| TerminalFailure::params("outputByteLimit 必须是非负整数"))
            })
            .transpose()?
            .unwrap_or(DEFAULT_OUTPUT_BYTE_LIMIT);
        if output_byte_limit > MAX_OUTPUT_BYTE_LIMIT {
            return Err(TerminalFailure::params(format!(
                "outputByteLimit 超过 Host 上限 {MAX_OUTPUT_BYTE_LIMIT} bytes"
            )));
        }

        Ok(Self {
            command: command.to_string(),
            args,
            env,
            cwd,
            output_byte_limit,
        })
    }
}

fn optional_array<'a>(
    params: &'a Map<String, Value>,
    name: &str,
) -> Result<&'a [Value], TerminalFailure> {
    match params.get(name) {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(values)) => Ok(values),
        Some(_) => Err(TerminalFailure::params(format!(
            "terminal/create 的 {name} 必须是数组"
        ))),
    }
}

fn terminal_id(params: &Map<String, Value>) -> Result<&str, TerminalFailure> {
    params
        .get("terminalId")
        .or_else(|| params.get("terminal_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.chars().count() <= MAX_TERMINAL_ID_CHARS)
        .ok_or_else(|| TerminalFailure::params("终端请求缺少合法 terminalId"))
}

fn spawn_command(
    request: &CreateRequest,
) -> Result<(TerminalProcess, ChildStdout, ChildStderr), TerminalFailure> {
    let mut command = if request.args.is_empty() {
        shell_command(&request.command)
    } else {
        let mut command = Command::new(&request.command);
        command.args(&request.args);
        command
    };
    command
        .current_dir(&request.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(path) = crate::process_env::enriched_path_env() {
        command.env("PATH", path);
    }
    // ACP 显式 env 的优先级高于 Host 补齐值，包括 Agent 主动指定 PATH。
    command.envs(request.env.iter().map(|(name, value)| (name, value)));

    #[cfg(unix)]
    command.process_group(0);

    #[cfg(windows)]
    {
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }

    #[cfg(windows)]
    let job = crate::process_job::ProcessJob::create_kill_on_close()
        .map_err(TerminalFailure::operation)?;

    let mut child = command
        .spawn()
        .map_err(|error| TerminalFailure::operation(format!("无法启动终端命令：{error}")))?;
    let pid = child.id().ok_or_else(|| {
        let _ = child.start_kill();
        TerminalFailure::operation("终端子进程没有可用 pid")
    })?;

    #[cfg(windows)]
    if let Err(error) = job.assign_pid(pid) {
        let _ = child.start_kill();
        return Err(TerminalFailure::operation(format!(
            "无法将终端进程加入 Job Object：{error}"
        )));
    }

    let stdout = child.stdout.take().ok_or_else(|| {
        let _ = child.start_kill();
        TerminalFailure::operation("终端子进程没有 stdout")
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        let _ = child.start_kill();
        TerminalFailure::operation("终端子进程没有 stderr")
    })?;
    Ok((
        TerminalProcess {
            child,
            pid,
            #[cfg(windows)]
            job,
        },
        stdout,
        stderr,
    ))
}

#[cfg(unix)]
fn shell_command(snippet: &str) -> Command {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|shell| !shell.trim().is_empty())
        .unwrap_or_else(|| "/bin/sh".into());
    let mut command = Command::new(shell);
    command.arg("-lc").arg(snippet);
    command
}

#[cfg(windows)]
fn shell_command(snippet: &str) -> Command {
    let shell = std::env::var("COMSPEC")
        .ok()
        .filter(|shell| !shell.trim().is_empty())
        .unwrap_or_else(|| "cmd.exe".into());
    let mut command = Command::new(shell);
    command.arg("/D").arg("/S").arg("/C").arg(snippet);
    command
}

async fn collect_process_output(
    entry: std::sync::Arc<TerminalEntry>,
    stdout: ChildStdout,
    stderr: ChildStderr,
    output_byte_limit: usize,
) {
    let mut stdout = Some(BufReader::new(stdout));
    let mut stderr = Some(BufReader::new(stderr));
    let mut stdout_buffer = [0u8; READ_BUFFER_BYTES];
    let mut stderr_buffer = [0u8; READ_BUFFER_BYTES];
    let mut exit_status = None;
    let mut drain_deadline: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
    let mut poll = tokio::time::interval(EXIT_POLL_INTERVAL);

    loop {
        if exit_status.is_some() && stdout.is_none() && stderr.is_none() {
            break;
        }
        tokio::select! {
            result = async {
                stdout.as_mut().expect("guarded stdout").read(&mut stdout_buffer).await
            }, if stdout.is_some() => {
                match result {
                    Ok(0) | Err(_) => stdout = None,
                    Ok(read) => append_output(&entry, &stdout_buffer[..read], output_byte_limit).await,
                }
            }
            result = async {
                stderr.as_mut().expect("guarded stderr").read(&mut stderr_buffer).await
            }, if stderr.is_some() => {
                match result {
                    Ok(0) | Err(_) => stderr = None,
                    Ok(read) => append_output(&entry, &stderr_buffer[..read], output_byte_limit).await,
                }
            }
            _ = poll.tick(), if exit_status.is_none() => {
                let status = {
                    let mut process = entry.process.lock().await;
                    process.child.try_wait()
                };
                match status {
                    Ok(Some(status)) => {
                        exit_status = Some(exit_status_from_process(status));
                        drain_deadline = Some(Box::pin(tokio::time::sleep(PIPE_DRAIN_TIMEOUT)));
                    }
                    Ok(None) => {}
                    Err(error) => {
                        exit_status = Some(TerminalExitStatus {
                            exit_code: None,
                            signal: Some(format!("wait error: {error}")),
                        });
                        drain_deadline = Some(Box::pin(tokio::time::sleep(PIPE_DRAIN_TIMEOUT)));
                    }
                }
            }
            _ = async {
                match drain_deadline.as_mut() {
                    Some(deadline) => deadline.as_mut().await,
                    None => std::future::pending().await,
                }
            }, if drain_deadline.is_some() => {
                // 后台后代可能继续持有 pipe。ACP 的 exit 属于直接命令；
                // release 会随后终止该进程组，不能让输出 drain 永久阻塞。
                stdout = None;
                stderr = None;
            }
        }
    }

    let status = exit_status.unwrap_or_else(|| TerminalExitStatus {
        exit_code: None,
        signal: Some("process output ended without exit status".into()),
    });
    entry.output.lock().await.exit_status = Some(status);
    entry.exit_notify.notify_waiters();
}

async fn append_output(entry: &TerminalEntry, bytes: &[u8], limit: usize) {
    let mut output = entry.output.lock().await;
    output.output.extend_from_slice(bytes);
    if truncate_utf8_tail(&mut output.output, limit) {
        output.truncated = true;
    }
}

fn truncate_utf8_tail(buffer: &mut Vec<u8>, limit: usize) -> bool {
    if buffer.len() <= limit {
        return false;
    }
    if limit == 0 {
        buffer.clear();
        return true;
    }
    let text = String::from_utf8_lossy(buffer);
    let mut start = text.len().saturating_sub(limit);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    *buffer = text.as_bytes()[start..].to_vec();
    true
}

fn exit_status_from_process(status: ExitStatus) -> TerminalExitStatus {
    let exit_code = status.code().map(|code| code as u32);
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal().map(|signal| format!("signal {signal}"))
    };
    #[cfg(windows)]
    let signal = None;
    TerminalExitStatus { exit_code, signal }
}

fn exit_status_json(status: &TerminalExitStatus) -> Value {
    json!({
        "exitCode": status.exit_code,
        "signal": status.signal,
    })
}

async fn terminate_entry(entry: &TerminalEntry) -> Result<(), String> {
    let mut process = entry.process.lock().await;
    let tree_result = terminate_process_tree(&mut process);
    let direct_result = match process.child.try_wait() {
        Ok(Some(_)) => Ok(()),
        Ok(None) => process
            .child
            .start_kill()
            .map_err(|error| format!("无法终止终端子进程：{error}")),
        Err(error) => Err(format!("无法读取终端子进程状态：{error}")),
    };
    tree_result.and(direct_result)
}

#[cfg(unix)]
fn terminate_process_tree(process: &mut TerminalProcess) -> Result<(), String> {
    let pid = i32::try_from(process.pid).map_err(|_| "终端 pid 超出进程组范围".to_string())?;
    let result = unsafe { libc::kill(-pid, libc::SIGKILL) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(format!("无法终止终端进程组 {pid}：{error}"))
    }
}

#[cfg(windows)]
fn terminate_process_tree(process: &mut TerminalProcess) -> Result<(), String> {
    process.job.terminate_tree()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, sync::atomic::AtomicU64};

    static NONCE: AtomicU64 = AtomicU64::new(0);

    fn workspace() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "grox-terminal-host-{}-{}",
            std::process::id(),
            NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path.canonicalize().unwrap()
    }

    #[test]
    fn output_truncation_keeps_utf8_tail() {
        let mut output = "head-你好-tail".as_bytes().to_vec();
        assert!(truncate_utf8_tail(&mut output, 8));
        let output = String::from_utf8(output).unwrap();
        assert!(output.ends_with("-tail"));
        assert!(output.len() <= 8);
    }

    #[test]
    fn create_request_rejects_escape_and_unbounded_output() {
        let root = workspace();
        let outside = root.parent().unwrap().join("outside");
        fs::create_dir_all(&outside).unwrap();
        let escape = json!({
            "command": "echo ok",
            "cwd": path_for_webview(&outside),
        });
        assert!(
            CreateRequest::parse(&root, escape.as_object().unwrap()).is_err(),
            "terminal cwd must remain inside its bound workspace"
        );
        let oversized = json!({
            "command": "echo ok",
            "outputByteLimit": MAX_OUTPUT_BYTE_LIMIT + 1,
        });
        assert!(CreateRequest::parse(&root, oversized.as_object().unwrap()).is_err());
        fs::remove_dir_all(root).ok();
        fs::remove_dir_all(outside).ok();
    }

    #[test]
    fn lifecycle_runs_waits_outputs_and_releases() {
        tauri::async_runtime::block_on(async {
            let root = workspace();
            let host = TerminalHost::default();
            host.reset(7).await;
            #[cfg(unix)]
            let params = json!({
                "command": "/bin/sh",
                "args": ["-c", "printf 'prefix-你好-tail'"],
                "outputByteLimit": 9,
            });
            #[cfg(windows)]
            let params = json!({
                "command": "cmd.exe",
                "args": ["/D", "/S", "/C", "echo prefix-tail"],
                "outputByteLimit": 9,
            });
            let created = host
                .execute(
                    7,
                    "s1",
                    &root,
                    None,
                    TerminalMethod::Create,
                    params.as_object().unwrap(),
                )
                .await
                .unwrap();
            let terminal_id = created["terminalId"].as_str().unwrap().to_string();
            let id = json!({ "terminalId": terminal_id });
            let status = host
                .execute(
                    7,
                    "s1",
                    &root,
                    None,
                    TerminalMethod::WaitForExit,
                    id.as_object().unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(status["exitCode"], 0);
            let output = host
                .execute(
                    7,
                    "s1",
                    &root,
                    None,
                    TerminalMethod::Output,
                    id.as_object().unwrap(),
                )
                .await
                .unwrap();
            assert!(output["truncated"].as_bool().unwrap());
            assert!(output["output"]
                .as_str()
                .unwrap()
                .trim_end()
                .ends_with("tail"));
            host.execute(
                7,
                "s1",
                &root,
                None,
                TerminalMethod::Release,
                id.as_object().unwrap(),
            )
            .await
            .unwrap();
            assert_eq!(host.len().await, 0);
            fs::remove_dir_all(root).ok();
        });
    }

    #[test]
    fn generation_reset_invalidates_and_drains_terminals() {
        tauri::async_runtime::block_on(async {
            let root = workspace();
            let host = TerminalHost::default();
            host.reset(1).await;
            #[cfg(unix)]
            let params = json!({ "command": "/bin/sh", "args": ["-c", "sleep 30"] });
            #[cfg(windows)]
            let params =
                json!({ "command": "cmd.exe", "args": ["/C", "ping -n 30 127.0.0.1 >NUL"] });
            host.execute(
                1,
                "s1",
                &root,
                Some(9),
                TerminalMethod::Create,
                params.as_object().unwrap(),
            )
            .await
            .unwrap();
            assert_eq!(host.len().await, 1);
            host.reset(2).await;
            assert_eq!(host.len().await, 0);
            let stale = host
                .execute(
                    1,
                    "s1",
                    &root,
                    None,
                    TerminalMethod::Create,
                    params.as_object().unwrap(),
                )
                .await
                .unwrap_err();
            assert_eq!(stale.code, -32000);
            fs::remove_dir_all(root).ok();
        });
    }

    #[test]
    #[cfg(unix)]
    fn kill_terminates_the_descendant_process_group() {
        tauri::async_runtime::block_on(async {
            let root = workspace();
            let host = TerminalHost::default();
            host.reset(21).await;
            let params = json!({
                "command": "/bin/sh",
                "args": ["-c", "sleep 30 & child=$!; printf '%s\\n' \"$child\"; wait"],
            });
            let created = host
                .execute(
                    21,
                    "s1",
                    &root,
                    None,
                    TerminalMethod::Create,
                    params.as_object().unwrap(),
                )
                .await
                .unwrap();
            let terminal_id = created["terminalId"].as_str().unwrap().to_string();
            let id = json!({ "terminalId": terminal_id });
            let descendant_pid = tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    let output = host
                        .execute(
                            21,
                            "s1",
                            &root,
                            None,
                            TerminalMethod::Output,
                            id.as_object().unwrap(),
                        )
                        .await
                        .unwrap();
                    if let Some(pid) = output["output"]
                        .as_str()
                        .and_then(|output| output.lines().find_map(|line| line.parse::<i32>().ok()))
                    {
                        break pid;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("shell should report its background child pid");

            host.execute(
                21,
                "s1",
                &root,
                None,
                TerminalMethod::Kill,
                id.as_object().unwrap(),
            )
            .await
            .unwrap();
            host.execute(
                21,
                "s1",
                &root,
                None,
                TerminalMethod::WaitForExit,
                id.as_object().unwrap(),
            )
            .await
            .unwrap();
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    let alive = unsafe { libc::kill(descendant_pid, 0) } == 0
                        || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH);
                    if !alive {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("terminal/kill must terminate descendants, not only the shell");
            host.execute(
                21,
                "s1",
                &root,
                None,
                TerminalMethod::Release,
                id.as_object().unwrap(),
            )
            .await
            .unwrap();
            fs::remove_dir_all(root).ok();
        });
    }
}
