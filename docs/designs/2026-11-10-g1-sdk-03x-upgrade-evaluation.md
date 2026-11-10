---
type: design-decision
status: confirmed
date: 2026-11-10
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - claudian
  - g1-turn-attribution
  - sdk-upgrade
  - upstream-alignment
---

# G1 SDK 0.3.x 升级评估：turn/result 归属可解性

## 背景与问题

G1（turn/result 归属不可辨识）上轮以"SDK 0.2.112 类型层全包 grep 无消费回显"停修，并裁决立项本评估：升级 `@anthropic-ai/claude-agent-sdk` 0.2.112 → 0.3.x 能否解开归属。本轮为纯调研，不改生产代码。

**核心结论先行**：0.3.x 的关联字段真实存在，但**字段由 CLI 进程产出而非 SDK 包装层**，且 0.2.112 对 wire 字段双向透传——**解 G1 不需要升级 SDK**；升级的主要动机不成立。

**裁决结果（2026-11-10）**：用户采纳"不升级 SDK、以透传字段重开 G1"结论；运行时 wire 复核为实施第一步，真实 CLI 单轮实测另行授权。

## 方案设计（证据与结论）

### 1. 字段真实性（证据级）

0.3.321（2026-11-09 发布，配对 CLI 2.1.321）类型层 result 消息携带〔实测，tarball 解包静态读 `sdk.d.ts`〕：

- `user_message_uuid?`：result（success/error）回显触发该 turn 的客户端 uuid（`submitMessage options.uuid`）；"absent on turns that neither had a client uuid nor folded a user message in, … and from older producers"
- `user_message_uuids?`：消费 echo（plural）——本 turn 消费过的全部 user message uuid（prompt batch 合并成员、mid-turn 折入的排队消息），按消费序，≤64 项，恒含 singular
- `queued_turn_count?`：产出此 result 时命令队列中待处理的用户发送数
- `result_index?`：本 result 在 run 内的写序（写失败也占号，语义是"写序"不是"turn 序"）
- 另有 assistant message / stream_event / thinking_tokens 帧的同名早期回显（不必等 result 即可绑定）

引入时间线〔实测，0.3.x 各版本 tarball 二分探测 `sdk.d.ts`〕：SDK 0.3.193（2026-06-25）首现 singular echo（0.3.194 短暂回退）；queued_turn_count 在 0.3.245 前；plural `user_message_uuids` 在 0.3.259（2026-09-02）；`result_index` 在 0.3.303。SDK 版本号与 CLI 2.1.NNN 锁步（manifest `claudeCodeVersion`），故 CLI 侧引入点约在 **2.1.193（singular）/ 2.1.259（plural）/ 2.1.303（result_index）**。

本机 CLI 2.1.311（homebrew 原生二进制）`grep -a` 实测含全部四个字段字符串〔实测〕。

### 2. 关键架构事实：字段的生产者是 CLI，SDK 只是管道

- 0.3.321 的 `sdk.mjs` 本体 **0 处**出现 `user_message_uuid` ——SDK 包装层不合成该字段，只声明类型〔实测 grep〕。
- 0.2.112 出站：`streamInput` 对每条消息裸 `JSON.stringify` 写 stdin，无 schema 剥除——fork 在 `ClaudeUserMessageFactory` 已为每条用户消息铸的 `uuid: randomUUID()` 今天就已上 wire〔实测，读 0.2.112 sdk.mjs 序列化函数〕。
- 0.2.112 入站：transport 逐行 `JSON.parse` 后原对象 yield，仅拦截 control/keep_alive 帧，无 zod 校验、无 strip〔实测，读 0.2.112 `readMessages` 循环〕。
- 结论：**用户 CLI ≥2.1.193 时，fork 在 0.2.112 上今天就已能在 result 帧读到 `user_message_uuid`**。类型缺失只影响编译期（须弱类型读取）。

### 3. 对上轮"不可辨识"判词的修正

上轮记录"真实 CLI wire 取证判不可辨识（仅 result_index/queued_turn_count）"。与静态证据冲突：若观测 wire 已含 result_index（CLI ≥2.1.303 期产物），则同版 CLI 必已含 echo（2.1.193 起）。最可能解释：**取证探针路径发送的消息未带 client uuid**——echo 的缺席条件正是"turn 无 client uuid 且未折入 user message"。fork 生产路径每消息必铸 uuid，且 CLI 接受该 uuid 并以其落 transcript 用户行（batch-1 reconciliation coordinator 以此为绑定键，既有生产行为），判词不必然迁移到生产路径。此点必须运行时复核（见验证方式 1）。

### 4. G1 映射

result 帧的 `user_message_uuids` 是 factory 铸的 uuid 超集——正是 reconciliation coordinator 的 canonical transcript UUID 绑定键。归属路径变为：`result.user_message_uuids ∋ uuid → coordinator binding → leaseTurnId/turnId`，覆盖原始反例（3 输入 2 result：两 result 各自回显其消费的 uuid 子集，合并消息不再歧义）；`queued_turn_count>0` 告知"还有一个 result 将至"。`result_index` 只可做诊断序号，不可参与归属（写序语义）。

### 5. 破坏面清点（若仍选择升级 0.3.321）

逐项核过 fork 使用面〔实测，两版 `sdk.d.ts`/`sdk.mjs` 对读〕：

**存活无变更**：`query` 函数、`Query` 全部方法（`setModel`/`setPermissionMode`/`setMcpServers`/`applyFlagSettings`/`streamInput`/`initializationResult`）、`Options` 字段（`pathToClaudeCodeExecutable`/`spawnClaudeCodeProcess`/`settingSources`/`includePartialMessages`/`canUseTool`/`hooks`/`resume`/`forkSession`/`allowDangerouslySkipPermissions`/`systemPrompt`）、全部 fork 导入类型（`SDKUserMessage`/`SDKMessage`/`SpawnedProcess`/`SpawnOptions`/`CanUseTool`/`PermissionUpdate`/`RewindFilesResult`/`HookCallbackMatcher`/`McpServerConfig` 等）、`SDKMessage` 联合成员两版相同、`SDKUserMessage.uuid` 两版均有。`setMaxThinkingTokens` 加了可选第二参（兼容）。

**实质代价**：
- 包结构巨变：0.3.x 不再捆绑 `cli.js`/`embed.js`/`assistant.mjs`/`vendor/ripgrep`，改 `optionalDependencies` 8 平台包携带原生 `claude` 二进制（darwin-arm64 ~323MB）。vault `node_modules` 49MB → ~370MB〔推算，manifest size 字段〕。fork 恒传 `pathToClaudeCodeExecutable` 不受运行影响，但磁盘与备份体积代价真实。
- deps→peers：`@anthropic-ai/sdk>=0.93`、`@modelcontextprotocol/sdk^1.29` 变 peer，新增 `zod^4` peer；`sdk.mjs` 运行时零外部 import（自包含 bundle），esbuild 打包不受影响〔实测 grep import〕。
- spawn 参数差异：`--thinking adaptive` 改 `--thinking=adaptive` 形态、新增 `skills`/`permissionPrompts`/`pluginsViaInitialize` 选项——fork 未用，但 control 协议/init 响应的演进未逐 diff，属行为级未知区，升级须全套验收。

### 6. 建议

**不升级 SDK，直接重开 G1**，以 passthrough 字段实现：
1. result 处理处弱类型读取 `user_message_uuid`/`user_message_uuids`（`(result as {user_message_uuids?: string[]}).user_message_uuids`），命中即用 coordinator 绑定做归属；缺席则回退现有 observer/reconciliation 启发式——功能单调不劣化。
2. 运行时能力探测（CLI 版本或首个带 echo 的 result），旧 CLI 用户自动回退。
3. SDK 升级降级为独立低优先"类型层跟进"项：等 0.3.x 的 323MB 分发代价有明确处置方案（如 `.npmrc` omit optional）再议，不与 G1 绑定。

理由：功能前置是 CLI 版本（用户已 2.1.311）而非 SDK 版本；升级不带来任何 G1 所需的运行时能力，却引入平台二进制体积与行为回归验收成本。若用户坚持升级，分阶段：先分支装 0.3.321 跑 typecheck+全测试基线，重点验收 spawn 参数与 control 协议差异，再决定合入。

## 风险与权衡

- **判词冲突未终裁**：本评估以静态证据推翻上轮 wire 结论的迁移性，但未运行时复核（红线禁启动 CLI）。若生产路径实测 echo 仍缺席，则 G1 依赖 CLI 侧修复，SDK 升级同样无用——两种结局下"不升级"建议都成立，但 G1 重开时点后移。
- **CLI 版本碎片化**：fork 用户各自解析本地 CLI，<2.1.259 的用户无 plural echo，<2.1.193 无任何 echo——回退路径是硬需求，非可选项。
- **合成 turn 不可归属**：无 client uuid 且未折入用户消息的纯合成 turn 无 echo，归属仍靠现有 transcript 因果（observer）——echo 只消灭"有发送但 result 无主"的 G1 主类，不覆盖全部 auto turn。
- **升级方案的残余不确定性**：control 协议/init 字段/错误路径差异未逐 diff，若用户裁决升级，验收清单须按上节补齐。

## 验证方式

1. **运行时 wire 复核（G1 重开第一步，须生产发送路径）**：本机 CLI 2.1.311 + 现有 0.2.112，fork 正常发送一轮（每消息带 factory uuid），在 `ClaudeMessageChannel` result 分支打诊断日志输出 `user_message_uuid`/`user_message_uuids`/`queued_turn_count`/`result_index`。红绿判据：带 uuid 发送后 result 帧出现 echo=绿；缺席=判词冲突升级回用户裁决。
2. **合并场景对拍**：复现 G1 原始反例（连发 3 条、队列合并成 2 turn），核对两 result 的 `user_message_uuids` 各自覆盖其消费的 uuid 子集、无遗漏无串扰。
3. **旧 CLI 回退**：模拟（mock wire）无 echo 的 result 帧，断言回退到现有 observer 归属且不抛错。
4. **若升级 SDK**：分支装 0.3.321 → `npm run typecheck && npm run lint && npm run test && npm run build` 全绿基线 → 手测一轮 persistent query 全生命周期（send/merge/queued/permission/hooks/setMcpServers/rewind）+ `node_modules` 体积记录。

## 关联

- [[2026-11-09-claudian-两线遗留现状核查与收口方案]]（G1 停修判词与裁决 2）
- [[2026-11-09-upstream-1482-claude-permission-port]]
- `src/providers/claude/transcript/ClaudeTranscriptTurnObserver.ts`
- `src/providers/claude/transcript/`（ClaudeTurnReconciliationCoordinator，canonical UUID 绑定）
- `src/providers/claude/runtime/ClaudeUserMessageFactory.ts`（uuid 铸造点）
- `/tmp/g1_sdk_eval/`（本轮取证 tarball 与解包，一次性临时产物）
