---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags: [architect, claudian, codex, opencode, compatibility, security]
---

# 背景与问题

审计 `hotfix/notify-lease@1d038d2d` 上 B1/投影并发/READY 门控/A0b/rewind/modelPresets/i18n/P1 搜索对 Codex、OpenCode 的真实影响：结论是发送与流式主链兼容，但非 Claude 历史仍全量物化且 P1 全历史搜索实际不可用，存在高风险可用性缺口；本记录是待用户确认的修复设计，不是实施记录。

# 方案设计

## 1. 审计基线与总表

仓库 HEAD 与派单一致为 `1d038d2d`，分支为 `hotfix/notify-lease`；但工作树并非完全干净，审计开始前已有未跟踪 `/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/`，本次未触碰。

| 改造项 | Codex | OpenCode | 一句话结论 |
|---|---|---|---|
| B1 预算窗口/摘要封顶 | **不兼容** | **不兼容** | 两者都未实现 `acquireHistoryIndex`，仍全量读取并物化历史，B1 的资源上限完全未覆盖。 |
| planner/锚点/around/compact 假设 | **不适用（不能直接复用 Claude 实现）** | **不适用（不能直接复用 Claude 实现）** | Codex 有自己的 turn/compaction 语义，OpenCode 是 SQLite message/part；只能复用中立契约和纯 planner，不能复用 Claude JSONL index/materializer。 |
| ProjectionWriteCoordinator + DOM epoch/dirty | **兼容** | **兼容** | 租约位于 per-tab UI 层，输入发送和归一化 `StreamChunk` 共用；不依赖 provider 原生消息 ID。 |
| Tab READY 进度门控 | **兼容但当前无实际作用** | **兼容但当前无实际作用** | 两者水合走统一 SHELL→LOADING→READY，但不建 index、不发 `HistoryLoadProgress`。 |
| `runStoredTransaction` stale 守卫 | **兼容但仅覆盖 lease 操作** | **兼容但仅覆盖 lease 操作** | 守卫本身中立；两者无 history lease，分页/搜索定位路径不可达，普通初始水合靠 hydration generation 与输入禁用保护。 |
| A0b usage 快照 | **不适用，现有独立链路兼容** | **不适用，现有独立链路兼容** | A0b 只改 Claude transform；Codex 从 app-server/tail、OpenCode 从 ACP 产生各自 `UsageInfo`。 |
| context gauge 分母 | **部分兼容** | **兼容** | Codex 实时通知可给权威窗口，但本地 fallback 固定 200k 且忽略自定义 limit；OpenCode 优先 ACP 权威窗口，fallback 支持 `customContextLimits`。 |
| rewind lazy-start 修复 | **不适用** | **不适用** | 两者 capability 均声明不支持 rewind，按钮被门控，runtime 也返回 `canRewind:false`；修复只改 Claude runtime。 |
| `modelPresets` 迁移 | **兼容** | **兼容** | 迁移只检查/改写 `providerConfigs.claude`，Codex/OpenCode 配置袋独立保留。 |
| i18n | **设置页兼容；聊天 UI 不完整** | **设置页兼容；聊天 UI 不完整** | 设置页及弹窗已迁移且有 AST 门禁；聊天配置和若干共享聊天 Notice/按钮仍硬编码英文。 |
| P1 历史搜索 | **不兼容** | **不兼容** | 搜索面板可打开，但 `searchHistory()` 在无 lease 时直接返回空数组，因此已完整水合的非 Claude 会话也永远显示无结果。 |
| 命令目录 | **兼容** | **兼容** | Codex 继续用 `/compact` + `$skill` catalog；OpenCode 继续使用 ACP runtime commands；本批未改变 catalog 契约。 |

## 2. 逐项证据链

### 2.1 水合、预算窗口与历史源

**判定：Codex/OpenCode 对既有功能兼容，但对 B1 的资源安全目标不兼容。**

1. 共享历史能力把索引声明为可选：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts:415-431,473-487`；预算窗口只挂在 `HistoryIndexLease.loadWindow/planWindow`。
2. Codex 注册自己的 history service：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/registration.ts:14-28`；该 service 只有 `hydrateConversationHistory`，没有 `acquireHistoryIndex`：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/history/CodexConversationHistoryService.ts:24-140`。普通水合最终调用 `parseCodexSessionFile` 并整数组写入 `conversation.messages`（:132-139）。
3. Codex 读取是同步整文件：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/history/CodexHistoryStore.ts:1129-1155` 使用 `readFileSync`、`split('\n')`、全量 records；这会同时驻留原字符串、行数组、records、turn map 和最终消息，超大会话仍可阻塞 renderer/耗尽内存。
4. OpenCode 同样未实现 index：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/history/OpencodeConversationHistoryService.ts:6-36`。它调用 `loadOpencodeSessionMessages` 后把完整数组写入 `conversation.messages`（:28-35）。底层一次查询 session 的全部 message/part rows，再整体 hydrate/map：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/history/OpencodeHistoryStore.ts:33-55,377-433`。
5. 共享入口无条件调用 provider hydration：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts:607-613,641-647,713-720`。只有 provider 返回 `oversize` 且提供 index 时，`ConversationController.loadActive` 才进入预算窗口：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts:226-280`。Codex/OpenCode 当前既不返回 oversize，也无 index，因此绕过 B1。
6. Claude planner/summary 实现在 `src/providers/claude/history/`，相关提交 `00f6cc3d`、`7945833e` 只改 Claude index/materializer；不能据共享类型推断另外两个 provider 已受保护。

**历史语义差异：**

- Claude：SDK JSONL + sidecar/branch filter/compact 边界，现有索引和 summary mapper针对该结构。
- Codex：JSONL 同时支持 legacy `event` 与 modern `event_msg/response_item/compacted`；一旦看到 `compacted`，会清空已有 turn 状态并以 `replacement_history` 重建：`CodexHistoryStore.ts:802-836,1150-1174,1230-1257`。turn 锚点应使用 `task_started/turn.started` 及 server turn id，而不是 Claude UUID/branch 假设；`context_compacted` 还能形成独立可见边界（:923-937）。
- Codex fork 还需组合“源 transcript 截至 checkpoint + fork-only turns”：`CodexConversationHistoryService.ts:40-90,200-209`。窗口 snapshot 必须先定义该逻辑视图，不能只索引单个 JSONL。
- OpenCode：事实源是 SQLite `message`/`part`，顺序为 `time_created,id`：`OpencodeHistoryStore.ts:398-407`；相邻 assistant rows 会折叠成一个 UI message：`:136-160`。其 turn 边界不是 Claude JSONL turn，若分页必须先定义稳定 group key，避免页边界拆开被折叠的 assistant 组。

**修复方案（推荐，P0，高风险）：**保留 provider-neutral `HistoryIndexLease/HistoryWindowRequest/HistoryLoadBudget`，分别新增 Codex 与 OpenCode provider-owned index/materializer，不抽象原始记录格式。

- Codex：修改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/history/CodexConversationHistoryService.ts`、`CodexHistoryStore.ts`，新增 `CodexTranscriptHistoryIndex.ts`；以 transcript snapshot（path/size/mtime，fork 时含 source+fork 两份 snapshot）建立 turn descriptor；compaction 前历史按当前 parser 语义失效，`replacement_history` 成为新逻辑前缀；message id 改为由稳定 record/turn/bubble identity 派生，不能仅用最终数组序号。
- OpenCode：修改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/history/OpencodeConversationHistoryService.ts`、`OpencodeHistoryStore.ts`，新增 `OpencodeHistoryIndex.ts`；在只读 SQLite 事务/snapshot 中先查 message descriptors，再按窗口批量取 parts；assistant 合并组必须是分页原子单元。
- 两者复用 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/history/HistoryResourcePolicy.ts` 与纯窗口 planner，但各自实现 source-byte 估算、detail/summary 投影。单个巨型 tool/result 同样执行 `maxProjectedChars` hard cap。
- 迁移后 `ConversationController` 按 `acquireHistoryIndex` capability 统一进入窗口，不写 `providerId` 分支。

备选是仅在全量读取前做文件/行数阈值并拒绝打开。实现小，但把“卡死”变成“不可用”，也无法支持搜索/分页；只适合作紧急止血，不推荐作为终态。

### 2.2 投影协调、消息 ID、事件流和 timestamp

**判定：当前共享发送/流式路径兼容；历史窗口化前没有发现 provider 特有破坏。**

1. coordinator 明确不读取 provider id，也不持业务消息：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/rendering/ProjectionWriteCoordinator.ts:1-10`；FIFO、取消、dispose 逻辑在 :27-133。
2. 每个 tab 都无条件创建 coordinator：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts:1391-1395`。每次发送在创建 user/assistant DOM 前取得 live lease：`InputController.ts:278-358`；所以 Codex/OpenCode 都经过同一路径。
3. `StreamController` 每个 chunk 前校验 `domEpoch + isMounted`，失效后只更新 domain 并标 `projectionDirty`：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/StreamController.ts:239-275,823-847`；turn 结束先释放 live，再以 stored lease 重投影：`InputController.ts:699-731`。
4. Codex 的多气泡事件被显式标准化为 `user_message_start/assistant_message_start`：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/runtime/CodexNotificationRouter.ts:370-401`；共享 InputController 在边界上结束旧 assistant、创建新 assistant并刷新 DOM epoch：`InputController.ts:1113-1207`。因此 coordinator 不依赖 Codex 原生 item id。
5. OpenCode 不发上述边界，但普通单 assistant 占位 + normalized chunks 满足共享流；其历史消息使用原生 message id/timestamp：`OpencodeHistoryStore.ts:91-133`。Codex 历史当前使用 `codex-msg-${index}`，timestamp 来自 transcript，缺失时退化为 `Date.now()`：`CodexHistoryStore.ts:949-1038`。这对当前一次性完整 hydrate 可用，但未来窗口化时序号和 `Date.now()` 不能作为跨页稳定 identity/order，必须按 §2.1 修复。
6. `runStoredTransaction` 捕获 conversation id，并在 window I/O 和 render await 后复验：`ConversationController.ts:359-382,434-473,595-655`。非 Claude 无 lease，故这些事务当前不可达；初始 hydration 则由 `TabManager` generation 检查和非 READY 输入禁用保护：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts:350-465`。
7. READY 进度门控位于 `Tab.ts:1676-1687`；非 Claude 不传 index progress，因此是无害 no-op。

**补强方案（P1，中风险）：**在新增 Codex/OpenCode index 时，把稳定 `projectionKey` 作为 descriptor 字段，并增加 provider 参数化集成测试：stored restore 与 live chunk 并发、切会话发生在 load await/render await、Codex 多 assistant bubble、OpenCode tool update；断言无跨会话写入、无重复/丢消息、DOM id 稳定。

### 2.3 context 用量与分母

**判定：A0b 没有污染非 Claude；Codex fallback 分母有缺口。**

1. A0b commit `9536151e` 只修改 Claude runtime/sdk/stream 与对应测试；核心状态机在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/stream/transformClaudeMessage.ts`，非 Claude 不调用。
2. Codex 从 `thread/tokenUsage/updated` 取 `last.inputTokens` 和 `modelContextWindow`，标记 runtime window 为 authoritative：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/runtime/CodexNotificationRouter.ts:438-456`；协议字段见 `codexAppServerTypes.ts:492-507`。其测试明确断言 last=9000、window=200000、5%：`tests/unit/providers/codex/runtime/CodexNotificationRouter.test.ts:401-438`。
3. Codex transcript tail 另从 `token_count` 取本轮 input，并在 `task_complete` 发 usage：`CodexSessionFileTail.ts:221-266,300-314`。若 transcript 没给模型窗口，该链路使用本地 fallback。
4. OpenCode 从 ACP `usage_update` 与 prompt response usage 组合：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/runtime/OpencodeChatRuntime.ts:338-379,1045-1087`；`buildAcpUsageInfo.ts:10-32` 优先 `usage_update.used/size`，并正确标注权威性。
5. shared state 不重算 token 分项，只接收 provider 的 `contextTokens`：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/types/chat.ts:153-176`；`StreamController.ts:370-391` 做 session 隔离并在缺 model 时补 active model。
6. shared model-change 刷新仅在“同 model + authoritative”时保留 runtime 分母，否则调用 provider UI config：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/utils/usageInfo.ts:9-25`；调用点为 `ClaudianView.ts:93-112` 与 `Tab.ts:844-852`。
7. Codex `getContextWindowSize()` 无参数、固定返回 200,000：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/ui/CodexChatUIConfig.ts:42-45,73-75`，所以 Codex 设置页虽展示 provider-scoped custom context limits（`CodexSettingsTab.ts:436`），该值并未生效。OpenCode 则读取 `customLimits?.[model]`：`OpencodeChatUIConfig.ts:155-157`。

**修复方案（P1，中风险）：**修改 `CodexChatUIConfig.ts#getContextWindowSize(model, customLimits)`，与 OpenCode 一致优先 `customLimits[model]`，否则 200k；保留 app-server `modelContextWindow` 的 authoritative 优先级。增加“无权威窗口时自定义值生效；有权威窗口且 model 相同时不覆盖；切 model 后回退对应自定义值”三组测试。不要把 Claude `modelPresets` 扩散为全 provider 数据模型。

### 2.4 rewind

**判定：不适用，能力门控正确。**

- Codex/OpenCode capabilities 均为 `supportsRewind:false`：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/capabilities.ts:3-16`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/capabilities.ts:3-16`。
- `MessageRenderer` 在加按钮前检查 capability：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/rendering/MessageRenderer.ts:1054-1065,1130-1145`。
- 两 runtime 的 `rewind()` 都返回失败：`CodexChatRuntime.ts:752-757`、`OpencodeChatRuntime.ts:467-472`。
- lazy-start commit `b047650c` 只改 `ClaudeChatRuntime.ts` 与 Claude 测试，未改变共享接口。

无需修复。长期若 Codex 要支持 rollback，应新增独立 capability 实现并复用 fork checkpoint 的 turn id，不应让 Claude rewind 初始化逻辑下沉到共享层。

### 2.5 modelPresets 设置迁移

**判定：兼容。**

- migration 只定位 `providerConfigs.claude`：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/settings/ClaudianSettingsStorage.ts:201-221`；加载时 Claude、Codex 分别通过各自 getter/update 写回：`:277-309`。
- provider 默认配置分别保留：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/defaultProviderConfigs.ts:6-15`；只有 Claude preset array 做深拷贝。
- Codex 仍有自己的 `customModels`：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/settings.ts:20-48,102-150,193-216`；OpenCode 仍有独立发现模型/可见模型配置：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/settings.ts:24-53,148-177`。
- 持久化测试确认 Codex host-scoped 字段仍存在：`tests/unit/providers/claude/storage/ClaudianSettingsStorage.test.ts:424-440`。

无需修复。建议补一个包含 Claude legacy 字段、Codex `customModels`、OpenCode `visibleModels/modelAliases` 的单一迁移 fixture，明确断言后两者逐字段不变，防止未来浅合并回归。

### 2.6 i18n

**判定：设置页兼容；“与 Claude 对话 UI 文案完整对齐”不成立。**

1. Codex 设置页已用 `t()`：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/ui/CodexSettingsTab.ts:44-137,236-436`；OpenCode 设置页同样已迁移：`OpencodeSettingsTab.ts:43-91,163-559`。commit `2a975069`、`dd0114a4`、`1d038d2d` 覆盖设置、弹窗、插值与门禁。
2. AST 门禁只扫描六个设置文件：`/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/i18n/uiLiteralGate.test.ts:17-26,252-288`，没有扫描 Codex/OpenCode chat UI config 或共享对话层。
3. 两个 chat config 仍有硬编码：`CodexChatUIConfig.ts:18-39` 的 Low/Medium/High/XHigh、Safe/YOLO/Plan、Standard/Fast；`OpencodeChatUIConfig.ts:24-35,47-48,69-71,103-104,135` 的 ACP runtime、Configured model、Selected in an existing session、Default、Safe/YOLO/Plan。
4. 共享对话路径仍有可见英文，包括 `MessageRenderer.ts:484,557,979,1002,1043,1107,1120`，`Tab.ts:829,1071,1121`，`InputController.ts:455,464`。这些会同时影响 Claude/Codex/OpenCode，不是 Codex 专属回归，但不满足“全量迁移”。
5. 本轮 17 个定向 suites（含 locale/interpolation/AST gate）共 748 tests 全绿，只能证明已纳入门禁的设置范围正确，不能证明聊天 UI 无英文。

**修复方案（P2，低风险）：**扩展现有 i18n，而非另建 provider 翻译体系。

- 修改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/ui/CodexChatUIConfig.ts`、`src/providers/opencode/ui/OpencodeChatUIConfig.ts`，把模块顶层可见常量改为 render-time factory/getter，避免 locale 切换后缓存旧文案。
- 修改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/rendering/MessageRenderer.ts`、`src/features/chat/tabs/Tab.ts`、`src/features/chat/controllers/InputController.ts`，迁移共享 Notice、ARIA、render error、copy feedback。
- 扩大 AST 门禁覆盖上述共享聊天文件及两个 ChatUIConfig；技术 model id、协议值保留窄白名单。

### 2.7 P1 历史搜索与命令目录

**历史搜索判定：不兼容。**

- 所有 tab 都创建 `HistorySearchController`，Cmd/Ctrl+F 也不按 provider 门控：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts:1366-1379,1722-1739`。
- 但实际 corpus 查询在无 `state.historyLease` 时直接 `return []`：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts:485-494`。
- Codex/OpenCode history service 都没有 `acquireHistoryIndex`，所以两者搜索面板能打开、已加载消息也存在，却永远得到空结果。现有 `HistorySearchController` 不自行扫描 DOM；它只高亮传回的 results：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/HistorySearchController.ts:173-210`。

**修复方案（P0，中风险）：**先补 provider-neutral fully-hydrated fallback，再随 §2.1 接入 provider index。

- **[修订 2026-09-16｜来源：独立审核]** 在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts` 中，无 lease 时对 `state.messages` 生成候选，并通过现有 `renderer.renderSearchCandidate + enumerateVisibleMatches` 得出与 DOM 一致的 `{projectionKey=message.id, turnIndex=messageIndex, matchOrdinal, matchedText}`；定位已加载节点，不触发窗口加载。fallback 与 ③ 共用同一规则：`results` 是唯一真相源，只有当前实际可挂载投影的匹配进入 `results/total`；projection/detail 命中但无法挂载的只记诊断，不另立计数口径。
- 更理想的终态是给三 provider 都实现 history search capability，UI 只消费统一 search contract；fully-hydrated fallback 仍作为一般退化路径保留，而不是写 Codex/OpenCode 分支。
- 增加 Codex/OpenCode 完整水合后多消息、多命中、tool-only、切会话 stale、流结束重搜测试，并断言 `total === 可导航 ordinal 数 === mark 集合数`。

**命令目录判定：兼容。**

- Codex catalog 明确提供 `/compact` 与 `$skill`，trigger 为 `['/','$']`：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/commands/CodexSkillCatalog.ts:20-35,80-97,166-174`。
- OpenCode catalog 映射 runtime commands，trigger 为 `/`：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/commands/OpencodeCommandCatalog.ts:8-30,58-91`。
- 共享 dropdown 由 provider config 决定 trigger/entries，且用 request id 丢弃旧异步结果：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/shared/components/SlashCommandDropdown.ts:81-90,92-133,206-247`。本批 history/usage/i18n 改造没有改变这些接口。

## 3. 推荐实施顺序

1. **P0a：历史搜索 fallback**：先恢复 Codex/OpenCode 当前可见且完整水合历史的搜索能力；按 §2.7 的统一 `results`/实际可挂载投影语义实施，改动局限于共享 controller/测试。
2. **P0b：暂缓（主会话裁决，2026-09-16；来源：独立审核）**：当前无可标定阈值的数据——本机 Codex 最大 transcript 仅 54KB，且无 OpenCode DB；阈值必须来自真实样本分位数，不编造固定上限。保留设计速记供未来启用：Codex 在 `CodexHistoryStore.ts:1132` 的 `readFileSync` 前 `stat` 文件大小；OpenCode 在 `OpencodeHistoryStore.ts:401-406` 全量 SELECT 前查询 message/part 行数与 `sum(length(data))`，以行数+数据字节双维预检，超限显式报错，不继续全量物化。
3. **P1：暂缓（用户既有裁决）**：Codex provider-owned index/window；未来启用时处理 mixed format、compaction replacement、fork 双源 snapshot、稳定 projection key。
4. **P2：暂缓（用户既有裁决）**：OpenCode provider-owned index/window；未来启用时采用 SQLite descriptor + message/part 分批查询。
5. **P3：维持原设计**：Codex 分母 fallback + chat i18n 收口，两项低耦合，可分别提交。

不建议把 Claude `ClaudeTranscriptHistoryIndex` 泛化成读取所有 provider 的巨型类；应只抽取真正中立的 planner、budget、page、search 契约，各 provider 保持事实源解析所有权。

# 风险与权衡

1. **高｜可用性/资源耗尽**：Codex `readFileSync + split + 全量 parse` 与 OpenCode 全量 SQLite rows 会让外部可增长的 provider transcript 造成 UI 长任务和内存峰值；这是本审计唯一明确的安全相关高风险（本地拒绝服务），不是数据越权。
2. **高｜Codex compaction/fork 语义**：若简单按文件行切页，会把 compact 前已失效历史重新暴露，或在 fork 中重复 source turns；必须先形成逻辑 snapshot 再规划窗口。
3. **中｜稳定 ID**：Codex 当前 `codex-msg-${index}` 只在完整重放内稳定；窗口化后若仍从局部 0 计数，会导致 dedupe、DOM 定位、搜索全部冲突。
4. **中｜OpenCode assistant 合并**：SQLite 分页若在相邻 assistant rows 中间断页，会造成同一逻辑气泡跨页重复或内容变化；descriptor 必须把合并组设为原子单元。
5. **中｜搜索 fallback 成本**：对已全量水合消息逐条离屏 render 仍是 O(n)，但不额外读取事实源；应受 debounce/generation 与结果上限约束。完成 provider index 后，大会话走 index search。
6. **低｜Codex context fallback**：权威 app-server 通知正常时不受 200k fallback 影响；只有缺通知、tail 无窗口或切模型后的显示可能失真。
7. **低｜i18n 范围误称**：现有设置页门禁有效，但不能称“全量 UI i18n”；需在发布说明中把范围写准，直至聊天层门禁补齐。
8. **未发现新增机密性/完整性漏洞**：本批 i18n 使用 `setText/textContent` 等安全 sink，未引入 HTML 注入；modelPresets 迁移只触及 Claude 配置；projection coordinator 不跨 tab/provider 共享状态。该结论限于本次改造相关路径，不等价于全仓安全审计。
9. **基线限制**：未执行真实 Codex/OpenCode CLI 会话和巨型真实 transcript；协议语义依据仓库实现、fixtures 与测试。最终资源结论需真机 fixture 验证，但“当前无预算边界”由调用链可直接确定。

# 验证方式

## 已执行

```bash
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian test -- --runInBand \
  tests/unit/providers/codex/history/CodexConversationHistoryService.test.ts \
  tests/unit/providers/codex/history/CodexHistoryStore.test.ts \
  tests/unit/providers/codex/runtime/CodexNotificationRouter.test.ts \
  tests/unit/providers/codex/runtime/CodexChatRuntime.test.ts \
  tests/unit/providers/opencode/OpencodeHistoryStore.test.ts \
  tests/unit/providers/opencode/OpencodeChatRuntime.test.ts \
  tests/unit/providers/acp/buildAcpUsageInfo.test.ts \
  tests/unit/features/chat/controllers/ConversationController.test.ts \
  tests/unit/features/chat/controllers/HistorySearchController.test.ts \
  tests/unit/features/chat/controllers/StreamController.test.ts \
  tests/unit/features/chat/rendering/ProjectionWriteCoordinator.test.ts \
  tests/unit/features/chat/tabs/Tab.test.ts \
  tests/unit/features/chat/utils/usageInfo.test.ts \
  tests/unit/i18n/uiLiteralGate.test.ts \
  tests/unit/i18n/interpolationContract.test.ts \
  tests/unit/i18n/locales.test.ts \
  tests/unit/shared/components/SlashCommandDropdown.provider.test.ts
```

结果：17 suites、748 tests 全部通过。首次从 vault 根目录执行失败（无 `package.json`），改用 `npm --prefix` 后通过；该失败不是产品测试失败。

## 修复后必须新增/执行

1. **资源边界**：Codex legacy/modern/mixed/compacted/fork 各准备小型与超大 fixture；OpenCode 准备超大 message/part 数据库。断言首次加载/翻页/搜索的 source bytes、projected chars、turns 均不超预算，单巨型 turn 走摘要且不为空页。
2. **语义对拍**：小 fixture 的全窗口结果与现有全量 parser 对拍 message 顺序、稳定 id、tool 状态、compact 边界；Codex fork 对拍 source prefix + fork-only turns；OpenCode 对拍 adjacent assistant merge。
3. **并发**：Codex 多 bubble、OpenCode tool update 与 stored search/翻页交错；切会话分别卡在 I/O await 和 render await，断言旧页不写新 state/DOM。
4. **搜索**：无 lease 的 Codex/OpenCode 已加载消息可搜；同 message 多命中 ordinal 正确；切会话、关闭 panel、流后刷新不应用陈旧结果；有 lease 后未加载命中可定位。
5. **用量**：Codex authoritative window 优先；无权威窗口时 provider custom limit 生效；切 model 后不沿用旧 model 权威窗口。OpenCode ACP `used/size` 与 prompt-only fallback 保持现状。
6. **i18n**：AST 门禁扩展到两个 ChatUIConfig 与共享聊天文件；zh-CN/zh-TW 人工走模型、权限、推理、复制、错误、fork/rewind 提示；其余 locale 允许英文 fallback 时需明确记录。
7. **总门禁**：

```bash
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run typecheck
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run lint
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian test -- --runInBand
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run build
```

8. **真机核验**：至少用真实 Codex/OpenCode 各执行一次新会话、恢复、流式工具、usage、搜索、切 tab；另用 ≥1 GiB Codex transcript 与高行数 OpenCode DB 观察首屏时间、event-loop long task、heap/RSS，确认总历史增长不再导致单次物化线性增长。

# 关联

- [[2026-09-15-claudian-B4双轨统一与DOM窗口化整合实施方案]]
- [[2026-09-16-claudian-Codex-Opencode设置页i18n化改造方案]]
- [[2026-09-15-claudian超大会话物化与渲染资源预算修复方案]]
- [[2026-09-15-claudian流式分帧互斥与锚点投影硬上限补修]]
