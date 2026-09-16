---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian/
tags: [architect, claudian, history-search, bugfix]
---

# 背景与问题

Cmd+F 同时使用“固定 transcript 索引结果”计数/导航和“当前 DOM 可见文本”高亮，且索引顺序与 DOM 物化顺序分别按 canonical turn 与 timestamp 排列，导致新增消息或异常时间戳下当前项、顺序、计数和高亮不再同源。

## 实证

指定 transcript `/Users/vincentwang/.claude/projects/-Users-vincentwang-Documents-NoteVault/c906c448-04c0-4b3a-8b7d-115daefca4e9.jsonl` 中：

- 旧 user 命中：line 1231，UUID `5e69e77b-350d-4742-95b8-778b3c63580d`，timestamp `2026-09-16T06:14:21.706Z`，正文“已重启，Rewind和i18n已验证看起来正常”。
- 新 assistant 命中：line 1245，UUID `b72f9598-fe74-4e14-9b45-68a5c96e8f77`，timestamp `2026-09-16T06:16:51.086Z`，正文含“A2：rewind/fork 精确 detail、删 legacy loadRange、around/LRU 收口”。

两者 JSONL 行序、父链和 timestamp 均确认 assistant 命中更新；不是大小写折叠或 transcript 时间序错误。

当前代码存在三处不一致：

1. `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/HistorySearchController.ts` 初次查询直接使用 tab 已持有的固定 lease；`refreshSearchSnapshot` 只在“搜索框已打开时流结束”调用。搜索框在新消息完成后才打开时，结果仍来自旧 snapshot。
2. 同文件 `applyMarks()` 无条件扫描当前 DOM，因此旧索引未包含的新消息仍会高亮；状态栏和导航却只认旧 `results`。这直接解释“新消息有高亮，但当前项仍落在旧消息”，并使 N/M 与可见高亮数不一致。
3. `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts` 将不可映射的候选保留为 `projection_mismatch`，`HistorySearchController` 仍把它们计入 `results.length`。此外索引按 canonical turn 排序，而 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeHistoryStore.ts` 及窗口合并按 timestamp 再排序；assistant 合并保留首段 timestamp，compact boundary 独立成条，异常/相同 timestamp 可造成潜在顺序分叉。

# 方案设计

## 方案选择

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| A. 只在搜索前刷新索引 | 首次非空查询重取 lease | 可直接修复本次复现，改动小 | 仍保留双重排序、DOM 幽灵高亮和 mismatch 计数 | 不足 |
| B. **统一搜索快照与展示序（推荐）** | 搜索会话先绑定最新 snapshot；结果、mark、计数同源；物化保持 canonical 顺序 | 同时消除已复现问题和 timestamp/compact 潜在错序 | 跨搜索控制器、历史服务、物化层 | 采用 |
| C. 改为纯 DOM 搜索 | 仅扫当前渲染节点 | 实现最简单 | 丢失未加载历史搜索，违背 P1/B4 目标 | 否决 |

## 1. 搜索开始时绑定最新固定快照

修改：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/HistorySearchController.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts`

复用现有 `refreshSearchSnapshot` / `acquireHistoryIndex`，不新建第二套刷新机制：

1. 每次打开搜索面板后，第一次非空查询先刷新 snapshot，再执行 `searchHistory`；同一次打开期间的后续输入复用该 snapshot，避免每个按键重建。
2. 搜索框打开期间，stream 完成仍执行“刷新 → 重搜 → 按 `projectionKey + matchOrdinal` 保留当前项”；若原项已不存在，退回最新一项。
3. snapshot 交换必须原子化：保留旧 lease 可用，待新 lease `ready` 后，校验 conversation id、搜索 generation、旧 lease 仍为当前值，再替换并释放旧 lease；失败或过期只释放新 lease，不污染 tab 状态。
4. 复用 completed-index cache；同一文件 stat 未变化时刷新应命中缓存，而非重复扫描。

不建议仅比较 transcript mtime 再决定刷新：已有 index cache 已负责 snapshot 去重，再增加 UI 层 freshness 判定会复制缓存规则。

## 2. 结果、计数、mark 使用同一集合

修改：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/HistorySearchController.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts`

规则：

1. `results` 是状态栏 current/total、Enter/Shift+Enter 遍历及 `.is-current` mark 的唯一真相源。
2. `applyMarks(projectionKey)` 只为 `results` 中该 key 的有效 ordinal 加 mark；不得仅因 DOM 文本命中就产生“不可导航的幽灵高亮”。
3. **[修订 2026-09-16｜来源：独立审核]** provider 的粗索引候选须经 detail 文本验证，再以当前 summary/loaded DOM 的实际投影验证可挂载 ordinal。只有当前确能挂载并导航的匹配进入 `results`；detail 命中但 summary 裁掉文本的候选记 `projection_mismatch` 诊断，不进入可导航 `total`。
4. 若一个 projection 的 detail 候选数与实际可挂载投影数不等，首版以实际可挂载数为导航/计数口径；不能把已验证但当前无法挂载的候选伪装成结果，也不能静默少计。
5. live assistant 在未落盘/未刷新前不参与 mark 和计数；stream 完成后由既有刷新入口一次纳入。这样短暂延迟可见，但不会出现“高亮存在、N/M 不承认”的矛盾。
6. 完整历史定位移交 B4/A2：`loadMessageDetail(projectionKey, ...)` 必须同时承担候选 detail 验证与命中消息的 detail 替换/挂载；不能只用它替换现有 `loadSearchCandidate()`，却继续用 summary `loadWindow(around)` 定位。③ 阶段仅承诺“当前实际可挂载投影”的搜索一致性，不提前宣称 summary 外命中可导航。

计数定义固定为：**当前固定 transcript snapshot 上、按当前实际可挂载消息投影可定位的非重叠匹配数**。大小写继续使用现有 `toLocaleLowerCase()`；本次问题与大小写无关。

## 3. 搜索顺序与 DOM 顺序统一为 canonical projection order

修改：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeHistoryStore.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts`
- 必要时 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts`

**[修订 2026-09-16｜来源：独立审核]** 不能仅删除 `materializeSDKMessages()` 的 timestamp sort：history service 当前按 newest-first 物化并依次 push，尾部 sort 才把整窗恢复为正序；直接删除会令整窗倒序。应先建立稳定、闭合的 `displayOrder`，再逐点替换排序语义：

1. `displayOrder` 为结构排序唯一依据，由 `segmentOrdinal + entryOrdinal + projectionOrdinal` 组成：多 session 按 `previousProviderSessionIds → currentSessionId` 显式确定段序；段内按 `filterActiveBranch` 后 canonical entry 序；同 entry 的 user/assistant/tool/compact 投影按 mapper 的稳定 projection 序。
2. summary synthetic 不能在 `ClaudeConversationHistoryService.ts:730-737` 无条件追加到末尾；它继承被摘要区间的 canonical 边界位置，获得明确 `displayOrder`，不得脱离原序列。
3. 初始窗口、around window、`loadOlderWindow` prepend、相邻页去重合并与 live tail 追加均保留/生成 `displayOrder`。旧页 prepend 后按该键稳定合并；live tail 只允许追加在当前段 canonical 尾部，重投影后仍用同键对齐。
4. 六处 timestamp 排序依赖逐一处置：`ClaudeHistoryStore.ts:167`、`ConversationController.ts:457,613,641`、`ClaudeConversationHistoryService.ts:500,667,811` 均删除或改为稳定 `displayOrder` 排序；不得留任一处回退 timestamp。`HistorySearchResult` 的现有结果排序同样改消费该键，`matchOrdinal` 仅表示单条投影内第几个匹配。
5. timestamp 只用于展示；assistant 合并可继续保留首段 timestamp，但不得影响结构位置。去重以稳定 identity 为准，排序以 `displayOrder` 为准。
6. 若 `displayOrder` 必须跨 provider-neutral 边界传递，则按原方案仅新增只读排序键，并在渲染/合并前消费；不把 Claude JSONL 原始结构泄漏给 feature 层。仅当实施证明所有跨页、around、prepend、live-tail 输入天然保持该顺序时，才可将键限制在 provider 内部，但上述五类路径仍须有同一可验证顺序契约。

## 4. 导航语义

- 初次搜索仍默认选择最新有效结果，即 canonical results 的末项。
- Enter 向后、Shift+Enter 向前；是否循环维持现有“非循环”产品行为，本修复不改变。
- `current/total` 在 `locateCurrent()` 成功后代表同一结果。定位若因 DOM 重建失败，显示明确错误但不偷偷切换 ordinal；重新刷新 snapshot 后再恢复。

# 风险与权衡

1. **刷新成本**：大 transcript 首次打开搜索会做一次 stat/cache lookup；snapshot 变化才重建。必须用现有 completed cache，禁止每次输入重扫。
2. **live 内容延迟**：流式生成中的未持久化片段暂不高亮，换取计数与导航一致；stream complete 后自动纳入。
3. **删除 timestamp sort 的影响面**：需核对跨 session、外部消息、compact boundary 和分页 prepend；不能只删一处排序。若漏一处，搜索与 DOM 仍会分叉。
4. **工作树说明**：派单称工作树干净，但实查存在未跟踪 `/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/2026-09-16-session-handoff.md`；本方案不触碰该文件。
5. 本文是待用户确认的设计记录，不是实施记录。

# 验证方式

## 自动测试

1. `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/controllers/HistorySearchController.test.ts`
   - lease 在旧 user 命中时建立，随后 append 新 assistant 命中；关闭状态下完成追加，再打开搜索：必须先刷新，默认 current 落在新 assistant。
   - DOM 含新命中而固定 snapshot 不含时，不产生幽灵 mark；stream complete 刷新后 mark、total、结果同步增加。
   - 两条消息分别多次命中：`total === 可导航 ordinal 数 === mark 匹配集合数`；每次 current 只标记对应 ordinal。
   - 大小写混合 `Rewind/rewind` 保持不敏感。

2. `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/history/ClaudeConversationHistoryService.test.ts`
   - visible projection 少于 detail 候选时，mismatch 只记诊断、不计入可导航结果。
   - **[修订 2026-09-16｜来源：独立审核]** 构造超大消息：查询词存在于 detail、但被 summary 裁掉。③ 阶段断言该候选不进入 `results/total` 且无法 Enter 导航；A2 阶段改为 `loadMessageDetail` 替换并挂载目标消息后，命中才进入可导航结果。
   - snapshot 原子交换失败、会话切换、generation 过期时旧 lease 保持可用，新 lease 仅释放一次。

3. `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/history/ClaudeTranscriptHistoryIndex.test.ts` 与 Claude history materialization 测试
   - 连续 assistant 两段 timestamp 故意逆序：合并消息仍位于原 canonical turn，内部文本顺序不变。
   - compact boundary timestamp 早于前消息或晚于后消息：仍独立成条并停在 JSONL canonical 位置，前后 assistant 不跨 boundary 合并。
   - summary synthetic 位于被摘要区间的 canonical 边界，不因追加动作跑到整窗末尾。
   - 相同 timestamp、多 session segment、branch filtering 后顺序均稳定。
   - 初始窗口、around、`loadOlderWindow` prepend、分页去重及 live tail 追加后，DOM 与搜索结果均按 `displayOrder`；逐一覆盖六处原 timestamp sort，禁止任一路径回退时间排序。

建议命令：

```bash
cd /Users/vincentwang/Documents/NoteVault/tools/claudian
npm run test -- --selectProjects unit --runInBand \
  tests/unit/features/chat/controllers/HistorySearchController.test.ts \
  tests/unit/features/chat/controllers/ConversationController.test.ts \
  tests/unit/providers/claude/history/ClaudeConversationHistoryService.test.ts \
  tests/unit/providers/claude/history/ClaudeTranscriptHistoryIndex.test.ts
npm run typecheck
npm run lint
```

## 真机核对

在指定会话搜索 `rewind`：

1. 最新项必须落在 timestamp `06:16:51.086Z` 的 assistant 消息，而非 `06:14:21.706Z` 的 user 消息。
2. 逐次 Enter/Shift+Enter，视觉顺序、current/total 与 `.is-current` 高亮一致。
3. 搜索框关闭时产生一条新命中，完成后再打开：新命中立即进入 total 且成为最新项。
4. 搜索框保持打开并生成新命中：流结束刷新后 total 增加，当前项保留或按既定回退规则更新。

# 关联

- [[docs/designs/2026-09-15-claudian-B4双轨统一与DOM窗口化整合实施方案]]
- [[docs/designs/2026-09-14-Claudian超大会话真机反馈分析与修复方案]]
