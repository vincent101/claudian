---
type: design-decision
status: confirmed
target: "[[tools/claudian]] rewind/fork 精确内容解析与陈旧 lease 自愈"
tags: [architect, claudian, history-lease, rewind, fork]
备注: 缺陷一根因再诊断（两层），修复方案已细化到改动点；待派 implementer 实施
---

# claudian rewind/fork 陈旧 lease 自愈方案（含同族排查）

## 背景与问题

窗口化会话打开时 `state.historyLease` 绑定当时的索引快照；此后新发的 turn 只进 live page，lease 快照不更新（除搜索面板刷新外无任何刷新点）。rewind/fork 对非 detail 投影消息强制走 `loadMessageDetail`，在快照缺该消息时报 `not_found` → "无法回退：无法读取消息的精确内容"。真机案例：恢复会话（transcript 4400 行）→ 发消息（→4562 行）→ rewind 第 4533 行消息失败。

## 根因再诊断（关键修正）

实证链路逐环核对后，案例失败有**两层根因**，已确认方向（刷新重试）只覆盖第二层：

1. **条件过宽（案例的直接根因，刷新救不了）**：`ConversationController.rewind:953` 与 `Tab.ts handleForkRequest:1114` 的条件是 `projectionLevel !== 'detail'`。live 消息（`InputController:425` / `AutoTurnProjectionController:113` 创建）`projectionLevel` 为 undefined，同样命中该分支。而 live 消息的 `id` 是本地生成的 `msg-<ts>-<rand>`（`Tab.ts:2035 generateMessageId`），**不是** transcript 投影键（descriptor 的 `projectionKey` 是 SDK uuid）。`materializeMessageDetail` 按 projectionKey 查 descriptor（`ClaudeConversationHistoryService.ts:377`）→ live id 永远 miss → `not_found`，**无论快照新旧**。rewind/fork 回调传的正是 `msg.id`（`MessageRenderer.ts:1219/1236` → `Tab.ts:1241/1243`）。
   - 旁证：离线复现脚本用完整索引 FOUND 的是 descriptor 键 `e7117585-…`（uuid），与 UI 实际传入的查找键不是同一个——"代码本身正确，纯粹快照陈旧"的结论只对 service 层成立，UI 失败主因是键不匹配。
   - 推论：**只做刷新重试，真机案例仍失败**（重试仍用本地 id 查询）。必须收窄条件：只有 `projectionLevel === 'summary'`（被裁剪的窗口投影）才需要加载精确内容；detail 投影、live、draft tail 的内存内容本就是精确的。
2. **快照陈旧（残余路径，已确认方向覆盖）**：summary 消息的 descriptor 缺失于当前挂载 lease 的快照（lease 换代后分支被弃等罕见场景）→ 刷新一次重试一次，二次 miss 才报错。

## 方案设计

### 改动 1：ConversationController 新增公共解析方法（核心）

`src/features/chat/controllers/ConversationController.ts`：

```ts
async resolveExactUserMessage(
  projected: ChatMessage,
  trigger: 'search' | 'rewind' | 'fork',
): Promise<
  | { status: 'exact'; message: ChatMessage }
  | { status: 'too_large' }
  | { status: 'not_found' }
  | { status: 'switched' }
> {
  const { state } = this.deps;
  // 只有 summary 投影的内存内容是被裁剪的；live/detail/draft 本就精确，
  // 且 live 消息的本地 id 不是 transcript projectionKey，加载必 not_found。
  if (projected.projectionLevel !== 'summary') return { status: 'exact', message: projected };
  const conversationId = state.currentConversationId;
  const lease = state.historyLease;
  if (!lease) return { status: 'not_found' };  // fail-closed，不再用裁剪内容预填
  const detail = await lease.loadMessageDetail(projected.id, { maxSourceBytes: 16 * 1024 * 1024 });
  if (detail.status !== 'not_found') return detail;
  if (state.currentConversationId !== conversationId) return { status: 'switched' };
  try {
    await this.refreshHistorySearchSnapshot(trigger);
  } catch {
    // 刷新失败（索引构建错）时旧 lease 仍在挂载；下面这一次重试会诚实地
    // 以 not_found 结束，而不是把构建错误当成 rewind 的错误。
  }
  if (state.currentConversationId !== conversationId) return { status: 'switched' };
  const retryLease = state.historyLease;
  if (!retryLease) return { status: 'not_found' };
  return retryLease.loadMessageDetail(projected.id, { maxSourceBytes: 16 * 1024 * 1024 });
}
```

要点：
- **刷新复用 `refreshHistorySearchSnapshot` 的 P1 交换语义**（构建在 grant 外、身份校验短临界区交换、回滚不复活 lease），不内联第二套、不绕过身份校验。刷新前/后各一次会话身份守卫：刷新期间切会话 → 返回 `switched`，调用方静默中止（不报错、不污染新会话）。
- 只在 `not_found` 时刷新；`too_large` 是消息自身属性，不刷新、直接返回。
- 只重试一次；刷新返回 not_applicable（无 lease/无索引能力等）时重试原 lease，诚实失败。
- 注释含于 catch 块内（eslint `no-empty` 不报含注释块）。

### 改动 2：rewind 接线（`ConversationController.rewind:951-960`）

```ts
const projectedUserMsg = msgs[userIdx];
const resolved = await this.resolveExactUserMessage(projectedUserMsg, 'rewind');
if (resolved.status === 'switched') return;
if (resolved.status !== 'exact') {
  new Notice(t(resolved.status === 'too_large' ? 'chat.rewind.detailTooLarge' : 'chat.rewind.detailUnavailable'));
  return;
}
const userMsg = resolved.message;
```

后续 `userMsg.userMessageId` 检查、rewind 事务（用交换后的新 `state.historyLease` 与新鲜 `totalTurns`）均不动。

### 改动 3：fork 接线（`Tab.ts handleForkRequest:1112-1121`）

```ts
const projectedUser = msgs[userIdx];
const resolved = await tab.controllers.conversationController!.resolveExactUserMessage(projectedUser, 'fork');
if (resolved.status === 'switched') return;
if (resolved.status !== 'exact') {
  new Notice(t(resolved.status === 'too_large' ? 'chat.fork.detailTooLarge' : 'chat.fork.detailUnavailable'));
  return;
}
const exactUser = resolved.message;
```

`tab.controllers.conversationController!` 与 Tab.ts:1428/1476 同一非空假设。fork 原有的 userMessageId/rewindCtx 前置检查顺序不动。

### 改动 4：刷新触发源诊断维度

- `refreshHistorySearchSnapshot(trigger: 'search' | 'rewind' | 'fork' = 'search')`——签名加默认参数，搜索侧零改动（Tab.ts:1428 闭包不传参）。
- `HistoryDiagnostics.ts` 的 `search_snapshot_refresh` 事件加 `trigger?: 'search' | 'rewind' | 'fork'` 字段；`reportRefreshNotApplicable` 与三处发射点带上。 rewind/fork 触发的刷新不再污染搜索刷新归因。

### 测试（TDD，先红后绿）

`tests/unit/features/chat/controllers/ConversationController.test.ts` 新增 describe（rewind 侧，深入测 resolver+交换集成）：
1. live 消息（无 projectionLevel）rewind：`loadMessageDetail` 与 `acquireHistoryIndex` 均不被调，直接用内存内容回退成功（真机案例回归测试）。
2. summary rewind：旧 lease not_found → `acquireHistoryIndex` 以 `(conversation, '/vault', undefined, true)` 被调 → 新 lease FOUND → 回退完成、无 detailUnavailable 通知。
3. 刷新后仍 not_found → 诚实报错，`agentService.rewind` 不执行。
4. 刷新期间切会话（acquire 回调内改 `currentConversationId`）→ 静默中止：无 Notice、不执行 rewind、新 lease `release` 恰一次（未挂载引用终结）。
5. too_large → 不触发 `acquireHistoryIndex`，报 detailTooLarge。
6. 触发源诊断：`refreshHistorySearchSnapshot('rewind')` 事件带 `trigger: 'rewind'`，默认调用带 `'search'`。
- 兼容性核对（不需改，跑通即可）：现有 `it.each(['not_found','too_large'])`（not_found 分支走 no_conversation not_applicable → 原 lease 重试 → 仍 abort）；`windowed rewind (F1)` 各用例全为 detail 投影，不触 resolver 加载。

`tests/unit/features/chat/tabs/Tab.test.ts` 扩展 `Tab - handleForkRequest`（测接线契约，`jest.spyOn(controller, 'refreshHistorySearchSnapshot')` 模拟交换换 lease，resolver 真跑）：
7. live 消息 fork：不调 `loadMessageDetail`，prefill 为内存内容。
8. summary fork：not_found → 刷新换 lease → 重试 exact → `forkRequestCallback` 收 prefill 与 `forkAtUserMessage = historyTurnOrdinal + 1`。
9. fork 刷新期间切会话：静默中止。
10. fork too_large：刷新 spy 不被调。

### 提交切分与门禁

- commit 1：`refactor(history): refreshHistorySearchSnapshot 增加 trigger 诊断维度（search/rewind/fork）`——改动 4 + 测试 6。
- commit 2：`fix(history): rewind/fork 精确内容解析——仅 summary 加载详情，not_found 强制换快照重试一次`——改动 1-3 + 测试 1-5、7-10。
- 门禁：`npm run typecheck && npm run lint && npm run test`。manifest 不动（随 3.1.4）、不 build、不碰 .obsidian。

### 不做什么（明确出界）

- 不做 stream-complete 自动刷新 lease：每次 turn 全量重建索引（grown 文件 cache key 含 size/mtime 必 miss），且换代会搁浅全部旧页（见矩阵 #7），收益不抵。本方案走按需自愈。
- 不在本批修矩阵中"留档"项（#5、#7、#9），仅记录。

## 同族排查矩阵（缺陷二）

族特征：会话打开后 transcript 增长窗口内，消费 `state.historyLease`（或其派生快照）的路径读到陈旧数据。逐消费点推演：

| # | 消费点 | 受影响 | 用户可见后果 | 处置 |
|---|--------|--------|--------------|------|
| 1 | rewind detail（CC:953） | **是（实证）** | live/auto-turn 消息回退必败（键不匹配为主因）；summary 陈旧罕见失败 | **本批修** |
| 2 | fork detail（Tab:1114） | **是（同病）** | live/auto-turn 消息 fork 必败 | **本批修** |
| 3 | loadOlderHistory/loadOlderWindow（CC:333/452） | 否 | 旧方向分页只读旧快照已存在前缀；anchor 取 newest.start、hasMore 对 T0 判定均正确；live 轮不经分页 | 无需修 |
| 4 | searchHistory（CC:509）+ HistorySearchController | 否（P1 已覆盖） | 每次打开首个非空查询前 rebind；面板开着时 stream complete/Retry 再刷；刷新失败标 stale+Retry 可用（设计内） | 确认无洞 |
| 5 | loadSearchCandidate/locateHistorySearchResult（CC:597/696） | 边缘 | 候选来自同一快照 corpus，同 lease 必 found；跨代点旧结果仅在分支被弃（rewind+重发）时 not_found → projection_mismatch 显式失败，语义上该消息已不在规范分支 | 留档不修 |
| 6 | refreshUsageWindow/usage 分母（CC:1241） | 否 | 读 provider settings，不经 lease | 确认无关联 |
| 7 | rematerializeHistoryPage（CC:339）+ 页存储换代 | **是（新发现，留档）** | 任何搜索面板首查刷新都会换代 lease；旧代 pageKey 的页被数据 LRU 逐出（>250 轮/16MiB）后，滚回该区域重物化被 pageKey 守卫拒绝 → **永久空白区**（静默，无诊断事件） | 留档：结构性修复需换代时重置页存储+重挂可见页（冲击滚动锚定），另批设计；建议后续先补 refusal 诊断事件 |
| 8 | loadTitleMaterial（Service:158） | 否 | service 层每次独立 acquire（新快照），不经 tab lease；代价是 grown transcript 触发重建（by design） | 无需修 |
| 9 | beginLivePage 锚（Input:438、AutoTurn:141） | 轻微 | live 页 range 停留在打开时 totalTurns（`{start:T0,end:T0}`）；keepEnd/pager/renderer.totalTurns 各消费点推演均良性（仅元数据低估） | 留档不修 |
| 10 | restoreConversation addPage（CC:1221） | 否 | 恢复时刻 lease 新鲜 | 无需修 |
| 11 | transcript observer 起始偏移（Tab:592） | 否 | 取恢复时刻 `historySnapshotOffset`，observer 自行前进 | 无需修 |
| 12 | rematerialize 内 detail 加载（CC:366） | 同 #7 | pageKey 守卫在 loadWindow 之后先拒绝，detail 不会执行 | 同 #7 |

## 风险与权衡

- **与已确认方向的偏差**：用户确认的是"not_found 刷新重试"；本方案主张叠加"条件收窄"（收窄才是实证案例的治本项，见根因再诊断）。若主会话认为收窄越权，可单独确认——但不收窄则真机案例不修复，方案不能仅按原方向落地。
- 收窄的行为变化：lease 为 null 的 summary 消息从"用裁剪内容预填"变为 fail-closed 报错（更诚实，路径近乎不可达）；live 消息 fork 的 `forkAtUserMessage` 走 `countUserMessagesForForkTitle` 兜底（窗口内计数，标题序号可能偏小——今天该路径直接报错，无回归可言）。
- rewind 触发刷新与搜索面板在途刷新并发：双重强制 acquire 安全（交换双重身份校验、transcript 级 requestKey 去重合并构建），最坏浪费一次构建；无需去重机制。
- 刷新成本：forceNewSnapshot 对 grown 文件是 worker 全量重建（completed cache key 含 size/mtime 必 miss）；只发生在 summary rewind/fork 的 not_found 残余路径，频率低、构建在 worker、无进度 UI 污染（silent acquire）。

## 验证方式

1. 单测：上述测试 1-10 全绿（含 4/9 的切会话静默中止）。
2. 门禁：`npm run typecheck && npm run lint && npm run test`。
3. 人工核对点（部署后）：恢复长会话 → 发新消息 → rewind 该新消息（秒级成功、无刷新感知）；rewind 一条早期 summary 消息（走原路径不受影响）；搜索面板打开 → 搜索 → 关闭，行为不变；`.claudian/diagnostics/` 中 `search_snapshot_refresh` 事件 trigger 归因正确。
4. 真机回归对拍：原失败案例（transcript 4400→4562，rewind 第 4533 行消息）应直接成功。

## 关联

- [[tools/claudian]] 窗口化历史：`src/features/chat/CLAUDE.md`（lease 生命周期、P1/F5 交换协议、rewind detail 约定）
- 实证来源：主会话派单（transcript 4400→4562 行案例 + 离线 descriptor 复现脚本）
- 后续留档项：矩阵 #7 页存储换代空白区（需独立设计）；#5 跨代搜索定位边缘
