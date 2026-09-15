---
type: design-decision
status: proposed
target: /Users/vincentwang/Documents/NoteVault/tools/claudian/
tags: [architect, claudian, history, resource-budget, dom-windowing]
---

# 背景与问题

Claudian 已有预算窗口与 `ProjectionWriteCoordinator`，但完整历史消费者、Claude 小/大会话双轨和持续累积的 DOM 仍突破端到端资源边界；本方案以当前 `hotfix/notify-lease@1583ab57` 为实证基线，分三批完成收口。派单所写 `5372b4ac` 是当前 HEAD 的祖先，之后 10 个提交均为写协议补修，因此不能按旧 HEAD 设计。

# 方案设计

## 1. 总体决策与交付顺序

### 1.1 方案选择

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| 保留双轨、只补大文件 | 小会话继续全量 hydrate，大会话分页 | 小会话最快、改动少 | 两套状态机、异常语义与测试永久并存；B3 只能覆盖一轨 | 否决 |
| 单轨索引 + 小会话直接全量读特例 | 所有 Claude 都建索引，小文件首屏另走旧 reader | 可保 12ms 读取基线 | “直接读”仍是第二物化路径，后续 detail/页缓存/完整性继续分叉 | 不推荐 |
| **单轨索引 + 自适应窗口（推荐）** | 所有 Claude 经 `acquireHistoryIndex + loadWindow`；小会话窗口自然覆盖全部 turns | 一套契约、一套完整性语义；小会话是一般路径退化 | 冷开多约一次索引成本，需缓存与性能门 | **采用** |

### 1.2 顺序

正式集成顺序为 **A → B → C**：

1. **A** 先封闭无界入口并补 detail、around、LRU；可独立部署，降低 B 改状态机时的灾难半径。
2. **B** 消灭 Claude 双轨，令所有 Claude tab 都有 page/range/lease 语义；这是 C 的必要前提。
3. **C** 只管理已加载数据的 DOM 驻留，不改变 provider 读取语义。

A 内可并行两条开发线，但必须串行合并：

- A1：完整历史迭代、amnesia、rewind detail；
- A2：删除 UI `loadRange`、around 回归固化、LRU 修正。

两线共同修改 `core/providers/types.ts`、`ClaudeConversationHistoryService.ts` 和 `ConversationController.ts`，不宜在同一工作树无序并改。先合 A1 契约，再将 A2 rebase 到该契约。A 与 B 不并行合并：B 会删除 A 所依赖的 oversize/loadActive 分支，冲突不仅是机械冲突。

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

`ProviderConversationHistoryService.iterateFullHistory(conversation, vaultPath, options)` 返回固定 snapshot 上的 oldest-first async iterable。实现内部持有一个 lease，每次用 planner 选下一段并 materialize detail；iterator `return/throw/abort` 必须释放 lease。单 turn 超过 `maxSourceBytesPerChunk` 时不得 summary：返回结构化 `HistoryEntryTooLargeError`，因为“完整导出”不能静默截断。

删除公开 `HistoryIndexLease.loadRange`。如 provider 内部仍需按范围物化，保留为 `ClaudeConversationHistoryService` 私有方法，避免 UI 再绕过 policy。

#### 两类消费方

1. **完整文本导出**：增加 provider-neutral `consumeHistoryText(iterable, WritableLike)`，逐消息格式化、逐块写文件/clipboard 临时文件；任意时刻只驻留“一个 chunk + writer buffer”。不得先构造 `ChatMessage[]` 或完整字符串。若当前产品并无用户导出入口，则本批只提供该 sink 契约与测试，不新增 UI。
2. **SDK amnesia rebuild**：`ChatRuntime.setFullHistoryExporter` 改为 `setHistoryRecoverySource(() => FullHistoryIterable)`；`ClaudeChatRuntime` 通过新增 `HistoryContextAccumulator` 消费 detail chunk。累计达到恢复预算后丢弃最旧完整 turn，保留 newest contiguous suffix，并加入明确的 `[Earlier history omitted: context recovery budget]` 标记。预算以模型 context token 上限换算的保守字符上限计算，并为 system prompt、当前 prompt、工具 schema 与输出留余量；首版采用现有 token/context 估算能力，不新增 tokenizer 依赖。

这解决了两个不同问题：导出遍历全部历史且流式落地；模型恢复不可能容纳无限历史，因此只注入未摘要、未拆断 turn 的有界后缀。`buildContextFromHistory(ChatMessage[])` 保留给普通小数组调用；新增 `HistoryContextAccumulator.appendChunk()`，禁止 amnesia 再调用旧全量函数。

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

流程：

1. 用户点击 rewind/fork 时，先从当前消息判断 `projectionLevel`；summary 或未知一律按 key 拉 detail。
2. detail 成功后才弹确认并执行破坏性 rewind；失败或超限则明确提示并中止，绝不把摘要写入输入框。
3. rewind 输入框使用 exact `displayContent ?? content`。
4. fork 的 provider 分支事实仍由 `sourceSessionId + resumeAt` 表达；不得把当前窗口 `msgs.slice(...)` 当完整历史。fork metadata 中的 `messages` 只作为有界首屏视图，目标 tab 随后按统一索引重建；被点击 user message的 exact 内容用于预填/标题计数。

单条消息仍需硬边界。首版 detail `maxSourceBytes=16 MiB`；超过则拒绝预填，不提供截断 rewind。该选择比把几十 MiB 文本塞进 textarea 更可控，也保持“执行即精确”。

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
3. amnesia 超过 context 预算：只保留完整 newest suffix、当前 prompt 不重复、出现 omission 标记；任何 chunk 都不是 summary。
4. summary user rewind：先取 exact detail；detail 失败/16 MiB 超限时不执行 rewind、不改输入框。
5. fork 不再把当前 `state.messages` 视为完整前缀。
6. Codex history load 不调用 index/window；删除 legacy fallback 后原测试仍绿。
7. around 在两侧 turn 大小不对称、字符预算二次缩窗时 anchor 不丢且偏移可解释。
8. 3–10 个 protected index 超上限时无 protected eviction；释放后自动收缩。

验收：全历史导出字节/消息序列与旧 loader 在小 fixture 上完全一致；1.59 GB 导出与 amnesia 无 `loadRange(0,total)`、无全量数组/字符串；amnesia 最终 prompt 不超过恢复预算；UI 源码中不存在 lease 裸 `loadRange` 调用。

### 2.6 独立部署与回滚

A 可独立部署。兼容期 `setFullHistoryExporter` 可保留一个版本但 Claude runtime 不再调用；下一批删除。回滚点为 A 前构建产物；回滚不会改变 transcript/meta。若 iterator 出错，显式终止导出或 amnesia 恢复，不回退全量物化。

## 3. 批次 B：Claude 双轨统一

### 3.1 语义重定义

Claude 的 `hydrateConversationHistory` 不再读 transcript。推荐从 Claude service 接口移除该实现，`getConversationById` 对 Claude 仅返回 metadata/in-memory shell；`ConversationHistoryHydrationError` 继续保留给 Codex/Opencode 的真实 hydration error，不再包含 `oversize` 分支。若类型收敛后所有 provider 都不需要该异常，再单独删除，不能在共享层假设 Codex 行为。

`ConversationController.loadActive` 改为 capability 分流而非异常分流：

- service 有 `acquireHistoryIndex`：唯一执行 `acquire → ready → loadWindow → bind lease → restore`；
- 无 index 能力：调用现有 `getConversationById`/provider hydration（Codex、Opencode）。

这不是 Claude 大小双轨，而是 provider capability 边界。

`hydratedConversationIds` 从 Claude service 删除。统一后的状态含义：

- `conversation.messages`：当前进程内的**可见已物化视图**，不是完整历史；仅供当前 tab/runtime UI 同步，不作为导出、fork、搜索、amnesia 的事实源。
- `ChatState.messages`：当前 tab 已加载 page 的合并视图 + live page；B3 前可随翻页增长，B3 后由 page store 派生可驻留视图。
- `loadedRanges`：固定 index snapshot 上已物化范围；不得据其判断 transcript 完整性。
- `historyLease`：所有已恢复 Claude tab 必有；Codex 无。

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

### 3.3 清理项

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts`：Claude `getConversationById` 不再抛 oversize；provider-neutral hydration 只服务无 index provider。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts`：删除 catch-oversize、`paged` 标志、`bindHistoryLease` 后置预热分支；首次和 switch 均走同一 helper `loadIndexedConversation`。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts`：删除 `OVERSIZE_BLOCKED` 状态及 placeholder；`buildProviderWarmupContext` 删除 oversize catch，Claude warmup 只使用当前有界视图，完整恢复由 A 的 recovery source 提供。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkSessionPaths.ts`：`MAX_LEGACY_SESSION_BYTES` 仅随旧 Claude hydration reader 一并删除；若旧 reader仍被测试工具使用，常量移入测试/legacy 私有模块，生产路径不可引用。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts`：删除 `hydratedConversationIds` 与全量 hydrate。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts`：`oversize` 从共享 hydration result 删除；index capability 保持可选以兼容 Codex。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/state/ChatState.ts`、`state/types.ts`：注释与命名明确“materialized view”。
- 命令目录、switch shell、retry、保存路径逐项删除 oversize 特判；保存 messages 仍只是内存视图，不写入 transcript。

### 3.4 Codex 边界

Codex 不实现 index/window，不改 `CodexConversationHistoryService`。共享改动必须验证：

1. Codex 冷开仍只调用 `hydrateConversationHistory`，不调用 Claude index API；
2. `MessageRenderer` 对 Codex contentBlocks/toolCalls/plan approval 无变化；
3. Codex fork 的内存前缀语义保持现状，A 的 Claude detail/fork 调整按 capability 生效，不做 providerId if；
4. `ConversationHistoryHydrationError(error)` 若 Codex 使用则仍能进入通用 ERROR/retry，而非 oversize shell；
5. send/stream/provider boundary 继续受既有 `ProjectionWriteCoordinator` 保护。

### 3.5 红测与验收

红测：

1. 1 KB、2.9 MB、63 MB、65 MB、1.59 GB Claude fixture 的调用序列均为 `acquire → ready → loadWindow`，不存在 size threshold 分叉。
2. Claude `getConversationById` 不读 transcript、不抛 oversize；`loadActive/switchTo` 无 catch-oversize。
3. 小会话 planner 覆盖全 range；超过预算只显示窗口且 `historyHasMore=true`。
4. index/load/render 任一步失败均 release 恰好一次并进入可重试 ERROR；无 partial view 冒充 ready。
5. 两 tab 同会话共享 snapshot；切换、关闭、刷新 lease 不泄漏。
6. warmup、命令目录、save/title 不依赖“messages 等于全历史”。
7. Codex 全套 hydration/fork/stream/plan tests 不变绿。

验收：Claude 源码中无 `MAX_LEGACY_SESSION_BYTES`、`oversize` UI 分支和 `hydratedConversationIds`；四档会话行为单轨；2.9 MB 达上述 p95 门槛；1.59 GB index 期间 UI 可交互，index 后 2 秒内首屏可读。

### 3.6 独立部署与回滚

B 依赖 A，可独立部署。无持久化格式或 meta 迁移；回滚到 A 产物即可。回滚后旧进程只会重新 hydrate，不需降级数据。部署诊断必须记录 `provider/path/indexHit/indexMs/windowMs/renderMs`，以便确认小会话退化来自索引、物化还是 DOM。

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
3. 获得租约后复验 conversation id、DOM epoch、目标 page 与 scroll direction；过期 intent 丢弃。
4. 事务内先记录稳定 anchor（message id + viewport top），测量待摘页，原位替换 spacer；需要回访时先确保 page data，离线构建 fragment，再以 spacer 原位替换。
5. mutation 后在同一帧校正 `scrollTop`；异步 Markdown 稳定后再做一次按 anchor 的差值修正。
6. live lease 持有时 stored intent 排队；若用户持续滚动，只保留每个方向最新 intent，避免响应结束后回放大量陈旧窗口操作。
7. 不允许持有 stored 租约等待网络/索引长 I/O：缺页时先在租约外物化并 pin `transaction`，完成后再申请 stored 做 DOM commit；commit 前再次 stale 校验。

### 4.3 spacer 高度

- 每页必须有独立 wrapper；`ResizeObserver` 只观察 mounted page wrapper，持续更新最后稳定高度。
- 摘除前用 `getBoundingClientRect().height` 记录精确像素，spacer 设置同高。
- 容器宽度、字体族/字号、主题切换导致所有 height cache 失效。简化策略：`ResizeObserver(messages viewport)` 检测宽度变化，加 `document.fonts.ready/loadingdone` 与主题 class 变化监听；统一标记 stale，不立即全量重建。
- stale spacer 回到邻接区时先按旧高度占位，重建后以 anchor 差值校正并写新高度。禁止尺寸变化时一次性重建所有页。
- 图片/异步内容在 mounted 状态由 page observer 修正；摘除时冻结最终观测值。

### 4.4 UI 状态、锚点与搜索

- 展开态从 DOM 私有状态提升为 `MessageUiState`，key=`messageId + blockId`，至少覆盖 thinking/tool/subagent/大文本 detail；renderer 创建节点时读状态，交互时写状态。
- 当前搜索状态保存 `{projectionKey, matchedText, matchOrdinal}`，不保存 `<mark>` 节点。页重建并完成 message content 后重新枚举并高亮。
- 滚动锚点始终使用稳定 `data-message-id`；若锚点所在页被数据 LRU 淘汰，先重物化并 pin，DOM commit 后恢复 offset。
- 搜索定位页使用 `search` pin，定位完成且离开视口后解除。找不到 projection 仍显式 `projection_mismatch`。
- page 摘除时必须清理 `MessageRenderer.liveMessageEls`、tool DOM maps 等易失引用；domain/page UI state 保留。该清理与 DOM epoch 校验共同防止写入脱离节点。

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
5. 摘除前后 spacer 高度相等；上下往返锚点误差 ≤1 可见行，无累计漂移。
6. 宽度、字体、主题变化使缓存 stale；回访校正而非全量同步重建。
7. tool/thinking/subagent/detail 展开态往返保持；被 data LRU 淘汰后重物化仍恢复。
8. 搜索命中 mounted、spacer、data-evicted 三类页均可定位并恢复高亮；解除 pin 后可淘汰。
9. page LRU ≤32 MiB/12 页（固定页单列）；所有页 pinned 时允许可诊断 overcommit，不驱逐可见/live/search 页。
10. Codex 因无 page store 默认保持旧渲染；共享 MessageRenderer 单消息行为不变。

验收：1.59 GB 会话浏览 20 页后 DOM turn 稳定在硬上限附近，page data 可回落；滚动、输入、切 tab 无 p95 ≥50ms Long Task；反复上下 10 次无内容丢失、重复、展开态丢失或搜索高亮漂移。

### 4.8 独立部署与回滚

C 依赖 B，可独立部署。以 feature flag（内部常量，默认开）保留一版关闭能力：关闭时 page store 仍记录数据但不摘 DOM，便于现场归因；稳定一版后删除 flag。回滚到 B 产物只失去窗口化，不影响 transcript、meta、index 或 page 重建能力。

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
6. **当前工作树已有未跟踪设计文档**：本方案不改动它们；实施前应以 `1583ab57` 冻结基线，避免误按 `5372b4ac` 回退掉写协议补修。

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

# 关联

- [[2026-09-09-claudian超大会话历史加载机制与分页方案]]
- [[2026-09-15-claudian超大会话物化与渲染资源预算修复方案]]
- [[2026-09-15-claudian超大会话修复全景回归审查]]
- [[2026-09-15-claudian流式分帧互斥与锚点投影硬上限补修]]
