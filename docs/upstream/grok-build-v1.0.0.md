# Grok Build v1.0.0 → Grox 桌面融合矩阵

## 版本身份

- 官网产品版本：`v1.0.0`（2026-08-07）
- 上一官网版本：`v0.2.120`（2026-08-03）
- 同步仓库最终包版本：`1.0.0`（发布初次同步曾短暂为 `0.2.121`）
- 官方提交：`afbc0fb710320c7add294c2106d447ecc3e3af2e`
- Source-Revision：`3e620a76a5f374ce644dc7c87f7e990c68348218`
- 对比基线：`a5589e958437d79e13db026eedcb1720bffd4063`
- 初次同步的结构化 Changelog：46 项；最终 `1.0.0.json` 将其合并为 30 项。矩阵保留初次同步的全部项目，并追加最终同步源码变化，避免最终文案合并造成漏项。第 43、45 项为上游重复记录，仍分别保留。

“源码包版本 0.2.121”不等于官网版本。Grox 对外跟踪官网 `v1.0.0`，同时记录包版本用于源码和二进制核验。

状态说明：`已实现`仅表示 Grox 代码与自动测试具备对应桌面行为；`待实机`表示必须安装官方 v1.0.0 CLI 后做 Grox 场景回归。在所有待实机项完成前，`.grox/official-cli.json` 的 `verifiedIntegration` 保持为空。

## 逐项决策

| ID | 上游变化 / 用户目标 | Grox 的非终端融合决策 | 证据与状态 |
|---|---|---|---|
| UP-001 | Dashboard 显示上一回合摘要 | 会话侧栏消费 `summary`，在标题下显示答案/发现摘要。 | `AcpBridge.metaFromRow`、`Sidebar.MissionRow`；已实现，待实机 |
| UP-002 | Extensions 分组排序，Skills 可折叠 | Skills 设置页按 scope 字母分组，组内按名称排序并可折叠。 | `SettingsModal.SkillsPanel`；已实现 |
| UP-003 | 大型 MCP 图片不再丢失/损坏 | 继承 CLI 修复；Grox 保留所有 content/rawOutput 图片并在工具卡显示。 | `AcpBridge.extractImages`、`ToolImages`；自动构建通过，待大图实机 |
| UP-004 | 后台子 Agent 提醒父 Agent继续原任务 | 继承运行时调度；Grox 工作流面板保留父/子轨迹且隐藏内部提醒控制文本。 | `workflow_updated`、`isHiddenWorkflowControlPrompt`；待实机 |
| UP-005 | 远端父会话恢复后，子会话续接不再 404 | 继承运行时修复；以 Grox 后台 workflow 恢复场景验收。 | `workflow_trace_update`、`loadSession(background)`；待实机 |
| UP-006 | 无重放重挂运行会话，并可显式关闭 | 保留后台 `session/load` 重挂；离开空闲/失败任务时调用标准 `session/close`，旧拼写回退，不删除历史。运行中任务继续后台执行。 | `GrokBridge.closeSession`、`AcpBridge.closeSession`、`shouldCloseDetachedSession`；单测通过，待实机 |
| UP-007 | 超大 Session fork 内存降低 | 继承 CLI；Grox 的“新聊天继续”使用官方 fork 扩展。 | `continueSessionInNewChat` / `x.ai/session/fork`；待大历史实机 |
| UP-008 | 无 origin/HEAD 时正确识别默认分支 | 继承 CLI Git 探测；Grox 工作树流程不得另行猜测分支。 | Tauri `git_confirm` + 官方 fork/worktree；待手工初始化仓库实机 |
| UP-009 | 可重新启用的禁用 MCP 仍可见 | Grox MCP 设置不按 enabled 过滤，直接渲染官方列表并提供 Toggle。 | `SettingsModal.McpPanel`；已有等价 UI，待实机 |
| UP-010 | Home/非项目目录不再询问项目目录 | Grox Home 明确展示当前 workspace；只有“新建项目”才打开目录选择器。 | `Home`、`newProject`；桌面原生等价 |
| UP-011 | 快速 send-now / 等待子 Agent 时不丢队列消息 | Grox 使用每会话本地队列、去重、故障 rehome 和按序 drain；不依赖 TUI 队列绘制。 | `promptQueue.test.ts` 24 项相关测试；待并发实机 |
| UP-012 | Esc/Stop 后后台任务不得唤醒模型 | Stop 同时发送 cancelSubagents 并停放本地队列，直到操作者再次发送。 | `AcpBridge.cancel`、`queueDrainParked`；单测通过，待工作流实机 |
| UP-013 | 无效第一方 API Key 不应跳过 Login | 认证判断由官方 CLI 返回值驱动，不用环境变量存在与否推断成功。 | `getAuthState`/`authenticate`；待无效 key 实机 |
| UP-014 | 审核计划时模型选择器/命令面板可用 | 计划预览为右侧 Pane，Composer 和全局 Command Palette 保持可操作。 | `App`、`PlanPreviewPane`、`Composer`；桌面等价回归 |
| UP-015 | workflow parallel() 限制并发，避免数百子进程 | 继承 CLI 调度上限；Grox 只呈现工作流状态，不自行扩增并发。 | `WorkflowRun` 面板；待压力实机 |
| UP-016 | 单 Agent Dashboard 不显示无效前后切换 | Grox 没有 TUI Dashboard overlay 或此快捷键，不存在无效控件。 | 终端呈现专属；语义上不适用 |
| UP-017 | `/feedback` 使用独立反馈框 | `/feedback` 是 Grox 本地 GUI 动作，打开模态报告框并调用官方 `x.ai/feedback`，不会作为普通 prompt。 | `Composer` Feedback Dialog；已实现，待提交实机 |
| UP-018 | 空 Session 退出在慢网下也立即完成 | Grox Home 导航立即完成，随后异步 `session/close`；不阻塞界面。 | `goHome` + `closeSession`；已实现 |
| UP-019 | Pinned prompt header 可鼠标选择复制 | Grox transcript 文本保持 `select-text`/浏览器原生选择；没有覆盖文本的 TUI 鼠标层。 | 桌面原生等价；待选择回归 |
| UP-020 | Tab/Esc 在 Question/Permission/Cancel 卡行为一致 | Tab 使用原生焦点顺序；Esc 会取消问题或拒绝权限，Stop 独立可见。 | `QuestionCard`、`PermissionCard`；已实现 |
| UP-021 | `/new` 后从空 prompt 能回 Dashboard | Grox `/new` 显式创建项目任务；`/home`/侧栏导航始终可返回，不依赖空 prompt 状态。 | `Composer` 本地命令；桌面等价 |
| UP-022 | 大型或浅克隆仓库 restore 不挂起 | 继承 CLI codebase restore；Grox 后台加载不阻塞主 UI，并保留离线快照。 | `openSession` background load；待大型 shallow repo 实机 |
| UP-023 | SSH/tmux 自动主题 | Grox 主题由桌面偏好和系统窗口环境决定，不运行于 SSH/tmux TTY。 | 终端检测不适用；用户目标由桌面主题切换覆盖 |
| UP-024 | Voice/Finance 工具卡图标及本地化 | 增加 voice/finance 工具分类、mic/summary 图标与中文标签。 | `mapToolKind`、`ToolCallCard.kindMeta`；已实现，待事件样本 |
| UP-025 | 远端恢复默认只恢复对话，显式参数才恢复代码 | 继承 CLI 安全默认值；Grox 普通打开只走 `session/load`，代码回退仅通过显式 Rewind UI。 | `openSession`、`RewindMenu`；待远端实机 |
| UP-026 | CJK 鼠标复制不丢边缘字符 | Grox 使用 WebView 原生文本选择，不经过 TUI cell 坐标换算。 | 桌面原生等价；需 Windows/macOS CJK 手测 |
| UP-027 | Markdown 表格窄 Pane 内重排 | 移除 `min-width:max-content`/nowrap，单元格允许安全换行。 | `tokens.css .md-table-wrap`；已实现，待视觉回归 |
| UP-028 | Resume 按 UUID 跨目录找到 Session | Grox 全局历史调用官方全目录 session list，并按 ID 打开、自动切换 workspace。 | `listSessions`、`openSession`；待跨目录实机 |
| UP-029 | Permission 展示完整脚本 | payload 用可选择、换行、滚动的 `<pre>` 呈现；长脚本可展开。 | `PermissionCard`；已实现 |
| UP-030 | API 错误显示干净提示而非原始 JSON | 递归提取 JSON `message/error/detail/data`，时间线显示人类可读错误。 | `cleanApiError` 单测；已实现 |
| UP-031 | Dashboard 输入 exit/quit 应退出 | Grox 无“在 Dashboard 输入 prompt”的入口，关闭由窗口系统负责。 | 终端命令解析不适用 |
| UP-032 | Resume/模式切换后 mode 指示准确 | `current_mode_update` 是权威状态；`session_ready` 恢复每会话 Composer mode。 | `mode_state` + `sessionComposers`；待 plan/ask/agent 实机 |
| UP-033 | 删除当前 Dashboard Session 后返回 Dashboard | Grox 删除当前任务后设置 `activeId:null, view:home`。 | `store.deleteSession`；已有等价行为 |
| UP-034 | Slash 菜单 Enter 执行高亮命令 | Composer 维护 slashIdx，Enter 调用当前高亮项。 | `Composer.onKeyDown`；已有等价行为 |
| UP-035 | 服务中断时重试更多服务器错误 | 重试策略继承官方 CLI；Grox prompt watchdog/自动重连只处理进程与流卡死，不覆盖服务端策略。 | `promptWithEffortFallback`、`reconnectAgent`；待模拟 5xx 实机 |
| UP-036 | Dashboard 摘要优先答案/发现而非活动描述 | 同 UP-001，直接显示官方 `summary`，不以工具活动替代。 | `SessionMeta.summary`；已实现，待实机 |
| UP-037 | 长 diff 行换行后语法高亮正确 | Grox DiffView 基于结构化增删行，不按终端视觉行重新词法分析。 | `DiffView`；桌面原生等价，待超长行视觉回归 |
| UP-038 | Dashboard 使用仅限 Session 的 slash command 时给出提示 | Grox Home 没有 Composer；Session-only 命令无法从 Home 误触。 | 桌面信息架构消除错误路径 |
| UP-039 | 退出 CLI 重置 terminal modes | Grox 通过 Tauri 子进程管道运行 `agent stdio`，不接管用户终端模式。 | 非终端宿主语义不适用 |
| UP-040 | 等待子 Agent 时 Queued prompts 仍可见可达 | 队列固定呈现在 Composer 内，不被 workflow/permission Pane 遮蔽。 | `Composer` queue pane；已有等价行为，待实机 |
| UP-041 | Auto recap 不得插入新 turn 中间或 busy 时 | recap 的生成时机继承 CLI；Grox按 session/update 顺序合并，busy live blocks 优先。 | `mergeOfflineWithLive`；待并发实机 |
| UP-042 | 长 Bash 权限脚本可 Ctrl-F 展开 | 长 payload 提供“展开完整脚本”，活跃权限卡 Ctrl/Cmd-F 直接展开。 | `PermissionCard`；已实现 |
| UP-043 | `/btw` 错误完整换行 | 所有系统错误和工具原始输出使用 `whitespace-pre-wrap`/break-word。 | `cleanApiError`、Timeline/ToolCallCard；待 `/btw` 实机 |
| UP-044 | 队列中的 slash command 和图片可重排 | 队列文本可就地编辑；消息和每条消息内附件均可上下移动，数组顺序即 drain 顺序。 | `moveQueueEntry` 单测、`Composer`；已实现 |
| UP-045 | `/btw` 错误完整换行（上游重复项） | 与 UP-043 共用同一实现和验收，不删除重复记录。 | 同 UP-043 |
| UP-046 | `/feedback` 关闭后不重置 Composer 输入模式 | 反馈框是独立 UI，只清理反馈草稿，不修改 agent/plan/ask、model、effort 或普通草稿。 | `Composer`；已实现，待实机 |
| UP-047 | 防止客户端高频 Git status/diff 请求拖垮进程 | Grox 仅在窗口可见且处于任务页时按 2 秒轮询；同时继承 CLI 的 in-process guard。 | `workspaceWatchTimer`；待大仓库压力回归 |
| UP-048 | Plugin CTA debounce 提高到 500ms | Plugin/Marketplace 操作增加 500ms 互斥窗口，避免桌面双击重复安装/切换。 | `SettingsModal.PluginsPanel`；已实现 |
| UP-049 | Session trace 导出包含 memory traces | 会话菜单新增“导出会话诊断”，调用官方 `grok trace <id> --local --json`；路径复制到剪贴板。 | Tauri `export_session_trace`、`Sidebar`；已实现，待实机导出 |
| UP-050 | `/usage`、`/session-info`、`/context` 使用标签式用量/会话信息 | 三个命令在 Grox 都路由到常驻 Inspector 的 Usage 面板，不启动 TUI modal。 | `Composer` 本地命令、`Inspector`；已实现 |
| UP-051 | Session recap 使用会话语言 | 继承 CLI 的 recap 语言判断；Grox 不翻译模型内容，确保中文 recap 原样进入时间线/摘要。 | 事件流保持原文；待中文/英文实机 |
| UP-052 | Session request metadata 支持 startupHints；修复 headless MCP connecting 提醒 | Grox 是可读取正文的交互式 ACP 桌面宿主，不声明“仅通过 deliveryTools 输出”；保留默认连接提醒，避免错误引导模型放弃正文。 | 初始化 `terminal:false`，session meta 不伪造 deliveryTools；待慢 MCP 实机 |
| UP-053 | Windows 最新下载名改为 `Grok Setup.exe` | 这是官方 CLI 自身分发文件名；Grox 使用受信 x.ai installer/update 接口，不按旧文件名定位。 | `install_official_grok_cli`；无需 UI 变更，待更新回归 |
| UP-054 | 大量 deny-glob 的大目录中 sandboxed Grok 可启动 | 继承 CLI sandbox 修复；Grox 的 ACP child 由官方 CLI建立 sandbox，不自行复制匹配逻辑。 | `acp_spawn`；待构造大目录实机 |

## 集成门禁

- [x] 官网版本、包版本、提交、Source-Revision 分开记录
- [x] 初次 46 项、最终 30 项及最终同步源码新增项已交叉合并，无静默丢项
- [x] 已识别的 Grox 桌面缺口完成代码实现与自动测试
- [x] 官方 Grok Build v1.0.0 Windows ACP 核心回归：initialize/list/new/close
- [ ] Windows 需要账号/大型仓库/MCP/工作流参与的完整场景回归
- [ ] 使用官方 Grok Build v1.0.0 完成 macOS Apple Silicon / Intel 关键路径回归
- [ ] Issue #16 链接本矩阵及最终证据
- [ ] 推进 `.grox/official-cli.json.verifiedIntegration`
