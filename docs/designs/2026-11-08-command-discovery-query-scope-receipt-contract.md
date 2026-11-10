---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - claudian
  - command-discovery
  - scope
  - evidence-gate
---

# 命令发现：Query 身份、来源范围与 Dropdown 回执合同

## 背景与问题

命令链把成功空、失败、无 runtime 和失效请求压成数组，又把非空 fallback 当成功缓存；需要先修 Query 级发布资格，再用来源、范围和回执贯通主聊天与 inline，不能靠 catalog revision 冒充发现成功或 SDK 热刷新。

> [!warning] 独立草案及工作边界
> 本记录不替代、不修改、不确认三份上游兼容设计。只设计命令发现；不重划 Stop、审批、任务、持久化、历史索引或全局生命周期。未运行真实 CLI/MCP、模型、测试、build、部署、commit、push 或清理；本轮唯一新文件是本记录，未改代码、README、旧设计及并发 session 文件。
> 派单未指定务实/理想。就本任务的必要边界，两者都需要相同的身份、结果、scope 和回执合同；分期限制的是启用顺序，不降低终态。不另提全生命周期重写。

## 方案设计

### 1. 已核查证据与结论限度

#### 1.1 本轮观察基线

代码根 `/Users/vincentwang/Documents/NoteVault/tools/claudian` 是独立 Git 仓库。HEAD 为 `cf47730d2109e798fd27ddacc712038d26883d5b`，分支 `fix/model-identity-sorting`。2026-11-08T08:47:53Z 观察到 79 条修改/未跟踪状态，暂存区为空；这是观察点，不是锁定其它写者。

关键文件 SHA-256〔实测：只读哈希〕：

| 绝对路径 | SHA-256 |
|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts` | `931f1271728050ff0e7af351c29f0e64ce136d8710d907921822d60c8ca98e92` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/ClaudeCommandCatalog.ts` | `73a4d82fb51d5b6a49314714bd6d1b477ef95c836b1ef3387b791a65fc8c9deb` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/probeRuntimeCommands.ts` | `e1d8f94bf95af7021779d69649d2208ed6417417aa636019853e7f4e9d49efb5` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts` | `13eecee1ae987996a833a2d0df621f5d129c73fd26ab0faca1419f0e98dfb6c5` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/shared/components/SlashCommandDropdown.ts` | `5c9d6e769499ea0bc371816904cb0fcd9a05a07f4ce3835c3c66bef290e06da7` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/inline-edit/ui/InlineEditModal.ts` | `a01864cbfea6c390f0b02a7bd885f4b0d639b28030bb9b43ae854dece85499c0` |

实施前须由主会话冻结包含脏文件和 untracked 的实际基线、指定整合者。Dropdown 已有另一工作线增加的 `disposed`、单调 `requestId`、destroy/hide 失效检查；必须保留，不能覆盖成旧实现。本记录不触碰派单所称“索引七文件”，也不将其纳入本任务实施范围。

#### 1.2 可证与不可证

| 编号/等级 | 证据 | 支持的结论；不支持的推广 |
|---|---|---|
| E1〔既有读数：受控动态测试〕 | `/private/tmp/claudian-command-evidence.48ybhP6F/snapshot/tests/unit/providers/claude/runtime/CommandProbeEvidence.test.ts`、`/private/tmp/claudian-command-evidence.48ybhP6F/jest-output.txt`；8 例中 7 绿、1 红。退役用例收到 `during=[old]`、新 Query 建立后 `after=[old]`，新 Query 的 supportedCommands 调用次数为 0 | 证明 mock Query 下生产 runtime 可返回已退役 Query 的缓存；不证明真实 UI 已发生、不证明真实 CLI 出现频率。独立复核由派单报告，本轮未重跑 |
| E2〔实测：只读保真核查〕 | 当前 runtime 与该临时副本 runtime 的 SHA-256 完全一致；临时 verify-output 另有历史 `344/344 match` | E1 对当前这个 runtime 文本仍有关联；不声称整个脏工作树仍与旧副本相同 |
| E3〔既有读数：源码〕 | runtime `:3466–3499` 在检查 Query 之前返回非空缓存；只有普通 close `:995` 清缓存，watchdog retirement `:2945–2965` 未清；旧完成 `:3492–3494` 返回当前缓存 | 空、失败、无 Query、旧请求不可分；旧请求还可能取得新 Query 的数据，而非明确 stale |
| E4〔既有读数：源码〕 | catalog `:74–111` 用 length 判断未探测/覆盖资格；`:89–92` 运行列表过滤后空则回 vault；Dropdown `:248–260` 非空置 `providerEntriesFetched=true` | 非空 vault fallback 可以锁住 Dropdown；合法空不能成为成功缓存；隐藏后空和原始成功空也被混淆。此端到端用户影响本轮仅为推算，尚缺生产链动态测试 |
| E5〔既有读数：源码〕 | TabManager `:1266–1325` 以 provider 相同借另一 tab，随后写 workspace 全局 catalog；`:1556–1578` await getSdkCommands 后再读全局数组。Tab `:177–185` 有 registry 直读后备；inline `:440–454` 直读同 catalog | manager 的原 tab/ticket 检查能防一些旧消费者发布，不能证明来源 scope 对等，也不能阻止同 workspace 两个合法入口读错全局来源 |
| E6〔实测：installed 文本核查〕 | installed SDK `0.2.112`；`sdk.mjs` 为 `supportedCommands(){return(await this.initialization).commands}`；`sdk.d.ts:4470–4483` 只有 name/description/argumentHint | 重调同 Query 不是热刷新；不能凭名称判断内置/同名自定义，也不能补造 origin |
| E7〔实测：installed 文本核查〕 | `sdk.d.ts:1791–1802` 公开 `initializationResult()` 与 `supportedCommands()`；`:2258–2270` 初始化响应有完整 commands。`sdk.mjs` Query 构造时启动 initialize，方法读同一个 initialization promise；异步 input 在收到项时才写 user 消息 | 现成公开初始化入口可正向规避 probe 必须等待 `system/init` 的插件层前提；可研究零入队输入的 init-first probe。不证明 CLI 初始化无 hooks、无 MCP 连接、无费用或已退出 |
| E8〔既有读数：官方现行文档〕 | Context7 官方 TypeScript 文档：动态 supportedCommands/commands_changed 需 SDK ≥0.3.216，MCP prompts push 需 CLI ≥2.1.281，SlashCommand.builtin 需 SDK ≥0.3.277 | 升级能作为热更新/内置判别的候选能力；不能把新文档当当前 0.2.112 wire 已支持。未升级 |
| E9〔既有读数：源码〕 | QueryOptionsBuilder、probe 与 inline helper 使用不同规则：persistent/cold chat 有 additionalDirectories，cold chat 合并 mentions/UI MCP；旧 probe 未传这些上下文；inline helper 不传 additionalDirectories/MCP/plugin 选项，也不传 Chrome flag | UI 提供 external context 不等于 SDK 实际加载该目录；不应为“统一”把 inline/其它辅助 query 改成 chat 行为 |

SDK 文本指纹〔实测〕：`/Users/vincentwang/Documents/NoteVault/tools/claudian/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` 为 `cb6908cb1701fc358269f0370615c9183dadfcd03dedc3060dd4bd8ef494d5b1`；同目录 `sdk.d.ts` 为 `99c1ce89ec7c20898dba5eee12043487ed7a7ebfe44e69a6395a4fd0e0b6dd73`。

#### 1.3 既有设计对齐

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-07-upstream-compat-stop-permissions-discovery.md` §4：方向为单一发现状态、冷热缓存和取消；本稿补可执行分期，不继承模糊的“新 revision 更鲜”。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-07-upstream-compat-evidence-closure-supplement.md` §7–8：初始化观测、candidate scope、published/source revision 分离、Dropdown 不另持成功缓存、borrowed/owned 分权；本稿保持。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-08-upstream-compat-remaining-implementation-contract.md` §8 C5：scope/store/receipt/finite probe 门；本稿将 Query 单元修复从完整 C5 拆为独立 P1。原 §8.2 资源接续条件仍是新增 owned probe 的前置，不用 P1 通过代替。
- 新发现 E7 纠正“尚未发现并验证本版本可读初始化入口”的证据范围：本轮已核实**入口存在且实现读 initialization**，但零 user 输入的真实初始化、费用与资源验证仍未完成。不改旧文档以回填结论。
- 原候选 Query 未缓存/pending/ready 是必要且成立的局部修复；**不是**整个 catalog/Dropdown fallback 缓存解。

### 2. 解层次、备选与推荐

困难分三层：Query 数据发布资格、catalog 来源/目标范围、Dropdown 消费回执。后两层不能从一个裸数组恢复丢失的信息。

| 方案 | 收益 | 缺口/取舍 |
|---|---|---|
| A：只修 Query 单元，或只加 catalog revision | Query 单元可直接封 E1；revision 可作消费失效信号 | A 只修局部；revision 不提供 success-empty/error/source/scope，不能根治 fallback pinning。保留 Query 部分作为 P1，不采用 revision-only |
| B：Query 单元 + 来源化 store + 无二级成功缓存的回执消费 | 旧 SDK 下仍诚实；跨入口同合同，成功空是正常特例，可分期验收 | 需要窄接口接线；完整 owned probe 启用仍受真实资源/用户策略门约束。**推荐终态** |
| C：升级 SDK/使用原生 reload 能力 | 新 SDK 的 push/builtin 可消除部分旧版能力限制；installed reloadPlugins 已可返回 commands | 升级不修应用层身份/消费缓存。reloadPlugins 是改变会话插件状态的操作，不是被动目录读取，不能默认由菜单触发；也不保证所有来源刷新。另案裁决，不阻塞 B 的纯状态实现 |

复用优先：复用现有 QueryScope/实际 Query 身份、init getter、catalog 并发去重模式、manager 原对象/ticket、Dropdown 单调 requestId、现有存储扫描和 provider registry。只提取命令必要的纯 context 与状态合同；不建新的 turn owner、全 App registry 或业务 writer。

### 3. 最小公共合同：数据、请求与消费者各有身份

新合同放 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/commands/ProviderCommandDiscovery.ts`。下列签名是目标接口，不是实现代码；opaque token 只表达资格，不能反推来源内容。

```typescript
type CommandDiscoveryResult<T> =
  | { status: 'ready'; snapshot: CommandObservation<T> }
  | { status: 'failed'; stage: string; code: string; retryable: boolean }
  | { status: 'cancelled'; reason: string }
  | { status: 'stale'; reason: string }
  | { status: 'unavailable'; reason: string };

interface RuntimeCommandDiscovery {
  read(signal?: AbortSignal): Promise<CommandDiscoveryResult<SlashCommand>>;
  subscribe(listener: () => void): () => void;
}

interface ProviderCommandDiscoverySession {
  read(signal?: AbortSignal): Promise<ProviderCommandDropdownSnapshot>;
  subscribe(listener: () => void): () => void;
  isCurrent(receipt: CommandCatalogReceipt): boolean;
  release(): void;
}
```

配套必需字段：

| 对象 | 必需语义 |
|---|---|
| `CommandObservation<T>` | readonly entries；source=`initialize-response/probe-candidate/vault/live-push/native-reload/legacy`；sourceRef；captured requested/applied scope；observed facts＋未知项；coverage；原始条目数。P1 只有 initialize-response，不提前实现其余能力 |
| `CommandCatalogReceipt` | catalogEpoch、targetToken、targetRevision、configRevision、policyRevision、publishedRevision、实际 sourceRefs、projectionClass=`observed/fallback/legacy`、fallbackReason。是消费一致性凭据，不是数据更新水位 |
| `ProviderCommandDropdownSnapshot` | readonly 展示 entries、receipt、各来源 outcome、rawCount/visibleCount、明确 scope/coverage。fallback entries 不替代 discovery outcome；vault 扫描失败独立登记，不能变空成功 |
| target | 捕获的原 tab/modal 对象、provider、原 runtime facade、目标上下文版本；对象身份＋单调 targetRevision 防 S1→S2→S1 ABA，不仅 conversationId 或 JSON 值相等 |
| sourceRef | Query 创建时唯一 command token（SDK Query 对象只留 provider 内），probe flightId，或 vault 扫描 observation。queryEpoch/workspaceEpoch 辅助资格，不是 source freshness |

接口接入：

1. `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/ChatRuntime.ts` 新增可选 `getCommandDiscovery?(): RuntimeCommandDiscovery`；保留现有 `getSupportedCommands()` 兼容方法。feature 不读取 SDK Query 或导入 Claude 实现。
2. `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/commands/ProviderCommandCatalog.ts` 新增可选 `openDiscovery?(context): ProviderCommandDiscoverySession`。context 带 targetToken/revision、原 runtime facade、已捕获入口声明；provider 内补实际配置证据。旧 CRUD/config/数组 API 保留供未迁 provider/设置管理。
3. Claude 的新路径**不再**经 `setRuntimeCommands(SlashCommand[])` 写全 workspace 当前数组。旧 setter 留兼容壳，不允许不带来源的写入污染新 store；manager 使用 capability 路由，不写新的 provider-name 分支。
4. 非 Claude 暂保留旧数组路径和原触发/优先级；标 legacy，不给数组凭空升级 ready/complete/失败判别。其行为等价测试通过即可，不在本案扩大 Codex/OpenCode 的发现/资源生命周期。

失败字段用可枚举 stage/code，展示文本另映射；不持久化异常堆栈、完整 env、accountInfo、服务器 URL 或命令正文。snapshot 与 SDK/当前可变数组不共享可写引用。

### 4. P1：Query 级缓存与发布资格，可先单独实施

作用文件 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts`。先 provider 内实现 typed read，再于 P2 接公共 facade；无需先建 workspace store。

每个实际 Query 一个 command cell：`unobserved → pending(flight) → ready(snapshot)`，外加不可逆 revoked 资格。失败的 lastOutcome 与“成功数据缓存”分开；失败不进入 ready。旧 SDK 的 ready 在该 Query 的初始化观测范围内稳定，包括 `entries=[]`。

具体规则：

1. 读取先检查当前 Query/cell 未 revoked、原 QueryScope 未 retired、signal 未 aborted；**之后**才能命中 ready。无 Query 返回 unavailable；已开始的旧请求失资格返回 stale。兼容数组壳只对 ready 返回 entries，其它返回 `[]`，不能将新 Query 数组塞给旧请求。
2. public read 与两条 `session_init` 路径共用同 Query flight。第一次 await 前同步安装 flight；同 Query 并发只调用 SDK 一次。init 触发只添加观察需求，不能在用户已读成功后再次抓取。
3. `routeMessage(message, scope)` 已持原 scope；其两处 `applySessionInitSideEffects` 调用把**该 scope 的 Query 身份**传到命令读入口。不要在异步完成时按 `this.persistentQuery` 重绑。这里只改命令来源参数，不重做其它 init 副作用或消息路由。
4. 在已有 Query 退役点同步 revoke 命令资格并通知：普通 close（包括没有 Query 的清理分支）、`executeQueryRetirement` 的 `scope.retired=true` 处；创建新 Query 时装新 cell。真实本 Query exit/consumer 结束若已有通知，追加命令资格撤销；旧 consumer 的 finally 必须核原 token，不能 revoke 新 cell。
5. revoke 只撤命令数据资格、结算命令等待者和摘命令订阅；**不改变** channel、turn、Query close、实际 exit/start prohibition、Stop/watchdog/rebuild 顺序。现有生命周期仍独立拥有进程。
6. 旧 SDK promise 即使无法取消，也不得挡住 host caller：caller signal 或原 cell revoke 可以先结束本次等待；挂起 SDK promise的两端均登记回调，迟到成功/失败被观察但不发布。一个 caller cancel 不 abort borrowed Query，也不取消其它 caller 的 flight。
7. 完成时核 Query＋cell＋flight 实例；旧 finally 不清新 flight。失败保留 failed；本阶段兼容壳的重试行为不扩大为自动轮询。旧 SDK 的 rejected initialization 可能不可恢复，不能承诺同 Query 重调可修复。
8. 创建/ready/failed/revoke 发命令专用通知。现有 ready boolean 不能替代：它不表示初始化成功空，也不覆盖已 ready Query 的列表改变。

P1 验收只关闭 Query stale/空值/去重缺口。下游仍调用数组 API时，failed/unavailable/stale 仍可能被当空，**不得写“所有命令发现已修复”**。

### 5. P2：scope、store 与回执贯通，消除 fallback 成功缓存

#### 5.1 scope 所有权及来源分区

新 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/ClaudeCommandContext.ts` 提取纯描述：cwd、实际 additionalDirectories、settingSources、实际 SDK/CLI/build 身份、env 内存 revision、plugins/工具/MCP 配置及入口规则。生成发送选项的同一时点捕获 applied descriptor，不把 `currentConfig` 或当前 UI selector 当完整生效证据。

- requested：用户/入口当前声明，希望哪些来源参与。
- applied：插件实际构造/动态成功应用的选项，**不等于 CLI 确认全部加载成功**。
- observed：初始化列表、可证明状态及 unknown；SDK 无 origin/来源水位时 coverage 最多 initialize-observed，不能伪造 complete。
- fingerprint 对白名单语义描述稳定序列化；它只作配置相等/去重。sourceRef 和 targetRevision 独立。目录实变但无 watcher/版本证据时标 untracked，不能宣称缓存自动热更新。

新 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/commands/ProviderCommandDiscoveryStore.ts` 由 catalog 拥有，承载 observation/receipt/订阅和 owned flight 去重；不导入 provider wire、TabManager、DOM 或 SDK Query。

分区规则：target 的实际 Query observation、target 的 probe-candidate、vault observation 分开保存。Query 变更撤旧 target 的发布资格；同配置不同 Query 不共用“当前会话”结果。不同 scope 不最后写入胜出。probe 结果只能更新自己的 candidate 分区，成功空也不删 hot 初始化观测。

现阶段停止“仅因 provider 相同即可作为当前目标借用”的事实升级：另一 tab 列表不写入 target-query 分区。若保留借用展示，只能进明确 borrowed-candidate，产品是否展示待裁决；未有对等证据不可伪装 current。无需为此重启另一 tab。

#### 5.2 manager/catalog/inline 直接传来源，不再 write-array/read-global

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts` 的新 capability 路径，打开 target discovery session，直接把 typed runtime result 交给该 session；保留原对象/ticket/registry 实例检查。以 result.status 求值，不用 length 决定暖启动/probe。成功空不触发新的 runtime/探测来“补满”。
- Query facade change/revoke 使 store 的相应来源 receipt 同步失效；不是等用户再次 getSdkCommands 才清 Dropdown。target/settings/selector 改动推进 target/config revision，释放原 session；不让反向切回同值复用旧 ticket。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts` 的 registry 直读后备同样接 openDiscovery；不能主路径升级、后备仍读全局裸数组。原 conversation/reset/manager-active guard 保留。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/inline-edit/ui/InlineEditModal.ts` 为原 modal 创建独立 target，捕获自身 provider/context revision，不借 active chat runtime。send 前上下文/设置变化需要失效原 session；不得忽略 provider runtime 当前执行规则。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/auxiliary/ClaudeInlineEditService.ts` 与 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/claudeColdStartQuery.ts` 只在必要时提供**现有 inline 执行选项描述**，不改变 tools、hooks、权限、MCP、Chrome 或 additionalDirectories。当前 inline 的 external file mention 是 prompt context，不据此注入 chat 的 additionalDirectories；UI 声明与 SDK applied 不同必须明示。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/ui/SlashCommandSettings.ts` 继续 listVaultEntries/CRUD，不启发现进程；保存/删除成功后使 vault observation 失效。失败不写成功 revision。

新 facade 的读/订阅不启动聊天 Query；原 send/warmup 启动政策由原机制拥有。改发现结果不能顺带增设 ensureReady 或绕过 queryStartProhibited。

#### 5.3 fallback receipt 与 Dropdown 单一缓存真相

**推荐移除 Claude 新路径的 Dropdown 二级成功缓存，而非不断为 fetched boolean 补条件。** Store 缓存来源成功（含空）；Dropdown 仅保存本次渲染 snapshot/receipt。

`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/shared/components/SlashCommandDropdown.ts` 增加可选 discovery session 接口；每次合法输入 read 当前 snapshot，本身不判 entries.length 为成功。store read 可以内存命中，不代表每键重跑 SDK/读文件/开进程。

- 当前 vault fallback 行为包括发现空、过滤后空；本期**不擅自改变**为“成功空一定不展示 vault”，但 receipt 必须记录发现成功空/失败/未就绪、rawCount/visibleCount 和 fallbackReason。vault 扫描成功只证明 vault 来源成功，不能反向令 runtime ready。
- 原始 `[cost]` 被过滤成空，与原始 `[]` 不同；hidden 政策只是投影，不清原成功 observation、不触发重复 probe。
- 新 Query、来源成功/失败/撤销、vault invalidate、target/config/policy 变化都会使原 receipt 失效。Dropdown 收 change：推进自己的 requestId，丢弃旧渲染 snapshot；若当前 input 仍符合 trigger，重新 read 并刷新；hidden 时只失效，不自动开任何探测。
- await 后同时核 UI requestId/disposed、原 session、receipt.isCurrent。点击/Enter/Tab 插入前**同步**再核 receipt；旧项不得在刷新 race 中继续插入。重新 read 后需要重新选项，不“替用户选择名称相同的新项”。
- hide/reset/destroy/provider switch 退订/结算自身请求并保留现有单调 requestId、disposed 防护；hide 可以释放 UI兴趣，不能关闭 borrowed chat。store 先通知并完成状态变更，监听回调只调度异步 read，避免同步重入发布。
- legacy 非 Claude 仍走原 callback/caching，Codex 的 `$` 与 built-in 前缀/优先级不变；不得偷偷为它新增 CLI 请求频率。后续迁移另走合同。

技术最低线：不再将 fallback 当权威发现成功，不再靠 entry 数量分状态，不保留失效 receipt。fallback 是否展现/可选择、部分来源怎样标识，见未决策略；本期可保持已有 policy 值，但不能宣称用户已确认。

#### 5.4 hidden/同名策略不偷换

当前 `BUILTIN_HIDDEN_COMMANDS` 与 Dropdown 本地 built-in 优先去重都是名称政策。0.2.112 无 origin：自定义 `/cost` 与内置 `/cost` 可以在元数据上完全相同；vault 找到同名文件也不能证明 SDK 此行来自该文件（plugins/MCP/优先级可能遮蔽）。

P1/P2 保留现有筛选结果，仅将其准确命名为 name-hidden policy，记录 raw/visible 差别；不声称只隐藏了内置，不以猜 origin 修改规则。若用户要求“只隐藏内置、自定义同名必须保留”，当前版本全来源不可证，需另选升级到具有 builtin 证据的 SDK/CLI组合或接受明确局部来源范围。不能静默用白名单替代这个裁决。

### 6. P3：owned probe 的 init-first、取消和故障合同

仅涉及 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/probeRuntimeCommands.ts` 和 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/app/ClaudeWorkspaceServices.ts` 的发现装配。借用 Query 永无关闭权；新增 owned 进程的准入/真实 exit/跨 workspace 接续由既有 C5 生命周期工作线提供 lease/barrier，本稿不重设计 main/registry 生命周期。

#### 6.1 现成初始化入口作为优先候选

候选 owned executor：借用现有 MessageChannel 模式或可取消空异步 input，**不 enqueue SDKUserMessage**；query 创建后立即读公开 `initializationResult().commands` 或 `supportedCommands()`，不用 for-await 等 `system/init`。只选一条 metadata flight，不重复调用两个 getter；不复制整个 initializationResult/account 到 store。

这直接规避插件层“必须先见 init 事件才能枚举”的等待耦合，不等于不 spawn CLI。用假 transport 验证初始化请求可在零 user 入队下独立返回；真实环境再确认 SessionStart hooks/MCP/API副作用。入口不成立就退回明确 unavailable，不编造私有 CLI 参数或直连 control channel。

probe 捕获自身 immutable applied context，来源永为 probe-candidate。是否能作为 chat initial-equivalent 需要真实 options＋加载集合对拍与 session-sensitive 反例，本案不先升级其权威。inline candidate 同样按 inline 规则，不取 chat selector。

#### 6.2 outcome 与 cleanup 分离

owned flight 由 `(catalogEpoch, fingerprint, candidateScope)` 去重，带唯一 flightId、subscriber集合、signal和外部 owned-resource lease。相同 fingerprint 只证明共享候选工作的输入，不把不同 target Query 权威合并。

| 事件 | discovery outcome | 清理/发布规则 |
|---|---|---|
| 初始化返回 `[]` | ready，原始 0 项 | 缓存该 candidate 成功空；随后主动 close/abort 属成功后的清理，不改称 cancelled |
| SDK/spawn/metadata 拒绝 | failed(stage/code/retryability) | 全出口 finally 向 lease 请求关闭；不吞错成空成功 |
| stdout EOF 且没成功响应 | failed，`eof-before-initialization` | EOF 不是正常空，也不是真实 child exit |
| 一个 subscriber取消/隐藏 | 该 caller cancelled | 退订，不中止仍有订阅者的 flight；borrowed 永不 abort |
| 最后subscriber释放/源换代/catalog retire | 对旧工作 cancelled 或 stale（资格变化） | 只关闭 owned lease。新 scope 不等待旧调用成功，也不继承其结果 |
| deadline到期 | failed，`deadline-exceeded` | 请求 owned cleanup；不是 ready-empty，不暗设 MCP cap |
| SDK结果迟到/旧 finally | stale/no-op | 核 epoch＋flightId，不覆盖新 snapshot、不清新 flight |
| close/abort返回但 exit 未证 | discovery 与 cleanup 分别保留；cleanup-pending/failed | 不称资源释放成功、不自动 Retry 叠进程；即使 metadata ready也不能释放资源barrier |

调用取消优先于给该 caller 返回成功；owner 已撤资格则 stale；只有仍有资格才能返回 ready。需要用显式 cause 标识成功后自清理，不能靠异常字符串猜 abort 是用户取消还是 ordinary failure。

flight completion 的错误、回调、timer、abort listener、input waiter 必须被观察并由各自 owner清理。store 操作只消费 lease 状态，不猜 PID、不杀共享 MCP、不调用 chat cleanup。

#### 6.3 启用门

新增 owned probe 生产启用必须有：明确 finite hard lifecycle policy、原 child exit/已知 owned 后代处置证据、跨 catalog/registry 换代后旧 barrier 接续合同、获准真实环境/预算及副作用范围。UI 提示 deadline、flight hard deadline、MCP timeout/cap三者分开；不继承“30秒/5秒”，不修改用户 MCP_TIMEOUT、chat env。

无该 lease 能力/未裁决时 source 返回 unavailable 原因，不能新开无限 flight。旧 probe 是否提前禁用或保留为未保证 legacy 路径是产品/上线选择，不能由 P2 默默裁决。

### 7. 分期、顺序与独立验收

| 批次 | 可交付范围 | 独立绿判据与未关门 |
|---|---|---|
| P0 冻结证据 | 主会话确认整合者、并发文件边界、实际基线和未决策略清单 | 不 stash/reset/覆盖他人改动；保留本轮 runtime 指纹/E1证据；只读定位不当 UI实证 |
| P1 Query 单元 | actual Query cell、同 Query flight、成功空缓存、撤资格/取消、旧请求不返回新数据；数组兼容壳 | 真生产 runtime 调用链红转绿；SDK函数计数和返回结果可独立验收。不依赖 store、probe资源、Stop 或授权改造 |
| P2a 合同/store/context | 公共 optional facade、来源分区、目标版本、receipt、原始/可见计数、fallback outcome；无进程的 reducer/订阅测试 | ready-empty不探测、scope不混用、旧结果/旧finally不发布；不是“真实probe已通过” |
| P2b 全入口消费 | manager＋Tab后备＋inline＋Dropdown 新接口；CRUD失效；保留同名/name-hidden及非Claude行为 | 真实组件链测试证明非空fallback不锁缓存，query revoke即receipt失效，选择旧项失败；主聊天/inline两端覆盖。借用runtime/vault路径可独立验收，cold owned路径仍受P3门 |
| P3a probe host协议 | init-first零user入队、structured outcome、subscriber cancel、owned lease接线，假transport资源矩阵 | 主机协议可独立验收；不因假 exit 通过就称真实费用/后代保证 |
| P3b owned生产启用 | 获批policy＋生命周期工作线lease/barrier＋安全真实对拍 | 完成真实init/exit/副作用/冷入口矩阵；不达门则No-Go，不以下一批兜底 |
| P4 产品/原生增强 | 经用户裁决的candidate/partial/ready-empty/同名策略；另批SDK升级或有意reload | 按各来源/trigger验证，不改变P1/P2身份合同；未定项不启用 |

依赖单向：P1→P2a→P2b；P2a→P3a→P3b；owned生产启用还依赖外部 C5 lease/barrier和用户policy。P2b/P3a可分别开发并独立验证，不要求先完成无关 Stop/result/审批/业务 writer。**整个 cold 入口的完成声明必须同时通过 P2b＋P3b**。

可以先落地P1；P2纯状态和无进程集成也可实施。若希望 P2 整体先上线，需用户明确选择 cold probe 暂不支持或保留旧探测的已知限制；未确认不得自行关闭旧路径，也不得在缺有限生命周期时冒称全入口完成。

### 8. 方案推演

#### 8.1 同对象跨步骤、规则求值与反例〔纯示意，非实测〕

以下数字都是锚值；绿为设计要求，红为任一相反现象。E1 的既有动态读数另列，不与示意混记。

| 输入/时序 | 当前/既有读数 | 目标链及绿判据 |
|---|---|---|
| Q1 已缓存 `[old]`，retire，Q2创建但未init；Q2初始化会返回 `[new]` | E1〔既有读数〕during/after都 `[old]`，Q2调用0 | Q1 cell撤资格→catalog原 sourceRef失效→Dropdown旧receipt失效；Q2 read只join Q2 flight。退役窗口旧项0，新完成后 `[new]`，Q2 getter1次；出现old即红 |
| 同Q连续public×2＋init×1，SDK成功 `[]` | 受控测试〔既有读数〕最多3次getter | 同cell pending共用→ready([])，SDK getter合计1；store runtime outcome ready/raw0，而非failed。再输入不触发新query/probe；次数>1即红 |
| 第一次失败且vault有 `[review]`，随后相同目标通过新有效source得到 `[deploy]` | 源码推算：Dropdown可先锁review；是否实际发生未测 | 第一次receipt=failed＋vault fallback；新source change→旧receipt失效→read返回deploy。UI仍合适trigger时显示deploy，review不能以缓存成功压住它。caller并发数不等同spawn次数 |
| Q1 read pending；换Q2并ready `[new]`；Q1迟到 `[old]` | 既有测试允许旧request收到新cache `[new]` | Q1 request返回stale，Q2保持new；旧finally不清Q2。旧request返回ready(new/old)均红，防串scope不仅防写污染 |
| raw为 `[cost]`，name-hidden投影后0，vault `[review]` | 当前回vault，与raw空无差别 | 原observation ready/raw1/visible0；fallbackReason=policy-empty。getter仍1，raw不清；把raw记0或再probe即红。是否显示review保持旧policy，非本稿新裁决 |
| 同workspace：A scope `/dir-a`、Q-A=`[alpha]`；B scope `/dir-b`、Q-B=`[beta]`；B先完成，A后完成 | 当前各合法caller写同catalog数组，存在串读可能〔推算〕 | sourceRef/target分区；A仅alpha、B仅beta、inline不读二者current权威。任一相反即红；更晚publishedRevision不是更鲜证据 |
| 2 subscribers共用owned candidate；S1取消，S2仍等待；S2成功空后主动abort清理 | 尚无动态证据 | S1=cancelled，S2=ready(raw0)，spawn1；S1不得触发close。成功后的自abort不改S2 cancelled。最后lease未exit时barrier保留；提前清barrier即红 |
| modal A→B→A相同字段值；原A结果迟到；旧项Enter | 当前requestId仅在部分UI变化处更新 | 原对象/targetRevision/receipt均核验；回到同值也不复活旧session，旧Enter插入0次。只比JSON或名称会失败 |

#### 8.2 论证链与反例

1. **缓存缺陷因果链**：裸数组丢失发现状态→catalog fallback产生非空数组→Dropdown length置成功→后续输入不再read来源→更新被隐藏。隐含前提是期间没有reset/provider-switch或其它失效事件。具体反例：第一次fallback后立即resetSdkSkillsCache，下一次取得hot列表，则不锁死；因此只能判定机制可导致，不声称所有UI场景必现。
2. **revision不够**：publishedRevision表示一次接受/投影变化→可废消费回执；但它既不证明source成功，也不证明target范围相同→不能决定哪项是权威。反例：低权威probe在Q1热列表之后发布更大revision仍不允许删除Q1项。
3. **init-first可规避等待**：installed公开getter读构造时启动的初始化promise→插件可在零user入队下请求初始化元数据→无需先读system/init。隐含前提是实际CLI此模式会完成initialize。反例：CLI只在首个user消息后返回所需列表或启动hook永久pending，则推理最后一步不成立；P3真实门失败，不补发一个空user消息来冒充无副作用证明。
4. **Q身份不等于context等价**：Query独立token能排除旧完成→只能证明当前Query归属；不能证明UI新目录已被当前Query加载。反例：UI增加dir-b但Query仍使用dir-a，则ready是dir-a初始化观测、desired/applied不等，应降为范围不匹配，不宣称dir-b全集。

本稿不翻案任何已关账上线结论；E1是受控失败证据，未关账UI实证。前向反事实：即使真实环境从不走watchdog退役，P1仍需成功空/失败区分；即使所有fallback都是空，scope串读与旧request取得新数据仍需P2合同。

#### 8.3 结构不变量判定

| 不变量 | 判定/位置 |
|---|---|
| 正交性 | 成立于目标：cell管Query观测，store管来源/receipt，UI管输入；发现status、coverage、cleanup三轴独立。当前length/status/visible混用违反于runtime/catalog/Dropdown |
| 数据流无环 | 成立：执行选项纯描述→runtime/probe observation→store projection→UI；事件只使receipt失效。catalog不调用manager、UI不反写runtime缓存；禁止read隐式启动chat防循环 |
| 扩展点方向 | 成立：未来push/native-reload接provider source adapter；现行name-hidden/候选展示是catalog policy；不是在Dropdown追加按provider猜状态 |
| 退化是一般情况特例 | 成立：ready([])是ready snapshot的空数组；没有runtime是unavailable，不另用假空模拟；vault扫描是独立来源，不是runtime失败的“成功” |
| 多入口覆盖 | 目标矩阵见验证方式；manager主路径、Tab后备、inline缺一即违反。旧数组legacy明确在已迁Claude合同之外，不虚报统一完毕 |
| 取消权限 | 成立：subscriber只取消自身；runtime生命周期拥有borrowed Query，owned lease拥有probe。不能让DropDown destroy误杀chat |
| 版本可接续 | P1/P2单catalog内可由token保证；新增owned跨workspace资源接续**未成立**，归外部C5门，不能以新catalogEpoch假释旧进程 |

### 9. 交付物规范

#### 9.1 目标目录树（新增部分；本轮只新增设计记录）

绝对根 `/Users/vincentwang/Documents/NoteVault/tools/claudian`：

```text
docs/designs/
  2026-11-08-command-discovery-query-scope-receipt-contract.md
src/core/providers/commands/
  ProviderCommandDiscovery.ts
  ProviderCommandDiscoveryStore.ts
src/providers/claude/commands/
  ClaudeCommandContext.ts
tests/unit/core/providers/commands/
  ProviderCommandDiscoveryStore.test.ts
tests/unit/providers/claude/runtime/
  QueryCommandDiscovery.test.ts
tests/unit/providers/claude/commands/
  ClaudeCommandContext.test.ts
tests/integration/features/chat/
  commandDiscoveryReceipt.test.ts
tests/integration/features/inline-edit/
  commandDiscoveryReceipt.test.ts
```

已有目录内加文件；是否需要新叶目录由最终基线决定。临时脚本/模拟资产只落 `/tmp` 或派单指定临时目录，不落仓库业务目录，不作为交付物。

#### 9.2 命名与索引

`ProviderCommand*` 是中立合同/状态，不承载Claude wire；`ClaudeCommand*` 是provider描述；`QueryCommandDiscovery` 针对实际Query资格；`commandDiscoveryReceipt` 针对组件生产链而非mock被测行为。设计文件日期＋主题slug，首版不加v1。

落地整合者在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/README.md` 增加命令发现产物/回归索引（设计、模块、测试、适用入口、仍未关门）。本轮权限只落designs，不改README；不得登记未创建模块为已交付。

#### 9.3 产物清单：绝对路径、用途、消费者

| 路径 | 用途/消费者 |
|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-08-command-discovery-query-scope-receipt-contract.md` | 本轮草案；主会话、独立architect复核、implementer |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/commands/ProviderCommandDiscovery.ts` | optional facade、outcome、scope/receipt合同；runtime/catalog/feature |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/commands/ProviderCommandDiscoveryStore.ts` | 来源化观测/投影/订阅/ownedflight记录；Claude catalog |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/ClaudeCommandContext.ts` | 纯实际执行描述及差异；chat/probe/inline描述适配，不改执行政策 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/core/providers/commands/ProviderCommandDiscoveryStore.test.ts` | 空/失败/旧scope/receipt/flight红绿；实施与reviewer |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/QueryCommandDiscovery.test.ts` | P1真实runtime链；实施与reviewer |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/commands/ClaudeCommandContext.test.ts` | 各入口实际选项与scope对拍；实施与reviewer |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/commandDiscoveryReceipt.test.ts` | runtime→manager→catalog→Dropdown；实施与reviewer |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/inline-edit/commandDiscoveryReceipt.test.ts` | modal→catalog→Dropdown及借chat反例；实施与reviewer |

#### 9.4 归属引用与偏离声明

依据 `/Users/vincentwang/Documents/NoteVault/tools/claudian/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/CLAUDE.md`：provider-native优先，中立core、provider wire自有，tests镜像src。复用旧C5拟定store/context目录；未发现docs下独立convention/methodology。设计记录遵照vault architect规范，新测试索引沿README既有回归表风格；临时产物按派单 `/tmp`，不采用域文档的`.context/`一般建议。无其它目录偏离。

## 风险与权衡

### 1. 已确定、可派实施的技术部分

- P1实际Query cell/成功空/单flight/撤命令资格/旧caller不取新data，不改变资源生命周期。
- P2来源化结果/目标分区、单调消费回执、Claude不再write-array/read-global、无Dropdown二级成功缓存、raw/visible分离。
- inline描述必须来自实际执行规则；不借chat selector、不改inline执行权限/目录。
- failed/cancelled/stale/unavailable不是ready-empty；successful cleanup abort不是caller取消；borrowed/owned权限隔离。
- 保留已有名称过滤/去重、vault CRUD、非Claude行为及并发session guard。以上可实现和无真实进程验证；完整cold上线门另算。

### 2. 需要用户裁决，不是既定需求

1. **成功空/过滤空的fallback**：保留目前vault fallback并标来源，还是只显示当前Query观测范围？本稿推荐显式来源且不冒充当前可执行；不自动选择哪种展示。
2. **candidate/partial的展示和插入**：展示带范围提示并允许插入，或只展示已观测范围？SDK初始化条目无origin/覆盖水位时怎样提示；“不默认保证当前可执行”是事实底线，不等于默认全部禁用。
3. **同名hidden/local built-in碰撞**：接受现有名称级政策、只解决可证vault范围，或另批升级原生builtin证据？不能用名称猜来源满足只隐藏内置。
4. **owned probe策略**：允许哪些配置/hooks/MCP副作用、真实证据预算，finite hard生命周期和失败后retry政策；UI等待提示是否允许fallback。数值需实测/裁决，不本稿填默认秒数。
5. **分期上线范围**：是否先启P1和已验收borrowed/vault链；cold probe在P3前暂不支持或保留旧限制？未确认不自行禁用/扩大旧probe。
6. **原生刷新**：是否另批SDK升级、主动reloadPlugins或能力适配？打开菜单不是用户同意reload会话。

### 3. 技术风险及迁移/落地代价

- 混合脏工作树＋共享Tab/Dropdown/types使机械覆盖风险高；须窄diff串行整合，独立复核后实施。设计复核与实施reviewer分别做，不让设计者自己代第二意见。
- optional合同能分期迁移，但Claude所有入口必须一次接完整后才称P2b完成；legacy壳永久留在Claude链会继续吞状态。
- 本案不保证磁盘编辑/MCP变化即时可见；P1只保证本Query初始化观测正确归属。UI请求号、catalog revision、目录fingerprint均不是上游水位。
- 默认现行hidden/fallback的兼容并不代表政策合理；本稿把缺陷暴露而不偷改用户策略。
- 代价是三个窄新模块、runtime和双入口消费接线、生产链红绿测试；不持久化目录缓存、不加第三方依赖、不改Stop/权限/历史/任务模型。owned资源真实验收成本独立，不因成本取消正确性门。

## 验证方式

### 1. 本轮完成与未完成

本轮完成只读源码/设计/installed SDK/临时证据核查与方案推演；没有运行测试或真实CLI，没有UI现场证明。E1引用既有受控读数。纸面绿判据不是已通过验收。

先派独立architect复核本记录：只挑身份、scope、分期依赖、未决策略和source权限硬伤，不重做无关设计；用户确认后按批派implementer，交付正确性改动后派reviewer。

### 2. 确定性TDD，必须走生产链

仅mock SDK getter/输出来控制transport，不mock `getSupportedCommands`、catalog policy、manager discovery接线或Dropdown被测行为。复用临时证据测试中的真实runtime创建/公开读入口；禁止靠手工set缓存证明getter正常。可用fake process/exit作为host协议靶子，但单独标注，不能充真实资源验收。

P1至少覆盖：

- public×2＋init并发成功空：SDK getter1次；连续ready-empty命中；失败与无Query明确不同。
- 强制close、watchdog retirement、reset/switch/cleanup、init getter迟到、consumer旧finally：同Query/异Query资格准确；during旧项0。
- Q1 pending→Q2 ready→Q1 resolve/reject：Q1 caller stale，Q2 snapshot不变，新flight不被旧finally清。
- 单caller取消不abort borrowed Query、不影响其它caller；原cell撤资格能立即结束host等待，迟到rejection被观察，无未处理promise。
- 不改existing query.close/spawn/turn settlement/start prohibition调用计数/顺序；P1不关闭任何Stop/生命周期门。

P2/P3至少覆盖：

- runtime ready-empty与failed/unavailable/stale/cancelled映射；fallback非空不变runtime成功；raw1/visible0不变raw0。
- 开Dropdown获得vault fallback后新source ready/revoke；不reset组件也更新，输入继续筛选正确；旧receipt点击/Enter插入0次。
- 同provider不同tab scope与并发完成、registry实例替换、target ABA；Tab后备与inline不读错误全局列表。
- vault保存/删除成功失效，失败不更新success receipt；外部文件变化未watch时不宣称自动更新。
- probe零user入队，在未发system/init的fake SDK下initialize response完成；普通SDK/spawn失败、EOF、截止、cancel与成功后cleanup abort分类准确。
- 2 subscriber共flight、一个释放/最后释放、oldfinally、cleanup-pending、lease未退出不得新启动；所有 listener/timer/input waiter可机械核对。
- Codex `$`、OpenCode原数组、built-in prefix/排序/去重/name-hidden输出对拍；不增加非Claude的SDK/CLI请求频率。

### 3. 入口×机制覆盖矩阵

每格最终提交者记录 pass/fail/N/A＋用例，不以单runtime绿覆盖整链。

| 入口 | 来源/scope | receipt/空/失败 | cancel/旧结果 | 不越权启动/关闭 |
|---|---|---|---|---|
| Main目标ready Query | actual token＋applied/unknown | Query→catalog→Dropdown | revoke/迟到/init并发 | borrowed不得close/ensureReady |
| Main冷/blank | target声明＋candidate/vault | failure/成功空fallback | subscriber/换tab | 完整owned启用需P3b |
| Main同provider另一tab | 不能升target权威 | candidate不覆hot | 同域并发 | 不重启借用tab |
| Tab registry直读后备 | 同openDiscovery合同 | 不回全局数组 | manager/provider换代 | 不绕暖启动门 |
| Inline新modal/继续编辑 | 实际inline applied，非chat selector | 同receipt/policy | modal关闭/ABA/设置变化 | 不abort chat；owned同门 |
| Settings CRUD | vault管理范围 | 成功扫描/失败/失效 | 保存失败不发布新成功 | 不启query |
| Query natural重建/init | 新sourceRef，不复用旧资格 | 合法空取代同源旧观测 | 旧request stale | 不改变原rebuild策略 |
| legacy非Claude | 原能力原scope | 不伪造complete | 原guard等价回归 | 请求频率/资源政策不变 |

### 4. 获准实施后的命令与证据存放

本段为交接命令，本轮未执行。生产代码整合者先冻结副本；测试运行环境复用已核验的 SDK mock/child-process/network guard，HOME/USERPROFILE/TMPDIR/TEST_VAULT指向新建安全临时目录，禁止真实spawn。既有临时guard若不存在或不兼容，则先派runner核验测试隔离，不用真实CLI兜底。

```bash
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run test -- --selectProjects unit --runInBand --runTestsByPath \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/QueryCommandDiscovery.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/core/providers/commands/ProviderCommandDiscoveryStore.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/commands/ClaudeCommandContext.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/commands/ClaudeCommandCatalog.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/commands/probeRuntimeCommands.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/shared/components/SlashCommandDropdown.provider.test.ts

npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run test -- --selectProjects integration --runInBand --runTestsByPath \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/commandDiscoveryReceipt.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/inline-edit/commandDiscoveryReceipt.test.ts

npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run typecheck
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run lint
```

另回归既有 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/TabManager.test.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/Tab.test.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/inline-edit/ui/InlineEditModal.test.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/ClaudianService.test.ts` 及 provider catalog/dropdown suites。按实际批次运行已创建文件，不能把计划中的路径当已存在。build/部署/commit/push另由主会话授权，本任务不执行。

真实P3b需另外授权后在安全vault核：零user输入的initialize可完成；spawn→metadata、abort/close→实际exit；配置/hooks/MCP/API可观察副作用；chat cold与candidate双向集合/metadata差异；延期MCP/目录范围/同名反例。不测真实分布/发生频率就不报告覆盖率。输出按source/version/trigger逐项证据，不给笼统“热刷新支持”bool；未达门保留明确No-Go。

阶段证据记录目标绝对路径、实际基线指纹、red/green用例和命令、source token/receipt迁移、取消/cleanup状态；脱敏日志和一次性中间产物只放派单临时目录。README回归索引由落地者回填，无新业务日志目录。

## 关联

- [[tools/claudian/docs/designs/2026-11-07-upstream-compat-stop-permissions-discovery]]
- [[tools/claudian/docs/designs/2026-11-07-upstream-compat-evidence-closure-supplement]]
- [[tools/claudian/docs/designs/2026-11-08-upstream-compat-remaining-implementation-contract]]
- 官方现行文档：[Claude Agent SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript)；仅作为版本能力候选，当前行为以installed文本和对应实证为准。
