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
