---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/rendering/MarkdownRenderDiagnostics.ts
tags: [architect, claudian, diagnostics]
---

# Markdown render metric contract — B 性能期 0 参数补全

## 背景与问题

仅补 `.context/sdd/ethereal-dancing-emerson/task-2-brief.md` B 第 4、7 项缺失的统计参数，解除 `task-2-core-report.md` 第 7–9 行阻塞；不重做已批准方案。以下为可重复的技术默认值，非实测性能阈值或产品告警线。

## 方案设计

### 1. 固定边界与样本口径（metricVersion = 1）

全部桶**左闭右开**，最后一桶无上界；相等值归入以该值为左端点的桶。直方图为非累计频数，按下表区间顺序输出固定长度数组，不输出 Infinity。

| 指标 | 固定边界（相邻端点组成区间） | 样本单位 / sum / max |
|---|---|---|
| chars | `0, 1024, 4096, 16384, 65536, 262144, 1048576, +∞`（7 桶） | 每次实际 Markdown 调用的输入 UTF-16 长度；在 start 入账，sum 为长度和，max 为单次最大长度 |
| elapsedMs | `0, 1, 4, 16, 64, 256, 1024, 4096, +∞`（8 桶） | 每次有效 end 的完整墙钟耗时，含成功和失败；sum 为耗时和，max 为单次最大耗时 |
| calls | `1, 2, 4, 8, 16, 32, 64, 128, +∞`（8 桶） | **每个 flush 窗口内、有 start 的归属桶的调用数** `nₐ`；sum = Σnₐ，max = max(nₐ)，直方图每个 nₐ 入账一次 |

- calls 的三个统计量使用同一组 `nₐ > 0` 样本，包括 overflow。不对每调用的常数 1 做 max/直方图，不拿整个 flush 的总调用数再做一次样本，也不把无 start 的桶补成 0 样本。`callsSampleCount = ΣcallsHistogram`，单位是“活跃归属桶×flush 窗口”，不是调用数。
- chars 的样本数 = `callsSum`；elapsedMs 的样本数 = `settledCalls`。`settledCalls = successCalls + failureCalls`，**不要求**同一窗口 `settledCalls = callsSum`。无样本时 sum/max = 0、频数数组全 0；0 最大值须结合样本数解读。
- 使用单调墙钟 `performance.now()`：耗时 = end 时刻 − token 开始时刻，保留毫秒小数、不先取整或裁到桶上界。不是 CPU 时间；sum 可因重叠调用大于窗口时长。计时器异常属于诊断故障，不伪造 0 耗时。
- 输入必须为 `MessageRenderer.ts` 现有传入 `renderMarkdown` 的 `processedMarkdown.length`，不是原 markdown、会话文本、字节、码点或 token 数。仅测 Markdown Promise 的成功/失败和耗时，不包含后续 DOM 增强/fallback/release；预处理失败且未调用 Markdown 不计数。

### 2. 归属、容量与 token

- **32 包含 overflow**：每个聚合器从创建到 dispose，最多保留 31 个实名脱敏归属槽，另预留 1 个固定 overflow；不在 flush 时重置/驱逐槽位。归属键为开始时的 `(tabIdHash, conversationIdHash, tabGeneration, conversationGeneration, tabActive, documentVisible, domConnected)`。哈希/世代沿用已批准登记及更新供给，不逐调用 hash，不新增共享接线需求。
- 未知 ID 用明确 unknown 状态，不能冒充有效哈希。可见性三个维度各为 `yes/no/unknown`，只读已有状态；viewport 固定 `unknown`，本补全不引入缓存、rect 测量或观察者。
- 第 32 个及以后不同归属直接映射固定 overflow；不登记其原 ID、额外哈希、标题、路径、映射表或“已见 ID”集合。overflow 行省略 tab/conversation 标识和世代，不挂任一原归属，也不宣称精确不同归属数。
- 保留固定 27 格 `startVisibilityHistogram`，记录三个可见性维度的联合分布，普通槽与 overflow 均在 start 加一次：`yes=0,no=1,unknown=2`，索引 `tabActive×9 + documentVisible×3 + domConnected`。viewport unknown 不另开样本维度；数组和 = callsSum。因此 overflow 不丢开始可见性分布，也不保留无限身份。
- token 仅持 owner/生命周期引用、归属槽、开始时间、chars、一次性 settled 标志；不持 DOM 元素、正文或原 ID。聚合器不收集逐次 token/样本列表，只维护 ≤32 槽的定长聚合及 inFlight 计数；token 随原调用栈存活。
- start 成功登记后即增加调用/字符数和 inFlight；end 先一次性封口，再将对应槽 inFlight 减一并登记 settled、success/failure、elapsed。重复 end、非本 owner/无效 token 忽略。不得从结束时当前 tab/conversation 重新归属。

### 3. flush、跨窗口与 dispose

1. 窗口是**相邻 flush 切点之间的事件增量**，初始切点为聚合器创建时刻；按 JS 实际执行顺序归窗，不是固定日历 5 秒窗口。首条脏数据触发唯一 `setTimeout(..., 5000)`，后续事件不推迟；timer 实际执行可因 event loop 延后。
2. flush 清 timer，快照并重置增量；保留归属槽、token 和 inFlight。仅有未结束调用不续 timer、不重复输出 gauge；下一次 start/end 产生脏数据才重新安排单次 5 秒 flush。无脏数据不写日志。
3. 每槽/窗口包含 `inFlightAtStart, inFlightAtEnd, abandonedCalls`；守恒：`inFlightAtEnd = inFlightAtStart + callsSum − settledCalls − abandonedCalls`。正常 flush 的 abandonedCalls 为 0。窗口 `windowMs` 为相邻切点的单调墙钟差，可包含空闲，不一定 5000；日志 ts 只是写入时间。
4. 跨 flush 的调用：calls/chars/开始可见性只归 start 所在窗口；success/failure/完整 elapsed 只归 end 所在窗口，归属槽始终不变。不重记 chars，不切分耗时、不补写旧日志。结束窗口没有 start 时 callsMax=0、callsHistogram 全 0，并不表示没有完成调用。
5. dispose **先关闭计量、清 timer**；把全部剩余 inFlight 一次计为 `abandonedCalls` 并清零，然后最多一次有界最终 flush（`flushReason=dispose`），最后释放 sink/归属状态。不等待 Promise，不测残缺耗时，不把未决调用算 failure。重复 dispose 无操作。
6. dispose 后 start 返回无效 token、end 无操作，不改任何计数、不起 timer、不再落盘。最终 abandonedCalls 的含义是“关闭时未观察到结算的调用数”，**不是实际失败数或已观察到晚到数**；将来晚到是其中的子集，不能再次计数。旧 token 不得进入新实例。
7. 诊断/sink 抛错立即停止该实例后续计量、清 timer/待写状态/引用，不重试且不影响 render。既有 logger 内部写失败会禁用并返回 void，不能据此虚构写成功或声称聚合器已获失败通知；沿用其失败禁用，不改接口加 ACK。

### 4. 可消费的汇总契约（不实施共享接线）

复用现有接口，不改 `MessageRenderer.ts` 的 `start(element: HTMLElement, chars: number): unknown` / `end(token: unknown, success: boolean): void`。已读到现有真实旁路在 Markdown await 的 finally 结算，外层 fallback/release 保持原状。

实施者在原批准 B 接线内为 neutral `HistoryDiagnosticEvent` / mapper / `TranscriptDiagnosticEvent` / serializer 同步加入以下白名单；当前接口**尚不包含**这些字段，不能只给 sink 传对象而静默丢字段。

- neutral `kind=markdown_render_summary` → logger `phase=markdown_render_summary`。共同字段：`metricVersion=1, collectorIdHash, flushId, flushReason(timer|dispose), flushScope(window|attribution), windowMs`。collectorIdHash 在登记时生成，用于区分多个实例；flushId 为实例内递增整数，不冒充 logger seq。
- 每个 flush 最多 **32 条归属行＋1 条窗口汇总行**；同一 flush 内一次有界输出，不逐调用 record、不另起 timer。归属行涵盖该窗口有增量或边界 inFlight 非零的槽；最后输出窗口行，带 `attributionRows` 数量供消费者识别完整组。
- 两类行都有：`callsSum, charsSum, charsMax, charsHistogram[7], elapsedMsSum, elapsedMsMax, elapsedMsHistogram[8], settledCalls, successCalls, failureCalls, inFlightAtStart, inFlightAtEnd, abandonedCalls, startVisibilityHistogram[27]`。归属行另含 `attributionSlot(1..31|0), attributionKind(known|overflow)`；仅 known 可含前述开始归属键字段。
- **只有 window 行**含 `callsMax, callsHistogram[8], callsSampleCount`，取全部有 start 槽的 nₐ；归属行 callsSum 就是 nₐ，不另生成含义不同的 calls max/直方图。窗口 chars/elapsed 的 max 取单次样本最大值，sum/直方图/计数为各槽相加。消费者用 window 行做总量，归属行做拆解，不把两类行再相加。
- mapper 逐字段构造，serializer 明确列键；哈希按已批准脱敏供给透传，不写原 ID、不二次 hash。数组仅定长非负有限整数，数字仅有限非负计数/耗时，枚举逐项校验；不透传任意 object、detail、errorName、error.message/stack、路径、标题、正文或凭证。
- 继续使用既有 `ClaudeTranscriptDiagnosticLog(..., ..., 'markdown-render')`、vault `.claudian/diagnostics/`、128 KiB 轮转及失败禁用。其 serialize 已支持白名单值为数组；现有 1024 字节 ENTRY_BYTES 只是 errorName 删除尝试，并非硬截断，不能假定新数组会被自动裁剪。固定行数/数组保证有界，不改轮转规则。写失败可能留部分行，不作事务性成功承诺。

### 推演与边界红绿靶子

以下全部为 **〔纯示意〕设计语义走查，未运行测试**；红为必须检出的错误，绿为实现验收目标。

| 锚值/场景 | 绿 | 红 |
|---|---|---|
| chars `1023/1024`；elapsed `15.999/16`；calls `127/128` | 分别落相邻桶 `0/1`、`2/3`、`6/7`；chars=0/elapsed=0 都落首桶 | 等值仍进左侧桶；elapsed 先取整 |
| 三次长度 `3/6/9`，前两次属 a、最后属 b；耗时 `0.5/16/64`，都在同窗完成 | callsSum=3，样本 `[2,1]`，callsMax=2，callsSampleCount=2，callsHistogram=`[1,1,0,0,0,0,0,0]`；charsSum=18/max=9；elapsedSum=80.5/max=64，直方图=`[1,0,0,1,1,0,0,0]` | callsMax 恒为1或误取整窗总量3；callsHistogram 样本数3 |
| 实际输入 `A😀` | chars=3（UTF-16） | 码点数2或UTF-8字节数5 |
| a 于0ms开始、100ms结束；b 于10ms开始、20ms结束 | 独立耗时100/10，总和110/max100 | 共享起始时间或串计时 |
| 唯一调用长度3，0ms开始、6000ms结束 | 5000ms flush：calls=1/chars=3/settled=0/inFlightEnd=1；6000ms end 重新起timer，11000ms flush：calls=0/chars=0/settled=1/elapsed=6000/inFlightStart=1/end=0；第二窗 windowMs=6000 | 5000ms后因未决调用轮询；结束窗重记输入；耗时仅1000/5000 |
| 上例5000ms已flush，5500ms dispose，6000ms晚到end | 一次最终汇总：calls=0/settled=0/abandoned=1/inFlight 1→0，无elapsed样本；晚到无计数/日志/timer | 算失败、补5500ms残缺耗时、final后追加晚到日志 |
| 同窗33个不同归属各开始1次 | 31 known＋1 overflow；overflow calls=2；window callsSum=33/max=2/sampleCount=32，callsHistogram 首两格为31/1；全部输入照计，overflow无身份列表 | 32 known＋overflow共33槽；原ID集合随归属数增长 |
| t=0开始，后无新事件；timer正常运行 | 4999ms不输出，5000ms仅一次flush，随后无timer；切tab后end仍落原槽 | 每5秒轮询、结束时重新归属 |

结构不变量：数据流 renderer → neutral sink → 原 mapper/logger **无环、无 provider 反向依赖**；归属31＋overflow32、定长数组、无逐次样本列表 **有界**；普通已完成单窗调用是跨窗状态机的特例 **成立**；streaming/final/history 经同一个实际 `renderContent` 调用点 **机制不分叉**。反例已列：以 end 时当前tab重分桶，会把旧世代耗时归给新会话；因此不得按flush重建身份槽或改变原调用路径。

## 风险与权衡

- 推荐 start 记工作量、end 记完整耗时：可记录卡住调用的实际输入，并以 inFlight/abandoned 解释缺失结算。只在 end 入账会漏掉永久未决输入；强等到跨窗调用完成再flush则违反5秒/关闭边界。均不采用。
- lifetime 固定31槽优先保证跨flush稳定与内存有界；长期大量世代切换会更多进入overflow，callsMax是压缩归属桶的热点量，不是原会话的精确最大值。没有足够身份时不反推。
- **未改变原批准语义**：本记录只确定桶、统计样本单位、32是否含overflow及生命周期入账。未改变B业务、共享main/view/tab接线边界、原Promise/异常/fallback/registrar release、Markdown分块、DOM windowing、隐藏tab卸载、renderTarget或live/stored lease；不触A、不加扫描/观察者/轮询，不扩DOM census，不承诺已解决卡死或证明主因。
- **无需用户裁决技术阈值**；记录保持draft，不擅自修改旧plan/confirmed设计。本轮不实施、联网、运行测试、build、部署、提交或派子代理。

### 交付物规范（单文件轻量版）

新增树仅 `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-06-markdown-render-metric-contract.md`；日期前缀＋主题slug标识独立参数补全，供主会话/实施者/复核者消费。沿用项目 `docs/designs/` 与 vault 架构师设计记录约定，status=draft；项目CLAUDE将临时交接材料放 `.context/`，本文件为正式设计记录，非临时报告。README产物索引登记留给后续获准收尾，本轮不改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/README.md` 或其他文件；同名存在不得覆盖。

## 验证方式

移交实施者：镜像单测覆盖上表边界、跨窗守恒、overflow无无限身份、重复/错owner token、dispose晚到及sink抛错；使用fake单调时钟/timer，不mock被测聚合。沿用已批准集成链真实 StreamController rAF → MessageRenderer → neutral sink → mapper → JSONL，覆盖streaming/final/history/切tab/关闭，断言字段未被白名单静默丢弃、无敏感内容，开启/关闭/抛错时真实Markdown参数、Promise结果及release次数一致。测试仅用受控fixtures。

本轮仅静态读指定接口和纸面推演；无测试通过声明。后续按原brief执行新增失败测试→实现→相关测试、typecheck、lint、git diff --check；不因本记录扩大验证范围或自动build/reload。

## 关联

- 已批准要求：`/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task-2-brief.md`
- 阻塞依据：`/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task-2-core-report.md` 第7–9行
- 已读接口：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/rendering/MessageRenderer.ts` 第34–36、975–1069行；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/history/HistoryDiagnostics.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptDiagnosticLog.ts`
