---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - claudian
  - command-discovery
  - implementation-contract
---

# 命令探测：最小下游回执接线与 probe 清理

## 背景与问题

Query P1 已保证实际 Query 的成功空缓存、单 flight 与撤资格，但公开数组壳继续丢失状态，下游仍按 length 补探测、缓存 fallback；本案只贯通必要回执并补 owned probe 的有限主机生命周期，不重做完整 P2/P3。

> [!warning] 草案与边界
> 按 `[务实]` 设计。主会话已裁定放行最小 typed 出口、公共回执接口、manager/factory 参数接线；P1 cell 行为不变。本文不修改、不 supersede 既有设计记录，不代表原总合同全部获批或命令探测生产门全部关闭。
> 本轮只新增本文；未改代码、测试、README、配置或其他工作线文件，未 build、部署、commit、push、真实 CLI/MCP 或模型调用。测试只运行既有 mock suites，临时数据在 `/tmp`。

## 方案设计

### 1. 核查、解层次与推荐

#### 1.1 观察基线

代码根为 `/Users/vincentwang/Documents/NoteVault/tools/claudian`；分支 `fix/model-identity-sorting`，HEAD `cf47730d2109e798fd27ddacc712038d26883d5b`。共享脏树，观察不等于锁定；实施前重新冻结脏文件及 untracked 的实际内容，不以 HEAD 代替基线，不 stash/reset/覆盖他人文件。

2026-11-09T01:58:02Z 只读 SHA-256〔实测〕：

| 文件（绝对路径） | SHA-256 |
|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts` | `ae10874514c77f62f44dc902a980e83f90df90e38e0507ff5ebd1d97a249238d` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/ClaudeCommandCatalog.ts` | `73a4d82fb51d5b6a49314714bd6d1b477ef95c836b1ef3387b791a65fc8c9deb` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/probeRuntimeCommands.ts` | `e1d8f94bf95af7021779d69649d2208ed6417417aa636019853e7f4e9d49efb5` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts` | `13eecee1ae987996a833a2d0df621f5d129c73fd26ab0faca1419f0e98dfb6c5` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/shared/components/SlashCommandDropdown.ts` | `5c9d6e769499ea0bc371816904cb0fcd9a05a07f4ce3835c3c66bef290e06da7` |

已读源码〔既有读数〕：

- Runtime `:201–217,3458–3596` 有私有 typed result/cell，公开 `getSupportedCommands()` 只返回数组；无公共 source receipt/change subscription。不能从 `[]` 恢复失败、成功空或来源。
- Catalog `:78–110` 在缓存空时 probe，过滤后空时回 vault，probe 失败吞掉；Dropdown `:248–260` 仅非空置 fetched。因此“把空也置 fetched”会把 unavailable/failed 同样缓存成成功。
- TabManager `:1266–1325,1556–1578` 仍是数组判断及 write-array/read-global；只改 catalog/Dropdown 不能贯通。其 ticket/generation/原 tab/registry 检查必须保留。
- Tab `:172–208,737–738` 原样透传 `ProviderCommandDropdownConfig`；Inline `:452–453` 也直接透传 config。**可把可选 session factory 放进既有 config，避免修改 Tab、Inline 或其 callback 类型。**
- 两个 vault storage 的 `loadAll()` 自己吞目录/文件错误。本案不改 storage，不能把其返回 `[]` 标成“vault 完整扫描成功”；应保留 best-effort/unknown 覆盖口径。
- installed SDK 声明 `supportedCommands()/initializationResult()/close()/SpawnedProcess`；实现为 `supportedCommands(){return(await this.initialization).commands}`。getter 可直接用于初始化观测，不必等插件读取 `system/init`。现行官方文档称命令动态更新需 SDK ≥0.3.216；不能推广到本地 0.2.112。

#### 1.2 解层次与候选

| 方案 | 取舍 |
|---|---|
| 数组加 sentinel/隐藏属性，或扩大 fetched 条件 | 不能恢复 Query 私有状态；manager 仍会按 length 补启动；拒绝 |
| **最小 typed facet＋每个 Dropdown 的 catalog session＋config 透传** | 有显式状态/来源，复用已有传递链；只加一个中立合同文件；推荐 |
| 完整 store/context/全入口生命周期改造或 SDK 升级 | 可扩能力，但超出本案；不实施、不作为本片隐含前置 |

复用 P1 私有读/撤资格、已有 manager ticket、Dropdown requestId/disposed、公开 SDK init getter、MessageChannel 和 customSpawn。installed `startup()` 也存在，但 WarmQuery 无直接 commands getter，还需转 Query；本案复用当前 query 选项与空输入通道即可，不额外引入预热阶段。

### 2. 最小公共合同

新增 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/commands/ProviderCommandDiscovery.ts`，仅中立类型，不建 store、不导入 SDK/DOM/provider 实现。

以下是接口合同，不是实现代码：

```typescript
interface RuntimeCommandDiscovery {
  read(signal?: AbortSignal, options?: { retryFailed?: boolean }):
    Promise<CommandDiscoveryResult<SlashCommand>>;
  subscribe(listener: () => void): () => void;
  isCurrent(receipt: CommandSourceReceipt): boolean;
}

interface CommandDropdownSession {
  read(signal?: AbortSignal): Promise<CommandDropdownSnapshot>;
  subscribe(listener: () => void): () => void;
  isCurrent(receipt: CommandDropdownReceipt): boolean;
  invalidate(): void;
  release(): void;
}
```

必需字段与语义：

| 对象 | 合同 |
|---|---|
| `CommandDiscoveryResult<T>` | `ready` 携 readonly entries/source receipt；`failed/cancelled/stale/unavailable` 各自显式状态。P1 无具体错误码时只报 `query-command-read-failed`，不猜网络/认证原因 |
| source receipt | `sourceKind=initialize-response/probe-candidate/vault-best-effort`；opaque `sourceToken`、命令专用 `sourceRevision`；不泄露 SDK Query 对象 |
| scope | `kind=actual-query/base-probe/vault`，所属 sourceToken；可附已捕获的 `cwd/additionalDirectories/settingSources` 白名单子集，未观测维度列 unknown。entry 的原 `scope: runtime/vault` 不等于此次发现 scope |
| target | 原 target token、session epoch、manager ticket/generation、当前 provider/runtime facade、requested external paths；上下文 key 只查请求一致性，不证明配置完整或来源等价 |
| dropdown snapshot | 展示 entries、runtime/probe/vault 各自 outcome、source refs、rawCount/catalogVisibleCount、coverage、receipt、fallbackReason；fallback 不覆盖 runtime outcome |
| dropdown receipt | catalog token＋session epoch/revision＋target ticket/generation＋source token/revision＋投影政策版本；用于拒旧消费，不是数据新鲜度水位 |
| coverage | Query 仅 `initialize-observed`；probe 仅 `candidate`；vault 为 `best-effort-unknown`。不输出 `current-complete/live` |

`sourceToken` 绑定来源对象，不用 sessionId/CLI PID/命令名称代替。sourceRevision 只表达本地读数/资格变化，不从更大的 revision 推出目录更新。source 与 target 关联至少区分 `query-owned / scope-mismatch / unverified`；相同路径不自动升级为全配置等价。本案不支持跨 tab 借用为当前 Query 权威。

### 3. P1 只加 typed 出口和观察通知

精确文件：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/ChatRuntime.ts`：增加可选 `getCommandDiscovery?(): RuntimeCommandDiscovery`；既有数组 API 保留。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts`：只增加命令 facet/receipt 旁路及通知。

规则：

1. facet 每次 read 在第一次 await 前捕获原 `QueryScope/commandCell`，直接调用现有 `readQueryCommands()`，完成后再次核原身份及 signal。**新请求入口若已经没有有资格的 cell（含此前 exit/EOF 已 revoke），传 null 得 unavailable；已开始请求的原 cell 后来撤资格仍为 stale。** 因而 fresh cold read 可以走候选，旧 caller 不可换绑或走新 fallback。成功空原样 `ready([])`，P1 私有 cell/数组壳不改。
2. 新 Dropdown 的被动读传 `retryFailed:false`，复用 P1 已有参数；显式 Retry 才可传 true。**不改 P1 私有默认值、数组壳重试行为、cell 转移或 getter 次数规则。**
3. source token/命令 revision 作为 provider 内旁路元数据；在已有创建、flight 完成和 revoke 点发通知。先更新元数据/撤资格再通知；监听异常不能影响原生命周期，监听器不得同步重入 SDK。
4. Query applied scope 子集在实际 `options` 已构造、Query 创建时捕获；不在结果返回时读 `currentConfig` 补造旧 Query 上下文。未知维度不新增 context 提取模块。
5. 命令通知不能调用 Query close/interrupt、重启、解 start prohibition，不能更改 Stop/watchdog/turn/exit 次序。borrowed Query 取消只摘该 caller waiter/订阅。

### 4. Catalog：每个消费者一个 session，不建全局 store

精确文件 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/ClaudeCommandCatalog.ts`。

- 新增 `openDropdownSession?(targetCapture)`，由 catalog 内薄 session 持有当前投影及 waiter；不把 target Query observation 写进 workspace 的单个 `sdkCommands`。
- 老 `setRuntimeCommands()/listDropdownEntries()` 作为明确 legacy 数组适配保留；**不能写入 typed session 的 Query 来源分区**。新生产主路径不得先 set-array 再 read-global。
- Query 数据缓存仍归 P1；session read 查询当前 facet、校验 receipt 后投影。session 只缓存渲染投影及 vault best-effort 扫描；owned candidate 仍由 catalog 的小型 flight 状态管理，不新建 `ProviderCommandDiscoveryStore`。
- Session 在 release/invalidate 时同步撤自身 receipt、结算自身 caller、退订；不关闭 borrowed Query。catalog 的显式 retire 同步撤所有 session/owned flight 准入，cleanup 可有界异步完成。
- 保留 name-hidden、built-in 去重和 vault 展示政策；raw 与过滤后计数分开。隐藏到零不改 P1 observation、不重复 probe。vault CRUD 后失效投影是当前 catalog 的局部动作，不改 storage。

#### 4.1 推荐 fallback 求值序

| 来源结果 | 展示及回执 | 是否另开 probe |
|---|---|---|
| 当前 Query ready，过滤后非空 | Query entries；initialize-response、initialize-observed | 否 |
| 当前 Query ready/raw=0 | 保留原 vault fallback；runtime 仍 ready；reason=`runtime-empty` | **否，成功空不能补启动** |
| 当前 Query ready/raw>0、过滤后0 | 保留原 vault fallback；reason=`name-policy-empty`；保留原 rawCount | 否 |
| 当前 Query failed | vault best-effort fallback；runtime 保持 failed；reason=`runtime-failed` | 不因失败另开替身 Query |
| 没有可读 Query：unavailable | 可按已批准政策使用 owned base-probe；非空仅 candidate；无/空候选回 vault | 仅有有限 lifecycle policy 且 owned 槽可准入时 |
| caller cancelled、target/source stale | 该 caller 无可发布投影；不能换绑新目标或先扫 vault 再“成功” | 否；新目标须新 read |
| probe ready-empty | 缓存本 candidate 成功空，回 vault；runtime 仍 unavailable | 同 scope 不再开 |
| probe failed/deadline/cleanup-failed | 保留结构化 outcome；vault fallback不改它为 ready | 不自动 Retry |

此表是待确认的推荐行为：延续 vault 展示，但禁止用成功空补启动、禁止错误 fallback 冒充 Query 成功。无需决定完整 P2 的 candidate 可执行保证、同名 builtin 原生增强或热刷新。

vault `loadAll()` 若显式 throw，登记 `failed`；正常返回也只记 `vault-best-effort`，因内部吞错而保留 completeness unknown。**不可在本案声称区分了“真空 vault”与“被吞掉的磁盘错误”。**

### 5. 最小参数接线：借 config 原样透传

#### 5.1 中立接口与 Dropdown

`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/commands/ProviderCommandCatalog.ts`：

- `ProviderCommandDropdownConfig` 加可选 `createDiscoverySession?: () => CommandDropdownSession`。
- catalog 加可选 `openDropdownSession`；旧 config/CRUD/数组签名保持兼容。
- Claude typed catalog 的无参 `getDropdownConfig()` 默认附 unbound factory；TabManager 只覆盖为 target-specific factory。传递的是 factory，不是多 UI 共享的 live session；每个 Dropdown 自己创建/释放。这样未改的 Inline/Tab 后备也能进 typed 通道，不会继续被非空数组 fetched 锁住。

`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/shared/components/SlashCommandDropdown.ts`：

1. config 有 factory 则用 typed session；无则保留 legacy provider callback 路径，不按 provider 名称分支。不得给 Codex/OpenCode 增加请求频率。
2. typed 路径不使用 `providerEntriesFetched` 判成功，每次合法输入 read session；缓存是否有效由 receipt 决定。ready-empty 和 fallback-empty 都能渲染，但不是同一发现状态。
3. source/session change 同步失效旧 receipt/可选项，合并调度重新 read；若正在读，按最新 receipt 合并刷新，避免事件→读→事件的重试环。hidden 时只失效，不启动新工作。
4. await 后核 requestId/disposed、原 session、receipt；Click/Enter/Tab 插入前同步再核 receipt，失效时插入0次、调度刷新，不自动选同名新项。app builtin 不冒充 provider observation。
5. 复用现有 hide/reset/destroy/setProviderCatalog：结算该 UI 的 signal；reset 还推进 session epoch 防上下文 ABA；replace/destroy release session及退订。hide 取消请求兴趣但不误杀其他 subscriber。
6. snapshot outcome/source/scope 到 DOM 的 `data-*` 可观测属性；不新增自然语言文案、i18n、通用状态面板或“当前可执行”承诺。

#### 5.2 TabManager 唯一允许的最小 hunks

文件 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts`：

| 位置 | 必需改动 | 与其他工作线耦合/不改边界 |
|---|---|---|
| `getSdkCommands :1266–1325` | target runtime 有 typed facet 时按 status 求值，ready-empty直接返回兼容数组；不借另一tab、不进 length→补启动、不写 typed 数据到全局 setter | 保留原 tab/ticket/generation/registry 检查；non-typed路径原行为不动；不改 ready/warmup/初始化政策 |
| `getProviderCatalogConfig :1556–1578` | 附 target-specific session factory；capture 复用 `buildProviderCommandContext` 的原对象/ticket/generation；typed兼容 getEntries 直接投影该 session，不 write-array/read-global | 这是与现有 manager退役、provider切换、dropdown reset 的耦合点；必须由唯一整合者串行，不扩生命周期状态机 |

capture 每次 read 冻结原 target/request；完成时使用原资格，不按 tabId重绑。旧 session保持可捕获当前上下文的 delegate，但每个 request/receipt属于当次捕获。现有 reset/世代变化必须推进 session epoch；同字段 A→B→A 不能复活旧消费。`buildProviderWarmupContext/buildProviderCommandContext/ensureProviderTabRuntimeReady/invalidateProviderCommandState` 不重写。

Tab/Inline 无代码修改：它们已经透传 config。无 target 的 registry/Inline config 只能打开 `auxiliary-unbound` session：runtime=unavailable，来源仅 vault/base-probe，scope 未证明等同 inline 执行范围；不能借 active chat。**测试须经过未改的真实 Tab 透传与 Inline config 用法，证明此通道确实被生产组件调用。**

#### 5.3 factory

`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/app/ClaudeWorkspaceServices.ts:58–62`：把旧数组 probe closure 换为 typed probe 参数；传有限 lifecycle policy、catalog资格 guard，并用既有 Plugin register 清理能力登记 `catalog.retire()`。旧 constructor 的数组 probe 可保留独立 legacy 适配，不能把其裸数组升级 ready。

不修改 main、ProviderWorkspaceRegistry、Tab、Inline、其他 provider、测试共享 mock 或 customSpawn。registry直接替换未通知旧catalog时，receipt通过原registry身份检查拒绝发布，ownedflight最多运行到有限期限；**不把此 guard 说成跨catalog即时退役/资源barrier已经闭合**。

### 6. Owned probe：init-first、有限等待、全出口清理

精确文件 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/commands/probeRuntimeCommands.ts`。

在同文件提供 typed executor；保留旧 `probeRuntimeCommands()` 数组兼容壳供旧调用，只有 ready映射entries，其他映射空。新生产 factory仅用typed executor，兼容壳不进入新回执链。

#### 6.1 入口及权限

- 参数含 caller/owner signal、flight token、scope/context capture、`hardDeadlineMs` 与 `cleanupGraceMs`。两个值须有限正数；未提供/非法返回 `unavailable/lifecycle-policy-missing`，不能默开无限探测。
- 启动前捕获本 probe实际 cwd/CLI/settingSources/flags/env配置标识；不复制完整 env进receipt/log，不添加chat的external directories/plugins/MCP规则，来源永为base-probe candidate。
- 复用 MessageChannel作为输入，**零 enqueue SDKUserMessage**。创建 Query后直接调用一次 `supportedCommands()`；不 `prompt:''`，不等 `system/init`，不同时调用两个getter。
- 删除“无API调用、无费用”的注释。persistSession:false和零user输入只说明输入/持久策略，不能证明hooks/MCP/认证/计费没有副作用。
- 重用 `createCustomSpawnFunction()` 的 Electron/node解析能力，在probe本地wrapper中捕获**本次返回的**SpawnedProcess与 exit/error/stdout EOF。监听在返回child给SDK前安装；不得经私有query.transport/PID猜测，不改chat默认spawn。

#### 6.2 Outcome 与资源结果分轴

flight有固定token，`settleOnce` 只确定 discovery outcome；cleanup另记 `not-started/confirmed/pending/failed` 与原因。

| 事件 | Discovery | 必须动作 |
|---|---|---|
| 没vault/CLI、政策缺失、已退役 | unavailable或stale | spawn=0；不能返回ready-empty |
| SDK/同步spawn/getter拒绝 | failed，stage保真 | 保存原失败；仍执行finally |
| getter成功（含空） | ready candidate | 先固定成功原因，再主动清理；自己的abort不改称caller cancelled |
| metadata前真实exit或stdout EOF | failed：exit/EOF-before-metadata | 立即结算host等待并请求清理；EOF不是真exit证明 |
| 外部signal取消/最后subscriber释放 | cancelled | caller立即结束；只有owner终止ownedquery |
| catalog/session资格撤销 | stale | 不发布迟到数据；请求ownedcleanup |
| hard deadline | failed：deadline-exceeded | 结算host等待，开始有界cleanup |
| close/abort后exit没确认 | discovery原结果保留；cleanup pending→failed | 不假称released，不开放本catalog新probe/自动retry |

一次catalog只允许一个owned资源槽。相同base-probe输入可以共享candidateflight，两consumer各有自己的target receipt；一个退订不abort另一消费者。配置变更可以撤旧candidate资格，**不能在旧exit未明时用新key开第二owned进程**。typedflight的成功空/失败按该scope记账，反复输入不重新启动；显式retry也先核资源槽。

#### 6.3 全出口 finally 清单

凡进入可能创建Query的段落，所有早退、同步throw、getter失败、cancel/stale/deadline、exit/EOF、成功都走同一finally：

1. 关闭零输入channel，使自己的input waiter返回done；不enqueue补prompt。
2. 以原因 `success-cleanup/failure-cleanup/external-cancel/retire` 请求本Query.close与内部abort；两者分别try，任何一个throw不跳过另一个。使用独立的内部processcontroller，避免成功自清理误判外部取消。
3. 真实exit监听已在close/abort前登记；最多等cleanupGrace。已证no-spawn可confirmed；`killed=true/close返回/stdout EOF`均不等于exit。
4. 释放本代码创建的deadline/cleanup timer、外部abort listener、child/stream listener与catalog waiter。customSpawn自己的once abort listener由finally内部abort触发摘除；其已有stdout grace由原helper有限完成，不声称本案改了helper。
5. SDK getter、可选iterator.return及close相关异步结果均安装成功/失败观察器；**不无界await pending getter/return**。迟到回调只查原flight/token，不写当前snapshot、不清新flight。
6. 清理失败附着于原discovery结果；既有普通失败不被cleanup error覆盖。函数最大host等待为hardDeadline＋cleanupGrace；subscriber取消可更早返回。OS不能退出时返回cleanup-failed并封新准入，而非挂着await等永远退出。

此合同保证**host caller/本代码waiter/timer/listener不无限挂起**，不承诺不可终止OS进程、共享MCP或后代已退出。当前customSpawn只证明直接child exit；后代、跨registry/reload资源barrier继续属于总合同真实门，不在本案自建。不得pkill、杀共享MCP、扩大SIGKILL政策或启自动retry。

### 7. 切片、并行与唯一实施者

| 切片 | 文件/内容 | 依赖与并行 | 定向验证 |
|---|---|---|---|
| W0 冻结公共合同＋runtime观察 | 新中立types、两公共接口、runtime typed facet/通知；P1不改 | 最先；runtime与其他工作线共享，指定唯一写者 | 下文U0 |
| W1 catalog session/投影 | catalog及镜像unit；先无进程 | W0后可与W2/W3分别开发；本catalog只一名写者 | U1 |
| W2 Dropdown消费 | Dropdown及镜像unit；保留当前disposed/requestId | W0后可与W1/W3开发；该文件已有并发改动，先交接写权 | U2 |
| W3 probe主机合同 | probe及镜像unit；mock child/独立init，不接生产factory | W0后可与W1/W2开发 | U3；fake资源不关真实门 |
| W4 最小生产接线 | TabManager两hunks、WorkspaceServices参数/register、typed默认config及真实组件集成 | W1/W2/W3合流后，**同一实施者串行整合**；不能不同人各改manager/catalog/factory互相推导 | U4＋I4 |
| W5 独立复核/真实启用门 | reviewer复核diff与定向测试；真实probe另授权 | 不用下一片兜底上一片；不build/部署 | 生产链回执门与真实资源门分别登记 |

W1/W2/W3只是逻辑可并行，不授权workflow/worktree，也不意味着可在未冻结接口/共享文件上并写。若同一工作树存在交叉写者，优先按顺序串行；唯一integrator负责接口一致性及W4，不把机械参数接线拆给不读合同的runner。

### 8. 方案推演

#### 8.1 具象锚值与迁移〔纯示意；非实测〕

| 同一对象/锚值 | 旧链 | 新链/绿判据；反之为红 |
|---|---|---|
| Q1连续读2次，getter返回[]；vault有review | 数组空可走probe，再将vault非空置fetched | getter合计1、probe0；runtime=ready/raw0，display=review/fallback，reason=runtime-empty |
| Q1返回[cost]，catalog name-hidden后0 | 和原始空混用 | raw1/catalogVisible0，fallback=review/name-policy-empty；getter1、probe0 |
| Q1 failed，vault review；Q2后来ready deploy | review可能锁UI | Q1failed不变ready；Q2source通知废旧receipt，原Dropdown无需reset显示deploy；插入旧review=0 |
| Q1 pending，Q2 ready new，Q1晚到old | 有全局数组混读/覆盖窗口 | Q1caller stale；Q2显示new；旧finally清新flight=0 |
| 两tab A/Qa=alpha、B/Qb=beta，同provider，B先完成 | workspace数组可能串源 | A只alpha/B只beta；unbound Inline不标Qa/Qb权威；跨tab借用0 |
| 外部目录 A→B→A；原read仍pending | JSON相等可能复活旧ticket | 两次reset/session epoch推进；旧UI请求和receipt插入0；不能只比最终路径 |
| S1/S2共一个candidate；S1取消，S2成功空 | 原probe无subscriber合同 | spawn1，S1cancelled，S2ready/raw0；S1误close0；成功自abort不改S2 cancelled |
| EOF时getter永久pending；hard=100ms、cleanup=50ms | for-await/getter可一直等 | 本示意host≤150ms返回failed或cleanup-failed；timer/listener/input waiter清理=0残留；这些数仅test注入，不是生产默认 |
| metadata成功但close抛错，child exit不来 | 空/成功可能掩盖cleanup | discovery保留ready，cleanup=failed，新probe0；不能以close返回、EOF或killed解锁 |
| vault目录读取被storage吞错返回[] | 被当正常空fallback | runtime原status保留，vault覆盖unknown；不声称“完整空目录” |

#### 8.2 论证链与具体反例

- 裸数组丢状态→fallback非空→Dropdown fetched→后续不read来源：可导致锁缓存。隐含前提是没有reset等外部失效；反例是fallback后立刻reset，则未必复现。所以本案修机制，不报告普遍发生率。
- 原Query token＋P1资格核验＋typed receipt→结果属于原Query；**不能推出目标声明范围已全部加载**。反例：UI添dir-b而Query仍dir-a；scope必须报差异/unknown，不能称current-complete。
- 所有出口进入finally＋host等待有界＋迟到promise被观察→host不会无限挂起；**不能推出所有OS后代退出**。反例：直接child已exit，MCP后代仍持stdout；cleanup可报unknown/failed，不扩大杀进程策略。
- init getter读构造期initialization→无需插件先消费system/init。隐含前提是实际CLI零user输入可完成该初始化；反例是启动hook永久pending。harddeadline失败有效，不补空user输入“解决”它。

不修改任何已关账结论。前向反事实：仅把entries=[]置fetched会永久缓存failed/unavailable；仅添加revision仍不能证明scope等价或probe权威，因此均不采用。

#### 8.3 结构不变量判定

| 不变量 | 判定/位置 |
|---|---|
| 正交性 | 成立：P1管Query观测，catalog管投影/ownedcandidate，Dropdown管UI请求；discovery/coverage/cleanup三轴分离。legacy数组不升级权威 |
| 数据流无环 | 成立：runtime/probe→catalog session→Dropdown；change只失效/合并调度。禁止Dropdown read→manager ensureReady→重启Query环 |
| 扩展方向 | 成立：optional中立facet/config factory是接线缝；SDK政策仍在provider；不在shared UI按provider猜wire |
| 空值退化 | 成立：ready([])是ready的普通特例，failed/unavailable不是假空；过滤空是投影，不是源状态 |
| 多入口 | 主聊天target、Tab config透传、registry无target、Inline无target、legacy非Claude均按下文矩阵验证；完整inline执行context等价不在保证内 |
| 资源所有权 | 单catalog内成立；跨registry/reloadbarrier未成立、不在本片保证。主机waiter已结束不等于资源已释放 |

### 9. 交付物规范

#### 9.1 目标目录树（新增部分）

绝对根 `/Users/vincentwang/Documents/NoteVault/tools/claudian`：

```text
/Users/vincentwang/Documents/NoteVault/tools/claudian/
├── docs/designs/2026-11-09-command-discovery-minimal-downstream-wiring.md
├── src/core/providers/commands/ProviderCommandDiscovery.ts
└── tests/integration/providers/claude/commands/CommandDiscoveryReceipt.test.ts
```

本轮只新增设计记录；另外两项待确认实施，不预建。其余改既有文件及镜像unit，不新增store/context、持久缓存、日志库或正式capture工具。

#### 9.2 命名与索引

`ProviderCommandDiscovery`=中立回执/接口；`CommandDiscoveryReceipt`=跨真实组件生产接线测试。设计记录日期＋主题slug，首版不带v1。实施后在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/README.md` 登记设计/公共接口/定向测试及仍未关门；本轮不改README，也不登记计划产物为已交付。

#### 9.3 清单、用途、消费者

| 绝对路径 | 用途/消费者 |
|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-09-command-discovery-minimal-downstream-wiring.md` | 草案及切片门；主会话/用户/implementer/reviewer |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/commands/ProviderCommandDiscovery.ts` | 无行为的中立合同；runtime/catalog/Dropdown/manager |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/providers/claude/commands/CommandDiscoveryReceipt.test.ts` | 实际factory/manager/config透传/catalog/Dropdown与mock SDK/child；实施/独立复核 |

临时测试HOME/TMPDIR/cache/安全vault和一次性证据只落新建 `/tmp/claudian-command-<用途>.XXXXXX/`，不作为业务交付物。

#### 9.4 归属与偏离

沿用 `/Users/vincentwang/Documents/NoteVault/tools/claudian/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/CLAUDE.md` 的provider边界、native优先、TDD/镜像tests。独立工具仓已有docs/designs，设计就近落盘，不复制vault顶层。

偏离一般流程：本任务明确禁止build/部署与共享树写入，临时产物只落/tmp，优先于一般build收尾和.context建议。新增测试叶目录的索引由本节作为雏形，落地回填README。

## 风险与权衡

1. **共享正确性耦合**：runtime、Dropdown、TabManager已有其他工作线改动。W0/W4和最终整合必须唯一写者，尤其TabManager只能改表列两hunks；diff出现main/Tab/Inline/registry/其他provider即越界回报，不顺手修。
2. **保留legacy不是统一完成**：生产factory及Dropdown必须实际走typed路径；仅新增接口、unit手工喂snapshot不能关闭生产回执门。新主路径禁止global array作为数据源。
3. **覆盖保证有限**：只保证actual Query初始化来源与consumer资格；无完整context、watcher、commands_changed、origin/builtin证据。Inline无target只报unbound，vault吞错保留unknown，不因本文“scope贯通”改称完整发现。
4. **有限政策仍待确认**：hardDeadlineMs/cleanupGraceMs、真实hooks/MCP/认证/成本范围与失败后人工Retry。测试100/50ms仅示意；不继承上游30/5秒，不改MCP_TIMEOUT/chat env。政策未确认时可交付无进程回执链和probe主机测试，但生产cold切换要明确选择，不能默默保留无限旧probe或静默禁用后称完成。
5. **产品确认**：推荐保留ready-empty/name-policy-empty的vault展示、不补启动；失败来源只fallback不升权。candidate展示/选择保持原产品范围但不赋予当前可执行保证；若要求额外可见提示/i18n或只显示权威Query，另裁决，不扩本片。
6. **资源门分开**：直接child退出、后代、跨registry/reloadbarrier和真实零user init未验。本片的host有限结算不是总合同C5资源门，也不是跨client第二CLI保证；没有外部已确认资源接续，不启动新增跨catalog自动retry/热接续。
7. **回退成组**：typed接口可先加且legacy兼容；W4启用后manager/catalog/Dropdown/factory成组回退，先retire本次ownedflight并处理cleanup结果。不能回成半接线数组壳后继续声称状态门关闭；不覆盖共享脏树或回掉P1/其他工作线修改。

落地代价：一个中立types文件、三处主要实现、runtime命令观察旁路、两公共接口与两处最小装配接线；不引依赖、不升级SDK、不重做Stop/R/S/P2/P3。外部真实资源门失败可作为有效No-Go收线。

## 验证方式

### 1. 本轮实测与限度

本轮在独立 `/tmp/claudian-command-wiring-design.1m22Oi/{home,tmp,cache,vault}`，先 `--runTestsByPath --listTests` 后自然运行：**5 suites / 96 tests通过，2.668秒，退出码0**；无forceExit，无build/部署。范围为QueryCommandDiscovery、ClaudeCommandCatalog、probeRuntimeCommands及两份Dropdown unit。

前两次调用因从vault根执行，分别未找到Jest config、ts-jest相对tsconfig路径；后一轮在源码根显式config纠正。前两次不是行为红测，后者实际用例数为0。交接命令必须在源码根执行，不能只指定config便以为cwd无关。

这些绿测包含仍验证旧数组/空prompt的测试，**不证明新方案通过**。QueryCommandDiscovery `P1 revoked Query menu refresh :329–503` 混入旧下游probe假设；W4只迁移这组生产接线fixture至零user/typed路径，保留其旧Query不泄漏和borrowed不被关闭的因果断言，不删/skip或用fixture cleanup替代取消验收。该文件其他P1 cell用例行为断言保持。

### 2. 每片必须验证的生产语义

| 组 | 用例与可观察红绿判据 |
|---|---|
| U0 | facet实际调用P1：成功空getter1、两caller单flight；failed与unavailable分离；cancel不abort borrowed；close/retire/exit/EOF废receipt；旧caller不能返回Q2数据；P1原query close/turn/watchdog次序不变 |
| U1 | real catalog＋storage adapter：ready空不probe；raw1/visible0不清源；failed＋vault非空不升ready；Query/candidate分区；两session不同target不串；legacy setter不污染typed；vault completeness unknown |
| U2 | real Dropdown：typed不走fetched bool；空成功渲染；fallback→Q2 ready不reset仍更新；旧Click/Enter/Tab插入0；hide/destroy/reset/provider-switch摘自身；source change合并刷新不循环；legacy Codex/OpenCode触发/前缀/请求频率等价 |
| U3 | mock SDK initialize独立于event iterator，零user enqueue；同步throw/拒绝/成功空/永久pending/exit/EOF/预取消/deadline/close抛错逐出口；单退订不杀另一；全部自有timer/listener/input waiter归零；迟到reject无unhandled；cleanup未证新spawn0 |
| U4/I4 | 使用真实WorkspaceServices装配、TabManager与未改Tab的config透传、real catalog/Dropdown，仅mock SDK/child/fs与UI外壳；typed factory确实被组件调用；getEntries兼容适配不回读global；双tab、scope差异、registry换代、A→B→A；P1和其他工作线回归 |

测试可mock边界facet来测Dropdown消费者，但I4不得mock被验的manager接线/catalog投影/Dropdown消费，不靠手工set cache证明生产通道正常。新probe mock在各测试文件本地提供；不改共享SDK mock，不以真实spawn补fixture缺口。

入口×机制最终登记pass/fail/N/A及用例：

| 入口 | Query来源 | 回执/空/fallback | 撤资格/取消 | owned权限 |
|---|---|---|---|---|
| 主聊天target Query | 原facet/token | initialize-observed | cell revoke＋UI receipt | borrowed关闭0 |
| 两个同provider tab | 各自Query，不互借 | 各自投影 | 原tab/ticket/epoch | 不因空warmup |
| Tab config原样透传 | target-specific factory | typed确实被调用 | existing reset/世代 | 不改Tab生命周期 |
| registry后备/Inline原config | unbound，不借chat | vault/candidate，scope unknown | session销毁/registry资格 | 不改inline执行规则 |
| cold base-probe | candidate | success-empty/failed分开 | 最后一订阅/retire/deadline | 本flightchild，不杀共享资源 |
| legacy非Claude | 原数组能力 | 不虚造typed权威 | 原guard等价 | 请求频率不变 |

### 3. 定向测试命令（实施后执行）

以下shell环境只放/tmp；每片使用新目录。先确认列出的新增test已创建；listTests必须准确命中指定文件，不能只看退出码0。所有执行都自然退出，不forceExit、不build、不运行npm安装/postinstall。

```bash
REPO=/Users/vincentwang/Documents/NoteVault/tools/claudian
SANDBOX=$(mktemp -d /tmp/claudian-command-verify.XXXXXX)
mkdir -p "$SANDBOX/home" "$SANDBOX/tmp" "$SANDBOX/cache" "$SANDBOX/vault"
cd "$REPO"
jrun() {
  env HOME="$SANDBOX/home" USERPROFILE="$SANDBOX/home" \
    TMPDIR="$SANDBOX/tmp" TEST_VAULT="$SANDBOX/vault" \
    node "$REPO/scripts/run-jest.js" --config "$REPO/jest.config.js" \
    --runInBand --cacheDirectory "$SANDBOX/cache" "$@"
}
vunit() {
  jrun --selectProjects unit --runTestsByPath "$@" --listTests &&
  jrun --selectProjects unit --runTestsByPath "$@"
}
vint() {
  jrun --selectProjects integration --runTestsByPath "$@" --listTests &&
  jrun --selectProjects integration --runTestsByPath "$@"
}
```

每片命令（同一shell中接上环境；跨Bash调用须重建环境与源码根cwd）：

```bash
# U0：typed出口/P1不变
vunit "$REPO/tests/unit/providers/claude/runtime/QueryCommandDiscovery.test.ts" \
  "$REPO/tests/unit/providers/claude/runtime/ClaudianService.test.ts"

# U1：catalog
vunit "$REPO/tests/unit/providers/claude/commands/ClaudeCommandCatalog.test.ts"

# U2：Dropdown
vunit "$REPO/tests/unit/shared/components/SlashCommandDropdown.provider.test.ts" \
  "$REPO/tests/unit/shared/components/SlashCommandDropdown.test.ts"

# U3：probe；另人工核mock资源计数与自然进程退出
vunit "$REPO/tests/unit/providers/claude/commands/probeRuntimeCommands.test.ts"

# U4：既有接线与共享文件回归
vunit "$REPO/tests/unit/features/chat/tabs/TabManager.test.ts" \
  "$REPO/tests/unit/features/chat/tabs/Tab.test.ts" \
  "$REPO/tests/unit/features/inline-edit/ui/InlineEditModal.test.ts" \
  "$REPO/tests/unit/providers/claude/runtime/QueryCommandDiscovery.test.ts"

# I4：新增真实组件链；只能在文件落地后列测/运行
vint "$REPO/tests/integration/providers/claude/commands/CommandDiscoveryReceipt.test.ts"

# 仅静态检查，不build/部署
npm --prefix "$REPO" run typecheck
```

typecheck的共享树既有失败须与冻结基线对比，不擅自修其他工作线。独立reviewer复核W4实际diff及上述链；测试通过数不能代替入口矩阵。

### 4. 真实门与收口

本案未运行真实probe。获准独立安全vault、有限政策及成本/hooks/MCP范围后，再实测零user输入初始化、直接childexit、取消/EOF/超时与清理、candidate对target范围差异；不拿fake childexit或96个unit绿作真实证明。

交付分两层：① typed生产链/host有限等待通过可关闭本片确定性接线门；②真实init、费用/副作用、后代及跨catalog/reload接续仍逐项未关，不称完整C5生产就绪。未有外部已确认资源barrier时，不开启新的跨catalog自动Retry/热接续。真实门失败返回具体unavailable/cleanup-failed与No-Go，不扩大Stop/R/S/P2/P3兜底。

## 关联

- [[tools/claudian/docs/designs/2026-11-08-upstream-compat-remaining-implementation-contract]]，§8 C5及真实门。
- [[tools/claudian/docs/designs/2026-11-08-command-discovery-query-scope-receipt-contract]]，P1与完整P2/P3边界；本案仅最小接线，不替代该草案。
- [[tools/claudian/CLAUDE]]
- [[tools/claudian/src/core/CLAUDE]]
- [[tools/claudian/src/providers/claude/CLAUDE]]
- 官方API核对：[Claude Agent SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript)；当前行为以installed实现与实测为准。
