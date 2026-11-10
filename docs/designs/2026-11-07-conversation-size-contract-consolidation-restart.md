---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - claudian
  - conversation-size
  - lifecycle-contract
---

# A 会话体量：统一完整性、许可与旁路生命周期契约

## 背景与问题

A 的多轮补接仍把加载 ready、统计完整、对象身份、持久化成功和 UI 可见性混作许可，导致误报完整、旧对象回写及统计阻塞业务；本案上移统一契约，不继续堆顺序 if。

**路径：理想。状态：独立 draft；不是实施批准，也不是 A 验收通过。**

- 本次派单指定的新文件名优先于旧 brief 的默认文件名。只新建本记录，不合并、覆盖或 supersede 任何旧设计。
- 旧 ac82 任务终止状态仍为 **UNKNOWN**。新代理未恢复、联系或确认其停止；重派门禁已由本次派单明确放宽，不再以确认旧任务停止作为本次设计的前置条件。
- 落盘前两次检查：本目标不存在；`/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-06-conversation-size-contract-consolidation.md` 与 `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-07-conversation-size-contract-consolidation.md` 亦未出现。这只是检查时点的文件事实，不证明旧任务停止。
- 本轮只读源码、需求、设计与冻结材料，执行只读哈希核对；不运行测试、构建或宿主。不读真实聊天、秘密、用户配置或 agent output_file；不派子代理，不提交、push、部署、reload、worktree。
- B 共享冻结保持不变。不审查或改造 B 的 Markdown 计量、渲染、windowing、renderTarget、隐藏 tab 卸载、live/stored lease 或 projection FIFO。

**2026-11-07 授权订正（A–D）**：用户选择「按建议订正（推荐）」——「保留现有删除语义；补原身份绑定及同口径比较；只改两份草稿，不实施」。本次只增量订正本稿与隔离持久化稿，status 均保留 draft，无新产物。下列初稿建稿/哈希记录是既有事实，不是本次重测；本次新增判断仅为源码核对与时序推演，行为测试仍待实施。用户「同意重划统计提交边界」已授权另设计 U1-c；具体隔离方案仍未批准，组合规则见该稿 §12，不把本稿原 overlay 约束当作组合终态。

**2026-11-07 授权订正（删除后 UI 复位）**：主会话建议「补充专门的删除后复位路径：不再保存旧会话，并校验原标签绑定身份；同时保留普通新建会话的先保存行为」，用户原话「按建议」。本次按务实路径仅订正本稿与隔离持久化稿的衔接、必要生产/测试范围及一致性；不改变既定存储、provider 删除、性能或方案取舍，不改 frontmatter/status，无新产物。下述新增源码判断均为〔既有读数〕，推演不是行为实测。

### 1. 证据基线与强度

源码根：`/Users/vincentwang/Documents/NoteVault/tools/claudian`。

冻结根：`/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task1-ready-r0-snapshot`。

- 〔实测：只读哈希〕冻结 `manifest.json` 的 **39/39** 路径与清单一致；现工作区对应 **39/39** 路径亦与冻结哈希一致。不能把 39 个快照路径当作所有测试均已冻结或通过。
- 〔实测：只读 Git〕Claudian HEAD 为 `cf47730d2109e798fd27ddacc712038d26883d5b`，分支为 `fix/model-identity-sorting`。工作区包含既有 A/B 未提交改动；本案不重置或清理它们。
- 〔实测：只读 Git/哈希〕下面四个快照外邻接文件与同 HEAD 一致，核查时 SHA-256 如下。它们不是误称的 snapshot 文件。

| 邻接文件绝对路径 | SHA-256 |
| --- | --- |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkBranchFilter.ts` | `a6e18fd7083444a1ed3b7cbc39651068d0cc7f26ef697bb1f85a391704cc9de0` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/storage/VaultFileAdapter.ts` | `b1821fe845fa3325bf0886a0a0339af26da5e720346d47131a3a527c15abd90c` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/types/providerState.ts` | `35e23925ad414d9451c7b95f79a248bbd1d6d97b765a79b6034ef631c5f0c43c` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/types/index.ts` | `72fb997d17a0eb269cc65b78215d6393f8f8ce789a544fcd7719a973d1c4faad` |

以下实现判断来自实际阅读的源码，标为〔既有读数：源码〕；R0 的受控运行结论只作〔既有读数：报告〕，本轮没有重演或把它们冒充本轮实测。

### 2. Finding 逐项核对与映射

| 编号 | 已核对实现与具体失败链 | 设计落点 | 授权归类 |
| --- | --- | --- | --- |
| F1 / R0-1，P1 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkBranchFilter.ts:164–185`：无分支且缺 anchor 时回退全 conversationEntries；有分支而 anchor 不在 latest ancestry 时保留 latest leaf。`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeTranscriptHistoryIndex.ts:719–748` 没有输出分支认证事实。`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts:410–419` 仅由 missing/partial/skipped 三计数判 complete，`:169–175` 据此 known。正常 fallback 与统计证明缺了一道独立门。 | 同一分支算法旁出认证事实；统计 complete 增加分支证据，正常输出不变。 | 原 A 完整性正确性修复。 |
| F2 / R0-2，P1 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/history/CodexHistoryStore.ts:1155–1163` 只验证 message content 元素是对象。`:412–420` 将缺失/非字符串 text 变成空串；`:733–771`、`:950–993` 及 `:1298–1315` 可不产出消息。`:1187–1211` 仍把结构检查结果带作 complete；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/history/CodexConversationHistoryService.ts:344–356` 可以记 count=0 的 complete。 | 完整性由实际归一化损失审计产生，不由外层对象检查推定。 | 原 A 正确性修复；不新增非文本消息计数口径。 |
| F3 / R0-3，P1 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationSizeService.ts:159–169`：旧两参数 ready 在 refresh/stat/ack 前删除 awaitingHistoryReady 并 invalidate。之后 skipped/reject 不恢复门；普通请求可重新使用旧 cache。 | 两参数 ready 仅通知；所有清门都须完整 receipt、written、最终 stat 与最终校验。 | 原 A 正确性修复。 |
| F4 / R0-4，P1 | 同文件 `:104–125` 的 generation 没有原对象/注册实例；两参数 ready 不传 expectedConversation。`:174–191` 的 proof 分支也在返回时取得 liveConversation，而非固定开始对象。`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts:282–292` 等旧回调只带 ID/generation。因此同 ID、同 source、同数值世代的替换对象可接收旧回调。 | 不可换绑的 owner incarnation；正常读取许可、保存 ticket、候选、发布缓存均绑定它。 | 原 A 对象/世代正确性修复。 |
| F5 / R0-5，P1 | 同文件 `:145–156` 的 finishSave await refresh；`:233–259` 两槽与 waiting 数组可永久等待。`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts:1333–1341` 的 finally await finishSave；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts:675–689` 两种正常加载结果都 await stats；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts:549–550,1375–1381` 等业务保存。另有同 ID overlay 真正占住 metadata FIFO 的不同问题。 | 业务完成与统计 job 脱钩；逻辑需求与实际占槽分开；共享 FIFO 的不可兼得边界单列 U1。 | 移除完成后统计依赖属原 A；无条件同 ID 保存非阻塞必须裁决 U1。 |
| F6 / R0-6，P1 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationSizeService.ts:133–136` 仅删 cache、不通知；`:279–286` 只有 ack written 后通知。`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ClaudianView.ts:449–470` 依通知安排 rAF。所以失效后 stat/persist 挂起或负 ack 可让已画出的 known 不变。 | 同步失效事件与正值提交事件分离；tab/menu 从当前负状态重绘，不等候选成功。 | 原 A 正确性修复。 |
| F7 / R0-7，P2 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ClaudianView.ts:188–190` 切 tab 无条件更新菜单；`:535–548` 调真实 controller；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts:1514–1558` 对每行 refresh，visible 只在结果返回时检验，未在请求时拦截。view 与 controller 还各有开关菜单路径。 | 容器所有者管理一次可见性 session；关闭不发/不留逐行需求；结果与 UI 入口绑定。 | 原 A 可见性与资源正确性修复。 |
| F8 / peer 白名单补充 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts:127–136` 展开整个 forkSource；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/types/providerState.ts:12–16` 只是 cast，没有净化。对象展开会读取额外 enumerable getter；抛错时 app `captureSource` 的 catch 返回 null，合法来源也不能统计。额外字段变化还可能改变 sourceKey。源码足以确认多读字段；getter fixture 本轮未跑。 | 只显式读 forkSource.sessionId/resumeAt；app 不再展开整个 Conversation。 | 原 A 来源白名单正确性修复，不是读取真实秘密或扩展 provider state 的授权。 |

本次订正另核实〔既有读数：源码，未跑行为〕：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkSessionPaths.ts:56–66` 捕获 unlink 异常；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts:850–860` 直接等待该 best-effort 方法。`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/history/CodexConversationHistoryService.ts:364–369`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/history/OpencodeConversationHistoryService.ts:59–64` 均保留原生历史。物理删除失败不等于业务 Promise reject。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts:752–788` 按 ID 找对象，手工 rename 跨两个 await；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/InputController.ts:1375–1441`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts:1953–2015` 在标题异步完成后再按 ID load/写。同 ID 且同 title 的新记录可通过旧检查，进入 main 才发行 ticket 已太晚。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationSizeService.ts:273–284` 在持久化前降级 history；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts:169–176` 可在来源未变时持续返回缓存 known。最终 stat 必须与降级前原始 observation 比，不能与门投影混比。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts:391–418` 全量替换列表，`:397` 与 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/SessionStorage.ts:133–145` 均以 `providerId ?? DEFAULT_CHAT_PROVIDER_ID` 默认 Claude。列表缺行不能抹去枚举后新建的 ID；资格探针须采用同一默认口径。

本次删除后复位另核实〔既有读数：源码，未运行测试〕：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts:726–749` 在 provider、metadata 两个 await **之后**才按 ID 枚举 tab，先裸调 `cancelStreaming()` 再 await `createNew({ force: true })`；同 ID 新登记/新 UI 绑定可被误选。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts:162–258` 的 force 只放宽 streaming guard，不越过 creating/switching guard；有消息时 `:188–189` 仍先 await save。原 origin/handle 在 delete 开始已退役，不能让此保存变成 written；`runStoredTransaction :430–440` 仅比较请求时 ID，复位清 ID 后捕获 null，取消等待返回 null 后原方法仍继续清输入/回调/finally。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts:1324–1428` 装配真实 controller；S2 钩子负责 turn lifecycle、auto projection 和 render-flush 失效，`onNewConversation` 会 cleanup 当前 runtime、改 tab 绑定/模型/搜索 UI。`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts:269–272,726–767` 存在 ID 同步与 token 化 open claim；claim 能防旧 release，但未覆盖 lazy binding、同 ID 同 claim 重绑或 reset continuation。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/services/SubagentManager.ts:673–693,790–801` 的 orphan 会同步发 onStateChange；`Tab.ts:1299–1318` 此回调会先按当前 ID merge，非 streaming 时再调 save。只删除 createNew 内的显式 save 仍可能产生删除后写入。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/rendering/ProjectionWriteCoordinator.ts:103–115,217–279` 在取得 grant 时检查取消，但 grant 之后至 task 开始仍有 Promise 续体；不是整段 UI reset 锁。`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/AutoTurnProjectionController.ts:548–557` 的 invalidate 释放其实际 auto live lease；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/InputController.ts:1454–1507,745–781` 的 cancel/watchdog 不证明 user live lease 已释放，后者仍由原 finally 处理。不得把取消旗标、token 或 JS 单线程等同于实际 projection 可立即提交。

R0 对 typed ack、FIFO 的正面判断不撤销：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/SessionStorage.ts:21–29,49–80` 确实已有同 ID 排队、读前/读后 isCurrent、written/skipped 及异常 reject。新设计直接复用，不重造存储确认机制。

## 方案设计

### 1. 解层次与方案选择

**上层检查**：只做 stat、全设 unknown 或取消完整历史指标，会让部分难点消失，但改变原 A 产品，不是本次可擅自选择的解。把完整性失败改成会话打开失败，也违背“正常加载兼容、统计严格”的边界。

**下层检查**：同一不可取消 overlay I/O 与同 ID FIFO 的矛盾不在 ready 函数内；不能用 Promise.race、提前释放槽、换 key 或提前报 save 成功掩盖。存储触发/排序边界须交用户裁决，见 U1。

| 做法 | 权衡 |
| --- | --- |
| **统一 provider-neutral 证据 + app owner/许可状态机 + 现有 UI 生命周期** | 推荐。算法和来源仍由 provider 拥有；app 只授权、排序、失效与发布。现存 stat、索引、归一化、ack、FIFO、rAF 都能正向复用。U1 未裁决前不能宣称满足无条件非阻塞。 |
| 新建全局 provider-ready 事件总线/全局会话状态框架 | 不推荐。仍需相同证据和身份协议，却另增订阅、重放、去重及生命周期真相源；不能解除底层 FIFO 的挂起。 |
| 继续给旧两参数 ready、各加载入口逐处加 if | 拒绝。许可仍可因捕获/完成时点不同而漂移，不能证明全入口正确。 |

不新建第二套 provenance 或分支/归一化算法；不扩成性能期 1–4、新轮询、强制 hover hydrate、新依赖、SQLite 或跨进程存储根治。

### 2. 单向数据流与四个独立问题

正常业务流保持原形：

```text
正常 acquire/ready/loadWindow 或 hydrate/归一化
  → 原业务恢复、快照交换、加载成功/失败
  → 同步转交 size receipt/许可（不 await stats）

统计旁路
  → 有限来源 stat / 已完成 cache 或持久证书校验
  → 候选校验 → metadata-only typed ack → 最终 stat
  → 无 await 最终检查、清门、发布
  → 现有 view rAF 从当前 getter 取值
```

| 问题 | 唯一所有者 | 不能代替它的信号 |
| --- | --- | --- |
| 这份历史是否完整、属于哪一逻辑分支？ | provider 的正常索引/归一化证据 | ready、cache_hit、messages.length、窗口范围、旧 messageCount |
| 这次结果是否获准用于当前对象/世代？ | app 的 owner + 正常读取许可 | 同 ID、同 sourceKey、完成时重新捕获 generation |
| 本次候选是否真的完成持久化且仍有效？ | storage typed ack + app 最终核验 | resolve void、written 单独成立、排队即成功 |
| 这个 UI 是否仍有权接收结果/发请求？ | 实际容器/tab 的可见性与绑定 session | DOM 行仍存在、数值 epoch 恰巧相同、当前 active ID 单独相同 |

失效是另一条同步通道：`状态撤销 → unknown/stale → onChanged → 既有 rAF`，不走候选持久化，也不授予任何 known 许可。

### 3. 中立契约与最小来源输入

作用文件：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts`。

1. 保留公开 `ConversationSizeSnapshot` 的 bytes/fileCount、turns/messages、unknown/missing 口径及 `Conversation/ConversationMeta/SessionMetadata.sizeSnapshot` 的存储位置。
2. 保留 `ConversationHistoryHydrationResult` 的 ready/error 与兼容 void。可选 `ConversationHistorySizeRead` 继续表达 complete/skipped/incomplete/unavailable；negative 不变成新的业务加载错误。
3. 给 `HistoryIndexLease` 增加可选只读 `sizeRead` receipt；ready 前必须不存在。保留现有 `sizeStatistics`，receipt 引用其 sourceRevision，不复制 count、bytes 或整份索引。
4. 统计读取改为中立的最小只读输入 `ConversationSizeReadInput`：ID、providerId、已捕获 `ConversationSizeSource` 和经字段校验复制的 persistedSnapshot。不是伪造完整 Conversation，也不 cast 掩盖缺字段。
5. `readConversationSize` 返回内部 `ConversationSizeReadResult`：公开 snapshot + provider 的该次 `sourceRevision | null`。全来源有有效指纹时，unknown history 也保留这个观察版本，以便最终 stat 校验；known history 的 sourceRevision 必须与它一致。缺失/不可读使它为 null，不冒充完整证明。
6. 此包装不持久化新的 schema，不新增第二种 hash。provider 正常证据、cache、统计观察和最终校验继续共用各自唯一的 revision 构造函数。
7. `ConversationSizePersistenceAck` 仍为 written 或 skipped(missing-metadata/obsolete/identity-mismatch)，异常仍 reject；同一次调用 Promise 的 ack 只确认其候选，不跨请求借用。

统计输入的字段表由 provider 显式构造，app 只复制中立包装。不得 `...conversation`、`...providerState`、`...forkSource`、枚举未知字段或序列化 subagentData/message 内容。

| Provider | 统计来源白名单 |
| --- | --- |
| Claude | sessionId、resumeAtMessageId；providerSessionId；复制的 previousProviderSessionIds 字符串数组；forkSource 只含 sessionId、resumeAt。 |
| Codex | sessionId、resumeAtMessageId；threadId、sessionFilePath、transcriptRootPath、forkSourceSessionFilePath、forkSourceTranscriptRootPath；forkSource 只含 sessionId、resumeAt。 |
| OpenCode | 现有 sessionId、resumeAtMessageId、databasePath；只适配中立输入，不扩大 SQLite 能力。 |

必要白名单字段类型异常/读取抛错时 fail-closed 为 unavailable。禁止读取**额外** getter；不承诺沙箱化所有必要字段 getter、Proxy 或任意恶意对象，那是另一个安全边界。

### 4. 唯一 provenance 与升级失效

复用 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/utils/conversationSizeSource.ts` 的有限 stat、物理去重、文件指纹和 `makeConversationSourceRevision`。

- Claude 保留显式 session 链及顺序、resume variant 与每个来源角色的文件指纹；Codex 保留 thread、source/native 角色、checkpoint 与指纹。缺路径不发现目录，不另外找父链。
- 物理 `(dev, ino)` 去重只作用于 bytes/fileCount，不能删掉逻辑角色、checkpoint 或 session 链。
- app 的 sourceKey 仍只封装 ID/provider/vaultPath/白名单值，是身份校验，不是 provider 计数算法。
- **Claude/Codex 认证语义 version 升为 2**，在各自现有 revision 构造函数中单点修改。否则 R0 已错误认证的持久 known 在文件未变时仍可能被重新接受。
- v1 cache/持久快照仅因 v2 revision 不匹配而失效；不改写既有 metadata、不迁旧 messageCount、不做扫描迁移。正常加载完成 v2 证据后可恢复 known。
- 重启允许验证过的 v2 持久统计被重新发布；必须重新 stat、written、final check，不能直接恢复当前完整值。运行时 owner/read/save 许可不持久化、不重启复活。
- `sourceRevision` 是“按该认证语义、这组已观察来源”的版本，不是内容签名、fsync、跨进程 CAS 或永不变化的保证。

### 5. Provider 完整性：兼容加载，严格认证

#### 5.1 Claude：给原分支选择旁出证据

文件：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkBranchFilter.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeTranscriptHistoryIndex.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts`

在 `filterActiveBranchEntries` **同一次选择过程**增加可选证据收集器：既有三参数调用与返回数组保持不变。复用现有 byUuid、progress parent resolution、latest ancestry、最终截断路径；不另写统计用 DFS/分支过滤器。

证据至少区分：已证明无分支的全序列、已证明 active ancestry、已命中且实际执行的 resume 截断、以及缺 anchor/anchor 不在 active ancestry/无法证明的 fallback。证据对象不携带正文，不送 app 解析。

- 有 resume 请求：anchor 必须存在于所需来源、属于该算法认定的当前 ancestry，并证明实际截断到它；存在但位于旧分支也不能认证。
- 无 resume：必须是现有选择过程能够证明的无分支/当前分支。无法辨识的结果不因“返回了数组”认证。
- 合法 previous-session 边界按**已取得的显式链**解释；不能把已证明的跨 segment 边界一律当坏 parent，也不能把任意断链假定为合法边界。不读取新文件找父链。
- 真空文件且无 anchor 可 complete/0；真空文件却请求非空 anchor 为 incomplete，不是已证明 0 轮。
- 已有 oversized anchor 的显式加载拒绝保留；本案不把其他统计认证失败升级成新加载错误。

`finalizeIndex` 将证据旁出到 `TranscriptHistoryIndex`；`buildConversationIndex` 聚合已有 missingSegments、partialSegments、skippedLines **和各所需 segment 的分支证明**。只有全部满足才令 `sizeStatistics.completeness=complete`。

正常的 turns、search、window/detail/title/export 输出依旧使用原 canonical 数组；fallback 的旧渲染/恢复行为不改。ready lease 的 `sizeRead` 取同一固定索引状态与来源，不从完成时的另一对象/另一 lease 生成。

**worker 不能漏接**：现有 `ClaudeTranscriptHistoryIndex.ts:1090–1158` 序列化原过滤和 finalize 函数。证据收集逻辑保持在该函数内，增加的输出须随 worker result、direct、completed cache、in-flight/cache variant 一致保留；不新建 worker 专用同族算法。只有实际执行序列化 worker 的测试能证明此接线。

#### 5.2 Codex：认证实际归一化结果，而非输入容器形状

文件：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/history/CodexHistoryStore.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/history/CodexConversationHistoryService.ts`

把正常 parser 的各实际出口纳入一个调用内的损失审计：合法省略、已保真归一化、受损内容、未支持但有语义的内容、无法辨识合并。审计可用内部枚举/计数，不另长期缓存、不二次全文解析；`turns/messages` 的原兼容输出不变。

`parseCodexSessionTurnsWithStatus.complete` 由换行/JSON 记录完整性 **及实际审计**合成。至少覆盖 response_item/message、event_msg、legacy/event、reasoning、tool、mixed 格式和 compacted/replacement_history 的真实处理路径，不能只补 input_text 一处。

| 实際输入/出口 | 正常兼容结果 | 统计认证规则 |
| --- | --- | --- |
| 真正读取稳定 0-byte 文件 | 现有空结果 | complete，normalized messages=0。 |
| 合法 `content=[]`、text 为 `''`/空白、合法空 event message | 保留现有省略空消息行为 | 不标作损坏；如果全文件无其他损失，可 complete，count 取真实归一化输出，可能为 0。 |
| `input_text/output_text` 缺 text、text 为非字符串，或 message 的 role/content 结构受损 | 原 parser 能保留的部分照常保留 | 受损，incomplete；纯坏输入不能 known 0，坏/好混合不能 known 部分数。 |
| 已支持的 tool/reasoning/compact boundary，文本为空但确实产出 ChatMessage | 取原归一化 bubble/message | 可以 complete，按真实输出数；不能要求每条消息有非空文字。 |
| 本地已支持的 tool output 数组（包括原 view_image 处理路径） | 保留原数组处理/工具消息 | 依据实际保真出口，不因非字符串输出一律标坏。 |
| 非文本 message part 未被当前 normalizer 保真表达 | 不为统计重写 hydrate，不伪造文本或补消息 | 分类为 unsupported semantic content，统计 incomplete；不能称“缺 text 的受损文本”，也不能假定合法附件已被完整计为 0。 |
| 未知消息/内容类型 | 原兼容 fallback 保留 | 若不能由本地规则证明是允许忽略的元数据，incomplete；本轮不声称知道任意未来 provider 格式。 |
| 既有系统注入排除、已证明重复消息合并、合法 compaction replacement | 保留当前正常归一化口径 | 明确合法省略不是损坏；不能另按原始行数计数，也不把被替换的历史偷偷纳入新指标。 |

count 只来自原正常归一化结果。要求把未表达附件另计一条、恢复 compaction 前物理全史、或扩大消息单位，均是新产品决定，不借修复 F2 加入。

保留现有 Codex 正向机制：读前/读后 stat 稳定性、`isAllowedSourceRefinement`、`recordSizeRead/rememberSizeStatistics`、checkpoint 截断、source-prefix + fork-only 合并与 turnId 可辨识性检查。

- 正常实读且全部保真、来源稳定才 complete；normal hydrationKey 命中和 pending fork 保留内存消息早退仍 skipped。
- established fork 需要 source + native；native-only fallback 顶层可 ready，但 sizeRead 不得 complete。
- 缺 checkpoint、所需文件、稳定身份或任一完整性条件均不认证。
- `requireFreshRead` 只用于已存在的正常加载；hover/menu/save 不调用 hydrate，也不新增 DFS。
- sourceBefore/sourceAfter 是同次调用的有限不可变值；允许的路径/root/thread 回填仍由 provider 验证，不能回填既有逻辑身份。

#### 5.3 OpenCode

维持共享数据库 files=unknown/unsupported、无完整证明时 history=unknown/unavailable；void/ready 兼容不产生新统计许可。只为中立读取输入/结果类型做机械适配，不增加 SQLite 查询或数据库 stat。

### 6. App owner、读取许可与保存 ticket

唯一所有者：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationSizeService.ts`。

#### 6.1 Owner 不等于 ID

每个当前注册会话有 `{id, originalObject, incarnation}`。同 ID 替换、删除后重建、甚至原对象被移除后重新注册，均获新 incarnation。`loadSettings` 的对象数组交换、create、delete 均由 main 在无 await 段登记/撤销。

- ticket/candidate/cache 绑定捕获时的 incarnation，不能完成后补拿 currentObject 作为 expectedObject。
- 最终校验同时要求 ticket 的 incarnation 等于当前注册记录，以及 `getConversationSync(id) === 该注册记录的 originalObject`。漏登记替换也应 fail-closed，而非自动换绑。
- 注册记录只持有当前对象；退役 ticket 只需不可复用的 owner token + 最小值输入，不把 messages/providerState/DOM 留在挂起 job 闭包。无需新依赖或 WeakRef。
- 保存也用成对 ticket，不再仅按 ID 减 count：旧对象保存晚完成、重复 finish、同 ID 重建都不能改变新对象的门。

**业务输入的原身份必须早于 ticket**：引入不可换绑的中立 `ConversationMutationOrigin`，绑定原登记 O；组合隔离方案时还固定原 `SessionRecordHandle` 的生命期身份。它不等于 save ticket，不冻结 title/F/saveEpoch，也不授予 complete。组合方案的自然 volatile→durable 迁移只推进该存活 handle 的 binding，不换原记录生命期；统计旧 binding job 退役，但正常同对象标题后续写不能因自己的合法保存而失去 origin。对既有记录，业务操作在**第一次异步调用/回调注册之前**捕获 origin；不是等最后一次 update/rename/delete 进入 main 时才按 ID 重建。main 的 mutation 输入边界必须接收并同步验证 origin、当前登记与 originalObject，验证通过后才 beginSave/Object.assign/发行 storage ticket，排队后再验证 handle。缺失/退役 origin 明确 obsolete，零 mutation/写入，不当成功、不换绑重试；不得提供给异步旧调用兜底的 ID-only 重载。

- main 的 `renameConversationManually` 两步 rename→清 titleGenerationStatus 共用一次 origin；两次调用各自入口复验，不能第二步重捕。既有先后顺序不改。
- InputController 的首次标题链从 fallback/pending 到异步生成 callback，ConversationController 的 regenerateTitle 从第一次 `getConversationById`/loadTitleMaterial 之前到 callback，均传原 origin。callback 内的读取也只针对该 origin，前后复验；再核原 expectedTitle 规则。相同标题不是身份证据；silent、手工标题优先、失败状态规则不改。
- 延迟 UI 输入/确认在打开输入框、注册确认回调时捕获；历史菜单、tab rename、delete 不能到提交回调才取最新同 ID。历史回填、Controller.save、InputController 的 resume 清理、TabManager fork 初始化及失败清理、main 批次回填/环境保存均传开始时原登记，不改正常消息/标题/分叉语义或 B 的 lease/投影机制。
- 尚无记录的 lazy create 是特例：由 create 在首个写 await 前建立自己的新登记，返回与该对象绑定的 origin；后续沿用该结果，不在 await 返回后按 ID 查到谁就给谁补身份。存储新 R 不代表旧异步操作有权创建。

#### 6.2 世代字段各司其职

| 字段 | 作用/变化时点 |
| --- | --- |
| incarnation | 一次对象注册身份；替换/撤销即退役。 |
| revision | app 正式统计失效世代；保存成功、已确认来源/分支失效时增加。不因无证据 ready 任意加一。 |
| saveEpoch | 每次影响历史的保存开始即增加，失败也不回退；跨越保存开始的旧结果均失效。 |
| normalReadEpoch/operation token | 正常读取开始时发一次；最新读取取代旧读取许可。普通 hover 不发行它。 |
| sourceBefore/key | 正常读取开始的白名单来源 + provider/vault/ID；值不可改。 |
| permittedSourceAfter | 只由该次合法 complete receipt 关联到原许可，不修改 origin 的 revision/saveEpoch/sourceBefore。 |
| gateEpoch | 统计门/发布资格切换顺序；用于撤销门清前的普通 unknown 请求，防止它晚到覆盖 proof 的 known。不是重新签发读取许可。 |

许可状态为 issued → offered/claimed → committed 或 retired；skipped/reject/失效后的旧 receipt 不能重放到新请求、新世代。再次完整认证来自下一次本来就发生的正常读取，不从统计功能主动读取。

#### 6.3 统一 ready：旧两参数不清门

`captureHistoryGeneration` 的语义改为发行绑定原 owner 的不透明正常读取许可，正常 acquire/hydrate 前捕获。

`historyReady(id, generation, receipt?)` 改为**同步接纳/拒绝并登记旁路意图**，不等待 stat 或持久化。

1. generation 必须是本 service 发行、尚有效的原许可，owner/revision/saveEpoch/readEpoch 均吻合；保存中不接纳。
2. receipt.complete 的 sourceBefore 必须对应许可开始来源，sourceAfter 必须对应当前 live 白名单来源。允许的细化只由同次 provider 证明；原保存世代不能重捕或盖章。
3. 完整 receipt 成为**该 job**的清门许可；proof sourceRevision/read token 是请求 identity 的一部分。
4. 两参数旧 ready、void、ready 无 receipt、negative receipt 最多登记普通 bytes/unknown 请求；不清 mandatory history gate，不将现存 cache 自动升级为本次 complete。
5. 同来源同世代普通请求可合并；普通/证明、不同 owner/read token/expected sourceRevision 不合并，更不能借用许可。
6. proof 发布成功清门时撤销旧 gateEpoch 的普通请求。旧 finally 只清自己；不能删掉后来的 job/需求。

#### 6.4 删除与正常列表的组合边界

采用隔离持久化方案时，详细状态转移以该稿 §7 为准；以下兼容不变量同属 U 的入口约束：

- 删除按 provider **现有 Promise 契约**继续到 metadata 删除：Claude 原生 unlink best-effort，Codex/OpenCode 不删原生历史。不能为统计改成物理 unlink 必须成功；业务删除也不等 sidecar 擦除。
- 删除开始撤原 O/handle 并保留业务排序。真正向外传播的 native/metadata/必要清理异常保留 reject；队尾 reject 可继续调度不等于 uncertain 屏障已解除。uncertain 下普通写/create 明确失败，不能占住队首等恢复；正常业务读取仍可执行。失败后只由既有正常加载/明确重试进行业务恢复，不复活原 ticket。
- 受业务排序保护的新读取须区分有效记录、两业务路径确认缺失、不可判定。确认现存原记录时发新 O/handle，保持 history 待认证，后续再次 delete 新发 ticket；确认缺失且旧实际业务操作全已 settle 时可解除屏障，让后续明确同 ID create 发新身份。不可读/损坏/身份冲突继续 uncertain；旧 delete 的 reject 不追认为成功，失败时等待的 create 不自动变成覆盖旧记录。scope保留最小失败删除上下文，显式正常loadSettings/list对未决删除ID定点重读，即使枚举无行也能确认absent；不能仅凭列表缺行解障，也不从stats发起恢复。
- 正常 list/load 安装同时检查行 stamp、loadBatch 和**枚举开始的成员关系 stamp**。枚举之后创建的新 ID 根本没有旧行，必须保留当前有效记录；不能用“旧列表未列出”当删除证据。过期行不覆盖/复活新生命期，正常无并发仍按原排序加载。
- 资格探针对缺省 providerId 使用正常 loader 的 `providerId ?? DEFAULT_CHAT_PROVIDER_ID`（当前 Claude）；显式其他 provider/非法值不得因默认化混成 Claude。这里只统一既有空值默认，不扩 provider 格式或迁移权限。

#### 6.5 删除完成后的免保存复位：只作用原 UI binding

**推荐**：给 controller 增加专用的 deleted-binding reset 入口，复用 blank UI 清理步骤但不复用 New Chat 的业务保存前置。不是给任意调用者开放 `skipSave=true`，也不是把 obsolete 保存吞成成功。隔离稿 §7.3 采用同一协议；本节只闭合原 UI 清理，不重划 B 的 lease/FIFO 或 provider 行为。

**身份与捕获**：在 TabData 上显式保存一次附着的 UI binding（不可复用 token + 绑定时的原 `ConversationMutationOrigin`，组合时含原 handle 生命期），不能临时通过 ID 查当前对象推导。Tab/Controller 装配以窄 hook 读写它，不把 TabData 注入统计 service。token 与 owner O、open claim、hydrationGeneration、streamGeneration 都正交：同一存活 origin 的自然持久 binding 迁移不换 UI token；真正 detach/rebind，包括同 ID、同 origin 再附着，必须换 token。

- main 在校验 delete 的原 origin 后、**首次 await/异步业务 task 开始之前，且在 splice/退役之前**，同步捕获所有原绑定 target：原 view/manager/TabData/controller 实例、UI token/原 origin、state/DOM 身份和原 open claim。只捕获绑定中存放的 origin 与本次被删原 origin 一致的 tab。懒创建、恢复、ensureService/restore、state→tab ID 同步、switch/commit、detach 和 closing 都必须经过实际绑定安装/撤销 hook；同值 ID 赋值不等于已校验绑定，不能漏过同 ID 新生命期。
- **真实重绑准入不能只写 token**：TabManager.openConversation 的本 view/cross-view “同 ID 已打开则 focus”捷径及 Controller.switchTo 的同 ID 早退，须同时认 UI binding 的原 origin；新 O2 不能被旧 O1 的 tab 截走。已退役 O1 的 open claim 以捕获的原 ownerToken 退役，复用 registry.release，不删同 ID 新 claim。显式新绑定请求在上述早退/guard **之前**进入实际 bind 准入 hook，可撤销 deleted-binding reset 自己的 operation/guard，再照原 reserve/restore 流程绑定；不越过普通 New Chat、其他 save/switch 的 busy guard，不据 ID 硬接管。
- 同 tab 的真实 `switchTo → save outgoing → restore` 也须闭合：仅当 outgoing UI binding 固定为原被删 O1，且其**原删除 ticket 的持久完成事实已确认**，才跳过这份已删除 outgoing 的 save，保留对其他存活 outgoing 的原先保存。持久完成事实同步记录在本次原 delete ticket、先于 B 后继 create 可执行；不重新按 ID 获取、追加等待或把普通 obsolete 当已删除。incoming O2 保持其原 origin 和正常业务/恢复语义，先撤旧 reset 后的新恢复不能再被旧 onNewConversation 收尾；对 outgoing 的 orphan 回调同样在 merge/save 前短路。否则现有 focus/creating guard、switchTo 同 ID 早退或退役 outgoing save 都会使“同 ID 实际重绑”测试没有真正发生。持久 create 仍受原 B 删除屏障保护，claim 退役/免保存 UI 清理不是新业务写许可。
- provider→metadata 的持久阶段按原契约完成，B 的持久删除屏障在这里结束；之后 main 在 **B 之外**仅遍历这份 target 快照进行 UI reset。不得在此再枚举同 ID、等新 create/bind、重新抓 origin，或把 UI/projection Promise 加入 B 使同 ID create 多等一层。固定快照可包含仍显示旧 binding 的 tab；另一 tab 已绑定新 O 时，仍可清原 tab，但绝不碰新 tab。
- 本次 delete ticket 的原身份及“持久阶段已完成”授权旧 UI 清理；不要求已退役 O/handle 再 current，也不允许它作业务写。UI 内部结果明确区分 `reset`、`skipped(binding-retired/tab-closed/busy)`，不是 BusinessMetadataAck，更没有 written。已成功持久删除不因旧 UI target 跳过而变成失败；真正 UI 异常仍向 main 原外层 Promise 传播。

**两个入口的前置不同**：普通 `createNew()` 及普通 force New Chat 保留已有 streaming/creating/switching guard、先 save 后清绑定、保存真实 reject 及 lazy blank 语义；deleted-binding 入口必须携带上述 target/删除完成凭据，**绝不调 save/update/create、发保存 ticket、await stats，亦不消费 runtime session invalidation 作保存**。creating/switching 已忙时仍不抢占原操作，返回 skipped/busy；不称该 tab 已复位，不新增等待、轮询或补偿 New Chat。正常 READY 且不忙的原 tab 应真实走完免保存复位。

**复位所有权与逐点检查**：绑定安装 hook 维护仅一份 reset operation token，拥有本次 `isCreatingConversation` guard；它不是持久记录或业务 origin。复位自己的 bound→resetting-blank 转移保留这个 operation 的续体许可，不能因自己清成 null 就失去许可，也不能因此创造新会话。任意外部 rebind/detach/closing 撤销旧 reset，安装新 UI 时只解除旧 operation 自己拥有的 guard；旧 finally 仅 compare-and-clear 自己的 token/guard，不能把新操作的 creating flag 清成 false。

| 真实关键点 | 必须执行的检查/顺序 |
| --- | --- |
| 入口及取得 reset guard 前 | 原 view/manager 仍在，manager 当前 map 中同 tabId **仍是原 TabData 实例**，controller/state/DOM 同实例，原 UI token/origin 未被换绑，tab 非 closing；再处理既有 busy guard。只核 ID 不合格。 |
| 首次 projection await 之前 | 按原 target 触发 cancel/force stream-generation 与 S2 invalidation；main 不再裸调当前 tab 的 cancelStreaming。每个可能回调的 hook 前后复验；检查失效即停，不读取/取消新 runtime。先取消/失效原 live turn，再入默认 stored 队列，不能拿 stored grant 后才等同一路 live 释放。 |
| orphan/取消的同步回调 | Tab.ts 的 subagent onStateChange 在 deleted reset（或持同一删除完成凭据的重绑清理）所属原 outgoing binding 上，**进入 stream/merge/save 之前**短路；保留原 orphan domain 清理，不发业务保存。清当前 ID 前也必须如此，不能仅 catch obsolete，或等回调按同 ID merge 新对象之后再拒写。普通 New Chat/正常新 binding 的回调不被此短路关闭。 |
| 清原绑定/open claim | 以 operation token 进行本次自有 detach，state/tab binding 的发布在同一 guarded hook 中；任何 setter/callback 回来后复验。旧 claim 只通过已捕获的 `ownerToken` 释放；不得从 tab 临时读取同 ID 新 claim，亦不得在 token release 后无条件清新 recovery source。 |
| 默认 projection FIFO 等待、grant 与 task 开始 | 使用原 coordinator 的默认 S+L 域，不用 bypassLive/timeout/dispose/新锁。对**本次 reset**给 runStoredTransaction 传额外的原 target/reset predicate，排队取消、grant 后 task 开始及正文再检查；不能在清 ID 后只捕获 null。返回 null 表示没有提交，不得续做输入/回调清理。 |
| grant 内 domain/DOM 提交 | 复验后才清旧 messages/history lease/pageStore/windowRenderer、流 DOM 引用、usage/todos/计划状态，empty messagesEl 并创建 welcome/remount。本次 clear-rebuild 正文不 await；但 state setter、setWelcome/remount 等可同步回调，逐个 hook 前后复验，发现重绑立即停止剩余提交。不得以“无 await”声称回调不重入。 |
| await 返回后的输入/上下文/READY/回调 | 再核原 tab 实例及 reset token；逐项保护 input、文件/图片/MCP/外部上下文、queue、markHydrationReady 和 onNewConversation。Tab.ts 回调内部也携带此 guard：cleanup 仅针对捕获且仍属本 operation 的 runtime，清 `tab.service`/绑定/模型/搜索前 compare-and-clear；不能只在 controller 调回调前核一次，再由其无条件 cleanup 当前 runtime。其他同步回调同样返回后再核。 |
| finally、列表删除的外层续体 | 只释放自己的 reset guard。deleteHistoryConversation 的 onRerender/loadActive 保留原 origin、UI/visibility session 检查；尤其不得因同 ID 新 binding 而再次 loadActive/清新 UI。真实 UI 抛错保留 reject，已确认持久 absent 不因此变 uncertain。 |

**现实能力边界**：open registry 的 token release、默认 projection FIFO、S2 lifecycle 和 render-flush 都直接复用；新 binding/reset hook 是为实际副作用提供可检验的身份，不是锁、I/O 取消或线程安全证明。auto invalidate 的实际 release 与 user finally 的实际 release 分开测；若原 UI predecessor 永久不 settle，UI reset 可仍等待原 projection，不能偷放 lease/加业务删除等待或宣称有限完成。正常新业务及新 UI 不因旧清理失效而被取消、保存、清空或禁用。需要修改 B/runtime 的释放语义才能转绿时应阻断回主会话，不能扩大本次订正。

### 7. 失效与保存时序：旧 known 不静默留在屏幕

公开状态至少区分 cold/unknown、certified、saving-suspended、awaiting-normal-read；实际 job running/queued 是正交状态，不代表 known。

| 事件 | revision/saveEpoch/门 | 可见值及通知 | 业务结果 |
| --- | --- | --- | --- |
| beginSave(ticket) | saveEpoch 立即 +1，暂停正值提交；保存 ticket 入集合 | 旧 known 仅作私有 last-good，公开 files unknown、history stale，同步 onChanged。不是保存成功失效。 | 尚未成功；不显示新候选。 |
| 一个保存成功 | revision +1，mandatory history gate 置为 awaiting；旧候选/许可退役 | 同步 unknown/stale 与通知；正值需后续认证。 | 真实业务 metadata 写/必要清理已完成。 |
| 仍有其他保存未结束 | 门不开放，保存集合不清空 | 保持 suspended/unknown | 不等待 stats；其他真实业务保存照常进行。 |
| 最后一个保存结束且至少一个成功 | 保持 awaiting-normal-read | 同步 finish，仅登记有限 stats 意图 | 完成调用者的保存；不 await refresh。 |
| 全部失败 | 不伪造成功 revision；saveEpoch 不回退。保守保留 stale/待正常认证 | 发布失败/负状态，不发布本次新 bytes/count，不无条件恢复 last-good | 保留原业务 reject；不能被 stats 错误覆盖。 |
| 保存被既有 shell/no-message guard 跳过 | 不发行 ticket，不变世代 | 不冒充成功或新失效 | 原 skip 行为保持。 |
| 普通 invalidate/已观察来源变化 | revision +1，撤销正值；需要完整读取的变化保持 gate | **同步**发布负状态/通知，即使统计槽全满 | 不依赖候选或 overlay。 |
| 只收到 stat/persist 失败 | 保持/转为诚实负状态，绝不清 mandatory gate | 通知可见 tab/menu；typed job 失败原因可观察 | 统计失败不制造业务保存/加载异常。 |

全失败后不无条件恢复 known，因为 metadata 失败不证明原生 transcript/内存来源未变；现有代码在 await write 前就 Object.assign。保守 stale 使用原已批准的待更新展示，不引入新字符串/新指标。若用户要失败后自动恢复 last-good，须另定义其来源再认证条件，不能直接恢复。

保存 guard 收敛到 main 的单一会话 mutation/persist 包装：Controller.save 交明确的 history-save intent 与操作开始的原 origin；main 先验证 origin，再在 Object.assign 前 begin ticket，真实 saveMetadata 后同步 finish，异常原样返回。删除 controller 的重复 begin/finish，禁止嵌套双记账；title/status 等 metadata-only 写同样校验原身份，只是不冒充历史保存。

metadata-only 的纯 title/status 更新不应假装发生历史读取；明确元数据字段可走原路径。涉及来源、resume、历史保存或无法证明仅元数据的 patch 走同一 guard；不由 feature 解释 opaque provider 字段。create/loadSettings/delete 的注册/撤销另由 owner 协议覆盖，不递归触发 size overlay。

### 8. 候选提交协议与失败语义

**所有普通/证明候选共用一条协议**；失效发布负状态是明确例外，不是成功候选。

1. 发起前：捕获 owner、原许可或普通需求身份、revision/saveEpoch/gateEpoch、最小来源输入；不持有 UI 节点或整份聊天。
2. 获得真实槽后再校验；失效的排队需求不启动 I/O。
3. provider 读取已完成 cache/经校验持久快照 + 显式有限 stat。校验 ID/revision、数值、单位、白名单来源后，保留不可变的**原始 provider observation `rawBefore`**（含包装的 observation/sourceRevision 及原始 files/history）；它在写候选之前采集，不原地降级。
4. 独立施加许可/mandatory gate，生成**待持久化安全投影 `candidate`**。gate 开着且本请求无有效 complete receipt 时 history 降为 stale，即使 rawBefore 来自 provider complete cache；files 可仍 known。proof 必须与原始 observation 的 known history/sourceRevision 匹配，否则不清门、不认证。未降级 rawBefore 只作本 job 比较输入，不能当作已认证公开结果持久化。
5. 调现有 `saveSizeSnapshot(id, candidate, isCurrent)`，组合隔离稿时改用其独立 store，要求**本次候选** ack written。所有 skipped、缺 ack、reject 均不清门、不提交新候选；缺 metadata 不创建、失败不自动循环重试。
6. **written 之后再最终 stat**：复用同一个 provider `readConversationSize`/revision 函数和同一份最小读取输入，取得未套 app gate 的 `rawFinal`。最终读取不能改喂刚写入的降级 candidate，制造自我导致的口径变化。比较的是 **rawBefore ↔ rawFinal**：observationRevision、原始 files 状态/原因/bytes/fileCount、原始 history 状态/原因/count/unit/sourceRevision，以及 proof 匹配。全指纹可用须 revision 相同；null 不认证 known。负态只比较对应字段，缺失字段不补零；同一 shared comparator 处理两端，不能拿 candidate.history=stale 与 rawFinal.history=known 判来源变化。
7. 最后在一个**无 await**临界段中：校验 owner、live object、来源、revision/saveEpoch/read token/gateEpoch、非保存中和本 job 许可；以同一门规则确认安全投影 → 清本次 gate（仅有效 proof）→ 发布与本次 written 对应的 candidate → 发 onChanged(published)。普通请求来源稳定时允许 files=known/history=stale，mandatory gate 原样保留。不得绕过重认证把 rawFinal 直接发布；临界段不再读盘、hydrate、取 lease 或等待 rAF。

第 6 步防止 overlay await 期间文件改变而仍发布旧 positive。它增加一次有限 stat，但复用同族算法；不能另建 finalStat 的近似 hash。

| 失败位置 | 结果 |
| --- | --- |
| source 捕获异常/缺可用来源 | 负状态/不可用；不发行伪造许可。 |
| stat 挂起 | job 仍真实占槽；失效值已可见，业务不等此 job。 |
| missing segment、partial、损坏内容/不可证明分支 | history unknown/incomplete；若 bytes 仍可证明，可作为普通候选按完整提交协议处理。 |
| skipped(missing-metadata/identity-mismatch/obsolete) 或缺 ack | typed 未提交；不清门、不更新 positive。 |
| exists/read/parse/write/legacy cleanup reject | storage 保持原异常 reject；app 收敛为显式统计失败状态，非业务成功。 |
| written 后 owner/source/世代/stat 改变 | 放弃候选、保留负状态与门。已完成 overlay 不回滚，不声称磁盘最终世代有效。 |
| 关闭/撤销观察者 | 立即释放 UI 订阅/逻辑需求；不伪称实际 I/O 已取消。 |
| observer/rAF 侧异常 | 不撤销已成立的 domain 提交，不污染业务 Promise；隔离具体 observer。 |

`written` 只确认本次 adapter.write 和必要 legacy 清理 resolve，非 fsync。外部写入可在 final stat 后再发生；本案保证“最后一次可检验来源上的认证 + 同进程最终世代检查”，不保证没有跨进程 TOCTOU。

### 9. 旁路调度、挂起 I/O 与 U1

#### 9.1 本案可直接做到的旁路

- main 的 `getConversationById`、`switchConversation` 只等正常 hydrate；完成后同步交 receipt/普通意图，不 await stats。
- Controller.save 的真实 metadata 完成后同步 finish；closeTab/destroy/onClose 不加入统计 drain/flush 等待。
- 统计读取/持久化异常不替代原 hydrate error 或 metadata reject。
- 保留至多 **2 个实际统计 pipeline**；每个 pipeline 内的显式 stat 顺序执行，stat/overlay/final stat 的实际未完成操作不因超时释放计数。
- 等待需求改为“当前有效 intent”，不是每次 refresh 建一个 resolver 追加数组：同 owner 最多一份最新 proof 意图 + 一份普通意图；UI 意图属于当前实际可见行/tab，close/reopen/重绘撤掉旧 intent。普通 UI 不留每行 `.then` 闭包等在永久挂起的 Promise 上。
- 多次打开/保存/刷新不会增长历史世代队列；容量随当前注册 owner 的单份状态和当前 UI 需求，而非调用次数增长。菜单行采用当前展示集合/游标供给空闲槽，不能预排全列表的一串 I/O Promise。
- physical active 与 logical retired 正交。取消逻辑需求可立即完成其观察者/释放 UI，但真实槽只在实际 Promise settle 的 finally 一次性释放；队首挂起时明确呈现 unknown，不无限起新 I/O。
- 关闭 UI 后没有该 UI 需求；正常读取产生的 owner 级有效候选可继续更新全局 cache，但任何旧 UI 写回必须拒绝。统计 job 不持有旧菜单/tab DOM。

没有新增轮询或超时重试。若以后引入一次性观察超时，它只能使观察者放弃，不证明 I/O quiescence，不能解锁 FIFO 或统计槽。

#### 9.2 必须分开的三种挂起

〔既有读数：源码〕`SessionStorage.ts:21–29` 下一同 ID task 在 `previous.catch(...).then(write)` 后运行；该文件的 `saveSizeSnapshot()` 方法 `:57–79` 可停在 read/write/cleanup await。`VaultFileAdapter.ts:23–26` 对写入没有可确认终止的取消契约。

| 场景 | 可观察事实/归因 | 本案可以保证什么 |
| --- | --- | --- |
| H1：X/Y 的统计 stat 或 persist 占满两槽；Z 的业务 metadata 已真实写完；Z 的 stats 尚排队 | Z 业务 I/O 已完成，阻塞来自 finishSave/main 对统计的依赖 | 脱钩后 Z save、对应 close、已完成的两 main 正常加载返回；真实 stats 活动仍最多 2。 |
| H2：C 的统计 overlay 已进入同 ID FIFO，在 read/write/cleanup 挂起；后续 C 业务 save 入队 | C 的业务 adapter.write 尚未开始；队首由 stats 占住 | 只删 await refresh **无法**让 C 后续 save 完成。不能把它误称“业务 I/O 本来挂起”。 |
| H3：没有前置 stats，业务 save 自己的 adapter.write 挂起，或正常 hydrate/index 自身挂起 | 第一项业务操作已开始却未完成 | 统计旁路不能保证该业务返回；保留业务错误/完成语义，不提前报成功。 |

验证必须让真实调用链分别进入 H1/H2/H3，记录 adapter 操作开始/完成及 FIFO 次序。尤其 Codex 正常加载用 statSync/readFileSync，H1 应挂起 **统计的 fs/promises.stat**，不能连正常 reader 一起 mock 挂起后错误归因。

#### 9.3 U1：固定 metadata overlay + 严格同 ID FIFO + 无条件非阻塞不可同时保证

〔推算：时序论证，待受控实测〕设 O 为已进入 C 队首、永不 settle 的统计 overlay，S 为后续 C 业务 save：

```text
保留同 ID FIFO ⇒ S 的实际写入必须在 O 结束后
O 不结束 ⇒ S 不开始写 ⇒ 不可能既保持真实持久化成功语义，又让 S 成功返回
```

具体反例就是 H2。给 S 超时并返回成功改变保存语义；释放统计计数不让 O 停止；绕过 FIFO 并发写同一个 metadata 文件可能让旧 read-modify-write 最后覆盖 S；仅换 sidecar 路径却继续同一个全局 ID FIFO也无效。

**初稿 U1 选择面保留如下；当前用户已授权另设计 U1-c，但具体隔离方案尚待确认。** 不宣称完整 A 非阻塞要求已满足；组合时按隔离稿 §12，不再将本稿 overlay 布局当作既定终态。三类边界不能由 implementer/agent 静默互换：

| U1 选择 | 保留/改变 | 代价与授权 |
| --- | --- | --- |
| U1-a：保留当前 overlay 布局和严格 FIFO | 原持久化与排序安全保留；承诺仅限 H1/H3 的诚实边界，接受 H2 可能阻塞后续同 ID 写 | 需用户接受非阻塞范围的明确缩窄；不是完整原目标达标。 |
| U1-b：统计不独立发 overlay I/O，仅借未来兼容的业务 metadata 写确认 | 可保留当前布局/FIFO；不因统计另发 I/O占住业务队首 | 会延后/缺少正常 ready 后的 known。不是任意下一次 save 都能搭载：影响历史的保存开始会撤销旧许可；只有兼容世代的自然写才可确认。若没有这种写，保持 unknown。需新的产品时效/持久化触发裁决。 |
| U1-c：允许重划统计的物理提交地址/存储提交能力及 FIFO 域 | 可追求隔离 stats 故障、业务不等 stats；代际检查与删除不能靠弱序列覆盖 | 需明确存储布局、排序范围、删除/重建、崩溃与跨域一致性授权；“不同路径”本身不够。本 draft 不选择 sidecar、journal 或新存储路径，也不设计跨进程根治。 |

架构推荐保持统一证据/owner/许可与“业务不依赖统计”的目标，不把目标降成默认务实承诺。**U1 由用户选择不变量边界后才有可执行的物理持久化方案**；其结果若实质改变本 draft 的推荐/边界，须按授权形成后续设计，不悄悄改旧记录。

### 10. UI：容器可见性是请求许可，rAF 只是消费

文件：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ClaudianView.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabBar.ts`

#### 菜单

实际容器所有者（view 的主菜单；legacy controller 的自身菜单）管理一次 visibility session：容器身份、owner 实例、open/render epoch、对应 tab/当前会话绑定及可撤销需求。view 把 session 显式传入 renderer，controller 不用自己独立的数字 epoch 替代共享容器所有权。

- 打开顺序改为“建立当前 session/置 visible → 按当前展示行渲染并登记统计需求”，避免在 visible 前调用 renderer，而新 guard 把首次打开请求全部拦掉。
- 隐藏时 update/render 只标记需要重绘或直接返回，**不发逐行 stats**；切 tab 的回调先撤旧菜单 session，再按真实可见状态重绘。
- 全部关闭路径统一走 session 撤销：view toggle、legacy controller toggle、document click、选择本会话/新 tab、tab 切换/关闭、view onClose。不能只给一个 toggle 加 epoch。
- 结果/失效通知只更新**当前 session 已展示的行**，校验当前 container/row、owner/tab、ID/revision；旧 session、重开复用 DOM、controller 换人都拒绝。
- onChanged 的行绘制只读 getter，不重新调用逐行 refresh；避免 publish → render → refresh 的反馈循环。
- 没有预先存在的筛选/分页就不为本案新建虚拟菜单。当前真正渲染的行就是本期请求集合，不全仓 scan。

#### Tab 与 view

- app 事件改为明确的 `onChanged(invalidated/published/failed)`，包含 ID/owner incarnation/revision；main 复用既有 view 分发路径。
- tab 事件/hover/focus 先验证当前 tab 实例和 conversation 绑定，再登记普通需求；tab 关闭、绑定变化或 view 关闭撤其需求。
- view 用现有 `updateTabBar` rAF。回调从当前 `TabManager.getTabBarItems → getSnapshot` 取最新值，不把旧事件 snapshot 写到新 active tab。
- 切到 B 不意味着 A 的未关闭 badge 永远不能更新：若 A 仍绑定原 owner，其已成立统计可更新 A；绝不能把 A 的候选写给 B。关闭/重绑 A 则拒绝旧 UI 接收者。
- onClose **先**标记 closing/增加 view epoch、撤菜单和 tab 需求、取消已有 rAF，再 await 原业务 teardown；后续通知不再为这个 view 排新 rAF。不等待 stats drain。
- `getConversationList`、`getTabBarItems`、`getSnapshot` 和格式化保持同步、无 I/O，不发行读取许可，不在 getter 中隐式 invalidate/通知。
- tab 保持单一 aria-label，不能加 title 双 tooltip；两入口共用现有 formatter 和 10 locales。新增内部原因归并到已有 unknown/incomplete/stale 展示，不增消息/字符/tokens 指标，不改 context usage meter。

### 11. 真实入口接线与精确实施清单

所有下列改动都只是设计；本轮没有实施。先获批并由主会话释放相应共享文件所有权，B 冻结未解除时不得装配 main/view/tab/controller。

| 文件绝对路径 | 精确改动点/依赖 |
| --- | --- |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts` | size-only ReadInput/ReadResult；lease可选sizeRead；mutation origin/record handle所需中立类型及hydration/ACK兼容约束。不改B预算/lease/render契约。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/utils/conversationSizeSource.ts` | 复用有限 stat/指纹/hash；若需 observation 包装只透传现有结果，不能另造算法或目录读取。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkBranchFilter.ts` | 原选择过程可选旁出证据；三参数输出/fallback 不变。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeTranscriptHistoryIndex.ts` | finalize 的分支证据、direct/worker/cache 保真透传；不改变原 index 消费路径。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts` | 显式 forkSource 捕获；v2 唯一 revision；完整性聚合；固定 lease receipt；size-only 读取/cache。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/history/CodexHistoryStore.ts` | 真实归一化出口审计，compact/mixed/legacy 复用；normal message 输出不改。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/history/CodexConversationHistoryService.ts` | v2 revision；ReadInput/ReadResult；实际完整审计驱动 receipt；保留现有合法来源细化/fork 检查。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/history/OpencodeConversationHistoryService.ts` | 只适配统计中立输入/结果；negative/void 行为、SQLite 范围不变。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationSizeService.ts` | owner/保存 ticket/读取许可单一状态；onChanged；当前 intent/实际两槽；rawBefore/rawFinal 同口径比较与独立门投影；本次 written 后 final stat、无 await 发布。无内容解析、计数或 DOM。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/SessionStorage.ts` | 复用 typed ack、FIFO、入口/排队后/读后 isCurrent；本案不默认改布局/FIFO。只有 U1 裁决授权所需部分可改。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts` | 装配 onChanged；loadSettings 校验 batch/行/成员 stamp 后登记 owner，保留枚举后新 ID；create 返回原登记；delete 在退役/首次 await 前捕获原 UI targets，持久屏障后在 B 外按快照免保存复位，不晚按 ID 枚举/裸 cancel；跨 view focus 查询携原 origin。rename/update/delete 的 mutation 输入验证起点 origin，再发 ticket；手工 rename 两步共用 origin；回填/环境批保存不能晚到换绑；两正常加载入口不 await stats。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts` | 原 ready/lease 接线及 visibility session 保留；loadActive/switchTo→backfill 的原身份贯穿到 main；save、regenerateTitle（含首次读取）、inline rename/删除确认从异步起点传 origin，保留 silent/手工标题优先与原业务结果。新增 deleted-binding 免保存 reset，与普通 createNew 共享受控清理而保留其先 save；switchTo 同 ID 早退认 incoming 原 origin，仅凭原删除完成 ticket 跳过已删 outgoing save，存活 outgoing 仍先保存；本 reset 的 runStoredTransaction 额外谓词/正文/await 后/回调/finally 全链验证 token，deleteHistoryConversation 外层续体不重置新 binding。不改 B 同步交换/lease/FIFO。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/InputController.ts` | 补必要调用者：首次标题 fallback/pending/生成回调共用原 origin；发送前 resume 清理传该业务操作原身份，lazy create 沿用返回登记并通过实际 UI binding hook 安装，不能只赋同 ID；不改发送/自动标题产品或 B turn/投影机制。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ClaudianView.ts` | 原 onOpen/menu/onChanged/onClose 接线；tab rename 在打开 InputModal 时固定 origin，onSubmit 不按 ID 换绑。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts` | 原 getter/close/switch/destroy 旁路约束；fork create→update→失败 delete 沿用新建返回的原登记。新增原 UI target 同步捕获/验证和 token 化绑定/自有 reset guard；同 ID focus/reserve 准入认原 origin，只退役旧 claim/reset，不阻挡新绑定；释放使用原 claim token，实际 bind/closing 撤旧 reset。不改业务 hydrate/保存成功条件。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts` | 必要生产文件，不能只改 controller：向真实 controller 注入 binding/reset hooks；ensureService/onConversationChanged/onNewConversation 贯穿原 token，自有 detach 不误退役自己的续体；deleted reset 的 orphan 回调进入 stream/merge/save 前短路，普通回调不变；runtime cleanup、模型/搜索/READY/UI 回调内部复验并条件清理原资源，不空掉新 service。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/types.ts` | 必要类型：UI binding/原 target/reset operation 的窄契约与 TabData/TabHydrationHooks/manager 接线；不是只供 badge 使用，不改变持久结构、turn 或 projection lease 定义。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabBar.ts` | 如需要，仅携带/验证当前 badge 的 UI 请求 binding；单 aria-label 与 hover/focus 共用普通需求。 |

只读复用/除类型适配外不预设修改：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/types/chat.ts`：保持 sizeSnapshot 和业务 metadata 字段位置，不引入第二份持久 proof。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/storage.ts`：保持 AppSessionStorage 的中立引用。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/ConversationOpenRegistry.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/rendering/ProjectionWriteCoordinator.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/TurnCoordinator.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/AutoTurnProjectionController.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/StreamController.ts`：只读复用原 token release、FIFO 与失效机制；不新增 lease 强释放、bypassLive、线程安全或取消契约。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/utils/conversationSize.ts` 与 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/types.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/locales/`：保留原口径/键；验证 10 locales，不顺手重写。

真实 ready 入口只有已盘点的这组：main 的 non-index hydrate（getConversationById/switchConversation），Controller 的 index loadActive、switchTo、refreshHistorySearchSnapshot（search/rewind/fork）。必须全部拿到**该次固定** receipt；不能主入口改三参数、其他入口仍凭 ready 清门。

### 12. 实施阶段与闸门

| 阶段 | 交付/闸门 |
| --- | --- |
| G0：用户裁决与冻结 | 确认本 draft 及 U1 边界；核对当前 A 基线、B 冻结与共享文件释放。未获确认，不实施。原批准正确性修复与新存储/产品选择必须分别写进派单。 |
| G1：证据层 | 先加 F1/F2/F8 红测与 v1 持久证书失效测试；再统一中立输入/receipt、branch audit、normalizer audit、v2 revision。direct/worker/normal 输出回归，保留正向 known 能力。 |
| G2：app 授权与失败语义 | owner/读取许可/保存 ticket、gateEpoch、typed ack/final stat、同步负状态。先做同 ID 替换、skipped/reject、交叉请求红测；真实槽计数与逻辑撤销分开。 |
| G3：共享入口与 UI | 仅在共享范围释放后串行装配 main/controller/view/tab；移除业务完成后 await stats；真实 onOpen 菜单/关闭接线、失效 rAF 测试。不改 B 计量或 lease。 |
| G4：U1 的获批物理边界与端到端验收 | 用 H1/H2/H3 实证所选边界。U1-a 必须明确 H2 限制，不能报完整非阻塞 PASS；U1-b/c 必须先有相应新授权/契约，不能沿本案自由实施。冻结新的 A-only package/snapshot，再独立复核。 |

每段先目标失败测试，再实现、同命令转绿、定向类型/lint/diff；不能把改后的绿测或 A 的旧 718 项摘要作为新协议成立的证明。部分阶段完成不等于整个 A 获批/验收。

### 13. 方案推演与结构自检

以下数据/时序均为〔纯示意〕或〔推算〕，不是本轮执行结果；用于圈定实证靶子。哈希核对的〔实测〕不证明这些行为通过。

#### 13.1 口径与正常/受损边界

| 锚值输入 | 旧行为/容易误判点 | 目标结果与红绿判据 |
| --- | --- | --- |
| 同一 inode 的两个显式来源，各含 UTF-8“汉字”6 bytes | 不能按角色把 bytes 算 12 | 绿：关联文件 6 B/fileCount=1；逻辑角色仍保留。红：物理去重顺带删除 fork/source provenance。 |
| 完整索引 300 轮，首屏只 materialize 50 | 窗口数不是历史规模 | 绿：known 300 turns；展示不 acquire/build/iterate。红：known 50 或 cold messages=[] known0。 |
| 线性 U0/A0/U1/A1，resume=不存在的 M | fallback 仍正常展示两轮，R0 complete 三计数均为0 | 绿：正常输出保持两轮、统计 incomplete。红：known2。 |
| 旧分支 U0/A0/Uold1/Aold1/Uold2/Aold2；latest 新分支只有 U0/A0/Unew1/Anew1；resume=Aold2 | anchor 在文件中，但未在 latest ancestry；旧算法仍选 latest 两轮 | 绿：正常 latest fallback 不改，统计 incomplete。红：仅 anchorFound 就 known2/known3。 |
| 真空文件无 anchor | 不同于没有 cache/没读过 | 绿：正常完整读取证明后可 count0；空文件带非空 anchor 则 incomplete。 |
| 单条 response_item/user，content=[{type:input_text}] | text 缺失变空，flush 不产消息，旧结构校验会 complete | 绿：正常兼容输出[]、统计 incomplete。红：known0。 |
| 合法一条 user text='ok' + 上述坏 content | 原正常输出可能只有1条 | 绿：统计 incomplete，不 known1；不因此让 hydrate 抛新错误。 |
| 合法空 text/空 content；另有一个带 call_id 的完整工具 bubble | 空文字不是损坏；工具仍产 assistant message | 绿：在无其他损失时可 known，count 等于正常输出（本例工具 bubble 为1）；红：所有无文字出口一律 incomplete 或 count0。 |

最后一行的工具 bubble 依据已读 `CodexHistoryStore.ts:573–602,974–1011`；未知非文本 message schema没有被本轮核实为具体 provider 合法格式，只作为 unsupported 分支验证，不伪造格式知识。

#### 13.2 新旧 ready、对象与 ack 的数字迁移

锚值：原 owner A，revision=4、saveEpoch=2、cache count=2，来源 K0。成功保存后 revision=5、saveEpoch=3、gate=awaiting。

| 同一场景 | R0 结果/薄弱点 | 新契约结果 |
| --- | --- | --- |
| 两参数 ready；metadata 缺失 → skipped | 先清 gate；metadata 恢复后普通 refresh可发布 cache2 | gate 保留；零新候选提交。只有新的真实 complete receipt + written + final check可解除。红判据：恢复 metadata 后仅普通 refresh就 known2。 |
| 同 ID/source 的 B 替换 A，旧 callback晚到 | 数值世代/key相同可接受；expectedObject在完成时才捕获也无效 | incarnation不符，拒绝；B 正值提交次数0。 |
| 正常读取开始 r=5/e=3/K0；合法 path/root 回填 K1；最终同 object/r/e | 旧代码另 invalidate并把来源细化改写到新generation | 原 r=5/e=3/K0不变，receipt关联 permittedAfter=K1；认证/ack/final stat成立后发布 count3，snapshot revision仍5。 |
| 上述读取中 beginSave，e=4；该保存最后失败，r可能仍5 | 仅检revision不能发现 | 旧许可退役；不能重捕 e=4为旧 receipt盖章。 |
| written返回前另一保存/替换/来源改变 | “确实写过”不等于还能发布 | 保留 gate/unknown；不回滚 overlay，也不提交旧 positive。 |
| written后文件从 F1变F2，来源路径不变 | R0 只在 readSize阶段 stat，persist之后没有再观察 | final stat R2≠候选/proof R1 ⇒ 放弃 positive，通知负状态。 |
| proof3先发布；旧普通 unknown2晚完成 | 不同许可不能借用，也不能覆盖较新的known | 清门增加gateEpoch并退役旧普通job；保持known3。 |
| 标题任务起于O1，同ID/同title重建为O2；旧callback此前尚未发行storage ticket | 到main才按ID取O2，局部ticket检查也全能通过 | 起点origin仍O1，在main mutation前obsolete；O2 title/status/providerState及写次数不变。红：O2被改，哪怕之后stats拒绝。 |
| 手工rename第一步结束后delete/recreate，第二步清状态晚到 | 第二次update按ID取新对象 | 两步共用O1；新O2的titleGenerationStatus不被清掉；不改变原手工标题规则。 |
| gate=awaiting；rawBefore/rawFinal均V2-a、4096 B/1 file、known2 turns；本次无proof | 将candidate.history=stale与rawFinal.history=known相比会假报变化 | 绿：本次written+final后files known4096/history stale，gate不变；磁盘history也stale。红：不能更新bytes、清门或把raw known2直接落盘。 |
| 上例写后文件变V2-b/8192 B | 两原始observation不同 | 绿：拒绝旧candidate、不清门；不能为了稳定场景可发布而省略final stat。 |

#### 13.3 边界时序

- 〔纯示意〕t0 badge=known2；t1 beginSave 同步置负状态并排现有 rAF；t2 业务 metadata 已成功；t3 stats stat永挂。绿：下一帧 badge 为 unknown/stale且业务 save已返回；红：必须等t3成功或手工调 updateTabBar才改。
- 〔纯示意〕菜单关闭时切 A→B：请求增量0；随后打开，先建立 visible session再渲染行，才登记需求。红：为了 hidden guard导致首次打开也0需求。
- 〔纯示意〕菜单 open epoch7→close→reopen epoch9；旧7结果返回，哪怕同 ID/同数字 controller局部epoch，旧session也不能写新DOM。tab关闭/view closing同理；rAF在真正paint时重取绑定值。
- 〔推算〕O(C) overlay真挂起后 S(C)入队：S的adapter.write开始次数0。这是 U1 的红例，不得通过假 ack、绕 FIFO或提前报 save成功“变绿”。

- 〔纯示意〕L1 枚举仅 A；读取挂起期间 create B 成功，B 不在任何旧行。L1 迟到安装必须保留 B，且按原排序与有效 A 合并；红：只核 A 的行 stamp 后全量赋值导致 B 消失。L2 已安装时 L1 全批拒绝。
- 〔纯示意〕旧 Claude metadata providerId 缺省，正常 loader 得 claude；探针也必须得 claude。绿：正常完整读取后可提交；显式 codex 对 Claude binding 仍不匹配。红：旧格式被探针错误挡死或跨 provider 放行。
- 〔推算〕Claude unlink 真失败但被原 catch 吞掉→provider resolve→metadata 删除成功，外层 delete 仍可成功；不能新增 uncertain。metadata remove 真 reject 则保留失败，经正常重读确认原 R1→新 handle/O→新删除票据 D2 重试；确认 absent 后同 ID create 才发 R2。绿：旧 D1 不复活、R2≠R1；红：失败永久卡屏障或误删 R2。详见隔离稿 §7/§13.2。

删除后复位走查〔纯示意，未实测〕，锚值为 ID=C、原 R1/H1/O1、READY tab T1、UI binding U7、1 条消息；复位 operation Q9：

| 同一对象/窗口 | 绿判据 | 红判据/反例 |
| --- | --- | --- |
| delete 退役 O1/H1；provider、metadata resolve；原 T1/U7 仍显示消息 | Q9 无 save 完成默认 projection、welcome/空输入/READY/blank；main delete 真返回，metadata 仍 absent | 调 createNew(force) 先 save；obsolete 被吞成 written 或删除后重建记录；只有 mocked reset 返回却 T1 未空 |
| provider pending 时申请同 ID create；B 完成后 R2/O2 真实绑定 T1/U8，旧 UI cleanup 才启动 | 原 target 仍 U7，零取消/保存/清 UI；新消息/输入/runtime/claim/flag 不变；真实 open 捷径认 O2，不把请求 focus 回 O1 | 清理阶段按 ID 捕获 U8；测试只注册 R2 未真正 bind；旧 ID-only focus 或 busy guard 导致假覆盖 |
| R2/O2 绑定不同 tab T2/U1，T1 仍是 O1/U7 | T1 可免保存变 blank；T2 流、UI、新 metadata 不变，原 claim release 不释放 T2 新 token | 为避免 T1 误删而一概跳过所有同 ID，或原清理改了 T2 |
| Q9 已清原绑定、等待真实 stored grant，此时 T1 绑定 U8（ID 仍 C） | 撤 Q9/其 guard，grant/task/await 后全拒绝旧续体；新 binding 可按正常流程工作 | isStale 只比 null/C；null grant 后仍清 input/onNewConversation；旧 finally 将新 creating=true 变 false |
| state.currentConversationId=null 的同步回调中发生新绑定；或 onNewConversation 内 cleanup 后发生新 service 安装 | hook 内外复验；后续 clear/model/search/READY 或 service=null 不提交到新 binding | 把无 await 当原子；仅在回调前核 token，回调内部无条件清当前 service |
| 原 active subagent 在非 streaming READY reset 时 orphan | Tab.ts 原 reset callback 在 merge/save 前短路，业务写与 save 调用增量 0；普通 New Chat 对照仍先真实 save | 只删 createNew 显式 save，orphan callback 仍保存/合并同 ID 新对象 |

#### 13.4 论证链与反例

完整认证链：全部所需显式来源 → 正常选择/归一化保真 → 唯一 v2 sourceRevision 下的 count → 原 owner/读取许可/保存世代未变 → 本次 written → final stat仍同来源 → 无 await最终提交。

隐含假设显式化：adapter的完成语义可靠；所有本进程影响来源/保存的入口经过 owner/guard；provider支持的合法格式已由受控回归证明；外部文件在观察之后仍可能变化。

具体反例：完整 hydrate返回后，overlay await期间文件变更。它不推翻“读时完整”，但推翻“发布时仍对应观察版本”；因此 written后 final stat不能省。另一个反例 H2 推翻“有FIFO便能保证非阻塞”，而不是推翻 ack 的安全性。

删除 UI 链〔推算〕：首次异步前捕获原 O/UI token/tab 实例 → delete 只退役业务 origin，原 UI target 仍可获一次免保存清理许可 → 每个实际绑定入口撤旧 reset、同 ID focus 不误拦新 O → grant/task/await/嵌套回调提交均验原 target 或自有 reset token → 旧续体不修改新 UI。隐含前提是所有实际绑定安装与回调副作用都接入上述 hook；只画 token 无法证明此项。反例一：metadata 删除成功后继续调普通 createNew，save 在退役 origin 上 reject，blank 永远未提交。反例二：入口 token 正确但 grant 前重绑，回调内部 cleanup 当前 runtime 或 finally 无条件清 flag，新 UI 仍被破坏。它们分别推翻“删除路径无需区分业务保存”和“入口检查足够”；不能靠放宽 obsolete/written 或改变 FIFO 修复。

对既有结论的追溯：保留 typed ack/FIFO 的成立事实；R0-1/2 的完整性判定条件被证据证伪，不能继续信任 v1持久证书。两份局部设计中曾明确豁免旧 Claude ready 的范围，在本次统一设计中被纳入；**不改其文件或 status**。前向反事实：若不升 v2、删 owner incarnation、保留提前清门或去掉 final stat，以上反例仍会产生 false known。

#### 13.5 不变量判定

| 不变量 | 判定及位置 |
| --- | --- |
| ready 与完整性正交 | 设计成立：中立 ready/error/void不变，sizeRead独立；Claude fallback/ Codex partial不新增打开错误。 |
| 同族算法/来源单一 | 设计成立：同 filter旁出、同normalizer审计、各provider现有唯一revision函数；worker只是透传。 |
| 原对象与许可不可换绑 | 设计成立：业务origin在首次异步前固定，main mutation前验证；再以owner/read/save ticket约束后半链。仅有存储ticket违反此前半链，见§6.1/13.2。 |
| 观察比较与公开资格正交 | 设计成立：rawBefore↔rawFinal核来源；gate只决定安全candidate，不能改变比较输入，也不能把原始known绕门持久化。 |
| 删除完成、物理擦除、失败恢复正交 | 设计成立于组合§6.4：保持provider契约；uncertain仅凭新业务事实退出，不能靠统计或重放旧票据。 |
| 业务 origin 退役与旧 UI 清理授权正交 | 设计成立于§6.5：删除完成凭据只清捕获的原 binding，不授业务写；普通 New Chat 仍先 save。原 createNew(force) 直接复用违反此项。 |
| tab 实例×绑定生命期×复位续体全覆盖 | 设计要求成立，未实测：§6.5 覆盖真实准入、guard、grant、task、await 后、嵌套回调与 finally；仅 token/ID 检查不成立。重绑只撤旧清理，新业务/UI 不被改动。 |
| projection FIFO 与 UI reset 不形成新环 | 设计成立：原 live 取消/失效在 stored 等待前；UI reset 不入 B、不等 stats/create，不强释放实际 user lease；原 predecessor 不推进时不提供 UI 完成期限。 |
| 列表行版本与成员关系均受保护 | 设计成立：行stamp不覆盖“旧列表无该ID”的信息缺口；枚举后新ID保留，旧batch不能全量覆盖。 |
| 来源细化不变成新保存世代 | 设计成立：origin不改，仅关联provider证明的after；不重新capture签发。 |
| 清门/正值发布仅一次且无await | 设计成立：统一提交段；written/final stat均在段外完成；旧gateEpoch任务退役。 |
| 数据流无环 | 设计成立：normal read→receipt→stats→metadata→UI；refresh不调用hydrate，rAF不请求stats，overlay不递归main保存。 |
| 扩展点在扩展方向 | 设计成立：provider拥有格式/来源，app只处理中立证据，UI不读opaque state；未实现能力自然退化unknown。 |
| 保存/正常加载完成后不等stats | 设计成立于H1：main/finish同步转交，无统计await；须真实链实测。 |
| 固定共享metadata严格FIFO且所有后续同ID保存均不受stats挂起阻塞 | **违反/未闭合**：H2、`SessionStorage.enqueueWrite`。U1未决，不能当作已成立。 |
| 实际stats资源有界 | 设计成立：至多2 actual pipeline，retired不释放未settle槽；当前intent取代历史waiting链。 |
| 多入口×机制覆盖 | 设计要求成立，尚未实测；下节矩阵逐格对应真实调用链，不能用局部app单测替代。 |
| 退化是一般情况特例 | 设计成立：空文件0须证明；partial/unsupported/无receipt走同一负状态；小窗口/大历史不分计数路径。 |

## 风险与权衡

### 1. 必须用户裁决

**U1-c 已获另行设计授权，具体物理方案仍是待确认项**：见隔离稿 D1–D4（地址/身份/排序域、旧格式与uncertain、保证范围、sidecar回收）。本稿保留的 U1-a/b/c 是原取舍背景；两稿组合不能既保留旧 overlay/FIFO，又声称 H2 已消除。

本记录明确设计目标与可证明边界，不因“理想”而伪造可取消 I/O，也不因工作量默认选 U1-a。用户确认前，U1相关实现不得开工；确认本 draft也不自动等于批准某个存储扩展。

### 2. 原批准修复与新增边界

| 内容 | 归类 |
| --- | --- |
| F1/F2/F3/F4/F6/F7/F8，完整receipt、原owner、v2认证、同步失效、主链移除统计await、真实可见性/TDD | 原 A 正确性实现；仍须本设计获批后实施，不另冒充新产品。 |
| 保守的保存开始负状态、失败不恢复未验证known | 原“失败不发布成功值/过期待更新”约束的明确化；不改成功保存或业务错误语义。 |
| 未来兼容写搭载、放宽known时效、改保存成功为“仅入队”、主动hover hydrate、附件另计消息 | 新产品/持久化触发边界，不能默认实施。 |
| 新sidecar/journal/提交地址、FIFO域变化、原子CAS/跨进程一致性、fsync保证 | 新存储授权；本案未选择布局，不承诺这些安全属性。 |
| 禁止size捕获额外opaque getter | 原白名单修复；并不授权真实秘密读取。 |
| 任意恶意getter/Proxy沙箱、持久证书签名、防外部篡改、安全根或路径权限重划 | 新安全边界，不在本案。 |
| B计量、渲染/lease/hidden-tab机制，配置/代理/hooks/CLAUDE与旧设计状态 | 冻结/禁止；不能借A接线修改。 |

### 3. 迁移/落地代价

理想终态需一次性收敛 source-only读取类型、provider receipt、owner/save/read状态、全真实入口和可见性，而不是保留新旧两套清门语义。v2使旧持久统计冷失效，用户可能短期看到待更新，直到既有正常加载产生新证据；这是拒绝已错误认证旧快照的必要代价，不通过扫描迁移降低架构。

written后 final stat增加有限观察成本；两实际槽被真实挂起占住时其他统计可长期unknown，这是有界旁路的诚实退化，不以无限并发换表面及时。U1-c若被选择，另需存储迁移、跨域删除/崩溃语义设计；不因迁移工作量改本次目标，也不把它偷塞进原A修复。

本轮行为只经过源码核对和纸面推演。新增协议的运行性、worker透传、真实onOpen/关闭接线、不可取消I/O分类及Obsidian宿主表现均未实测。宿主验收需另行授权、仅受控合成会话，不把jsdom通过称为Electron部署验收。

删除后复位的局部代价仅为真实 Tab/manager/controller 的绑定与 reset hook、必要 origin-aware 准入和镜像测试；不改持久方案或 provider 删除。creating/switching 忙时保持原 skip，不假称已 blank；原 projection predecessor 不 settle 时仍无 UI 完成期限。D01–D09 是实施前置闸门，若转绿需要改变 B/runtime 释放/取消语义或新删除等待，应停止并回传，不借本订正实施新架构。

### 4. 交付物规范

#### 4.1 目标目录树

绝对根 `/Users/vincentwang/Documents/NoteVault/tools/claudian`。标注“后续”的产物只是规范，不是本次写入授权。

```text
/Users/vincentwang/Documents/NoteVault/tools/claudian/
├── docs/designs/
│   └── 2026-11-07-conversation-size-contract-consolidation-restart.md  [本轮唯一新建]
├── tests/unit/providers/claude/history/
│   └── sdkBranchFilter.test.ts                                     [后续新增，先红]
├── tests/integration/features/chat/
│   └── conversationSizeLifecycle.test.ts                           [后续新增，真实onOpen/关闭链]
└── .context/sdd/ethereal-dancing-emerson/
    ├── task-1-contract-restart-implementation-report.md              [后续实施交接]
    ├── task1-contract-restart-r1-review-package.md                    [后续A-only冻结包]
    └── task1-contract-restart-r1-snapshot/                           [后续只读镜像]
        ├── manifest.json
        ├── src/...                                                 [精确批准路径]
        └── tests/...                                               [精确批准路径]
```

无本轮 source/test/config/runtime数据新建；一次性受控 transcript/中间文件只在独立 `/tmp/claudian-size-contract-<随机>/`，不作交付物。不得落真实聊天或多轮临时脚本到业务目录。

#### 4.2 命名与 README 索引

- 设计：`YYYY-MM-DD-conversation-size-contract-consolidation-restart.md`。conversation-size说明A领域，contract-consolidation说明统一契约，restart说明独立重派；不是旧设计vN或自动替代。
- unit测试镜像生产模块名；Lifecycle集成名表明覆盖真实容器/入口，而不是又一份app-only测试。
- `task-1-contract-restart-*` 表示这次独立A修复交接；`r<N>` 表示新冻结轮次，不能覆盖R0/旧package/snapshot。目标已存在时停止报告，再由主会话明确下一目标/操作方式。
- 长期设计/回归产物索引应登记到 `/Users/vincentwang/Documents/NoteVault/tools/claudian/README.md`。已读README没有专门设计产物索引；本轮禁止回填，由主会话在另获授权后登记本记录与新增回归入口。

#### 4.3 产物清单与消费者

| 路径 | 用途/消费者 |
| --- | --- |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-07-conversation-size-contract-consolidation-restart.md` | 本轮唯一draft；主会话、用户、后续实施者/独立设计复核。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/history/sdkBranchFilter.test.ts` | 后续新增：同算法输出兼容与分支证明负例；实施者/回归。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/conversationSizeLifecycle.test.ts` | 后续新增：真正onOpen产生的view/tab/menu/close接线与H1/H2/H3；独立验收。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/conversationSize.test.ts` | 修改既有受控main/provider/storage/app链；补原始观察/安全投影及真实provider删除故障链，不能手工刷新代替失效通知。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/controllers/InputController.test.ts` | 修改既有：标题/resume异步起点origin；与Controller/View/TabManager既有镜像回归共同覆盖必要调用者。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task-1-contract-restart-implementation-report.md` | 后续报告：逐finding、逐矩阵格的红/绿命令与退出码、观测值、哈希、未覆盖、U1裁决和边界；主会话与复核者。不复用旧report。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task1-contract-restart-r1-review-package.md` | 后续A-only范围、保留改动与新改动、基线/邻接区分；复核者。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task1-contract-restart-r1-snapshot/manifest.json` | 后续source/test全文件只读镜像哈希；复核者据此区分工作区/冻结事实。 |

上述新测试之外，既有unit载体全部就近追加：app ConversationSizeService、Claude/Codex history/index/store/size、SessionStorage、Controller/View/TabManager/TabBar、formatter；不得新造一套测试专用统计实现。绝对命令清单见验证方式。

#### 4.4 归属引用与偏离声明

遵循 `/Users/vincentwang/Documents/NoteVault/tools/claudian/CLAUDE.md` 的 provider-native-first、镜像tests与 `.context` 交接约定；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/CLAUDE.md` 的中立seam；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/CLAUDE.md` 的正常历史路径；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/CLAUDE.md` 的入口与同步快照交换约定。

偏离仅一项：通用开发规范的编辑后build不适用于本次显式禁止build/deploy的设计任务。当前不写任何 `.context` report/package、测试、源码或README；唯一新建是指定设计记录。旧设计/status、B冻结和用户配置不变。

## 验证方式

**全部下列行为测试均为交实施阶段的TDD矩阵，本轮未执行，不宣称通过。**

### 1. 测试真实性与安全前提

- 使用唯一新建的 `/tmp` fixture根、明确映射的Claude session路径、Codex显式root/path、内存Obsidian adapter。允许mock host/时钟/文件故障边界和无网络runtime factory；不使用真实HOME聊天、凭证或用户配置。
- 被测 provider history/index/parser、app、SessionStorage、main、Controller、view rAF、TabBar必须走真实实现；禁止mock receipt/ready/publish/刷新/FIFO结果来证明它们正确。
- integration要实际走 `ClaudianView.onOpen` 所装配的 tab callback/主菜单，不只Object.create view或自己拼一个“相似”callback。宿主仅模拟Obsidian API，不替换被测onOpen/close方法。
- `onChanged` 可用spy/latch观察终点；不能手工调用被测updateTabBar来证明自动失效通知。推进受控rAF之后断言真实aria-label/菜单文本。
- hung测试用可控不settle边界，在观测窗口保持挂起，分别断言业务settled、操作是否开始、actual active与typed结果；断言后清理fixture时可释放deferred。测试超时仅用来判红，不能成为生产I/O取消保证。
- worker用真正序列化执行而不是mock返回complete。展示禁止路径用spy证明没有调用acquire/build/hydrate/parse/full iterate/DFS/listMetadata；getter还要证明没有stat/overlay。
- 每个新增格先对冻结语义下的旧实现跑红，再改生产代码，再同命令转绿。合法空/正常known等兼容格旧实现可能已绿，须明确是回归，不伪造红测。
- 删除测试至少一例以 /tmp 下映射的 SDK session 路径制造真实 fs.unlink 错误（例如该 `.jsonl` 路径实际为目录），穿过真实 deleteSDKSession→Claude history service→main→SessionStorage；断言 unlink 确实失败且原 catch 后业务按原语义继续。metadata/legacy 删除异常另在真实 VaultFileAdapter.remove/exists 边界注入或制造，不能 mock provider.deleteConversationSession reject 冒充 Claude unlink 失败。
- 原身份测试由真实 InputController/ConversationController、main 及 UI 输入/确认入口触发；允许在无网络标题 runner/transport 挂起响应，但不能手调一个自造 callback 或 mock main mutation 的返回。必须覆盖迟到 mutation **尚未发行 storage ticket** 的前半链漏洞。
- 同口径比较测试实际暖起 Claude 完整 cache，经正常业务保存开启 gate，再从普通统计入口走 provider→app→storage→final stat。断言磁盘与公开 history 均 stale、files known、gate 未清，且真实写后 stat 已发生。稳定来源旧实现可能已绿的部分记回归；新增final-stat缺口及来源变化应红，另用混比 comparator/未降级落盘的定向变异证明此格可检出设计缺陷。

- 删除后 reset 必须从真实 `ClaudianView.onOpen → TabManager/createTab → Tab.ts/initializeTabControllers → main.deleteConversation → 专用 controller reset → 默认 ProjectionWriteCoordinator → Tab.ts 回调` 进入。只 spy 观察 save/reset/cancel，不替换被测方法返回；现 main integration 的“列表里已没有 ID”不足以证明原 tab 已复位。
- 同 ID 测试在 provider/metadata 真实边界挂 deferred，**先发 create 请求，等原 B 持久删除完成后，再用真实 open/reserve/restore 绑定返回的新 origin**。断言新 TabData/UI token/runtime 与消息/input 实际安装，不能只把 conversations 数组换对象，或由测试直接给 tab/state 填一个 token 假装重绑。分别测同 tab、不同 tab/同 tabId 新实例和跨 view。
- projection 窗口用真实 coordinator 的前驱 grant 或生产 stored load 的受控 I/O占住；队列/grant/task 仍执行生产实现。grant 后/task 前、runStored 返回后/回调前及同步 setter 回调重入分别留观察点；不得 mock runStored 为 null/已完成来证明安全。无法从真实可控调用点覆盖的窗口须记未覆盖，不新增测试专用生产入口。
- 原 READY 非 streaming、有消息及 active subagent 的删除，逐项断言 delete Promise 真 settle、旧 tab blank/welcome/空输入/READY、metadata absent，且删除持久完成后的 save 调用及业务 write 增量均 0；不能以“obsolete 没写成功”替代“没有调用保存”。另留普通 New Chat 的真实先保存/原异常对照。
- 同 tab 重绑必须实际穿过 switchTo：同 ID 早退认 incoming origin；仅凭原已完成删除 ticket 不保存已删 outgoing，非删除/删除未确认/普通 obsolete 的 outgoing 不得借此变成功。新绑定完成后固定其 metadata/UI/runtime/claim/guard 基线，再放旧清理，断言**旧清理追加增量为 0**；不禁止 incoming 正常 backfill/save/stream 或把它们的合法写算成旧清理。两稿 D02/T40 同此口径。

### 2. 入口 × 机制 TDD 矩阵

缩写只用于表内，精确文件见后续命令。P=真实provider/index/store unit；A=app unit；S=真实storage unit；I=既有尺寸integration；L=新Lifecycle integration；M=既有main integration；V/T=既有view/tab unit。

| 格 | 真实入口 × 机制 | 受控样本/操作 | 必须观测的红绿终点 | 载体 |
| --- | --- | --- | --- | --- |
| C01 | Claude正常index → 分支认证 | 缺anchor；anchor在旧分支不在latest ancestry | 原canonical/window输出不变，size incomplete；不能known fallback计数 | P + I |
| C02 | Claude direct/实际worker/completed cache → 同证据 | 对C01及正常anchor分别跑三模式 | receipt/complete一致，worker不可丢branch证据；原输出逐项相同 | P |
| C03 | Claude正常chain → 完整性聚合 | 正常显式previous链；缺segment/partial/skipped/opaque anchor | 正常链known；各负例unknown；既有oversized错误不被改写 | P |
| C04 | Claude首屏loadWindow → 统计旁路 | 300轮，只读50轮；冷cache/getter未ready | known300，不known50/冷0；stats无acquire/build/全文读 | P + I |
| C05 | Claude capture → 白名单 | forkSource额外enumerable getter计数/抛错；subagentData getter哨兵 | 额外getter读次数0；必要来源仍有效；捕获后原值改变不改变snapshot | P + A |
| C06 | Claude normal ready → 统一许可 | loadActive真实lease、缺metadata/拒ack/final stat改变 | old两参数不清门；新receipt也须written/final检查；负态自动rAF | I + L |
| X01 | Codex normal hydrate → 损失审计 | 单坏input_text缺text；有效/坏混合；坏output_text/role/content | 正常兼容数组保留；pure坏不known0、mixed不known部分count | P + I |
| X02 | Codex normalizer → 合法空/非文本 | 0-byte、content=[]、text空/空白、空event；正常tool/reasoning/compact boundary、tool数组output | 合法省略不误坏；有真实nontext消息按真实count；未支持semantic part统计unknown | P |
| X03 | Codex parser各入口 → 同损失语义 | legacy、mixed、response_item/event_msg、compacted replacement含坏项 | 不漏某格式；正常消息输出与旧兼容样本一致 | P |
| X04 | Codex正常fork → 合并证明 | pending/established、checkpoint缺失、source/native缺一、重复/缺turnId | 正常fork known；negative/fallback仅ready不complete；bytes保留角色且物理去重 | P + I |
| X05 | Codex正常加载 → 来源细化 | 原path/root缺失，本次正常发现回填；已有身份被更换 | 合法K0→K1可经原世代发布；非法细化拒绝；不重捕epoch盖章 | P + I + M |
| X06 | Codex cache/freshRead → 请求许可 | 保存后hydrationKey命中；正常main加载freshRead；pending内存早退 | 普通skip不清门；已有正常实读可恢复；hover不hydrate/DFS | P + I + M |
| O01 | OpenCode/未实现seam → 退化 | void/无receipt；共享数据库 | 不加打开错误，不stat共享DB为单会话，history/files维持批准unknown | P + M |
| R01 | 重启/冷列表 → v2持久认证 | v1假known不改文件；v2已认证快照；旧messageCount很大 | v1失效、messageCount不迁；v2经stat/written/final可恢复；getter不直接known | P + A + I |
| A01 | 两参数ready/三参数receipt → 清门 | save成功，metadata缺失、各skipped、缺ack、reject | 全部保留门/无positive提交；metadata恢复后的普通refresh仍不能借旧proof清门 | A + S + I |
| A02 | 普通/证明refresh → 最终对象 | 同ID同source替换/删除重建；旧保存finish也晚到 | 老ticket/receipt/candidate不能作用新incarnation；positive次数0 | A + I + M |
| A03 | 正常读取 → saveEpoch | 读取pending中beginSave：成功/失败/尚未完成；重叠两个save | 每次开始均撤旧许可；成功记失效；失败不伪造成功；旧finish不清新save集合 | A + I |
| A04 | 写后stat → 文件变更 | written之前/之后改文件，同路径不同F；版本仍被cache持有 | final观察不匹配就无positive/不清门；重启不能信过期证书 | P + A + I |
| A05 | 请求合并 → 许可隔离 | 普通↔proof两完成序；两normal load倒序；旧finally | 不吞许可，不跨generation/owner；旧unknown不覆盖新known；旧finally不删新job | A + I |
| A06 | beginSave/invalidate → 通知 | 原badge known2；stat挂起/overlay各负ack/reject | 下一rAF为unknown/stale，另一tab不变；不得手调刷新作证明 | I + L |
| A07 | ordinary/proof → 真实两槽 | 两pipeline永久占用，多次刷新/开关/失效 | actual<=2；旧intent被替换；关闭需求撤销；不无限起I/O或放弃计数 | A + L |
| A08 | 真实Claude complete cache→普通stats→写后stat | 无新normal proof，gate开；两次原始observation同V/count，写入candidate history stale | files按实际stat可known，公开/磁盘history均stale，gate不变；真实final stat存在；混比或raw直接落盘须失败 | P + I |
| A09 | A08的红对照→最终来源变化 | 在实际统计write pending时改变合成transcript，后放行ACK | final原始V/bytes不同即拒绝旧发布、不清门；不能靠省略final stat修混比 | P + I |
| B01 | Input初次标题/Controller regenerateTitle→main mutation | 标题底层响应pending；callback mutation未发行ticket；delete→同ID同title recreate后返回 | origin在异步前捕获；新记录title/status/providerState及metadata写增量全不变；正常同owner/silent/手工标题规则仍回归 | I + L + Controller/Input回归 |
| B02 | 手工rename/输入框→两步main写 | 打开inline/tab输入框后换同ID；另在rename与清status之间退役原身份 | 所有子写同origin，迟到输入不能改新记录；旧origin不触发beginSave/发storage ticket | M + L |
| B03 | 回填/save/resume/fork cleanup/环境批次→main | 各既有异步间隙撤原登记，恢复/重建同ID再放行 | 原对象传到底，旧mutation零业务写；正常入口输出/保存与B机制不变 | I + M + Controller/Input/TabManager回归 |
| R02 | list枚举→晚安装 | 枚举仅A后create新ID B；两个load batch倒序；另测同ID重建 | B不丢、旧行不覆盖，过期batch不安装；仍按原业务排序，非仅行stamp单测 | M + I |
| R03 | 旧Claude正常loader→资格probe | preferred/legacy分别缺providerId（并测既有null默认），显式codex/非法值为反例 | 默认都为claude且正常read后可known；错误provider仍拒绝；无额外补字段写 | M + I（组合隔离稿） |
| S01 | saveSizeSnapshot → typed ack | preferred/legacy成功；missing/obsolete/identity mismatch；读/写/parse/cleanup故障 | 精确written/skipped或原异常reject；missing零写、不创建；written仍非final有效 | S + I |
| S02 | overlay/save/delete → FIFO | overlay→save、delete→overlay、overlay→delete；前项reject | 顺序和最后文件内容正确；失败不毒化后队；不嵌套同ID队列死锁 | S |
| S03 | 真实Claude unlink失败→provider→main delete | /tmp制造物理unlink错误，metadata删除仍成功；Codex/OpenCode原生保留作对照 | Claude原catch后业务可成功、不新增uncertain；其他provider原生文件零删除；不mock provider reject | I + M |
| S04 | 真实metadata/legacy删除reject→正常load→重试delete | provider按原契约resolve，业务remove/exists真失败；恢复有效原记录再delete | 原Promise reject；新O/handle、新delete ticket；旧ticket永远obsolete；重试成功后同ID create新R，stats旧写不复活 | S + I + M（组合隔离稿） |
| S05 | delete reject→恢复absent/不可判定 | 物理已部分删除但调用reject；分别重读两路径缺失、损坏、不可读 | 仅确认absent且旧IO全settle才解屏障；旧reject不追认；后续明确create可成功，吞错null不作证据 | S + I + M（组合隔离稿） |
| H01 | Controller.save → H1 | 两纯stats槽挂起；第三metadata真实已完成 | saving在stats未释放时settle；actual仍2；无新known | I + L |
| H02 | main.getConversationById → H1 | 真实Codex hydrate完成，async stats stat挂起/排队 | main正常返回且history原结果正确；不是等待统计；error兼容另测 | I + M + L |
| H03 | main.switchConversation → H1 | 与H02同样但真实switch入口 | 正常switch数据返回，不等stats；不靠mock main loader | I + M + L |
| H04 | TabManager.closeTab → H1 | 真实controller.save已完成metadata，stats挂起 | close返回、tab资源/绑定消失，另一tab不污染；no stats drain | L |
| H05 | view.onClose → manager.destroy → H1 | 原persistTabState/业务save可完成，stats挂起 | onClose完成；closing之后迟到事件不再排rAF/改DOM | L |
| H06 | 同IDoverlay → 后续save → H2 | 真实SessionStorage队首overlay.read/write/cleanup分别挂起 | 记录后续业务write未开始；U1-a明确仍阻塞，不能报全目标绿；b/c按获批新协议验收 | S + L |
| H07 | 业务save/正常reader → H3对照 | 无前置stats，让业务自身write或正常reader挂起 | 业务仍未完成，不提前报成功；与H01/H06的起因日志不同 | I + L |
| E01 | Controller.loadActive → lease receipt | 真实restore，正常完整/partial/fallback、同ID替换 | 只有实际固定lease证据可授权；normal restoration不被size失败改变 | I + L |
| E02 | Controller.switchTo → lease receipt | 真实dropdown switch、来源/对象变化、normal完整 | 与loadActive同协议；不以完成时live lease重盖章 | I + L |
| E03 | refreshHistorySearchSnapshot → 同步交换 | search/rewind/fork触发；next ready后交换排队；切换/旧lease更换 | 原交换无await/I/O；只成功的固定next receipt在交换外通知；不复活释放lease | I +既有Controller回归 |
| U01 | view.onOpen的onTabSwitched → hidden菜单 | 真实TabManager.switchToTab，主菜单关闭，多会话行 | 列表stats请求增量0；getter无stat/overlay；不只测controller.toggle | L + V/T |
| U02 | view主菜单open/refresh → 当前展示 | 真按钮打开/可见重绘、随后close | 先可见再请求，所有当前展示行获需求；隐藏不获需求，关闭撤需求 | L |
| U03 | legacy controller菜单 → 相同可见机制 | 真实toggle，close/reopen，原pending请求返回 | 旧epoch/session不能写新行；不能因guard首次打开也0请求 | I + L |
| U04 | 所有主菜单关闭路径 → binding退役 | document click、选本会话/新tab、tab切换/关闭、view close | 每条路径撤旧session；迟到结果不写旧/新容器；重复开关不累积队列 | L |
| U05 | menu/tab失效通知 → paint-only | save失效但stat/persist挂起；菜单已开/已关 | 已开行/绑定badge下一帧unknown；已关零列表请求；paint不再触发refresh环 | L |
| U06 | TabBar hover/focus → 普通需求 | 当前badge、旧移除badge、同ID新tab实例/重绑 | 当前普通请求无hydrate/build；旧binding拒绝；数据绝不写新active会话 | L + TabBar回归 |
| U07 | 多view/tab → 迟到与owner | A/B tab，切换/关闭/clear；同ID替换；view关闭重开 | A仍绑定可更新A，关闭/重绑的旧接收者不更新；B aria-label不含A值 | I + L |
| U08 | 两入口getter/formatter → 无I/O和口径 | known、missing、unsupported/incomplete/stale、pending fork；10 locales | list/tab同文案口径；单aria-label无title；source提示正确；getter无I/O | A + V/T +formatter |

删除后 UI 补充矩阵；生产范围为 main、ConversationController、InputController 的必要 origin/lazy binding 接线、Tab.ts、TabManager、tabs/types，不含 provider/lease 算法改造。D01–D09 与隔离稿 T39–T47 一一对应：

| 格 | 真实入口/窗口 | 必须观测的预期 | 必要载体 |
| --- | --- | --- | --- |
| D01 | onOpen 装配的 READY、非 streaming、有消息原 tab → main.deleteConversation，provider/metadata 正常完成 | 真实 delete 返回；原 tab 完整 blank/READY/welcome/空输入、无新 conversation；删除后 save 调用和 metadata write 均 0，原 origin/handle 仍 retired，无假 written | L + M + Controller/Tab 回归 |
| D02 | delete 在 provider/metadata pending，申请同 ID create；持久屏障结束后实际重绑同/不同 tab，旧 cleanup 才运行；含跨 view | 新 O2/UI token 已真实安装，不被 ID-only focus 截回 O1；同 tab 原 cleanup skipped；不同 tab 仅旧 tab reset；新 metadata/messages/input/runtime/stream/claim 均未被取消、保存、清除，业务删除不多等新 create/stats | L + M + TabManager 回归 |
| D03 | 原 reset 已开始并等待真实 projection；同 tab 新 binding 进入，随后释放前驱 | 旧 reset 在 grant/task/await 后全部拒绝；新绑定可正常 restore/send，旧 finally 不清新 guard，不 empty 新 DOM/重置输入/READY/cleanup 新 runtime | L + Controller/Tab/TabManager 回归 |
| D04 | grant 后 task 前、DOM/state setter 同步回调、runStored 返回后到 onNewConversation 内发生重绑；含相同 origin detach/rebind及相同 tabId 新实例 | 每个旧剩余提交被拒；真实回调内条件 cleanup，不将新 service 置 null；不是只测入口 token；无法覆盖的窗口明确未证 | L + Controller/Tab 回归 |
| D05 | 原 READY active subagent orphan，及原 reset 自有 detach 后迟到 orphan/取消回调 | 原 domain orphan 可完成，Tab.ts 在 stream/merge/save 前短路，save/业务写增量 0；新 binding 回调仍正常，不按 ID merge 到新 O | L + Tab 回归 |
| D06 | 原 user/auto streaming delete；另让新 O2 已在同/不同 tab streaming，再放旧清理；cancel watchdog/晚 finally | 只原 binding 能 cancel/bump/invalidate；auto 实际 lease release 与 user 原 finally release 分别观测，默认 FIFO 不绕过/不 dispose；新流与 UI 不变，旧 origin 不产生业务写；旧 predecessor 不 settle 时不谎称 reset 返回 | L + Input/Controller/Tab 回归 |
| D07 | 普通 New Chat/普通 force，READY 有消息；真实业务 write pending/resolve/reject | pending 时尚未清绑定/消息；真正保存成功后才 blank；原 reject 传播，不用 obsolete/统计 ACK 当成功；shell/no-message及普通 busy guard 回归 | L + Controller/TabManager 回归 |
| D08 | provider 原 resolve（含真实 Claude unlink 失败被 catch）、provider 真 reject、metadata/legacy 真 reject、UI reset 真 throw；stats 两槽仍 pending | resolve→metadata→原 UI reset；真实持久 reject 不 reset，原 uncertain 契约不变；UI throw 使外层 reject但持久 absent不翻案；skipped UI不是 written；全链不 await stats | I + L + M（组合隔离稿） |
| D09 | 原 creating/switching 已忙、原 tab closed/manager 换人、旧 reset 与新 reset 交叠 | 不抢普通操作，不新增等待/补偿 New Chat；明确 skipped/busy/retired，不称已 blank；旧清理/finally只释放自己，正常新 guard 不变 | L + Controller/Tab/TabManager 回归 |

H06必须在U1裁决前保留为“已揭示约束/未闭合”而不是假造PASS；它不是允许任意实现改变FIFO的借口。

### 3. 精确命令与证据产出

只在实施获批、目标新测试存在后执行。以下为目标范围，不在本轮执行；不跑全套，不build/deploy/reload。每次保留直接退出码，红测不能用管道掩盖。

Provider/证据层：

```bash
node /Users/vincentwang/Documents/NoteVault/tools/claudian/scripts/run-jest.js --selectProjects unit --runInBand --runTestsByPath \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/history/sdkBranchFilter.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/history/ClaudeTranscriptHistoryIndex.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/history/ClaudeConversationHistoryService.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/history/ConversationSize.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/history/HistoryBudgetMaterialization.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/history/HistoryDisplayOrderMaterialization.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/codex/history/CodexHistoryStore.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/codex/history/CodexConversationHistoryService.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/codex/history/ConversationSize.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/opencode/history/ConversationSize.test.ts
```

App/存储/UI镜像回归：

```bash
node /Users/vincentwang/Documents/NoteVault/tools/claudian/scripts/run-jest.js --selectProjects unit --runInBand --runTestsByPath \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/app/ConversationSizeService.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/storage/SessionStorage.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/controllers/ConversationController.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/controllers/InputController.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/ClaudianView.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/Tab.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/TabManager.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/TabBar.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/utils/conversationSize.test.ts
```

真实受控集成：

```bash
node /Users/vincentwang/Documents/NoteVault/tools/claudian/scripts/run-jest.js --selectProjects integration --runInBand --runTestsByPath \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/conversationSize.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/conversationSizeLifecycle.test.ts

node /Users/vincentwang/Documents/NoteVault/tools/claudian/scripts/run-jest.js --selectProjects integration --runInBand --runTestsByPath \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/main.test.ts \
  --testNamePattern='getConversationList|loadSettings|updateConversation|renameConversation|deleteConversation|createConversation|getConversationById|switchConversation'

npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run typecheck
git -C /Users/vincentwang/Documents/NoteVault/tools/claudian diff --check
```

ESLint用 `/Users/vincentwang/Documents/NoteVault/tools/claudian/node_modules/eslint/bin/eslint.js` 定向列出本次实际获批 source/test 绝对路径；不加 `--fix`、不扫描其他B文件替它验收。新文件另做 `git diff --no-index --check /dev/null <绝对路径>`。测试依赖已存在才运行，不能为本设计默认安装或更新依赖。

人工/报告核对：每个 known追到v2正常证据与final stat；每个清门追到同owner原许可和written；H1/H2/H3分别记业务操作started/completed与stats槽读数；每个UI入口由真实事件触发、每个负状态由自动rAF显示。报告逐格标注〔实测/既有读数/推算/纯示意〕、红绿终点、命令退出码及未覆盖项；空白格不能由“已跑旧718测试”补齐。

### 4. 验收裁决

只有原A正确性矩阵、正向完整能力、禁止展示重读、实际资源边界和所选U1契约均被真实链验证，才可提出A验收；U1-a只能报告“保留H2限制的变更边界”，不能悄悄改原非阻塞条款或宣布全A PASS。

本次订正交付仅为：**两份既有 draft 的删除后免保存 UI 复位、原 binding/自有 reset guard、真实准入/await/回调衔接与 D01–D09（隔离稿 T39–T47）已同步补齐；既有 A–D/存储/provider/性能取舍不变。源码链已核对；具体方案与 U1-c 仍待用户确认；未实施、未运行行为测试、未批准部署；frontmatter/status 不变，无新产物。** 初稿建稿/哈希记录保留，不作为本次新实测。

## 关联

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task-1-contract-design-brief.md`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task-1-brief.md`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task-1-review-brief.md`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task-1-review-r0.md`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task-1-review-r0-peer-supplement.md`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task-1-persistence-report.md`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task1-ready-r0-review-package.md`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task1-ready-r0-snapshot/manifest.json`
- [[tools/claudian/docs/designs/2026-11-06-codex-ready-unblock]]（只引用，不修改/status不变）
- [[tools/claudian/docs/designs/2026-11-06-conversation-size-persistence-ack-resume]]（只引用，不修改/status不变）
