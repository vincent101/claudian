---
type: design-decision
status: confirmed
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - claudian
  - process-lifecycle
  - orphan-reclamation
  - crash-recovery
---

# Claudian 孤儿 CLI 子进程回收方案

## 背景与问题

Obsidian 被强退/崩溃/被 kill 时，插件为每个 tab spawn 的 `claude` CLI 子进程不会退出：`ppid` 变 1 被 launchd 收养，存活 31 小时持续占 CPU，并继续写自己的 transcript jsonl（435 MB / 179 MB）。同一进程第二次 `--resume <sessionId>` 会与旧进程双写同一 jsonl，造成 transcript 分叉。

根因不是"清理链有 bug"，而是**清理链是本进程内的动作，而进程已不存在**：

1. 唯一的回收路径是 `ClaudianView.onClose()` → `TabManager.destroy()` → `destroyTab()` → `tab.service.cleanup()` → `ClaudeChatRuntime.cleanup()` → `closePersistentQuery()` → `Query.close()` + `queryAbortController.abort()` → `customSpawn` 里注册的 abort 监听 `child.kill()`。整条链依赖本进程活着。（既有读数：事故窗口的 `transcript-tail.current.jsonl` 只有 `tick_start/tick_end`，无 `query_close`，与"链没跑完"一致。）
2. **没有任何持久化的进程身份**：`src/providers/claude/runtime/customSpawn.ts` spawn 后不记录 `child.pid`，全仓 `grep` 无 `.pid`/`process.pid` 使用。所以事后（新实例）连杀谁都不知道，本次靠人工 `kill 57414 58005`。
3. **macOS 没有父死信号**：`PR_SET_PDEATHSIG` 为 Linux-only，darwin 无对应物；POSIX 也不存在进程领养/接管，新实例收不到任何继承关系。
4. **stdin EOF 不足以杀它**：本机实测，父进程死亡后子进程不因 stdin 管道关闭而退出（事实 2 的 31 小时存活）。CLI 内部对输入 EOF 的处理不在插件契约内。
5. 3.3.2 的 lease 看门狗（`TurnCoordinator` 停滞 force-settle）是**进程内**机制，对孤儿无效，不作为解法。

设计目标：Obsidian 非正常结束时，插件 spawn 的 CLI 必须可被回收；回收本身不得误杀任何仍在使用的会话/其他实例/用户终端进程。

**核心约束（实测结论，决定方案形态）**：本机 macOS 15.4 / Darwin 24.6 上 `ps -E`、`ps eww` **都不返回其他进程的环境变量**（对同 UID 进程实测 0 命中），因此"用 env 标记做身份"这条常见做法在本平台不可行——不要走这条路。

## 用户裁决（2026-11-10）

用户选「只做 A」：接受 A 的回收时延边界（下次打开该 vault 才回收），不加分离式看门狗；方案 B 作为增量留存，不实施。实施时机用户要求「先 hold」，尚未开工。

## 方案设计

### 0. 可达身份判据（所有方案的共同基础）

回收的前提是能回答"这个 PID 现在还是不是我们 spawn 的、还属不属于本 vault 实例"。四元组，任一不符即拒绝动手：

| 判据 | 取法 | 覆盖的误杀场景 |
|---|---|---|
| `lstart` token（秒级启动时刻字符串） | spawn 后立刻 `ps -o lstart= -p <pid>` 原样存下，回收时字符串严格相等（实测跨调用稳定） | pid 复用（新进程几乎不可能同秒启动） |
| argv 签名 | `ps -ww -o command=` 必须含 `--output-format stream-json --verbose --input-format stream-json`（实测 SDK 固定前缀：`["--output-format","stream-json","--verbose","--input-format","stream-json"]`），且含我们传入的 CLI 目标路径；有 `--resume` 时其值须等于登记的 sessionId | 用户终端手动跑的 `claude`（无 stream-json 三件套）、其他工具的 SDK 会话 |
| `ppid` 关系 | `ps -o ppid=` 必须 ∈ {1, 登记的 ownerPid} | 用户 shell 下的 claude（ppid 是 zsh/tmux，两者都不是）；同时也排除了"杀了别人的进程树" |
| 进程组 | `pgid == pid` 当且仅当我们以 `detached: true` spawn（实测成立） | 组杀越界：进程组杀只允许在"我们亲手 detached 且 pid>1"的前提下执行 |

补充（仅对 `ppid==1` 的候选，最多几只）：`/usr/sbin/lsof -p <pid> -a -d cwd -Fn` 取 cwd，须等于本 vault 路径。实测可用，单次约数十毫秒。

owner（就是我们自己，`process.pid`，插件跑在 Obsidian renderer 里）同样登记 pid + lstart token + `pluginGeneration`（每次 onload 生成的随机串）。

### 1. 推荐方案 A：自持注册表 + 启动清点（sweep）+ 进程组圈定

**A-1 注册（`customSpawn`）**

- `spawn(..., { detached: true, stdio: ['pipe','pipe', …], windowsHide: true })`：让每个 CLI 成为独立进程组组长（实测 pgid==pid，孙子进程共用该 pgid），这是后续"组杀连 MCP server / bash 工具一起收"的前提。stdio 全显式，数据通路不变。
- spawn 返回后**同步**（不 await、不落任何 await 之前）读 `ps` 取 `lstart`/`ppid`，写 `<vault>/.claudian/processes/<nonce>.json`：`{v, nonce, cliPid, cliStartToken, argvSignature, sessionId?, spawnSite, ownerPid, ownerStartToken, pluginGeneration, createdAt}`。写入用 `tmp + rename`（原子），目录 `0o700`、文件 `0o600`。
- 一进程一文件（而非单 JSON 数组）：多实例并发写不竞争、天然可 GC、单文件损坏只损失一条。
- `child.on('exit')` 里删文件（与既有 `onExit` 回调互不依赖）。
- abort 路径改为**组杀 + 升级**：`process.kill(-pid, 'SIGTERM')` → 3 s 未退则 `SIGKILL`；只有 `detached` 分支才允许负 pid（否则 `-pid` 会命中 Obsidian 自己的进程组——致命，硬编码守卫）。
- 同时把 SDK 侧的 `child.kill()` 包一层同名覆盖（`ChildProcess.kill` 是原型方法，实例上赋值即可，保留 `killed` 语义），让 `query.close()`/transport 的 `kill("SIGTERM")` 也变成组杀，顺带修掉"正常关闭时孙子进程残留"（2026-09-25 事件同源）。

**A-2 清点（`main.ts onload`）**

在 `getVaultPath` 之后、`registerView` 之前同步扫一遍（此刻本进程尚无任何 runtime，`live` 集合为空，是最干净的判定时刻）。逐条决策：

| # | 条件（按序求值，命中即停） | 动作 |
|---|---|---|
| 1 | 文件不可解析 / `v` 不符 | 删文件，**不杀**，记 `orphan_skipped:bad_entry` |
| 2 | `cliPid` 已不存在（`ps` 无行） | 删文件 |
| 3 | 四元组任一不符 | 删文件，**不杀**，记 `orphan_skipped:identity_mismatch` |
| 4 | `ppid == 本进程 pid` 且 nonce ∈ 内存 live 集合 | 保留（正常在跑） |
| 5 | `ppid == 本进程 pid` 但 nonce 不在 live 集合，或 `pluginGeneration != 本代` | 判孤儿 → **杀**（进程内泄漏 / 插件 reload 遗留） |
| 6 | owner 存活且 `ownerStartToken` 相等（另一实例/另一窗口在用） | 保留 |
| 7 | 其余（owner 已死或 token 不符，此时 `ppid` 必为 1） | 判孤儿 → **杀** |

杀死：`SIGTERM` 到该进程组 → `setTimeout(3000).unref()` 复查仍活则 `SIGKILL` → 删文件 → 记 `orphan_reap`（outcome=`terminated|killed|vanished`）。TERM 同步发（不阻塞加载），升级复查异步。

**A-3 兜底清点时机**

- 每次 `startPersistentQuery` 前再扫一遍（成本一次目录读 + N 次 `ps`，N≤tab 数）；覆盖"同进程内条件 5 的泄漏"与"上一个窗口同进程崩溃"。
- `onunload`（插件被禁用/重载）：对本进程 live 集合做一次组杀（`reapOwnLive()`）。当前 `onunload` 只存状态、不碰进程，插件 reload 会直接留孤儿——这是本次一并修的第二个缺口。
- 不做定时器：无收益，且增加长尾噪声。

**A-4 失败/降级**

- `ps` 调用失败/超时（1 s）→ 判"不可验证" → **不杀**、保留条目、下次再试，记 `orphan_skipped:unverifiable`。
- 注册失败（写盘异常）→ 该 runtime 无回收能力（等同现状），会话照常工作，记 `cli_process_register_failed`。
- 非 darwin 平台 → 探针 no-op，sweep 整体跳过并各记一次 `orphan_skipped:unsupported_platform`。
- `kill` 得 `EPERM/ESRCH` → 记 outcome，不重试风暴。
- 已知限制：**该 vault 的插件从未再加载一次，孤儿就永远不被回收**（含插件被永久禁用的情形）。这是 A 的边界，也是下面"待裁决点"的由来。

### 2. 候选方案 B：A + 分离式看门狗（秒级回收）

在 A 之上加一个**不进数据通路**的 sidecar：spawn 时额外开一条 fd 3 管道，起一个 detached 的极小守护进程（`sh`，无外部依赖），阻塞读 fd 3；Obsidian 一死 fd 3 即 EOF → 守护进程按 A 的四元组校验后组杀 CLI，然后自杀。

- 增益：回收窗口从"下次打开该 vault"缩到数秒，transcript 分叉窗口同步缩小。
- 代价：每会话多一个常驻进程；多一条 fd 的传递与继承边界（不能被 CLI 误读、不能阻塞）；守护进程自身可能先死（此时退化为 A，因此 A 仍是必需的地基）；守护进程杀自己之前同样要做身份校验，否则 pid 复用会打歪。
- 结论：B ⊃ A，不是替代关系。A 单独已经满足"必须能被可靠回收"的硬要求，B 换的是时延。

### 3. 被否的路径与具体理由

- **C 仅进程组/job control**：组杀需要执行者。Obsidian 被强杀后没有存活者知道 pgid，组杀无人发起——只解决"正常关闭残留孙子进程"，对本次事故无效。故只作为 A 的机制件（detached + 组杀）保留。
- **D 守护 wrapper 放进 stdio 通路（guardian parent）**：为了异常退出，把每一路会话的输入输出都加一跳转，wrapper 任何缺陷都放大为全会话故障；435 MB 流的背压/半关闭/EPIPE 语义要在 wrapper 里重新实现一遍。风险与收益不成比例。
- **E launchd LaunchAgent / 常驻外部 daemon**：引入需要用户安装、无法随插件自运维的外部常驻物，违反"自主可控 + 简单透明"；且插件是唯一知道"哪个 pid 属于哪个 vault 会话"的一侧。
- **F 复用 CLI 自带文件（如 `~/.claude/ide/*.lock`）反查 pid**：不是我们的契约，CLI 升级即失效（本项目对上游兼容性已有教训）。
- **G 用环境变量标记身份**（直觉上最优雅）：**本机实测不可行**——macOS `ps -E`/`ps eww` 读不到其他进程的 env（同 UID 也读不到），无 `/proc`。此条已实证排除，避免后来者重试。

### 4. 方案推演（照触发项执行）

- **规则求值序**：上表 1→7 的顺序是有意义的。若把 6（owner 存活 → 保留）提到 5 之前，插件 reload 场景会被判"owner 存活 → 保留"，泄漏不被回收——这正是必须"先看是否本进程、再看是否他人"的原因。具象：插件事务内 live 集合有 {nonce1}，磁盘上有 {nonce1(A 代), nonce2(A 代), nonce3(B 代)}，本代 = B；结果 nonce1 保留（条件 4）、nonce2 被杀（条件 5）、nonce3 保留（条件 4）。
- **跨步骤衔接**：spawn→写注册表之间存在一个极短窗口（`ps` 读数 + 一次文件写，毫秒级）。若 Obsidian 恰好死在此窗口，该 CLI 无记录、成为本轮无法回收的孤儿。不可消除（pid 只能 spawn 后才有），只能压到最小：写盘紧接 spawn、中间不 await；窗口量级〔推算〕< 10 ms，相对 31 小时的事故量级可忽略，且不引入新风险。反向：exit 删除与 sweep 读取同文件——sweep 读到的可能是刚被删的条目，`ps` 查无此行 → 走条件 2，安全。
- **时序语义**：① 同一秒内 pid 复用并同时满足 argv 三件套 + ppid 关系的概率〔推算〕极低；且即便命中，条件 3 失败也只是"删除记录不杀"，方向是安全侧。② 强杀 A 实例后立即启动 B 实例：若 A 的 CLI 尚未完成 reparent（`ppid` 短暂仍是已死的 A pid），条件 7 的 owner 存活校验失败 → 仍判孤儿 → 杀，正确。
- **论证链**：前提①无存活者知晓 pid ⇒ 必须持久化身份（条件：身份可验证）；前提②macOS 无父死信号、env 不可读 ⇒ 唯一可靠身份面是 `ps` 可见的 pid/lstart/argv/ppid；结论：pid+lstart+argv+ppid 四元组 + owner 存活校验是可达的判据集合，A 成立。反例（推翻哪一步）：若某会话的 CLI 被 `exec` 替换成另一程序且 lstart 不变（同 pid 原地 exec，lstart 描述的是进程创建时刻，exec 不重置）——此时 argv 签名会变，条件 3 拦住，不杀；若攻击者伪造注册表指向"某同 vault、argv 恰好带 stream-json、ppid==1"的进程，A 会杀它——已接受为残余风险（该攻击者已具备登录用户写权限），且 lsof cwd 校验可进一步把范围锁到本 vault。
- **框架结构**：注册表与探针放 `src/core/runtime/process/`（provider 中性），Claude 只是调用方——正交性成立；数据流 `spawn → 写文件 → onload 读文件 → kill` 单向无环；扩展点朝扩展方向（Codex `CodexAppServerProcess`、ACP `AcpSubprocess` 有完全相同的洞，接入只需在各自 spawn 后调同一注册接口，不改核心）；退化即特例（目录为空 = 空扫描；`ps` 不可用 = no-op；单条目损坏 = 跳过一条）。
- 无费率/金额公式，不触发口径量纲走查。

### 5. 交付物规范

**① 目标目录树（锚定仓库根 `/Users/vincentwang/Documents/NoteVault/tools/claudian`）**

```
src/core/runtime/process/                       (新目录)
  types.ts                    注册条目/身份/裁决类型
  ProcessIdentity.ts          ps/lsof 探针（含纯函数解析，便于单测）
  CliProcessRegistry.ts       注册/注销/sweep/reapOwnLive
src/providers/claude/runtime/customSpawn.ts     (改) detached + 注册 + 组杀
src/providers/claude/runtime/ClaudeQueryOptionsBuilder.ts  (改) 注入 vaultPath/registry/generation
src/providers/claude/runtime/claudeColdStartQuery.ts       (改) 同上
src/providers/claude/commands/probeRuntimeCommands.ts      (改) 同上（探测进程同样登记）
src/providers/claude/transcript/ClaudeTranscriptDiagnosticLog.ts (改) phase 联合与字段白名单
src/main.ts                                    (改) onload sweep / onunload reapOwnLive / 实例生命周期标记
tests/unit/core/runtime/process/               (新目录) ProcessIdentity.test.ts、CliProcessRegistry.test.ts
tests/unit/providers/claude/runtime/customSpawn.test.ts (改)
tests/integration/core/runtime/process/orphanSweep.test.ts (新，真进程端到端)
```

运行期数据目录（**不在仓内**，落在用户 vault）：`<vault>/.claudian/processes/`。

**② 命名规则**

- 注册文件：`<nonce>.json`（nonce = 32 hex，每次 spawn 一个，语义是"本次 runtime 生命周期"）。同目录 `*.tmp` 为写入中间态，sweep 时一并清理。
- 诊断文件：`.claudian/diagnostics/process-lifecycle.{current,previous}.jsonl`（沿用既有 `fileBase` 旋转约定，与 `transcript-tail`/`history-render`/`markdown-render` 并列）。
- 诊断 phase：`cli_process_registered` / `cli_process_unregistered` / `cli_process_register_failed` / `orphan_sweep` / `orphan_reap` / `orphan_skipped` / `instance_lifecycle`（detail=`onload|onunload|view_close`，用于事后区分"干净卸载"与"崩溃"，正是本次诊断缺口）。新增字段：`pid`、`ownerPid`、`signal`、`spawnSite`；`reason` 增补 `bad_entry|identity_mismatch|unverifiable|unsupported_platform`；`outcome` 增补 `terminated|killed|vanished`。

**③ 产物清单**

| 路径 | 用途 | 消费者 |
|---|---|---|
| `src/core/runtime/process/CliProcessRegistry.ts` | 注册/清点/回收 | `customSpawn`（各 provider）、`main.ts` |
| `src/core/runtime/process/ProcessIdentity.ts` | pid 身份探针 | 注册表 |
| `.claudian/processes/*.json` | 运行期进程台账 | 下次启动的 sweep |
| `.claudian/diagnostics/process-lifecycle.current.jsonl` | 回收可观测 | 人工排障、诊断脚本 |
| 本设计文档 | 决策留痕 | 后续实现/复核 |

**④ 归属引用**：仓库 `CLAUDE.md` 的 Storage 表为产物索引（新增 `.claudian/processes/` 行）；`src/core/CLAUDE.md` 为本模块层级归属；`src/providers/claude/CLAUDE.md` 的 "Custom Spawn — Electron Workarounds" 节增补 "Orphan Reclamation" 段；vault 根 `.gitignore` 增补 `.claudian/processes/`（与既有 `.claudian/diagnostics/`、`.claudian/ask-relay/` 同列）。

## 风险与权衡

1. **误杀（首要风险）**——判据已按"安全侧失败"设计：任何一条判据拿不到或对不上 → 不杀、只删记录；只有"四元组全中 + owner 已死/本代非 live"才动手。四条具象场景：用户终端跑 `claude`（不进注册表；即便被伪造条目指向，`ppid` 是其 shell → 拒杀）；pid 复用（`lstart` 同秒碰撞 → 拒杀）；多 vault（注册表按 vault 隔离，物理不可见）；同 vault 双实例/双窗口（owner 存活 + token 校验 → 保留）。
2. **负 pid 组杀的越界**：`detached` 未生效或 pid 异常时 `kill(-pid)` 会打到 Obsidian 自己的进程组。硬性守卫：仅当"本次确实用 detached 且 pid 为安全整数 >1 且 pgid==pid（读 `ps` 证实）"才允许负 pid，否则退化为单 pid 杀。
3. **启动耗时**：onload 同步 `ps` 调用（1+每条目 1 次，单次约数毫秒〔推算〕）。条目数上限 = tab 数，可接受；探针设 1 s 超时，超时按"不可验证"跳过。
4. **注册表可被同用户伪造**：可把需要杀的进程指向他人，但仍需满足 argv 三件套 + `ppid` 关系 + `lstart`，且可再叠加 lsof cwd == 本 vault。接受为残余风险，不做签名（密钥同样落在本地，收益为零）。
5. **需用户裁决的一点**：是否接受 A 的回收时延边界（"下次打开该 vault 才回收"）——若不接受，则追加方案 B 的看门狗（每会话 +1 进程、+1 fd 通道），核心判据与代码复用 A。**默认推荐先落 A**。
6. **范围外**：Codex（`CodexAppServerProcess`）与 ACP（`AcpSubprocess`）的相同洞不在本次改动内，中性模块为其预留接入点，作为后续小切片。
7. 不改 `.claude/mcp.json` 及其符号链接；不引入外部服务/依赖（`ps`/`lsof` 为 macOS 自带）。

## 验证方式

**单元**（`npm run test -- --selectProjects unit -- tests/unit/core/runtime/process`）：决策表 7 行逐条；探针解析（`ps` 输出样例 → 结构体，含无此行/多行异常）；注册表原子写与损坏文件跳过。

**集成（真进程，可在本机跑）**：`orphanSweep.test.ts` 用一个 spawner 进程 detached 起 `sleep` 并写注册表，然后其自杀；第三个进程执行 sweep，断言 `ps -p <pid>` 为空、注册文件被删。反向用例：注册表指向一个 `ppid` 非 1 的存活进程 → 断言未杀且产出 `orphan_skipped identity_mismatch`。

**人工核对点（上线前必做）**：

1. 打开 Obsidian，发一条消息使 CLI 起来；记 `ps -o pid=,pgid=,command= -p <cli pid>`（应 pgid==pid）。`kill -9 <Obsidian 主进程>`；确认孤儿 `ppid` 变 1。
2. 重开 Obsidian → 5 s 内该 CLI 消失，`.claudian/processes/` 空，`process-lifecycle.current.jsonl` 出现 `orphan_sweep` + `orphan_reap`；随后 `--resume` 新进程写出的 jsonl 无分叉（`grep -c '"type":"user"'` 与预期一致）。
3. 双实例：两个 vault 各开一个 Obsidian，`kill -9` A 的实例；确认 B 加载后 B 自己的 CLI 仍在（pid 不变），A 的 vault 目录里的孤儿被清。
4. 误杀回归：在 vault 目录手动起 `claude`（不带 stream-json 参数），并伪造一条指向它的注册表条目 → 确认未被杀、日志为 `identity_mismatch`。
5. 干净退出：正常 Cmd+Q 后 `.claudian/processes/` 为空且 `ps` 无残留 CLI；`instance_lifecycle detail=onunload` 存在（用于与崩溃场景对照）。

## 关联

- 现有 spawn 实现：[[tools/claudian/src/providers/claude/runtime/customSpawn.ts]]
- 清理链：`ClaudianView.onClose` → `TabManager.destroy` → `destroyTab` → `ClaudeChatRuntime.cleanup` → `closePersistentQuery`
- 同源问题的既有修复：2026-09-25 "orphaned fd holder 挂死 turn"（commit `66384764f`，`customSpawn` 的 stdout 强制 EOF）
- 启动期清扫先例：`cleanupAskRelayFiles(vaultPath)`（`src/main.ts` onload）
- 上游同类能力缺口：[[tools/claudian/src/providers/codex/runtime/CodexAppServerProcess.ts]]、[[tools/claudian/src/providers/acp/AcpSubprocess.ts]]
