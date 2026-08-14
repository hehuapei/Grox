# ADR-0003：原生 Host 成为 Grox 后端唯一运行时

- 状态：Accepted（迁移中）
- 日期：2026-08-14
- 版本：v0.3.2
- 取代：ADR-0001 第 4、6、7 条

## Context

Grox 的 Rust 进程已经负责启动 CLI、文件和 Git 操作，但迁移前 ACP JSON-RPC 请求关联、
会话门控、流式回合、重连、提示队列和多数恢复决策仍在 `AcpBridge`/Zustand 内。
这不是单纯的 `main.rs` 过长问题，而是权威被拆成了三份：

1. Rust 知道子进程和宿主环境，却不知道一个 ACP 请求属于谁、何时终止；
2. Bridge 知道协议请求和会话流，却随 WebView 刷新、关闭而消失；
3. Store 知道产品队列和展示状态，却无法原子地约束进程、journal 与后台任务。

因此，只在某条功能链增加门禁会产生新的平行状态。多窗口、后台会话、自动化、
异常恢复和进程池也无法在这个边界上可靠实现。

`grok-app` 的正确方向是让 Rust `SessionManager`、`AcpClient`、FSM、store、自动化
runner 和媒体 Host 共同拥有后台事实，前端只接收快照与事件。它也存在连接锁、
journal RMW、单权限槽、进程树和网络超时等已知问题，所以 Grox 学习其职责归属，
不复制具体竞态或以文件数量作为目标。

## Decision

### 后端边界

原生 Host 是以下事实的唯一所有者：

- CLI 探测、认证、进程启动/退出、代次和资源上限；
- ACP 请求关联、超时、取消、重连和主动事件路由；
- 会话生命周期、活动回合、门禁、停止和恢复；
- journal、提示队列、草稿、自动化与删除 tombstone 的持久化事务；
- 工作树所有权、权限策略、路径授权、密钥和媒体访问令牌；
- 后台自动化与前台发送共用的会话执行入口；
- 可导出的结构化错误、运行时快照和诊断记录。

WebView 可以保留渲染节流、临时编辑态和乐观界面，但不能裁决进程、协议、会话终态
或持久化事务。前端缓存丢失不得改变后台正在执行的事实。

### 必须维持的不变量

1. 一个出站 ACP 请求只能由 Host 注册一次，并只接受同一进程代次的响应。
2. 进程退出、替换、CLI 更新或主 Host 关闭时，所有相关请求必须立即得到明确失败。
3. 主动通知和 Agent 发起的请求可以广播为事件；普通 RPC 响应不得广播给所有窗口。
4. `session/prompt` 的结果、用户停止或明确失败是回合终态；早到通知不裁决终态。
5. 每个持久化实体只有一个原生写入入口；RMW 必须在同一把锁内完成并原子替换。
6. 删除先建立 Host tombstone，再清理数据；任何晚到写入都必须失败。
7. 自动化调用与前台调用使用同一个 SessionCoordinator，不得另建简化执行器。
8. 路径、权限和密钥由 Host 验证；前端开关只能表达意图，不能扩大授权。
9. 协议、用户操作、环境错误在 Host 边界具有稳定代码，前端只负责本地化呈现。
10. 共享单进程存在期间，进程级事故必须列出全部受影响会话，不能只更新当前页面。
11. Agent 发起的交互请求只接受 Host 保存的 session + rpc id + generation；WebView 不得回传或猜测 wire id。
12. Client callback 只能使用 Host 在 session/new|load 时绑定的工作区；未知会话不得回退到当前页面目录。

### v0.3.2 内的迁移顺序

以下是同一个 v0.3.2 版本内的迁移切片，不拆分为多个发布版本：

| 顺序 | 后端主干 | 迁移结果 |
| --- | --- | --- |
| 1 | Native ACP transport | Host 关联请求/响应并负责超时、取消、退出清算；已落地 |
| 2 | SessionCoordinator | Host 签发/校验 lifecycle 与 turn 许可并发布占用快照；已落地 |
| 3 | Native repositories | PromptQueueStore、AutomationStore、SessionJournalStore 已迁移；草稿持久化边界继续收口 |
| 4 | Unified turn execution | Host 自动化与普通前台回合均拥有许可、模型/模式绑定、Prompt、watchdog、取消和 effort 降级；流内容继续由前端投影 |
| 5 | Interaction service | Host 持有权限、计划审批、ask-user 的 rpc id、代次、回复和 Stop 清算；已落地 |
| 6 | Client callback service | Host 持有 FS callback 的 session/cwd/rpc/generation；标准 FS 已落地，terminal 仍保持未宣告 |
| 7 | Host services | worktree、权限策略、媒体、密钥统一使用会话/项目身份和路径授权 |
| 8 | Command facade | 将 `main.rs` 按领域迁出，Tauri command 只校验 DTO 并调用服务 |
| 9 | Error/diagnostics | 稳定错误码、运行时快照、审计事件和支持包覆盖所有上述服务 |

顺序不能倒置：在 Host 尚未拥有会话状态前直接增加进程池，只会把当前分裂状态复制
到多个进程；在 repository 尚未拥有事务前运行后台自动化，会放大队列和 journal 竞态。

## 当前实现（v0.3.2）

- `acp_host::AcpRequestBroker` 已成为出站 RPC 的 Host 请求表；
- `acp_request` 定向返回响应，`acp_send` 拒绝绕过 Host 的出站请求；
- 普通请求超时与长回合 watchdog 都由 Host 处理；WebView 不再持有 prompt RPC id 或调用任意请求取消命令；
- 进程替换、自然退出、停止、CLI 更新和主窗口退出都会清算请求；
- Host 为退出、通道替换、超时、停滞、取消和协议校验返回稳定错误代码，前端不再用字符串正则覆盖这些分类；
- 环境摘要和支持包记录 Host 悬挂请求、待用户交互门控、Client callback 与已绑定工作区会话数；
- WebView 只解释已经归属的响应，未知广播响应仍呈现为协议错误。
- `agent_runtime_connect` 在 Host 连接锁内完成 CLI 检测、进程替换、`initialize`、非交互认证和 ready 提交；WebView 不再用 `acp_spawn`、`initialize` 和 `runtime_ready` 三次调用拼出连接事实；
- 初始化失败或进程在握手中退出会清算该代请求、能力租约和半连接子进程；运行时快照区分 starting、initializing、authenticating、ready、paused 与 offline，不再把“有 PID”等同于“可派发”；
- `ready_generation` 只存在于 `AcpState`，自动化直接读取同一 Host 状态；供应商/认证配置事务暂停时由 Host 保存一次性的已就绪代次，恢复必须消费同一进程的凭据，页面不能在握手中制造 ready 或单独宣布 runner 就绪；
- 交互式 OAuth 仍需用户显式点击，Host 只返回方法与标签，不在后台连接时擅自打开浏览器；非交互认证失败会保留结构化错误，也不会再被账户投影反向推断成已登录。
- `session_coordinator::SessionCoordinator` 在 Host 内维护活动回合、FIFO 生命周期队列和进程代次；
- `session/new`、`session/load`、`session/prompt` 必须携带 Host 签发且与方法、会话、代次匹配的许可；
- 生命周期排队会阻止新回合抢占，不同已绑定会话仍可并发运行；等待任务取消、进程自然退出、替换、停止、CLI 更新和主窗口退出都会清除旧许可；
- 占用快照由 Host 通过事件和查询命令发布，环境摘要与支持包不再依赖 WebView 自报门控状态；
- 前端 `SharedAcpLifecycleGate` 及其平行测试已删除，兼容重试、回放收尾和模型/模式预绑定仍保持在同一 Host 许可窗口内。
- `prompt_queue_store::PromptQueueStore` 在 Host 锁内按会话合并 patch 并原子替换文件，前端不再提交整个队列文件；
- 不同会话的并发队列写不会互相覆盖，Host 会校验队列条目/附件契约、容量和重复 id；
- 旧 localStorage 队列只在原生仓储从未初始化时迁移一次，原生空对象也是初始化标记，避免已删除队列在重启后再次导入；
- 删除会话/项目会在同一 tombstone 锁序内删除提示队列，晚到 upsert 会被 Host 拒绝，不能让已删除会话复活。
- 普通前台队列不再由 Store 先删行再调用 `bridge.prompt()`：`execute_foreground_turn` 在同一 Host 命令内按 queue id 原子领取磁盘首项、用权威文本/附件/模型/模式派发，并在 RPC 成功或用户停止后消费；协议、环境或进程代次失败会原位回队并触发人工确认门禁；
- 提示队列的 `_hostRuntime` 记录 Host 实例、claim token、进程代次和领取时间。WebView 只收到去除保留字段的快照，普通 patch 不能伪造、擦除、编辑或删除活动领取；旧 token 不能结算新领取；新 Host 实例、进程代次变化和旧版无 token 的 `sending` 行会恢复为 `queued`；
- 队列领取事件会在 Agent 输出前校正前端乐观用户气泡，避免磁盘权威内容与屏幕内容不一致；发送中的行不可编辑/排序/删除，清空操作也保留当前活动领取；
- 入队时保存的权限模式只是历史意图。派发时 Host 会与当前 `host_prefs` 取更严格者，旧队列不能在用户关闭 bypass 后重新扩大授权；
- 本地队列以稳定 id 和 Host settlement 判断是否消费，不再根据“文本刚好等于最后一个用户气泡”删除条目；因此异常回队后显式“确认并继续”确实会重发，而不会被文本去重静默吞掉。
- 成功消费或用户停止会在 Host 进程内留下 queue id tombstone；结算前已进入前端 Promise 链的旧 patch 会在原生锁内剔除这些 id，不能在结算后把已执行提示复活。应用重启后旧前端链已不存在，永久删除仍由 SessionStorage tombstone 跨操作兜底。
- `automation_store::AutomationStore` 按 automation id 在 Host 锁内合并更新/删除，不同任务的启停、编辑和运行结果不再通过整包数组互相覆盖；
- 自动化 DTO、时间、频率、权限模式、可选运行结果和重复 id 均由 Host 校验，失败 patch 不修改原文件。
- `automation_runner::AutomationRunner` 在应用进程内每 30 秒检查到期任务，只在 ACP 已初始化且 SessionCoordinator 无活动回合/生命周期操作时派发；WebView 不再持有调度定时器或到期判断；
- 认领、两分钟租约、30 秒 Host 续租、排程推进、一次性任务停用和安全失败退避都在 AutomationStore 的同一文件事务内完成；建会话前失败会五分钟退避，已经创建会话后的模糊失败会消费本次排程，避免自动复制可能已写入 Agent 的工作；同一时刻跨任务也只允许一个后台派发；
- `_hostRuntime` 是 Host 保留字段：普通 UI patch 不能伪造或擦除认领，过期租约可以在页面崩溃后恢复，旧 token 不能结算新认领；删除任务仍然优先，不会被晚到结算复活；
- `session/new` 与 `session/load` 已由 Host 原子完成：读取系统提示、验证工作区/模型/权限、创建 Computer/Browser 租约、取得 lifecycle permit、执行兼容重试并把资源绑定到真实 session id；WebView 只登记返回的会话和投影流事件；
- Computer/Browser lease id 不再保存在 WebView Map；会话关闭/删除、功能关闭、运行时替换、进程异常退出和主窗口销毁都由 Host 释放资源，TTL/容量淘汰也同步停止 MCP server 并清除会话绑定；
- Bypass/YOLO 建会话必须与 `host_prefs` 的 Host 授权一致，前端参数只能降权或表达能力意图，不能扩大权限；可选 Browser 降级与扩展参数兼容回退通过结构化 warning 呈现，不再静默失去能力；
- 自动化在页面登记 Host 创建的会话后，只把 automation id、claim token 和 session id 移交给 Host；Host 从磁盘重读权威配置，并在同一个 turn permit 内完成 `session/set_model`、`session/set_mode`、`session/prompt`、推理强度兼容降级、长回合续租和最终结算；
- `session/prompt` 的 RPC 成败现在直接决定自动化结果，不再经过会吞掉异常的 UI `bridge.prompt()`；终态和用量由 Host 事件投影到会话，前端不能把协议失败结算成成功；
- `foreground_turn::ForegroundTurnRegistry` 是普通前台回合的 Host 状态源：按 session + generation 记录当前请求、准备/提示/取消阶段、活动时间、开放工具和权限/问题门禁；进程替换时与请求表、许可一起清空；
- `execute_foreground_turn` 在一个自动释放的 turn permit 内完成模型/模式绑定、Host-attested 权限元数据、`session/prompt` 和 invalid-effort 降级；前台与自动化复用 `turn_runtime` 的协议规则，不再各自维护一套 fallback；
- `cancel_foreground_turn` 先定向拒绝当前 Host 请求，使 prompt future 与 turn permit 立即释放，再尽力写 `session/cancel`；发送前 Stop 的 IPC 竞态由短期取消墓碑消费，不会在用户停止后反向启动回合；
- Host 从入站 ACP 更新维护 stream 活动、开放工具和 operator gate。学习 grok-app 的停滞策略：普通 5 分钟静默只发一次可见提示，不自动误杀长工具；Host 配置的绝对上限仍会清算僵尸回合；
- `session/prompt` RPC 结果仍是回合终态权威；`turn_completed` / `prompt_complete` 只更新用量或触发协议恢复，不能提前释放下一条队列；
- `interaction_service::InteractionRegistry` 截获 `session/request_permission`、`x.ai/exit_plan_mode` 和 `x.ai/ask_user_question`：按 generation 保存 rpc id、session、原始 options/questions 和回复中状态，只向主窗口发布不含 rpc id/wire option 的不透明 block id；
- `resolve_interaction` 不接受 WebView 回传 rpc id 或 optionId，而是用 Host 保存的协议材料构造回复；跨会话、过期、重复点击、未知选项和伪造问题键都有稳定错误，stdin 写入结果不确定时不会自动重发批准；
- Stop 与绝对 watchdog 会先由 Host 回复当前会话的全部反向 RPC 为 cancelled，再发送 `session/cancel`；符合 ACP 对 pending permission 的取消要求，也避免 Agent 永久卡在 ask-user/plan gate；
- `interaction_status` 允许主 WebView 重载后重新投影仍存活的门控；进程代次切换、自然退出和 CLI 更新会在 Host 清空旧请求，新页面不能把旧卡片回复到新进程；
- `client_callbacks::ClientCallbackRegistry` 截获标准 `fs/read_text_file`、`fs/write_text_file` 和 Grok Build 的 `x.ai/fs/read_file`：Host 按 generation 保存 rpc id 与 session→canonical cwd，WebView 不再接收或回复文件 RPC；
- `session/new` 尚未返回真实 id 时，唯一 lifecycle opening 临时绑定本次 cwd，并只允许观察到的一个 session id；成功后原子提交正式绑定，失败、close/delete、进程替换和主窗口退出都会清除；
- 未绑定会话、跨代次、重复 rpc id、越界路径和超限响应都由 Host 明确拒绝，不再用 `AcpBridge.workspace` 猜 cwd；原先暴露给 WebView 的 `acp_read_*` / `acp_write_*` commands 已移除；
- `clientCapabilities.terminal` 继续为 false。官方 ACP 要求只有完整实现 create/output/wait/kill/release 后才能宣告；本切片没有用半成品 shell 执行器扩大 Agent 权限；
- 自动化只定向派发给 `main` WebView；供应商、认证或全局配置切换会先暂停 runner，并取得 Host lifecycle permit 后才替换进程，因此能够等待 Host 后台回合而不是只观察 `activePromptSessions`；
- 运行时切换已删除前端 `promptDrainWaiters` 第二门控，只等待 SessionCoordinator 的 lifecycle permit；`activePromptSessions` 仅保留 UI 中断标记与权限提示延迟，不再裁决进程替换；
- Host 返回 `AUTOMATION_RUNTIME_BUSY`、`AUTOMATION_CLAIM_STALE`、`AUTOMATION_INVALID_RESULT` 和 `AUTOMATION_STORAGE_FAILED` 等分域错误，前端不再把所有失败折叠成“启动失败”。
- `session_storage::SessionStorageState` 改为按会话写/删除租约：同一会话串行、不同会话并行，删除先标 tombstone 再等待现有 writer，避免全局文件锁拖慢多会话；
- `session_journal_store::SessionJournalStore` 校验现有和提交快照，前端以磁盘 savedAt 为基线生成单调逻辑版本；旧窗口的等版本/低版本写入会明确冲突并停止续写，不能覆盖新 journal；
- 旧版裸 Session 只保留只读迁移入口，损坏的现有 journal 不会被新快照静默覆盖。

本切片没有把完整 SessionManager 伪装成已经迁移：连接初始化、非交互认证、建会话/恢复、
自动化协议回合、普通前台回合、持久化提示队列和权限/计划/提问交互生命周期已属于 Host。
标准文件 client callback 与其会话工作区绑定也已属于 Host。用户显式触发的 OAuth 回调、
自动化启动时的页面会话登记以及尚未宣告的 terminal client callback 仍待迁移；
在这些职责迁完之前不会另起一个简化 CLI 进程冒充后台运行时。

## 完整后端对照结论

| 领域 | Grox 迁移前 | `grok-app` 可学习点 | Grox 决定 |
| --- | --- | --- | --- |
| 组合根 | 9k+ 行 `main.rs` 同时承担命令与业务 | `lib.rs` 组合状态，commands 为薄门面 | 随职责迁移拆模块，不做纯文件搬家 |
| ACP | Rust 透传 stdio，Bridge 关联请求 | `AcpClient` 在 Host 维护 pending/退出 | 先完成 Native ACP transport |
| Client callback | Bridge 用当前页面 catalogue 猜 FS cwd；terminal 未宣告 | 未实现能力就不宣告，避免 Agent 挂起 | FS 由 Host 会话绑定应答；terminal 完整实现前保持 false |
| 会话 | Bridge + Store 共同裁决 | Host SessionManager + FSM + snapshots | 建立单一 SessionCoordinator |
| 多会话 | 单进程共享、生命周期门控在前端 | 每应用会话进程、后台 busy 不被抢占 | 先迁权威，再用容量策略决定进程池 |
| 持久化 | 前端组装完整 JSON，Host 原子写 | store + 锁 + journal 对账 | Host 提供语义操作和锁内 RMW |
| 队列 | Store/localStorage 主导 | Host 运行时可观察 busy/退出 | 队列状态与发送事务绑定 |
| 自动化 | Host 已拥有时钟、建会话、能力租约、模型/模式、Prompt 与结算；页面仍承担会话登记屏障 | runner 复用 SessionManager | 前台与后台已共用 SessionCoordinator/turn_runtime；继续删除页面登记屏障 |
| 工作树 | 命令安全性已有，生命周期仍偏 UI | worktree 与 session metadata 绑定 | 引入 Host 所有权记录和清理策略 |
| 权限/提问 | Host 已按 session + generation 持有反向 RPC，WebView 只用 block id 投影；持久 allow cache 尚未统一 | 每会话策略、allow cache、Host resolve | 交互生命周期已迁移，下一步统一权限策略与审计 |
| 媒体 | 工具图已落盘，预览/生成分散 | token loopback + path scope | 统一 MediaService 与会话授权 |
| 密钥 | 配置合并/脱敏，但无统一 secret backend | OS keychain + 受限文件后备 | 单独 SecretStore，诊断永不带值 |
| 错误 | Rust 多为字符串，前端再推断域 | 稳定 AgentErrorCode | HostError DTO 取代正则推断 |
| 诊断 | support bundle 已有但依赖前端快照 | 日志、运行时、审计集中 | Host 快照为主，前端快照只作补充 |
| 测试 | 工具函数测试多，跨层运行时少 | mock ACP、路由/停机/竞态测试 | 增加故障注入和 Host 集成测试 |

## Consequences

- WebView 刷新不再决定任务是否已被消费，也不会丢失仍在 Host 等待的权限/提问；未结算自动化会在租约过期后由 Host 恢复。当前共享 ACP 进程仍随主窗口退出，这是明确限制。
- 迁移期间仍保留一个共享 CLI 进程；这是真实限制，不伪装成进程池。
- `AcpBridge` 会逐步缩小为投影器，Zustand 只保存 UI 需要的快照。
- Host 模块会增加，但每次拆分必须伴随职责迁移、测试或不变量，禁止只为了缩短文件。
- v0.3.2 完成标准不是“看起来像 grok-app”，而是上述十二条不变量可由 Host 测试证明。
