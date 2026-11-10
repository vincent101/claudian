---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - claudian
  - upstream-compatibility
  - lifecycle
  - permissions
---

# 上游兼容修复吸收：Stop hook → 授权语义 → 命令探测

## 背景与问题

吸收上游 #936、#1493/#1551、#1359 的正确语义，消除过时 Stop 阻断、授权范围扩张与不可见命令发现失败，同时保留本地任务销账、会话/turn 身份、sidecar 恢复、query lease、watchdog 和多 provider 边界。

> [!warning] 待确认设计，不是实施授权
> 路径为 `[理想]`。本轮只读源码、测试、已存在记录和 GitHub PR；只新建本设计记录。不修改插件代码、配置、测试、既有设计记录，不 fetch、合并、提交、启动插件、运行构建或调用模型。其他顶层 session 仍在开发；以下基线是动态观察，不是最终实施基线。

## 方案设计

### 1. 基线、证据与解层次

#### 1.1 动态基线

- 独立仓库：`/Users/vincentwang/Documents/NoteVault/tools/claudian`。
- 观察 commit：`cf47730d2109e798fd27ddacc712038d26883d5b`；分支 `fix/model-identity-sorting`。
- 截止观察点：2026-11-07 11:14:47 UTC，设计记录新建前；36 个 tracked 修改、21 个 untracked。读取期间清单发生变化；不能把 HEAD 等同于实际工作树，也不能假设本轮所读内容最终保留。
- 与本方案交叉的脏文件包括：
  - `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/SessionStorage.ts`
  - `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts`
  - `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/types/chat.ts`
  - `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ClaudianView.ts`
  - `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts`
  - `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/rendering/MessageRenderer.ts`
  - `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts`
  - `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabBar.ts`
  - `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/types.ts`
  - `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts`
  - `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeTranscriptHistoryIndex.ts`
  - `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkBranchFilter.ts`
  - `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptDiagnosticLog.ts`
  - `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts` 及 10 份 locale、i18n 类型、相应测试。
- 本轮不锁文件、不备份/暂存他人改动、不停止他人进程。以下指纹是某次读取的定位凭据，不是冻结承诺。

| 绝对路径 | SHA-256，观察点前 16 位 |
|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts` | `931f1271728050ff` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeApprovalHandler.ts` | `c899d6359793f49c` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/hooks/SubagentHooks.ts` | `f1b48ec5004ef32b` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/probeRuntimeCommands.ts` | `e1d8f94bf95af702` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/ClaudeCommandCatalog.ts` | `73a4d82fb51d5b6a` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/ChatRuntime.ts` | `939061d172d4371c` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/types.ts` | `be6cc72496342e7f` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts` | `d049cebb809882c2` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/StreamController.ts` | `74bdab11b3bb7b90` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptTurnMapper.ts` | `7b94089c26345f62` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/shared/components/SlashCommandDropdown.ts` | `817532ad1e00c054` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` | `99c1ce89ec7c2089` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` | `cb6908cb1701fc35` |

#### 1.2 核实的契约与边界

证据等级：〔实测〕本轮安全只读核查；〔既有读数〕PR/既有记录报告；〔推算〕由所读机制推出；〔纯示意〕设计案例。均不等于实施后实证。

1. **Stop 阻断确实存在。〔实测〕**
   - `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/hooks/SubagentHooks.ts:7,42-49` 在 `hasRunning` 时返回 block，理由要求 `TaskOutput ... block=true`。
   - `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts:1098-1128` 注册 Stop hook；前三次阻断，第四次尝试熔断放行并通知。熔断不是任务生命周期终态。
   - 从 `/Users/vincentwang/Documents/NoteVault/.claudian/sessions/` 最近 8 份元数据关联到 7 份不同 Claude transcript，每份只读最后至多 4 MiB。CLI 2.1.311 记录中有 120 条开头为 `Stop hook feedback:` 且携带上述旧理由的反馈；254 条 queue task-notification，165 条 user notification-origin。抽样不是全量失败率，不建立阻断与任务数的一一对应关系，不导出会话 ID、正文、路径和凭证。

2. **SDK 0.2.112 已支持任务流，不需要同名 SDK callback。〔实测〕**
   - `/Users/vincentwang/Documents/NoteVault/tools/claudian/package.json` 声明 `^0.2.112`；lockfile 与已安装包均为 `0.2.112`，声明并非精确 pin。
   - 本机 `/opt/homebrew/bin/claude --version` 为 `2.1.311`。这不证明每个插件 query 都使用同一 CLI；最终验收须记录实际 resolved executable/version。
   - 已安装 `/Users/vincentwang/Documents/NoteVault/tools/claudian/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2973-3044` 含 `task_notification/task_started/task_progress/task_updated`；notification 有 `task_id`、可选 `tool_use_id`、`session_id`、`output_file`、`summary` 和 `completed/failed/stopped`。
   - #936 的 `setAsyncSubagentCompletionCallback` 是**插件新增契约**，由 `system/task_notification` 转换而来；不是要求 SDK 新增同名配置回调。该 PR 没有修改依赖文件。
   - 当前 CLI 2.1.311 的真实 user origin 有 `runId`、`producer`；其中 159 条同时有两者，另有兼容缺字段形态。本地 SDK 的 `SDKMessageOrigin` 类型只声明 `kind`；transport 的 `readMessages()` 解析后直接 yield 对象。可在 provider 边界守卫真实额外字段，不应改 node_modules 或靠 `as any` 伪造能力。SDK wire 全链透传仍须用 transport fixture 验收，transcript 不是 SDK stdout 的替代品。

3. **已有能力可以直接解题，不另造生命周期真相。〔实测〕**
   - 本地已有 `dispatchTaskNotification` → `setSubagentNotificationHandler` → `SubagentManager.handleTaskNotification` 直接销账和提前终态缓存；已有 sidecar merge-by-tool-id、running 只读工具明细、terminal 才读最终结果、投影 clamp。
   - `QueryScope` 已隔离旧 query；query retirement 保留未派发队列并确认真实 CLI exit。不能倒退成 #936 较早的仅比较 query 指针。
   - `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts:235-250` 已有 `mergePersistedSubagentState` 与 providerState 序列化。优先扩展 `subagentData`，不新建第二份状态数据库。
   - turn reconciliation 当前是 **observe-only**。不能因名字合适就默认已是 result/通知的权威归属机制。

4. **授权失真在本地真实存在；组织限制尚未接通。〔实测〕**
   - `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/security/ClaudePermissionUpdates.ts` 把普通 allow 也转成 session 规则；always 将 add/replaceRules 重写为 projectSettings，并可能自造整工具规则。
   - `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeApprovalHandler.ts:112-133` 对 allow/always 均调用它。既有测试还把此行为写成正确预期。
   - SDK 0.2.112 的 `CanUseTool` 类型没有 `suppressAlwaysAllowRule`；`sdk.mjs` 的 can_use_tool 桥接明确枚举 options，未透传该字段，整个文件无该字符串。**只加可选类型/字段判断不会修复这条桥。**
   - 最新官方文档称此 hint 需要 TS SDK 0.3.268+；#1551 的实测组合是 0.3.293。两者不能代替本地版本的证明。本方案不升级 SDK。
   - `canUseTool` 只处理最终需要询问的请求；已有 allow 规则、acceptEdits/bypass 等可使请求不经过它。此轮不改安全模式，不声称 callback 能替代组织总策略。

5. **命令发现：问题同类，具体旧基线不同。〔实测〕**
   - probe 内部和 catalog 吞错；probe 仅在成功 init 分支 abort，没有覆盖所有出口的 finally，也不接收外部 signal。
   - 本地 catalog 的 `probePromise` 在 finally 清空，**不是 #1359 旧版那种永久缓存失败空数组**。真正的局部污染路径是：失败变空 → vault fallback 返回非空 → dropdown 将该不完整列表缓存为已成功；热 runtime 的 `fetchAndCacheCommands` 也吞错。
   - 当前 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/shared/components/SlashCommandDropdown.ts:235-247` 无 loading/error/Retry 状态，只有 requestId 与非空结果缓存；没有 #1359 所述共用 8 秒 discovery store。本轮没有测得本地 probe 耗时。
   - #1359 的 3.6 秒→27.7 秒、MCP_TIMEOUT=3000 后 5.9 秒，是上游 SDK 0.3.267/CLI 2.1.278 的既有读数；30 秒 picker、默认 5 秒 MCP cap 是其政策。不得宣称是本地测量或直接定成本地正确阈值。

6. **已有运行诊断的适用范围。〔实测〕**
   - `/Users/vincentwang/Documents/NoteVault/.claudian/diagnostics/transcript-tail.current.jsonl` 与 previous 段在本次读取中覆盖约 2026-11-07 10:45:40–11:12:26 UTC：有 settle_result、auto lease/render/save 和 terminal_retracted；该窗口未见 watchdog/stop_task phase。不能由此证明历史 watchdog 未触发或问题已修复。
   - 部署文件 `/Users/vincentwang/Documents/NoteVault/.obsidian/plugins/claudian/main.js` 当次大小 4,591,390 bytes、SHA-256 `159a8f7923dec8a0fc621f32e3b142b2d7f1914d4717621c82a48dae74586fda`。磁盘 bundle 身份不等于内存加载身份，也不等于脏源码产物。

#### 1.3 解层次检查

- Stop 问题不应在“改等待工具名/熔断次数”层求解：**宿主 turn 结束不要求后台任务结束**。任务终态与 SDK 后续 continuation 各有生命周期，移除错误耦合使矛盾不成立。
- 授权问题不应在“选 project/local/session 保存位置”层求解：保存什么、保存到哪由 SDK suggestions 决定，插件只忠实表达用户的单次或记忆选择。
- 命令问题不应在“把统一超时调大”层求解：发现结果必须先有来源、完整性、失败与资源归属契约；loading 可与已知本地列表并存，但不完整结果不能冒充完整。

### 2. S1：Stop hook 与异步任务生命周期

#### 2.1 备选与推荐

| 方案 | 优点 | 问题 | 结论 |
|---|---|---|---|
| 只删除/改名 Stop 理由，保留现有销账 | 改动少 | 丢通知、秒完成、身份/持久化问题仍在；改名仍把后台结束绑到主轮 | 不选 |
| 摘取/整体迁入 #936 | 上游已有较完整生命周期 | 覆盖本地 QueryScope、observer、turn lease/watchdog；较早架构与当前差异大 | 不选 |
| 复用本地销账与持久化，吸收原生流的关联、异步接收与持久化确认；最后移除本地阻断 | 生命周期正交，保留本地已有保障，不依赖 SDK 升级 | 需跨层接线及真实事件对拍 | **推荐** |

#### 2.2 目标行为与契约

1. **任务事件是状态事实，不是新 turn，不释放正在运行的 host lease。** `task_started/progress/notification`、queue enqueue 与 user notification-origin 分别处理；只有 provider 的实际后续轮由现有 transcript observer/auto-turn projection 承载。不得按任一 task 通知制造一轮，也不得插件再发一条 prompt 重复处理 SDK continuation。
2. **一个规范事件入口，两种数据来源。** provider 边界适配 SDK 流与原生 transcript/recovery 事实；输出中立 task event，携带来源、providerSessionId、taskId、toolUseId、可验证的 run 身份、terminal/进度，以及 session generation/query epoch 的本地接收上下文。两端复用同一归一化和去重语义，但保留证据来源，不把 transcript 形态假定为 stdout 形态。
3. **身份不能再裸用 taskId。** 持久业务身份至少是 conversation + providerSessionId + taskId + run 身份；运行接收资格另校验 session generation/query epoch，不能把 query epoch 放进跨重启的持久键导致同一终态被算两次。
   - `tool_use_id` 关联主 Agent/Task 调用 ID；`task_id` 关联 native 任务；agentId 只有被 async launch payload/已知调用关联证明时才是别名。
   - 有真实 `run_id`/origin `runId` 就保留，不由时间戳、描述或随手生成 UUID替代；本地未实证所有 task event 都带 run_id。
   - 缺 run 字段的兼容事件，只在所属 session 的任务关联唯一时接收；同 taskId 多次运行且无法区分的晚到事件进入可见 ambiguous/recovery-needed，不能误销新 run。
   - 通用后台 Bash/MCP/workflow 任务不因同有 task_id 就变成 subagent；已知 Agent/Task 调用或被验证的任务类型才进入 SubagentManager。
4. **唯一领域真相仍是 SubagentManager/SubagentInfo。** 新关联组件只持派生索引，不持另一份 lifecycle 状态；扩展已有 providerState.subagentData 的版本化记录与 hydration 状态。早到终态记录在同一作用域，pending→active 必须消费同一终态；重复消息不能让终态重新 running，冲突终态留诊断、不静默覆盖。
5. **终态和内容完整性正交。** `completed/failed/stopped` 立即销账；summary 不是完整最终输出。hydration 用独立 `pending/ready/retryable/failed` 状态，复用当前 merge-by-tool-id 与 clamp；running 时仍不读最终结果。sidecar output_file 不直接信任，继续走受信目录/真实路径护栏。任务完成不能因读文件失败变回 running。
6. **异步接收、投影和持久化分开。** 把可选 positional void notification handler 升为结构化、可 await 的接收契约；接收路径只做短事务：关联→领域终态→保存意图。sidecar 长轮询不占 SDK consumer、turn lease 或 projection grant。
   - 复用 `mergePersistedSubagentState`，即使 parent message 已不在当前历史窗口也保存任务事实；DOM 缺失不是不落数据的理由。
   - 元数据保存经现有 conversation 串行化/CAS 机制；持久化确认前不得宣称“状态已保存”。写失败保留 dirty/retryable、可见告警；启动后用 transcript/sidecar 重放修复。不能承诺进程被杀前尚未写盘的意图不丢。
   - conversation switch/dispose：先停止接收新旧域事件，捕获并 drain 已接受的旧域保存意图；不能 await 任意长 sidecar 链。旧域已接受事实可保存旧 conversation，严禁改新域 DOM。
   - `cleanup(): void` 若仍是同步接口，正常 tab 生命周期在 cleanup 前调用有限时的 async drain；应急 cleanup 只取消并记录未确认状态，不假装完成 drain。
7. **回调身份要跨 await 不变。** 保存、sidecar 读取、retry 都冻结 runtime instance、conversationId、providerSessionId、run 身份、generation；每次提交前重核。现有只传 agentId、读取 mutable current session 的方式必须补显式 recovery context。

#### 2.3 Stop、watchdog 与 turn 归属的保留边界

- 最后移除**插件自身** Stop 注册、旧理由、熔断计数与该 hook 测试；保留用户/项目自己的 Stop hooks。persistent 与 cold fallback 都移除，不把 `hooks = {}` 当作关闭用户配置。
- `setSubagentHookProvider/hasRunning` 不能直接全删：watchdog 仍使用 `runningAgents`。改成可选、只读的 running-subagent snapshot provider；快照不顺便清理/销账，不让 provider 依赖 DOM。
- 去掉只为 Stop 服务的“2 小时即 orphan”副作用；尤其当前 pending 创建不写 startedAt、旧 getter 默认 0 的行为不能移作通用存活判定。孤儿化只依据明确 conversation/query 终止或被验证的 provider 任务状态。
- 本地已有关联到终态证据的 120 秒 result watchdog、15 秒观察窗、5 秒 interrupt-ack、query exit 确认与 queue recovery。本阶段**不调数值、不扩大 stopTask 候选、不以后台任务存在为 host 活跃证据**；候选快照补 session/task-run 归属并复用原门槛。
- 删除插件 hook 后仍必须能处理 end_turn 无 stop_hook_summary 的 quiet-settle；复用现有 mapper 路径，保留强 continuation 证据撤销旧 terminal、manual compact/auto compact 区分。quiet-settle 不是任意静默即完成，也不是 SDK result 已到的证明。
- `notificationResultPending` 目前是布尔跳过法，测试只覆盖 notification→result 交替。**不得视作已证实的 SDK 一通知一 result 保证。** S1 的前置集成闸门必须覆盖多 notification、合并、无 result、重复 origin、host 继续输出。
  - 理想归属是 query-scoped SDK turn fence：关联实际输入 echo/canonical UUID、当前 provider turn 边界与对应终态；host dispatch 仅是候选，observe-only coordinator 不自动升级为权威。
  - 能证明串行边界的输入走同一显式 owner 记录，不依赖“跳过下一条/跳过 N 条”计数；没有足够身份的 bare result 先保留待对账，**不错误成功、不释放 host lease**，最终走已有证据门控的 retire/recovery。
  - 若当前 SDK/CLI 的安全真实集成样本不能建立该边界，本阶段停在闸门，不以升级或增加启发式蒙混通过。先回传需补的窄 turn-boundary 适配范围；不能悄然启动全量 turn reconciliation 改造。

### 3. S2：授权语义

#### 3.1 备选与推荐

| 方案 | 特征 | 结论 |
|---|---|---|
| 新增保存 destination 设置，继续造规则 | 仍让插件成为第二政策引擎，不能解决 allow once 扩张 | 不选 |
| #1493 透传 + 有 suggestions 就 always | 单次语义正确；本地桥缺 suppression，不能保证组织持久授权限制 | 可作为用户明知兼容边界后的选择，不当默认 |
| 原生透传 + 单一 persist eligibility + SDK 能力闸门 | 不造规则；UI 和响应同门槛；未知政策能力时 fail-closed | **理想默认推荐** |

#### 3.2 精确响应语义

- 普通 `allow`：仅 `behavior: allow` 与原/用户修改后的 updatedInput，**不返回 updatedPermissions 字段**。不是 `session` destination，也不是空数组冒充记忆。
- `allow-always`：只有本次有非空 suggestions 且有效 eligibility 允许，才将**完整 suggestions 原样**作为 updatedPermissions；不筛 destination、不改 behavior、不补 rule、不丢目录/mode 更新。保留数组内容/顺序及结构，不把展示用摘要回写。
- 无建议、空建议或 suppression=true：只展示 Deny/Allow once；即便陈旧 UI/异常 callback 回了 always，也降为当前调用 allow，不返回任何 permission updates。
- `deny/cancel`、AskUserQuestion、allowedTools 校验保持原语义。
- ExitPlanMode 的明确 `setMode(..., destination: session)` 是计划模式交互，不是 allow-once 造规则；单独保留、配回归，不能统一删除所有 updatedPermissions。
- 直接复用已有 `ApprovalCallbackOptions.decisionOptions` 和 InputController 的选项机制。文案使用现有 i18n；不改其他 provider 默认选项/安全模式。移除 ClaudePermissionUpdates 和其旧预期，将测试迁到实际 canUseTool→UI→PermissionResult 生产链。

#### 3.3 suppression 能力闸门

- 唯一 eligibility 由 provider 计算，同时用于选项和结果。概念条件为“非空建议 ∧ 已验证的政策信号桥接能力 ∧ 本次未 suppression”；不是 UI 自行判断，也不是 SDK 版本字符串自我证明。
- 当前 0.2.112 的能力为 **unsupported**：它明确丢该信号。理想默认在这个版本仅提供单次许可；任务继续可用，不升级 SDK，不私接控制通道，不改 node_modules。
- 用户可以明确选择在当前旧 SDK 上接受“无组织 suppression 保证”的原生记忆授权；若选此分支，仍严格透传 #1493，并明确这是兼容范围裁决，不能写成组织限制生效。未裁决前采用保守单次设计。
- 将来单独获准升级时，再验证官方字段透传、实际组织受限请求、所有 canUseTool 接口差异与 lockfile/打包平台包；支持字段时 absence 的语义按该版本官方契约处理，不把 absence 自动当 true，也不把旧 SDK absence 自动当“无限制”。
- 现有已落盘规则**不自动清理/迁移**：无法证明哪些由旧插件造出、哪些是用户原有。session 临时规则随真实 query 重建消失，不清全局权限。新目的地可能为 user/local/session/cliArg，永不强制 projectSettings。保存前可只读展示 SDK 建议的范围与目的地，但不新增 destination 选择器。

### 4. S3：命令发现

#### 4.1 备选与推荐

| 方案 | 优点 | 损失/问题 | 结论 |
|---|---|---|---|
| 完全搬 #1359 的 30 秒 picker + 5 秒 MCP cap + 去 fallback | 有上游实现与测量 | 本地没有同一 store；会截掉慢 MCP prompts，不能把 capped success 当完整 | 不直接采用 |
| strictMcpConfig/禁 MCP，另扫文件 | 冷路径快 | 改变命令宇宙、遗漏 MCP prompts，与当前 scope 无关 | 不选 |
| 带来源/完整性快照的 discovery + 热复用/冷可取消 + 明示降级 | 不用列表速度换假完整；空、失败、部分可区分 | 需小幅重划 catalog/dropdown 契约 | **推荐** |

#### 4.2 单一发现状态契约

- 结果不是裸数组：snapshot 至少有 entries、status（loading/ready/degraded/error/unavailable/cancelled）、coverage（vault-only/runtime-observed/runtime-degraded）、source（vault/probe/runtime）、context fingerprint、revision、stale、结构化错误/未覆盖来源。
- `ready + []` 是合法空列表；失败不是空列表。完整性限定为“该上下文当前 SDK 可枚举范围”，不是所有磁盘技能/MCP 一定全包含。
- 本地 vault 条目可在冷路径 loading/失败时作为**明确标注的部分列表**展示，不缓存为 provider complete；并提供 error/Retry。设置页继续列本地可编辑条目。若 CLI 不可用，显示 unavailable，不假称配置无命令。
- 慢 MCP 失败/超时或未连接时，即使 supportedCommands 成功也记 runtime-degraded，列出数量/状态类别、不泄露服务器凭证。用户看不到“不存在”，只看到“本次未覆盖”。无法获知单个来源时 coverage=unknown/degraded，不猜全。
- hidden built-ins、同名 skill 优先级、MCP 清退、任务工具禁用保持现状，尤其不能把菜单漏项归因后顺手重写这些策略。

#### 4.3 冷热路径与缓存

1. **热路径先复用匹配的 ready runtime。** 在同一 fingerprint 下使用它的 supportedCommands/init 元数据，绝不为菜单重启正在聊天的 query。热失败要可见；必要时可给旧 snapshot 标 stale，不丢成无命令。
2. **冷 probe 是目录服务所有的资源，不是聊天 session。** 保留当前 SDK 查询方式与 persistSession:false，但“空 prompt 不调用模型/无费用”仍须集成证明；加载 MCP/用户 hooks 可能启动外部进程，有副作用风险，本轮不实跑。
3. **缓存键显式覆盖实际命令上下文。** vault realpath、CLI resolved path/version、实际 SDK/构建版本、settingSources、provider 配置 revision、env 配置 revision、plugin/command/skill/MCP 配置 revision、相关 external context 与 runtime generation。不把原始 env/凭证写到日志；敏感值只能用内部 revision 或摘要。仅 providerId 相同不是充分热复用条件。
4. **一个 fingerprint 一个 owned flight，多 subscriber。** 复用 catalog 现有去重能力；外部 signal 取消一个订阅者不终止其他消费者。最后一个消费者离开、配置换代、catalog dispose 或硬生命周期到期，才 abort owned probe。新的 flight 不能被旧 finally 清空。
5. **revision 优先，不看数组是否非空。** 热 runtime 的新空列表也覆盖旧 probe 非空；换上下文后旧成功/失败均丢弃。dropdown requestId 只管一次输入，不能代替 catalog/config generation。
6. **只缓存有效 snapshot。** error/cancelled 不成为成功缓存；degraded 快照可作为带标签的暂存结果，显式 Retry 应开新 flight。成功空也可缓存；refresh 必须真正失效并触发重新发现，不再 no-op。运行时成功更新推送给所有同上下文 dropdown，不能被局部 providerEntriesFetched 永久遮蔽。
7. **入口共用 store/policy。** Main Chat 与 Inline Edit 使用同一 discovery store 工厂/timeout policy，前者传 tab runtime/context，后者 catalog-only；不能为 inline 初始化完整聊天会话。新 store 放 core 的中立 command 契约；Claude 负责 probe/coverage，其他 provider 沿用原行为的兼容适配，不搬上游全 provider 改造。

#### 4.4 超时、取消与进程清理

- 分三件事：UI 等待提示；整个 discovery flight 的硬生命周期；MCP 单服务器连接策略。一次表单显示 deadline 不应悄悄等于 MCP cap。
- **本轮不填未经测量的超时。** 本地没有证据支持 8/30/5 秒。落地先用安全 fixture 测取消与边界，再在获准的真实环境量 `spawn→init`、`init→supportedCommands`、`cancel→exit` 和 MCP 状态；随后确认数值。目标是有限 owned flight + 用户可取消，不允许永远 pending。
- 理想默认**不人为缩短 MCP_TIMEOUT**。若用户选择有界快速部分列表策略，cap 只作用 probe、严格尊重显式环境值、结果标 degraded、保留补全/Retry；聊天 env 不变。不能依赖“启动聊天后也许会自动补全”，必须实测热列表更新是否发生。
- probe 用 try/finally 覆盖 init 前 EOF、supportedCommands reject、abort、spawn error 等全部出口；外部取消能中断等待 next()/supportedCommands()，而不只是等下一消息才检查 signal。SDK abort/close 与取消原因保留；不吞普通异常。
- 复用 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/customSpawn.ts` 的 Electron signal realm 兼容、onExit 和 stdout drain。abort/close 不是真实 exit 的证明，正确去除 listener/timer 并确认 probe 自己的进程退出。
- 只能清理证明由该 probe 创建/拥有的进程，不能 `pkill claude`、按命令名找全机 MCP、关闭热 chat query。当前 child.kill 仅证实直接 child 路径，**未证明整个 MCP 后代树**；落地须验证 SDK/CLI 的清理保证。若需进程组策略，仅 probe-scoped、按平台单独验证；不得改变所有 runtime 的 spawn 行为。
- 若无法确认旧 probe exit/后代归属，显示 cleanup_failed 并阻止同上下文无限重试造进程；用户手动恢复或被验证的受限清理后才新建。

### 5. 影响面与依赖

以下是方案目标位置，最终基线重核后可能收缩；不是本轮 diff。新增模块只承担明确契约，不为了包一层而包一层。

| 阶段 | 绝对路径 | 目标改动 |
|---|---|---|
| S1 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/types.ts` | 中立结构化 task event/接收确认、只读快照/recovery context；conversation identity 合同补 id（现 Pick 未含 id） |
| S1 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/ChatRuntime.ts` | 可选 task subscription/有限 drain；替换 hook-named 快照接口，非支持 provider 不加假生命周期 |
| S1 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeTaskEventAdapter.ts` | 新增，纯事件/兼容字段归一化与守卫 |
| S1 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeTaskCorrelation.ts` | 新增，作用域与别名的派生关联；不成为第二状态仓 |
| S1 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts` | persistent/cold task 接收、scope guard、窄 turn-fence 接线、快照、移除插件 Stop；保留 recovery 时序 |
| S1 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeQueryOptionsBuilder.ts` | hooks 可选/条件传递；保留其他 SDK options 与用户 hooks 来源 |
| S1 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/hooks/SubagentHooks.ts` | 最终删除，仅删插件阻断机制 |
| S1 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/sdk/types.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/sdk/typeGuards.ts` | 若 task 事件进入 TransformEvent，明确排除其 StreamChunk 分类；不能由目前“不是 session_init 就是 chunk”漏判 |
| S1 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/stream/transformClaudeMessage.ts` | task 控制事件与正文分离；保留 usage/文本去重，不重新引入上游已废的 context 分母逻辑 |
| S1 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/services/SubagentManager.ts` | scoped 关联、早终态与幂等；非破坏性快照，去 hook-only 年龄清理 |
| S1 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/StreamController.ts` | 保存不依赖可见 message；sidecar 锁定 recovery identity，终态/内容正交 |
| S1 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts` | 事件订阅、域内串行保存、switch/drain/dispose；不覆写并行 session 的最终生命周期 |
| S1 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/types/providerState.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts` | subagentData 兼容字段/版本、保存合并与恢复 |
| S1 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/SessionStorage.ts` | 默认复用；仅最终读证据证明缺少保存确认/更新边界时改，不预设重写 |
| S1 验证 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptTurnMapper.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptTurnObserver.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/MessageChannel.ts` | 优先不改，验收 quiet-settle/uuid/order；有硬缺口先明确前置范围 |
| S2 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeApprovalHandler.ts` | 原生响应、统一 eligibility；删除旧 rule builder 调用 |
| S2 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/security/ClaudePermissionUpdates.ts` | 删除，不重写为 destination setting |
| S2 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/InputController.ts` | 复用 decisionOptions；取消/超时一锤定音，必要时补 signal/身份校验接线 |
| S3 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/commands/ProviderCommandCatalog.ts` | snapshot/signal/policy 的中立可兼容契约 |
| S3 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/commands/ProviderCommandDiscoveryStore.ts` | 新增，状态/订阅、取消、revision、policy；本地尚无此 store，不依赖上游已建前提 |
| S3 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/probeRuntimeCommands.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/ClaudeCommandCatalog.ts` | 可见失败、coverage、owned flights、缓存与 refresh |
| S3 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/app/ClaudeWorkspaceServices.ts` | 外部 signal/context 与目录 dispose 接线 |
| S3 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/shared/components/SlashCommandDropdown.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/inline-edit/ui/InlineEditModal.ts` | 三入口共用状态，热 runtime fingerprint、部分列表/失败/Retry、取消订阅 |
| S3 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/customSpawn.ts` | 优先复用；probe-owned 退出观测若需扩展必须保持 chat 默认行为 |
| 各阶段 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptDiagnosticLog.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/types.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/locales/` | 复用结构化、脱敏、轮转诊断与 i18n；不新增 console 日志链 |

`package.json/package-lock.json/node_modules` 本方案不改。若后来允许锁定当前 SDK 的精确 pin 或升级，是另一个经确认的依赖动作。其他 provider 仅为共享接口做行为等价适配；不得纳入其命令能力扩张。

### 6. 分阶段顺序与闸门

1. **G0，等待并行开发结束并重核最终基线。** 主会话依据用户确认的开发完成信息执行第 10 节；不轮询/控制其他 session。记录最终 commit + 工作树 diff + 实际部署/SDK/CLI 身份；检查本设计需订正或迭代，未获授权不自行改既有记录。
2. **G1，冻结契约证据，不改行为。** 生成脱敏 task/turn fixtures、canUseTool payload fixture、命令 probe 资源 fixture。识别 turn-fence 与保存确认是否已被其他开发实现；前置缺口单列，不能悄然扩 scope。
3. **S1-a，任务归一化/关联与保存红测。** 保留旧 hook 仅作为尚未切换的基线；完成 source/query/session/run guards、早终态、单状态源、后台持久化、恢复/drain。
4. **S1-b，turn/恢复集成闸门。** actual SDK transport fixture 与 transcript 对拍通过，确认 host result 不被提前消费、无 result 不错成功、quiet-settle 与 query retirement 保持。若不能证明，No-Go，回问边界，不升级。
5. **S1-c，移除插件 Stop。** persistent/cold 一并去除 hook/熔断；验证用户 hooks 仍加载、watchdog 独立快照仍可用。真实验收完成后关账冻结 S1。
6. **S2，授权。** 先 ordinary allow 无 updates 与 eligibility/陈旧回复红测，再删除 builder；用户裁决当前 unsupported suppression 下是否保守只准单次。真实安全授权实验通过后冻结。
7. **S3，发现契约→probe 资源→全入口 UI/cache。** 先让失败/部分可见并取消正确，再真实测量并确认超时/coverage 政策；不提前套上游阈值。
8. 每阶段独立小批交付、独立复核、禁止依赖下一阶段替上一阶段兜底。高风险设计可在用户确认前另派独立 architect 挑硬伤；实施后按项目规则派 reviewer。

### 7. 方案推演

#### 7.1 因果链与反例

- **Stop 链**：已读 hook 在 hasRunning 时发出旧理由 → 真实记录重复出现完全相同理由 → 本地插件阻断是这类反馈的直接来源之一 → 解耦后插件不再要求 TaskOutput。隐含条件是实际加载 bundle 确实包含该 hook。**反例**：用户另一个 Stop hook 输出同样文本；移除插件 hook 不消除它，因此验收须区分 hook 来源，不能许诺所有 Stop 反馈为零。
- **授权链**：allow 也生成 session rule → SDK 可能让后续同范围操作绕过 prompt → “只允许本次”被扩张。**反例**：既有用户 allow rule 已覆盖动作，本来不会进入 callback；修改插件响应不能使其重新询问。因此红绿判据是响应与规则差异，不是无条件要求每次都弹窗。
- **发现链**：probe 错误被吞为空 → catalog 回本地非空列表 → dropdown 把它缓存成成功 → 用户看不到 runtime 漏项与失败。**反例**：vault 无条目，dropdown 不置 fetched，因此不存在同样的非空污染；仍有静默失败，但不能宣称 catalog 永久缓存所有失败。

这份记录不改已关账设计的结论。若未来实证需要翻案，应追溯原记录证据/适用版本，并做“保留旧行为”的前向反事实，不就地覆写历史判断。

#### 7.2 同一对象跨步骤、默认值与顺序走查

以下案例均为〔纯示意〕，不是生产时延测量。数字为可测试锚值。

| 案例/锚值 | 旧机制 | 推荐机制 | 红/绿判据 |
|---|---|---|---|
| C1，session S1、task T、调用 U；先 terminal，再 launch；随后重复 terminal 2 次 | 裸 taskId early cache 在 promotion 销账，无完整作用域 | 保存同一 S1/T/run 的 early terminal，launch 绑定 U；重复只补内容 | 绿：1 次 terminal、1 个持久 run，0 次复活；红：2 次完成或另一个 session 被销账 |
| C2，C1→C2 switch；sidecar read 在 switch 后返回 | 单 agentId/当前 runtime session 有跨 await 风险 | 冻结旧 C1/S1/run；允许保存已接受 C1事实，不投影 C2 | 绿：C2 0 次更新；红：C2 result 被旧值覆盖 |
| C3，task T/run R1 已完成，R2 正 running，晚到 R1 通知 | taskId 复用可能结掉 R2 | 有 runId 区分；缺 run 且歧义则 recovery-needed | 绿：R2 仍 running；红：按 taskId/时间猜 R2 terminal |
| C4，host H 持 lease；2 个通知 user echo 后只 1 个 result，或无 result | 布尔 flag 不能表达两者，交替测试不能证明正确 | 显式 SDK turn owner/fence；无法证明归属不释放 H，证据门控恢复 | 绿：H 0 次虚假完成、queued input不进入旧 query；红：改成跳过2次即宣称根治 |
| C5，Bash A 建议 localSettings，用户 allow | 1 个 session 更新 | 0 个更新，updatedPermissions 字段不存在 | 绿：1 次本次许可、0 次规则写入；红：造 session rule |
| C6，同 A 用户 always；建议含2条不同 destination；eligibility=true | addRules destination 可能被改 project | 2 条建议原样、顺序不变 | 绿：deep-equal 原 suggestions；红：改 scope、删 unscoped 或补 rule |
| C7，无 suggestions/empty/suppression=true/旧桥 unsupported；陈旧 UI 返回 always | 自造规则或未来限制失效 | 默认只准本次，0 个更新 | 绿：可选项无always且响应0更新；红：仅隐藏按钮、handler仍写规则 |
| C8，cold probe 失败，本地2命令；热 runtime随后返回合法空 | 本地2条可能被缓存并遮盖热空 | 明示 vault-only+error；热新 revision 的 ready空覆盖旧 | 绿：用户可见失败且新空生效；红：判断 length>0 才算新鲜 |
| C9，2 dropdown共享1 probe；一个取消，后者完成；随后2者全取消 | 无外部取消/退出归属 | 首次只移订阅者；末订阅者离开才关闭 owned process | 绿：最多1 flight且确认exit；红：关热chat或旧probe无限残留 |
| C10，慢MCP提供1个prompt，连接晚于所选cap | 上游快速策略可遗漏它 | 不cap则等待可取消；若cap则degraded并明确该来源未覆盖 | 绿：不声称完整，热补全经实测；红：30秒内有列表即算全部成功 |

默认值最不利场景：无 runId + 同 taskId 重运行；旧 SDK 缺 suppression；空列表也应新鲜；用户快速换 tab/provider；无 attending user 的 auto 授权。各自必须退化为明确的不确定/单次/空成功/取消，不退化成“放宽猜测”。

#### 7.3 结构不变量判定

- **正交性：目标成立。** task lifecycle、host/auto turn、hydration、持久化确认四轴分开；当前 Stop 将前两轴耦合，位置为 SubagentHooks。去除耦合但保留 watchdog recovery。
- **数据流无环：目标成立。** provider facts→task domain→持久 state/DOM；sidecar只补内容；保存 ack 不反向造 SDK task/turn。禁止 task callback→send prompt→task callback 的循环。
- **单真相：目标成立。** 关联表是派生索引，SubagentInfo/subagentData 是一条状态链；command store统一 snapshot，dropdown不另藏完整性判断。若落地出现第二 lifecycle map/第二成功缓存则违反。
- **扩展点方向：目标成立。** provider 处理新增 wire字段/coverage；features消费中立事实，不写 Claude SDK字段判断；共享契约可选能力，不给其他provider假 no-op completion。
- **退化为一般特例：目标成立。** 同步任务、无DOM、合法空目录、无CLI、缺可选字段走同一结构的不同状态，不另开“全量历史/无通知/小会话”捷径。
- **多入口覆盖：必须实证。** persistent/cold/recovery × task、user/auto/subagent × approval、Main Chat/Inline Edit/Settings × discovery/save/cancel；见验证矩阵。现有 local tests缺真实session/run字段、冷热失败/取消链，因此当前基线不能判全入口已成立。

### 8. 交付物规范

本轮仅新建本设计记录。后续代码/fixture/真实验收均未授权；以下规范供获准实施时使用。

#### 8.1 目标目录树（新增部分）

绝对代码根 `/Users/vincentwang/Documents/NoteVault/tools/claudian`：

```text
/Users/vincentwang/Documents/NoteVault/tools/claudian/
├── docs/designs/2026-11-07-upstream-compat-stop-permissions-discovery.md
├── src/providers/claude/runtime/
│   ├── ClaudeTaskEventAdapter.ts
│   └── ClaudeTaskCorrelation.ts
├── src/core/providers/commands/ProviderCommandDiscoveryStore.ts
├── tests/unit/providers/claude/runtime/
│   ├── ClaudeTaskEventAdapter.test.ts
│   └── ClaudeTaskCorrelation.test.ts
├── tests/unit/core/providers/commands/ProviderCommandDiscoveryStore.test.ts
├── tests/integration/providers/claude/
│   ├── upstreamCompatibility.test.ts
│   └── fixtures/
│       ├── claude-compat-211311-task-stream.jsonl
│       ├── claude-compat-211311-task-transcript.jsonl
│       └── claude-compat-02112-permission-request.json
└── dev/（若最终确需可复用真实验收 harness，在方案确认后再定文件名与范围）
```

不预建 dev harness；一次性取证脚本与原始 stdout 只落单独 `/tmp/claudian-compat-<时间戳>/`，不交付原始会话资料、不登记业务产物。现有 `/Users/vincentwang/Documents/NoteVault/.claudian/sessions/*.meta.json` 与 diagnostics 目录复用，无新持久业务数据库。

#### 8.2 命名与索引

- `ClaudeTask*`：Claude原生任务事件/身份适配，不承载中立 UI；`ProviderCommandDiscovery*`：provider-neutral目录发现契约。
- `claude-compat-<cli或sdk数字版本>-<证据种类>`：兼容fixture的实际版本和渠道，不把transcript命名成stream。fixture伴随测试注释记录来源类型、脱敏方法、字段删留、SDK/CLI版本与红绿断言。
- 正式设计用 `YYYY-MM-DD-主题.md`，status=draft；同主题实质迭代按 vN，不覆盖旧记录。
- 获准落地后在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/README.md` 登记设计/验收产物索引及正式入口；本轮禁止改 README。

#### 8.3 产物清单与消费者

| 路径 | 用途 | 消费者 |
|---|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-07-upstream-compat-stop-permissions-discovery.md` | 待确认设计、动态基线与最终重核闸门 | 用户、主会话、architect、implementer、reviewer |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeTaskEventAdapter.ts` | 统一经守卫的任务事实 | Claude runtime、恢复适配 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeTaskCorrelation.ts` | 域内身份索引与歧义判定 | Claude runtime、任务接收 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/commands/ProviderCommandDiscoveryStore.ts` | 全入口发现状态与订阅生命周期 | catalogs、Main/Inline dropdown |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/ClaudeTaskEventAdapter.test.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/ClaudeTaskCorrelation.test.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/core/providers/commands/ProviderCommandDiscoveryStore.test.ts` | 失败优先的契约红测 | Jest unit、reviewer |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/providers/claude/upstreamCompatibility.test.ts` 及上述 fixtures 目录3份文件 | 真实形态的SDK边界/跨层/磁盘对拍 | Jest integration、兼容回归 |

若 turn-fence 前置缺口须增加模块/fixture，先明确本规范扩展，不在实现途中悄然新增平台/依赖。

#### 8.4 归属与偏离

- 引用 `/Users/vincentwang/Documents/NoteVault/tools/claudian/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/CLAUDE.md`：provider-native-first、provider-neutral边界、mirrored tests、TDD、生产禁止console、新正式工具归dev。
- 已有独立工具仓 `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/` 为唯一主题归属，沿用其既有设计记录，不另在vault顶层造重复记录。
- 本轮临时逻辑走 `/tmp`，优先于域内一般 `.context/` 临时约定；不新建 `.context` 交接/报告，不落敏感 fixture。
- 未找到现成的兼容fixture产物索引约定；本节为雏形，落地后回填 README。除上述临时目录优先级外无主动偏离。

### 9. 失败与回退

- **S1**：未过 task/turn 身份或保存闸门不去 hook；上线后 callback/保存失败显式标 dirty/recovery-needed，task终态不复活，旧query事件不碰新域。回退到上一份已验证 bundle；若回退重现旧block，明确恢复的是旧缺陷，不能改成静默丢通知方案。用户Stop配置不随回退删除。
- **S2**：安全回退为 one-time-only，不恢复插件自造/改目的地规则。不能自动撤销已经写到 user/local/project 的SDK建议；删除既有规则须用户单独裁决和备份。回退业务schema不得丢新增任务记录。
- **S3**：失败保留可识别部分列表/旧 stale快照和Retry；不变空成功、不切 strictMcpConfig；清理失败阻断无限重试。回退store接口与接线需成组，不能只回某一入口造成缓存契约断裂。
- schema 做读取兼容、增量懒迁移；未知字段往返保留，不自动批量重写所有meta。fork不继承源conversation仍运行任务的接收资格；旧记录的running是历史状态，不自动宣称当前进程仍活。
- 任一升级需求（SDK、CLI、依赖pin、控制桥patch）单独列成本/行为影响并获取授权；本方案不是其授权。

### 10. 并行开发完成后的可执行基线复核清单

先记录只读快照，然后逐项给出“相同/已改且等价/已实现/冲突/未知”，每项附实际路径与验证证据。**不得把“其他session可能会实现”登记为已实现。**

| 检查 | 精确接口/文件 | 对方案的影响/闸门 |
|---|---|---|
| 代码/运行身份 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/package.json`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/package-lock.json`、已安装SDK的sdk.d.ts/sdk.mjs、resolvedCLI、部署main.js | 版本/桥能力变了则重核suppression/run字段；不凭日期/manifest判定 |
| task接收与scope | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/ChatRuntime.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/types.ts` | callback若已结构化/可await则复用；currentQueryScope/retirement语义变化则重做跨await图 |
| provider转换分类 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/sdk/types.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/sdk/typeGuards.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/stream/transformClaudeMessage.ts` | 新事件不能被误当streamchunk；保留usage/model窗口当前裁决 |
| Stop与watchdog | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/hooks/SubagentHooks.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeQueryOptionsBuilder.ts`、runtime watchdog/stopTask函数 | hook若已被移除只验证，不重复删除；只读快照仍供watchdog，数值和回收顺序冻结 |
| turn归属 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/MessageChannel.ts`、runtime.notificationResultPending、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptTurnMapper.ts`、Observer、ReconciliationCoordinator、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/TurnCoordinator.ts` | observe→authoritative若已被独立验证可复用；未验证则不能改变本阶段闸门。核canonical UUID/alias、quietsettle、compact、通知无result |
| tab/conversation生命期 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts`、TabManager/TabBar/types、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ClaudianView.ts` | rebind/drain/dispose/CAS时机以最终代码为准；重绘身份不等于业务会话身份 |
| 域状态/sidecar | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/services/SubagentManager.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/StreamController.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkSubagentSidecar.ts` | 早终态缓存key、poll注册key、结果clamp、await后的session引用若已重划则缩小适配 |
| 持久化/新size链 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/SessionStorage.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/types/chat.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/types/providerState.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts` | mergePersistedSubagentState/buildPersistedProviderState/保存ack/CAS/sizeSnapshot需一起核：任务更新不能丢size字段，size保存不能回滚任务；不用无关改造重算全历史 |
| history投影/branch | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeTranscriptHistoryIndex.ts`、sdkBranchFilter、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/rendering/MessageRenderer.ts` | terminal保存不得依赖当前window；fork/rewind的源task不得接收目标session通知；保留historybudget |
| 授权 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeApprovalHandler.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/security/ClaudePermissionUpdates.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/InputController.ts` | 是否已经一次/记忆分离；选项/返回同门槛；取消signal/auto超时；旧规则不自动清理 |
| commands全链 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/commands/ProviderCommandCatalog.ts`、Claude catalog/probe/workspace、runtime.fetchAndCacheCommands、TabManager.getSdkCommands/getProviderCatalogConfig、SlashCommandDropdown、InlineEditModal | 若已出现discovery store/完整性/取消接口优先复用；热点cache key/合法空、sharedflight与刷新事件仍逐项证明 |
| spawn/build/locale/test | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/customSpawn.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/esbuild.config.mjs`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/` | 生产打包不自动部署；新增契约用最终testlayout；诊断若被并行改动禁止覆盖旧字段/轮转 |

复核操作：`git --no-optional-locks status --short`、`rev-parse HEAD`、`diff --name-status`、对上述关键文件重算SHA-256并读具体diff；只读命令不reset/stash/checkout/fetch。快照仍脏则明确作者工作尚未冻结，不对脏树跑会改cache/build的验收。实质结论变化应先向用户回报，再按授权新建vN/supersede；只映射文件位置/补漏则经明确订正授权处理。原记录不自行改。

## 风险与权衡

- 理想结构不靠阻断、规则造型或超时巧合维持正确性，代价是三项都涉及契约接线，不适合摘提交。本地复用价值高：任务domain、subagentData、observer、QueryScope、spawn、decisionOptions均已有，不应另起第二套系统。
- SDK 0.2.112 的动态额外消息字段可守卫读取，不等于所有CLI事件都存在；typed contract、wire fixture、native transcript分别取证。特别是bare result归属不足时必须明确No-Go/恢复，不能承诺任意乱序都可识别。
- 当前SDK缺组织suppression透传是实际能力缺口；保守只准单次能**规避新增记忆授权风险**，不能补救所有既有权限/acceptEdits绕询问，也不能标记组织总策略已受控。
- command完整性必须限定上下文与可枚举来源；“用户设置开关”实际影响整个user source，不能只说settings.json。说明可更新，不能顺带实现用户skills与user权限拆载。
- 正常shutdown可drain，进程突然被杀/磁盘满不能保证最后意图已保存；用可见确认和重放修复，不宣称绝对exactly-once投递。

### 迁移/落地代价

S1跨provider边界、tab生命期、恢复/持久化；S2行为变化会让普通allow更频繁询问、建议目的地改变，旧SDK保守方案隐藏always；S3新增中立snapshot/store与两个dropdown入口。已有metadata兼容懒迁移、各阶段单独回归与部署，不因成本降低目标结构。若SDK升级另获准，需单独锁依赖、检查新选项/权限/平台包/构建产物，不能混进这三批。

### 需用户裁决

1. 是否确认整体目标与三阶段顺序，并允许并行开发结束后先复核方案，而非立即实施？本轮无实施授权。
2. 当前SDK缺suppression桥时，接受**理想默认one-time-only**，还是明确接受“无组织suppression保证”的#1493记忆授权？推荐前者；此项不意味着升级授权。
3. 目录发现接受明示vault-only/degraded列表并可Retry，还是失败时完全不展示provider条目？推荐明示部分，不假完整。
4. 默认不缩短MCP连接；是否允许后续在独立安全环境测量，再裁决ownedflight超时与可选MCP cap？未测量前不定值、不改聊天env。
5. S1真实验收与S2持久授权实验需要独立测试vault/安全目录、明确模型预算与写权限；组织受限connector用例如不可取得，则组织端验收标未验证，不伪造通过。

## 验证方式

### 1. TDD与集成矩阵

本轮没有运行这些测试，不声称它们已通过。先写真实失败断言→最小实现→重构，mock仅模拟SDK/磁盘/进程输入，不能mock被测状态机或回调接线。

| 范围 | 覆盖入口×机制 | 可观测红绿判据 |
|---|---|---|
| 任务unit | typed notification、queue、userorigin；缺session/tool/run，generic背景任务、重复/冲突、earlyterminal | 作用域匹配才销账；terminal幂等；0假subagent、0新hostlease、歧义可见 |
| 任务生产链integration | 真实installedSDK+fake SpawnedProcess stdout（不要全mock SDK）→adapter/runtime→Tab→SubagentManager→providerState保存→重新load | source字段不丢；parent不在window仍持久；同对象stream/transcript对拍；最多1持久终态 |
| turn/lease | persistent/cold/recovery；两个notification先于result、合并/缺result、同origin重复、host继续、旧scope迟到 | host不虚假完成；不吞host正文/usage；旧result不结新turn；队列仅在正确boundary派发 |
| Stop保留项 | 有/无用户Stop、无summary、thinking/text同messageid分行、compact、continuation撤回、watchdog/stopTask/interrupt/exit | 插件block与熔断为0；用户hook仍执行；不存在无candidate静默成功；原恢复门槛/时序不变 |
| sidecar与保存 | 无DOM/parent被卸载、慢fileflush、读取失败、超量内容、switch/dispose/read跨await、保存失败与重启 | terminal与hydration分离，clamp不丢meta；1poll/run；新域0污染；dirty/确认和恢复可核 |
| 授权unit/productionUI | user/auto/subagent；allow/always/deny/cancel；suggestions absent/empty/多dest/目录/mode；suppression；陈旧always；ExitPlanMode | allow无updatedPermissions；eligible always deep-equal；UI和response同eligibility；取消/auto超时只settle1次 |
| 命令unit | coldEOF、supportedCommandsreject、合法空、热失败、换fingerprint、配置refresh、旧finally、新runtime空盖旧probe非空 | error!=empty；revision单调；retry新flight；部分!=complete；刷新可观察 |
| 菜单integration | Main Chat/Inline Edit/Settings；readyruntime/noCLI；两subscriber取消一/全取消；MCP失败/慢；user source开关 | 两picker同policy与状态；Settings仅本地管理；0热query重启；空/漏项明确 |
| process/平台 | init前挂住、supportedCommands挂住、exit不关闭stdout、abort时已退出/未启动、cleanup_failed | finally总到；cancel有界；listener/timer归零；确认ownedexit；绝不终止其他session |
| 并行开发回归 | sizeSnapshot、providerState、historywindow/branch、fork/rewind、其他provider菜单/批准 | 新任务保存不丢size，旧保存不覆新task；provider能力保持；未知字段往返 |

优先复用并扩展既有：
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/ClaudianService.test.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/ClaudeApprovalHandler.test.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/turnResultWatchdog.test.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/turnLeaseRelease.test.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/customSpawn.test.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/commands/probeRuntimeCommands.test.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/commands/ClaudeCommandCatalog.test.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/services/SubagentManager.test.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/controllers/StreamController.test.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/Tab.test.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/TabManager.test.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/shared/components/SlashCommandDropdown.provider.test.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/transcript/ClaudeTranscriptTurnMapper.test.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/transcript/ClaudeTranscriptTurnObserver.test.ts`

删旧hook/rule-builder测试前先把新响应/边界红测写入真实调用链，不以删除断言充当修复。

### 2. 获准实施后的命令

最终基线冻结后执行，不能在此轮或并行脏工作树上冒充只读验证：

```bash
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run typecheck
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run lint
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run test -- --selectProjects unit --runInBand --no-cache
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run test -- --selectProjects integration --runInBand --no-cache
```

构建前确认 `/tmp/claudian-compat-NONEXISTENT-vault` 不存在；用非空不存在值覆盖OBSIDIAN_VAULT，否则 `.env.local` 会把它补成真实vault：

```bash
test ! -e /tmp/claudian-compat-NONEXISTENT-vault && env OBSIDIAN_VAULT=/tmp/claudian-compat-NONEXISTENT-vault npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run build
```

构建仍会写仓库main.js/styles等，因此只在获准实施阶段用；不能把“没有部署”说成“没有写文件”。最终部署/重载用户另行批准，先保存已验证的bundle备份与哈希，不依赖vault git保护.obsidian。

### 3. 真实环境验收与可观测判据

- **S1**：在不干扰其他session的测试vault，记录实际插件构建ID、SDK/CLI executable/version；后台任务秒完成、主turn先结束/任务后完成、任务结束后nativecontinuation、连续2通知、下一条手工输入、cancel/close/reload/fork。核插件Stop block/熔断均0、每task-run终态1、重复消息不复活、所有host/auto的begin/finish/release配对、不误结下一turn；任务已保存与hydration失败分别可见。保留用户hook样本以证非全局关闭。
- **S2**：仅安全无副作用工具/独立测试配置目录；allow一次前后比较权限文件与response，0新增更新；符合eligibility的always对拍SDK建议目的地和规则；受限请求always选项缺失、陈旧回复0更新。旧SDKunsupported情形明确只验保守fallback，不宣称真实组织限制透传。不得在本vault写宽授权做实验。
- **S3**：同context分别测cold/hot、user source开/关、MCP成功/失败/受控慢、空目录、无CLI、取消与Retry；记录阶段耗时与coverage，不记录env/command正文/服务器URL。核热复用无probe spawn，cold ownedflight共享，取消后真实exit，partial明示，热列表补全事实可见。模型调用/费用为0的probe承诺需从实际调用/结果证据核验。
- **可观测扩展**：复用轮转diagnostic，新增task observed/accepted/duplicate/ambiguous/stale/terminal、save intent/ack/failure、hydrate retry/ready/failed、approval offered/returned及eligibility reason、discovery source/coverage/revision/error/stage/elapsed、probe abort/exit/cleanup_failed。仅带salted identity hash、枚举、计数、耗时、SDK/CLI/build版本；不写suggestions规则内容、任务summary、凭证、原始路径。告警不能只存在console。
- **No-Go**：host虚假完成、新域污染、allowonce写规则、未知policy默许always、部分列表冒充complete、取消遗留ownedprocess且继续无限重试、任一入口没有接线。遇到此类失败停批次，回到契约，不继续调熔断/固定等待数值。

## 关联

- [[tools/claudian/CLAUDE]]
- [[tools/claudian/docs/designs/2026-09-14-Claudian-v6-auto-turn收口冻结根因与修复]]
- [[tools/claudian/docs/designs/2026-08-23-turn-lease偶发不释放根因定位-v2]]
- [上游 #936：native async subagent lifecycle](https://github.com/YishenTu/claudian/pull/936)，merge `852b970826c606aa674bf3ec03c1b6ba2d38012c`
- [上游 #1493：原生建议透传](https://github.com/YishenTu/claudian/pull/1493)，merge `552ecf8f4c43b5c6d5eff5cb5201f8ba6053d32f`
- [上游 #1551：suppression与SDK升级](https://github.com/YishenTu/claudian/pull/1551)，merge `7c41ac0e798125186474ce315f2bcac80185cf10`
- [上游 #1359：发现失败与慢probe](https://github.com/YishenTu/claudian/pull/1359)，merge `f1328f3e8e742aae2e1583741f15a5313df7eb31`
- [官方任务/权限类型](https://code.claude.com/docs/en/agent-sdk/typescript)、[用户许可](https://code.claude.com/docs/en/agent-sdk/user-input)、[subagents](https://code.claude.com/docs/en/agent-sdk/subagents)。最新文档用于查升级边界，不替代本地0.2.112实证。
