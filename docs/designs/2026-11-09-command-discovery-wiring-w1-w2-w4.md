---
type: design-decision
status: draft
date: 2026-11-09
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - claudian
  - command-discovery
  - implementation-contract
  - staged-integration
---

# 命令探测下游接线 W1 / W2 / W4 Implementation Plan

## 背景与问题

W0 已冻结类型、P1 已保护实际 Query 的命令 cell，但 catalog、manager 和 Dropdown 仍经数组传递，丢失失败/空值/来源与资格；本案贯通最小 typed 消费链，并以禁止生产 owned probe 规避尚未闭合的资源 owner 问题。

> [!warning] 边界与授权
> 路径为 `[务实]`。cold＝没有有资格的活动 Query，只展示 vault 与适用 builtin；不启动 owned probe，不借跨 tab 的全局 `sdkCommands`。目录实际变更后同步撤销旧命令请求资格，不能靠路径字符串相等抵御 ABA。
> 本文为新草案，不修改、不 supersede 任何既有记录，尤其不修改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-09-command-discovery-minimal-downstream-wiring.md`。旧稿关于 cold probe、Tab/Inline 无需改动、registry 只靠末尾 guard 的假设不作为实施依据。
> 本轮只新建本文，未改生产代码/测试/README，未派实施、build、部署、commit、push 或调用真实 SDK/CLI。下述新增 API、测试与步骤均为待实施设计。

## 方案设计

### 1. 实地基线与出入

代码根：`/Users/vincentwang/Documents/NoteVault/tools/claudian`。观察分支 `fix/model-identity-sorting`，HEAD `cf47730d2109e798fd27ddacc712038d26883d5b`；共享树有多条工作线的 tracked/untracked 改动。本记录不是树锁，实施前由 integrator 重新核对实际内容；禁止 reset/stash/整文件覆盖来制造干净基线。

2026-11-09T03:32Z 起核查。源码读数标为〔既有读数〕；命令实际运行标为〔实测〕；后文时序案例为〔纯示意〕，不是已完成实证。

| 位置（绝对路径） | 现有事实与本案处理 |
|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/commands/ProviderCommandDiscovery.ts:49–214` | W0 有五态来源结果、runtime eligibility、target/capture/binding、ready 双分支及 cancelled/stale 分支；三槽 coverage 与 vault/probe 不可 query-owned 已约束。**静态类型仍允许把 runtime cancelled/stale 包进 ready 投影，不能代替运行期禁发布规则。**不修改 W0。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/commands/ProviderCommandCatalog.ts:12–17`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/ChatRuntime.ts:63–64` | `createDiscoverySession? / openDropdownSession? / getCommandDiscovery?` 只是可选合同，不能据此认定生产已接线。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts:201–231,3381–3418,3458–3596` | P1 实现在这个大文件内，没有独立生产 `QueryCommandDiscovery.ts`。私有 typed cell、成功空缓存、single flight、独立 waiter 与撤资格已实现；**生产类尚无 `getCommandDiscovery()` 实现/命令订阅/source receipt**。W4 必须补只读 facet 旁路。“cancel撤资格”须区分：callerSignal只取消本waiter；普通runtime.cancel()发interrupt/启动watchdog，不直接revoke cell，后续真retire/exit/EOF才撤共享资格。不得为typed接线改掉P1这个边界。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/ClaudeCommandCatalog.ts:64–110` | 当前全局 `sdkCommands`，空则 probe、过滤后空则 vault；`listDropdownEntries` 与 `setRuntimeCommands` 都是 legacy。W1 新 session 与这个槽隔离，保留旧 API。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts:1266–1325,1556–1579` | 先看目标 runtime，runtime 不 ready 且无 loader 时借同 provider 别的 tab；随后按 length 补 loader、写全局槽再 list。**typed 分流必须先看 catalog 能力，runtime=null 也不得掉入 legacy。** |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/shared/components/SlashCommandDropdown.ts:84–94,194–199,218–260,415–433` | 有 requestId/disposed 防 late write，但 fetched 只记非空；reset 清缓存却未清已渲染可选项；插入前未核 receipt。W2 保留 legacy，新增 session 生命周期及同步撤销。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts:177–208,995–1000` | 后续 provider sync 有 registry fallback，**初始 `initializeTabUI` 没有 manager 时只拿 null，未走 fallback**。W4 补初始 fallback；不能声称仅 config 透传即可覆盖全部入口。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts:292–333,340–368,610–667,1453–1508,1985–1987` | runtime 安装/更换/摘除、conversation 被动绑定缺统一命令通知；`cleanupTabRuntime` 已有 reentry/原 runtime 身份保护，必须保留。W4 仅在实际字段提交点发命令通知，不重排通用清理。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts:944–958`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ui/InputToolbar.ts:543–679` | Tab onChange 只 preScan；add/remove 有 onChange，但 set/clear/持久路径 merge 没有；remove 持久路径先 persistence 再 onChange。只改 Tab 回调无法保护所有目录赋值。W4 必须统一有效目录提交，并把 onChange 移到 persistence 之前。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/ProviderWorkspaceRegistry.ts:41–70` | `initializeAll` 直接赋 services；set/delete/clear 无 revision、无同步通知。W4 让所有发布/摘除走同一命令槽提交机制。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/inline-edit/ui/InlineEditModal.ts:440–455,653–676` | Dropdown config 已透传，但 getter 闭包捕获原 catalog，缺替换订阅。它不是普通 Obsidian Modal 的 onClose 收尾；实际收尾是私有 `cleanup()`。W4 在这里退订。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts:217`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ClaudianView.ts` | Main blank 不是 main.ts 的独立命令 UI：生产链是 ClaudianView→TabManager→Tab→Dropdown。main.ts 只负责 registry bootstrap，本案不改 main.ts/ClaudianView。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/app/ClaudeWorkspaceServices.ts:58–62`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/probeRuntimeCommands.ts:54–85` | 生产 factory 仍注入旧 probe closure。helper 缺有限期限/直接子进程 exit 清理证据，init 后只 abort；本案**移除生产注入**，不修 executor、不把未启动写成 cleanup confirmed。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/storage/SlashCommandStorage.ts:10–32`；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/storage/SkillStorage.ts:10–42` | 两个 loadAll 内部吞错。vault 正常返回只代表 best-effort 读数，不能证明完整成功或区分真空/被吞磁盘错误。不改 storage。 |

已运行基线〔实测〕：命令合同/P1/catalog/probe/Dropdown/registry 共 7 suites、114 tests 通过；TabManager/Tab/InputToolbar/Inline 两个 suites 共 5 suites、537 tests 通过；ExternalContextSelector 1 suite、39 tests 通过。合计 **13 suites / 690 tests**。`npm run typecheck` exit=0。全局 lint exit=1，唯一当时读数为 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/history/ClaudeTranscriptHistoryIndex.test.ts:611:3` 的 `no-unexpected-multiline`；属于共享树既有阻断，不由本案顺手修复。未跑完整 test/build/实机，不声称新方案已验证。

关键指纹〔实测，供交接比较，不是冻结〕：

| 文件（绝对路径） | SHA-256 |
|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/commands/ProviderCommandDiscovery.ts` | `468a60ec3508408106d5480bebe199d13ce7f7738769b0667260f6fbc0103ba6` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts` | `ae10874514c77f62f44dc902a980e83f90df90e38e0507ff5ebd1d97a249238d` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts` | `13eecee1ae987996a833a2d0df621f5d129c73fd26ab0faca1419f0e98dfb6c5` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts` | `0abb15c43c1203ee587a5fed7fd843f1e35ab79e6433e94b5e2bdfe179004347` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/shared/components/SlashCommandDropdown.ts` | `5c9d6e769499ea0bc371816904cb0fcd9a05a07f4ce3835c3c66bef290e06da7` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-09-command-discovery-minimal-downstream-wiring.md` | `17036e7d34a6e0dd32fdfdafdb08cfbf9b725d91a4dd8566fbbdeead61844c61` |

### 2. 解层次、选型与冻结语义

资源清理矛盾不在“换一个 timeout”层解决：上移到准入策略，cold 不需要拥有替身 Query，就不产生这个 owner 难点。复用已有 W0、P1、config 透传、manager ticket/generation、Dropdown requestId、vault storage 与 builtin。**不建通用 store，不升级 SDK，不新增 probe executor。**

| 候选 | 取舍 |
|---|---|
| 继续数组＋empty sentinel/更宽 fetched 条件 | 不能恢复 failed/unavailable/cancelled/source，无法可靠抵御同 runtime 的无 Query→新 Query；拒绝。 |
| **每个 Dropdown 一个 typed session＋命令专用通知＋生产禁 probe** | 完整覆盖本次资格与 cold 裁决，复用现成合同；推荐。 |
| 完整 discovery store＋稳定 owned probe owner | 能扩资源生命周期，但不是本次需求；未有 owner 不启用，不以未来实现作当前前提。 |

#### 2.1 必须原样消费的 W0 合同

- `CommandDropdownSnapshot.status === 'ready'` 有两个分支，共用判别值。须进一步查 **`snapshot.runtime.status === 'not-attempted'`**：此时 receipt.runtimeEligibility 必须为 null；否则必须为这次 `RuntimeCommandRead.eligibility` **同一个对象**，不得重建 `{token, revision}`。
- `runtime=null` 的 tab 和 unbound 属 not-attempted；有 runtime facet、但没可读 Query 属 attempted `unavailable`，携 eligibility。缺 facet 的 runtime 不可冒造 query source；typed catalog 仍只走 not-attempted/vault，不能回退数组。
- Runtime 的 cancelled/stale 必须提升为外层 cancelled/stale：entries=[]、receipt=null。W0 可构造 ready(cancelled/stale) 只是结构兼容，不是生产许可。
- callerSignal abort＝cancelled；target eligibilitySignal / session invalidate / source revoke＝stale；release 后的新 read＝stale。双信号都已失效时 caller abort 优先，但两者都不发布。
- 只有 query receipt 可标 query-owned；vault 默认 unverified，已观测范围不等才用 scope-mismatch。路径相同不证明全配置等价。
- sourceRefs 是来源读数及关系，不是执行保证。coverage runtime 仅 initialize-observed，probe 始终 null，vault 仅 best-effort-unknown；未知配置维度保留 unknown。
- rawCount/catalogVisibleCount 的 null＝该槽无有效 ready 读数；0＝确实读到 ready-empty。catalogVisibleCount 在 catalog 固定 hidden 规则之后、Dropdown 用户 hidden/search/builtin 去重之前计数。

#### 2.2 投影求值序（版本 1）

Builtin 继续由 Dropdown 在 `/` 且位置 0 合成；不进入来源计数/receipt，不新增 UI 文案。

| 原 runtime 结果 | catalog 投影 | probe / fallbackReason |
|---|---|---|
| unbound 或 tab runtime=null/缺 facet | vault best-effort；runtime=not-attempted、receipt.runtimeEligibility=null | not-attempted / `unbound` 或 `runtime-not-attempted` |
| facet read unavailable | vault best-effort；保留 unavailable 和其 eligibility | not-attempted / `runtime-unavailable` |
| facet read ready、raw>0 且 catalog 过滤后>0 | 原 Query entries，不再额外扫 vault | not-attempted / null |
| facet read ready、raw=0 | vault best-effort；保留 runtime ready-empty | not-attempted / `runtime-empty` |
| facet read ready、raw>0 但固定 hidden 后0 | vault best-effort；保留 raw 与 ready | not-attempted / `name-policy-empty` |
| facet read failed | vault best-effort；保留 failed/code/eligibility，不自动 retry | not-attempted / `runtime-failed` |
| caller cancelled、target/source/session stale | 不扫新的 fallback、不发布旧 vault 晚到；外层 cancelled/stale | not-attempted；receipt=null |

所有行 `probeCleanup={status:'not-started',reason:'owned-probe-disabled'}`。不能用 not-started 代替已经启动的历史 probe 清理事实。vault 显式 throw 登记 failed；正常返回仍只有 best-effort-unknown。vault 也空时可发布 ready 空投影，仍保留原 runtime/vault outcome，UI 只剩适用 builtin。

目录变更仅撤消费资格，**不强制关闭/重启实际 Query**。新的 read 若仍观测到旧 Query，scope 必须取它创建时的 applied options，不能用 selector 的新目录冒充；观测目录与请求目录明确不一致时标 scope-mismatch。此片不新增“保证新目录立即出现命令”的承诺，不修改现有 restart 策略。

### 3. 分片依赖、所有权与合流门

| 分片 | 文件所有权 | 依赖与可并行性 |
|---|---|---|
| W1 | ClaudeCommandCatalog＋其单测 | 仅依赖已存在 W0；用假的 runtime facet/target capture 测试生产 session。与 W2 文件不重叠，可并行开发。 |
| W2 | SlashCommandDropdown＋其两份现有单测 | 仅依赖 W0 可选 factory；用假的 session 测生产 UI。与 W1 可并行开发，不等待真实 manager。 |
| W4 | runtime facet、manager/Tab/目录、registry、factory、Inline；对应测试＋跨入口 integration | **唯一 integrator 串行实施、串行接收 W1/W2 并负责生产合流**。不让其他 worker同时改这些文件或共享 mock。 |

W1/W2 开发完成只表示独立单测可过，**不允许单片部署**。W1 的 factory 只在最终生产合流启用完整链；W2 没有 factory 时维持 legacy。W4 未关生产 probe 注入、未完成目录/registry/runtime 通知前，W1＋W2 也不能生产放行。

推荐闸门：G0 重核共享树/W0/P1 → W1∥W2 分片红绿测试 → integrator 串行 W4a runtime → W4b registry/factory → W4c manager/Tab/目录 → W4d Inline/入口合流 → G1 全定向测试/typecheck/lint → G2 全量 test/build → G3 实机。无需也不得为此自行启用 workflow/worktree。

### 4. W1：catalog typed 接线与 cold 策略

**修改生产文件** `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/ClaudeCommandCatalog.ts`；**修改测试** `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/commands/ClaudeCommandCatalog.test.ts`。不改 runtime、manager、Dropdown、W0、probe helper。

#### 4.1 消费/产出接口

- 消费 W0：`CommandTargetCapture`、`CommandCatalogRegistryBinding`、`RuntimeCommandDiscovery`、`CommandDropdownSession` 等现成类型。
- 实现 `openDropdownSession(targetCapture?: CommandTargetCapture): CommandDropdownSession`。
- `getDropdownConfig()` 加 `createDiscoverySession: () => this.openDropdownSession()`，默认明确 unbound，不查 active tab、不读全局 sdkCommands。
- constructor 保留现有前三参数；第四可选参数为 `registryBinding?: CommandCatalogRegistryBinding`。独立实例缺 binding 时用 revision=0/current=true/no-op subscription；生产 factory 必须由 W4 传真实 binding。旧 probe 参数只服务 legacy list，typed session 从不调用。
- 同文件内薄 session；不新增生产文件。`setRuntimeCommands/listDropdownEntries/ensureProbed` 仍为 legacy，typed 观察不得写回它们。`listVaultEntries` 和已有转换函数复用。

#### 4.2 实施步骤与行为

- [ ] 先补下表失败单测，运行 W1 定向命令，确认旧代码没有 session/行为不符合。
- [ ] session 持有独立 epoch/revision、当前投影 receipt、当前 target/facet 订阅及 waiter；catalog 持独立 catalogToken、vaultRevision、活 session 集。复用相同 catalog 的 storage，但不共享 Query 投影。
- [ ] 每次 read 首次 await 前冻结 target capture、registry revision、session epoch/revision、原 runtime/facet。先订阅原 facet，再读 `facet.read(waiterSignal,{retryFailed:false})`；不以 `runtime.isReady()` 代替资格合同。
- [ ] fallback 开始前、每次 await 后、缓存提交前核同一冻结上下文。attempted 结果还核 `facet.isCurrent(runtime.eligibility)`，即使结果是 failed/unavailable 也核。用原 eligibility 对象构造 receipt。
- [ ] vault flight/cache 仅对本 session 当前资格及 catalog vaultRevision 有效；允许 single flight，包括成功空。晚到原 vault 可被观察/结算，但不能写入新的 session cache。投影缓存不可让 read 跳过当前 target/facet 资格核对。
- [ ] `subscribe` 通知先推进 sessionRevision、作废旧 receipt、结算该 session 旧 waiter，再调用 listener；**listener 只表示失效，不同步调用 SDK/read**。有新 target 时退订旧 facet，在下一 read 绑定新 facet。
- [ ] `invalidate` 推进 epoch/revision，同步撤 receipt/当前 waiter/投影；不 release 整个 session。`release` 幂等、退订 target/facet/registry、从 catalog 集合摘除、结算全部 waiter；不 close/interrupt/abort borrowed Query owner。
- [ ] 即使 vault/SDK promise 永久 pending，caller abort/target abort/invalidate/release 也要独立结算 session waiter。底层 promise 安装成功/失败观察，避免迟到 reject 成为 unhandled；不以底层 promise 真结束为资格撤销前提。
- [ ] vault CRUD 成功及 `refresh()` 推进本 catalog vaultRevision，并通知 session 失效；失败 CRUD 不伪造成功更新。外部文件变更仍依赖既有 refresh 调用，不加 watcher。
- [ ] 跑 W1 红绿与既有 catalog suite；复核 legacy 隔离、empty/count/sourceRefs，再交 integrator。不直接部署。

#### 4.3 W1 单元测试设计

测试文件均为 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/commands/ClaudeCommandCatalog.test.ts`；新增 describe `typed dropdown session`。

| 用例名 | 输入与断言 |
|---|---|
| `opens independent unbound sessions without reading legacy runtime commands or probing` | 预先 setRuntimeCommands([foreign])、注入 probe spy；开两个 session，各自 vault entries，runtime not-attempted/eligibility null，probe=0，foreign 不出现，一个 release 不影响另一个。 |
| `keeps attempted unavailable eligibility over the vault fallback` | fake facet unavailable(E0)，vault 1 项；snapshot ready 但 runtime unavailable；receipt.runtimeEligibility **toBe(E0)**；sourceRefs vault unverified；raw.runtime=null/raw.vault=1，coverage.runtime=null。 |
| `preserves ready empty and hidden-to-empty without retry or probe` | 参数化 raw=[] 与 raw=[cost]；vault 1 项；runtime ready，runtime raw=0/1、visible=0，fallbackReason 分别 runtime-empty/name-policy-empty；SDK read 不自动 retry、probe=0。 |
| `preserves failed outcome while rendering a best effort vault fallback` | failed/code＋E0；保留失败，read options retryFailed=false，后续输入不自动重试；vault 空也不升格 runtime。 |
| `rejects old unavailable vault completion after a new Query becomes eligible` | read unavailable(E0)，挂起 vault；facet 发布新 Query(E1) 通知；旧 waiter stale/null receipt，旧 vault 晚到不缓存；新 read 只含 Q1 entries，isCurrent(old receipt)=false。 |
| `never wraps runtime cancelled or stale as a ready projection` | 两种 runtime 结果参数化；外层对应状态、entries=[]、receipt=null、未开始新 vault fallback。 |
| `settles caller and released session while a vault scan remains pending` | 永久 pending vault；caller abort→cancelled、invalidate/release→stale，均可在确定测试 deadline 内结算；不关闭 borrowed Query，晚到 reject 无 unhandled。 |
| `invalidates receipts on target registry and vault revision changes` | 分别 target ticket/generation、registry replacement/clear、成功 save/delete/refresh；同步 isCurrent=false，旧 source/count 不流到新缓存。重复 release/退订幂等。 |

### 5. W2：SlashCommandDropdown 消费 session

**修改生产文件** `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/shared/components/SlashCommandDropdown.ts`；**修改测试** `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/shared/components/SlashCommandDropdown.provider.test.ts` 和 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/shared/components/SlashCommandDropdown.test.ts`。不改 catalog、manager、Tab、registry、Inline、共享 mock。

#### 5.1 接口与生命周期

保留 options.getProviderEntries。config 有 `createDiscoverySession` 就走 typed，不按 provider 名分支；没有 factory 的 Codex/OpenCode/legacy 保持原调用频率与数组缓存。

为 W4 的 catalog 摘除补一个向后兼容能力：`setProviderCatalog(config: ProviderCommandDropdownConfig | null, getEntries: (() => Promise<ProviderCommandEntry[]>) | null): void`，既有两实参调用不变。null 表示清掉 provider callback/factory/entries，仍可保留适用 builtin；不得“仅 reset”而留住旧 catalog 闭包。

- [ ] 先补下表失败单测，核旧 requestId/disposed 测试仍绿。
- [ ] 构造和 setProviderCatalog 时每个 UI 独立创建 session并订阅；保存 session 身份及 lastSnapshot/receipt。替换先撤旧 request、清可选 DOM、退订/release，再安装新配置。
- [ ] 每次合法输入取消上一个 UI waiter，使用新 caller AbortController＋requestId，调用 session.read。typed 不使用 `providerEntriesFetched` 判断成功；ready-empty 也接受为投影，后续 read 由 session 验资格/复用缓存。
- [ ] await 后同时检查 disposed、requestId、原 session、`snapshot.status==='ready'`、`session.isCurrent(snapshot.receipt)`。外层 cancelled/stale 不写 cache、不 render、不转 fallback。
- [ ] session change 回调同步清 last receipt、cached entries、filteredItems、selectedIndex 及已显示的可选 DOM/旧 click 闭包资格；保留当前 trigger/search 的重新求值能力。增加 UI 自有 menu-interest 标记：合法输入请求菜单时置 true，hide/disabled/destroy 置 false；失效清 DOM 本身不清兴趣。仅在兴趣为 true、输入仍有合法 trigger且 enabled 时合并调度一次 microtask read。不能只按 isVisible 判定（首读 pending 尚无 DOM），也不能只看输入仍含 `/` 而重新打开用户已 hide 的菜单。
- [ ] read 完成引起 source change 可以使第一次 read stale；合并的下一次 read 使用 P1 ready cache。不得在 failed/empty 上自己 invalidate→read→invalidate 形成环；测试 SDK getter 1 次、稳定后 UI read 次数不持续增长。
- [ ] `selectItem()` 在改输入前核 session 身份和 receipt；旧 DOM click/Enter/Tab 均插入 0 次，不按同名匹配新条目。失效 UI 必须连旧 builtin 的选择闭包也清理，避免旧 index 指向新列表；用户重新看到当前列表后可选新 builtin。
- [ ] hide/setEnabled(false) 取消本 UI waiter并撤 requestId/可选闭包，不关闭 session owner；hide 不反向 invalidate 全部来源。resetSdkSkillsCache 兼容名称保留，typed 时还 session.invalidate/推进 epoch并同步撤 DOM；destroy 退订/release/abort，幂等。
- [ ] 复用原 builtin 合成、隐藏、排序、参数提示、insertPrefix/fixed 定位。typed DOM 的可观测 `data-command-runtime-status`、`data-command-fallback-reason`、`data-command-source-kinds` 只投影状态/枚举，不写 cwd、环境、opaque token，不新增“可执行”文案。
- [ ] 跑 W2 新旧两份 suite 后交 integrator；不派生产接线。

#### 5.2 W2 单元测试设计

新增用例落 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/shared/components/SlashCommandDropdown.provider.test.ts`；已有通用触发/键盘测试留原 suite。

| 用例名 | 断言要点 |
|---|---|
| `uses a typed factory instead of the legacy entries callback` | 同时提供 factory/getProviderEntries；每 UI factory一次，legacy getter=0，实际渲染 typed entries。 |
| `renders both ready branches without treating vault fallback as runtime success` | not-attempted/null eligibility 与 unavailable/同对象 eligibility 两样本；可见 vault/builtin，DOM runtime-status 不相同；ready-empty不反复 legacy fetch。 |
| `rejects cancelled stale and non-current ready snapshots` | 三样本均不提交 provider entry；旧 request promise 完成不得改新列表。 |
| `clears visible options synchronously before a refresh microtask` | ready 的旧 DOM 保存 click handler；触发 session change，在 flush 前 filtered/rendered旧命令已清；click/Enter/Tab不改输入/onSelect=0。 |
| `aborts only its waiter on hide and releases once on replacement or destruction` | hide abort但不 release/close；replace/destroy退订＋release各一次，旧结果不复活；第二 UI waiter不受影响。 |
| `keeps reset epochs distinct across A B A catalog contexts` | 配置A→B→A；旧A receipt永远不能插入；新A单独 receipt可消费。 |
| `coalesces source notifications without retries for stable empty or failed results` | 同步连续通知合并一次刷新；failed/ready-empty稳定后不自发 read；实际 SDK getter次数在合流测试断言1。 |
| `clears a removed provider catalog without retaining its factory` | setProviderCatalog(null,null) 后旧 getter/factory/read均不再调用；重装新config可重新展示。 |

### 6. W4：唯一 integrator 的串行接线

#### W4a：给 P1 加公开只读 facet，不改 cell 转移

**生产** `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts`；**测试** `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/QueryCommandDiscovery.test.ts`。

- [ ] 新增稳定 `getCommandDiscovery(): RuntimeCommandDiscovery` 旁路对象和独立命令 listener 集。私有 `readQueryCommands`、默认 retryFailed=true、数组壳的重试/clone 行为及原 getter/flight/waiter/revoke逻辑不改。
- [ ] facet.read 在 await 前捕获原可读 scope/cell；此前已 revoked/exit/EOF 的 cell 按 fresh no-readable-query 返回 unavailable(Eabsence)，不是新请求 stale。开始后原 cell 被撤才 stale；禁止晚到换绑 Q2。options.retryFailed 缺省按 typed 被动读取 false处理，显式 true才传给原私有读。
- [ ] 命令资格元数据与 P1 state 分离：runtime 实例的 absence 也有 opaque eligibility；scope 安装/更换/撤资格/摘除推进命令资格，使 Eabsence 在新 Query 建立时立即失效。仅 caller waiter取消不推进共享资格；getter完成推进 sourceRevision并通知，不要求改 P1 cell状态。
- [ ] facet.isCurrent 核当前命令资格对象/原 scope-cell identity与未 revoked。不能只看 Query ready 或 receipt是否存在；unavailable和failed的资格也必须可撤。
- [ ] `ensureQueryScope` 安装后通知；`finishQueryCommandFlight` 完成 cell提交后发 source通知；`revokeQueryCommands` 撤资格时通知；`closePersistentQuery/executeQueryRetirement` 实际摘除字段后也同步通知 absence。通知幂等、异常隔离、listener仅失效 UI，不同步重入 SDK。原 readyState通知时序不是命令资格替代品。
- [ ] 在生产 `startPersistentQuery` 的实际 options 与新 Query 关联时复制 cwd/additionalDirectories/settingSources白名单；receipt 的 scope/sourceToken绑定原 Query观察对象，不泄露 SDK Query。`ensureQueryScope` 测试惰性 attach 缺 applied options时列 unknown，不拿 mutable currentConfig补造。
- [ ] 添加测试后跑 P1整套，核 Stop/watchdog/EOF/exit/旧consumer等既有行为未变化。此片不调用 probe、不关闭 borrowed Query来取消命令 waiter。

新增用例（同一测试文件，独立 describe `public typed facet`）：

| 用例名 | 断言 |
|---|---|
| `invalidates unavailable eligibility when the same runtime installs a Query` | 真实 ClaudianService public facet先 unavailable(E0)；用原 mock SDK启动生产Query，事件同步使 isCurrent(E0)=false；新 read ready(E1)，不依赖 runtime对象更换。 |
| `reads the original Query and preserves ready empty with one getter flight` | 原 P1 fixture 两并发read＋init；getter=1；ready entries=[]、receipt.initialize-response/coverage固定；独立数组壳仍 clone。 |
| `does not retry a failed typed read unless explicitly requested` | typed默认/false复用失败；true可启动后来那一次getter；原 public数组重试用例原样通过。 |
| `revokes typed receipts on retire exit and EOF while caller cancellation stays isolated` | retire/exit/EOF参数化：旧eligibility立即无效、旧read stale，旧consumer finally/late child exit不撤Q2。另测callerSignal取消：仅该read cancelled，共享eligibility仍current、其他waiter可ready；不把普通runtime.cancel()的interrupt当成必然Query撤资格。 |
| `captures applied Query scope before later directory settings change` | options dirs=[A]，随后selector/settings变B；原Queryreceipt仍A；新Query才可记录B，unknown不被虚构填齐。 |

#### W4b：registry 命令槽提交与生产 factory 禁 probe

**生产** `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/ProviderWorkspaceRegistry.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/app/ClaudeWorkspaceServices.ts`。

**测试** `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/core/providers/ProviderWorkspaceRegistry.test.ts`；新增 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/app/ClaudeWorkspaceServices.test.ts`。

新增 registry 方法合同：

```typescript
static getCommandCatalogRevision(providerId: ProviderId): number;
static subscribeCommandCatalog(providerId: ProviderId, listener: () => void): () => void;
```

- [ ] 独立维护 provider→命令catalog最后发布引用/revision/listeners，revision只管命令槽，不用于 MCP/agent/全 workspace状态；不可在 clear 重置为0。
- [ ] `initializeAll` 的服务发布改调用 setServices；setServices 在实际替换/删除后先更新命令槽引用＋revision，再同步通知。即使原 services对象被原地修改，也使用独立保存的 catalog引用比较，不能从已被改的对象读取“旧catalog”。仅MCP变且catalog同对象不推进命令revision。
- [ ] clear先摘所有services、推进所有受影响命令revision，再通知；listener中 getCommandCatalog/getRevision立即见新值。跨provider不误伤；listener异常隔离，退订幂等。register registration不等于发布catalog，不乱推revision。
- [ ] 生产 `createClaudeWorkspaceServices` 移除 probeRuntimeCommands import及第三参数closure；第三参数留undefined，第四参数真实 CommandCatalogRegistryBinding：getRevision读上述revision，isCurrent核registry中catalog===原实例，subscribe读命令槽事件。factory构造期间不能提前消费尚未发布的binding。
- [ ] 不实例化 FrozenCommandProbeInput/TypedCommandProbe/owner executor，不新增 cleanup confirmed。`probeRuntimeCommands.ts` 与其legacy单测保持，只断开生产可达入口；不是宣称其资源问题已修复。

| 测试文件（绝对路径） | 用例名 / 断言 |
|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/core/providers/ProviderWorkspaceRegistry.test.ts` | `notifies command replacement synchronously after publishing services and revision`：callback内立即见新catalog/new revision。 |
| 同上 | `detects catalog replacement on a reused services object`：同services对象把C1改C2，revision仍增加。 |
| 同上 | `keeps command revisions monotonic across clear and A B A restoration`：旧C1＋旧revision不可复活；clear callback见全部已摘槽。 |
| 同上 | `does not notify command consumers for unrelated service or provider changes`：MCP改、其他provider改不通知本provider；unsubscribe/throwing listener不影响发布。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/app/ClaudeWorkspaceServices.test.ts` | `creates a production catalog whose cold session never calls SDK query or probe`：调用真实factory，仅mock storage/CLI外部依赖；把SDK query/probe设置为一旦调用就失败；open unbound及cold target，只见vault；probe/query调用=0。不可直接mock被测factory/catalog。 |
| 同上 | `binds production sessions to command registry replacement and removal`：真实factory＋真实registry；setServices安装后session可读，替换/clear旧receipt同步失效；退订后不再回调。 |

#### W4c：manager capture、Tab 通知与目录 ABA

**生产** `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ui/InputToolbar.ts`。

不改通用 Tab生命周期状态机/历史关账/持久化语义；不修改 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/types.ts`，优先同文件 WeakMap通知机制。

**Tab.ts 拟新增的命令专用观察点**：

```typescript
export function subscribeTabCommandContextChanges(tab: TabData, listener: () => void): () => void;
// 同文件私有：先通知manager/capture，再reset Dropdown。
function notifyTabCommandContextChanged(tab: TabData): void;
```

- [ ] manager在createTab完成TabData、initializeTabUI之前订阅Tab命令事件，退订放eventCleanups；订阅处理先 `invalidateProviderCommandState(tab)`。该方法复用generation/tickets/cache清理，新增abort旧资格controller、安装新controller、同步通知target capture listeners。
- [ ] manager targetCapture冻结原TabData对应opaque targetToken、ticket对象、generation、provider/runtime/contextKey、registryRevision、requestedExternalPaths副本；sessionEpoch由session传入。`isCurrent`保留原isTabActive/provider/TabData/ticket/generation/runtime/context检查再核registryrevision，不按tabId重新找一个对象。candidate tab沿现有isTabActive规则处理。
- [ ] capture检测contextKey改变时，同步撤旧ticket/controller/receipt资格，再生成新ticket；目录同值回归仍靠generation/新ticket，不靠key。eligibilitySignal因目标变化abort，映射stale，不冒充caller取消。
- [ ] `getProviderCatalogConfig`先按 `typeof catalog.openDropdownSession==='function'` 分流：typed config factory覆盖成target-specific session；typed getEntries兼容壳为临时session read→仅current ready映射entries→finally release，绝不先getSdkCommands/set-array再read-global。legacy路径保留原行为。
- [ ] `getSdkCommands`在进入target runtime/跨tab/length/loader逻辑前，先查catalog typed能力：typed只读原目标runtime facet；无runtime/无facet直接[]，failed/unavailable/ready-empty直接兼容数组结果，均不借别tab、不跑loader、不setRuntimeCommands。保留资格核查。**不是以runtime是否支持facet决定可不可以掉回legacy。**
- [ ] manager订阅当前provider命令registry槽；变更同步撤各相关tab资格，重新getProviderCatalogConfig并setProviderCatalog（无catalog为null/null）。原unbound默认factory不能代替tab-specific factory。beginClose/closeTab/cleanup候选时先撤资格并结算capture waiter，再destroy UI；manager registry订阅在retire收尾退订，不能残留静态listener。
- [ ] Tab所有实际runtime字段提交点发同一命令通知：initializeTabService旧摘除/新安装/异常清空、cleanupTabRuntime实际摘除、onProviderAvailabilityChanged清空、destroyTab清空。通知放相关字段赋值后，不把调用cleanup()当成“已经摘除”。保留原entry-runtime reentry guard及错误聚合，不让旧runtime通知清掉新runtime资格。
- [ ] Tab ensureServiceForConversation的provider/conversation/lifecycle被动绑定以及blank模型/provider切换也同步发context通知，放实际字段提交之后、settings await之前；后续已有reset可幂等合并。目录/绑定变更即使runtime仍同一对象也必须撤旧请求。
- [ ] Tab初始initializeTabUI用manager config优先、null时getRegistryProviderCatalogInfo fallback。后续sync同样保持。无manager fallback得到catalog默认unbound factory，只显vault/builtin，不借active chat。同步registry替换监听在无manager入口注册并放eventCleanups；有manager入口由manager重绑，避免两套fallback抢写tab factory。
- [ ] ExternalContextSelector同文件新增私有 `commitExternalContextPaths(nextPaths: string[]): boolean`：对有效目录数组实际赋值后同步onChange（传副本），再render/persistence。add/remove/setExternalContexts/clearExternalContexts/setPersistentPaths的merge全部经过这个提交点；restore仍exact、clear仍persistent、路径验证/去重/冲突规则原样。
- [ ] remove持久路径时先更新内存active/persistent两槽，再有效目录onChange，再onPersistenceChange；togglePersistence若active dirs未变只走persistence、不撤命令。无效/重复add、same effective paths的set/clear不撤资格；A→B→A发生两次有效提交，两次generation增加。
- [ ] Tab setOnChange回调顺序严格为 `notifyTabCommandContextChanged`（manager同步撤旧资格→Dropdown reset）→ `preScanExternalContexts()`；selector稍后才允许persistence。不能把manager撤销放Promise.then/await后；不仅要reset Dropdown，旧manager请求也须失格。

**单元测试**：

| 测试文件（绝对路径） | 用例名 / 断言 |
|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/TabManager.test.ts` | `routes by typed catalog before checking a null runtime`：目标cold，另一tab热；真实typedcatalog/目标session只见vault，外tab getter/loader/global setter=0。 |
| 同上 | `uses a tab specific session without the legacy array catalog handoff`：原目标facet结果，getSdkCommands/listDropdownEntries/setRuntimeCommands spy不走legacy handoff；entries仅当前tab。 |
| 同上 | `does not resurrect a directory A request after A B A`：挂起old vault/read；真实selector两次提交后generation/ticket变化；即使key回A，旧read stale/旧receipt false、新A独立可读。 |
| 同上 | `rebinds visible command consumers on runtime replacement and registry changes`：Tab生产安装/摘除通知＋registry C1→C2→clear；在microtask前旧项失效，新factory指向新slot。 |
| 同上 | `settles command captures on candidate cleanup tab close and manager retirement`：pending请求在关闭当轮同步失格、不挂到vault结束；registry退订，borrowedQuery owner仅由原清理路径处理。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/Tab.test.ts` | `notifies command consumers after each actual runtime commit`：安装/更换/摘除/异常路径与同runtime无变化；listener见字段新值，保留cleanup重入保护。 |
| 同上 | `revokes manager commands before resetting dropdown and prescanning directories`：日志先字段新目录→manager generation/ticket失格→reset→preScan；persistent remove再persistence，顺序用mock invocationCallOrder＋当场资格断言。 |
| 同上 | `uses the unbound registry factory during UI initialization without a manager`：实际initializeTabUI默认入口，不只测私有helper；constructor收到factory，读vault而非globalSdkCommands。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/ui/ExternalContextSelector.test.ts` | `commits every effective directory mutator before change and persistence callbacks`：参数化add/remove/set/clear/persistent merge；onChange内getExternalContexts已是新值，remove持久路径onChange先于persistence。 |
| 同上 | `does not revoke commands for invalid duplicate or persistence only changes`：invalid/duplicate add、same dirs set/clear、togglePersistence不产生effective path通知；existingvalidation规则不变。 |
| 同上 | `emits two synchronous effective changes for A B A`：回到同字符串仍两次通知；回调获得副本，不可修改内部数组。 |

#### W4d：Inline 真实入口、通知退订与跨入口测试

**生产** `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/inline-edit/ui/InlineEditModal.ts`；**测试** `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/inline-edit/ui/InlineEditModal.openAndWait.test.ts`；新增 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/commandDiscoveryWiring.test.ts`。

- [ ] 在实际Dropdown创建处加一个小型rebind函数：按resolvedProviderId取当前catalog及config/getter；默认typed factory仍unbound。注册 `subscribeCommandCatalog`，替换/clear时同步setProviderCatalog新值/null；不把active chat runtime注入命令capture。
- [ ] 单独保存registry退订句柄；实际 `cleanup()`先退订、清句柄，再destroy Dropdown。不要虚构onClose，不改inlineEditService执行流程、模型选择或mentions。
- [ ] 新增 `keeps inline discovery unbound even when an active chat has SDK commands`：真实Inline入口把factory透传到实际Dropdown，vault/builtin可见、active chat getter=0。既有只mockDropdown constructor的测试可保留，但不能单独作为接线验收。
- [ ] 新增 `rebinds inline catalog replacement and unsubscribes on cleanup`：C1→C2→clear，旧选项同步失效，后续accept/reject cleanup后registry通知不再调用UI。
- [ ] 跨入口integration使用真实registry、production factory/catalog、manager、Tab、Dropdown、Inline路径；只mock SDK transport/Obsidian外部适配/storage I/O，不能mock被测接线函数或直接喂预制visible list。复用现有mockElement/SDK fixture模式，不改共享mock去迎合新结果。

### 7. 入口 × 机制验收矩阵

以下均为必须新增的生产链路测试，不由类型fixtures代替；落新增integration文件。

| 入口 / 用例名 | cold来源 | 必须覆盖机制 |
|---|---|---|
| Main blank：`main blank shows vault builtins without owned probe or cross tab borrowing` | tab target＋runtime=null，not-attempted | 另一热tab存在；vault/builtin可见，SDK query/probe/他tab getter/global setter=0；目录ABA、runtime安装通知。 |
| Tab bound_cold：`bound cold follows typed catalog policy without runtime startup` | 同上，或存在facade但Query absent的unavailable(E0) | 不ensureReady/loader；分别验两种runtime分支；同runtime unavailable→新Query→旧vault晚到；runtime更换/摘除。 |
| Tab registry fallback：`registry fallback initializes and replaces an unbound catalog` | unbound，not-attempted | 调用无manager的initializeTabUI；C1→C2→clear、旧DOM插入0；有效目录变更reset，不借active tab。 |
| Inline：`inline unbound discovery rebinds and releases across catalog changes` | unbound，not-attempted | 真实Inline创建/cleanup；active chat存在也不借用；registry替换/clear同步撤旧选项、退订后无回调。 |

warm补充 `active Query commands retain receipts and reject old consumers`：真实Query初始化→两次菜单read getter=1；ready-empty保留；cancel/stale不发布；两个Dropdown同Query，一个hide不影响另一个。builtin仍是原 `/`位置0政策，中句 `/`仅provider项，Codex `$`不混入Claude builtin。

### 8. 推演小节（设计语义，不代替实测）

#### 8.1 求值序锚值〔纯示意〕

锚定vault含1项`vault-only`，适用builtin含2项，Query仅固定hidden `cost`。绿色＝状态/计数/资格正确且probe启动数0；红色＝升级来源、借tab、重复启动或旧项能插入。

| 输入 | 旧规则provider结果/启动 | 新规则runtime与计数/provider结果/启动 | 红绿判据 |
|---|---|---|---|
| 本tab无Query，另tab有1项foreign | manager借foreign，全局catalog返回foreign | not-attempted；runtime raw=null、vault raw=1；仅vault-only；probe=0 | foreign出现即红。 |
| ready-empty | 数组[]→catalog可probe；状态丢失 | ready、runtime raw=0/visible=0；vault=1；probe=0 | 把0写null或二次probe即红。 |
| ready([cost]) | 固定hidden后0→vault | ready、runtime raw=1/visible=0；vault=1；probe=0 | 改成runtime-empty、failed或not-attempted即红。 |
| failed | []与成功空不可区分，可probe | failed/code/E0保持；runtime raw=null；vault=1；probe=0 | 外层ready不能改变runtime失败事实。 |
| runtime stale / caller cancelled | 下游可能把[]再作fallback | 外层stale/cancelled、entries=[]、receipt=null、发布数0 | 即使vault晚到1项，发布/插入均须0。 |

builtin不计入source counts；例中UI有provider1＋builtin2共3项，不把“3”误写runtime rawCount。

#### 8.2 跨步骤与时序走查〔纯示意〕

1. **Unavailable→新Query→旧vault晚到**：R1无Query给E0=(opaque e0,revision10)；session请求S0的vault挂起。生产建立Q1后facet同步推进E1/通知，`isCurrent(E0)=false`，S0 stale/null receipt。新请求S1读Q1；旧vault返回1项只能结算旧底层promise，不能写S1cache/DOM。若只核R1对象或只核Query成功receipt，这个案例会误放旧vault，故eligibility对unavailable也必需。
2. **目录 A→B→A**：旧读(A,keyA,generation20,ticketTA)；B实际提交后generation21/ticketTB；回A后generation22/ticketTA2。即使keyA相同，TA≠TA2、20≠22，旧isCurrent永假。顺序是内存目录赋值→manager撤资格→Dropdown reset→preScan→persistence；把撤销推迟到await后会留可点击窗口，判红。
3. **Runtime换代通知**：Tab R1→null→R2每个实际提交都同步通知；capture冻结R1，旧R1晚到不能消费R2。cleanupR1内重入安装R2时保留既有entry identity guard，不许旧清理把R2摘除；旧命令source通知只能撤其receipt，不能操作R2owner。
4. **Registry C1→C2→C1 / clear**：revision7→8→9→10，不因相同catalog对象或clear而归零。manager/无managerTab/Inline分别重绑自己的factory；旧C1receipt带revision7，即使C1重装也不当前。

上述无业务日历语义，不命中周五/节前/月末走查；无金额、费率或量纲公式。

#### 8.3 论证链、反例与结构不变量

- 链A：所有生产命令入口按catalog能力走typed → typed不会调用legacy probe且factory不注入probe → cold不创建owned Query。隐含前提是不存在遗漏的直接probe生产调用。**反例**：Inline仍捕获旧catalog/getter、或factory仍带closure，单测fake session全绿也不能证明cold不probe；故factory真实调用＋四入口矩阵是强制实证靶子。
- 链B：有效目录赋值都同步发onChange → manager generation/ticket撤销早于任何await/扫描/持久化 → A→B→A不能复活旧请求。**反例**：setExternalContexts绕过onChange，A→B→A仅key比较会复活旧读；故统一mutator提交点与same-key不同ticket测试不可省。
- 链C：runtime absence资格会在同runtime新Query安装时撤销 → fallback也携原eligibility → 旧vault不能“晚到成功”。**反例**：receipt仅记录R1对象或runtimeEligibility重建但isCurrent只比token，就可能误放；必须测试E0与E1以及同对象toBe约束。

| 结构不变量 | 判定及位置 |
|---|---|
| 正交性 | 设计成立：P1管Query读/flight；manager管目标资格；catalog管来源投影；Dropdown管UI插入；registryrevision只管命令槽。把sourceRevision当目录新鲜度、把global sdkCommands当typedcache即违反。 |
| 数据流无环 | 设计成立：Tab/registry/runtime更新→session失效→UI合并刷新；listener不直接read/SDK，empty/failed不反向invalidate。稳定状态仍增长getter/read即违反。 |
| 扩展点在扩展方向 | 设计成立：catalog可选session/factory是provider扩展点；Dropdown不写Claude判断。新provider只提供合同，不新增manager provider分支。 |
| 退化为一般特例 | 设计成立：cold/空结果是同session pipeline的状态；只有缺factory的既有provider用显式legacy兼容路。runtime=null不意味着切换回跨tab路径。 |
| 多入口覆盖 | 当前源码违反：初始无managerTab、Inline替换、目录set/clear漏接；W4补齐后由第7节每格实证，不能仅凭纸面宣称已成立。 |

### 9. 交付物规范

本轮仅新建指定设计记录；实施阶段新增两份测试，不新增生产模块、不新增数据/日志产物。

**① 新增部分目录树，绝对根**：

```text
/Users/vincentwang/Documents/NoteVault/tools/claudian/
├── docs/designs/2026-11-09-command-discovery-wiring-w1-w2-w4.md
├── tests/unit/providers/claude/app/ClaudeWorkspaceServices.test.ts
└── tests/integration/features/chat/commandDiscoveryWiring.test.ts
```

**② 命名规则/README登记**：设计记录以日期＋command-discovery主题slug标明裁决范围；`*.test.ts`镜像生产模块，integration名标跨入口接线，不用P片号作为业务API名。实施合流时由integrator在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/README.md` 增加command discovery产物/验收索引，列本设计及两份新增测试；本轮不改README、不注册为已上线。

**③ 清单**：

| 路径（绝对路径） | 用途 | 消费者 |
|---|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-09-command-discovery-wiring-w1-w2-w4.md` | 分片合同、已裁决cold政策、合流及验收边界 | 用户、W1/W2 worker、唯一integrator、独立复核者 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/app/ClaudeWorkspaceServices.test.ts` | 真实生产factory禁probe及registrybinding哨兵 | unit Jest / integrator |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/commandDiscoveryWiring.test.ts` | 四入口×资格/通知/目录机制 | integration Jest /复核者 |

**④ 归属引用/偏离**：遵循 `/Users/vincentwang/Documents/NoteVault/tools/claudian/CLAUDE.md` 的provider边界、镜像tests和TDD，及 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/CLAUDE.md`。设计落docs/designs使用同目录既有design-decision格式并加date，无约定偏离；README目前无完整设计产物索引，实施后回填。本任务临时数据只准 `/tmp`，不落业务目录，不制作另一个报告文件。

## 风险与权衡

1. **明确的行为改变**：Claude typed cold不再probe/借同provider热tab，因此用户未发送前可能少见SDK/plugin/user全局命令；这是已裁决政策，不作为待选项。vault scan仍只有best-effort，不能保证覆盖用户/插件/外部目录。
2. **最小接线不等于极小diff**：公共facet当前缺失、目录多mutator、registry/Inline通知漏接都是事实；省掉任一处都会产生静默失效。W4增加这些落点，但不扩成probeowner/store/P1重构。
3. **通知重入**：runtime getter完成、Tab摘除、registryclear都能触发同步listener。只能同步撤资格，不在listener里SDK读/重启/全局服务清理；UI刷新推迟合并。P1 first read可能因完成事件失格，新read使用readycache，不得演变无限循环。
4. **共享脏树**：runtime/Tab/manager/UI等正被其他工作线改，必须唯一integrator按hunk接收。全局lint当时有历史测试阻断，不能把它修进本片或称lint通过；合流闸门须由该工作线清掉后重跑。
5. **已有测试含旧政策**：`/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/QueryCommandDiscovery.test.ts` 的 `P1 revoked Query menu refresh` 9个参数化场景当前断言manager菜单启动第二个owned probe；生产typed后不应保持这些policy断言。integrator将该段改为EOF/exit后vault-only/probe0的生产断言，保留所有纯P1 cell断言；旧probehelper行为留独立legacy suite。不得通过剥掉真实catalog的typed能力、mock被测manager或强行放开probe来维持旧绿灯。
6. **legacy保留范围**：非typedcatalog的同provider借用、loader、globalset-array/list路径及显式legacyprobe单测不在本片修改范围；不宣称全项目已消灭旧probe API。生产Claude入口必须全部typed，legacy路径不能成为缺facet回退口。
7. **目录范围诚实性**：撤旧请求不是取消实际Query或修改applied directories；本片仅保留scope与关系，目录新命令何时出现仍服从原Query重启策略。scope-mismatch不升级为“当前配置完整命令”。
8. **owner未闭合**：禁入口只阻止以后新启动，不终止已经运行的旧probe。任何实机遗留子进程需独立确认/人工处理，不能用not-started回执抹掉；稳定probeowner方案另行确认后才允许重启该功能。

### 回滚边界

| 类别 | 内容 | 回滚原则 |
|---|---|---|
| A：只加、未被生产消费时不改变旧行为 | W0保持；W4 runtime只读facet/旁路元数据；W1 openSession独立实现；W2可选factory分支；registry命令revision/订阅API | 可停在未消费状态，不改P1 cell/数组壳。`getDropdownConfig`挂factory本身在W2消费者合流后就属于B，不能一概标“全是additive”。 |
| B：改变生产fallback/缓存/通知 | 默认factory挂载、manager先catalog分流、cold不借tab、factory断probe、目录提交顺序、UI即时撤项/插入检查、Tab/Inline重绑、CRUD/refresh失效 | 按完整接线单元撤回或暂停typed消费者；不能仅撤manager通知、eligibility或目录generation却继续让typedUI缓存旧receipt。 |
| 永不自动恢复的禁令 | 生产probe注入与typedcold跨tab借用 | 普通rollback不重新开启已裁决禁止的行为。若须退回旧UI，至少保留productionfactory禁probe与cold禁止跨tab/loader的准入边界；不能保持它们时停止该provider命令展示（只保留builtin），另请用户裁决。 |

回滚只撤本片已登记hunk，禁止reset整个共享文件/分支；不触碰W0/P1/其他工作线/旧design draft。每个hunk记录当时基线与新状态，integrator按依赖逆序处理。

## 验证方式

### 1. 运行期验收清单

- [ ] ready双分支按runtime.status进一步分辨；not-attempted→null，attempted所有可发布结果→`receipt.runtimeEligibility === runtime.eligibility`，使用`toBe`而非deep equal。
- [ ] attempted unavailable/failed也受facet.isCurrent保护；同runtime unavailable→新Query→旧vault晚到必测，旧结果发布/缓存/插入次数0。
- [ ] runtime.cancelled/stale、target/sessionstale、caller取消均无可发布receipt；W0fixture可构造的ready(cancelled/stale)不成为生产输出。
- [ ] target原TabData/opaque token/ticket/generation/context/runtime/registry等任何失效拒旧；目录A→B→A和registryC1→C2→C1不可复活。
- [ ] runtime实际安装/换代/摘除与Query内部换代均有同步命令通知；同runtime字段对象未变不能漏Query资格通知。
- [ ] reset/registrychange之后、microtask刷新之前旧DOMclick/Enter/Tab不能插入；hide/release不会关闭另UI借用的Query。
- [ ] productionfactory＋四入口cold/unbound的probe/query/跨tabgetter/typedglobalsetter均0；absence不是cleanupconfirmed。
- [ ] Query成功空和init/public并发singleflight保持getter1；failed/empty不会通知环或自动retry；typed显式retry与legacy数组默认规则分开。
- [ ] vault/probe不可query-owned，coverage三槽正确，raw0与null不混淆；DOM不泄露scope路径/环境/token。
- [ ] registryclear不重置revision，静态listeners在Tab/Inline/manager销毁时退订；pending底层promise不拖住session取消/退役。

### 2. 明确验收命令

以下在实施树运行，不代表本轮已执行新增测试。每片先红后绿，不用`--forceExit`掩盖挂起/残留owner。

**W1**：

```bash
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run test -- --selectProjects unit --runInBand --runTestsByPath /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/commands/ClaudeCommandCatalog.test.ts
```

**W2**：

```bash
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run test -- --selectProjects unit --runInBand --runTestsByPath /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/shared/components/SlashCommandDropdown.test.ts /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/shared/components/SlashCommandDropdown.provider.test.ts
```

**W4＋W0/P1 合流定向**：

```bash
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run test -- --selectProjects unit --runInBand --runTestsByPath \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/core/providers/commands/ProviderCommandDiscovery.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/runtime/QueryCommandDiscovery.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/core/providers/ProviderWorkspaceRegistry.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/app/ClaudeWorkspaceServices.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/TabManager.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/Tab.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/ui/ExternalContextSelector.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/inline-edit/ui/InlineEditModal.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/inline-edit/ui/InlineEditModal.openAndWait.test.ts

npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run test -- --selectProjects integration --runInBand --runTestsByPath /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/commandDiscoveryWiring.test.ts
```

**生产放行硬闸门**：

```bash
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run typecheck
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run lint
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run test -- --runInBand
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run build
```

每条记录独立exit状态；typecheck必须执行W0负控制（Jest不执行那些无效赋值函数），不以mockfixture PASS代替tsc。lint既有阻断未清前G1/G2不能声称全绿，交原工作线处理，不做跨线顺手修复。

**代码可达性人工核对**：

```bash
rg -n 'probeRuntimeCommands|new ClaudeCommandCatalog|openDropdownSession|createDiscoverySession|getCommandDiscovery' /Users/vincentwang/Documents/NoteVault/tools/claudian/src
rg -n 'externalContextPaths\s*=|onChangeCallback|onPersistenceChangeCallback' /Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ui/InputToolbar.ts
rg -n 'tab\.service\s*=|notifyTabCommandContextChanged|subscribeTabCommandContextChanges' /Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts /Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts
```

核每个实际赋值点与通知顺序；搜到残留legacyhelper定义不是失败，搜到生产factory/typedentry调用它则是失败。

### 3. 既有测试不回归清单

- P1纯cell：成功空缓存、init不自动retry、later explicit read retry、singleflight、clone、旧Q1不返回Q2、单waiter取消不关borrowedQuery、pre-aborted不读getter、watchdog退役/exitbarrier/startprohibition、自然EOF、lateoldconsumer/child exit隔离；`QueryCommandDiscovery.test.ts`纯P1段保留。
- Catalog旧数组/显式legacyprobe/CRUD/hidden过滤：`ClaudeCommandCatalog.test.ts` legacy describe仍通过；`getDropdownConfig`可多factory字段，旧断言核既有字段而非精确字段集合。
- Dropdown非typed：两个原suite中的provider切换requestId/disposed、Codex `$`/中句trigger/insertPrefix/builtin去重/hidden/键盘/fixed不回归。
- Tab/manager生命周期与provider分流：原同provider借用用例在明确**非typed**catalog路径保留；不能拿它要求生产Claude typedcold借用。OpenCode loader/cache/warmup/inactivecold、Codexscan-backed、mixedprovider禁止跨provider、close/hydration/cleanupreentry保留。
- `ExternalContextSelector.test.ts`原exactrestore/persistentclear/pathvalidation/quotes/homeexpansion/duplicate/overlap/persistencerules不回归；新增effectivechange通知可能增加callback次数，旧测试不能再假设初始化/set/clear永远静默。
- 调用set/clear的 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/controllers/ConversationController.test.ts`，及 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/controllers/InputController.test.ts`（/add-dir），全量闸门必跑，核无额外启动runtime、无保存次序破坏。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/inline-edit/ui/InlineEditModal.openAndWait.test.ts`原accept/reject/隐藏命令/模型传递不改；cleanup新增退订不能漏原取消。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/commands/probeRuntimeCommands.test.ts`仅作为保留legacyhelper回归，不证明生产资源owner/cleanup已闭合。

**必须显式更新、不能假称不回归的旧政策断言**：P1测试内9个revoked菜单启动ownedprobe的混合用例；真实typedmanager不再走globalset-array/list的断言；不支持effective目录change的新静默假设。更改范围由integrator逐项登记，只改政策，不改P1state/getter/flight断言。

### 4. 实机验证项（必须 Obsidian）

下列只在经用户确认的部署后执行，本轮未做；实机留事件顺序/截图及进程证据，不用“mock全绿”替代。

- [ ] 真实Main blank与恢复bound_cold打开 `/`：vault命令/skills＋适用builtin出现；另一热tab有独特SDK命令也不能串入；仅开菜单不新增CLI/MCP子进程，不生成会话。
- [ ] 第一次真实发送建立Query后，菜单无需切tab就能重读实际Query观察；取消/CLIexit/恢复新Query后旧项不能点击。发送可能有成本，未授权不为验证偷偷发送。
- [ ] 窗口可见时目录A→B→A，包括UI添加/删除持久路径、`/add-dir`、会话restore/set、newconversation/clear；赋值当轮旧可选项撤销，扫描/保存慢也无插入窗口。不要以旧Queryreceipt声称新目录已应用。
- [ ] registry重建/provider可用性切换/插件正常reload：Main/无managerTab/Inline各自正确替换或摘除catalog，旧DOMclick/Enter/Tab不能插旧命令；Inlineaccept/reject后无悬挂listener。
- [ ] 真实Electron AbortSignal realm、fixedInline定位、鼠标/键盘、hide/destroy快速切换、两个Dropdown共享同Query但分别取消，核无卡死/未处理rejection。
- [ ] 若旧版本已启动过probe，单独记录直接子进程存活/退出证据并处理；不能只看stdout EOF或新版本probeCleanup=not-started宣告旧资源已清。

## 关联

- [[tools/claudian/docs/designs/2026-11-08-command-discovery-query-scope-receipt-contract]]
- [[tools/claudian/docs/designs/2026-11-09-command-discovery-minimal-downstream-wiring]]（历史草案，只引用；其中被推翻的假设不沿用）
- [[tools/claudian/CLAUDE]]
