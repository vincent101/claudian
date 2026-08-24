---
type: design-decision
status: draft
target: "[[2026-08-09-claudian历史保留backport]]"
tags:
  - architect
  - claudian
  - model_proxy
  - bug-investigation
---

# Claudian「空消息/空思考/工具没执行」运行期 bug 根因调研

## 背景与问题

多个 Claudian session 反复出现：模型声称"用户又发空消息"（实际用户没发）、伴随 "Thought for 0s" 空思考块、Bash 等工具"没执行成"；重启 Obsidian 不解决。任务：定位真实根因，给出修复/规避方案。

## 根因结论（证据链完整）

**一句话：nation route 的 kimi-k3（少量 glm-5.2）在长 agentic 上下文中间歇性返回"只有 thinking、没有正文、没有 tool_use"的响应（stop_reason=end_turn）；Claude Code CLI 2.1.197 内置的 `thinking_only_retry` 机制随即自动注入一条 user 消息"[Your previous response had no visible output. Please continue and produce a user-visible response.]"并续跑；kimi-k3 把这类"tool_result-only 的 user 轮 / SDK 注入的 nudge 轮 / 自己上一轮的不可见输出"误读为"用户发了空消息"，进入自我强化的抱怨-重试循环；思考里"计划"的工具调用从未真正发出，于是用户看到"工具没执行成"。**

三个症状是同一根因的三面：

| 症状 | 机制 |
|---|---|
| "Thought for 0s" 空思考 | kimi 返回 thinking-only 响应，Claudian 只渲染出思考块、无正文 |
| "用户又发空消息" | kimi 对 tool_result-only user 轮 / nudge 轮 / 自身不可见输出的误读（"(no content)" 是 Claude Code 对空可见输出的占位符，kimi 从 Claude Code 蒸馏轨迹中学到了这个说法） |
| "Bash 没执行成/被中断" | 工具调用只在 thinking 里"计划"，响应里从未包含 tool_use，根本没发出，自然没执行 |

### 关键证据

1. **投诉 100% 来自 nation 模型**：4 个受影响 session 中，"空消息"投诉按模型分布为 kimi-k3 107 次、glm-5.2 4 次、claude 0 次（同一 session 内 claude-opus-5/sonnet-5 段落 93 条消息无一投诉）。统计口径：transcript 中 assistant 消息 thinking/text 含"空消息"或"(no content)"。
2. **不存在真的空 user 轮**：3 个受影响 session 共 1841 条 user 消息扫描，0 条结构性为空（无空字符串/空数组/空 tool_result）。所有 tool_result 内容完整（投诉点前的 tool_result 有 1623-2725 字符正文）。
3. **thinking-only 响应真实存在**：transcript 中 kimi-k3 的完整消息（按 message id 合并流式分片后）有 content 仅含 thinking 块的消息，stop_reason=end_turn，output_tokens 71-84——与思考文本长度吻合，证明 kimi 确实只输出了思考就收尾，不是代理/SDK 丢了 tool_use（若丢，usage 会反映更多 output token）。
4. **SDK 自动 nudge 机制实锤**：claude CLI 2.1.197 二进制（/opt/homebrew/Caskroom/claude-code/2.1.197/claude）中含 `nudged`、`[Your previous response had no visible output. Please continue and produce a user-visible response.]`、`thinking_only_retry`、`nudge_exhausted`、`thinkingOnlyNudged:!0` 等字符串；transcript 中 thinking-only 消息的下一行正是这条注入的 user 消息（如 4eb3be5f 第 1131/1144/1283/1302/1366 行）。每个 query 最多 nudge 一次，再犯则 nudge_exhausted 结束本轮（可见输出为空）。
5. **1a09afa5 的 51 次投诉前导消息分类**：10 次 TaskOutput 超时轮询 tool_result、6 次 Stop hook feedback（"Background subagents are still running..."）、其余均为各类 tool_result——**无一条是真实用户文本**。kimi 把 tool_result-only 的 user 轮误读为"空消息"。
6. **nation 链路不经协议转换**：nation supplies `protocol: anthropic`，server.py:605 `("anthropic","anthropic"): PASSTHROUGH`——proxy 不改写 messages/thinking，原样透传给美团网关。translate.py 的 thinking-drop / 多块 tool_result JSON 序列化只作用于 chat 协议 supply（openai route），与本症状无关。（E2 附带发现：proxy 透传只到网关——网关内部会把 anthropic **再转 OpenAI chat 格式**并把工具 id 改名为 `{name}:{n}`，由其 400 报文措辞实证。）
7. **重启不有效的解释**：退化模式由会话历史驱动（nudge 注入记录 + kimi 自己的 thinking-only 轮留在上下文里），重启 app 只是重新加载同一会话；/clear 或新会话才能切断。

### 循环如何自我强化

1. kimi 首次返回 thinking-only（触发条件在模型/网关侧，长 agentic 上下文中间歇出现）；
2. SDK nudge："你上一轮没有可见输出，继续"；
3. kimi 在历史中看到：自己上一轮 thinking 里写着"现在必须调用 Edit"但没有 tool_use + user 轮说"你没有可见输出"→ 它"确认"了自己的执行故障，在 thinking 里道歉/分析（"我陷入了严重的执行故障"），而不是直接发工具调用——有时再次 thinking-only；
4. 轮到下一 query，历史里已有"故障叙事"，kimi 延续该叙事，并把 nudge/工具结果轮误述为"用户发空消息 (no content)"。

2896beec 的变体（Agent 反复重派 6 次）：kimi 收到正常 Agent 结果后声称"还没真正派出 agent"再派一次——同一误读模式的工具版。

> **订正（2026-08-09 E2 实验后）**：调研阶段对 pattern B（kimi 把 tool_result-only 的 user 轮误读为"空消息"）的主要机制怀疑是"网关在 tool_result 后系统性补空 user 轮"。该假设已被 E2 实验**证伪**：最小三元组、多轮工具循环、TaskOutput 超时轮询、多块 tool_result、以及 2896beec 真实历史重放（535 条消息/279K input tokens，5 次独立采样）全部阴性——若网关系统性补空轮，真实历史中的几十处 tool_result 必然触发。结论：**pattern B 触发条件未明，属低概率/条件性模型行为**，非确定性协议 artifact。实验实录见 tools/model_proxy/docs/designs/2026-08-09-cli-thinking-only-nudge文案proxy改写.md "E2 实验实录"段。上文的误读事实描述（证据 5）不受影响，失效的是对其机制的解释。

## 五个假设逐一判定

| 假设 | 判定 | 证据 |
|---|---|---|
| 1. 协议层 tool_result 空/丢失 | **证伪** | 1841 条 user 消息 0 条为空；投诉点前 tool_result 内容完整（1623-2725 字符） |
| 2. thinking_proxy（model_proxy）吞块 | **证伪（原猜测形式）/ 确认无关** | nation 为 anthropic PASSTHROUGH（server.py:605），proxy 不改写消息；thinking-only 响应 output_tokens≈思考长度，证明上游真没输出正文 |
| 3. 我们的 patch（尤其 patch 2 授权回调） | **证伪** | 失败模式根本不到工具执行/授权环节（调用从未发出）；同 instance 同 patch 下 claude 段落 0 投诉、数千次工具经授权回调正常执行；patch 是模型无关的，若在实机抛异常应对 claude 也生效 |
| 4. 上游 2.0.11 自身 bug | **证伪（非 Claudian bug）/ 部分确认（CLI 特性）** | nudge 机制在 claude CLI 2.1.197 二进制里，是对 claude 模型设计合理的 by-design 特性；Claudian 只负责渲染。问题在"nation 模型 + 该特性"的组合 |
| 5. sandbox/权限拦截 | **证伪** | 无 sandbox 拦截痕迹；transcript 里 "[Request interrupted by user for tool use]" 是用户主动 esc；截图中 dangerouslyDisableSandbox 只是标准授权弹窗文案 |

**真正的根因**：kimi-k3（经美团网关 anthropic 透传）间歇性 thinking-only 响应 + CLI thinking_only_retry nudge + kimi 对该模式的误读叙事，三者耦合成的退化循环。我们可控的代码（Claudian patch、model_proxy 消息处理）均不在因果链上。

## 修复 / 规避方案

按推荐顺序：

1. **【立即，首选】Claudian 主力工作 session 切回 claude route**。nation route 的 kimi-k3/glm-5.2 不适合跑长 agentic 主线程（本次实锤的退化模式 + 既往 max_tokens 截断史）。用 `$route` session override 或改 strategy 默认。claude 模型从不产生 thinking-only，触发器消失。
2. **【症状出现时】新开会话或 /clear，而不是重启 Obsidian**。循环由会话历史驱动。
3. **【中期，可选】向 nation 网关/kimi 提供方反馈**：anthropic 协议下 kimi-k3 会返回 reasoning-only（end_turn）响应。（对 tool_result-only user 轮的"空消息"误读一项，E2 实验未能复现——反馈前先经 proxy 症状嗅探拿到实机请求体作硬证据，见订正段交叉引用。）
4. **【不推荐首选】proxy 侧加"thinking-only 检测+自动重试"**：改动大、收益不确定（SDK 已有一次 nudge 重试），仅在必须继续用 nation 跑主力时再评估。
5. **不需要回滚任何 Claudian patch**。patch 2 已证伪。

## 风险与权衡

- 残留不确定点 1：kimi 首次 thinking-only 的模型内部触发条件不可见（网关黑盒）。不影响规避方案有效性。
- 残留不确定点 2：proxy 日志 2026-08-09 13:44:13 有一条 `usage_in=0 usage_out=0 stop_reason=空` 的请求（session 1a09afa5），疑似流产的流式请求，与投诉无时间对应关系，建议留意不处理。
- 若业务上必须继续用 nation route 跑主力（成本考虑），则方案 4 需要立项评估，届时再设计。

## 验证方式

- E1（高信息量/低成本，推荐）：同类长 agentic 任务，session override 切 `claude` route 跑半天到一天 → 预期症状完全消失（依据：claude 段落在受影响 session 内本就 0 投诉）。
- E2（低成本）：症状若再现，`tools/model_proxy/model_proxy_cli.sh logs | grep <session_id>`，查 `stop_reason=end_turn` 且 `usage_out<150` 的条目 → 坐实 thinking-only。
- E3（低成本旁证）：Obsidian → Cmd+Opt+I 开 DevTools → Console 有无 exception 堆栈 → 预期无（进一步排除 patch 运行期异常）。
- E4（低信息量，不推荐）：回滚 patch 2 实验。证据链已排除，仅在 E1 后症状仍在时才值得做。

## 关联

- [[2026-08-09-claudian历史保留backport]]
- [[2026-08-09-claudian-other输入修复backport]]
- model_proxy 侧设计：tools/model_proxy/docs/designs/2026-08-07-reasoning-thinking-truncation-and-protocol-consistency.md
