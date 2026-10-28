---
type: design-decision
status: draft
target: tools/claudian
tags:
  - architect
  - claudian
  - tab-bar
  - session-metadata
---

# Tab 栏右键「更改会话标题」方案（[务实]）

## 背景与问题

「复制会话标题」已落地（TabBar.ts showContextMenu 菜单首项）。现要求在聊天 tab 右键菜单新增「更改会话标题」：复用已有改名链路，避免另起写入路径。核心发现：**改名能力已完整存在**（历史下拉内联改名 + `plugin.renameConversation`），本功能只是新增一个入口，真正要做的是入口接线、UI 形态选择、手改标题防覆盖确认、刷新补齐。

## 已核实盘点（file:line）

**现有改名入口与调用链**：
- 历史下拉每条会话：铅笔按钮（ConversationController.ts:1582-1587）+ 右键菜单 Rename（:1667-1669）→ `showRenameInput`（:1771-1806）：DOM 内联 input 替换标题元素，blur/Enter 提交，Escape 还原；`input.value.trim() || currentTitle`（空值回退原标题）。
- 提交链：`plugin.renameConversation(convId, newTitle)`（main.ts:733-743）→ 内存 `conversation.title` 赋值 + `updatedAt=Date.now()` → `storage.sessions.saveMetadata(toSessionMetadata(conversation))`。随后 `plugin.updateConversation(convId, { titleGenerationStatus: undefined })`（ConversationController.ts:1789）→ `updateHistoryDropdown()`（:1790）。
- `updateConversation`（main.ts:745-757）：Object.assign 到同一内存对象再全量存 meta；`titleGenerationStatus: undefined` 经 JSON.stringify 后键被剔除。

**写入路径与原子性**：`SessionStorage.saveMetadata`（SessionStorage.ts:27-32）→ `VaultFileAdapter.write`（VaultFileAdapter.ts:23-26）→ `app.vault.adapter.write` 直写，**非原子**（截断风险属实）。`adapter.rename` 存在（exportHistory 已用，ConversationController.ts:1739）。

**手改 vs 自动生成的优先级机制（无需 schema 扩展）**：
- 自动标题两处触发：首轮 fallback + AI 生成（InputController.ts:1392-1439）；每 10 条用户消息静默重生成（InputController.ts:694-704，**仅当 `titleGenerationStatus === 'success' | 'failed'` 才触发**）。
- 手改防覆盖三重机制：① 生成回调比对 `expectedTitle`，不一致即跳过（InputController.ts:1423、ConversationController.ts:1968）；② 历史改名后清 status 为 undefined（ConversationController.ts:1789）→ 周期性重生成被门槛挡住；③ 首轮生成回调发现手改时也清 status（InputController.ts:1431-1434）。
- 结论：`titleGenerationStatus === undefined/缺失` 即"手改或不生成"哨兵，**现有 schema 足以表达优先级，不需要新字段**。新入口只需复刻「rename + 清 status」两步。

**刷新链缺口**：`onTabTitleChanged` 回调已声明并一路接线（types.ts:353 → TabManager.ts:255-257 → ClaudianView.ts:199 → updateTabBar），但 **Tab 侧从未发射，是死回调**（全仓无发射点）。现状任何标题变更（含历史改名、AI 标题落盘）都不即时刷新 tab 栏，靠下一个 streaming/attention 事件顺带刷。历史改名后 tab badge 滞后是既有缺口。

**TabBar 上下文菜单**：copyTitle 首项 + `setDisabled(!item.conversationTitle)`（TabBar.ts:220-236）；`TabBarItem`（types.ts:374-390）**无 conversationId 字段**，只有 `conversationTitle`。`TabBarCallbacks` 在 TabBar.ts:7（onTabClick/onTabClose/onNewTab/onTabReorder），由 ClaudianView.ts:280-286 注入。

**外部读取方兼容**（不改，仅确认）：
- `tools/model_proxy/core/claudian_titles.py`：正则 `^  "title": "` / `^  "updatedAt": (\d+)`（2 空格缩进=顶层键）+ 顶层 sessionId join、updatedAt 最新者胜。改名只改既有字段值，格式仍是 `JSON.stringify(meta, null, 2)`，**兼容**。注意：`renameConversation` 会 bump `updatedAt` → 同 sessionId 多 conv 时被改名的旧 conv 会抢 latest-wins；这是既有行为（历史改名同样如此），非本功能引入。
- `.claude/skills/session-send/scripts/session_list.py`：同样顶层 title/sessionId 前缀正则 + mtime join，**兼容**。无新增顶层字段，不碰 "title"/"sessionId"/"updatedAt" 命名即无碰撞。

**通知/窗口标题**：desktopNotifier 用 `getTabTitle`（desktopNotifier.ts:11/28/41/46 ← TabManager.ts:132/153）即时读内存 conversation.title，改名后下一次通知自动用新标题，无需额外接线。未发现 document.title / leaf header 写入点，窗口标题不消费会话标题。

## 方案设计

### 1. 交互形态：Obsidian Modal（推荐）vs 内联编辑

- **推荐：新建通用单输入 Modal**（`src/shared/modals/InputModal.ts`，参照 InstructionConfirmModal 的 Modal 用法）。预填当前标题，Enter/保存提交、Escape/取消关闭，按钮文案复用 `common.save`/`common.cancel`（zh-CN.json:3-4）。
- **弃选内联编辑 tab badge**（照搬历史下拉的 `.claudian-rename-input`）：tab 栏由 rAF 去抖的 `updateTabBar()` 全量重建（ClaudianView.ts:420-436），任何后台 tab 的 streaming/review/attention 变化都会触发——编辑中输入框随时被整栏重建销毁，改名内容丢失。历史下拉的内联 input 没有同等频率的重建源， precedent 不可迁移。badge 本身宽度也容不下编辑态。

### 2. 入口接线（最小 diff，沿用 copyTitle 结构）

1. `src/features/chat/tabs/types.ts`：`TabBarItem` 增加 `conversationId: string | null`（注释：null = 新建空 tab 未绑会话）。
2. `src/features/chat/tabs/TabManager.ts` `getTabBarItems()`（:671-690）：填充 `conversationId: tab.conversationId ?? null`。
3. `src/features/chat/tabs/TabBar.ts`：
   - `TabBarCallbacks` 增加 `onTabRename: (tabId: TabId) => void`；
   - `showContextMenu` 在 copyTitle 之后、分隔线之前插入菜单项：`setTitle(t('chat.tabs.renameTitle')).setIcon('pencil')`，`setDisabled(!item.conversationId)`（与 copyTitle 的禁用口径一致——空 tab 两者都禁用），onClick → `this.callbacks.onTabRename(item.id)`。
4. `src/features/chat/ClaudianView.ts`：TabBar 构造处（:280-286）注入 `onTabRename: (tabId) => void this.handleTabRename(tabId)`。
5. `handleTabRename(tabId)`（ClaudianView 新私有方法）：
   ```
   const tab = this.tabManager?.getTab(tabId);            // TabManager.ts:647
   const convId = tab?.conversationId; if (!convId) return;
   const conv = this.plugin.getConversationSync(convId);  // 取当前标题预填
   new InputModal(app, { value: conv?.title ?? '', onSubmit: async (raw) => {
     const title = raw.trim();
     if (!title || title === conv?.title) return;         // 空/纯空白/未变更 = 无操作
     try {
       await this.plugin.renameConversation(convId, title);                    // main.ts:733
       await this.plugin.updateConversation(convId, { titleGenerationStatus: undefined }); // 清哨兵，挡周期性 AI 重生成
       this.updateTabBar();                                // 补齐刷新缺口（本入口）
       this.updateHistoryDropdown();
     } catch { new Notice(t('chat.tabs.renameTitleFailed')); }
   }}).open();
   ```
   不抽 ConversationController.showRenameInput——它绑定历史列表 DOM（querySelector `.claudian-history-item-title`），不可复用于 tab badge，且其 Notice 是硬编码英文。

### 3. 数据与语义

- 写字段：`title`（trim 后）、`updatedAt`（renameConversation 自带 bump）、剔除 `titleGenerationStatus`。零 schema 变更，向后兼容（旧版本读新 meta 无新键）。
- 手改优先级：靠清 status 哨兵 + expectedTitle 比对，机制已存在（见盘点）。
- 重复标题：允许。title 非唯一键（sessionId/id 才是），现有改名也无唯一性校验。
- 超长：现有链路无长度限制，本功能不加（一致优先）；软上限列为决策点。
- 同步刷新：tab 栏（updateTabBar）+ 历史下拉（updateHistoryDropdown）；通知标题下次触发时自动取新值；窗口标题不消费会话标题，无动作。
- 外部读取方：零改动零影响（见盘点兼容分析）。唯一语义注记：bump updatedAt 会让被改名的旧 conv 在同 sessionId 多 conv 的 latest-wins 中可能抢占——既有行为，接受。

### 4. 并发推演（具象走查）

- **改名 vs 进行中的 AI 标题生成（pending）**：t0 首轮消息→fallback 标题+status=pending+AI 生成中；t1 用户经 tab 菜单改名→title=新手改、status=undefined、meta 落盘；t2 AI 回调读 `currentConv.title ≠ expectedTitle`→跳过所有写入分支（InputController.ts:1423-1434 / ConversationController.ts:1968-1978）。手改标题保留 ✓。之后每 10 条消息的静默重生成因 status=undefined 不触发 ✓。反例路径（已排除）：若新入口漏掉清 status，status 停留 'success' → 下个 10 条边界 regenerateTitle 以手改标题为 expectedTitle 重生成，AI 可能覆盖手改——**清 status 是本方案不可省的一步**。
- **改名 vs 流式进行中**：renameConversation 同步赋值内存 `conversation.title` 后才 await 落盘；turn 结束的 `save()` 走 `toSessionMetadata` 序列化同一内存对象，新标题必然包含。两个 await 交错时后落盘者内容完整（同对象序列化），无 lost-update。改名不触碰 messages/providerState/lease，与 TurnCoordinator 投影写租约无交集 ✓。
- **菜单禁用态**：新建空 tab（conversationId null）→ rename 与 copyTitle 双禁用，口径一致 ✓。

### 5. i18n（新增 2 key × 10 locale）

- `chat.tabs.renameTitle`：菜单项 + Modal 标题共用（zh-CN:「更改会话标题」；en: "Rename session title"）
- `chat.tabs.renameTitleFailed`：（zh-CN:「重命名会话失败」）
- 改 `src/i18n/types.ts`（TranslationKey 联合类型，:119-121 邻位）+ `src/i18n/locales/{en,zh-CN,ja,ko,de,fr,pt,ru,es,zh-TW}.json`（各 :152-154 邻位，zh-TW 以实际 locale 清单为准）。保存/取消复用 `common.save`/`common.cancel`。

### 6. 测试方案（红→绿）

走生产调用链、断言可观察结果：
- **TabBar.test.ts**（先红：新 key/新菜单项不存在）：
  1. 右键 → 菜单第 2 项 title = `t('chat.tabs.renameTitle')`；
  2. `conversationId === null` → 该项 disabled；有 convId → enabled；
  3. 点击 → `callbacks.onTabRename` 以该 tab id 被调（仿 :433-438 的 `Menu.instances.at(-1)` 模式）。
- **TabManager.test.ts**：`getTabBarItems()` 填充 `conversationId`（有会话/空 tab 两例）。
- **InputModal.test.ts**（tests/unit/shared/modals/ 镜像）：预填值、trim、纯空白不触发 onSubmit、Escape 取消不触发 onSubmit。
- **ClaudianView.test.ts**（或最小集成）：onTabRename → `plugin.renameConversation(convId, trimmed)` + `plugin.updateConversation(convId, {titleGenerationStatus: undefined})` 均被调，且 saveMetadata 落盘内容不含 `titleGenerationStatus` 键；reject → Notice(renameTitleFailed)。
- i18n key parity 既有套件自动覆盖新 key。

### 7. 交付物规范

- 目标目录树（新增仅 1 文件）：`tools/claudian/src/shared/modals/InputModal.ts`；其余均为既有文件修改：`src/features/chat/tabs/{TabBar.ts,types.ts,TabManager.ts}`、`src/features/chat/ClaudianView.ts`、`src/i18n/types.ts`、`src/i18n/locales/*.json`（10 个）、`tests/unit/features/chat/tabs/{TabBar,TabManager}.test.ts`、`tests/unit/shared/modals/InputModal.test.ts`（新）、`tests/unit/features/chat/ClaudianView.test.ts`。
- 命名：沿用 vault 既有 i18n key 命名（chat.tabs.*）与 tests 镜像路径约定，无新目录约定；README 产物索引不涉（代码仓非 vault 笔记）。
- 产物清单：InputModal.ts（通用单输入 Modal，潜在后续消费者=历史下拉改名替换硬编码英文 Notice）。
- 归属引用：遵循 tools/claudian/CLAUDE.md（TDD、`npm run typecheck && lint && test && build`、无 console.*）；偏离声明：无。
- 部署：`npm run build`，OBSIDIAN_VAULT（.env.local）已设则自动复制到 `.obsidian/plugins/claudian/`（esbuild.config.mjs:90-93），否则手动复制 main.js/manifest.json/styles.css 后在 Obsidian 重载插件。版本号：本地 hotfix 分支惯例未 bump（package.json 仍 2.0.11），是否 bump 让用户定。

## 风险与权衡

- **Modal 新组件 vs 复用**：shared/modals 无现成单输入 Modal（仅 Confirm/ForkTarget/InstructionConfirm），新建是必要成本；换来编辑态不受 tab 栏重建销毁。
- **死回调 onTabTitleChanged**：本方案在改名入口直接调 updateTabBar，不动死回调。若想根治"AI 标题落盘后 tab badge 滞后"，需在 ConversationController 两个标题回调里触发它——属另一条改动线，列为可选后续项。
- **meta 原子写（tmp+rename）**：本功能只是 saveMetadata 的又一个调用方，单独为改名单点原子化不解决截断类问题（save() 写入频率远高于改名）；正确位置是 SessionStorage.saveMetadata 统一改 `<id>.meta.json.tmp` + `adapter.rename`。**列为可选后续项**，不并入本功能。
- **历史下拉硬编码英文**（'Rename'、'Failed to rename conversation'，ConversationController.ts:1784/1792）：范围内不动，顺手项请用户裁决。
- **用户决策点**（未见用户表态）：
  1. 标题长度是否加软上限（现有无限制，方案默认不加）；
  2. 纯空白输入：默认视为取消保持原标题（与历史改名回退语义一致）；是否要显式 Notice 提示；
  3. 是否顺手 i18n 化历史下拉硬编码英文 + 触发死回调根治 AI 标题滞后 + meta 原子写（三项均为小后续项，可另派）。

## 验证方式

1. 红→绿：先加测试跑 `npm run test -- --selectProjects unit` 确认失败，实现后转绿。
2. `npm run typecheck && npm run lint && npm run test && npm run build`。
3. 人工核对：Obsidian 内右键 tab → 改名 → tab badge/历史下拉即时刷新；空 tab 菜单项灰置；改一个 status='success' 的会话后再发 10 条消息，标题不被 AI 覆盖；改名后 `cat .claudian/sessions/<id>.meta.json` 确认 title 更新且无 titleGenerationStatus 键；跑 `python3 tools/model_proxy/core/claudian_titles.py` 冒烟（或其 test_claudian_titles.py）确认标题读取正常。
4. 流式竞态实测：流式中改名，turn 结束后 meta 内 title 仍为手改值。

## 关联

- 上游参考：`docs/designs/2026-10-09-渲染管线减压批次方案.md`（同仓设计记录约定）
- 外部读取方：`tools/model_proxy/core/claudian_titles.py`、`.claude/skills/session-send/scripts/session_list.py`
