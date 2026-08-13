# Grox 上游集成

本上下文定义 Grox 如何理解和跟进官方 Grok Build 的持续变化。它确保版本发现、变化分析和桌面端完整集成不会被混为一谈。

## Language

**上游观察（Upstream Observation）**：
已经发现并登记的官方 Grok Build 发布或源码提交；它只证明变化已被看见。
_Avoid_: 已适配、已兼容、已审查基线

**上游变化项（Upstream Change Item）**：
官方发布中一个可独立分析的功能、修复、性能或协议变化。
_Avoid_: 更新点、杂项

**桌面融合决策（Desktop Integration Decision）**：
一个上游变化项在 Grox 非终端产品中的处理结论，包括继承、桌面化实现或有证据的不适用。
_Avoid_: 忽略、应该没影响

**验证集成（Verified Integration）**：
所有上游变化项均有桌面融合决策、实现证据和真实官方 CLI 回归证据的状态。
_Avoid_: 看过、基本兼容、未崩溃

**集成基线（Integration Baseline）**：
最近一个达到验证集成状态的官方源码提交。未完成的目标不能成为集成基线。
_Avoid_: 最新提交、已观察提交

**继承变化（Inherited Change）**：
由官方 CLI 运行时直接提供，但仍经过 Grox 场景验证的上游变化项。
_Avoid_: 自动获得、无需测试

## 会话运行时语言

**应用会话（App Session）**：
用户在 Grox 中创建、查看、重开和删除的对话身份；它拥有目录项、草稿、提示队列和本地展示历史。
_Avoid_: 当前页面、当前聊天框

**Agent 会话（Agent Session）**：
Grok Build CLI 通过 ACP 创建或恢复的上下文身份；所有协议事件和操作都必须显式归属到它。
_Avoid_: 当前 Agent、活动槽位

**回合（Turn）**：
从一个主提示被 Agent 接受，到对应 `session/prompt` 请求成功、失败或被取消的完整执行周期。
_Avoid_: 一条消息、一次流式输出

**人工门禁（Human Gate）**：
回合中等待用户批准、拒绝或回答的问题；门禁属于发起它的会话，切换页面不会转移归属。
_Avoid_: 弹窗、全局确认

**提示队列（Prompt Queue）**：
按应用会话持久保存、等待未来回合发送的用户意图；它不是已经被 Agent 执行的历史。
_Avoid_: 消息历史、CLI 回显

**队列事故门禁（Queue Incident Gate）**：
停止或运行时事故后扣留提示队列的显式门禁；只有“确认并继续”或清空队列能解除，发送一条新的主提示不代表同意重放旧队列。
_Avoid_: 自动恢复、下次发送时顺便继续

**运行时连接（Runtime Connection）**：
Grox 与 Grok Build CLI 子进程之间的连接事实；连接恢复不等于被中断的回合已经成功完成。
_Avoid_: 登录状态、会话状态

**运行时事故（Runtime Incident）**：
导致连接或回合无法按协议完成的异常退出、环境故障或协议破坏；恢复连接只能结束事故，不能改写原回合结果。
_Avoid_: 普通失败、已自动修复

**自动化运行记录（Automation Run Record）**：
Grox 当前窗口实际观察到的一次定时或手动启动尝试；`starting`、`started`、`skipped`、`error`、`unknown` 只描述启动链路，不证明任务已完成或应用退出后仍在运行。
_Avoid_: 执行历史、后台服务日志
