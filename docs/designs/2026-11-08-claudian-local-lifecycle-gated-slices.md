---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - claudian
  - lifecycle
  - evidence-gate
---

# Claudian 本方生命周期遗留：定位与分闸门切片

## 背景与问题

修复本任务遗留的 R1a、Observer、Reader 及其保存/布局/来源交接缺口，逐项独立验收；不把局部生命周期修复冒称跨 client 资源交接，也不把整套遗留问题扩大为 Stop 前置。

> [!warning] 独立 draft，非实施/验收授权
> 本记录不修改、不替代、不确认既有设计记录。不设计 Stop/result、权限或命令探测，不升级 SDK，不修改源代码/测试/配置/README，不构建、部署、提交、推送或清理工作区。
> 本轮只读源码/差异，并执行了四份定向测试；SDK 使用测试 mapper，数据、localStorage 与 Jest 缓存位于独立 `/tmp`。未启动真实 CLI/MCP。工作区有多 session 未提交改动，测试读数不是冻结验收。

## 方案设计

### 1. 边界、证据与现状

#### 1.1 基线

根目录 `/Users/vincentwang/Documents/NoteVault/tools/claudian`；HEAD `cf47730d2109e798fd27ddacc712038d26883d5b`。2026-11-08T08:49:24Z 为补充只读观察点，HEAD 不包含已读的脏修改。

证据标记：〔实测〕本轮实际执行；〔既有读数〕源码/测试/旧文档；〔推算〕源码因果推导；〔纯示意〕设计样例。未动态跑 HEAD，因此下文“既有机制”不冒称 HEAD 测试已复现；“新增回归”依据本树实测加 HEAD 源码对照。

定向结果〔实测〕：

| 范围 | 结果 | 数据真实性与限制 |
|---|---|---|
| Reader + Observer unit | 88 项，86 过、2 失败 | Reader 用真实临时文件及部分 fs 故障/时序注入；Observer 有公开方法与私有 `consumeBatch` 注入混用，不是 CLI 保证 |
| Markdown/R1a + nativeSessionSize integration | 113 项，104 过、9 失败 | 真实 Plugin→View→Manager→Controller/Storage 接线；Obsidian/SDK mock。部分 runtime/lease 被替换，只证明应用合同 |
| Reader suite | 通过 | 不等于所有切代/交付/I/O/长行预算缺口已关闭 |
| nativeSessionSize suite | 通过 | A 的当前可见行/对象身份回归通过，不等于完整 metadata、资源或任意来源 ABA 已证明 |

测试前后四份 transcript source/test 和六份 R1a/A/B source/test 指纹相同。未冻结所有依赖，尤其对方 index/history；涉及这些依赖的结果只作当时读数。

| 文件绝对路径 | 本轮测试指纹 SHA-256 |
|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptTailReader.ts` | `d55948ffae93066d97d0b7a673574733e11fc48d093debd5072de5e22e8130c4` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptTurnObserver.ts` | `409b94fa19bfb74a071fbc62a26f69cfcabf353294f78a3f54162d464dd9b357` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/transcript/ClaudeTranscriptTailReader.test.ts` | `5bb42ecfc4d0bd3210446a91637060b7500b7d33756fdb58992d245611cc66f3` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/transcript/ClaudeTranscriptTurnObserver.test.ts` | `cf8e1793344f3bb1dc2ea0f5e0a98595dce459471ff448f40e74e5ffc96b71d8` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts` | `b573ba7ab0ca8d68ef6ca00a3bc5a64810579ad46a543e0048fc7fcd653a3aa6` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts` | `13eecee1ae987996a833a2d0df621f5d129c73fd26ab0faca1419f0e98dfb6c5` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ClaudianView.ts` | `01ceca6354e5b4679fcd519600ce81fab45dc35f30c21b1c1eabd8ee1364bbe4` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts` | `b5274e5a433f88bbb88fe6a689c84a9e2d0e892bab0d1b05a11a521304b597ec` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/markdownRenderDiagnostics.test.ts` | `9e1164f706af5444cd62de35918300b5cf0e93d7998602063bc2b92bb1100c25` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/nativeSessionSize.test.ts` | `7c74e894032f884733c94bc0ed881f0bdd54a7d6c42655691c826f50cca2a21d` |

#### 1.2 失败账：生产接线、模拟与归因分开

下列行号均锚定本轮源码，不是实施时固定行号。

| 编号 | 观察结果/定位 | 真实性与归因 |
|---|---|---|
| O-host | Observer test:381–389，真实文件 truncate 后公开 `completeUserTurnProjection` 返回，`hostUserTurnId` 仍为 `host` | 〔实测〕生产类＋真实 fs。`consumeBatch` reset 增 generation，而完成方法:238 用旧 owner 退场；HEAD 没有该 owner 检查，是新增隔离防线带来的收口回归 |
| O-missing | Observer test:362–375，reset 恢复到 prime 时文件消失，仍调用 `reader.start` 1 次 | 〔实测〕私有 batch 注入＋prime/fs 故障。`prime` 吞 stat 失败、Observer 无结果判断，HEAD 同形。测试的“不能 start”是候选策略，不直接证明生产丢数或必然应永久停轮询 |
| C-cleanup | Markdown test:784–821，event cleanup 抛错，runtime cleanup=0、DOM 仍连接；lease release=1、另一 view 已拿新 claim | 〔实测〕真实 Manager→destroyTab，runtime 为 fake。Tab.ts:1946 逐项 cleanup 无隔离，HEAD 同形；当前单次 cleanup flight 又使重复 destroy 不补救。不证明真实 CLI 已退出 |
| L-layout | Markdown test:1511–1595，lazy save 的 meta 已写出新 ID，最终 layout/reopen 仍为 null | 〔实测〕真实 SharedStorageService＋临时文件＋真实 reopen；create 仅加等待 gate。View:285 先取 layout 再 Manager:1650 drain 是同形既有顺序，新增 accepted-save 保留不自动补布局，不能只称 R1a 新增丢数 |
| S-binding | Markdown test:1646–1736，state/claim 仍指 A，runtime 已 sync B；close 把 A session/thread 写成 B | 〔实测〕真实保存/临时 meta，但 session 更新 runtime 是可控 fake。Controller:1362–1417 从动态 runtime 拼 delta，HEAD 同形；尚缺真实 Claude/Codex 两向接线对拍，不能推出所有 provider 已生产损坏 |
| H-cleanup | Markdown test:2543、2591，旧 hydration 返回/失败，把后续安装或复用的 runtime 清掉 | 〔实测〕真实 hydrate/manager 流程、controlled runtime/lease。Manager:575/582/593/603–607 按当前 tab 清理，HEAD 已有同形 stale cleanup；仅 manager-active 不能区分 attempt/runtime binding |
| H-progress | Markdown test:2639，旧进度 91 覆新进度 37；test:2801，真实旧 index source 的 100% 覆新 queued | 〔实测〕前者 fake lease，后者真实 index/service/fs＋gate；Controller:954–957 与 Tab:1416 只核 manager-active，HEAD 同形。对方 index 未验收，不能把后一例单方归咎其改动 |
| H-click | Markdown test:3048–3102 的两种故障，tab click 的 Promise 无 UI rejection owner | 〔实测〕真实 badge click＋placeholder/rAF 故障；用 Promise Proxy 观察 catch/then，不直接触发系统 unhandled 事件。View:455 `void switchToTab` 无 catch，HEAD 同形 |

另有不在现有绿测覆盖内的 Reader 风险〔既有读数＋推算〕：

- I/O lane、过时代请求不提交 cursor、每 watcher 独立 polling latch已在当前改动中；不可重复当未修。
- `readAvailable` 先提交 cursor，poll 在 await 后才查 watcher generation；提交与交付间切代可丢未被接收的 batch。HEAD 同形，未新增实测，本轮不称已证生产漏行。
- `open/read/close` rejection 没有 tick 外层 catch，`void tick()` 可留下未处理拒绝；现有 read-reject 测试只直接 await 手工 read，不测 poll 出口。HEAD 同形。
- 旧 watcher 的 onBatch rejection 仍调用同一个 `onBatchError`。当前 Observer 注入的 handler 有 `owns(owner)`，故“旧 handler 会破坏新生产 watcher”不能直接成立；standalone reader 的副作用 handler 仍需隔离测试。现有 unit 甚至明确期待旧 error handler 被调用，须先冻结合同，不以改绿测试自证。
- `partial` 跨批无上限；自定义 maxReadBytes 可能一次越过 8 MiB tick 门槛，门槛目前在读后检查；恢复 scan 无完整 newline 时仍可能映射未提交片段。均是已有形状，不等于 Reader 全部并发修复失败。

`Markdown` 的 OpenCode known-baseline/control 测试通过时仍期待旧共享 Conversation 被覆盖；不是修复验收。整套非 index staged hydration/metadata 单写者仍按既有 R1h/R2 方案另行关门，不在此扩大实施。

#### 1.3 source identity/offset：已核实接口，未实测丢数

当前生产链为：

1. `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts:1020` 仅输出 `snapshotOffset=current.index.committedSize`。
2. `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts:527` 仅数字 offset；Controller 写入 state。
3. `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/state/ChatState.ts:117–118` 仅数字。
4. `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts:589` 设置 runtime offset；runtime:3587–3589 取出后清空，异步启动 Observer。
5. Reader:50–59 对 prime 时路径重新 stat，将当时 dev/ino 与外来 offset 拼接。read:74/99 也是 pathname stat 后另 open。

index 已有 `dev/ino/snapshotSize/committedSize/projectionVariantKey`，不能说缺底层身份；缺的是**跨边界携带与校验**。HEAD 同样只有裸 offset。

同路径在 index→prime 间替换且新文件长度≥旧 offset，可错误接受旧边界〔推算〕；本轮没有此端到端实测，不登记为已证丢数。`pageKey` 虽含 snapshot identity，但 feature 不应解析其内部字符串；不可拿不透明 cache key 当读取合同。

### 2. 复用与解层次

承接既有理想正确性不变量，实施分期；本任务不另选降低架构的务实路线。问题不只在“加 generation guard”，而在 guard 混用了 source、host、runtime binding、save ticket、layout 五种生命周期。

| 候选 | 权衡 | 推荐 |
|---|---|---|
| 每个失败点继续补 `isCurrent`/finally | diff 小；同 ID、同 runtime 复用、reset 会再出现变体，Promise 仍冒称 ACK | 不选作为整体方案 |
| 新建统一全局 lifecycle/事务框架 | 可以强约束；重复现有 registry/队列及已设计 R2 owner，扩大到 Stop/权限/命令 | 不选 |
| **既有 owner/token 分轴＋边界接收/保存 receipt＋局部原子交接** | 可分片，错误显式；跨 client 资源/完整 metadata 合并仍各有门 | 推荐 |

正向复用：

- Observer 的 `owner/owns`、`hostProjection`、consume FIFO；修正各自职责，不删除隔离。
- Reader 的同一 IO lane、watcher-local polling、旧 IO generation 失效；补交付窗口，不重建 Reader。
- Manager 的 beginClose、candidate 集合、单次 destroy/cleanup flight；补异常全收口，不靠第二次 destroy。
- A 的 WeakMap 对象身份、sourceKey/revision、独立 stat；B 的 collector token/binding/flush。二者已经直接规避统计阻塞业务和跨代诊断污染，不重做统计持久化。
- `getConversationSync` 已用于若干 warmup/init；保留纯 metadata lookup，缺口只盘点实际余下调用。
- index 的已存在物理身份与 committed newline 边界。它能直接解决跨文件 offset 不匹配，不新建 identity 服务或解析 pageKey。

### 3. 实施闸门与协作冻结

严格“一项→验证→独立复核→关账→下一项”，不并行写源码。主会话先安排独立 architect 只挑本稿硬伤；本记录当前未获该复核，也未获产品裁决。

**每项共同闸门**：

1. 明确本项写文件、只读依赖、排除项与用户待决项；有待决行为则不进入该行为实施。
2. 相关写者暂停本项重叠文件；冻结 HEAD＋脏 diff＋未跟踪内容＋文件 SHA-256。不擅 stash/reset/commit。不要仅冻结 HEAD。
3. 保留因果 fixture，先证明目标红测，补真实生产接线控制例；不用内部计数代替可观察结果。
4. 单 implementer 执行最小切片；同指纹跑定向回归；独立 reviewer 检查隔离、异常、接口漏接；主会话轻量抽查。
5. 确认“通过/失败/未覆盖/待产品决策”，存证后才开下一项；失败停在本项，不让后项兜底。

**并发边界**：另一 session 的索引七文件精确名单未在派单列出，不能猜名单。保守避让其全部 `src/providers/claude/history/`、相关 history tests 及其已声明共享合同；本轮一律只读。主会话须由对方确认精确七文件清单。

| 时点 | 谁停止写、冻结什么 | 是否需要对拍 |
|---|---|---|
| P1 host 收口、P2 cleanup、P3本地 hydration、P4/P5 Reader/Observer 私有合同 | 本方及其他 architect 后续 implementer暂停本项重叠文件；对方若不改这些文件可继续 index。涉及共享 integration test，由单 integrator 写 | 此时只关局部门，不等待整个 index 或 Stop 方案完成 |
| P6 save receipt/binding、P7 layout | main/Tab/Manager/Controller/shared storage/types 的所有写者停写；只冻结所涉接口与 A/B入口 | 对方若改这些共享文件，须先交接字段权属；不采纳其未验收代码为前提 |
| P8 source-tail 交接接口定稿前 | **双方暂停共享 source/tests/types 的写入**；对方提供最终 exporter 身份/committed/variant 合同及七文件摘要，本方提供 importer/reset/recovery 合同 | 同一临时文件/同一 snapshot，生产 export→state→runtime→Observer→Reader 双向对拍；两边不得各拿另一套 fixture 自证 |
| 最终整合验收 | 两方冻结所有本次重叠 source/tests及新文件，唯一 integrator整合；必要时 Stop/权限/命令负责人仅交接被触及 runtime 接口 | 同基线跑 A/B/R1a/transcript，核实际契约差异；接口重开或哈希改变即重开对应门 |

对方未冻结不能做 P8 接口落地；不妨碍 P1。不能要求对方先整体验收七文件才能修完全独立的 host 收口。

### 4. 最小可交付切片与顺序

#### P1：host 完成责任与 source generation 分离——最先可推进

- **文件**：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptTurnObserver.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/transcript/ClaudeTranscriptTurnObserver.test.ts`。
- **合同**：`hostProjection` 标识一次 host 投影，不由 source reset 代替。完成请求捕获 host token；reset 后仍清理同一 token 的 host latch，但不沿旧 source owner drain/promote。清理后重新取得当前有效 source owner再处理其队列。stop 或同 ID 新 host token撤销旧完成资格。
- **精确断言**：公开 `completeUserTurnProjection('host')` 遇 truncate/reset 后，旧匹配 host latch 清空；source generation 可以前进。若回调/读取期间 begin 同 ID 新 host，旧完成对新 token 的清空/投影/释放=0。reentrant start保持权威。不给 runtime 造 host-success/result/lease 信号。
- **验证**：先用现有 O-host 红例，再覆盖 reset+同 ID 新 host、reset+reentrant start、无 reset 双 embedded控制例；运行完整 Observer/Reader unit。
- **回滚/风险**：仅退本项 diff，不退当前 owner guard；旧 generation 接受过的 callback仍归旧 context。暂不动 missing、runtime/resource/Stop。不能靠忽略所有 owner 校验令红测变绿。
- **前置**：本项独立设计复核无硬伤＋两文件短冻结；不依赖对方 index 验收或用户 missing政策。

#### P2：cleanup 全路径继续执行，结果不等于资源退出

- **文件**：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts`；其 mirrored unit及现有 Markdown integration。
- **合同**：同步撤本 tab准入；捕获原 cleanup资源集合。每项 cleanup失败记账但继续后项，eventCleanups先摘取本次集合以防 reentrancy；lease/DOM/回调/原 runtime本地 cleanup各执行一次。最终聚合错误，不能把最后错误盖掉原错。清对象引用只在其仍指原对象时执行。
- **精确断言**：C-cleanup例第一次 close/destroy返回失败，但 runtime本地 cleanup=1、DOM disconnected、lease release=1；每个故障点均不阻后续项；并发 close/destroy共 flight，不靠 finally人工清理才达标。旧 cleanup不清后来安装的 runtime。UI claim释放不得被当作 CLI exit证明。
- **验证**：event cleanup、lease release、runtime cleanup分别抛错；reentrant close/destroy；另一 tab/view正常；独立 fake runtime只记录本地 cleanup，另注明未验证进程退出。
- **回滚/风险**：仅反向应用本项 owned diff；失败 flight保持可查询，不把错误统一登记为“资源已清空”。保持既有 claim释放政策，此项不启 R1b安全热交接。完整 exit barrier由其他方案负责，不能顺手扩成杀进程。

#### P3：R1a hydration attempt、runtime binding与 UI异常拥有者

- **文件**：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ClaudianView.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts`、必要的 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/types.ts`；对应既有 tests。
- **合同**：每次 hydrate有独立 attempt token，捕获 manager/tab对象、hydration generation、原 record/source绑定与 runtime绑定令牌。runtime对象相同而新 attempt复用时，绑定令牌仍改变。`initializeTabService` 返回/发布本次创建或借用的安装凭据；旧失败仅回收自己未安装/仍由自己独占的候选，不 `cleanupTabRuntime(current tab)`。
- progress callback捕获**消费者 attempt**并在应用前核验；同 source共用底层 index flight不意味着共用 UI消费者资格。索引不用为此新造一套 progress owner。`isStaleHydration` 判定与改 SHELL副作用分开，旧 attempt不能退后新 READY。
- SCHEDULED placeholder/rAF注册、LOADING正文、timer回调、tab click均有对应错误出口。当前 shell失败显示现有 ERROR+retry；过时代失败不 repaint当前tab，真实异常按已有故障通道报告一次。所有 UI fire-and-forget有 rejection owner；不吞成成功，也不抛原始私密正文到日志。
- **精确断言**：H-cleanup两例新 runtime仍安装、cleanup=0、旧 recoverySource改动=0；H-progress旧91/100不改变新37/queued；旧消费者失效但新同源消费者仍收到合法进度；两种 H-click无无人接管 rejection。新增更早/更晚/reentrant控制例。
- **验证**：现有 fake lease隔离例＋真实 index共享flight与换源例。对方接口尚变化时真实 index例不关整合门，只关 fake消费者门；源合同冻结后补对拍。
- **回滚/风险**：attempt凭据、progress接线、候选释放和UI错误出口按子合同成组，不留一半。此项不批准 shared Conversation旧读提交；OpenCode旧写 baseline另属 R1h/R2，不把其坏结果期待改成验收绿。

#### P4：Reader 交付窗口、poll异常与硬预算

- **文件**：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptTailReader.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/transcript/ClaudeTranscriptTailReader.test.ts`；P5接入 Observer。不改 index七文件。
- **合同**：保留一条 IO lane。cursor候选、source identity、partial候选在同一次读中构造；生产消费须有**同步接受决定**，核 read/source/watcher owner后入原消费者 FIFO，接受后才提交本次读 cursor。接受 receipt与异步消费完成 Promise分开；应用 callback等待不占 IO lane。拒绝/过代发生在接受前，cursor不前进，后续合法读可重读。
- 新目标接口落在既有 Reader，名称/签名由本项冻结；它提供“读＋同步接受＋消费完成”合同，不另建消息总线。当前手工 `readAvailable` 仅作明确手工消费兼容；P5后生产 poll/host catch-up走同一接收合同，禁止永久保留两套生产真相。
- accepted后的消费拒绝保留原 owner错误，进入显式恢复/失败；不盲重放已投影 chunks。切 session/source允许废弃失效旧工作，但不能把未接受字节计为已交付。跨进程/跨 client exactly-once不在本项保证。
- poll全出口捕获 open/read/close/onBatch及诊断 callback异常；只向有权 owner发布，旧 finally只管旧 watcher timer。read失败 cursor不提交；read和close均失败保留两错及未知 cleanup结果；timeout不当I/O结束。
- 验证 maxReadBytes为正安全整数；每次分配/read预先限定剩余 tick预算，默认保持2 MiB/read、4 batches、8 MiB/tick。partial有硬上限，建议与 index既有16 MiB行边界一致；过界返回显式 oversized/gap，不截断后 JSON解析，也不跨 gap宣称完整/成功。无需将含worker/cache的整个 index模块 import进 Reader来“复用常量”。
- **精确断言**：在“读已完成但接受前” gate stop/start，同 source新消费者得到该行一次，旧接受=0；after-accept阻塞 callback期间手工/新IO仍可运行；每 watcher timer最多1、stop后旧新增timer=0；poll open/read/close reject均有owner、cursor不前进；64 MiB自定义read仍单tick≤8 MiB；长无newline retained partial≤行cap，正常后继行不被静默当完整。
- **验证**：补真实 fs＋gate交付例，不mock `readAvailable` 为已完成batch；poll fault例而非仅直接 await read；UTF-8跨批、末行补newline、四批yield、参数边界。超长行测试只做小cap参数化，不写业务数据。吞异常/假timeout不足以绿。
- **回滚/风险**：P4未接生产消费者前只验 Reader合同，不能称应用丢批已修；P4/P5接收协议投入后联动回退。不得退掉现有IO lane/watch-local修复。oversized如何提示/恢复须用户裁决后启新行为；未裁决时可先落红测/接口，不偷偷丢行。

#### P5：Observer reset/prime/recovery 的结果合同

- **文件**：既有 Reader、Observer及两份 unit；必要的 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptDiagnosticLog.ts`，复用现有枚举诊断。暂不改 runtime控制/Stop。
- **合同**：prime/recover不再用 void/null同时表示成功、缺失、取消与错误；返回可辨 ready/missing/stale/source-changed/failed。恢复扫描只映射完整 newline行；扫描的身份与 committed边界成对返回，不再第二次 stat把陌生身份拼上旧边界。
- source reset切换 reader/mapper/queue/quiet timer/offset anchors成为一个重验证交接。源相关 host row/lastHostOffset不能沿旧文件比较；hostProjection完成责任依P1。旧 accepted callback保持原context与原失败，不清consumeChain掩盖它；新source队列不接旧 events。
- 接入 P4同步batch接受，在poll与host completion同一路。recover的4 MiB窗口只是有界恢复，不承诺捕获任意长离线期间的全部turn；超过可证明范围报告缺口，不能当完整新历史。
- **精确断言**：recovery无newline时映射0行；scan后追加完整/半行不跳字节；reset旧队列0次promote到新源；失效prime不提交/启动；恢复来源无法确认不登记ready或接受旧offset。O-missing改用可观察 source状态/错误与后来文件创建行为核验，而非仅spy `start=0`。
- **待裁决**：推荐瞬时 ENOENT保持source-waiting、按既有2秒节奏仅重新确认来源，确认前不普通消费/不报ready；或者缺失即暂停并要求显式retry。不凭红测私有期待选择永久暂停，也不新增未经裁决的超时数值。
- **回滚/风险**：P4/P5握手合同成组回退；保持P1 host独立收口。跨generation保留consume FIFO是当前显式测试合同，永久pending accepted callback仍可能阻新消费；本项不通过race超时取消已接受保存。若用户要求新代不等旧代，须另核已接受callback的领域提交/取消合同，不直接清队列。

#### P6：save receipt与会话 binding——不冒称完整 R2

- **文件**：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts`、必要中立 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/types/chat.ts`；真实 Storage写入回归。低层 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/SessionStorage.ts` 的 write＋legacy-cleanup语义复用，不为receipt额外造持久schema。
- **合同**：区分显示 record binding、runtime binding、projection binding、candidate incoming。save在首次await前捕获原对象/本地binding token、runtime/source描述与最小delta；A壳保存不能取已rebind B的runtime全state。READY布尔与currentId均不是保存资格。
- 先完成 outgoing A有权save，再允许runtime rebind B；关闭过程中已接受 incoming delta仍写其原record，但未commit incoming壳不能被destroy的最终save猜成有权。save snapshot不整包长期持有可变Conversation/messages图；lazy create共用本次create/save flight，不能两次create。
- **目标receipt**：written（原对象、ticket、绑定/dirty版本，adapter.write与必需legacy清理已resolve）；skipped（empty/not-ready/missing/stale-binding等原因）；failed/conflict（stage/原ticket）。异步失败可保持 rejected且携typed错误，不能仅fulfilled清dirty。`main.updateConversation` missing不能void成功，须把实际跳过传到上层。只对应written或可证已写的幂等结果清该dirty ticket，旧ACK不能清后来修改。
- receipt只证明本受控调用的逻辑写完成，**不是fsync、crash durable ACK、跨client安全、全metadata最新合并**。若其它writer仍送旧全providerState，仍不能保证terminal/未知字段并集；完整R2沿既有ConversationMutationCoordinator方案另批，未有owner不先落record header或新task schema。
- **精确断言**：S-binding临时磁盘A仍session A、B仍B；反向B→A＋同runtime对象重新绑定亦成立。empty/non-READY/missing返回skipped、dirty不被假清；write/legacy-cleanup失败不返回written；新dirty ticket晚于旧save时旧结果清除=0；lazy create=1。pending A-stat不阻meta receipt，B-log失败不改变保存结果。
- **验证**：现有模拟runtime红例保留，再分别走真实Claude/Codex runtime `syncConversationState/buildSessionUpdates`（SDK不启动）＋真实临时Storage；未commit incoming的坏“destroy总要保存READY壳”期待改为明确资格合同，已接受incoming delta控制例仍written。
- **回滚/风险**：所有receipt消费者/guard按接口整体回退或保留。不能把typed union以 `.then(()=>undefined)`抹掉再称兼容ACK；不能用统计/diagnostic generation当business binding版本。跨client/全writer问题未关闭，不开R1b或新后台任务持久保证。

#### P7：最终布局在保存之后，布局错误诚实化

- **文件**：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ClaudianView.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/storage/SharedStorageService.ts`及现有layout/R1a tests。
- **合同**：close同步beginClose＋B最终flush＋关闭新准入；drain已接受save及原binding有权final save；保留稳定tab集合直到取得最终layout快照；该快照含written lazy create新ID；布局写完成/失败后仍执行P2 cleanup。不能先persist旧null再依赖已禁用的UI callback补写，也不能让Manager清空后才getPersistedState。
- plugin级layout lane串行化现有 `loadData→saveData` 读改写，close入口同步登记一次closing ticket，任务体稍后取最终snapshot；较后合法布局写排在后面，旧finish不能倒灌新布局。所有活跃layout写/读接同lane，服务重建不另起未等待的lane；其它saveData写者实际若仍可触达，纳入此数据文件合同或阻断本项保证。
- 同一view reopen的layout读取等待该view先前closing布局ticketsettle，不能先从null布局另造lazy tab再错失新ID；这只是layout/read交接，**不证明旧CLI exit，不批准runtime热交接**。不同view的业务/stat/Markdown不等layout；保持当前单份AppTabManagerState schema，不新建多view布局库。
- SharedStorageService当前:40–42 Notice后吞写错；改为typed失败/抛错，由唯一UI出口提示。`lastKnownTabManagerState`只更新已确认布局base，待写意图另记，不把失败状态冒充已存。
- **精确断言**：L-layout meta written后final layout/reopen均含savedId；close失败仍cleanup；并发close只有1ticket/布局写；old close pending＋new合法布局的最终磁盘是后者；布局write失败不返回成功、不虚报已恢复。plugin unload路径同样先封本manager准入，不只截未drain快照。
- **验证**：真实SharedStorageService/临时data文件；lazy-create gate、布局load/write故障、sameview reopen、另一view照常render；分别断言meta receipt、layout receipt，不用Promise全resolve代替。
- **回滚/风险**：保存/drain顺序与layout lane/read barrier成组；不恢复早snapshot或吞错。建议保持“最后合法登记的单份layout”语义；聚合所有view或每view独立保存需用户另裁决，不顺手改产品模型。sameview reopen可能增加等待时间，永久未确认写不能假超时称完成。

#### P8：index→tail的源身份交接——双方接口冻结后的切片

- **文件**：exporter由对方负责 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts`；底层index只读核其现有identity。共同中立 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/ChatRuntime.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/types/chat.ts`；本方Controller/ChatState/Tab、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts`、Reader/Observer。本方不得单方编辑对方七文件。
- **合同**：页面携provider-owned、不透明tail-start描述；features只传递、不解析pageKey或provider路径。Claude payload至少绑定当前segment/source key、实际路径、dev/ino、snapshotSize、committedOffset、variant、原read/binding身份。沿用现有index值，不重stat产生另一套snapshot。历史旧segment不能冒充current live segment。
- Observer pending start描述与目标session/runtime binding一同捕获；target更换、同ID重新绑定或stale restart不得挪用旧offset；接收一次与消费成功分开，不在失败前丢掉可诊断的来源证据。runtime只做observer start适配，不动result/Stop/权限/command逻辑。
- 读取先open，再用**该handle的stat**确认实际dev/ino及长度；offset只能与确认身份相配。recover也从该已打开对象获取边界；stat(path)后另open不是同对象证明。mismatch返回source-changed，进入P5恢复/显式缺口，不读新文件旧offset。合法append时用committedOffset，不用stat EOF。
- **精确断言**：小临时文件原I1/offset=100，新I2/size=300在export→prime间rename，旧offset接受=0；prime前无替换合法append不重放旧已提交行；stat/open间rename不把I1身份与I2字节拼接；小于offset truncate显式reset；UTF-8＋无newline尾巴在补写后一次出现；S1→S2→S1的旧binding描述不被新S1接受。必须走真实export→Controller/state→runtime→Observer→Reader，不仅手工 `prime(100)`。
- **局限**：dev/ino＋长度不证明同inode在两次观察间truncate后又长回、或任意原地重写从未发生。此方案限定append-only原生来源＋可观察replacement/truncate；若用户要求任意非协作写者下严格snapshot一致，需另有不可变快照/协作版本或互斥合同，不能用mtime/ctime/有限指纹宣称根治。
- **验证/回滚**：共享fixture/同一export descriptor实测，同时保留双方branch/committed/budget回归。新描述与importer原子整合；回退保留identity校验或关闭数字offset加速、显式恢复，不静默降回路径重stat拼旧offset。对方接口未验收/未停写则本项blocked，而非本方猜接口补出。

### 5. 依赖与不属于本次的保证

执行次序：P1→P2→P3→P4→P5→P6→P7→P8；某项产品决策未到时停其行为切换，主会话可明确另派后续无依赖项，不默默并行写文件。

- P1独立；P2不依赖完整R2或真实exit；P3与index exporter可分开，但真实共享progress整合需要冻结接口。
- P4→P5是Reader生产接收闭环；只P4绿不能称Observer交付修好。
- P3本地binding凭据→P6；P6保存结果/稳定tab集合→P7。布局读取barrier不等于资源barrier。
- P4/P5＋双方最终source合同→P8。P6的business版本与P8的file身份不同，不共用token。
- R1b跨client资源交接仍需要既有R2稳定owner＋资源exit切片＋实际App域/exit证据。当前claim释放、cleanup return、onClose resolve、A/B绿测都不能代替它。
- Stop是否以前述哪条**被实际调用的**共享合同为前置，由其负责人列窄依赖；不得把P1–P8全部列成Stop移除的默认前置。权限/命令设计同理，只协商重叠文件，不吸收其任务主体。

### 6. 方案推演

#### 6.1 具象走查

| 锚值/等级 | 链路与结果 | 红/绿判据 |
|---|---|---|
| host token H1、source g7→g8〔纯示意〕；现有host红例〔实测〕 | complete遇reset，source换代不撤H1完成责任；只清H1，再取g8owner。期间新同ID H2则H1无权清H2 | 绿：H1清空1、新H2清空0、旧owner drain0；红：g变即永久保留host或删所有guard |
| old attempt a1/new a2、progress91/37〔既有读数＋实测〕 | 同source底层flight共用，a1失效，a2接37；a1回91不写 | 绿：新placeholder37不变、新有效progress仍到；红：以source相同接受旧消费者或取消共同flight |
| I1/offset100→I2/size300〔纯示意、未测〕 | descriptorI1进入handleI2时mismatch；不得以300≥100接受 | 绿：旧offset接受0、新源显式恢复；红：只看长度/路径 |
| line5 bytes、接受前切代〔纯示意、未测〕 | IO读完候选cursor5，accept旧owner拒绝，不commit；新owner从0读该行 | 绿：合法消费者1、旧0；红：cursor5已进而两代均没接 |
| callback已accepted、随后reject〔纯示意〕 | cursor表示已交付，不表示业务written；原消费错误进入恢复，不无条件重放 | 绿：失败有owner、无假成功/重复chunk；红：Promise变绿即当持久ACK |
| event cleanup第1项throw〔实测〕 | 当前runtime cleanup0、DOM连接；P2记录错后继续原集合所有项 | 绿：cleanup1/DOM断、错误保留；红：依赖test finally手动清资源才通过 |
| A壳/claim A、runtime已B〔实测〕 | 关闭不能从B造A的session delta；accepted A保存使用原binding，incoming有权delta另算 | 绿：disk A=A/B=B；红：READY布尔就许当前runtime写currentId |
| lazy meta新ID=C、layout早null〔实测〕 | 先save receipt、再保留集合取snapshot并写layout、reopen等该ticket | 绿：meta/layout/reopen=C、create1；红：只等save不补layout或靠失效UI debounce |
| read64MiB、tick上限8MiB〔纯示意〕 | read前clamp剩余预算；cap小参数测试长无newline | 绿：tick≤8MiB、partial≤cap、gap明确；红：读后才限/累计partial无界 |

不涉及金额公式或日历语义，相关推演不触发；上表为生命周期锚值，不是覆盖率实证。

#### 6.2 论证链与反例

1. source owner防旧映射→host完成责任也安全？**不成立**。具体反例是g7 reset成g8而H1未换；旧owner失效恰好阻H1收口。P1分token后仅保证host投影收口，不推出host成功/control result。
2. IO lane串行→无丢批？**缺同步交付前提**。具体反例是cursor提交后旧tick await返回前stop/start；两代都未接受。P4只在accept后commit，不推出accepted callback已written或跨崩溃无损。
3. manager仍open＋runtime对象相同→旧hydration可清理/发布？**不成立**。a1被a2复用同runtime反例破坏绑定资格；P3加attempt/binding凭据，不能仅比对象或session字符串。
4. acceptedSaves全fulfilled→layout恢复正确？**不成立**。lazy C写成功但layout早取null为实际反例；又有non-READY save fulfilled且未写。P6/P7分别确认meta和layout，不推出fsync。
5. dev/ino/committedOffset配对＋handle校验→replacement不会错用旧offset，在限定来源假设下成立。具体反例是同inode原地truncate再长回，破坏append-only假设；不推导任意非协作写者snapshot保证。

追溯：不翻改既有draft/关账结论。只纠正本轮具体测试真实性与原未完成合同；HEAD形状存在不把当前责任移交给别人，修复仍列本方遗留。

#### 6.3 结构不变量判定

- **正交性**：目标成立在source/host/attempt/runtime binding/save/layout/A/B分轴；当前违反在O-host、H-cleanup、S-binding。diagnostic/stat token不升格业务或资源凭据。
- **无环**：batch→同步accept→cursor；callback→业务save→receipt；drain→layout→cleanup。业务save不等待stat/log/layout，layout lane可以等待save但save不反等layout。source recovery不发补prompt。
- **扩展方向**：文件身份与原生字段由Claude exporter/importer解释；features只携opaque描述。新增provider不让shared UI猜dev/ino/路径。
- **退化**：empty/skipped、missing/waiting、半行、无DOM、stale attempt都为合同状态；不另设小会话全量路径。当前“void既是写成又是跳过”违反。
- **入口×机制**：poll/host catch-up/recovery同accept；restore/switch/retry同attempt；save/close/destroy/lazy/backfill同receipt资格；debounce/close/unload/reopen同layout lane；first-screen/refresh/paging尾边界归同source合同。当前尚未全接线，按验证矩阵逐格关门。

### 7. 交付物规范

本轮唯一新增产物：`/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-08-claudian-local-lifecycle-gated-slices.md`；既有 `docs/designs/` 内 `<日期>-claudian-local-lifecycle-gated-slices.md` 表示本方独立生命周期裁决记录，消费者为用户/主会话/architect/implementer/reviewer。落地后由获授权执行者登记到 `/Users/vincentwang/Documents/NoteVault/tools/claudian/README.md` 产物索引，本轮不改README。

新增目录树仅上述文件；后续source/test均改既有文件，无新业务产物/日志库/schema库。一次性Jest数据/缓存仅 `/tmp/claudian-lifecycle-design-*`，不是交付物，本轮不清理。

归属沿用 `/Users/vincentwang/Documents/NoteVault/tools/claudian/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/CLAUDE.md` 的provider-native-first、中立边界、mirrored tests/TDD、禁止console和index预算。临时材料走派单/tmp而非一般.context；不走默认build/部署验收。除此无主动偏离。若后续确需新增utility/fixture/dev目录，先补完整产物清单与README索引再授权，不现在预建。

## 风险与权衡

1. **可以先推进P1**：两文件短冻结、独立复核即可；本稿尚待独立复核，不称已可实施。P2/P3也不要求完整R2/Stop先完成。
2. **明确阻塞**：P5 missing策略、P4 oversized处理、P7 reopen等待/单份layout政策待用户拍板；P8双方精确七文件清单及接口冻结未到。R1b实际App域/真实exit仍未证。
3. **建议用户裁决**：瞬时missing等待来源 vs显式retry；oversized行显式恢复 vs可靠opaque-gap投影（不许静默丢）；sameview reopen等待先前保存/布局结果、失败显式恢复是否接受；保持当前单份最后合法layout还是另做multi-view schema。均不默认已批准。
4. **来源保证范围**：建议先关闭同路径replacement/可观察truncate的可证缺口，不承诺同inode任意原地重写。若要求后者需另核协作snapshot；不因此阻断P1–P7。
5. **保存范围**：P6诚实receipt与本地binding可独立交付，但不能宣称已完成全writer typed mutation、legacy/删除跨client barrier、task持久ledger。R2新schema切换、冷首次安装/回退域保证仍按既有方案待裁决，不在此代拍。
6. **回滚**：只针对本项归属diff，保留他方脏改；不使用整文件覆盖、reset/stash、清registry或重启来“恢复”。P4/P5、P6receipt消费者、P7layout lane、P8export/import各自按协议成组。部署bundle回退不在本次授权，源码回退也不撤销已写meta或消除pending I/O/CLI。
7. **迁移/落地代价**：目标复用现有文件，不引新库/全局框架；P3/P6/P7有真实跨文件耦合，P8需双方短暂停写和合同对拍。工作量只影响分期，不降低身份/错误真实性。不能为了小diff继续叠顺序启发式。

## 验证方式

### 1. 本轮已执行与未执行

四份定向测试及结果见§1。本轮没有HEAD动态重演、production plugin/真实SDK wire/CLI/MCP、build/deploy/commit/push，也没有source replacement→旧offset端到端实测。并行依赖未全冻结，不作整合验收。

执行器绕过项目测试wrapper的共享 `/tmp/claudian-localstorage`，为每次测试独立分配localStorage/cache。unit运行数据根 `/tmp/claudian-lifecycle-design-yRPFZ2`；integration运行数据根 `/tmp/claudian-lifecycle-design-mhXnhx`。测试自建业务fixture位于各自随机tmp目录并按既有afterEach处理，本轮没有额外工作区清理动作。

### 2. 获准后的定向命令

先审查测试import/setup不会启动真实provider或写活vault；每项冻结指纹后再执行。下面命令为后续验收，不在本轮追加执行：

```bash
cd /Users/vincentwang/Documents/NoteVault/tools/claudian
TEST_TMP=$(mktemp -d /tmp/claudian-lifecycle-verify-XXXXXX)
node --localstorage-file="$TEST_TMP/localstorage" node_modules/jest/bin/jest.js \
  --config /Users/vincentwang/Documents/NoteVault/tools/claudian/jest.config.js \
  --selectProjects unit --runInBand --no-cache --cacheDirectory="$TEST_TMP/cache" \
  --runTestsByPath \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/transcript/ClaudeTranscriptTailReader.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/transcript/ClaudeTranscriptTurnObserver.test.ts
```

R1a/A/B用同命令形式改selectProjects与两个绝对test路径：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/markdownRenderDiagnostics.test.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/nativeSessionSize.test.ts`

P2/P3/P6/P7再按本项改动添加既有mirrored `Tab/TabManager/ClaudianView/ConversationController/SessionStorage` suites；P8由对方指定已冻结的branch/window/committed/budget回归，不猜七文件测试名单。跨文件合同完成后运行typecheck与限定文件lint；最终双方源码冻结后再讨论全相关suite。build、部署、真实模型/CLI/MCP取证不由上述测试通过自动获授权。

### 3. 生产调用链验收矩阵

每格登记pass/fail/未覆盖/N/A及证据，不能只数绿测：

| 入口 | 机制/靶子 |
|---|---|
| Observer host complete/reset/reentrant start | host token与source owner分别变化，无新host清空或假完成 |
| Reader poll/手工catch-up/恢复scan | 同accept合同、before/after accept切代、open/read/close reject、UTF-8/half-line/预算 |
| tab click/restore/switch/retry/进度订阅 | attempt/resource凭据、旧进度0当前写、每个异常有UI或受控owner |
| normal save/backfill/lazy/close/destroy | 原record/runtime/source delta、skipped/written/failed、dirty ticket、incoming资格 |
| layout debounce/close/unload/sameview reopen | drain前后snapshot、单lane读改写、oldfinish/newticket、错误真实化 |
| A hover/history row/delete/rebind＋B stream/history/dispose | 统计无metadata写/阻业务；collector属于原render，flush后late token0新代写 |
| history first-screen/switch/search refresh/paging→tail | 同source opaque描述、current segment/variant、replacement两个窗口、合法append/半行不丢 |

只mock边界I/O、clock、provider transport，不mock被测accept/guard/save/layout/cleanup实现。internal test用于局部状态，关业务门还需公开入口和临时磁盘/DOM结果；cleanup测试必须在test finally手工补救**之前**断言资源结果。

原生文件对拍可无模型：受控小文件rename/truncate/append＋真实生产export/import；不能用对方“源码推演”替代。source不变案例与source变化案例都要有，防止通过一律拒绝形成假绿。

### 4. 最终交接标准

- 每项独立reviewer无未处理正确性问题；本设计经独立architect硬伤复核。
- 11个已测失败逐条登记修复/策略重定义/不在本项，不能删测试或以known-issue绿计关闭。
- source交接新增实测后才能把该风险从〔推算〕升级；任何真实CLI/跨client资源承诺仍独立待证。
- 只交付本项diff、source/test/接口指纹与结果；不修改旧design status，不将对方未验收内容追认成基线，不替Stop/权限/命令负责人选依赖。

## 关联

- [[tools/claudian/docs/designs/2026-11-08-upstream-compat-remaining-implementation-contract]]
- [[tools/claudian/docs/designs/2026-11-07-upstream-compat-evidence-closure-supplement]]
- [[tools/claudian/docs/designs/2026-11-07-conversation-size-contract-consolidation-restart]]
- [[tools/claudian/docs/designs/2026-11-06-markdown-render-metric-contract]]
- [[tools/claudian/CLAUDE]]
- Node FileHandle/stat/read合同：本轮Context7核对 [Node fs文档](https://github.com/nodejs/node/blob/main/doc/api/fs.md) 与 [FileHandle实现](https://github.com/nodejs/node/blob/main/lib/internal/fs/promises.js)。官方API说明不证明本地文件从未被并发改写。
