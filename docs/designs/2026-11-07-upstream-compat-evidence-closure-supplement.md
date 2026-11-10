---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - claudian
  - upstream-compatibility
  - evidence-gate
  - lifecycle
  - permissions
---

# Stop hook → 授权语义 → 命令探测：证据闭合补充设计

## 背景与问题

原草案主方向可保留，但 result 归属、跨 run 内容、保存竞争和命令快照尚缺可执行边界；本补充将其收敛为可判定状态、显式降级与 Go/No-Go 闸门，避免按未经证实的 SDK 时序实施。

> [!warning] 独立补充，不是替代、确认或实施授权
> 路径为 `[理想]`。引用原草案 `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-07-upstream-compat-stop-permissions-discovery.md`，不修改它、不 supersede、不改变其 status。原稿与本稿须组合复核；冲突处以本稿标出的**待确认补充条款**讨论，不悄然改历史结论。
> 本轮只读源码、已安装 SDK、关联 PR 和有限原生结构样本，只新增本记录。未改代码/配置/测试/README，未 git fetch、提交、启动插件、构建、执行 SDK query 或调用模型。当前基线动态未冻结，**完整目标设计不等于当前实现可 Go**。

## 方案设计

### 1. 动态基线与证据账

#### 1.1 观察身份

- 代码根：`/Users/vincentwang/Documents/NoteVault/tools/claudian`，独立 Git 仓库。
- HEAD：`cf47730d2109e798fd27ddacc712038d26883d5b`，分支 `fix/model-identity-sorting`。2026-11-07T12:34:06Z 的工作树仍含 size/history/render/i18n 等并行修改；HEAD 不代表已读脏内容。
- `git worktree list` 本次仅列上述主工作树；不能据此判断其他顶层 session 是否活动。本轮不创建 worktree、不联系/控制其他 session、不 stash/reset/checkout 他人修改。
- 已安装 SDK 与 lockfile对应的原基线为 0.2.112；本轮重新核实 installed=0.2.112、package 声明=`^0.2.112`。不是精确 pin，不批准依赖变更。
- 实际插件 query 的 resolved CLI、内存 bundle、所有平台版本未核实。原草案的本机 CLI 2.1.311 是〔既有读数〕，不是本稿所有 query 的版本证明。

以下完整 SHA-256 为**一次只读观察凭据**，不冻结文件、不证明行为：

| 绝对路径 | SHA-256 |
|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-07-upstream-compat-stop-permissions-discovery.md` | `e5a9578d916855dae8ea42e57adb74c93e53944fc6c3333e959735310b0f9651` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts` | `931f1271728050ff0e7af351c29f0e64ce136d8710d907921822d60c8ca98e92` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkSubagentSidecar.ts` | `263bd2f9ccf117356241bda62296846805551d1b8fb6db1c513e416301328b51` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/SessionStorage.ts` | `46557760b9777ded883c98f95e52f4d2fdd7a6faa9dcded9229fd7809ac0e56f` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts` | `2609960d73330585615ccfaa2c12d1e9aaab7e70c5f9e7a23e2266b6b8ace96e` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts` | `f37dc53f94730e113a8f45773108c38d94d85f6d9d8d5f50ebf297186f5fc7c1` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` | `cb6908cb1701fc358269f0370615c9183dadfcd03dedc3060dd4bd8ef494d5b1` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` | `99c1ce89ec7c20898dba5eee12043487ed7a7ebfe44e69a6395a4fd0e0b6dd73` |

原稿两处 `runtime/MessageChannel.ts` 路径在本稿准确定位为 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeMessageChannel.ts`；不改原文。

#### 1.2 证据等级与已证事实

〔实测〕限本轮实际执行的只读核查/结构计数；〔既有读数〕所读源码、文档、PR或旧记录的陈述；〔推算〕由这些机制推出；〔纯示意〕设计测试输入。读源码不是动态行为实测，mock 不是真实 CLI 保证。

| 编号/等级 | 已证内容与位置 | 不能推出 |
|---|---|---|
| E1〔既有读数：源码〕 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts:1314–1366` 在 result owner 判定之前处理 cancel tombstone；通知 user origin 无 `shouldQuery` 判断就置 `notificationResultPending`，下一条 result 清 flag 并丢弃 | 一通知一 result；下一 result 必属通知；cancel 后任意 result 足以交接 |
| E2〔既有读数：SDK〕 | installed `sdk.d.ts:2713–2755` 的 result 有自身 uuid/session，没有输入 UUID、task run 或 assistant request 关联；`:3067–3084` 明确 `shouldQuery:false` 只记 transcript，合并到后续 queryable user | result.uuid=输入身份；user echo 自身就是执行边界 |
| E3〔既有读数：源码〕 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptTurnMapper.ts:126–152` 排除 false/replay/sidechain；`ClaudeMessageChannel.ts:363–409` 有真实 dequeue canonical UUID/aliases，但 text 重建消息只输出有限字段；`ClaudeUserMessageFactory.ts:31–88` persistent 工厂发 UUID，cold string/图片 generator 没有同一 UUID合同 | 现有 coordinator 已权威；冷热输入身份已经一致 |
| E4〔既有读数：源码〕 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkSubagentSidecar.ts:201–271` 按 session+agentId 全文件读；`:219–235` 按 type+toolUseId 去重；runtime `:560–571` 每次取 mutable session；`sdkMessageParsing.ts:287–319` 裸 taskId 后值覆盖，缺 result 丢掉；`sdkAsyncSubagent.ts:52–90` queue 状态默认 completed且缺 killed/stopped 精确语义 | 冻结 callback 后文件内容便属该 run；缺正文=无终态；launch 工具 completed=后台 run completed |
| E5〔既有读数：源码〕 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/SessionStorage.ts:39–45` 先序列化后排队写；`:49–80` size overlay 在队内读旧 metadata 再写；`main.ts:778–788` 顶层 Object.assign；Controller `:1277–1279` 非 READY直接 return | 已有 CAS；串行旧快照不会覆盖新数据；void 返回代表保存成功 |
| E6〔实测：installed文本核查〕 | `sdk.mjs` 的实际实现为 `async supportedCommands(){return(await this.initialization).commands}`；`commands_changed` 与 `suppressAlwaysAllowRule` 字符串均为0处；can_use_tool 桥明确列举 signal/suggestions/toolUseID 等，不透传 suppression | 再调一次 supportedCommands 会热刷新；给 TypeScript 加字段即可修桥 |
| E7〔既有读数：源码〕 | `ClaudeApprovalHandler.ts:112–133` 普通 approval 只传 reason/path/agent，未传 signal/toolUseID；InputController `:1684–1690` 给普通 approval 的 question 传 undefined signal；只有 AskUserQuestion 的 auto 路径走现有5分钟 race | 普通 approval 已有相同超时/取消链 |
| E8〔既有读数：源码〕 | probe 没有 additionalDirectories、tab启用 MCP、显式 plugin选项；cold chat builder `:186–220` 传 MCP union/禁用工具/additionalDirectories；TabManager `:1083–1104` 可借同 provider另一 tab 列表；workspace registry clear只清引用，setServices/initialize可覆盖旧服务；`main.ts:259–268` unload只存tabstate | 同provider即同上下文；清 registry=关闭 catalog/probe；菜单可重启热聊天 |
| E9〔既有读数：官方文档〕 | Context7 官方 TypeScript 页明确：动态 supportedCommands/commands_changed需 SDK≥0.3.216；MCP prompts变化推送需 CLI≥2.1.281；suppression需 TS SDK≥0.3.268；task run_id/origin.runId需 SDK≥0.3.292 | 这些阈值自动证明当前0.2.112 wire和CLI行为；升级无需另批 |

**有限原生样本〔实测：只读结构计数〕**：从最近4份插件 meta关联的4个 native transcript各读最后至多1 MiB，222条 assistant均带 parentUuid；21条 notification user均带 origin.runId/parentUuid，21条均缺 shouldQuery。其关联目录最近4份 sidecar各读最后至多256 KiB，157条 user/assistant均带 uuid/parentUuid/sessionId/agentId，0条带 run_id/runId/sourceToolUseID。只输出计数，未导出ID/正文/凭证。

这证明**这些样本存在父链和通知run字段，但缺直接sidecar run标签**；不证明父链必可绑定launch、不证明样本覆盖全部run、不证明stdout字段透传、不证明shouldQuery缺省的真实求值，更不证明bare result owner。窗口首条不完整行丢弃，非全量覆盖率。

#### 1.3 关联 PR 的真实适用范围

本轮 `gh pr view` 与选定 `gh api .../pulls/.../files` 只读核查，不更新任何 Git ref。

| PR | 可复用的正向能力 | 不能当作证明/不能整包摘取 |
|---|---|---|
| [#936](https://github.com/YishenTu/claudian/pull/936)，merge `852b970826c606aa674bf3ec03c1b6ba2d38012c` | task_notification→插件可await接收、提前终态、background work drain、去插件Stop | PR里的 callback 是插件API，不是SDK新增callback。sourceQuery guard只证明接收来源；未解决本地bare result、内容跨run、旧快照合并；旧usage/window逻辑不搬 |
| [#1493](https://github.com/YishenTu/claudian/pull/1493)，merge `552ecf8f4c43b5c6d5eff5cb5201f8ba6053d32f` | once不写规则；always原样传suggestions，无建议不造规则 | 不能证明旧SDK的组织suppression可用 |
| [#1551](https://github.com/YishenTu/claudian/pull/1551)，merge `7c41ac0e798125186474ce315f2bcac80185cf10` | 同一 canPersist 值控制选项/响应，陈旧always降为once | SDK升级0.3.293是该PR的一部分，不获批就不能摘为当前能力。PR明确未做认证live smoke |
| [#1359](https://github.com/YishenTu/claudian/pull/1359)，merge `f1328f3e8e742aae2e1583741f15a5313df7eb31` | EOF/SDK失败显式报错、finally取消、全入口deadline工厂、十语言user source说明 | 30s/5s是上游政策，不是本地测量；上游明确未验证慢MCP prompts热补全，不能承诺。其shared store本地尚不存在 |

### 2. 解层次与目标边界

1. **task terminal、assistant内容归属、result控制归属、query可安全交接是四个不同判定。** 不再通过“跳过几个result”解决不可识别身份。某次内容可确定属于H，并不证明某个bare result也属H；H内容完成也不等于CLI已可接受下一输入。
2. **run来源与接收资格分离。** session/query epoch只防迟到回调，不能证明所读文件哪段内容属于run。内容不明时保留已证terminal和summary，停止自动补全，而非将整个sidecar强塞进去。
3. **保存排队对象是业务意图，不是过期全量快照。** 复用已有meta/subagentData、序列化入口和队列概念，补单写者所有权与最新状态归约，不新建第二业务数据库。
4. **目录快照的有效范围由来源证明，revision仅表示本地发布次序。** 旧SDK可正确展示“会话初始化观测”，但不能包装为“当前完整会话目录”。菜单失败不是理由去关闭MCP或重启聊天。

### 3. S1-A：turn owner 求值与控制交接

#### 3.1 备选/推荐

| 方案 | 收益 | 根本限制 | 裁定 |
|---|---|---|---|
| bool改counter、按最近echo/最后输入顺序分配 | 局部易写 | false、合并、零/多个result均无身份保证；取消同样误交接 | 不选 |
| 直接把现有transcript coordinator变权威、全靠父链 | 已有UUID/observer可复用 | 父链主要约束内容；bare result无父链。当前observe-only未证闭环 | 不直接选 |
| **窄ownership reducer：内容证据关联 + result契约能力 + 独立query交接栅栏** | 不可判别显式隔离；复用输入工厂、canonical registry、observer、QueryScope、retirement | 当前真实wire契约尚缺，S1切换必须No-Go；不是以降级宣称根治 | **推荐目标** |

新增纯provider ownership reducer，复用 `ClaudeTurnReconciliationCoordinator` 的canonical/alias事实，不在原observe-only旁路上偷换settlement权限。若证据要求改其权威模式，须单独冻结边界并经本稿复核，不实施全量turn系统重写。

#### 3.2 身份、状态、证据

- Host owner：`conversation record handle + providerSessionId + canonical input UUID`，host aliases指向同一owner；队列owner仅在**真实dequeue**变 dispatched。
- Notification continuation owner：已验证的queryable user UUID，task/run为来源关联，不以task terminal事件创建turn。
- SDK assistant uuid仅标消息；assistant.message.id标模型request实例；二者不直接等于input UUID。仅同session/branch的native父链与已验证UUIDjoin，可将assistant/request归给owner。
- SDK result.uuid只用于该渠道消息去重；session_id只作范围校验。num_turns、文本相同、usage、耗时、run_id猜测、时间邻近都不能作输入owner证据。
- 本地运行资格：workspaceEpoch、runtimeInstance、conversationHandle、sessionGeneration、queryEpoch。持久input/run身份不包含queryEpoch；重启不得制造同一业务对象的新身份。
- Owner阶段：`reserved → dispatched → observed → active → terminal-candidate → completed`；中途可 `cancelled / interrupted / conflicted`。这里只描述产品轮，不代表query槽已释放。
- Query栅栏：`open / attribution-blocked / interrupting / retiring / exited / recovery-blocked`。completed/cancelled owner仍可处于blocked；未证CLI交接不得 `completeTurn()` 派发队列。
- 归属值：`bound(owner,evidenceRef) / unresolved(candidates,reason) / duplicate / stale / conflict`。无证据不是默认host。
- `TerminalEvidence`记录content-terminal与control-result分别的sourceRef；usage未知/合并范围未知时标unattributed，不投影到host费用/成功统计。

#### 3.3 固定求值顺序

所有入口先走同一窄适配器：**资格/身份 → replay/去重 → task状态事实 → user queryability/assistant关联 → result owner → cancel栅栏 → 投影/结算/队列交接**。

current `routeMessage` 在owner前解cancel tombstone的顺序必须改；cold loop也必须走相同判定，不能在finally/EOF无条件标成功。`done`若只是generator结束，不能再被消费者当成功信号，须用已有metadata或中立结果契约显式携带 `completed/cancelled/failed/recovery-needed`。

`shouldQuery`严格三值：false=非queryable；true=可query候选，**不证明已开始独立轮**；absent=legacy未明，只有冻结版本缺省证据或已验证执行父链后可升级，不能只凭origin分类。对于本地新发host可显式true，必须验证SDK/CLI兼容，并让 `ClaudeMessageChannel.pendingToMessage` 保留身份/语义字段；不得修改priority来逼出未经验证的序列。

#### 3.4 输入/echo/notification完整求值表

下表为〔纯示意：设计语义〕；所有“已验证”都指G1得到的真实证据，不是mock自证。

| 输入事件/当前状态 | owner求值 | 状态与副作用 | 禁止 |
|---|---|---|---|
| host reserve尚未dequeue | reserved candidate | 不接正文、不结算；取消只移未发队列 | 把reserve算CLI执行 |
| host真实dequeue UUID=H，aliases=H1/H2 | dispatched H | 注册canonical及实际payload；aliases共用结果 | 每个alias造独立CLI轮 |
| 相同H的普通user echo，true | observed H | 幂等bind，不新开轮 | echo次数作result配额 |
| 相同H echo缺shouldQuery | legacy证据核对 | 若G1证明该入口缺省queryable则observed，否则unresolved | 用typed可选字段推断全部CLI版本 |
| 相同UUID在不同owner/session重绑；或与已发host payload/queryability冲突 | conflict | 阻止继续分配，保留诊断 | UUID相同就吞冲突 |
| user `isReplay:true`、sidechain、tool_result-only | 非新轮 | 只入对应历史/子调用渠道；不加result义务 | 重放重复开轮 |
| queue enqueue/task_notification/system task_updated | task事实，不是turn | 归约任务；host轮/lease不动 | task完成即host done |
| notification user，false | 非queryable机制行 | 任务事实保留；可作为后续输入的上下文附件，owner不切换 | 置skip flag/等一个result |
| notification user，true，无host竞争 | continuation candidate N | 等真实assistant关联后active N；auto由已有observer投影 | 用户echo即auto已运行 |
| notification user，true，host H仍执行 | H/N候选竞争 | 内容逐request关联；没有新证据的chunk隔离，query attribution-blocked | “紧跟N所以result属N” |
| notification user，absent | legacy queryability unknown | 不加结果计数；验证父链/冻结缺省后再分类 | 默认一个新result |
| 多个notification，带不同UUID但相同task/run | 多个delivery候选 | delivery去重按消息身份；task terminal幂等另算 | 按taskId吞掉真实不同投递 |
| 同notification重复echo | duplicate（渠道+session+uuid+payload核对） | 0次再开户/终态；payload冲突转conflict | 每重复追加一个skip |
| host输入含前面false通知合并内容 | 真实dequeue H为owner | false行不是另一个owner；实际payload hash仅核对，不用于猜身份 | 按文本片段拆result |
| queued host文本合并/附件替换 | canonical H + aliases | 复用工厂和channel首UUID；最终payload与字段在dequeue记录 | 替换payload时换canonical |
| origin=peer/channel/coordinator/其他新origin | 独立分类，沿用已证observer范围 | 不冒充task；未知origin保留机制/unknown | 硬塞host/notification类别 |

#### 3.5 assistant/result/取消/错序状态转移表

| 事件/条件 | 归属与转移 | 可结算/交接条件 |
|---|---|---|
| 子agent assistant/stream，parent_tool_use_id非null | 给已验证子调用/run内容渠道 | 不计host usage、不释放host |
| 主assistant A可用UUIDjoin+native父链证明属H | bound H；H active，保存request关联 | 内容可投影H；尚不证明任意result属H |
| stream仅有request实例但尚未绑定H/N | unresolved暂存，按request分组 | bounded缓冲；关联补到再回放，溢出改transcript重建，不全量内存累积 |
| A先于input echo；稍后父链/echo补齐 | 先待账、后bound | 不按arrival强行归最近输入 |
| assistant end_turn | 对其已绑定owner标terminal-candidate | 沿用quiet-settle/强continuation撤销；不能把end_turn当query result |
| result同session、唯一dispatched候选 | 仍须G1证明该入口的control result契约 | 仅“候选只有一个”不够：历史/通知残留结果仍可能迟到 |
| result可通过冻结版本契约或实际额外wire关联唯一绑定H | 记录control-terminal；成功/错误按原result值，不把success且is_error误作成功 | owner结算一次；CLI交接须同一控制契约允许且无未明前驱 |
| result唯一绑定N | N结算；H不变 | 不写H usage；N结束不能代H completeTurn |
| 2通知+1 result、或多输入合并result，无真实合并成员证据 | unresolved范围 | 不给result平均拆usage、不跳过N次；归属冻结/恢复 |
| 1输入产生多个不同result | 每个独立去重、按真实边界分类 | 无subresult/final契约时第二个=冲突/未明，不假设首个或末个最终 |
| 同uuid+同payload result重复 | duplicate | 0次重复settle/lease release/save；异payload conflict |
| 零result/EOF/consumer异常 | 不等于completed | 已绑定内容保留；错误/中断或recovery-needed，队列不进入可能存活旧CLI |
| result先于assistant terminal/echo | 暂存待账；不回填result.uuid到input | 后续足够证据可结算；没有则blocked |
| 旧session/retired query result或chunk | stale | 0新域更新，不解新域cancel tombstone |
| host已cancel，收到未明或N的result | H cancelled，cancel fence保持 | 不派发队列；不会复活H或标success |
| host已cancel，收到**绑定H** control terminal | H仍cancelled，只确认旧CLI轮边界 | 合法解除H tombstone一次，且再次校验queryScope |
| interrupt ACK仅表示请求收到；Stop task ACK | 不作owner成功或无后台任务证明 | 查询真实终止/原门控证据；stopTask候选保持原限制 |
| terminal-candidate之后新request/Stop block强续接 | 只对同owner撤销候选 | 若旧成功已对外发布，不能静默回改；G1必须证实发布点避免该情况 |
| 主content terminal可证、bare result不可证 | 内容可显示已结束，控制归属unknown | 不显示“成功已确认”；无安全交接证据不发队列 |

**状态表的“unknown”是完整定义的失败分支，不是完整识别能力。当前缺真实control契约，所有依赖该契约的Go格子尚为No-Go。**

#### 3.6 无法判别时恢复

1. 保留已接受的任务事实/已绑定内容；未知result、chunk写脱敏诊断，不生成新的SDK prompt补通知。
2. 停止本query新的host派发，旧已发输入标 `recovery-needed`；尚未发队列保持canonical UUID、aliases、最终payload。不给用户假success。
3. 复用现有transcript observer/受预算索引做有限对账，不循环等待任意历史全量读；pending缓冲达到预算或用户取消时升级为明确恢复失败。
4. 只有原watchdog门控证据满足且**query-scoped retirement对后台任务影响被实证可接受**，才复用interrupt→真实CLI exit→新query。不能靠timer到期假exit，不能仅让Promise race超时就释放槽；exit未确认=`recovery-blocked`，禁止第二CLI占同聊天槽。
5. 新query只恢复未发队列。已发输入可能已执行工具，**不自动重发**；复用现有crash replay仅在原“未见任何chunk等”条件仍经过工具副作用证据审查后使用，不能把它扩成通用模糊owner恢复。
6. 后台任务若随retire被杀、独立后代无法归属或会丢native continuation，本自动恢复分支No-Go；可用“冻结派发+显式用户重建/重新核对”降级，不承诺透明继续。去Stop切换本身须等G1/G2/G3全过。

### 4. S1-B：task/run、历史重放、sidecar内容来源

#### 4.1 备选/推荐

| 方案 | 优缺点 | 结论 |
|---|---|---|
| 给所有回调加session/query epoch，继续全文件sidecar | 能挡跨tab回调；挡不住同agent复用文件的前run内容 | 不选 |
| 依赖全部事件必有run_id，或直接升级最新SDK | 目标API较丰富；当前不成立，升级另批，旧恢复仍可能缺run | 不作唯一解 |
| **统一任务归约 + 真实run/launch证据 + run分段内容reader，未知降级** | 能复用现有销账/subagentData/branch/index；不伪造run、不猜内容 | **推荐** |

#### 4.2 持久身份与来源合同

- 真实run键：`conversation record identity + providerSessionId + taskId + providerRunId`；runId视为opaque，仅在已验证该版本合同允许时作排序。官方最新lexical次序不能默认用于当前额外字段。
- 兼容occurrence键：同session/branch的**实际launch tool-use与source row UUID**。字段命名为 `launchRef/compatOccurrence`，不是生成UUID冒充providerRunId。记录不足不能生成“看似精确”的run键。
- toolUseId、taskId、agentId三者是不同namespace。只有launch结构化返回/已证task_started.tool_use_id/可靠source join才能建别名；不能沿用 `agentId=task-id` 普遍假设。
- 缺run的事件只有在**该session/关联证据下所有可匹配历史occurrence唯一**时绑定；不是“当前只有一个running就唯一”。R1已terminal、R2running仍有R1晚消息可能。
- generic Bash/Monitor/workflow task保留provider task事实；没有Agent/Task launch证明，不创建SubagentInfo卡片，不加入running-subagent watchdog候选。
- 在既有 `ClaudeProviderState.subagentData` 内版本化扩展run记录/证据字段；map key为recordKey，UI锚点另存parentToolUseId。保留旧id展示语义，consumer不能把map key当工具id。同parent多run通过显式run关联投影，不让后run覆盖前run记录。
- 旧schema可读，缺run条目为compat/unverified；仅实际可证launch可懒归一化。不得清理未知providerState字段、批量把旧running“修正”为completed。
- reducer统一处理live、history、early-terminal、recovery；manager各索引/DOM仅为同一record的派生映射，持久化不是第二套终态规则。

#### 4.3 输入归一化与终态优先级

| 原始事实 | canonical含义 | 求值/恢复规则 |
|---|---|---|
| task_started/task_progress | launch/progress候选 | 校验session/run、可选tool-use；task_type决定subagent关联资格 |
| task_updated.patch无status | 仅patch字段变化 | 白名单merge已给字段；缺字段不清旧值；error文本本身不等于failed |
| patch.status pending/running | 非terminal | pending→running可推进；已有native terminal不能复活。若有真实新run，开新record |
| patch.status completed/failed/killed | terminal事实 | 即使没有result也销账；killed规范为stopped，原始词保留 |
| task_notification completed/failed/stopped | terminal事实+summary/output pointer | status独立于summary是否空；summary级内容不冒充最终正文 |
| queue XML completed/failed/killed/stopped，无result标签 | 兼容terminal事实 | status必须显式有效；缺result不丢terminal、不默认completed |
| queue XML只有result，无status | 内容提示，terminal unknown | 不沿用history默认completed；待其他事实确认 |
| user origin notification runId | delivery与run关联 | 仅payload里确有task/status或可join已有事实才补terminal；origin本身不是completion |
| launch工具 completed但payload isAsync/async_launched | launch已返回，run running | 修正sdkAsyncSubagent fallback，不能与task done混淆 |
| launch工具失败+明确start失败 | launchFailed | 不再等待后台run；如后到native start/terminal矛盾则conflict |
| TaskOutput等取结果 completed/success | 依其真实合同为completion候选 | 只有run绑定+retrieval合同证明才terminal；普通tool result status不是通用terminal |
| 本地switch/reset/orphanAllActive | 接收/投影detach或liveness unknown | 不是native failed/stopped；不因看不见UI就说后台已死 |
| 真正query exit但后台存活不明 | orphaned/unknown-liveness证据 | 停live接收资格，不覆盖已知native terminal |

终态字段分两轴：`providerTerminal=completed/failed/stopped/unknown`；`localAttachment=attached/detached/orphaned`。中立旧UI可把failed/stopped显示error，但必须保留canonical语义，恢复不能从UI error反推failed。

| 已存事实 + 新事实 | reducer结果/优先级 |
|---|---|
| early native terminal，稍后同run launch/progress | 消费早终态，补launch/内容；1次terminal，0次复活 |
| 同run同terminal重复，stream/transcript各一份 | 合并sourceRef、补metadata；不重复completedAt，不重复通知。跨渠道无同event UUID时按record+相同语义幂等，不伪造消息同一性 |
| 本地orphan + 已验证native terminal（历史或恢复） | native terminal优先；local仍可detached。允许把unknown历史补为事实，不改其他run |
| native terminal + 晚pending/running patch | 保留terminal，记晚进度；不能覆盖 |
| verified R1 terminal + verified R2 start | 两个record，R1保存、R2running；不在R1上写running |
| run缺失，R1/R2均可匹配 | ambiguous事实待账；任何一个都不销错 |
| 同run completed与failed/stopped冲突 | terminal-conflict；活动计数不复活，但不发布确定成功。除非实际provider合同有明确纠正/revision顺序，否则不按渠道等级或arrival选胜者 |
| sidecar正文存在 + native terminal缺失 | 内容不能制造completion；只有经过验证的sidecar terminal合同才可增加terminal事实 |

native terminal高于**本地推断的orphan**；两个相互冲突的native terminal没有凭空固定胜者。`output_file`只作证据线索，未验证路径及run来源前不读取。

#### 4.4 历史重放归一化

1. 复用现有分segment的branch过滤、committed byte边界、预算索引；持久身份至少带segment的providerSessionId。`previousProviderSessionIds`不是把所有裸taskId放一张map的许可。
2. 先取所需branch内结构事实：launch/tool-use→结构化launch结果→task事件/delivery；即使projectionKind=skip，也不能丢任务状态关联。保留实际row UUID/offset/branch/snapshotRef，不用timestamp兜底当因果序。
3. 归一化与live调用同一reducer，替换 `collectAsyncSubagentResults(): Map<bare taskId,...>` 的逻辑消费合同；不新增全量历史加载路径。window/detail的associationEntries必须从同一snapshot提取，不能用当前另一个读数补父链。
4. 缺状态/结果分别记unknown/missing，killed/stopped不再落running或默认completed。replay不启SDK prompt、不给当前运行任务live资格、不重复成功通知。
5. fork/resume：只带源snapshot已覆盖的历史事实；源仍running不成为目标conversation当前running。已证同provider run可保留只读provenance，目标接收资格另发，不借session链合并跨branch裸ID。
6. schema迁移和重放对同对象的红绿判据是**recordKey、providerTerminal、来源、正文范围相同**；不能只比较UI“已完成”文字。

#### 4.5 sidecar来源证明与降级

reader输入必须包含：固定vault realpath、providerSessionId、agentId、recordKey、providerRunId或launchRef、branch/snapshotRef、预期run段sourceRef，以及独立的commit资格handle。不得只收agentId再读mutable当前session。

| 来源边界 | 可验证方法 | 许可范围 |
|---|---|---|
| 行显式run标签 | 守卫字段、对拍launch和原生task run，SDK/CLI版本合同冻结 | 仅该run行；同agent其他run排除 |
| 无run标签但父链可达被验证launch/恢复root | 比较真实UUID/parent graph与launch root，验证跨文件桥字段/重启行为；相同session/agent只作必要条件 | 可证图分量/段，不是整文件 |
| 经实证的专属output_file | realpath/受信根/类型/来源关联、确认每run唯一与最终输出语义；引用不能来自自由文本 | 只读该来源已证明的完整范围 |
| 实际launch前后byte栅栏 | 仅在证明该file在此区间无其他run/既有记录并发写、flush可界定时可用 | 条件性优化，不默认兜底；晚flush反例会使其No-Go |
| 只有session+agentId路径/mtime/固定callback | 不能证明run归属 | **No-Go自动hydration**；显示summary，content=unverified/missing，保留人工重试入口 |

当前本轮sidecar样本没有直接run字段；父链跨文件bridge尚未实证，故**run-specific自动正文/工具明细补全No-Go**。这不阻止已证task terminal保存，也不把内容不明伪装为reader空成功。

- 稳定读取：只解析同一次已确认file identity下的committed完整行；半行/文件替换/截断返回retryable或source-changed，不能JSON跳行后称complete。借现有tail/index模式，不以“两次mtime相同”证明完整。
- 工具内容按 `(recordKey,toolUseId,event/sourceRevision)` 合并；不能跨run仅按toolUseId首次胜出。未绑定的orphan tool_result留待账，不静默丢掉影响完整性。
- 最终正文必须有**该run final输出合同**；`extractFinalResultFromSubagentJsonl`取最新assistant文本不足。terminal先来、sidecar只刷出进度时保持content=pending；stopped/failed可以有已证partial正文，不强求completed式final。
- 独立状态：`content=unverified/pending/partial/ready/retryable/failed` 与 `persistence=dirty/written/skipped/failed/conflict`；ready必须来源和final范围都可证，空正文亦可ready（有final证据）。
- poll slot按recordKey而非agentId；run重启换slot，running只补工具，terminal才尝试final。每次await后的commit检验run来源与记录handle；detach仍可完成已接受旧record保存，不碰新DOM。
- orphan不自动禁止所有历史内容恢复：live poll取消，后续用户history/recovery调用可读旧record已证来源。native terminal可补orphan，但不得把其run的live接收资格恢复。

### 5. S1-C：最新状态原子合并与保存结果

#### 5.1 备选/推荐及保证范围

| 机制 | 正向适用 | 限制/结论 |
|---|---|---|
| 扩现有writeTails，只延迟JSON.stringify | 可减小旧序列化窗口 | 上游已将旧providerState算好，仍覆写；SessionStorage实例重建还断队列，不选 |
| 文件CAS/事务数据库 | 可处理多writer和外部改文件 | 当前adapter无CAS；check-then-write不是CAS。引入新依赖/多进程锁非当前事实，不暗自选 |
| **同vault单业务写者 + typed mutation + 队内最新状态reducer** | 直接覆盖本地所有保存入口，复用metadata存储 | **推荐**；同renderer受控writer的逻辑原子合并，不承诺disk/fsync或跨进程原子性 |

单写者所有者放app workspace生命周期，不依附可被 `loadSettings()` 重建的 `SharedStorageService/SessionStorage` 实例。core提供provider-neutral序列化/提交合同，Claude注入纯task merge；不引入通用数据库框架。

最新状态含**当前已确认持久record + 本lane已接受未提交意图**。业务顺序由实际admission ticket确定；异步callback必须在注册/第一次await之前捕获原record handle，不能完成时按ID换绑新对象。

参考相邻draft `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-07-conversation-size-isolated-persistence-boundary.md` 的originalObject/incarnation/recordToken、原删除语义、业务/统计分域是候选复用能力，**不是已实现或已获批**。不得自建第二套相互冲突record token。

#### 5.2 目标mutation与ACK合同

不再接受后台 `Partial<Conversation>{providerState:旧全量对象}`。目标意图至少为：

| 意图 | 入参/求值方式 | 字段权限 |
|---|---|---|
| `createRecord` | 独立创建动作，新handle；同ID重建须等旧delete barrier结束 | 只有create能创建meta |
| `patchMetadata` | 原handle+明确field mask+值；保留最新其它字段 | title/preview/context等白名单；undefined仅explicit-clear才删除 |
| `mergeTaskFact` | 原handle+recordKey+normalized fact/sourceRef；queue执行时对最新subagentData归约 | 不替换整个providerState，不依赖当前window/READY |
| `mergeTaskContent` | 原handle+run来源proof+内容revision | 只改同run已证内容/截断元数据，不改providerTerminal |
| `updateSessionBinding/rewind/fork` | 业务handle+显式session/branch mutation；来源变化需原身份验证 | 不让旧runtime快照回滚新session/size fence |
| `deleteRecord` | 原handle+完整生命周期barrier | 退役旧admission，执行原provider删除→metadata删除；失败仍显式失败 |
| `migrateLegacy` | 在lane内读最新preferred/legacy，非先读raw后重写 | 当前preferred若已存在不得覆盖；内部不得同ID再enqueue自等待 |
| size候选 | 使用最终获批size协议的独立reader/writer与内存发布接口 | task writer不写/清sizeSnapshot或受保护sizePersistence |

ACK 为显式判别联合：

- `written`：该ticket的业务写与原合同要求的legacy清理均真实resolve；含handle/ticket/confirmed revision。不是只“已入队”，不是保证突然断电也已fsync。
- `skipped`：明确 `stale-origin/deleted/not-ready-shell/no-op/missing-record` 等理由；no-op附当前已确认版本可供重复事件复用，但不能报“本次写了”。
- `failed`：stage=`read/decode/reduce/write/legacy-cleanup/delete` 与可重试性；保留dirty/uncertain，不把抛错转空成功。
- `conflict`：record身份/业务session/同run证据矛盾，或发现不受控writer；停止该危险覆盖，等待对账。冲突不是新建或全量快照重试许可。

`ConversationController.save` 的empty/non-READY return改为typed skipped；只在written或可证no-op/已保存重复时清相应dirty ticket。非READY只禁止**壳UI全量同步**，不能阻断已持原handle的task事实mutation。

#### 5.3 原子合并步骤

1. app同步检查originalObject/不复用incarnation和准入状态，分配ticket；捕获**最小不可变delta**，不冻结旧全量Conversation。
2. per `(vault,id)` 业务lane执行时复验ticket所属record。读最近确认state；首读/uncertain/迁移读磁盘最新record并验证身份。所有读后可能写的业务入口也进lane。
3. 用同一reducer按ticket顺序将delta归约到最新state；保留未知providerState字段和最新protected record/size头。task merge按run/证据幂等；不用generic deepMerge拼终态。
4. 在lane内序列化本次归约结果并写meta。执行期间禁止另一个业务写者/实例写相同路径；任何“直接storage save”必须改成委托typed intent，不能留旁路。
5. 写真实成功才发布ACK和持久base；内存投影从新base+尚未提交意图重算，旧ACK不覆盖已接受后续terminal/size内存值。领域事实可先显示dirty，但不能宣称saved。
6. I/O失败可能已部分落盘。下个mutation先做有序恢复读/校验；损坏或身份不明则failed/conflict，不用内存旧快照覆写救场。重试同一事实幂等；不追认原失败ACK为written。

逻辑原子性来自**唯一写权限+同lane read/reduce/write**，不是现有CAS。当前 `VaultFileAdapter.write/rename` 未证原子替换/fsync，不能作磁盘crash-atomic承诺；若验收要求此性质，须另做adapter/平台能力闸门，未证No-Go。

同realm服务重建必须保留业务lane/handles直到所有旧I/Osettle；不能超时后新建同域writer。发现外部进程/同步插件写同文件，只有检测不足以防TOCTOU：本协议多writer保证No-Go，需用户选择单writer范围或另立可证互斥方案。

#### 5.4 生命周期与size接线表

| 流程 | 顺序/许可 | 保存结果与边界 |
|---|---|---|
| host普通save | 同步捕获handle；壳READY后产生显式delta→lane | typed ACK；不能将当前window当全history |
| background terminal，parent已卸载/非READY | 已接受旧handle事实→mergeTaskFact→ACK；无需UIsave | 可written；shell save仍skipped，不能同称失败 |
| switch C1→C2 | 关闭C1新live接收；detach UI；已接受C1短任务意图排队/drain；释放projection后绑定C2 | 长sidecar不占switch/SDKconsumer；迟到旧事实只能合法写C1，不回查currentId |
| 正常close/shutdown | 同步停止新准入/取消pending审批与probe；drain已接受业务ticket；保存tabstate；dispose服务 | 有限UI等待≠取消I/O；timeout标未确认，底层lane保留所有权，不能新writer越过 |
| 急杀进程/磁盘满 | 无ACK就未确认；下次启动按真实native事实重放 | 不承诺最后未写意图无损，不虚构exactly-once投递 |
| delete C1 | 捕获原handle；立即禁止旧新admission；先前accepted ticket依序完成；原provider删除与metadata删除成为同ID barrier | 删除后旧callback skipped；delete失败不称成功，保持retired/uncertain供显式恢复 |
| 删除后UI复位 | 仅核对仍绑定**原handle**的tab执行专用resetAfterDelete，不保存被删C1 | 保留普通createNew先保存行为；旧reset/finally不能cleanup新tab runtime |
| 同ID再次create | 旧delete实际结束/结果处理后显式新create，发新handle | ID相同≠同record；迟到旧write/delete不碰新record |
| loadSettings/服务替换 | Storage facade替换前接入同app业务owner；旧pending lane不失联 | 不因新SessionStorage实例丢单写者资格 |
| native transcript/历史index | provider仍独立拥有；task只读关联/写metadata | task保存不全量重算size/history |
| size最终走独立sidecar | task保持最新record/sizeFence；history/session变更按size协议显式失效 | task纯terminal不虚构history变化；size ACK不回写旧整个Conversation |
| size仍overlay共meta | 至少改成同业务owner中的latest-field mutation，防覆写 | 永久pending统计阻塞业务的理想非阻塞仍不成立；若要求该性质，此配置**No-Go**，不能本稿暗自批准size迁移 |

**当前size方案尚draft，接线门槛G3未过。** 最终批准的size contract决定受保护字段和invalidate矩阵；任务改造不得顺手删除inline size、迁移统计地址或重新定义计数。兼容接线必须同时过“两方向竞争对拍+统计永久pending不阻业务”所对应的最终要求。

### 6. S2：一次/记忆授权与单次结算

#### 6.1 纠偏、备选/推荐

普通approval当前不传signal/toolUseID，也没有AskUserQuestion同样的auto timeout。不能引用原稿“取消/auto超时”一句就当已接线。

| 旧SDK缺suppression时的政策 | 能解决什么 | 风险/用户裁决 |
|---|---|---|
| 只提供once | 规避新持久授权，不依赖丢失hint | 降低记忆能力；**推荐候选，但未裁决，不提前启用** |
| 接受兼容边界，有建议即允许原生always | 修复造规则/目的地覆盖，保留记忆 | 组织suppression可能被忽略；须用户明确接受，不写成安全保证 |
| 另批SDK升级并验证新桥/组织请求 | 目标可具备真实政策hint | 迁移/API/平台包回归另案；本轮不升级 |

明确：旧桥unsupported只证明“插件不能执行新的hint限制”，不证明官方必然要求once-only。未裁决前该行为切换No-Go，现有缺陷不因设计默认而被修改。原记录的“默认已选”不在本稿继承为用户裁决。

响应保持原草案方向：once无updatedPermissions字段；eligible always整数组suggestions原样透传，不换destination、不筛规则、不补规则；none/empty/suppressed下陈旧always降once。ExitPlanMode明示session setMode单独保留。既有权限文件不自动清理。

#### 6.2 单一请求结算合同

优先复用已有ApprovalCallbackOptions/decisionOptions、InlineAskUserQuestion resolved guard及现有timeout，但**resolved guard只管卡片，不是整个请求身份保证**。

- 每次真实canUseTool callback建request handle：workspace/runtime/queryScope、conversationHandle、固定owner/turnKind、toolUseID、agentID、local request token。0.2.112未给callback暴露control request_id，local token不可命名为SDK requestId；toolUseID也不够区分不同询问尝试。
- ordinary approval把signal/toolUseID/handle/decisionOptions接入InputController；Ask与ExitPlanMode同样带handle。UI持自身inline实例和pending handle，不以mutable `pendingAskInline`取消另一个新请求。
- 注册前已aborted/retired直接cancel；注册后SDK signal、runtime cancel、switch/delete/unload共用settleOnce。监听/计时器finally清理；已settled旧卡片回调不能清空新卡片引用或恢复新tab input。
- auto turnKind在请求发生时固定；子agent request继承该query/owner，不按agentID或当前activeTab猜user/auto。owner未知则不能默认为attended user，先显式恢复/审批不可用。
- 建议复用现有auto ask **300000ms（5分钟）**政策作为auto普通approval/ExitPlanMode的统一上限，user普通approval保持等待且可取消。这是**新增适用范围推荐**，不是现状，需用户确认；不把发现probe timeout同此混用。手机relay仍仅原Ask合同，不顺手开放远程普通权限审批。

| 请求状态/事件 | 一次性转移 | 返回/清理 |
|---|---|---|
| pending，用户once/always/deny | settled(decision)，冻结eligibility+suggestions；最终同步检验handle/signal | 生成一次PermissionResult；always仍经过同门槛 |
| pending，SDK abort/runtime cancel/switch/delete/unload | settled(cancel) | deny+interrupt（原Ask/Exit语义保留），清自己listener/timer/card |
| pending，auto到300000ms未答 | settled(timeout) | deny+interrupt，visible timeout一次，旧response不能之后allow |
| pending，UI render/reject/error | settled(failed) | 结构化失败/deny，不能卡住callback或写规则 |
| 答案与abort/timeout同tick | 同一settleOnce先事件胜；return前signal/资格再核 | 若取消已生效，不能发持久更新；迟到事件0次再settle |
| settled，迟到点击/relay/旧card destroy | no-op，按handle比对 | 0次额外response/规则更新，0次触碰新请求 |
| callback返回后SDK收到取消 | 应用请求已returned | 实际工具执行/取消由SDK拥有；本方案只保证host response一次，不虚称工具副作用exactly-once |

取消必须同时完成产品卡片结算和SDK等待promise结算；仅destroy DOM不算。未知suppression政策和无法绑定request owner均不能由UI自主放宽。

### 7. S3-A：命令来源、版本能力与coverage

#### 7.1 备选/推荐

| 数据方案 | 长处 | 限制/结论 |
|---|---|---|
| 定期重调supportedCommands或增加store revision | 易复用现接口 | 0.2.112仍旧init；是假刷新，不选 |
| 全部以独立probe列表替换当前session | 可以新初始化 | context相同不等于session状态对等，慢MCP可能缺、scope不同，不能直接替换热权威 |
| **来源分层快照：初始化范围 + 已证live push + 非对等probe候选；能力不足明示范围** | 旧SDK仍能诚实使用、未来能力直接适配 | 当前live push和probe对等未证；完整当前会话目录不能Go | **推荐** |

快照至少区分：`entries、requestedContext、observedContext、source(init/live-push/probe/vault)、queryEpoch、workspaceEpoch、publishedRevision、sourceRevision、observedAt、coverageBySource、stale、status、uncoveredReason`。

- publishedRevision仅是store接受一个新证据的序号；sourceRevision是实际SDK推送/初始化/文件来源身份。不得构造一个新publishedRevision就称SDK目录已变。
- hot current query 0.2.112：只返回初始化observed列表，标 `session-init-snapshot`。MCP后来connected不能升级该列表为current-complete。
- 现有typed init只含names不足以伪造完整metadata；缺description等标字段完整性，不能拿旧probe的description合成同context新权威。
- fresh `commands_changed`：官方≥0.3.216的SDK消费模式可作为升级后能力；当前SDK0.2.112若CLI真实raw push且transport透传，provider可通过严格额外字段守卫适配完整payload。**优先评估这个现成CLI能力是否能正向解决，不能仅因d.ts缺类型排除；但须G4真wire证实，当前No-Go**。不patch node_modules、不私接control通道、不发明消息序列。
- 官方CLI门槛≥2.1.281用于MCP prompts push，不证明磁盘任意编辑均自动push。每种refresh trigger分别记录能力，不给一个总“支持热刷新”bool。
- 未获live能力时，手动refresh可重扫vault并开新probe候选；不能令热query重启。要真正刷新session-init范围，只能在合法聊天生命周期后自然新query获得新init，不由菜单触发。
- fresh hot空列表可以替换同source旧列表；probe空不能无条件覆盖hot旧列表。优先级是**证明等级/目标范围**，不是简单“热一定新、最后revision胜”。

#### 7.2 MCP状态与覆盖可证关系

installed SDK的McpServerStatus是 `connected/failed/needs-auth/pending/disabled`，可列tools但没有本次命令枚举的prompts清单/同步水位。catalog不得从工具连接状态反推prompt覆盖。

| 本次要求范围内MCP状态 | 能证明 | coverage处理 |
|---|---|---|
| pending | 尚未就绪 | pending/uncovered；列表可partial，不能complete |
| failed | 本次连接失败 | failed/uncovered；错误与空列表分开 |
| needs-auth | 认证未完成 | auth-required/uncovered，不伪装disabled |
| disabled且desired context明确不要求 | 该来源在请求范围之外 | excluded，**不是发现失败**；不为完整性偷偷启用 |
| disabled但desired要求它 | requested/observed不一致或运行策略禁止 | unavailable/uncovered，非complete |
| connected | 存在连接、至多有tool元数据 | prompt enumeration unknown，直到命令push/枚举合同证明 |
| 状态没返回/不认识来源/SDK成功但无per-source命令证明 | 来源不明 | coverage=unknown；不按未列出当不存在 |

`ready`仅表示本scope观测动作成功，可与 `coverage=init-observed/partial/unknown` 并存；“当前会话全可枚举范围complete”必须证明desired sources与session已生效sources一致，且相应命令更新水位已应用。没有来源映射时最多发布 `session-enumeration-observed`，不是所有用户配置或所有MCP prompts全集。

同名冲突、hidden builtins、skill优先级继续用已知catalog policy；debug计数须区分原始observed与policy隐藏，否则“隐藏0项”会冒充source无命令。

#### 7.3 独立probe是否对等

独立probe默认是**candidate scope**，不是current session权威。要升级为目标入口的initial-equivalent，至少满足：

1. normalized effective config一致：cwd/additionalDirectories、settings sources及实际source版本、enabled plugins、managed+native MCP集合、禁用工具/visibility policy、Chrome/auto flags、CLI executable+version、SDK+build、env内部revision。
2. 真实init/状态信息证明实际加载集合一致，不能只比较发送实参。native user/project/managed MCP还可能额外加载；失败/禁用状态记未覆盖。
3. 验证session历史/动态directory/授权/工具更新不会影响所枚举范围；未能证明则**不可等价当前会话**，只标initial-config candidate。
4. 同一mock返回同数组不能证明对等。独立安全vault实际cold initial chat vs probe双向集合对拍和MCP延期反例通过，才可对该明确初始scope声明对等。
5. probe消失的来源不能删热session已observed命令；候选可展示“probe可见、当前会话未确认”，不能保证可执行。菜单选择前以当前实际执行上下文重核或明确提示。

### 8. S3-B：逐入口实参、fingerprint与资源生命周期

#### 8.1 统一context构造

provider内提取纯 `ClaudeCommandContext` 构造器，复用QueryOptionsBuilder的settings/env/plugin/MCP规则，不复制一套不同MCP过滤。context含 **desired** 与 **observed effective** 两份，requested≠已生效时不得共用cache。

fingerprint仅覆盖语义config/source变化；queryEpoch标一次transport，workspaceEpoch标服务生命期，**三者不可混作一个cache key**。新query同fingerprint仍需新的source evidence；不同query不得共享活跃结果归属。敏感env仅用内存revision/脱敏摘要，不记录值、服务器URL或完整command正文。

source目录变动需显式invalidate或已有事件通知；没文件watcher证明时不能称缓存自动新鲜。哈希只针对配置白名单、版本、目录修订，不为probe全量读用户秘密配置。

| 入口 | 当前真实接线 | 目标传参/范围与权威 |
|---|---|---|
| Main hot目标tab | TabManager.getSdkCommands用该service.getSupportedCommands | target tab实际observed context/query epoch；直接读取borrowed snapshot，绝不abort/restart聊天 |
| Main hot借另一tab | 当前仅provider相同就复用 | fingerprint及**observed effective scope**一致才候选复用；session-sensitive能力不等价则不用作current权威 |
| Main cold/blank tab | catalog probe闭包只有plugin | target selector的additionalDirectories、enabledMcpServers、已明确mention集合、settings/plugin/env snapshot；未发prompt的未来mentions不猜。范围=该tab已声明initial scope |
| Cold chat真实query | builder MCP=getActiveServers(mentions∪UI enabled)，additionalDirectories，disallowed/工具、plugins等effective规则 | 同context builder产生的query需求；实际init后登记observed。菜单不能把prompt未来变化提前当生效 |
| Persistent新init/dynamic MCP变更 | builder初始MCP后续applyDynamicUpdates setMcpServers；set成功更新本地key | 记录desired→applied/failed，命令source需另行push/枚举证明，不能setMcpServers成功即目录新鲜 |
| Inline Edit dropdown | 当前listDropdownEntries只有includeBuiltIns=false，虽modal持getExternalContexts但未传catalog | 传modal getExternalContexts和inline实际执行时规则；没有tab MCP selector则不凭空传active-tab集合。prompt mentions在执行解析后新fingerprint。无runtime只发布probe候选/vault scope |
| Settings → Commands & Skills | listVaultEntries/CRUD | vault管理范围，非session命令全集；编辑后invalidate相应context，继续可编辑条目，不启chat query |
| tab fallback/provider command loader | 当前各自缓存/warmup policy | 共用store构造与deadline contract；Claude不得用此绕开catalog ownedflight；其他provider能力保持 |
| probe执行 | cwd/env/sources/chrome/auto，bypass，persistSession:false；未传tab context/MCP/plugin集合 | 用上述确定context，显式effective config；persistSession:false只证明不持久session，不证明无API/无hooks副作用 |

辅助title/refine的 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/claudeColdStartQuery.ts` 不是聊天或command probe；不为复用context把其tools/persistence/permissions改成chat规则。Inline dropdown上下文须对拍真实inline service options，不能凭UI持路径就认定SDK加载该路径。

#### 8.2 catalog/store刷新与subscriber

- workspace catalog拥有store与probe flight；每fingerprint一个flight，flightId/epoch用于旧finally隔离；合法空也是一次snapshot，不再length>0才缓存。
- subscriber拥有订阅和UI请求token。取消单个subscriber只退订；最后subscriber退出、明确flight失效或workspace dispose才取消**owned probe**。borrowed chat query永远没有abort权。
- hot query订阅的hook removal仅摘listener。query close/restart由原聊天生命周期管理，catalog dispose不能代调用chat.cleanup。
- `refresh`语义必须返回其执行的source动作：vault-rescan、new-probe、await-live-push、session-refresh-unavailable；不可返回void/no-op后显示“刷新完成”。
- old source结果在fingerprint/workspaceEpoch失配时discard；same fingerprint的新source仍按scope/authority判断，不能用store revision覆盖不对等scope。
- dropdown不另持成功缓存真相；requestId只防自身旧input，snapshot+revision+source来自store。partial/error/ready-empty/unsupported可同时明确显示。

#### 8.3 workspace资源处置

| 生命周期 | 必须执行 | 非允许动作 |
|---|---|---|
| initialize创建 | 为候选services发workspaceEpoch；初始化成功才安装 | 中途失败遗留probe/catalog不dispose |
| initialize失败/被较新initialize替换 | dispose候选已建资源，报告cleanup结果 | 让旧初始化后来覆盖新services |
| setServices替换/删除 | 先退役旧catalog准入、取消订阅/ownedflight；registry串行交换并drain旧owned资源；新workspaceEpoch | 裸覆盖引用；允许新旧同scope probe无限并存 |
| registry clear | async disposeAll，调用每services可选中立dispose合同；引用清空不算完成 | 只this.services={} |
| main onunload | 同步退役所有新准入；取消审批/ownedprobe，drain已接受业务write；按原tab/runtime生命周期关闭chat，再disposeworkspace | 只存tabstate；目录dispose误杀聊天query |
| 再加载/SharedStorageService重建 | 已证退出/业务owner接续后新服务生效 | timeout后另开相同owned槽/业务writer假接续 |

正常unload等待上限由G5实测后裁决；SDK promise超时不代表进程/I/O结束。系统不等待async unload时必须同步标retired，旧finally不得更新新registry；真正exit未证则cleanup-failed，受限新probe/重试，不无限造进程。

#### 8.4 probe副作用、超时和退出

候选：取消后只调用SDK abort/close；或probe-scoped进程树所有权清理。推荐先复用 `customSpawn` 的Electron signal兼容/onExit，并**实证SDK/CLI后代清理**；后代未退出才另立probe专用平台策略，不修改chat默认spawn。

- probe全出口finally移listener、abort/closeowned query，确认真实direct-child exit和已登记owned后代退出；stdout强制EOF不是后代退出证明。
- 当前customSpawn的匿名abort listener没有统一移除合同，probe扩展要有dispose listener/timer；不得把“SDK promise settled”当资源归零。
- MCP/用户hooks可能启动本机或外部资源。不能 `pkill claude`、命令名匹配杀全机MCP、按猜PID杀其他session；外部共享server只有归属可证时才清理其专属connection/process。
- “空prompt init无模型费用”是当前代码注释/上游说法，不是本轮实测。启用新probe先获准安全环境及预算，确认启动hooks/外部服务范围。推荐探索无需模型的官方初始化能力是否本版本可用；没有明示API不发明。
- UI等待提示、flight硬生命周期、MCP cap分开。保留显式用户MCP_TIMEOUT；本设计不自动设5000、不关闭MCP，不把probe短cap带入chat env。
- 决定可执行的finite lifecycle数值前测 spawn→init→snapshot、abort→exit；未定值/未证bounded cleanup则新probe自动Retry能力No-Go。可诚实展示vault-only/旧init-snapshot，不能把无限pending包装为正常ownedflight。

### 9. 十语言说明与共享接口兼容

范围仅纠正 `settings.loadUserSettings.desc`（保留既有name可选）及本稿新增状态/错误/timeout/范围文案，不实现user skills与user权限拆载。语义锚句为：

> 加载 `~/.claude` 的用户级 Claude Code 配置，包括 settings.json、skills、commands、agents、plugins；已有用户权限规则可能绕过 Safe mode。

这是上游live读数支持的整体user source说明；本地每类发现是否生效仍需G4逐类实测。不能写成“插件扫描了用户全部资源”或“开关只影响权限文件”。

固定locale：`de、en、es、fr、ja、ko、pt、ru、zh-CN、zh-TW`，位于 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/locales/`。所有locale与 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/types.ts` 同键、同插值参数；Safe warning不能漏。语义review检查五类scope+警告，不要求逐字机械直译。

新增中立task/snapshot/ACK/dispose合同须明确optional capability，Codex/OpenCode当前接口做行为等价适配。不得借共享types触发其他provider命令、权限或任务生命周期扩张。

### 10. 影响范围与依赖

以下均为**后续目标，不是本轮diff**。表内带“新”文件尚不存在，复核可据最终基线收缩；不能把planned模块当现成能力。

| 机制 | 绝对路径 | 必要改动/保留边界 |
|---|---|---|
| owner | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeEventOwnership.ts`（新） | 纯owner/栅栏求值，consume证据，不假造SDK序列 |
| owner输入/consumer | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeMessageChannel.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeUserMessageFactory.ts` | canonical/字段/冷热同合同；取消owner先于tombstone；bare result隔离；cold结束非假成功 |
| 现有证据 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeTurnReconciliationCoordinator.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptTurnMapper.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptTurnObserver.ts` | canonical事实/父链/quiet-settle复用；observe-only不悄然升权；保留continuation撤销语义 |
| task | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeTaskEventAdapter.ts`（新）；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeTaskCorrelation.ts`（新） | 沿用原稿planned位置，统一live/replay reducer/别名/证据；不造第二数据库 |
| history/content | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkMessageParsing.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkAsyncSubagent.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkSubagentSidecar.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeHistoryStore.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkHistoryTypes.ts` | scoped record索引、无正文terminal、status映射、run-specific read结果合同 |
| schema/history预算 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/types/providerState.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeTranscriptHistoryIndex.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkBranchFilter.ts` | subagentData版本/未知字段往返、同snapshot结构关联；后两者只按实际缺口补，保留并行budget/branch改造 |
| domain/projection | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/services/SubagentManager.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/StreamController.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts` | 同run归约/早terminal/native优先于orphan、content proof/poll slot/await后guard |
| persistence owner | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationMutationCoordinator.ts`（新）；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/SessionStorage.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/storage/SharedStorageService.ts` | typed意图、最新state、app/vault单writer接续、failed/conflict/drain；不声称CAS |
| 全保存入口 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ClaudianView.ts` | 当前startup回填/environment/create/rename/update/delete、load/list迁移及后台保存全接owner；专用delete reset；非READY typed skipped |
| size共享门 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationSizeService.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/types/chat.ts` | 按最终获批协议映射handle/ACK/invalidations；本稿不裁决size存储迁移 |
| Stop最后删除 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/hooks/SubagentHooks.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeQueryOptionsBuilder.ts` | G1–G3过后删插件hook/熔断；保留用户hooks、只读running snapshot/watchdog门槛 |
| SDK分类 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/sdk/types.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/sdk/typeGuards.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/stream/transformClaudeMessage.ts` | 控制/task/source snapshot与StreamChunk明确区分；保留usage分母/去重裁决 |
| approval | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeApprovalHandler.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/security/ClaudePermissionUpdates.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/types.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/InputController.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/rendering/InlineAskUserQuestion.ts` | once/always、eligibility政策、ordinary signal/toolUseID、request handle/settleOnce、原relay和计划mode保留 |
| catalog/context | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/commands/ProviderCommandCatalog.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/commands/ProviderCommandDiscoveryStore.ts`（新）；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/ClaudeCommandContext.ts`（新） | 来源/coverage/刷新结果/订阅、中立capability；provider纯effective context |
| discovery执行 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/ClaudeCommandCatalog.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/probeRuntimeCommands.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeDynamicUpdates.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/customSpawn.ts` | init/live/candidate来源、额外wire字段守卫、applied≠enumerated、ownedflight/exit；chat spawn默认不变 |
| registry/全入口 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/ProviderWorkspaceRegistry.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/app/ClaudeWorkspaceServices.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/shared/components/SlashCommandDropdown.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/inline-edit/ui/InlineEditModal.ts` | create/replace/dispose/unload；Main/Inline/Settings/fallback实参与store接线 |
| diagnostics/i18n | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptDiagnosticLog.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/types.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/locales/` | owner-proof/blocked、task provenance、save ACK、coverage/sourceRevision、cleanup；脱敏轮转、十语言 |

`package.json/package-lock.json/node_modules` 不在本稿实施范围；SDK升级、依赖pin、CLI升级另获授权。`VaultFileAdapter.ts`若需crash-atomic协议另立能力门，不静默增Node-only路径。

### 11. 方案推演与反例

#### 11.1 跨步骤/规则序走查

以下全部〔纯示意〕，不是生成或宣称真实CLI序列。计数只用于可验证红绿断言。

| 锚值/输入 | 当前可推出的风险〔推算〕 | 推荐合同的结果 | 红/绿判据 |
|---|---|---|---|
| H持lease；1条N false；H result到达 | bool吞H result；mapper没开N | N不加入owner候选；若H control证据已成立则正常结H | 绿：H成功1、N轮0；红：为N跳一次 |
| H active；N1/N2 true；只1 result、无关联 | bool不能表达多输入，最近echo猜也不成立 | unknown result、0虚假成功；query blocked后按证据恢复 | 绿：H/N成功0且可见unknown；红：counter=2或分摊usage |
| H cancel；N result在先，H result在后 | tombstone前置可能在N result解H栅栏 | 首个不释放；绑定H的后者确认交接一次 | 绿：下一host在确认前dequeue0次；红：cancel后任意result释放 |
| task T/R1 completed；R2 running；旧R1 terminal缺run晚到 | 唯一running启发式误结R2 | 两历史occurrence可匹配则ambiguous | 绿：R2仍running；红：用最新run/时间选R2 |
| 同run patch.killed，summary/result均缺 | history丢terminal或fallback running | providerTerminal=stopped，content=missing | 绿：active计数减1、result可空；红：缺正文不销账 |
| orphan R1；native completed R1后到；sidecar有R1/R2文本 | orphan可能阻所有恢复；全文件最新文本属R2 | R1 terminal补completed，local detached；内容无run证明拒绝 | 绿：R1不展示R2正文，terminal仍保存；红：固定callback即取最后文本 |
| sidecar run A先写tool use U；run B重用U再写result | type+U首次去重/merge混run | recordKey隔离；未证分段时unverified | 绿：A/B不混；红：A工具状态被B result补completed |
| disk r10有size S；迟到task delta A；随后rename B | stale全snapshot可能丢S或A | lane r10→mergeA=r11→patchB=r12，均保留S/未知字段 | 绿：S、A、B三者在最终disk；红：只比write次数 |
| task A已written r11；迟到先前捕获providerState快照r9的host save | FIFO保证写顺序，不保证base新 | 不接受r9全providerState；显式delta归约r11 | 绿：A不回滚；红：延迟stringify仍写r9 |
| delete old C；同ID新C；旧sidecar/write/delete迟到 | ID-only guard可伤新C | old handle retired；new handle独立、delete barrier禁止越序 | 绿：新C更新0次来自old；红：finish时按ID重绑 |
| 非READY shell；parent卸载；1个terminal A | Controller.save返回void可被当保存 | shell skipped+task merge written，两ACK分开 | 绿：reload见A且shell未覆session；红：await save即saved |
| 2菜单共享1 probe，取消菜单A；B仍等；hot chat输出 | 未区分owned/borrowed可能误abort | A退订；B flight继续；hot listener不动query | 绿：probe1、hot中断0；红：任何signal终止chat |
| init列表2条；MCP pending→connected；store revision+1 | 状态变更包装为新命令快照 | sourceRevision不变，仍init-observed/unknown，非current-complete | 绿：UI明示未覆盖；红：connected=>完整 |
| probe empty，hot init有2条，两个context相似但session不同 | 空/最后revision可能覆盖有用旧范围 | probe candidate独立；hot scope保留2条并stale标记 | 绿：不混scope、不承诺当前全量；红：最后发布胜出 |
| ordinary auto approval与timeout在300000ms同tick点击always | 仅card resolved不能挡旧资格/策略 | request settleOnce+最终资格；至多1响应，cancel后0 updates | 绿：response1、持久更新至多一次且eligible；红：旧UI仍写宽规则 |

默认值最不利场景：shouldQuery缺失（本轮21/21通知样本如此）、taskId复用+run缺失、真实terminal无正文、无DOM/非READY、旧SDKsuppression缺失、connected无命令水位、query退出但后代存活。分别降unknown、ambiguous、missing-content、独立task保存、待用户裁决、init-observed、cleanup-failed；无一默认成功。

#### 11.2 论证链与具体反例

- **归属链**：实际dequeue给H UUID → native父链把assistant A绑定H → 可投影A到H。**隐藏前提**：同snapshot、同branch、UUID跨渠道一致。**反例**：A父链经一个未读/被skip的不明notification user；链不唯一，第三步失败。即使链唯一，也没有“bare result属于H”这第四步。
- **内容链**：固定C/S/R回调 → 路径落受信sidecar → 内容属R。第三步并不成立。**反例**：同agent resumed R2复用文件，最新assistant为R2；fixed callback与safe path均真，R1内容仍错。因此目标要求内容分段proof。
- **保存链**：所有业务writer进入同lane → 队内读取最新base并归约delta → 串行写不丢已接受不同字段更新。**隐藏前提**：无writer旁路、服务重建不丢owner、失败读可验证。**反例**：loadMetadata先读legacy r9，migration在另一实例写回；单lane前提被破坏，不能称CAS或正确。
- **目录链**：MCP connected → prompts已进入supportedCommands → 当前目录完整。第二步被0.2.112init快照直接反驳。**反例**：连接发生在init之后，SDK仍返回2条旧列表；新publishedRevision无帮助。
- **取消链**：single card resolved → callback只返回一次 → 不会批准已取消query。末步有额外前提：signal/handle经过生产callback并在返回前核验。**反例**：ordinary当前没传signal，switch后的旧always仍能返回；所以不能只复用resolved guard不补接线。

追溯：本稿不改已关账记录。纠正的是原draft里“已有CAS/默认once/热新快照”的待设计前提，不把旧事故重新宣布已修。前向反事实：只删Stop而保留bool/旧快照，后台更早释放后notification竞争仍可误结host；因而去Stop不是身份/保存正确的替代证据。

#### 11.3 结构不变量判定

| 不变量 | 判定/位置 |
|---|---|
| 四生命周期正交 | 目标成立；当前违反在Stop hasRunning耦合host与task、notification bool、终态内容合一；本稿分owner/control/task/content/save |
| 内容proof与接收资格正交 | 目标成立；仅freeze callback仍违反，位置sdkSubagentSidecar/runtime.loadSubagent* |
| 单向无环 | facts→reducer→store/DOM；ACK只确认dirty，probe只发snapshot。禁止task→send补prompt、save→全history重算→再save、dispose→重启chat循环 |
| 单写者 | 目标需G3证明；current saveMetadata多入口+实例重建违反。队列不能在原lane里再enqueue自己；统计非前驱按最终size合同验证 |
| 扩展点方向 | provider适配wire/source/run；core合同中立；UI不解析Claude SDK origin。新增未知wire只改provider适配，不让十处UI猜 |
| 退化为一般特例 | empty-ready、terminal-without-content、no-DOM、legacy-unverified、无CLI同合同状态；不新建“小会话全量”或“无通知就跳过身份”支路 |
| 入口×机制覆盖 | 当前未成立：cold UUID/通知分类、ordinary signal、inline context、registry dispose缺口；验收矩阵逐格核，不能单个unit证明全链 |

### 12. 交付物规范

#### 12.1 本轮新增目录树

绝对根 `/Users/vincentwang/Documents/NoteVault/tools/claudian`，只新增：

```text
/Users/vincentwang/Documents/NoteVault/tools/claudian/
└── docs/designs/
    └── 2026-11-07-upstream-compat-evidence-closure-supplement.md
```

这是独立supplement首版，不是原主题v2；原稿路径/status/content均不变。后续如需修改本稿也须具体派单授权，不自行覆盖设计历史。

#### 12.2 获准后新增部分（目标，不预建）

```text
/Users/vincentwang/Documents/NoteVault/tools/claudian/
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
├── tests/integration/providers/claude/
│   ├── upstreamCompatibility.test.ts
│   └── fixtures/claude-compat/
│       ├── evidence-manifest.json
│       ├── task-owner-wire.jsonl
│       ├── task-owner-native.jsonl
│       ├── task-run-sidecar.jsonl
│       └── permissions-control.jsonl
└── dev/claude-compat/
    └── verify.mjs
```

`dev/claude-compat/verify.mjs` 是**后续获批证据工具的入口规范**，当前不存在。不得现在执行该路径冒充有harness。它须提供 `capture/owners/runs/persistence/discovery/resources` 子命令及非0 No-Go退出，真实query capture须显式 `--allow-live --case --budget --sandbox-vault`，默认只消费脱敏fixture。进入实施前先设计其真实SDK调用/费用/写权限，不发明初始化API。

一次性脚本/原始采样仅 `/tmp/claudian-compat-<timestamp>/`，不是交付物；保存原始敏感材料须另授权。fixture目录是新约定，正式工具不得放临时 `.context`。本轮没有新业务数据/数据库/运行日志文件。

#### 12.3 命名、索引、清单与消费者

- `ClaudeEvent*`：provider控制/内容归属；`ClaudeTask*`：原生任务归一化与派生关联；`ConversationMutation*`：中立业务mutation；`ProviderCommandDiscovery*`：目录状态/订阅。不是通用事件总线/数据库。
- fixture名称表示渠道，不用数字版本伪装实采。`evidence-manifest.json` 必填sourceKind=`real-wire/real-native/fake-transport/synthetic`、SDK/实际CLI/build/context摘要、捕获方式/允许范围、脱敏说明、完整/截断边界、caseId、SHA-256、假设/缺口、红绿判据。real与fake不可同标签。
- 关联join字段在wire/native/sidecar采用同盐映射保留等值关系，删字段须登记；原始UUID不入repo。manifest的哈希证明fixture不变，不证明SDK保证。
- 获准落地后在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/README.md` 登记设计、dev验收入口、fixtures/tests索引；本轮不改README。

| 路径/组 | 用途 | 消费者 |
|---|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-07-upstream-compat-evidence-closure-supplement.md` | 本轮待复核独立设计 | 用户、主会话、独立architect |
| 上述6个新增source模块，绝对路径见第10节 | 纯owner/task/context、业务写者、目录store | runtime/history/app/UI |
| 上述6个mirrored unit文件，绝对根 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/` | 状态/竞争/取消确定性验证 | implementer/Jest/reviewer |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/providers/claude/upstreamCompatibility.test.ts` 与同目录fixtures/claude-compat5文件 | 生产调用链及保真证据对拍 | integration/独立复核/回归 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/dev/claude-compat/verify.mjs` | 获批后真实取证、fixture静态验收及非0闸门 | implementer/验收者 |

#### 12.4 域约定引用与偏离

遵循 `/Users/vincentwang/Documents/NoteVault/tools/claudian/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/CLAUDE.md` 的provider-native-first、中立边界、mirrored tests、TDD、dev正式工具、生产禁止console、window/index预算、用户hooks保留。

归属沿用独立工具仓的已有 `docs/designs/`，不在vault顶层复制。临时逻辑依派单走 `/tmp`，优先于领域一般 `.context/` 约定；不落新的交接/report文件。兼容fixture/证据manifest索引暂无现成规范，本节是雏形，获准落地后回填README。除此无主动偏离。

## 风险与权衡

### 1. 当前Go/No-Go总表

“Go设计准备”仅允许获批后写红测/采证工具；不批准生产行为。真实不可决定项不能用更多mock关闭。

| 闸门 | 当前结论 | 缺证/决策与失败分支 |
|---|---|---|
| G0 最终并行/合并基线 | **No-Go实施** | 工作树脏；最终size/ACK/删除/registry等尚需mapping。HEAD不覆盖脏改 |
| G1 owner/control契约 | **No-Go去Stop/新settlement** | bare result无input关联，真实多/合并/零result序列未取；需真wire+native+代码/官方保证，取不到就保持blocked降级，不造序列 |
| G2 run/content证明 | terminal方案可设计；**run-specific hydration No-Go** | 当前样本无sidecar run标签；cross-file父链bridge/final输出/flush边界未证 |
| G3 最新state保存与size耦合 | **No-Go生产保存切换** | 单writer全入口、服务接续、两方向竞争对拍和最终size协议未证/未批 |
| G4 command当前会话范围 | init观测设计可用；**current-complete/热补全 No-Go** | raw commands_changed当前CLI/旧SDK透传、effective scope和per-source枚举未证；probe不对等则只candidate |
| G5 probe/resource | **No-Go新自动probe/Retry部署** | 无费用/无不受控副作用、finite生命周期/后代退出和unload替换未证 |
| G6 approval政策及生产链 | **No-Go行为切换** | 用户未裁决旧SDKalways政策；ordinary signal/handle/timeout新适用范围未实施/实测 |

### 2. 用户必须裁决

1. 旧SDK缺suppression：选once-only规避新持久授权（推荐候选），或接受明确无组织hint保证的原生always，或另批升级设计；不是官方必然性，本稿不代拍。
2. auto普通approval/ExitPlanMode是否采用现有Ask的5分钟上限；user等待与取消不改，手机普通权限relay不扩。
3. 菜单是否接受标注scope的vault-only/init-observed/probe候选与明确不可执行/未确认提示（推荐），还是失败不列provider项。都不能假complete。
4. 最终size持久协议及record handle如何归一：主会话应先拿已确认size方案映射，不将相邻draft当决策；若仍要求共享meta overlay且统计永久pending不阻业务，需回到物理边界裁决。
5. 真SDK/CLI验收的独立测试vault、具体MCP/hooks启动权限和模型预算；组织受限connector用例取得不了，组织端限制验证就No-Go/未验证，不能伪造。
6. 保证范围是否接受同renderer同vault受控单业务writer、非fsync承诺；若要跨进程或同步插件共同写meta，应另设计互斥/存储合同，不用check-then-write冒充CAS。

### 3. 迁移/落地代价

目标不是摘PR：S1补窄owner合同、所有任务/历史/sidecar入口及最新状态writer，涉及共享保存和tab生命期；S2需request identity、取消/超时接线及用户政策；S3需source-aware catalog/context/registry disposal。schema读取兼容、增量懒迁移，未知字段保留；不批准自动清旧权限/任务/统计。成本影响实施节奏，不降低证据/身份目标。

### 4. worktree并行与合并风险

- 当前只读源码与脏size/history实现并存，不冻结、不修改其文件。自己的唯一新路径独立；用户要求讨论worktree不等于授权创建隔离。
- 后续若用户点名worktree，须从**包含已确认并行结果的commit**建；default分支或旧HEAD副本看不到未提交size改动，合并必有隐藏合同冲突。路径写绝对worktree根，不回写主区。
- 顺序优先：size最终合同冻结→G0接口映射→G1/G2/G3证据→S1切换→S2→S3。允许独立采证并行，但共享文件落地只有一名integrator；不独立重写main/SessionStorage/Controller/shared types/locale。
- 每次回流比较基线commit、关键file hash、合同diff、全入口矩阵，而非只解决Git文本冲突。方法/签名相同也可能有ACK/字段权属/owner变化。
- 构建/部署会写源码仓或活vault，必须另获批准；`.obsidian`未受此仓Git保护。worktree不能代替生产bundle回滚和真实版本确认。

## 验证方式

### 1. 冻结前只读复核

获并行完成信息后由主会话安排，不在本轮轮询/控制其他session。命令可执行且不改ref：

```bash
git --no-optional-locks -C /Users/vincentwang/Documents/NoteVault/tools/claudian status --short
git -C /Users/vincentwang/Documents/NoteVault/tools/claudian rev-parse HEAD
git -C /Users/vincentwang/Documents/NoteVault/tools/claudian diff --name-status
git -C /Users/vincentwang/Documents/NoteVault/tools/claudian worktree list
```

逐项输出相同/已变等价/冲突/未知并附证据：

- actual installedSDK bridge、resolved CLI/build/内存加载身份；不能只manifest。
- routeMessage/cold入口、cancel tombstone顺序、canonical工厂/channel字段、coordinator仍否observe-only、quiet-settle/compact/recovery。
- sdkMessageParsing/history association/branch/snapshot、run aliases、sidecar read来源、manager orphan与poll。
- 所有saveMetadata/saveSizeSnapshot/update/rename/create/delete、legacy load/list迁移、SharedStorageService重建、Controller非READY ACK；size最终record/fence合同。
- getSdkCommands跨tab借用、probe/context、commands_changed桥、mcpServerStatus来源、Main/Inline/Settings/fallback、workspace set/clear/unload。
- ordinary approval signal/toolUseID、request handle/auto政策、十语言键与现有并行locale diff。

任何实质目标变化回报用户决定本稿订正或独立迭代；本轮不改任何已有记录。

### 2. 证据采集闸门

以下是**后续要落成的验收动作**，本轮未运行。不能先写fake流再宣称CLI就是如此。

| 闸门 | 真证据靶子/用例 | Go判据 | No-Go处理 |
|---|---|---|---|
| G1 | 在获批safe vault实际SDK transport边界捕获input-dequeue/user echo/assistant/stream/result/exit，同时native committed行；单host、false通知、queryable/legacy通知、2通知、合并、零result、取消、错序/迟到；记录实际CLI及配置 | 能建立内容owner与control交接的不同proof；未明分支确实blocked且无假成功。CLI保证须源码/官方合同或明确版本受控范围，不从几个样本归纳普遍序列 | 无bare result区分合同就保持No-Go；未知用例不以synthetic补成“实测” |
| G2 | 同task/agent实际resume两run、早terminal、patch.killed/stopped、native恢复缺run、sidecar晚flush/进度最后文本；cross-file UUID root桥 | 每run内容来源可证，或严格降unverified；history/live同record/terminal，0跨run正文混合 | 未证自动hydration停用/不切换；terminal与summary仍可独立验证 |
| G3 | 生产main→writer→SessionStorage→实际test-vault adapter；重建storage实例；slow task/save/rename/size/delete；故障注入write后清理失败、损坏读取 | 最终字段并集/同run单terminal、ACK准确、0删后复活、未知字段保留；统计是否非阻按最终协议 | writer旁路或overlay liveness冲突即No-Go，不调队列等待数值 |
| G4 | 当前installedSDK+实际resolvedCLI观察commands_changed；MCP pending→connected/prompts更新、settings sources五类、两tab外部目录/启用集合差异、probe/cold chat集合对拍 | source scope/revision正确；未证connected不标complete；真push即便空能发布；不等价probe只candidate | 无push只init-observed；不可取得来源覆盖证据就unknown/current-complete No-Go |
| G5 | owned probe init前EOF/挂住、supportedCommands挂住、取消1/全订阅、CLI exit但后代持stdout、replacement/unload、外部共享MCP；记录child及实际owned后代身份 | finite预算/全部出口finally、listener/timer归零、真实exit/后代归属可证；chat中断0；费用与hooks范围符合批准 | cleanup-failed且限制Retry；无法安全证明树归属不实施猜PID清理 |
| G6 | real SDK控制桥→provider callback→普通/Ask/Exit UI→response；signal前后abort、same-tick答案/超时、旧card换tab、陈旧always；另获批组织请求 | once字段无updates，always deep-equal建议、一次response、取消后0持久更新、政策选择生效 | 无组织用例只能验host响应fallback，不能称组织hint已验证 |

真实捕获可使用approved custom spawn wrapper记录白名单结构和已脱敏的跨渠道等值键；不能在真实活vault发宽授权或启动未经确认MCP来“验证”。没有raw wire捕获条件时G1/G4保持No-Go，不以native transcript替代stdout。

### 3. 必须竞争对拍与入口矩阵

确定性故障/顺序测试可用fake filesystem/SpawnedProcess，但必须加载真实installedSDK与生产app/runtime wiring；不能mock被测reducer、writer、cancel或catalog行为。fake结果只证明host面对这些输入的正确性。

| 对拍 | 两种执行序均须验 | 最终断言 |
|---|---|---|
| task vs普通save/rename | A terminal→B metadata，以及B捕获旧state→A written→B执行 | 最终最新title/context+任务terminal+未知字段，0回滚 |
| task vs size | task written→size ACK，size提交→task；额外统计I/O永pending | 按最终size合同不互覆盖；业务ACK不以假超时绕过统计前驱 |
| task vs delete/recreate | read发起→delete→read返回；old delete pending→同IDcreate请求 | 原handle0碰新record、old意图不得创建meta、provider删除语义保留 |
| live/history | 同一真实对象wire事实归约与native重放；不同segment裸taskId相同 | record身份/terminal/content来源一致；相同taskId跨session不覆盖 |
| ownership/cancel | N result先于H control terminal、旧query result在新epoch后、zero/multi results | 0假success、0错lease释放、队列UUID/aliases保留 |
| catalog/context | A tab外部目录≠B；A仅启用MCP1、B仅MCP2；hot空vsprobe非空 | context不互借，source范围不伪装，合法空可新鲜 |
| registry/probe | 2subscriber→取消1→替换workspace→旧finally；unload后旧push | chat query中断0、旧registry更新0、owned资源ACK准确 |
| approval | pending old request→switch→new request→old callback | old只清自身card，new仍可答，response/update各至多一次 |

入口×机制：persistent/cold/recovery × task/owner/approval；user/auto/subagent × ordinary/Ask/Exit；Main hot/Main cold/Inline/Settings/tab fallback × context/error/refresh/cancel；save/startup/environment/rename/create/delete/legacy迁移/size × ACK/record identity。每格输出pass/fail/not-applicable及理由，不能“测试全部通过”替代未覆盖机制。

优先扩现有mirrored suites：`ClaudianService、turnResultWatchdog、turnLeaseRelease、ClaudeApprovalHandler、SubagentManager、StreamController、ConversationController、Tab、TabManager、SessionStorage、ClaudeCommandCatalog、probeRuntimeCommands、SlashCommandDropdown.provider、ClaudeTranscriptTurnMapper/Observer、customSpawn`；新增模块unit位置见交付物规范。注意既有SessionStorage测试路径为 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/storage/SessionStorage.test.ts`，以最终layout为准，不为整齐迁测试。

### 4. 获批后机械验证命令

仅冻结/获准实施后运行；本轮未跑、不声称通过：

```bash
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run typecheck
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run lint
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run test -- --selectProjects unit --runInBand --no-cache
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run test -- --selectProjects integration --runInBand --no-cache
```

已实现并获批的dev工具才能运行，例如：

```bash
node /Users/vincentwang/Documents/NoteVault/tools/claudian/dev/claude-compat/verify.mjs owners --fixtures /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/providers/claude/fixtures/claude-compat
node /Users/vincentwang/Documents/NoteVault/tools/claudian/dev/claude-compat/verify.mjs persistence --fixtures /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/providers/claude/fixtures/claude-compat
```

工具当前不存在；这些是入口验收规范，不是已可运行证据。构建另批，用非空且不存在的OBSIDIAN_VAULT挡真实部署，仍会写仓库build产物：

```bash
test ! -e /tmp/claudian-compat-NONEXISTENT-vault && env OBSIDIAN_VAULT=/tmp/claudian-compat-NONEXISTENT-vault npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run build
```

### 5. 后续设计复核与阶段验收

1. 独立architect只挑本稿+原稿硬伤：owner未知分支是否仍偷放lease、内容proof是否依赖固定callback、所有writer是否覆盖、size并行合同是否被暗选、probe是否冒充session、ordinary取消是否只卡片一次。重点复核G1/G3/G4，不从mock数目取信。
2. 用户先裁决第6节政策与风险中的真实待决项；再批准具体采证权限。G0–G6按证据账逐条关闭，不要求不可能观测的真实用例被“演出来”。
3. S1-a先实现/验证归约、typed ACK、owner unknown分支；G1–G3与后台retire副作用未过，不去Stop。S1-b才移插件hook，保留用户hook和原watchdog候选/数值；每批独立reviewer和安全真机验收。
4. S2先响应/取消红测和政策闸门，再改UI/删除旧builder；S3先来源/context/dispose合同，再ownedprobe/全入口。不得用后批替前批兜底。
5. 每阶段冻结source/build/SDK/CLI、实测manifest、通过/未覆盖/No-Go清单与回退边界。回滚bundle不会撤销已写权限或抹去新taskschema；不自动清理。
6. 最终验收必须同时满足：插件Stop阻断0、host虚假成功0、错run内容0、不同字段更新丢失0、allow-once规则更新0、取消双结算0、partial冒充complete0、菜单导致chat中断0；所有unknown有用户可见恢复/范围标签，而不是被统计成成功。零值指受控验收案例计数，不是未经测量的生产全年保证。

## 关联

- [[tools/claudian/docs/designs/2026-11-07-upstream-compat-stop-permissions-discovery]]
- [[tools/claudian/docs/designs/2026-11-07-conversation-size-isolated-persistence-boundary]]
- [[tools/claudian/docs/designs/2026-11-07-conversation-size-contract-consolidation-restart]]
- [[tools/claudian/CLAUDE]]
- [[tools/claudian/src/core/CLAUDE]]
- [[tools/claudian/src/providers/claude/CLAUDE]]
- [[tools/claudian/src/features/chat/CLAUDE]]
- [#936 原生异步任务生命周期](https://github.com/YishenTu/claudian/pull/936)
- [#1493 原生授权建议透传](https://github.com/YishenTu/claudian/pull/1493)
- [#1551 suppression与SDK升级](https://github.com/YishenTu/claudian/pull/1551)
- [#1359 发现失败与慢probe](https://github.com/YishenTu/claudian/pull/1359)
- [官方TypeScript SDK：版本能力、commands_changed、task run与permission合同](https://code.claude.com/docs/en/agent-sdk/typescript)；本轮经Context7查询，最新文档不替代installed0.2.112或真实wire证明。
