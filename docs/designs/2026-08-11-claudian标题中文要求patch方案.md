---
type: design-decision
status: confirmed
target: .obsidian/plugins/claudian/main.js
tags:
  - architect
  - obsidian-plugin
  - claudian
  - title-generation
---

# Claudian 标题生成加入中文要求 patch 方案

## 背景与问题

Claudian 会话标题由 LLM 按固定 system prompt 生成，当前 prompt 全英文、输出要求未约束语言，实际生成的标题基本是英文。用户笔记仓库（中文环境）里历史会话标题清一色英文，检索和扫读不友好。目标：让标题主要逻辑用中文写，同时保留英文专有名词（模型名、库名、路径、API 等）不被强行翻译。

提示词结构（实测 main.js L57832-57855）：

- `TITLE_GENERATION_SYSTEM_PROMPT`（L57835-57846，`var` 模板字符串）——system prompt，含角色定义、5 条规则、输出要求。**被两条 provider 路径共用**：Claude 路径 `TitleGenerationService.generateTitle`（L57879，`systemPrompt: TITLE_GENERATION_SYSTEM_PROMPT` @ L57896）、Codex 路径 `QueryBackedTitleGenerationService.generateTitle`（L66535，同变量 @ L66550）。改这一处变量即覆盖全部路径。
- user prompt 模板两套：Claude 路径内联模板（L57887-57892，`Conversation excerpt: ...`）；Codex 路径 `buildTitleGenerationPrompt`（L57847-57854，`User's request: ...`）。两者都只是素材容器，不含语言约束。
- 长度约束 `MAX_TITLE_LENGTH = 50`（L57834）、`MAX_TITLE_INPUT_LENGTH = 500`（L57833）；`parseTitleGenerationResponse`（L57856）/`parseTitle`（L57935）超 50 按 `slice(0, 47) + "..."` 截断。
- v3 patch 引入的"现标题增量判断"逻辑在 `regenerateTitle`（L77530）构造的 `material` 里（L77563-77570，含 `Return it unchanged if it still accurately summarizes...`），是 user prompt 素材，不进 system prompt。

## 方案设计

### 改动点：仅改 system prompt

只改 `TITLE_GENERATION_SYSTEM_PROMPT`（L57835-57846）。理由：

1. 语言约束是输出要求，归 system prompt 职责；user prompt 只是素材容器。
2. 该变量被两条 provider 路径共用，改一处全覆盖，无需同步改两份模板。
3. v3 的"现标题增量判断"是 user prompt 素材层逻辑（判定要不要改写），与"改写时用什么语言"是正交两件事，不冲突。

### 改动位置：Rules 列表新增第 6 条

加在现有 5 条规则之后、`**Output**` 之前（L57844 之后、L57846 之前）。作为独立一条约束，不嵌入现有规则的措辞里，避免与"Tech Context"等条目语义纠缠。

### 措辞（精确中英文）

中文要求本身就是约束 AI 输出语言，用英文表述给 LLM 最稳（prompt 全英文环境，嵌入中文指令反而可能让模型混淆输出语言）。措辞：

```
6.  **Language**: Write the title primarily in Chinese (简体中文). Keep proper nouns (model names, library names, APIs, file paths, command names) in their original English/ASCII form. Example: "调试 Python 脚本错误" not "Debug Python script".
```

这条同时给了一个英→中的对照示例，锚定"专有名词保留原文"的边界，防止模型把 `Python` 翻成"蟒蛇"或保留整句英文。

### 与现有约束的协调

- **弱动词禁令（Rule 4）**：不冲突。中文标题同样要求"具体动作"而非"继续/处理"这类弱动词，中文表达如"实现/修复/调试/分析"对应英文的 Create/Fix/Debug/Analyze。
- **Tech Context（Rule 5）**：不冲突。Rule 5 要求检测语言/框架并写入标题，Rule 6 要求主体用中文——两者叠加效果是 `调试 Python 脚本错误` 而非 `Debug Python script`，正是期望形态。
- **长度限制（MAX_TITLE_LENGTH=50）**：中文标题 50 码元（JS `slice` 按 UTF-16 码元，CJK 在 BMP 单码元）足够宽裕，50 个汉字远超语义需求。`parseTitle` 的 `slice(0, 47)+"..."` 截断不会切坏中文（不会产生半截组合字符，CJK 无代理对问题）。
- **Sentence case / no periods（Rule 1）**：中文标题本身不用句号，不冲突；句首大写规则对中文无意义，对保留的英文专有名词仍自然成立。

### 精确改动（minified old/new）

`TITLE_GENERATION_SYSTEM_PROMPT` 是模板字符串字面量，改动是往里插一行。文件非 minified 片段（这一段 esbuild 保留了换行和缩进，因为是模板字符串内部内容），old/new 带足够上下文确保唯一：

**old_string**（L57844-57846，Rule 5 末尾 + Output 行）：

```
5.  **Tech Context**: Detect and include the primary language/framework if code is present (e.g., "Debug Python script", "Refactor React hook").

**Output**: Return ONLY the raw title text.`;
```

**new_string**（新增 Rule 6，紧接 Rule 5 之后、Output 之前）：

```
5.  **Tech Context**: Detect and include the primary language/framework if code is present (e.g., "Debug Python script", "Refactor React hook").
6.  **Language**: Write the title primarily in Chinese (简体中文). Keep proper nouns (model names, library names, APIs, file paths, command names) in their original English/ASCII form. Example: "调试 Python 脚本错误" not "Debug Python script".

**Output**: Return ONLY the raw title text.`;
```

改动量：1 处字符串字面量内插入 1 行，无变量/逻辑改动，不影响 minified 结构。

## 风险与权衡

### 1. 现标题增量判断的交互

v3 的 `regenerateTitle` 在 `material` 里告诉模型"现标题仍准确就原样返回"。改 system prompt 后，已有英文标题的会话在 10 条 hook 触发时，模型可能因为"现标题仍准确"而原样返回英文标题，不主动改写成中文。这是**期望行为**——增量判断本就为避免频繁重写；中文要求只约束"要生成/改写时用什么语言"，不强制把仍准确的英文标题翻成中文。若用户希望强制刷成中文，需在 `material` 里加一句"若现标题为英文且仍准确，仍请改写为中文"——这会破坏 v3 增量判断的省刷初衷，**不推荐**，列为下方决策分叉。

### 2. minified 改动风险

该字面量是 `var ... = \`...\`;` 结构，esbuild 未对模板字符串内部做转义/压缩（模板字符串内换行、缩进原样保留）。插入一行纯文本，不改任何 `\``、`${`、`\\` 转义结构，无语法风险。改动后建议 `node -c main.js` 或 Obsidian 重载确认无 parse 错误。

### 3. 英文专有名词边界模糊

"专有名词保留原文"靠模型判断，模型可能把非专有名词也保留英文（如把"调试"写成"debug"）。示例对照（`调试 Python 脚本错误` not `Debug Python script`）已锚定期望形态，但不能保证 100% 准确。可接受——标题语义可读即可，不追求纯净。

### 4. Fallback 标题不受影响

`generateFallbackTitle`（L77523，AI 失败时取首句前 50 字符）不走 LLM，不受 system prompt 影响，仍会是用户原文片段（可能中英混杂）。AI 成功路径覆盖绝大多数情况，fallback 罕见，不处理。

## 需用户决策的分叉

### 分叉 A：中文要求的强度

- **A1（推荐）**：弱约束——仅加 Rule 6 一条，模型自主判断何时用中文。若用户用纯英文提问，标题可能仍是英文。优点：不破坏多语言适应性。
- **A2**：强约束——Rule 6 措辞改为"Always write in Chinese unless the conversation is entirely in English"。优点：中文仓库标题一致性高；缺点：纯英文技术讨论会话也会被强翻中文标题，可能违和。

推荐 A1。用户笔记仓库以中文为主，弱约束在中文提问场景下自然产出中文标题；纯英文技术会话保留英文标题也合理。

### 分叉 B：是否对已有英文标题会话强制刷中文

见风险 1。推荐**不强制**（保留 v3 增量判断初衷）。若要强制，改的是 `regenerateTitle` 的 `material` 文案（L77564），不是 system prompt。

## 验证方式

### 1. 语法验证

改完后 Obsidian 重载 Claudian 插件（设置 → 社区插件 → 关闭再开启 Claudian，或重启 Obsidian），无控制台报错即 parse 通过。

### 2. 新会话标题验证

开新会话，用中文提问（如"帮我看看这段 Python 代码哪里有 bug"），发首条消息后观察自动生成的标题——应为中文（如"调试 Python 代码 bug"），而非英文 "Debug Python Code"。

### 3. v3 hook 路径验证

用一个已有英文标题、user 消息数刚过 10 的倍数的会话，再发一条触发 `userCount % 10 === 0` hook（@L80319）。观察日志（若有）或标题是否变化：

- 若现标题仍准确 → 英文标题保留（增量判断生效，期望行为）。
- 若会话已跑题、标题需改写 → 新标题应为中文。

### 4. 专有名词保留验证

用含专有名词的提问（如"Refactor the React hook in utils/useAuth.ts"）测新会话标题，确认 `React`、`useAuth.ts` 保留原文，动作词用中文（如"重构 React hook useAuth.ts"）。

### 5. 长度截断验证

极端长标题场景下，`parseTitle` 的 50 码元截断不会切坏中文——目测即可，CJK 在 BMP 单码元，`slice(0, 47)` 截断点不会落在组合字符中间。

## 关联

- [[2026-08-09-claudian标题按最近内容生成]] —— v3 patch 方案（confirmed），本方案在其基础上追加语言约束，不改 v3 触发/素材/增量判断逻辑。
- [[2026-08-11-claudian每10条标题regen-hook-this绑定修复]] —— v3 hook 的 this 绑定修复，与本方案无冲突。
