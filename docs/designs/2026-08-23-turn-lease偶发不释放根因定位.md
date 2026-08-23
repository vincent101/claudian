---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian-2.0.11
tags:
  - architect
  - claudian
  - concurrency
  - debugging
---

# 背景与问题

Claudian 在 SDK 已结束一轮后偶发保留 feature 层 `TurnCoordinator` lease，导致下一条输入停在 `queuedMessage`；需要区分 SDK 终止语义与插件自身结算链路，并给出不改源码前提下的根因判断及最小修复方案。

# 方案设计

## 1. 探针结论

探针保留于 `/tmp/claudian-lease-probe.mjs`，共执行 4 次，未触碰插件源码或 vault `.obsidian/`：

1. Stop hook 首次 `block`、第二次 `allow`：`assistant → Stop(block) → continuation → Stop(allow) → result` 正常，result 在约 14.5 秒到达。
2. `canUseTool` 配置：工具轮正常到达 `result`。
3. `resume`：新会话与 resume 第二轮均正常到达 `result`。
4. 直接使用源码 `MessageChannel` 作为 async iterable prompt：`DEQUEUE → assistant → Stop → result` 正常；query 本身保持长驻而不结束，符合 persistent query 语义。

因此未复现 SDK 层“轮结束但不结算”；Stop block/allow、approval、resume、async iterable prompt 均不能单独解释故障。

## 2. 代码链路结论

### 2.1 SDK result 到 runtime lease 释放

`/Users/vincentwang/Documents/NoteVault/tools/claudian-2.0.11/src/providers/claude/runtime/ClaudeChatRuntime.ts`：

- `1071-1074`：result 进入 `settleTurnAtResult`。
- `1249-1262`：有 waiter 的用户轮先 `onDone()`，再等待 deferred restart，最后删除 runtime turn 并 `completeChannelTurn()`。
- `1956-1962`：`onDone()` 仅把 generator 标成 done 并唤醒等待者。
- `2021-2037`：generator 会先退出主循环，再同步 drain 已缓存 chunks，不依赖后续 SDK 消费速度。
- `2054-2058`：generator finally 注销 handler；不会主动清除 collecting runtime turn，后者由 result 路径结算。

结论：buffer drain 本身没有“onDone 后丢尾块而永久等待”的路径。

### 2.2 feature lease 真正释放点

`/Users/vincentwang/Documents/NoteVault/tools/claudian-2.0.11/src/features/chat/controllers/InputController.ts`：

- `272-273`：feature lease 在首个 UI/持久化异步步骤前取得。
- `317`：`triggerTitleGeneration()` 位于保护性 `try/finally` 之外。
- `359-371`：`ensureServiceInitialized()` 同样位于保护性 `try/finally` 之外，仅 false 返回被显式 finish；Promise rejection 不受保护。
- `400-607`：只有进入该 try 后，`595-606` 的嵌套 finally 才保证 `finish(turnId)`。

这是可证实的 lease 泄漏路径：`beginUserTurn()` 成功后，`triggerTitleGeneration()` 或 `ensureServiceInitialized()` 若 reject，函数直接退出，`finish(turnId)` 永远不执行。首轮风险更高，因为 `triggerTitleGeneration()` 会创建/重命名会话并更新标题状态（`1088-1129`）；这与 `d18b94a0`“新会话第一轮即卡”相符。该路径由 S2 引入，阶段 1 没有 feature lease，因此符合版本回归边界。

但 `f4b429fa` 第五轮不必经过首轮 title 分支，现有证据不足以证明它也由同一 await 触发。最强次级假设是另一个 feature 结算 await 挂起，尤其是 `StreamController.finalizeCurrentTextBlock()` / `finalizeCurrentThinkingBlock()` 等待 render promise（`StreamController.ts:745-801,900-964`）；用户可见文字已出现并不代表这些 Promise 已 resolve。它们仍被最终 `finish()` 的 finally 覆盖，理论上 rejection 不泄漏，但“永不 settle”的 Promise 会阻止 finally 到达。需运行时日志确认。

### 2.3 queuedMessage 重复泵机制

`InputController.processQueuedMessage()` 在 `682-703` 先清 `state.queuedMessage`，再用 `setTimeout(0)` 重发，单次调用本身不会重复。重复发送要求存在两次 pump 或清空后同一内容被恢复：

- 用户轮由 `InputController.ts:585` 直接 pump；
- auto 轮由 `ClaudeChatRuntime.ts:1294-1297` 发 `onAutoTurnReleased`，经 `Tab.ts:1733-1734` 调 `TurnCoordinator.release()`，再由 `TurnCoordinator.ts:133-148` pump。

当前没有统一、幂等的 queue-drain 所有者。若 result 边界附近发生 user/auto 归属错配或 stale/unregistered turn 补偿释放，两个路径可先后观察并泵队列。`handleTurnDequeued()` 的 unregistered 分支（`ClaudeChatRuntime.ts:1302-1309`）只释放 runtime channel，不同步 feature coordinator；这会放大两层状态漂移。现有 transcript 能证明重复 enqueue，不能仅凭 transcript 唯一确定是哪两个 pump 触发。

## 3. 推荐修复

### 最小改动（推荐）

1. 在 `/Users/vincentwang/Documents/NoteVault/tools/claudian-2.0.11/src/features/chat/controllers/InputController.ts` 把保护性 `try/finally` 上移到 `beginUserTurn()` 成功后的第一条语句，覆盖 title generation、service initialization、prepare/query、projection和保存全链路。
2. `beginUserTurn()` 返回 false 时 fail-fast：恢复 `isStreaming`，将消息重新入 UI queue 或返回协议错误；禁止忽略失败后继续创建 DOM/发送 runtime turn。
3. lease 清理由唯一 finally 执行；保留“projection 完成后提前 finish”仅作为可证明安全的优化，不作为正确性前提。
4. queue pump 收口为单一入口：用户轮和 auto 轮都只通过 `TurnCoordinator.release(turnId)` 触发；`release` 消费 settled record 后立即置空，使同一 turn 的重复 release 幂等。移除用户轮 `InputController.ts:585` 的直接 pump。
5. `handleTurnDequeued()` 遇到 unregistered turn 时，除释放 runtime channel 外发出带 turnId 的取消/释放通知，让 feature 层对同一 turn 做条件清理；不要静默形成双层状态分叉。

### 诊断增强

在修复验证版本中为每个 turn 记录结构化阶段日志：`feature.begin/finish/release`、`runtime.enqueue/dequeue/result/onDone/complete`、`queue.set/clear/pump`，字段至少含 `turnId`、generation、conversationId、active feature/runtime turn、queue 是否为空。日志只记录状态，不记录用户正文。

# 风险与权衡

- 已确认根因类别在插件 feature 结算边界，不在 SDK；但现有探针未复现真实偶发时序。
- “保护范围过窄”是确定存在且足以泄漏 lease 的代码缺陷，对首轮样本解释力高；对第五轮样本仍是中等置信度，需要 console 阶段日志闭环。
- 单纯在 ESC 或超时处强制清 lease 只能掩盖根因，可能让旧轮与新轮并发投影，不推荐。
- 仅给 `finish()` 增加 generation 参数不能解决当前问题：现实现有 `finish(turnId)` 已按 turnId 校验；主要故障是调用根本未到达或两层生命周期漂移。
- deferred restart 是 result 路径唯一显式 await（`ClaudeChatRuntime.ts:1258,1288`），但它内部 `ensureReady(force)` 没有等待旧 consumer 结束，代码上未见必然死等；建议保留阶段日志，不作为首修对象。

# 验证方式

1. 探针回归：
   - `ANTHROPIC_BASE_URL=http://localhost:18889/ ANTHROPIC_AUTH_TOKEN=cc node --import tsx /tmp/claudian-lease-probe.mjs block-once`
   - 同命令末参依次换为 `approval`、`resume`、`channel`。
2. 单元测试：
   - mock `triggerTitleGeneration()` reject，断言 `TurnCoordinator.isBusy() === false`、`state.isStreaming === false`。
   - mock `ensureServiceInitialized()` reject，断言同上。
   - 同一 turn 连续调用两次 `release()`，断言 queued message 仅 pump 一次。
   - 构造 user result 与 stale/unregistered dequeue 交错，断言 feature/runtime 两层最终均无 active lease，且同一 queued payload 只发送一次。
   - 构造永不 resolve 的 render promise，再 cancel，断言取消路径主动解除等待并最终 finish。
3. 集成压力：新会话首轮、已有会话连续 10 轮、Stop block→allow、工具审批、resume、配置触发 deferred restart，各循环 20 次；每轮断言 `featureActive=null`、`channelActive=null`、queue drain 次数 ≤ 1。
4. 若线上仍复现，请截取从当前用户消息 enqueue 到下一条 queued 的完整 `[Claudian]` 日志，重点匹配：
   - `feature.begin` 后是否缺 `feature.finish`；
   - `runtime.result` 后是否卡在 `deferredRestart.begin`、`generator.done` 或 `projection.finalize.begin`；
   - 是否出现 `dequeued message for unregistered turn`、`completeTurn mismatch`；
   - 同一 turnId 是否出现两次 `queue.pump`，分别来自 direct-user 与 auto-release。

# 关联

- [[docs/designs/2026-08-22-Claudian阶段2空闲期管道回喂实施设计-v4]]
