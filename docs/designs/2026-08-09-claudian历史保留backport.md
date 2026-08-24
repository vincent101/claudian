---
type: design-decision
status: draft
target: .obsidian/plugins/claudian/main.js
tags:
  - architect
  - obsidian-plugin
  - claudian
  - backport
modified: 2026-08-09 12:57:50
created: 2026-08-09 02:09:44
---

# Backport 上游 #981 替代方案：切 model/环境变量不丢 Claude 会话历史（2.0.11）

## 背景与问题

2.0.11 上，Claude provider 的环境变量哈希（`ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` / 三个 tier 模型变量）一旦变化，`claudeSettingsReconciler.reconcileModelWithEnvironment` 会把每个会话的 `conv.sessionId = null`，**且不保留任何可恢复的 sessionId 副本** → 会话历史（resume 链接）不可逆丢失。上游 #981（2.0.42）修复。本方案评估"在 2.0.11 自己实现"的可行性，给出分层选项与推荐。

**结论先行**：不做完整 backport；**推荐方案 A（sessionId 备份，约 6 行）**，它能以极小代价恢复"历史可回放"这一核心价值。方案 C（磁盘恢复）**不可行**（2.0.11 不写上游恢复逻辑所依赖的文件格式）。

## 先回答关键事实核查（coordinator Q4）

**"无 env 配置用户首次加载会不会被误伤置 null？"——不会。** 已逐行验证：

- `computeEnvHash("")`：`parseEnvironmentVariables("")` 得 `{}` → `ENV_HASH_*` 各键 `filter(key => envVars[key])` 全被滤掉 → `.map().sort().join("|")` = **`""`**（`main.js:552-567`、`57981-57985`）
- 保存的 `environmentHash` 默认值 = **`""`**（`main.js:25160`、25813 的 `DEFAULT_CLAUDE_PROVIDER_SETTINGS`）
- 于是 `currentHash("") === savedHash("")` → 提前 `return { changed: false }`，**不进入置 null 循环**（`57991-57993`）
- 加载时那次调用（`92894`）同样走此逻辑，空配用户 `"" === ""` 安全

**真正的风险窗口**：**已配置** `ANTHROPIC_BASE_URL`（或模型 env 变量）→ 保存了非空 hash → 之后**改动**它 → `currentHash ≠ savedHash` → 置 null。用户当前 `data.json` 无 env 配置，所以是**潜伏风险而非现状**；一旦将来在插件里配/改这些变量即触发。

## #981 完整 backport 工作量评估（为什么不推荐）

#981 上游 diff 触及 3 个运行时文件 + 4 个测试文件。运行时要 backport 的部分：

| 上游文件 | 改动 | 2.0.11 对应 | 复杂度 |
|---|---|---|---|
| `providerState.ts` | 新增 `getClaudeConversationSessionIds`、重写 `clearClaudeResumeState`（保留 previousProviderSessionIds、resumeAt） | `main.js:58044` `getClaudeState` 附近（2.0.11 **无** `clearClaudeResumeState`，置 null 逻辑内联在 reconciler 里） | 中——需新建函数并改调用点 |
| `ClaudeConversationHistoryService.ts` | `getConversationSessionIds` 改用新helper；hydrate 加 legacy 恢复分支 | `main.js:59576` `hydrateConversationHistory` | 中 |
| `ClaudeHistoryStore.ts` | 新增 `parseLegacyConversationSessionId` + `readLegacyConversationSessionId`（读 `.claude/sessions/<id>.jsonl` 首行 meta） | **无对应**（2.0.11 不写该 jsonl） | 高且**无意义**（见方案 C） |

**前置依赖**：#981 假设存在 `clearClaudeResumeState` 这个抽象（2.0.11 没有，置 null 逻辑直接内联在 reconciler），且其恢复逻辑依赖"Claude Code CLI 写的 `.claude/sessions/<convId>.jsonl`"这一磁盘格式（2.0.11 的对话落盘格式不同）。因此完整 backport ≈ 半天到一天，且其中约 40%（磁盘恢复）在 2.0.11 上**根本不产生效果**。**不推荐。**

## 分层替代方案

### 方案 A（推荐）：置 null 前备份 sessionId 到 previousProviderSessionIds

**核心洞察（已验证）**：2.0.11 的数据流**已经就位**，只差 reconcile 那一行没备份——

- `toSessionMetadata`（`26937`）**本就持久化 `providerState`** 到 `.claudian/sessions/<id>.meta.json`
- 加载路径（`92892`）`providerState: meta3.providerState` **本就恢复**它
- `hydrateConversationHistory`（`59584`）**本就遍历 `previousProviderSessionIds`** 重放历史
- 且 2.0.11 的 Claude reconcile **只清 `sessionId`，不清 `providerState`**（已确认：reconcile 体内无 `providerState`/`resumeAt` 赋值）——所以备份进 `providerState.previousProviderSessionIds` **不会被连带清掉**

**能保住什么**：会话转录文本本就存在 Claude 的 SDK session 文件里没丢；丢的只是"会话 → sessionId"的链接。备份后，重新打开该会话时 `hydrateConversationHistory` 能读到旧 sessionId → **完整重放历史**。

**保不住什么**：**原地 resume**（`sessionId` 已 null，继续对话会开新 SDK session）。这正是上游 #981 也没完全保住的（它同样 `sessionId = null`，只是保留了 transcript 引用）——所以方案 A 与上游的实际效果**等价**。

**改动**：1 处，约 6 行。

### 方案 B（最小防御）：env 变化时弹 Notice 警告

改动最小（reconcile 检测到 `invalidatedConversations.length > 0` 时 `new Notice(...)`），但**不解决丢历史**，只让你知情。可作为方案 A 的附加，不单独推荐。

### 方案 C（磁盘恢复）：**不可行**

上游 `readLegacyConversationSessionId` 解析的是 `.claude/sessions/<convId>.jsonl` 的**首行 `type:'meta'` 记录**。已验证 2.0.11 **不写这种文件**——2.0.11 写的是 `<id>.meta.json`（`getMetadataPath`，`26868`），全文 grep 无任何 `type:'meta'` 的 jsonl 写入。没有数据源，恢复逻辑无的放矢。**排除。**

### 方案 D（A+C 组合）

C 不可行，组合无意义。方案 A 单独即达 #981 在 2.0.11 上能达成的实际效果。

## 推荐：方案 A — patch 清单

**目标文件**：`/Users/vincentwang/Documents/NoteVault/.obsidian/plugins/claudian/main.js`（仅此一个，不动 styles.css）

**Patch 0（备份）**：新建 `main.js.bak-before-preserve-history-patch`，不覆盖现有 5 个 bak。

**Patch 1（唯一改动）**：位置 `main.js:57994-58001`（`claudeSettingsReconciler.reconcileModelWithEnvironment` 的置 null 循环）。

锚点（全文命中 **1** 次，已验证；注意勿与 Codex reconciler 混淆——Codex 版在 `66718`，含 `getCodexState`/`providerId === "codex"`，结构不同）：

old:
```js
    const invalidatedConversations = [];
    for (const conv of conversations) {
      if (conv.sessionId) {
        conv.sessionId = null;
        invalidatedConversations.push(conv);
      }
    }
```
new:
```js
    const invalidatedConversations = [];
    for (const conv of conversations) {
      if (conv.sessionId) {
        const state = getClaudeState(conv.providerState);
        const preserved = [.../* @__PURE__ */ new Set([...state.previousProviderSessionIds || [], state.providerSessionId, conv.sessionId].filter((id) => !!id))];
        conv.providerState = { ...state, previousProviderSessionIds: preserved };
        conv.sessionId = null;
        invalidatedConversations.push(conv);
      }
    }
```

说明：
- `getClaudeState`（`main.js:58044`）是 `function` 声明，会被提升（hoist），在 57997 处可直接调用，无顺序问题
- 把 `state.providerSessionId` 与 `conv.sessionId` 一并去重收进 `previousProviderSessionIds`，对齐上游 `getClaudeConversationSessionIds` 的语义
- 保留其余 `providerState` 字段（`...state`），不动 `resumeAtMessageId`（2.0.11 本就不清它）

**代码形态已过 `node --check`**（见下验证）。

## 风险与权衡

1. **改 bundle 失败 = 插件加载失败**：先备份 + `node --check`。
2. **升级即失效**：与既有 patch 相同；上游 2.0.42+ 已含 #981，届时直接升级即可（其完整实现比本 patch 更全，含 resumeAt 保留的边界处理）。
3. **本 patch 只保"历史可回放"，不保"原地 resume"**——与上游 #981 在 2.0.11 能达成的效果一致，符合预期。
4. **未实机验证**：备份后 `hydrateConversationHistory` 重放行为基于代码路径推断（`59584` 遍历 `previousProviderSessionIds`），需实机确认。
5. 与现有 5 个 patch 区域不重叠（本 patch 在 57994，其余在 55733 / 78045+ / 80245 / 85247+ / 90089+ / styles.css）。

## 验证方式

**静态**：
```bash
cd /Users/vincentwang/Documents/NoteVault/.obsidian/plugins/claudian/
node --check main.js && echo OK
grep -c "preserved" main.js                      # 预期 1
grep -c "previousProviderSessionIds" main.js     # 应比 patch 前多 1
# 确认没误碰 Codex reconciler
python3 -c "s=open('main.js').read(); print('Codex reconcile intact:', 'getCodexState(conv.providerState)' in s)"
```

**实机**（需先构造触发条件）：
1. 准备：在插件设置里给 Claude 配 `ANTHROPIC_BASE_URL`（任意值），重启使 `environmentHash` 落库为非空
2. 开一个 Claude 会话，发几轮消息（产生 SDK session），记住会话标题
3. **改动** `ANTHROPIC_BASE_URL` 的值，触发 reconcile → 该会话 `sessionId` 被置 null
4. 重开该会话 → **预期**：历史消息完整回放（`hydrateConversationHistory` 经 `previousProviderSessionIds` 找到旧 session 文件）
5. 对比：无 patch 时第 4 步历史为空/从头开始

**回滚**：
```bash
cp main.js.bak-before-preserve-history-patch main.js  # 然后重启 Obsidian
```

## 关联

- 升级价值评估：[[2026-08-09-claudian升级价值评估]]
- Other 修复 backport：[[2026-08-09-claudian-other输入修复backport]]
- attention 方案：[[2026-08-06-claudian标题栏等待回答状态颜色方案]]
- 上游 commit： https://github.com/YishenTu/claudian/commit/b96e4c69ae
