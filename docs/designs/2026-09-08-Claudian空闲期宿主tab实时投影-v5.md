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
  - pragmatic
supersedes: "[[2026-09-08-Claudian阶段2-S4S5重设计-v4-务实]]"
---

# Claudian 空闲期宿主 tab 实时投影 v5（务实）

## 背景与问题

Claudian 自己创建并持有的 session 在空闲期收到 peer 消息后会继续工作，但宿主 tab 要等整轮 `result` 才可能一次性显示，长轮次因此表现为“进程在干活，台前 UI 没有过程”；目标是在不引入 transcript 旁路、不重做 v3 两层状态机的前提下，让同一 tab 实时显示该轮的文本与工具活动。

## 方案设计

### 1. 断点结论：路径 A，但不是“整轮永久过滤”

**结论：SDK 输出链存在，断点在 Claudian runtime 的无租约路由与终态批量投影之间。路径 B 不成立，不启用 transcript reader。**

证据链：

1. `notevault-38` 确为 Claudian 宿主进程：PID 18058 的父进程是 `Obsidian Helper (Renderer)`，stdin/stdout 均为 Unix pipe；命令行带 `--output-format stream-json --input-format stream-json --include-partial-messages`。这不是外部 session。
2. 现场 transcript `/Users/vincentwang/.claude/projects/-Users-vincentwang-Documents-NoteVault/d8912b5b-7549-48ce-b75f-940214fd96ff.jsonl`：
   - 1571 行是 peer `queue-operation/enqueue`；
   - 1574 行是 `type=user`、`origin.kind=peer`、`promptSource=sdk`；
   - 1575 起连续出现 assistant thinking/text/tool_use，1576、1586、1590、1605、1617、1623、1630、1635、1640、1646、1666、1672 行均是该轮主 agent 输出；
   - 1571 之后未出现 `result`，说明这是一条仍未结算的长轮。
3. 当前 Agent SDK 已把该类消息纳入公开输出模型：`/Users/vincentwang/Documents/NoteVault/tools/claudian/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2598-2616,3067-3085` 中，`SDKMessage` 包含 `SDKUserMessage`，其 `origin` 明确定义 `peer/channel/task-notification/coordinator`，`shouldQuery` 表示是否触发 assistant turn。因此不能把 peer user 当成未知内部记录。
4. Claudian consumer 持续 `for await` 读取 SDK query 并逐条调用 `routeMessage()`：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts:826-847`。不是“runtime 在空闲期停止读”。
5. 第一处断点：`isAutoTurnStartMessage()` 只允许 `assistant | stream_event`（同文件 `170-180`）；无租约的 peer `user` 会在 `routeMessage()` 的白名单门被直接丢弃（`1004-1018`）。所以 UI 看不到“谁触发了这轮”。
6. 第二处、也是“长期无过程”的直接断点：后续首个 `stream_event`/`assistant` 虽会建立 auto turn（`1020-1024`），但 auto turn 没有 waiter，`deliverChunkToTurn()` 只把每个 chunk 放进 `turn.chunks`（`1174-1189`）；直到 `result` 才一次性调用 `_autoTurnCallback`（`1280-1332`）。现场该长轮尚无 `result`，所以 UI 必然一直空白。
7. 终态 callback 的 UI 也只是拼接文本后 `renderStoredMessage()`（`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts:1783-1820`），没有走 `StreamController`，因此即使最终显示，也丢失逐步工具活动的体验。
8. 现有 `StreamController` 已支持文本、thinking、tool_use、tool_result 与 usage 的逐 chunk 投影（`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/StreamController.ts:227-377`）；异步 subagent 运行中 sidecar 轮询也已落地（同文件 `116-123,146-154`，历史 commit `62a38f01`）。问题不是工具明细能力缺失，而是 auto turn 没接入这条实时投影链。

边界说明：无法在不劫持当前唯一 stdout consumer 的情况下补录 9 月 8 日现场的原始 stdout 字节；但“peer user 被白名单丢弃、后续 auto chunks 被缓存到 result”均由当前运行代码直接决定，且与 transcript 的精确事件顺序和“尚无 result”完全闭合。无需以 transcript tail 猜测 SDK 是否输出。

### 2. 触发源分类与显示策略

不要把白名单改成“所有 user 都可开 auto turn”。新增一个纯函数，对**无租约 SDK 消息**分类：

| 类型 | 判定 | 行为 |
|---|---|---|
| `external-user` | `type=user`、`origin.kind ∈ {peer, channel, coordinator}`、`shouldQuery !== false` | 合法开 auto turn；立即显示一条只读来源消息，再实时显示 assistant 活动 |
| `task-notification` | 现有 XML queue-operation 或 `system/task_notification` | 保持 settle-only，不因纯通知建租约；若后续 assistant/stream_event 到达，再按 `notification-continuation` 开 auto turn并实时显示 |
| `assistant-continuation` | 无租约 `assistant | stream_event`，且没有可归因的前置信号 | 保持可开 auto turn；显示“后台继续处理”状态，不伪造用户消息 |
| `non-query external-user` | 上述 origin 但 `shouldQuery === false` | 只作上下文记录，不建 turn、不显示运行态 |
| `session-control / bookkeeping / unknown` | init、compact、普通 queue-operation、未知类型 | 维持现有 side-effect/drop 规则，禁止建 auto turn |
| `human user without lease` | `origin` 缺失或 `kind=human` | 视为协议异常并丢弃；正常键盘输入必须已有 user turn lease |

任务通知的来源关联只需一个**短命 display hint**，不是第二把锁：收到 lease-less task-notification 后记录“下一次 assistant-first auto turn 来源可能是通知续轮”；仅用于文案/测试，不参与归属、排队和 release。若无法可靠清除该 hint，则宁可显示通用“后台继续处理”，不要引入 pending reservation。

### 3. 推荐方案：扩展既有 auto turn 为实时 chunk 投影

#### 3.1 Runtime：开轮条件修正 + 增量事件

修改：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/ChatRuntime.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/types.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/stream/transformClaudeMessage.ts`

设计：

1. 用 `classifyLeaselessTurnStart(message)` 替代只看 `message.type` 的 `isAutoTurnStartMessage()`；明确返回 trigger source，而不是散落 `if`。
2. `external-user` 可创建现有 `RuntimeTurn(kind='auto')`，`AutoTurnStartedEvent` 增加 `source` 与经过清洗的 `displayContent`；不得把 socket、完整 origin 对象或控制 XML渲染给用户。
3. 为 `ChatRuntime` 增加可选异步 `setOnAutoTurnChunk(callback)`；事件至少含 `turnId`、`generation`、`chunk`。`routeMessage()` 按 SDK 顺序 `await` 投影 callback，保证 tool_use/tool_result/text 不乱序。
4. 有实时 callback 时，auto chunk 不再进入终态批量 buffer；没有 callback 的 provider/测试仍走既有 `turn.chunks → setAutoTurnCallback` 兼容路径。不得双投影。
5. `AutoTurnFinishedEvent` 携带最终 `ChatTurnMetadata`；完成顺序保持：最后 chunk 投影完成 → feature finalize/save → runtime settle/release。不要恢复 v3 的 Promise-ack 通用事务，只为现有 auto turn callback 改成可等待的窄接口。
6. `transformSDKMessage()` 对带外部 origin 的 query user 产出一个 provider-neutral 的 trigger/boundary chunk，或由 `AutoTurnStartedEvent.displayContent` 直接承载；二选一，推荐后者，避免正常 user echo 进入通用流转换。

#### 3.2 Feature：复用 StreamController，不再另造简化 renderer

修改：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/InputController.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts`
- 必要时新增 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/AutoTurnProjectionController.ts`

推荐落法：新增窄职责 `AutoTurnProjectionController`，由 `Tab.ts` 装配，内部复用现有 `StreamController.handleStreamChunk()`：

1. `started(event)`：`TurnCoordinator.beginAutoTurn()` 已成功后，创建本轮唯一投影上下文；peer/channel/coordinator 先插入只读 user bubble（标注来源），再创建空 assistant bubble、thinking indicator 和 `TurnProjectionContext`。
2. `chunk(event)`：先校验 `turnId + generation + conversationId/lifecycle`，再 `await StreamController.handleStreamChunk()`。这会直接复用现有工具卡片、thinking、文本、usage、异步 Agent 卡片及 0825 sidecar 轮询。
3. `finished(event)`：按用户轮已有顺序 finalize thinking/text、清理流式 DOM 状态、写入 assistantMessageId、调用唯一的 `ConversationController.save(true)`；完成后才允许 `TurnCoordinator.finish(turnId)`。
4. `released(turnId)`：仍由现有 `TurnCoordinator.release()` 单点 pump queued user message。
5. `cancelled/invalidate`：只清理由该 auto turn 创建的上下文和 placeholder；调用现有 render-flush invalidation，不写新消息。
6. 删除 `Tab.ts:1783-1820` 的 `renderAutoTriggeredTurn()` 终态简化路径，或仅保留为“provider 未实现 chunk callback”的明确兼容 fallback；Claude runtime 不得同时走两条路径。

为何不直接复用 `InputController.sendMessage()`：它会创建本地用户输入、调用 `query()` 并拥有用户 turn finally，不适合 SDK 已自行启动的轮次。可复用的是其“建 bubble / finalize / save”小函数与 `StreamController`，不能伪造一次发送。

#### 3.3 单锁与单写约束

- **不改 `ClaudeMessageChannel.activeTurnId` 模型**。auto turn 仍由现有 `beginExternalTurn()` 获取 runtime lease（`ClaudeChatRuntime.ts:1191-1231`）。
- **不增加第二套 conversation 状态**。实时 chunk 只写当前 tab 的 `ChatState`，持有现有 `TurnCoordinator` auto lease时才允许投影。
- **不增加第二个保存器**。auto 完成只调用现有 `ConversationController.save()`；runtime 不写 conversation。
- **不读取 transcript**。因此没有 byte offset、半行 buffer、截断重置，也没有 runtime 与 tail reader 双写竞争。
- 用户输入在 auto turn 期间仍进入现有 `queuedMessage`，只由 `TurnCoordinator.release()` 单点泵出（`TurnCoordinator.ts:127-153`）。

### 4. usage 分阶段

#### 第一阶段：随实时 chunk 自然入账

`transformSDKMessage()` 已从主 agent assistant/stream event 产生 usage（`transformClaudeMessage.ts:388-401,447-475`），接入 `StreamController` 后会走现有 session 校验和 meter 更新（`StreamController.ts:347-369`）。先不新增 transcript usage 解析。

#### 第二阶段：仅在测试证明缺口时修

auto turn 开始时应重置 `subagentsSpawnedThisStream`，否则上一轮残留可能让 `StreamController.ts:359-362` 跳过本轮 usage。新增测试确认：

- 无 subagent 的 peer turn 更新 usage；
- 本轮有 subagent 时仍遵守“主 agent assistant usage，不拿 result 聚合 usage”的既有口径；
- task-notification settle-only 不虚增 usage。

若现有 guard 确实误杀，再局部修正；不为 usage 引入 reader。真流式协议明确砍除。

### 5. 备选方案与裁决

1. **推荐：现有 stdout/SDK 流上做 auto turn 增量投影。** 优点是数据源唯一、时序实时、复用完整工具渲染、改动集中；代价是需把 auto callback 从“终态批量”扩成窄的异步生命周期。
2. **仅给白名单加 `user`，保留终态 callback。** 能显示触发来源/运行色，但长轮仍要等 `result` 才看到工作内容，未满足首要目标，不采用。
3. **transcript byte-tail reader。** 可绕过 SDK，但同一宿主 tab 会同时拥有 stdout 与 transcript 两条数据源，必须去重、处理延迟/半行/截断，容易形成双写竞争；只有实测证明 SDK 没输出 chunks 时才启用。本次证据已否定该前提，不采用。v4 中 reader 构件仅保留为历史备案。

### 6. 实施步骤与逐步验收

#### 步骤 0：冻结基线与补失败测试

- 在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/ClaudianService.test.ts` 加现场形状：lease-less `user(origin.peer, shouldQuery≠false)` → assistant/stream_event → tool_use/result → result。
- 在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/Tab.test.ts` 或新增 controller 测试，先断言当前实现“result 前没有消息/工具 UI”，形成红测。

验收：红测失败原因必须分别命中“peer user 被 guard 丢弃”和“auto chunks 只在 result flush”，不能靠 mock 人为制造其他失败。

#### 步骤 1：修正无租约触发分类

- 实现分类纯函数与 external-user 开轮。
- 保持普通 queue-operation、`shouldQuery=false`、human user、纯 task-notification 不开轮。

验收：新增分类矩阵全过；原有 ghost guard、首条消息、纯通知无租约测试（现位于 `ClaudianService.test.ts:3952-4133`）全部不改语义。

#### 步骤 2：增加可等待的 auto chunk 接口

- 扩展 runtime contract/types；Claude auto turn 按序 await chunk callback。
- 无 callback 时保留终态 buffer fallback；有 callback 时断言终态不重复投影。

验收：在 `result` 发送前，测试已依次收到 text/tool_use/tool_result；callback 延迟时后续 chunk 不越过；result 后只完成一次。

#### 步骤 3：接入宿主 tab 实时投影

- 新增 `AutoTurnProjectionController` 并在 `Tab.ts` 装配；复用 `StreamController`。
- peer/channel/coordinator 显示来源 user bubble；assistant-first 显示通用后台活动；纯 task-notification 只更新原 subagent 卡片，若有 continuation 再显示 assistant。
- 终态 finalize、保存、finish、release 严格单次。

验收：result 前文本逐段出现、工具卡片出现并更新；完成后 conversation 中只有一份 user/assistant/tool 数据；切换会话或关闭 tab 后旧 callback 不写新会话。

#### 步骤 4：usage 与工具明细回归

- auto start 重置本轮 subagent 计数；验证 usage 路径。
- 慢速 async Agent 至少执行 3 个工具，确认父 Agent 卡片创建后，0825 sidecar 轮询在运行中逐条补工具明细，而非完成后一起出现。

验收：peer 长轮在未结束时可见主 agent 文本、Agent/TaskOutput 等工具活动；usage 至少在 assistant usage 到达时更新。若 usage 单测暴露独立口径问题，单独提交第二阶段，不阻塞“看得到”。

#### 步骤 5：复核、冒烟、干净构建与打包

1. implementer 按 TDD 实施，禁止修改 `/Users/vincentwang/Documents/NoteVault/.obsidian/plugins/claudian/` 中已部署 bundle。
2. reviewer 独立复核：重点检查 ghost lease 回归、chunk 顺序、双投影、跨会话陈旧写入、保存单写者。
3. 全量门禁：
   ```bash
   cd /Users/vincentwang/Documents/NoteVault/tools/claudian
   npm run typecheck && npm run lint && npm run test && npm run build
   ```
4. 冒烟 A（新会话首条消息）：新建 Claudian tab，发送首条普通用户消息；确认立即显示用户 bubble、实时文本/工具、完成后可继续发送，重载历史无重复。
5. 冒烟 B（peer）：让另一 session 向该**空闲且台前** tab 的 sessionId 发送含“先输出一句进度、再执行一个可观察工具、再输出完成”的消息；确认 peer user bubble 立即出现，result 前进度和工具卡片实时出现，完成后仅一份记录，下一条手工输入正常。
6. 冒烟 C（task-notification）：启动后台任务并让通知触发续轮；纯通知不得闪烁 ghost running；发生续轮时第一条 assistant/tool chunk 即出现，结束后锁释放。
7. 仅在源码测试、review、冒烟均通过后，从同一已验证源码树执行一次 production build；核对 `main.js`、`styles.css`、`manifest.json` 均来自该次构建，再整体替换 `/Users/vincentwang/Documents/NoteVault/.obsidian/plugins/claudian/` 对应三文件。禁止“旧 main.js + 新 styles.css”或手补 bundle 的混合构建。

## 风险与权衡

- **最大风险是把所有 `user` 放进白名单，重现幽灵租约。** 必须按 `origin + shouldQuery` 精确分类；未知来源 fail-closed。
- **异步投影会对 consumer 施加背压。** 这是有意的：保证显示顺序和完成前 finalize；现有 DOM 渲染已有 animation-frame 合并。若实测吞吐受影响，只优化 renderer，不改成 fire-and-forget。
- **task-notification 有“纯通知”和“通知后续轮”两种。** 纯通知绝不能开 auto lease；显示来源 hint 不能参与锁归属。
- **StreamController 有全局 current DOM 状态。** 本方案成立的前提是现有 `TurnCoordinator` 单锁继续覆盖 user/auto 两类 turn；任何绕过 coordinator 的投影均应被 reviewer 拒绝。
- **历史现场缺少 stdout 原始字节留档。** 不影响本次代码断点闭环；若实施测试无法从 SDK mock/真实 peer 得到 `SDKUserMessage.origin=peer`，停止实施并重新评估路径 B，不可硬接 transcript reader。
- **v4 已作废。** 其“外部 Sessions 观察 tab”主线不实施；byte-tail reader 只在未来证实 SDK 流缺失时作为备选重新立项。v3 保持 superseded，不恢复两层 reservation/attributed lease、六道门、通用投影事务或真流式协议。

## 验证方式

### 自动测试

- Runtime：external-user 分类矩阵；peer user 开轮；`shouldQuery=false` 不开轮；queue-operation/unknown 不开轮；纯 task-notification 不开轮；通知续轮开轮；chunk 顺序与 await；终态不重复；取消释放。
- Feature：peer 来源 bubble；result 前 text/tool 卡片可见；async subagent 明细运行中刷新；usage；finalize/save 一次；conversation switch/tab destroy 丢弃陈旧回调；queued user 仅 pump 一次。
- 回归重点：`ClaudianService.test.ts:3952-4133` 的 system control、task notification、ghost guard、assistant continuation；`Tab.test.ts:1472-1608` 的 auto render/lifecycle 测试需从终态批量语义迁移到实时语义。

### 人工核对点

- 看到的是当前宿主 tab，不是新建 observer tab。
- peer 消息文本不暴露 socket/control XML；来源标签能区分 peer 与普通用户输入。
- 长轮未结束时持续看到文本和工具活动；不要求展示模型私有 thinking 内容。
- 纯通知不会让 tab 永久绿色/红色；结束后输入不排队卡死。
- Obsidian 重载后历史不重复、不缺最后一轮。
- 部署目录三个产物来自同一次 clean production build。

## 关联

- [[2026-09-08-Claudian阶段2-S4S5重设计-v4-务实]]
- [[2026-08-23-Claudian阶段2-S4S5重设计-v3]]
- [[2026-08-23-turn-lease偶发不释放根因定位-v2]]
- [[2026-08-23-Claudian-subagent工具明细不显示根因与修复]]
- [[2026-08-25-async-subagent工具详情展开状态保留]]
