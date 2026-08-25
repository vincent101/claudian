---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - claudian
  - subagent
  - debugging
---

## 背景与问题

Claudian 在 15:20 热修后，异步 subagent 卡片由“Prompt + 工具明细 + Result”退化为“Prompt + Result”；需定位数据存在但 UI 不再补齐的断点，并在不破坏 task-notification 实时销账语义的前提下恢复。

## 方案设计

### 根因结论

断点不是 SDK 丢事件，也不是 `task-notification` 误判中间活动；而是**终态通知新增的提前销账，与既有唯一 sidecar hydration 触发器互斥**。

1. Agent 启动后，`SubagentManager.handleTaskToolResult()` 将记录放入 `activeAsyncSubagents`。
2. subagent 中间工具活动只写入 `subagents/agent-*.jsonl`；主会话 transcript 不包含这些 `Read/Bash/...` 事件。`task-notification` 仅在 agent 停止/完成时出现，样本 XML 明示：`A task-notification fires each time this agent stops...`。
3. 当前工具明细 sidecar 读取并非“运行中轮询”：`StreamController.hydrateAsyncSubagentToolCalls()` 只由 `handleAgentOutputToolResult()` 调用，且只接受 `completed/error`；后续 200/600/1500ms retry 也只补最终结果，不再次读取工具明细。
4. 15:20 前实际部署 bundle 没有 `setSubagentNotificationHandler` / `handleTaskNotification`。因此完成后的 `TaskOutput` 仍能从 `activeAsyncSubagents` 找到记录，进入 `handleAgentOutputToolResult()`，再触发 sidecar hydration。
5. 15:20 后 bundle 新增通知销账：`handleTaskNotification()` → `settleActiveSubagent()` 立即把记录从 `activeAsyncSubagents` 删除，并清除 `outputToolIdToAgentId`。随后：
   - 无 `TaskOutput` 的样本：根本没有 hydration 入口；
   - 有 `TaskOutput` 的样本：`handleAgentOutputToolUse()` 已找不到 active 记录，无法建立 output 映射；结果到达后 `handleAgentOutputToolResult()` 返回 `undefined`，仍不 hydration。

因此 UI 只收到通知写入的 Result，sidecar 中完整工具调用永远未投影。

### 关键文件与函数

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts`
  - `routeMessage()` / `dispatchTaskNotification()`：通知识别与投递；保持“无 lease 只销账、不建 auto turn”。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/services/SubagentManager.ts`
  - `handleTaskNotification()` / `settleActiveSubagent()`：当前提前删除 active/output 映射的断点。
  - `handleAgentOutputToolUse()` / `handleAgentOutputToolResult()`：原 hydration 前置关联依赖 active map。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/StreamController.ts`
  - `handleAgentOutputToolResult()` → `hydrateAsyncSubagentToolCalls()`：当前唯一工具明细补齐入口。
  - `tryHydrateAsyncSubagent()`：工具明细仅首次读取；retry 只补 final result。

### 推荐修复：通知终态后立即 hydration

保持 c5ad19d 的 runtime/lease 行为不动，仅补齐 feature 层终态投影：

1. 在 `StreamController` 增加面向通知的异步入口，例如 `handleAsyncSubagentNotification(taskId, status, result)`。
2. 入口先调用 `SubagentManager.handleTaskNotification()` 完成现有销账；使用其返回的 `SubagentInfo` 立即调用现有 `hydrateAsyncSubagentToolCalls()`。
3. `setupServiceCallbacks()` 的 notification handler 改为 fire-and-observe 调该入口；异常记录诊断但不得影响 runtime 消费循环。
4. 保留 `TaskOutput` 路径作为兼容兜底；hydration 本身应幂等。
5. 将 `tryHydrateAsyncSubagent()` 的工具读取条件从“仅 `toolCalls` 为空”改为按 tool id 合并，以兼容未来多次增量读取，避免首次读到部分 sidecar 后永久冻结。

该方案不恢复/延长 active bookkeeping，不影响 Stop hook 与通知销账，也不重建 ghost auto turn。

### 若产品要求严格“运行中逐步冒工具行”

现有源码并无运行态 sidecar 轮询，只有终态 one-shot hydration。若必须保证逐步显示，应另设由 async launch 启动、终态停止的有界 poller：按 agentId 定时读取 sidecar、按 tool id 增量合并、刷新卡片；task-notification 只负责停止 poller并做最终一次读取。此为独立增强，不应伪装成最小回归修复。

## 风险与权衡

- 推荐方案恢复的是“完成通知到达时补齐工具明细”，改动最小且与销账语义正交；不能凭现有代码保证运行期间逐条刷新。
- 通知与 sidecar 最终 flush 存在竞态；必须复用现有 retry，并让 retry 同时重读工具明细，而非只读 final result。
- fire-and-forget 异步入口必须显式捕获异常，避免 unhandled rejection。
- 不能通过延迟 `settleActiveSubagent()` 或重新保留 `activeAsyncSubagents` 来修：这会重新耦合 UI hydration 与运行态账本，增加 Stop hook/重复通知风险。
- 0133ab7 的 projection/flush 改动不是首断点；新旧函数语义等价，且数据入口在它之前已丢失。

## 验证方式

1. 单测：通知到达、无 `TaskOutput`，断言 `loadSubagentToolCalls(agentId)` 被调用，卡片/message 写入工具明细，active map 已销账。
2. 单测：通知先到、`TaskOutput` 后到，断言不重复工具项、Result 不回退、无 active 记录复活。
3. 单测：首次 sidecar 仅 1 个工具，retry 后出现第 2 个工具及 final result，断言按 id 合并并二次刷新。
4. 单测：重复 enqueue/remove 通知，断言 hydration/销账幂等。
5. runtime 回归：纯通知无 lease 后仍不创建 auto turn，下一条用户消息立即获得 lease。
6. 人工慢 agent：执行 5 个间隔工具；确认完成通知后卡片含 5 条工具和 Result。若实施运行态 poller，再额外确认每步在完成前逐条出现。
7. 全量命令：`npm run typecheck && npm run lint && npm run test && npm run build`。

## 关联

- [[docs/designs/2026-08-21-Claudian-Stop-hook自激循环修复方案]]
- [[docs/designs/2026-08-23-Claudian阶段2-S4S5重设计-v2]]

## 修复结论（0824 验证通过）

根因（通知销账副作用切断 hydration）已修复并实测验证：

- **8883b66**：`handleAsyncSubagentNotification` 在通知销账后立即触发 `hydrateAsyncSubagentToolCalls()`，按 tool id 合并+retry 重读 sidecar——通知驱动的工具明细恢复
- **c8d079d**：秒完成竞态补齐——`handleTaskToolResult` 的 early-terminal 分支返回 early-settled 信号，由 `handleAsyncTaskToolResult` 对该记录调用同款 hydration，堵"通知先于转正到达"的窗口

实测：0824 派 5 步慢速 agent，运行中卡片逐步冒工具行（Bash/Read 交替），完成后卡片含完整工具列表+Result——恢复到事故前水平。


## 续章：运行中实时显示（0825 落地）

完成时补齐（8883b66/c8d079d）解决了"看不到"但仍有"运行期空白、完成时全冒"的延迟。根因：retry 链 gating 在 `asyncStatus !== 'completed'` 时直接 return（运行中不读 sidecar）——上游即如此，非本工程回归（更早 CC SDK 同步运行 Agent 时活动流入主流，SDK 异步化后只能靠 sidecar 轮询）。

**62a38f0**：去掉运行中 gating + `onAsyncSubagentStateChange` 在 running 时启动轮询链（每 2s 读 sidecar 增量、按 tool id 合并、终态收口停止，上限 900 次≈30 分钟兜底）。Set 注册所有权从状态回调移至链自持（通知 settle 同步删 Set 会让防重检查恒失效——实施 agent 发现的时序矛盾）。实测：运行中工具行每 2 秒逐条冒出。
