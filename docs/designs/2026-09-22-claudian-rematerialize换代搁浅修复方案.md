---
type: design-decision
status: confirmed
target: "[[tools/claudian]] 窗口化历史页存储换代搁浅（同族矩阵 #7）"
tags: [architect, claudian, history-windowing, rematerialize, lease]
备注: 待用户确认后派 implementer 实施；档位建议 implementer-high
---

# claudian rematerialize 换代搁浅修复方案（矩阵 #7）

## 背景与问题

`refreshHistorySearchSnapshot`（搜索面板每次打开的首个非空查询、面板开着时 stream complete、rewind/fork 自愈的 not_found 残余路径）经 forceNewSnapshot 交换 lease 后，新 lease 的快照身份（`snapshotIdentity` = 各段 `path:dev:ino:snapshotSize:mtimeMs` 拼接，`ClaudeConversationHistoryService.ts:598-600`）与旧代不同 → 同一 turn range 的 `loadWindow` 返回的 pageKey（`w:${snapshotIdentity}:${start}:${end}`，:619）随之改变。旧代 pageKey 的页若已被数据 LRU 逐出（messages=null，renderState='spacer'），用户滚回时 `rematerializeHistoryPage` 的 pageKey 守卫（`ConversationController.ts:363` `page.pageKey !== record.pageKey` → return null）必拒 → **永久空白 spacer，静默无诊断**（渲染层 `HistoryWindowRenderer.materialize/ensureMounted` 的同款守卫二次拒绝，`HistoryWindowRenderer.ts:472/499`）。

暴露面核实（本仓 3.1.5，HEAD 857bf9e5）：
- 换代而不 reset 页存储的唯一路径就是 `refreshHistorySearchSnapshot` 的交换临界区（switchTo/loadActive 均走 `windowRenderer.reset()`）。
- rewind 主路径安全：rewind 事务内 `windowRenderer.reset()` + 单一 memory-only 合成页（`ConversationController.ts:1079-1095`），旧代记录全部丢弃。**但** rewind 自愈 refresh 发生在 confirm 弹窗之前（:966 → :1018），用户取消弹窗则 refresh 已换代而 store 未 reset → 本 tab 留下 #7 暴露。fork 同理：resolver 在源 tab 换代（`Tab.ts:1113`），fork 后源 tab 保留旧代页存储。这两条残余路径与本方案同一修复覆盖。
- 触发频率：每次搜索面板打开的首个非空查询都会 refresh；仅当快照实际变化（acquireOutcome='rebuilt' 且身份漂移）才搁浅。cache_hit 时身份不变、pageKey 不变，无影响。

## 方案设计

### 方案对比

| 方案 | 做法 | 判定 |
|---|---|---|
| **A. 换代时全量 reset 页存储** | 交换临界区内 reset + 重建页 | **否决**。reset 丢掉全部高度/UI 状态/spacer 几何；重建要么用合成页（须标 memory-only 豁免逐出 → 数据 LRU 窗口化对已加载历史整体失效，12 页/32MiB 上限被击穿，属功能回退），要么对每个 loadedRange 跑 loadWindow（O(已加载页数) 的重物化塞进/围绕本应短小的 P1 交换临界区，且滚动锚定必然受冲击）。用户不滚回时白付全量代价。 |
| **B. 范围重取 + re-key（惰性愈合，推荐）** | 守卫从 pageKey 等值放宽为 **range 等值**；key 漂移但 range 相同 → 接受数据并把记录 re-key 成新代 key | **推荐**。滚回时才按需取数（常态零成本）；spacer 高度、uiState、renderState、pins 全保留；wrapper/spacer 原位不动 → 无滚动跳跃（复用既有 mount 锚点机制）。 |
| C. pageKey 去身份化（key 只含 range） | provider 侧改 key 格式，身份降为记录属性 | 否决。稳态与 B 完全一致（首访后各页都携带当前代身份），却要动 provider↔feature 的 pageKey 不透明契约与全量测试，无额外正确性收益——违背"复杂度须由不可替代的核心功能换来"。 |
| B'. 接受漂移但保留旧 key（数据换、key 不换） | — | 否决。key 成为谎言身份（内嵌已死的快照身份），调试误导，防碰撞靠 mtime 单调这种"碰巧成立"的不变量。 |

关键语义论证：pageKey 守卫真正要防的是 **loadWindow 返回的窗口不等于请求的窗口**（planner 预算收缩后 `actualStart/actualEnd` 可小于请求区间，`ClaudeConversationHistoryService.ts:583-594`）——这是 range 性质，不是身份性质。快照代际差异不是错误：交换后的 lease 就是唯一真相（与 3.1.4 设计"交换前 stale-but-consistent、交换后 fresh"同一条线）。range 等值即正确性边界。

### 改动点（文件:行级）

**commit 1 —— refusal 诊断先行（独立可回滚，先补可见性）**

1. `src/features/chat/history/HistoryDiagnostics.ts:12-31`：`HistoryDiagnosticEvent` 联合新增两 kind：
   ```ts
   | { kind: 'page_rekeyed'; pageKey: string; previousPageKey: string; turns: number }
   | { kind: 'page_rematerialize_refused'; pageKey: string; rangeStart: number; rangeEnd: number; actualRangeStart: number; actualRangeEnd: number }
   ```
2. `src/providers/claude/transcript/ClaudeTranscriptDiagnosticLog.ts:5-19`：`TranscriptDiagnosticPhase` 增加 `'page_rekeyed' | 'page_rematerialize_refused'`；`:21-57` `TranscriptDiagnosticEvent` 增加可选字段 `previousPageKeyHash?: string; rangeStart?: number; rangeEnd?: number;`（additive，磁盘 jsonl 只追加）。
3. `src/main.ts:64-83`：`mapHistoryDiagnosticEvent` exhaustive switch 补两 case（编译期白名单门禁，新 kind 不映射即编译失败）：
   - `page_rekeyed` → `{ phase, pageKeyHash: hashId(new), previousPageKeyHash: hashId(old), turns }`
   - `page_rematerialize_refused` → `{ phase, pageKeyHash: hashId(record), rangeStart, rangeEnd, turnCount: 实际返回页 turn 数 }`
4. `src/features/chat/controllers/ConversationController.ts:363`：现有 pageKey 不匹配分支先落 `page_rematerialize_refused` 事件再 return null（本 commit 内先只改诊断，行为不变）。

**commit 2 —— 结构修复（守卫放宽 + re-key）**

5. `src/features/chat/controllers/ConversationController.ts:339-373` `rematerializeHistoryPage`：守卫重写为——
   ```ts
   if (conversationId !== this.deps.state.currentConversationId) return null;   // 不变
   if (page.pageKey !== record.pageKey) {
     if (page.range.start !== record.range.start || page.range.end !== record.range.end) {
       recordHistoryDiagnosticEvent({ kind: 'page_rematerialize_refused', ...请求/实际区间 });
       return null;   // 残余洞：planner 收缩或快照分叉，显式拒绝并留痕
     }
     // 代际漂移：lease 已交换，同 turns 新身份。接受，交由渲染层 re-key。
   }
   ```
   后续 detail 加载与 `toPageInput` 返回不变（新 pageKey 原样返回）。
6. `src/features/chat/rendering/HistoryWindowRenderer.ts`：
   - `materialize`（:460-481）与 `ensureMounted`（:483-514）两处重复的内联 rematerialize 块收敛为私有 `acceptRematerializedPage(record, page, context)`：staleness 检查不变；`page.pageKey !== record.pageKey` 时校验 range 等值（防御性——controller 已过滤，不等值 return false），否则调 `rekeyPage` 后 `upsertPage`。
   - 新增 `rekeyPage(oldKey, newKey)`：`pageStore.renamePage` → wrappers map 换键 + 同一元素 `dataset.pageKey = newKey`（spacer 原位保留，高度不动 → 无滚动跳跃）→ `visiblePages`/`adjacentPages` 两 Set 同步换键（否则 `mountTargetPages` 按 Set 里的旧键查 store 永远 miss，挂载死锁到下一次 viewport 采样）→ 落 `page_rekeyed` 事件。
   - **陷阱（必须处理）**：两处 `.finally` 中 `this.rematerializations.delete(record.pageKey)` 读的是可变字段，re-key 后删错键 → 去重 map 泄漏。须在 promise 创建前捕获 `const requestedPageKey = record.pageKey`，delete 用捕获值；而 `unpin(record.pageKey, 'transaction')` 保持读活字段（rename 后解析到新键即原记录对象，pin 落在对象上，读活字段才能正确解除——若用捕获旧键 unpin 会 no-op，pin 永久残留 → 该页永不逐出）。
7. `src/features/chat/history/HistoryPageStore.ts`（`replaceMessage` 后，~:140）新增 `renamePage(oldKey, newKey): HistoryPageRecord | null`：`records` 换键（同一对象，`record.pageKey = newKey`，heights/uiState/renderState/pins/retention/tickets 全保留）；`tickets` map 随迁；新键已存在则返回 null（fail-fast）。
   - `upsertPage` 在 rename 之后执行时按新键命中 existing 记录 → retention/uiState/高度自动保留（既有语义，:77-90）。

不改：`state.messages` 合并（rematerialize 本就不触碰模型层，与现同键路径一致）；`loadedRanges`（range 不变）；live/memory-only 页（前者豁免逐出、后者首轮即拒，均不会走到 re-key）；i18n/Notice（纯诊断，无用户可见文案）。

### 与 rewind/fork 的交互结论（设计必答 5）

- rewind 主事务安全（reset 已覆盖）；**rewind 自愈 refresh 后用户取消 confirm**、**fork 源 tab 换代后不 reset** 是两条残余暴露路径，本方案惰性愈合覆盖，无需额外改动。
- refresh 期间在途 rematerialize 用旧 lease 取数返回旧 key → 与记录键匹配照常接受（stale-but-consistent，与搜索读同一容忍语义）；后续再逐出再滚回时走漂移分支 re-key，自愈收敛。

## 风险与权衡

- **re-key 簿记正确性**是本方案唯一实质风险点：store records/tickets、renderer wrappers/dataset、visiblePages/adjacentPages、rematerializations 去重键、transaction pin 解除，六处必须同步换键/正确捕获。测试清单 5-8 逐项覆盖；实现须按上文陷阱说明逐条对齐。
- **分叉重写场景**（外部 rewind 重写 transcript → 同 range 内容换血）：新页消息 id 与 `state.messages` 旧 id 分叉，DOM 显示新 id、模型留旧 id。接受：与换代后 loadOlder 分页既有语义一致（新 lease 是唯一真相），且该场景远比 append-only 稀有；不为此扩大战线。
- 拒绝分支仍留永久洞（range 收缩），但从静默变为留痕事件——矩阵 #7 的"先补诊断"诉求落地。
- `page_rematerialize_refused` 事件中的 pageKey 经 hashId 落盘（沿既有隐私约定，pageKey 内嵌本地 transcript 路径）。

## 验证方式

**单测（TDD，先红后绿）**

`tests/unit/features/chat/controllers/ConversationController.test.ts`（扩展 ~:1065-1094 describe）：
1. 漂移接受：`loadWindow` 返回 range 等值、pageKey 不同（`w:S2:0:5` vs 记录 `w:S1:0:5`）→ 返回非 null 页，detailLoaded 的 uiState 照常触发 `loadMessageDetail`。
2. range 收缩拒绝：返回 `{0,3}`（请求 `{0,5}`）→ null + `page_rematerialize_refused` 事件含请求/实际区间，且不调 `loadMessageDetail`。
3. 同键路径与 memory-only 拒绝回归不变（现有用例）。

`tests/unit/features/chat/rendering/HistoryWindowRenderer.test.ts`（沿 ~:169-188 harness 模式）：
4. processIntent 路径 re-key：evicted spacer 页 'old-key' → `rematerializePage` 返回 'new-key' 同 range → flush+reconcile 后 `store.peek('new-key')` mounted、`peek('old-key')` undefined、wrapper dataset 为新键、spacer 被页 wrapper 原位替换、`page_rekeyed` 事件落盘。
5. range 不等值页返回 → 维持 spacer、无幻影记录、materialize 返回 false。
6. ensureMounted（reveal/search）路径漂移 re-key：`revealMessage` resolve true，visiblePages 换键后再次 sampleViewport 仍 pin 新键。
7. 滚动锚定：re-key+mount 前后 viewport scrollTop 增量为 0（spacer 高度保留的直接断言）。
8. 去重/pin 陷阱：rematerialize 完成后 `rematerializations` 无泄漏条目、record.pins 无残留 'transaction'（对 :476/:504 两处 finally 分别断言）。

`tests/unit/features/chat/history/HistoryPageStore.test.ts`：
9. `renamePage`：字段（measuredHeight/uiState/renderState/pins/retention）保留、旧键消失、tickets 随迁、新键冲突返回 null。

`tests/integration/main.test.ts`（`mapHistoryDiagnosticEvent` describe）：
10. 两新 kind 映射：phase 正确、双 key 均经 hashId、数值字段透传。

**门禁**：`npm run typecheck && npm run lint && npm run test`。manifest 不动（随下个版本号）、不 build、不碰 .obsidian。

**真机人工核对（部署后）**：
11. >250 轮大会话：滚动制造 unmount+evict（>12 页）→ 开搜索面板首查（换代）→ 关面板滚回旧位置 → 内容重物化非空白；`.claudian/diagnostics/`（history-render channel）出现 `page_rekeyed`。
12. 换代后立即滚回：spacer 高度保持、无整屏白闪、无滚动跳跃。
13. rewind 自愈后取消 confirm 再滚回（残余暴露路径）正常；fork 后源 tab 滚回正常。

**回滚线**：commit 1/2 相互独立——revert commit 2 回到"拒绝但有诊断"状态；连 revert commit 1 回到原始静默状态。无持久化格式变更，诊断 jsonl 新 phase 为追加式，无读端契约。

**实施档位**：implementer-high（方案已到文件/行级，跨文件常规耦合，无剩余设计决策）。

## 关联

- 缺陷留档：[[2026-09-22-claudian-rewind-fork陈旧lease自愈方案]]（同族矩阵 #7、#12）
- 窗口化不变量与 P1/F5 交换协议：`src/features/chat/CLAUDE.md`
- 前序相关：[[2026-09-15-claudian-B4双轨统一与DOM窗口化整合实施方案]]、[[2026-09-15-claudian超大会话物化与渲染资源预算修复方案]]
