---
type: design-decision
status: proposed
target: /Users/vincentwang/Documents/NoteVault/tools/claudian/
tags: [architect, claudian, history, resource-budget, dom-windowing]
---

# 背景与问题

Claudian 已有预算窗口与 `ProjectionWriteCoordinator`，但完整历史消费者、Claude 小/大会话双轨和持续累积的 DOM 仍突破端到端资源边界；本方案首版以 `hotfix/notify-lease@1583ab57` 为实证基线，v2 复核修订时仓库为 `hotfix/notify-lease@d773605f`。[v3 修订] 终审修订基线为 `hotfix/notify-lease@ddafd3ba`，其中 A0a 已由 `b047650c` 完成并部署 2.1.2。派单所写 `5372b4ac` 是旧祖先，不能按旧 HEAD 设计。

# 方案设计

## 1. 总体决策与交付顺序

### 1.1 方案选择

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| 保留双轨、只补大文件 | 小会话继续全量 hydrate，大会话分页 | 小会话最快、改动少 | 两套状态机、异常语义与测试永久并存；B3 只能覆盖一轨 | 否决 |
| 单轨索引 + 小会话直接全量读特例 | 所有 Claude 都建索引，小文件首屏另走旧 reader | 可保 12ms 读取基线 | “直接读”仍是第二物化路径，后续 detail/页缓存/完整性继续分叉 | 不推荐 |
| **单轨索引 + 自适应窗口（推荐）** | 所有 Claude 经 `acquireHistoryIndex + loadWindow`；小会话窗口自然覆盖全部 turns | 一套契约、一套完整性语义；小会话是一般路径退化 | 冷开多约一次索引成本，需缓存与性能门 | **采用** |

### 1.2 顺序

[v3 修订] 正式集成顺序为 **A0a（已完成）→ A0b（已完成：commit 9536151e，2026-09-16 部署 2.1.3，reviewer 已复核放行）→ A1 → A2 → B → C**：

1. **A0a：rewind hotfix** 已于 2026-09-16 以 `b047650c` 独立完成并部署 2.1.2；后续 A 批只验证其仍被包含，不重复实现。
2. **A0b：usage snapshot hotfix** 是下一个可独立部署、独立回滚的批次，先消除线上 context gauge 双计。
3. **A1：iterator、导出、amnesia** 封闭全历史与恢复路径的无界入口。
4. **A2：detail、search、`loadRange` 清理、LRU** 收口 UI 精确读取与缓存契约。
5. **B** 消灭 Claude 双轨，令所有 Claude tab 都有 page/range/lease 语义；这是 C 的必要前提。
6. **C** 只管理已加载数据的 DOM 驻留，不改变 provider 读取语义。

A1 与 A2 共同修改 `core/providers/types.ts`、`ClaudeConversationHistoryService.ts` 和 `ConversationController.ts`，必须串行合并：先合 A1 契约，再将 A2 rebase 到该契约。A0b 只触及 usage stream 聚合与对应测试，可先独立发布。A 与 B 不并行合并：B 会删除 A 所依赖的 oversize/loadActive 分支，冲突不仅是机械冲突。

### 1.3 共同不变量

1. transcript 是唯一事实源；index、page、DOM、spacer 均可丢弃重建。
2. UI 只调用 `loadWindow` 或精确 detail API；`loadRange` 从公开 lease 契约删除。
3. “完整”表示未做 summary 的原始可见投影，不表示无限对象可同时驻留。
4. 导出可遍历全部历史，但消费方必须逐块写出；禁止返回 `ChatMessage[]` 或完整字符串。
5. 模型恢复受模型 context 硬上限约束：使用完整投影的**有界连续后缀**，不得假称注入全部无限历史。
6. 所有 `messagesEl` 结构变更，包括页摘除、spacer 替换、页重建，都必须取得 `stored` 租约；live turn 期间不得执行。
7. 小会话与大会话只允许预算参数不同，不允许 reader、错误语义或生命周期分叉。

## 2. 批次 A：B4 预算收口

### 2.1 完整历史迭代契约

#### 契约

修改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts`：

```ts
interface FullHistoryIterationOptions {
  maxTurnsPerChunk: number;
  maxSourceBytesPerChunk: number;
  maxProjectedCharsPerChunk: number;
  projectionLevel: 'detail';
  signal?: AbortSignal;
}

interface FullHistoryChunk {
  messages: ChatMessage[];
  range: LoadedTurnRange;
  sourceBytes: number;
  done: boolean;
}

type FullHistoryIterable = AsyncIterable<FullHistoryChunk>;
```

`ProviderConversationHistoryService.iterateFullHistory(conversation, vaultPath, options)` 返回固定 snapshot 上的 oldest-first async iterable。实现内部持有一个 lease，每次用 planner 选下一段并 materialize detail；iterator `return/throw/abort` 必须释放 lease。chunk 同时受 turn、source bytes、投影字符三重上限；单 turn 超限时不得 summary，返回结构化 `HistoryEntryTooLargeError`。生产者不预取，chunk 单所有者，sink 不得留存已消费 chunk。[v2 修订：补投影后内存边界。]

[v4 修订] oldest-first 顺序语义直接采用已落地的 displayOrder（ChatMessage 只读排序键 `[segmentOrdinal, entryOrdinal, projectionOrdinal]`，波次 1 commit `0a1d9ec9` + `14c69202`，2.3.0 已部署）；iterator 与物化/搜索/窗口共用同一键，不再依赖 timestamp 概念。

删除公开 `HistoryIndexLease.loadRange`。如 provider 内部仍需按范围物化，保留为 `ClaudeConversationHistoryService` 私有方法，避免 UI 再绕过 policy。

#### 两类消费方

1. **完整文本导出**：增加 provider-neutral `consumeHistoryText(iterable, WritableLike)`，逐消息格式化、逐块写文件；任意时刻只驻留“一个 chunk + writer buffer”。文件导出使用流式 writer。Clipboard API 不支持流式写入，设置独立硬上限（建议 4 MiB，真机校准）；预估或实际超限即提示改用文件导出，禁止先拼完整字符串或以临时文件冒充流式剪贴板。[v2 修订]
2. **SDK amnesia rebuild**：`ChatRuntime.setFullHistoryExporter` 改为 `setHistoryRecoverySource(() => FullHistoryIterable)`；`ClaudeChatRuntime` 通过新增 `HistoryContextAccumulator` 消费 detail chunk。累计达到恢复预算后丢弃最旧完整 turn，保留 newest contiguous suffix，并加入明确的 `[Earlier history omitted: context recovery budget]` 标记。预算以模型 context token 上限换算的保守字符上限计算，并为 system prompt、当前 prompt、工具 schema 与输出留余量；首版采用现有 token/context 估算能力，不新增 tokenizer 依赖。

[v3 修订：恢复确认与熔断] `SessionManager` 将布尔 `needsHistoryRebuild` 升级为 recovery state：`idle | pending{generation, lostSessionId, attempts} | awaiting_result{generation, dispatchSessionId, attempts} | tripped{generation, reason}`。`session_init` 只负责检测非 fork 的 session id 跳变并创建/推进 generation，**不再作为恢复成功确认信号**；持久 query 可能不再产生下一次 init。恢复后缀注入并成功 dispatch 时，记录该请求的 `dispatchSessionId` 与 session 快照，进入 `awaiting_result`。仅当同一 generation 收到成功 `result` 事件，且 result 所属 session id 与 `dispatchSessionId` 相等、当前 session 快照自 dispatch 后未再次跳变，才 `confirmRecovery → idle`。失败 result、query 中断或快照变化均不得清状态：仍有预算则回到 `pending`，每个 generation 最多注入 2 次；超限进入 `tripped`，后续 turn 停止自动注入。

[v3 修订] `tripped` 必须有 UI 可见、原子化的手动重置入口 `retryHistoryRecovery(generation)`：仅当传入 generation 与当前熔断 generation 匹配时建立新 generation 并回到 `pending`，旧 UI/旧异步任务不得重置新状态。提示明确给出两条恢复路径：“新建会话”或“手动重试恢复”。显式切换到新会话、reset、fork 也建立新 generation 并清旧熔断；普通 `session_init` 不得隐式清除 `tripped`。

这解决了两个不同问题：导出遍历全部历史且流式落地；模型恢复不可能容纳无限历史，因此只注入未摘要、未拆断 turn 的有界后缀。`buildContextFromHistory(ChatMessage[])` 保留给普通小数组调用；新增 `HistoryContextAccumulator.appendChunk()`，禁止 amnesia 再调用旧全量函数。

#### [v4.1 补遗 2026-09-16] 导出入口、writer 与格式

实证：生产代码中 `exportFullHistory` 只有 `TabManager.ts:408-412` 一处调用，且用途是给 runtime 做 amnesia 恢复；现有命令只覆盖 open/new tab/new session 等，`TabBar` 右键仅 move/close；会话列表已在 `ConversationController.ts:1264-1382` 提供按 `conversationId` 定位的右键菜单。故推荐在**会话列表项右键菜单**增加“导出完整会话到文件”“复制完整会话文本”，它能导出未打开会话且目标无歧义。命令面板只能操作 active tab，可作为后续快捷入口；tab 右键空间窄且当前只对 `canClose` tab 注册，不作为首版入口。

文件默认写入 vault 内 `.claudian/exports/<安全化标题>-<本地时间>.md`，重名递增后缀；完成后 Notice 显示 vault 相对路径。首版不弹路径选择器：仓库没有 `FallbackSuggester`/通用 save-file 组件，唯一文件系统选择模式是 `InputToolbar.ts:705-738` 的 Electron `showOpenDialog` 目录选择器，移动端不可复用。若后续要自选位置，另建跨平台 vault-path suggester，不把 Electron API带入本批。

在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts` 增加 provider-neutral `WritableLike`（`write(text): Promise<void>`，可选 `close/abort`）；`consumeHistoryText` 每格式化一条即 `await writer.write`，保留背压。Obsidian 装配留在 feature/app 层：`adapter.write(partialPath, '')` 建临时文件，writer 的每次 `write` 顺序调用 `adapter.append(partialPath, text)`，成功后 rename，失败/abort 删除 partial。`obsidian.d.ts` 的 `DataAdapter` 明确提供 `write`、`append`、`appendBinary`；仓库现有 storage 只用全量 `write`，故不能复用其全量 buffer，但可复用 `VaultFileAdapter` 的目录创建/路径规范化方式。这里的“流式”是 bounded chunk 顺序 append，不承诺底层 OS stream handle。

导出文本不另创格式：从 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/utils/session.ts` 的 `buildContextFromHistory` 抽出单消息 formatter，保持现有 `User/Assistant`、current-note、thinking 摘要与 tool 状态格式；数组函数、iterator 文件导出和 draft 导出共用它。剪贴板硬上限固定为 **4 MiB UTF-8**：先用 index/page 的 `projectedChars` 做保守预估闸（明显超限直接拒绝），再在逐条格式化时以 `TextEncoder` 累计实际 UTF-8 bytes；实际值一旦超过立即停止、释放 iterator 且不调用 `navigator.clipboard.writeText`。仅双闸都通过才允许拼接这个有界字符串。新增 TranslationKey 覆盖入口、成功/失败、`chat.history.export.clipboardTooLarge`（文案：“会话超过 4 MiB，无法复制到剪贴板。请改用‘导出完整会话到文件’。”）与 source unavailable；十个 locale 同步补键，不留英文直写。

#### [v4.1 补遗 2026-09-16] draft 导出契约

实证：现实现 `vaultPath` 为空即复制 `conversation.messages`，而 §3.1 已确定 Claude 的 `conversation.messages` 以后不再代表完整视图；新建未落盘消息的事实只在当前 tab `ChatState.messages`。因此 `iterateFullHistory` 只表示 transcript snapshot：无法解析 vault/session/transcript 时抛结构化 `HistorySourceUnavailableError`（含 `reason: 'vault_unavailable' | 'session_unavailable' | 'transcript_unavailable'`），绝不回退数组。

显式 draft export 在 feature 层分流，不进入 iterator：仅当用户对**当前 tab**执行导出、provider history service 确认不存在 transcript 身份，且该 tab 的 `ChatState.messages` 非空时，允许以 `source: 'draft'` 将该小数组一次性送入同一单消息 formatter。只要 conversation 有 transcript 身份，即使文件暂时不可读也必须报 source unavailable，禁止拿当前 materialized window 冒充完整历史。这与 §3.3 的 “`exportFullHistory` fallback” 一致：该旧方法不再承担 fallback；首版文件/剪贴板入口显式选择 `transcript` 或满足上述判定的 `draft`。

#### [v4.1 补遗 2026-09-16] recovery 状态暴露与动作接线

实证：共享 `ChatRuntime` 已有 `onReadyStateChange(listener) → disposer` 的 provider-neutral订阅模式，feature 的 `setupServiceCallbacks`/tab cleanup 已负责装配与解绑；`onStreamingChanged`/`onTurnCompleted` 则是 runtime→tab 的回调接缝。采用同类订阅而非让 feature 读取 Claude `SessionManager`：在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/ChatRuntime.ts` 增加可选 `onHistoryRecoveryStateChange(listener)`、`retryHistoryRecovery(generation)`，事件仅暴露中性 `{status: 'idle'|'recovering'|'tripped', generation, reason?}`。Claude runtime 把 `SessionManager` 状态映射后同步首发并在每次迁移通知；其他 provider 不实现。

提示使用 messages viewport 与 input 之间的**持久可交互 recovery banner/card**，不写入 `ChatMessage`、不伪装系统消息。原因：Notice 虽可接 `DocumentFragment`，但仓库实际用法均是短暂通知且无动作生命周期；`InlineAskUserQuestion`/`InlinePlanApproval` 已证明 inline card + 按钮/键盘交互模式可行，但二者是一锤子 promise，不直接复用类，只复用视觉和销毁模式。banner 只在当前 generation 为 `tripped` 时存在，包含 i18n 文案和两个按钮：

- “新建会话”调用既有 `TabManager.createNewConversation()`；成功切换后由 runtime/session reset 建新 generation，banner 随 `idle` 事件销毁。
- “重试恢复”调用当前 tab runtime 的 `retryHistoryRecovery(capturedGeneration)`；返回 false 表示 stale generation，保持/刷新当前状态而不误清新熔断；返回 true 后显示 `recovering`，防重复点击。

切 tab、runtime cleanup 必须取消订阅并销毁旧 banner；新 runtime 装配时订阅会同步发当前状态，故后台发生的 tripped 不丢失。新增 TranslationKey：标题、原因、两动作、stale/重试失败；不得把 provider 错误字符串直接作为 UI 文案。

#### [v4.1 补遗 2026-09-16] `setFullHistoryExporter` 过渡

全仓实证确认生产唯一调用方是 `TabManager.ts:408-412`（另有对应单测），A1 同批将其改装为 `setHistoryRecoverySource(() => historyService.iterateFullHistory(...))`。`ChatRuntime.setFullHistoryExporter` 与 Claude 实现标 `@deprecated` 保留一个发布版：内部仅登记 legacy source，并适配为单 chunk iterable；新 source 优先，二者都存在时不得双读。它只保障外部/旧测试装配不崩，不再有生产调用，也不用于用户导出；下一批按 grep 零调用删除。回归测试锁定旧 setter 仍可装配、TabManager 只调用新 setter、runtime 恢复只消费一个 source。

[v4 修订] A1 范围新增并入残项：统一 hydrate 段序与 index 侧段序口径——`ClaudeConversationHistoryService.ts:456-461` 按文件链下标保留 missing-session 空洞，而 `:606-621` 段压缩在中间 session 文件缺失时两路径会对同一消息赋不同段序；统一口径后补多段缺失场景测试（来源：1c 复核复验留档）。

改动文件：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/ChatRuntime.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/utils/session.ts`
- 新增 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/HistoryContextAccumulator.ts`

### 2.2 rewind/fork 精确 detail

不复用 `loadWindow(... detail)`：其单位是 turn，会把无关 assistant/tool 载荷带入内存。给 lease 增加 `loadMessageDetail(projectionKey, { maxSourceBytes, signal })`，返回 `exact | not_found | too_large` 与一条完整 `ChatMessage`。索引需维护 `projectionKey → turn/entry descriptor`；读取后复用既有 SDK→Chat 映射，但只返回目标可见消息。

[v4 修订] `loadMessageDetail` 除 rewind/fork 预填外，同时承担搜索候选验证与目标消息替换/挂载（③ 方案修订已定边界：禁止 detail 候选配 summary 定位）；A2 实施 `loadSearchCandidate` 迁移以此为准。

流程：

1. 用户点击 rewind/fork 时，先从当前消息判断 `projectionLevel`；summary 或未知一律按 key 拉 detail。
2. detail 成功后才弹确认并执行破坏性 rewind；失败或超限则明确提示并中止，绝不把摘要写入输入框。
3. rewind 输入框使用 exact `displayContent ?? content`。
4. fork 的 provider 分支事实仍由 `sourceSessionId + resumeAt` 表达；不得把当前窗口 `msgs.slice(...)` 当完整历史。fork metadata 中的 `messages` 只作为有界首屏视图，目标 tab 随后按统一索引重建；被点击 user message的 exact 内容用于预填/标题计数。

单条消息仍需硬边界。首版 detail `maxSourceBytes=16 MiB`；超过则拒绝预填，不提供截断 rewind。该选择比把几十 MiB 文本塞进 textarea 更可控，也保持“执行即精确”。

**[v3 修订] 前置修复 A0a：rewind 的 lazy-runtime 契约缺陷——已完成。** 真机发现（2026-09-15）：paged 会话未发言 tab 点“回退到此处”报“回退失败： No active query”。定位结论：`ConversationController.ts:879` 直接调 `runtime.rewind()` 未初始化 runtime，`ClaudeChatRuntime.ts:2493` 因 `persistentQuery === null` 抛错；且 `ClaudianService.test.ts:3445-3449` 固化了该错误行为。**非 5cb8799d..HEAD 新回归**（5cb8799d 的 rewind 代码与当前相同，缺陷源自 lazy runtime 引入时），系 B1 使超大会话从 OVERSIZE_BLOCKED 变为可交互后首次暴露；普通小会话未发言 tab 同样触发，非 paged 特有。修法已以 commit `b047650c` 于 2026-09-16 独立 hotfix 完成并部署 2.1.2：`ClaudeChatRuntime.rewind()` 自行确保 persistent query 就绪，UI 层不承担 provider 生命周期。A 批实施时只验证该提交及回归测试被包含，不重复开发。

改动文件（rewind 前置修复部分）：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/ClaudianService.test.ts`

**[v3 修订] 前置修复 A0b（下一个可独立部署 hotfix）：usage 聚合跨请求双计。**〔已于 2026-09-16 独立完成：commit 9536151e，部署 2.1.3，request-boundary 快照状态机 + meta usage.model 记实际解析模型；reviewer 复核可放行，4 条低危备注留档（测试名不副实/中途切模型 label 陈旧/id 缺失降级/瞬态陈旧发射）。〕真机发现：context gauge 曾显示 1016k/1000k（>100%）。取证结论：同一 turn 内请求 A 为 cache miss（input 496652 + cacheRead 22272 ≈ 519k），下一请求 B 为 cache hit（input 598 + cacheRead 518912 ≈ 520k）；`transformClaudeMessage.ts` 的 `mergePromptUsage`（约 :253-267）跨请求**按字段各取最大值**（`Math.max(current.inputTokens, next.inputTokens)` 等）拼出 496652+518912≈1016k——把 miss 请求的未缓存输入与 hit 请求的 cache_read **双计**，真实上下文 ≈522k。

[v3 修订] 修法不是简单“取最后一条”，而是 **request-boundary 快照状态机**：以 SDK 主 agent 消息流的请求边界划分快照，`assistant` 开启/更新该请求的 input 侧 usage，匹配的 `result` 关闭该请求并提供权威窗口信息；每个请求边界都以该请求的**完整 usage 对象整体替换**当前请求快照，禁止跨请求逐字段 `max`、累加或拼接。空/全零片段不得覆盖同一请求已建立的非空快照；`parent_tool_use_id` 非空的 subagent assistant/result 全部过滤，不得推进主 agent 状态机。turn 最终仍按两阶段合并：assistant 快照提供 input/cache 侧计数，匹配 result 提供权威 `contextWindow`；这保留原设计动机（见 `providers/claude/CLAUDE.md`），只消除跨请求双计。〔订正 [用户裁决 2026-09-17]：result 的 `contextWindow` 对**分母**降级为不采信（2.3.2 ②分母单线化——模型选择器 preset 为唯一分母源，未配置 200k），`selectContextWindowEntry` 解析链已删除；result 仅保留**分子**（token 计数）取数与请求闭合语义，request-boundary 快照状态机本身不变。〕

[v3 修订] 模型字段继续保留 `50214f22` 的 turn model 快照；`fc882a63` 捕获的 resolved model 只与同请求的 result 匹配并持久化，禁止较晚/较早请求串配。红测至少覆盖 miss→hit、hit→miss、多 assistant 分段、全零片段、subagent 插流、result 缺失/乱序；最终 `contextTokens` 应等于最后一个已闭合主 agent 请求的完整 input+cacheRead 快照（示例约 520k），而非字段 max 拼接（约 1016k）。

改动文件（usage 聚合修复部分）：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/stream/transformClaudeMessage.ts`（mergePromptUsage / UsageState）
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/stream/`（对应红测）

改动文件：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeTranscriptHistoryIndex.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts`

### 2.3 删除 legacy UI `loadRange`

源码实证：Codex 的 `CodexConversationHistoryService` 没有 `acquireHistoryIndex`，因而不会产生 `state.historyLease`，不会进入 `loadLegacyFirstScreen` 或 `loadOlderHistory` 的 lease fallback。当前 lease 只来自 Claude，而 Claude 同时实现 `loadWindow`。因此：

- 将 `HistoryIndexLease.loadWindow/planWindow` 改为必选；
- 删除 `loadLegacyFirstScreen`、`nextOlderRange`、`loadRange` 及搜索候选的裸 `loadRange`；
- `loadSearchCandidate` 改用 `loadMessageDetail`；定位仍用 `loadWindow(around)`；
- Codex 继续走自己的完整 hydration，完全不绑定 lease。

### 2.4 around 与 LRU 收口

- **around**：当前 `HistoryWindowPlanner.ts` 已交替向 older/newer 扩展，修复已在基线中。A 不重复改算法，只增加不对称 byte fixture，锁定“anchor 必在结果且尽量居中”；materializer 必须按 plan 的 `[start,end)` 正序处理，不得 newest-first 再把 anchor 一侧裁掉。若字符预算导致缩窗，按距 anchor 从远到近剔除，不能只丢 older 端。
- **LRU**：禁止驱逐受保护项。将 `MAX_COMPLETED_INDEXES=2` 改为双门槛加权 LRU（建议初始 `8 snapshots / 128 MiB index metadata`）；只驱逐 idle、非 in-flight、非 protected 项。全部受保护时允许临时超预算并记 `cache_overcommit`，待 release 后立即收缩。驱逐最旧受保护项会使活跃 lease 对应缓存失真并导致反复重建，否决。

### 2.5 红测与验收

红测：

1. 1.59 GB / 1000 turn iterator：每块均受 turn/byte 上限，顺序无重漏，中途 abort/throw 只 release 一次。
2. 导出 sink 故意慢写：生产者受 backpressure，不预取后续块，RSS 不随总历史线性增长。
3. [v3 修订] amnesia 超过 context 预算：只保留完整 newest suffix、当前 prompt 不重复、出现 omission 标记；任何 chunk 都不是 summary。注入后仅“成功 `result` + result session id 等于 dispatch 快照 + 当前 session 快照未跳变”可确认；失败/跳变最多重试 2 次后进入 `tripped`，后续 turn 不再注入；旧 generation 手动重置被拒，新建会话、匹配 generation 的手动重试、fork/reset 可开启新 generation。
4. summary user rewind：先取 exact detail；detail 失败/16 MiB 超限时不执行 rewind、不改输入框。
5. fork 不再把当前 `state.messages` 视为完整前缀。
6. Codex history load 不调用 index/window；删除 legacy fallback 后原测试仍绿。
7. around 在两侧 turn 大小不对称、字符预算二次缩窗时 anchor 不丢且偏移可解释。
8. 3–10 个 protected index 超上限时无 protected eviction；释放后自动收缩。

验收：全历史导出字节/消息序列与旧 loader 在小 fixture 上完全一致；1.59 GB 导出与 amnesia 无 `loadRange(0,total)`、无全量数组/字符串；amnesia 最终 prompt 不超过恢复预算；UI 源码中不存在 lease 裸 `loadRange` 调用。

### 2.6 独立部署与回滚

[v3 修订] A 按 A0b→A1→A2 分批独立部署；A0a 已部署且后续只做包含性验证。A0b 可单独回滚；A1/A2 合并后共同构成 B 的前置 A 基线。兼容期 `setFullHistoryExporter` 可保留一个版本但 Claude runtime 不再调用；下一批删除。回滚不会改变 transcript/meta。若 iterator 出错，显式终止导出或 amnesia 恢复，不回退全量物化。全链路仍仅允许 C→B→A2→A1→A0b 逆序回滚；A0a 作为已发布 hotfix 不随 B4 批次回退。

## 3. 批次 B：Claude 双轨统一

### [v4.2 补遗 2026-09-18] capability 注入边界、旧测试迁移与实施顺序

本补遗只闭合 §3 已定语义的可实施性，不改变 capability 分流、metadata 化、防双开、读者清单及 Codex/OpenCode 边界。

#### 决定 1：以 controller deps 注入“可用服务”，不在 controller 直查全局 registry

现状实证：`ConversationControllerDeps` 已用 `getAgentService`、`getTitleGenerationService`、`ensureServiceForConversation` 等 getter 注入运行时依赖；生产装配集中在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts`。反例是 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/TabManager.test.ts`：文件顶层 `jest.mock('@/core/providers/ProviderRegistry')` 返回共享 `historyService` 外形，而 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/controllers/ConversationController.test.ts` 又在模块级注册 Claude service 并于多例中 spy registry。把新分流直接绑定该 singleton，会使一个用例添加的 `acquireHistoryIndex` 改变其他用例路径。

采用选项 ① 的窄化形式：在 `ConversationControllerDeps` 增加显式 `getHistoryIndexCapableService(conversation): ProviderConversationHistoryService | null`。返回值必须是 controller 随后实际 `acquireHistoryIndex` 的同一 service，不注入布尔值，避免“探针判定”和“再次查 registry”取得不同对象。`loadActive`、`switchTo` 的 Claude 单轨入口及 lease refresh/bind 共用该 getter；无 capability 返回 `null`，继续现有 provider hydration。`Tab.ts` 是唯一生产适配点：内部从 `ProviderRegistry.getConversationHistoryService(conversation.providerId)` 取 service，并按 `typeof service.acquireHistoryIndex === 'function'` 窄化。controller 不新增 `ProviderRegistry` 查询，也不接收 TabManager claim；各 controller 单测在 `createMockDeps` 内显式给 `null`，仅索引语义用例给独立 service stub，TabManager 的 real-controller harness 同样局部注入。

| 选项 | 改动面 | 测试迁移 | 隔离性 | 结论 |
|---|---:|---:|---|---|
| ① deps 注入 capability service | controller 接口、`Tab.ts`、两个 fixture | 低；普通用例默认 `null`，索引用例逐例 stub | 强；无模块全局状态 | **采用** |
| ② registry mock 改 `jest.isolateModules`/重做 factory | 多个测试文件及 import 顺序 | 高；需重构顶层 hoisted mock，类型与运行实例易分裂 | 中；仍围绕 singleton 清理 | 否决 |
| ③ registry 直查，仅把判定包成可注入函数 | controller 仍有隐式 service 获取 | 中；判定可隔离但实际调用仍可串扰 | 弱；存在双来源/TOCTOU | 否决 |

边界：该 getter 是 history capability 端口，不是 providerId 特判，也不把 registry 或 TabManager 下沉进 controller。以后新增 index provider 只改注册对象；测试不需要 `resetModules`。其他与本次分流无关的 registry 使用可留待对应读者迁移，不借此做全 controller 服务定位重构。

#### 决定 2：旧双轨测试按“语义保留”而非按失败逐个打补丁

| 分类 | 测试文件/套件 | 处置 |
|---|---|---|
| **a. 改写为单轨语义** | `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/controllers/ConversationController.test.ts` 的 `paged history` 首屏、lease takeover、ready/loadWindow 失败、generation 失效、progress，以及 `loadActive`/`switchTo` 成功恢复 | 统一由 deps stub 返回 index service；断言 `get metadata shell → acquire → await ready → loadWindow → bind lease → restore ChatState → render drain → READY`。小/大会话只改变 planner 结果，不再制造 oversize 异常。保留 paging/search/lease release/stale transaction 测试。 |
| **a. 改写为单轨语义** | `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/TabManager.test.ts` 的 “materializes an oversize restored tab…” 与 “fails to index” real-controller harness | 改名为 indexed restored tab；`getConversationById` 返回 metadata shell，局部 capability stub 提供 lease。成功断言 page 仅进入 `ChatState`、`conversation.messages` 保持空；失败仍进入通用可重试 `ERROR`。 |
| **a. 迁移测试归属** | `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/main.test.ts` 的 `loadSdkMessagesForConversation - fork branch` 与 Claude subagent recovery 全套 | 不再经 `plugin.getConversationById` 验证全量 hydrate。fork session/truncate、displayOrder、subagent 富化等仍是有效业务语义，迁到 Claude index/materializer、`loadMessageDetail`、providerState sidecar 的定向测试；不得因删除旧入口而丢覆盖。 |
| **a. 更新边界断言** | `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/core/providers/ProviderRegistry.test.ts` | Claude service 不再断言 `hydrateConversationHistory`；改断言 `acquireHistoryIndex`。Codex/OpenCode 的 hydration contract 由各自 service 测试覆盖。 |
| **b. 删除** | `ConversationController.test.ts` 中 catch oversize 才进入分页、`switchToHydrationShell`、oversize shell release；`TabManager.test.ts` 中 `OVERSIZE_BLOCKED` placeholder、blocked-shell hook、READY paged warmup catch workaround | 被测对象正是待删除的异常双轨、shell 状态和补偿分支；不改写成同义 mock。通用 `SHELL/SCHEDULED/LOADING/ERROR/READY` 生命周期、输入禁用、stale cleanup 继续保留。 |
| **b. 删除** | `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/history/ClaudeConversationHistoryService.test.ts` 中 “returns oversize… ”、hydrate canonical merge、hydrate failure retry/缓存，以及 `hydratedConversationIds` 相关断言 | 这些只证明 Claude 全量 hydration/大小阈值/已 hydrate 缓存；窗口内 oversized-turn summary、index build retry、displayOrder、iterator 超限仍是单轨能力，保留原测试。 |
| **c. 保留不动** | `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/codex/history/CodexConversationHistoryService.test.ts` 全套；OpenCode 对应 hydration/搜索 fallback；`ConversationController.test.ts` 的 lease-less loaded-message 搜索 | §3.4 明确无 index provider 继续 hydration；不得批量替换 fixture 或断言。 |

迁移顺序固定为：**先加 deps 默认 stub 与 per-test capability fixture，使现有套件隔离且仍绿；再在同一“核心单轨”提交内删除/改写旧契约测试与生产分流；最后迁移 integration 中仍有效的 Claude 富化语义。** 不先批量删失败测试，否则无法区分预期契约变化与真实回归。预计直接触及 5 个主测试文件、约 25–30 个测试；其中约 10 个旧 oversize/hydration 断言删除，约 8–10 个改写，约 11 个 integration 富化场景迁移归属。最终数量以实施时 `rg` 和 Jest 列表为准，不把估算当验收值。

#### 决定 3：B 批提交与回归闸门重排

1. **B0 注入缝（独立提交，语义不变）**：增加 `getHistoryIndexCapableService` deps、`Tab.ts` 适配与局部 fixture；移除 controller 新路径对 registry mock 的依赖。跑 controller、Tab、TabManager、ProviderRegistry 定向测试，再跑全量 `typecheck + lint + test`。
2. **B1 单轨核心 + 契约测试（同一提交）**：`getConversationById/switchConversation` 对 index-capable provider 只取 metadata shell；Claude 删除 `hydrateConversationHistory`/`hydratedConversationIds`/oversize result；`loadActive/switchTo` 统一 `acquire → ready → loadWindow → bind → restore`。同步执行上表 a/b，避免生产与测试任一提交处于互相不兼容状态。定向跑 controller、Claude history、TabManager、integration main；再跑全量四门 `typecheck + lint + test + build`。
3. **B2 §3.1.1 防双开**：实现 token/CAS registry、恢复去重及入口收口；测试并发 switch、跨 view restore、stale token release。全量四门。
4. **B3 §3.3 读者清理与 metadata 化**：逐项迁移 save/passive sync/providerState/title/export/preview/图片清理；将 integration 中仍有效的 fork/subagent 富化语义落到 index/materializer/sidecar。每迁一类先跑对应定向套件；清单完成后以 `rg` 验证 Claude 路径无 `conversation.messages` 历史读、无 `hydrateConversationHistory`/`OVERSIZE_BLOCKED`/`hydratedConversationIds`，再跑全量四门。
5. **B4 §3.2 性能保护**：仅在语义和读者均收口后做 1 KB、2.9 MB、63/65 MB、1.59 GB 同轨基准与缓存优化；不以恢复旧 reader 过门。跑全量四门及 30 次冷/热开性能门。

提交纪律：B0 可独立回退；B1 起必须依序回退 B4→B3→B2→B1，B1 不拆成“先删测试/后改实现”。每一步全量回归除绿灯外，还要核对 Codex/OpenCode 测试文件无 diff；若其测试失败，只修共享契约兼容，不改其 hydration 预期。

### 3.1 语义重定义

Claude 的 `hydrateConversationHistory` 不再读 transcript。推荐从 Claude service 接口移除该实现，`getConversationById` 对 Claude 仅返回 metadata/in-memory shell；`ConversationHistoryHydrationError` 继续保留给 Codex/Opencode 的真实 hydration error，不再包含 `oversize` 分支。若类型收敛后所有 provider 都不需要该异常，再单独删除，不能在共享层假设 Codex 行为。

`ConversationController.loadActive` 改为 capability 分流而非异常分流：

- service 有 `acquireHistoryIndex`：唯一执行 `acquire → ready → loadWindow → bind lease → restore`；
- 无 index 能力：调用现有 `getConversationById`/provider hydration（Codex、Opencode）。

这不是 Claude 大小双轨，而是 provider capability 边界。

`hydratedConversationIds` 从 Claude service 删除。[v2 修订：Claude 的共享 `Conversation` 不再承载窗口视图。]

- `conversation.messages`：对 Claude 只允许两种值：新建/未落 transcript 的短暂 draft 尾部，或空数组；绝不回写索引窗口。持久化事实仍是 transcript；metadata 另存 `hasHistory/messageCount/preview/firstUserExcerpt` 等派生字段，不能由窗口推断。Codex/Opencode 暂保现有完整 hydration 语义。
- `ChatState.messages`：唯一 per-tab materialized view，含当前 tab 已加载 page + live page；B3 前可随翻页增长，B3 后由 page store 派生可驻留视图。
- `loadedRanges`：固定 index snapshot 上已物化范围；不得据其判断 transcript 完整性。
- `historyLease`：所有已恢复 Claude tab 必有；Codex 无。
- runtime passive sync 改为 `syncConversationState(conversationMetadata, externalContextPaths)`，只消费 session/providerState/context metadata，不读 `messages`；发送历史显式来自当前 tab `ChatState`，amnesia 显式来自 recovery source。

### 3.1.1 双开可达性与防线 [v2 修订]

正常 UI 不可达双开：`TabManager.openConversation` 先查本 view，再经 `findConversationAcrossViews` 跳转另一 view。但这是入口级、非提交级不变量，现状仍有三类绕过：

1. **[v3 修订] 并发窗口 a：可达。** `openConversation` 检查后才调用异步 `switchTo`，而 `tab.conversationId` 在 `ensureServiceForConversation/onConversationIdChanged` 成功后回写；两个 tab 可同时通过检查。增加 plugin 级 `ConversationOpenRegistry`：registry 值固定为 `{ownerToken, conversationId}`，`reserve(conversationId)` 原子生成并返回不可复用的 `ownerToken`；异步 `switchTo` 全程携带该 token，提交前以 token 做 CAS claim，失败则取消本 tab restore 并聚焦当前 owner。`release(conversationId, ownerToken)` 必须同时匹配 conversationId 与 token；不匹配表示过期任务，拒绝释放且记录诊断，防止旧 restore/switch 任务释放后来建立的新 owner。失败、切离、close 只能释放自身 token，最终 owner 以提交点 CAS 为准。
2. **恢复绕过 b：可达。** `restoreState` 逐项直调 `createTab`，不经过 `openConversation`；同一快照内重复 id、多个 view 同时恢复、历史脏快照均可双开。恢复前按 `conversationId` 稳定去重（保留 activeTabId 指向项，否则保留首项），每个候选仍走全局 reserve；被拒项恢复为空白 tab 或跳过并记录诊断。持久化前也去重，防脏状态再生。
3. **直调绕过 c：受限但存在。** 生产调用仅见 `openConversation`、`forkInCurrentTab`，以及 `InputController` 在未注入 `openConversation` 时的 fallback；后者当前装配已注入但测试/未来装配可绕过。将 `switchTo` 变为 TabManager 私有提交入口（或强制注入 `claimConversation` capability），删除 InputController fallback；fork 也统一走该入口。`plugin.switchConversation` 仅做数据加载，不承担唯一性。

防线后，双开按产品路径严格不可达；per-tab view 仍不可省，因为即使单 tab，窗口回写 `conversation.messages` 也会污染 save、passive sync、providerState/subagent 持久化、标题与导出语义。

### 3.2 小会话性能保护

不设 `<64 MB` reader 分支。采用同一路径的自适应首屏预算：

- `maxTurns = 200`、`maxSourceBytes = 8 MiB`、`maxProjectedChars = 2 Mi chars`；
- 若 planner 判定全会话满足预算，首屏窗口自然为 `[0,total)`，用户体验等价全量；否则分页；
- 2.9 MB 会话预计冷开由约 `12ms 读取 + 30ms 渲染` 上升到“索引扫描约 0.2s + 窗口物化/渲染”。这是统一语义的明确代价，验收门设为冷开首条可见 p95 ≤300ms、完整可交互 p95 ≤500ms；缓存重开 p95 ≤100ms/≤200ms。数值须以同机 30 次基线确认，不达标不以恢复旧 reader 解决。

保护手段按优先级：

1. snapshot-key completed index 命中；
2. 同一 index 扫描中同时保留预算内尾页 entry descriptor，避免第二次遍历，不复制正文；
3. 首屏允许在 index ready 后一次 `loadWindow` 覆盖全会话；
4. 仅若真机仍不达标，再设计持久化 index cache；不引入“直接全量读”第二轨。

### 3.3 `conversation.messages` 读者审计与清理项 [v2 修订]

Claude 相关直接读者已逐项核对：

| 读者 | 当前用途 | 窗口语义是否正确 | 修订 |
|---|---|---|---|
| `ConversationController.restoreConversation` / `hydrateTab` | 复制到 tab state | 否；共享窗口会串 tab | [v3 修订] 方法签名显式接收 `HistoryWindowPage`（或 page descriptor）并写目标 `ChatState`；禁止先赋给 `Conversation.messages` 再读取过桥 |
| `ConversationController.save` → `updateConversation` | 保存当前状态 | 否；会把窗口冒充历史 | [v3 修订] `save` 显式接收当前 tab page/materialized view 与 metadata，但 Claude 持久层只保存 metadata/providerState；新建 draft 另走显式 `pendingMessages`，不得读写 `Conversation.messages` 过桥 |
| `initializeTabService`、`ensureServiceForConversation`、TabManager passive sync/warmup、环境重启 | 判断有无历史并同步 runtime | 否；窗口为空不等于空会话 | 读取 metadata `hasHistory`；runtime 只同步 session/provider/context metadata |
| `ClaudeConversationHistoryService.buildPersistedProviderState` | 从消息提取 subagentData | 否；窗口会丢旧记录 | providerState sidecar 增量维护；保存时不扫描窗口 |
| `hydrateConversationHistory` merge | 全量 hydrate | B 后删除 | Claude 不再读取/写入 `conversation.messages` |
| `exportFullHistory` fallback | 无 vault 时复制 messages | 否 | 无 transcript 时仅允许显式 draft export；否则报 source unavailable；实现位置订正为 `ClaudeConversationHistoryService.ts:823-833` |
| `main.ts` preview/list、`findEmptyConversation`、image 清理 | 列表摘要/空判断/清内存图片 | 否 | 改读持久化 metadata；图片清理由 per-tab state/runtime 生命周期负责 |
| title regeneration | 首条 + 最近消息 | 否 | history service 新增有界 `loadTitleMaterial`：精确首个 user + newest user suffix，不全量 hydrate |
| rewind/fork | 当前数组定位/复制 | 仅已加载 detail 时部分正确 | 依 §2.2 使用 exact detail + provider checkpoint；不把窗口当完整前缀 |
| provider 发送路径 | 当前 turn 上下文 | 正确但必须显式 | `InputController` 传 `ChatState.messages`；amnesia 不复用它 |

Codex/Opencode 的 `conversation.messages` 读写保持现状；共享 API 以 capability 分流，不用 `providerId` 硬编码。

清理文件：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts`：Claude `getConversationById` 只返回 metadata shell；新增/持久化 `hasHistory/messageCount/preview/firstUserExcerpt`，`findEmptyConversation` 与图片清理不再依赖 Claude messages。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts`：删除 catch-oversize、`paged`、后置预热；首次/switch 统一 `loadIndexedConversation`，结果只写当前 `ChatState`；save 不回写 Claude 窗口；title 改 `loadTitleMaterial`。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts`、`Tab.ts`：删除 `OVERSIZE_BLOCKED` 与 warmup catch；passive sync、初始化、环境重启改读 metadata + 当前 tab context；加入全局 reserve/claim 与恢复去重。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/InputController.ts`：删除直调 `conversationController.switchTo` fallback，所有 resume 统一经 TabManager。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkSessionPaths.ts`：删除生产 `MAX_LEGACY_SESSION_BYTES`。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts`：删除 `hydratedConversationIds`/全量 hydrate；新增 title material/draft export；providerState 不再扫描窗口。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts`、`core/types/chat.ts`、`core/bootstrap/SessionStorage.ts`：metadata、title material、index capability 契约；`oversize` 从共享 hydration result 删除。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/state/ChatState.ts`、`state/types.ts`：明确 per-tab materialized view；命令目录、retry、保存路径同步删除 oversize 特判。

### 3.4 Codex 边界

Codex 不实现 index/window，不改 `CodexConversationHistoryService`。共享改动必须验证：

1. Codex 冷开仍只调用 `hydrateConversationHistory`，不调用 Claude index API；
2. `MessageRenderer` 对 Codex contentBlocks/toolCalls/plan approval 无变化；
3. Codex fork 的内存前缀语义保持现状，A 的 Claude detail/fork 调整按 capability 生效，不做 providerId if；
4. `ConversationHistoryHydrationError(error)` 若 Codex 使用则仍能进入通用 ERROR/retry，而非 oversize shell；
5. send/stream/provider boundary 继续受既有 `ProjectionWriteCoordinator` 保护。
6. [v4 修订] 无 historyLease 的搜索 fallback（1c 引入，读 `state.messages` 生成候选）在 `loadActive` capability 分流重写后仍工作，Codex/OpenCode 搜索不回归。

### 3.5 红测与验收

红测：

1. 1 KB、2.9 MB、63 MB、65 MB、1.59 GB Claude fixture 的调用序列均为 `acquire → ready → loadWindow`，不存在 size threshold 分叉。
2. Claude `getConversationById` 不读 transcript、不抛 oversize；`loadActive/switchTo` 无 catch-oversize。
3. 小会话 planner 覆盖全 range；超过预算只显示窗口且 `historyHasMore=true`。
4. index/load/render 任一步失败均 release 恰好一次并进入可重试 ERROR；无 partial view 冒充 ready。
5. [v3 修订] 正常 open、两 tab 并发 switch、单/跨 view 脏快照恢复、fork/resume 直达均只能提交一个 owner；构造旧任务延迟 release、新任务已 reserve 的交错，旧 `ownerToken` 释放必须被拒且新 owner 保持。
6. [v3 修订] warmup、命令目录、环境重启、runtime 初始化、save/providerState/title/export 不依赖 `conversation.messages`；`save/restore/hydrateTab` 的 page 参数显式可见，Claude 窗口只存在于目标 tab `ChatState`。
7. Codex 全套 hydration/fork/stream/plan tests 不变绿。

验收：Claude 源码中无 `MAX_LEGACY_SESSION_BYTES`、`oversize` UI 分支和 `hydratedConversationIds`；四档会话行为单轨；2.9 MB 达上述 p95 门槛；1.59 GB index 期间 UI 可交互，index 后 2 秒内首屏可读。

### 3.6 独立部署与回滚

B 依赖 A，可独立部署。metadata 新字段必须向后兼容；回滚到 A 产物可忽略它们，旧进程只会重新 hydrate。若 C 已部署，须先回滚 C，禁止单独回滚 B。部署诊断必须记录 `provider/path/indexHit/indexMs/windowMs/renderMs`，以便确认小会话退化来自索引、物化还是 DOM。

## 4. 批次 C：B3 页面级 DOM 窗口化

### 4.1 页面模型

新增 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/history/HistoryPageStore.ts`：

```ts
interface HistoryPageRecord {
  pageKey: string;
  range: LoadedTurnRange;
  messages: ChatMessage[] | null;
  projectedWeight: number;
  measuredHeight: number | null;
  renderState: 'mounted' | 'spacer' | 'evicted';
  uiState: Map<string, MessageUiState>;
  lastAccess: number;
  pins: Set<'visible' | 'adjacent' | 'live' | 'search' | 'transaction'>;
}
```

数据层与 DOM 层正交：

- `loadedRanges` 继续表示当前 snapshot 曾加载范围；翻页 API 不变；
- page store 保存每次 `HistoryWindowPage`，相邻/重叠 range 可合并描述，但 `pageKey` 保持稳定；
- DOM 只挂载可见页 ± 邻接页，并受 `maxMountedTurns=200` 硬上限；
- page data 用加权 LRU（建议 12 页/32 MiB projected weight）；淘汰只清 `messages`，保留 range、height、UI state descriptor，回访再由 lease 重物化；
- live page 永久位于尾部并 pin，结束后可冻结为普通 page。不得把 streaming DOM 摘除。

新增 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/rendering/HistoryWindowRenderer.ts`，`MessageRenderer` 保留单消息具体渲染，前者只负责 page 容器、spacer、挂载/摘除和锚点校正。

### 4.2 与写协议的时序

页替换是 `stored` 事务，因为它会移除节点并改变 `messagesEl` 结构。规则：

1. scroll/IntersectionObserver 回调只采样位置并发出 intent，不同步测量/重排。
2. 以单个 `requestAnimationFrame` 合并同帧 intent；下一帧通过 `ProjectionWriteCoordinator.runStored` 排队。
3. **[v3 修订] 引入 page-scoped render ticket。** 每页维护单调递增 `renderTicket`；页首次挂载、重建或 generation 变化时创建新 ticket。该页所有 `renderMessageContent` 调用在发起前登记 ticket slot，包含初始分帧、lazy expand 触发的重渲染、图片/异步内容接线；每个 promise 在成功、失败或取消时核销自己的 slot。新渲染若发生在 ticket 尚未核销前继续登记同一 ticket；若发生在核销后，先递增 ticket 并把页面重新标为 unsettled。旧 ticket 的完成回调不得核销新 ticket。只有“当前 ticket 已封闭且 outstanding=0”才发出 page settled 信号；不再依赖现有 fire-and-forget 的 `onMessageContentRendered` 通知推断完成。
4. 获得租约后复验 conversation id、DOM epoch、page generation、当前 render ticket、目标 page、anchor 仍挂载与 scroll direction；过期 intent 丢弃。
5. [v3 修订] 摘除前等待**当前 page render ticket 核销**；spacer 精确测高只允许发生在核销之后。默认超时 3 秒（真机校准）。超时不得伪造 settled：允许按当前 `getBoundingClientRect().height` 摘除，但只记录 `heightQuality='estimated'`、超时 ticket 与诊断；该 spacer 首次回到邻接区时必须重挂，创建/等待新 ticket 核销，再按 anchor 差值纠正并升级为 measured。事务内记录稳定 anchor，原位替换 spacer；缺页仍先在租约外物化。
6. mutation 后在同一帧校正 `scrollTop`；异步 Markdown 稳定后再做一次按 anchor 的差值修正。
7. live lease 持有时 stored intent 排队；若用户持续滚动，只保留每个方向最新 intent，避免响应结束后回放大量陈旧窗口操作。
8. 不允许持有 stored 租约等待网络/索引长 I/O：缺页时先在租约外物化并 pin `transaction`，完成后再申请 stored 做 DOM commit；commit 前再次 stale 校验。

### 4.3 spacer 高度

- [v3 修订] 每页必须有独立 wrapper；`ResizeObserver` 只观察 mounted page wrapper。`HistoryPageRecord` 增加 `renderGeneration/renderTicket/settledTicket/heightQuality: 'measured'|'estimated'`；高度观测值须携带产生它的 ticket，不再保留可与 ticket 脱节的布尔 `contentSettled`。
- [v3 修订] 仅当 `settledTicket === renderTicket` 且该 ticket 已封闭、outstanding=0 时，当前 `getBoundingClientRect().height` 才可写为精确 measured；ticket 未核销、已过期或超时的值只能写 estimated。estimated 不得覆盖同宽度 measured 值；新 lazy render 创建 ticket 后，旧 measured 可作占位但立即标 stale，直到新 ticket 核销后重测。
- 容器宽度、字体族/字号、主题切换导致所有 height cache 失效。简化策略：`ResizeObserver(messages viewport)` 检测宽度变化，加 `document.fonts.ready/loadingdone` 与主题 class 变化监听；统一标记 stale，不立即全量重建。
- stale spacer 回到邻接区时先按旧高度占位，重建后以 anchor 差值校正并写新高度。禁止尺寸变化时一次性重建所有页。
- 图片/异步内容在 mounted 状态由 page observer 修正；摘除时冻结最终观测值。

### 4.4 UI 状态、锚点与搜索

- 展开态从 DOM 私有状态提升为 `MessageUiState`，key=`messageId + blockId`，至少覆盖 thinking/tool/subagent/大文本 detail；renderer 创建节点时读状态，交互时写状态。
- 当前搜索状态保存 `{projectionKey, matchedText, matchOrdinal}`，不保存 `<mark>` 节点。页重建并完成 message content 后重新枚举并高亮。
- 滚动锚点始终使用稳定 `data-message-id`；若锚点所在页被数据 LRU 淘汰，先重物化并 pin，DOM commit 后恢复 offset。
- 搜索定位页使用 `search` pin，定位完成且离开视口后解除。找不到 projection 仍显式 `projection_mismatch`。
- page 摘除时必须清理 `MessageRenderer.liveMessageEls`、tool DOM maps 等易失引用；domain/page UI state 保留。该清理与 DOM epoch 校验共同防止写入脱离节点。
- [v4 修订] 1b 引入的 message-level 工具栏 `syncMessageActions`/`syncLiveMessageActions` 幂等入口需在 page 挂载/摘除/重建时接线；`messages.css` 中 assistant `bottom:0` 特例保留至占位验收（延续 ④ 方案约定）。

### 4.5 启用阈值

只在 `loaded turn > 250` 或估算 mounted projected weight > 16 MiB 时启用摘除；低于阈值仅建立 page wrapper，不创建 spacer，小会话永不触发。启用后目标软窗口 150–180 turns，硬上限 200；当前可见页若单页本身超过硬上限，以该页作为唯一例外并记录 `dom_overcommit`，不得拆 turn。

阈值是首版安全基线，须用 20 页真机数据校准；不暴露用户设置。

### 4.6 改动文件

新增：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/history/HistoryPageStore.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/rendering/HistoryWindowRenderer.ts`

修改：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts`：page descriptor/weight 必要字段
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/state/types.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/state/ChatState.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/rendering/MessageRenderer.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/rendering/ToolCallRenderer.ts` 及 thinking/subagent 展开态接线
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/rendering/ProjectionWriteCoordinator.ts`：只增加 intent 取消/诊断，不改变 P1–P7
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts`：装配、dispose observer
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/style/components/messages.css`：page/spacer

### 4.7 红测与验收

红测：

1. 20 页连续向上加载后 mounted turns ≤200；小会话 ≤250 turns 从不产生 spacer。
2. scroll 回调内无同步 DOM mutation；同帧 20 次事件只提交一次 intent。
3. live turn 中触边：页替换不执行；release 后仅最新 intent 执行，DOM/ChatState 顺序一致。
4. 缺页重物化不持有 stored 租约；切会话后完成结果不 commit。
5. [v3 修订] 分帧、Markdown、lazy expand 或图片 render slot 未核销时摘除会等待当前 page ticket；3 秒超时后仅允许 estimated spacer 并记录 ticket 诊断，迟到的旧 ticket 不得升级高度；回访创建的新 ticket 核销后才升级 measured。上下往返锚点误差 ≤1 可见行且无累计漂移。
6. 宽度、字体、主题变化使缓存 stale；回访校正而非全量同步重建。
7. tool/thinking/subagent/detail 展开态往返保持；被 data LRU 淘汰后重物化仍恢复。
8. 搜索命中 mounted、spacer、data-evicted 三类页均可定位并恢复高亮；解除 pin 后可淘汰。
9. page LRU ≤32 MiB/12 页（固定页单列）；所有页 pinned 时允许可诊断 overcommit，不驱逐可见/live/search 页。
10. Codex 因无 page store 默认保持旧渲染；共享 MessageRenderer 单消息行为不变。

验收：1.59 GB 会话浏览 20 页后 DOM turn 稳定在硬上限附近，page data 可回落；滚动、输入、切 tab 无 p95 ≥50ms Long Task；反复上下 10 次无内容丢失、重复、展开态丢失或搜索高亮漂移。

### 4.8 独立部署与回滚

C 依赖 B，可独立部署。以 feature flag（内部常量，默认开）保留一版关闭能力：关闭时 page store 仍记录数据但不摘 DOM，便于现场归因；稳定一版后删除 flag。回滚到 B 产物只失去窗口化，不影响 transcript、meta、index 或 page 重建能力。[v3 修订] 交付纪律：批次只允许按 **C→B→A2→A1→A0b** 逆序回滚；A0a 是已独立部署的 2.1.2 hotfix，不纳入 B4 逆序回滚。不得在保留依赖方时独立回滚底层批次；每批回滚包须声明前置版本并由脚本/清单阻断非法组合。

## 5. 总测试门与部署节奏

每批先提交红测，再实现；定向绿测后执行：

```bash
cd /Users/vincentwang/Documents/NoteVault/tools/claudian
npm run typecheck && npm run lint && npm run test && npm run build
```

隔离 vault 使用 1 KB、2.9 MB、71.6 MB、91.3 MB、1.59 GB 脱敏 fixture；每档记录 index hit/miss、index/window/render 时长、实际 read bytes、heap/RSS、DOM turns、page/index cache weight、Long Task。A/B/C 各产出独立构建与上一版回滚包，不跨批夹带。

# 风险与权衡

1. **小会话冷开变慢**：单轨必付索引约 0.2s；接受该成本换取唯一语义，以缓存和单次扫描复用保护，不恢复第二 reader。
2. **“完整历史”与有限 context 冲突**：导出可完整流式遍历；模型 prompt 不可能无限，必须明确采用 exact-detail newest suffix。若产品要求模型读取全部 1.59 GB，只能改为检索/摘要体系，已超本批范围。
3. **单消息 detail**：精确预填可能本身巨大；16 MiB 上限时拒绝 rewind，而非静默截断或打爆 textarea。该阈值需真机校准。
4. **B3 时序复杂**：scroll、异步 Markdown、live streaming、搜索都可能改变高度或 DOM。以“intent 与 commit 分离、commit 必须 stored、I/O 不持锁、anchor 二次校正”降低组合态；不引入第三方逐项虚拟列表。
5. **全 pinned 超预算**：index/page cache 都选择可诊断 overcommit，不驱逐活跃正确性所需对象。资源压力时可提示关闭 tab，但不能暗中让活跃页反复重建。
6. **双开防线**：现有入口检查覆盖正常操作，但并发提交与恢复曾可绕过；全局 reserve/commit guard 与恢复去重后将其降为防御性风险。即便双开不可达，per-tab view 仍是必须项，因为共享 `conversation.messages` 的单 tab 读者也要求持久化语义干净。
7. **当前工作树已有未跟踪设计文档**：本方案不改动它们；实施前应以当前 `hotfix/notify-lease` 实施起点冻结基线，避免误按旧提交回退写协议补修。

迁移/落地代价：无持久化数据迁移，但 B 会重定义 Claude hydration 与 `conversation.messages`，C 会把 flat state 演进为 page store；测试与装配改动较大。代价不改变单轨与资源硬边界的目标。

## 明确不做

- **B2 后台/分块物化**：用户已裁定不做；现有分帧渲染与预算窗口保留。若真机仍有 materialization Long Task，另案重启，不混入收官批。
- **持久化 index cache**：仅当 B 的小会话或 1.59 GB 重开性能门不达标时另案设计。
- **全历史 FTS/搜索 sidecar 重构**：现有搜索已可用，本批只保证跨页定位与高亮。
- **subagentData 持久化瘦身、巨型附件/base64 清理、复制按钮完整 detail、第三方虚拟列表**：均属全景审查其他残留或产品扩展，不是本三批闭环所必需；仅确保新路径不复制放大它们。
- **Codex 单轨索引化**：其事实源和 history service 独立；本批只做共享层不回归。

# 验证方式

除各批红测与验收外，最终做三组交叉回归：

1. **正确性**：小 fixture 完整翻页/完整导出的 message id、正文、tool 状态、branch 顺序与旧 loader 对拍；rewind/fork 使用 exact user 内容。
2. **并发**：初始分帧、live turn、向上翻页、搜索定位、DOM 摘除、切 tab 组合执行，验证 P1–P7、stale guard 与 lease release。
3. **资源**：1.59 GB 导出、amnesia、20 页往返分别观察 RSS/heap/DOM；总历史增长不得使单次 iterator chunk、amnesia prompt、mounted DOM 或 page cache 线性增长。
4. **双开与语义**：并发触发两个 tab `switchTo`、构造同 view/跨 view 重复恢复快照、调用所有 resume/fork 入口；断言仅一 owner，且 Claude `Conversation.messages` 从未接收窗口页。对读者清单逐项设测试，窗口变化不改变 metadata、title material、providerState、export、runtime session sync。
5. **[v3 修订] 恢复与渲染屏障**：模拟注入后持久 query 不再发 `session_init`，仅成功 `result` 且 session/dispatch 快照一致时确认；失败、跳变与两次重试后熔断，校验手动重置 generation CAS。模拟 B1 分帧、延迟 Markdown、lazy expand 与旧 ticket 迟到，断言当前 ticket 核销前不测为精确高度、超时为 estimated、仅新 ticket 核销后升级 measured。
6. **[v3 修订] 导出与回滚**：剪贴板边界内成功、超限明确引导文件导出；发布包演练 C→B→A2→A1→A0b 成功，跳过依赖层或回滚 A0a 被阻断。

# 关联

- [[2026-09-09-claudian超大会话历史加载机制与分页方案]]
- [[2026-09-15-claudian超大会话物化与渲染资源预算修复方案]]
- [[2026-09-15-claudian超大会话修复全景回归审查]]
- [[2026-09-15-claudian流式分帧互斥与锚点投影硬上限补修]]

## 复核记录（architect-xhigh，2026-09-15）

### 硬伤清单

- **阻断｜§3.1/3.5**：B 把 `conversation.messages` 定义为当前可见视图，但它是共享 `Conversation` 对象；双 tab 同会话会互相覆盖窗口，且 passive sync 读取该共享值。改为 per-tab view，`Conversation` 只存 metadata；否则 B、C 必须原子交付。
- **阻断｜§2.1**：amnesia 只留后缀却无恢复确认、重试上限和降级态；现代码在注入后即清 `needsHistoryRebuild`（`ClaudeChatRuntime.ts:1751-1757`），SDK 再换 session 会逐轮重复。增加 recovery generation、成功确认、单次/总次数熔断；失败明确中止，不循环注入。
- **高｜§2.1**：chunk 仅限 source bytes/turn，未限制投影后 `ChatMessage`、tool/subagent 富化与格式化缓冲；补 `maxProjectedChars`、单块单所有者、无预取，并禁止 sink 留存 chunk。文件可流写；Clipboard API 不能流写，须设硬上限或只复制导出文件路径，不能声称临时文件即可流式复制。
- **高｜§3.3**：删除 hydration 异常未闭合调用方。除 warmup 外，`regenerateTitle`、周期标题回调、`initializeTabService`、switch 等仍调 `getConversationById`；标题还依赖“首条+最近消息”，窗口不保证含首条。逐调用点改 metadata API、精确首条/尾部窗口 API，禁止继续假设全历史。
- **高｜§4.2-4.3**：spacer 测量缺少“页渲染完成”屏障；B1 分帧及异步 Markdown 未排空时可冻结错误高度。增加 page-local render generation、content-settled/ResizeObserver 稳定闸门；未稳定页不得摘除。commit 前同时复验 page generation、DOM epoch、anchor 仍挂载。
- **中｜§3.2/§4.8**：`+0.2s`仅估算，无当前 HEAD 基准；改为假设并以前后各 30 次分位数验收。B 回滚后 C 不能存活，所谓独立回滚应明确只能按 C→B→A 逆序。
- **低｜现状引用**：Codex 无 index 的判断属实；`exportFullHistory` 实际在 `ClaudeConversationHistoryService.ts:823-833`，不是 816-825；amnesia exporter 调用在 `ClaudeChatRuntime.ts:1687-1689`，注入在 1751-1757。

### 场景推演

| 场景 | 方案行为 | 判定 |
|---|---|---|
| 重启开 1.59GB | 建索引→有界尾窗 | 可行，受索引耗时门约束 |
| 开 2.9MB | 同轨索引后全窗 | 可行，性能数字待测 |
| 连翻 20+ 页 | page LRU+DOM 摘除 | 修复渲染完成屏障后可行 |
| 流式中导出 | snapshot iterator 与 live transcript 并存 | 须定义 snapshot 边界；文件可行，剪贴板不成立 |
| 大会话 amnesia | 注入 newest suffix | 有重复恢复风险，阻断 |
| 双 tab 同小会话 | 共享 `conversation.messages` 被覆盖 | 阻断 |
| Codex 全流程 | 保持 hydration、无 lease | 可行；共享异常类型勿误删 |
| fable 线合入 | 文件冲突少，但 recovery budget 依赖模型 context | rebase 后联测 resolved model/context；不可只做机械合并 |

### 总结论

**需修订后实施。** 修订 §2.1、§3.1-3.5、§4.2-4.3、§4.8、§5；A→B→C 依赖成立，但先消除双 tab 共享视图、amnesia 循环和 spacer 未稳定测量三项阻断。

## 修订记录 v2（2026-09-15）

- [v2] 阻断 1：实证确认正常 `openConversation` 已双层防双开；补并发提交、恢复快照、直调入口三类绕过分析与全局 reserve/commit guard。最终采用“Claude `Conversation` 保持 metadata/持久化语义，窗口仅在 per-tab `ChatState`/page store”的分层；双开降为防御性风险，但视图分层保留为核心修复。
- [v2] 阻断 2：amnesia 增加 recovery generation、下一个 `session_init` 连续性确认、最多 2 次重试与 `tripped` 熔断/用户提示。
- [v2] 阻断 3：spacer 增加 page-local render generation + content-settled 屏障；3 秒超时用 estimated 高度并在回访后校正。
- [v2] 补充：chunk 增加投影字符边界；剪贴板设硬上限、文件流式导出；回滚固定 C→B→A；订正 `exportFullHistory` 为 `ClaudeConversationHistoryService.ts:823-833`；性能数字改为实测门槛。

## v2 终审记录（2026-09-16）

### 硬伤清单

- **阻断｜§2.1**：`session_init` 非逐 turn 事件，持久 query 注入后可能不再触发，`awaiting_init` 会悬空。改为 init 判跳变、成功 `result` 且 session 等于 dispatch 快照才确认；注入最多两次；`tripped` 提供原子重置入口。
- **阻断｜§4.2-4.3**：stored render 对 content promise 是 fire-and-forget，lazy expand 不再通知。改 page-scoped render ticket；分帧、展开、图片全登记，settle 后才记 measured。
- **高｜§2.2**：双计属实；须按 request 建快照：`message_start` 重置，delta 只 patch 已出现字段，非空主-agent assistant snapshot 替换；全零不覆盖正值，过滤 subagent。保留 turn model 快照；resolved model 仅匹配 result 并持久化。
- **高｜§3.1.1**：registry 须 token/CAS；reserve 新 id，提交时原子 old→new，仅 owner token 可释放；恢复去重正确。
- **中｜§3.3**：`save/restore/hydrateTab` 须显式传 page，禁用 `Conversation.messages` 过桥。

### 场景推演

| 场景 | 结论 |
|---|---|
| 1.59GB/2.9MB 打开 | 有界尾窗；小会话须实测 300/500ms 门 |
| 翻20页/250+ turns | ticket 修后 DOM≤200；搜索可重建高亮 |
| 流式导出/amnesia | snapshot 可并行；恢复按 result 确认 |
| 双tab/Codex | registry 封堵；per-tab 必要；Codex 回归 |
| usage | 约520k；result 仅校正窗口 |

### 总结论

**需修订后实施。** 双开基本闭合；amnesia、spacer 未闭合；usage 需 request 状态机。粗估 A 8–12、B 10–15、C 12–18 人日，联测 5–8 人日。

### 批次 A 落地切分

[v3 修订说明] 终审原始建议为 A0a rewind-runtime；A0b usage-snapshot；A1 iterator/导出/amnesia；A2 detail/search/LRU。现行切分已在 §1.2 补全 A2 的 `loadRange` 清理，并将回滚细化为 C→B→A2→A1→A0b；A0a 已部署，不纳入 B4 回滚。

## 修订记录 v3（2026-09-16）

- [v3 修订] amnesia recovery state 改为 `idle/pending/awaiting_result/tripped`：`session_init` 仅判跳变，成功 `result` 与 dispatch session 快照共同确认；`tripped` 增加 generation-CAS 手动重试，并明示新建会话入口。
- [v3 修订] DOM 测高改为 page-scoped 单调 render ticket；初始分帧、lazy expand、图片/异步渲染均登记并核销，当前 ticket 未核销不得 measured，超时仅降级 estimated。
- [v3 修订] usage 修复升级为 request-boundary 快照状态机：每请求完整 usage 对象替换，过滤 subagent，保留 assistant input + result 权威窗口两阶段及 turn/resolved-model 匹配。
- [v3 修订] `ConversationOpenRegistry` 值改为 `{ownerToken, conversationId}`，claim/release 均校验 token，拒绝过期任务释放新 owner。
- [v3 修订] `save/restore/hydrateTab` 显式传 page/materialized view，禁止 `Conversation.messages` 过桥。
- [v3 修订] 批次定为 A0a→A0b→A1→A2→B→C；A0a 已由 `b047650c` 于 2026-09-16 完成并部署 2.1.2，A 批只验证包含；A0b 为下一个独立 hotfix。
- [v3 修订] 已统一正文中的 v2 冲突描述：删除 `awaiting_init`/“下一次 session_init 确认”、布尔 content-settled 精确测高及无 token registry 语义；v2 终审记录保留为历史审查证据，不作为现行设计。

## 修订记录 v4（2026-09-16）

- [v4 修订] §2.1：A1 iterator 的 oldest-first 顺序语义直接采用已落地的 displayOrder（只读排序键 `[segmentOrdinal, entryOrdinal, projectionOrdinal]`，波次 1 commit `0a1d9ec9` + `14c69202`，2.3.0 已部署）；iterator 与物化/搜索/窗口共用同一键，不再依赖 timestamp 概念。
- [v4 修订] §2.1：A1 范围新增并入残项——统一 hydrate 段序与 index 侧段序口径（`ClaudeConversationHistoryService.ts:456-461` 按 missing-session 空洞 vs `:606-621` 段压缩，中间 session 文件缺失时两路径对同一消息赋不同段序），统一后补多段缺失场景测试（来源：1c 复核复验留档）。
- [v4 修订] §2.2：`loadMessageDetail` 同时承担搜索候选验证与目标消息替换/挂载（③ 方案已定边界：禁止 detail 候选配 summary 定位）；A2 的 `loadSearchCandidate` 迁移以此为准。
- [v4 修订] §3.4：B 批验证新增回归检查项——无 historyLease 的搜索 fallback（1c 引入）在 `loadActive` capability 分流重写后仍工作，Codex/OpenCode 搜索不回归。
- [v4 修订] §4.4：1b 引入的 message-level 工具栏 `syncMessageActions`/`syncLiveMessageActions` 幂等入口需在 page 挂载/摘除/重建时接线；`messages.css` assistant `bottom:0` 特例保留至占位验收（延续 ④ 方案约定）。
- [v4 修订] 基线说明：v3 的实证基线为旧 HEAD；波次 1 落地后基线为 `bb28bcc3`（2.3.0），实施时行号按语义定位，不按旧行号。
