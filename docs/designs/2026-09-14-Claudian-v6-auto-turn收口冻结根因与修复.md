---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - claudian
  - auto-turn
  - transcript
  - p0
---

# Claudian v6 auto turn 收口冻结根因与修复

## 背景与问题

v6 首次真实处理空闲 peer 与连续 task-notification 时，transcript 的“同一 assistant message 分多行落盘”及 observer 重启共同破坏 auto turn 生命周期，造成租约挂死、人工消息 pending；现有证据尚不能把 11.8 分钟无 tick 等同于浏览器主线程同步阻塞。

## 方案设计

### 根因链定论

1. **真实形态与 turn 对应。** transcript `/Users/vincentwang/.claude/projects/-Users-vincentwang-Documents-NoteVault/6d0b7111-41be-4d9d-af81-87cf4634a0e3.jsonl:1623-1646` 依次是 A peer、A notification、B peer、B notification；据时间顺序，诊断 hash 对应 `a25081e1=A peer`、`f814d349=A notification`、`be431ef8=B peer`、`64602ae6=B notification`。B 与 notification 的 assistant 均把同一 `message.id` 拆成 thinking 行和 text 行，且两行都标 `stop_reason=end_turn`（1640-1641、1645-1646），没有 result。
2. **首要收口缺陷。** `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/transcript/ClaudeTranscriptTurnMapper.ts:163-173` 把任一 assistant `end_turn` 行立即视为整轮结束；因此 thinking 行先触发 finished，随后同 message.id 的 text 行因 `active=null` 被丢弃。`controlled-no-result.jsonl:5` 只有单一 text 终行，未覆盖“thinking/text 分行但共享 message.id”的真实形态。
3. **重复 begin 来源。** `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts:1069-1071` 每次 `session_init` 都重启 observer；`restartTranscriptObserver():2417-2432` 无同 session 幂等保护。旧 observer `stop()` 会 cancel 当前投影，随后 recovery 从 EOF 重建同一未收口 turn，故再次真实 acquire。诊断在 `AutoTurnProjectionController.ts:59-61` 的 `beginAutoTurn()` 成功之后记录，所以重复 begin 不是日志重复；中间 cancel/finish 未记诊断，形成“两个 begin、无 finish”的表象。原子拒绝仍在 `TurnCoordinator.ts:80-92`，但 observer 重启已先释放旧 lease。
4. **FIFO 被破坏。** mapper 遇到新 external user 会无条件覆盖 `active`（`ClaudeTranscriptTurnMapper.ts:115-136`）；故 A 未可靠收口时，A notification、B、B notification 继续改写归属，observer 队列与 mapper 当前 turn 脱节。
5. **冻结机制边界。** pending 已由挂死 lease 充分解释。tick 停止不能证明主线程阻塞：TailReader 在 `/ClaudeTranscriptTailReader.ts:118-135` await `onBatch` 完成后才安排下一 timer；observer 又在 `/ClaudeTranscriptTurnObserver.ts:129-131,183-195` 串行等待 projection/render/save。因此任一 render Promise 卡住就同时表现为“tick 停+lease 不释放”。16ms 仅证明该 tick 变慢，不能证明随后 11.8 分钟 CPU 长任务。重复 start 还会重置共享 StreamController 的 DOM/render 状态（`AutoTurnProjectionController.ts:67-129`），扩大异步 render 卡住概率，但现有日志不足以断言全 tab 主线程死循环。

### 修复（推荐）

1. **按连续逻辑 assistant message 实例聚合。** mapper 不再在首个 `end_turn` 行立即 finished；只在当前 turn 内聚合**连续相邻**且 `message.id` 相同的 thinking/text/tool 块，记录 terminal-candidate。`message.id` 不是跨 transcript 的全局唯一键；不同 id、分支/回放边界均先提交当前实例。遇到明确边界（不同 assistant id、system `stop_hook_summary`、下一 external user、兼容 result）先结束旧 turn再处理新行。真实样本存在终行后停在 `queue-operation`/`last-prompt` 乃至 EOF，故必须实现有界 quiet-settle；它只提交已见 `end_turn` 的 terminal-candidate，任何无 terminal-candidate 的轮询空闲不得成功收口。
2. **禁止 active 覆盖。** 新 external user 到达时，mapper 必须先输出前一 terminal-candidate 的 finished；若前轮无 terminal-candidate，则输出 interrupted/protocol-gap 并由 observer cancel 后再建新 turn，绝不覆盖。
3. **observer 单实例幂等。** `restartTranscriptObserver(sessionId)` 保存 active session/path；相同目标只保留现有 observer。仅 session/path 实变更才 stop+recover。并把 observer start/restart 串行化、加 observer instance generation，防并发 start 反序完成。
4. **回调超时自愈与诊断。** 对 `chunk`、render-finalize、save 分别设置有界超时；任一超时必须 invalidate→cancel→release，并让独立 tail/watchdog 继续运行，不能只记录告警。增加 `observer_start/stop/recover`、`lease_cancel`、`terminal_candidate/commit`、`callback_start/end/timeout` 与独立 watchdog。watchdog 与 tail 调度分离：若 watchdog继续而 tick不动，判定 async callback 卡住；两者都停且恢复后记录大幅 timer drift，才支持主线程阻塞。
5. **渲染隔离与严格交接。** auto projection 使用 turn-owned render state；开始新 turn 前断言前 turn 已 settle。禁止 `started()`直接清空另一个 turn共享的 `current*` 状态；异常/超时统一 invalidate→cancel→release。observer 必须按 `finished→released→promote next` 交接，禁止在前轮 `released` 前递归 promote 后轮。thinking-only 与 text-only走同一聚合/终结路径。

备选：仅给 end_turn 加固定延迟可快速止血，但依赖落盘时差且制造竞态，不采用；仅加 lease watchdog会掩盖 mapper/observer协议错误，也不采用。

## 风险与权衡

- `stop_hook_summary` 属当前 transcript 事实而非稳定 API，不能作为唯一结束标志；聚合器需同时支持不同 message id、result 与有界 quiet-settle。
- `message.id` 在抽样 transcript 中会跨非相邻区段复用；聚合键必须限定为当前连续实例，不能做文件级 `Map<message.id,...>`。
- watchdog 若仅观测而不触发 callback 超时取消，冻结仍需人工重启；本方案要求超时自愈，代价是可能把极慢但最终成功的渲染判为中断，超时值须由生产耗时分位数校准。
- hash 映射基于同一现场时间线；salt 随 runtime 随机，离线无法由 UUID重算。
- “全 tab 主线程阻塞”仍待独立 watchdog/long-task 证据；修复不得以未证实的 DOM 死循环为前提。

## 验证方式

1. 新增真实 fixture：A peer、B peer、两次 notification；每个终轮含共享 message.id 的 thinking(end_turn)+text(end_turn)+stop_hook_summary；另覆盖 text-only、同 id 多轮非相邻复用、终行后 `queue-operation`/`last-prompt`/EOF、tool_use→tool_result、多 tool_use、attachment 伴行。断言每 turn 恰好 `started×1→chunks→finished×1→released×1`，text 不丢，FIFO 为 A→notification A→B→notification B。
2. observer 测试：重复同 session `session_init` 不 restart；并发 restart 仅最新 generation 生效；未终结 turn 遇新 user 必须 cancel/finish 后再 start；严格断言前轮 release 先于后轮 start。
3. 集成红测：真实 JSONL 分批追加（thinking 与 text 跨两个 poll；terminal-candidate 后无后续边界），配真实 TurnCoordinator/AutoTurnProjectionController，断言 quiet-settle 能收口、无重复 begin、最终 `isBusy=false/isStreaming=false`、queued user 仅 pump 一次。
4. 卡顿与自愈：分别注入永不 resolve 的 chunk renderer、finalize renderer、save，确认 watchdog定位 callback 且超时后 cancel/release、后续 turn 可继续；注入同步 200ms busy-loop，确认 watchdog/tick 同时漂移，避免再把串行 poll 停摆误判为主线程冻结。
5. 全量执行 `npm run typecheck && npm run lint && npm run test && npm run build`。生产冒烟按 A(mid-turn)→空闲 B→两次 notification→手工消息；核对四轮均单 begin/finish/release、thinking-only 可见、人工消息不 pending，持续观察至少 15 分钟。

## 关联

- [[2026-09-09-Claudian空闲期宿主tab实时投影-v6-transcript感知]]
- [[2026-09-11-Claudian-v6生产回归诊断与修复]]
- [[2026-08-23-turn-lease偶发不释放根因定位-v2]]
