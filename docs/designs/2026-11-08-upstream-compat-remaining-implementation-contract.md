---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - claudian
  - upstream-compatibility
  - implementation-contract
  - evidence-gate
---

# 上游兼容剩余任务：最小完整实施合同

## 背景与问题

在 A 原生文件体积与 B Markdown 性能旁路已整合、ordinary allow 与 Codex effort 英文已局部修改的基线上，补齐 Stop/result、后台任务、业务保存/删除、退役、always 与命令发现的执行合同；明确哪些可以独立实施，哪些生产行为仍不能启用。

> [!warning] 独立 draft，不替代、不确认原稿
> 本稿承接既有理想目标，收缩重复机制，不以“最小”降低正确性门槛。开发方向已由派单明确；always 政策、保证范围、回退及真实取证成本尚未获具体裁决。
> 不修改或更改两份 2026-11-07 记录的内容/status，不 supersede。本记录初版为独立新建，本次只按明确授权订正本 draft；未改生产代码、配置、测试或 README，未提交、构建、部署、网络查询、真实模型运行或执行测试。
> 用户订正授权原话为 `方案需补强，派之前的architect补`；派单明确映射为重载交接、历史读取覆盖、后台任务通知三处缺口，仅连带修正实现映射、分期、验收及回退，status 保持 draft。
> 下文是目标合同及有禁用结果的闸门，不是“当前实现可上线”。派单报告 ordinary allow/Codex effort 英文两项已通过隔离验证，属于〔既有读数〕，本轮未重跑、未核定其完整测试范围，不能推广为 A/B、三项兼容任务或真实运行验收通过。

## 方案设计

### 1. 新基线与解层次

#### 1.1 观察凭据

代码根 `/Users/vincentwang/Documents/NoteVault/tools/claudian`；HEAD `cf47730d2109e798fd27ddacc712038d26883d5b`，分支 `fix/model-identity-sorting`。

2026-11-07T18:33:19Z 只读快照（本稿新建前）：42 个 tracked 修改、26 个 untracked 文件，暂存区为空。

- tracked diff SHA-256：`d56732ea7071a2a390937e2f41ee3701cc6965b45015f6e4d22a81c6ec96f997`。
- 修改及未跟踪文件的有序 `(相对路径, 内容SHA-256)` 清单 JSON 摘要：`6c9cd5913e1627f37cf4a8e328dbcca12177c742b5394e0fac74cf4c84114305`。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeApprovalHandler.ts`：`eb49092bd330659a17aeb0f56e3a35195f38d2f8a815085052669ec834efacda`；ordinary allow 已无 updatedPermissions，always 仍调用旧 builder。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/ui/CodexChatUIConfig.ts`：`4f6a431231af8c1b8adfdf5db8364e8728afab1d952b69b2cb908d83afb0d5a9`；effort 已固定 Low/Medium/High/XHigh。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts`：`aaa9f63471db684dcc1df49c575634a717a7f0d94c5300fa583e86789ce0e4cd`。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/SessionStorage.ts`：`e83c798e15b62aeef8660f5545014ae1b7dd8e4087b6d6c8b8273886d60f0f4c`。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts`：`eb16944329fcb29498a99a028e15a29f667ad81fd7f4c220cdf4ae84bbf2044f`。
- SDK declared=`^0.2.112`，locked/installed=`0.2.112`；实际 query 的 resolved CLI、内存 bundle 未验证。
- 磁盘部署 `/Users/vincentwang/Documents/NoteVault/.obsidian/plugins/claudian/main.js`：4,591,390 bytes，SHA-256 `159a8f7923dec8a0fc621f32e3b142b2d7f1914d4717621c82a48dae74586fda`；仍含旧 Stop、notificationResultPending 与 allow→session/always→projectSettings builder，未见 A/B 新机制。

A/B 负责人停止写 tools/claudian 是派单提供的交接信息，不是本稿对全部并发写者的证明。主会话须指定唯一 integrator、冻结包含未跟踪文件的基线；只冻结 HEAD 不够，不用 stash/reset/覆盖他人文件完成冻结。

证据分级：〔实测〕仅本轮只读 Git/哈希/文本定位；〔既有读数〕源码、既有测试文本及派单报告；〔推算〕由机制推出的结果；〔纯示意〕合同走查输入。本轮没有动态测试通过或真实 CLI 保证。

本次订正前观察点为 2026-11-08T01:48:59Z：43 个 tracked 修改、27 个 untracked 文件（含本记录），暂存状态另按最终基线核对。除本记录外，修改/未跟踪内容清单摘要为 `a54ad25ac9fabb69a3d917540d2fccc90be00a58056e97b81014027df5c50487`，tracked diff 摘要为 `e913184513fceb0ae5b7f25173cbf67c0379e5f0016343abb736c6c0a6e076fd`。前述初版快照保留为历史读数，不替换成新工作树。main/TabManager/runtime及两项局部生产改动的指纹与初版相同；变化包含新的测试修改，不从测试文件存在推出测试通过。

独立复核提出的三种失败序列均为纸面推演，未登记为已发生故障。核实到的源码事实为：普通 close 同步清 query 槽，watchdog retirement 才等待 exit；getter/warmup 会隐式 hydrate，非 index provider 会在 caller 提交检查前修改共享对象及 cache；现有 needsReview/桌面提示依赖 turn completion，SDK 声明有 skip_transcript 而本地 task 接收未保留。下面 §3、§5、§9 与验收段给出订正合同，不把“经推演可行”记成实测关闭证据门。

#### 1.2 已有能力的正向复用

- A 已用 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationSizeService.ts` 的弱对象身份、source key、revision 和双并发 stat 发布内存读数。业务保存不等待统计，已经直接规避 size 写盘竞争；**不新增 sizeSnapshot 持久化、size sidecar 或持久 size fence**。
- B collector 的 generation/token/flush/dispose 直接用于诊断隔离；不能兼作业务 record、writer、query 或审批身份。
- 复用 SubagentManager/subagentData 为任务状态链、现有 branch/index/committed boundary 为读取边界、QueryScope/channel/retirement 为控制资源边界。
- 复用现有 decisionOptions、inline prompt resolved guard，但必须补真实请求身份和 signal；卡片 guard 不足以约束 SDK 请求。
- 复用 catalog 的 flight 去重和 customSpawn 的 Electron/onExit 能力；不能据此宣称目录对等、后代已退出或无模型成本。

#### 1.3 三种路径与推荐

| 路径 | 收益 | 不满足处 | 建议 |
|---|---|---|---|
| 摘 PR/删 Stop/延迟 stringify/直接透传 always | 局部短 | 不闭合 result、旧 writer、run 内容与政策 | 不选 |
| 先升级 SDK 或整体重写 turn/storage | 新 API 可能直接补能力 | 升级另批；不能解决未知写者、删除及旧记录兼容 | 作为单独候选，不在此实施 |
| 复用现有结构，先闭合准入/意图/资源合同，真实能力不足返回禁用/未知 | 闭环可分批、无第二状态库 | 部分行为必须等真实证据及用户裁决 | **推荐** |

结果不可辨识的矛盾不能靠计数/顺序补丁化解；无法证明时不启用新结算/Stop 移除。跨进程互斥也不能由 renderer 内队列解决；保证范围未定时不切新 writer。

### 2. 原稿与补充稿冲突映射

原稿：`/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-07-upstream-compat-stop-permissions-discovery.md`；补充稿：`/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-07-upstream-compat-evidence-closure-supplement.md`。

| 编号 | 原稿 | 补充稿/当前证据 | 本稿建议与授权边界 |
|---|---|---|---|
| D1 | §2.2.6 复用串行化/CAS；必要时才改 SessionStorage | §5：入队前旧快照，不存在 CAS | typed mutation＋队内最新归约；低层 FIFO 只作 I/O 顺序，不称 CAS |
| D2 | §3.3 unsupported 下默认 once-only | §6：once-only 是未裁决候选 | ordinary once 修复保留；always 政策 pending，生产选项切换等待用户，不能自行当默认已批 |
| D3 | §4.3.5 热新 revision/空覆盖旧 probe | §7–8：publishedRevision 不等于来源新鲜，probe 不默认对等 | 同 target scope、同证明等级内才替换；old SDK 只 init-observed，candidate 不删 hot 已观测目录 |
| D4 | §2.2 sidecar 固定 recovery context＋merge-by-tool-id | §4：固定回调不能证明文件段属于 run | run 内容 proof 是自动 hydration 的独立门；未证只保存 terminal/summary，不读整文件冒充 final |
| D5 | §2.3 窄 turn fence，无法归属则停门 | §3：cancel 必须在 owner 后、query 交接另判 | 吸收精确次序；不把 observe-only 升权，不接受 bool→counter；内容结束不释放 query |
| D6 | §9 S1 回退上一已验证 bundle；S2 安全回退 once-only | §验证末：回滚不撤权限/任务 schema；当前旧 bundle 恢复造规则 | 回退产物必须包含 once 修复及新读写兼容；原旧 bundle 不是安全回退。回退可用性由用户裁决 |
| D7 | §10 新 size 保存/sizeSnapshot 与 task 双向竞争 | §5.4 size 地址待最终协议 | 当前 A 已纯内存；删去本次持久 size 前提，不暗迁统计；保留 object/source/revision 发布检查 |
| D8 | §2.2 switch/dispose drain；§5 保存生命周期映射 | §5、§8 同域接续/registry drain；独立复核指出分期漏依赖 | B 仅隔离诊断；R1a 只隔离旧 manager，不提前释放资源；R1b 须稳定 client barrier＋真实 exit，不能用 R1a 通过代替 |
| D9 | §3.2 cancel/Ask/Exit 保持原义，验证提及 auto timeout | §6：ordinary 未接 signal；5分钟新增适用范围待确认 | request handle/signal/settleOnce 先补；auto ordinary/Exit 5分钟仍是用户选择，不先启用 |
| D10 | §9 未知字段往返＋增量懒迁移 | §5 原对象/incarnation/recordToken 尚为目标 | 先确定 record header/task v2 的兼容读写与回退；只 spread 未知字段不足以证明旧 writer 安全 |
| D11 | 删除按原 provider 流程，失败显式 | §5 typed delete；实际 Claude unlink 吞错，Codex/OpenCode保留 | 按 provider 删除政策返回明细；逻辑删与物理删分离，strict native deletion 是另一个用户裁决 |
| D12 | §4.4 正确 cleanup/finally | §8 owned 子进程/后代及有限生命周期未证 | 假 transport 可测 host cleanup；真实资源门未过不启新自动 Retry/进程树策略，不改 chat 默认 spawn |
| D13 | 两稿强调 scope/snapshot/旧域 guard，未明确全部 hydration 提交与 cache 序关系 | 独立复核：同域 A/B 旧读和 binding ABA 不由 manager ticket 排除 | §3.4 增加 record/binding/materialization 版本及提交许可；cache 只随成功提交或有权失效推进，request 顺序不当新鲜度 |
| D14 | task terminal 保存与 turn 通知分别描述，缺零 result 的 attention 闭环 | 独立复核：parent 不可见＋无 result 时 turn completion 不触发提示 | §5.2 同 run 持久 attention 与 app 重投影，不制造 turn；普通终态/ambient/桌面政策待用户裁决，外部通知不承诺 exactly-once |

这些是建议映射，不赋予本稿对原两稿的已批准优先权。实施派单应引用本表和具体用户裁决，不能让 implementer 自行择稿。

### 3. C0：稳定所有者、同步退役与准入

#### 3.1 三种身份不可互用

1. **持久 recordIdentity**：新 create 的不可复用 opaque nonce，保存到 provider-neutral metadata 头；ID 相同不表示同一 record。旧记录无 header 时标 legacy，在首次合法 mutation 内补；不批量重写。
2. **运行 RecordHandle**：原对象、recordIdentity、owner client epoch、incarnation 的 opaque handle；异步入口必须在第一次 await 前捕获，不在完成时按 ID 再绑定。
3. **任务/输入原生身份**：providerSessionId＋run/launch 或 canonical input UUID；queryEpoch 是接收资格，不进入持久 run/input 键。

A 的内存 identity/revision 和 B 的 generation 保持独立。不让同 ID 的新记录继承旧 handle、poll、审批、claim 或 SDK query。

#### 3.2 writer 的可证明范围与初次切换

推荐的最小候选是：**同一个已识别 renderer/App 生命周期域、同 vault 的受控业务 writer**，支持域内多 view/tab 和后续 plugin reload；不承诺独立 App/renderer、其他 Obsidian 进程或同步工具共同写 meta，也不承诺 fsync/crash-atomic。此范围须用户接受，不能自动视为成立。

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts` 只做 assembly：在不会随插件模块 reload 消失的 App 生命周期槽保存 writer owner、ConversationOpenRegistry 及 retirement barriers 的引用，带显式协议版本。
- writer 状态属于新 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationMutationCoordinator.ts`；registry 仍属既有 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/ConversationOpenRegistry.ts`。二者职责分开：registry 管显示/资源准入，不是 meta 锁。
- reload 取回同一 owner，先 retire 旧 client；新 client 不可越过旧 pending lane/资源 barrier。跨模块对象用协议合同，不靠 instanceof；未知 owner/version 冲突即禁用危险接续。
- loadSettings 不另起同 vault writer，不把新加载对象替换到旧 pending 操作下。设置重载与业务 bootstrap 分开；业务记录导入/刷新进 owner，重新投影当前对象及 handles。
- 发现不受控写者/未知 realm，写入合同 No-Go。读后比哈希只能检测，不解决 TOCTOU；不能加 check-then-write 后声称多进程安全。
- **从当前旧 bundle 首次安装**，旧 writer 未参与此协议，不能用新 owner 包裹后追认旧 pending I/O。推荐在获准停止相关实例、完成冷进程退出后切换，再启动检查 metadata；若要求无停机或多 renderer 同写，另设计实际互斥协议，本稿不暗选文件锁。

App 槽能跨哪些实际 Obsidian reload/窗口保持同一域须现场核查；fake App 复用只证明 host 合同，不证明 Electron 场景。冷重启避免旧 metadata writer 存活，不等于后台原生任务全部停止。

#### 3.3 manager 局部隔离 R1a 与资源交接 R1b

TabManager 增加同步 `open → retiring → retired/blocked` 准入状态与操作 tickets。onClose 第一段封原 manager 的新准入，不先等 layout 保存。每个 await 后，在创建下一 tab、reserve/commit claim、写共享对象/DOM或初始化 runtime 前检查原 ticket；restore 循环及 blank fallback同样检查。并发 destroy共用promise，清理准入已关闭后的稳定集合，不能依赖测试finally第二次destroy。

**R1a 最小独立切片**：仅增加旧 manager 准入/结果发布检查、纯 metadata lookup及本地请求实例隔离。它不改变原 claim/resource释放顺序、不清 start prohibition、不提前释放 CLI槽、不启跨 client接续、不以新 guard跳过既有已接受保存。不得称“完整退役已修复”。staged payload与版本提交可先开发红测，但共享发布另过§3.4；不能仅凭R1a ticket启用。

**R1b 完整交接**：同步退役所有旧client准入，已接受短delta drain；原manager、writer lane与runtime资源资格分别确认。claim仅在原操作取消和资源barrier处理后释放；旧focusOwner不指向关闭view，blocked项走恢复入口。原runtime dispose、清registry引用、UI等待超时或SDK close resolve都不解除barrier。新plugin/client必须取回稳定域的pending/blocked资源记录，不因重建registry而获新启动资格。

| 入口 | R1a可做，不代表资源交接 | R1b准入条件与验收靶子 |
|---|---|---|
| createTab/openConversation/restoreState/下一tab/blank fallback | 封旧manager准入；旧ticket不得新reserve/init/发布 | 若要创建或复用runtime，须record/source仍有效＋资源barrier可交接；gate旧restore，旧域新claim=0 |
| switch/loadActive/ensureServiceForConversation/initializeTabService | await后核原对象/操作；metadata获取不隐式hydrate | replacement前确认旧runtime退出或已有可证安全复用合同；exit延迟时新spawn=0 |
| prime/prewarm/ensureProviderTabRuntimeReady、getSdkCommands及loader | retiring后不启动新工作，旧context/结果不发布 | 冷/热fallback、provider切换、command loader/probe各查实际owned槽；不得绕过send门 |
| view onClose/destroy/reopen、同域新view | 同步退役旧manager、并发close单次；不改资源释放时点 | reopen不等于旧exit；已接受save完成且资源barrier未明时新runtime仍blocked |
| plugin unload/reload/loadSettings、registry替换/clear | 可准备旧client退役与版本冲突红测；仅R1a不能启安全热切 | 同App稳定owner/registry/barrier接续、旧writer I/O结果、实际exit；未知协议/realm禁止热接续 |
| send/resume/persistent/cold fallback/reset/cleanup、自动restart | 不纳入R1a已修结论，保持既有行为边界 | 一切新CLI启动查相同barrier；超时/旧finally/新registry不能使第二spawn放行；自动rebuild另过G-retire-effect |

完整退役立即取消自己的pending审批与owned命令订阅，不abort borrowed chat。已接受delta指退役前已归一化并入writer的意图；长sidecar/history read开始不等于接受未来内容。正常关闭只保存有权READY壳；未commit incoming不按currentId猜保存权，已接受incoming delta仍持原handle完成。完整accepted-intent/drain属于R2/R1b，不能提前在R1a宣称已达成。

依赖拆清：R1b需要R2稳定owner与C3的**资源exit切片**、G-domain/G-exit；不必等待所有result归属识别完成。自动rebuild/透明恢复还需要G-retire-effect及相应control证据。资源exit切片可独立实现和假transport验证，未接新client全部启动入口前不能开启R1b生产热交接。

精确改动：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ClaudianView.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/ConversationOpenRegistry.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts`及C3列出的全部runtime启动/关闭入口。B原有collector退役保持，不用它替业务/资源barrier。

#### 3.4 staged hydration：record/source/版本及提交闭环

**已读源码事实〔既有读数〕**：main.getConversationById/switchConversation都会经loadSdkMessagesForConversation触发hydrate；Codex各fork/current分支修改Conversation.messages/providerState及hydratedConversationPaths，OpenCode await后改messages/hydratedKeys。manager ticket只阻止旧消费者发布，不能阻止同域旧读A晚于B覆盖，也不能阻止session S1→S2→S1的binding ABA。OpenCode两次SQL查询当前不返回统一事务snapshot/version，不能将请求号、mtime、最后时间戳用作数据新鲜度。

读取前同步冻结 `RecordHandle + bindingRevision + materializationRevision + sourceDescriptor + callerTicket/readId`：

- RecordHandle核原对象/incarnation；完整跨client合同含recordIdentity与owner资格，按ID重查不足。
- bindingRevision由业务owner维护，session/provider-owned路径、previous sessions、fork/resume/branch或相关读取上下文改变即递增；值返回原样也不回退counter。纯taskData变化不冒充binding变化。
- materializationRevision核该record共享messages/其可变内容的当前版本。任何相关实际写入/清空/live提交/rewind都在提交域内推进；不因换manager或reload重置。per-tab页面/DOM有独立projection generation，不能拿mount/unmount、A统计revision或B collector代替。
- sourceDescriptor是provider捕获的不可变实际来源：vault/provider/session、native文件或DB、fork链/截断点等。snapshotProof仅在provider能证明文件身份/committed范围或DB一致snapshot时携带；request序号/发布时间不是proof。
- callerTicket/readId只表达消费者仍有兴趣及去重，**不表达哪个数据更新**。

provider只返回staged messages、最小source绑定patch及snapshot证据，不改共享对象、不整包替providerState、不先写“此record已hydrate”的cache。集中**同步提交点**同时重核record/client、caller、bindingRevision/sourceDescriptor与expected materializationRevision；随后提交允许字段、推进materialization版本，并据实际新绑定推进binding版本，再返回commit receipt。失败/retired/deleted/version mismatch不发布，cache也不set/delete当前其它已提交结果。

A/B同从v0读取、B先提交成v1、A后返回：A expected-v0失效，拒绝覆盖。此结论仅防旧基线覆盖，不称B内容更鲜；A可能读得更晚。来源无可证序关系时显式重新读取当前base，不把“后发请求获胜”当freshness；如果实际有可证append/snapshot偏序，也须防止覆盖并发live/业务意图，不能绕过版本核验直接全量覆盖。失败、半行、来源变化返回uncertain/retryable，不称最新完整历史。

**缓存分两类**：纯不可变source snapshot读取缓存可在成功读取后保存，只按可验证snapshot身份复用；record级hydratedKeys/hydratedConversationPaths只在commit receipt后由有权提交者更新，key至少带recordIdentity/binding/materialization确认版本与来源。cache失效也走同域资格，旧读失败不得删B的新cache。provider payload不能与current Conversation/可变live消息图共享写引用；只浅拷贝数组不足。若某消息图实际共享，所有相关原地写必须进materialization提交域，否则该发布路径No-Go。

| 实际入口/写点（本次只读定位） | 合同映射 |
|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts:849–855,883–889,959–965` | getConversationById不再隐式发布；分纯metadata snapshot与显式staged read/commit。switch只在有权完整提交后返回可恢复数据 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts:279,933` | loadActive/switch使用完整record/source/version提交许可；Claude保留index/window，不新建全量hydrate路径 |
| 同Controller `:1994,2036`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/InputController.ts:707,1427` | 标题状态/回调纯metadata lookup；标题材料是detached读取，不发布共享历史；标题写仍用原record handle/最新字段guard |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts:1203–1210`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts:526–554` | warmup/runtime初始化只捕metadata及selector上下文，不通过getter hydrate；await后再核context，启动仍受R1b资源门 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/history/CodexConversationHistoryService.ts` | pending fork、established fork、current三分支的messages/providerState回填及所有cache set/delete改为staged delta/提交后cache |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/history/OpencodeConversationHistoryService.ts:26–52` | messages/cache提交移动到commit receipt后；缺失/失败/旧read不清别人cache |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts:525–593,945–955`及create/delete | bootstrap/对象替换受record identity；update的messages/source字段推进对应版本；rename不伪造history freshness |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/env/ClaudeSettingsReconciler.ts:43–53`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/env/CodexSettingsReconciler.ts:35–40`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/env/OpencodeSettingsReconciler.ts:63–76` | 改source/session的失效意图进业务owner，binding版本递增。保持原provider失效政策，不另改模型/端点行为 |
| Controller.save/rewind/backfill `:454–474`、Tab任务回调 `:1338–1357` | save清共享messages或变binding按field mask推进；backfill不直接Object.assign旁路；task仅mergeTaskFact，不整包覆source/taskData |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/state/ChatState.ts:83–105,132–137`及Input/Stream/AutoTurn的相关消息修改 | 区分per-tab私有projection与共享record；共享/原地影响同record时进版本域。分页挂载不当全历史更新，不重算A统计 |

以上是实际已定位写点及其消费者映射，不宣称已实施；落地前补机械搜索所有messages/source写入、原地共享图变更及cache操作，逐项pass/N/A。完整shared commit依赖R2稳定版本所有者和所有相关写点接线；纯metadata拆分/staged payload可先开发。缺任一写旁路、无法证明cache归属或同域版本接续时，G-hydration不关闭，不用manager ticket通过代替。

### 4. C1：业务 mutation、保存 ACK 与删除

#### 4.1 最小 writer 合同

一个 `(vault,recordIdentity)` lane，只接受 handle＋最小 immutable delta；只有 create能建立新 meta。旧 public `saveMetadata(旧全量对象)` 不得留下生产旁路。provider-specific归约由 Claude 注入，不由 app deepMerge 终态。

| 意图 | 执行时对最新 base 归约 | 不允许 |
|---|---|---|
| createRecord | 新 recordIdentity，原ID delete barrier已处理 | 迟到save自动创建 |
| patchMetadata | 显式field mask；explicit-clear才删除；保留其它字段 | undefined隐式清整个上下文 |
| updateSessionBinding/rewind | 原handle＋expected session/branch；当前有效来源核验 | 旧runtime全providerState回滚新session |
| mergeTaskFact | 对同record/run归约；首次已证terminal与其attention事实/待决policy同一次持久写 | UI window/READY/result决定是否落事实；重复terminal重复建未读义务 |
| mergeTaskContent | 同run来源proof＋content revision，只补内容 | 内容反推terminal、agentId全文件合并 |
| acknowledgeTaskAttention | 原record/run/attentionKey、已确认review revision；只确认该run已见或所选外部提示attempt | 切tab清所有任务未读；把OS构造调用等同用户已读/送达 |
| migrateLegacy | lane内读preferred/legacy；preferred已存在不得覆旧 | load/list先读旧raw再递归enqueue save |
| deleteRecord | 同ID barrier，原handle退役，按provider policy登记结果 | ID-only异步删除新record |

流程：同步验证admission并发ticket → lane内验证record与最新base → reducer → 现时序列化 → write/legacy清理 → 确认base并重投影base＋后续已接受delta。磁盘结果不确定时，下个mutation先做有序恢复读；损坏/身份不明即failed/conflict，不用旧内存全量重写救场。

返回联合：`written(handle,ticket,confirmedRevision)`、`skipped(reason,confirmedRevision?)`、`failed(stage,retryability)`、`conflict(reason)`。missing/deleted/non-READY壳明确skipped；只有written或可证已写重复清对应dirty ticket。write后legacy清理失败不是written。任务终态可先显示dirty，不假称saved。

精确位置：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationMutationCoordinator.ts`（新）、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts`全部startup/environment/create/update/rename/delete、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/storage/SharedStorageService.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/SessionStorage.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/storage.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/types/chat.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts`。

SessionStorage 降为 lane内raw read/write/delete primitives；序列化使用原始metadata base＋白名单delta以保留未知顶层字段，不只保留providerState。record header归属业务，不叫sizeFence。没有sidecar统计写者，task纯metadata变化不触发全历史重算/统计落盘；来源绑定变化调用A的内存invalidate，普通save后原stat旁路保留。

R2业务owner同时保留§3.4的record/source/materialization版本及提交资格；source和共享消息的所有实际改变必须在同一同步提交域推进对应版本，纯metadata字段不伪装成source freshness。hydration的内存commit receipt与磁盘written ACK分别命名，前者不能清持久dirty；provider“已hydrate”cache只接受前者，terminal＋attention的可靠重投影只接受后者。不得从异步cache更新反向覆旧providerState或记录旧terminal。

#### 4.2 删除合同与原生结果

1. 同步捕获原handle、退役该record新准入；取消自己的审批/poll，detach UI，先前accepted mutations依次完成。
2. metadata delete在同ID barrier内；同ID再次create必须等结果已处理后显式新建新identity。
3. provider 返回 policy/outcome，至少区分 `keep-native`、`deleted`、`missing`、`failed`、`cleanup-pending/unverified`。当前 Claude best-effort unlink不再吞成“已物理删除”；Codex/OpenCode保持native是明确policy，不是失败。
4. 不在可能仍写原生文件的CLI上盲删文件、猜PID或隐式扩大stopTask。若原生写者无法安全退出，逻辑删除与native cleanup结果分别报告。保持当前best-effort产品范围可允许logical deletion完成并提示native未确认；若要求严格物理删除失败即阻止逻辑删除，须用户另裁决。
5. metadata删除失败保留retired/uncertain记录供明确retry/recover，不报成功。已删除record的旧callback一律skipped，不因原生文件再出现而复活meta。
6. UI reset使用原handle＋专用resetAfterDelete，不调用会先保存旧session的普通createNew；再核tab仍绑定原handle，不cleanup后来切入的新runtime。

位置：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkSessionPaths.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts`、两非Claude history service及 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts`。

### 5. C2：后台任务事实、内容来源与独立 attention

#### 5.1 任务领域及 run 内容合同

新 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeTaskEventAdapter.ts` 仅做wire/transcript守卫归一化；新 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeTaskCorrelation.ts` 仅做scope/alias/occurrence证据归约，不持第二lifecycle状态库。SubagentManager/subagentData承载同一任务record，UI为派生投影。

- 持久task key=`recordIdentity + providerSessionId + taskId + 已证providerRunId`；无run时只能使用已证launch tool-use/source row的compatOccurrence，不能生成UUID冒充runId。
- 缺run匹配须在所有可匹配历史occurrence里唯一；只有一个running不等于唯一。taskId/toolUseId/agentId各自namespace；通用Bash/MCP/workflow task无Agent launch证据不进subagent/watchdog候选。
- live、early-terminal、history、recovery复用同归约：明确completed/failed/stopped及patch killed可销账；无正文不丢terminal；无status不默认completed。terminal重复幂等，晚running不复活；冲突native终态标conflict而非arrival胜出。
- `providerTerminal`、`localAttachment`、`content`、`persistence`四轴分别保存；switch/orphan不等于provider failed。旧running读取为liveness unknown，不自动恢复活动资格。
- 在既有subagentData内版本化保存v2 records＋provenance。old map key旧工具id与v2 recordKey不混用；parentToolUseId用于UI。兼容读取旧条目，不把未知内容迁成确定run/final。
- 接收合同中立结构化，带fixed scope/record handle/sourceRef及接收结果；通知不造turn、不发送补prompt、不释放host lease。已归一化事实入短mutation后返回，不await长sidecar链。
- sidecar输入固定session/agent/run/launchRef、snapshot/branch及来源proof；只读已证段的committed完整行。最终正文还需要该run final输出合同。只有safe path或固定callback时禁止自动完整hydration，只展示已证summary与unverified/missing。
- poll按recordKey；内容returned且资格有效才接受delta。退役前已接受delta可写旧record；退役后返回但此前未接受的内容丢弃自动提交，后续用户recovery可重新读已证来源。
- fork只复制source snapshot覆盖的历史事实/provenance，不复制source still-running的live接收资格。parent不在window仍可独立保存task，不调用壳save兜底。

精确接线：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/types.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/ChatRuntime.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/types/providerState.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/services/SubagentManager.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/StreamController.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkAsyncSubagent.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkMessageParsing.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkSubagentSidecar.ts`、ClaudeConversationHistoryService。branch/index仅按实际结构事实提取缺口补，不重算全量历史或改budget。

**当前门**：真实task事件字段/wire透传、sidecar跨文件run bridge/final来源仍未证。纯归一化/幂等/未知分支可开发；未证来源的自动正文/工具明细补全不能启用，确定性fixture不能把来源升级为verified。

#### 5.2 已证 terminal＋零 result 的独立 attention 路径

**源码事实〔既有读数〕**：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts:241–256` 以成功turn completion设置needsReview/桌面提示，并在切tab时清turn review；持久tab state仅保存id/provider草稿，不保存needsReview/lastNotifiedCompletedTurnId。`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/StreamController.ts:1482–1520` terminal只销账与hydration，没有独立attention发布。故已证任务terminal、零result、parent不可见时，该turn通知路径不会可靠给出提示〔推算〕，不能用“任务已持久”代替“用户可见”。

最小目标是在**同一既有v2 run记录**里增量保存attention事实，不建通知数据库/新通用tasks panel，不由task发SDK prompt或伪造turn：

1. native事实已验证且绑定run后，首次terminal归约同时生成稳定attentionKey（同recordIdentity/session/run或compatOccurrence），连同terminal、sourceRef、skip_transcript三值及policy版本/待决状态，进入同一次mergeTaskFact持久意图。重复/重放只补provenance，不重复创建未读或刷新completedAt；未知run不猜键。冲突terminal保留conflict，不发第二条成功结论。
2. 策略批准后，普通已证run的`pending-review/seen/suppressed`按明确policy归约。policy未裁决时只保存可分类事实/待决状态，不擅启新badge/桌面政策，也不静默登记成用户已读。**target有独立路径，不宣称pending策略已经给出自动提示**。
3. terminal＋attention written后由main中的app级单一projector发布中立attention summary，现有TabManager/tabbar/history行按原record handle重投影；没有tab也能在历史入口呈现。父消息卸载、host结果缺失、content未ready不阻此链。失败保存仍dirty/failed，走保存错误路径，不把OS提示当持久ACK。
4. turn的原needsReview行为保留；task review从持久run ledger派生，UI显示可用`turnReview OR pendingTaskReview`，不增加第二份可清空的任务真相。`seen(attentionKey,reviewRevision)`须用户确实查看相应terminal摘要/明确确认；只切tab、卸载父DOM、重载、桌面发送不清任务未读。旧seen不能清后来尚未确认的review revision。
5. reload加载持久run ledger重投影未读，native重放仍按同run幂等；fork不复制源conversation的live提示或待发送外部attempt。删除原record后旧attention/OS回调无资格污染新record。同受控App域的多view只消费summary，不各自执行外部副作用；跨client共享同owner/ledger并核资格。
6. **跨独立renderer/窗口/进程去重没有额外保证**：若不共享受控owner，本合同的单projector/原子归约前提不成立，须G-domain或另行互斥。不能靠各窗Set、tab索引或时间戳宣称跨窗恰好一次。
7. 桌面提示是与文件写不同的外部副作用。推荐候选为持久未读可靠重投影、桌面best-effort attempt：在受控域按run claim、记录attempt资格/状态，发送前再核client/record，尊重既有desktopNotifications开关与OS权限；不自动申请新权限、不扩手机relay。若选择attempt写在发送前，崩溃可能有标记无桌面弹出；写在发送后可能重投。明确不承诺崩溃边界exactly-once送达，Notification构造成功也不等于用户见过。reload是否重发未完成外部attempt须用户裁决，推荐只恢复未读、不自动重播历史桌面提示。
8. 未ACK事实仍可能在崩溃前丢；尤其skip_transcript不应假定一定能从native transcript重放恢复。没有源记录证据时保留恢复缺口，不凭空补terminal/提示；已ACK ledger不以新result是否出现决定重投影。

installed SDK `/Users/vincentwang/Documents/NoteVault/tools/claudian/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2973–2988,3021–3024` 声明task notification/start的skip_transcript；start注释称ambient/housekeeping应隐藏inline、可出现在tasks panel。**这是声明读数，不是本轮wire实测；不是禁止提示的政策，也未证另有ambient布尔字段。**adapter保留实际skip三值与来源，不把缺省当false、task_type当静默证明，started已证skip不被terminal缺字段清空。

| 人群/终态 | 产品候选 | 本稿推荐，均未获裁决 |
|---|---|---|
| 普通已证Agent/Task run：completed | 持久未读；或未读＋桌面 | 至少持久未读；文案“后台任务完成”，content未知时不称完整结果可用，不称host turn成功 |
| 普通run：failed | 持久失败未读；可另开桌面 | 持久异常标记；是否桌面沿明确政策，不套streamComplete成功文案 |
| 普通run：stopped/killed | 普通终态未读；或已证主动停止静默 | 保留stopped语义；无明确stopCause/run关联不猜用户主动。静默是否同时抑制未读须单独明确 |
| 已证ambient/skip_transcript | 隐藏inline＋静默；或隐藏inline但保留未读/异常提示 | 隐藏inline；默认不弹桌面只是推荐候选，异常是否进入现有历史attention待裁决，不新建通用tasks panel |
| 未确认skip/来源或terminal conflict | 明示待核/异常，或暂不主动提醒 | 保留分类缺口、不当普通成功、不偷偷转suppressed；主动提示选择待裁决 |

精确映射（不增新source模块）：ClaudeTaskEventAdapter/Correlation保留flag/证据并作纯归约；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/types/providerState.ts` 在v2 run记录中带attention；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationMutationCoordinator.ts` 合并terminal＋attention与seen/attempt；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts` 负责单域projector；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/types/chat.ts`/中立runtime types定义派生summary；TabManager/TabBar/ConversationController/`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/desktopNotifier.ts` 消费现有表面并使用选定终态文案。单纯turn callback/position-index notifier不可作为跨reload task去重。其它provider任务能力、桌面权限默认、手机提醒与通用task面板不扩。

**attention门**：纯归约、持久/重投影、零result和无DOM红测可先准备；生产run来源与writer/跨client域、用户attention政策未关闭时，不启新外部提示或宣称S1提示闭环完成。G-attention明确校验零result仍可见，不要求先获得host control result或run final正文；但不等于可以跳过G-control去Stop。

### 6. C3：Stop/result 与全入口 query retirement

#### 6.1 内容owner与控制结果分开

新 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeEventOwnership.ts` 是纯窄判定器，消费既有canonical/alias/父链事实，不把现有observe-only coordinator偷换为结算者。

固定次序：**scope资格 → replay/duplicate/conflict → task事实 → user queryability/assistant关联 → result owner/control evidence → cancel fence → 内容/usage/成功结算 → query安全交接**。

- host只有实际dequeue成为dispatched；aliases共享canonical owner。冷热输入工厂同合同；channel text重建保留已批准身份/语义字段。
- shouldQuery=false不创建独立轮；true只是候选；absent是legacy unknown，须冻结版本缺省/执行父链证据，不从origin猜。
- assistant/native父链可证内容owner，不推出bare result owner。result自身uuid去重、session校验、唯一候选、num_turns/耗时/usage/最近echo都不独立构成control proof。
- result返回bound/unresolved/duplicate/stale/conflict；多通知一result、零result、额外result、result先到均有显式分支。无归属不算host成功、不写host usage、不解cancel tombstone。
- 已绑定内容end_turn只作terminal-candidate，沿用quiet-settle/强continuation撤销、manual/auto compact区分。control-result与CLI handoff各有proof。
- `done`/generator EOF不是成功。对Claude补明确completed/cancelled/failed/recovery-needed结果metadata，消费者含InputController与AutoTurnProjectionController据此决定**turn**通知/按钮/队列；task terminal的独立attention走§5.2，不等待此metadata，也不伪造完成turn。共享可选能力不改变其它provider。

位置：ClaudeChatRuntime、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeMessageChannel.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeUserMessageFactory.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/sdk/types.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/sdk/typeGuards.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/stream/transformClaudeMessage.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/types.ts`、InputController/AutoTurnProjectionController。observer/mapper/reconciliation保留证据生产与当前observe模式，需升权则另核具体范围。

#### 6.2 retirement不是只修watchdog

当前watchdog retireAndRebuildQuery已等真实exit〔源码既有读数，不是本轮实际进程验收〕；普通close/reset/cleanup还可能同步清scope/解除start prohibition，新tab runtime/reload不在旧runtime槽内。统一在现有QueryScope/retirement链补 `retire(restart:false|true)` 的显式结果及可await barrier，所有 persistent/cold、restart/reset/switch/cleanup、view/plugin关闭都经过同资格原则。

该**资源exit切片**是R1b的前置，不由R1a局部guard补出，也不必等全部result可归属才开发。稳定域保持原资源record、client/query epoch和pending exit promise，新registry不能重新发空槽。G-exit核全部实际启动入口及跨runtime/client接续；G-retire-effect另核后台任务/continuation影响，前者关闭不自动批准后者或新result settlement。没有稳定barrier和exit证据时，R1b热重开/交接保持禁用或显式blocked，不用“只改manager”名义启用。

- 同步退役scope并封dispatch；提取never-dispatched队列；注册exit wait在close前；旧query实测exit前不得新建占用同record资源槽的CLI。
- 局部runtime被dispose不销掉barrier。稳定生命周期域保存pending/blocked资源引用；新client及registry在交接前不得越过。timeout不是exit，也不释放业务writer。
- unknown owner保存已绑定内容/terminal事实，冻结新派发；有界诊断/索引对账不长占projection grant。没有安全control proof时可进入显式恢复界面，而非透明继续。
- 自动retire/rebuild须同时有原门控证据及后台任务/continuation副作用被验证可接受；后台存活/归属不明时不能新增自动恢复。已dispatch输入不自动重发；既有crash replay不扩大。
- 原watchdog的120秒/15秒/5秒门槛与候选范围不改。hasRunning hook-only getter清理不可变成通用存活判定；watchdog继续非破坏性running snapshot，加session/run作用域。
- 最后才删除persistent/cold插件Stop注册、熔断及旧hook测试；保留用户hooks，不能用hooks={}全关配置。

**当前门**：真实control proof未证，故新的结算、无感恢复、Stop移除均No-Go。纯判定器/unknown退化分支、retirement确定性回归可开发但不能因此启用新生产结算。需要真实证据导致更大turn边界适配时，先回报而非实现中扩scope。

### 7. C4：always政策与每次审批尝试身份

ordinary allow已局部修复，本批不得覆盖或重做成session rule；ExitPlanMode明确session setMode仍是独立计划交互。

#### 7.1 未裁决政策的三分支

| 分支 | 响应 | 代价/当前状态 |
|---|---|---|
| P-once（推荐候选） | 全部ordinary只准本次，无updatedPermissions | 降记忆能力；用户尚未裁决，不能部署隐藏always |
| P-native-legacy | 非空suggestions时原数组完整透传；无/空降once；不造rule、不改destination | 接受0.2.112缺组织suppression信号的兼容风险；须明确接受 |
| P-upgrade | 另批依赖后验证实际hint桥/UI/response同门槛 | SDK/CLI迁移独立授权，本稿不升级 |

eligibility由provider一次计算，UI与最终PermissionResult共用；policy=pending时不启动新的always实现。现状always旧builder缺陷不能因为ordinary已修而宣称整项授权已安全。用户选分支后才删除 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/security/ClaudePermissionUpdates.ts` 及迁旧测试。

#### 7.2 request handle

每次canUseTool callback建立独立attempt token，带原workspace/runtime/queryScope/RecordHandle、已证owner/turnKind、toolUseID/agentID。相同toolUseID重投是不同attempt，不以卡片、tool id或最后一个pending引用去重；local token不叫SDK request_id。R1a可先隔离原inline实例并透传signal，但不宣称R2 RecordHandle、R1b跨client返还资格或真实owner已闭合；新always/auto timeout及未知owner产品行为仍按各自门控制。

ordinary、Ask、Exit均传signal和handle；注册前aborted直接cancel，注册后SDK abort/runtime cancel/switch/delete/unload进入同settleOnce。每attempt保留原inline实例，finally只清自己listener/timer/card，最终return前重核资格；旧回调不能解除新input禁用、清新卡片、同步新query mode或返回持久更新。

unknown owner不能默认为attended user；审批不可用/恢复明确，不以当前activeTab猜。auto ordinary/Exit采用现有Ask 300000ms是建议扩展，未裁决前不启用该新timeout；user正常等待和原Ask政策保留，手机ordinary权限relay不扩。

位置：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeApprovalHandler.ts`、ClaudeChatRuntime、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/types.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/InputController.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/rendering/InlineAskUserQuestion.ts`、Tab callbacks。其它provider既有decisionOptions行为保持。

### 8. C5：命令来源、scope及owned probe

新 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/ClaudeCommandContext.ts` 从现有query settings/env/plugin/MCP/additionalDirectories规则提取纯context，不复制过滤政策；cold probe/inline/chart无关aux query不强改为chat规则。

新 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/commands/ProviderCommandDiscoveryStore.ts` 只承载snapshot发布/订阅/flight，不持provider wire政策；catalog拥有它。

#### 8.1 snapshot与替换

必要字段：entries、status、desired/observed scope、source=`vault/init/live-push/probe-candidate`、sourceRef/revision、publishedRevision、workspace/query epoch、coverage/uncoveredReason、stale、structured error。ready与coverage独立；成功空可缓存，错误不变空成功。

- installed0.2.112 supportedCommands读初始化对象；没有实际live证据时hot标init-observed，不把MCP connected、重调函数或新publishedRevision当目录热刷新。
- hot目标tab可读borrowed init；跨tab只有effective scope可证对等才候选借用，同provider不足。probe默认candidate，不能覆盖当前session已observed范围，空也不能越权删hot。
- scope包含实际CLI/SDK/build、env内部revision、settingSources与配置版本、plugins/MCP/disabled工具、external paths、target declared mentions/selector。desired≠observed时不共用complete cache，不猜未来prompt mentions。
- Inline取自身external contexts及真实inline执行规则，不借active chat selector；Settings只列vault可编辑范围；两picker复用store/policy，非Claude行为等价适配。
- refresh返回确实做了vault-rescan/new-probe/await-live-evidence/session-refresh-unavailable哪种动作；无live能力不为菜单重启热query。
- partial/init/candidate如何显示与选择仍为产品待决；最低安全线是范围明示、未确认可执行项不能默认为当前session可执行。若不接受partial则显示错误/不可用，而不是假空全集。

#### 8.2 flight与清理

每fingerprint一个owned flight，多subscriber。单退订不abort其它消费者；末退订/换代/retire才关闭owned probe。borrowed chat仅摘listener，永无abort/cleanup权。旧finally由flightId/epoch核验，不清新flight。

probe全出口try/finally覆盖EOF/init/supportedCommands/spawn/abort异常，signal能够中断等待；普通错误保留。允许启动前必须有明确有限hard lifecycle policy；policy未确认返回unavailable，不开启新无限flight。UI提示deadline、flight上限、MCP cap三个字段分开，不设上游30/5秒，不改用户显式MCP_TIMEOUT或chat env。

customSpawn仅为probe可选提供owned child/onExit/listener teardown；SDK close/abort/forced EOF不当真实exit。真实child和已证owned后代退出前保持cleanup-pending/failed；未知共享MCP不猜PID清理，绝不pkill。cleanup失败禁止自动重试累积进程。

registry initialize候选创建成功才安装；失败/旧initialize迟到dispose候选。setServices/clear/unload先同步retire旧准入，再可await dispose/drain；旧资源barrier保留在稳定域，不能裸覆盖引用。只清owned catalog/probe，不替chat cleanup。

位置：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/commands/ProviderCommandCatalog.ts`、ClaudeCommandCatalog/probeRuntimeCommands/ClaudeWorkspaceServices、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/ProviderWorkspaceRegistry.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts`、main/TabManager、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/shared/components/SlashCommandDropdown.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/inline-edit/ui/InlineEditModal.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/customSpawn.ts`、ClaudeChatRuntime/fetchAndCacheCommands、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeQueryOptionsBuilder.ts`和实际inline options生产点。i18n新增状态同10语言键，不覆盖A的体积文案。

**当前门**：source truthful store可以开发；current-complete/live补全、initial-equivalent probe、无成本/无副作用承诺、新自动Retry/后代清理策略不得启用。无需模型的官方初始化若当前本地SDK已有可读入口可作为候选；本稿未发现并验证，不能发明API。

### 9. 批次、允许项与阻断项

| 批次/切片 | 可独立实施/验证 | 生产启用前置 |
|---|---|---|
| R0 | 保留主会话once/英文改动；派单已报告隔离验证通过，冻结包含全部脏文件的整合基线 | 隔离验证不等于最终整合/部署验收；用户preset中文别名不擅改 |
| R1a 局部隔离 | 封旧manager准入/旧结果发布、纯metadata lookup、本地inline实例与signal隔离 | 确定性生产接线回归；不提前释放claim/CLI槽、不清start prohibition、不启新client接续、不改always/timeout；不称全局第二CLI风险已消除 |
| R1h 历史提交准备 | staged纯读取、source/版本合同与全写点/cache红测 | 纯读取/lookup可先做；shared publish须R2版本owner、全部写点接线及G-hydration，不能只凭manager ticket |
| R2 保存与版本owner | typed mutations、header/ACK、legacy、delete barrier、binding/materialization版本、terminal＋attention原子意图 | 用户接受writer范围/首切/schema与回退；业务及相关共享消息/source全部入口无旁路，cache无旧读set/delete |
| R3-resource 资源exit前置 | 复用QueryScope补全入口retire/真实exit barrier；假transport跨runtime/client延迟exit红测 | 先于R1b接线，可与纯owner测试分开；不据此开启自动rebuild或新result结算 |
| R1b 跨client资源交接 | 全startup/warmup/send/reset/reload入口接稳定资源barrier，accepted delta有权drain | R1a＋R2稳定owner＋R3-resource、G-domain/G-exit闭合；旧I/O/exit未明保持blocked，不能用R1a测试通过替代 |
| R3-task/attention/owner | task归一化/未知分支、run内容proof、窄owner；零result的持久attention/重投影与策略矩阵 | R1h/R2对应门闭合；真实task/run/control各门独立。新attention表面/桌面启用另有用户policy及G-attention，不等host result、不默认重发桌面 |
| R4 | 用户选定always后原生响应/eligibility；source-aware command store/UI/ownedflight红测 | 政策先裁决；真实probe资源/成本/timeout门独立。仅纯source store不需先开模型，生产ownedflight仍须稳定资源接续 |
| R5 | 去插件Stop、实际自动hydration/新query交接、新probe生产启用 | 对应真实门及已确认attention产品策略全过，逐批独立reviewer与现场验收；失败不以下一批兜底 |

R1a、纯metadata/staged读取、request本地隔离和command纯状态可以先开发，不把尚未落地的R2/R3前提包装成已存在。依赖关系是R2＋R3-resource→R1b，不是R1b等待完整result识别、完整result识别又等待R1b的循环。R1h shared提交、task attention持久重投影必须使用同一已接线owner；纯reducer/matrix准备不启用未裁决产品政策。

共享main/Tab/Controller/types由一名integrator串行整合，A纯内存统计/B诊断既有边界保持。若真实门无法关闭，负结果有效：保留不启用/blocked分支，回报具体真实契约缺口，不无限加启发式。

### 10. 方案推演

#### 10.1 具象走查〔全部纯示意，非实测〕

| 锚值/同一对象 | 合同结果 | 红/绿判据 |
|---|---|---|
| r9旧providerState先捕获，task A r10已written，rename B随后 | lane最新base归约A/B，不接受旧全providerState | 绿：A/B/未知字段均在disk；红：只保证三次FIFO |
| 旧manager第一tab restore停住；destroy；继续第二tab | 原ticket退役，第二tab不能reserve/init/commit | 绿：旧域新claim=0、第二次destroy不必要；红：仅collector=null |
| OpenCode旧read停住；新owner发布live；旧read返回 | staged旧read无record/source/materialization提交资格；不推进/删除当前cache | 绿：共享messages仍live且新cache不变；红：旧switch reject后共享值/cache仍被old覆盖 |
| 同域A/B均捕materialization v0；B先commit v1，A后返回 | A expected-v0拒绝；不把B先完成当内容更鲜 | 绿：A覆盖=0、cache保持v1；红：manager ticket仍live就接受A |
| A先发但实际读得更晚；请求号A=1/B=2，来源无可证偏序 | request号只管兴趣；版本冲突后重读，不宣称B因号2更鲜 | 绿：0次以发起/到达顺序断言fresh；红：last-request-wins冒充完整新鲜历史 |
| source S1→S2→S1，bindingRevision 0→1→2；旧read持S1/rev0 | source值虽同，binding版本不符拒绝 | 绿：旧提交/cache变更=0；红：只比路径/ID通过 |
| R1a关闭旧manager，旧CLI exit仍pending；新plugin/client触发prime/send各1次 | R1a不证明资源释放；R1b未闭合禁止安全热切，已接barrier时两入口都blocked | 绿：确认exit前newSpawn=0且不清prohibition；红：registry重建得空槽或timer放行 |
| C_old delete pending，同ID请求C_new | barrier处理完再新identity；旧reset/write拒绝 | 绿：来自old的新记录写入=0；红：finish时按ID换绑 |
| T/R1 terminal，R2 running，缺run的R1晚到 | 历史两occurrence可匹配，ambiguous不销R2 | 绿：R2仍running；红：唯一running当唯一身份 |
| R1 terminal已证，sidecar末条是R2进度 | terminal written，R1 content unverified | 绿：错run正文=0；红：安全路径就读last assistant |
| 已证run R终态completed，0 result，parent tab/DOM不可见；示意选择“持久未读” | terminal＋attention写同意图，ACK后history/tab汇总显示1个未读；turn完成回调仍0 | 绿：独立可见未读=1，不发补prompt；红：只等turn completion、伪造host done |
| R terminal重放2次，reload/multi-view重投影2次，用户仅seen一次 | 同run attentionKey复用，seen持久化；views不各建外部attempt | 绿：逻辑未读最多1、seen后0；红：裸taskId/新queryEpoch重建义务 |
| skip_transcript=true事件已接收但未ACK即崩溃；或OS发送前/后崩溃 | 未ACK事实可能丢、native恢复未证；已ACK未读可重投影，桌面attempt不作送达/已读证明 | 绿：明确unknown/损失窗口且不宣称exactly-once；红：凭空从transcript补任务或承诺弹出恰好1次 |
| H cancel，N false/legacy通知，先到未明result | 不解H tombstone，不新发队列 | 绿：确认前dequeue=0；红：cancel后任意result释放 |
| 两旧storage实例pending写，新plugin注册owner | 无旧protocol证据不得热切；冷退出/受控接续门 | 绿：新域越过旧I/O=0；红：new Map即宣称单writer |
| 同toolUseID审批重投两次，旧card晚回always | 两attempt；旧只清自身，scope取消后0permission updates | 绿：每attempt response≤1，新卡片可答；红：tool id共用resolved |
| hot init2命令、MCP后来connected，probe空 | init scope保留2，probe candidate另列；coverage未明 | 绿：假current-complete=0；红：最后revision胜 |
| 两subscriber共probe，取消1，CLI exit后后代持stdout | 另一订阅继续；child/后代分别核退出 | 绿：误杀chat=0，cleanup未证时新Retry=0；红：EOF当全部exit |

默认值最不利：shouldQuery缺失、run缺失、terminal无正文、非READY、policy pending、无live目录水位、旧writer/CLI exit pending、native删除未确认、source ABA/版本无法排序、零result/parent不可见，分别返回unknown/ambiguous/missing/skipped/不切策略/init-observed/禁止接续/独立cleanup明细/拒旧基线并重读/按已选attention策略独立重投影。skip字段未知不默认静默，未ACK事实不默认可恢复，OS调用不默认用户已读。

#### 10.2 论证链与反例

- 所有业务writer受同owner准入 → lane内read/reduce/write最新base → 不同字段意图不丢。隐含前提是全入口受控且owner接续成立。反例：另一个Obsidian renderer直接adapter.write；本合同多writer保证立即不成立，检测哈希不能补回互斥。
- input dequeue UUID＋同snapshot父链 → 可绑定assistant内容。反例：bare result没有input桥；内容链不能多推出result归属，更不能自动解除cancel fence。
- task terminal＋已证run段＋该run final合同 → final内容可以ready。反例：同agent resumed文件跨run；terminal与safe path都真而末文本属R2，缺第三项必须拒绝。
- subscriber全退＋owned close＋真实exit → 本flight资源可交接。反例：direct child已exit但后代存活；EOF/Promise settled不是第三项。
- manager ticket仍有效＋staged结果 → 有权覆盖共享历史。此链缺record/binding/materialization版本前提；反例是同域B已写v1、A仍持v0并晚返回。补版本拒绝A只保证不覆并发base，仍不能推出B内容因请求晚而更新。
- 已证terminal＋同run持久attention ACK＋所选policy → 零result也可重投影未读。隐含前提为run关联、writer/跨client域受控且policy已批准。反例：skip_transcript事实未ACK崩溃，源无恢复记录；或两独立renderer各发OS通知。不能多推出所有事实无损/桌面exactly-once。

追溯：不翻改两份draft或已关账事故记录。前向反事实：只去Stop保留bool/旧writer，会允许相同通知竞争与旧快照覆盖；只新建writer保留manager越代，旧operation仍能获得新claim或污染共享messages。故两者都不是完整修复。

#### 10.3 结构不变量

- 正交性：record/writer、task terminal/content/attention、turn/control、diagnostic/stat分轴；目标条件成立，当前实现未证。R1a资格不推导R1b资源已exit，hydration ticket不推导freshness，task terminal不推导host成功；混用均违反。
- 无环：native facts→task reducer→terminal/attention mutation→ACK→独立UI重投影；source staged read→有权commit→hydrated cache；command evidence→store→UI。task→补prompt、保存→全history重算→再保存、cache→旧全量对象回写均禁止。
- 扩展方向：wire/run/source判断在Claude边界；features用中立合同；新增provider只做能力适配，不重写shared UI猜字段。
- 退化：无DOM、空目录、legacy无run、unknown owner、non-READY是同合同状态；不另设小会话全hydrate/无通知跳身份支路。
- 入口覆盖：目标需实证矩阵。persistent/cold/recovery、save/startup/environment/rename/create/delete/legacy、Main/Inline/Settings、view/plugin/reload、全部getter/title/warmup hydration来源、terminal×可见性/result/skip/重载全部逐格验证；局部unit不代表全入口已接。R2＋资源exit切片→R1b明确单向，不能令R1a隐性依赖R1b后仍称独立已闭合。

### 11. 交付物规范

#### 11.1 目标目录树（既有记录锚点及后续新增部分）

绝对根 `/Users/vincentwang/Documents/NoteVault/tools/claudian`。本轮仅订正既有设计记录，无新产物；树中该记录已存在，其余均为后续获准产物，不预建。三处补强复用下列模块/测试及已有UI表面，不另建hydration框架、通知库、通用tasks panel或新的capture工具：

```text
/Users/vincentwang/Documents/NoteVault/tools/claudian/
├── docs/designs/2026-11-08-upstream-compat-remaining-implementation-contract.md
├── src/app/ConversationMutationCoordinator.ts
├── src/providers/claude/runtime/
│   ├── ClaudeEventOwnership.ts
│   ├── ClaudeTaskEventAdapter.ts
│   └── ClaudeTaskCorrelation.ts
├── src/providers/claude/commands/ClaudeCommandContext.ts
├── src/core/providers/commands/ProviderCommandDiscoveryStore.ts
├── tests/unit/
│   ├── app/ConversationMutationCoordinator.test.ts
│   ├── providers/claude/runtime/ClaudeEventOwnership.test.ts
│   ├── providers/claude/runtime/ClaudeTaskEventAdapter.test.ts
│   ├── providers/claude/runtime/ClaudeTaskCorrelation.test.ts
│   ├── providers/claude/commands/ClaudeCommandContext.test.ts
│   └── core/providers/commands/ProviderCommandDiscoveryStore.test.ts
└── tests/integration/
    ├── app/conversationMutationLifecycle.test.ts
    └── providers/claude/
        ├── upstreamCompatibility.test.ts
        └── fixtures/claude-compat/
            ├── evidence-manifest.json
            ├── control-wire.jsonl
            ├── task-native.jsonl
            ├── run-sidecar.jsonl
            └── approval-control.jsonl
```

扩展既有A/B integration中的known-issue断言，保存其当前来源说明；不删除或将已知错误期望当修复验收。R1a/R1b延迟exit、同域history A/B/source ABA/cache、零result attention/seen/reload/skip策略均进入已列的unit/integration及现有A/B suites；attention状态复用v2 run schema/ConversationMutationCoordinator，投影复用main/TabManager/history/desktopNotifier，不增加新source模块。fixture manifest逐例记录policy=synthetic选择，不能命名成用户已批准策略。暂不新增正式live capture工具；已有批准捕获方式足够就复用。确需dev harness时先确认其调用/预算/退出/命名合同，不现在列虚构可执行命令。

#### 11.2 命名与索引

ConversationMutation=中立业务意图/ACK；ClaudeEventOwnership=控制/内容证据；ClaudeTask*=wire/派生关联；ClaudeCommandContext=effective scope；ProviderCommandDiscovery=中立状态/订阅。模块数量以职责为限，不造事件总线、第二任务库或通用事务框架。

设计记录首版draft，独立主题，不修改原稿。获准落地后在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/README.md` 登记本记录、测试及fixture索引；本轮不改README。

#### 11.3 清单/用途/消费者

| 绝对路径/组 | 用途 | 消费者 |
|---|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-08-upstream-compat-remaining-implementation-contract.md` | 未裁决实施合同/证据门 | 用户、主会话、architect、implementer、reviewer |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationMutationCoordinator.ts` | 单域业务owner/最新归约/ACK | main/storage/所有mutation入口 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeEventOwnership.ts` | 不含SDK猜测的纯归属判定 | runtime/transport回归 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeTaskEventAdapter.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeTaskCorrelation.ts` | 归一化、证据/alias/occurrence合同 | runtime/history/SubagentManager |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/ClaudeCommandContext.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/commands/ProviderCommandDiscoveryStore.ts` | scope和snapshot/flight | catalog/Main/Inline/Settings |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/` 上述6份mirrored测试 | 确定性状态/意图/取消 | implementer/Jest/reviewer |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/app/conversationMutationLifecycle.test.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/providers/claude/upstreamCompatibility.test.ts`及同目录fixtures/claude-compat | 生产链竞争、真实SDK假transport与保真fixture | integration/独立复核 |

manifest必填sourceKind=`synthetic/fake-transport/real-wire/real-native`、case/SDK/实际CLI/build/context、截断/committed边界、捕获授权范围、同盐join映射、删留字段、hash、证明项/不证明项。fake不冒real，哈希不证明CLI保证。raw敏感材料不入repo；一次性采样只在单独 `/tmp/claudian-compat-<timestamp>/`，保留原始材料另授权。

#### 11.4 归属与偏离

沿用 `/Users/vincentwang/Documents/NoteVault/tools/claudian/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/CLAUDE.md` 的provider-native-first、中立边界、mirrored tests、TDD、正式dev工具、禁止console、index预算与用户hooks保留。

独立工具仓既有docs/designs为主题归属，不向vault顶层复制。临时逻辑走派单/tmp约定，优先于一般.context；未找到既有证据manifest索引规范，本节作为雏形，获准落地回填README。无其它主动偏离。

## 风险与权衡

### 1. 用户待裁决（不得冒称已确认）

1. **always**：P-once、P-native-legacy接受缺组织hint保证、或另批升级。推荐P-once候选；ordinary once已修不代表此裁决。
2. **writer范围/首切/回退**：接受单已识别受控renderer/App域、非fsync保证，并允许首次冷退出切换；或确需多进程/多App同写另设计。未知并发写者未排除时R2生产No-Go；不共享稳定资源owner时R1b热交接No-Go，task attention跨独立窗口去重也不能承诺。
3. **回退可用性**：推荐预制保留新header/taskschema、owner/write合同与once修复的兼容恢复产物；遇control/resource失败可禁live发送/probe、保留历史与恢复界面。若不接受此可用性下降，需另核安全回退，不默认恢复旧bundle。
4. **删除语义**：保留provider best-effort/keep-native并报告logical/native不同结果；还是严格native未删即不准逻辑删。推荐保留原产品范围、把结果诚实化，不扩大杀后台任务权限。
5. **产品策略**：是否接受标scope的partial/init/probe candidate；auto ordinary/Exit是否扩用5分钟上限；不新增手机ordinary权限relay。
6. **取证授权/时间参数**：独立测试vault、实际CLI/hooks/MCP启动范围、费用上限、有限probe生命周期/MCP cap与unload UI等待。未批准预算不跑真实模型/连接；没有时间政策不启新自动probe。
7. **零result任务attention政策**：普通completed/failed/stopped哪些产生持久未读、哪些桌面提示；已证主动stopped是否静默；ambient/skip_transcript的隐藏/异常提醒、未知flag/conflict的处理，以及reload是否重发未完成外部attempt。推荐普通已证run三种终态至少持久未读、ambient不默认桌面、reload只恢复未读；均为候选，不冒称用户已同意。选择静默也不能把terminal事实删除或标记用户已读，跨崩溃桌面exactly-once不在保证内。

### 2. 回退合同

- R0语言/once：只回语言展示也不能回掉once修复；保留用户preset和value。
- R1a局部guard/request隔离可独立回退，但不可因此提早释放claim/CLI槽、清start prohibition或称旧资源已经exit。R1b与稳定owner/资源barrier成组保留；未结束的旧业务/资源barrier不得因回文件/重建registry而丢。生产回退先retire/drain，无法确认则blocked/受限恢复，不趁重载另起writer或第二CLI。
- R1h hydration回退须保留record/source/materialization提交及cache约束，或明确禁用shared publish；不能恢复getter隐式hydrate、旧read set/delete新cache或用request号判新鲜。若回退移除某版本写点，先停止读/提交并失效相应cache，不能留下半接线版本合同。
- R2/R3写入新header/task schema/attention ledger后：原部署bundle不兼容保证。安全候选须保留新reader、未知字段/recordIdentity、未读/seen/外部attempt状态、同域writer和delete barrier；禁止旧schema批量转换/删task或把未读重置为已读。旧client/version不受控时不能热回退。兼容恢复产物至少能读已存attention并在原表面重投影；若无法保证，只能保持受限读取和显式恢复缺口，不宣称原提示保证继续成立。
- S1控制失败：不自动重发已dispatch prompt；可冻结live并保留历史/诊断/显式重建，不能回到bool/counter后称安全。task的已证terminal/attention不因缺result撤销，不造turn来补提示；故障期间外部attempt可暂停，恢复后按已选policy重投影未读，未裁决时不重播桌面。恢复旧插件Stop也须明确它重新带来旧阻断缺陷。
- S2：已写SDK原生权限不可通过bundle回滚撤销；回退响应为已批准once-only安全产物，清规则另获授权。不直接退到当前含旧builder的main.js。
- S3：停止owned新准入、取消/确认旧exit，再回源范围展示。无法清理维持cleanup-failed限制Retry，不关闭chat或全机MCP。
- `.obsidian`不受本独立源码仓Git保护；部署/备份/重载须单独确认实际disk＋memory身份。Git回退不能替代runtime/resource交接，也不能覆盖本工作区其他session改动。

### 3. 迁移/落地代价

闭合writer涉及全部业务入口与legacy/raw primitives；R1a局部隔离不能单独提供R1b跨client资源交接；staged hydration涉及两非index provider及全部source/materialization写点/cache，任务attention复用v2 run ledger与现有表面，不另起通知库。新schema读写须compat恢复产物；result/命令真实门可能维持功能不启用。以上是正确性耦合，不靠小diff降低目标。可先交付R0/R1a、纯读取/策略reducer/纯store，R2、资源exit切片、R1b和shared publish按依赖渐进；不升级依赖、不引入数据库、不重做A/B。

## 验证方式

### 1. 无真实模型的确定性回归

本轮未执行。获准实施后所有测试用独立 `/tmp` 数据目录与受控adapter/时钟/传输，加载真实生产接线；禁止启动真实CLI/MCP/hooks，禁止访问活vault/权限文件。Fake filesystem/SpawnedProcess只替输入/故障，不mock被测reducer、writer、审批settlement、store或retirement。

| 测试组 | 必须走的链 | 断言 |
|---|---|---|
| R1a局部隔离 | real View→TabManager→Controller，gate每个await、restore下一tab/fallback、并发close；保留原资源释放时点 | old manager新增claim/runtime/结果发布=0；不清start prohibition、不提前释放槽。此测试不声称跨client新spawn风险已修 |
| R1b资源交接 | 不同runtime/plugin client共受控fake域；旧exit/I/O挂住，新registry/reopen/prime/warmup/send/reset依次尝试；旧finally到达 | 对应barrier未明时newSpawn=0；真exit通知后按资格最多启1；timer/rebuild registry不解锁；accepted delta不丢。fake域通过不代表实际窗口已证 |
| hydration同域竞争 | real OpenCode/Codex staged→集中commit；A/B从v0读，B写v1后A到；失败/空/半行/来源改动/source ABA/live写入 | 旧共享写/cache set/delete=0；拒旧base不宣称后发更鲜；bind rev变化即使值回S1也拒；fork/current既有projection等价 |
| hydration全部入口/cache | main getter/switch、Controller restore/title、Input title、Tab runtime初始化、TabManager warmup；业务update/env/rewind/shared原地消息变更 | 不需history的lookup零hydrate；所有相关写推进正确版本；cache只随有权commit/失效变更；纯snapshot cache不当record hydrated；未接任一共享写点即fail |
| mutation | main所有入口→coordinator→SessionStorage→受控adapter；旧快照/rename/task/legacy/服务重建交错 | 最终字段并集、ACK真实、unknown保留；size stat永pending业务ACK仍可达 |
| failure/delete | write后清理失败、decode损坏、nativeunlink失败、metadata失败、同IDrecreate | 0假written/物理删除成功；0old碰new；不自动复活 |
| reload owner | 不同插件/模块client共fake App；旧pending后注册new；协议版本冲突 | pending不越过；unknown不接续。仅证明fake域，不证明实际跨窗口 |
| task | real SDK假stdout边界→adapter→SubagentManager→task delta→reload；无DOM/非READY/early/重复/冲突/无status/缺正文 | 1同runterminal、0复活/假subagent；unknownrun不hydration；stream/native fixture不混来源 |
| attention零result/可见性 | 同生产task→terminal＋attention writer→ACK→app projector→tab/history；0 result、parent卸载/关闭、active但document隐藏；示意策略逐项选择 | 无需turn completion/content ready仍有1个逻辑未读可达；不发prompt/不报host成功；policy pending不擅开外部提示 |
| attention持久/幂等/崩溃 | terminal重放、跨view/client reload、seen/旧seen、delete/recreate；write失败、skip事件未ACK、OS发送前/后故障 | 已ACK未读重投影、重复无新义务、旧seen不清新revision、旧record影响=0；外部attempt单域受控，送达/跨崩溃exactly-once不作断言 |
| attention策略矩阵 | completed/failed/stopped＋已证/未证主动stop；skip true/false/unknown、ambient/conflict；OS权限/desktop开关；mock notifier只记录attempt | 状态/inline/未读/桌面分别按示意policy，未裁决不默认已批；skip不丢terminal、无普通成功误报、无通用task面板/手机权限扩张 |
| control | reducer＋真实runtime/channel/consumer＋fake SDK wire，多/零/result前到/cancel/late/cold EOF | 0假success、0错usage/lease释放；unknown不发queued prompt；UUID/aliases/payload保留 |
| retirement | every close/reset/switch/watchdog/unload/reload/prime/command fallback path，fake childexit前/后、不同runtime/client、latefinally | R1b/资源切片全入口exit前第二CLIstart=0；old不释放new；timeout不等exit；既有门槛/candidate不变，R1a不代替此测试 |
| approval | SDK假控制请求→ordinary/Ask/Exit→UI→response；同toolUseID两attempt、abort/switch/timeout/旧card | once无字段；选定policy always deep-equal；each response≤1；取消后0updates/newUI污染 |
| command | Main hot/cold/Inline/Settings→context/catalog/store/dropdown；empty/failed/partial、不同scope、两订阅、旧finally | 假complete=0、错scope覆盖=0、chat abort=0、oldworkspace更新=0 |
| A/B回归 | 现有nativeSessionSize、Markdown诊断、historywindow/branch、model identity/order | 统计不落meta；diagnostic跨代隔离、无业务lease依赖；模型value/默认/分母不变 |

既有 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/markdownRenderDiagnostics.test.ts:702–748,902–917` 是旧manager再claim与OpenCode覆盖的当前错误期望。落地时保留因果fixture，改断言为上述正确结果；它们当前跑绿绝不算修复门关闭。

### 2. 需真实 transport/环境或明确产品裁决关闭的门

| 门 | 证据靶子 | 成本/副作用 | 当前失败结果 |
|---|---|---|---|
| G-control | 实际SDK/CLI输入dequeue、echo/queryability、assistant/stream/result/exit与native同盐join；多/零/合并通知、cancel/晚到；版本受控合同 | 正常turn可能调用模型/工具；获批sandbox、只安全工具、预算、stdout结构脱敏 | 无真实control桥/保证即No-Go新结算/Stop，不以synthetic填“实测” |
| G-run | 两真实run/resume、launch/source桥、任务terminal及sidecar final/晚flush | 后台模型/文件写、延迟/取消；要批准任务预算 | terminal可独立验；run-specific正文/工具完整hydration禁用 |
| G-exit | 实际CLI exit及cold/persistent/reset/view/plugin/reload/新registry/prime/warmup/send全部资源入口；稳定域pending跨client保留 | 关闭测试CLI/重载，可能中断测试任务；须sandbox权限，不触及其它session | R1b热交接或新runtime启动No-Go；只R1a通过不关此门，超时保持blocked |
| G-retire-effect | 实际retire对后台task生存、owned后代与native continuation的影响；不扩大原stopTask候选 | 会中断测试query/后台任务；要任务预算与明确许可 | 未证副作用不启新的自动retire/rebuild；G-exit通过不当透明恢复批准 |
| G-probe | 实际spawn→init→snapshot、取消→child/owned后代exit，MCP/hooks副作用和模型调用事实 | persistSession:false不证明免费；可能联网/auth/启动hooks/MCP/产生费用 | 无预算不启动；cleanup/finitepolicy未证不启新自动Retry |
| G-source | 实际旧SDK wire是否有commands_changed、MCP延期/prompt变化、probe vs目标入口effective集合 | 真实连接、可能认证；可无需模型但非无副作用 | 只init-observed/candidate/unknown，不标current-complete |
| G-policy | 选定always政策下真实SDK响应写建议目的地；若组织hint支持则真实受限请求 | 写独立测试权限、可能扩大许可；须独立配置目录 | 旧SDK缺bridge只验所选fallback，组织限制保持未验证 |
| G-domain | 实际App/renderer/模块reload接续、可能写者范围，初次退出与兼容恢复产物；resource/attention owner是否同域 | 关闭测试实例/重载/磁盘写；非模型成本 | fake owner证明不能替代；范围未接受/未知writer时新writer/R1b热交接No-Go，跨独立窗口去重不承诺 |
| G-hydration | 生产getter/restore/warmup/title、所有实际source/messages/shared图/cache写点；受控真实文件/DB的snapshot合同、同域A/B及source ABA | 可不用模型；独立测试文件/DB写读与故障注入，禁止活vault；本轮未运行 | 任一共享写或cache旁路未纳入版本域即shared publish No-Go；仅ticket/请求号/mtime不能关门，不宣称完整最新历史 |
| G-attention | 已证run/skip字段实际wire、terminal＋attention ACK、0result/parent不可见/重载seen路径及已选择政策；必要时受控OSattempt | run来源取证可能用模型，提示链本身可无模型；持久/重载/OS提示是独立副作用，须许可 | 没有run/稳定writer/政策或独立可见路径，不关S1提示闭环；不默认弹桌面，不以turn completion代测，不承诺跨崩溃/独立窗口exactly-once |

不从几个样本归纳任意时序保证。raw wire没有捕获条件就维持门未关闭；native transcript不是stdout替代品。明确的负结果可以终止该能力切换，不启动无限测量/启发式补丁。

### 3. 入口矩阵、可观测验收与命令

矩阵至少包含：persistent/cold/recovery×task/control/approval；user/auto/subagent×ordinary/Ask/Exit；save/startup/environment/create/update/rename/delete/legacy×record/ACK；Main hot/cold/Inline/Settings×source/error/refresh/cancel；view/tab/plugin/reload/新registry×R1a准入/R1b资源barrier；getter/title/warmup/restore×record/source/materialization/cache；completed/failed/stopped×0/多result×parent可见/卸载/关闭×skip true/false/unknown×live/reload/replay/seen。每格pass/fail/not-applicable附理由，测试数不是覆盖证明。

三处订正的观测复用现有轮转诊断和实际UI/adapter断言，不新造日志库；字段只用salted hash、revision、enum/count，禁止原始session路径、任务正文或凭证：

| 合同 | 必须可观测 | 红/绿判据与No-Go |
|---|---|---|
| R1a/R1b | 入口名、client/manager/query epoch、barrier状态、admission结果、exit evidence、实际spawn count、latefinally outcome | R1a旧域新claim/发布=0；R1b确认exit前新spawn=0。任一prime/warmup/send/reset/reload绕门、timer清barrier或新registry得空槽即No-Go |
| hydration | readId（不叫freshness）、record/source hash、expected/current binding/materialization版本、snapshot证据类、commit/cache receipt或拒绝理由 | B已commit或binding ABA后A共享写/cache操作=0；metadata lookup hydrate=0。任一写点未推进、cache早于commit、request顺序当新鲜度即No-Go；版本拒绝不宣称B最鲜 |
| task attention | run/attentionKey hash、terminal/skip分类、policyVersion/待决状态、save ACK、review revision、重投影/seen/外部attempt outcome | 已选未读策略、已证run、0result、无parentDOM仍能观察1个持久未读汇总；重复不重建义务；seen只清本run。以turn completion代替、造prompt/host done、unknownrun猜键、未批准策略直接弹桌面、把attempt当送达/崩溃exactly-once即No-Go |

attention的可见验收分别断言tab/history标记与任务摘要可达；不是仅数domain回调。跨reload以真实持久ACK后的状态重载，跨view只投影一次逻辑义务；独立renderer/窗口若无共享所有权协议，报告不在保证范围，不用mock共享App代拍。两项局部隔离验证的既有通过读数不关闭以上三门。

以下仅获准实施后执行，本轮未跑：

```bash
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run typecheck
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run lint
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run test -- --selectProjects unit --runInBand --no-cache
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run test -- --selectProjects integration --runInBand --no-cache
```

测试执行前审查所有setup/import/目录来源，确认不会写活vault/启动provider。构建另批，用非空不存在OBSIDIAN_VAULT挡`.env.local`部署；构建本身仍写仓库产物，不能叫只读：

```bash
test ! -e /tmp/claudian-compat-NONEXISTENT-vault && env OBSIDIAN_VAULT=/tmp/claudian-compat-NONEXISTENT-vault npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run build
```

每批source/SDK/实际CLI/build及fixturemanifest独立冻结、独立reviewer；高影响writer/control合同可先做独立architect只挑硬伤。回退实测必须写新header/task/attention数据、保留已写原生权限，证明兼容恢复产物不以旧snapshot损坏它们，不恢复getter隐式发布/失去hydration版本和cache合同，不清未完成资源barrier或用户未读。未关闭的source/run/control、G-domain/G-exit/G-hydration/G-attention及产品门分别列清，功能保持未启用或受限，不用全suite或两项局部隔离验证通过冒充全部已验收。

## 关联

- [[tools/claudian/docs/designs/2026-11-07-upstream-compat-stop-permissions-discovery]]
- [[tools/claudian/docs/designs/2026-11-07-upstream-compat-evidence-closure-supplement]]
- [[tools/claudian/docs/designs/2026-11-07-conversation-size-isolated-persistence-boundary]]
- [[tools/claudian/docs/designs/2026-11-07-conversation-size-contract-consolidation-restart]]
- [[tools/claudian/docs/designs/2026-11-06-markdown-render-metric-contract]]
- [[tools/claudian/CLAUDE]]
- [[tools/claudian/src/core/CLAUDE]]
- [[tools/claudian/src/providers/claude/CLAUDE]]
- [[tools/claudian/src/features/chat/CLAUDE]]
