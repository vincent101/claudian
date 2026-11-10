---
type: design-decision
status: confirmed
date: 2026-11-09
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - claudian
  - permissions
  - upstream-port
---

# 上游 #1482 Claude 权限四档移植设计

## 背景与问题

在本 fork 2.0.11 架构上移植上游 Claude 四档权限与新装 Auto 默认，消除默认 YOLO、Safe 二级设置和原生模式回写失真，同时保留本地 Plan、审批与多 provider 边界。

> [!warning] 范围与状态
> 路径为 `[务实]`；用户已裁决“跟随上游”：新装默认 Auto、废除 Claude safeMode、四档选择器、legacy Safe 映射。**用户已确认设计（2026-11-09），status: confirmed，实施获批**；运行时验收仍待落地后进行。只新增本设计记录，不改生产、测试、README、配置、依赖或既有设计记录，不 commit/push/build/deploy；落地排在 W4d 之后。

## 方案设计

### 1. 实证基线与上游拆解

#### 1.1 本 fork 的实际状态

核查时间为 2026-11-09，本地 HEAD 为 `cf47730d2`，实际分支 `fix/model-identity-sorting`，并非当前工作树已经在 main。主干约定仍为 main。`package.json.version=2.0.11`，但本 fork 已有 Claude/Codex/OpenCode 的 provider 边界及大量本地演进，不能按纯上游 2.0.11 文件结构推断。upstream/main 本地引用为 `fbf3431d21289efb4f2285eb3c9d15d24d65c5f7`。

共享树正在被其他工作线修改；以下是本轮逐点读数，不是整个工作区原子快照。实施 G0 须在 W4d 完成后重新冻结基线。

| 文件绝对路径 | 已有读数与设计影响 |
|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/settings/defaultSettings.ts` | `permissionMode:'yolo'`；新装改 Auto，但不能重置已存 YOLO。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/types/settings.ts` | 共用 PermissionMode 为 `yolo/plan/normal`；ClaudianSettings 权限字段仍绑此类型。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/settings.ts` | getter 支持嵌套 `providerConfigs.claude.safeMode` 和旧顶层 `claudeSafeMode`，缺省 acceptEdits；updater 重建 provider 配置。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/settings/ClaudianSettingsStorage.ts` | 优先读 `.claudian/claudian-settings.json`，否则读旧 `.claude/claudian-settings.json`；清理顶层旧字段后合并 defaults，再调用两 provider 的配置 updater，迁移条件命中则写新文件并删旧文件。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/ProviderSettingsCoordinator.ts` | 权限来自二态 toggle；saved map 优先。权限分支之前 `applyModelDefaults` 可能调用 Claude 配置 updater，故等到权限分支才读 legacy safeMode 也可能太晚。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeQueryOptionsBuilder.ts` | YOLO→bypassPermissions、Plan→plan、normal→safeMode；auto opt-in 只在 safeMode=auto 时启用。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeDynamicUpdates.ts` | 支持 setPermissionMode；无启动 auto 能力时需重启；权限 setter 失败目前仅通知、继续执行，可能在 UI 已选 Manual 后仍用旧 YOLO 发下一条消息。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts` | init 回调传 SDK 原值；流中 EnterPlanMode 单独同步；动态更新与 ExitPlanMode 依赖目前取插件顶层权限，需改为 Claude snapshot。system/status 尚未投影权限。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts` | SDK callback 把 auto、acceptEdits、default 都压成 normal；Shift+Tab/Exit/发送前恢复有 normal 兜底；普通审批已有生产接线。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ui/InputToolbar.ts` | PermissionToggle 是两态开关；不存在上游 ToolbarMenu/ToolbarMenus。Model/ModeSelector 的 dropdown、check icon 模式可复用。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/claudeColdStartQuery.ts` | 这是独立辅助查询，不是主聊天 cold 分支；固定 bypassPermissions。Inline 提供只读工具+PreToolUse 拒写；title/refine 提供 tools=[]。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/probeRuntimeCommands.ts` | 独立 legacy probe，固定 bypassPermissions/persistSession:false；safeMode 仅影响 auto 启动旗标。W4 禁止生产下游 owned probe，本任务不得重新注入。 |

本轮运行了六组既有 mock SDK 单测：ProviderSettingsCoordinator、ClaudianSettingsStorage、QueryOptionsBuilder、claudeColdStartQuery、probeRuntimeCommands、InputToolbar，**6 suites / 226 tests 通过〔实测〕**。这只证明读取时的既有基线，不证明新方案通过。

#### 1.2 #1482 不等于“改一个默认值”

主提交 `7b44007cc261879320e44830b6e5732123741513`，2026-09-30；本地 git show 显示 101 文件、3489 additions / 1925 deletions，包含 composer 重排、多个 provider 权限与资源图。它只有一个父提交 `09a354b53cbd4b037768af7664cb586f368f8a5d`，是 squash，不可把提交正文里的条目当作本地可 cherry-pick 的独立对象。

本轮用 `gh api .../pulls/1482/commits` 取得原始提交链；#1480 的原始权限子提交完整 diff 另从 GitHub commit API 核查。相关子提交在本地 cat-file 不存在，未为此 fetch/改 refs。完整主 diff 临时输入在 `/tmp/claudian-permission-source.XDLCNt/1482.diff`；原始权限 diff 同目录，不作为持久交付物。

| #1482 原始提交 | 意图 | 本案处理 |
|---|---|---|
| `4457f5f5553dc64553f2255aa1947b7d4d5ca999` | composer toolbar/info row 重构 | 排除整体布局；只借鉴权限菜单必需交互。 |
| `678ad36818f0a6589c0a1d64df2ca91d4045aa10` | 合并主线，解决 Zen 冲突 | 非独立产品功能，不移植 merge。 |
| `faf017b767375dccfbda60c974da14ade86e5ba1` | context gauge 靠 model、permission 到末端 | 保留 fork 布局；权限控件本就靠末端。 |
| `f89bfb9cdba7bf3c372d382927afc1f94469a93e` | 菜单展开 chevron 翻转 | 仅权限菜单可采用，不改其他 selector。 |
| `eb1c73f8e05b2c2d7519b74314fccea022ffb571` | gauge 间距 6px | 排除。 |
| `613e34bd6d9bf6cbabee630baeb31c21bd398340` / #1479 | Pi 删除 read-only 与权限 toggle | 本 fork 无 Pi，不适用。 |
| `130e86424646bd4f6d177bbadf156fe1745a9892` / #1480 | Claude 四档、legacy、默认与图标 | 本案主体，按 fork 手工移植。 |
| `ff735b3fb779aca60bb6a4934de09022281c749a` / #1481 | Codex auto-review、reviewer 原生能力核验 | 排除；Codex 原有 Safe/YOLO 与 sandbox 保留。 |
| `95531137d38b7da852efcf376d9e398e6b1ddbe8` | Claude Safety heading→Configuration，十语言 key | 采用。 |
| `2a4037a802201ea20a2320a2b14ba9c0b3be49aa` | 选中项只用绿色 tick | 只用于权限菜单 check，不改其他菜单。 |
| `be3139feb96bdcd71709cb665104a7fd4484ffea` | composer hint/caret 排版 | 排除。 |
| `5e9cc441d98e9d1dbf39a0b0dc8c4ee2835156f5` | idle composer 最小两行 | 排除。 |
| `55bf459549be2b471371ce6c3aec0a003b5fe21d` | chip hover 与 popover 阴影风格 | 不搬整体 skin；权限 CSS 服从 fork。 |
| `109f4085edc5ca9b7808279698ecf4c0b8713ada` | README 预览和截图 | 排除上游图片与展示重构，README 只补本案索引/语义。 |

#1480 进一步拆解：

- `2ef73ade7fc8fe1ede889e48c8f64af53422b3ab`：四档、provider policy/options、legacy normal 映射、safeMode 删除、SDK 正反映射、模式切换与菜单 tests；完整 1361 行 diff 已核查。
- `711b8ffb8a04c18b066b7951d18573d71198e430`：默认 yolo→auto；新装及 unsaved provider 测试。不是“把存量 yolo 都改 auto”。
- `893b5b648f2654b4020957b07e44d76805ab25f8`：仅 bypassesApprovals 的模式绘制 shield-alert；离开 YOLO 清除旧 SVG。
- `2e3aba23f794b9d7c03bca41d49d03a7cedcbdd4`、`24541903cb4ec83d501bde6dfcc84a81c9b4a692` 是合并/冲突处理，不单独移植。最终以 #1482 squash 的权限语义为准。

相关后续：

| 提交 | 完整差异意图 | 本案边界 |
|---|---|---|
| `552ecf8f4c43b5c6d5eff5cb5201f8ba6053d32f` / #1493 | Always allow 仅在 SDK suggestions 非空时出现；原样返回 suggestions；删除插件自行造规则/改 destination 的 helper 与对应 tests。 | **不合并进本案**。已有 S2 设计还涉及旧 SDK suppression/取消/持久授权裁决。只改 default 不构成重新批准这些政策。本案不改该 helper、不清权限规则。 |
| `2ebd1e1e34ec75f5f556c46779cdaabda14b2db6` / #1894 | main/side 的 requested native permission event 通过同一个 settings owner 更新并发布 UI，下一次请求不能覆回旧模式。 | 采用“原生回写进入相同 owner”的语义。fork 无 SessionModel/SideChatRuntime，不新增 side-chat；落在 Claude runtime 正反映射与 Tab 既有 snapshot writer。 |

### 2. 解层次与方案选择

问题锚定在默认配置，但只改配置不能成立：类型、二态 UI、原生回写和配置读写都不支持 Auto 成为一等选择。反过来，也不需要移植上游整个 composer/execution 架构。

现成能力的正向利用：

1. 既有 ProviderSettingsCoordinator snapshot/commit 直接作为多 provider 权限 owner，不新增设置存储体系。
2. 既有 SDK setPermissionMode 直接支持切换四档；统一启动 auto opt-in 后，不为每个档位重启 Query。
3. 既有只读 hook 与 tools=[] **直接规避辅助查询审批问题**；不把辅助查询误接到无人负责回答的 main approval UI。
4. 既有 Tab 审批/Ask/ExitPlanMode 接线继续使用；本案不重做 S2 request/timeout/always 策略。
5. 既有 Obsidian setIcon、CHECK_ICON_SVG 与 dropdown 样式模式供权限菜单复用；不引入新依赖或全局 toolbar 框架。

| 方案 | 利弊 | 结论 |
|---|---|---|
| A：只改 default 与保留 Safe 二级配置 | diff 最小，但 UI 无法选择四档、Auto 回写会变 normal、仍有双真相 | 不符合已裁决范围。 |
| B：**完整 Claude 四档 + 共享 policy/options + fork 局部适配** | 改共享契约和若干链路；无大重构，不改其他 provider 执行政策 | **推荐**。 |
| C：搬完整 #1482 composer/provider execution 架构 | 关联新组件、Zen/side-chat/Codex/Pi 改造，超范围、冲突面大 | 排除。 |

### 3. 模式类型与共享契约

#### 3.1 四档全移植，不把所有 provider 强换四档

Claude 可选值严格为 `auto/manual/acceptEdits/yolo`，四档都受本地 SDK 类型支持，无某一档成本高到需裁决删档的证据。

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/types/settings.ts`：ClaudianSettings.permissionMode 改为 **string**，与已有 model/reasoning/provider-owned 字段一致。
- 原共用 `PermissionMode='yolo'|'plan'|'normal'` 可保留给 Codex/OpenCode 已有窄类型，明确其不是 Claude 四档类型；不得扩成全 provider 超大 union 来继续混用。
- 新 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/permissionModes.ts`：定义 ClaudePermissionMode 四档、常量/options/policy/legacy 映射/SDK 正反映射；另定义 ClaudeRuntimePermissionMode = ClaudePermissionMode | 'plan'，只服务 fork 临时 Plan。
- Claude runtime/types、DynamicUpdates、ApprovalHandler 的权限依赖改为 provider runtime 类型或 string+统一边界正规化，不再引用共用 PermissionMode 来解释 Claude 值。

| Claude 四档 | SDK 请求值 | 语义边界 |
|---|---|---|
| auto | auto | SDK classifier 处理其适用请求；不承诺“每次都弹窗”或“所有操作都放行”。 |
| manual | default | 需审批且未被 allow/mode/rules 放行的请求进入 canUseTool。Read 等无需权限的调用不必弹窗。 |
| acceptEdits | acceptEdits | 原生自动批准文件编辑；其他需审批的调用仍由 SDK 求值。 |
| yolo | bypassPermissions | 普通调用绕审批；明确 ask/用户交互等例外取决于实际 SDK/CLI。仍注册 canUseTool，不移除 hook。 |
| 临时 plan，不在四档菜单 | plan | 保留 fork Enter/Exit/Shift+Tab 语义，退出恢复此前四档；丢失恢复值时 Claude 回 Manual。 |

#### 3.2 把 policy 与显示选项分开

在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts` 新增：

- ProviderPermissionModePolicy：readonly values、fallbackValue、defaultValue?、migrateValue?(value, settings)。
- fork 必需的小扩展：readonly transientValues?，用于运行内存接受 plan，但不作为持久配置或菜单选择。
- ProviderPermissionModeOption：复用 ProviderUIOption 的 value/label/description，加 bypassesApprovals?。
- ProviderChatUIConfig 增加 `permissionModes?` 和 `getPermissionModeOptions?(settings)`，替换旧 getPermissionModeToggle；不新增上游 ProviderModelPolicy 类层。

新 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/permissionModes.ts` 容纳 SDK 无关的正规化/验证、二态 policy 常量与恢复 fallback。所有 caller 使用同一个验证口径；核心不 import Claude SDK 或 provider 实现。

Claude policy：values 四档、defaultValue auto、fallbackValue manual、transientValues plan。
Codex/OpenCode：values normal/yolo、defaultValue normal、fallbackValue normal、transientValues plan；options 仍是两项，沿用各自现有 i18n label，OpenCode apply/resolveManagedMode 不改。

**两态不是第二套 UI 分支**：同一个数组驱动菜单接受两项或四项；plan 作为临时展示状态，不是第五个选项。旧 toggle 契约全量替换，不保留永久双接口。

### 4. legacy 迁移与存储顺序

#### 4.1 先映射，后清理，再投影

移植点是 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/settings/ClaudianSettingsStorage.ts` 的 **raw stored 读取后、stripLegacyFields 与 updateClaudeProviderSettings 之前**，不是只有 main.loadSettings 最后加一次正规化。

1. 解析 JSON，复用既有 providerConfigs 正规化；对 providerConfigs 与 savedProviderPermissionMode 作必要独立复制，不能修改 DEFAULT_CLAUDIAN_SETTINGS 嵌套对象或 caller settings。
2. 保存 raw Claude legacy 源：嵌套 safeMode 若有值则优先，否则读顶层 claudeSafeMode。若明确非法，不向更旧来源回退抬权；两个来源均缺失时，legacy normal 对应历史 acceptEdits。
3. 使用 provider-owned migration 函数正规化 `savedProviderPermissionMode.claude`；只有顶层权限确属 Claude（settingsProvider=claude，或经既有 provider 解析确认缺省 Claude）才消费顶层值，绝不把 Codex/OpenCode 当前 yolo 当成 Claude 的旧选择。
4. active provider 的 saved 值优先，继而 derived、当前 owned 值、该 provider 的 default、fallback。明确非法保存值先降 fallback，不能因无效而跳过并重新挑 Auto/YOLO。
5. 写回已正规化顶层/Claude saved 选择后，才清理旧顶层字段与 Claude provider safeMode、合并 defaults、运行既有 model/config 迁移。
6. 将本次 permission 迁移 changed 纳入已有一次写回条件；复用 save 成功后删 legacy 文件的顺序。写失败不删源文件。
7. save 对独立序列化副本消除旧字段、正规化 durable 值；不得给还未映射的旧输入只删 safeMode。读旧格式、update()、直接 save() 都须同一迁移语义。

缺省与非法必须分开：新装或无 Claude 历史选择→Auto；已存非法权限/非法 Safe 参数→Manual；已存 YOLO→YOLO。**不新增“默认开启 Auto 就重置所有用户”的批迁移。**

#### 4.2 迁移用例表

下表为设计预期〔纯示意〕；“旧生效值”来自当前源码推导〔既有读数/推算〕，不是实测 CLI。

| raw 数据（目标 provider=Claude） | 旧路径的 SDK 值 | 新 durable/SDK 值 | 判据 |
|---|---|---|---|
| 无设置文件，无历史选择 | bypassPermissions | auto / auto | 绿：新装 Auto；红：YOLO 或 acceptEdits。 |
| permissionMode=yolo；safeMode 任意 | bypassPermissions | yolo / bypassPermissions | 绿：保存选择不被改默认。 |
| permissionMode=normal；safeMode=auto | auto | auto / auto | 绿：SDK 实际语义保持。 |
| normal；safeMode=default | default | manual / default | 同上。 |
| normal；safeMode=acceptEdits | acceptEdits | acceptEdits / acceptEdits | 同上。 |
| normal；两个 Safe 字段均缺失 | acceptEdits | acceptEdits / acceptEdits | 缺失不误作 Auto。 |
| normal；只有顶层 claudeSafeMode=auto | auto | auto / auto | 顶层值不得先被 strip 丢失。 |
| normal；嵌套 default、顶层 auto | default | manual / default | 嵌套优先。 |
| normal；嵌套未知、顶层 auto | auto（fork 当前 getter 可回退） | manual / default | 跟随上游 fail-closed；畸形配置有意收紧。 |
| permissionMode=future/null/false/空串 | 旧代码非 yolo/plan 值可能落 Safe | manual / default | 明确非法不重挑默认 Auto。 |
| 四档之一已存，仍残留 safeMode | 按 fork旧类型未正式支持 | 原四档保持、safeMode 删除 | 新式选择优先。 |
| saved.claude=normal，top=yolo，safeMode=default | coordinator saved 优先→default | top/manual，saved/manual | 不让 ignored top yolo 覆盖 saved。 |
| saved.claude=future，top=yolo | 旧 saved 无效会跳过 | manual / default | 无效已存值不能抬到 YOLO。 |
| disk top/saved Claude=plan | main normalize normal→Safe | manual / default | Plan 不跨 reload；跟随上游非法持久 Plan 收紧。 |
| active=codex，top=yolo，无 saved.claude | 旧投影可能继承 top yolo | Claude snapshot auto；Codex yolo 原样 | provider 隔离；无 Claude 历史才用默认。 |
| active=codex，top=normal，saved.claude=normal，legacy auto | Claude snapshot auto | saved.claude auto；Codex normal 原样 | 非 active Claude 也迁移。 |

所有新式 durable 值 load→save→load 幂等；legacy 首次转换后再加载不重复写。只改变 permission/Claude retired 字段，其他 provider safeMode、模型预设、环境、命令隐藏、session metadata 不受本案清理。

#### 4.3 保留临时 Plan 而不污染落盘

若照抄 upstream values 仅四档，fork 的 plan snapshot 会被即时正规化为 Manual，破坏现有 Plan。采用明确 durable/transient 区分：

- coordinator **内存投影/commit** 可接受 policy.transientValues，允许当前 plan 与 saved 内存 map 的 plan 保持一致。
- storage **磁盘 load/序列化** 不接受 transient，Claude plan→manual，Codex/OpenCode plan→normal。save 仅转换副本，不能把正在运行的 Plan 从 plugin.settings 擦掉。
- main.loadSettings 原“所有 plan→normal”循环改为 provider fallback 口径或交由已正规化 storage 处理，不能再次把 Claude Manual 回写 normal；OpenCode selectedMode 的既有 Plan 清理保留。
- Shift+Tab、发送前 restore、ExitPlanMode 的丢失恢复值使用 policy.fallbackValue，而非硬编码 normal，更不能兜底 auto/yolo。
- plan 内选四档相当于显式退出 Plan；清理 prePlanPermissionMode，避免下一次恢复拿到更早选择。

这不是 Plan 功能重构；四档是 durable 审批选择，Plan 是其临时覆盖层。无需新增 per-tab settings store。

### 5. 运行时、原生回写与 UI 接线

#### 5.1 正向请求与动态更新

- QueryOptionsBuilder 的 persistent config/options、主聊天 cold options 共用 provider 正向映射：四档直接映射；plan 单独允许；其余 Manual。
- 所有相关 Claude 启动 options 都含 `'enable-auto-mode':null`；enableChrome 旗标继续合并，loadUserSettings/settings sources 不变。
- persistent config 的 enableAutoMode 新启动恒 true；保留既有 defensive restart/active-turn defer 机制，不为删不可达 guard 改造生命周期。
- allowDangerouslySkipPermissions 仍 true，表示允许未来显式切到 YOLO，**不等于当前 mode 已 bypass**；每档始终保留 canUseTool 注册。
- ClaudeChatRuntime 的动态和 ApprovalHandler/Exit 取值改用 getScopedSettings()/同一 Claude 正规化入口，不取其他 provider 的顶层 projection。
- 四档（及 Plan 进退）在已有 query 上 setPermissionMode，无新增 query、无命令发现资格刷新、无资源 scope 更换。
- toolbar 延续 fork 现有时机：选值即时保存，**在下一条 provider 消息发出前**经动态更新应用；不声称这次移植新增了对当前进行中调用的追溯审批。
- 权限 setter 失败须可观察错误并中止本次发送，不能只 Notice 后继续以旧 YOLO 执行。只在 SDK 确认成功后更新 currentConfig；禁止静默降到 YOLO、禁止中断其他活动 turn 来强行重建。下一次发送可按现有 owner 尝试重新同步。

#### 5.2 原生回写必须走同一 settings owner

`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/ChatRuntime.ts` 的现有 setPermissionModeSyncCallback 保持函数形状不变，明确 payload 为 **provider 已正规化的 app mode**，不是 Claude SDK 原值。

- Claude runtime 先做反向映射：default→manual、auto→auto、acceptEdits→acceptEdits、bypassPermissions→yolo；fork plan 通过独立 transient 入口同步。
- dontAsk/delegate/future/空值等不在 UI policy 内的 native 值不冒认 Manual/Auto；忽略其 UI 回写，不伪造对应权限。unknown stored input 与 unknown native observation 是两个不同边界。
- init 和 system/status（确有 permissionMode 字段时）复用同一个 scope-guarded native 同步 helper，同时更新 currentConfig 及 Tab callback。不把 status 冒作 session_init，不制造新 session id、turn、result 或 command discovery 事件。
- 主 turn 和 leaseless system message 两入口都覆盖。保留原 query epoch、当前 service/tab/manager 身份检查；已 retired scope 的迟到消息不能回写。
- Tab 删除 bypassPermissions/plan/normal 三分支，验证 provider policy 值后，经现有 updateTabProviderSettings/commit/save/UI 刷新 owner 提交。Plan 保存/恢复也汇入该 owner，不另开只改 label 的分支。
- Codex 无需借本案新增 native 审批行为；OpenCode 现有 callback 已输出 normal/yolo/plan，继续按 policy/applyPermissionMode 消费。

这实现 #1894 的意图：native 改到 Accept edits 后，菜单、saved.claude、下一条 request 都是 Accept edits；不是仅本轮 label 变了。

最新官方文档说明新 CLI 在 Auto 不支持的模型上可能 emit status/default，而旧本地 SDK 类型与实际 CLI 能力未做 live 验证。本案只适配字段已出现时的正规化与接线，不硬编码模型支持清单、不升级 SDK、不改变默认 Haiku。Auto 启动/setter 不支持时显式失败，用户可在尚未启动 runtime 的四档菜单改 Manual。

#### 5.3 权限菜单局部替换

只在现有 InputToolbar.ts 的 PermissionToggle 内实现数组驱动 dropdown，保留组件名和 TabUIComponents.permissionToggle，降低共享大文件 diff。

- 展示 Auto / Manual / Accept edits / YOLO，附各自 description；数据来自 provider options，不在 UI 重新定义 modes。
- 真 button、aria-label、aria-haspopup/expanded、menu/menuitemradio、aria-checked；支持 click、Enter/Space、上下键、Escape、焦点回 button、外点关闭。
- 仅当前 option.bypassesApprovals=true 时 shield-alert + 专属 warning class；离开 YOLO 清 SVG/class。不使用“mode 字符串=yolo”来定义所有 provider 警示。
- 选中 check 复用已有 CHECK_ICON_SVG；description 使用文本节点，不用任意 innerHTML。
- 同值选择不提交；provider switch/updateDisplay 时以当前 options 重建菜单并关闭旧菜单；异步提交捕获 provider 身份，禁止在 await 后把结果提交到新 provider。复用 Tab 当前身份守卫，不引入全局权限 owner。
- plan 时显示只读 PLAN 状态，四档列表仍只有四项且无选中项；显式选一档退出 plan。不能 fallback options[0] 将 PLAN/未知状态伪装成 Auto；未知显示不可用并等待正常投影恢复。
- `closeMenu():boolean`、`handleKeydown`、`isMenuOpen`、`destroy` 只覆盖此权限菜单，不搬上游整个 ToolbarMenus。
- Escape 三条现有路必须仲裁：ClaudianView Obsidian Scope、Tab input keydown、NavigationController 的 shouldSkipEscapeHandling。权限菜单已消费的 Escape 不触发 cancelStreaming；无菜单时旧取消行为不变。
- cleanupTab 加 destroy；setVisible(false)、provider 切换与 destroy 都清菜单及 document listeners，destroy 幂等。不要把清菜单放进 runtime retirement 或改 W4 command cell。
- CSS 只改已有 permission-toggle.css，复用 Obsidian theme tokens/本地 brand token；不导入上游依赖 toolbar-chip 新框架的整段 CSS。

ClaudeSettingsTab 删除 Safe dropdown，heading 为 Configuration；十语言删除 retired key、增加 heading 和四档/错误提示必要 key，src/i18n/types.ts 同步。更新 loadUserSettings description 的“Safe mode”措辞为“已有用户权限规则可能跳过审批”，不改变整个 user source 的加载语义。其他 provider Safe label/settings 不改。

#### 5.4 辅助查询与 probe 边界

- 独立 runColdStartQuery：只移除 safeMode 的旗标依赖，保持 bypass + tools/hook/persistence 原配置。不能因为 DEFAULT 已 Auto 就把 inline/title/refine 接到无人答复的 main canUseTool。
- Inline 的“应用修改”由用户在 Modal accept 执行；SDK 只产出建议，保持现成 READ_ONLY_TOOLS + PreToolUse 拒写。新增测试必须调用生产 hook，证明四档无关的 read-only 不变量。
- title/refine 保持 tools=[]；不得因删 safeMode 隐式恢复默认全部工具。
- legacy probe options 统一 auto opt-in 旗标并保留 chrome；不改目录资格、notifier、缓存、启用入口、owned probe 策略。W4d 后若该函数仍作为非生产 legacy 能力保留，定向 tests 只 mock SDK。
- 不新增 live CLI 探测来验证 Auto 可用；本案验收只能证明 host-to-SDK 合同。

### 6. 上游文件→fork 移植映射

上游路径是 `YishenTu/claudian@7b44007cc` 内的路径；fork 落点均为绝对路径。

| 上游文件/改动 | fork 对应生产文件 | 所需移植/不适用边界 |
|---|---|---|
| src/app/settings/defaultSettings.ts | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/settings/defaultSettings.ts` | 新装 Auto；不改已存 YOLO。 |
| src/core/types/settings.ts | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/types/settings.ts` | settings.permissionMode:string；旧 provider 窄类型保留。 |
| src/core/providers/types.ts | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts` | policy/options + transientValues；挂现有 UI config，不引 ProviderModelPolicy 大拆分。 |
| src/core/providers/permissionModes.ts | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/permissionModes.ts`（新增） | 统一 SDK 无关正规化/验证/fallback，二态复用。 |
| src/core/providers/ProviderSettingsCoordinator.ts | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/ProviderSettingsCoordinator.ts` | policy 驱动投影/保存；在 model defaults 前捕获/正规化 permission 候选；禁止跨 provider 继承。 |
| src/providers/claude/permissionModes.ts | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/permissionModes.ts`（新增） | 四档/SDK/legacy/Plan provider 入口。 |
| src/providers/claude/ClaudeModelPolicy.ts | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/ui/ClaudeChatUIConfig.ts` | fork 无独立 ModelPolicy；直接挂 Claude policy/options。 |
| src/providers/claude/settings.ts | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/settings.ts` | 移除 Safe 类型/默认/get/updater；迁移读取留 permissionModes 而非继续提供有效 Safe setting。 |
| 上游 migrateValue/投影语义；无可直接套用 fork 读写顺序 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/settings/ClaudianSettingsStorage.ts` | raw 映射在 strip/config rewrite 前；save 同语义、changed 持久化、Plan 副本清理。 |
| fork 原持久 Plan 清理，无直接上游同构文件片段 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts` | 移除 Claude plan→normal 的二次污染；不改 metadata/bootstrap/W4 发布。 |
| src/providers/claude/execution/ClaudeExecutionRequestEncoder.ts | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeQueryOptionsBuilder.ts` | cold/persistent 映射+统一启动 auto，保留工具/prompt/hooks。 |
| 同上 native live-setter 意图 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeDynamicUpdates.ts` | scoped mode、四档 setter、权限失败不发下一消息；保留延期重启 owner。 |
| src/providers/claude/execution/ClaudeExecutionSession.ts | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts` | provider 模式回调、init/status/Plan、scope guard、scoped 取值。 |
| execution types 中四档类型 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/types.ts` | PersistentQueryConfig.permissionMode 改 Claude runtime 窄类型。 |
| execution interaction 的模式依赖 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeApprovalHandler.ts` | 仅权限依赖类型/取值接线适配；不改 once/always/signal/timeout 的审批规则。 |
| src/core/execution/ProviderExecutionEvent.ts | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/ChatRuntime.ts` | fork 已有 callback seam；payload 改为 provider app mode，不建 core/execution。 |
| src/features/chat/tabs/TabProviderState.ts、TabRuntimeUI/types | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts` | options gating、相同设置 writer、Plan fallback、callback、菜单 Escape/cleanup；无需新 TabRuntimeShell。 |
| src/features/chat/ui/InputToolbar.ts 的权限片段 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ui/InputToolbar.ts` | 局部 dropdown；保留模型身份排序、ExternalContextSelector/W4 完整实现。 |
| src/features/chat/ClaudianView.ts 菜单 Escape | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ClaudianView.ts` | Scope 仲裁+ShiftTab fallback；不搬 Zen/layout。 |
| src/style/toolbar/permission-toggle.css | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/style/toolbar/permission-toggle.css` | 本地 menu/icon/check 样式，无全局 toolbar skin。 |
| src/providers/claude/ui/ClaudeSettingsTab.ts | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/ui/ClaudeSettingsTab.ts` | 删 dropdown，改 heading。 |
| src/i18n/locales/{十语言}.json | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/locales/` 下 de/en/es/fr/ja/ko/pt/ru/zh-CN/zh-TW.json；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/types.ts` | 只权限/Configuration/必要 error keys；保留其他工作线新增 keys。 |
| src/providers/{codex,opencode}/UI 的二態 options 适配 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/ui/CodexChatUIConfig.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/ui/OpencodeChatUIConfig.ts` | 仅共同契约替换；保留 fork plan、label、OpenCode managed mode；不搬 Codex auto-review。 |
| src/providers/claude/runtime/probeClaudeRuntime.ts | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/probeRuntimeCommands.ts` | 仅 legacy options 的 auto/chrome，不能等同上游新 runtime probe 或重启生产 probe。 |
| fork 独立辅助 runner，无上游同构摘取 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/claudeColdStartQuery.ts` | 删 Safe 依赖；保留独立 bypass/tool restriction。 |
| README.md | `/Users/vincentwang/Documents/NoteVault/tools/claudian/README.md` | 产物/验收索引、四档与旧用户说明；不移植 screenshots。 |

不适用的上游文件群已按完整主 diff 的路径/hunk 分类：

- ComposerInfoRow、LinkedContentChip/Controller、ComposerContextTray、TabRuntimeShell、ZenComposerLayout/ZenModePanel，以及 composer-info-row/context-tray/input/zen-mode/context-footer CSS：布局/info-row/queued-strip/Zen 改造，不是四档依赖。
- model-selector/thinking-selector/mode-selector/service-tier-toggle CSS、variables/accessibility/composer-editor 与相应 style/UI tests：其他控件 skin/布局；只提取权限控件实际所需行为，不整段覆盖。
- CodexExecutionSession/CodexModelPolicy/codexAppServerTypes 与 backend tests：auto-review 原生协议，明确排除。
- Pi 全部 module/settings/launch/execution/UI/tests、Grok policy/UI/tests：fork 没有对应 provider，不新建。
- core/execution 与 ClaudeExecutionRequestEncoder/Session、ProviderModuleCatalog、SideChatTracer/SideChatToolbar/Zen/Layout 新测试：fork 架构无同构入口，按上表和第9节映射语义，不创建同名影子系统。
- assets/Preview、main-chat 双图、Zen 双图与上游展示 README：图片/宣传范围排除。

### 7. 与 W4/共享树的冲突评估

**需要串行接收 W4d 后基线的直接交集**：

| 绝对路径 | 本案片段 | W4/其他共享片段与处置 |
|---|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts` | 权限 policy/options | W4 command discovery/contracts，同文件不同区域；不可整文件覆盖。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/ChatRuntime.ts` | callback 模式注释/语义 | W4 getCommandDiscovery seam，保留其 optional facet。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts` | native/scoped/动态依赖 | W4 query cell/facet、其他 Stop/资源生命周期；不得挪 route scope guard 或 revoke 边界。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts` | 权限 UI、callback、Escape/cleanup | W4 runtime/registry/目录/catalog 接线、当前 model identity；cleanup 片段实际邻近，禁止重排通用 cleanup。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ui/InputToolbar.ts` | PermissionToggle | W4 ExternalContextSelector 的提交/通知顺序；局部编辑，保留单提交点。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/Tab.test.ts` | 权限回写/Plan/menu | W4 provider/runtime/catalog tests；联合定向回归。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/ClaudianService.test.ts` | setter/native/scoped/失败 | W4/P1 与 Stop tests 在同大文件；保留其断言与 fixtures。 |

**本案不计划编辑**：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/inline-edit/ui/InlineEditModal.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/commandDiscoveryWiring.test.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/shared/components/SlashCommandDropdown.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/ProviderWorkspaceRegistry.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/ClaudeCommandCatalog.ts`

这些入口/测试本輪未发现权限 toggle 调用依赖；作为回归消费者运行，不因本案再改 W4 接线。若 W4d 最终落点变化使 mock/interface 真需适配，G0 列新交集后再执行，不靠设计时旧行号覆盖共享树。

ClaudianView、main、i18n 十语言/types、ClaudeApprovalHandler、CodexChatUIConfig 等当前也有未提交改动；**不能仅凭 git status 认定都属于 W4**。本案确实会触及，须由 integrator 按最终 diff 确认与各工作线关系。尤其 #1493/S2 的 ApprovalHandler 只动权限依赖类型，不改其它已落审批修复。

### 8. 方案推演与结构不变量

以下不是新实现测试。四级标注含义：〔实测〕=本轮已跑；〔既有读数〕=源码/提交实际读取；〔推算〕=由读数推导；〔纯示意〕=拟议方案预期。新行为验收全在第9节。

#### 8.1 具象链与反例

1. **配置层不充分**：前提〔既有读数〕SDK init auto、Tab 将其映为 normal、default safeMode=acceptEdits。链〔推算〕：default 改 auto→首轮 init→Tab 保存 normal→下轮 builder acceptEdits。结论：只改默认不能保持 Auto。反例输入：初始 Manual/SDK default 会正确落回旧 normal，不能据这个样本称四档已支持。绿：auto/acceptEdits 四档回写后第二条 request 仍保真；红：第二条变 acceptEdits/normal 或 provider map 没变。
2. **迁移先后**：锚值 raw normal+claudeSafeMode=auto。旧 getter 得 auto〔既有读数〕；若先 strip/updater 丢旧值，新 migration 将认为 Safe 缺失→acceptEdits〔推算〕。绿〔纯示意〕：磁盘 auto、SDK auto、source 已成功写后才删除；红：acceptEdits 或失败时源被删。
3. **Plan 不是四档第五项**：锚值 acceptEdits→ShiftTab plan→save→Exit approve。预期〔纯示意〕内存仍 plan，落盘副本 manual，Exit 恢复 acceptEdits；fallback/failed/cancel 保持计划或 Manual，不恢复 YOLO。反例：values 只有四档且内存正规化不认 transient，第一次 snapshot 已退出 Plan。绿：期间 SDK mode plan、四档列表无第五项；红：snapshot 隐式变 Auto/Manual。
4. **动态失败**：锚值 currentSDK=bypassPermissions，用户选择 Manual，setter rejects。旧 catch 仅通知〔既有读数〕。预期〔纯示意〕本次 user message enqueue=0、currentSDK 保持旧已知值、可见失败；红：仍 enqueue=1 以 YOLO 执行，或假写 currentSDK=default。补丁来源是权限同步失败链推演，不借机改其他 dynamic knob 的失败策略。
5. **provider 归属**：锚值顶层 Codex yolo、saved.claude manual。预期〔纯示意〕Claude setter default、Codex map 原 yolo；反例：getPermissionMode 仍取顶层，会让 Claude 变 bypass。绿：两 provider projection 各自正确；红：同样“yolo”字符串被借用当用户同意 Claude YOLO。
6. **旁路不等于万能审批拦截**：canUseTool 只处理 SDK 最终询问，批准/拒绝可在其前完成〔官方既有读数〕。所以“换 Auto 一定弹窗”“Manual 每个 Read 都弹窗”“YOLO 永不进 callback”都是过强归因。反例：Read 无需审批；user ask 规则/用户交互可能在 YOLO 仍请求 host。绿〔纯示意〕：普通 bypass callback=0、明确 prompt callback=1；红：删 callback 后异常 prompt 无答复，或用强制 callback 覆写 Auto classifier。
7. **菜单 Escape**：锚值 streaming=true、permission menu=open。预期〔纯示意〕menu close=1、cancelStreaming=0；第二次 Escape 无菜单→cancelStreaming=1。反例：仅 document bubble stopPropagation，Obsidian Scope 已先 cancel。绿：Scope、input、navigation 三入口矩阵均保持；红：任一路第一次 Escape cancel=1。

#### 8.2 不变量判定

| 不变量 | 当前/建议判定与位置 |
|---|---|
| 策略与 UI 正交 | 当前 toggle 用二态 shape 定义所有合法值，违反；policy.values 决定合法性，options 决定菜单，Plan transient 独立后成立。 |
| 数据流单向/无反馈环 | native observation→provider 正规化→Tab settings owner→UI；不由 UI label 反推 SDK。currentConfig 在 native observation 同步，下一次相同 set 不循环。纯结构检查成立，异步/迟到仍需实测。 |
| provider 扩展方向 | 注册 policy/options 即可；不要求 core 认识四档 SDK。Codex/OpenCode 两项为同菜单一般情况特例，成立。 |
| 存储唯一有效口径 | raw legacy 一次映射→clean durable，save 对副本；不继续保留“可配置 safeMode”双真相，成立。 |
| 临时状态不泄漏 | 内存可 plan、磁盘禁止 plan；若 save 改 live input 则违反，必须测试 freeze/深比较。 |
| 多入口覆盖 | main persistent/cold、native init/status active/leaseless、Plan enter/exit、aux/probe、菜单三种 Escape 都列验收；不是只验默认常量。 |
| 扩权限失败不静默 | 权限 setter reject 后不继续 user send；复用错误/lease 清理 owner，局部修正。No-Go 时不能用 Notice 数量冒充“不发消息”。 |
| W4 生命周期不回退 | 权限 setter 不创建 query scope/owned probe，菜单 cleanup 不撤 command cell；具体证明需 W4 回归，不凭字段分区认定无影响。 |

### 9. 测试文件清单、用例与验收

#### 9.1 测试清单

新增：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/core/providers/permissionModes.test.ts`：policy 正规化/default/fallback/transient、无 SDK 依赖。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/permissionModes.test.ts`：四档正反映射、legacy 与来源优先级。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/permissionModeWiring.test.ts`：生产 Tab/settings/runtime/query 主链、审批与旁路、原生回写、迟到/失败。

修改既有相关用例（保留其他工作线断言，不全文件替换）：

| 测试绝对路径 | 修改点 |
|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/storage/ClaudianSettingsStorage.test.ts` | 通过旧 re-export 仍测真实 app Storage；raw/save 幂等、所有 legacy 源、Plan 副本、失败不删源。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/settings.test.ts` | 废除 Safe 有效配置；残留 Safe 不返回/不写入，模型迁移不变。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/core/providers/ProviderSettingsCoordinator.test.ts` | 所有 provider snapshots/maps、缺省不串档、legacy 捕获早于 model updater、transient。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/QueryOptionsBuilder.test.ts` | main persistent/cold 四档/Plan，所有启动旗标、chrome/sources，不同档不需重启。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/ClaudianService.test.ts` | 四档动态 setter/native/scoped；旧“权限更新错误静默处理”改为失败禁止下一消息；旧 Safe 重启样本改直接 mode 切换。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/ClaudeApprovalHandler.test.ts` | 仅权限依赖 fixture、Exit恢复四档；保持现有 once/always/request 生命周期断言。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/Tab.test.ts` | 四档回调、保存和 Plan 恢复、Escape/cleanup、provider切换。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/ClaudianView.test.ts` | Scope先关菜单；ShiftTab fallback，保留模型/manager 生命周期。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/ui/InputToolbar.test.ts` | DOM四档/二档、labels/descriptions/check/icon、keyboard、same selection、destroy。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/ui/ClaudeChatUIConfig.test.ts` | policy/options/Plan 非第五选项。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/ui/ClaudeSettingsTab.test.ts` | 删除 Safe dropdown、Configuration heading。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/codex/ui/CodexChatUIConfig.test.ts` | two-option 契约、labels/Plan 保持；不生成 auto-review。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/opencode/modes.test.ts` | two-option 与 managed mode resolve/apply 保持。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/claudeColdStartQuery.test.ts` | 辅助 fixed bypass、不增加 callback、统一 auto flag/chrome。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/commands/probeRuntimeCommands.test.ts` | legacy flags、persistSession:false；不证明生产 owned probe 可用。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/inline-edit/InlineEditService.test.ts` | 调生产 read-only hook；四档下读允许、写拒绝、user accept边界不变。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/services/TitleGenerationService.test.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/services/InstructionRefineService.test.ts` | tools=[] 仍传入，不误恢复 SDK 默认工具。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/main.test.ts` | mock新装 auto，legacy→map与load两端，无 Safe残留。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/i18n/uiLiteralGate.test.ts` | 按现有literal gate要求更新权限UI；不改其它文案检测基线。 |

不新增共用 SDK mock API。既有 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/__mocks__/claude-agent-sdk.ts` 可记录 options 和 setPermissionMode；新 integration 在本测试内对其 query 作 scripted stub，并在 afterEach 恢复，避免与 W4 共用 mock 耦合。默认 moduleNameMapper 已指向 mock。

#### 9.2 必验用例表（新预期均〔纯示意〕）

| 编号 | 生产链/输入 | 可观察验收，绿/红 |
|---|---|---|
| T01 | main冷启动/持久，各选四档 | options 与表3.1的 SDK值逐一相等；auto flag恒有、callback保留。任一仍依赖 safeMode为红。 |
| T02 | Manual；SDK fixture 发需审批 Edit，UI选Allow once/Deny/Cancel | real ApprovalHandler→Tab→InputController→response，callback=1；allow仅此请求，deny不执行，cancel interrupt，保持当前 S2 已实现响应语义。 |
| T03 | Manual；SDK fixture 已批准 Read | callback=0，不制造每tool弹窗。 |
| T04 | Accept edits；SDK fixture 文件编辑已批准；另发需审批 Bash | 编辑callback=0；Bash callback=1；真实返回决定成功/拒绝，不让 UI字段独立蒙混。 |
| T05 | Auto；classifier fixture 分别批准、拒绝、最终prompt | 批准callback=0、拒绝callback=0/工具不执行、prompt callback=1→真实UI决策。不得本地重写classifier。 |
| T06 | YOLO；普通已批准 Bash/Edit fixture | options=bypass、callback=0、无approval DOM；仍保留callback/hooks配置。 |
| T07 | YOLO；fixture 显式prompt/AskUserQuestion | 已注册生产callback可答并得到response；不把T06的0次当所有请求必然旁路。 |
| T08 | 四档轮换manual→auto→acceptEdits→yolo→manual，发多条消息 | SDK query创建=1，setter按字面预期，currentConfig/sdkMode正确，W4 scope/command cell无revoke；same-value不重复setter。 |
| T09 | currentSDK=yolo，Manual setter reject | 下一user enqueue=0，有错误，currentConfig不假改，turn/handler最终清理可再试；红=仍用YOLO发消息。 |
| T10 | native init/status 四SDK值，主turn及leaseless各一次 | runtime正规化→callback→Tab writer→saved.claude→UI→下一请求全等；status不产生session/turn/done。 |
| T11 | native unknown、旧query迟到/旧tab callback | 不错误正规化到Auto/Manual、不改新provider map/UI；关闭old callback资源。 |
| T12 | 表4.2 raw 数据，嵌套/顶层/saved/map冲突 | load结果与序列化匹配；raw非active top不串provider；旧字段已在完成映射后清。 |
| T13 | legacy文件写回失败、正常重载、直接save、update | 写失败delete=0；新读旧读一致；第二次load同值不重复迁移；直接save不先删参数。 |
| T14 | 冻结caller/defaults；plan内save；四档load→save→load | input/defaults深比较不变；memory plan/disk manual，durable字节语义幂等。 |
| T15 | 各四档→ShiftTab/EnterPlan→Exit approve/feedback/cancel | approve恢复各自原档；feedback/cancel不擅自退出；missing prePlan→Manual；四档列表=4非5。 |
| T16 | 菜单先选档、pending存储时换provider/closeTab | 旧provider captured提交不落到新provider；迟到UI无覆盖；same selection无save。 |
| T17 | streaming时从Scope/input/navigation按Escape | 第一次close=1/cancel=0，第二次旧cancel行为；destroy后listeners=0、provider切换不残菜单。 |
| T18 | fork/Codex/OpenCode two options与Plan/native managed mode | 无auto-review，sandbox/managed mode不变；saved各自不串档。 |
| T19 | inline四档→cold runner→生产PreToolUse/allowed tools | SDK fixed bypass、tools只读、Edit/Write被hook拒绝；title/refine tools=[]；没有无人消费审批。 |
| T20 | W4 cold/prime/warmup/send/inline与权限模式轮换 | commandDiscoveryWiring及既有W4 tests仍过；无新owned probe、目录ABA/revoke/cleanup口径无回退。 |
| T21 | Safe设置删除、十语言与theme/UI | Configuration heading；四档描述与旁路警示、离开YOLO icon清除；i18n keys齐全。 |

**mock 真实性边界**：不 mock 被测 mapper、coordinator、storage writer、ApprovalHandler 或 Tab writer。SDK scripted stub 是外部输入，独立声明 `approved/denied/prompt` verdict，不从生产正向映射生成“预期”。stub 按 prompt调用真实 options.canUseTool并用其真实返回构造tool结果，测试捕获 options/setter/DOM/存储/后续message。T03–T07只能证明适配器在这些SDK输入下接线正确，**不能证明真实 SDK classifier、rules优先级、Auto可用性或组织策略**；不得把mock输出包装为SDK运行实证。

### 10. 交付物规范

**① 新增目录树（锚定绝对根，仅列新增）**

```text
/Users/vincentwang/Documents/NoteVault/tools/claudian/
├── docs/designs/2026-11-09-upstream-1482-claude-permission-port.md
├── src/core/providers/permissionModes.ts
├── src/providers/claude/permissionModes.ts
├── tests/unit/core/providers/permissionModes.test.ts
├── tests/unit/providers/claude/permissionModes.test.ts
└── tests/integration/features/chat/permissionModeWiring.test.ts
```

**② 命名与索引**：日期+upstream-1482-claude-permission-port 标识本移植设计；permissionModes 为权限策略/映射，不叫 SafeConfig 或 Patch；tests 镜像生产目录，integration 名标全链路。实施后由 integrator 在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/README.md` 登记本设计、两生产 helper、三新增 tests 与验收命令；设计阶段不登记为已上线、不修改 README。

**③ 产物清单**

| 绝对路径 | 用途 | 消费者 |
|---|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-09-upstream-1482-claude-permission-port.md` | 范围、迁移、对照与验收合同 | 用户/主会话/implementer/reviewer |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/permissionModes.ts` | 中立策略正规化与二态复用 | coordinator、storage serialization、Tab/UI验证 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/permissionModes.ts` | Claude四档/legacy/SDK映射 | Claude UI/runtime、Storage migration |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/core/providers/permissionModes.test.ts` | 核心contract检验 | Jest unit/复核 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/permissionModes.test.ts` | Claude策略检验 | Jest unit/复核 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/permissionModeWiring.test.ts` | 多入口host-SDK接线检验 | Jest integration/验收 |

**④ 归属引用/偏离**：遵循 `/Users/vincentwang/Documents/NoteVault/tools/claudian/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/style/CLAUDE.md` 的 provider 边界、TDD、镜像tests、CSS命名。设计沿用本仓库 docs/designs 格式，无目录偏离。测试为复用保留现有 storage/auxiliary 老镜像路径，不为改目录扩大 diff。临时上游 diff 只在 `/tmp`，不落 `.context`/业务目录、不作交付。没有新增用户业务数据或日志。

## 风险与权衡

1. **无需二次裁决删档**：四档全做；保留 fork Plan 临时覆盖，不把它加成第五个审批档。不需为某档删改升级 SDK。用户对默认 Auto 的裁决不等同 Auto 在当前所有模型/代理/CLI 上实测可用。
2. **有意收紧的畸形数据边界**：非法保存值、非法 legacy Safe、磁盘 Plan→Manual；合法 normal 的历史实际档位保持，已存 YOLO保持。不静默抬权。
3. **迁移不可仅靠 bundle 回滚**：新四档 Manual/Auto 老代码可能当normal→acceptEdits；用户切Accept edits后原safeMode若被删除也可能丢解释。切旧bundle而不处理设置不等价安全回退。
4. **新默认不清旧 rules**：用户/project/local allow规则依旧参与原生求值；本案不自动删除已有宽权限、不宣称组织总策略已受控。
5. **#1493/S2独立工作线**：持久授权eligibility、suppression、ordinary取消/timeout不在本授权范围。不能通过本案加“Always allow”顺手越过已有待决闸门。ApprovalHandler只做模式依赖适配，既有修复不回退。
6. **测试只用mock**：已明确不碰真实CLI。Auto/classifier实际能力、SDK与CLI语义漂移、真实Obsidian焦点/样式仍未验证；本轮设计与mock验收不能称生产权限安全验证已完成。实际发布若要求live验证，另获用户许可并用独立测试vault/预算，不默认发起。
7. **共享树范围大**：落地需一个integrator在W4d后串行修改共享热点。当前不创建worktree、不切分支、不commit其他线代码。按用户规则先由主会话保护未提交基线，再派实施；本任务自身无权替其它线收口。
8. **动态应用时机**：保留“下一条provider消息前应用”的fork语义；已经执行的tool不追回，进行中调用不因切Manual重新审批。若用户另要求菜单即时影响活动query，应另定明确事务/时序，不暗藏在这次移植。

### 回滚边界

- G0 先记录W4d后基线提交和独立本案 diff；仅revert本案提交，不能reset共享工作区或回退W4修复。
- 未上线/未写新设置：恢复本案代码即可。
- 已迁移设置但无后续用户修改：用实施前**外部临时备份**恢复对应Claudian settings文件；备份不作为仓库产物，权限规则文件/metadata不动。
- 已有后续用户修改：不全文件覆盖；按provider所有权转换当前Claude新值：auto→normal+safeMode auto、manual→normal+safeMode default、acceptEdits→normal+safeMode acceptEdits、yolo→yolo。同步top owned字段与saved.claude；其他provider和用户新设置原样保留。未知先Manual/default，绝不YOLO。
- 回滚转换是后续明确授权动作，不在本设计轮执行；须有一次 mock old-reader 对拍，证明旧builder恢复同一SDK值。
- 不撤销、不清理任何已经写入的原生permission规则，不回退S2已实施once修复/资源owner合同。回退bundle须是保留这些安全修复且能读转换设置的验证产物，不默认旧main.js安全。
- 重启/部署仅在相关运行turn安全收尾后，由主会话另行确认；设计不结束其它session或后台任务。

## 验证方式

### G0：接收 W4d、冻结基线与证据

由 integrator 确认最终文件交集、SDK锁文件/installed版本、无待合流W4代码，保留当前真实diff而非按设计行号整文件覆盖。先跑第1节六组基线和W4定向tests，异常归属于基线，不靠本案改造掩盖。

```bash
git -C /Users/vincentwang/Documents/NoteVault/tools/claudian status --short
git -C /Users/vincentwang/Documents/NoteVault/tools/claudian rev-parse HEAD
git -C /Users/vincentwang/Documents/NoteVault/tools/claudian show --stat 7b44007cc
```

### G1：TDD 与定向 mock 验收

先新增T01–T21失败样本，再实现各链路；新增test路径在实施前不存在，不现在执行冒充通过。所有new query都通过Jest mapper/local scripted mock，不require真实sdk.mjs、不spawn真实CLI、不访问活vault设置/权限文件。

```bash
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run typecheck
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run lint
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run test -- --selectProjects unit --runInBand --runTestsByPath \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/core/providers/permissionModes.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/permissionModes.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/storage/ClaudianSettingsStorage.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/core/providers/ProviderSettingsCoordinator.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/QueryOptionsBuilder.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/ClaudianService.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/ClaudeApprovalHandler.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/Tab.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/ClaudianView.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/ui/InputToolbar.test.ts
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run test -- --selectProjects integration --runInBand --runTestsByPath \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/permissionModeWiring.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/main.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/commandDiscoveryWiring.test.ts
```

Storage用in-memory adapter/独立mock文件内容断言，migration失败场景核write/delete顺序；冻结input/defaults确保save不改Plan内存。验证所有模式的第二条请求和saved map，不能只assert配置常量或setter.called。

### G2：全 mock 回归、构建与独立复核

此仓库已有integration绕mapper加载真实SDK（即便fake CLI），不满足本任务“测试用mock SDK”。本轮不要直接运行未筛选的 `npm run test`。

```bash
# 先审计当前最终树；如新增其他真实SDK入口，更新排除清单再运行。
rg -n 'sdk\.mjs|nativeRequire|mockRealSdk|requireActual.*claude-agent-sdk' \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests --glob '*.test.ts'
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run test -- --selectProjects unit --runInBand
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run test -- --selectProjects integration --runInBand \
  --testPathIgnorePatterns='(CliDeathSettlement|StopSdkFieldPreservation)\.test\.ts$'
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run build
git -C /Users/vincentwang/Documents/NoteVault/tools/claudian diff --check
```

同时保留W4d的定向回归清单：QueryCommandDiscovery、ClaudeCommandCatalog、ProviderWorkspaceRegistry、Tab、InlineEditModal.openAndWait、SlashCommandDropdown.provider、commandDiscoveryWiring。特别断言四档setter不触发命令scope撤销、不重新注入cold probe。

独立 reviewer 检查：safeMode是否只剩migration读取、所有SDK请求入口是否使用对应策略、原生回写是否保持provider归属、save是否仅改副本、权限setter失败是否真的阻断enqueue、Plan/三路Escape和W4生命周期是否完整。不由主会话重复全量复核。构建通过不自动授权部署。

### G3：回退与未验证项目

用mock旧reader/builder验证回退转换四档的SDK值逐一相等，settings metadata/其它provider不变。用mock injected init/status/default/unknown与setter rejects验证Auto不可用时无YOLO降级。

真实CLI的Auto可用性、classifier/rules/组织限制、真实Obsidian菜单焦点/视觉均单列**未验证**；没有另获live/部署授权时到此停止，不伪装成通过、不增CLI测试来补齐表面覆盖。

## 关联

- [[tools/claudian/docs/designs/2026-11-09-command-discovery-wiring-w1-w2-w4]]
- [[tools/claudian/docs/designs/2026-11-07-upstream-compat-stop-permissions-discovery]]
- [[tools/claudian/docs/designs/2026-11-07-upstream-compat-evidence-closure-supplement]]
- [[tools/claudian/docs/designs/2026-11-08-upstream-compat-remaining-implementation-contract]]
- [上游 #1482](https://github.com/YishenTu/claudian/pull/1482)、[主体提交](https://github.com/YishenTu/claudian/commit/7b44007cc261879320e44830b6e5732123741513)
- [Claude 子 PR #1480](https://github.com/YishenTu/claudian/pull/1480)、[四档原始提交](https://github.com/YishenTu/claudian/commit/2ef73ade7fc8fe1ede889e48c8f64af53422b3ab)、[新装 Auto](https://github.com/YishenTu/claudian/commit/711b8ffb8a04c18b066b7951d18573d71198e430)、[YOLO 图标](https://github.com/YishenTu/claudian/commit/893b5b648f2654b4020957b07e44d76805ab25f8)
- [#1493 原生建议透传](https://github.com/YishenTu/claudian/commit/552ecf8f4c43b5c6d5eff5cb5201f8ba6053d32f)、[#1894 原生模式回写](https://github.com/YishenTu/claudian/commit/2ebd1e1e34ec75f5f556c46779cdaabda14b2db6)
- [官方 Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)、[TypeScript types](https://code.claude.com/docs/en/agent-sdk/typescript)。本轮经 Context7 查询；最新文档是能力/风险依据，不替代installed SDK/真实CLI实证。
