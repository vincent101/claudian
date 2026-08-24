---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - claudian
  - lifecycle
  - debugging
---

# Claudian streaming tab 持续红色根因审计

## 背景与问题

当前 `2f700e4` 中后台 Claude tab 在 streaming 期间持续显示红色；需先区分“streaming 本来就是红棕色”的渲染事实与 `needsAttention` 泄漏，再审计四条 attention 生命周期。

## 方案设计

### 根因结论

**最高置信结论：当前现象首先是渲染语义，不足以证明 attention 泄漏。** 当前源码和已部署 CSS 都把 Claude streaming 边框设为 `--claudian-brand-claude: #D97757`，视觉即红/砖红：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/style/components/tabs.css:39-45`
- `/Users/vincentwang/Documents/NoteVault/.obsidian/plugins/claudian/styles.css:243-249`
- `/Users/vincentwang/Documents/NoteVault/.obsidian/plugins/claudian/styles.css:9-13`

attention 才使用 `--text-error`：源码 `tabs.css:55-57`、部署 CSS `styles.css:259-261`。TabBar 只挂一个状态类，优先级为 `active > attention > streaming > review > idle`（`TabBar.ts:49-59`）；单测明确固定 `attention > streaming`（`TabBar.test.ts:169-177`）。因此：

- DOM 为 `claudian-tab-badge-streaming`：运行中红棕色是当前设计；修 A、ghost 修复都不会改变。
- DOM 为 `claudian-tab-badge-attention`：才进入 attention 泄漏调查。

仓库、已部署 `main.js`、`main.js.bak-hotfix-v1` 未发现额外 badge recolor/attention CSS 注入；当前源码与部署 CSS 一致。旧设计记录也曾明确记载“红=运行中”（[[2026-08-06-claudian标题栏等待回答状态颜色方案]]:15,37）。

### 四触发点生命周期矩阵

| 触发点 | 正常/提交 | cancel | lifecycle invalidate / destroy | 结论 |
|---|---|---|---|---|
| ① Permission approval，`Tab.ts:1656-1664` | `InlineAskUserQuestion.handleResolve` → Promise resolve → `finally endAttention` | `ClaudeChatRuntime.cancel()` 仅调用 permission dismisser（`ClaudeChatRuntime.ts:2281-2287`）；它销毁 `pendingApprovalInline`（`Tab.ts:1667-1669`，`InputController.ts:1479-1483`） | `createNew/switchTo/destroyTab` 均走全量 `dismissPendingApproval()`（`ConversationController.ts:96,247`；`Tab.ts:1604-1605`） | **存在实质竞态**：SDK `CanUseTool` 明确提供 `options.signal`（SDK `sdk.d.ts:146-188`），但共享 `ApprovalCallbackOptions` 不含 signal（`core/runtime/types.ts:24-38`），`ClaudeApprovalHandler.ts:112-120` 丢弃它。若取消先发生、permission callback 后到，dismisser 当时无卡片，后到 callback 仍渲染并永久等待；与修 A 前竞态同型。 |
| ② AskUserQuestion，`Tab.ts:1670-1678` | 提交/拒绝均 resolve，finally 配对 | signal abort → `handleResolve(null)`；已 abort 预检（`InlineAskUserQuestion.ts:57-64,107-110`） | 全量 dismiss（`InputController.ts:1486-1491`） | 单实例路径已闭合。残余风险是同类型并发覆盖单槽 `pendingAskInline`。 |
| ③ ExitPlanMode，`Tab.ts:1681-1689` | 决策 resolve，finally 配对 | signal abort + 已 abort 预检（`InlineExitPlanMode.ts:44-51,137-140`） | 全量 dismiss（`InputController.ts:1492-1495`） | 单实例路径已闭合。残余风险是同类型并发覆盖单槽。 |
| ④ post-plan approval，`InputController.ts:516-543` | `InlinePlanApproval` 的 implement/revise/cancel/Esc 均 resolve（`InlinePlanApproval.ts:42-75,93-140,175-181`） | 它发生在流结束、feature lease 已于 `InputController.ts:507-515` 释放后；普通 streaming cancel 已无作用 | 全量 dismiss 标记 invalidated，再 resolve（`InputController.ts:1496,1533-1543`） | 不能解释“同一旧 turn 仍 streaming 且红”。设计上等待期间 `isStreaming=false`。除非已有 attention 计数泄漏后新 turn 开始，才会见到 streaming+attention。 |

### endAttention 不可达组合

1. **高风险、可由代码推出：permission late callback after cancel。** `cancel()` 先调用 dismisser，后取消/中断；普通 approval 没有 signal 预检能力。后到 callback 会 `beginAttention()`，但没有后续 destroy/resolve 保证。
2. **中风险：同类型并发覆盖 pending 单槽。** 四类 pending 各自只有一个字段（`InputController.ts:108-111`）；第二个同类交互覆盖第一个后，全量 dismiss 只能销毁最后一个。第一个 Promise 与 attention 计数可永久悬挂。并行 subagent 使 permission 同类并发具备现实来源。
3. **低风险：Ask/Exit interrupt 信号未及时到达。** 普通 `cancel()` 的显式 dismisser仍只处理 permission；Ask/Exit依赖 SDK 将 interrupt 传播到 `options.signal`。SDK 类型只承诺 signal 表示应中止，并不替宿主 UI 做清理。生命周期切换/销毁不受此风险，因为其直接全量 dismiss。
4. **④本身无已见不可达路径。** `destroy()` 幂等 resolve；外部失效测试存在（`InputController.test.ts:3255-3290`）。

### streaming 中置位时序

- ①②③均发生在 Claude `canUseTool` 阻塞期间；此时 `InputController.sendMessage()` 的 `state.isStreaming` 直到 finally 的 `InputController.ts:448-456` 才清零。因此“streaming + attention”对真实待交互卡是合法组合，TabBar 按 attention 显示红色。
- ④在 `state.isStreaming=false` 与 feature lease `finish()` 之后才 beginAttention（`InputController.ts:454-455,507-525`），本身不是“运行中红色”的来源。
- 自动 turn 由首个非纯 notification 消息创建并同步置 `isStreaming=true`（`ClaudeChatRuntime.ts:988-990`；`TurnCoordinator.ts:80-92`）；若该 turn 调用 ①②③，同样合法进入 streaming+attention。
- auto turn 被取消时 runtime 只清 feature lease（`ClaudeChatRuntime.ts:1380-1431`；`TurnCoordinator.ts:157-165`）；交互 UI 的收敛仍依赖 query interrupt signal 或 permission dismisser。故上述 ①晚到竞态和同类覆盖在 auto turn 同样成立。
- 纯 task-notification 当前直接销账、不建 auto lease（`ClaudeChatRuntime.ts:969-983`），与本次红色无直接因果；continuation 从后续首个 assistant/stream 消息再建 auto turn。

### 推荐修复方向（不实施）

理想终态不是继续给三个组件补洞，而是把“等待用户动作”建模成带唯一 interaction ID、AbortSignal 和幂等 settle 的统一注册表：

1. `ApprovalCallbackOptions` 透传 SDK `signal`；permission 与 Ask/Exit 共用同一 abort-aware interaction primitive。
2. `InputController` 用 `Map<interactionId, interaction>` 取代四个单槽字段；每个 interaction 自带 `dispose/resolve-once`。
3. attention 不再独立手工计数，而由未结算 interaction registry 派生；lifecycle invalidate/cancel/destroy 对 registry 做原子 `settleAll(reason)`。
4. post-plan approval也注册为 interaction，但标记 phase=`post-turn`，避免错误归入 streaming。
5. 若只做最小修复：至少把 ① 的 `options.signal` 透传并做 aborted 预检，同时让 runtime cancel 调用全量 dismiss；但这不能解决同类型并发覆盖，非理想终态。

## 风险与权衡

- **代码无法仅凭“看起来红”判定状态类。** `#D97757` 与主题 `--text-error` 都可被人眼描述为红；必须读取 DOM class。
- 未拿到本次复现时的卡片/DOM/计数现场，故不能断言已实际命中 ①竞态；只能确认它在当前代码中真实存在。
- 桌面通知缺失不是反证：`Notification.permission !== 'granted'` 时静默返回（`desktopNotifier.ts:28-35`），且只在后台 tab 的 `false→true` attention 边沿触发（`TabManager.ts:212-216`）；已为 true 的泄漏不会再次通知。
- 现有相关测试 7 suites / 426 tests 全过，但未覆盖 `setupServiceCallbacks` 的 attention 配对、permission 的 already-aborted signal、同类并发覆盖。测试通过不能排除上述竞态。

### 迁移/落地代价

统一 interaction registry 会改动 core callback contract、Claude/Codex/OpenCode adaptor、InputController、Tab wiring 与并发测试；成本高，但能消除“计数器与 UI pending 状态分属两套真相源”的结构性缺陷。可分阶段落地，目标模型不应妥协。

## 验证方式

### 用户一步取证（优先）

在 Obsidian 开发者控制台执行以下一行，然后把输出贴回：

```js
[...document.querySelectorAll('.claudian-tab-badge')].map((e,i)=>({tab:i+1,class:e.className,border:getComputedStyle(e).borderColor,label:e.getAttribute('aria-label')}))
```

判定：
- `claudian-tab-badge-streaming`：根因已锁定为当前 streaming 配色，不是 attention 泄漏。
- `claudian-tab-badge-attention`：再检查该 tab 是否有隐藏/可见交互卡；若没有，按 ①竞态优先调查。

### 针对性测试矩阵

1. permission：预先 abort signal 后调用 callback，期望不渲染、Promise 立即 settle、attention 归零。
2. permission：`cancel()` 后模拟 late callback，期望同上。
3. 同类并发：同一 tab 同时发起两个 permission；只结算第二个后第一个仍可被统一 dismiss，最终计数归零。
4. Ask/Exit：分别覆盖 abort-before-render、abort-after-render、runtime cancel、lifecycle invalidate。
5. post-plan：覆盖 finish lease → show prompt → lifecycle invalidate，以及 implement auto-send；新 turn 开始前旧 attention 必为零。
6. auto turn：在 auto turn 内触发 permission/Ask/Exit，再 cancel/invalidate；registry 与 feature lease 都必须归零。
7. 保留现有测试命令：

```bash
cd /Users/vincentwang/Documents/NoteVault/tools/claudian
npm test -- --runInBand tests/unit/features/chat/tabs/TabBar.test.ts tests/unit/features/chat/state/ChatState.test.ts tests/unit/features/chat/rendering/InlineAskUserQuestion.test.ts tests/unit/features/chat/rendering/InlineExitPlanMode.test.ts tests/unit/features/chat/rendering/InlinePlanApproval.test.ts tests/unit/features/chat/controllers/InputController.test.ts tests/unit/features/chat/tabs/Tab.test.ts
```

当前实测：7 suites、426 tests 全过。

## 关联

- [[2026-08-06-claudian标题栏等待回答状态颜色方案]]
- [[2026-08-07-claudian待查看状态第5色方案]]
- [[2026-08-22-Claudian阶段2空闲期管道回喂实施设计-v4]]
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabBar.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/InputController.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts`
