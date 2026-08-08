# Grok Build v1.0.0 集成验证证据

## 结论

Grox 已完成官网 v1.0.0（上游提交 `afbc0fb710320c7add294c2106d447ecc3e3af2e`、Source-Revision `3e620a76a5f374ce644dc7c87f7e990c68348218`）的桌面融合。验证对象是用户在非终端 Grox 中获得的等价结果，不是照搬 TUI 控件。

## 审计覆盖

- 官网最终 30 项 Changelog、初次同步 46 项结构化记录、2 个同步提交和 312 个变更文件已交叉核对。
- 合并重复项并补入源码独有变化后形成 54 项处置矩阵；每项均记录继承行为、桌面实现或终端专属不适用理由。
- 上游二进制身份固定为 `grok 1.0.0 (3cd0d0cbce)`；官网产品版本与曾短暂出现的包版本 `0.2.121` 分开记录。

## 原生平台验证

统一工作流：[GitHub Actions #31246326257](https://github.com/dandandujie/Grox/actions/runs/31246326257)

| 平台 | 官方 CLI/ACP | Grox 前端 | Grox Rust |
|---|---|---|---|
| Windows x64 | 通过 | 128 tests + production build | 65 tests |
| macOS Apple Silicon | 通过 | 128 tests + production build | 65 tests |
| macOS Intel | 通过 | 128 tests + production build | 65 tests |

每台 runner 均从 `https://x.ai/cli/install.sh` 固定安装官方 v1.0.0，并运行同一隔离验证。没有向 CI 上传本机 OAuth、API Key 或其他凭据。

## 官方 CLI 场景

`scripts/verify-grok-v1-hermetic.mjs` 以隔离 `GROK_HOME` 和本地推理端点验证：

- ACP initialize、全局 session list、session new/info；
- plan → agent 模式切换；
- MCP、Skills、Workflows 列表；
- `session/request_permission` 的 allow-once 回调；
- MCP 工具搜索与调用，以及有效大型 PNG 被官方 CLI 处理后进入超过 1 MB 的后续模型请求；
- prompt 更新流与约定最终响应；
- session fork、load、close，且无版本不匹配通知。

Windows 另使用本机已登录的官方稳定版完成真实在线 prompt，以上会话、模式、列表、fork/load/close 路径均通过；凭据未被读取、打印或复制。

## Grox 非终端融合

- 队列、取消和忙碌态由 Grox 每会话 GUI 状态机承接，共 24 项队列测试；不会依赖 TUI 的按键或绘制状态。
- 权限、问题、计划、反馈、用量、会话信息、MCP、Skills、Workflows 均映射为桌面 Pane/Card/Modal。
- CJK 选择、终端模式复位、SSH/tmux 主题等 TTY 专属实现不进入 Grox；其用户目标由 WebView 原生选择、桌面窗口生命周期和系统主题覆盖。
- 上游负责的重试、sandbox、git/codebase restore、子 Agent 调度等运行时修复由官方 v1.0.0 进程承载；Grox 不复制另一套易漂移实现，只验证宿主启动、更新流、重挂和关闭契约。

## 可复现命令

```text
node scripts/verify-grok-v1-hermetic.mjs
pnpm --dir apps/desktop test
pnpm --dir apps/desktop build
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
```
