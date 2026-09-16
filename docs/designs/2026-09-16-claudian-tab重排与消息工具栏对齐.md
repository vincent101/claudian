---
type: design-decision
status: confirmed
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - claudian
  - ui
---

# 背景与问题

> 实施记录（2026-09-16）：已实施（c8848c51 + 99a1c667，2.3.0 部署，复核通过）。

Claudian 需要在不改变会话/runtime 语义的前提下，为内部 tab 增加可持久化重排和标准右键菜单，并把 assistant 消息尾部操作统一为 user 消息已有的 message-level 工具栏形态。

本记录基于 `hotfix/notify-lease` 分支 `1d038d2d`、manifest `2.2.0` 的只读核查，状态为待用户确认，非实施记录。

# 方案设计

## A. Tab 拖拽重排与右键菜单

### A.1 现状

- 渲染：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabBar.ts` 将 `TabBarItem[]` 全量重绘为 `.claudian-tab-badge`；当前只有左键切换和右键直接关闭。
- 未发现 tab 的 HTML5 DnD、pointer 拖拽、中键关闭或独立关闭按钮。现有注释中的“close button”与实现不符；本轮不把不存在的交互当兼容约束。
- 状态：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts` 使用 `Map<TabId, TabData>`；所有编号、关闭后的相邻 tab 选择、通知编号和 `getTabBarItems()` 都依赖 `Map` 插入顺序。
- 持久化：顺序已经隐式持久化。`getPersistedState()` 按 `Map.values()` 生成有序 `openTabs`，`restoreState()` 按数组顺序重建。数据经 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/storage/SharedStorageService.ts` 的 `plugin.loadData()/saveData()` 写入插件 `data.json`，不是 Obsidian workspace leaf 布局。
- 现有存储为插件级单份 `tabManagerState`；多 Claudian view 时仍是“最后写入者覆盖”。本轮重排复用该既有语义，不顺带改造成 per-leaf 布局。

### A.2 交互方案

推荐 **HTML5 DnD + Obsidian `Menu` API**。

1. `TabBar` 给 badge 设置 `draggable="true"`，仅接受同一 `TabBar` 内的 tab ID。
2. `dragstart` 记录源 tab；`dragover` 根据目标 badge 中线判断 before/after，阻止默认行为并显示唯一插入线；`drop` 只提交一次最终顺序；`dragend` 无条件清理拖动态。
3. drop 指示用 `.claudian-tab-drop-before/.claudian-tab-drop-after` 伪元素或 outline，写入 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/style/components/tabs.css`；不插入临时假 tab，避免编号抖动。
4. 记录本次 gesture 是否实际进入 drag；drag 后吞掉随后的 click，普通点击仍切换 tab。右键不启动拖动；菜单项 click 阻止冒泡。
5. 当前无中键关闭、无 close button，故本轮不新增。后续若补中键，应仅在 `auxclick(button === 1)` 调用同一关闭命令，不与 DnD 状态混用。
6. `contextmenu` 不再直接关闭，改用 Obsidian `Menu`：
   - 必选：`向左移动`、`向右移动`、`关闭`；边界方向项保留但 disabled，位置稳定、状态明确。
   - `关闭`复用 `ClaudianView.handleTabClose()`，保持当前“streaming tab 视为用户中断并强制关闭”的行为。
   - 可选、建议暂缓：`关闭其他标签页`、`关闭右侧标签页`。最大 tab 数仅 10，批量关闭会引入 streaming tab 的批量确认/中断语义，不值得混入首版。

Obsidian 当前 typings 提供 `Menu.addItem()`、`MenuItem.setTitle()/setIcon()/setDisabled()/onClick()` 和 `Menu.showAtMouseEvent()`，足以满足需求；自建菜单会重复处理主题、层级、键盘焦点和视口边界，不推荐。

### A.3 状态与依赖改动

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/types.ts`
  - `TabBarCallbacks` 所在文件不变；增加顺序变化回调契约。
  - `TabManagerCallbacks` 增加 `onTabOrderChanged`。
  - `PersistedTabManagerState` 无需加 `tabOrder`：`openTabs` 本身就是有序序列，另存一份会产生双真相源。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts`
  - 新增单一领域操作 `moveTab(tabId, targetIndex): boolean`，负责校验 ID/边界、按新顺序重建 `Map`，成功后触发 `onTabOrderChanged`；不切换 active tab，不销毁/重建 `TabData`，不触碰 runtime、DOM 内容和 hydration。
  - 左移/右移与拖放都转换成该操作，避免 UI 各自改状态。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabBar.ts`
  - 只负责 gesture、drop index 计算、菜单展示和调用 callbacks，不直接拥有 tab 顺序。
  - 保存最近一次 `items` 快照供菜单边界和 drop 计算；`update()` 后清理失效 drag 状态。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ClaudianView.ts`
  - 串接 reorder callback；顺序成功变化后走既有 `updateTabBar()` + `persistTabState()`。300ms debounce 和关闭时 immediate persist 原样复用。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/style/components/tabs.css`
  - 增加 dragging 降透明度、before/after 插入线和 `cursor: grab/grabbing`；使用 Obsidian CSS token。

持久化无需迁移：旧 `openTabs` 按旧顺序正常恢复，新顺序仍写回同一数组结构。需同步确认 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts` 的 `AppTabManagerState` 与 feature 类型没有新增字段。

### A.4 DnD 选型权衡

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| HTML5 DnD | Electron 桌面原生；实现小；有标准 drag 生命周期；适合离散 badge 重排 | drag image 可定制性一般；需显式抑制拖后 click | 推荐。插件 `isDesktopOnly: true`，不存在移动端触控覆盖要求 |
| Pointer Events 自建 | 阈值、动画、ghost、触控行为完全可控 | 需自己处理 pointer capture、取消、窗口越界、滚动、点击仲裁和清理 | 当前 3–10 个固定小 badge 不值得 |
| 仅菜单移位 | 最稳、无 gesture 冲突 | 不满足拖拽需求 | 只作为键鼠替代入口，不单独采用 |

### A.5 i18n

新增建议键：

- `chat.tabs.moveLeft`
- `chat.tabs.moveRight`
- `chat.tabs.close`

若启用可选批量项，再加 `chat.tabs.closeOthers`、`chat.tabs.closeRight`，首版不预埋未使用文案。

同步修改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/types.ts` 和 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/locales/` 下 10 个 locale JSON。所有 `MenuItem.setTitle()`、aria-label/tooltip 文案调用 `t()`。

`/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/i18n/uiLiteralGate.test.ts` 当前只扫描六个设置页文件，并不会实际扫描 `TabBar.ts` 或 `MessageRenderer.ts`；不能把它误当成本改动的覆盖证明。实施时除运行该门禁外，应在 tab/message 单测中断言菜单与按钮文案来自 translation key，并依靠 `Record<Locale, typeof en>` 的编译约束保证 10 locale 结构一致。若未来扩大 AST 门禁，应先清理目标文件已有硬编码，不能直接把 `MessageRenderer.ts` 加入现有目标列表导致存量噪声淹没本轮。

## B. Assistant hover 工具栏对齐 user 形态

### B.1 两处现状与逐项差异

两类消息都由 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/rendering/MessageRenderer.ts` 创建；差异不是两个独立 renderer，而是同一 renderer 内的两套操作入口。样式集中在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/style/components/messages.css`。

| 维度 | user 消息 | assistant 消息 |
|---|---|---|
| DOM | `msgEl > contentEl`，以及直接子元素 `msgEl > .claudian-message-actions`；复制、fork、rewind、timestamp 均在 toolbar | `msgEl > contentEl > .claudian-text-block > .claudian-text-copy-btn`；另有 `msgEl > .claudian-message-actions > timestamp`，复制和时间分属两棵 DOM |
| 顺序 | 当前最终顺序通常为 fork → rewind → copy → timestamp（fork/rewind 通过 prepend 插入） | 每个 text block 各有 copy；message toolbar 只有 timestamp，无统一相邻顺序 |
| CSS 类 | `.claudian-user-msg-copy-btn` 与 `.claudian-message-{fork,rewind}-btn` 共用 `.claudian-message-actions` | `.claudian-text-copy-btn` 为块内绝对定位，timestamp 才使用 `.claudian-message-actions` |
| 对齐 | toolbar `right: 0; bottom: -20px`，整行位于 user 气泡下方右侧 | copy 位于各 text block 的 `bottom: 0; inset-inline-end: 0`；timestamp 因 assistant 覆盖规则位于消息框内部 `bottom: 0` |
| 间距 | toolbar `gap: 12px` | copy 与 timestamp 不在同一 flex 容器，没有统一 gap |
| 显隐 | 整个 toolbar 在 message hover/focus-within 时显示 | copy 只在对应 text block hover 时显示；timestamp 在 message hover/focus-within 时显示 |
| 复制粒度 | 复制整条 user 文本 | 逐 text block 复制；多文本块时可能出现多个复制按钮 |

此前提交 `0b461e03` 修的是 assistant toolbar 沿用 `bottom: -20px` 后侵入下一条 user 气泡的问题：通过 assistant 专属 `bottom: 0` 把 timestamp 收回消息框。它与本轮“copy 和 timestamp 不在同一行/显隐区域不同”不是同一问题，但属于同一布局债务：前次修复保住位置安全，本轮不能简单删除 override 而让重叠复发。

### B.2 推荐方案：统一 message-level actions，复制整条可见回答

1. 将 assistant 复制从 `.claudian-text-copy-btn` 提升到 `msgEl > .claudian-message-actions`；assistant toolbar 固定为 `copy → timestamp`，与 user 的“按钮组 → timestamp”顺序一致。
2. **[修订 2026-09-16｜来源：独立审核；用户裁决：2026-09-16 确认“整条复制”]** “整条”严格定义为当前 message projection 的全部 text blocks：按 `MessageRenderer.ts:596-650` 的展示顺序拼接 `contentBlocks` 中文本；旧消息无 blocks 时 fallback 为 `msg.content`。不含 thinking、tool、subagent、duration。summary 投影只复制当前 summary，不承诺原文全文；A2 后若需全文复制必须另走 detail API，本轮明确出范围。
3. 抽取/重命名 message-level copy helper，使 user 与 assistant 共用按钮 DOM、图标、clipboard、反馈和 i18n；不再让 assistant 调用 `addTextCopyButton()`。代码块自带的 Obsidian copy 不受影响。
4. 建立幂等的 `syncMessageActions(msgEl, msg)`：
   - stored/prepend：内容构建完成后一次同步 toolbar；
   - live user：创建时同步；
   - live assistant：创建时先有 timestamp，`StreamController.finalizeCurrentTextBlock()` 将文本写入 `contentBlocks` 后更新同一个 copy action；多文本块只更新 payload，不新增按钮；
   - projection 重建继续走 stored 路径，避免第二套 DOM。
5. CSS 让 user/assistant 都使用同一 `.claudian-message-actions` 布局和 hover/focus-within 显隐。为防止复发 `0b461e03`：
   - 不直接恢复 assistant 无预留的 `bottom: -20px`；
   - 给 assistant 显式预留工具栏占位（与 `.claudian-messages` gap 合计至少覆盖工具栏高度），再使用与 user 相同的下挂定位；
   - **[修订 2026-09-16｜来源：独立审核]** `messages.css:328-335` 的 assistant `bottom: 0` 修复保留到占位验收通过；只有确认“assistant toolbar 底部不超过下一消息顶部”后才删除该特例，禁止先删后验。
6. 保留 `focus-within` 显示，确保键盘聚焦按钮时工具栏不消失；hover 范围统一为整条 message。

不推荐两种替代：

- **只调 CSS**：无法改变复制和时间分属不同 DOM、不同 hover 触发区的根因，多文本块仍有多个 copy。
- **保留逐块 copy，再新增 message copy**：功能重复、按钮含义不清，且 toolbar 更拥挤。

### B.3 i18n

趁共用 helper 收口现有复制反馈，新增：

- `chat.message.copyAriaLabel`
- `chat.message.copied`

10 个 locale 与 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/types.ts` 同步补齐。不得新增 `Copy message`、`copied!` 等硬编码 UI 字符串。

# 风险与权衡

1. **Map 顺序是行为数据**：关闭 fallback 和通知编号都会随重排后的视觉顺序变化；这是正确且应由测试锁定的结果。
2. **拖放 index 易出 off-by-one**：目标 index 必须按“先移除源，再插入”计算；同位 drop 应返回 false，不触发重绘/持久化。
3. **频繁 TabBar update**：streaming/attention 会触发全量重绘。拖动期间若状态刷新，DOM 会被替换；设计要求 `update()` 清理 drag 状态，drop 失败不改顺序。首版不冻结状态更新。
4. **关闭 streaming tab**：沿用当前 force-close 行为，不新增确认框；若用户希望右键关闭更保守，需要另行确认产品语义。
5. **assistant 复制语义变化**：从“逐文本块”改为“整条可见回答”。这是统一 message-level toolbar 的必要产品选择；若必须保留逐块复制，则只能做到视觉近似，无法真正与 user 形态统一。
6. **消息间距回归**：assistant 下挂工具栏必须预留空间；重点覆盖短回答、长回答、collapsed subagent、连续 assistant/user、最后一条消息与 RTL。
7. **工作树前提有偏差**：核查时仓库存在未跟踪目录 `/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/`，因此并非严格 clean；本方案未读取或改动该目录。

# 验证方式

## 自动测试

1. `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/TabManager.test.ts`
   - 首/中/尾位置移动；同位、未知 ID、越界；active ID 和 `TabData` 引用不变。
   - 重排后 `getTabBarItems()` 编号、关闭 fallback、通知 index 使用新顺序。
   - `getPersistedState().openTabs` 按新顺序；restore 后顺序一致。
2. `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/TabBar.test.ts`
   - drag before/after index、drop 指示清理、drag 后不触发切换。
   - context menu 替代右键直关；左右边界 disabled；close 调用统一 callback。
3. `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/rendering/MessageRenderer.test.ts`
   - user/assistant toolbar 都是 `msgEl` 直接子元素。
   - assistant 的 copy 与 timestamp 位于同一 toolbar，DOM 顺序确定；多 text block 仅一个 copy。
   - stored、prepend、live streaming、projection rebuild 路径一致；tool-only assistant 无空 copy。
   - 复制 payload 严格等于当前 projection 的全部 text blocks（无 blocks 时 fallback `msg.content`），排除 thinking/tool/subagent/duration；summary 仅复制 summary，且不调用 detail API。
4. i18n：10 locale key parity、`TranslationKey` 编译、`uiLiteralGate`；另加目标文件的翻译调用断言，弥补现有 AST 门禁扫描范围不足。

执行：

```bash
cd /Users/vincentwang/Documents/NoteVault/tools/claudian
npm run test -- --selectProjects unit --runInBand tests/unit/features/chat/tabs/TabBar.test.ts tests/unit/features/chat/tabs/TabManager.test.ts tests/unit/features/chat/rendering/MessageRenderer.test.ts tests/unit/i18n
npm run typecheck
npm run lint
npm run build
```

## 人工核对

- header/input 两种 tab bar 位置下，拖首/中/尾 tab；插入线与落点一致，刷新 Obsidian 后顺序保留。
- 普通 click、右键菜单、边界移位、关闭空白/绑定/streaming tab；拖动结束不得误切 tab。
- assistant 短文本、多文本块、代码块、tool-only、collapsed subagent、流式完成、历史加载；hover/focus 时复制与时间同排，且不覆盖下一条 user 消息。
- user 原有 copy/rewind/fork/time 顺序和行为不退化；亮/暗主题、窄侧栏、RTL locale 均检查一次。

# 关联

- [[CLAUDE]]
- [[docs/designs/2026-09-15-claudian超大会话修复全景回归审查]]
