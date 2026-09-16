---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - claudian
  - context-window
---

# 背景与问题

已发送过消息、但当前窗口未发送的 Claude 会话在水合时直接恢复 metadata 中的旧 `usage`；若该值是本地 fallback（示例为 `model: sonnet, contextWindow: 200000`，且无 `contextWindowIsAuthoritative`），水合链未按当前 `modelPresets.contextWindow` 重算，故 gauge 继续显示 200k。

证据链：

- `/Users/vincentwang/Documents/NoteVault/.claudian/sessions/conv-1784725185735-qqojxd6cd.meta.json`：`providerId=claude`，metadata 不存 messages，`usage.model=sonnet`、`usage.contextWindow=200000`、无权威标记；`providerState` 也无模型字段。
- 对应 transcript `/Users/vincentwang/.claude/projects/-Users-vincentwang-Documents-NoteVault/b769c46c-0f52-4217-9b37-2e15b605cc55.jsonl` 共 33203 行，尾部主代理 assistant 的 `message.model=glm-5.3`，最后响应时间与 metadata 一致。因此示例不是“从未发送的新会话”，而是“有历史、当前窗口未发送的旧会话”；meta 的 `messages: 0` 仅是 B1 后索引语义。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts:1055-1064` 水合后直接执行 `state.usage = conversation.usage ?? null`。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ui/InputToolbar.ts:1128-1155` gauge 原样读取 `usage.percentage/contextWindow`。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ClaudianView.ts:93-112` 和 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts:848-856` 虽已接入 `getContextWindowSize(model, customContextLimits)`，但只覆盖设置刷新/模型切换，不覆盖会话水合。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/settings.ts:252-275,335-337` 已把 `modelPresets.contextWindow` 投影到 `customContextLimits`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/types/models.ts:83-101,205-222` 已实现大小写归一、`[1m]` 与自定义窗口 fallback。问题不是 preset 未接入或本例 alias 不匹配，而是水合入口未调用现成 fallback 链。

# 方案设计

## 方案比较

1. **推荐：复用持久化 `usage.model`，在所有“已有 usage 进入 UI”入口统一重算。** 改动小；`usage.model` 正是生成该 token 快照时记录的模型，且示例值 `sonnet` 可直接命中配置页投影的 1M。无需读 transcript、无需扩 providerState。
2. 在 `ClaudeProviderState` 新增 `lastModel`。语义重复于 `usage.model`，还需迁移、写回与多段 session 裁决，不适合小修复。
3. 水合时扫描 transcript tail。可取到真实执行模型，但示例得到 `glm-5.3`，而配置 preset 键是用户选择 alias `sonnet`；二者没有可靠反向映射，且超大 transcript 已有独立分页/索引约束。反而不能稳定解决配置窗口匹配。

## 推荐改动

1. 在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/utils/usageInfo.ts` 增加一个薄的“按 provider 配置刷新 usage”公共函数（或等价集中逻辑）：
   - 候选模型优先 `usage.model`；缺失时才用调用方提供的当前/草稿模型。
   - 先调用现有 `uiConfig.normalizeModelVariant(candidate, settings)`，再调用现有 `uiConfig.getContextWindowSize(normalizedModel, customContextLimits)`；不新建 alias 解析规则。
   - 最终仍交给 `recalculateUsageForModel`：同模型且 `contextWindowIsAuthoritative=true` 时保留 runtime 窗口；否则采用配置 fallback 并重算百分比。
2. 在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts` 的 `hydrateTab()` 中，`loadActive()` 恢复 state 后、READY/首屏完成前调用该公共函数。这样旧会话无需首次 send/session_init 即修正分母。
3. `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ClaudianView.ts` 的设置刷新改复用同一函数，避免当前全局模型覆盖历史 usage 模型；配置页修改 contextWindow 后，所有已开 tab 立即按各自 `usage.model` 更新。
4. `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts` 的显式模型切换仍把“新选择模型”作为强制候选，保持现有切换语义与刷新链。
5. 不改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/stream/transformClaudeMessage.ts`：A0b 的 session_init/result 权威解析及快照不受影响。

模型来源优先序：runtime 权威窗口（同模型） > 已持久化 `usage.model` 对应 preset 窗口 > 当前 tab/provider 模型对应 preset 窗口 > 200k。真正从未发送的新 tab 没有 usage，meter 本就隐藏；首次发送由既有 turn model snapshot/session_init 链建立 usage。

## 解析链简化（用户裁决 2026-09-16）

1. **解析链简化**：`getContextWindowSize`（`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/types/models.ts`）删除 `[1m]` 后缀规则与 fable 族硬编码规则。二者系 modelPresets 之前 enableSonnet1M 时代的历史机制，是与配置页并存的第二真相源，可能与用户配置冲突——例：用户配 sonnet=200k 而 runtime 回报 `sonnet[1m]` 时，后缀规则强行给 1M。简化后链：**配置页该模型 contextWindow → 200k**；整体优先序不变：同模型 runtime 权威窗口 > `usage.model` 对应 preset > 当前/草稿模型 preset > 200k。
2. **选填语义明确**：preset 的 `contextWindow` 维持选填；**不填 → 200k**（不再走代码兜底链）。可选 UI 优化：设置页该字段空值时 placeholder 显示 `200000`（标注为可选项）。
3. **行为变化点（需记录）**：归一后（normalizeModelId）匹配不到任何 preset 的模型串，原 `[1m]`/fable 规则会给 1M，简化后统一落 200k——"没配就按保守值"的配置优先语义，用户已知情接受。
4. **前置检查项**：出厂默认 preset（`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/settings.ts` 的 `DEFAULT_CLAUDE_MODEL_PRESETS`）各条的 contextWindow 值需在实施时复核——删规则后开箱显示不得回退（haiku/sonnet/opus/fable 四条默认值逐条列出核对）。

# 风险与权衡

- `usage.model` 缺失的老 metadata 只能回退当前 provider 模型，无法无损还原历史选择；这是兼容性降级，不引入 transcript 扫描。
- transcript 的 concrete/proxy 模型（示例 `glm-5.3`）与用户 preset alias 不一定可逆，故禁止以 tail model 覆盖已有 `usage.model`。
- 设置刷新若改为优先历史 `usage.model`，会修正当前“所有 tab 被全局模型重标”的隐式行为；显式模型切换仍保持新模型优先。

# 验证方式

红测先行：

1. `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/utils/usageInfo.test.ts`：非权威 `sonnet/200k` + preset 投影 `sonnet=1M` → `1M/45%`；大小写与 `sonnet`↔`sonnet[1m]` 沿用现有 normalization；权威同模型不覆盖；显式切换模型丢弃旧权威。
2. `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/TabManager.test.ts`（若现有水合夹具更适合则放对应 hydration 测试）：SHELL 老会话水合后、未发送消息即重算；`usage.model` 缺失回退当前模型；无 usage 的全新会话仍隐藏 gauge。
3. 补 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/ClaudianView.test.ts`：修改 preset window 后，历史 tab 按自身 usage.model 刷新，不被当前全局模型改名；权威窗口保留。
4. 保持 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/stream/transformSDKMessage.test.ts` A0b 快照全绿；补一次模型切换回归，确认 Tab 显式新模型仍覆盖 fallback。
5. 解析链简化相关（见"解析链简化（用户裁决 2026-09-16）"节）：配置 200k + 回报 `sonnet[1m]` → 显示 200k（配置覆盖 alias 后缀）；无匹配 preset 的串 → 200k；出厂默认 preset 开箱值不回退。

执行：`npm run test -- --selectProjects unit --runInBand`，再跑 `npm run typecheck && npm run lint && npm run build`。人工打开示例会话，发送前 tooltip 应由 `450k / 200k` 变为 `450k / 1000k`（约 45%）；新空白 tab 仍不显示 meter。

# 关联

- [[2026-09-16-空载会话-context-window-fallback]]
