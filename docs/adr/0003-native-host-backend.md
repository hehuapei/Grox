# ADR-0003：原生 Host 成为 Grox 后端唯一运行时

- 状态：Accepted（迁移中）
- 日期：2026-08-14
- 版本：v0.3.2
- 取代：ADR-0001 第 4、6、7 条

## Context

Grox 的 Rust 进程已经负责启动 CLI、文件和 Git 操作，但 ACP JSON-RPC 请求关联、
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

### v0.3.2 内的迁移顺序

以下是同一个 v0.3.2 版本内的迁移切片，不拆分为多个发布版本：

| 顺序 | 后端主干 | 迁移结果 |
| --- | --- | --- |
| 1 | Native ACP transport | Host 关联请求/响应并负责超时、取消、退出清算；已落地 |
| 2 | SessionCoordinator | Host 签发/校验 lifecycle 与 turn 许可并发布占用快照；已落地 |
| 3 | Native repositories | PromptQueueStore 已迁移；journal、草稿、自动化继续改为带锁语义事务 |
| 4 | Background execution | 自动化、恢复、后台多会话通过 SessionCoordinator 执行；再评估按会话进程池 |
| 5 | Host services | worktree、权限、媒体、密钥统一使用会话/项目身份和路径授权 |
| 6 | Command facade | 将 `main.rs` 按领域迁出，Tauri command 只校验 DTO 并调用服务 |
| 7 | Error/diagnostics | 稳定错误码、运行时快照、审计事件和支持包覆盖所有上述服务 |

顺序不能倒置：在 Host 尚未拥有会话状态前直接增加进程池，只会把当前分裂状态复制
到多个进程；在 repository 尚未拥有事务前运行后台自动化，会放大队列和 journal 竞态。

## 当前实现（v0.3.2）

- `acp_host::AcpRequestBroker` 已成为出站 RPC 的 Host 请求表；
- `acp_request` 定向返回响应，`acp_send` 拒绝绕过 Host 的出站请求；
- 普通请求超时由 Host 处理，长回合由会话 watchdog 调用 `acp_cancel_request`；
- 进程替换、自然退出、停止、CLI 更新和主窗口退出都会清算请求；
- Host 为退出、通道替换、超时、停滞、取消和协议校验返回稳定错误代码，前端不再用字符串正则覆盖这些分类；
- 环境摘要和支持包记录 Host 悬挂请求数；
- WebView 只解释已经归属的响应，未知广播响应仍呈现为协议错误。
- `session_coordinator::SessionCoordinator` 在 Host 内维护活动回合、FIFO 生命周期队列和进程代次；
- `session/new`、`session/load`、`session/prompt` 必须携带 Host 签发且与方法、会话、代次匹配的许可；
- 生命周期排队会阻止新回合抢占，不同已绑定会话仍可并发运行；等待任务取消、进程自然退出、替换、停止、CLI 更新和主窗口退出都会清除旧许可；
- 占用快照由 Host 通过事件和查询命令发布，环境摘要与支持包不再依赖 WebView 自报门控状态；
- 前端 `SharedAcpLifecycleGate` 及其平行测试已删除，兼容重试、回放收尾和模型/模式预绑定仍保持在同一 Host 许可窗口内。
- `prompt_queue_store::PromptQueueStore` 在 Host 锁内按会话合并 patch 并原子替换文件，前端不再提交整个队列文件；
- 不同会话的并发队列写不会互相覆盖，Host 会校验队列条目/附件契约、容量和重复 id；
- 旧 localStorage 队列只在原生仓储从未初始化时迁移一次，原生空对象也是初始化标记，避免已删除队列在重启后再次导入；
- 删除会话/项目会在同一 tombstone 锁序内删除提示队列，晚到 upsert 会被 Host 拒绝，不能让已删除会话复活。

本切片没有把供应商切换的“发送意图等待”、队列调度策略和自动化调度伪装成已经迁移：
它们仍在 Bridge/Store，后续必须通过同一个 SessionCoordinator 的维护操作与后台执行入口
迁入 Host，才能删除 `activePromptSessions` 等剩余前端运行时权威。提示队列持久化事务
已经迁入 Host，但何时 claim、发送和恢复仍属于 Background execution 切片。

## 完整后端对照结论

| 领域 | Grox 迁移前 | `grok-app` 可学习点 | Grox 决定 |
| --- | --- | --- | --- |
| 组合根 | 9k+ 行 `main.rs` 同时承担命令与业务 | `lib.rs` 组合状态，commands 为薄门面 | 随职责迁移拆模块，不做纯文件搬家 |
| ACP | Rust 透传 stdio，Bridge 关联请求 | `AcpClient` 在 Host 维护 pending/退出 | 先完成 Native ACP transport |
| 会话 | Bridge + Store 共同裁决 | Host SessionManager + FSM + snapshots | 建立单一 SessionCoordinator |
| 多会话 | 单进程共享、生命周期门控在前端 | 每应用会话进程、后台 busy 不被抢占 | 先迁权威，再用容量策略决定进程池 |
| 持久化 | 前端组装完整 JSON，Host 原子写 | store + 锁 + journal 对账 | Host 提供语义操作和锁内 RMW |
| 队列 | Store/localStorage 主导 | Host 运行时可观察 busy/退出 | 队列状态与发送事务绑定 |
| 自动化 | 前端调度，依赖 WebView 存活 | runner 复用 SessionManager | 后台 runner 共用 SessionCoordinator |
| 工作树 | 命令安全性已有，生命周期仍偏 UI | worktree 与 session metadata 绑定 | 引入 Host 所有权记录和清理策略 |
| 权限 | Host 有部分产品门禁，交互在 Bridge | 每会话策略、allow cache、Host resolve | 权限请求按 session + rpc id 建模 |
| 媒体 | 工具图已落盘，预览/生成分散 | token loopback + path scope | 统一 MediaService 与会话授权 |
| 密钥 | 配置合并/脱敏，但无统一 secret backend | OS keychain + 受限文件后备 | 单独 SecretStore，诊断永不带值 |
| 错误 | Rust 多为字符串，前端再推断域 | 稳定 AgentErrorCode | HostError DTO 取代正则推断 |
| 诊断 | support bundle 已有但依赖前端快照 | 日志、运行时、审计集中 | Host 快照为主，前端快照只作补充 |
| 测试 | 工具函数测试多，跨层运行时少 | mock ACP、路由/停机/竞态测试 | 增加故障注入和 Host 集成测试 |

## Consequences

- WebView 刷新不再是清理后台请求的必要条件，后续可以安全支持后台会话和自动化。
- 迁移期间仍保留一个共享 CLI 进程；这是真实限制，不伪装成进程池。
- `AcpBridge` 会逐步缩小为投影器，Zustand 只保存 UI 需要的快照。
- Host 模块会增加，但每次拆分必须伴随职责迁移、测试或不变量，禁止只为了缩短文件。
- v0.3.2 完成标准不是“看起来像 grok-app”，而是上述十条不变量可由 Host 测试证明。
