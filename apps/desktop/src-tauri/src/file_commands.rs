//! 桌面文件操作的领域门面。
//!
//! WebView 提交的路径先被约束到工作区；媒体等 Host 服务则只能把已经授权的
//! 规范路径交给平台动作。两类入口复用相同的结构化错误，而不是依赖文案推断。

use std::path::Path;

use crate::{
    host_error::HostError,
    path_sandbox::{checked_workspace, checked_workspace_file},
};

#[tauri::command]
pub(crate) fn reveal_in_explorer(cwd: String, path: String) -> Result<(), HostError> {
    let root = checked_workspace(&cwd)
        .map_err(|error| HostError::operation("FILE_WORKSPACE_INVALID", error))?;
    let file = checked_workspace_file(&root, &path)
        .map_err(|error| HostError::operation("FILE_TARGET_INVALID", error))?;
    reveal_file(&file)
}

pub(crate) fn reveal_file(file: &Path) -> Result<(), HostError> {
    if !file.is_file() {
        return Err(HostError::operation(
            "FILE_TARGET_NOT_FILE",
            "只能在文件管理器中定位文件",
        ));
    }
    #[cfg(windows)]
    std::process::Command::new("explorer.exe")
        .arg("/select,")
        .arg(file)
        .spawn()
        .map_err(|error| file_environment_error("FILE_REVEAL_FAILED", error))?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("-R")
        .arg(file)
        .spawn()
        .map_err(|error| file_environment_error("FILE_REVEAL_FAILED", error))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(file.parent().unwrap_or(file))
        .spawn()
        .map_err(|error| file_environment_error("FILE_REVEAL_FAILED", error))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn open_file_with_default(cwd: String, path: String) -> Result<(), HostError> {
    let root = checked_workspace(&cwd)
        .map_err(|error| HostError::operation("FILE_WORKSPACE_INVALID", error))?;
    let file = checked_workspace_file(&root, &path)
        .map_err(|error| HostError::operation("FILE_TARGET_INVALID", error))?;
    open_file_default(&file)
}

pub(crate) fn open_file_default(file: &Path) -> Result<(), HostError> {
    if !file.is_file() {
        return Err(HostError::operation(
            "FILE_TARGET_NOT_FILE",
            "只能使用默认应用打开文件",
        ));
    }
    #[cfg(windows)]
    std::process::Command::new("explorer.exe")
        .arg(file)
        .spawn()
        .map_err(|error| file_environment_error("FILE_OPEN_FAILED", error))?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(file)
        .spawn()
        .map_err(|error| file_environment_error("FILE_OPEN_FAILED", error))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(file)
        .spawn()
        .map_err(|error| file_environment_error("FILE_OPEN_FAILED", error))?;
    Ok(())
}

fn file_environment_error(code: &'static str, error: std::io::Error) -> HostError {
    HostError::recoverable_environment(
        code,
        format!("无法启动系统文件处理程序：{error}"),
        "检查系统默认应用或文件管理器后重试",
    )
}
