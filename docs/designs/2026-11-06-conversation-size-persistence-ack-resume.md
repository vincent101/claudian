---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task-1-codex-report.md
tags:
  - architect
  - claudian
  - persistence
---

# A 持久化确认缺口：局部承接设计

## 背景与问题

只解决阻塞报告第21–27行：metadata-only 写入与静默跳过都 resolve void，app 误把“未抛错”当成写入成功，解除 proof 分支的 stale 门并发布 known。

〔既有读数〕报告第25行记录受控集成实际结果为 `gateStillClosed=false / publishedKnown=true / metadataMissing=true`；本轮未重跑。〔既有读数：源码〕`SessionStorage.ts:49–64` 的缺路径、身份不符、世代失效均正常返回；`ConversationSizeService.ts:276–284` 未检验写入结果便进入最终提交。

这是已批准“持久化通过且最终核验后才清门/发布”的内部接线，不新增指标，不重写 A 全案。沿用同 ID FIFO、有限来源与保存世代检查；无展示读回/扫描、主动 hydrate、缺失 metadata 自动创建、新生产模块。B 的独立计量模块不在本案改动范围。本轮只读核查并新建此记录，未实施、未跑测试、未读真实聊天或秘密。

## 方案设计

### 1. 最小 ack 契约

推荐显式结果联合；布尔 ack 更短，但无法区分缺失、失效和身份跳过。把正常跳过改为异常也能阻止误发布，但混淆预期失效与 I/O 故障，不推荐。已有 FIFO 能直接保证同 ID 写操作排序；复用它，而非读回、扫描或重建 metadata 来确认。

```ts
export type ConversationSizePersistenceAck =
  | { status: 'written' }
  | {
      status: 'skipped';
      reason: 'missing-metadata' | 'obsolete' | 'identity-mismatch';
    };

// saveSizeSnapshot 与 persistSnapshot 的返回类型一致：
Promise<ConversationSizePersistenceAck>
```

| 条件 | storage 结果 | app 对本次候选的处理 |
| --- | --- | --- |
| overlay 写入 resolve，必要 legacy 清理也完成 | written | 仍需最终世代/来源/对象检查，不能直接发布 |
| preferred 与 legacy 路径都不存在 | skipped / missing-metadata | 返回 undefined，不清 proof 门，不改内存、不通知；不创建 metadata |
| snapshot 或读出的 metadata 的 ID 不符 | skipped / identity-mismatch | 同上 |
| 入口、排队后或读取后的既有 isCurrent 检查失败 | skipped / obsolete | 同上 |
| exists/read/JSON.parse/write/必要 legacy 清理抛错 | Promise reject 原异常 | 由既有 performRefresh catch 收敛为 undefined；不清 proof 门、不发布 |

`written` 只证明**本次操作**的 adapter.write 及既有必要清理完成，不是 fsync、最终磁盘版本不变或世代仍有效的证明。legacy 清理失败即使 overlay 已落盘也 reject；不回滚、不伪造成功。默认 `isCurrent=()=>true` 保持直接 storage 调用兼容；main 必须继续传 app 的真实检查闭包。

### 2. 精确改动点与消费者

| 绝对路径 / 当前锚点 | 拟改动 |
| --- | --- |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/SessionStorage.ts:49–64` | saveSizeSnapshot 改返 ack；入口早退和队列内每个正常早退均给明确 skipped。仅在 await write 与既有 legacy 清理之后给 written。可用每次调用独立的局部 ack 传出 void 队列回调，默认只能 skipped，绝不能默认成功；各正常出口显式赋值。 |
| 同文件 `:21–29 / :165–177` | **不改** enqueueWrite/writeTails/getLoadPath：overlay、saveMetadata、deleteMetadata 继续共用同 ID FIFO；队列前项失败不毒化后项，当前操作异常仍向调用者 reject；preferred→legacy→null 查询不变，不新增读回。保留队列内读前/读后双检及入口检查。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationSizeService.ts:14 / :276–284` | persistSnapshot 改返同一 ack；await 后先要求 `ack?.status === 'written'`，再保留最终 isCurrent、getConversation、expectedConversation 身份检查；最后在无 await 段内依次清 verified proof 门、赋 conversation.sizeSnapshot、更新 snapshots、onPublished、return。任何负 ack/异常均不进入该段，不自动重试。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts:109–117` | 唯一生产装配 `persistSnapshot` 原样转交 storage 返回 Promise；当前表达式箭头已转交返回值，不应为了“显式接线”另加无返回的 async 包装。保留原第三参数 isCurrent，无新加载/展示调用。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts:103` | **需范围裁决后核对/同步**：符号盘点命中另一个 saveSizeSnapshot 声明，本轮未展开其契约。推荐在这个既有中立契约文件定义 ack，并同步该方法返回类型；storage/app 用 type import，不新增模块，不把 app 依赖倒置到存储实现。 |

main 的 storage 属性类型来自 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/storage.ts`，不是直接声明为具体 SessionStorage。实施前须沿该文件的 sessions 类型引用核对上述契约接线；本轮未展开，不声称只改三个生产文件即可通过类型检查。若该文件只是引用契约，无需改；若还需行为/其他契约改动，停下补授权，不用 cast 绕过。

当前生产符号盘点仅有 main 直接调用 saveSizeSnapshot、app 调用 persistSnapshot；其他命中为声明。没有第二个生产 ack 消费入口。legacy 两参数 historyReady 原先会先清门，本案不改变该路径；**本次“持久化之后才清门”修复针对阻塞的 proof-aware 分支**，所有 performRefresh 发布均必须有 written。不能借此声称已重设计全部 history-ready 行为。

### 3. 所有直接测试 fixture 适配

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/app/ConversationSizeService.test.ts`：成功 persist mock 的 `mockResolvedValue(undefined)`（当前66、113、245、304行）全部改为 typed written；成功空回调（97、138、158、190、202、225、275、292、324行）全部显式返回 written。349–355行的延迟 fixture：isCurrent 为真才记写并返回 written，否则返回 skipped/obsolete。保留313行原 rejection 用例；另加 written 已返回但最终对象/世代失效用例，不能只测“写前拒绝”。普通成功 fixture 也必须适配，不能只修 proof 用例。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/storage/SessionStorage.test.ts:101–159`：既有三个 overlay 用例增加 ack 断言，保留内容完整与 FIFO 最终内容断言；新增下节缺失/早退/异常/队列用例。当前从 provider 历史兼容入口导入 SessionStorage，盘点显示它是 core 实现的重导出；不用新增测试文件或修改兼容入口。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/conversationSize.test.ts`：使用真实 main/app/SessionStorage，**不 mock ack**。既有207–255行缺失 metadata 用例保留并转绿；扩展一次 overlay 写异常和一次 overlay await 期间世代失效。49–205行成功链继续断言 metadata 与绑定 tab 的 known=3，其他 tab 不污染。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/main.test.ts` 的直接 ack/size fixture 盘点未命中，不列必改。若获准核对的中立存储契约还有结构化 fixture，按同一返回契约机械适配；不扩大其他行为测试。

### 4. 推演：ack 与最终有效性是两道独立门

以下均为〔纯示意〕，对象 C 的候选为 `(revision=2, saveEpoch=1, count=3)`；不是本轮实测。

| 同一候选的时序 | storage 所记 | app 所记 / 红绿判据 |
| --- | --- | --- |
| 完整 proof，路径缺失 | skipped/missing-metadata；写次数0 | 门保留、无候选发布、metadata仍缺失；任一反向结果为红 |
| 路径存在，全部操作完成，世代不变 | written；写次数1 | 最终检查通过，才清 proof 门并发布 count=3；绿 |
| 在 metadata read await 期间 beginSave，epoch变2 | 读后检查拒绝，skipped/obsolete；写次数0 | 不提交候选；绿 |
| 在 adapter.write await 期间 beginSave，epoch变2 | write 可完成，written；写次数1 | 最终 isCurrent 拒绝，门不清、无候选发布；若以 written 代替最终检查则红 |
| 同 ID delete 排在 overlay 前 | delete先完成，overlay无路径，skipped/missing-metadata | 不复活 metadata、不发布；绿 |
| overlay 排在较晚完整 save 前 | overlay可 written，较晚 save 最后落盘 | FIFO 不许旧 overlay 覆盖新 save；app 若跨保存 epoch 则丢弃旧候选 |

论证链：完整来源候选 → 本次 metadata 写操作获得 written → 同一保存世代/来源/目标对象仍有效 → 无 await 发布临界区。隐含前提是 adapter 的成功返回可靠，且影响世代的业务保存经过既有 beginSave/失效接线。具体反例是 write pending 期间开始新保存：它不推翻“确实写过”，却推翻“还能发布”，因此最终 isCurrent 不能删。

结构不变量：**写入确认与世代有效性正交，成立**（storage ack / app final check）；**同 ID FIFO，成立**（不改原队列）；**数据流无环，成立**（storage→main依赖返回→app提交，不反向触发 hydrate）；**扩展点归属中立契约，待上述范围裁决和类型引用核对**；**多入口覆盖，设计成立待实测**（switchConversation/getConversationById 复用同一依赖，普通/proof refresh 都检查 written）。原批准语义不翻案；若继续把 resolve void 当成功，已有 metadata 缺失反例仍必然错误清门。

## 风险与权衡

- **需用户裁决一项实施范围**：是否允许在既有三处链路之外，核对并同步 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts` 的存储返回声明，以及只读核对 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/storage.ts` 的 sessions 类型引用。推荐允许；这是同一 ack 的必要类型接线，不是产品语义扩展。当前“另派新代理”只授权本次设计承接，不等于批准实施。
- 产品口径无新增裁决。缺失 metadata 保持未提交，不保底发布 bytes/known，不自动创建、不自动重试；之后本来就发生的正常保存/加载仍可重新走完整流程。要求“缺失也必须立即展示新值”会改变批准语义，不能顺手加入。
- ack 不承诺跨进程/外部删除的原子性：路径找到之后、write 之前外部 unlink 的 TOCTOU 不由 FIFO 消除；本案“不自动创建缺失 metadata”指 getLoadPath=null 时零写入及同实例 FIFO 删除顺序，不是新增跨进程 CAS 保证。也不回滚已完成但随后世代失效的 overlay。
- 不修改旧设计、状态、计划或停止报告；不改 view/tab、provider 计量、B 文件、schema、配置。尚未通过本案红绿验收，A 仍不能报完成。

### 交付物规范

唯一新增 `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-06-conversation-size-persistence-ack-resume.md`，用途为 A 局部 ack 草案，消费者为主会话、实施者、独立方案复核；沿用本项目既有 docs/designs 日期-主题命名，conversation-size-persistence-ack-resume 表示“新代理承接持久化确认”，不是旧案替代版。目录树为 `/Users/vincentwang/Documents/NoteVault/tools/claudian/ → docs/designs/ → 本文件`，不新建目录。归属引用 `/Users/vincentwang/Documents/NoteVault/tools/claudian/CLAUDE.md` 的镜像 tests 约定及 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/CLAUDE.md` 的中立契约边界。README 当前无设计产物索引；登记到 `/Users/vincentwang/Documents/NoteVault/tools/claudian/README.md` 留给主会话另行授权，本轮不回填、不写 .context 副本，除此无目录约定偏离。

## 验证方式

均为移交实施的红绿靶子；**本轮未跑测试，不宣称通过**。只用内存 metadata 适配器、独立临时 transcript 与显式受控 root；不读取真实 home 会话。

1. **缺失红→绿**：既有 integration 207–255行在旧实现下的已记录红值是 false/true/true；新实现必须 true/false/true，且没有 overlay write。不得 mock saveSizeSnapshot/historyReady/publish，也不得把期望改成接受旧行为。
2. **storage 成功与所有跳过**：preferred成功、legacy迁移成功皆 written；双路径缺失、错误snapshot ID、错误metadata ID、入口/排队后/read后世代失效逐项精确断言 skipped reason 与零写入。内容保持其他metadata字段。
3. **异常及FIFO**：write rejection 原样拒绝；另覆盖 read/解析/legacy清理异常。先失败的同 ID 操作不阻止下一次 saveMetadata；overlay→save、delete→overlay、overlay→delete 的最终内容/不存在状态符合入队顺序，不出现嵌套入队死锁。
4. **app负ack**：每种 skipped在普通/proof refresh均返回undefined、不写conversation.sizeSnapshot、不更新发布缓存、不调用onPublished；proof门保留。额外受控无ack fixture仅用于运行时 fail-closed 测试，普通成功 fixture禁止继续返回void。
5. **最终双检**：deferred persist确实完成并返回written，但期间beginSave、改来源、删除/同ID替换对象，均不得提交本次候选；proof门不误清。写前skipped与写后written失效必须分开测。
6. **真实主链恢复**：Controller.save建立门→移除metadata→真实getConversationById不清门/不publish；随后由测试显式恢复metadata，再正常加载才可written＋最终核验→known。另测overlay阶段抛错与pending写期间新保存，不能只复用原“完整保存失败”用例。保留真实view/rAF/TabBar成功链及另一tab隔离，展示刷新不增加storage读回/列表扫描。

精确命令（在 `/Users/vincentwang/Documents/NoteVault/tools/claudian` 执行，交实施者先红后绿；不跑全套、不build/deploy/reload）：

```bash
node /Users/vincentwang/Documents/NoteVault/tools/claudian/scripts/run-jest.js --selectProjects unit --runInBand --runTestsByPath /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/storage/SessionStorage.test.ts /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/app/ConversationSizeService.test.ts
node /Users/vincentwang/Documents/NoteVault/tools/claudian/scripts/run-jest.js --selectProjects integration --runInBand --runTestsByPath /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/conversationSize.test.ts
npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run typecheck
git -C /Users/vincentwang/Documents/NoteVault/tools/claudian diff --check
```

对获批生产/测试清单逐文件 ESLint；人工核对无 void 成功 fallback、main 不丢返回值、FIFO/isCurrent 未弱化、无新 I/O入口。与B合并时仅复测既有尺寸 integration，不改B模块；本案通过不替代A其余未完成验收。

## 关联

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task-1-codex-report.md` 第21–27行
- [[tools/claudian/docs/designs/2026-11-06-codex-ready-unblock]]（只引用，不修改）
