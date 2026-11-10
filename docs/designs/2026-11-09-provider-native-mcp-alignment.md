---
type: design-decision
status: draft
date: 2026-11-09
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - claudian
  - mcp
  - upstream-alignment
  - migration
---

# Claudian 内置 MCP 下线与 provider 原生管理对齐

## 背景与问题

取消 Claudian 的 MCP 配置所有权，保留 provider 原生配置和通用工具呈现；难点不是删除 UI，而是不让旧禁用规则、同名覆盖和目录作用域在切换时悄悄变成更大权限。

> 路径沿用本轮 `[务实]`。用户原话：“‘取消 Claudian 内置的 MCP 管理功能’，这个我们也拉齐吧，由上游provider管理，派刚才的architect再调研下，上游是如何实现这个的，我们是否能照搬，出设计方案”。授权仅为方向与新方案设计，不授权配置删除、导出、迁移、代码修改、提交或修改任何既有设计记录。本文为独立 draft，等待用户确认后才实施。

## 方案设计

### 1. 基线、证据和边界

- CODE_ROOT：`/Users/vincentwang/Documents/NoteVault/tools/claudian`。本地 HEAD `cf47730d2109e798fd27ddacc712038d26883d5b`，实际分支 `fix/model-identity-sorting`，主干约定 main。共享树已有多条工作线，本文不是原子冻结。
- upstream/main：`fbf3431d21289efb4f2285eb3c9d15d24d65c5f7`，2.3.41。#1084 `25c3d41a0aa57a70a1d893d5b75cda8b10a88ee9`，#1521 `43424e306274b4088ec80fccfaaa8269b6de6834`。
- WORKSPACE_ROOT 必须来自实际 provider 启动 cwd，不是本仓库 Bash cwd。当前 Claude 代码取 Obsidian vault 路径。若打开的是 NoteVault，旧数据路径为 `/Users/vincentwang/Documents/NoteVault/.claude/mcp.json`，原生项目路径为 `/Users/vincentwang/Documents/NoteVault/.mcp.json`；本文未检查这些文件是否存在或读取内容，不把例示路径当已观察配置。
- 〔既有读数〕=源码、已存在记录及公开文档；〔实测〕=实际行为测试；〔推算〕=依据代码/契约推导；〔纯示意〕=构造案例。**本轮没有 MCP/CLI 行为实测、没有启动任何 provider CLI、没有查询 MCP server、没有读取凭证或真实配置值。**git/gh 和静态源码读取不标成 CLI 实测。
- SDK 0.2.112 包元数据：`/Users/vincentwang/Documents/NoteVault/tools/claudian/node_modules/@anthropic-ai/claude-agent-sdk/package.json:3`。其包内 CLI 静态读取证明一部分原生行为，但生产可能指定另一份 CLI；不把包内源码当用户实际 CLI 的版本证据。

### 2. 上游做了什么，哪些不能照搬

#### 2.1 #1084→#1521→当前 main

#1084 PR 明示：大量 MCP 启动错误，**怀疑**损坏旧配置干扰 Claude CLI；撤除重复配置所有权。不能改写成“已证实 `_claudian` 导致故障”或“新 SDK 不兼容旧 JSON”。

#1084 为 102 文件、+199/-8519 行：

| 删除面 | 上游证据／净行为 |
|---|---|
| 编辑、导入、测试、选择器 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/shared/settings/McpServerModal.ts`、McpImportModal/McpTestModal/McpSettingsManager 的上游历史对应文件被删；输入工具栏选择器和专属 CSS、翻译、测试被删。历史文件使用 `git show 25c3d41a0^:<仓库内路径>` 读取，当前工作区的 settings 路径不同。 |
| server 提及／context-saving | FileContext、MentionDropdownController、请求中 enabledMcpServers、mcpMentions、@文本的 MCP 后缀变换被删；文件、agent、session 等其他提及保留。 |
| 存储／装配／合同 | McpStorage、McpServerManager、McpConfigParser、McpTester、AppMcpStorage、workspace manager 槽及 supportsMcpTools 管理能力被删。 |
| 启动／动态更新 | ClaudeExecutionRequestEncoder 删除用户 server 注入及 MCP disallowedTools；ClaudeExecutionStrategies 删除 setMcpServers 更新。旧 QueryOptionsBuilder 同时被删，不等于 fork 可以删除自己的整份 builder。 |
| 旧数据 | 当时新增启动删除旧文件；**#1521 删除 LegacyMCPConfigCleanup.ts，终态不再删除、不读取、不注入、不迁移旧文件**。当前上游 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/AGENTS.md:8` 的 git 对象明示此边界。 |

#1017 增加 Codex/OpenCode/Grok 原生配置提示，#1331 又按用户请求删除全部提示段；当前上游无应用内 MCP 设置段。提示删除属于产品 UI 取舍，不是原生 MCP 停用。

#1623 当前仍为 Claude 添加 `claudian_sessions` 内部 SDK MCP（上游 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/execution/ClaudeExecutionStrategies.ts:541-554`）。它是产品自有跨会话工具，**不是用户 MCP 配置管理回归**；本案不移植该功能，不为此升级 SDK。未来若接入，不能用用户 server 清单的 setMcpServers 抹掉内部 SDK server。

#1084 基于 #1008 的新 execution 架构；fork 是 ChatRuntime、本地生命周期和窗口历史。**可复用净语义，不能整 PR cherry-pick，不能整文件覆盖。**

#### 2.2 三个 provider 的原生发现、启动、更新与认证

| Provider | 已有证据 | 可以下的结论／不能下的结论 |
|---|---|---|
| Claude | fork `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeQueryOptionsBuilder.ts:279-292`、settings.ts 的 resolveClaudeSettingSources；包内 `/Users/vincentwang/Documents/NoteVault/tools/claudian/node_modules/@anthropic-ai/claude-agent-sdk/cli.js` 的 `SJ/my/Ip8` 静态函数；SDK 官方 MCP 文档 | 启动 cwd 与 settingSources 决定原生文件层；user/project/local 开关不变。包内 SJ 对项目 `.mcp.json` 自祖先到 cwd 合并；my 同名查 enterprise→local→project→user。local 来自原生用户状态的项目条目，**不是 vault 根另建一个 `.claude.json`**；默认用户状态位置通常为 `/Users/vincentwang/.claude.json`，实际需尊重配置 home。插件 server 由原生插件加载。没有自动读取旧 `.claude/mcp.json` 的接线；不以全文搜索负结果证明所有运行版本都不会读取。 |
| Claude 更新／权限 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1816-1900,3281-3332`；cli.js Ip8 | setMcpServers 不控制全部原生文件 server；mcpServerStatus/reconnect/toggle 类型已存在但本案不新建管理 UI。原生 `.mcp.json` 批准/拒绝列表与 enableAllProjectMcpServers 不是旧 `_claudian.enabled`。Ip8 有“已批准／全部批准／其他自动批准条件”分支，**不能保证 SDK/headless 第一次使用一定逐个弹窗**。native deny、模式、管理策略最终由 provider 求值。 |
| Claude OAuth／诊断 | 包内 vH5 的 mcp add help、Pi8 原生诊断；公开官方 MCP 文档 | 管理与授权入口在原生 CLI `/mcp`、`claude mcp ...`。Claudian 不新增 token 存储或登录流。不承诺 SDK 里的交互式 `/mcp` 可在本 fork 菜单直接打开，更不自动执行 mcp list/get（可能检查连接）。配置更新的新启动可重新加载；当前 query 是否被 CLI 自动刷新未做实测，采用保守重启说明。 |
| Codex | fork `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/runtime/CodexLaunchSpecBuilder.ts:17-84`，CodexChatRuntime.ts:215-216；上游 git 对象 CodexThreadBinder.ts:181-188；官方 codex `codex-rs/config/src/mcp_types.rs:243-245,291-297,652-654` 与 thread_processor 的 load_with_overrides | fork 已用 app-server 原生 MCP，不接 Claudian 清单。默认用户配置 `/Users/vincentwang/.codex/config.toml`；当前官方实现还支持可信项目 `.codex/config.toml`。新 thread/start 重读层；已有 thread/resume 是否取得改动不得仅凭 start 推断，待固定 CLI 版本核对。enabled=false 阻止初始化，缺省 true；enabled_tools 白名单后应用 disabled_tools。保留现有 cwd、home、WSL target、信任和 sandbox，不迁移 Claude server 到 Codex。 |
| Codex OAuth／交互 | 官方 mcp_cmd.rs run_login；上游 #1336＋#1521；fork `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/runtime/CodexServerRequestRouter.ts:48-63` | 原生 `codex mcp login` 为 HTTP OAuth；Claudian 普通工具审批与 MCP elicitation 不同。fork 不处理 mcpServer/elicitation/request，上游支持空对象确认、拒绝 URL／带字段表单；有取消与迟到保护。**移除管理 UI 不会修好这个缺口**，独立跟进，不能宣称全部 OAuth/确认流在插件里可用。Codex debug 命令本轮没有证据，不列为已支持。 |
| OpenCode | fork `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/runtime/OpencodeChatRuntime.ts:547-595`、OpencodeAuxQueryRunner.ts:240-286、OpencodeLaunchArtifacts.ts:88-107,184-204；上游 git 对象 OpencodeServerConfig.ts:21-63,70-85 和 OpencodeServerService.ts:276-282；官方 v2.0.32 config.mdx:29-55、mcp-servers.mdx | fork 仍 ACP，main 使用受管 configPath 替换 OPENCODE_CONFIG，aux 同时替换 OPENCODE_CONFIG_CONTENT；读取 explicit 文件用 JSON.parse 且失败退空对象。上游已用原生 HTTP（#1687），明确配置副本可能含凭证，因此置 OS 临时目录，不写同步 vault。**fork 不等于已完全无代理原生配置**，主/辅入口不同，不能只补提示就宣称对齐。 |
| OpenCode 作用域／OAuth | 固定 v2.0.32 公开文档，未打开用户配置 | 文档配置层：remote→global→OPENCODE_CONFIG→project→.opencode→inline→managed/MDM，冲突后层覆盖、非冲突合并；全局示例 `/Users/vincentwang/.config/opencode/opencode.json`。此版本文档用 `mcp.<name>`、local command 数组、remote URL、enabled=false；不要把 dev 新 schema 当已安装 ACP 的 schema。原生 auth/list/logout/debug，HTTP 401 OAuth/RFC7591；debug 会联网。本 fork 所用版本和 native parser 合并细节尚需离线核定。 |

Claude 插件 enabled 双写与本案正交：保留 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/plugins/PluginManager.ts:149-192`、CCSettingsStorage 合并和 restart key。插件携带的 MCP 仍由 provider 控制，不把“删除用户管理 UI”当“删插件管理”。

### 3. 解层次、现成能力与方案选择

问题若锁在“自动把旧 JSON 变成 native JSON”，无法安全推导 `_claudian.enabled/contextSaving/disabledTools` 对每个 native scope 的等价表达；相同名称也可能代表另一个 endpoint。**上移到管理边界：本期不迁配置，只撤旧注入并让用户显式接受原生配置集合**，转换问题不再是上线前提。

现成能力正向复用：provider 已会解析配置、认证和连接，不再自建；已有 SDK permission、辅助 tools/hook、ProviderSettingsCoordinator 与 Query 生命周期继续负责权限和资源；W4 的 Query-bound 命令发现避免再启动第二个 MCP-heavy probe；既有设置持久化承载非秘密确认记录。OpenCode 原生配置合并可取代 fork 的完整配置克隆，但须先证明当前 ACP 版本支持。

| 方案 | 权衡 | 结论 |
|---|---|---|
| A：完全照抄净删除，不做存量闸门 | 最贴上游；不能保护旧限制、同名覆回或告知功能净损失 | 不推荐 |
| **B：净删除＋存量切换确认闸门；不导出、不迁移、不删除配置** | 多一个非秘密确认状态；失去旧细粒度选择需用户处理，但无多文件配置事务／凭证复制 | **推荐** |
| C：自动转换原生文件并翻译 metadata 限制 | 需要额外读取与写入授权；跨作用域、同名、审批模式、credentials、两文件失败窗口难以保证等价 | 本期排除；未来作为独立需求重新设计 |

#### 3.1 用户视角前后对照

| 能力 | fork 当前真实语义 | 推荐终态 |
|---|---|---|
| 增删改、导入、Test | Claude 内置表单/解析器/tester | 取消；用户在**同一 cwd、home、执行目标**的 provider 原生入口管理。Claudian 只给帮助链接，不代执行。 |
| server enabled/disabled | 仅旧 Claudian 清单过滤，不保证禁用所有原生 scope 的同名 server | 交 provider。旧 enabled 值原样保留但不执行；不得自动改成 native enabled。 |
| 选择器“白名单” | 不是所有 MCP server 的全域白名单：未开 contextSaving 的旧 server 即使未选也会激活；native 文件/plugin server 另外加载 | 取消该选择器。若需要白名单，用户在原生策略设置；不承诺三个 provider 有等价统一白名单。 |
| disabledTools | 旧 enabled server 的工具名转 mcp__server__tool 进入 disallowedTools，可影响同名 native 工具 | 取消注入；须用户重建原生工具拒绝规则，或明确接受旧限制退休。Codex/OpenCode 有 native tool filter；Claude 原生 deny 与旧隐藏工具的呈现语义未证明完全等价。 |
| context-saving／MCP 提及 | enabled＋非contextSaving 或被提及/选择才注入；API 文本追加 MCP 后缀 | 取消自动挂载与后缀。旧文本和历史不重写。普通提及 server 名称只是文本，不控制连接；原生工具搜索不等于“未提及不连接”。 |
| 会话记忆 enabledMcpServers | Conversation/metadata 恢复选择器 | 只作旧数据惰性兼容保存，**不再生成新选择、不再恢复到 UI/请求**。 |
| 热更新 | 下一次动态同步 setMcpServers；禁工具/插件变化可能仍需重启 | 交 provider；不保证立即生效。本期保守规则：在 idle 经既有 owner 关闭进程，下次用户发送启动；不自动重连/探测。Codex 旧 thread 的 reload 另有验证门。 |
| 审批／目录 | permission 与 cwd/settings sources 本来已影响 native 配置 | 保留 #1482 四档/Plan 和原生策略，不启用新的 user source，不默认放宽 sandbox。additionalDirectories 不等于合并外部目录的 MCP 配置。 |
| 远程/OAuth | HTTP/SSE 直连已有；native 管理也已部分存在，插件交互接线不完整 | 交 provider 原生认证；不宣称“本案新增全部 OAuth 支持”，不复制 tokens。 |

### 4. 安全论证与具象推演

#### 4.1 不能声称“不写旧文件，所以不会扩权”

链：旧清单只是一类配置来源→撤注入会让 native 同名来源重新成为有效候选→撤 MCP disallowedTools 会去掉工具限制→原生/管理策略又可能允许调用→**存在扩权输入，必须有存量告知与显式确认**。

下表全为〔纯示意〕，不是用户实际配置：

| 锚样本 | 新旧求值推演 | 红／绿判据 |
|---|---|---|
| old server A：enabled=false；仅在旧文件 | 旧不注入，新不读取旧文件→A不从此源出现 | 绿：没有转换；红：把 mcpServers 全量复制到 native 后默认 enabled。 |
| old A enabled=true，指向只读 endpoint；native A 指向可写 endpoint | old dynamic A 覆盖 native 名称的可能性由 SDK 文档确认；撤 dynamic 后 native A 可能显露 | 绿：确认前 CLI spawn=0；红：以“旧文件不读”为由直接发送。实际优先级须固定 CLI 版本验证。 |
| old disabledTools=['delete']；native A 提供 delete；YOLO 或 native allow | 当前注入 deny-list；删除该段后 tool 可能可用 | 绿：用户先重建 native deny 或明确接受限制退休；红：MCP UI消失被当默认授权。Manual也不保证每个请求都弹窗。 |
| old contextSaving=true、会话未选择 A；native 已有 A | 旧清单不挂载A不代表原生所有scope都不连接；转换更不能丢掉条件默认启用 | 绿：不转换；用户接受新的连接粒度；红：用 tools=[] 推断“不会连接server”。 |
| 新 .mcp.json，无批准记录 | 包内 Ip8 除 pending 外还有自动批准条件 | 绿：不依赖首次弹窗做迁移授权；红：转换后声称 provider 保证逐个询问。 |
| OpenCode explicit JSONC 含 disabled server；fork JSON.parse 报错退{} | 受管副本可能丢掉该限制，原生低层 default重新显露 | 绿：离线验证合并/错误阻断，原文件和inline层不被吞；红：读取失败退空配置继续启动。 |

自检订正来源：本稿成形中发现“原生来源既有，所以删除不会扩权”遗漏同名遮蔽与工具禁用；已撤销该推论及自动导出推荐。没有修改或翻案任何既有设计记录。

#### 4.2 结构不变量判定

- 所有权正交：provider 解析用户 MCP；Claudian 只负责切换同意与应用自身能力。**成立**，确认闸门不能列 server、编辑配置、测试连接或变成长期管理器。
- 无环数据流：应用确认记录→启动准入→原生运行→工具/命令投影。投影不反写用户 MCP config。**成立**。
- 退化：无旧痕迹的新装是同一准入函数的自动 eligible 分支，不另造新装启动路径。**成立**。
- 跨入口：主/辅助/自动续跑必须在 spawn 前同闸门。仅 gate 主聊天将被 title/refine 的独立 Query 绕过，**违反位置已定位**：claudeColdStartQuery.ts:133；设计补此入口。
- 扩展方向：内部 SDK server 将来由 provider 应用工具绑定添加，不能重新开放用户 serverManager。**成立**；#1623不纳入本期。
- 目录：权限来源取实际 applied cwd/home/target/source，不拿新 UI目录冒充旧 Query身份。**依赖 W4 现成契约成立；实际接线待验收**。

### 5. 推荐切换协议：只改变管理，不变更配置数据

#### 5.1 状态与持久化

新增 Claude provider-owned `nativeMcpCutover` 非秘密记录，通过已有 Claudian settings 存储保存；不加数据库。字段仅 policyVersion、scopeKey、confirmedAt、decision='native-config-reviewed'。scopeKey 来自 providerId/实际 cwd/配置home标识/执行target/settingSources 的正规化非秘密组合；可散列以减少路径暴露，不把 hash 当认证机制。不含 server URL、env/header、token或旧文件内容。

```
unknown
  ├─ 旧文件路径不存在，且已加载历史无旧MCP痕迹 → eligible-new
  ├─ 旧路径存在／symlink／无法确认不存在／已加载meta含旧字段 → review-required
  └─ scope已确认且policy匹配 → eligible-confirmed
review-required
  ├─ 稍后／取消 → 保持review-required，历史可读，Claude spawn=0
  ├─ 用户确认“已检查native配置、同名和旧限制” → persist-confirmation
  │    ├─ 写失败／scope ABA／被取消 → review-required，不能先在内存放行
  │    └─ 写成功且scope仍同一 → drain-old-runtime → eligible-confirmed
  └─ CLI缺失 → 显示已有CLI缺失提示，仍不启动替代Query
eligible-* → 下一次真实用户请求经现有owner启动 → native-running
  ├─ launch失败 → 可见错误，不清config、不回落legacy，不记成已连接
  └─ 请求关闭/插件卸载 → 原owner关闭；下次可重试
scope/policy变化 → 旧confirmation不得套给新scope
```

检测只看旧路径存在性／错误，**不读取旧 JSON**。历史痕迹消费现有已加载 metadata，不全盘扫大型历史、不假造没有配置。新出现的 legacy 痕迹使未确认scope回到 review-required；已确认代表用户采用 native 管理，不再将旧内容当可执行来源。

确认界面（Claude settings 一次性告知＋固定文案 modal）只有：查看帮助、稍后、明确确认；不提供导出/删除/自动迁移按钮，不展示 server 配置值。说明旧文件仍在、旧MCP可能停用、同名native可能生效、细粒度控制已退休。确认不是机械验证“配置完全等价”；它是用户接受新的管理集合，不能包装成迁移实证。

#### 5.2 在途、恢复、幂等与回滚

- 不在进行中 turn/Ask/后台工作上直接 setMcpServers({})。旧 dynamic 与 native 不是同一个可全部清空集合。
- 阻止此scope新启动，等旧 Query 经现有owner真实关闭/退休；只有现有清理确认后才放行 native 启动。未闭合关闭→保持阻断，不强杀其他tab、不假记ready。
- 沿用正常插件重载/cleanup；切换确认本身不启动 CLI，也不自动发送模型请求。Resume/fork 保留原生locators，不能靠恢复 metadata 重新启用旧MCP。
- 幂等：同policy/scope重复确认不制造迁移或重复运行；失败写无成功状态；late save 后重新验scope；请求waiter取消不关闭别的owner。
- 配置回滚不存在，因为本方案对旧/原生config写入数均为0。若回退旧插件，先明确旧server注入会恢复，不自动回退；沿用交付包回滚和保存的旧数据，不删除native配置或授权。新确认字段在旧getter中必须无副作用；不能一遍新版save就丢掉。
- 开发部署 rollback 不是 git reset/stash 共享树；由主会话/实施者按仓库发布规则操作。本轮不build、不部署、不提交。

#### 5.3 数据保护边界

| 对象 | 本期允许行为（仅未来用户确认实施后） | 禁止行为 |
|---|---|---|
| 旧 `/Users/vincentwang/Documents/NoteVault/.claude/mcp.json`（示例vault）及 `_claudian.servers` | 存在性检查；原文件保留 | 解析、注入、覆盖、重命名、迁移、删除；“只复制mcpServers”也不允许 |
| native .mcp.json、用户状态、settings、Codex/OpenCode config及OAuth存储 | 交CLI解析；研究/预检不读取秘密；应用不可打印配置 | 自动转换、改批准名单、enableAllProjectMcpServers、自动登录/重连、向同步vault复制credentials |
| 旧 Conversation/SessionMetadata.enabledMcpServers | 保留旧值原样 round-trip，标为 deprecated inert；新会话不生成；不参与runtime/UI | save时覆盖成[]/undefined造成旧信息丢失，迁到其他provider，恢复成选择器 |
| 新 nativeMcpCutover | 由已有settings路径持久化非秘密确认记录 | 写原生config、默认确认、复用不同scope的确认 |
| 日志／错误 | 固定类型码与一般错误；沿既有错误呈现，不新打序列化options | env、header、credentials、完整MCP状态config、URL query/token、复制 native config 到报告 |

导出、配置迁移和配置删除是**三个独立的后续操作授权**，对齐方向或确认本设计均不自动授权它们。本期无配置备份/导出产物：零修改不是备份成功；用户要备份须另行指定路径、秘密承载和权限。

### 6. fork 适配与必要文件

下列均为未来改动，除本设计记录外本轮未写。

#### 6.1 Claude 管理链净删除与存量兼容

| 必要绝对路径 | 改动点 |
|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/app/ClaudeWorkspaceServices.ts` | 删mcpStorage/manager创建、载入、返回槽；保留command registry binding、owned-probe-disabled，不退回旧构造器参数。接provider-owned cutover准入服务。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/storage/StorageService.ts` | 删McpStorage构造/属性，保留CCSettingsStorage及其他目录/存储。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeQueryOptionsBuilder.ts` | 删manager依赖、MCP disallowedTools及key、cold mcpServers；保留base cwd/env/settingSources、#1482权限、tools/hooks、checkpoint/resume。不删除整文件。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeDynamicUpdates.ts` | 删用户server setMcpServers块/key；不动权限setter失败阻止发送、在途延迟重启和模型/目录更新。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts` | 删manager字段/构造legacy分支/reload/request合并MCP字段；保留UUID、QueryScope、lease、命令cell、watchdog和窗口历史。所有实际启动入口经同一cutover准入。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/claudeColdStartQuery.ts` | agentQuery前调用同一准入，辅助不能绕过；不因MCP对齐删tools/hook限制、改bypass政策或启用探针。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/types.ts` | 去mcpServersKey等执行字段。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/prompt/ClaudeTurnEncoder.ts` | 去extract/transform及manager依赖，保留其他上下文编码；不重写历史文本。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/ChatRuntime.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/types.ts` | 去reloadMcpServers、mcpMentions、请求enabledMcpServers；三个provider encoder按普通prepared内容适配。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/ProviderWorkspaceRegistry.ts` | 去AppMcpStorage、workspace MCP槽、supportsMcpTools管理flag及getter；保留W4命令发布revision/通知。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/capabilities.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/capabilities.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/capabilities.ts` | 去旧管理flag，不能推断成provider不支持MCP工具。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/types/chat.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/SessionStorage.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts` | 保留存量enabledMcpServers惰性round-trip，不加入新执行请求；metadata load/save不能重置旧值。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ui/InputToolbar.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/types.ts` | 删McpServerSelector/component slot，保留#1482权限菜单与W4目录提交。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/InputController.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts` | 删MCP选择/恢复/广播/请求链；不要把restore中旧字段保存丢掉，保留pending/history/目录与命令资格。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ui/FileContext.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/shared/mention/MentionDropdownController.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/shared/mention/types.ts` | 删除MCP候选、回调与状态；file/agent/folder等提及原样。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/inline-edit/ui/InlineEditModal.ts` | 删MCP接口桩，保留W4 session/registry订阅、cleanup和只读查询。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/ui/ClaudeSettingsTab.ts` | 删内置CRUD/tester；加入非管理的一次性cutover提示/帮助。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/settings.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/settings/ClaudianSettingsStorage.ts` | 保留/正规化非秘密cutover记录，getter/updater不能被#1482或模型正规化丢掉；save失败不得放行。 |

待删除实现文件：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/storage/McpStorage.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/mcp/McpServerManager.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/mcp/McpConfigParser.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/mcp/McpTester.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/types/mcp.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/utils/mcp.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/settings/ui/McpSettingsManager.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/settings/ui/McpServerModal.ts`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/settings/ui/McpTestModal.ts`。对应index导出与旧单测一起处理，**配置数据文件不在删除清单**。

CSS删除：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/style/modals/mcp-modal.css`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/style/settings/mcp-settings.css`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/style/toolbar/mcp-selector.css`；同步 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/style/index.css`。翻译清理位于 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/i18n/locales/` 十语言及types；原生提示仍使用的键不得按mcp字符串全删。

#### 6.2 Codex 与 OpenCode

Codex沿用app-server原生配置。修改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/runtime/CodexChatRuntime.ts` 和其 encoder 只清共享MCP空壳字段/no-op，不改sandbox、WSL、thread launch。保留 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/ui/CodexSettingsTab.ts:420-433` 的已有提示，不新增server inventory。

OpenCode必须分清“已无内置serverManager”与“原生配置代理正确”。本案不搬#1687 HTTP/provider架构，最低目标：**用户配置层由实际CLI解析，Claudian只提供自身agent/prompt overlay，不能吞掉或复制用户MCP配置**。

必要适配：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/runtime/OpencodeLaunchArtifacts.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/runtime/OpencodeChatRuntime.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/runtime/OpencodeAuxQueryRunner.ts`；提示位于 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/ui/OpencodeSettingsTab.ts`。

- 保留用户OPENCODE_CONFIG路径、home/XDG、cwd和原始inline配置层；不再读取explicit文件后把完整config写入vault中的受管config.json。
- 受管overlay只含Claudian agent/prompt，不写mcp/tools或新增全域permissions，不重定义用户global/custom/project优先级。若需合并用户inline文本，仅做内存、版本匹配的JSONC处理，原样保留opaque字段，不打印；解析错误必须可见阻断，不能退{}。JSONC机制优先复用已有能力；确需jsonc-parser时先核固定CLI格式，作为明确依赖列入实施，不能用JSON.parse冒充JSONC支持。
- 主/辅助入口使用同一overlay协议，不能主替路径、辅覆盖inline形成不同native层。移走会含凭证的完整副本能力；**现存** `/Users/vincentwang/Documents/NoteVault/.claudian/opencode/config.json`（示例）不自动删除，不读取秘密；清理须单独授权。
- 离线G1须先证明实际ACP CLI支持的层合并与managed agent继承。如果不能证明／当前版本不支持，OpenCode片保持阻断/原版，不带着“已对齐”的标签上线；提出独立native HTTP设计请求，而非在本案顺手搬#1687。

### 7. 依赖、合流与SDK边界

```
G0 基线/原生静态证据/取舍确认
  ├─ W4d完成并关账
  │    └─ 已confirmed #1482 权限移植完成
  │         └─ integrator串行：Claude净删除 + cutover + 入口合流
  └─ OpenCode版本匹配原生配置层离线验证
       └─ 主/辅overlay适配（独立开发，最终同版本验收）
合流 → 全入口mock矩阵 → typecheck/lint/test/build（隔离部署目标） → 用户验收
```

这是执行依赖建议，不修改既有记录：#1482原记录已安排W4d之后。本案不要反转为“#1482→本案→W4”。MCP与#1482逻辑正交但同文件耦合，尤其builder、DynamicUpdates、Tab、settings；必须串行重基线，不删除已定权限政策、不合并#1493永久授权裁决。MCP cutover不以默认Auto/Manual替换用户已存YOLO，也不把Manual当server连接保险。

W4同样涉及registry/factory/Tab/目录/inline/QueryScope。本案不新增owned probe，不把SDK init慢恢复为detached命令探针，不修改W0/P1资格合同。native config改变后的命令候选属于具体Query，旧receipt须随真正Query退休失效，不用当前UI设置给旧Query重新贴身份。

Claude净删除/cutover没有SDK升级硬依赖。SDK0.2.112的settingSources/options已经被fork使用；类型存在不代表指定CLI版本行为已验证。上游#1468 initializationResult probe、#1623内部server、#1687 OpenCode HTTP均不搬。Codex elicitation和#1752/#1765/#2097工具投影修复分别是独立后续，不与“取消管理功能”混成必需大升级。

### 8. 交付物规范

#### 8.1 新增目标目录树（绝对根）

```
/Users/vincentwang/Documents/NoteVault/tools/claudian/
  docs/designs/2026-11-09-provider-native-mcp-alignment.md       本轮唯一产物
  src/providers/claude/app/ClaudeNativeMcpCutover.ts            待实施
  src/providers/claude/ui/ClaudeNativeMcpCutoverModal.ts        待实施
  tests/unit/providers/claude/app/ClaudeNativeMcpCutover.test.ts 待实施
  tests/unit/providers/claude/ui/ClaudeNativeMcpCutoverModal.test.ts 待实施
  tests/integration/providers/claude/runtime/NativeMcpCutover.test.ts 待实施
  tests/integration/providers/opencode/NativeConfigLayers.test.ts 待实施
```

#### 8.2 命名规则与登记

设计按既有 `<YYYY-MM-DD>-<slug>.md`；ClaudeNativeMcpCutover前缀表示provider-specific切换准入，不是通用MCP管理；NativeConfigLayers表示原生配置层保真。测试镜像/生产链integration沿项目目录规范。实施时在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/README.md` 新增设计/原生MCP对齐入口索引，更新原MCP内置管理说明。本轮不修改README。

#### 8.3 产物清单／用途／消费者

| 路径（均以上述绝对根定位） | 用途 | 消费者 |
|---|---|---|
| docs/designs/2026-11-09-provider-native-mcp-alignment.md | draft设计及授权边界 | 用户、主会话、integrator |
| src/providers/claude/app/ClaudeNativeMcpCutover.ts | 只检测旧痕迹、持久同意、启动资格；不读server内容 | Claude主/辅助启动、设置提示 |
| src/providers/claude/ui/ClaudeNativeMcpCutoverModal.ts | 取舍说明与明确确认 | Claude设置与用户 |
| 两份unit、两份integration（目录树列明） | 状态机、数据保护、生产调用链与层保真回归 | CI、reviewer |

#### 8.4 归属引用／偏离

复用 `/Users/vincentwang/Documents/NoteVault/tools/claudian/CLAUDE.md` 的provider-owned边界与镜像测试、现有 `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/` 记录格式；代码/测试命名沿当前fork而非#1416强制重命名。对上游明确偏离：增加非管理的存量确认提示、保留fork Codex原生提示和惰性旧metadata；上游零迁移不直接保护本fork旧限制。无永久业务数据、凭证导出或新MCP管理目录。

## 风险与权衡

1. **需用户裁决一**：接受取消context-saving、@挂载、会话选择器、旧工具隐藏与免重启切换。native deny/tool search不能冒充完全等价。若不接受，方向需要重新讨论，不追加永久代理以假装已对齐。
2. **需用户裁决二**：接受推荐存量确认闸门——旧文件/旧痕迹存在但未确认时，Claude新请求（含辅助/自动）不可启动，历史仍可读；或者接受纯删除方案及限制变化风险。本设计推荐前者，确认过程不改用户配置。
3. **需用户裁决三**：OpenCode ACP原生层验证不足时，是分provider验收暂不发布该片，还是另开HTTP迁移设计；本期不自行扩任务。不得宣称三provider已经完成同等对齐。
4. 不自动导出、不迁移、不删除旧/native数据是本方案边界，不需要挑某个拒绝名单落点。用户未来要求恢复某个旧server，另行授权明确文件/条目/目标scope/秘密承载/冲突处理。
5. 原生管理≠安全设置保持完全等价。闸门防**未同意切换**，不是审计全部native权限；用户确认后自行修改native配置由provider政策治理。
6. 所有写操作限定未来code/非秘密应用确认记录，旧配置没有可回滚事务；新ack写入失败或owner未闭合均阻断，不能静默降级legacy。共享树冲突、OpenCode格式/版本、aux连接延迟仍需实测。

迁移/落地代价：删除是跨入口/类型/测试的耦合改造，OpenCode需要配置层小适配与版本证据；分片降低实施风险，不降低“provider拥有用户MCP、旧数据不变、未确认不扩面”的目标。

## 验证方式

### 1. 只读/离线证据补齐

- Claude：固定实际pathToClaudeCodeExecutable版本和settingsSources；只读包内/指定CLI源码或公开版本源码，检查scope/优先级/headless批准。不得用 `claude mcp list` 当无连接预检。
- Codex：固定已安装版本的config loader、thread/start与resume源码；核可信项目层、enabled=false及tool filters。当前官方main的证明不能自动覆盖旧CLI。
- OpenCode：固定实际ACP版本，读取公开/安装版本原生config parser，核OPENCODE_CONFIG、inline、JSONC、agent继承。纯mock CLI仅证明adapter参数，**不能证明原生深合并**；需版本源码或离线纯parser测试，未满足不放行该片。
- 所有fixtures人工构造在测试临时目录，HOME/XDG与cwd隔离，不读真实vault配置；真实server/网络/LLM调用数必须0。不新增sleep/真实CLI“dry session”来代替mock。

### 2. 入口×机制验收矩阵（每格落实生产链测试）

| 入口 | 旧注入/提及/UI | 准入与owner | 配置/旧数据 | 权限/命令/作用域 |
|---|---|---|---|---|
| Claude新装首发 | 无manager、无用户mcpServers/旧禁工具 | 无旧痕迹eligible，同一启动函数 | 旧/native config writes=0 | cwd/env/settingSources保持，#1482值不变 |
| Claude旧装冷启 | 选择器消失，不恢复旧提及 | 未确认agentQuery/spawn=0，cancel/写失败仍0 | 旧文件read=0，字节不变 | 同名可写/禁工具案例不能未确认发送 |
| Claudepersistent下一轮 | 不setMcpServers清旧集合 | 必须旧Query真退休；关闭失败阻断 | 不删meta值 | UUID/lease/auto-turn/receipt退休正确 |
| Clauderesume/fork/自动续跑 | 不回灌metadata启用清单 | 同scope确认gate，保留locators | 旧字段round-trip，opaque字段保留 | 分支/Plan/审批/超时无行为回退 |
| ClaudeInline首次与continue | 无MCP候选/桩 | cold helper同gate，不暗开第二个query | 不读旧JSON | READ_ONLY_TOOLS＋PreToolUse保持 |
| Claudetitle/refine | 不注入用户server | 未确认同gate，不为后台弹授权 | tools=[]不是连接隔离证据 | tools/hook与原权限政策保持 |
| 设置打开/确认/缺CLI | 无CRUD/test/auth | 确认不启动CLI，无CLI不创建替代运行 | 仅ack写；错误固定文案 | 无env/header泄漏，scope变化late-save失效 |
| Codexstart/resume/fork/aux | 无共享MCP空壳 | 既有app-serverowner | user/project字段完整，no config writes | target cwd/WSL/sandbox不变；elicitation仍明确未支持 |
| OpenCodemain/aux | 无sharedmanager | 原生overlay版本闸门 | custom/inline层保真，无凭证副本入vault | false/deny保留，解析失败阻断，主辅一致 |
| 目录/home/source/provider变化 | 不把旧选择带到别provider | scopeKey不同不套确认 | 不扫描秘密，全局config不改 | W4 applied身份与UI请求区别保留 |
| 卸载/中途失败/重复确认 | 无旧自动回退 | 收尾幂等，只有owner关自身进程 | 原文件与旧metadata不丢 | 无重复turn或跨tab Query关闭 |

### 3. 确定测试命令（实施者执行，本轮未运行）

所有npm从 `/Users/vincentwang/Documents/NoteVault/tools/claudian` 执行：

```bash
npm run typecheck
npm run lint
npm run test -- --selectProjects unit --runTestsByPath tests/unit/providers/claude/app/ClaudeNativeMcpCutover.test.ts tests/unit/providers/claude/ui/ClaudeNativeMcpCutoverModal.test.ts --runInBand
npm run test -- --selectProjects integration --runTestsByPath tests/integration/providers/claude/runtime/NativeMcpCutover.test.ts tests/integration/providers/opencode/NativeConfigLayers.test.ts --runInBand
npm run test -- --runInBand
```

同时回归现有builder/DynamicUpdates/ClaudianService、claudeColdStartQuery、SessionStorage、ClaudianSettingsStorage、Tab/TabManager/InputToolbar/Inline、命令W1/W2/W4与Codex/OpenCode suites。测试移除不允许当成功覆盖；新增integration必须调真实生产入口并断言spawn=0/真实传出options/保存字节与UI可观察结果，不能mock被测gate本身。

`npm run build` 按既有发布约定**指定不存在的部署目标或实施者认可的安全构建方式**，不得裸build覆盖用户Obsidian部署；未核清build脚本前不假定环境变量能阻止复制。本轮未build。

静态审计：生产源码应无McpServerManager/McpStorage/用户清单setMcpServers/管理flag import；enabledMcpServers仅storage惰性兼容，mcp__工具名和通用结果渲染必须保留。审计命中不以全字符串删法修复。

### 4. 后续实机验证边界

用户确认实施后，先跑全部离线门；需要真实CLI/MCP/OAuth的验证另征求预算与连接授权，按provider同cwd/home/target核原生配置、拒绝工具、同名来源、重启/恢复及OAuth。没有连接/行为证据不得标“原生服务已可用”。本轮源码与推演仅用于圈出靶子，未替代实机验收。

## 关联

- [[2026-11-09-upstream-1482-claude-permission-port]]（confirmed；先W4d后权限；本案不修改）
- [[2026-11-09-command-discovery-wiring-w1-w2-w4]]（在途；实际Query资格与禁止owned probe）
- 上游 #1084 `25c3d41a0`、#1521 `43424e306`、#1017 `123fbb9db`、#1331 `68b62664e`、#1623 `cf9326f32`、#1687 `922aa61c8`、#1336 `bb9ddf0fd`；均以git diff/公开PR正文核查。
- SDK官方：https://code.claude.com/docs/en/agent-sdk/mcp 、 https://code.claude.com/docs/en/agent-sdk/typescript （通过Context7读取；直接WebFetch不可用，未把失败当文档不存在）。
- Codex官方：https://github.com/openai/codex/blob/main/codex-rs/config/src/mcp_types.rs 、 https://github.com/openai/codex/blob/main/codex-rs/cli/src/mcp_cmd.rs 、 https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/thread_processor.rs （main版本证据，不冒充本机版本）。
- OpenCode固定文档：https://github.com/anomalyco/opencode/blob/v2.0.32/packages/web/src/content/docs/config.mdx 、 https://github.com/anomalyco/opencode/blob/v2.0.32/packages/web/src/content/docs/mcp-servers.mdx （经gh API读取；fork ACP版本适用性未确认）。
