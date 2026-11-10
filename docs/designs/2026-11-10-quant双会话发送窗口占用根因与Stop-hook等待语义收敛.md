---
type: design-decision
status: draft
target: tools/claudian/src/providers/claude/hooks/SubagentHooks.ts
tags: [architect, claudian, stop-hook, turn-lease, diagnosis]
---

# quant 双会话"发送窗口占用"根因与 Stop hook 等待语义收敛

## 背景与问题

同一 Obsidian/Claudian 实例下两个长期会话行为分叉：

- **quant 引擎线**（58005 / `b63e58e8` / notevault-71）：忙碌时用户仍可发消息，后台继续干活。
- **quant 数据线**（57414 / `ddc4a138` / notevault-9e）：任务看似完成后窗口长期不释放，后续消息排队不推进。

本文只做只读诊断，结论基于注册表、进程表、transcript、`.claudian/diagnostics/` 与部署 bundle 实读；方案为设计级建议，未实施。

## 方案设计

### 1. 运行形态（实测，一致）

两个会话都是 Claudian 插件的 tab 会话：父进程为 Obsidian renderer（`ps -o ppid` = 56645），命令为
`claude --output-format stream-json --verbose --input-format stream-json ... --resume <sessionId> ...`，`entrypoint=sdk-ts`，进程状态 `S`，自 2026-11-09 09:46/09:47 存活约 28h。差异仅在外部目录参数（引擎线 `--add-dir ~/Documents --chrome`，数据线 `--add-dir ~/Documents/worktrees`）与注册表状态快照。两者运行的是同一份 11-08 22:17 前后部署的插件 bundle（停止 hook 仍为阻塞版）。

### 2. "发送窗口"是什么

不是 vault 内自定义队列/调度器，而是 Claudian **单 tab 独占 turn lease**：

- `src/features/chat/controllers/TurnCoordinator.ts:31-38`：user turn 与 SDK 自发 auto turn（task-notification 续跑）都必须持锁；锁被持有时用户输入只能进 `state.queuedMessage`，不创建消息、不注册 handler。
- 释放唯一路径：runtime 收到该 turn 的 `result` → `finish` → `release` → `processQueuedMessage()` 泵出队列（`TurnCoordinator.ts:133-153`）。

即"窗口占用"= lease 未释放，后续任务卡在 feature 层 UI 队列，与 CLI 侧 `queue-operation`（毫秒级消费）无关。

### 3. 故障点逐层定位（数据线，实测）

| 层 | 事实 | 证据 |
|---|---|---|
| 完成信号 | 03:20–06:36 UTC 有 7 个异步 agent 无终态 task-notification；sidecar 末行即 `[Request interrupted by user]` | `~/.claude/projects/.../ddc4a138.../subagents/agent-*.jsonl` 尾行；父 transcript 无对应 `<task-id>` 终态通知 |
| 占用锁 | 14:34:48 user lease begin → 14:35:47 才 settle；可见回复 14:35:27 已结束，其间 Stop hook 于 14:35:27/34/41 连续 block | diagnostics `lease_begin/settle_result/lease_finish`；transcript `hook_blocking_error` |
| 释放后 | 14:35:47 立即起 auto turn，直到 14:36:16 用户取消，取消时 `queueLength=1` | diagnostics `lease_begin ... leaseKind=auto`、`cancel_request queueLength=1` |
| 后续任务 | 卡在 feature 队列；进程存活（S、0.2% CPU）、CLI 队列最大等待 25s（正常） | `ps`；queue-operation 配对统计 |
| 机制 | 旧版 Stop hook 只要 `hasRunningSubagents()` 为真就返回 `decision:block`，理由 "Background subagents are still running..."；每 block 触发一轮新模型输出（还会再派 agent）；熔断阈值 3 次只打断单次循环 | Nov-08 bundle（`/tmp/mainjs_nov8.js` 由 `git show da40d052f:.obsidian/plugins/claudian/main.js` 得到）；`git show 9ac4ef2a0^:src/providers/claude/hooks/SubagentHooks.ts` |

因此故障链为：**中断/杀死的 agent 丢失终态信号 → 记账长期 running → Stop hook 每次收尾都 block → 模型被迫继续说话/继续派 agent → lease 一直被 user/auto turn 持有 → 用户消息排队不消费**。属于"锁未释放 + 事件自激"，不是进程死、也不是排队未消费。

### 4. 引擎线为什么"后台不占窗"（实测 + 推断）

实测：引擎线 14:30:16 派出 agent `aff24a29`，14:30:23 就出现**无错误**的 `stop_hook_summary`（放行），租约释放；该 agent 14:37:18 才完成，其后 14:37:21–14:37:45 以 auto turn 接续。即同一保护在引擎线 tab 上读到 `hasRunning=false`，尽管确有其派出的 agent 在跑。

这是**记账不同源/假阴**，不是设计好的"后台模式"：引擎线之所以表现良好，是阻塞保护在其 tab 上失效的副作用。具体旁路（hook 状态 provider 与 StreamController 是否绑到同一 `SubagentManager` 实例、还是 provider 闭包读到了被替换/清空的状态）无法从磁盘证据定案，需在 Stop 事件上插桩 `hasRunning` + `runningAgents` id 后才能确认（标注为推算）。

附带事实：14:33 部署的 3.3.1 构建已把 Stop hook 改为**恒放行**（`src/providers/claude/hooks/SubagentHooks.ts:7-22`），但两个运行中 tab 自 11-09 起未重载插件，仍持有旧的阻塞闭包，故行为未变。

### 5. 修复建议（方案级）

1. **立即止血**：重载 Claudian 插件，让 14:33 已部署的恒放行 hook 生效；4 个 SDK 进程会重启，会话走 `--resume` 续接（在跑的后台 agent 一并终止，现状本已不可用）。
2. **契约化**：明确"后台 agent 不占发送窗口"为产品契约——Stop hook 恒放行，后台结果由 task-notification 驱动的 auto turn 接续；不再用 Stop hook 阻塞等待（与 3.3.1 方向一致）。
3. **补完成信号**：中断/杀死路径必须对同一 agent 销账（`interruptAllActive → orphanAllActive` 已有，需验证在 stop-hook 阻塞态下仍可达）；以 CLI task 状态做一次对账兜底；2h stale TTL 缩到 15–30min 可配。
4. **lease 看门狗**：现有 `CANCEL_WATCHDOG_MS=5s` 只覆盖用户取消（`InputController.ts:1472-1510`）；补"非取消但有 block 循环、长时间无 chunk/settle"的 force-settle + 队列泵出。
5. **单一真相源**：Stop 事件诊断日志记录 `hasRunning` 与 runningAgents 列表；hook 读取的 manager 必须与 StreamController 写入的是同一实例（加运行时断言/共享引用），根治引擎线式假阴。

### 6. 推演

- **规则求值序走查**（同一具象样本：14:35:12 派 agent → 14:35:27 模型收尾）：旧规则 → block 3 次后放行，turn 延长 20s，auto turn 再占 29s；新规则 → 14:35:27 直接 result、lease_release、队列立即泵出。红绿判据：`lease_release` 距最后一条可见文本 ≤5s。
- **结构不变量**：`hasRunning` 的唯一真相源应是 StreamController 写入的 `SubagentManager`；引擎线实证存在"写入 A、hook 读到空/异地"的路径 → 违反单一真相源，需断言收敛（位置：`Tab.ts:2278-2280` 的 provider 闭包与 service 绑定）。
- **业务边界人群**：用户中断一个已派 2 个后台 agent 的 turn，随后立刻发新指令；新规则下应先放行并泵出队列，不等 agent 终态。

### 7. 风险与权衡

- 重载会杀掉当前 4 个 SDK 进程的回合与后台 agent；不可逆的部分只是未落盘进度。
- 恒放行后若 task-notification 丢失，后台结果可能无人消费——需要 UI 侧"后台任务"可见 + 手动收割入口作为兜底。
- TTL 缩短只影响存活判定，不会杀进程；但真正长跑（>30min）的 agent 会被判僵尸，需保留诊断与人工确认。
- 已接受权衡（实施期记录，2026-11-10）：lease 看门狗对"证据型静默"（有 running 工具但无 chunk）设 30min 绝对上限；单个合法超长工具调用（>30min 无 chunk）会被误杀并触发 runtime cancel，诊断以 `lease_stall_force_settle` / detail=`settled_blocked_too_long` 留痕。

### 8. 交付物规范

无新增产品产物（仅本设计记录）。代码改动均落既有文件：`src/providers/claude/hooks/SubagentHooks.ts`、`src/features/chat/services/SubagentManager.ts`、`src/features/chat/controllers/TurnCoordinator.ts`、`src/features/chat/controllers/InputController.ts`，不新建目录。诊断日志沿用 `.claudian/diagnostics/` 既有轮转文件。

### 9. 验证方式

- 单测：Stop hook 无 provider/异常一律放行（已有 `tests/unit/providers/claude/hooks/SubagentHooks.test.ts` 可扩展）；interrupt 后 running 记录清零；终态通知即时销账；TTL 边界。
- 复现：起一个 turn → 派后台 agent → 收尾；断言 `stop_hook_summary` 无 hookErrors 且 `lease_release` ≤5s；agent 完成时能看到 auto turn。
- 中断：含 2 个后台 agent 的 turn 被中断后，断言无残留 running；随后发消息，`queueLength=1` 且 release 后泵出。
- 观测：`.claudian/diagnostics/transcript-tail.current.jsonl` 的 `lease_begin/settle_result/lease_release` 时间线与注册表 `status`。

## 实施状态（2026-11-10）

用户裁决"2-4 派"，建议 2-4 已落地于 `feat/stop-hook-hardening`（并入 3.3.2），连带建议 5 的单一真相源一并收敛：

| 建议 | 落点 | 状态 |
|---|---|---|
| 2 契约化（恒放行） | `SubagentHooks.ts` 已于 3.3.1 改恒放行 | 完成 |
| 3 补完成信号 | `SubagentManager` 中断销账 + 终态通知销账 + 固定 20min stale TTL（不再可配） | 完成 |
| 4 lease 看门狗 | `TurnCoordinator.checkStall` + `onStallForceSettle`；`InputController`/`AutoTurnProjectionController.abandonStalledTurn` 各自隔离释放 | 完成 |
| 5 单一真相源 | Stop 快照改由 `createStopHookStateProvider()` 读 StreamController 写入的同一 `SubagentManager` | 完成 |
| 1 立即止血（重载插件） | 用户侧动作 | 待执行 |

## 关联

- [[2026-08-21-Claudian-Stop-hook自激循环修复方案]]
- [[2026-11-04-claudian-compact终态证据与病态agent-stopTask清理方案]]
- [[2026-08-09-claudian空消息与thinking-only根因调研]]
