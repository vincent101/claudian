---
type: design-decision
status: superseded
superseded_by: "[[2026-09-09-Claudian空闲期宿主tab实时投影-v6-transcript感知]]"
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - claudian
  - runtime
  - ui
  - hotfix
---

# Claudian 空闲期宿主 tab 实时投影 v5 修复增补

## 背景与问题

v5 主方向成立，但部署前必须补齐六处：真实 peer 正文净化、replay 拦截、保存异常释放、活跃 turn 内 peer 排队、`task-notification` origin 分类、chunk 投影异常不丢数据。

## 方案设计

### 1. 活跃 turn 内 peer：采用 FIFO 排队，不采用“只显示气泡”

**定案：选 b。** `shouldQuery !== false` 表示该外部 user 消息会触发后续 assistant turn；只显示气泡却不保留归因，会把后续 assistant 误并入当前/下一人工 turn。排队必须复用现有 release 顺序，不另设 feature pump。

修改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts` 与 provider runtime types：

1. 增加有界 FIFO `pendingExternalTurnStarts`，元素仅含净化后的 `LeaselessTurnStart`；上限复用 `MESSAGE_CHANNEL_CONFIG.MAX_QUEUED_MESSAGES`。溢出时保留先到项并告警，不显示未承诺处理的来源气泡。
2. `routeMessage()` 收到 `type=user`、`origin.kind∈{peer,channel,coordinator}`、`shouldQuery!==false`：
   - 无 active runtime turn：按现有路径立即开 auto turn；
   - 有 active turn：只入 FIFO，不交给当前 turn 的 transform/projection，不立即显示气泡。
3. **用户 turn 不能在 runtime result/cancel 后立即晋升 peer。** `handler.onDone()` 只唤醒 generator；此时 `InputController` 尚未 finalize/save，也尚未 `TurnCoordinator.finish(userTurnId)`。直接晋升会让 `onAutoTurnStarted` 被旧 user feature lease拒绝，并使两个 turn 共用 `StreamController` 全局 DOM 状态。
4. 为同一个 user turn 增加一条**完成屏障**（不是第二把锁）：runtime 在 `onDone()` 前建立 turnId 对应 barrier，随后等待 feature 调用 `completeUserTurnProjection(turnId)`；feature 仅在本轮所有投影、保存尝试、全局 streaming cleanup 和 `TurnCoordinator.finish(turnId)` 完成后调用。该方法返回时保证 runtime 已完成“旧 channel lease释放 + 下一 peer晋升（若有）”。
5. feature 在 `await completeUserTurnProjection(turnId)` 返回后才调用既有 `TurnCoordinator.release(turnId)`：
   - 有 peer 晋升时，`onAutoTurnStarted` 已原子取得新的 auto feature lease，旧 user release因存在 active lease而不 pump；
   - 无 peer时，没有新 lease，旧 user release按原逻辑且仅一次 pump人工 `queuedMessage`。
6. auto turn 不需要此屏障：其 `onAutoTurnFinished` 本就被 runtime await，结束后可直接“channel release → 晋升下一 peer → old auto release callback”。
7. `closePersistentQuery/resetSession/setSessionId/cleanup` 清空 FIFO并以 aborted 结果解除所有 barrier；不得晋升 peer。用户 cancel只标记 turn cancelled并唤醒 generator，channel lease/registry删除/peer晋升延后到 feature ack 后；cancel期间到达的 trailing result对该 cancelled turn只丢弃，不能再次 settle。
8. 不预创建空 lease：pending 描述只在前一 turn完整结束后晋升，避免 08-22 的 reservation/第二把锁。唯一人工 queue pump 仍是 `TurnCoordinator.release()`。

依赖关系：runtime FIFO负责“SDK 已到达但尚未归属”的边界；completion barrier只表达同一 user turn 的 runtime→feature→runtime happens-before，不拥有新 turn、不持有第二份业务状态；`TurnCoordinator` 仍只管理一个 feature turn；`MessageChannel.activeTurnId` 仍只持有一个 runtime turn。

#### 1.1 用户 turn 完成屏障的精确定义

**定案：候选 1，显式异步回执；否决原子接替。** 原子接替只能解决 lease 名称冲突，不能阻止旧 `InputController` 在新 auto turn 开始后继续 finalize/save/reset 同一个 `StreamController`，会造成跨 turn DOM 与持久化污染。显式屏障把真实资源释放点作为顺序边界，且比 reservation 更窄、更可验证。

接口与实现：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/ChatRuntime.ts` 增加可选方法：
  `completeUserTurnProjection?(turnId: string): Promise<void>`。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts` 增加 `userTurnCompletionBarriers: Map<turnId, { featureFinished; runtimeHandoffDone }>`；barrier必须在调用 user waiters的 `onDone()` 前注册，防止 feature快速回执丢失。
- `settleTurnAtResult(userTurn)` 顺序固定为：
  `register barrier → publish metadata → onDone/clear waiters → await featureFinished → deferred restart eligibility check → delete old runtime turn → completeChannelTurn(old) → promoteNextExternalTurn() → resolve runtimeHandoffDone`。
- `completeUserTurnProjection(turnId)`：解析并 resolve `featureFinished`，随后 await `runtimeHandoffDone`。未知/已完成/生命周期已 abort 的 turnId幂等返回；不得自行 promote或操作 feature lease。
- `cancelTurn(userTurn,'user_cancel')` 采用相同 barrier，但因公开 `cancel()` 保持同步，后半段放入受控异步 continuation：
  `mark cancelled/abort → register barrier → onDone → await featureFinished → delete/release/promote → resolve runtimeHandoffDone`。等待期间 registry保留 cancelled tombstone；`routeMessage()` 对其 trailing result直接 drop。query-close等终止原因不等待 feature，直接 abort barrier、清 FIFO并完成清理。
- `executeDeferredRestartIfAny()` 的 idle 判定必须同时要求 `pendingExternalTurnStarts.length===0`；否则 restart会在 peer晋升前清掉 FIFO。最后一个 pending external turn结束后再执行 deferred restart。

`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/InputController.ts`：

1. 把“是否应 release/pump、plan auto-send、新会话 auto-send”等后继动作先记录为本地 intent，不在 user turn cleanup 尚未结束时执行。
2. 最外层 `finally` 的顺序固定为：
   `完成/隔离本轮 cleanup → TurnCoordinator.finish(userTurnId) → await runtime.completeUserTurnProjection?.(userTurnId) → TurnCoordinator.release(userTurnId)（仅原逻辑允许 pump时）→ 执行记录的后继 send/createNew intent`。
3. 即使 finalize/save/title/plan流程抛错，也必须进入该 finally并发送回执。运行时回执失败只能在 lifecycle已关闭时被吞；其他错误显式记录，不能跳过 feature清锁。
4. 下一次 `sendMessage()`、`createNew()` 或人工 queued pump均不得发生在 ack Promise 返回前，防止新 user feature lease抢在 pending peer之前。

这条屏障消除 08-22 卡死的方式不是超时抢占：不设超时强制晋升（会重建并发写）；依靠所有 user路径的 finally回执，以及 query-close/lifecycle abort统一解除等待。

### 2. peer 正文净化

在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts` 提取纯函数 `extractExternalDisplayContent(message)`，规则如下：

1. **优先候选**：当 `origin.kind='peer'` 且运行时扩展字段 `origin.body` 为非空字符串，优先使用。它是语义载荷而非安全可信输入：仍须净化，不得直接渲染。
2. 备用候选：拼接 `message.message.content` 中所有 text block/字符串。
3. 对候选执行确定性剥壳：
   - 去掉固定前缀 `Another Claude session sent a message:`；
   - 若含完整 `<cross-session-message ...>...</cross-session-message>`，只取元素正文，丢弃开始标签全部属性及闭合标签后的 SDK 安全说明；
   - 若含完整 `<agent-message ...>...</agent-message>`，只取元素正文，丢弃属性；
   - 对 courier 正文，删除开头连续的 `[to]...`、`[from]...` 行；遇到首个 `[msg]`，返回该标记后的同一行文本加后续全部行；
   - trim；不做 HTML/XML 正则泛化删除，避免误删业务正文。
4. 若检测到上述 wrapper 起始标记但找不到配对闭合，或净化后为空，fail-closed：`displayContent` 不承载原文，UI 只显示来源标签/“Peer message received”。
5. `origin.from`、socket、`verifiedPeerPid/msg_id/fromMode`、wrapper 属性永不进入 event。`origin.name/server` 只作普通文本 label。

现场基准：transcript `d8912b5b-7549-48ce-b75f-940214fd96ff.jsonl:1574`，最终气泡应从“[数据治理任务包移交……”开始，不含 `uds:/tmp/cc-socks`、`<cross-session-message>`、`[to]`、`[from]`、SDK 尾部安全说明。

### 3. replay fail-closed

修改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts`：

- `classifyLeaselessTurnStart()` 对 `message.type==='user' && message.isReplay===true` 在检查 origin 前直接返回 null；活跃 turn 分支也不得把 replay 放入 FIFO。
- replay 只由既有 history/session hydration处理，不能获取 runtime/feature lease、显示新气泡或设置 notification hint。

### 4. `origin.kind='task-notification'`

同文件统一分类：

- `type=user`、`origin.kind='task-notification'`、`shouldQuery===false`：settle-only；若正文可解析 task id/status则调用现有 notification handler，否则仅 drop；不设 auto lease。
- 同 origin 且 `shouldQuery!==false`：开/排队一个 `source.kind='notification-continuation'` 的 auto turn，不显示 user bubble。
- system/task_notification 与 XML queue-operation 继续 settle-only并设置现有 30 秒 display hint。
- `shouldQuery` 缺失按 SDK 契约视为 query（仅显式 false 才 non-query）。

### 5. finished/save 异常必释放

修改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/AutoTurnProjectionController.ts`，为依赖增加 `notify(message)`，finished 采用：

```text
let completionError = null
try:
  写 assistantMessageId
  hide/finalize thinking/finalize text
  state.hasPendingConversationSave = true
  try save(true); catch -> completionError=error（标记保持 true）
catch finalizeError:
  completionError ??= finalizeError
finally:
  resetStreamingState（自身再隔离异常）
  active = null
  turnCoordinator.finish(turnId)
if completionError:
  notify("Background response is visible but could not be saved. It will retry on the next conversation save.")
```

- 不把错误文字写进 assistant 内容，避免污染 transcript。
- 成功保存由 `ConversationController.save()` 现有路径清 `hasPendingConversationSave`；失败保留该标记，后续正常保存、切换/关闭重试。
- finished callback不再向 runtime 抛错；无论 finalize/save/Notice 哪一步失败，feature lease均已清除，runtime随后 release并 pump。

### 6. chunk callback 异常：切换为“终态补投影 suffix”

**定案：buffered fallback，不仅提示错误。** 单纯提示会永久丢正文/工具状态；失败后继续 live 又会在终态补投时破坏顺序。

修改 core/runtime contract、`ClaudeChatRuntime.ts` 与 `AutoTurnProjectionController.ts`：

1. `RuntimeTurn` 增加 `liveProjectionFailed=false`。
2. auto chunk callback首次抛错时：置 true，把失败 chunk 放入 `turn.chunks`；之后本 turn 全部 chunk只按序进入 buffer，不再调用 live callback。
3. result settlement先 `await` 一个带 `turnId+generation+chunks` 的异步 buffered-fallback callback，再调用正常 finished。不得用无 turn identity 的旧同步 callback。
4. controller fallback 先做与 `chunk()` 相同的五重校验，再按序逐个调用 `StreamController.handleStreamChunk()`；已成功 live 的 prefix 不在 buffer 中，因此不重复。
5. fallback 本身再失败：记录警告并给用户 Notice；仍进入 finished 的 finally 清锁。无 callback provider保留原 legacy adapter，不受影响。

### 7. 实施文件

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/types.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/ChatRuntime.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/types.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/AutoTurnProjectionController.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts`
- 对应三组现有测试文件；不改部署目录。

## 风险与权衡

- FIFO依赖 SDK 的 `shouldQuery` 契约：显式 false不触发，缺失默认触发。若 SDK 违反契约，turn 只能由现有 cancel/query-close回收；不得增加超时强行 release，因为会造成跨 turn 污染。
- peer 气泡在排队晋升时显示，而非到达瞬间；这是保证“气泡=已取得独占 turn”的必要取舍。
- runtime cancel/result必须共用 promote-or-release 收尾，否则连续 peer 或人工 queued message仍可能卡死。
- buffered fallback会让失败点后的内容延迟到 result，但保证不丢、不乱序；优于继续部分实时。
- `origin.body` 是优先语义源，不是信任边界；Markdown/HTML安全仍走现有 renderer，净化函数只负责去传输封装。

## 验证方式

### 五组必补测试

1. **现场 peer 包装形状**（`ClaudianService.test.ts`）
   - 输入复刻 transcript 1574：`origin.body` + SDK prologue + cross-session/agent-message + courier headers + 尾部安全说明。
   - 断言 started 的 `displayContent` 仅为 `[msg]` 后业务正文；不含 socket、XML、to/from、安全尾注；event无完整 origin。
   - 再测缺失 `origin.body` 的 content fallback与残缺 wrapper fail-closed。

2. **连续 peer**（runtime + Tab/controller）
   - peer1无 lease开 auto；peer2/peer3在 peer1 active 时到达。
   - 断言 peer2/3不进入 peer1 chunks、不立即 started；peer1 result后只晋升 peer2，peer2 result后只晋升 peer3，started/气泡顺序为1→2→3。
   - 最终 release 后人工 queued message只 pump一次；中途 release均不 pump。

3. **用户流式中 peer**（runtime + InputController/Tab wiring）
   - 建 user runtime/feature lease，peer到达，再在 UI 点击发送形成 `queuedMessage`。
   - result测试用两个受控 Promise 验证屏障：runtime `onDone` 后、feature ack 前，peer未 started、旧 runtime lease仍在、人工消息未 pump；feature执行完 finalize/save/reset并 `finish(user)` 后调用 ack，随后才看到 peer started且 `beginAutoTurn` 成功。
   - 断言 ack Promise 返回时 peer runtime+feature lease均已建立；之后旧 `release(user)` 不 pump；peer result后人工消息才 pump一次。
   - cancel路径做同样断言：`cancel()` 后 generator被唤醒但 peer不提前 started；feature finally ack后才 release/promote。trailing result不二次晋升、不二次回执。
   - 无 pending peer对照：ack返回后无新 active feature lease，`release(user)` 正常且只 pump一次。
   - lifecycle close对照：等待ack期间关闭runtime，barrier被abort、FIFO清空、Promise结算，不开peer turn、不悬挂测试进程。

4. **save reject**（`AutoTurnProjectionController.test.ts`）
   - `save(true)` reject。
   - 断言 finished resolve、`active`失效、`TurnCoordinator.isBusy=false`、`state.isStreaming=false`、`hasPendingConversationSave=true`、Notice一次；随后 runtime release可 pump queued message一次。
   - finalize reject也至少覆盖“仍 finish、不死锁”。

5. **restart replay**（`ClaudianService.test.ts`）
   - 输入 `type=user,isReplay:true,origin.peer,shouldQuery:true`，分别在无 active turn及 active turn下发送。
   - 断言不 started、不入 pending FIFO、不显示气泡、不签 lease、不改 notification hint；随后真实 peer仍可正常开轮。

### 六项补充断言

- `origin.task-notification + shouldQuery=false` settle-only；true/undefined开或排 notification-continuation。
- chunk callback首个失败后：failed chunk和后续 chunk进入 suffix buffer，后续 live callback不再调用；result时按原序补投且 prefix不重复。
- fallback再次失败仍 finished/released。
- 全量门：`npm run typecheck && npm run lint && npm run test && npm run build`。
- 人工冒烟：前台/后台各做一次“用户长流中连发两条 peer，再手工发送”；观察三轮顺序、仅最终 pump、重载无重复。

## 关联

- [[2026-09-08-Claudian空闲期宿主tab实时投影-v5]]
- [[2026-08-23-Claudian阶段2-S4S5重设计-v3]]
- [[2026-08-23-turn-lease偶发不释放根因定位-v2]]
