//! GUI 启动场景的子进程 PATH。
//!
//! Dock/Finder/Explorer 启动的桌面应用通常没有交互式 shell 的 PATH。
//! Agent 与 ACP terminal 必须共享同一套可执行文件发现规则，否则同一命令
//! 会出现“系统终端可用、Grox 内不可用”的体验分裂。

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

pub(crate) fn enriched_path_env() -> Option<OsString> {
    let mut paths = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    if let Some(home) = user_home() {
        for path in user_tool_dirs(&home) {
            push_unique(&mut paths, path);
        }
    }
    std::env::join_paths(paths).ok()
}

fn user_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn user_tool_dirs(home: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(windows)]
    {
        candidates.extend([
            home.join(".grok").join("bin"),
            home.join(".local").join("bin"),
            home.join(".cargo").join("bin"),
            home.join("AppData").join("Local").join("pnpm"),
            home.join("AppData").join("Roaming").join("npm"),
            home.join(".pyenv").join("pyenv-win").join("shims"),
            home.join(".pyenv").join("pyenv-win").join("bin"),
            PathBuf::from(r"C:\Program Files\nodejs"),
            PathBuf::from(r"C:\Program Files\Git\cmd"),
            PathBuf::from(r"C:\Program Files\Git\bin"),
        ]);
        for key in ["NVM_HOME", "NVM_SYMLINK"] {
            if let Some(path) = std::env::var_os(key).filter(|value| !value.is_empty()) {
                candidates.push(PathBuf::from(path));
            }
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let local = PathBuf::from(local);
            candidates.push(local.join("Microsoft").join("WinGet").join("Links"));
        }
    }
    #[cfg(not(windows))]
    {
        candidates.extend([
            home.join(".grok").join("bin"),
            home.join(".local").join("bin"),
            home.join(".cargo").join("bin"),
            home.join(".bun").join("bin"),
            home.join(".pyenv").join("shims"),
            home.join(".pyenv").join("bin"),
            home.join(".asdf").join("shims"),
            home.join(".asdf").join("bin"),
            home.join(".volta").join("bin"),
            home.join(".local").join("share").join("fnm"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ]);
        if let Some(path) = newest_nvm_node_bin(home) {
            candidates.push(path);
        }
    }

    for key in ["CONDA_PREFIX", "MAMBA_ROOT_PREFIX", "CONDA_ROOT"] {
        if let Some(root) = std::env::var_os(key).filter(|value| !value.is_empty()) {
            let root = PathBuf::from(root);
            #[cfg(windows)]
            candidates.extend([
                root.join("Scripts"),
                root.join("Library").join("bin"),
                root.join("condabin"),
            ]);
            #[cfg(not(windows))]
            candidates.extend([root.join("bin"), root.join("condabin")]);
        }
    }

    candidates
        .into_iter()
        .filter(|candidate| candidate.is_dir())
        .collect()
}

#[cfg(not(windows))]
fn newest_nvm_node_bin(home: &Path) -> Option<PathBuf> {
    let versions = home.join(".nvm").join("versions").join("node");
    let mut installed = std::fs::read_dir(versions)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let bin = entry.path().join("bin");
            if !bin.is_dir() {
                return None;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            semver::Version::parse(name.trim_start_matches('v'))
                .ok()
                .map(|version| (version, bin))
        })
        .collect::<Vec<_>>();
    installed.sort_by(|left, right| left.0.cmp(&right.0));
    installed.pop().map(|(_, bin)| bin)
}

fn push_unique(paths: &mut Vec<PathBuf>, candidate: PathBuf) {
    #[cfg(windows)]
    let exists = paths.iter().any(|path| {
        path.to_string_lossy()
            .eq_ignore_ascii_case(&candidate.to_string_lossy())
    });
    #[cfg(not(windows))]
    let exists = paths.iter().any(|path| path == &candidate);
    if !exists {
        paths.push(candidate);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NONCE: AtomicU64 = AtomicU64::new(0);

    #[test]
    #[cfg(not(windows))]
    fn user_tool_dirs_choose_newest_existing_nvm_and_skip_dead_roots() {
        let home = std::env::temp_dir().join(format!(
            "grox-process-env-{}-{}",
            std::process::id(),
            NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        let newest = home.join(".nvm/versions/node/v22.4.1/bin");
        std::fs::create_dir_all(home.join(".nvm/versions/node/v20.1.0/bin")).unwrap();
        std::fs::create_dir_all(&newest).unwrap();
        std::fs::create_dir_all(home.join(".cargo/bin")).unwrap();
        let dirs = user_tool_dirs(&home);
        assert!(dirs.contains(&newest));
        assert!(!dirs.contains(&home.join(".nvm/versions/node/v20.1.0/bin")));
        assert!(dirs.contains(&home.join(".cargo/bin")));
        assert!(!dirs.contains(&home.join(".pyenv/shims")));
        std::fs::remove_dir_all(home).ok();
    }
}
