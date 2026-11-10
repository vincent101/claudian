---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task-1-brief.md
tags:
  - architect
  - claudian
  - codex
---

# Codex 正常历史读取证明与保存世代补接

## 背景与问题

任务 A 已批准真实关联文件 bytes 与可证明完整的历史规模；阻塞仅在 Codex 正常 hydrate 缺少可识别的读取证明，以及路径回填跨越 app 来源 key 时无法安全解除保存后的 stale 门。

本设计是原批准语义下的内部接线，不重做全案，不增加产品指标、不扩大展示 I/O、不扩展 OpenCode/SQLite。当前只读核查，无生产或测试实施，无测试运行。

### 已核实的前提〔既有读数：源码，非测试实测〕

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/history/CodexConversationHistoryService.ts`：126–256 行返回 `Promise<void>`；pending-fork 内存消息与 normal hydrationKey 命中会跳过；路径发现会回填 providerState。21–36 行已有读取前后 stat 指纹，108–123 行已有完整性与合并可辨识性缓存。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/history/CodexHistoryStore.ts`：1187–1211 行已有 `parseCodexSessionTurnsWithStatus()`，检查末尾换行、解析行遗漏及既有 payload 结构，不需要为本阻塞另建解析器。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationSizeService.ts`：已有 revision、saveEpoch、保存中门、来源捕获与请求合并；136–140 行的 `historyReady()` 目前先解除门，再刷新，不能直接用于携带来源变更的 Codex 证明。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts`：675–681 行已经读取 `ConversationHistoryHydrationResult`，非 ready 会抛既有加载异常；但没有 Codex size-ready 接线。`switchConversation()` 与 `getConversationById()` 共用此加载入口。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts`：392–400 行已有 ready/error 加载结果；580–583 行已允许 `void | ConversationHistoryHydrationResult`，不必把所有 provider 改成必返结果。
- Codex 的 `captureConversationSizeSource()` 当前不捕获两个 transcript root；但缺路径时正常 hydrate 依赖它们选源。应把这两个有限字符串加入捕获，不能只校验发现后的路径。

解层次检查：难点不是产品口径冲突，而是缺少“正常读取确实发生”的返回证据及其世代传递。现有解析完整性、指纹 stat、来源捕获和保存门能正向复用；无需新增索引、展示扫描或全局事件框架。

## 方案设计

### 1. 推荐与备选

| 方案 | 评价 |
| --- | --- |
| **在既有 hydration ready 结果中附带 sizeRead，主入口传递证明** | 推荐。复用既有返回契约，保留加载错误行为，四处生产文件补接即可。 |
| provider 独立发布统计 ready 事件，app 订阅 | 能实现，但需要订阅生命周期、调用与事件对应关系、去重；对这一处阻塞过重。 |
| 以每次 void/ready 返回或现存统计缓存推定“本世代已完整读取” | 不满足批准契约。缓存跳过、失败和旧世代均可被误盖章，拒绝。 |

### 2. 核心契约：加载 ready 与统计 complete 正交

修改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts`，保留既有顶层 ready/error 语义，为 ready 加一个可选字段，并为 hydrate 加可选第三参数。

建议的最小类型形态如下；名称可机械调整，语义不能删减。

```ts
export interface ConversationHistoryHydrationOptions {
  requireFreshRead?: boolean;
}

export type ConversationHistorySizeRead =
  | {
      status: 'complete';
      sourceRevision: string;
      sourceBefore: ConversationSizeSource;
      sourceAfter: ConversationSizeSource;
    }
  | { status: 'skipped' | 'incomplete' | 'unavailable' };

export type ConversationHistoryHydrationResult =
  | { status: 'ready'; sizeRead?: ConversationHistorySizeRead }
  | { status: 'error'; errors: Array<{ sessionId: string; message: string }> };

// hydrateConversationHistory 的返回类型保持不变。
// 仅增加 options?: ConversationHistoryHydrationOptions。
```

- `ready` 仍只表示既有加载流程没有报告加载错误，不代表完整历史。
- `sizeRead.complete` 必须证明**本次调用实际读取并完成正常归一化/合法 fork 合并**，不能从 `sizeStatistics` 命中或 `conversation.messages.length` 推导。
- `sourceBefore/sourceAfter` 是 provider 捕获的独立有限值快照；不得引用可变 providerState/forkSource，不含消息正文或 subagentData。
- `sourceRevision` 是此次实际读取、正常归一化与最终来源身份共同生成的 provider provenance；与随后 `readConversationSize()` 使用同一生成函数。
- 不在此结果复制 count/bytes。count 继续来自 provider 正常读取缓存，bytes 继续来自有限 stat；app 不计数。
- void、ready 无 sizeRead、以及三个负结果均不能解除保存后的 stale 门。OpenCode 无证明维持未知，不改其实现。
- Codex 路径缺失/部分解析等当前非抛错行为仍返回顶层 ready，并附负 sizeRead；不能把统计不可用变成新的阻断会话打开错误。

### 3. Codex：产生本次读取证明，保留原消息行为

修改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/history/CodexConversationHistoryService.ts`。

#### 来源捕获

在 `captureConversationSizeSource()` 51–63 行的白名单加入 `transcriptRootPath`、`forkSourceTranscriptRootPath`。保留 sessionId、resumeAtMessageId、threadId、两个文件路径及复制后的 forkSource；只复制有限字段，不遍历任意 providerState。

每次 hydrate 入口先捕获 sourceBefore。完成本次路径解析及回填后捕获 sourceAfter，再以最终来源生成统计 provenance。provider 内只允许下列来源细化进入 complete 证明：

- 未知 sessionFilePath/forkSourceSessionFilePath → 本次正常查找所得路径；已知路径不得悄悄换成另一文件。
- 未知 transcript root → 由实际路径派生的 root；原显式查找 root 不得被另一来源覆盖。
- 缺 threadId 时可回填已经确定的 conversation.sessionId；不得换逻辑 thread。
- sessionId、resumeAtMessageId、已有 threadId、forkSource.sessionId/resumeAt 不得因本次读取改变。

在本调用发现非上述变更时不给 complete。app 不理解 Codex 字段，只校验 provider 提供的前后有限来源与当前来源吻合。

#### 复用解析与统计缓存

把 `rememberSizeStatistics()` 从纯 void 调整为返回此次记账是否完整及 sourceRevision，或返回 `ConversationHistorySizeRead` 所需的等价小结果。它仍负责写原 `sizeStatistics`，不另建长期缓存。

complete 必须同时满足：

1. 该分支所需的全部来源已经实际读取，读取前后指纹稳定；不是缓存跳过。
2. 所有解析结果 complete；缺行、结构检查失败或未完成 JSONL 尾行均不成立。
3. pending fork 找到 resumeAt；established fork 找到 source checkpoint，且原合并可辨识性检查通过。
4. 使用的来源集合与该分支 `readConversationSize()` 需要的集合一致：普通会话一个原生文件；pending fork 一个 source；established fork source＋native。物理去重只影响 bytes，不删除逻辑来源角色。
5. sourceRevision 在路径回填之后、依据实际文件指纹及当前分支身份生成。

特别注意：现有 established-fork 缺任一文件时可能落入 Normal hydration。可保留其原消息加载退化行为，但**不能把 fork 原生文件单独读取包装成完整 fork 证明**；此路径 sizeRead 必须 unavailable/incomplete，不能记完整统计。

| 本次路径 | sizeRead | stale 门 |
| --- | --- | --- |
| 普通会话真实读取，解析完整且指纹稳定 | complete | 交 app 再验；不能由 provider 自行解除 |
| pending fork 实际读取 source、checkpoint 存在、解析完整稳定 | complete | 同上 |
| established fork 两端完整稳定、合法合并 | complete | 同上 |
| normal hydrationKey 命中而没有重新读取 | skipped | 不解除 |
| pending fork 保留已有内存消息的早退 | skipped | 不解除；不把内存长度认证为历史规模 |
| 未发现路径/读失败/缺所需来源 | unavailable | 不解除 |
| partial、skip line、结构不完整、缺 checkpoint、不可辨识合并、读取期间源变动 | incomplete | 不解除 |
| 真正已读取且稳定的 0-byte 空文件 | complete，原缓存 count=0 | 可以验后发布 known；与冷 messages=[]、读取失败严格区分 |

`requireFreshRead=true` 仅在**已有正常历史加载调用**中绕过 normal hydrationKey 跳过条件，使保存后的下一次正常打开/重载实际读取一次；不新增调用入口、不从 hover/重绘调用 hydrate，不为保存完成主动 hydrate。

pending-fork 已有内存消息的保留分支仍返回 skipped，不因 size 功能改变其消息语义。下次本来就会读取 source 的正常路径可产生证明。正常 cache miss 与 established fork 的原读取路径照常产生证明，不能一律降级未知。

真实空文件即使走现有 `sdkMessages.length===0` 早退，也必须返回之前已得到的 complete 证明，不能以消息长度判断成功。读失败的空数组则永不 complete。

### 4. App：来源细化不等于重新捕获当前世代盖章

修改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationSizeService.ts`。

#### 最小接口补接

- 增加只读 `requiresFreshHistoryRead(id): boolean`：读取 awaitingHistoryReady 状态，无 I/O。main 与 captureHistoryGeneration 在同一段无 await 代码中调用。
- 在既有 `historyReady(id, generation)` 上加可选第三参数，仅接受 sizeRead 的 complete 分支。旧两参数调用保持既有 index-ready 行为；新增证明分支不按 providerId 分流。
- 抽取现有 JSON 来源 key 构造为内部复用函数，使 proof.sourceBefore/proof.sourceAfter 与 captureSource 使用完全一致的 id/providerId/vaultPath 包装及有限字段序列化。不能另建字符串近似比较。

#### 证明接纳顺序

1. generation 必须在 hydrate 前捕获。缺 generation 不接纳证明。
2. live conversation 必须存在；main 另检查对象身份未被替换。
3. 不在保存中；当前 revision 和 saveEpoch 必须与**开始时** generation 完全相同。保存成功、失败及开始后尚未结束都会使跨越它的旧证明失效。
4. 以当前固定 id/providerId/vaultPath 包装 proof.sourceBefore，必须等于开始时 sourceKey。
5. 同方式包装 proof.sourceAfter，必须等于当前实际有限来源 key。
6. 只用开始时 revision/saveEpoch＋校验过的 sourceAfter key 创建来源细化后的 generation；不得重新 capture 一个新 revision/saveEpoch 再给旧结果盖章。
7. 接纳后同步 invalidate 一次，建立本次 proof-aware refresh。证明与此次 refresh 的新 revision、原 saveEpoch、sourceAfter key 绑定。

#### 延迟解除 stale：必须等最终 stat 与持久化都校验通过

现有 historyReady 的“先 delete awaitingHistoryReady，再 refresh”不能直接用于证明分支。证明分支须把 expectedSourceRevision 作为**该请求**的内部参数传给 refresh/performRefresh，不作为永久全局许可。

- `readConversationSize()` 仍只读取已完成 provider 缓存并 stat 显式有限路径。
- 除既有 id/revision/source/saveEpoch 校验，返回值必须为 known history，且其 sourceRevision 与本次 complete 证明严格相等，才能绕过 stale 降级。
- sourceRevision 不同、history unknown、请求抛错、统计持久化失败或世代改变：不解除 awaitingHistoryReady。可按原请求契约发布 bytes＋未知历史；绝不发布本次未经证明的 known。
- 对候选 known 先按既有 metadata-only 路径持久化；最终 isCurrent 再次成立后，在无 await 临界区解除本 id 的门并更新 snapshot/onPublished。
- proof-aware 请求合并必须包含 expectedSourceRevision。普通请求不能把证明请求吞并成无证明请求，也不能继承另一证明的许可；迟到请求的 finally 仍只删除自己。
- 证明不可跨 revision/saveEpoch 或在另一请求复用。后续新保存重新加门，旧 provider 缓存即使指纹未变也不能凭旧证明解除。

旧 Claude index-ready 两参数路径不在本次重设计范围内。新增证明路径的 final-stat/持久化校验独立，不能为了这次补接放宽现有 isCurrent。

### 5. Main：正常加载完成后转交证明，不直接 publish

修改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts` 的 `loadSdkMessagesForConversation()` 675–681 行。

顺序固定：

1. 保留 acquireHistoryIndex/no-hydrate 的现有早退。
2. 无 await 地捕获本 conversation 的 generation 与 requiresFreshHistoryRead，保存传入 conversation 对象引用。
3. 调用现有 hydrate，传入可选 `{ requireFreshRead }`；不新增 provider-id 判断。
4. 保留当前非 ready 结果抛 ConversationHistoryHydrationError 的逻辑。
5. await 返回后，`getConversationSync(id) === 原对象` 才能处理 size 结果；删除或同 id 对象替换直接丢弃。
6. 仅 `result?.sizeRead.status === 'complete'` 调用 proof-aware historyReady，传**开始时** generation 与本次证明。它负责 stat、持久化及 onPublished；main 不直接写 snapshot，不因 ready/void 清门。
7. 对 skipped/incomplete/unavailable/void，可走普通 refresh 更新 bytes/未知状态；普通 refresh 的原 stale 门照常生效。不得为得到统计结果重试 hydrate。

这让 `switchConversation()` 与 `getConversationById()` 两个入口自动获得同一机制。publish 仍由 app 完成，经既有 view 绑定检查和 rAF 更新真实 TabBar；不改 TabBar/formatter/UI 口径。

### 6. 推演

以下均为〔纯示意〕设计走查，数字是锚值，不是运行结果；最终有效性须由受控测试确认。

#### 具象：来源回填与跨步骤衔接

对象 C 的开始来源为 thread=T、path 未知；generation 为 `(revision=4, saveEpoch=2, sourceKey=K0)`。正常加载找到 `/tmp/.../T.jsonl`，稳定指纹 F，得到 2 messages；provider 回填 path/root，返回 `before=K0 对应字段、after=K1 对应字段、sourceRevision=R(F,T)`。

| 场景 | 新方案结果 | 红绿判据 |
| --- | --- | --- |
| live 来源 K1，revision=4、epoch=2，最终 stat 仍 F | 来源细化接纳；新 revision=5 的 proof-aware read 返回同 R，持久化后 known=2 | 绿：回填路径不造成永久 stale，且未换保存世代 |
| await 期间 beginSave：epoch=3；即使该保存失败、revision 仍4 | 丢弃旧证明，不能清门或发布此候选 known | 绿：不能只检 revision |
| await 期间保存成功：revision=5、epoch=3 | 丢弃开始世代证明 | 绿：不能重捕当前世代把 R 盖章 |
| 中途同 id conversation 被替换 | main 对象身份校验失败 | 绿：结果不得落入新对象 |
| 中途 fork checkpoint 改动，live 来源 K2 | after 与 live 不等，丢弃 | 绿：不能只认可 path 回填 |
| 证明后最终 stat 变成 F2 | 旧 R 与 readConversationSize 不匹配，保持未知/stale | 绿：解除门不能只看调用完成 |

#### 具象：默认值与缓存跳过

保存前缓存是 count=2。成功保存后 revision 从0变1，epoch 从0变1，门已加上；state.messages 仍非空且 hydrationKey 相同。

- 旧情况：normal hydrate 跳过；void 若被当 ready，可把旧 count=2 盖成 revision1 known，红。
- 新情况：这次正常加载收到 requireFreshRead=true，实际读取文件中 3 条归一化消息；complete 证明与最终 stat 一致才发布 count=3，绿。
- 若文件不可读：返回 unavailable，bytes 可仍经 stat 得到，history 保持未知，绿。
- 若未发生任何正常加载、只有 hover：只 stat/缓存校验，保存门不解除，绿。冷/过期历史待更新仍是批准边界。
- requireFreshRead 默认 false：未保存时保留原 normal 缓存跳过；skipped 不提供新证明。已有完整来源缓存可以按原读取契约继续使用，但不能因此解除保存门。

#### 抽象：论证链与反例

前提：本次实际读取全部所需来源＋解析完整＋指纹稳定＋合法分支合并；推理：provider 可记录该来源版本的归一化 count；再加开始/完成同保存世代及最终 stat 与证明同 sourceRevision，才可把该 count 发布于 app 新 revision。

具体反例：hydrate 返回后另一个写入把文件从 F 改成 F2。它推翻“此次 provider 缓存仍代表最终来源”的推理；最终 stat/sourceRevision 比较必须阻止 known。故 complete 返回本身不能直接清门。

已批准语义不翻案：原 A1 的完整性、保存失效及展示无扫描要求不变；前向反事实是若删掉保存 epoch 或最终来源校验，上述失败保存/外部写入案例会再次误发布。

#### 抽象：结构不变量

| 不变量 | 判定与位置 |
| --- | --- |
| 加载状态与统计完整性正交 | 成立：顶层 ready/error 与可选 sizeRead 分离；partial 不引入新加载失败 UI。 |
| 数据流无环 | 成立：正常 hydrate → provider 证明/缓存 → main → app stat/persist/publish → 既有 view；refresh 永不回调 hydrate。 |
| 扩展点在扩展方向 | 成立：证明与可选 options 落既有 provider-neutral seam；app/main 不识别 Codex 文件字段。 |
| 退化情形是一般情况特例 | 成立：未实现/无证明＝未知；普通分支一个来源、fork 多来源共用证明规则。 |
| 多入口覆盖 | 成立于设计：switchConversation/getConversationById 共用 main；列表与 tab 展示只消费已发布值；需集成测试验证真实接线。 |

## 风险与权衡

- 这不是产品重新裁决：已批准“只复用正常读取”“skip/partial 未知”“保存后不能旧世代盖章”；本方案只是使这些语义有可检查的接口。
- 保存后的下一次**既有正常加载**会绕过一次 normal 消息缓存，可能增加该次正常加载的读取耗时；不增加展示扫描、后台轮询或自动 hydrate。这是实现可信正常读取所需的内部行为，不承诺每次 hover 实时 count。
- pending-fork 已有内存消息早退仍不认证，避免为了统计重写原消息语义；既有 source 实读路径仍能发布，不把所有 Codex 永久设为未知。
- 现有 parser 的 complete 是既有格式与结构检查下的证明，不是对任意未来 Codex 格式的全知保证。本轮复用已新增检查，不弱化、不扩成格式研究；若针对受控有效格式的验收发现仍有真实遗漏，再按具体遗漏停下修正前提，不能用 ready 掩盖。
- 来源白名单补入查找 roots 会令某些旧来源 key 不匹配，这是安全失效，不迁移旧缓存为新证明。sourceRevision 的生成须与读缓存保持同一函数；本轮不另改统计单位或创造新 provenance 口径。
- stats 验证/持久化失败不得变成新增会话打开异常；main 继续保留仅由既有 hydration error 决定加载失败的语义。
- **用户必须重新裁决事项：无。** 若实施要求“保存一完成就保证 known”或“pending-fork 内存早退也保证 count”，则超出本案：前者需新增主动读取，后者需新增内存/磁盘口径；两者均不得顺手实施。

### 交付物规范

根目录：`/Users/vincentwang/Documents/NoteVault/tools/claudian`。本方案修改既有 source/test，不新增生产模块或测试目录。

#### 目标目录树（本次新增文档）

```text
/Users/vincentwang/Documents/NoteVault/tools/claudian/
└── docs/designs/
    └── 2026-11-06-codex-ready-unblock.md
```

请求的机械交接副本目标为 `/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/codex-ready-unblock.md`；当前 architect 受仅可写自身 designs 记录的角色约束，不在该目录写文件。主会话如需此副本，可依据同一设计记录机械落盘；这不是未解决的产品裁决。

#### 命名与索引

- 设计记录沿用已有 `docs/designs/YYYY-MM-DD-主题.md`；日期由本轮 `date` 得到 2026-11-06，新记录 draft，不改旧记录/status。
- `.context` 副本的 `codex-ready-unblock` 表示任务 A 的单处阻塞补接，不是新 plan/全案替代。
- 长期设计记录索引可登记于 `/Users/vincentwang/Documents/NoteVault/tools/claudian/README.md` 的产物索引；当前 README 没有专门设计索引节。该登记不在本轮允许修改范围，交主会话另行处理，不要求实施者为这次补接扩大生产 diff。

#### 小范围 source/test 清单与消费者

以下路径均锚定绝对根；实施只修改表内相应接线，不重排其他任务改动。

| 路径 | 改动点/用途 | 消费者 |
| --- | --- | --- |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts` | 可选 sizeRead 证明、可选 requireFreshRead 参数 | main、app、provider，实现者及类型检查 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/history/CodexConversationHistoryService.ts` | finite root 捕获、各退出结果、本次 complete 证明、正常缓存绕过 | main；readConversationSize 原缓存消费者 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationSizeService.ts` | 来源细化校验、proof-aware refresh、最终核验后清门 | main、metadata、既有 onPublished |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts` | 开始世代/options、结束对象校验、转交证明 | switchConversation/getConversationById 的正常加载 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/codex/history/ConversationSize.test.ts` | 真实受控文件证明/失效/禁止展示 DFS | 实施者、独立复核 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/codex/history/CodexConversationHistoryService.test.ts` | freshRead 绕过与旧 pending/messages 行为兼容 | 实施者、独立复核 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/app/ConversationSizeService.test.ts` | 前后来源、saveEpoch、最终 stat/persist、合并竞态 | 实施者、独立复核 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/conversationSize.test.ts` | 真 main 正常加载→provider→app→metadata→view rAF→TabBar | 任务 A 验收 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/main.test.ts` | 可选补无证明 ready/void 与 error 原行为；不 mock 统计主链 | 若前一集成测试未覆盖兼容性时使用 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-06-codex-ready-unblock.md` | 本次新 draft 设计记录 | 主会话、implementer、方案复核 |

只读复用且不要求修改：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/history/CodexHistoryStore.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/utils/conversationSizeSource.ts`。OpenCode、Claude index、storage schema、UI、i18n、配置、代理和旧 confirmed 设计不在本补接改动范围。

#### 归属引用

沿用 `/Users/vincentwang/Documents/NoteVault/tools/claudian/CLAUDE.md` 的 `.context` 非提交交接约定与镜像 tests 约定，以及 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/CLAUDE.md` 的 provider-neutral seam 和 opaque providerState 边界。设计记录沿用本项目已有 `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/`。

偏离声明：当前 agent 不写 `.context` 副本、不回填 README、不改业务/source/test；唯一新增是自身设计记录。

## 验证方式

所有下列内容为移交验证靶子，**本轮未执行测试，不宣称通过**。仅使用独立 `/tmp` fixture；正常 discovery 测试必须显式传入受控 root 或像已有测试一样 mock homedir 到临时目录，不访问真实会话/秘密。

### 红→绿用例

1. **正常可用能力**：两条有效归一化消息＋终止换行，真实正常 hydrate 返回 complete；readSize 返回 messages count=2 和真实 bytes，证明 sourceRevision 一致。
2. **保存后缓存跳过**：先 hydrate=2，成功保存后同 hydrationKey、messages 非空；受控文件改成3条；经生产 main 正常加载，requireFreshRead 使实际读取，最终 metadata/TabBar 得到3，不是永远 stale。
3. **路径回填**：只有 thread＋受控 transcript root，正常发现 native/source 路径；before/after key 确实不同，同保存世代可发布。展示独立 spy 证明不调用 find/hydrate/parse。
4. **负结果**：cache skipped、缺路径、权限/读失败、malformed JSON、无尾换行、结构不完整、缺 checkpoint、缺 fork source、无稳定 turn identity，逐一断言不能解除保存门；尤其 established fork 退化加载不能认证 native 为完整 branch。
5. **空文件**：实际稳定0 bytes ⇒ known bytes=0/count=0；cold messages=[]、读失败[]、partial[] ⇒ history unknown；保留现有“空文件之后写入可重新 hydrate”行为。
6. **保存世代**：deferred hydrate 返回期间 beginSave，覆盖失败保存（revision可能不变但epoch变）、成功保存、保存尚未完成；旧证明均不得清门。重捕当前 generation 不能被实现当作替代旧 generation。
7. **来源/对象变化**：hydrate await 期间改 checkpoint/root/provider source、删除或同 id 替换 conversation；不得落入新对象或清门。
8. **最终文件新鲜性**：complete 证明之后、readSize stat 前改文件；sourceRevision 不同 ⇒ unknown/stale。统计持久化被挂起时再 beginSave 或改 source，最终不能 publish candidate known。
9. **失败持久化**：proof-aware refresh 写 metadata 抛错，门仍在；下一次普通 refresh 不能凭旧缓存发布 known。
10. **请求合并**：普通 refresh、proof-aware refresh、两次 normal load 交错，许可不跨请求/世代；旧 finally 不删除新请求。只保持既有最大两并发 provider read。
11. **真实 UI 链**：扩展已有 integration fixture，把无效 `abcdef` 换成受控有效 transcript；走真实 Controller.save → main.switchConversation/getConversationById → Codex → app → SessionStorage → view rAF →真实 TabBar aria-label。切到第二 tab 后第一 id 的结果不得污染第二 tab；只 mock 存储适配器/时钟/受控延迟，不 mock 被测 historyReady/readSize/publish 行为。
12. **兼容性**：顶层 ready 无 sizeRead、void 不新增加载异常且不清门；既有 error 仍按原加载异常路径处理；不读 OpenCode 源码或扩展 SQLite。

### 精确运行范围（交实施阶段）

在 `/Users/vincentwang/Documents/NoteVault/tools/claudian` 下逐个显式路径执行，先新增用例红，再补接，再重复绿；绝不只有 `--selectProjects unit` 就运行。

```bash
node /Users/vincentwang/Documents/NoteVault/tools/claudian/scripts/run-jest.js --selectProjects unit --runInBand --runTestsByPath /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/codex/history/ConversationSize.test.ts /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/codex/history/CodexConversationHistoryService.test.ts /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/app/ConversationSizeService.test.ts

node /Users/vincentwang/Documents/NoteVault/tools/claudian/scripts/run-jest.js --selectProjects integration --runInBand --runTestsByPath /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/conversationSize.test.ts
```

若新增 main 兼容性用例，再单独指定 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/main.test.ts`，不能扩成全部 integration。

类型/lint 门禁由当前 implementer 负责，不在本只读设计轮重复运行；后续验证应保留 `npm run typecheck`、针对本清单的 ESLint 与 `git -C /Users/vincentwang/Documents/NoteVault/tools/claudian diff --check` 结果。不得 build、部署、重载、提交或跑全套。

人工核对：所有 known 必须能追溯本次完整实读 provenance＋最终 stat；所有展示调用链无 find/hydrate/build/全文迭代；保存世代不能靠后来 capture 覆写；新 proof 分支不放宽旧 index-ready 接线。

## 关联

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task-1-brief.md`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task-1-report.md` 7–18 行
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/CLAUDE.md`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/CLAUDE.md`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/CLAUDE.md`
