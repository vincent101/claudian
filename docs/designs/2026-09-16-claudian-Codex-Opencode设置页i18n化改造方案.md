---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - i18n
  - claudian
---

# 背景与问题

当前 `hotfix/notify-lease`（`99ae9fbf`，已包含 `31bdc1f1`）中，Codex/OpenCode 设置页大量用户可见文案直接写在 TypeScript 中，切换 locale 时不会变化；目标是在不改业务逻辑、CSS 和 Claude 已迁移键的前提下，将设置页文案纳入现有 `t()` 与 10-locale 体系。

> frontmatter 使用仓库设计记录规范允许的 `draft`；用户要求的 `proposed` 语义等同于未确认草案，但不是现行合法状态值。

# 方案设计

## 1. 盘点口径与结果

口径：统计用户可见的标题、名称、描述、选项标签、占位符、ARIA、校验提示、Notice、确认框；运行时生成的用户数据不算。文件路径、命令、模型 ID、环境变量、JSON 示例及协议枚举值属于技术字面量，保留原文。下表“约”是按源码当前行号统计的用户可见英文 literal 出现数；同一文案多次出现分别计数，迁移时允许复用同一 key。

| 文件（绝对路径） | 大致行 | 待迁移 | 保留/排除 |
|---|---:|---:|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/ui/CodexSettingsTab.ts` | 47-432 | 约 31 | 路径/模型/环境变量示例、`workspace-write`/`read-only` 值、Codex/CLI/MCP/WSL/TOML 保留 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/ui/CodexSkillSettings.ts` | 46-266 | 约 26；另有 4 条来自 `validateCommandName()` 的透传错误 | `$name`、目录值、`SKILL.md` 保留 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/ui/CodexSubagentSettings.ts` | 10-390 | 约 51 | 模型 ID、agent 名称、存储错误详情 `{message}` 保留但外围文案翻译 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/ui/CodexChatUIConfig.ts` | 18-39 | 约 10 | **不迁移**：聊天面板的推理/权限/服务档位，不是设置页 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/ui/OpencodeSettingsTab.ts` | 42-554 | 约 41 | CLI 路径、模型 ID/供应商名、目录、环境变量示例、`×` 保留 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/ui/OpencodeAgentSettings.ts` | 11-567 | 约 75 | JSON 示例、模型 ID、用户输入值、底层错误详情保留 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/ui/OpencodeChatUIConfig.ts` | 25-135 | 约 12 | **不迁移**：聊天模型选择器/权限/推理文案 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/settings/ui/EnvironmentSettingsSection.ts` | 53 | 1 | provider 设置页会显示，纳入 shared key |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/settings/ClaudianSettings.ts` | 110-156, 480-503 | 0 | provider 名是注册表专名；隐藏命令文案由 provider renderer 注入 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/settings/ui/EnvSnippetManager.ts` | 全文 | 0 | 已使用 `t()`；技术占位符保留 |
| 其余 `features/settings/ui/` | 全文 | 0 | MCP 通用页面或非 Codex/OpenCode 专属，不在本任务范围 |

### 逐文件字符串清单

- `CodexSettingsTab.ts`：启用 provider（2）；Windows 安装方式及两个选项（4）；三种 CLI 描述、带主机名标题、WSL 路径校验（5）；WSL distro 名称/描述（2）；摘要四选项（4）；自定义模型（2）；推理摘要（2）；Skills 标题/说明、隐藏项名称/说明（4）；Subagents 标题/说明（2）；MCP 前后句和链接（3）；环境名称/说明（2）。
- `CodexSkillSettings.ts`：新增/编辑标题（2）；目录、技能名、描述、指令四组名称/说明（8）；指令占位符（1）；必填、保存失败（2）；取消/保存（2，复用 common）；列表标题、刷新、添加、空态、badge（5）；编辑、删除（2，复用 common）；删除成功/失败、创建/更新（4）。`validateCommandName()` 还会透出必填/过长/字符集/YAML 保留字 4 种英文错误，必须一并截断，不能因调用点没有 literal 而漏掉。
- `CodexSubagentSettings.ts`：推理强度 5 个标签、沙箱 4 个标签；名称/昵称校验 5 条；弹窗双标题；名称、描述及占位符；高级选项；模型、推理强度、沙箱、昵称；开发者指令及占位符；必填/重复/保存错误；取消/保存；列表标题、刷新/添加、空态、编辑/删除；删除确认与 CRUD Notice。
- `OpencodeSettingsTab.ts`：Setup/Models/Environment 三个现有通用键；启用项（2）；CLI 标题/说明/两条校验（4）；可见模型名称/说明（2）；浏览、搜索；可见数量摘要（单/复数）、可用数/未发现、已选数量；清空及 ARIA；不可用说明；别名 ARIA/title；移除 ARIA；全部供应商；空目录/过滤无结果；Unavailable badge/title；命令与技能标题/说明/隐藏项名称与说明；子代理标题/说明；环境名称/说明。
- `OpencodeAgentSettings.ts`：名称校验 6 条；弹窗双标题；名称、描述及占位符；高级字段名称/说明（Model、Variant、Temperature、Top P、Color、Steps、隐藏、禁用、Tools、Permission、Options）；Prompt 名称/说明/占位符；取消/保存；描述/Prompt 必填、重复、保存错误；列表标题、刷新/添加、空态、badge、编辑/删除、确认及 CRUD Notice；数值/整数/JSON/对象/布尔映射校验。技术示例占位符保持原样。
- `EnvironmentSettingsSection.ts`：`Review environment ownership for: {keys}`。

## 2. 键命名与结构

### 2.1 原则

1. 继续使用 `settings.*`，provider 根节点分别为 `settings.codex`、`settings.opencode`；可复用组件下设 `skills`、`subagents`、`models`、`environment`、`validation`、`modal`。
2. 跨 provider 且语义完全相同的按钮只复用 `common.save/cancel/add/edit/delete/refresh/clearAll`；provider 语义或句子不同则不强行共键。
3. `settings.subagents.*` 保留给 Claude 现有实现，禁止把 Codex/OpenCode 的差异硬塞进去。
4. 动态内容统一 `{name}`、`{message}`、`{count}`、`{hostname}`、`{label}`、`{keys}`。不拼接可翻译句段。
5. `src/i18n/types.ts` 显式加入全部 key；不改为无类型字符串索引。

### 2.2 新增键全表

下表即 en / zh-CN / zh-TW 的完整首版文案。路径、命令、专名保持原文。

#### 共享

| Key | en | zh-CN | zh-TW |
|---|---|---|---|
| `settings.environmentReview` | Review environment ownership for: {keys} | 请检查以下环境变量的归属：{keys} | 請檢查以下環境變數的歸屬：{keys} |

#### Codex 设置主体

| Key | en | zh-CN | zh-TW |
|---|---|---|---|
| `settings.codex.enable.name` | Enable Codex provider | 启用 Codex 提供商 | 啟用 Codex 提供商 |
| `settings.codex.enable.desc` | When enabled, Codex models appear in the model selector for new conversations. Existing Codex sessions are preserved. | 启用后，Codex 模型会出现在新对话的模型选择器中。现有 Codex 会话将保留。 | 啟用後，Codex 模型會出現在新對話的模型選擇器中。現有 Codex 工作階段將保留。 |
| `settings.codex.installation.name` | Installation method | 安装方式 | 安裝方式 |
| `settings.codex.installation.desc` | How Claudian should launch Codex on Windows. Native Windows uses a Windows executable path. WSL launches the Linux CLI inside a selected distro. | Claudian 在 Windows 上启动 Codex 的方式。原生 Windows 使用 Windows 可执行文件路径；WSL 在所选发行版中启动 Linux CLI。 | Claudian 在 Windows 上啟動 Codex 的方式。原生 Windows 使用 Windows 可執行檔路徑；WSL 在所選發行版中啟動 Linux CLI。 |
| `settings.codex.installation.nativeWindows` | Native Windows | 原生 Windows | 原生 Windows |
| `settings.codex.installation.wsl` | WSL | WSL | WSL |
| `settings.codex.cliPath.name` | Codex CLI path ({hostname}) | Codex CLI 路径（{hostname}） | Codex CLI 路徑（{hostname}） |
| `settings.codex.cliPath.descUnix` | Custom path to the local Codex CLI. Leave empty for auto-detection from PATH. | 本地 Codex CLI 的自定义路径。留空则从 PATH 自动检测。 | 本機 Codex CLI 的自訂路徑。留空則從 PATH 自動偵測。 |
| `settings.codex.cliPath.descWsl` | Linux-side Codex command or absolute path to run inside WSL. Leave empty for PATH lookup inside the selected distro. | 在 WSL 内运行的 Linux 侧 Codex 命令或绝对路径。留空则在所选发行版的 PATH 中查找。 | 在 WSL 內執行的 Linux 端 Codex 命令或絕對路徑。留空則在所選發行版的 PATH 中查找。 |
| `settings.codex.cliPath.descWindows` | Custom path to the local Codex CLI. Leave empty for auto-detection from PATH. Use the native Windows executable path, usually `codex.exe`. | 本地 Codex CLI 的自定义路径。留空则从 PATH 自动检测。请使用原生 Windows 可执行文件路径，通常为 `codex.exe`。 | 本機 Codex CLI 的自訂路徑。留空則從 PATH 自動偵測。請使用原生 Windows 可執行檔路徑，通常為 `codex.exe`。 |
| `settings.codex.cliPath.validation.wslWindowsPath` | WSL mode expects a Linux command or Linux absolute path, not a Windows executable path. | WSL 模式需要 Linux 命令或 Linux 绝对路径，不能使用 Windows 可执行文件路径。 | WSL 模式需要 Linux 命令或 Linux 絕對路徑，不能使用 Windows 可執行檔路徑。 |
| `settings.codex.wslDistro.name` | WSL distro override | 覆盖 WSL 发行版 | 覆寫 WSL 發行版 |
| `settings.codex.wslDistro.desc` | Optional advanced override. Leave empty to infer the distro from a `\\wsl$` workspace path when possible; otherwise use the default WSL distro. | 可选的高级覆盖项。留空时尽可能从 `\\wsl$` 工作区路径推断发行版，否则使用默认 WSL 发行版。 | 可選的進階覆寫項。留空時盡可能從 `\\wsl$` 工作區路徑推斷發行版，否則使用預設 WSL 發行版。 |
| `settings.codex.summary.auto` | Auto | 自动 | 自動 |
| `settings.codex.summary.concise` | Concise | 简洁 | 簡潔 |
| `settings.codex.summary.detailed` | Detailed | 详细 | 詳細 |
| `settings.codex.summary.off` | Off | 关闭 | 關閉 |
| `settings.codex.customModels.name` | Custom models | 自定义模型 | 自訂模型 |
| `settings.codex.customModels.desc` | Append additional Codex model IDs to the picker, one per line. OPENAI_MODEL still takes precedence when set. | 向选择器添加其他 Codex 模型 ID，每行一个。设置 OPENAI_MODEL 后仍以其为准。 | 向選擇器新增其他 Codex 模型 ID，每行一個。設定 OPENAI_MODEL 後仍以其為準。 |
| `settings.codex.reasoningSummary.name` | Reasoning summary | 推理摘要 | 推理摘要 |
| `settings.codex.reasoningSummary.desc` | Show a summary of the model's reasoning process in the thinking block. | 在思考区块中显示模型推理过程的摘要。 | 在思考區塊中顯示模型推理過程的摘要。 |
| `settings.codex.skills.name` | Codex Skills | Codex 技能 | Codex 技能 |
| `settings.codex.skills.desc` | Manage vault-level Codex skills stored in .codex/skills/ or .agents/skills/. Home-level skills are excluded here. | 管理存储在 .codex/skills/ 或 .agents/skills/ 中的 Vault 级 Codex 技能。此处不包含用户主目录级技能。 | 管理儲存在 .codex/skills/ 或 .agents/skills/ 中的 Vault 級 Codex 技能。此處不包含使用者主目錄級技能。 |
| `settings.codex.skills.hiddenName` | Hidden Skills | 隐藏技能 | 隱藏技能 |
| `settings.codex.skills.hiddenDesc` | Hide specific Codex skills from the dropdown. Enter skill names without the leading $, one per line. | 从下拉菜单中隐藏特定 Codex 技能。每行输入一个技能名称，无需前导 `$`。 | 從下拉選單中隱藏特定 Codex 技能。每行輸入一個技能名稱，無需前導 `$`。 |
| `settings.codex.subagents.name` | Codex Subagents | Codex 子代理 | Codex 子代理 |
| `settings.codex.subagents.desc` | Manage vault-level Codex subagents stored in .codex/agents/. Each TOML file defines one custom agent. | 管理存储在 .codex/agents/ 中的 Vault 级 Codex 子代理。每个 TOML 文件定义一个自定义代理。 | 管理儲存在 .codex/agents/ 中的 Vault 級 Codex 子代理。每個 TOML 檔案定義一個自訂代理。 |
| `settings.codex.mcp.beforeCommand` | Codex manages MCP servers via its own CLI. Configure with | Codex 通过自身 CLI 管理 MCP 服务器。请使用以下命令配置： | Codex 透過自身 CLI 管理 MCP 伺服器。請使用以下命令設定： |
| `settings.codex.mcp.afterCommand` | and they will be available in Claudian. | 配置后即可在 Claudian 中使用。 | 設定後即可在 Claudian 中使用。 |
| `settings.codex.mcp.learnMore` | Learn more | 了解更多 | 瞭解更多 |
| `settings.codex.environment.name` | Codex environment | Codex 环境变量 | Codex 環境變數 |
| `settings.codex.environment.desc` | Codex-owned runtime variables only. Use this for OPENAI_* and CODEX_* settings. If Codex auto-detection needs help, add its install directory to shared PATH instead of this provider section. | 仅填写 Codex 自有的运行时变量，例如 OPENAI_* 和 CODEX_*。若 Codex 自动检测需要帮助，请将其安装目录添加到共享 PATH，而不是此提供商区域。 | 僅填寫 Codex 自有的執行階段變數，例如 OPENAI_* 和 CODEX_*。若 Codex 自動偵測需要協助，請將其安裝目錄加入共用 PATH，而非此提供商區域。 |

#### Codex 技能弹窗与列表

| Key | en | zh-CN | zh-TW |
|---|---|---|---|
| `settings.codex.skills.modal.titleEdit` | Edit Codex Skill | 编辑 Codex 技能 | 編輯 Codex 技能 |
| `settings.codex.skills.modal.titleAdd` | Add Codex Skill | 添加 Codex 技能 | 新增 Codex 技能 |
| `settings.codex.skills.modal.directory` | Directory | 目录 | 目錄 |
| `settings.codex.skills.modal.directoryDesc` | Where to store the skill | 技能的存储位置 | 技能的儲存位置 |
| `settings.codex.skills.modal.name` | Skill name | 技能名称 | 技能名稱 |
| `settings.codex.skills.modal.nameDesc` | The name used after $ (e.g., "analyze" for $analyze) | `$` 后使用的名称（例如 $analyze 对应“analyze”） | `$` 後使用的名稱（例如 $analyze 對應「analyze」） |
| `settings.codex.skills.modal.description` | Description | 描述 | 描述 |
| `settings.codex.skills.modal.descriptionDesc` | Optional description shown in the dropdown | 显示在下拉菜单中的可选描述 | 顯示在下拉選單中的可選描述 |
| `settings.codex.skills.modal.instructions` | Instructions | 指令 | 指示 |
| `settings.codex.skills.modal.instructionsDesc` | The skill instructions (SKILL.md content) | 技能指令（SKILL.md 内容） | 技能指示（SKILL.md 內容） |
| `settings.codex.skills.modal.instructionsPlaceholder` | Analyze the code for... | 分析代码中的…… | 分析程式碼中的…… |
| `settings.codex.skills.validation.nameRequired` | Skill name is required | 技能名称为必填项 | 技能名稱為必填 |
| `settings.codex.skills.validation.nameTooLong` | Skill name must be {max} characters or fewer | 技能名称不能超过 {max} 个字符 | 技能名稱不得超過 {max} 個字元 |
| `settings.codex.skills.validation.nameInvalid` | Skill name can only contain lowercase letters, numbers, and hyphens | 技能名称只能包含小写字母、数字和连字符 | 技能名稱只能包含小寫字母、數字與連字號 |
| `settings.codex.skills.validation.nameReserved` | Skill name cannot be a YAML reserved word (true, false, null, yes, no, on, off) | 技能名称不能是 YAML 保留字（true、false、null、yes、no、on、off） | 技能名稱不能是 YAML 保留字（true、false、null、yes、no、on、off） |
| `settings.codex.skills.validation.instructionsRequired` | Instructions are required | 指令为必填项 | 指示為必填 |
| `settings.codex.skills.saveFailed` | Failed to save Codex skill | 保存 Codex 技能失败 | 儲存 Codex 技能失敗 |
| `settings.codex.skills.noSkills` | No Codex skills in vault. Click + to create one. | Vault 中没有 Codex 技能。点击 + 创建一个。 | Vault 中沒有 Codex 技能。點擊 + 建立一個。 |
| `settings.codex.skills.badge` | skill | 技能 | 技能 |
| `settings.codex.skills.deleted` | Codex skill "${name}" deleted | 已删除 Codex 技能“${name}” | 已刪除 Codex 技能「${name}」 |
| `settings.codex.skills.deleteFailed` | Failed to delete Codex skill | 删除 Codex 技能失败 | 刪除 Codex 技能失敗 |
| `settings.codex.skills.updated` | Codex skill "${name}" updated | 已更新 Codex 技能“${name}” | 已更新 Codex 技能「${name}」 |
| `settings.codex.skills.created` | Codex skill "${name}" created | 已创建 Codex 技能“${name}” | 已建立 Codex 技能「${name}」 |

> 上表 key 值实际写入 JSON 时使用 `{name}`，表中 `${name}` 仅为避免 Markdown 与原模板字符串混淆；实现不得保留 `$`。

#### Codex 子代理

| Key | en | zh-CN | zh-TW |
|---|---|---|---|
| `settings.codex.subagents.options.inherit` | Inherit | 继承 | 繼承 |
| `settings.codex.subagents.options.low` | Low | 低 | 低 |
| `settings.codex.subagents.options.medium` | Medium | 中 | 中 |
| `settings.codex.subagents.options.high` | High | 高 | 高 |
| `settings.codex.subagents.options.extraHigh` | Extra High | 超高 | 超高 |
| `settings.codex.subagents.options.readOnly` | Read-only | 只读 | 唯讀 |
| `settings.codex.subagents.options.dangerFullAccess` | Danger full access | 完全访问（危险） | 完整存取（危險） |
| `settings.codex.subagents.options.workspaceWrite` | Workspace write | 工作区可写 | 工作區可寫 |
| `settings.codex.subagents.modal.titleEdit` | Edit Codex Subagent | 编辑 Codex 子代理 | 編輯 Codex 子代理 |
| `settings.codex.subagents.modal.titleAdd` | Add Codex Subagent | 添加 Codex 子代理 | 新增 Codex 子代理 |
| `settings.codex.subagents.modal.name` | Name | 名称 | 名稱 |
| `settings.codex.subagents.modal.nameDesc` | Agent name Codex uses when spawning (lowercase, hyphens, underscores) | Codex 启动代理时使用的名称（小写字母、连字符、下划线） | Codex 啟動代理時使用的名稱（小寫字母、連字號、底線） |
| `settings.codex.subagents.modal.description` | Description | 描述 | 描述 |
| `settings.codex.subagents.modal.descriptionDesc` | When Codex should use this agent | Codex 应在何时使用此代理 | Codex 應在何時使用此代理 |
| `settings.codex.subagents.modal.descriptionPlaceholder` | Reviews code for correctness and security | 审查代码的正确性与安全性 | 檢查程式碼的正確性與安全性 |
| `settings.codex.subagents.modal.advancedOptions` | Advanced options | 高级选项 | 進階選項 |
| `settings.codex.subagents.modal.model` | Model | 模型 | 模型 |
| `settings.codex.subagents.modal.modelDesc` | Model override (leave empty to inherit) | 覆盖模型（留空则继承） | 覆寫模型（留空則繼承） |
| `settings.codex.subagents.modal.reasoningEffort` | Reasoning effort | 推理强度 | 推理強度 |
| `settings.codex.subagents.modal.reasoningEffortDesc` | Model reasoning effort level | 模型推理强度级别 | 模型推理強度等級 |
| `settings.codex.subagents.modal.sandboxMode` | Sandbox mode | 沙箱模式 | 沙箱模式 |
| `settings.codex.subagents.modal.sandboxModeDesc` | Sandbox restriction for this agent | 此代理的沙箱限制 | 此代理的沙箱限制 |
| `settings.codex.subagents.modal.nicknames` | Nickname candidates | 候选昵称 | 候選暱稱 |
| `settings.codex.subagents.modal.nicknamesDesc` | Comma-separated display nicknames (e.g., Atlas, Delta, Echo) | 用逗号分隔的显示昵称（例如 Atlas、Delta、Echo） | 以逗號分隔的顯示暱稱（例如 Atlas、Delta、Echo） |
| `settings.codex.subagents.modal.instructions` | Developer instructions | 开发者指令 | 開發者指示 |
| `settings.codex.subagents.modal.instructionsDesc` | Core instructions that define the agent's behavior | 定义代理行为的核心指令 | 定義代理行為的核心指示 |
| `settings.codex.subagents.modal.instructionsPlaceholder` | Review code like an owner.\nPrioritize correctness, security, and missing test coverage. | 以代码负责人的标准审查代码。\n优先检查正确性、安全性和缺失的测试覆盖。 | 以程式碼負責人的標準檢查程式碼。\n優先檢查正確性、安全性與缺少的測試覆蓋。 |
| `settings.codex.subagents.validation.nameRequired` | Subagent name is required | 子代理名称为必填项 | 子代理名稱為必填 |
| `settings.codex.subagents.validation.nameTooLong` | Subagent name must be {max} characters or fewer | 子代理名称不能超过 {max} 个字符 | 子代理名稱不得超過 {max} 個字元 |
| `settings.codex.subagents.validation.nameInvalid` | Subagent name can only contain lowercase letters, numbers, hyphens, and underscores | 子代理名称只能包含小写字母、数字、连字符和下划线 | 子代理名稱只能包含小寫字母、數字、連字號與底線 |
| `settings.codex.subagents.validation.nicknameInvalid` | Nickname candidates can only contain ASCII letters, numbers, spaces, hyphens, and underscores | 候选昵称只能包含 ASCII 字母、数字、空格、连字符和下划线 | 候選暱稱只能包含 ASCII 字母、數字、空格、連字號與底線 |
| `settings.codex.subagents.validation.nicknameDuplicate` | Nickname candidates must be unique | 候选昵称不能重复 | 候選暱稱不得重複 |
| `settings.codex.subagents.validation.descriptionRequired` | Description is required | 描述为必填项 | 描述為必填 |
| `settings.codex.subagents.validation.instructionsRequired` | Developer instructions are required | 开发者指令为必填项 | 開發者指示為必填 |
| `settings.codex.subagents.validation.duplicateName` | A subagent named "{name}" already exists | 名为“{name}”的子代理已存在 | 已存在名為「{name}」的子代理 |
| `settings.codex.subagents.saveFailed` | Failed to save subagent: {message} | 保存子代理失败：{message} | 儲存子代理失敗：{message} |
| `settings.codex.subagents.noAgents` | No Codex subagents in vault. Click + to create one. | Vault 中没有 Codex 子代理。点击 + 创建一个。 | Vault 中沒有 Codex 子代理。點擊 + 建立一個。 |
| `settings.codex.subagents.deleteConfirm` | Delete subagent "{name}"? | 删除子代理“{name}”？ | 刪除子代理「{name}」？ |
| `settings.codex.subagents.deleted` | Subagent "{name}" deleted | 已删除子代理“{name}” | 已刪除子代理「{name}」 |
| `settings.codex.subagents.deleteFailed` | Failed to delete subagent | 删除子代理失败 | 刪除子代理失敗 |
| `settings.codex.subagents.updated` | Subagent "{name}" updated | 已更新子代理“{name}” | 已更新子代理「{name}」 |
| `settings.codex.subagents.created` | Subagent "{name}" created | 已创建子代理“{name}” | 已建立子代理「{name}」 |
| `common.unknownError` | Unknown error | 未知错误 | 未知錯誤 |

#### OpenCode 设置主体

| Key | en | zh-CN | zh-TW |
|---|---|---|---|
| `settings.opencode.enable.name` | Enable OpenCode | 启用 OpenCode | 啟用 OpenCode |
| `settings.opencode.enable.desc` | Launch `opencode acp` as a provider. | 以提供商方式启动 `opencode acp`。 | 以提供商方式啟動 `opencode acp`。 |
| `settings.opencode.cliPath.name` | CLI path ({hostname}) | CLI 路径（{hostname}） | CLI 路徑（{hostname}） |
| `settings.opencode.cliPath.desc` | Optional absolute path to the OpenCode CLI for this computer. Leave empty to use `opencode` from PATH. | 此计算机上 OpenCode CLI 的可选绝对路径。留空则使用 PATH 中的 `opencode`。 | 此電腦上 OpenCode CLI 的可選絕對路徑。留空則使用 PATH 中的 `opencode`。 |
| `settings.opencode.cliPath.validation.notExist` | Path does not exist | 路径不存在 | 路徑不存在 |
| `settings.opencode.cliPath.validation.notFile` | Path must point to a file | 路径必须指向文件 | 路徑必須指向檔案 |
| `settings.opencode.models.visibleName` | Visible models | 可见模型 | 可見模型 |
| `settings.opencode.models.visibleDesc` | Choose which OpenCode models appear in the chat selector. Filter by provider or type to search. The current session model stays pinned even if it is not selected here. | 选择聊天选择器中显示的 OpenCode 模型。可按提供商筛选或输入文字搜索。即使当前会话模型未在此选中，也会保持固定显示。 | 選擇聊天選擇器中顯示的 OpenCode 模型。可按提供商篩選或輸入文字搜尋。即使目前工作階段模型未在此選取，也會保持固定顯示。 |
| `settings.opencode.models.browse` | Browse models | 浏览模型 | 瀏覽模型 |
| `settings.opencode.models.filterPlaceholder` | Filter by model, provider, or id… | 按模型、提供商或 ID 筛选…… | 按模型、提供商或 ID 篩選…… |
| `settings.opencode.models.summaryOneProvider` | Visible: {visible} of {discovered} discovered • {providerCount} provider | 可见：已发现 {discovered} 个，其中显示 {visible} 个 • {providerCount} 个提供商 | 可見：已發現 {discovered} 個，其中顯示 {visible} 個 • {providerCount} 個提供商 |
| `settings.opencode.models.summaryManyProviders` | Visible: {visible} of {discovered} discovered • {providerCount} providers | 可见：已发现 {discovered} 个，其中显示 {visible} 个 • {providerCount} 个提供商 | 可見：已發現 {discovered} 個，其中顯示 {visible} 個 • {providerCount} 個提供商 |
| `settings.opencode.models.available` | {count} available | {count} 个可用 | {count} 個可用 |
| `settings.opencode.models.noneDiscovered` | No models discovered yet | 尚未发现模型 | 尚未發現模型 |
| `settings.opencode.models.selected` | Selected ({count}) | 已选择（{count}） | 已選取（{count}） |
| `settings.opencode.models.clearAllAria` | Clear all selected models | 清除所有已选模型 | 清除所有已選模型 |
| `settings.opencode.models.notReported` | Not currently reported by OpenCode | OpenCode 当前未报告此模型 | OpenCode 目前未回報此模型 |
| `settings.opencode.models.aliasAria` | Alias for {label} | {label} 的别名 | {label} 的別名 |
| `settings.opencode.models.aliasTitle` | Custom label shown in the model selector. Leave empty to use the default. | 模型选择器中显示的自定义标签。留空使用默认标签。 | 模型選擇器中顯示的自訂標籤。留空使用預設標籤。 |
| `settings.opencode.models.removeAria` | Remove {label} | 移除 {label} | 移除 {label} |
| `settings.opencode.models.allProviders` | All providers ({count}) | 所有提供商（{count}） | 所有提供商（{count}） |
| `settings.opencode.models.startToDiscover` | Start OpenCode once to load its model catalog. Claudian will then let you pick visible models. | 启动一次 OpenCode 以加载其模型目录，之后即可在 Claudian 中选择可见模型。 | 啟動一次 OpenCode 以載入其模型目錄，之後即可在 Claudian 中選擇可見模型。 |
| `settings.opencode.models.noMatch` | No models match your filter. | 没有符合筛选条件的模型。 | 沒有符合篩選條件的模型。 |
| `settings.opencode.models.unavailable` | Unavailable | 不可用 | 不可用 |
| `settings.opencode.models.unavailableTitle` | Configured model not currently reported by OpenCode | 已配置的模型当前未由 OpenCode 报告 | 已設定的模型目前未由 OpenCode 回報 |
| `settings.opencode.commands.name` | Commands and Skills | 命令与技能 | 命令與技能 |
| `settings.opencode.commands.desc` | OpenCode can auto-detect vault-level Claude slash commands from .claude/commands/ and skills from .claude/skills/, .codex/skills/, and .agents/skills/. Manage those entries in the Claude or Codex settings tab. This setting only hides entries from the OpenCode dropdown. | OpenCode 可自动发现 .claude/commands/ 中的 Vault 级 Claude 斜杠命令，以及 .claude/skills/、.codex/skills/ 和 .agents/skills/ 中的技能。请在 Claude 或 Codex 设置页管理这些条目；此设置仅控制 OpenCode 下拉菜单中的隐藏项。 | OpenCode 可自動發現 .claude/commands/ 中的 Vault 級 Claude 斜線命令，以及 .claude/skills/、.codex/skills/ 與 .agents/skills/ 中的技能。請在 Claude 或 Codex 設定頁管理這些項目；此設定僅控制 OpenCode 下拉選單中的隱藏項。 |
| `settings.opencode.commands.hiddenName` | Hidden Commands and Skills | 隐藏命令与技能 | 隱藏命令與技能 |
| `settings.opencode.commands.hiddenDesc` | Hide specific OpenCode commands and skills from the dropdown. Enter names without the leading slash, one per line. | 从下拉菜单中隐藏特定 OpenCode 命令与技能。每行输入一个名称，无需前导斜杠。 | 從下拉選單中隱藏特定 OpenCode 命令與技能。每行輸入一個名稱，無需前導斜線。 |
| `settings.opencode.subagents.name` | Subagents | 子代理 | 子代理 |
| `settings.opencode.subagents.desc` | Manage vault-level OpenCode subagents from .opencode/agent/ and legacy .opencode/agents/. New entries are saved as subagent-only files and appear in the @mention menu. | 管理 .opencode/agent/ 和旧版 .opencode/agents/ 中的 Vault 级 OpenCode 子代理。新条目保存为仅限子代理的文件，并显示在 @提及 菜单中。 | 管理 .opencode/agent/ 與舊版 .opencode/agents/ 中的 Vault 級 OpenCode 子代理。新項目儲存為僅限子代理的檔案，並顯示在 @提及 選單中。 |
| `settings.opencode.environment.name` | Environment variables | 环境变量 | 環境變數 |
| `settings.opencode.environment.desc` | Extra environment variables passed to OpenCode. `OPENCODE_ENABLE_EXA=1` is enabled by default. | 传递给 OpenCode 的额外环境变量。默认启用 `OPENCODE_ENABLE_EXA=1`。 | 傳遞給 OpenCode 的額外環境變數。預設啟用 `OPENCODE_ENABLE_EXA=1`。 |

#### OpenCode 子代理

| Key | en | zh-CN | zh-TW |
|---|---|---|---|
| `settings.opencode.subagents.modal.titleEdit` | Edit OpenCode Subagent | 编辑 OpenCode 子代理 | 編輯 OpenCode 子代理 |
| `settings.opencode.subagents.modal.titleAdd` | Add OpenCode Subagent | 添加 OpenCode 子代理 | 新增 OpenCode 子代理 |
| `settings.opencode.subagents.modal.name` | Name | 名称 | 名稱 |
| `settings.opencode.subagents.modal.nameDesc` | OpenCode agent name. Use slash-separated segments for nested agents. | OpenCode 代理名称。嵌套代理使用斜杠分隔路径段。 | OpenCode 代理名稱。巢狀代理使用斜線分隔路徑區段。 |
| `settings.opencode.subagents.modal.description` | Description | 描述 | 描述 |
| `settings.opencode.subagents.modal.descriptionDesc` | When OpenCode should use this subagent | OpenCode 应在何时使用此子代理 | OpenCode 應在何時使用此子代理 |
| `settings.opencode.subagents.modal.descriptionPlaceholder` | Reviews code for correctness and maintainability | 审查代码的正确性与可维护性 | 檢查程式碼的正確性與可維護性 |
| `settings.opencode.subagents.modal.advancedOptions` | Advanced options | 高级选项 | 進階選項 |
| `settings.opencode.subagents.modal.model` | Model | 模型 | 模型 |
| `settings.opencode.subagents.modal.modelDesc` | Model override in provider/model format | 以 provider/model 格式覆盖模型 | 以 provider/model 格式覆寫模型 |
| `settings.opencode.subagents.modal.variant` | Variant | 变体 | 變體 |
| `settings.opencode.subagents.modal.variantDesc` | Model variant override | 覆盖模型变体 | 覆寫模型變體 |
| `settings.opencode.subagents.modal.temperature` | Temperature | Temperature | Temperature |
| `settings.opencode.subagents.modal.temperatureDesc` | Optional sampling temperature | 可选的采样温度 | 可選的取樣溫度 |
| `settings.opencode.subagents.modal.topP` | Top P | Top P | Top P |
| `settings.opencode.subagents.modal.topPDesc` | Optional nucleus sampling value | 可选的核采样值 | 可選的核心取樣值 |
| `settings.opencode.subagents.modal.color` | Color | 颜色 | 顏色 |
| `settings.opencode.subagents.modal.colorDesc` | Hex color or theme token | 十六进制颜色或主题令牌 | 十六進位色彩或主題權杖 |
| `settings.opencode.subagents.modal.steps` | Steps | 步数 | 步數 |
| `settings.opencode.subagents.modal.stepsDesc` | Maximum agentic iterations before forcing text-only output | 强制仅输出文本前允许的最大代理迭代次数 | 強制僅輸出文字前允許的最大代理迭代次數 |
| `settings.opencode.subagents.modal.hide` | Hide from @mention | 从 @提及 中隐藏 | 從 @提及 中隱藏 |
| `settings.opencode.subagents.modal.hideDesc` | Hide this subagent from the @ autocomplete menu | 从 @ 自动补全菜单中隐藏此子代理 | 從 @ 自動完成選單中隱藏此子代理 |
| `settings.opencode.subagents.modal.disable` | Disable agent | 禁用代理 | 停用代理 |
| `settings.opencode.subagents.modal.disableDesc` | Disable the agent without deleting the file | 禁用代理但不删除文件 | 停用代理但不刪除檔案 |
| `settings.opencode.subagents.modal.tools` | Enabled tools (JSON) | 已启用工具（JSON） | 已啟用工具（JSON） |
| `settings.opencode.subagents.modal.toolsDesc` | Optional deprecated tools map, e.g. {"write":false,"edit":false} | 可选的旧版工具映射，例如 {"write":false,"edit":false} | 可選的舊版工具映射，例如 {"write":false,"edit":false} |
| `settings.opencode.subagents.modal.permission` | Permission (JSON) | 权限（JSON） | 權限（JSON） |
| `settings.opencode.subagents.modal.permissionDesc` | Optional permission config, e.g. {"edit":"deny","bash":"allow"} | 可选的权限配置，例如 {"edit":"deny","bash":"allow"} | 可選的權限設定，例如 {"edit":"deny","bash":"allow"} |
| `settings.opencode.subagents.modal.options` | Options (JSON) | 选项（JSON） | 選項（JSON） |
| `settings.opencode.subagents.modal.optionsDesc` | Optional custom agent options | 可选的自定义代理选项 | 可選的自訂代理選項 |
| `settings.opencode.subagents.modal.prompt` | Prompt | 提示词 | 提示詞 |
| `settings.opencode.subagents.modal.promptDesc` | Markdown body used as the agent prompt | 用作代理提示词的 Markdown 正文 | 用作代理提示詞的 Markdown 正文 |
| `settings.opencode.subagents.modal.promptPlaceholder` | Review code changes carefully and call out correctness, regressions, and missing coverage. | 仔细审查代码变更，指出正确性问题、回归和缺失的测试覆盖。 | 仔細檢查程式碼變更，指出正確性問題、回歸與缺少的測試覆蓋。 |
| `settings.opencode.subagents.validation.nameRequired` | Agent name is required | 代理名称为必填项 | 代理名稱為必填 |
| `settings.opencode.subagents.validation.namePath` | Agent name must use slash-separated path segments without leading or trailing slashes | 代理名称必须使用斜杠分隔路径段，且不能以斜杠开头或结尾 | 代理名稱必須使用斜線分隔路徑區段，且不能以斜線開頭或結尾 |
| `settings.opencode.subagents.validation.segmentEmpty` | Agent name path segments cannot be empty or whitespace-only | 代理名称的路径段不能为空或仅含空白 | 代理名稱的路徑區段不得為空或僅含空白 |
| `settings.opencode.subagents.validation.segmentWhitespace` | Agent name path segments cannot start or end with whitespace | 代理名称的路径段不能以空白开头或结尾 | 代理名稱的路徑區段不能以空白開頭或結尾 |
| `settings.opencode.subagents.validation.dotSegment` | Agent name cannot include "." or ".." path segments | 代理名称不能包含“.”或“..”路径段 | 代理名稱不能包含「.」或「..」路徑區段 |
| `settings.opencode.subagents.validation.reservedCharacter` | Agent name path segments cannot contain Windows-reserved filename characters | 代理名称的路径段不能包含 Windows 保留的文件名字符 | 代理名稱的路徑區段不能包含 Windows 保留的檔名字元 |
| `settings.opencode.subagents.validation.descriptionRequired` | Description is required | 描述为必填项 | 描述為必填 |
| `settings.opencode.subagents.validation.promptRequired` | Prompt is required | 提示词为必填项 | 提示詞為必填 |
| `settings.opencode.subagents.validation.duplicateName` | A subagent named "{name}" already exists | 名为“{name}”的子代理已存在 | 已存在名為「{name}」的子代理 |
| `settings.opencode.subagents.validation.validNumber` | {field} must be a valid number | {field} 必须是有效数字 | {field} 必須是有效數字 |
| `settings.opencode.subagents.validation.positiveInteger` | {field} must be a positive integer | {field} 必须是正整数 | {field} 必須是正整數 |
| `settings.opencode.subagents.validation.validJson` | {field} must be valid JSON | {field} 必须是有效的 JSON | {field} 必須是有效的 JSON |
| `settings.opencode.subagents.validation.jsonObject` | {field} must be a JSON object | {field} 必须是 JSON 对象 | {field} 必須是 JSON 物件 |
| `settings.opencode.subagents.validation.booleanMap` | {field} must map tool names to boolean values | {field} 必须将工具名称映射为布尔值 | {field} 必須將工具名稱對應至布林值 |
| `settings.opencode.subagents.saveFailed` | Failed to save subagent: {message} | 保存子代理失败：{message} | 儲存子代理失敗：{message} |
| `settings.opencode.subagents.noAgents` | No OpenCode subagents in vault. Click + to create one. | Vault 中没有 OpenCode 子代理。点击 + 创建一个。 | Vault 中沒有 OpenCode 子代理。點擊 + 建立一個。 |
| `settings.opencode.subagents.badge` | subagent | 子代理 | 子代理 |
| `settings.opencode.subagents.deleteConfirm` | Delete subagent "{name}"? | 删除子代理“{name}”？ | 刪除子代理「{name}」？ |
| `settings.opencode.subagents.deleted` | Subagent "{name}" deleted | 已删除子代理“{name}” | 已刪除子代理「{name}」 |
| `settings.opencode.subagents.deleteFailed` | Failed to delete subagent | 删除子代理失败 | 刪除子代理失敗 |
| `settings.opencode.subagents.updated` | Subagent "{name}" updated | 已更新子代理“{name}” | 已更新子代理「{name}」 |
| `settings.opencode.subagents.created` | Subagent "{name}" created | 已创建子代理“{name}” | 已建立子代理「{name}」 |

## 3. 翻译与 locale 策略

涉及文件：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/types.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/locales/en.json`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/locales/zh-CN.json`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/locales/zh-TW.json`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/locales/{de,es,fr,ja,ko,pt,ru}.json`

首版：en、zh-CN、zh-TW 使用上表；其余 7 个 locale 复制英文值。`locales.test.ts` 的结构一致性会强制所有 locale 同步补键。

`localizedKeys` 有两种做法：

1. **推荐：不加入本批新增键。** 该数组并非全量 i18n 契约，只是“近期 bang-bash/subagent 已完成十语种本地化”的专项回归。首版明确允许 7 locale 英文，加入必然与策略冲突。
2. 将新增键加入 `localizedKeys`：必须同时完成 de/es/fr/ja/ko/pt/ru 的人工翻译和复核，工作量约增加 1.5-2 人日；不适合本次“7 locale 英文占位”目标。

可在该测试旁补注释，说明 `localizedKeys` 只放“承诺所有非英语 locale 均已本地化”的键，避免后续误加。

## 4. 迁移方式

### 4.1 常规替换

- `.setName/.setDesc/.setTitle/.setPlaceholder/.setText`、`text:`、`aria-label`、`title`、`Notice` 全部改为 `t('...')`。
- 保存/取消/增删改刷新/清空复用 `common.*`；标题 `Setup/Models/Environment/MCP Servers` 复用现有 `settings.*`。
- 技术示例（路径、模型 ID、JSON、环境变量）不建 key；专名 Codex、OpenCode、CLI、MCP、WSL、JSON、TOML 保留在译文内。
- 当前语言在设置页打开时已由 `ClaudianSettingTab.display()` 设置，因此 provider renderer 和其 modal 直接调用全局 `t()` 即可，不引入 locale 参数或新 context。

### 4.2 插值与复杂句

- 主机名： `` `Codex CLI path (${hostnameKey})` `` → `t('settings.codex.cliPath.name', { hostname: hostnameKey })`；OpenCode 同理。
- CRUD/确认/ARIA：统一 `{name}` 或 `{label}`，例如 `t('settings.codex.subagents.deleteConfirm', { name: agent.name })`。
- 错误详情：`t('...saveFailed', { message })`；`Unknown error` 改为 `t('common.unknownError')`，底层原始错误不翻译。
- OpenCode 模型摘要不能继续拼接 `provider/providers`。现有 i18n 无复数规则，使用 `summaryOneProvider` / `summaryManyProviders` 两键，代码仅保留数量分支。
- Codex MCP 说明因中间插入 `<code>codex mcp</code>`，保留三段 DOM，但前句、后句、链接分别走三个 key；不要合成 `innerHTML`。
- Codex skill 创建/更新的模板字符串拆为 `created` / `updated` 两键，不把局部动词插值进句子。
- OpenCode 校验 helpers 当前以英文 `label` 拼模板。应让 parser 返回稳定错误类别（`validNumber | positiveInteger | validJson | jsonObject | booleanMap`），调用点再用本地化 field label 和对应 key 格式化；解析判定不变。不要对英文错误文本做字符串映射。
- Codex `validateCommandName()` 同理：为 `/src/utils/frontmatter.ts` 增加保持旧 API 的结构化 issue 入口（或在 `/src/utils/slashCommand.ts` 暴露 issue），Codex UI 将 issue 映射至 `settings.codex.skills.validation.*`；原 `validateCommandName()` 继续供既有调用，避免影响 Claude。此处是唯一非机械替换，但不改变验证规则。
- `validateCodexSubagentName`、`validateCodexNicknameCandidates`、`validateOpencodeAgentName` 的公开测试目前断言英文。推荐保留纯验证函数并改为返回稳定 issue code，再由 UI 格式化；测试改断言 issue code，新增翻译层断言。若担心改公开签名，可新增 `get*ValidationIssue()`，旧函数作为兼容包装。

### 4.3 明确不做

- 不改业务状态、持久化格式、provider 注册、模型发现、runtime 回收逻辑。
- 不改 CSS、DOM 层级和交互。
- 不改 Claude 侧现有 `settings.subagents.*` 等键和值。
- 不处理 `CodexChatUIConfig.ts`、`OpencodeChatUIConfig.ts` 及其他 chat/inline-edit 面板文案。
- 不翻译日志、诊断信息、错误码、协议值、底层异常详情、用户/模型/供应商返回的数据。
- 不把路径、命令、模型 ID、JSON/环境变量示例包装成翻译键。

## 5. 实施切分与依赖

推荐**按 provider 分两批提交、一次部署**，而不是两次独立部署：

1. **Codex 批**：先加入共享 key、Codex key、10 locale、`TranslationKey`；迁移 `CodexSettingsTab`、`CodexSkillSettings`、`CodexSubagentSettings` 及相关测试。
2. **OpenCode 批**：加入 OpenCode key（10 locale、类型）；迁移 `OpencodeSettingsTab`、`OpencodeAgentSettings`、`EnvironmentSettingsSection` 及相关测试。
3. 两批都通过后统一 build/deploy。中途部署会造成两个 provider 汉化程度不一致，且 locale 文件变更容易在第二批冲突。

备选：单批提交，优点是原子完成、locale 只改一次；缺点是 diff 大、审查困难、回归定位差。故不推荐。

估算（熟悉代码库）：Codex 0.75-1 人日；OpenCode 1-1.5 人日；十 locale 对齐、测试与人工验收 0.5 人日；合计约 2.25-3 人日。若其余 7 locale 也翻译，另加 1.5-2 人日及母语复核成本。

# 风险与权衡

1. **范围显著大于“30+”**：当前源码已增长到约 224 个用户可见英文 literal 出现点（含复用项和校验分支）；若只替换最显眼的名称/描述，Notice、ARIA、空态和校验仍会漏英文。
2. **结构完整不等于已翻译**：7 locale 复制英文能满足键集合测试，但只是英文 fallback 的显式占位；本次验收只承诺 en/zh-CN/zh-TW。
3. **现有测试耦合英文**：多个设置测试用英文 `findSetting()` 或精确文案断言。迁移后应以 key-mock 返回值或真实 locale 文案更新，避免误判业务回归。
4. **翻译时点**：模块顶层常量若在 import 时调用 `t()`，切换语言后可能保留旧值。所有选项标签应在 `render()` / `onOpen()` 内生成，或将常量改为 key/工厂；协议 `value` 保持常量。
5. **英文错误映射不可取**：按英文文本反查 key 脆弱；结构化 validation issue 是必要的小范围接口整理，不是业务逻辑改造。
6. **大小写**：产品注册名为 `OpenCode`，key 命名沿源码目录使用小写 `opencode`；UI 统一显示 `OpenCode`。

# 验证方式

## 自动化

1. 运行结构与既有专项测试：
   ```bash
   npm run test -- --runInBand tests/unit/i18n/locales.test.ts tests/unit/i18n/i18n.test.ts
   ```
2. 更新并运行 provider 设置测试：
   ```bash
   npm run test -- --runInBand \
     tests/unit/providers/codex/ui/CodexSettingsTab.test.ts \
     tests/unit/features/settings/ui/CodexSkillSettings.test.ts \
     tests/unit/features/settings/ui/CodexSubagentSettings.test.ts \
     tests/unit/providers/opencode/OpencodeSettingsTab.test.ts \
     tests/unit/providers/opencode/ui/OpencodeAgentSettings.test.ts
   ```
3. 新增两类针对性断言：
   - `setLocale('zh-CN')` 后分别渲染 Codex/OpenCode tab，抽查标题、描述、空态、ARIA、动态 `{hostname}/{count}` 均为中文且无裸 key。
   - 打开三类 modal，触发空值、重复名、非法数值/JSON、保存失败、删除确认，断言 Notice/confirm 为中文且变量正确插入。
4. 增加静态防回归测试或 ESLint 级扫描：仅扫描本任务五个设置 UI 文件的 UI sink（`setName/setDesc/setTitle/setPlaceholder/setText`、`Notice`、`confirmDelete`、`aria-label`、`text`），除白名单技术字面量外不得出现英文 literal。AST 规则优于正则；首版可用测试内白名单。
5. 全量门禁：
   ```bash
   npm run typecheck && npm run lint && npm run test && npm run build
   ```

## 人工验收

- 切到 `zh-CN`，逐页检查 Codex/OpenCode：Setup、Models、Skills/Commands、Subagents、MCP、Environment；打开新增/编辑弹窗，触发校验、保存失败、删除确认和成功 Notice；除专名与技术字面量外无英文。
- 切到 `zh-TW`，同路径抽查繁体文案与插值。
- 切到 `en`，全部恢复英文；切到任一其余 locale，新增区域显示英文且不出现 key 名。
- Windows 补验 Codex Native/WSL 分支及路径校验；macOS/Linux 补验非 Windows CLI 描述。
- OpenCode 模型目录分别覆盖 0/1/多 provider、0/多 selected、不可用模型、筛选无结果，确认摘要和 ARIA 无残留英文。

验收完成条件：10 个 locale 键集合与 en 完全一致；类型检查无漏键；zh-CN 设置页全中文、en 全英文；业务行为、持久化、CSS 和 Claude 设置页无变化。

# 关联

- [[CLAUDE]]
- [[src/providers/codex/CLAUDE]]
- [[docs/designs/2026-09-16-claudian-Codex-Opencode设置页i18n化改造方案]]
