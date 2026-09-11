---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - claudian
  - runtime
  - transcript
  - pragmatic
supersedes:
  - "[[2026-09-08-Claudian空闲期宿主tab实时投影-v5]]"
  - "[[2026-09-08-Claudian空闲期宿主tab实时投影-v5修复增补]]"
---

# Claudian 空闲期宿主 tab 实时投影 v6：transcript 感知（务实）

## 背景与问题

v5 把“空闲期 peer 消息触发的 turn 会从 SDK stream 输出 user/assistant/stream_event”当成前提；2026-09-09 探针证明该前提不成立，因此改由同一 session 的 transcript 增量 tail 感知并投影已落盘的块级事件，同时保留 stream 作为普通用户 turn 的唯一数据源。

## 方案设计

### 1. 实证记录

实验均在 macOS、Claude Code 2.1.227、`/Users/vincentwang/Documents/NoteVault` 下完成。

#### 1.1 v5 失败前提

用户提供的定向 peer 探针结论成立：queue 注入成功并触发 turn，stream-json stdout 只有 system/hook 事件，无 user、assistant、stream_event；对应 transcript 却有 `origin.kind='peer'` 的 user 行和完整后续对话。故“消费 stdout 即可看见 peer turn”被推翻。

#### 1.2 transcript 写入粒度与时机

另起受控 CLI 探针，固定 sessionId，要求模型先输出文本、调用 `Bash sleep 1`、再输出结束文本；以 10ms `stat` 轮询记录 JSONL 增长，并同步记录 stdout：

- user 与 queue-operation 在 turn 启动阶段即写入，不等 assistant 完成；本次 user 行在 stdout init 后约 0.1 秒被观察到。
- assistant 不是“整轮结束一次写入”，而是按**完整 content block / assistant message**落行：thinking、首段 text、tool_use 三行先落盘；约 2.1 秒后 tool_result 落盘；约 8.8 秒后最终 text 才落盘。
- transcript 不含 `stream_event` 逐 token 行。因此实时性上限是块级，不是 token 级；但首段 text、工具开始、工具结束均能在整轮结束前出现，满足“看得到在干什么”。
- 两次探针新增 JSONL 均以换行结束；一次文件 change 可包含多条完整行。仍须保留半行 buffer，因为“本次未观察到半行”不等于写入原子性契约。
- 受控探针 stdout 到 transcript 可见的附加延迟约 64–680ms；主要延迟来自 transcript flush，而非 watcher。

探针产物：`/tmp/claudian-v6-controlled-probe.json`；样本 transcript：`/Users/vincentwang/.claude/projects/-Users-vincentwang-Documents-NoteVault/80399a7a-b2ba-47a9-bbd1-7a632d9c05e6.jsonl`、`/Users/vincentwang/.claude/projects/-Users-vincentwang-Documents-NoteVault/53ee63df-158b-4d9f-9d61-64bea0100678.jsonl`。

#### 1.3 prompt 中“result 行结束 turn”的假设被推翻

上述两个完整成功 turn 的 stdout 均有 `type=result, subtype=success`，但 transcript 均为 **0 条 result 行**；当前活动 transcript `6d0b7111-...jsonl` 同样无 result。可用的持久化结束标志是顶层 assistant 的 `message.stop_reason='end_turn'`；中间 assistant 行为 `stop_reason='tool_use'`。

因此 v6 不依赖 result 行：

- `assistant.message.stop_reason='end_turn'`：transcript-owned turn 正常结束；
- `result`：若未来版本确实落盘，可作兼容性结束信号，但不是必需条件；
- 文件停止增长、`last-prompt`、queue dequeue 均不代表结束；
- crash 后没有 end marker 的 turn 保持 `interrupted/unknown`，不得伪报完成。

#### 1.4 macOS 读法与轮询节奏

同一受控探针用 Node `fs.watch` 观察 transcript：assistant/tool/result 对应 change 通知相对 stdout 约晚 87–126ms；事件会合并，不能假设“一事件一行”。

本功能优先解决“看得到”，不追求亚秒级。外来消息或后续块从产生到 UI 可见的延迟可拆为：

```text
transcript 落盘延迟 + 等待下一次轮询（0–2s）+ 增量解析/投影耗时
```

受控样本中的 transcript 落盘延迟约 64–680ms，据此推算样本内端到端额外等待约 64ms–2.68s，再加很小的本地解析/投影耗时。64–680ms 是两次探针的观测范围，不是 Claude Code 的时延契约；因此验收只硬约束“完整行已落盘后 2s 内被 observer 读取”，不把 2.68s 写成生产上界。

| 方案 | 延迟 | 系统活动/复杂度 | 裁决 |
|---|---|---|---|
| 固定 2s 自驱轮询 `stat + byte read` | 落盘后增加 0–2s；多个块可合批投影 | 空闲时每 tab 每 2s 一次 `stat`；行为确定，易测 | **首版采用** |
| 空闲 2s、turn 活跃时加快 | turn 中更新更密 | 需要额外活动状态、切速与终态恢复；块本身落盘不稳定，收益有限 | 不采用 |
| `fs.watch`（macOS 底层文件通知） | 平均更快 | 通知可合并；rename/替换后需重绑；仍须 byte cursor 与补漏扫描 | 不作权威，不纳入 v6 |
| `fs.watch` + 慢轮询兜底 | 平均更快 | 两个调度源、去重和重绑复杂度更高 | 不采用 |

**与 0825-1 sidecar 的关系：仅对齐 2s 间隔数值，各自保留独立 timer，不统一调度器。** sidecar 只在 async subagent 运行期间启动，读取 subagent sidecar 并由 `StreamController` 管终态收口；transcript observer 则在宿主 session 存续期间常开，负责发现尚未知晓的 external turn。二者生命周期、数据源、错误边界不同；共享调度器会让一方的阻塞、异常或重启影响另一方，新增耦合却没有可复用的业务状态。2s 作为共同的人机可感知刷新档位便于理解和测试，但不抽取共享常量：未来任一路径可按自身证据独立调整。

结论：固定 2s，不自适应，不引入文件通知，也不与 sidecar 合并调度。相较 100ms，空闲系统活动频率降低 20 倍；代价是 turn 内多个块可能每 2s 合批出现，属于明确接受的务实取舍。

### 2. 单一真相源

按 **turn 来源** 划分权威，不按“哪个通道先到”竞争：

| 状态/数据 | 普通用户 turn | peer/channel/coordinator turn | task-notification continuation |
|---|---|---|---|
| turn 开始与输入正文 | 既有 runtime/feature send | transcript user 行 | transcript `origin.kind=task-notification && shouldQuery!==false`；兼容 queue-operation hint 后的 assistant continuation |
| 进行中 text/thinking/tool | SDK stream | transcript assistant/user(tool_result) 行 | transcript |
| turn 结束 | SDK result | transcript assistant `stop_reason=end_turn` | transcript assistant `stop_reason=end_turn` |
| usage | SDK stream 的既有两阶段口径 | transcript 顶层 assistant `message.usage` | transcript 顶层 assistant `message.usage` |
| conversation 持久化 | `ConversationController.save()` | 同一入口 | 同一入口 |

硬规则：

1. transcript observer 只接管 **lease-less external turn**；普通 human/Claudian user 行只用于确认边界，不投影。
2. `ClaudeChatRuntime.routeMessage()` 不再用 lease-less assistant/stream_event 创建 auto turn；这类 stdout 事件只保留现有通知销账等副作用，避免与 transcript 双写。
3. task-notification 统一交 transcript 投影。旧 stream `_autoTurnBuffer`/v5 chunk callback 不再拥有该 turn；它可保留为非 Claude provider 的兼容接口，但 Claude 不得双发。
4. 对同一 transcript turn，输入、过程、结束、usage 全部来自 transcript；不使用 stdout result“补结束”。
5. SendMessage 投递黑洞不在本方案内：没有 transcript user 行就不创建 UI turn。

### 3. 最小模块边界

新增三个 provider 文件：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptTailReader.ts`
  - 只负责 `path + byteOffset + partialLine + fileIdentity`；
  - 每 tick `stat`，只读新增字节；文件缩短或 identity 变化时报告 reset；
  - 单次最多读 2MB，超量用零延迟续批；无全文件 `readFile`。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptTurnMapper.ts`
  - 纯 reducer：JSONL 行 → `AutoTurnStarted/Chunk/Finished`；
  - 复用 `classifyLeaselessTurnStart`、`extractExternalDisplayContent`、`transformSDKMessage` 及现有 tool-result 归一化；不调用全量历史的 `loadSDKSessionMessages()`。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptTurnObserver.ts`
  - 固定 2s 自驱 `setTimeout`（上次 tick 完成后再排下一次，不用 `setInterval`）；持有 reader、reducer、pending external FIFO 与 lifecycle generation；
  - 不因 turn 活跃切速，不与 `StreamController` 的 sidecar timer 共用调度器；
  - sessionId 切换、runtime cleanup、tab destroy 时停止；
  - 通过现有 provider-neutral auto-turn callback 交给 feature 层，不直接写 `ChatState`。

修改：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts`
  - session 建立后启动 observer；session 切换/关闭时停止；
  - 将分类/净化纯函数迁至 mapper 可复用位置；
  - 删除 Claude stream 对 external auto turn 的开轮、chunk、结束权威；保留普通 user turn 与通知副作用；
  - 删除 runtime `pendingExternalTurnStarts`，外部 FIFO 归 observer；
  - 保留 `completeUserTurnProjection()` 这个已接好的完成屏障接口，但语义缩窄为“普通 user feature 已清理，可由 observer 优先晋升 pending external turn”。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkHistoryTypes.ts`
  - 补齐真实 transcript 字段：`origin/isMeta/promptSource/message.id/message.stop_reason/message.usage/isSidechain`；不得用 SDK stream 类型冒充持久化格式。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/types.ts`
  - 保留现有 `AutoTurnStarted/Chunk/Finished` DTO；为事件增加 `replay?: boolean`（若实现需要）和稳定 transcript identity，不暴露原始 origin/socket。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/AutoTurnProjectionController.ts`
  - 保留并继续复用 `StreamController`、五重陈旧校验、唯一 save 入口；
  - 增加 replay reconciliation：按 external user uuid、assistant uuid、toolUseId 去重；
  - pending turn 只有真正取得 `TurnCoordinator` lease 后才建气泡。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/InputController.ts` 与 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts`
  - 保留 `finish(user) → completeUserTurnProjection → release(user)` 顺序与现有 callback 装配；不新增第二把锁。

依赖方向：

```text
transcript file
  → TailReader（字节）
  → TurnMapper（行/turn 状态）
  → TurnObserver（调度/FIFO/replay）
  → AutoTurnProjectionController
  → StreamController → ChatState/DOM
  → ConversationController.save（唯一持久化入口）
```

### 4. turn 重建规则

#### 4.1 行分类

- `user` 且 `origin.kind ∈ {peer, channel, coordinator}`、`shouldQuery !== false`：新 external turn；turnId 优先用 user `uuid`，其次 `origin.msg_id`，均缺失则 fail-closed。
- `user` 且 `origin.kind='task-notification'`：`shouldQuery===false` 只销账；否则新 notification continuation，不显示 user bubble。
- 普通 user / `isReplay=true` / sidechain：不创建 external turn。
- 顶层 `assistant`：仅归入当前 transcript-owned turn；content block 经 `transformSDKMessage` 映射。相同 `message.id + content block type/id` 或 uuid 不重复投影。
- 顶层 user `tool_result`：按 `tool_use_id` 更新当前工具；无匹配 tool_use 时建立兼容占位卡。
- `queue-operation`：只作 notification hint/诊断，不显示、不决定结束。
- `assistant.message.stop_reason='end_turn'`：完成当前 turn；`tool_use` 只表示等待工具结果。
- 若出现 `result` 行：只在当前 transcript-owned turn 尚未结束时兼容完成；不得重复 finished/usage。

#### 4.2 运行时排队与 barrier

- observer 检测 external user 时立即创建 reducer turn，但若 `TurnCoordinator` 正忙，只进入 observer FIFO，不显示。
- 当前普通 user turn 结束时，沿用已实现的 `completeUserTurnProjection(turnId)` happens-before：feature 完成 finalize/save/reset/`finish(user)` 后回执；observer 在该 Promise 返回前尝试晋升 FIFO 首项并同步取得 auto feature lease；随后旧 user `release()` 因已有 active lease而不 pump 人工 queued message。
- auto turn 完成时：最后一行 chunk 投影完成 → `finished()` finalize/save/`finish(auto)` → observer 晋升下一 external turn → `released(old)`；只有 FIFO 空时 `release(old)` 才 pump 人工 queued message。
- observer 是文件观察者，不创建 `RuntimeTurn`、不占 `MessageChannel.activeTurnId`。因此删除 v5 的 runtime external FIFO、auto chunk buffer、live projection fallback；保留的是 feature 单锁和完成顺序，不是旧数据源状态机。

#### 4.3 crash / 插件重载 replay

启动 observer 时先做有界 recovery scan：从 EOF 向前最多 4MB，找到最近一个可分类 external user 边界，重放到 EOF 生成 reducer shadow state：

- 已见 `end_turn`：仅把 EOF 设为 cursor，不重新投影；历史 hydration 是已完成 turn 的权威。
- 未见 `end_turn`：状态为 `recovering`，用稳定 ID 与已 hydrate 的 `ChatState` 对账；已有 user/assistant/tool 不重复，仅补缺项，并从 EOF 后续增量继续。
- 4MB 内找不到起点：状态为 `unknown`，从 EOF 开始；后续 assistant 行不凭空开 turn。宁可漏掉 crash 前过长 turn 的续块，也不把普通/旧 assistant 误归为新 external turn。
- 文件截断/替换：generation++，旧 callback 全失效；重新执行有界 recovery scan。原 UI 不删除，稳定 ID 防重。
- 进程 crash 且 open turn 无 end marker：final drain 后标 `interrupted/unknown`，完成投影 cleanup但不显示“已完成”。

4MB 是安全上限而非协议语义；若真实 peer turn 单轮超过窗口，应记录诊断并从 EOF 继续，不退化为全文件读取。

### 5. 保留、迁移与删除

| v5 资产 | v6 裁决 |
|---|---|
| `classifyLeaselessTurnStart` | 保留规则，输入改为真实 transcript 行；`isReplay` fail-closed不变 |
| `extractExternalDisplayContent` | 原样迁移，继续优先 `origin.body`、剥信封、残缺 fail-closed |
| `AutoTurnProjectionController` + `StreamController` | 保留；数据源改为 observer，增加 replay 幂等 |
| `TurnCoordinator`、单写入口、五重陈旧校验 | 全保留 |
| runtime `pendingExternalTurnStarts` | 删除；FIFO移到 observer |
| user completion barrier | 保留接口与 happens-before，去掉“runtime 观察到 peer”的假设，改为 observer 晋升 |
| runtime live chunk / buffered suffix fallback | Claude 路径删除；transcript byte cursor 本身就是可重读缓冲 |
| 真流式逐 token | 明确砍除；仅承诺块级实时 |
| `_autoTurnBuffer` task-notification stream 路径 | Claude 路径退出投影权威；notification bookkeeping 可保留 |

### 6. 实施步骤

#### P0：固定实证为 fixture 与红测

1. 将两个受控 transcript 复制为最小脱敏 fixture，只保留 user、assistant(text/tool_use)、user(tool_result)、assistant(end_turn)；另加真实 peer origin fixture。
2. 红测证明：同一 peer turn 在 stdout 无对话事件时，仅 transcript 仍能在 end_turn 前产出 text/tool chunks。
3. 红测证明 transcript 无 result 仍能结束；无 end_turn 的 crash 样本不得报 completed。

验收：测试不再 mock `SDKMessage stream_event` 作为 peer turn 数据源。

#### P1：byte tail reader

新增 `ClaudeTranscriptTailReader.ts` 及 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/transcript/ClaudeTranscriptTailReader.test.ts`：

- EOF prime、增量 offset、UTF-8 跨 chunk、半行、一次多行、2MB 分批；
- truncate/replace reset；stop 后无 timer/句柄；
- 以 fake timer 验证固定 2s 调度：未到 2s 不读、到点只触发一次、慢 tick 不重入；
- 79MB 稀疏 fixture 连续 100 tick 不全读。

验收：稳定 tick 只 `stat`；新增 N 字节只读取 O(N)；调度频率与 sidecar 同为 2s，但无共享 timer/调度器。

#### P2：turn mapper/reducer

新增 `ClaudeTranscriptTurnMapper.ts` 及镜像测试：

- 分类矩阵、净化矩阵直接迁移现有测试；
- text/thinking/tool_use/tool_result/usage 映射；sidechain 与普通 user 过滤；
- `tool_use → tool_result → end_turn` 生命周期；result 可有可无；
- uuid/message.id/toolUseId 幂等；notification pure/query 分流。

验收：对两个真实 probe fixture 的事件序列和终态与实证一致。

#### P3：observer 与 runtime 接线

1. sessionId 可用后 prime；先完成 recovery scan，再进入固定 2s 自驱 poll；每轮完成后才安排下一轮，避免 I/O 重入。
2. 2s 节奏在 idle 与 active external turn 期间保持不变；一次读取多行时按 transcript 顺序在同一 tick 内批量投影。
3. observer 与既有 2s sidecar 各自持有 timer；不抽公共 scheduler，也不互相启动、停止或传播错误。
4. 删掉 Claude stream 的 external auto-turn 开轮/投影；普通 user stream 不变。
5. 把 pending external FIFO 与晋升放入 observer；接入现有 completion barrier。
6. session switch、query close、tab destroy、plugin unload 全部 invalidate generation 并停止 observer。

验收：同一 auto turn 任一状态只有一个来源；代码中不存在 transcript 与 stream 对同一 turn 同时调用 auto callbacks 的路径。

#### P4：feature 投影与 replay

1. 复用 `AutoTurnProjectionController`/`StreamController`；事件从 observer 到达。
2. 增加 replay 对账和稳定 ID 去重。
3. 保留 finalize/save 异常必释放；conversation 仍只有 `save(true)` 单写。
4. 删除已失去用途的 runtime buffered suffix 测试，改为 reader 重读/offset 不前移测试。

验收：peer bubble、块级 text、工具 running/completed、usage、结束状态均在宿主 tab 更新；重载无重复。

#### P5：全量回归与真实冒烟

按 TDD 分批提交；每批跑定向测试，最后运行：

```bash
cd /Users/vincentwang/Documents/NoteVault/tools/claudian
npm run typecheck && npm run lint && npm run test && npm run build
```

现有测试迁移：

- 保留：净化、分类、replay fail-closed、`AutoTurnProjectionController`、TurnCoordinator、save reject、五重陈旧校验、普通 user barrier/FIFO、全部非 v5 回归。
- 改数据源 mock：peer/channel/coordinator/task-notification auto-turn 的 runtime stream mock，改为 JSONL append + observer tick。
- 删除/替换：`setOnAutoTurnChunk` 顺序、runtime buffered suffix、runtime external FIFO 这些只验证错误前提的测试。
- 新增：reader I/O、真实 transcript mapper、无 result 结束、recovery scan、truncate/replace、single-source 断言、固定 2s 调度与无重入断言。

## 风险与权衡

1. **块级而非 token 级**：assistant text 只有完整块落盘后可见；实测仍早于整轮结束，满足本次务实目标。逐 token 另需进程主动 IPC，本版不做。
2. **结束标志与 prompt 原假设不同**：真实 transcript 没有 result。采用 `assistant.stop_reason=end_turn`；crash 无终态时显示 interrupted/unknown，不猜完成。
3. **轮询延迟与成本**：固定 2s 将空闲 `stat` 频率降至每 tab 0.5Hz，代价是完整行落盘后最多再等 2s，turn 内多个块也可能合批显示。首版接受秒级可见性，不引入自适应切速、`fs.watch + poll` 或共享调度器；若真实冒烟证明 2s 明显妨碍使用，再凭数据单独调整，不预埋机制。
4. **recovery 回看有界**：超长单 turn 可能找不到起点；选择 fail-closed，而非扫描数 GB transcript 卡死 UI。
5. **transcript 是本地可信来源，不是可信内容**：origin/body/tool result 仍按不可信文本处理；路径只由 vault+已验证 sessionId推导，禁止任意路径输入。
6. **SDK/CLI 格式漂移**：持久化格式不是稳定公共 API。mapper 对未知行忽略并 log-once；关键字段缺失时不创建 turn。真实 fixture 纳入回归。
7. **范围外问题不被掩盖**：SendMessage 黑洞、死进程 socket/registry 残留不在 v6 修复；UI只在 transcript 实际出现 user 行后响应。
8. **迁移代价**：v5 已有约 1650 行改动；不是全删重写。保留净化、分类、controller、锁与 save 逻辑，只替换感知/归属部分。预计主要新增 3 个小模块并重写 v5 runtime 测试。

## 验证方式

### 自动测试

1. **写入粒度**：fixture 分四次追加 text、tool_use、tool_result、end_turn；每次 tick 只出现对应增量。
2. **单一来源**：向 runtime 注入同一 peer 的 system/hook/assistant 模拟事件，同时追加 transcript；最终只能有一份 user/assistant/tool。
3. **task notification**：`shouldQuery=false` 只销账；true/缺失时仅 transcript 建 turn；stream 不建第二 turn。
4. **FIFO/barrier**：普通 user turn 中追加 peer1/peer2；user finalize/save/finish 前不投影，回执后 peer1→peer2，最后才 pump 人工 queued message。
5. **结束**：无 result、有 assistant end_turn 正常完成；只有 tool_use 后 crash 标 interrupted/unknown；可选 result 不二次完成。
6. **replay**：重载时 bounded scan 重建未结束 turn；已 hydrate 的 uuid/toolUseId 不重复；旧 generation 回调失效。
7. **I/O**：半行、坏行、超大行、截断、替换、2MB 分批、79MB 文件 O(增量)读取。
8. **调度**：fake timer 下固定 2s；完整行落盘后下一 tick 读取；慢 tick 不重入；active turn 不切速；sidecar 与 observer timer 相互独立。
9. **安全**：peer 展示不含 socket、PID、msg_id、wrapper 属性；任意 sessionId/path traversal 被拒绝。

### 真实冒烟

1. 新建 Claudian tab，确认普通首条用户 turn 仍完全走 stream，逐 token 行为不退化。
2. tab 空闲时由另一 session 投递 peer 消息，要求“先说明进度→执行 5 秒工具→总结”；以 transcript 行的实际落盘时刻为起点，确认 user、首段 text/tool_use、tool_result、end_turn 各自在下一次 2s tick 内被读取。端到端首显还包含 Claude Code 自身落盘延迟，不将“发送后 2s”误作验收上界；允许同一 tick 合批显示多行。
3. 普通 user 流式中连续投递两条 peer，再手工发送一条：验证 user → peer1 → peer2 → queued user 的顺序且各一份。
4. task-notification 做 pure 与 continuation 两例，确认无 ghost lease、无双投影。
5. turn 中途重载插件：恢复后不重复已有 text/tool，后续块继续；杀死进程则显示 interrupted/unknown。
6. 对比观察前后 transcript size/mtime，确认插件只读；同时确认 SendMessage 黑洞时 UI无虚假消息。

### 人工核对点

- `rg` 确认 Claude external auto turn 只有 transcript observer 调用 auto projection callbacks。
- observer 模块无 write/append/unlink/rename，无 send/cancel/resume。
- `ConversationController.save()` 仍是唯一持久化入口；observer 不直接写 conversation。
- `MessageChannel.activeTurnId` 不承载 transcript auto turn；`TurnCoordinator` 仍是 feature 单锁。
- build 产物与源码同一工作树，部署后重做上述 peer 冒烟，不能以 5624+ 单测替代实测。

## 关联

- [[2026-09-08-Claudian空闲期宿主tab实时投影-v5]]
- [[2026-09-08-Claudian空闲期宿主tab实时投影-v5修复增补]]
- [[2026-09-08-Claudian阶段2-S4S5重设计-v4-务实]]
- [[2026-08-23-turn-lease偶发不释放根因定位-v2]]
