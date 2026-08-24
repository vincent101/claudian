---
type: design-decision
status: confirmed
target: .obsidian/plugins/claudian/main.js
tags: [architect, claudian, bug-fix, stop-hook]
---

# Claudian Stop hook 自激循环修复方案

## 背景与问题

### 事故

2026-08-20 18:29-19:48（1h19m），quant_research 长会话（b769c46c）Stop hook 持续 block 263 次，文案 "Background subagents are still running"。实际后台任务全部完成、进程为零、harness 任务表空（TaskOutput 全部 "No task found"）。session 内无法自愈，最终用户手动打断。

### 历史前科（同模式）

- **2026-08-09 补丁注释自述**："进程退出丢失状态的 agent 会永远卡在 Map 里，导致 stop hook 永久 block" → 打了 STALE_MS=2h 僵尸清理补丁（main.js L84784 附近）。
- **2026-08-19 零星 block 两次**（08:44、09:45 UTC）：同源头，未成持续循环（活跃期自愈回路销了账）。

### 根因（三层，均已源码实证）

1. **权威销账信号被扔**：harness 完成通知（task-notification，queue-operation 消息）实时链路不解析（`transformSDKMessage` 无该 case，L60445 起），仅会话加载回放时认（`collectAsyncSubagentResults`，L58820）。
2. **空闲期失明**：非用户消息发起的轮次（通知自动唤醒轮 + Stop block 续轮）无 responseHandler，chunk 全进 `_autoTurnBuffer`（L62400），`renderAutoTriggeredTurn` 只取 text（L90272-90300），工具事件不进 SubagentManager → Map 永不清理。用户消息发起的轮次 handler 在（`isTurnCompleteMessage` 仅认 result，L60978），有自愈回路——**故复发条件为"后台任务在空闲期完成"**。
3. **门卫无保险**：Stop hook（`createStopSubagentHook`，L59808-59826）fail-closed（getState 抛错即 hasRunning=true）、无熔断、block 文案为静态常量（不含滞留 agentId）。判定函数 `hasRunningSubagents()` 谓词内做破坏性清理副作用，且 `createAsyncTask` 不设 startedAt → pending 条目首次 hook 即被误删（08-09 补丁连带伤）。

### 调查过程

三轮：主会话根因定位（transcript 取证）→ architect-xhigh 复核（推翻初始三点方案，给出 P0-P4）→ architect-max 理想路径终审（verdict：需小修、无硬伤，6 项修正）。修正已全部并入本终版。

## 方案设计

### 架构原则（贯穿全部修复）

**完工通知事件流 = 终态唯一权威销账信号；Task tool_result = 身份绑定信号；内存 Map 降级为 UI 投影、任意时刻可从 transcript 全量重建（`loadSDKSessionMessages` 回放逻辑已具备该能力）；TaskOutput 解析与僵尸清理降级为投影修正/兜底。**

现状是"Map 为唯一真相源 + 五个分散写入点"（Task tool_result L84687 / TaskOutput tool_use L84711 / TaskOutput tool_result L84719 / 加载回放 L59244 / 谓词内清理 L84791），信号源各自为政——08-09 补丁把清理塞进谓词正是补丁摞补丁的实证。不写明本原则，下次加信号源还会再散一次。

### 六条修复（终版，含全部审核修正）

| # | 名称 | 内容（修正后准确表述） | 关键实现点 |
|---|---|---|---|
| 1 | 熔断 + fail-open | 同一聊天轮序列内（口径：**自上次用户消息 / 上次放行以来的连续 block 计数**，非"同一轮"——Stop hook 语义下每轮至多一次 block）连续 block 超 3 次即放行并向用户出 notice；getState 抛错时改放行（原 fail-closed） | hook 无状态（纯闭包），计数器放 provider 上；熔断与 fail-open 是同段代码两半，**必须一起上** |
| 2 | 通知直接销账 | 实时解析 task-notification，到达即销账。**必须认全终态：completed / killed / failed（transcript 实证存在 killed 通知）**。限定：只销已激活条目（activeAsyncSubagents，键=agentId=task-id，L58099/L58835）；launch 在途 pending 条目仍依赖 handleTaskToolResult 转正 | `transformSDKMessage` 加 queue-operation case；`routeMessage` 入口即可取原始消息，用现成 `extractXmlTag`（L58848） |
| 3 | 空闲期管道回喂 | 无 responseHandler 的轮次（通知自动唤醒轮 + Stop block 续轮，**两者机制相同须都覆盖**）的工具 chunk 回喂 SubagentManager 处理链 | `renderAutoTriggeredTurn` 改造；顺带修 UI 零渲染与 usage 丢弃 |
| 4 | 记账查账分离 + 打断对账 | 清理逻辑移出 `hasRunningSubagents()` 谓词（独立 reconcile()）；pending 条目用创建时间戳计时（修 createAsyncTask 不设 startedAt 的误删三连：launch 在途期无保护 / 永不转正 / DOM 永久卡 pending）；**打断时对账而非即销**（查通知/心跳确认真终态才销，在跑则保留——异步语义核心场景就是打断主对话后台继续） | `cancelStreaming`（L80780）挂对账 |
| 5 | block reason 带工号 | 静态常量改动态函数，携带滞留 agentId 让 AI 定向 TaskOutput。限定：仅 active 条目（pending 无 agentId，带 taskToolId 无用）；内部 ID 不进用户可见 UI | STOP_BLOCK_REASON 常量 → 函数 |
| 6 | 心跳兜底 | Map 条目活性判据换 sidecar 文件 mtime 心跳（`getSubagentSidecarPath` 已存在，L59168/L59279），失联超 N 分钟视为死；**STALE_MS=2h 保留不缩**（startedAt 非心跳，缩短会误杀 30min+ 真实长任务）。不能用 `extractFinalResultFromSubagentJsonl` 判终态（agent 在跑时也返回最后 assistant text） | 四层防御的最后兜底 |

### 分阶段推进计划

**前置（阶段 0）**：确认 Claudian 源码工程路径（`main.js` 为 esbuild 打包产物，不宜直接改；vault 内有多个 main.js.bak-* 佐证源码工程在外部）。实施走 implementer 路由，每阶段交付后 reviewer 复核。

**阶段 1（用户已拍板，先做）：修复 1 + 2**
- 两条正交：2 管"信号到了用上"，1 管"信号没到也出得去"。
- 附带条件（硬性，缺一打折）：① 修复 2 认全终态（completed/killed/failed）；② 修复 1 必须含 fail-open。
- **秒完成竞态缓解一并做**（成本低）：通知销账查无此账时，将 task-id 记入"已见终态"短表；pending 转正时比对补销。防"完成通知先于转正到达 → 白销 → 转正后滞留"。
- 验收：见"验证方式"V1-V4。

**阶段 2：修复 3（管道回喂）**
- 实施复杂度最高（动自动唤醒渲染管线），需专门测试：回喂后 UI 渲染空闲期工具活动不重复、不遗漏。
- 验收：V5。

**阶段 3：修复 4 + 5**
- 分离与对账；动态 reason。验收：V6-V7。

**阶段 4：修复 6（心跳）**
- 兜底层。需先实测 sidecar 写入频率定阈值（agent 深度思考期的静默时长）。
- 验收：V8。

**明确不在本方案范围**（2+1 及全六条均不治、不恶化）：空闲期 UI 显示动作（修复 3 顺带）、空闲期 token 统计（修复 3 顺带）、pending 误删的 UI 卡 pending（修复 4 治）之外无其他。

## 风险与权衡

| 风险 | 等级 | 缓解 |
|---|---|---|
| 熔断后保护退化为 best-effort：真有长任务在跑、AI 连续 4 次试图收工 → 放行，结果没人收 | 低（正常 AI 被 block 会去 TaskOutput block=true 等待，等待不算"连续收工"） | 放行时显式 notice 用户知情 |
| 秒完成竞态：通知先于转正 → 白销 → 滞留 | 低（agent 任务通常分钟级，launch 回执秒级） | "已见终态"短表比对补销（阶段 1 一并做） |
| 通知格式随 CC 升级变化 → 解析失败 | 中 | 失效后退化为熔断兜底（封顶 3 次）；解析失败记日志 |
| 修复 3 渲染层沿用"空闲期无动作"旧假设 → 重复渲染 | 中（阶段 2） | 专项测试 V5 |
| 心跳阈值误判长静默任务为死 | 低（阶段 4） | 先实测写频率再定阈值；误销后 Map 可全量重建 |
| 行为变化（非缺陷）：token 统计变准=数字变大；AI 刚派单就收工会被正当拦一次（pending 计时修正后） | — | 提前知悉即可 |

## 验证方式

- **V1（主事故回归）**：派后台 agent，等其在空闲期完成 → 应：通知销账、无 block、正常放行。
- **V2（通知失效）**：人为丢弃/破坏通知解析 → 应：最多 block 3 次 + notice，然后放行。
- **V3（fail-open）**：人为令 getState 抛错 → 应放行（不再永久 block）。
- **V4（killed 终态）**：后台任务被 stop（killed 通知）→ 应销账。
- **V5（阶段 2）**：空闲期完成 → UI 渲染工具活动、无重复；token 统计含空闲期。
- **V6（阶段 3）**：block 循环中手动打断后再发一条消息 → 自愈销账；打断时在跑任务保留保护。
- **V7（阶段 3）**：真滞留时 block 文案含 agentId（AI 可定向 TaskOutput），且该 ID 不出现在用户可见 UI。
- **V8（阶段 4）**：杀掉 agent 进程且无通知 → 心跳超时后条目清理，Map 可从 transcript 重建。
- **历史事件覆盖对照**：事件 A（08-20 主事故）→ V1/V2；事件 B（08-19 零星）→ V1；事件 C（08-09 进程死亡前科）→ V4（正常停）+ V2/V8（通知不来）。

## 实施进展与事故记录（2026-08-23 更新）

- **阶段 1（修复 1+2）**：✅ 已部署稳定（commit 6eefb74，观察期验证）
- **阶段 2 S1-S3**：✅ 已实施部署（fe2b87a/cf116c8/ea6e53f，分支 fix/stop-hook→hotfix/notify-lease）
- **阶段 2 S4+S5（61f7692）**：❌ 部署失败回滚（切 tab 消息消失+排队卡死），整体放弃
- **四层热修（全部已部署）**：fbd4de8 首消息丢弃（init 建轮锁通道）→ c5ad19d 纯通知幽灵租约 → cc27faf 交互计数泄漏（他 session 交付）→ 0133ab7 六项锁链修复+埋点
- **根因确诊（0823 深夜）**：轮次挂死家族=同病根三发作（无主消息一律建 auto turn）——fbd4de8/c5ad19d 治的是发作部位，99dca6b 幽灵守卫（auto turn 启动白名单：仅 assistant/stream_event）根治；bbb431f 补 finalize 渲染挂起保护。console 埋点链（Obsidian CLI dev:console 读取）是确诊关键
- **工具明细修复（0823 深夜~0824）**：8883b66 通知入口补齐 hydration（销账后立即补读工具明细）+ c8d079d 秒完成竞态补齐（early-settled 记录回流同款 hydration）——subagent 运行中工具明细实时显示恢复，0824 实测验证
- **当前线上**：hotfix/notify-lease@c8d079d，完整修复链部署，功能正常
- **S4+S5 方向**：v4 部分前提失效，v3 经价值审查暂缓（8883b66 已覆盖核心诉求、复杂度失衡）——未来按流式协议方向重起
- **远程仓库**：源码已 fork 到 vincent101/claudian（origin），hotfix/notify-lease 分支已推送，bundle 冷备在 release backup-0824
- **遗留**：网关"有首事件无终态"空流变体（0823 20:12 req 7270905e，200 透传无终态）待 model_proxy 线补修

## 关联

- 根因证据与三轮调查全记录：本对话（2026-08-20/21，session 4a3a332a）
- 事故 transcript：`~/.claude/projects/-Users-vincentwang-Documents-NoteVault/b769c46c-0f52-4217-9b37-2e15b605cc55.jsonl`
- 相关环境备注：architect 高档变体默认 opus 池，今日 opus 供应端经 model_proxy a2r 转换丢 system 消息致 agent 启动即死（`.model_proxy.log` 有 `unknown message role dropped (a2r)` 记录）；派单显式指定 sonnet 可绕开
