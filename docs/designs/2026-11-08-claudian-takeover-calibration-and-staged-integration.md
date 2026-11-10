---
type: design-decision
status: draft
target: "[[tools/claudian]]"
tags:
  - architect
  - claudian
  - takeover
  - staged-integration
---

# Claudian 接管校准与分阶段整合计划

## 背景与问题

接管“claudian优化”的已批准工作，区分已经交付的功能、仍开放的恢复合同与共享工作区归属，按独立单测、复核、阶段合入和整体回归推进；不重设计已收口功能，不把旧绿测当当前整体验收。

**路径：务实。** 本记录是新的接管设计，不覆盖、订正或替代任何既有记录。既有用户批准的实施主体无需因本记录为 draft 再次整包审批；新增业务政策、提交/合并、部署仍分别过授权门。核查只读，未运行行为测试、构建或真实插件，未联系其他 session。一次性提取仅在 `/tmp`，本轮唯一正式产物是本记录。

### 1. 原始目标及后续裁决

依据 `/Users/vincentwang/.claude/projects/-Users-vincentwang-Documents-NoteVault/c906c448-04c0-4b3a-8b7d-115daefca4e9.jsonl` 的实际用户轮次及完成回执，以下仅记任务结论，不复制会话正文。

| 时间（+08:00）/证据定位 | 有效范围 |
|---|---|
| 11-06 15:08–16:10，原日志 39933–40363 | 定位 Obsidian 卡顿；原“渲染根治”经独立复核发现等价性及论证不足。后续只推进不改变渲染行为的性能期 0，不认定 DOM 已是卡死主因。 |
| 11-06 15:33，40124；19:03，41484 | 历史列表及 tab 悬停展示体积；同意 A/B 独立部分并行，共享接线串行。 |
| **11-07 21:41，44447–44456** | **A 明确收窄为当前 session 原生日志文件体积；去掉历史轮数。** 不是关联文件求和、上下文 tokens、`.meta.json` 体积或分支独占磁盘占用。 |
| 11-08 09:42，45394；11:47，45473 | 修复已发现的恢复竞态；确认“读取与提交分离、关闭撤销旧资格、独立索引 lease、保存内容/回执隔离”的修订方案。native 同源启动是否需要退出屏障先实证，不凭推测增加阻断。 |
| 11-08 16:51，46740 | 在适合时设计两线整合及主干合入；必须先核实真实仓库/分支与变更归属。 |
| 11-08 18:48，46852 | 异常非 native thenable 不再主动执行；正常同步通知不变。该修复已完成局部独立复核，不再重开选型。 |

**范围排除**：旧 A 完整历史认证、统计 sidecar/R-F 持久身份重划；性能期 1–4、流式分块、隐藏 tab DOM 卸载；新增 Steer now；SDK/模型升级；代理、配置、CLAUDE、worktree 治理；跨崩溃通知 exactly-once。旧 A 草稿和旧性能 confirmed 文档保留原状，不能据其磁盘 status 恢复已撤回范围。已有 parser/分支测试是否进入提交，按归属和回归用途判断，不借范围收窄清理文件。

### 2. 实际仓库与基线

〔实测：只读 Git，2026-11-08 22:04 +08:00〕

- 源码独立仓库：`/Users/vincentwang/Documents/NoteVault/tools/claudian`；唯一登记 worktree 即该目录。
- 当前分支 `fix/model-identity-sorting`，HEAD `cf47730d2109e798fd27ddacc712038d26883d5b`。
- **真实主干 `main`**，`origin/HEAD → origin/main`；本地 `main` 与本地 `origin/main` 均为 `1ab2ab831700b2833aae3f40b4ca5a49b7d1fa1e`。未联网 fetch，不能宣称远端实时状态。
- `main...HEAD` 为主干独有 0、当前分支独有 **24 个既有提交**，含此前 compact、模型身份/排序等基础修复；新功能阶段合入不能偷偷连带它们。
- 工作区 **59 个 tracked 修改、31 个逐文件 untracked 项**，为新建本记录前读数。不能按整份 HEAD diff、文件 mtime 或文件名认领 session；当前 Git index/分支也是共享状态。
- 外层 `/Users/vincentwang/Documents/NoteVault` 在 `master`、HEAD `6df1b707fc9c66360ed324abdcdc4104394841e3`。**外层 vault 的 master 不等于 Claudian 的 main**；不顺带提交外层业务笔记。

## 方案设计

### 1. 每功能验收账

“既有读数”含已完成 agent 回执/冻结材料；不是本轮重跑。“实测”在本轮仅用于 Git/文件比对。原线最新可查回执为 11-08 19:19；是否仍有写者由主会话的 courier 回执确认，不根据离线或日志停止推定。

| 功能 | 当前证据与状态 | 不足/下一动作 |
|---|---|---|
| **A 当前原生文件体积** | 既有回执 44950：Spec PASS、Quality APPROVED。当前 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationSizeService.ts` 为内存观察；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/utils/conversationSizeSource.ts` 只对显式单文件异步 stat；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/utils/conversationSize.ts` 只显示 bytes/未知。Claude 当前 providerSessionId 优先、排除 previous/fork source；Codex 仅现有 sessionFilePath；OpenCode 共享数据库不统计。 | 保留功能，**不重写统计**。首悬停时 Obsidian 已打开 tooltip 的视觉更新未实机验收；共享接线变化后需定向回归。 |
| **B Markdown 性能期 0** | 回执 45308：修复宽泛 `it.failing` 假阳后 Spec PASS、Quality APPROVED；当时 B 46/46、A/B 合成对拍 20/20。真实调用→collector→mapper→JSONL 已装配；低频汇总、关闭释放、脱敏、显式 census 有证据。 | **未证明卡顿根因或性能收益。** 目前集成文件还承载恢复线测试，不能用整个文件绿色推断 B/恢复各自完成。 |
| **共享索引/固定 lease/cursor** | 已逐轮修复和复核。最新 `/tmp/claudian-review-4GcEd81S/current/` 七文件与工作区 **7/7 字节哈希一致**。`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts` 已按 lease 分发进度、独立终态；index 保留 exact-instance pin/flight 交接。 | 已交付部分直接采用。物化读取的文件身份缺口仍开放，见 I1；不是 lease 隔离全部失效。 |
| **异常返回/测试握手清理** | 回执 46793、47026：Scoped Spec PASS、Quality APPROVED。最新原始 `/tmp/claudian-sync-return-NQYLS6Bh/five-suites-first.jest.json` 为 **5 suites、381 通过、0 失败**；Service 单套 203。复核还验证循环 thenable getter 一次、then 调用 0、其他 lease/timer 可推进。 | 不再改异常返回策略。恶意同步 getter、外部隐藏拒绝、被篡改 native Promise 不在保证内；冗余参数非阻断。 |
| **本线 P1、Stop、普通单次授权、命令探测、模型/思考标签** | 派单明确源码与定向验证已收口，未提交/部署。 | **只接收其 owned diff、接口与验证凭据；不重新设计、不把后续 P2–P8 全部加成 Stop 前置。** 被共享整合触及的接口才做回归。 |
| **cleanup 后续责任（P2）** | 当前 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts:290–298` 在 recovery-source/cleanup 抛错时仍可跳过后续清理；View 已尝试逐项清理，不能据此推断所有路径完整。 | 拆分必做清理、保留原错误身份、只回收本次资源；不把“调用 cleanup”称实际 CLI 已退出。 |
| **hydrate attempt/runtime ownership（P3）** | P1 的本地错误归属改动已存在，保留。当前 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts:574–607` 仍有 stale 分支 `cleanupTabRuntime(tab)`；`isStaleHydration` 还含 SHELL 副作用。 | 补 attempt/runtime-install 凭据及旧进度/旧清理隔离；不能清理被新 attempt 复用的同一 runtime。已关账错误处理不重做。 |
| **Reader/Observer 交付与恢复（P4/P5）** | IO lane、watcher-local polling latch、P1 host token 已落；不当作待建。当前 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptTailReader.ts:132–158` 先提交 cursor、poll await 后才查 watcher；prime 仍 void；Observer recover 仍 number/null、path stat 后另 open。 | 接受后提交 cursor/partial/identity；区分 ready/missing/stale/source-changed/failed；恢复只映射完整 newline。超长行/missing 行为政策未拍板的部分不切换。 |
| **恢复提交与保存 receipt（R2/P6）** | 批准的准备—提交方向尚未闭合。当前 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts:849–855` 把活 Conversation 交非 index hydrate；OpenCode `:45–52` 读后改共享 messages；Controller `:1439–1458` 用通知型 setter 顺序提交并 sync runtime，`:1424` 无条件清 dirty。 | 纯准备、消息图隔离、静默 backing binding、原对象/source/data/turn 版本；同步 accepted receipt 与真实 written/failed 分开。不能拿 boolean READY 或 Promise fulfilled 代替。 |
| **最终布局/重开（P7）** | 当前 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ClaudianView.ts:285–286` 先存布局、后 destroy/drain；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/storage/SharedStorageService.ts:35–42` RMW 未排序、错误仅 Notice；SessionStorage 队列是实例级。 | 真实 accepted saves→最终原 manager layout→cleanup；同宿主跨 storage 实例写序/读屏障。保留全局最后合法接受的单份布局，不另建 per-view schema。 |
| **物化/tail 来源配对（I1/P8）** | 已有真实文件合成反例：物化 stat→open 换源，98→98/193 B 读出新 UUID、旧索引身份；window→prime 换源，旧 offset=468 与新 468 B 文件配对后漏观察。当前源码形状仍在。 | I1 先堵同对象物化读取；P8 再把 current segment/variant/committed boundary 与原 binding 一起移交。完整 Controller/Tab 动态贯通尚缺，不能把合成 mock 环境称实机。 |
| **native 同源启动交接** | 原批准方案要求先实证。没有凭真实退出/安全复用确认闭合的交接证据。 | 条件门，不默认新建 NativeSourceRegistry、不封锁纯历史读；若确有同源并写需求，先取得可信关闭/复用合同再设计该窄门。 |

**整体基线读数**：11-08 02:15 原线报告 unit **6688**、integration **309** 通过，临时副本构建通过；其后新增恢复修改，不能再称当前全套通过。最新 B 冻结包 56 个文件中 **42 同、14 变**；A2 包 7 个中 **3 同、4 变**。这证明旧包不能直接覆盖当前共享文件，不证明变化归属。

### 2. 复用与合同收敛

采用已批准的“纯准备＋静默提交＋独立订阅＋宿主写序”，不新增 actor/事件溯源系统。

1. **索引**沿用已复核 shared/flight/lease/cursor；lookup 是发现入口，不是旧 lease 的生存许可。
2. **A/B**沿用现成 WeakMap 观察身份、同步 getter、rAF、collector token、logger；它们不升格为业务 binding、保存或文件身份凭据。
3. **恢复资格**在首次异步/注册回调前固定原 record incarnation、tab/manager 实例、binding/attempt、source/data/turn revision、claim 和 runtime-install 凭据；不能返回后按 ID 补身份。运行期身份不写成旧 A 的持久 R/F 头。
4. **非 index 历史**返回 `PreparedHistory`：messages 为 keep/replace，字段 patch 显式 keep/set/delete 并带预期版本，cache intent 独立。Codex pending fork/空读、OpenCode 空读及原 fork 拼接不变；不能整份旧 providerState 覆盖当前值。
5. **单一 backing 提交**：准备/复制/可失败预检在 projection grant 外；grant 内复验后只换 backing 引用、受控 binding/claim/lease，不调用通知 setter、runtime、DOM、diagnostic 或 save。通知、runtime adoption、投影随后逐点核 receipt。正常后台流不因非活动而退役。
6. **保存**沿用已接受保存账，但补 `SaveAdmission = rejected | accepted(receipt, durability)`；receipt 固定原对象/binding/dirty revision/runtime source/目标/sequence。序列化和一次性状态采集在接受前，之后立即进入目标 FIFO。ACK 仅确认 adapter 写及原必要清理，不是 fsync；旧 ACK 不清新 dirty。
7. **写序**复用 SessionStorage 的 FIFO 原理，改由同一宿主 App＋vault/plugin namespace 长寿命协调器持有。metadata save/delete/create、legacy 迁移和 layout RMW 不得绕过；新实例读取有读屏障。业务不 await stat、diagnostics 或 source 恢复来解除自己的写。

R2 接口只由唯一 integrator 冻结于 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/ChatRuntime.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/state/types.ts` 及既有 storage 契约。按上述实际语义沿用 `PreparedHistory`、`CommittedTabBinding`、`CommitReceipt`、`SaveReceipt` 名称；叶子实施者不能各造不兼容 DTO。新增能力不能把旧“直接修改共享对象”的调用当新保证的兜底；完成迁移后生产历史入口必须走同一准备/提交协议。

### 3. 可执行切片、文件和单测

下表均为后续获准实施范围；本轮不改。每项：目标红测→最小实现→同命令绿测→相关既有回归→冻结 owned delta→独立 reviewer。单元测试由该功能实施者完成，不能只交给最终整合者。

| 切片/优先级 | 生产文件、接口 | 单测/可观察验收 |
|---|---|---|
| **I1 / 最高** | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeTranscriptHistoryIndex.ts` 的 `readIndexEntries`：复用 scan 的 open→handle.stat→同 handle.read 模式；读取前核 index dev/ino、长度。所有 page/detail/tool association 调用继续共用这一入口。 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/history/ClaudeTranscriptHistoryIndex.test.ts`：stat/open 窗口换源等长/长/短均拒绝，正常 append 可读，短读失败、handle 总能关闭；保留真实 worker、cap、pin、握手清理断言。旧实验证据 `/tmp/claudian-index-review.VAsAI5/results.jsonl` 的 rc0 是坏行为被复现，不是产品 PASS。 |
| **L1 / 高：P2** | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts` 的 cleanup/destroy；必要 View 仅由 integrator 接。每个必做动作独立尝试，原资源引用/原异常不换绑。 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/Tab.test.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/TabManager.test.ts`：首动作抛错仍执行其余 cleanup，原错误身份/多个错误保留，新 runtime 清理次数0；重复 close 单次。 |
| **T1 / 高：P4＋P5 局部** | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptTailReader.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptTurnObserver.ts`：同步接受后提交候选 cursor；异步消费 FIFO 分开；typed prime/recover、同 handle 身份、newline、owner 错误。保留 IO lane/watch latch/P1 host 收口。 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/transcript/ClaudeTranscriptTailReader.test.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/transcript/ClaudeTranscriptTurnObserver.test.ts`：接受前 stop/start 旧接收0、新接收1；接受后失败不盲重放；poll open/read/close 错误有 owner；无 newline 映射0；partial 跨 UTF-8；真实在途 IO 未结束不偷放 lane。missing/oversized 未决政策仅留红测，不擅自切行为。 |
| **L2 / 高：P3** | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts` 的 hydrate attempt、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts` 的 `initializeTabService` 返回安装凭据；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/types.ts` 携窄 token。只处理 P1 未覆盖的 runtime/attempt 所有权。 | 上述 Tab/TabManager 单测＋`/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/controllers/ConversationController.test.ts`：旧 a1 进度91不得盖 a2 进度37；同 runtime 被新 attempt 复用时旧 cleanup0；旧 finally 不退后新 READY；P1 错误处理原回归保持。 |
| **R / 高：R2＋P6** | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationHistoryCoordinator.ts`（新）、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/state/ChatState.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts`；必要 Input/Stream/AutoTurn 的数据/turn revision 写点一并盘点，不改其调度/Stop 语义。 | 新 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/app/ConversationHistoryCoordinator.test.ts`；既有 ChatState/Controller/Input/Stream/AutoTurn/main 镜像测试。OpenCode 旧读不能覆盖新消息；Codex keep/replace/patch 相容；通知 close/switch/save 重入只看完整 binding；dirty7 的 ACK 不清 dirty8；保存 A 不读 runtime B。 |
| **S / 高：P6＋P7 存储** | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/storage/PersistenceCoordinator.ts`（新）、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/SessionStorage.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/storage/SharedStorageService.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/storage/StorageService.ts`、View/Manager/main 唯一共享接线。保留 metadata/layout 格式，不建立统计 sidecar。 | 新 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/core/storage/PersistenceCoordinator.test.ts`＋`/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/storage/SessionStorage.test.ts`、storage convenience/layout/main 既有镜像测试。跨两 storage 实例写1→写2最终为2；失败仍 reject；lazy 新 ID 必须进最终 layout/reopen；layout RMW 无丢更新、unload 不被宿主 await 仍有同 App 写序。 |
| **H / 高：P8 整体交接** | exporter `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts`；中立 `HistoryWindowPage.tailStart`/runtime 可选能力；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/state/ChatState.ts`、Controller、Tab、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts`、Reader/Observer。与 R 的 binding 提交及 T1 一起收口。 | Service/index/runtime/Reader/Observer 既有单测；新 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/historyTailHandoff.test.ts`：真实 export→Controller→State→Tab→Runtime→Observer→Reader；同一 fixture 贯通，不分别 mock 两端。 |

**P8 冻结合同**：中立外壳 provider＋协议版本＋opaque payload；Claude payload 来自原 index 的 source-chain、显式 current/live target、segment ordinal/session、path、dev/ino、snapshotSize、committedOffset、variant。current 缺失时历史旧段可以展示，但不导出旧段冒充当前 tail；pending fork source 不自动当新会话 writer。prepare ticket 不发业务事件，完整 binding 提交后再 activate；runtime 排队前捕获整份 restart request。普通分页/search refresh 不重 prime 已运行 observer，不跳到较大 offset。source reset 不代替 P1 host 完成，不补造历史完成通知。

### 4. 第一批并行派单

**F0 先行，短闸门**：主会话收 courier 的停止/释放回执；一名 runner 制作白名单 manifest，逐项记录“原已保留/本线已复核/原线已复核/共享待整合/未认领”、绝对路径、起点及终点 hash、owned patch、接口、测试命令/结果。不读取真实配置/正文、不把整个 diff 当 owned patch。未知归属阻止对应文件写入，不阻止完全独立叶子任务。

F0 对相应路径通过后可并行，不用 Workflow、不新建 CC worktree：

1. **implementer-high：I1**，仅 index 源码及其 unit，保持其余已冻结六文件；与 Reader/UI 不共享写文件。
2. **implementer-max：T1**，Reader/Observer＋各自 unit 一名负责人；P4/P5 成组，无 P8 公共接口/运行时写入；保留已收口 P1。需裁决部分仅做目标测试和已确定资格合同。
3. **implementer-high：L1**，Tab/Manager cleanup＋其 unit；不同时启动 L2/R 共享写者，不处理真实 CLI 退出策略。
4. **runner：A/B 当前关键链验证**，只在冻结临时副本运行，不改共享集成文件；A/B 新的失败不得交给该 runner 现场修码。

每路 source/unit 写集合互斥；`/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/markdownRenderDiagnostics.test.ts`、main、View、Controller、Tab、TabManager、核心 types 由**唯一 integrator**串行管理。runner/reviewer 读取冻结副本；写者未释放时不靠“只读工作区”假装同版本复核。

随后：L1→L2；T1 的接收/结果合同→H；R/S 先由 integrator 固定中立 DTO 后，Codex 准备实现、OpenCode 准备实现、PersistenceCoordinator 核心可各自并行；共享 binding/save/layout/H 最终接线串行。R/S/H 不能当互不依赖的功能各自上线。

### 5. 阶段合入及整体回归

| 阶段 | 可合入边界 | 门槛与回归 |
|---|---|---|
| **M0 基础归属** | 核实 `main..cf47730d` 的24个既有提交；推荐按已批准/已交付基础认领后纳入，不能退回旧 compact 基线规避。 | 主会话确认这24项是否允许连同合入。若不允许，先设计精确提取，不能普通 merge 连带。当前不提交/合并。 |
| **M1 已成熟功能** | A/B、七文件已闭合部分、I1及本线四项可确认独立的 owned slices。 | 每项自己的 unit、相关集成和 reviewer 通过；精确阶段树含全部新文件、没有未认领 hunk。剥离会破坏共享接口则延后该项，不机械拆半协议。 |
| **M2 局部生命周期** | L1/L2、T1；只提供其已确定合同，不声称完整 R2/P8。 | P1/A/B 保留；局部控制/反例、实际接收/错误/资源归属独立复核。尚未裁决的 missing/超长行行为不能混入。 |
| **M3 恢复闭环** | R＋S＋H 的准备/静默 binding、保存 receipt、宿主写序、最终布局和来源移交成组。 | 全入口矩阵、共享 fixture、正常控制、错误及重入均通过；独立 reviewer 检查旧 ACK/旧 cleanup/半提交；高影响结构变化可再由独立 architect 只挑合同硬伤。 |

**每次真实合入 Claudian main 后，整体 unit＋integration、typecheck、lint、隔离 production build 各执行一次。** 功能开发阶段只跑该功能 unit及受影响集成，不每次补丁重跑全仓；unit/integration 可在同一已冻结 main 树的不同 HOME/TMPDIR/cache 路并行。失败先定位具体套件，原失败日志保留，同一目标修复后定向重跑，阶段结束再跑一次整体；不以十轮无关基线重演代替定位。

#### Git 安全前提

- 当前没有明确的本轮提交授权，所有 Git 动作仅是方案。主会话须取得**准确仓库、归属片段、提交及合入 main**授权；原线旧部署授权、peer 消息、review PASS 均不能替代。
- 同一共享树内先暂停相关写者，冻结 staged tree/hash；用 reviewed owned patch/临时 index 预演，不能 `git add -A`、整文件覆盖、restore/reset/stash/clean 别人工作。interactive `git add -p` 不是这里的可执行工具路径。
- staged diff、新增文件与认领清单逐项相同；由精确 candidate tree 构建/测试。构建当下整个脏工作区后，再提交另一个树，不算该提交的验证。
- **直接切 main/merge 的前提是工作树和共享 index 已有安全交接、相关待提交修改不被带入。** 未达到时仅做临时精确集成快照和回归演练，明确记“未合主干”，不假报阶段 merge 完成。
- 若用户要求在共享树仍脏时立即真实分阶段合入，需先确认独立干净集成副本/工作线的运维方式；本方案不自作主张开 worktree、改 refs 或用临时副本冒充真实 main。
- 合入前检查真实 `main` tip/merge base、当前分支及树清单；新提交/新接口或 hash 变化只重开受影响门。不推送、不清分支/目录，不顺带提交外层 vault。

### 6. 推演：具体红绿靶子与结构判定

本节新结果为〔推算/纯示意〕，不是测试；既有读数来自上表证据。

| 锚值/链 | 旧/已观测 | 绿判据；红判据 |
|---|---|---|
| 物化 I1 old-001，98 B；校验后换 I2，同98 B | 〔既有读数〕返回 new-002，仍挂 I1 索引。 | 同 handle.stat 确认 I2≠I1，交付0条；若仅 path stat或仅长度相等即放行，为红。 |
| index I1 committed=468；prime前 I2 size=468 | 〔既有读数〕读0 B且无 reset，新源轮次漏观察。 | 原 I1凭据不能接受，返回 source-changed；不能通过测试继续期待“没事件”来报修复。 |
| I1 committed=100、snapshot=120，合法追加至150 | 〔纯示意〕若从150 prime会丢半行前缀。 | 同身份且 `0≤100≤120≤150`，从100续接；补齐行一次。size降到110虽≥100，仍相对已观测120失效。mtime/ctime改变不单独拒绝正常append。 |
| current S2缺失，S1 committed=400 | 〔既有源码读数〕segments最后成功项可能是S1。 | S1可历史展示，S2没有有效tailStart；把400移给S2为红。 |
| 5 B新行，读完至接受前切代 | 〔推算〕先cursor=5再拒旧batch，两代可能都未接收。 | 旧接受0/新接受1、拒绝时cursor未推进；接受后callback失败则保留原错误，不盲重放。 |
| A binding b1→B→A b3，b1 late cleanup | 〔纯示意〕ID/路径可能再次相等。 | b1对b3 runtime/DOM/claim/dirty改动0；新旧token正交，不能晚查当前实例。 |
| 保存 dirty7已接受，新消息dirty8，ACK7返回 | 〔既有源码读数〕当前最终无条件置false。 | ACK7真实结果保留，但dirty8不清；failed不称written。布局仅在合法最终保存后捕获新ID。 |
| B三个输入UTF-16长度3/6/9 | 〔纯示意〕沿用既有metric合同，不改桶。 | calls=3、charsSum=18；`A😀`.length=3，不是UTF-8字节5。守恒跨flush核算，不能把工作量显示成A大小。 |

论证链：**provider原索引产生来源凭据→同对象handle读取→原binding同步接受→cursor提交→完整binding后激活**，在已观察到的 replacement/truncate 下防坐标系错配。隐含前提是原生来源前缀仅追加、全部实际入口遵守此合同。**具体反例**：同inode在两次观察间truncate后又长回，或原地改写至等长；dev/ino＋长度不能证明旧前缀还在，推翻该前提。本案不宣称处理任意非协作改写、已消失字节或跨进程原子快照。

不变量判定：

- **正交性**：source/binding/attempt、P1 host、index pin、projection grant、save receipt、A/B诊断身份分别所有；目前裸offset、stale清当前runtime、dirty布尔违反，位置已列，目标合同修复。
- **无环**：慢读/复制在grant外；业务保存不等待stat/日志；save确认→layout→cleanup，layout不能成为该save自身前驱。当前“先layout后drain”违反最终快照顺序。
- **扩展方向**：provider解释source/patch，features只传中立DTO/opaque tailStart；不解析pageKey、不另造统计/identity服务。
- **退化**：小Claude仍走同index；0B是known0而非missing；无tail能力provider维持原历史路径，不冒称来源已验证。
- **入口覆盖**：restore/switch/retry/懒runtime走同binding；window/detail/tool association共用同handle读取；poll/host catch-up/recover共用接受合同；normal/lazy/backfill/close/unload走同receipt；debounce/close/reopen/legacy layout共用同RMW排序。全部须动态实测，不仅列函数存在。

### 7. 交付物规范

**① 新增目标树（锚定绝对根）**，除本记录外均是后续获准产物，不是已创建：

```text
/Users/vincentwang/Documents/NoteVault/tools/claudian/
├── docs/designs/2026-11-08-claudian-takeover-calibration-and-staged-integration.md
├── src/app/ConversationHistoryCoordinator.ts
├── src/core/storage/PersistenceCoordinator.ts
├── tests/unit/app/ConversationHistoryCoordinator.test.ts
├── tests/unit/core/storage/PersistenceCoordinator.test.ts
└── tests/integration/features/chat/
    ├── conversationRestoreLifecycle.test.ts
    └── historyTailHandoff.test.ts
```

**② 命名**：设计日期＋主题slug、首版无vN；不supersede旧稿。生产沿用PascalCase职责名，unit镜像同名；integration按实际机制命名，不继续把新增恢复用例全部塞进Markdown诊断文件。现有混合测试不批量移动/重命名。后续正式设计及回归入口登记到 `/Users/vincentwang/Documents/NoteVault/tools/claudian/README.md` 的产物/回归索引；本轮不改README。

**③ 产物与消费者**：本记录供主会话/用户/实施者/复核者；ConversationHistoryCoordinator供main/controller准备/版本/提交编排；PersistenceCoordinator供SessionStorage、SharedStorageService及legacy storage同目标排序；两份unit各验证真实模块；conversationRestoreLifecycle集成验证真实Plugin/View/Manager/Controller/provider/storage；historyTailHandoff集成验证同源export/import。用途与绝对路径如上，不新落业务明细或新统计库。

临时证据根为独立 `/tmp/claudian-takeover-<实际run-id>/`，分路`home/`、`tmp/`、`cache/`、`candidate/`、`manifest.json`、首轮`results.json`/logs和owned patches；不作正式业务产物、不登记README、不覆盖已冻结包。设计规范要求实施者将实际随机绝对路径及精确命令内联到runner派单，不能只写“按方案落盘”。

**④ 归属引用/偏离**：沿用 `/Users/vincentwang/Documents/NoteVault/tools/claudian/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/CLAUDE.md` 的native-first、中立边界、固定window和镜像tests；正式记录落现有工具仓`docs/designs/`。有意偏离：一次性材料仅/tmp；一般编辑后裸build条款让位于本任务安全构建/不部署门；不修改旧设计、README或CLAUDE。本计划未新增业务持久格式。

## 风险与权衡

### 1. 执行方式推荐

| 合理方式 | 权衡 |
|---|---|
| **按owned slice小批推进、叶子并行、共享唯一整合者** | 推荐。复用已交付功能，反例/回滚边界清晰；需要短冻结和逐项归属，而非按文件整体认领。 |
| 全线冻结后一名实施者整批串行 | 操作简单、归属更易管，但拖延独立I1/T1，回归难定位；仅在共享归属始终不能分离时采用，不为了“快”整包提交未知改动。 |

核心复杂度来自恢复/保存正确性，不再来自被撤回的完整历史规模。R/S/H必须成组，不能以分期理由降低终态；阶段源码通过不等于允许部署半套协议。

### 2. 真正裁决与事实门

| 类别 | 推荐/需要主会话处理 |
|---|---|
| **换源/missing策略** | 推荐保留已显示UI但明确来源失效，先走既有显式retry，不自动全史重建、不补发历史完成通知。是否自动等待/重建及UI替换时点须用户明确；身份拒绝本身属于已批准正确性补全。 |
| **超长未闭合行** | 硬预算不能以静默丢行变绿；显式gap/暂停恢复 vs可证明opaque-gap投影尚未裁决。先完成不依赖该政策的P4接受/错误合同。 |
| **Git授权及24个基础提交** | 明确是否提交认领片段、把既有24项纳入Claudian main；未明确不提交/merge。master/main名称已核实，无需重命名仓库。 |
| **共享脏树不能阶段清净** | 可以继续临时精确树回归；真实阶段合入的干净集成方式需主会话向用户确认，不擅自开worktree/清脏。 |
| **native同源/退出** | 先实证，是事实门而不是默认产品新规则。需要新启动屏障时再给窄范围设计；真实进程/CLI退出与逻辑claim释放不能互相替代。 |

不重复询问：A单文件口径、B期0范围、非native thenable拒绝、P1/Stop四项已收口、单份最后合法布局。旧R1a关账只证明局部封闸，不追改为“完整R2已完成”。

## 验证方式

### 1. 安全测试/构建固定要求

1. **先冻结精确candidate输入**：源/tests/config仅白名单复制；前后sha一致；包括untracked source/tests。不得hardlink源码，node_modules可只读软链。复制期间hash变化即停止，不能用mtime或“看起来没动”认证。
2. 每并行路独立 HOME、TMPDIR、Jest cache和localStorage。现 `/Users/vincentwang/Documents/NoteVault/tools/claudian/scripts/run-jest.js` 固定把localStorage写在`os.tmpdir()/claudian-localstorage`，不同路共享TMPDIR会互相污染。清掉继承API/proxy/用户路径环境；只用临时合成transcript/metadata/日志。
3. 仅mock SDK/Obsidian/传输/物理故障边界，不mock被测lease、FIFO、receipt、cursor提交、mapper或保存结果。spy透明调用生产方法。真实Worker的合成索引测试与真正Obsidian/CLI仍是不同证据等级。
4. 每功能使用上表精确unit路径；共享集成只由integrator写。原宽泛`it.failing`问题已修，新增测试必须明确到目标断言，注入无关异常要变红；控制组正常路径保留。
5. 定时器/Jest自然退出纳入结果；不`--forceExit`掩盖cleanup、不把超时当IO/CLI已退出。若新增退出异常，仅对具体失败套件一次`--detectOpenHandles`定位，不重复全仓排查旧噪声。

命令模板在**已创建的实际副本**中使用；主会话派单需用真实绝对路径代入`C/D`：

```bash
R=/Users/vincentwang/Documents/NoteVault/tools/claudian
# C=已冻结candidate绝对路径；D=本路独立临时根；下列目录须先建立。
(cd "$C" && env -i PATH=/opt/homebrew/bin:/usr/bin:/bin \
  HOME="$D/home" TMPDIR="$D/tmp" \
  /opt/homebrew/bin/node "$C/scripts/run-jest.js" \
  --selectProjects unit --runInBand --cacheDirectory="$D/cache" \
  --runTestsByPath "$C/tests/unit/providers/claude/history/ClaudeTranscriptHistoryIndex.test.ts")
```

I1替换为其精确路径；T1/L1/L2按上表同命令追加各自unit。A/B接线的最小integration集合：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/nativeSessionSize.test.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/markdownRenderDiagnostics.test.ts`（按B/P1/R1a分组报告，不混淆功能）
- 新增restore/tail两份integration，在实际创建后运行。

**构建必须在副本调用副本script**。`/Users/vincentwang/Documents/NoteVault/tools/claudian/scripts/build.mjs` 的ROOT来自脚本目录；仅cd到/tmp却调用源区脚本，仍会回源区写CSS/bundle。`esbuild.config.mjs`会读取`.env.local`、按OBSIDIAN_VAULT复制真实插件并清理cwd的`.codex-vendor`。

- 构建副本白名单：`src/`、`scripts/`、package/lock、manifest、esbuild config、tsconfig及实际必要构建输入；**不复制`.env.local`、生成bundle、用户配置、聊天和诊断数据**。
- 明确非空`OBSIDIAN_VAULT=/dev/null/claudian-build-only`，不能用空串阻止dotenv回填。
- 仅在副本执行 `env -i PATH=/opt/homebrew/bin:/usr/bin:/bin HOME="$D/home" TMPDIR="$D/tmp" OBSIDIAN_VAULT=/dev/null/claudian-build-only npm --prefix "$C" run build`。
- 原源码bundle/styles、真实插件bundle/styles构建前后hash不变；不复制回插件、不reload。现成安全构建证据 `/tmp/claudian-build-2s1wEHKU/`可参考操作，不冒称当前待提交树已验证。

### 2. 合入后的整体回归

在**实际合入main后的冻结树**按同一安全环境执行一次unit全部、integration全部、`npm --prefix "$C" run typecheck`、`npm --prefix "$C" run lint`、上述隔离build；记录commit/tree hash、命令、退出码、suite/test数量和未覆盖。运行前检查integration中需要真实CLI/网络的格是否已有授权；不能顺带触发真实模型调用。

`git -C /Users/vincentwang/Documents/NoteVault/tools/claudian diff --check`只检查tracked差异；新增文件另检查，不能当全量内容审查或归属证明。reviewer面向冻结的阶段diff＋准确新文件＋接口，不重审整份未认领HEAD diff。

**恢复全入口矩阵**：

| 入口 | 必须验证 |
|---|---|
| view打开/restore循环/create/fallback/cross-view focus | closing撤旧资格；旧claim不占新owner；后台合法stream保持 |
| loadActive/switch/retry/懒runtime | 原attempt/binding、完整静默提交、旧进度/cleanup不动新runtime |
| older/detail/tool association/search/rewind/fork | 固定lease、同handle读取；正常append；current/variant不混；分页不重prime |
| poll/host catch-up/recover | 同接受协议、newline/UTF-8、接受前切代、accepted后失败归原owner |
| normal/lazy/backfill/auto/subagent/save/close | 原capture、accepted≠written、dirty版本、旧回调不发新owner保存 |
| debounce/close/unload/reopen/legacy layout | 真实最终savedId、同App全目标排序、失败不假成功；宿主不await unload仍成立 |
| A/B与本线四项 | 真实两处体积、无hydrate/DFS/metadata写；诊断开/关/失败业务一致；已关账Stop/权限/命令/标签定向回归 |

### 3. 实机门及最终完成判据

另行授权后，在受控合成会话的Obsidian/Electron中确认：首次已打开tooltip更新、列表/tab切换与删除、新旧view关闭重开、真实Markdown结果/错误与诊断白名单。性能期0再采冷/长历史/后台流式、显式DOM census及真正卡死现场；没有现场证据不输出CPU收益或根因结论。真实CLI/同源退出如触发需求另测，不用Jest SDK mock或合成子进程冒充。

功能完成须同时具备：其自己的单测、目标反例和正常控制、独立复核、阶段main整体回归、精确归属/树证据；真实UI未验项单列。**提交、合主干、部署、实机验收是四个不同状态**。本轮到此只交设计，不越过任何执行门。

## 关联

- [[tools/claudian/docs/designs/2026-11-06-markdown-render-metric-contract]]
- [[tools/claudian/docs/designs/2026-11-08-claudian-local-lifecycle-gated-slices]]
- [[tools/claudian/docs/designs/2026-11-08-upstream-compat-remaining-implementation-contract]]
- [[tools/claudian/docs/designs/2026-11-08-claudian-mainline-stop-once-adoption-gates]]（只引用既有范围，不重新设计）
- `/tmp/claudian-review-4GcEd81S/README.txt`、`/tmp/claudian-review-4GcEd81S/current/`
- `/tmp/claudian-a-review-20261107T2245/COVERAGE.md`、`/tmp/claudian-a2-fix-review-20261107T154623/MANIFEST.txt`
- `/tmp/claudian-b-final-review-pkg-wuQztd/MANIFEST.md`
- `/tmp/claudian-sync-return-NQYLS6Bh/five-suites-first.jest.json`
- `/tmp/claudian-offset-review.ETQEvYhb/snapshot/tests/unit/providers/claude/transcript/OffsetHandoffReview.test.ts`
- `/tmp/claudian-index-review.VAsAI5/results.jsonl`

旧完整恢复方案与后续身份交接意见分别见原会话完成回执45460、47054；用户实施确认45473。该证据链不改变既有文件status，不把尚待裁决的恢复政策追认为已批准。
