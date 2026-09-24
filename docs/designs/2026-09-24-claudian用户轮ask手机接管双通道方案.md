---
type: design-decision
status: implemented
target: "[[tools/claudian]] AskUserQuestion 手机接管（双通道答复）"
tags: [architect, claudian, cross-session, ask-user-question, phone-relay]
备注: fe 案例根因已实证；两路径方案待用户确认后实施
---

# claudian 用户轮 ask 手机接管双通道方案

## 背景与问题

用户在桌面发起的 turn 中，模型调 AskUserQuestion 弹卡片等桌面答复；用户已离场，手机消息全部入队未被消费，卡片死等近 16 小时（fe 案例）。要解决：手机能看到桌面 ask（问题+选项）并能答复，答复解除 canUseTool、回合继续；桌面卡片照常弹（不破坏在场体验）。

## 因果链实证（transcript 取证）

会话 `36351190-fff1-40e4-93ac-e474e7d7f27e`（notevault-fe，tab "fe"）。**事发为 2026-09-23 18:06 本地**（派单写 09-22，实差一天；UTC 2026-09-23T10:06:46Z）：

1. 该轮由 09:26:09Z 用户真实消息发起（桌面亲发）→ **user turn**，lease kind=user。
2. `10:06:46.237Z` assistant 发出 `tool_use: AskUserQuestion`（选项"提供真实抽样参数/回退二分对照"），**无 tool_result 直到次日** `2026-09-24T01:59:19.423Z`（挂起 15h52m33s）。期间无 5 分钟超时 deny → 印证用户轮走无界路径（`InputController.ts:1667-1668`：`kind !== 'auto'` 直接返回 `askPromise`）。
3. 手机三条消息（19:00/19:45/20:26 本地 = 11:00:31/11:45:32/12:26:52Z）落为 `queue-operation`（enqueue）记录，**未成为 user turn**。勘正：卡住的是 **CLI harness 的 control 队列**（transcript queue-operation），不是 claudian `ClaudeMessageChannel`（后者是 claudian 自身发送侧排队，8 条上限，同样只在回合间 dequeue）——手机消息从未经过 MessageChannel。
4. 次日 09:59 本地用户回桌面拒绝卡片（Esc→destroy→resolve(null)）→ tool_result "The user doesn't want to proceed"（deny+interrupt，`ClaudeApprovalHandler` ask 分支：`answers===null → deny+interrupt`）→ 回合结束 → 同秒队列排空，三条消息变为 user turn 被消费（02:03 模型答复"收到裁决"）。

因果链成立：**ask canUseTool 挂起 → 回合不结束 → CLI harness 队列不 dequeue**。用户轮无超时是设计事实（3.1.3 只给 auto 轮 5 分钟兜底）。

关键机制事实（代码实证）：
- ask 的 resolve 只存在于 UI 内：`InlineAskUserQuestion` 的 `resolveCallback`，由键盘/点击/`destroy()` 触发；`dismissPendingApprovalPrompt`（cancel 路径）同族。外部进程无任何注入点。
- 答复形状契约：callback 返回 `Record<string, string|string[]>`（键 = `question.id ?? question`，值 = `option.value ?? label` 或自定义文本）→ `{behavior:'allow', updatedInput:{...input, answers}}`，回合继续。
- 通知：`TabManager.notifyBackgroundTab` **只覆盖 background tab**（active tab 的 ask 零通知），通知体只有 tab 序号+标题、无问题内容。用户口述该通知能到达手机（机制未实证，按既有能力采用）。

## 方案设计

### 归属理由

方案成立的关键是 claudian 的 ask resolve 旁路——改动主体、风险主体、测试主体均在 claudian 仓；vault 协议层（脚本/skill/规则）是配套消费方。故落盘 claudian 仓，跨仓切分在文内分节列明。

### 目标态架构：ask 双通道等待（先到先得）

```
ask 弹出（任意 turn kind）
├─ 通道A：桌面卡片（现状不动）
└─ 通道B：relay 文件协议
    ├─ claudian 写 <vault>/.claudian/ask-relay/<sid8>.ask.json（normalize 管道导出的问题+选项+askId）
    ├─ 桌面通知（扩体：问题摘要+6 位 nonce；60s 未答触发，active/background tab 均覆盖）
    ├─ claudian 轮询 reply 文件（2s，仅 ask pending 期间存在）
    └─ 手机侧：大象 → dxchannel 私聊 session → ask_relay.py show/reply
         → claudian 校验（nonce+寻址+序号映射） → resolveExternal(answers)
         → 卡片消失、回合继续
         → CLI 队列消息随后作为新 turn 正常消费（语义正确）
```

红线（协议层）：**ask 答复只走 reply 文件，禁止 SendMessage**——SendMessage 进 CLI 队列不会被当作答案（fe 案例实证）；答复与新指令分流，无重复 dequeue 污染（09-21 方案 A 的死结由此绕开，不碰 mapper/observer）。

### 注入点与协议形状

1. `InlineAskUserQuestion` 加公开 `resolveExternal(answers | null)`：内部走既有 `handleResolve`，`resolved` 守卫幂等——与 `raceAutoTurnAskTimeout` 同型先到先得，双通道竞态天然安全。
2. `InputController.handleAskUserQuestion` user-turn 分支 arm 新 `AskRelayService`（features/chat/services/，deps 注入）：写 ask 文件、起轮询、reply 校验（nonce 匹配+失败计数、sessionId 寻址匹配、askId 匹配、questionIndex 范围、picks 映射 `options[i].value ?? label`、multiSelect 数组、text 并存追加）、调 `pendingAskInline.resolveExternal`；settle（任一通道）后清文件、丢弃晚到 reply；启动清扫孤儿。接口按 `armFor(turnKind, sessionId, input)` 通用设计，Phase 1 只在 user-turn 分支调用（分期不改接口）。
3. 协议（`.claudian/ask-relay/`，gitignore；原子写 tmp+rename）：
   - `<sid8>.ask.json`（sid8=sessionId 前 8 位，会话寻址；同会话同时至多一张 pending ask——一个 tab 同时只有一个 pendingAskInline，且同一 conversation 被 tab 独占）：`{askId, sessionId, sessionName, turnKind, createdAt, questions:[{question, header, multiSelect, isSecret, options:[{label, description}]}]}`。**questions 必须从与桌面 UI 完全相同的 normalize 管道导出**——把 `InlineAskUserQuestion` 的 `parseQuestions/coerceOption/deduplicateOptions/extractLabel/extractValue` 抽成共享函数（`normalizeAskQuestions(input)`），桌面渲染与 ask.json 序列化走同一代码路径；禁止从 raw input 二次序列化——normalize 的 filter（无效问题剔除）与 dedupe（label 去重）会改变选项序号，二次序列化将导致"手机选 A 桌面答 B"的序号错位。
   - `<askId>.reply.json`：`{askId, sessionId, nonce, answers:[{q:<0基index>, picks:[<1基序号>..], text?: string}], via:"phone-dxchannel", userQuote:"用户原话", repliedAt}`。`picks`=1 基序号数组（单选单元素、多选多元素，序号与 ask.json options 序一致）；`text`=自定义文本，可与 picks 并存（multiSelect 时 append 到值数组尾部、单选时覆盖值，同桌面 submit 语义）；picks 空且 text 空视为未答（拒绝）。**sessionId 必须与目标 ask.json 完全一致**——多 tab 可同时各挂一张 ask，reply 按此寻址字段路由到对应会话，不匹配即丢弃。
   - isSecret 问题默认拒答（要求回桌面输入），防大象通道泄敏感文本：ask.json 含 isSecret 问题时，claudian 一律拒绝该 ask 的 phone reply。
4. nonce 防猜（Phase 1 即含）：6 位数字，只出现在桌面通知体（ask 文件不含），reply 必须携带；连续校验失败 5 次作废该 pending 的 relay 通道（删 ask 文件、停止接受 reply），桌面卡片继续等待桌面答复（不 deny 回合——防故意输错 5 次 DoS 掉用户回合）。
5. 轮询 vs 推送：**轮询 2s**。生命周期有界（仅 ask pending 期间）、零常驻成本、无 fs.watch 平台差异；fs.watch 列为可选优化非必需。
6. vault 侧：`session-send/scripts/ask_relay.py`（show/reply/clean 三动词，对齐 session_inbox.py 风格）；SKILL.md 增"ask 应答模式"；CLAUDE.md 跨 session 节增一条 dxchannel 私聊职责（判权沿用三档：owner 私聊全权）。

### 两条路径

**[务实] 最小止血（user-turn only）**：上述 1-6（含第 4 条 nonce 硬化，6 位+失败计数随本期落地）+ 通知扩体与补发（Tab.ts ask 包装处 60s 延迟通知，desktopNotifier 加 `detail` 参数 + i18n 10 locale 2 串；通知体含问题摘要+nonce，active/background tab 均覆盖——background 另有既有即时轻通知，60s detail 通知为第二级）。auto turn 保持 3.1.3 现状（5 分钟 deny+interrupt）。成本：claudian 约 1.5-2 天实施+测试，vault 半天。不动 promise/lease 主链路，只加旁路 resolve，回归面小。

**[理想] 完整目标态**：务实全部内容，另加：
- **auto turn ask 语义分层**（解派生问题 3）：做 09-21 C-mini 的 source 传播链（`TurnCoordinator.ActiveFeatureTurn + source`，`beginAutoTurn` 收参，`AutoTurnProjectionController.started` 传递）——phone-originated（peer）auto turn 的 ask 也 arm relay 且窗口 5min→30min；task-notification 轮维持 5min。分层判据是"在场用户在哪"，不是轮种类。
- **身份硬化收尾**：nonce（6 位+失败计数）已随 Phase 1 落地；本期补 `userQuote` 审计 + claudian 渲染"经手机答复"标记。
- **B 规则收窄**：peer 转发轮恢复可用 AskUserQuestion（答复通道已统一）；轻量确认仍走文本。CLAUDE.md 措辞修订。
- settings 化（开关/窗口时长）、ExitPlanMode/approval 卡片纳入 relay 的接口预留（不实施）。
成本：claudian 3-5 天（含 auto turn 生命周期回归），vault 1 天。

### 派生问题裁决

- **用户轮超时（问题 2）：不引入**。fe 型死点根因是"无人可达"而非"无界等待"；relay 消除前者后，无界等待语义正确（用户何时答由用户定）。deny+interrupt 对用户轮是替用户结束回合——队列可能为空，回合静默死亡比等待更糟。relay 关闭时维持现状无界，不回归。
- **B 规则 vs relay（问题 5）：互补**。B 管"提问时发起人已知缺席"（结构化卡片无意义）；relay 管"在场者意外离场"。理想阶段 B 才收窄。

### 分期推荐（架构不妥协、实施分期）

- **Phase 1 = 务实 + nonce 硬化**（nonce 6 位+失败计数前移至本期；立即消除 fe 型死点）。
- **Phase 2 = source 传播 + auto turn 分层 + B 收窄 + settings 化**（原 P2/P3 合并：nonce 既已前移，剩余项一次收口；依赖 Phase 1 真机验证）。
AskRelayService 通用接口在 Phase 1 一次定型，后续期只扩调用点不改契约。

### 改动归属清单

| 层 | 内容 |
|---|---|
| claudian 代码 | `InlineAskUserQuestion.resolveExternal`、共享 normalize 管道抽取（`normalizeAskQuestions`）、`AskRelayService`（新，含 nonce/失败计数/寻址路由）、`InputController` user-turn 分支、`Tab.ts`/`desktopNotifier` 通知扩体（含 nonce）、i18n、（Phase 2）TurnCoordinator source 链 |
| 协议/skill/规则（vault） | `ask_relay.py`（新）、session-send SKILL.md 增节、CLAUDE.md 跨 session 节增条、（P3）B 规则修订、`.gitignore` |
| 零改动 | 信箱、courier、SendMessage、macOS 通知镜像（纯使用） |

## 风险与权衡

1. **通知到达手机的机制未实证**（用户口述"曾收到 tab7：xxx"）：通知体加长后 iOS/Watch 截断需真机验证；退路=拉取式（用户主动问 dxchannel "看 ask"）仍闭环，不依赖通知。
2. **身份软约束残余风险**：nonce（6 位+失败计数作废）已随 Phase 1 落地——非 owner 本机 agent 在无 macOS 通知库读取能力时无法自答。残余：能对抗性读取通知库的本机进程可取 nonce，超出当前威胁模型（与信箱现状同级）；连续输错 5 次可作废 relay 通道（桌面卡片不受影响，仅迫使回桌面答复）。userQuote 审计 + "经手机答复"标记留 Phase 2。
3. **手机答复算不算用户授权**：AskUserQuestion 是偏好选择非权限授予；owner 私聊通道的回答等同桌面键入（同一 Unix 用户、同一意图链）。不适用"peer 消息≠授权"——该原则管的是权限/敏感操作授权转移。
4. **answers 形状映射错误**（label/value 键、multiSelect、id 缺省回落 question 文本）：reply 以 1 基序号数组（picks）+ 可选 text 为主编码，index→value 映射收在 claudian 单侧、且 questions 从共享 normalize 管道导出（杜绝序号错位），单测锁 SDK 契约形状。
5. **竞态/生命周期**：resolved 守卫既有先例；Obsidian 重启中断 ask 属现状行为（SDK 连接断开本来 abort turn），孤儿清扫兜底。
6. **`deny+interrupt:false` 未实证**（若未来做用户轮超时兜底才需要）：本方案不依赖该行为。

## 验证方式

- **因果链复证**：`python3` 扫 `36351190-...jsonl`——10:06:46Z tool_use 后无 tool_result 直至次日 01:59:19Z；三条 queue-operation（11:00/11:45/12:26Z）在 01:59:19Z 后同秒变 user 行。
- **单测**：`AskRelayService.test.ts`（ask.json 与桌面渲染同源 normalize 导出、reply 校验含 picks 映射/text 并存/单选多 pick 拒绝、nonce 失败计数作废、sessionId 寻址路由、晚到丢弃、孤儿清扫）；`askQuestions.test.ts`（normalize 管道对齐）；`InlineAskUserQuestion.test.ts` 补 `resolveExternal` 先到先得用例；`InputController.test.ts` 补 relay resolve 用例（断言 answers 走 allow 路径）+ 桌面先答→晚到 reply 丢弃；对拍 3.1.3 既有用例零变化（auto turn 分支不动）。TDD 先行。
- **真机 E2E（复刻 fe）**：桌面发 turn → 离场 → 确认手机收通知 → 大象问 dxchannel → `ask_relay.py show`/`reply` → 桌面卡片消失、回合继续、CLI 队列消息作为新 turn 消费；反向：桌面先答、手机 reply 被丢弃。
- **回归**：`npm run typecheck && npm run lint && npm run test && npm run build`；2.5.1 F1/F1b/F2 用例全绿。

## 关联

- [[2026-09-21-claudian跨端AskUserQuestion回传方案]]（前案：A 弃、B 已落 CLAUDE.md、C 未采纳——本方案是其 user-turn 补集）
- [[2026-09-14-Claudian-v6-auto-turn收口冻结根因与修复]]（5 分钟兜底语义来源）
- [[2026-08-24-跨session查询与信箱职能归位]]、[[2026-08-20-信箱与身份join操作细节]]
- fe transcript：`~/.claude/projects/-Users-vincentwang-Documents-NoteVault/36351190-fff1-40e4-93ac-e474e7d7f27e.jsonl`

## 实施记录（Phase 1，2026-09-24）

改动文件清单：

**claudian 仓**（分支 hotfix/notify-lease，未 commit）：
- `src/features/chat/rendering/askQuestions.ts`（新）：共享 normalize 管道（`normalizeAskQuestions`/`toRelayQuestions`），桌面渲染与 ask.json 导出同一代码路径
- `src/features/chat/rendering/InlineAskUserQuestion.ts`：解析逻辑改用共享管道；新增 `resolveExternal(answers | null)`（resolved 守卫先到先得）
- `src/features/chat/services/AskRelayService.ts`（新）：arm/dispose/2s 轮询、nonce（6 位）校验+连续 5 次失败作废 relay 通道（桌面卡片继续等待）、sessionId 寻址路由、isSecret 拒答、reply 结构校验与桌面 submit 语义映射、启动清扫 `cleanupAskRelayFiles`
- `src/features/chat/controllers/InputController.ts`：user-turn 分支 `armAskRelay`（arm + 60s 通知定时器 one-shot race + settle 后 dispose）；deps 增 `getAskRelay`/`onAskAttentionTimeout`
- `src/features/chat/tabs/types.ts`：`TabData.onAskAttentionTimeout`、`TabServices.askRelay`
- `src/features/chat/tabs/Tab.ts`：`TabCreateOptions.onAskAttentionTimeout` 透传；`initializeTabControllers` 创建 per-tab `AskRelayService` 并注入 InputController deps
- `src/features/chat/tabs/TabManager.ts`：`notifyAskPending`（tab 序号+标题+摘要+nonce，active/background 均发）
- `src/features/chat/tabs/desktopNotifier.ts`：`detail` 参数 + `chat.notifications.needsAttentionDetail` 分支
- `src/i18n/types.ts` + `src/i18n/locales/*.json` ×10：新 key（en/zh-CN/zh-TW 实翻，其余英文占位，对齐既有模式）
- `src/main.ts`：onload 启动清扫孤儿（`cleanupAskRelayFiles`）
- 测试：`tests/unit/features/chat/rendering/askQuestions.test.ts`（新）、`tests/unit/features/chat/services/AskRelayService.test.ts`（新，24 用例）、`InlineAskUserQuestion.test.ts`（+resolveExternal 先到先得 3 用例）、`InputController.test.ts`（+relay 5 用例：arm+60s 通知、reply 走 allow 路径、桌面先答晚到 reply 无效、auto turn 不 arm、无 sessionId 不 arm）

**vault 仓**：
- `.claude/skills/session-send/scripts/ask_relay.py`（新）：show/reply/clean 三动词，reply 客户端预校验 + 原子写 + `--wait` 消费结果轮询（accepted/rejected/timeout）
- `.claude/skills/session-send/scripts/test_ask_relay.py`（新，18 用例）
- `.claude/skills/session-send/SKILL.md`：增"ask 应答模式"节（判权三档 + 红线）
- `CLAUDE.md`：跨 session 节增"手机代答桌面 ask"条
- `.gitignore`：`.claudian/ask-relay/`

关键偏差（实施细节与方案文本的差异，非架构变更）：
1. **60s 通知落点**：方案写"Tab.ts ask 包装处 60s 延迟通知"；实施为 InputController.armAskRelay 持有定时器（与 raceAutoTurnAskTimeout 同型 one-shot race），经 `onAskAttentionTimeout` 回调链（Tab.ts → TabData → TabManager.notifyAskPending）发通知——定时器生命周期与 ask promise 同置更内聚；background tab 的既有即时轻通知（onAttentionChanged 链）保持不动，60s detail 通知为第二级（通知宁滥勿缺）。
2. **ask.json 增 `isOther` 字段**：协议修订条目未列，实施需要（手机侧判断能否自定义文本；`ask_relay.py` 据此校验 --text）。
3. **reply 必须覆盖所有问题**：方案未明说；实施按桌面 submit 的 allAnswered 语义补齐（answers.length 必须等于问题数）。
4. **isSecret 拒答粒度**：实施为 ask 含任一 isSecret 问题 → 该 ask 的所有 phone reply 一律拒绝（严格版，协议字段自描述防歧义）。
5. **armFor 同步写**（writeFileSync + rename）：保证 arm 返回时 nonce/askId 立即可用于通知，调用方无需 await。

验证结果：`npm run typecheck && npm run lint && npm test`（245 suites / 6351 tests）全绿；`npm run build` 产物 main.js（4.5MB）+ styles.css；vault 侧 `test_ask_relay.py` 18 用例 OK，show/reply 冒烟（协议形状对拍）通过。

复核修复（reviewer 修订后可交付，2026-09-24 二轮）：① arm 全链路 fail-safe——`AskRelayService.armFor` 写文件失败吞异常+`console.warn` 诊断并返回 null，`InputController.armAskRelay` 整体 try/catch，旁路故障不再冒泡为 deny+interrupt；② corrupt-reply 测试目录错（断言恒真）改对并经红→绿反转验证（临时破坏 catch 分支该用例转红）；③ nonce 作废经 per-arm `onArmInvalidated` 回调取消 60s 通知定时器，Tab.ts 构造级 `onInvalidated` 接诊断日志；④ `ask_relay.py wait_for_result` TOCTOU 修复（ask 消失单条件判 accepted + 4s 确认窗口，防 reply 先删 ask 后删窗口期误报 rejected）；⑤ 删除 validate_reply 死代码。修后 245 suites / 6354 tests 全绿、build 通过、test_ask_relay.py 19 用例 OK。

待真机验证（方案风险 1 既有项，非本期代码遗留）：macOS 通知到达手机的机制与 iOS/Watch 截断表现；E2E 复刻 fe 场景（桌面发 turn → 离场 → 手机 ask_relay.py reply → 卡片消失、回合继续、CLI 队列消息作为新 turn 消费）。
