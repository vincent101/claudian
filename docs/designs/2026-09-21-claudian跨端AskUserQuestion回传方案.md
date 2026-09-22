---
type: design-decision
status: draft
target: "[[tools/claudian]] 跨端 AskUserQuestion 回传"
tags: [architect, claudian, cross-session, ask-user-question]
备注: 跨端 ask 回传，待用户确认方案后实施
---

# claudian 跨端 AskUserQuestion 回传方案分析

## 背景与问题

dxchannel 手机 peer 消息触发的 auto turn 里，agent 调 AskUserQuestion 时，claudian 3.1.3 在本机弹卡片 + 5 分钟超时兜底——但发起人在手机上，看不到本机卡片，白等 5 分钟后 deny（真机案例 c8f938ab：12:58:20 ask 发出，19ms 后 deny，用户 13:00 在本机手动救场"你刚才的问题没有问出来，选 2…"）。要回答的问题：提问能否路由回发起方（手机），答完回传；用户直觉是"优化 courier subagent 带要求回传标记"。

## 现状链路（实证，HEAD 0f97f003）

### 手机 → 本机 → ask 的完整路径

1. 手机用户在大象私聊发消息 → dxchannel 唤醒本机一个**短命 dxchannel 私聊 session**（每次新 PID，transcript 实测 from sock 每次不同：10913/73854/73735…）→ 该 session 派 courier → UDS `SendMessage` → 目标 session 的 CLI harness 把消息 dequeue 成带 `origin.kind='peer'` 的 user turn，模型随即开跑。
2. 真实 envelope（transcript 实测）：

```json
{
  "type": "user", "isMeta": true, "userType": "external",
  "origin": {
    "kind": "peer",
    "from": "uds:/tmp/cc-socks/73735.sock",
    "verifiedPeerPid": 73735,
    "fromMode": "bypass",
    "body": "[to]   <目标sessionId> notevault-0a\n[from] <来源sessionId> notevault-a6\n[msg]  正文"
  }
}
```

手机私聊的 body 首行带文本约定标记 `[from 用户,经手机私聊转达]`（信箱读取流程的 courier prompt 约定，非协议字段）。

3. claudian 侧：`routeMessage` 对带 `origin` 的 user 消息直接忽略（`ClaudeChatRuntime.ts:962-977`），external turn 生命周期归 **transcript observer**（v6）：`ClaudeTranscriptTurnMapper.classifyLeaselessTurnStart` → `observed_start`（`source: {kind:'peer', label?}`，label 来自 `origin.name`，实测样本中无此字段，基本为空）→ FIFO → `promote()`（`canAcquire` 恒 true）→ `AutoTurnProjectionController.started` → `TurnCoordinator.beginAutoTurn` 挂 auto lease。
4. 模型调 AskUserQuestion → SDK canUseTool → `ClaudeApprovalHandler` → `askUserQuestionCallback` → `InputController.handleAskUserQuestion`：`getActiveTurn()?.kind === 'auto'` → 渲染本机卡片 + `raceAutoTurnAskTimeout` 5 分钟 → 手机看不到 → deny + interrupt。

### 问题 1 的答案：来源信息在 ask 时拿不到

- `AutoTurnSource` 有四值 `peer | channel | coordinator | notification-continuation`（`core/runtime/types.ts:136`），`AutoTurnStartedEvent.source` 只传到 `AutoTurnProjectionController`（仅用于渲染 label）。
- **`TurnCoordinator.ActiveFeatureTurn` 不含 source**——InputController ask 时只能判定 `kind==='auto'`，无法区分 peer 轮和 task-notification 轮。传播缺口在 `TurnCoordinator.beginAutoTurn`（不收 source 参数）。
- envelope 的回传地址（`origin.from` sock、body `[from]` 行的 sessionId）在 `extractExternalDisplayContent` 中被剥掉，**不上抛到 feature 层**——即使补 source 也只有 `kind`，拿不到回传地址。
- "来自手机"的三种识别途径及可靠性：① `origin.from` sock 路径——无法区分手机中转和本机 session 转发（都是 uds sock）；② body 文本标记 `[from 用户,经手机私聊转达]`——prompt 约定，可靠性=信箱读取流程的模型遵从度；③ courier 侧显式协议标记（用户直觉）——在发送侧把标记写进 body（如 `[via] phone-private`），vault 侧可控，claudian 解析 body 检测。三者都不硬。

### 问题 2 的答案：回传通道的三个硬事实

1. **本机→手机唯一通道是信箱**（`.session-message-inbox/`，`session_inbox.py put`）。信箱是**显式异步 transport**：设计文档明确"手机私聊唤醒需查信箱"——**拉取式，仅手机用户发消息唤醒 dxchannel 私聊 session 时才 peek 转述**；ack 是"回复生成前确认"，非手机端送达回执（[[2026-08-24-跨session查询与信箱职能归位]]）。**没有已知的手机端推送/轮询机制**——待用户确认。
2. **SendMessage 是 harness 层 agent 工具**（经 ListAgents 实时 name 寻址），**claude-agent-sdk 类型里没有 SendMessage/ListAgents**（实测 grep 0 匹配）——claudian 进程内无现成跨 session 发送能力，要发 UDS 消息需逆向/复刻 harness 协议。信箱是纯文件写，claudian 进程内可直接做（schema 简单：from/target/time/text JSON 原子写）。
3. **dxchannel 消息纯文本**（CLAUDE.md/skill 双处声明）：AskUserQuestion 的结构化选项必须文本化编码（编号列表），回复解析（"1"/"选2"/label 匹配）需容错设计。

### 问题 5 的答案（核心难点）：回复关联 vs 新 turn 提升

手机回复经 dxchannel→courier→UDS 到达目标 CLI 时存在**双路径**：

- **CLI harness 层**：ask 阻塞期间（CLI 等 control_response），消息入 CLI 队列排队，turn 结束后才 dequeue 成新 user turn（2.5.1 F1 注释实证："the CLI waiting on control_response forever"）。消息不丢，但**不会被解析成 answers**。
- **transcript observer 层**：回复落行为新 peer user 行 → mapper `closeBeforeNextUser` 会把挂起 ask 轮的 mapper 状态**强制收尾**（terminalCandidate→`finished(next_user)`，否则→`interrupted(protocol_gap)`）→ 新 `observed_start` 入 FIFO → `promote()` 调 `beginAutoTurn` 失败（feature lease 被 ask 轮持有）→ **unshift 回 FIFO 死等**旧 turn settle。

当前没有任何"回复→挂起 ask"的关联机制。若方案 A 要做：claudian 须在 mapper 收尾**之前**（fact adapter 层）识别 reply 标记并消化，且要处理 resolve ask 后 CLI 队列同条消息仍会 dequeue 成重复 turn 的语义污染（同一条"选1"既进了 updatedInput.answers 又成为新 user 消息）。

### courier 侧 vs claudian 侧的边界（问题 3）

courier 只存在于**发送侧**（peer envelope 的产生），ask 事件发生在**接收侧**的 canUseTool 链路——此时 courier 早已退场。所以纯 courier 改造只能解决两件事：① 在 body 里加显式标记（让 claudian/agent 可识别"手机来的"）；② 固化回复格式约定。**接住 ask 的工作必须在 claudian（canUseTool 拦截）或 agent prompt（行为约定）侧做**。跨仓库切分：标记的产生归 vault（session-send skill / 信箱读取流程 / CLAUDE.md），标记的消费归 claudian（或 agent prompt）。

## 方案设计

### 方案 A：claudian 全链路回传（用户描述的理想形态）

识别 ask 发起轮的 peer 来源 → 不弹本机卡片 → 问题+选项编码成文本写信箱 → 手机回复进来时 observer 拦截 → 解析成 answers → resolve promise → 超时兜底。

**被三个硬约束卡住**：

1. **信箱时效**：拉取式，手机用户不知道有 ask 挂着就不会来唤醒 → 5 分钟窗口内大概率无人答 → 超时 deny 照旧。除非手机端有推送能力（待确认项 1，决定 A 的生死）。若延长超时到小时级，pending canUseTool 无界挂起 auto lease——正是 2.5.1 F2 要防的 ESC 卡死家族回归。
2. **本机 peer 无出口**：claudian 进程内无 SendMessage；peer 转发轮不只来自手机（c8f938ab 的发起方就是本机另一 session fae6e891，同样白等 deny），对非手机 peer 回传只能走 UDS 协议实现（大工程）。
3. **拦截时序与双路径**：须抢在 mapper `closeBeforeNextUser` 之前识别 reply 并消化（provider 层 fact adapter 改动），且接受 CLI 队列重复 dequeue 的语义污染（同条消息二次入 turn）。

改动面：`AutoTurnSource` 加 via 字段（mapper 解析 body 协议行）+ `ActiveFeatureTurn` 加 source + 信箱写模块（provider 层新文件）+ observer/factAdapter 拦截 + 回复解析器 + 超时管理 + vault 侧 courier 标记协议——**跨两仓、五层**。

### 方案 B：纯 agent 层约定（vault 侧，零插件改动）

在 CLAUDE.md「跨 session 协作与远程监控」节加一条规则：**peer 转发轮（识别 envelope 的 [from] 字段或 `[from 用户,经手机私聊转达]` 标记）触发的任务，需要用户裁决时禁用 AskUserQuestion（发起人不在本机键盘前），改用"文本提问 + 派 courier phone-private 写信箱 + end_turn"**，回复作为新 peer turn 进来时继续。

- 为什么可能更简单：零 claudian 改动；**异步信箱语义天然契合**——turn 正常结束无挂起 lease、无超时问题（问题留在信箱里，什么时候回都行）、回复天然成为新 turn（与现有 peer 问答环同构，无拦截/关联/双路径问题）、mapper 状态机无冲突（turn 已 end_turn，`closeBeforeNextUser` 走正常 `next_user` 路径）。
- 为什么不可靠：agent 不一定听话（现状就是这么坏的——c8f938ab 里 agent 调了 AskUserQuestion）；CLAUDE.md 注入常驻但长会话漂移真实存在；无结构化保证（问题/答案以自然语言进上下文）。

### 方案 C：claudian 侧 ask 路由兜底（小改动）

`auto + peer 来源`的 ask 不再走 5 分钟白等：保留短窗本机卡片（本机在场者可抢答，c8f938ab 手动救场证明该场景真实存在），窗口从 5 分钟缩到短窗（建议 30–60 秒），超时 deny。可选增强：deny 时带指引文案（需扩 `AskUserQuestionCallback` 契约加 relay 哨兵，`ClaudeApprovalHandler` 对哨兵返回 `deny + interrupt:false + 指引文本`，模型收到反馈后转文本提问，turn 不断）。最小版不动 ask 契约。

识别用 `source.kind==='peer'` 即可，**无需精确区分手机**：本机 peer 转发轮的发起人（另一 session 的 agent）同样不在本机键盘前，白等 deny 同样成立——规则统一为"peer 轮 ask 一律短窗+异步化"。

改动面（C 最小版）：
- `src/features/chat/controllers/TurnCoordinator.ts`：`ActiveFeatureTurn` 加 `source?: AutoTurnSource`，`beginAutoTurn` 收参
- `src/features/chat/controllers/AutoTurnProjectionController.ts`：`started` 传 `event.source`
- `src/features/chat/controllers/InputController.ts`：`handleAskUserQuestion` 加 peer-auto 分支（短窗参数化 `AUTO_TURN_ASK_TIMEOUT_MS`）
- i18n 10 locale 超时文案区分场景
- 测试：`InputController.test.ts` 补 peer-auto 用例 + `TurnCoordinator` source 传播用例

### 推荐：B + C 组合（B 为主路径，C 为硬兜底）

- B 解决"怎么问"（agent 主动走信箱异步问答），C 解决"agent 没听话时别白等 5 分钟"（短窗快速 deny，turn 断后模型下轮从 transcript 记忆捡起）。
- 组合后 peer 场景 5 分钟白等消失，无挂起风险（C 短窗兜底 + B 主路径零挂起），改动面收敛在 InputController 一处分支 + CLAUDE.md 一条规则。
- 方案 A 列为理想终态保留：**仅当待确认项 1（手机端推送能力）确认存在时才值得立项**，否则其时效假设不成立。

## 风险与权衡

1. **B 的遵从度风险**：规则是软约束，靠 C 兜底；C 的最小版 turn 会断（deny+STOP），模型重新捡起依赖 transcript 记忆，多烧一轮上下文——可接受（现状白等 5 分钟后同样断）。
2. **`deny + interrupt:false` 的 SDK 行为未实证**：ask 分支无先例（approval 分支有），SDK 对 AskUserQuestion 的 deny 是否支持非 interrupt 需真机对拍——C 增强版的前置验证项。
3. **C 短窗剥夺本机抢答**：30–60 秒内本机用户没答即 deny；若本机用户正在深度旁观 peer 轮（罕见），会提前断。参数可调。
4. **信箱语义污染**：B 路径 agent 写信箱频率上升（每次提问一条），50 条/from 上限（`session_inbox.py`）足够；ack 仍是 best-effort。
5. **方案 A 若未来立项**：mapper 拦截与 `closeBeforeNextUser` 的时序竞态、CLI 队列重复 dequeue、[from] sessionId 白名单稳定性三个坑需专项设计。

## 待用户确认项

1. **手机端信箱拉取机制**（决定方案 A 生死）：是否仅"用户发消息唤醒 dxchannel 私聊 session 时"才 peek 信箱？有无推送/轮询能力（大象通知等）让手机被动收到"有 ask 挂着"？
2. **C 的短窗时长**：30 秒 / 60 秒 / 保持 5 分钟？
3. **C 是否做增强版**（改 ask 契约带指引文案，依赖待验证的 `deny+interrupt:false` 行为），还是先最小版？
4. **[from] 行 sessionId 稳定性**（仅方案 A 需要）：手机私聊 dxchannel session 的 [from] 身份是否跨次稳定可作白名单？（实测两次不同 PID 但同一 [from] UUID，样本不足）

## 验证方式

- **B**：手机发一条需要裁决的任务（如"某方案选 A 还是 B"）→ 观察 agent 是否文本提问+信箱落一条（`session_inbox.py peek`）+ turn end_turn；手机回复后新 peer turn 进来且 agent 拿到答案继续。
- **C**：单测——`InputController.test.ts` 模拟 peer-auto turn 下 ask：断言短窗超时 deny、卡片原位超时提示；user turn 与 notification-continuation auto turn 行为零变化（对拍 3.1.3 既有测试）。真机——peer 轮触发 ask，本机不答，确认短窗内 deny（不再等 5 分钟）。
- **回归**：`npm run typecheck && npm run lint && npm run test`（claudian 仓）；2.5.1 F1/F1b/F2 及 3.1.3 用例全绿。
- **deny+interrupt:false 行为**（若做增强版）：真机 transcript 对拍 tool_result 文本形态。

## 关联

- [[2026-08-24-跨session查询与信箱职能归位]]
- [[2026-08-20-信箱与身份join操作细节]]
- [[2026-08-19-官方cross-session-messaging缓存稳定使用方案]]
- [[2026-09-11-claudian-v6全tab冻结根因诊断]]（observer/auto turn 生命周期背景）
- claudian 仓 3.1.3 提交 398df33d（auto 轮 ask 卡片化 + 5 分钟超时兜底）
