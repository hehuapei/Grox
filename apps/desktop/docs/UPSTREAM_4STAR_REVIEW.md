# 四星及以上回灌 — 严格 review（相对 main / PR #13）

目标：主线可独立运行后弃用本地 fork。仅收录 ★★★★～★★★★★ 且可安全合入项。

## 决策表

| 项 | 星 | 本 PR | 严格结论 |
|----|:--:|:----:|----------|
| ACP allowlist / SSRF / catalog / Job / cache trim / offline merge / sessionGate | ★★★★+ | 已在 #13 第一 commit | **保留** |
| host_prefs + CU 主机门 + migrate latch | ★★★★★ | **本 commit 纳入** | 主线 `computer_use_enabled` FE 默认开；合入后：**首次 migrate 保留现有 FE 偏好**，其后 host 为权威；`computer_session_extensions` / spawn plugin **忽略未确认 FE** |
| CU Bearer 宿主 inject | ★★★★★ | **不重复做** | 主线已有 `mcp_leases` 整表替换（FE 不持 token）；再 inject 易双路径冲突。**文档对齐 lease 模型** |
| computerUse 纯策略 + 测 | ★★★★ | **本 commit 纳入** | 接 host_prefs 缓存；不整替换 Settings UX |
| sessionOpenPolicy 升级 force | ★★★★ | **本 commit 纳入** | 无完整 fingerprint 管线时：升级代际内强制 `loadSession` + cache 仅作 paint、status 强制 idle |
| promptQueue 纯函数 + 测 | ★★★★ | **本 commit 纳入** | drain 用 `nextLocalDrainIndex`；idle 用 ghost filter；**不**整 rewrite CLI 事件总线 |
| queueParkPolicy | ★★★★ | **本 commit 纳入** | 对齐 Stop → suppress + parked mirror |
| firstEventWatch 纯函数 + 测 | ★★★★ | **本 commit 纳入** | 策略可测；**不**强绑超时杀进程（避免误杀主线慢工具，接线留给后续小 PR） |
| 完整 open fingerprint / chat_history enrich Rust | ★★★★ | **否决本波** | 与 main 离线路径差异大；#13 spine 已覆盖主要顺序；缺证据再开专 PR |
| CLI queue/changed 全量 merge | ★★★★ | **否决本波** | store 缠绕；纯函数已入库，接线需独立 PR |
| 策略单测密度 | ★★★★★ | 随模块带入 | 必须绿 |

## 明确不回灌（与「改用主线」冲突）

- 删 Browser Use / 应用内更新
- 整棵 0.2.31 monorepo 替换
- 与 `mcp_leases` 对打的第二套 Bearer 通道

## 验收

- `pnpm test` 全绿
- `cargo test` host_prefs + 既有 acp/parse 过滤绿
- Settings 关 CU 后 `computer_session_extensions` 不挂 MCP
- 版本号变更后 open 会话强制 background load 一次
