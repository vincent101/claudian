---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian/
tags:
  - architect
  - claudian
  - model-selection
---

# Claudian：Fable 档与模型档位可配置化

## 背景与问题

Claudian 当前把 Claude 模型下拉拆成“内置三档 + 1M 开关 + 自定义模型文本 + 环境变量模型替换”四套规则；需求是在不侵入 B4/双轨统一/B3 的前提下加入 Fable，并收敛为可在设置页维护的单一档位模型。

### 现状结论

1. **列表与映射**
   - `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/types/models.ts` 的 `DEFAULT_CLAUDE_MODELS` 写死 `haiku / sonnet / sonnet[1m] / opus / opus[1m]`。
   - `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/modelOptions.ts` 负责最终列表：只要 Claudian 自己的运行时环境文本里出现模型环境变量，`getModelsFromEnvironment()` 就会**整体替换**默认列表；否则显示默认列表并追加 `customModels` 的逐行 model id。
   - `enableSonnet1M / enableOpus1M` 不是“额外显示”，而是在普通档和 `[1m]` 档之间二选一。
   - `customModels` 已有设置 UI，但语义仅是“每行一个 model id”；label 自动生成、无档位映射、无逐项 context window，不能满足核心诉求。

2. **下发链路**
   - 下拉项的 `value` 就是传给 SDK 的 model 字符串。
   - 冷启动由 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeQueryOptionsBuilder.ts` 和 `claudeColdStartQuery.ts` 写入 `Options.model`。
   - 持久 query 切换由 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeDynamicUpdates.ts` 调 `Query.setModel(selectedModel)`；SDK 类型明确接受任意 `string`，控制请求原样发送 `{ subtype: "set_model", model }`。

3. **Fable 与环境变量实证**
   - 当前 Claudian 依赖 `@anthropic-ai/claude-agent-sdk 0.2.112`。它的 `Options.model` / `Query.setModel()` 均为字符串；SDK 自己不限定三档。
   - 该 SDK 包内捆绑的旧 `cli.js` 尚未实现 Fable alias，也没有 `ANTHROPIC_DEFAULT_FABLE_MODEL`；但 Claudian 明确通过 `pathToClaudeCodeExecutable` 启动外部 Claude Code，而不是依赖捆绑 CLI 的模型表。
   - 当前配置的外部 Claude Code `2.1.227` 的 `--help` 明确接受 `fable` alias；原生二进制包含 `ANTHROPIC_DEFAULT_FABLE_MODEL` 与 `claude-fable-5`。
   - 实测 `claude -p --model fable` 成功；Agent SDK `query({ model: 'fable', pathToClaudeCodeExecutable: ... })` 也成功。当前用户设置把 Fable 映射到 `claude-opus[1m]`，SDK `system/init.model` 与最终 `modelUsage` 均报告 `claude-opus[1m]`，证明 alias 由外部 CLI 解析。
   - `~/.claude/settings.json` 的 `env` **不是** Claudian 的 `environmentVariables`；前者由 Claude Code settings loader 读取。Claudian 传 `settingSources: ['user','project','local']` 时生效，`loadUserSettings=false` 时 user source 被排除，Fable 不再使用用户级映射。SDK spawn 的 `env` 只负责继承进程环境和 Claudian 环境文本；无需、也不应由 Claudian 读取并复制 home settings 的 `env`。

4. **Usage/context window**
   - 流中先用 `getContextWindowSize(intendedModel)` 估算；默认非 `[1m]` 均按 200K。result 到达后，`selectContextWindowEntry()` 从 `modelUsage` 修正为权威值。
   - 单一 `modelUsage` entry 无条件采用；多 entry 时按 literal、normalize、family 匹配。family 目前只有 haiku/sonnet/opus。
   - Fable alias 经用户 env 映射后，实测 key 是解析后的 `claude-opus[1m]`，不是 `fable`。多模型结果中，拿 intended `fable` 无法匹配该 key，会静默保留估算分母。
   - 匹配失败不会报错：result 不发 `context_window`，meter 保留此前估算。若没有档位覆盖，当前通用 fallback 为 200K；这对 Fable 1M 会高估占用率。

## 方案设计

### 1. 方案对比

#### Fable 下发

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A. alias 直传 | 档位 `model: "fable"`，冷启动和 `setModel` 原样传递 | 复用 Claude Code 原生语义；自动遵循用户/项目/本地 settings；映射变化无需改 Claudian | 依赖所选外部 CLI 支持 Fable；`loadUserSettings=false` 时不读取用户映射 |
| B. Claudian 自行解析 | 读取 `~/.claude/settings.json.env.ANTHROPIC_DEFAULT_FABLE_MODEL`，转成具体 id 再下发 | Claudian 表面上掌握最终 id | 重复 Claude Code 的 settings 合并、优先级和未来演进；绕过 `settingSources`；产生两套真相源；跨平台 home/managed settings 易错 |

**推荐 A。** Claudian 是 Claude Code/Agent SDK 适配器，应传 alias 而非重写 provider 解析。设置页允许用户把 Fable 档的 `model` 改为具体 id，作为明确、可见的人工覆盖；不自动读取 home JSON。

#### 档位配置

| 方案 | 做法 | 评价 |
|---|---|---|
| A. 保留三套旧配置并加 Fable 开关 | 扩充 `DEFAULT_CLAUDE_MODELS`、`customModels`、1M 开关 | 改动小，但用户仍不能编辑 label/映射/context，且规则继续分裂 |
| B. 统一 `modelPresets[]` | 一项同时定义 label、下发 model、可选 contextWindow | 单一用户模型；新增档位只改配置；可迁移旧字段 |
| C. 动态读取 CLI 全部模型 | 运行时探测 catalog | 当前 CLI 没有稳定、结构化的“列出全部可选 alias + 自定义 label/context”契约，仍需本地配置 |

**推荐 B，环境发现仅作兼容追加，不再替换整张列表。**

### 2. 数据模型与迁移

在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/settings.ts` 定义：

```ts
interface ClaudeModelPreset {
  label: string;
  model: string;
  contextWindow?: number;
}
```

`ClaudeProviderSettings` 新增 `modelPresets: ClaudeModelPreset[]`。新安装默认：

```text
Haiku  -> haiku
Sonnet -> sonnet
Opus   -> opus
Fable  -> fable, contextWindow=1000000
```

约束：
- `label`、`model` trim 后非空；`model` 大小写敏感地唯一，避免 selector value 冲突；
- `contextWindow` 缺省表示未知/交给既有规则和 result 权威值，填写时必须为正整数；
- 至少保留一项；数组顺序即下拉顺序；
- label 仅展示，model 是存储选择值与 SDK 下发值，不引入第二套 selector id。

在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/settings/ClaudianSettingsStorage.ts` 做一次确定性迁移：

1. 已有 `modelPresets`：规范化、去空、拒绝重复；不再读取旧字段参与运行。
2. 缺失 `modelPresets`：以旧 `enableSonnet1M / enableOpus1M` 状态生成 Haiku、Sonnet/`sonnet[1m]`、Opus/`opus[1m]`，追加 Fable，再把 `customModels` 每行迁成 `{ label: formatCustomModelLabel(id), model: id }`；去重并保持顺序。
3. 将旧 `customContextLimits[model]` 导入对应 preset 的 `contextWindow`。
4. 保存时不再写 `customModels / enableSonnet1M / enableOpus1M`；旧字段只作为一次性迁移输入。默认配置同步改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/defaultProviderConfigs.ts` 的来源对象。

`customContextLimits` 暂保留为 provider-neutral兼容字段，但 Claude preset 是 Claude 模型分母覆盖的唯一可编辑真相源。保存 preset 时生成 Claude model→window 的兼容投影，供现有 `ClaudianView / Tab / transform` 调用读取；Claude 设置页不再为这些 preset 重复渲染旧“自定义上下文限制”控件。环境动态发现、其他 provider 的 context limit 仍保留原通道。此做法避免修改 `ProviderChatUIConfig`、`ClaudianView`、`Tab`，从而避开 B3 主改动面。

### 3. 列表合成与设置 UI

修改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/modelOptions.ts`：

1. 以规范化后的 `modelPresets` 为主列表。
2. Claudian 环境文本中的 `ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_HAIKU_MODEL`、`...SONNET...`、`...OPUS...`、新增 `...FABLE...` 解析成**兼容追加项**，按 model 去重；不再因任一 env 值存在而替换全部 presets。
3. `resolveClaudeModelSelection` 继续按 model 值校验；删除档位或修改当前档位的 model 时，设置页显式把当前选择迁移到该行的新 model；无法对应时才回退首项。

修改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/ui/ClaudeSettingsTab.ts`：

- 用可排序的 preset 行编辑器替换两个 1M toggle 和 `customModels` textarea；每行含 Label、Model、Context window（可空）、删除；提供“新增档位”“恢复默认四档”。
- 输入即时本地校验，blur/Enter 原子提交整张数组；有空值、重复 model、非法窗口时不保存、不刷新 selector，并显示行级错误。
- 成功提交后统一执行：迁移当前 model/标题 model → 写设置 → `saveSettings()` → `refreshModelSelectors()`；模型值变化不需要重启 persistent query，下一次动态更新走既有 `setModel`。
- i18n 修改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/types.ts` 与 10 个 locale JSON；至少补齐 editor、add/reset/remove、验证错误。非中文可先用准确英文，不留缺 key。

修改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/env/claudeModelEnv.ts` 和 `ClaudeSettingsReconciler.ts`：

- 补 `ANTHROPIC_DEFAULT_FABLE_MODEL`，包括发现、描述优先级、hash 与会话失效判定；
- 这里只识别 Claudian 注入的环境文本。`~/.claude/settings.json` 仍由 CLI 按 `settingSources` 读取，不冒充 Claudian 可见配置。

### 4. Fable reasoning 与 usage 适配

修改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/types/models.ts`：

- `fable` 加入默认 preset、adaptive thinking、`xhigh/max` 能力与默认 effort；family/parser 正则支持 `fable` 和 `claude-fable-*`。
- `getContextWindowSize('fable')` 默认 1M；preset `contextWindow` 优先于该默认；最终仍以 SDK result 为权威。
- 不给 Fable 发送 legacy fixed thinking budget。当前 SDK/CLI 的 Fable 语义要求 adaptive/always-on thinking，误判为 custom model 会走 `setMaxThinkingTokens`，必须用红测锁死。

修改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/stream/transformClaudeMessage.ts`：

- 扩展现有 `TransformUsageState`，在 `system/init` 捕获 SDK 已解析的 `message.model`；result 多 entry 匹配优先使用该 resolved model，其次才用 intended preset model。
- 这不是写死 `fable -> 某模型`：用户把 Fable 映射到任何具体 id，CLI init 都会返回实际模型，`modelUsage` 可按 literal/normalize 命中。
- 匹配优先级：resolved literal → resolved normalized → intended literal/normalized → built-in family signature → 无匹配不更新。只有唯一 entry 时沿用直接采用。
- 未收到 init 或匹配失败：流中使用 preset contextWindow；preset 也未提供时使用 family 默认（Fable 1M，其余保持现状）。不得在多 entry 歧义时猜最大窗口。

### 5. 关键改动文件

生产文件：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/settings.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/types/models.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/modelOptions.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/modelLabels.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/env/claudeModelEnv.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/env/ClaudeSettingsReconciler.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/ui/ClaudeSettingsTab.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/stream/transformClaudeMessage.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/settings/ClaudianSettingsStorage.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/types.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/locales/*.json`

既有通用 selector、`ClaudeDynamicUpdates.ts`、`ClaudeQueryOptionsBuilder.ts` 不改；它们已经接受字符串并正确下发。

### 6. 并行实施边界

当前 B4/双轨统一/B3 方案主要修改 history、`ClaudeChatRuntime.ts`、`ConversationController`、`Tab/TabManager`、rendering/state。本文方案刻意不改这些文件；resolved model 放入既有 `TransformUsageState`，context 配置通过兼容投影进入现有参数，避免为此改 `ClaudeChatRuntime.ts`、`ClaudianView.ts`、`Tab.ts`。

已核对 B4 整合设计没有要求修改 `transformClaudeMessage.ts`；它只在背景说明中引用该文件。两条工作线可分别建 worktree 并行。建议本需求拆为两个连续提交：

1. preset/settings/UI/env/migration；
2. Fable reasoning + usage resolved-model 适配。

若 B4 实施期间实际新增对 `transformClaudeMessage.ts` 或 settings migration 的修改，以 B4 先合并，本需求第二提交 rebase 后跑 usage 全套测试；不要在同一提交手工夹带冲突解决。

## 风险与权衡

1. **外部 CLI 版本**：只验证了 Claude Code 2.1.227。所选 CLI 若不认识 Fable，`setModel('fable')` 会失败；Claudian 应保留现有显式错误，不静默改回 Opus。可在后续增加 CLI capability probe，但不应为本需求复制模型目录。
2. **`loadUserSettings` 语义**：关闭后，用户级 `ANTHROPIC_DEFAULT_FABLE_MODEL` 必然不生效，这是现有开关的正确含义。设置说明需明确；不能暗中读取 home settings 绕过开关。
3. **环境模型兼容变化**：现状是 env 模型一出现就替换整表；推荐改为追加，避免 Fable/default preset 消失，但属于可见行为变化，需迁移测试。
4. **contextWindow 双阶段**：流中只能使用配置/默认估算，result 才有权威值；多模型且缺 init 时仍可能无法修正。此时保持当前分母并记录测试，不猜测。
5. **配置标识**：以 `model` 作为 selector identity，避免引入 preset id 与 runtime model 两套状态；代价是改 model 值等同删除旧项并新增新项，UI 必须显式迁移当前选择。
6. **Fable API 特性边界**：本需求只负责 Claude Code 模型选择和 usage 分母，不在 Claudian 自行实现 Messages API 的 Fable refusal fallback、retention 或 thinking 协议；这些由外部 Claude Code/Agent SDK 承担。

### 需用户拍板

无阻塞项。推荐默认采用：Fable 档传 `fable` alias；`loadUserSettings` 决定是否应用 `~/.claude/settings.json`；四档均可改名、改 model、删除，提供一键恢复默认。

## 验证方式

### 红测清单

1. 默认配置精确产生 Haiku/Sonnet/Opus/Fable，Fable 下发值为 `fable`、默认分母 1M。
2. `modelPresets` 增删、排序、改 label/model/context；重复 model、空 label/model、非正整数 context 拒绝保存。
3. 旧设置组合迁移：普通/1M toggle、空/多行/重复 `customModels`、已有 custom context、当前/标题/last model；迁移幂等。
4. Claudian 环境模型与 presets 合并而非替换；新增 Fable env key 被发现、去重并计入 env hash。
5. `loadUserSettings=true/false` 分别产生包含/不包含 `user` 的 `settingSources`；不新增读取 `~/.claude/settings.json` 的 Claudian 代码。
6. 冷启动 `Options.model === 'fable'`；persistent query 切换调用 `setModel('fable')`，不预解析成具体 id。
7. Fable 走 adaptive effort，不调用 legacy fixed-token thinking；支持 `xhigh/max`。
8. `system/init.model='claude-opus[1m]'` + intended `fable` + 多 entry `modelUsage` 时选择 `claude-opus[1m]` 的 1M；直接 `claude-fable-5`、唯一 entry、无 init、歧义多 entry 均覆盖。
9. result 匹配失败时不发错误 context_window；meter 保留 preset/family fallback，不出现 NaN、0 分母或错误选择 subagent 窗口。
10. 删除/修改当前 preset 后，主模型、标题模型、lastModel 一致迁移；selector 刷新后无幽灵值。
11. 现有 haiku/sonnet/opus、1M、custom model、provider 切换测试全绿。

### 命令

```bash
cd /Users/vincentwang/Documents/NoteVault/tools/claudian
npm run typecheck
npm run lint
npm run test -- --selectProjects unit
npm run test -- --selectProjects integration
npm run build
```

外部契约验收使用临时目录，分别验证 CLI 与 SDK：

```bash
claude -p --model fable --output-format json "Reply with exactly OK"
```

SDK probe 必须断言：`system/init.model` 与 `result.modelUsage` 的主模型 key 等于用户 `ANTHROPIC_DEFAULT_FABLE_MODEL` 的解析结果；关闭 user setting source 后不作此断言，只验证调用显式失败或按 CLI 自身默认解析，禁止 Claudian 偷读 home settings。

### 验收标准

- 用户无需改代码即可在 Claude 设置页增删档位、修改 label/model/context window；默认看见四档。
- 选择 Fable 后冷启动和热切换均把 `fable` 原样交给外部 Claude Code。
- `loadUserSettings=true` 时用户级 Fable 映射生效；false 时严格隔离。
- usage 在实测映射 `fable -> claude-opus[1m]` 下最终显示 1M，且多模型结果不误取 subagent。
- 生产改动不触及 B4/双轨统一/B3 的 history/rendering/state/Tab 主改文件，两条线可独立测试、提交和合并。

## 关联

- [[2026-09-15-claudian-B4双轨统一与DOM窗口化整合实施方案]]
- [[2026-09-15-claudian超大会话修复全景回归审查]]
