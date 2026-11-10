---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - claudian
  - mainline-adoption
  - stop-hook
  - permissions
  - evidence-gate
---

# Claudian 主线借鉴：Stop 与单次授权的窄闭环及验收闸门

## 背景与问题

核实 Claudian 各“主分支”处理 Stop 和单次授权的实际机制，借鉴可证明的语义，消除主轮与后台任务的错误耦合，而不把未经实流验证的结算假设或全生命周期重构当成必要前提。

> [!warning] 独立设计草案，不是实施或部署授权
> 本轮只读仓库、固定提交源码、SDK 分发包与既有设计；仅新建本记录。未运行测试、构建、插件、真实模型请求或真实 MCP，未 fetch、改 refs、提交、推送、部署或清理。下载材料仅在 `/tmp/claudian-mainline-evidence-kKVfJy/` 被动读取，未安装或执行其中代码。
> 本记录不修改、确认、替代或 supersede 任何既有记录；宽范围保存、重载、删除与命令发现设计仍是独立议题。

## 方案设计

### 1. 仓库、分支与版本证据

#### 1.1 “主分支”不是当前工作分支

| 对象 | 实际仓库／分支 | 核实 commit | 本轮结论 |
|---|---|---|---|
| 当前工作区 | `/Users/vincentwang/Documents/NoteVault/tools/claudian`，`fix/model-identity-sorting` | `cf47730d2109e798fd27ddacc712038d26883d5b` 加未提交修改 | 必须按实际源码分析，不能当 main 已发布状态 |
| 本地 main | 同一独立仓库，`refs/heads/main` | `1ab2ab831700b2833aae3f40b4ca5a49b7d1fa1e` | 仍有 Stop 阻断及普通 allow 的 session 规则更新 |
| origin 默认主分支 | `vincent101/claudian`，GitHub API 确认为 `main` | `1ab2ab831700b2833aae3f40b4ca5a49b7d1fa1e` | 与本地 main 相同；API 本次返回 public fork，不沿用历史“私有仓”描述 |
| upstream 默认主分支 | 原作者 `YishenTu/claudian`，GitHub API 确认为 `main` | `3e58ea7707085d40176f9762dc92fbbd07cb40b0` | 下文所有上游源码固定到此 commit，不以浮动 main 取证 |

origin 的 GitHub parent/source 均为 `YishenTu/claudian`。本地 `origin/HEAD → origin/main` 已读，但远端默认分支身份以此次 GitHub API 为证，不仅靠本地缓存。原作者主分支 commit 时间为 `2026-11-08T04:05:50Z`；origin/main 为 `2026-11-04T07:02:01Z`。

版本不能按 fork 的产品版本号大小推断新旧：

| 边界 | 本地 main／当前工作区 | 原作者固定 main |
|---|---|---|
| 插件 manifest | id=`claudian`，version=`3.2.8`，minAppVersion=`1.4.5` | id=`realclaudian`，version=`2.3.40`，minAppVersion=`1.13.0` |
| package 产品版本 | `2.0.11`，与本地 manifest 不同 | `2.3.40` |
| Agent SDK | 声明 `^0.2.112`；lock／installed 均 `0.2.112` | 声明和 lock 精确 `0.3.293` |
| SDK 自带 CLI 版本声明 | `claudeCodeVersion=2.1.112` | `claudeCodeVersion=2.1.293` |
| 实际 CLI | 本机 `/opt/homebrew/bin/claude --version` 返回 `2.1.311`；未启动 query | 上游通过 resolved executable 启动；未核实原作者实际运行的 CLI |
| SDK／项目 Node 边界 | SDK 要求 Node ≥18；本地 package 未声明项目 engines | SDK 要求 Node ≥18；上游项目要求 Node ≥24 且 <25，测试已转 Vitest |

**SDK 自带 CLI、shell 的 CLI 与插件实际 resolved CLI 是三个不同对象。** 本地 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeQueryOptionsBuilder.ts:279–295` 显式传 `pathToClaudeCodeExecutable` 与 custom spawn；shell 版本不能证明某次插件 query 的 executable、参数或内存 bundle。

#### 1.2 动态采样，不宣称冻结

2026-11-08T08:54:34Z 核定版本；2026-11-08T09:03:38Z 重核 runtime 指纹及 Stop／归属 hunk。后一个观察点的 SHA-256 如下：

| 文件绝对路径 | SHA-256 |
|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts` | `931f1271728050ff0e7af351c29f0e64ce136d8710d907921822d60c8ca98e92` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/hooks/SubagentHooks.ts` | `f1b48ec5004ef32bb057622232e331db4280f0882be7f11a433c123d825efbba` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeApprovalHandler.ts` | `eb49092bd330659a17aeb0f56e3a35195f38d2f8a815085052669ec834efacda` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/security/ClaudePermissionUpdates.ts` | `fd459f4a130c2a9263c983ecee1da8d272ca0c5277ab43f7f3eff9a63ef9f589` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` | `99c1ce89ec7c20898dba5eee12043487ed7a7ebfe44e69a6395a4fd0e0b6dd73` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` | `cb6908cb1701fc358269f0370615c9183dadfcd03dedc3060dd4bd8ef494d5b1` |

协调方已告知命令探测 P1 正在修改 runtime 的命令缓存区域及测试。09:03:38Z 时该文件尚无相对 HEAD 的 diff，上述 Stop／归属 hunk 与先前读取一致；**这不证明其后仍不变或并发写者已经结束**。后续实施只重核相关 hunk／接口和最终整合基线，不覆盖命令缓存改动。本文行号仅对应所记采样。

证据分级：〔实测〕本轮静态读取、Git/API／版本命令／哈希核查；〔既有读数〕官方契约、既有测试定义及派单报告；〔推算〕由已读代码推导；〔纯示意〕下文构造样本。静态实测不等于真实 CLI 行为实测。

### 2. 主线到底怎么处理

#### 2.1 Stop：上游删除的是错误耦合，不是只换理由

- 本地 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/hooks/SubagentHooks.ts:7,30–53` 读取 `hasRunning`，返回 block，理由要求 `TaskOutput ... block=true`。runtime `buildHooks():1098–1128` 注册它，前三次阻断、第四次熔断。hook 没有按 `stop_hook_active` 判重入。
- 原作者 [#936](https://github.com/YishenTu/claudian/pull/936)，merge=`852b970826c606aa674bf3ec03c1b6ba2d38012c`，删除 `SubagentHooks.ts` 和该阻断测试，接入原生异步任务完成事件。此 PR 的删除 patch 已核实；不是“上游可能修过”的猜测。
- 当前固定 main 的 [ClaudeExecutionRequestEncoder.ts](https://github.com/YishenTu/claudian/blob/3e58ea7707085d40176f9762dc92fbbd07cb40b0/src/providers/claude/execution/ClaudeExecutionRequestEncoder.ts):139–188、286–341 只因只读策略注册 `PreToolUse`，没有重建这个 Stop hook。persistent／ephemeral strategy 共用该编码结果。
- task 完成由 [transformClaudeMessage.ts](https://github.com/YishenTu/claudian/blob/3e58ea7707085d40176f9762dc92fbbd07cb40b0/src/providers/claude/stream/transformClaudeMessage.ts):57–68、575–581 转成事件；[ClaudeExecutionSession.ts](https://github.com/YishenTu/claudian/blob/3e58ea7707085d40176f9762dc92fbbd07cb40b0/src/providers/claude/execution/ClaudeExecutionSession.ts):493–583 区分“任务终态”和“模型实际消费通知的位置”。不是每个 task completion 都新造一轮。
- [ClaudeTaskNotificationQueue.ts](https://github.com/YishenTu/claudian/blob/3e58ea7707085d40176f9762dc92fbbd07cb40b0/src/providers/claude/execution/ClaudeTaskNotificationQueue.ts) 用原生背景任务全量 level 判断活动；`ClaudeExecutionSession.blocksIdleRelease()` 配合 [ChatExecutionCoordinator.ts](https://github.com/YishenTu/claudian/blob/3e58ea7707085d40176f9762dc92fbbd07cb40b0/src/features/chat/execution/ChatExecutionCoordinator.ts):767–773、814–818 阻止有后台任务时自动空闲释放／静默换 session。**后台存在阻止的是资源自动回收，不是主轮完成。**

还须分清：模型结束时的 **Stop hook**、用户点 **停止／cancel**、`Query.close()`／插件卸载不是同一个行为。删除 hook 不表示 interrupt、close 或重载一定保留后台任务。

“TaskOutput 不可用”是派单已有读数，本轮没有真实 `system/init.tools`。当前 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/types.ts:336` 的 `UNSUPPORTED_SDK_TOOLS=[]`，没有显式禁掉它；源码有工具名常量也不证明真实模型工具表暴露它。根因设计不依赖确认或更换这个工具名。

#### 2.2 单次授权：当前局部修改已经借到正确语义

- 本地 main／origin main 的 `ClaudeApprovalHandler.ts:126–133` 对 allow 和 always 都调用 builder；普通 allow 会产生 session 规则。
- 实际工作区 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeApprovalHandler.ts:126–137` 已拆开：allow 仅返回 `behavior: allow + updatedInput`，不携带 `updatedPermissions`；always 仍调用旧 builder。
- 原作者 [#1493](https://github.com/YishenTu/claudian/pull/1493)，merge=`552ecf8f4c43b5c6d5eff5cb5201f8ba6053d32f`，采用单次不写规则、always 原样回传 SDK suggestions 的方向。
- 当前固定 main 的 [ClaudeExecutionInteractionRouter.ts](https://github.com/YishenTu/claudian/blob/3e58ea7707085d40176f9762dc92fbbd07cb40b0/src/providers/claude/execution/ClaudeExecutionInteractionRouter.ts):107–149 用 `非空 suggestions 且未 suppression` 决定是否展示 always；即使陈旧 UI 返回不可用的 always，也降为当前调用 allow。普通 allow 的 `decisionClassification=user_temporary` 是遥测分类，不是单次生效的必要前提；本地 SDK 已声明缺省 allow 会保守推断 temporary，勿为了对齐文本再扩大修改。
- ExitPlanMode 的明确 session `setMode` 是计划交互，不是普通 allow 扩权；本地 `ClaudeApprovalHandler.ts:52–72` 必须保留。

派单报告单次局部修复的定向单测及局部复核已通过、尚未部署，属于〔既有读数〕；本轮核实 diff 和测试定义，未重跑，不宣称最终整合或真实 CLI 已验收。**该修复不依赖 Stop、存储重构或 SDK 升级，可独立收口。**

#### 2.3 新主线可直接借鉴的原生身份，但不能照搬兼容回退

当前原作者使用 [ClaudeResponseOwnership.ts](https://github.com/YishenTu/claudian/blob/3e58ea7707085d40176f9762dc92fbbd07cb40b0/src/providers/claude/execution/ClaudeResponseOwnership.ts) 与 [ClaudeTurnInputs.ts](https://github.com/YishenTu/claudian/blob/3e58ea7707085d40176f9762dc92fbbd07cb40b0/src/providers/claude/execution/ClaudeTurnInputs.ts)：

1. `user_message_uuid/user_message_uuids` 将 reply／result 关联到实际消费的输入 UUID；stream／message／tool ID 保留内容所有者。
2. `queued_turn_count` 提供输入尚待消费的辅助证据，而不是 task 数或 result 数。
3. 输入准入、原生回复、后台任务及资源保留分开；任务通知不等于当前 host 的完成。

官方 SDK `v0.3.293` tag=`5dc91fb5ebe27e926e95d62f4b5dd7632e936e79` 已核实。另从上游 lock 指定 URL 下载 1,590,960 bytes 分发包，SHA-512 与 lock integrity 一致，静态读取真实 `sdk.d.ts/sdk.mjs`：

| 契约 | 版本／分发包证据 | 对本地的意义 |
|---|---|---|
| task notification + 可选 tool-use 关联 | 本地 0.2.112 `sdk.d.ts:2973–3045` 已有；上游早期 #936 无需当前 0.3.293 的整套架构 | 已有能力能正向解 Stop 等待问题，不应先升级才能接任务终态 |
| input UUID echo | 官方 changelog：success echo 0.3.216，error／首回复 0.3.246，批输入列表 0.3.259，synthetic／自动续轮进一步补齐 0.3.265 | 本地类型没有这些字段；不能由类型旧断言当前外部 CLI 不会发送 |
| result／queued count | 0.3.293 `sdk.d.ts:5725–5750,5758–5761`；queued count 从 0.3.243 加入 | 每个实际 CLI turn 一条 result，不是每个 task notification 一条；count 只数用户排队输入，不含系统队列，可合并，0 不是归属证明 |
| background level／run | level 从 0.3.203 加入；run 从 0.3.292 加入；0.3.293 `sdk.d.ts:3712+,6028+` | `run_id` 区分同 task 的多次 run；level 不替代任务终态或结果身份 |
| suppression 桥 | hint 从 0.3.268 加入；0.3.292 明确组织 connector suppression；0.3.293 类型及实际 can_use_tool 桥均透传 | 本地 0.2.112 的桥枚举 options，明确未传 suppression 或 requestId；扩本地 TypeScript 类型不能补出它 |
| interrupt 保后台声明 | 0.3.293 `sdk.d.ts:1794–1808` 的 `perTaskStopAffordance` 有开输入／关输入例外；本地未声明该 option | 不能把上游“主轮可结束”偷换成“点击停止也保证后台继续” |

**层次突破：旧 SDK 的消息 parser 原样 yield JSON，而权限 callback options 是枚举桥接。** 已读本地 `sdk.mjs.readMessages()` 能保留额外 JSON 字段，这是“不升级，窄适配当前外部 CLI 原生 UUID”的候选解；query 全链是否透传、当前 CLI 实际是否发送仍须 G1/G2。suppression 则已经被旧桥丢掉，两者不能用同一个“加类型兼容”办法解决。

不能直接借鉴的地方：

- `ClaudeResponseOwnership.getClaudeInputMatch():168–180` 缺字段返回 undefined；`ClaudeTurnInputs.observe():95–119` 无 echo 时首个 result 结束输入集合；session 使用 `inputMatch !== false` 接受 result。它是兼容策略，不是本地任意通知交错都安全的证明。
- 上游 task 转换仍把 stopped 映为 error，未将 `run_id` 等全部 provenance 带入 completion 对象；其 terminal／deferred map 不等于完整跨 run、跨重载账本。
- 上游 session 池、ProviderExecution 重划与测试体系不同；直接迁入会覆盖本地 QueryScope、observer、lease、watchdog 和 selector 分母裁决。特别不能顺带吸收上游 result model-window 分母行为。
- 已读上游 ownership unit／execution integration 明确使用 SDK mock／scripted query。测试注释“captured SDK order”不等于本轮取得原始实流，不从测试存在推出上游或本地已真实验收。

### 3. 路径选择与解层次

本任务两路径的正确目标一致：原生身份、任务／主轮正交、许可选择如实表达；区别是实施节奏和可验证版本范围，不另选“务实降标”架构。若后续证据迫使整体架构迁移，再单独确认路径及范围。

| 候选 | 优点 | 硬缺口 | 建议 |
|---|---|---|---|
| 只改理由／加 stop_hook_active／调熔断 | 可减少旧反馈或重入 | 仍拿后台未完成阻断主轮；不识别 result，也不保持资源 | 不作为根治；至多是另获批准的临时缓解 |
| 整体迁当前上游并升级 SDK | 已有原生事件和新接口 | 本地边界不等价；上游还有未证兼容回退；产品 ID／平台／统计等范围外变化 | 不推荐本次整体搬迁；升级可作独立能力分支 |
| **复用本地任务接收／observer／scope，补窄输入证据与失败闭环，再删除插件 Stop** | 解耦错误前提；可复用原生字段；单次修复独立验收 | 必须验证真实 wire 及有限保证范围，未知不能假成功 | **推荐** |

更上层的回避解：若用户要求“一轮必须等全部结果”，把该次工作明确组织为可核实的前台执行／汇总依赖；不要让 Stop hook 用不存在或无限等待的工具补救调度需求。短期手工不使用后台是可选使用策略，不冒称插件已实现强制禁后台。

### 4. 推荐合同与具体改动

#### 4.1 四个状态轴

| 轴 | 权威事实 | 不推出什么 |
|---|---|---|
| 主轮 H | 实际已派发输入、可绑定的 result／明确失败 | 不推出全部后台任务完成 |
| 后台 T/run | task started／updated／terminal，与 launch／session／run 可关联 | 不推出 H 已完成、完整最终正文已取得 |
| 内容／投影 | 关联后的 assistant／stream／sidecar 及 observer 事实 | 不以 DOM 在场判任务存在；summary 不冒充完整输出 |
| CLI 资源 | 当前 QueryScope、输入 fence、native background level、真实 exit | H 完成不等于可以 close；SDK Promise／EOF／超时不等于 owned 后代退出 |

首期推荐保证范围是**当前已绑定 tab/runtime 存活、配置不被静默重建的后台执行与结果接收**。关闭会话、重载、跨 renderer 保存／接续不默认纳入。现有 metadata 保存继续使用，但不新增“跨崩溃未读恰好一次”承诺。扩大范围可引用既有宽合同另批，不作为单次授权或当前域 Stop 解耦的当然前置。

#### 4.2 输入证据与 result 归属

新窄纯模块 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeNativeInputEvidence.ts` 只做 unknown 入口守卫与判定，不调用 SDK、不存业务状态：

- 读取 input UUID 单值／列表、result UUID／可选 index、queued count、message ID／parent tool ID／session、可选 resume reason；区分 absent／valid／invalid。
- 返回 host、non-host、unknown、conflict、duplicate、stale，不用耗时、任务描述、通知条数、最后活跃 tab 或裸 lease 作为正向归属证据。
- 有消费列表时，匹配实际派发的 canonical SDK UUID；批输入的最后 UUID 不一定是 H。列表缺失才看有效单值；互相矛盾的字段进入 conflict，不降级为猜测。
- queued count >0 可阻止“所有输入已消费”的猜测；它与 result_index 只能提供辅助／去重信息，不能单独证明 owner；0 不能放行 unknown。

在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts` 的 QueryScope 中保留派生 native-input binding：query epoch、native session、leaseTurnId、canonicalUuid、aliases、是否取消及终态证据。复用 `handleTurnDequeued` 的 `DequeuedTurnInfo`，不把 reserved／enqueue 当消费；binding 在 cancel tombstone 期间仍保留。现有 observe-only reconciliation 不升权，也不建第二持久身份库。

路由固定次序：scope 资格 → 去重／冲突 → task 事实 → replay／输入与内容证据 → result owner → cancel fence → host 正文／usage／结算 → feature handoff／下一输入。具体要求：

1. `user origin=task-notification`、shouldQuery=false 或 queue enqueue 不再设置“跳过下一 result”标志；删除 `notificationResultPending` 及所有复位／旧预期。
2. task notification 在有／无 host lease 时只处理任务事实，不造 auto lease。native user replay 可带消费通知，先提取需要的事实再去重，不整包先丢而漏接。
3. 非 H result 不写 H usage、不卡 H 的已证 result；H result 必须绑定 H 才调用 `settleTurnAtResult`。取消后也先判 owner，非 H result 不解除 H tombstone。
4. 首回复 echo 可为后续同 message ID／stream／tool ID 建立内容所有者；已有消息中途到达的新 echo 不重标旧消息。归属不足的正文不混入 H；继续复用 transcript observer 恢复／投影，不从 stdout 再造一套 auto 生命周期。有渲染缺口要可见，不能静默丢帧后声称完整。
5. unknown 保持输入 fence，并显示“无法确认本轮结果归属，后续输入仍暂存”；用户可继续等／明确取消或重建。**不能调用当前通用 `cancelTurn(..., error)` 后顺便释放未知 channel**。现有 120 秒 watchdog 的观测节奏可复用，unknown 不因此自动 stopTask 或透明重发；若需终止／重建，由明确用户动作进入当前域 exit-confirmed 路径。
6. 普通错误、已证 scope 死亡、用户取消与 cold EOF 要有明确结果。扩 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/types.ts` 的 `ChatTurnMetadata.completionOutcome`（completed／failed／cancelled／unverified）。`InputController` 对该字段有值时只在 completed 报成功，不能只看 generator 自然耗尽。其他 provider 缺此可选字段保留原合同；auto 投影收到显式非成功也不发成功提示，但不在本批重划 observer 的所有结算依据。

cold 路径目前文本是 string prompt、图片 generator 无显式 UUID，不能照套 persistent gate。在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeUserMessageFactory.ts` 复用现成 SDK user-message 工厂；cold 使用单条带 UUID 的 iterable，记录实际 handoff，保留图像／editor／权限／resume 语义。无 result EOF 为 unverified／failed，不是 completed。真实 one-shot 是否持有后台结果须独立验收，不能从 persistent 样本推断。

#### 4.3 任务接收与资源保留：只补当前闭环

新 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeTaskEventAdapter.ts` 做 task／level 的纯守卫归一化；如果其他已批准实施先落同职责模块，复用并合并这一子合同，不另造平行入口。当前未见该模块，不能登记为已存在能力。

- 扩既有 `SubagentTaskNotificationHandler` 为结构化事件，runtime 和 Tab 两端一起改；保留 native session、task、tool-use、可选 run、raw terminal kind、summary、skip／ambient 三值、接收 scope。短同步接收，不在 SDK consumer await 长 sidecar 轮询。同事件只归约一次，不并行触发新旧 callback 双销账。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/services/SubagentManager.ts` 仍是子代理领域真相。优先关联 launch tool-use ID；task／agent 别名须唯一并属于同 session/run。早终态、重复终态复用现成缓存／索引和状态变化链；terminal 不被晚 running 复活。缺 run 且同 task 多次执行时标 ambiguous，不凭“只有一个 running”绑定。通用 Bash／MCP／monitor 不因 task_id 相同结构就变成子代理。
- stopped 可以保留既有 error 配色，但原生 stopped 不能被抹成普通失败或成功；在既有 `SubagentInfo/subagentData` 中增量保存任务 identity／terminal provenance，旧条目身份未知仍可历史显示，不批量重写。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts` 接收前核 fixed runtime、conversation 原对象、binding generation 和 native session；每次异步提交再核。首轮尚未建立 conversation 绑定时按原 runtime/session 暂存，不按当下 tab ID 猜归属。
- 当前活动会话至少显示“本轮完成，后台仍运行 N 项”以及任务 completed／failed／stopped／待核摘要；parent DOM 未挂载也不等下一个 host result 才提醒。复用状态区域／子代理卡片，不新建通用 tasks panel、不新开桌面／手机通知政策。完整正文未核时注明“终态已到，完整结果未验证”。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/StreamController.ts` 继续 merge-by-tool-id、clamp 与有界重试；sidecar identity／run 不明确时不把最后 assistant 文本当当前 run final。终态与内容补全分轴，不因读失败重新 running。
- 复用 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts:408–423` 的 subagentData 合并及已有保存链；Promise resolve 可能是 non-READY skip，不写成保存 ACK。保存失败／未确认在当前域可见 dirty，重放／下次保存恢复仍须实测。首期不以此宣称可靠跨重载通知；若要求该保证，再接宽范围 writer/attention 合同。

后台 level 是 **CLI 资源活动快照**，不是第二子代理终态库。`background_tasks_changed` 经验证后可让 QueryScope 的 busy／idle／unknown 快照替换旧 level；ambient 不计普通活动。缺 level 是 unknown，不是空集合。当前 scope 的原生 level 和子代理只读快照供自动重建判断，不根据 2 小时年龄推定真实任务已经死亡。

本地尚无上游同形的空闲 session 池，不新建池。保留现成 persistent consumer；在 `executeDeferredRestartIfAny`／自动 config replacement 入口补当前域保留条件：有已证后台活动或相关存活性未知时，不因 H 完成自动 close。设置需重建则显示“待后台结束后应用”，或由用户明确选择中断后应用，不能静默用旧配置发送。显式 reset／close／reload 可能终止后台，要告知；跨 runtime/client 启动互斥与热接续仍另批。

#### 4.4 移除插件 Stop 与授权扩展边界

- 当前域 gate 通过后，在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts` 的 persistent 与 cold 两条路径一起删除本插件 Stop 注册、熔断字段／提示／复位；删除 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/hooks/SubagentHooks.ts`。不改用户／项目 hooks，也不把 `hooks={}` 当成全局禁用配置。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeQueryOptionsBuilder.ts` 的 hooks context 可选、按实际自带 hook 传递；settingSources 等不变。
- `setSubagentHookProvider` 现名可暂留兼容，watchdog 继续复用 `getRunningAsyncAgents()` 只读 snapshot，不因删 Stop 全删该接口／候选。`hasRunningSubagents()` 的年龄清理只为旧 hook 服务，本批不得移成新的 liveness 判据。
- watchdog 120 秒／15 秒／5 秒等旧参数及原候选范围不扩大；但“数值不改”不是安全证明。验证正常后台任务不被当作 H 的失败原因；unknown owner 分支不得借恢复链结束合法后台任务。
- 单次 allow 原修复保持，deny／cancel／Ask／allowedTools 与 ExitPlanMode 回归。always 是用户政策选择，未裁决不重做。选择原生记忆授权后才删除旧 `ClaudePermissionUpdates`：完整 suggestions 原样回传，不改 destination／behavior／顺序、不补工具规则；缺建议或不可持久化时降一次。UI 和返回共用同一 eligibility。
- 旧 SDK 无 suppression 桥：可选仅单次，或用户明确接受无组织 suppression 保证的 native-legacy always；若要求该 hint 真正生效，SDK 升级须单独获准，静态／假 transport／真实受限请求分别验证。不私接 control 通道、不改 node_modules，不自动清理既有授权。

### 5. 有条件阶段与依赖

| 阶段 | 可做／可验 | 启用门与阻断 |
|---|---|---|
| S0 本轮研究 | 固定主线、源码／版本／桥边界、候选合同 | 已完成静态取证；没有真实运行通过结论；工作区仍动态 |
| S1 单次授权独立收口 | 保留已改 allow、最终基线定向回归，核 ExitPlanMode／always 未被误改 | 不等 Stop 或存储；部署仍需用户批准，不能把其余 always 风险说成已修 |
| S2 输入／任务证据观察 | pure guard、派生 binding、真实 installed SDK＋fake transport 保真；observe-only 比较当前判定 | G1 证明旧桥是否保留新字段；不因合成顺序跑绿开新结算／删 Stop |
| S3 当前域窄闭环 | result／cancel fence、cold UUID、显式失败 outcome、任务关联／当前可见摘要／自动重建保留 | 确定性生产链红绿，当前域保证／unknown 暂存策略获用户确认；没有宽生命周期前置 |
| S4 真实 CLI 有界取证 | 授权后的独立测试环境，baseline／candidate，主轮先结束、后台后结束、通知折叠、下一输入、cancel／exit | G2 关闭实际 resolved SDK/CLI 的必要证据；没捕到多通知变体标未验证，不循环烧预算 |
| S5 删除插件 Stop／小范围发布 | 仅切经验证组合和入口；回归用户 hooks、后台接收、selector 统计、observer／queue／death settlement | G1/G2 与当前域合同全过；未知版本／关键入口未测不得默启；全局重载保证不是本批验收标语 |
| 独立可选 | always 政策／SDK 升级；可靠跨重载 attention／writer；跨 client 资源托管 | 各自授权与门，既不能偷带实施，也不反过来阻断独立 once 修复 |

若当前 CLI 实流不提供可用 input bridge，S2 得到有效负结果：当前组合不启新 Stop 解耦／结算，回报“需升级或采用明确前台策略”的窄选择。不能改成 bool→counter、固定延迟、按下一个 result 猜，也不能直接断言必须重写所有生命周期。

### 6. 方案推演

#### 6.1 具象走查与规则迁移〔全部纯示意，不是 CLI 事故〕

锚值：H 的实际 canonical UUID=`h1`；通知输入=`n1/n2`；背景 task=`t1`。每行列出的“result 属谁”由样本字段或显式假设给出，不从模拟输出倒推真实 SDK 时序。

| 同一对象／样本 | 当前旧规则 | 推荐规则 | 红／绿判据 |
|---|---|---|---|
| 后台仍 1 项，H 的 result 消费列表=`[h1]` | Stop 先最多 block 3 次；第 4 次才放行 | H 可完成，后台仍 1 项，query 保留 | 绿：H 成功 1、后台运行 1；红：H 完成使后台误销或 close |
| task user echo `shouldQuery=false`，随后仅 H result=`[h1]` | bool 置 true，丢掉 H 的唯一 result | echo 不武断另开轮；H result 正常绑定 | 绿：H 结算 1；红：H 结算 0／须另一个假 result |
| 两通知 echo，result 列表依次 `[n1]`、`[n2]`、`[h1]` | bool 只跳第一条，第二条可能误结 H | 前两条 H 结算 0，第三条 1 | 红：第二条报 H 成功；绿：H 正文／usage 不混通知轮 |
| 单个折叠 result=`[n1,h1]` | 可能因 flag 跳掉 | 消费列表包含 h1，可结 H，不按“最后一个”排除 | 绿：H 成功 1；红：通知和 host 固定必须各有 result |
| H 已取消，N result=`[n1]` 先到，另 1 条用户输入暂存 | cancel tombstone 在 owner 前遇 result 解锁 | N 不解 H fence，新输入派发 0 | 绿：归属未明前 dequeue 0；红：任意 result 解锁 |
| bare result，无 UUID，queued count=0 | active lease／兼容回退可能当 H | unknown，可见暂存；0 不作正向证明 | 绿：H 假成功 0；红：按唯一候选或超时认成功 |
| t1/run1 terminal 先于 launch；重复 2 次；run2 后来 running | taskId early cache 可把不同 run 混用 | 绑定同 session／launch／run；重复幂等，歧义显式 | 绿：run1 terminal 1，run2 不被旧终态结束；红：terminal 使别的 run 复活／销账 |
| task terminal 已到、host 无 result、parent DOM 卸载 | turn completion 提示不会由此必然触发 | 任务摘要独立可见，不造 H success／auto turn | 绿：任务状态可见 1，host success 0；红：等假 result 才让用户知道 |
| 通知接受后 C1→C2，sidecar 再返回 | mutable session／currentConversation 有污染风险 | frozen C1 原对象／runtime／generation，提交重核 | 绿：C2 变更 0；红：旧内容投影或保存到 C2 |
| SDK 建议 2 条：localSettings rule＋session directory；点击 once | main 旧规则产生 updates；当前局部修复为 0 | once 更新数 0、字段不存在；保持 input 引用 | 绿：0 规则副作用；红：once 返回 session rule／目录更新 |
| 同建议点击 eligible always | 旧 builder 重写 rule 到 projectSettings | 2 条建议 deep-equal，顺序／目的地不变 | 绿：只表达这次 native suggestions；红：补整工具规则 |
| 无 suggestions／suppression=true，陈旧 UI 返回 always | 旧 builder 可自造规则；旧桥看不到 suppression | 选定政策后，UI 与响应同门槛，不更新权限 | 绿：更新数 0；红：只隐藏按钮但 handler 仍写规则 |

默认值最不利：缺 echo／run／level／suppression 桥、cold EOF、无 attending user、old query late event。分别退化为 unverified／ambiguous／unknown／明确政策分支／非成功／现有 ask 约束／stale，不退化为默认成功、后台空闲或“组织无限制”。

#### 6.2 论证链与反例

1. **Stop**：已读 hook 将 hasRunning→block → 主轮等待后台完成 → 任务原生完成可独立接收、query 可继续存在 → 去该条件可解除错误耦合。隐含前提是接收／当前资源继续存活。反例：H 完成后 deferred restart close 同 query；删 hook 仍会丢后台，本稿因此补当前域自动重建保留，不承诺所有重载已安全。
2. **单次**：普通 allow 返回权限规则 → 后续同范围操作可能不再询问 → single invocation 被扩张；去 updates 可避免插件新增扩张。反例：已有用户 allow 或 bypass/acceptEdits，本来不进 callback；修返回值不能保证所有工具必定再弹窗，也不撤旧规则。
3. **原生输入身份**：实际派发 UUID＋同 scope 的 result 消费列表包含它 → result 可关联 H → H 结算不依赖通知数。反例：字段缺失、无效、跨 scope 或 delivery-failure result 仅有不同语义单值；不能从正文归属或 list 的名字推全保证，须分支守卫与实流验证。
4. **旧 SDK 可复用**：parser yield 完整对象 → 新 CLI 字段可能穿过旧传输 → 小适配可能免升级。反例：实际 query 层过滤字段／resolved CLI 根本未发送；G1/G2 会证伪。权限桥反例已静态成立：枚举 options 丢 suppression，不能借消息透传结论推它也能工作。

不翻改既有记录。前向反事实：保留 block／只换文案，错误等待仍在；直接全抄上游 missing-echo fallback，同样没有本地实证；只删 hook 但 H 完成即 close，后台接收仍不成立。

#### 6.3 结构不变量判定

- **正交性**：当前 `SubagentHooks.hasRunning→block` 违反主轮／任务分离；目标将任务终态、主轮 result、content completeness 和 query lifetime 分轴，成立位置为上述四合同。若 task notification 调 host onDone，立即违反。
- **无环**：native evidence→scope binding／任务归约→projection／保存；不得 task callback→补发 prompt→再通知。observer 是现成 auto 入口，不与新 stdout 判定器双建轮。
- **扩展方向**：wire 变化在 Claude pure adapter；features 消费中立事实／可选 outcome，不按 SDK 版本猜语义。scope map 是派生索引，不是第二任务库／新全局 owner。
- **退化**：无 DOM、缺字段、cold、无通知、失败／取消走同合同的不同状态；UUID 缺失为 unknown，不恢复“第一个／下一个 result”支路。
- **入口覆盖**：目前不能判全成立。persistent／cold／recovery × task／content／result／cancel／exit；user／auto／subagent × once／always／Ask／ExitPlanMode，必须逐格给 pass/fail/N/A，见验证。单次切片没有 Stop／writer 前置；当前域自动重建 gate 不推出跨 client 热接续，依赖无环。

### 7. 交付物规范

本轮只有新设计记录，无新业务数据或生产代码。以下新增代码／测试／fixture 均是获准实施后的目标，不预建。

#### 7.1 新增目录树，绝对根锚定

```text
/Users/vincentwang/Documents/NoteVault/tools/claudian/
├── docs/designs/2026-11-08-claudian-mainline-stop-once-adoption-gates.md
├── src/providers/claude/runtime/
│   ├── ClaudeNativeInputEvidence.ts
│   └── ClaudeTaskEventAdapter.ts
├── tests/unit/providers/claude/runtime/
│   ├── ClaudeNativeInputEvidence.test.ts
│   └── ClaudeTaskEventAdapter.test.ts
└── tests/integration/providers/claude/runtime/
    ├── NativeInputEvidenceTransport.test.ts
    └── fixtures/mainline-stop-once/
        ├── evidence-manifest.json
        ├── native-input-wire.jsonl
        └── task-wire.jsonl
```

fixture 子目录只在获准 G1 实施时建立；同名模块若已有获准实现，合并职责／测试，不在另一目录复刻。Stop 文件删除和其他扩展落既有路径。

#### 7.2 命名与 README 索引

- `ClaudeNativeInputEvidence`：原生输入关联证据，不是完整 execution framework；`ClaudeTaskEventAdapter`：任务／level 守卫，不存第二生命周期。
- `NativeInputEvidenceTransport`：真实 SDK＋受控假传输，名字不称真实 CLI；JSONL 文件名表明 wire 渠道，不能拿 transcript 冒充 wire。
- manifest 逐例登记 `sourceKind=synthetic/fake-transport/real-wire/real-native`、SDK／实际 CLI／构建／options 范围、同盐 identity join、字段删留、完整性／截断边界、哈希、证明项与不证明项。hash 不是时序保证。
- 获准落地后向 `/Users/vincentwang/Documents/NoteVault/tools/claudian/README.md` 增加本设计及测试／fixture 产物索引；本轮不改 README。

#### 7.3 产物及消费者

| 绝对路径／组 | 用途 | 消费者 |
|---|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-08-claudian-mainline-stop-once-adoption-gates.md` | 独立 draft，主线证据、用户选择、窄切片／阻断条件 | 用户、主会话、architect、implementer、reviewer |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeNativeInputEvidence.ts` | 纯输入／结果证据 guard 与判定 | Claude runtime、unit／transport 回归 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeTaskEventAdapter.ts` | task／level 归一化、保留身份与终态来源 | runtime、既有任务接收链 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/ClaudeNativeInputEvidence.test.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/ClaudeTaskEventAdapter.test.ts` | 明确失败／缺省／批输入红测 | Jest unit、独立复核 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/providers/claude/runtime/NativeInputEvidenceTransport.test.ts` | 绕过全局 SDK mock 的实际旧 SDK 保真链 | Jest integration、G1 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/providers/claude/runtime/fixtures/mainline-stop-once/` 下上述 3 文件 | 可追溯合成／假传输／获准脱敏实证样本 | transport／runtime／history 对拍 |

一次性原始 stdout／transcript／SDK 包仅在各自新建 `/tmp` 目录，敏感 raw 不入 repo、不作为交付物；本轮不清理临时材料。真实验收 harness 如确需正式沉淀，另定 `dev/` 名称、调用／预算／退出合同，当前不虚构已存在执行入口。

#### 7.4 归属与偏离

沿用 `/Users/vincentwang/Documents/NoteVault/tools/claudian/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/CLAUDE.md` 的 provider-native-first、中立边界、mirrored tests、TDD、生产禁止 console、既有正式 `docs/designs` 与 `dev/` 归属。

临时材料走派单 `/tmp` 约定，优先于项目一般 `.context/`；不新建业务数据根、日志库或生命周期数据库。项目尚无此证据 fixture 索引规范，本节为雏形，获准落地后回填 README。除此无主动目录偏离。

## 风险与权衡

### 用户需拍板

1. **主轮产品语义**：推荐“主轮可完成，后台状态独立可见”；若需等全部汇总，明确该次前台／汇总依赖，不借 Stop 反复阻断。
2. **首期保证范围**：推荐先当前绑定 runtime 存活域；是否另要求关闭 tab／插件重载后继续、持久未读／桌面通知／多 renderer 去重？后者是独立扩展，不能既不确认又宣称已有。
3. **未知归属策略**：推荐显式暂存后续输入，等待／用户恢复，不自动杀任务或重发；是否接受对应可用性下降，以及更改配置有后台时延后生效？未裁决不启新结算分支。
4. **always**：仅单次（推荐安全候选）、native-legacy 且接受旧 SDK 无组织 suppression 保证、或单独升级验证。单次补丁不构成隐藏 always／升级／清规则授权。
5. **真实验收**：独立测试目录、凭证来源、允许工具／hooks、模型与费用总上限、会话／场景数量和最长时间；未授权不启动。真实组织 MCP suppression 另授权，当前没有该端实证。

### 迁移／落地代价与范围

当前域窄切片仍有跨文件正确性耦合：input factory／channel／runtime／outcome／task callback／UI 必须一起接线；漏改 cold 或 cancel 仍会错结算。它不要求整体 session 池迁移、storage writer／delete／热重载大改或命令发现返工。若现有保存链不能提供某项保证，先缩清该项声明／补其窄写点，不能把“全存储重构”默认变成本次全部工作的前置。

SDK 升级如另获批准，要处理 0.3.293 的 peer dependencies（含 Anthropic SDK ≥0.93.0，而本地为0.81.0）、平台包拆分、callback 可返回 null、新 options／env／取消契约和打包；不只改版本字符串。不能把借鉴上游模型 usage／context window 行为混进来。

### 回退与部署阻断

- 单次回退产物须保留 once 无 updates；不能回到当前 main／旧部署 bundle 然后称授权仍安全。已经写入的规则不会被 bundle 回滚撤销，清理须另授权。
- 当前域切换失败先暂停新后台／新结算能力、保留历史与明确恢复；不能恢复 bool/counter 后称根治。若临时恢复旧 Stop，要明示重新引入旧等待缺陷。
- 新 optional 任务 provenance 需旧记录兼容读取；不批量删字段或迁成确定 run。跨重载 schema／保存未获保证时，不以旧 bundle 全量写回来“回退”。
- owner 冲突、主轮假成功、通知 usage／正文混入 H、非 H result 解除 cancel fence、unknown 自动 stopTask／重发、旧 session 污染新 conversation、cold EOF 报成功：任一即阻断 S5。
- 正常 H 完成触发自动 close 丢后台、用户 hooks 被禁、真实 stream 未捕获、依赖版本／resolved CLI／内存 bundle 未核定、关键入口缺测试、单次回复带规则、always 政策未裁决却改行为：阻断对应批次。
- runtime 文件正在并发命令缓存实施；integrator 必须先确认最终写入边界／diff／untracked 基线。不得 stash/reset/checkout 覆盖他人改动；此次采样不替代最终审查。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/esbuild.config.mjs` 会读 `.env.local`，并在 OBSIDIAN_VAULT 存在时复制产物。构建本身会写文件；默认不得让测试 build 自动复制活 vault。部署／重载另批准，并记录磁盘 bundle 与内存加载身份；源码 hash 不证明实际加载。

## 验证方式

### G1：无模型的保真及生产链回归

本轮未运行。获准实施后先红测，mock 只替 SDK 输入／文件故障／进程传输，不能 mock 被测归属、任务归约、settlement 或 UI 成功判定。

- 复用 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/providers/claude/runtime/CliDeathSettlement.test.ts:20–30` 的 absolute-path real SDK 加载模式，绕过 Jest moduleNameMapper；新增 transport 测试优先用受控 SpawnedProcess／流，不需真实 CLI／模型／MCP。
- 证明 0.2.112 的真实 query delivery 是否保留 UUID 单值／列表、queued count、run、level 等字段；权限控制桥另证明 suppression 丢失与候选升级桥的透传，不把两条证据混用。
- 记录合成／fake-transport 来源。该门只证明 host/SDK 传输与实现面对给定输入的行为，不证明真实 CLI 发这些字段、时序分布或覆盖率。

| 入口／机制 | 必经生产链与测试路径 | 可观察验收 |
|---|---|---|
| allow once | `ClaudeApprovalHandler → runtime.createApprovalCallback → PermissionResult`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/ClaudeApprovalHandler.test.ts`、`ClaudianService.test.ts` | suggestions absent／非空都无 updates；builder 调用0；ExitPlanMode setMode仍在 |
| always 政策 | handler→`InputController.handleApprovalRequest`→陈旧／正常响应；扩上述 suites及 InputController suite | 选定政策 UI／返回同 eligibility；native建议 deep-equal；abort／迟答不作用新请求；无真实 MCP |
| input／result | installed SDK→pure guard→实际 channel dequeue／runtime→waiter／projection→completion | §6全部样本；H done／usage／新dequeue逐项；无echo不由计数补归属 |
| cold／resume／recovery | 同 user-message factory，实际 cold query及 scope retry；`QueryOptionsBuilder.test.ts`、`MessageChannel.test.ts`、`ClaudianService.test.ts` | 文本／图片UUID保真；enqueue≠消费；合并aliases／unsentqueue保留；EOF／error不是success |
| task／无DOM | adapter→Tab→SubagentManager→既有 state-change／summary；`/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/services/SubagentManager.test.ts`、`StreamController.test.ts`、`Tab.test.ts` | early terminal／重复／wrong session／run／skip／generic任务；0 result仍有可见task状态，H success 0 |
| 正文／observer | native echo／message id／tool parent→transform／现有 observer及AutoTurnProjection | H正文归属及去重；通知不双造auto；SDK wire与native同对象对拍；sidecar不冒充不明run final |
| cancel／资源 | runtime owner→tombstone→原query scope exit／queue；扩 `turnLeaseRelease.test.ts`、`turnResultWatchdog.test.ts`、`CliDeathSettlement.test.ts` | 非H result不解锁；late scope不碰新scope；normal H完成不close；自动config变更有bg不静默重建；exit未明不启动替换 |
| UI成功 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/controllers/InputController.test.ts`、`AutoTurnProjectionController.test.ts`、`TabManager.test.ts` | failed/cancelled/unverified不发streamComplete；task状态不冒充host/全部任务完成 |
| 回归 | 本地现有history／branch／model selection／其他providers；命令缓存P1最终整合 suites | selector分母／usage既有裁决、原auto lease、fork/rewind、命令缓存变更不被覆盖；其他provider可选字段等价 |

本地测试入口 `/Users/vincentwang/Documents/NoteVault/tools/claudian/scripts/run-jest.js` 默认使用 `os.tmpdir()/claudian-localstorage`，不要多个验证会话共享它。后续 runner 建独立 TEST_ROOT 并设置 TMPDIR；审查 setup／import，确认不读写活 vault 或启动真实 provider。定向先跑，再全量：

```bash
env TMPDIR="$TEST_ROOT/tmp" npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run test -- --selectProjects unit --runInBand --no-cache --runTestsByPath /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/ClaudeApprovalHandler.test.ts /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/ClaudianService.test.ts
env TMPDIR="$TEST_ROOT/tmp" npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run test -- --selectProjects integration --runInBand --no-cache --runTestsByPath /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/providers/claude/runtime/NativeInputEvidenceTransport.test.ts
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run typecheck
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run lint
```

`TEST_ROOT` 为获准 runner 新建的绝对临时目录，`tmp` 必须存在；不是本轮执行参数。测试脚本／cwd／SDK absolute import 的实际约定最终整合时重核，不用本稿命令宣称已通过。build／部署不在本轮，也不由上述测试自动获准。

### G2：真实 CLI 验证隔离、预算与证据限度

**当前门未关闭。** 开始前用户明确批准以下项目，缺一不运行：

1. 新建独立 `/tmp/claudian-stop-once-live-<时间戳>/`，分别放测试 vault、配置、原始材料；凭证采用用户批准的独立来源，不复制整个 `~/.claude`／真实 vault 配置，不输出秘密。
2. 捕获实际 resolved executable／version／hash、installed SDK／hash、source/build、输入形式、permission mode、tools、settingSources、spawn参数和 query epoch。干净 settings sources、无插件／MCP、仅允许核定的安全本地工具；可用的 `strictMcpConfig:true + mcpServers:{}` 等先经 G1验证。用户hook回归用sandbox内无外部副作用的自有hook，不加载真实vault hooks。
3. 明确总费用上限、场景／query数量及最长时间。建议首批至多3个隔离会话，每会话至多2个后台子任务，串行；这里只是预算候选，不是运行授权。maxTurns不是总模型调用/费用上限；核 maxBudgetUsd 是否覆盖后台/自动续轮，并在harness累计总支出、控制新增请求。捕不到合并通知时标未覆盖，至多另申请一次补样，不无限诱导。
4. 超时只关本次证明拥有的测试query/进程；真实exit和owned后代分别核查，绝不pkill、找全机MCP或中断其他session。close可能停止测试任务，其副作用也须授权；“独立/tmp”不自动保证进程资源隔离。

最小实证靶子：

- once：用测试权限配置强制安全动作经过 callback，连做2次，捕返回的control_response、callback数量与测试权限文件差异。普通allow没有规则更新；已有规则／自动许可的工具不拿弹窗次数冒充单次契约。
- Stop：baseline与candidate有明确构建/opts差异；H先结束，任务后结束；任务先结束/通知被折入H；新H输入与旧后台续轮交错；cancel后非H result/late output；真实用户hook仍执行。核 H成功/任务终态/lease release/query exit是四个不同计数。
- 同对象join：stdin canonical UUID→SDK delivery→assistant/stream/result→native transcript；task launch/tool-use→task id/run→terminal→卡片。raw wire与native transcript各有sourceKind、同盐键、完整行/截断说明；不能只拿transcript推SDK stdout。
- 资源：H正常完成后同query继续接收task；deferred配置变更不会静默close；明确停止/关闭的效果诚实记录。first release已证不等于跨plugin/client热接续或全部后代已退出。

几个真实样本只证明所记SDK/CLI/build/opts和案例，不证明任意乱序、失败率或所有模型/平台。若全部采样都没有可绑定result字段，或关键cancel/cold形态无法对拍，保留No-Go/未验证，不从纯示意升级为事故或上线保证。

### 交付验收

本轮可验收的是：三个主分支身份/commit、当前实际源码/旧桥与固定上游差异、独立draft、已明确的用户选择及G1/G2阻断。不可验收为“Stop已修”“真实SDK时序已证”“always组织限制生效”或“可部署”。高影响控制切片可由另一 architect 独立挑硬伤；实际实施后按项目规范由 reviewer 复核。

## 关联

- [[tools/claudian/CLAUDE]]
- [[tools/claudian/docs/designs/2026-11-07-upstream-compat-stop-permissions-discovery]]
- [[tools/claudian/docs/designs/2026-11-07-upstream-compat-evidence-closure-supplement]]
- [[tools/claudian/docs/designs/2026-11-08-upstream-compat-remaining-implementation-contract]]
- [[tools/claudian/docs/designs/2026-08-21-Claudian-Stop-hook自激循环修复方案]]
- [origin仓库身份](https://api.github.com/repos/vincent101/claudian)，[upstream仓库身份](https://api.github.com/repos/YishenTu/claudian)
- [本地/远端main commit](https://github.com/vincent101/claudian/commit/1ab2ab831700b2833aae3f40b4ca5a49b7d1fa1e)，[原作者固定main commit](https://github.com/YishenTu/claudian/commit/3e58ea7707085d40176f9762dc92fbbd07cb40b0)
- [#936](https://github.com/YishenTu/claudian/pull/936)，[#1493](https://github.com/YishenTu/claudian/pull/1493)，[#1551](https://github.com/YishenTu/claudian/pull/1551)，merge分别为 `852b970826c606aa674bf3ec03c1b6ba2d38012c`、`552ecf8f4c43b5c6d5eff5cb5201f8ba6053d32f`、`7c41ac0e798125186474ce315f2bcac80185cf10`
- [SDK v0.3.293发布](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.293)，[该tag固定commit的CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/5dc91fb5ebe27e926e95d62f4b5dd7632e936e79/CHANGELOG.md)
