---
type: design-decision
status: confirmed
target: "[[tools/claudian/src/features/chat/controllers/ConversationController.ts]]"
tags: [architect, claudian, ui]
---

# 历史列表当前会话身份后缀方案（[务实]）

## 背景与问题

历史会话列表要求会话名称后追加 session 身份标识。口径订正（2026-11-09 主会话核实）：用户示例 `notevault-8b · 02a240bd` 是 **session 身份串**，格式 `<name> · <sessionId前8位>`，name 取自 `~/.claude/sessions/*.json` 活注册表（CC session name，非 hostname、非 vault 名），口径源 `tools/model_proxy/core/session_identity.py`。历史会话多数已不在活注册表，name 不可得。

用户裁决（原话）："只显示当前活跃的session的即可，历史的不用；其他的OK"——后缀仅渲染在历史列表中**当前活跃会话**那一行；历史项一律不加后缀，**不回退仅显示 sid8，整段不渲染**。实测印证（2026-11-09 本 vault 181 份 meta）：顶层 sessionId=null 102 份（其中 99 份为旧持久化会话，原生 id 在 `providerState.providerSessionId`；3 份真草稿）；当前活注册表仅 4 条，4/181 历史项可命中——历史项无 name 属正常形态。

另有一条从"claudian 优化"继承的"显示 session 文件体积"需求，取证结论见下节。

## 体积需求取证结论（属实且已实现，本方案不重做、不触碰其边界）

- 服务层：`src/app/ConversationSizeService.ts`（注意：尚未提交，属在途工作树产物）。
- 渲染：历史 item 第三行 `sizeEl`（`ConversationController.ts:1672-1673`），异步发布守卫刷新 `:1583-1590`；Tab 标题 tooltip（`TabBar.ts:98,122`）。
- 格式化：`src/features/chat/utils/conversationSize.ts`。
- i18n key 已有：`chat.history.sessionFileKnown / sessionFileUnknown / sessionFileTooltip`（zh-CN.json:90-92，十语言齐）。
- 相邻设计：`docs/designs/2026-11-06-conversation-size-persistence-ack-resume.md`、`2026-11-07-conversation-size-contract-consolidation-restart.md`、`2026-11-07-conversation-size-isolated-persistence-boundary.md`。

身份后缀只在当前会话行 title 行、体积在全项第三行，同行不同列不同数据源，共存无冲突。

## 方案设计

### 身份口径与数据源

- 身份串 = `<name> · <sessionId前8位>`（name 形如 `notevault-8b`，注册表整体就是完整 name，无需拼接 host/编号）。
- **sessionId（当前会话）**：`Conversation.sessionId: string | null`（`src/core/types/chat.ts:107`，持久化 meta.json 顶层 `src/core/bootstrap/SessionStorage.ts:132`）。列表项类型 `ConversationMeta` 无 sessionId 字段，**不扩字段**：isCurrent 行经 `plugin.getConversationSync(conv.id)` 取 Conversation（同函数 `:1676` size 行已用同一调用，零新接线面）。
- **name（活注册表）**：只读扫描 `~/.claude/sessions/*.json`。claudian 侧自实现（util 注入式 reader，默认 Node fs），**不 import model_proxy**（跨语言亦不可行）；逻辑参照其设计约束：只读、按次扫描不缓存（目录规模=活跃进程数级别）、坏 JSON/缺字段跳过、同 UUID 多快照取 procStart 最新。与 model_proxy 的差异：claudian 只需完整 UUID 精确命中分支（Conversation.sessionId 是完整 UUID），不需要其 uuid8 前缀歧义处理。
- HomeFileAdapter 无 `listFiles` 且注册表是 CC 外部状态的一次性读取——util 自带注入 reader 比扩 adapter 更简。
- **渲染判据（三条全满足才渲染）**：① isCurrent（`conv.id === state.currentConversationId`）② 对应 Conversation.sessionId 非空 ③ 该 sessionId 注册表命中取到非空 name。任一不满足 → 整段不渲染：覆盖所有历史项、Codex/OpenCode 当前会话（CC 专属注册表必然未命中）、新草稿（sessionId=null）、注册表缺失/损坏。

### 渲染点（唯一函数、双入口）

`renderHistoryItems`（`ConversationController.ts:1627` 起；title 渲染 `:1665-1666`）。双入口：Tab 栏下拉 `updateHistoryDropdown :1607`、ClaudianView 侧栏 `renderHistoryDropdown :2158-2164`，都走它——单点改，双入口生效。

### 拼接：仅展示层，不写回存储

title 是持久化用户资产（rename 流程、title generation、复制会话标题回执等下游消费），写回会污染存储且 sessionId 在 meta.json 已有。仅改 isCurrent 行 titleEl 与 title attr。

### 异步时序

注册表扫描异步；渲染同步段用最近一次已解析结果，解析完成后**复用 size 行同款守卫**（menuEpoch + currentConversationId + container.visible + span 仍在 DOM，参照 `:1583-1590` 结构）就地补写当前行 span。首开可能先无后缀、毫秒级补写——已知行为，与 size 行首次异步刷新同型。

### 排版细节

- isCurrent 行 title 行内追加 `<span class="claudian-history-item-identity"> · notevault-8b · 02a240bd</span>`；新 CSS 类 `.claudian-history-item-identity`：`color: var(--text-faint)`、`font-size: 11px`（与 item-date 同档）。父级 `.claudian-history-item-title` 已有 `nowrap + hidden + ellipsis`（history.css:136-141），溢出自动截断保底。
- hover tooltip：isCurrent 行 `title` attr 从 `conv.title` 改为 `conv.title + 身份串`（宽屏完整、窄屏截断互补）。
- i18n：纯数据拼接，**零新 key**，十语言零改动。

### 精确文件改动点

| 文件 | 改动 |
|---|---|
| `src/features/chat/utils/sessionIdentity.ts`（新） | `loadActiveSessionNames(reader, dir): Promise<Map<string, string>>`（procStart 最新快照、坏文件/缺字段跳过、只读）+ `formatActiveSessionIdentity(sessionId, name): string`——任一为空返回 `''`（整段不渲染，杜绝悬空 " · "） |
| `src/features/chat/controllers/ConversationController.ts:1665-1666` + 异步守卫段 | isCurrent 行 title 行接 identity span；扫描解析后按守卫补写 |
| `src/style/components/history.css` | 追加 `.claudian-history-item-identity` 规则 |

### 推演

- 具象走查〔推演〕：当前会话 sessionId=`02a240bd-…`、注册表命中 name=`notevault-8b` → 行渲染 `贷款分析 · notevault-8b · 02a240bd`，tooltip 同串；同列表其余 180 项（含 102 个顶层 sessionId=null 的旧持久化会话）→ 纯 title；新草稿 sessionId=null → 无后缀；Codex 当前会话 → 注册表（CC 专属）未命中 → 无后缀；注册表目录缺失 → `loadActiveSessionNames` 返回空 Map → 无后缀，无悬空分隔符（最不利边界：目录/单文件损坏全跳过）。
- 边界〔推演〕：并行其他活跃 CC session 出现在列表历史位置 → **不渲染**。判据是"claudian 当前会话"，注册表命中只是 name 的取数手段，不是判据本身。
- 结构不变量：身份后缀（isCurrent 行 title 行）与体积（全项第三行）不同行不同数据源，正交；守卫结构复用 size 行既有模式不新造；退化（未命中/缺失）= 一般情况的特例，fail-quiet 到纯 title。成立。
- 批量实证（多语言渲染、长 title 截断位）属落地层，见验证方式。

### TDD 测试路径

1. `tests/unit/features/chat/utils/sessionIdentity.test.ts`（新，注入 fake reader）：单快照命中；同 UUID 多快照取 procStart 最新；坏 JSON/缺 sessionId/缺 name 跳过不影响其余；目录缺失返回空 Map；format——完整输入返回 `name · uuid8`，sessionId/name 任一空返回 `''`。
2. `tests/unit/features/chat/controllers/ConversationController.test.ts`（追加，镜像目录已存在）：当前行含 ` · notevault-8b · 02a240bd` 且 tooltip 同步；历史行无后缀；注册表缺失/未命中当前行无后缀；size 行共存不位移；epoch 守卫——解析完成前会话已切换则不写。

## 风险与权衡

1. **注册表是 CC 进程产物、非 claudian 契约**（位置/字段/形态可能随 CC 演进变更）→ 只读容错 + 未命中即不渲染，最坏退化是丢后缀不损功能，风险受控；与 model_proxy 是逻辑参照非共享实现，上游演进需人工对齐（漂移风险，非阻塞）。
2. **#1482 串行硬前提**：ConversationController.ts +219 行在途且 hunk（+1556,40 / +1597,19 / +1629,10 / +1669,15）**直接覆盖 renderHistoryItems 区域**（复核订正：原"0 命中"不实）；TabBar.ts +36、SessionStorage.ts +24 同在途；本方案全部行号基线取自工作树未提交状态。必须排在 #1482 及体积线（ConversationSizeService.ts 等未提交文件）提交后串行实施，不并行叠写。
3. TabBar 的 Tab tooltip 维持不做（用户裁决"其他的OK"覆盖原方案范围，原方案即未含）。

## 验证方式

- `npm run test -- tests/unit/features/chat/utils/sessionIdentity.test.ts tests/unit/features/chat/controllers/ConversationController.test.ts`
- `npm run typecheck && npm run lint && npm run build`
- 人工核对：开历史下拉，当前会话行含 ` · <name> · <sid8>`、悬停 tooltip 完整、长标题截断在 ellipsis、体积行不位移；历史行一律无后缀；新建草稿（不发消息）当前行无后缀；临时移走 `~/.claude/sessions` 验证注册表缺失时当前行无后缀无悬空分隔符。

## 交付物规范

轻量版：新增 2 文件（`src/features/chat/utils/sessionIdentity.ts` 及其镜像测试 `tests/unit/features/chat/utils/sessionIdentity.test.ts`），均落既有约定目录（src mirror tests 布局），命名沿用 feature 目录 util 语义；claudian README 无既有产物索引，沿用 docs/designs 命名惯例即可，无新目录。实施时若新增设置项或第 4 个改动文件，升级为完整四项规范。

## 关联

- [[tools/model_proxy/core/session_identity.py]]（身份口径源，逻辑参照）
- [[tools/claudian/docs/designs/2026-11-07-conversation-size-isolated-persistence-boundary]]
- [[tools/claudian/docs/designs/2026-11-09-upstream-1482-claude-permission-port]]
- [[docs/designs/2026-10-27-claudian复制会话标题与route回执标题补全]]
