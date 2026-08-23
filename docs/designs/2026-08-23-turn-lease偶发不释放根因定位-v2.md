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

Claudian 在 SDK 已输出回复后偶发保留 feature 层 `TurnCoordinator` lease，下一条输入停在 `queuedMessage`；目标是排除 SDK 终止语义并锁定插件内最可能的未结算边界。

# 方案设计

## 探针结论

探针位于 `/tmp/claudian-lease-probe.mjs`，执行 4 次：

- Stop 首次 block、随后 allow：正常得到第二次 Stop 和 result。
- `canUseTool` 配置：工具轮正常得到 result。
- 新 query + resume query：两轮均正常得到 result。
- 源码 `MessageChannel` 作为 async iterable prompt：正常 `DEQUEUE → assistant → Stop → result`；query 长驻不结束是 persistent query 的预期行为。

所以 Stop、approval、resume、async iterable prompt 均不能单独复现故障，根因范围收敛到插件收到 result 后的 feature 投影/清理阶段。

## 最强根因假设

`ClaudeChatRuntime.settleTurnAtResult()` 在用户轮调用 waiter `onDone()` 后可继续释放 runtime channel；但 `TurnCoordinator` 的 feature lease 只能等 `InputController.sendMessage()` 的 generator 完全 drain，并走到 finally 才释放：

- runtime result：`/Users/vincentwang/Documents/NoteVault/tools/claudian-2.0.11/src/providers/claude/runtime/ClaudeChatRuntime.ts:1246-1262`
- generator drain：同文件 `2021-2058`
- feature finish：`/Users/vincentwang/Documents/NoteVault/tools/claudian-2.0.11/src/features/chat/controllers/InputController.ts:400-607`

因此 SDK result 与 runtime channel 释放并不等于 feature lease 已释放。最可能的挂点是 generator drain 中的 UI 投影 await，尤其：

- `StreamController.finalizeCurrentTextBlock()` 等待 `flushPendingTextRender()`：`/Users/vincentwang/Documents/NoteVault/tools/claudian-2.0.11/src/features/chat/controllers/StreamController.ts:745-801`
- `finalizeCurrentThinkingBlock()` 等待 `flushPendingThinkingRender()`：同文件 `900-964`
- 两类 pending promise 只在 render 完成或 `resetStreamingState()` 中显式 resolve：同文件 `836-851,999-1014,1586-1602`

这能同时解释：assistant 文本已出现、SDK 端已完成，但 feature finally 尚未到达；ESC 经 cancel/reset 路径解除 pending render 并让 finally 继续，从而解锁。当前仍属高强度代码假设，缺少异常现场阶段日志，不能伪装成已实证唯一根因。

另有确定存在但不符合两个现有样本时序的缺陷：`InputController.ts:317` 的 `triggerTitleGeneration()` 与 `359-360` 的 `ensureServiceInitialized()` 位于保护性 try/finally 之前；它们 reject 会直接泄漏 lease。但两个样本均已有 assistant 输出，说明其当轮已越过这两个 await，故它不是本次样本主因，仍应顺手修正。

## 重复 pump 机制

`processQueuedMessage()` 自身先清 queue 再异步 send（`InputController.ts:682-703`），单次调用不会重复。重复发送只能来自“同一内容被再次放回 queue”或两个独立 drain 入口交错：

- 用户轮结束直接 pump：`InputController.ts:584-585`
- auto turn release pump：`ClaudeChatRuntime.ts:1294-1297` → `Tab.ts:1733-1734` → `TurnCoordinator.ts:133-148`

当前 queue drain 并非单一所有者；同时 `handleTurnDequeued()` 的 unregistered 补偿只释放 runtime channel（`ClaudeChatRuntime.ts:1302-1309`），不对齐 feature coordinator。该结构允许两层状态漂移，并与现场 `dequeued-for-unregistered` 警告及重复 enqueue 相容，但需要 turnId 级日志确定具体交错。

## 推荐最小修复

1. 将 user turn 的 feature lease 生命周期下沉到一个统一 `runTurnWithLease()`/单一 outer finally；从 `beginUserTurn()` 成功起覆盖 title、初始化、query、projection、save 全链路。
2. `beginUserTurn()` 失败必须 fail-fast，不能忽略返回值继续创建 UI/runtime turn。
3. 为 `flushPendingTextRender()`、`flushPendingThinkingRender()` 增加可取消的 turn-scoped await；cancel/lifecycle invalidation 必须主动 settle，且 render 回调不得依赖已被替换的全局 DOM state 才 resolve。
4. queue drain 统一由 `TurnCoordinator.release(turnId)` 触发；移除用户轮 finally 内直接 `processQueuedMessage()`。`release()` 消费 settled record 后清空，使重复 release 幂等。
5. unregistered dequeue 补偿同时通知 feature 层按 turnId 条件取消，保持 runtime/feature 两层一致。

# 风险与权衡

- 探针没有复现线上偶发时序，因此当前结论是“SDK 排除 + 插件投影 await 最强假设”，不是完整实证闭环。
- 只加超时强制 finish 会允许旧投影与新轮并发，可能造成跨轮 DOM/消息污染，不推荐。
- `executeDeferredRestartIfAny()` 是 runtime result 路径的唯一 await（`ClaudeChatRuntime.ts:1258,1288,1450-1471`），但其 `ensureReady(force)` 未等待旧 consumer，源码上未见确定死等；仍需日志排除。
- 首轮保护范围缺陷应修，但不能拿它解释已经产出 assistant 的两个样本。

# 验证方式

1. 保留探针回归：
   - `ANTHROPIC_BASE_URL=http://localhost:18889/ ANTHROPIC_AUTH_TOKEN=cc node --import tsx /tmp/claudian-lease-probe.mjs block-once`
   - 末参换为 `approval`、`resume`、`channel`。
2. 新增阶段日志，字段含 `turnId`、feature/runtime active turn、generation、queue 状态；节点：
   - `runtime.result.enter/onDone/deferredRestart.begin/end/completeTurn`
   - `generator.chunk/drain.done/finally`
   - `projection.textFlush.begin/end`、`thinkingFlush.begin/end`
   - `feature.begin/finish/release`
   - `queue.set/clear/pump(source)`
3. 向用户索取异常发生前后完整 `[Claudian]` console；判定规则：
   - 有 `runtime.completeTurn`、无 `generator.finally`：卡在 generator drain/投影。
   - 有 `projection.*.begin`、无对应 end：锁定 render promise。
   - 有 `deferredRestart.begin`、无 end：锁定 restart。
   - 有 `generator.finally`、`feature.finish=false`：turnId/feature active 漂移。
   - 同一 payload 两次 `queue.pump`：按 source 确定双泵入口。
4. 单元测试覆盖：render promise 在尾块 flush 时挂起后 cancel；title/init reject；重复 release；unregistered dequeue 与 feature lease 对齐；同一 queued payload 最多 send 一次。
5. 集成压力：新会话首轮、已有会话连续 10 轮、Stop block→allow、工具审批、resume、deferred restart 各循环 20 次；每轮断言两层 active lease 均为空。

# 关联

- [[docs/designs/2026-08-22-Claudian阶段2空闲期管道回喂实施设计-v4]]
- 前一草案 `/Users/vincentwang/Documents/NoteVault/tools/claudian-2.0.11/docs/designs/2026-08-23-turn-lease偶发不释放根因定位.md` 对首轮 await 缺陷归因过强；本版修正为次要缺陷，未覆盖旧文档。

## 复核后记（2026-08-23，六项修复合入时）

**埋点处置决策**：14 处 `console.debug` 为取证期临时埋点（DevTools debug 级默认隐藏，量级按块边界触发不刷屏）。观察稳定后随 S4+S5 大修移除；若复发，日志自动报出卡点。

**已知残余风险（复发时第一排查点）**：flush await 已可取消，但 finalize 体内 flush 之后的直接 `await renderer.renderContent(...)`（StreamController.ts 数学渲染延迟路径、thinking finalize 路径）不受 invalidation 保护——若日志出现 `projection.*.end` 已打而 turn 仍卡，落此处。次排查点：cleanup 阶段（isStreaming 已 false、lease 仍在）的 finalize 挂起仅会话切换可解。

## 终章：同根因三发作确诊（0823 深夜，本系列收官）

六项修复+finalize 渲染保护部署后，console 全程埋点（Obsidian CLI `dev:console` 读取）抓到最终真相：用户轮 result 正常结算、feature.finish 正常执行的**同一毫秒**，一条尾随的 queue-operation 记录（非轮次内容）以无主状态到达 → ensureAutoTurn 误建 auto turn 抢占 feature 锁（`ok:true`）→ 该 turn 永无 result → 锁永挂。auto 创建与用户锁释放的**毫秒级竞态**决定抢占成败——即全部"偶发"的真相。

**重新定性**：轮次挂死家族三发作（fbd4de8 的 init、c5ad19d 的纯通知、本例尾随记录）为**同一病根**——"无主消息一律建 auto turn"。前两次修复是发作部位治理；根治为 `isAutoTurnStartMessage` 白名单（commit 99dca6b）：仅 `assistant`/`stream_event` 可开轮，其余无主消息丢弃+warn。fbd4de8（init 副作用）与 c5ad19d（通知销账）保留——各承载独立必需功能，与白名单三道门分工。

**复盘教训**（已入 AI_MEMORY `0823-2`）：同族症状第 2 次发作即应停止打补丁、先上埋点找共同病根——纯通知修复时已有 49% 数据暗示"建轮条件太宽"却未深挖。
