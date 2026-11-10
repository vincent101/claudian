---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - claudian
  - conversation-size
  - persistence-boundary
---

# A 会话体量：统计物理提交与业务 metadata 排序隔离

## 背景与问题

统计 overlay 与业务 metadata 共用文件和同 ID FIFO，故不可取消的统计 I/O 一旦占住队首，移除上层 await 仍不能让后续真实业务保存完成；本案重划物理写权限、地址和排序域，不降低保存成功语义。

**路径：理想。独立 draft，仅设计，具体方案尚未获批。**

- 授权依据为派单逐字引用的用户裁决「同意重划统计提交边界」，含义是授权另行设计 U1-c，不是批准本方案、实施、迁移、部署或修改旧记录/status。
- 组合基案是 `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-07-conversation-size-contract-consolidation-restart.md`，下称 U。不是替代整个 U；与 U 的明确差异列于方案第 12 节。两案均需确认，不能将旧文“保持原存储位置/FIFO”与本案同时照搬。
- 本单命中跨层矛盾、非局部方案后果。旧 ac82 终止状态仍 **UNKNOWN**；未联系、恢复或判定其状态。B 共享接线继续冻结。
- 本轮只读源码、设计及指定冻结材料；执行只读存在性/Git/哈希检查。未读真实聊天、秘密、用户运行配置或 agent output_file；未触发业务存储入口，未跑行为测试、子代理、联网、build、部署、reload、worktree、提交或 push。唯一写入为本设计记录。

**2026-11-07 授权订正（A–D）**：用户选择「按建议订正（推荐）」——「保留现有删除语义；补原身份绑定及同口径比较；只改两份草稿，不实施」。本次仅增量订正本稿与 U，不新建版本、不改 status，无新产物。初稿建稿/哈希记录保留为历史记录；本次核查源码，不重演行为或哈希验收，不将订正授权解释为具体方案/实施批准。

**2026-11-07 授权订正（删除后 UI 复位）**：主会话建议「补充专门的删除后复位路径：不再保存旧会话，并校验原标签绑定身份；同时保留普通新建会话的先保存行为」，用户原话「按建议」。本次按务实路径仅补本稿与 U 的 UI reset/退役衔接、必要生产/测试范围及一致性；不改变既定持久方案、provider 删除、性能和取舍，不改 frontmatter/status，无新产物。新增源码判断为〔既有读数〕，推演不是行为实测。

### 已核实基线

源码绝对根为 `/Users/vincentwang/Documents/NoteVault/tools/claudian`。

| 证据等级 | 事实及位置 |
| --- | --- |
| 实测：只读 Git/哈希 | Claudian HEAD=`cf47730d2109e798fd27ddacc712038d26883d5b`；工作区有既有 A/B 修改，不清理。`/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task1-ready-r0-snapshot/manifest.json` 的 39/39 路径在冻结镜像及当前工作区均匹配；不是行为测试通过。 |
| 既有读数：源码 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/SessionStorage.ts:21–29,39–80,104–109`：业务 save、统计 overlay、delete 共用 `writeTails[id]`；overlay 读旧 metadata 后整对象回写。前项 reject 不毒化后项，永不 settle 则后项不能开始。 |
| 既有读数：源码 | 同文件 `:83–101,111–129`：load/list 读取 legacy 后会 `saveMetadata(raw)`，不是无副作用的统计资格探针；迟到旧 raw 不能直接拿来作新身份迁移。`:153–179` 把 `conversation.sizeSnapshot` 带回普通业务写。 |
| 既有读数：源码 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/storage/VaultFileAdapter.ts:23–26` 的 write 经过 ensureParentFolder 和宿主 adapter.write；本类只有 append 使用自己的全局 writeQueue。不含取消、fsync、CAS 或原子替换契约，不能推断宿主内部无全局串行化。 |
| 既有读数：源码 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/storage/SharedStorageService.ts:18–28,62–65` 每次构造新 SessionStorage，initialize 会建业务目录；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts:350–352` 的 loadSettings 重建该服务。仅以实例保存队尾/统计两槽不能覆盖重建实例或同 realm 热重载。 |
| 既有读数：源码 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts:692–738` 支持以 sessionId 创建同 ID；delete 先移除对象、await provider 删除，再调用 metadata delete。若不先保留生命周期顺序，旧 delete 可在同 ID 重建之后删掉新 metadata。 |
| 既有读数：源码 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts:436–438,512–514,710–712,759–761,778–788` 是全部直接业务保存位置；有启动回填、环境失效、create、rename、update，不只有 Controller.save。 |
| 既有读数：源码 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationSizeService.ts:233–291` 的两槽包含读取和 persist，但没有持久 owner；`:279–286` written 后直接写内存。U 中的证据/owner/final stat 是待实施设计，不能当作现成代码。 |
| 既有读数：报告 | `/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task-1-review-r0.md` 判 A FAIL，保留 typed ACK/FIFO 的正面判断；7 项缺陷继续由 U 处理。本轮未重演报告。 |

删除后 UI 本次补核〔既有读数：源码，非行为实测〕：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts:726–749` 在 provider/metadata await 后按 ID 选 tab，并裸 cancel→createNew(force)。`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts:162–258` 对有消息原 tab 先 await save，force 不越过 creating/switching guard；新 handle 已退役，此 save 不能 written。`:430–440` 的 stored guard 只比较 ID，清 ID 后 null 取消不会自动阻止后续 input/onNewConversation/finally。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts:1299–1318,1324–1428` 是真实装配：orphan 的同步回调可能按当前 ID merge/save；onNewConversation cleanup 当前 runtime 并重设 binding/模型/搜索。`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/services/SubagentManager.ts:673–693,790–801` 确实发 orphan 回调。仅去掉显式 save、只在 controller 外检查 token，都不足以保护新绑定。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts:269–272,705–831` 的 ID 同步、open/focus 捷径、busy guard 和 token 化 claim 是实际准入约束，不是持久 origin。`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/rendering/ProjectionWriteCoordinator.ts:103–115,217–279` 只提供真实 S/L grant/FIFO，不封住整个 reset。auto invalidate 释放实际 auto lease（`AutoTurnProjectionController.ts:548–557`），user cancel/watchdog 不等于 user live lease 已释放（`InputController.ts:1454–1507,745–781`）；不改变它们的原契约。

相邻未列入冻结镜像的文件，只读哈希如下；不冒称冻结文件：

| 绝对路径 | SHA-256 |
| --- | --- |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/storage/VaultFileAdapter.ts` | `b1821fe845fa3325bf0886a0a0339af26da5e720346d47131a3a527c15abd90c` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/StoragePaths.ts` | `ba183b41f2f59dcaf04dbfa39afe7e054bf6d5d7799e14f43af0dcb3ae62de58` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/storage.ts` | `915691cdf1ecb33df3c3045a30a9a9b2739b819382984fe2c9db4680c71c0a22` |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/storage/SharedStorageService.ts` | `f88d35226f05fca3f4d6855b2f5c52903f2f458dadb80a55decef65e8132a700` |

## 方案设计

### 1. 问题模型与保证边界

分开六种对象，不能用一个 ID、一个版本或一个“保存完成”替代：

| 对象 | 权威/生命周期 | 不代表什么 |
| --- | --- | --- |
| 业务记录 | SessionStorage 管理的 metadata，provider-native transcript 仍由 provider 管理 | 统计文件不能创建、恢复或修改业务记录。 |
| 持久记录身份 R | metadata 内随机 recordToken；一次创建到删除的逻辑记录生命期 | 同 ID、相同 createdAt、相同来源不等于同 R。 |
| 持久统计栅栏 F | metadata 内随机 sizeFence；按已进入业务排序的历史相关写更新 | 不是 U 的数值 revision/readEpoch，更不是文件内容指纹。 |
| 运行时 owner O | U 的 originalObject + 不复用 incarnation | 不是可从磁盘恢复的许可；同 R 再加载也发新 O。 |
| 来源证明 V | provider 唯一 v2 sourceRevision，加同次正常完整读取证据 | R/F/O 都不证明 count 完整，bytes 也不证明 history。 |
| 统计候选/发布 | 候选可以物理写成文件；只有本次 typed ACK、最终 stat 和 U 最终校验后才发布 | 文件存在、完整 JSON 或 writer 的旧 epoch 都不是当前已发布/业务已保存。 |

**所保证的非阻塞**：在当前 renderer JS realm、同一 vault 的新协议作用域内，任意 A 统计 read/stat/mkdir/write/资格探针/清理永久 pending，不形成后续业务 metadata 操作的前驱；若业务自身 I/O 和事件循环能够推进，其真实保存仍可开始并完成。正常 save/close/load 不 await 统计完成、初始化或回收。

不保证整个磁盘、宿主事件循环或 OS I/O 调度失效时业务仍有完成期限；也不保证跨进程总并发=2。若要求这些更强性质，见风险 D3，不能用应用级队列设计冒充。

### 2. 候选比较与推荐

| 结构成立的方案 | 局部收益 | 非局部后果/失败模式 | 结论 |
| --- | --- | --- | --- |
| **按记录生命期寻址的可替换统计 sidecar + metadata 身份栅栏 + 独立统计 lane** | 固定一次记录生命期一个统计地址；不写业务文件、不需要统计 manifest；当前值可有限定位；旧写最多损坏可重建派生值 | 必须严格验证 R/F/source；非原子写需完整性校验，损坏降 unknown；删除允许孤儿文件，不能保证同步擦除 | **推荐**。目标是可靠隔离可重建统计，不是将其升级成事务数据库。 |
| 每候选不可变 blob + 当前指针/manifest | 候选本身不互相覆盖，适合审计留存 | 指针仍需独立排序、验证和崩溃处理；无原子替换不能凭 rename 就认定发布；多文件提交与 GC 增加长期维护，不能省 metadata 身份 | 可行但本案不选；没有审计历史需求。 |
| 独立 append journal + 回放索引 | 可记录撤销/候选、统一恢复 | append 的原子性未证明，需 framing/checksum/尾部截断；共享 journal 形成跨会话统计队首阻塞，分 journal 又增加回放/压缩；不能用现有 adapter.append 的吞错行为作 ACK | 不选；为单个派生快照引入第二套日志存储不划算。 |

不选“改 sidecar 路径但继续 enqueueWrite(id)”或“独立队列仍整份回写 metadata”；前者不隔离，后者丢业务更新。不选依附下一次兼容业务写才产生 known 的 U1-b。旧记录过渡期也可正常读后独立提交，见第 9 节。

### 3. 物理地址、写权限与实际 FIFO 域

#### 3.1 地址与能力

对当前 vault，以下运行数据根仅为**后续实施地址规范，本轮不创建、不读取**：

```text
/Users/vincentwang/Documents/NoteVault/.claudian/
├── sessions/<conversationId>.meta.json                 业务权威文件，原位置
└── conversation-size/v1/
    ├── durable/<recordToken>.json                     可跨重启验证的统计候选
    └── volatile/<runtimeRecordToken>.json              旧 schema 的运行期候选，不跨重启恢复
```

其他 vault 用正常 `getVaultPath` 的绝对根原样拼固定后缀，不硬编码 NoteVault。无原生绝对 vaultPath 则统计持久化 unavailable，业务加载/保存维持原路；不退回共享 metadata overlay。

- **业务 writer**：仍使用 VaultFileAdapter，写原 preferred/legacy 业务地址；只经过业务 FIFO `B[vault,id]`。
- **统计 writer**：新 ConversationSizeStore 使用本地原生异步文件能力，写权限只有上述统计根；不经 VaultFileAdapter.write/append、SessionStorage.enqueueWrite、saveMetadata 或 plugin.saveData。不复用 HomeFileAdapter 的宽泛任意路径接口，只复用项目已采用的原生异步文件模式。
- **统计资格 reader**：同一 store 持有只读资格探针，可读由 SessionStorage 路径规则产生的那个 ID 的 preferred/legacy metadata，仅提取 ID/provider/sizePersistence。不得调用有迁移副作用的 loadMetadata/listMetadata，不枚举会话，不回写读取出的 raw metadata。
- 统计文件夹懒建，由统计 job 在占槽后执行；SharedStorageService.initialize 不建、不检查、不等待统计目录。不得把 mkdir Promise 接到业务启动屏障。
- provider transcript 仍只作 U 允许的显式有限 stat；统计 store 不能获得写 transcript 的能力。
- token 为固定长度安全字符，不用 title/source/path 作文件名。ID 必须可作为业务路径 basename；异常 ID 对统计 fail-closed。用绝对根和 resolve/relative containment 检查阻止词法越界，不宣称抵抗受攻击的符号链接/恶意 vault。

原生统计 I/O 的选择消除了已知应用队列及宿主 adapter 内部串行化的依赖；不承诺不同文件获得独立磁盘、线程池或 fsync。

#### 3.2 排序域

| 域 | 排序键/包含操作 | 可以等待谁 | 禁止依赖 |
| --- | --- | --- | --- |
| B：业务域 | `(vault,id)`；正常 save、create、delete 生命周期屏障、正常 read/legacy 迁移及失败恢复读取 | 同 ID **业务**前驱、provider 删除的原 Promise 契约及业务 I/O；恢复读取不等 uncertain 自己解除 | 任何 S lane、统计槽、统计文件、统计回收 |
| S：统计域 | `(vault,kind,R)`；候选读→stat→写→最终探针/stat，以及该地址删除 | 同地址先前实际操作；统计两槽 | 不把自己加入 B；不调用可能写 metadata 的 reader |
| O：授权域 | U 的 owner/read/save/gate 状态；同步校验和失效 | 不 await | 不以 S 的 pending 阻止 B 登记/执行 |

一个 S pipeline 从首次 I/O 到最后 I/O settle 持有同地址 lane；同地址最多一个实际 pipeline。不同 R 可并行，所有 A 统计 pipeline 的实际活动总数最多 **2**。S 读/写/清理同序，不能让取消后的迟到旧写跨过新写。

B 保留既有“前项 reject 后后项可执行”的模式；不把 reject 当成功返回。create/update/delete 的旧生命期检查在排队后再次进行，避免仅在入队前检验。不得在已经持有 B lane 的迁移/删除内部再 enqueue 同 ID，造成自等待。

### 4. 持久结构及接口契约

#### 4.1 metadata 的唯一新增持久字段

正常业务 serializer 新增、且仅由存储生命周期管理的顶层字段：

```ts
sizePersistence?: {
  schema: 1;
  recordToken: string; // R：新建必新发，不从 id/title/source 推导
  sizeFence: string;   // F：历史相关业务写的新栅栏
};
```

- `Conversation.sizeSnapshot`、`ConversationMeta.sizeSnapshot` 保留作经 service 发布的**内存投影**；`SessionMetadata.sizeSnapshot` 只作旧格式兼容字段，永不再输出，也不直接喂给 provider 或 getter。
- `toSessionMetadata` 和最终 `saveMetadata` 两层都剥离 sizeSnapshot，防止直接 storage 调用绕过 serializer。普通业务写不镜像 sidecar、不从 sidecar 合并整记录。
- sizePersistence 不接受 `Partial<Conversation>` 任意覆盖；main 同 providerId 一样保护生命周期字段。使用显式 `SessionRecordHandle`/写意图交给 storage 盖章，不从 stale Conversation 复制受保护头。
- handle 属于本作用域的一次记录登记，不能只传 id 让旧调用自动换绑最新 R。沿用 U §6.1 的 `ConversationMutationOrigin`：**业务第一次异步调用/回调注册前**捕获原 O/handle；main 的 rename/update/delete 输入边界先校验 origin 与原对象，再 mutation/发行 storage ticket；排队后复验 handle。origin 固定的是登记生命期，不冻结 F/saveEpoch，也不把一次 binding 的 R/F 快照当保存票据；同存活记录的自然 volatile→durable 迁移推进原 handle 的 confirmed binding，只退役旧统计 binding job，不误伤原对象后续业务步骤。必要签名破坏应让编译失败，不提供缺省 current、ID-only 异步兜底或完成时重新绑定。
- R/F 使用现有平台加密随机能力生成不复用 token；同作用域另用单调登记编号防重复发放。跨重启随机碰撞依赖通常的随机唯一性假设，不宣称数学零碰撞或跨进程共识。

#### 4.2 栅栏如何跟业务提交排序

SessionStorage 的每个当前 record handle 保存 `plannedFence / confirmedBinding / issuedBusinessEpoch / pending writes / uncertain / retired`。这些是控制状态，不是第二份持久业务记录。

- create：发行新 R/F，在真正业务写完成前没有已确认 durable binding。
- 历史保存、来源/resume/environment 失效或无法证明纯 metadata 的更新：入队前产生新 planned F；主链先按 U beginSave，再 mutation。payload 在入队时定格，含该 F。
- 纯 title/status 等业务更新：保留**最近已入队的 planned F**，不能用较早 confirmed F 覆盖排在前面的历史更新。
- 每个成功业务写仅在该次 adapter.write 和原本必要 legacy 清理均 resolve 后确认它自己的 binding/序号，并返回给主链；有后续 pending 时不误当整批已静止。
- write 或必要清理 reject：该次仍 reject；可能已落部分磁盘内容，标记 uncertain，不回滚 planned F，不以旧内存头伪造当前持久状态。未获后续成功业务写或正常业务重读确认之前，统计持久资格 fail-closed。正常业务重读只确认现存记录，不声称此前失败其实成功。
- numeric revision/saveEpoch 的增减仍归 U；F 不替代这些状态。纯 metadata 写没有历史变化时，不因它更新 updatedAt 就人为更换 F/正常读取许可。

#### 4.3 sidecar envelope

单文件为完整替换，不 append，不需要当前指针，不以 mtime 或 attemptId 选“最新”：

```ts
interface SizeCandidateEnvelopeV1 {
  schema: 1;
  kind: 'durable' | 'volatile';
  conversationId: string;
  providerId: string;
  recordToken: string;
  sizeFence: string;
  sourceKey: string;              // U 的有限白名单身份序列化值
  observationRevision: string | null; // provider 唯一 v2 revision；不是另一个来源算法
  attemptId: string;             // 本次物理写身份，不排序、不恢复许可
  files: ConversationSizeSnapshot['files'];
  history: ConversationSizeSnapshot['history'];
  integrity: { algorithm: 'sha256'; digest: string };
}
```

不存 title、updatedAt、lastResponseAt、messages、整个 providerState、DOM、保存 ticket、readEpoch 或可复活的 owner incarnation。公开 snapshot.revision 在读后按**新 job 当前 revision**重建，不能用磁盘旧数字与新实例比较。

checksum 对经白名单验证、固定键顺序序列化的完整 envelope payload（排除 integrity 自身）计算；writer/reader 共用一个 codec。它仅检出撕裂/截断/意外混合，不是第二套 provenance、签名或抗恶意篡改能力。非原子写可以留下旧完整文件、新完整文件或损坏文件；只有结构和 digest 均有效者可进入来源再认证。损坏不回退到旧 inline known。

数值要求与 U 一致：safe integer、非负、已支持的状态/原因/unit；known history 必有有效 v2 sourceRevision，且等于 observationRevision。store 不解析消息、不算 count、不根据文件存在自发认证 complete。

#### 4.4 最小接口分工

下列是目标契约，不是本轮代码：

| 所有者/接口 | 必要输入与结果 | 成功含义/限制 |
| --- | --- | --- |
| SessionStorage 正常读取 | 返回 `LoadedSessionRecord { metadata, handle, businessReadStamp }`；原 list/load 的返回类型同步升级 | 是业务读取结果；main 安装前仍检查 load batch 和 record stamp。不合并 sidecar。 |
| SessionStorage 业务保存 | `saveMetadata(handle, businessPayload, intent)` → `BusinessMetadataAck`；`intent=create/history/metadata-only/migration` | `written` 只在真实业务写及必要清理完成；obsolete 返回明确 skipped，主链不能当成功。I/O 原异常 reject。 |
| SessionStorage 删除 | `beginDelete(handle)` 同步保留 B 顺序和退役身份；一次性 ticket 对应本次删除 | 等 provider 的原 Promise 契约后删 metadata/必要 legacy；不是要求 native unlink 物理成功，不含 sidecar unlink。reject 后新正常读取可恢复/确认 absent，再新发 ticket，见 §7.1。 |
| ConversationSizeStore | `readCandidate(binding, lane)`、`probeBinding(binding, lane)`、`writeCandidate(request, lane)`、`purge(binding, lane)` | lane 由真实两槽 coordinator 发放；不得自行创建队列、跨入 B 或加载整会话。只读探针区分 missing/identity/obsolete/unavailable。 |
| ConversationSizePersistenceAck | `written { attemptId, recordToken, sizeFence, payloadDigest }`；或 `skipped { reason }` | written 仅确认本次统计 write Promise resolve，不是业务保存、不证明 final stat。无 ack/字段不匹配不得发布；异常 reject。 |
| 统计 skipped 原因 | 保留 missing-metadata/obsolete/identity-mismatch；增加 binding-unconfirmed、unsupported-storage | 入口及写前拒绝均零统计写。已实际写成而后失效仍返回 written，交最终校验拒绝，不能谎称没写过。 |
| ConversationSizeJobCoordinator | 当前 intent 登记/撤销；真实槽和 S lane；按 client/owner token 交回结果 | 不向业务返回需等待的统计 Promise；unregister 立即撤观察者，不伪造 I/O 终止。 |

AppSessionStorage 不再暴露可写 metadata 的 `saveSizeSnapshot(id,...)`；从 SharedAppStorage 明确获得独立 size store。旧签名删除而不是保留隐式 fallback；直接测试 fixture 必须适配。typed ACK 的原则复用，但统计 ACK 与 BusinessMetadataAck 是两种类型，不能互相代替。

### 5. 写入与读取合并：一条候选协议

#### 5.1 提交顺序

1. **同步捕获**：U 的 O/original registration、revision/saveEpoch/read token/gateEpoch、白名单 sourceBefore/允许的 after，以及当前 binding（kind/R/F/handle）。不存在当前原对象、保存中、binding uncertain 时直接负状态；不创建业务记录。
2. **等待当前 intent 被调度**：取得真实槽和对应 S lane 后重新校验。过期排队 intent 不启动 I/O，不发行新世代给旧 receipt。
3. **资格探针**：只读 ID 对应的 preferred，缺失时才看 legacy；preferred 存在但损坏/身份不符不得偷偷信 legacy。durable 要求 header 的 R/F/provider/ID 匹配；volatile 要求仍是原登记的无 header 记录。provider 比较必须先应用正常 loader 同一规则 `raw.providerId ?? DEFAULT_CHAT_PROVIDER_ID`（当前 Claude），不从当前 UI provider 猜，不要求旧 metadata 先补字段；显式其他 provider 不默认成 Claude，非法非空值 fail-closed。IO 前后均核当前 handle/业务序号；读到并发业务写的半成品只产生负结果。
4. **候选来源**：在同 lane 有限定位 sidecar；验证 envelope/checksum/kind/R/F/ID/provider/sourceKey，才可把它作为 U `ReadInput.persistedSnapshot`。随后由 provider 已完成 cache 或该候选加显式 stat 产生 observation。normal complete receipt 的授权仍由 U 单独核验；sidecar 不伪装成本次 normal read receipt。
5. **写前校验与投影分离**：在写候选前保存第 4 步不可变的**原始 provider observation `rawBefore`**；核 U 世代、原 owner、binding、原始 observation/proof。另施加 mandatory gate 生成安全 `candidate`：普通请求 gate 开着时 history=stale，files 可 known；只有本 job 有效 complete proof 才可保留已认证 known history。envelope 的 files/history、digest 和本次 ACK 对应的是 candidate，observationRevision 仍取 rawBefore 的来源版本。未降级的 rawBefore 不作为已认证公开结果落盘；store 不写/清理 metadata。
6. **本次 ACK**：write resolve 后才 written，attemptId/R/F/digest 必须对应同一次候选。任何 skipped/reject/无 ACK均不清门、不发布新候选；统计故障不改业务 Promise。
7. **写后资格和 final stat，同口径比较**：再做只读 binding 探针，然后复用 provider 同一 readConversationSize/revision 函数和同一最小读取输入取得**原始 `rawFinal`**；不能重新喂入已降级 candidate 导致自致差异。比较 rawBefore ↔ rawFinal 的 observationRevision、原始 files 状态/原因/bytes/fileCount、原始 history 状态/原因/count/unit/sourceRevision 和 proof；绝不比较 candidate.history=stale 与 rawFinal.history=known。负态字段/空 revision 按 U §8，不补零、不凭 null 认证。最后一次 await 后立即进入第 8 步，不再 await 存储或 UI。
8. **无 await 最终段**：同时核 O 仍当前、`getConversationSync(id) === 注册原对象`、handle/R/F、revision/saveEpoch/read token/gateEpoch、sourceKey/合法细化、非保存/删除/uncertain、本 job 未退役；以同一门规则确认安全投影 → 仅本有效 proof 清门 → 发布本次 written 对应的 candidate → onChanged。普通请求来源稳定时可发布 files known/history stale，gate 不变；不直接发布 rawFinal。任何不符只留下可失效的磁盘候选，不回滚业务文件，不伪造保存成功。

第 3/7 步是有限资格观察，不是跨文件事务。外部进程可在 final probe/stat 后改文件；最后同步段只能封住本 realm 的可管理变化。探针解析只提取固定字段，不枚举未知 provider 字段，不向日志输出 raw metadata。

#### 5.2 读取合并边界

- `listMetadata/loadMetadata/loadSettings` 只建立业务记录与 binding。**不得 await sidecar，不从 sidecar 生造会话，不将 sidecar 字段展开到 metadata。**
- `getConversationList/getTabBarItems/getSnapshot` 继续同步、无 I/O；size 仅来自 U service 已发布缓存。业务排序继续使用原 lastResponseAt/updatedAt/createdAt，统计写、attemptId、文件时间绝不改变它们。
- 冷启动 durable 候选可由正常统计 intent 进入上述完整协议：换新 O、新 revision，重新 stat、重新获得本次 written、final check，之后才 known。旧 ACK 不跨请求重用。
- 有 mandatory history gate 时，持久候选只是一份候选，不能代替新的正常 complete receipt 清门；冷启动无运行期 gate 时可按 U 的 v2 持久认证规则再验证，不恢复旧 runtime ticket。
- 负状态/失效通知不需要任何磁盘 ACK；正向候选无论 ordinary/proof/replay，均经同一协议。provider partial/fallback/unsupported 仍不改变正常加载 ready/error 兼容行为。

### 6. 两槽、挂起、取消与 service 重建

#### 6.1 作用域寿命

新增 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/storage/ConversationPersistenceScope.ts`：在当前 renderer realm 的具名宿主 registry 中，按规范化绝对 vault root 取得同一 scope。scope 持有 SessionStorage 的 B 状态和独立的统计 coordinator/store；是装配层复用，不把两类队列合并。

- registry 需跨 `new SharedStorageService`、loadSettings 和同 realm 插件卸载/再加载保留，不能仅用会被重新执行清零的模块变量。
- 协议版本不兼容而旧 actual operations 非零时，不开第二个统计 coordinator；新统计 fail-closed，业务可用既定兼容 B。B 协议不兼容则禁止热切换，转部署闸门。
- scope 的统计部分不持有旧 view、DOM 或完整 Conversation。运行 job 只留有限输入/token；client callback 在 registry 中注册，卸载后删除。job 在每个 await 后按 client token 查当前接收者，不能用闭包永久保留退役 app/聊天。
- 根的词法别名、不同 realm/窗口/进程不自动合并成全局 singleton。本案不做跨进程锁；此边界须如实标注。

#### 6.2 状态与取消

```text
intent: current → replaced/withdrawn
job: queued → running → written → final-check → published/discarded → settled
                         └─ 各异步阶段都可能永久 pending
owner: current → retired
physical: active → settled（只有真实 Promise settle 才走这条边）
```

- 至多 2 个 active pipeline；每个 pipeline 内 probe/read/stat/mkdir/write/final stat 顺序执行，不暗用 Promise.all 扇出。两个 job 可各占一个实际 I/O；normal hydrate 自身 I/O 不属于统计预算，不能偷算成它的取消。
- queued 是当前 intent，不为每次 refresh 创建永续 resolver 链。同 owner 仍按 U 至多最新 proof 和 ordinary 各一份；新世代替换旧意图，关闭撤可见性需求。
- 同一 S lane 被 retired-but-active job 占住时，新 intent 可等待但不抢占；其他 R 在剩余槽运行。队列只保存当前 owner 的需求，不保存历次调用。
- abort/close/delete 只撤许可和接收者。若底层尚未开始，可零 I/O退役；已开始而不可确认停止，仍计 active、仍占 lane，不能 Promise.race 后归还槽。每个真实 finally 最多归还一次。
- 全部两槽挂住：统计持续 unknown/stale，业务不等；没有超时自动补槽、无限 retry 或新增轮询。一个槽挂住：另一槽按当前需求公平轮转，不能永久优先某个持续刷新 owner。
- 普通 UI 关闭撤其需求；有效 owner 级 normal receipt 可继续，但旧 UI绝不能接收结果。onClose 不 drain stats。

统计 purge 也占同一两槽及 S lane。业务删除仅尝试登记 best-effort purge，不等结果；若 lane 正在运行，附一个 cleanup-on-settle 标记；若无可用槽，不无限累计删除历史队列。未能清理的孤儿允许保留。本案不新建全目录扫描/压缩/后台 janitor；要求有期限的磁盘回收见 D4。

### 7. 删除、同 ID 重建与迟到读写

#### 7.1 业务生命周期必须有明确边界

1. main 删除输入边界先验证**原异步起点**传来的 origin；无 await 段撤 U owner/许可/公开值、退役 handle，并同步保留 B[id] 删除 task/屏障。该 task 轮到后才按原 provider→metadata 顺序执行；不先在队列外启动 native 删除，也不让旧回调按 ID 删除新记录。
2. provider 的 `deleteConversationSession` **按原契约 resolve** 后，继续 metadata 与必要 legacy 删除。Claude 的物理 unlink best-effort；Codex/OpenCode 原生历史保留。不得将“provider resolve”解释成物理文件已消失，或新增 unlink 失败向业务传播的条件。metadata/legacy 的真实未捕获异常仍 reject；UI 后续处理也保留原业务结果，不以统计 ACK 替代。
3. 同 ID create 是**新生命周期**：pending 删除时只等旧业务 B，不等统计；旧删除 reject 且持久状态未确认时，等待的 create 明确失败、不写文件、不自动覆盖恢复出的旧记录。不同 ID 不受该屏障影响。reject 的队尾可继续调度恢复读取，**不等于**身份 uncertain 已解除；遇 uncertain 的普通写/create 明确失败，不在 B 队首等待恢复，以免堵住恢复读取。不能把永久 rejected Promise 留作永远无法退出的屏障。
4. 新 create 发新 R/F，不接受旧 binding。旧业务 save/load/migration ticket 排队后若 handle 退役，skipped/obsolete；不能写新记录。已经开始的旧业务 I/O 必须实际 settle 才能让后继生命周期推进，不能用超时/取消观察者代替。
5. stats 旧写可在 delete/create 成功后落到旧 R 地址；没有 metadata 写能力，新记录不引用旧 R，故只能成为孤儿。删除成功不承诺旧 sidecar 擦除，也不新增原生历史物理擦除保证。

**源码语义锚点〔既有读数，非实测〕**：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkSessionPaths.ts:56–66` 在 fs.unlink 外 catch；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/ClaudeConversationHistoryService.ts:850–860` 等待它；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/history/CodexConversationHistoryService.ts:364–369` 与 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/history/OpencodeConversationHistoryService.ts:59–64` 不删原生历史。相反，`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/storage/VaultFileAdapter.ts:43–46` 的 remove 异常向 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/SessionStorage.ts:104–109,196–200` 及 main 传播。

**reject、uncertain 与合法退出**（不新增恢复 UI、自动重试或产品功能）：

| 已实际发生的事实 | 屏障/后续合法动作 |
| --- | --- |
| provider 和 metadata/必要清理按原 Promise 契约全部完成 | 删除持久阶段完成，屏障可结束；随后 create 新发 R/F。即使 Claude 原生文件因 best-effort 仍在，也不能新增 uncertain。 |
| native/metadata/必要清理真的向外 reject，持久现状未知 | 原调用保持 reject，旧 O/handle/ticket 永久退役；B 可调度新的正常业务恢复读取，但不允许普通写/create越过 uncertain。统计只给负态。 |
| 新正常读取在 B 内确认有效的原记录仍存在 | 采用 loader 的 preferred 优先规则，核原 R/provider/ID（无头旧记录还核 scope 的原生命周期 stamp）；发**新 handle/O**，结束失败删除的 uncertain，保留 history 待认证。下一次用户正常 delete 发行**新删除 ticket**、重新保留 B 顺序；不能把原 retired handle 复活，不能重放旧票据。恢复存在不等于 native 删除未发生或原 delete 成功。 |
| 新正常读取确认 preferred/legacy **均确实缺失**，且旧实际业务操作已全 settle | 确认 absent 并退出 uncertain；后续明确同 ID create 才可新发 R/F。原 delete 的 reject 不追改，此前失败的 create 不自动重试。 |
| 新读取不可读/损坏/身份冲突，或仍有旧实际业务操作未 settle | 继续 uncertain；不得按 ID 重建、据 sidecar 修复、凭超时清障，或将 loader 吞错返回的 null 当“确认缺失”。无有限完成保证。 |

scope 对失败删除保留最小恢复上下文（ID/provider/原 R 或无头生命周期 stamp/删除阶段），不保留可复活的旧 O/ticket 权限。显式正常 loadSettings/list 除枚举所得 ID，还对本 scope 已知的未决删除 ID 作 B 内有限定点重读：即使两个文件都已消失、没有枚举行，也有合法的 absent 确认入口；这不是统计触发恢复、全目录扫描、自动轮询或新增 UI。

恢复判断由同一业务读取路径内部的 present/absent/unavailable 结果承载，列表原有跳坏行行为可保留；`loadMetadata` 的兼容 null 不能直接作为 absence 证明。正常重读/必要既有迁移在 B 内完成，不递归排同 ID、不等待 S；只确认当前事实，不追认失败的保存或删除。删除后 UI 收尾若另抛错，外层 Promise 仍按原语义 reject；已确认的持久 absent 不因此伪造 uncertain。

#### 7.2 迟到读取不许重新登记旧记录

- 统计读/资格探针：固定原 handle/R/F/O，在返回及最终发布时再检；不能在返回时按 ID 获取新 owner 再盖章。
- 正常 load/list：枚举只产生 ID，不拿已经读出的 legacy raw 在未来无条件迁移。每 ID 在 B lane 内重新选择 preferred/legacy、读/校验/必要迁移，内部不递归 enqueue。
- 正常读取返回 `businessReadStamp`；main 在无 await 安装段核 loadBatch 仍最新、handle 与 issuedBusinessEpoch 仍匹配。读期间发生 create/delete/save 时，旧行不能覆盖新对象或重新加入已删除对象。
- 列表还须在**枚举开始前**捕获 membership stamp/当时的登记集合，安装时和当前登记对齐；行 stamp 不能代表集合里不存在的行。枚举结束后新建的 ID 不在旧列表中，也必须保留其当前合法记录；“不在枚举结果”绝非删除许可。旧 batch 的安装不能抹去新 ID，也不能覆盖同 ID 新生命期；不得用无条件 `this.conversations = oldRows`。
- 安装采用带 stamp 的行核验及当前成员保留：过期行保留当前合法记录，无当前记录则不导入；枚举后新增/改变的当前登记并入结果，不恢复已退役项，仍按原业务时间字段排序。全局过期 loadBatch 整批不安装。下一次显式正常加载可重取，不自动无限 retry；启动无并发退化为原正常列表加载。
- 这修的是本案身份/迁移的必要同 realm 防复活边界；不是给 provider transcript 引入全局事务，亦不改 B 的 history lease/projection FIFO。

#### 7.3 持久删除后 UI 复位：与 U §6.5 同一协议

本节只闭合原 UI 清理与退役 handle 的衔接，不改变 §7.1 的 B 排序、provider Promise/reject/uncertain/恢复或 sidecar best-effort 行为。**采用 U §6.5 的专用 deleted-binding reset；普通 New Chat 仍先保存。** 不能继续用 createNew(force) 在已退役 origin 上 save，也不能将 obsolete 包装成 written。

1. **异步之前捕获**：main 验原 origin 后、splice/退役及首次 await/业务 task 开始前，同步取得原 view/manager/TabData/controller、state/DOM 身份、UI binding token/其绑定时原 origin/handle 及原 open claim 的 target 快照。TabData 真实存放一次 UI 附着身份，不在删除完成后通过 ID 找新对象补身份。token 与 O、R/F、claim、hydration/stream generation 正交；自然 volatile→durable 迁移不换 UI token，真正 detach/rebind（同 ID/同 origin 也算）及 closing 必须撤销旧 token。
2. **真实绑定准入**：TabManager 同 ID 的本 view/cross-view focus 捷径及 Controller.switchTo 的同 ID 早退须核存放的原 origin；新 O2 不被旧 O1 截回。已退役旧 claim 仅以捕获 ownerToken 调原 registry.release；不是删同 ID 当前 claim。新显式绑定在早退/guard之前进入实际准入 hook，可撤旧 deleted-reset 自己的 operation/guard，再按原 reserve/restore 流程绑定；不抢普通 creating/switching/save guard，不赋 token 假装已绑定。同 tab 的 switchTo 保存前置仅在原 outgoing O1/UI binding 持有**原 delete ticket 确认的持久完成事实**时免 save，其他存活 outgoing 仍先保存；该事实同步记录在原 ticket、先于 B 后继可执行，不按 ID 补捕、不增加等待、不把任意 obsolete 当已删。incoming O2 保持原正常恢复/业务 origin，orphan 原 outgoing 的回调在 merge/save 前短路；否则同 ID 早退或退役 outgoing save 会阻止实际重绑。新 create 仍等 §7.1 的 B 持久删除，释放 claim/免业务保存 UI 清理不是新业务写许可。
3. **持久屏障与 UI 分段**：provider、metadata/必要 legacy 按原 Promise 契约完成后结束持久 B 屏障；main 在 B **之外**仅处理已捕获 targets，不重枚举同 ID、不等新 create/bind，不加入 stats 或额外业务删除等待。UI 清理凭本次原删除完成 ticket 验身份，而不是让 retired handle 再 current。另一 tab 绑定新 O2 时，仍可清仍属原 O1 的 tab，不碰新 tab。
4. **免业务保存**：专用 controller 入口持 target/删除完成凭据，复用 blank UI 清理但不调 save/update/create、不发保存票、不消耗 session invalidation 保存、不 await stats。内部 UI 结果为 reset 或 skipped(binding-retired/tab-closed/busy)，不是 BusinessMetadataAck，不含 written。普通 createNew/普通 force 保留原 guards、先真实 save 后清绑定、原 reject/lazy blank；creating/switching 已忙仍 skip、不抢占，不称已复位，不轮询/追加等待/补偿 New Chat。
5. **reset 自有续体**：UI binding hook 只维护一个 reset operation token，拥有本次 creating guard；自己的 bound→resetting-blank/null 转移保留这份续体许可，不生成业务 origin。外部 bind/detach/closing 撤旧 operation，只解除其自有 guard。旧 finally compare-and-clear 自己，不能改新 UI/新 reset 的 flag。

| 关键提交点 | 与 U 相同的必要保护 |
| --- | --- |
| reset 开始、claim/guard | 当前 view/manager/map 中 tabId 必须仍是捕获的原 TabData/controller/state/DOM 实例，原 UI token/origin 一致、非 closing；再判断 busy。退役业务 origin 的一次 UI 清理资格与新 origin 写许可分开。 |
| cancel/S2 与所有同步回调 | 原 target 验证后才取消旧流/推进旧 stream generation/调用原 S2；hook 前后复验。main 不裸 cancel；不能等持有 stored grant 才取消/等同路 live。orphan callback 在 Tab.ts 进入 stream/merge/save 前，对 deleted-reset 或持同一删除完成凭据的重绑清理之原 outgoing binding 短路；不因 catch obsolete 伪称无保存，也不关闭新 binding/普通 New Chat 的正常回调。 |
| 自有 detach/open release | 守 operation 发布 state/tab 绑定，setter/callback 后再核；旧 claim 精确 ownerToken release，不按 ID 重取或清新 recovery source。自己的 null 不使合法旧 reset 续体失效，也不是新业务绑定。 |
| 默认 projection FIFO | 复用原 S+L runStored，无 bypassLive/timeout/dispose/新锁；本 reset 给 runStoredTransaction 额外传原 target/reset predicate，队列/grant/task 开始和正文均核，不能只比较清 ID 后的 null。null grant 不继续 input/callback 清理。 |
| grant 内 domain/DOM | 复验后清原 messages/lease/pageStore/windowRenderer、流 DOM 引用、usage/todos/计划，empty/create welcome/remount；本 reset 正文不 await，setter及 UI hook 前后仍验，重入重绑即停剩余提交。无 await 不等于不可重入。 |
| await 后 input/context/READY/onNewConversation | 复验原实例/operation；各 context/queue/READY/回调逐项保护，Tab.ts 回调**内部**也验。cleanup 只作用捕获且仍属本 operation 的 runtime，清 service/binding/模型/搜索 compare-and-clear，不能无条件 cleanup 当前新 runtime。 |
| finally/删除菜单外层续体 | 只释放自己 guard；deleteHistoryConversation 的 rerender/loadActive 认原 origin/UI/visibility session，不在 await 后因同 ID 新绑定重新 load/清 UI。UI 真异常保留外层 reject，持久 absent 不变 uncertain。 |

这是局部 UI binding/reset hook 的必要接线，不是新全局框架。原 registry 的 token release、projection FIFO、S2/render-flush 直接复用；auto 实际 release 与 user 原 finally 的实际 release 分开验证。原 projection predecessor 永久 pending 时 UI reset 仍可能等待原 UI 流程；不偷放 lease、不加业务/stats 等待、不宣称有限 UI 完成。若真实测试要求改变 B/runtime 的取消/释放语义，停止回主会话，不扩大本案。重绑/退役只撤旧清理，新业务和新 UI 不被取消、保存、清空或禁用。

### 8. 故障与崩溃/恢复一致性

**不要求任意一次 write 原子或 fsync。** 单 sidecar 是可重建候选，不是业务日志。恢复必须从业务记录出发，永不通过枚举统计目录恢复会话。

| 中断/故障阶段 | 可留下什么 | 当前运行/恢复规则 |
| --- | --- | --- |
| intent/读取前 | 无新磁盘候选 | 负态；重启没有旧 runtime 许可。 |
| 资格探针缺失/损坏/拒绝 | 旧 sidecar 可仍在 | missing/identity/unavailable，零新统计写；不迁移、不创建 metadata。 |
| 侧文件 read 或 provider stat pending | 活动槽占用，B 不依赖 | owner 可立即退役；无法确认 IO结束不放槽；业务照原真实 I/O处理。 |
| mkdir/write 抛错 | 无文件、旧完整文件、半文件，甚至完整新文件都可能 | 本次 reject、不清门/发布；不推断“没有写过”。后来只接受完整校验后的候选。 |
| write 完整、ACK尚未送达 | 磁盘可有完整候选；旧调用是否成功未知 | 旧调用不补发成功；重启可将 durable 候选重新认证并重新 written，属于**新提交**。volatile 不恢复。 |
| ACK written 后、final probe/stat 前崩溃 | 完整但从未发布的候选 | 不恢复 published 状态；新 owner 重新走全协议，或因 R/F/source 不符丢弃。 |
| final stat 后、最终段前 owner/保存变化 | 文件可能仍旧完整 | 同步检查拒绝。若进程崩溃，按实际恢复到的业务 header + 当前来源重新认证；不恢复旧 gate 数字。 |
| published 后进程崩溃/掉电 | 新文件、旧文件、损坏或丢失均可能 | UI冷启动先 unknown；不承诺最后一次 ACK 的断电持久性；有效 durable 证书须再提交验证。 |
| 历史业务写前开始保存后崩溃 | 可能仍是旧 F，transcript 可能已改变 | 原保存不追认为成功。以实际读到的 metadata 和当前 provider v2 指纹重认证；指纹不符不能 known。若要求跨崩溃保留“曾 beginSave 的门”，需业务事务/持久 dirty 记录，超出本案。 |
| 新 F 已写、sidecar 仍旧 F | 跨域不一致 | 正常允许：旧 sidecar不合资格，统计 unknown；正常 read/cert 后可写新 F，不阻塞业务。 |
| metadata write/legacy cleanup失败 | 两份 metadata 或不确定内容 | 当前 binding uncertain；业务原异常。正常重读按 preferred 优先确认现存状态；本案不解决业务文件断电原子性。 |
| 删除成功，旧统计 write 迟到/清理前崩溃 | 旧 R 的孤儿统计文件 | 无权威 metadata 引用，不参与 list/recovery；新同 ID R2不会读它。 |
| 删除尚未完成时崩溃 | metadata可能仍在或native部分已删 | 不宣称 delete成功。启动按现有记录加载，新 owner和provider正常负态；这不是“删除成功后被统计复活”。 |
| 正常迁移 preferred已写、legacy清理未完 | 两份记录，可能头不同 | 只读业务 preferred优先；不合并/择较新mtime；统计写不承担清理。 |

checksum 以常规 SHA-256 非恶意损坏检测假设工作；它不保障业务 metadata 本身的完整原子性。对业务文件损坏而 loader 无法确认 R/F 的情况，统计 fail-closed；不根据 sidecar“修复”业务头。外部回滚整份旧 metadata、复制旧 R 或跨进程同时写不是本协议能封住的输入。

### 9. 迁移：不让统计初始化重回业务队首

#### 9.1 首次运行新协议

- 新 create 在其本来就需要的业务写中落 R/F，无额外统计触发写。
- 已有合法 `sizePersistence.schema=1`：正常业务加载采用 durable binding；其 sidecar按完整读取协议验证。
- **旧 metadata 无 sizePersistence**：正常业务加载不为统计补写 header，不新增启动迁移屏障。为当前原对象登记 fresh volatile R/F，只保存在 scope/owner 绑定中；统计用 volatile 地址独立写，仍可在正常 complete receipt 后 written+final check→known。
- volatile 不跨重启/对象重新登记复用，也不通过 ID/source/createdAt 猜回旧地址。因此在未发生下一次自然业务写的旧记录上，重启后需下一次本来就发生的正常完整读取才能重新产生 known；不是等待下一次业务保存才能 known，不主动 hover hydrate。
- 下一次自然业务 write 或原本已存在的 legacy 迁移，顺带安装**全新 durable R/F**；这不是统计 job 发起的写。转移期间暂停旧 binding 提交；成功后旧 volatile jobs退役，普通 cache可在新 binding 上重新认证。若这是历史保存，U 的 mandatory gate仍需正常新 receipt；纯 metadata 安装不伪造历史保存。
- 头字段存在但格式损坏/未知版本：不能当作“无头旧格式”自降级。统计 unavailable；业务路径保留该未知字段，不猜其身份、不默默改写为 v1。修复/降级需明确迁移裁决。
- 新代码一律忽略旧 inline sizeSnapshot（包含未来可能出现的 v2 inline 值），避免无 R 的证书跨重建使用。原 U 的 v1完整性失效规则继续成立；不迁旧 messageCount、不扫描 transcript、不做统计目录发现。

这项 volatile 过渡是同一候选协议的非 restorable binding 特例，不是第二套 count/provenance 算法，也不是临时把统计关掉。

#### 9.2 切换与回滚闸门

- **禁止新旧 writer 并行热切换**：旧实现已有未完成 metadata overlay 时，它仍有业务文件写权限；新 sidecar 无法阻止旧代码稍后覆盖业务。实施前须证明旧 metadata writer 已实际 settle/退出适用作用域。确认不了时停在 cutover gate，不能将“不再订阅”当成旧 I/O 已停止。
- 完整关闭宿主后再启动是隔离旧代码的运维候选，不等同 fsync、存储无在途写或旧 ac82已停止；实际切换方式及可验证的 writer 静止条件需部署阶段单独批准。当前不执行任何关闭/reload。
- 新协议内部同 realm service重建复用 scope/槽/队尾；不能借重建清掉挂起计数。
- 功能回退可停止接纳统计 intent、公开 unknown、撤 UI订阅，不等待 sidecar drain；本案不新增配置开关，回退入口随实施/部署方案明确。
- 二进制回滚同样不能宣称热切换安全。旧版本可忽略未知 sidecar；当前旧 serializer 会省略新 header，回到新版本后即按无头 volatile重新开始。旧版本重新产生的 inline snapshot仍不可信。
- 不把 sidecar反灌旧 metadata以“保留统计”；不清空业务目录、不删除未知未来 schema数据。回滚不还原整个 vault。正常业务兼容以合成记录双版本读取/写后再升级测试证明，不能仅声称“JSON向后兼容”。

### 10. 精确实施文件与依赖

下表是**未来获批改动清单**，非本轮实施。共享 main/core 类型需主会话先释放 B 共享所有权；其他 U改动按 U清单执行，不在此借机再扩大。

| 绝对路径 | 新/改及责任 |
| --- | --- |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/ConversationSizeStore.ts` | 新：固定统计根、窄原生 IO能力、业务头只读 probe、单一 envelope codec/checksum、typed读/写/清理。不拥有业务写权限，不自行调度。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationSizeJobCoordinator.ts` | 新：实际两槽、per-R lane、当前 intents、retired-but-active、client token分发、bounded best-effort purge；不持有DOM/完整会话。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/storage/ConversationPersistenceScope.ts` | 新：同 realm/vault 的长期装配 registry；复用业务 SessionStorage与独立统计 coordinator；协议兼容闸门，不合队列。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/SessionStorage.ts` | 改：受保护R/F、handle、行/成员stamp、intent/ACK、仅业务FIFO；删除pending/uncertain/恢复读取及新ticket；内部present/absent/unavailable不能用吞错null代替；去overlay写、strip sizeSnapshot。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/StoragePaths.ts` | 改：声明固定统计根/version/durable/volatile路径；原业务路径不改。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/storage.ts` | 改：SharedAppStorage显式暴露独立统计能力/作用域所需类型，不藏在 sessions.saveSizeSnapshot。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts` | 改：AppSessionStorage handle/ACK/loaded receipt；独立 stats ACK/binding/lane契约，沿用已有中立size类型。U的证据类型修改合并设计但分别核对。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/types/chat.ts` | 改：新增业务持久binding头/loaded类型所需字段；Conversation/Meta 的sizeSnapshot仅内存投影，SessionMetadata旧字段仅可读兼容。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/storage/SharedStorageService.ts` | 改：从scope取得session/统计能力，initialize只等业务目录，不为统计建目录或等任何统计Promise。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationSizeService.ts` | 改：U owner许可接binding；普通/proof/replay统一管线；保留rawBefore/rawFinal、独立gate安全投影；协调器执行、final probe/stat及本次ACK后无await发布。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts` | 改：五处直接save及Controller历史save入口的intent/原origin/handle/ACK；rename/update/delete输入先验证起点身份，手工rename两步同origin；delete 退役/首次 await 前捕获原 UI targets，B 持久屏障后在 B 外按快照免保存 reset，不晚按 ID 枚举/裸 cancel；跨 view focus 查询携 origin。loadSettings行+batch+成员stamp及失败删除恢复，新create返回原登记。环境/来源mutation前记票；无stats await/sidecar合并。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/InputController.ts` | 与U合并必要改动：首次标题链及resume清理从异步起点传origin，lazy create 原返回登记通过 UI binding hook 安装，禁止晚按ID绑定；原 cancel/watchdog/turn 语义不改。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts` | 与U合并：regenerateTitle、历史回填、save、inline rename/删除确认贯穿原origin；新增 deleted-binding 免保存 reset，普通 createNew 保留先 save；switchTo 同 ID 早退认 incoming 原 origin，仅凭原删除完成 ticket 跳过已删 outgoing save，存活 outgoing 仍先保存；本 reset 的 stored 额外 predicate、grant/task/await 后/嵌套回调/finally及删除菜单续体验证原 token/自有 guard。保留silent/手工标题优先及B lease/交换/FIFO语义。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/ClaudianView.ts` | 与U合并：tab rename输入框打开时捕获原origin，提交回调只携带原身份；不新建UI机制。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/TabManager.ts` | 与U合并：fork新建结果贯穿初始化与失败删除清理；同步原 UI target 捕获/验证、实际绑定/自有 reset guard、同 ID origin-aware focus/reserve 准入、原 claim token 释放、bind/closing 撤旧 reset，不假 bind 或改新业务条件。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/Tab.ts` | 必要生产改动：真实 controller 注入 binding/reset hooks；ensureService/state→tab同步/onNewConversation 贯穿原 token；deleted reset 的 orphan 回调在 stream/merge/save 前短路；runtime/模型/搜索/READY/UI 回调内部复验、条件清理原资源，普通 New Chat/新 binding 回调不变。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/tabs/types.ts` | 必要 UI binding/target/reset operation 及 TabData/TabHydrationHooks/manager 窄类型，不只 badge；不改持久结构或 turn/projection lease。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/core/bootstrap/ConversationSizeStore.test.ts` | 新：真实codec/store，故障只注入物理IO边界。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/app/ConversationSizeJobCoordinator.test.ts` | 新：真实两槽、per-R lane、取消、重建及回收有界性。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/app/storage/ConversationPersistenceScope.test.ts` | 新：跨实例/同realm重载scope、旧client撤销、版本不兼容fail-closed。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/conversationSizePersistence.test.ts` | 新：真实main/SessionStorage/provider/app/store的FIFO blocked、delete/recreate、迁移、恢复组合矩阵。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/storage/SessionStorage.test.ts` | 改：原兼容入口继续测core；旧overlay测试转移/重写为业务剥离、binding/FIFO/迁移及typed业务结果，不搬目录。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/app/ConversationSizeService.test.ts` | 改：绑定字段、ACK、candidate replay、raw同口径比较及安全gate投影；不得只把mock改成无条件written。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/controllers/InputController.test.ts` | 改：首次标题/resume原origin贯穿、同ID重建前尚无ticket的旧回调；真实组合链另在integration验证。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/controllers/ConversationController.test.ts` | 改：regenerateTitle、手工输入/删除确认、回填/save原origin；专用免保存 reset 的 busy/原 token/真实 grant/await 后/finally 与普通先 save 对照；正常silent/手工标题优先回归，不改B测试口径。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/Tab.test.ts` | 改：真实 initializeTabControllers/reset 回调、orphan 不诱发 save/merge、新 runtime 不被 cleanup/置 null、原 operation 自有 detach/guard，配 Lifecycle 真实链。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/TabManager.test.ts` | 改：原 target 同步捕获、同 ID 实际 focus/reserve/restore 新 origin、精确旧 claim release、同/不同 tab 与 closing/自有 reset guard 回归；不能手填 token 代替绑定。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/main.test.ts` | 改：所有存储fixture签名、六业务入口、正常load迟到结果和delete屏障。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/conversationSize.test.ts` | 改：原真实尺寸链的持久断言改为sidecar、metadata无size字段；保留provider与UI正/负回归。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/storage/storage.test.ts` | 改：既有SharedStorage兼容入口装配fixture适配；确保统计初始化不污染业务initialize。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/storage/storageService.convenience.test.ts` | 改：相同存储类型变更的机械适配与无统计等待断言，不扩业务功能。 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/README.md` | 后续另获写授权后登记设计/回归入口与运行存储布局；本轮不改。 |

直接复用不改：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/storage/VaultFileAdapter.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/storage/HomeFileAdapter.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/utils/path.ts`。不声称给它们加取消/fsync/跨进程锁。`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/history/sdkSessionPaths.ts` 的best-effort及各provider的deleteConversationSession语义只读复用，不把订正变成provider删除行为改造。

U拥有而本案不另改算法：`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/utils/conversationSizeSource.ts`；Claude/Codex正常证据及v2 revision；OpenCode negative兼容；Controller/View/TabManager/TabBar真实接线与 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/conversationSizeLifecycle.test.ts`。本案H1/H2/H3及 T39–T47（U 的 D01–D09）验收依赖该Lifecycle入口；它仍按U新增，必须包含真实 onOpen/Tab.ts/controller/main 删除复位链，不能因本案只新增存储测试而漏验真实UI/close链。

依赖方向：core类型/路径 → SessionStorage与SizeStore（互不写对方）→ app scope/coordinator → SizeService/main装配 → 原UI getter。provider证据 → SizeService；不存在 stats→业务save→stats 或 paint→refresh环。

### 11. 实施与回滚迁移阶段

| 闸门 | 目标/退出条件 |
| --- | --- |
| G0 设计确认 | 用户确认本案具体边界、D1–D4，及与U的差异；释放必要共享范围。当前不实施。 |
| G1 基线红测 | 保留真实旧overlay阻塞反例；添加metadata无统计写权限、同ID重建、旧load/迁移迟到、统计两槽跨实例的目标红测。记录既有正向回归，不伪造全部先红。 |
| G2 业务身份与存储分域 | 实现R/F/handle/业务ACK与scope；实现独立store与codec；先证明业务文件所有写都不来自统计、初始化无stats依赖。此时尚不宣称A已可发布known。 |
| G3 U证据及统计协议组合 | U证据/owner/version修复到位后，接入coordinator、ordinary/proof/replay、final probe/stat、volatile→durable转换；每次更改同命令转绿。 |
| G4 共享入口 | 获释放后接六业务保存、正常load/delete生命周期与U真实UI链；验证每种stats挂起不挡业务、H3不假成功、updatedAt/排序不受stats影响。 |
| G5 恢复/兼容验证 | 合成磁盘/子进程故障注入逐切点恢复，双版本读写兼容、未知schema、实际worker证据回归；生成新的A-only冻结证据，独立复核。 |
| G6 运维切换 | 另行授权确认旧metadata writer静止、受控宿主验证、部署/回滚步骤。未达此门不能用reload强行甩掉挂起。 |

### 12. 与 U 的组合自洽性

本案只补 U1-c，但确实改变 U 中部分待定持久约束；组合必须采用下表，不能声称两个文本毫无差异：

| U原位置 | 组合规则 |
| --- | --- |
| §3.1 保持SessionMetadata.sizeSnapshot原位置、§4.6不改schema | 被本案**明确调整**：公开snapshot形状不变，持久位置改sidecar；业务新增身份头，inline只读兼容且不信任。provider v2 revision仍只有原单点。 |
| §3.7/§8.6 现有saveSizeSnapshot与原ACK | ACK原则保留，能力移到独立store、ACK绑定本次R/F/attempt；stats不再参与必要legacy清理，业务清理仍影响业务ACK。 |
| §4.7 重启可重验v2持久统计 | durable执行；旧无身份记录volatile不恢复，下一次正常完整读取后仍可独立written→known。新增边界须用户确认。 |
| §6 owner/读取许可/保存ticket、§8 final stat | 全保留，并增加binding gate；磁盘R/F不能替代O、原对象、saveEpoch/read token/gateEpoch。 |
| §9.3 H2/U1尚未闭合 | 在本案所定义单realm/I/O可推进范围内，以写权限+实际FIFO分域闭合；不扩大为OS或跨进程非阻塞。 |
| §11“SessionStorage默认不改布局/FIFO” | 本案为U1获准另设计的具体变更；B业务FIFO仍严格，stats从该域彻底移出。 |
| F1/F2/F8证据完整性与source白名单 | 不弱化；错误v1证书即使checksum正确也无效。storage不补做分支/归一化算法。 |
| UI/正常加载兼容、失效rAF、展示不hydrate | 全保留；新读取合并不放进同步getter或业务list/load。 |
| U §6.5 删除后 UI reset 与本稿 §7.3 | 同一协议：退役/首次异步前捕获原 binding/实例；真实同 ID 新 origin 准入；持久屏障后在 B 外免保存复位；默认 projection、嵌套回调、finally验证原 token/自有 guard。普通 New Chat先 save、provider/reject/uncertain不变；重绑仅跳旧清理。 |
| U D01–D09 与本稿 T39–T47 | 一一对应，共用真实 Lifecycle/main/Controller/Tab/TabManager 载体；不以存储层mock成功、纸面token或只换数组对象代替真实重绑和 UI blank。 |

因此组合定义为“U除上表明确变更项 + 本案”，不是只完成隔离就宣告U全部缺陷已修复。本次授权A–D订正在两稿同步：原身份捕获早于异步与storage ticket、保持provider删除语义及失败恢复、raw同口径比较/安全门投影、列表成员与缺省provider一致性。本次删除后 UI 订正另同步 U §6.5/本稿 §7.3 及 D01–D09/T39–T47、必要 Tab.ts/tabs/types 和镜像测试范围，不改变前述 A–D/存储/provider/性能取舍。两稿status仍draft；frontmatter及其他旧记录/status不改，无新产物。

### 13. 方案推演与自检

以下均为**推算/纯示意**，不是本轮运行行为。锚值用于确定红绿判据；前述哈希实测不能证明这些时序通过。

#### 13.1 同对象的提交与世代走查

锚值：C 的业务 title=A、R=R1、F=F7；O=O3、revision=4、saveEpoch=2、gateEpoch=8；来源V2-a，候选files=6 B/1 file、history=2 turns。

| 案例（纯示意） | 两端分别记成什么 | 绿/红判据 |
| --- | --- | --- |
| S1(C)统计write挂起；随后rename title=B | S持R1/F7；B仍R1/F7，只改title/updatedAt | 绿：B write开始并完成，rename成功；S仍active。红：等S或先假成功。 |
| 上例S1晚写完成 | 旧统计仅改durable/R1.json；B文件title=B | 绿：业务记录逐字仍是rename结果；统计不得整份回写title=A。 |
| S1挂起；history-save入队F8，e=3 | B可提交R1/F8；S1仍R1/F7/O3/e2 | 绿：S1可written但final拒绝，不清门；新record不接受F7证书。 |
| write后V2-a变V2-b，R/F不变 | ACK仍确认写过a；final stat读b | 绿：不发布2、不清门。红：把R/F匹配当来源完整有效。 |
| proof count3先发布；旧ordinary count2/unknown后返回 | U已换gateEpoch；旧job被退役 | 绿：不覆盖known3；一个R实际pipeline串行，queued旧意图不借proof。 |
| 旧O3替换为同R/F/source的新O4 | 磁盘候选可能可供O4**新job**再认证；旧job仍O3 | 绿：旧callback不发布；O4独立stat/written/final可认证。红：完成时重捕O4给旧job盖章。 |
| source文件只有50轮已materialize、完整正常证据为300轮 | sidecar承载完整provider count300，存储不重新计数 | 绿：known300；红：以窗口数/旧messageCount替代。 |

无新增金额/费率公式；6 B沿用UTF-8“汉字”的锚值，仅检查统计和业务数据不相互覆盖，不修改计量口径。

#### 13.2 delete/recreate与迁移走查

- **推算**：t0 S(R1)已在write；t1 delete退役O3/H1并保留B屏障；t2正常native+metadata删除完成；t3 create同ID成功，R2/F1/O4；t4旧S(R1)落盘。绿：main只见R2，title/来源属R2，新统计地址为R2；旧R1只可能成为孤儿。红：按ID给R2套旧统计，或旧delete排在R2 create之后才执行。
- **推算**：旧legacy read返回前发生delete；若继续`saveMetadata(raw)`会重建旧业务文件，这是反例。目标读必须在B重新选择并返回stamp；退役stamp无法迁移/安装。绿：删除后无旧业务记录复活。
- **纯示意**：无头C加载，volatile V1；normal完整读取后V1.json written→known2；本轮无任何因统计新增的metadata写。随后rename自然写安装R2/F1；V1迟到写不能覆盖R2，也不能阻塞rename。重启只定位R2。若从未自然写，重启不定位V1，仅下一次正常完整读取重新认证。
- **纯示意**：历史S1入队F8，rename随后入队；后者必须带planned F8而不是旧confirmed F7。绿：最终metadata仍F8；红：纯title更新把栅栏退回7。

补充订正走查（均〔纯示意〕，未实测）：

| 锚值/时序 | 绿判据 | 红判据/反例 |
| --- | --- | --- |
| R1/H1/O3，D1删除：真实Claude unlink抛错但原catch吞掉，metadata remove完成 | provider及持久删除resolve，屏障结束；原生路径可仍存在，业务delete不因此reject | 为满足“物理删除成功”而改provider错误语义或平白置uncertain |
| D1的metadata remove真reject；随后在B正常重读到原R1 | D1保持reject，发新H2/O4，stats history stale；H1/D1永不复活 | 把已退役H1重新设current，或normal read永远排在等待自身解除的uncertain之后 |
| 恢复R1/H2后再次正常delete发行D2，再create同ID | D2≠D1；D2真实完成后发R2/F1，R2≠R1；旧写/回调不作用R2 | 复用D1导致永远obsolete，或失败时已等待的create自动覆盖恢复的R1 |
| D1删除已产生部分效果但reject，新业务读取确认两路径均absent，旧实际操作全部settle | 原reject不翻案，解除uncertain；之后明确create获R2 | 将loadMetadata吞错的null当absent；半文件/不可读也清障 |
| 标题任务起于O3/R1，尚未发行storage ticket；D1完成、同ID同title创建O4/R2后回调才到main | 输入origin仍O3/H1，mutation前obsolete；R2的title/status/来源/业务写次数全不变 | 在main入口按ID拿H2/R2发新ticket；存储检查虽全过，业务已经换绑 |
| L1枚举只有A；随后创建未被枚举的B；L1最后安装 | 保留B及其当前origin；有效A按原排序合并；新L2已安装则整个L1拒绝 | 只校验旧行stamp后整体赋值，B消失 |
| metadata无providerId、无header；normal loader默认claude | 资格探针同样默认claude，volatile可正常认证；显式codex仍拒Claude binding | 原始undefined和claude直接比较挡住所有旧Claude记录 |
| mandatory gate=8；rawBefore/rawFinal均V2-a、4096 B/1 file、known2 turns，无proof | 本次written后发布files known4096/history stale；gate仍8；envelope history也stale | candidate stale与raw known混比导致bytes不能更新；或持久化raw known2绕门 |
| 上行写后来源变V2-b/8192 B，或换O/F | raw比较/同步终检拒绝发布、不清门 | 为修复混比而删除最终stat或放松身份核验 |

删除 UI 补充走查〔纯示意，未实测〕：ID=C、R1/H1/O1、READY T1、UI U7、1 条消息，reset Q9；与 U §13.3 同口径。

| 实際链/窗口 | 绿判据 | 红判据/反例 |
| --- | --- | --- |
| D1 持久完成后 T1/U7 尚未换绑 | Q9 免 save，默认 projection→blank/welcome/空输入/READY，D1 外层真返回；H1/O1仍 retired | createNew(force) 调 save，在 retired H1 reject/假 written；仅metadata已删但 UI 未空也报完成 |
| D1 provider/metadata pending 期间请求 create；B 完成后 R2/O2 实际绑同 tab U8 | 原捕获 U7 过期，旧 cancel/save/DOM/cleanup 增量0；新 claim/stream/消息/input不变；真实 focus/reserve不截回O1 | 完成后按ID捕获U8；只换 conversations 对象而未bind；旧busy/focus使所谓重绑根本未发生 |
| R2/O2 实际绑 T2，T1 仍 U7 | 只 T1 可 blank；T2新 runtime/UI/metadata不变，原 claim token不能释放T2新claim | 清理按ID遍历两tab或清理新claim/recovery source |
| Q9 自有 detach后等待真实grant，新binding进入；或setter/onNewConversation内部重入安装新service | 撤Q9/其guard，grant/task/await/回调内部全部拒绝旧余下提交；finally不清新flag，service不被置null | null grant后仍清输入；仅回调前核token；无await被冒充为不重入 |
| 原非streaming async subagent被orphan | 真实Tab.ts回调在stream/merge/save前短路，save/write增量0；普通NewChat仍先真实save | 只去掉显式save，orphan回调仍触发业务保存/按IDmerge新O |

#### 13.3 挂起槽与重建走查

锚值为actual=2：J1在stat、J2在sidecar write；两者owner均撤销。关闭20次菜单、重建3次SharedStorageService、新开同vault新service。

绿：actual仍2，新stats实际开始数0，当前UI需求撤销，无旧DOM闭包；新业务save真实完成后返回。真实J1 settle后actual降至1，才启动一个当前有效job，actual回2；J2仍占槽。红：超时或实例重建后active归0，实际产生第三个I/O；或close等待drain。

#### 13.4 论证链、反例与不变量判定

**隔离链（推算）**：stats只有统计根写能力 → stats不在B队尾且B没有等待stats的边 → stats挂起不能成为B前驱 → 在B自身可推进时业务真实写可完成 → stats迟到也不能改业务文件。隐含前提：所有入口遵守窄能力、旧overlay writer已退出、业务IO/事件循环可推进。

具体反例：只移路径却继续`enqueueWrite(id)`，第一条写权限成立但第二条不成立，H2仍阻塞；同磁盘整体故障会推翻“B自身可推进”前提，不能据此宣称绝对低延迟。

**防复活链（推算）**：业务记录才发行可恢复R → delete成功移除旧R的业务记录 → create发新R → stats既不能发业务记录也不能改R → 旧R迟到写不能被新R引用。反例：按id+createdAt/source哈希生成R，同样输入重建会重用R；或把sidecar当list入口，就会破坏第一步。

**认证链（推算）**：U正常完整证据/合法持久证书 → 同v2来源候选 → 当前O/R/F/保存世代许可 → 本次written → final probe/stat仍匹配 → 无await最终检查 → 新published。反例：write ACK回来前文件换版本，即使R/F未变也不能跳过final stat。

| 结构不变量 | 设计判定/位置 |
| --- | --- |
| 业务与统计写权限正交 | 成立：第3节；统计写不到meta，业务不读写sidecar。 |
| 业务排序不被统计时间污染 | 成立：第5.2节；不改业务时间/列表排序键。 |
| 身份与完整性正交 | 成立：第1/4/5节；R/F不是complete证据，旧v1不因codec正确变合法。 |
| 异步起点与storage ticket身份贯通 | 成立：U§6.1及本案§4.1；未发行ticket的旧回调也先被main拒绝，不靠末端storage检查补救。 |
| raw观察与安全投影正交 | 成立：§5.1；只比两原始observation，持久化/发布均套gate，无proof不能清门。 |
| 删除屏障可安全退出 | 成立：§7.1；真实reject不追认，正常读取可在B运行确认present/absent，新handle/ticket不复用。不可判定时不承诺有限退出。 |
| 行stamp不冒充集合完整性 | 成立：§7.2；保留枚举后新ID，过期batch不全量覆盖；缺省provider与loader同口径。 |
| 退役业务handle与原UI清理授权正交 | 设计成立：§7.3/U§6.5；只清原target，不让retired handle保存，不输出业务written；普通NewChat保留先save。 |
| tab实例×绑定生命期×reset续体覆盖 | 设计要求成立，未实测：真实准入、guard、grant/task、await后、回调内部、finally全检；仅ID/入口token违反，重绑仅撤旧清理。 |
| UI projection与B/S排序无新增环 | 设计成立：持久B屏障结束后UI reset在B外；原live失效在默认stored等待前，不等stats/create、不强放user lease，不提供原UI前驱永挂时完成期限。 |
| 物理操作与逻辑取消正交 | 成立：第6节；retired active仍占槽/lane。 |
| 数据流无环 | 成立：正常read→证据→stats→内存投影；不存在stats→业务save或paint→stats反馈。 |
| 退化是一般情况特例 | 成立：volatile仅不可恢复；unknown/unsupported走同一ACK与门规则。 |
| 扩展点沿正确方向 | 成立：新provider提供证据/来源；存储不识别其格式；新存储schema不改变count单位。 |
| 同realm至多2真实pipeline | 设计成立：scope跨实例、lane跨取消；待实际重载/挂起测试。不声称跨realm成立。 |
| 断电后必保持最后一次ACK、全目录无孤儿、跨进程CAS | **不成立/不提供**：本存储能力未证明，见第8节及D3/D4。 |
| 多入口全覆盖 | 要求成立，尚未实测；下面矩阵含六业务写、正常load、stats三个来源、delete/close。 |

**旧 UI 隔离链〔推算〕**：异步前原 O/UI token/tab 实例固定 → 持久删除完成凭据只授权原 UI 免保存 reset → 每个实际新 binding 准入撤旧 reset/guard、旧 claim release不伤新 claim → default grant/task/await后/嵌套回调逐点复验 → 旧续体不修改新业务/UI。隐含前提是实际 bind/回调接线完整，不是 token 类型存在就成立。反例：入口有效，projection 等待中已换 U8；若 null 返回后照旧执行 onNewConversation→cleanupTabRuntime，U8 新 runtime 被清掉。另一个反例：只删显式save，orphan同步callback仍发save。故存储隔离本身不能证明 UI 衔接成立，T39–T47必须实测。

追溯不翻案：保留R0对原typed ACK和FIFO安全性的评价；本案改变的是stats进入同一FIFO的前提，不是宣布FIFO有错。前向反事实：保留旧overlay入口、丢掉R/F、只做路径隔离或重建计数器，分别重新得到业务覆盖、重建误认、H2阻塞或真实并发超2。

## 风险与权衡

### 待用户确认的真实事项

| 裁决 | 推荐及边界 |
| --- | --- |
| **D1 具体持久方案** | 确认record-lifetime sidecar、原生异步统计能力、独立S/B域、新sizePersistence头及typed接口；这是当前draft的核心选择，不因已同意另设计U1-c就视作已批。 |
| **D2 旧记录兼容与不确定态** | 确认无头记录用volatile过渡、不为stats补业务写；它能本轮normal-read后known，但未自然迁移前不能跨重启恢复known。未知/损坏header或业务写结果不确定时stats保守unknown，正常业务继续；不自动修复业务身份。 |
| **D3 强保证范围** | 推荐只承诺单realm应用提交/排序隔离，以及业务自身可推进条件下不受stats前驱阻塞；不承诺跨进程原子性、全局并发2、fsync、I/O强取消或OS故障下完成期限。若用户必须要这些，需另授权平台/事务/资源隔离设计，本案不能实施为“已满足”。 |
| **D4 删除与回收** | 推荐业务delete不等待sidecar擦除，孤儿无业务可达性、best-effort回收；不宣称磁盘占用永远有全局上界。若要求同步擦除、严格保留期、确定的全量GC/安全删除，需要新流程/存储能力，不能藏进stats旁路。 |

另有**实施/部署门禁而非方案选择**：U证据契约获批并落地、B共享文件释放、旧metadata writer静止条件、受控宿主实测、独立复核与切换授权。旧ac82状态不由本案推断；不得为了过cutover门自行联系它。

### 非局部影响与迁移/落地代价

- 新持久身份头使业务serializer、create/delete/load、六保存入口与测试fixture正确性耦合；不能只增加一个sidecar类就上线。scope跨service重建是两槽真实边界的必要成本，不是另做跨进程治理。
- 每个统计job比U再增加两次有限metadata资格探针；这是保持missing/identity检查且不进入业务写队列的成本。可观察性以stage/枚举原因/匿名attempt计数为限，不新增长期诊断日志、不记录聊天/来源路径/raw metadata。
- 固定sidecar可损坏并暂时丢统计；选择安全unknown而非复杂journal恢复，这是派生数据的合理边界，不降低业务metadata可靠性。checksum仅普通损坏检测，无秘密签名。
- 同R的挂起阻止后续同R统计，两个槽都挂起可让全部stats长期unknown；不以无界并发或假取消换取表面及时。
- scope单例、protected header和业务read stamp须专门审查。未知schema不静默重发身份；跨进程/手工恢复旧metadata可能回带旧R，不能宣传为已防外部回滚。

删除 UI 局部接线的代价只涉及既有 main/controller/Tab/manager/types 和镜像测试；不更改 D1–D4、provider native 策略或性能目标。busy skip 不冒充 UI reset；原 projection 前驱不 settle 时不提供 UI 完成期限。真实 T39–T47 若必须改 B/runtime 释放或增加业务删除等待，应阻断回主会话，不借本轮授权扩大架构。

### 交付物规范

#### 1. 新增目录树

本轮仅新建指定设计记录。后续source/test是方案规范；运行数据落**被插件打开的vault根**，不是源码仓库目录。

```text
/Users/vincentwang/Documents/NoteVault/tools/claudian/
├── docs/designs/
│   └── 2026-11-07-conversation-size-isolated-persistence-boundary.md  [本轮唯一产物]
├── src/core/bootstrap/ConversationSizeStore.ts                    [后续]
├── src/app/ConversationSizeJobCoordinator.ts                      [后续]
├── src/app/storage/ConversationPersistenceScope.ts                [后续]
├── tests/unit/core/bootstrap/ConversationSizeStore.test.ts        [后续]
├── tests/unit/app/ConversationSizeJobCoordinator.test.ts          [后续]
├── tests/unit/app/storage/ConversationPersistenceScope.test.ts    [后续]
└── tests/integration/features/chat/conversationSizePersistence.test.ts [后续]

/Users/vincentwang/Documents/NoteVault/.claudian/conversation-size/v1/ [运行时，后续]
├── durable/<recordToken>.json
└── volatile/<runtimeRecordToken>.json
```

#### 2. 命名与索引

- 文档前缀日期说明设计时间，conversation-size标识A领域，isolated-persistence-boundary标识U1-c的提交/排序重划；不带vN、不supersede旧记录。目标已存在则停止，不能覆盖。
- `durable/volatile` 表示恢复资格，不表示磁盘fsync等级。token只能由生命周期factory生成；文件名不含会话标题、provider来源或真实内容。
- source/test同名镜像；新scope模块表示同realm/vault作用域，不使用“global transaction”一类误导名称。
- 后续登记到 `/Users/vincentwang/Documents/NoteVault/tools/claudian/README.md` 的回归/架构索引并补运行存储布局。本轮不回填README，不另落报告、副本或`.context`产物。

#### 3. 产物与消费者

- 本设计绝对路径：`/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-07-conversation-size-isolated-persistence-boundary.md`；消费者为用户、主会话、后续实施者与独立架构复核。
- 三个新生产模块及四个新测试绝对路径、用途见方案第10节；消费者分别是SharedStorageService/main/SizeService和实施/验收回归。
- `/Users/vincentwang/Documents/NoteVault/.claudian/conversation-size/v1/durable/<recordToken>.json`：可验证候选，仅SizeStore/SizeService消费，不能被业务list消费。
- `/Users/vincentwang/Documents/NoteVault/.claudian/conversation-size/v1/volatile/<runtimeRecordToken>.json`：当前运行登记的候选，重启不发现、不恢复；不作备份权威。
- `/Users/vincentwang/Documents/NoteVault/.claudian/sessions/<conversationId>.meta.json`：既有业务产物新增受保护头，仍由SessionStorage消费/写；不是本轮改动。
- 测试临时目录为唯一新建的 `/tmp/claudian-size-persistence-<随机>/`；合成metadata/transcript/崩溃中间态只在其内，不作交付物、不落真实运行数据根。

#### 4. 归属与偏离

遵循 `/Users/vincentwang/Documents/NoteVault/tools/claudian/CLAUDE.md` 的provider-native-first、镜像tests和本地存储约定；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/CLAUDE.md` 的provider-neutral/storage边界；`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/CLAUDE.md` 的正常历史入口/同步交换边界。

明确偏离：本案新增业务存储布局及identity头，必须以本draft批准为前提；本轮仅设计，显式禁止build/业务操作优先于一般编辑后build规范。临时验证只用/tmp，不按一般`.context`临时脚本约定落业务仓库。README索引留待另获授权；不改CLAUDE/config/旧记录/status。

## 验证方式

**下列全部行为验证移交实施阶段，本轮未执行。** 本轮已做的只有只读基线核查。纸面成立不能替代真实FIFO/adapter/main/owner链测试。

### 1. 实测约束

- fixture用唯一/tmp根和合成provider transcript；metadata/storage指向内存或该临时根，强制禁止读取真实HOME会话、秘密、agent输出、真实vault运行文件。
- 被测SessionStorage、scope、coordinator、SizeStore codec、SizeService、main、provider证据与U实际onOpen/close使用生产实现；只能替换Obsidian宿主和物理IO故障边界，不mock被测FIFO、ACK、receipt、publish或main保存结果。
- 暂停操作用可控制deferred卡在真实IO调用边界；观测窗口内保持未settle，记录每项operation的start/complete、domain、binding、actual计数和业务Promise状态，断言后再释放以清理fixture。测试timeout不是生产取消语义。
- 真实磁盘兼容/恢复测试不只重建JS对象：保存合成文件中间态并用全新scope读取；受控子进程退出测试用于区分正常进程退出与阶段截断。它仍不能证明物理断电/fsync，应将这一项明确记为“不提供/未证”。
- 每个新要求先红再同命令绿；正常known、空文件0等旧绿格标为回归。禁止用一个mock固定written覆盖所有阶段，禁止“无第三次调用”代替actual未完成计数。
- T19至少制造一次真实fs.unlink失败（如/tmp映射的`.jsonl`路径实际为目录），实际穿过deleteSDKSession→Claude history service→main→SessionStorage并观测最终Promise/文件；metadata异常在真实adapter.remove/exists边界发生。mock provider reject只能补测传播契约，不能充当物理失败的实证。
- T31/32以真实controller/main/输入事件链驱动；只允许无网络标题runner/transport返回受控结果，不替换controller callback或main mutation。须明确记录迟到mutation尚未发storage ticket，防止只测旧ticket失效而漏前半链。
- T33实际暖起provider complete cache，正常业务保存开启mandatory gate后走普通stats全管线；写后stat必须真实调用。稳定组的旧绿终点如实标回归；新增final-stat/源变更先红，混比comparator或raw known直接落盘的定向变异须使该测试红，不能仅mock provider恒返snapshot证明比较正确。

- T39–T47 使用真实 `ClaudianView.onOpen → TabManager/createTab → Tab.ts/initializeTabControllers → main.deleteConversation → 专用 controller reset → 默认 ProjectionWriteCoordinator → Tab.ts 回调`，不能mock save/reset/cancel/FIFO/回调的被测行为或只以metadata已删判UI成功；spy只观察、仍调用生产方法。
- 同ID创建在provider/metadata真实边界pending时发请求，等B持久屏障结束后以生产open/reserve/restore绑定返回的新origin。必须观测新TabData/UI token/runtime/messages/input已安装；不得手填token/ID或只替换conversations数组，绕过旧focus/busy捷径后声称“实际重绑”。
- projection窗口用真实coordinator前驱grant/生产stored读的受控I/O占住；覆盖grant后task前、await返回后到嵌套onNewConversation、setter同步回调重入与finally。原FIFO仍实跑，不mock runStored为null/成功；不可达窗口记未覆盖，不新增测试专用生产入口。
- READY非streaming且有消息（含active subagent）的删除必须断言main真实Promise settle、旧tab blank/READY/welcome/空输入、metadata absent以及删除后的save调用/业务write增量0；不是只让obsolete写被拒。另测普通NewChat先真实save与provider/metadata/UI原异常对照，不等待stats。
- 同tab新origin必须实际穿过switchTo，同ID早退认incoming origin；只有原delete ticket已确认持久完成才免已删outgoing save，非删除/删除未确认/普通obsolete不得据此假成功。新binding完成时记录meta/UI/runtime/claim/guard基线，随后放旧清理，断言旧清理追加增量0；不拦incoming正常backfill/save/stream或误算其合法写。T40/U-D02同口径。

### 2. 入口 × 机制 TDD矩阵

载体缩写：S=SessionStorage既有unit；P=新SizeStore unit；Q=新coordinator/scope unit；A=SizeService unit；I=新Persistence integration；M=main integration；L=U的真实Lifecycle integration。下表每格都有可观察终点。

| 编号 | 真实入口 × 机制 | 受控输入/阶段 | 红绿终点 | 载体 |
| --- | --- | --- | --- | --- |
| T01 | 旧saveSizeSnapshot→后续同IDsave | 真实旧FIFO队首分别卡read/write/legacy-cleanup | 基线红：业务write未start；不得把它计为业务自身挂起 | S/I |
| T02 | 新ordinary/proof/replay→rename/update同ID | stats分别卡probe/read/stat/mkdir/write/final-probe/final-stat | 绿：业务真实write已start+complete，业务Promise成功；stats仍pending；meta无sidecar字段 | P/I/M |
| T03 | 迟到stats写→较新业务记录 | R1/F7统计晚完成，业务title A→B且F不变 | 业务内容及时间戳保持B，零stats meta-write；列表排序不因stats变化 | I/M |
| T04 | 历史保存→F及U世代 | S1新F8，rename排后；旧proof F7晚到 | 最终业务F8，不回退F7；旧candidate written后仍不能清门/positive | S/A/I |
| T05 | H3业务自身pending对照 | 无stats前驱，业务write/必要清理pending；另测真实hydrate pending | 业务仍未完成，不假成功；日志与T02可区分 | I/L |
| T06 | 六业务save入口→统一header/ACK | 启动回填、环境失效、create、rename、update、Controller历史save；直接storage也测 | 正确intent/stamp；统计字段始终剥离；缺ACK/skipped不被包装成成功 | S/M/I/L |
| T07 | normal load/get/switch/close→不等stats | X/Y占两槽，第三业务已写；真实main两个加载、closeTab/onClose | 正常业务返回；负态自动rAF；actual仍2、无drain | I/L |
| T08 | ordinary/proof/replay→typed ACK | 各skipped、无ACK、错attempt/R/F/digest、write原异常 | 均无positive/清门；本次write成功才written；错误不替代业务结果 | P/A/I |
| T09 | missing/identity探针→无业务写 | preferred/legacy都缺；preferred坏而legacy好；ID/R/F/provider不符 | 明确负结果；不回退坏preferred、不迁移/建meta，任何统计路径meta写次数0 | P/I |
| T10 | 写后final检查→来源和原对象 | 每个await间改source、F、saveEpoch、revision、owner/原对象 | 写前失效可skipped；写后可written但零publish/清门；不按ID重捕owner | A/I |
| T11 | normal complete→完整性 | U Claude缺anchor/旧分支、Codex损坏mixed、v1证书，另跑合法0/完整300轮 | 坏证据不known，合法known保持；checksum不能升级v1/partial | I + U provider矩阵 |
| T12 | 逻辑取消→真实两槽 | 两jobs各卡IO，多轮refresh/open/close/delete | actual<=2，retired仍占位；旧intents/DOM释放，队列不随调用次数增长 | Q/A/L |
| T13 | 同R lane→迟到顺序 | J1卡写后撤销，J2同R、J3不同R | J2不开始IO；J3仅有空槽才开始；释放J1后只启动当前有效J2 | Q/I |
| T14 | loadSettings/新service/热卸载再装→scope | 两旧实际IO未settle，重建3实例；旧client卸载 | 仍同actual=2和B队尾；无第三IO；旧callback不保留/访问旧app | Q/M/I |
| T15 | scope版本不兼容→fail-closed | 原actual>0，装配不同协议版本 | 不开新budget绕上限；stats unavailable；B不静默清队尾 | Q |
| T16 | delete→同IDrecreate | 旧stats卡write；native删除可完成，新建同ID | delete/create业务成功不等stats；R1≠R2；旧写最终只生成R1孤儿，新meta不变 | S/I/M |
| T17 | delete与旧业务save/read/migration | 旧ticket晚入队/晚返回；create请求在native删除pending时到达 | 旧ticket拒绝；create等待的是B删除屏障；旧delete不能删R2 | S/M/I |
| T18 | 正常load/list→旧batch防复活 | legacy读取中delete/recreate或save；两load batch倒序 | 无旧raw迁移、无旧对象重新安装；当前合法记录不被旧列表丢掉 | S/M/I |
| T19 | 真实物理删除错误→原provider/业务链 | Claude /tmp SDK路径真实unlink失败但原catch吞掉；另让metadata remove/legacy exists/remove抛错 | 前者provider resolve、metadata完成则业务可成功；后者真实传播reject并按持久事实置uncertain；禁止mock provider reject混充unlink失败 | S/M/I |
| T20 | volatile普通/proof→旧格式兼容 | 无header+旧inline known，真实normal完整读取 | 无stats触发meta-write，也可written/final→known；inline不直接信任 | A/I |
| T21 | volatile→durable自然迁移 | volatile写pending；rename/历史save安装R2；成功/失败分别跑 | 自然业务不等stats；新binding不接旧结果；历史gate不被纯迁移清除 | S/A/I |
| T22 | restart→持久读取合并 | durable v2有效/过期/错F/错source；volatile孤儿 | 只定位业务引用R；新written+final后才known；volatile不恢复；getter/list零sidecar IO | P/A/I/M |
| T23 | 跨域崩溃→业务F新/统计F旧 | 在业务write成功后、stat开始前退出 | 正常加载业务新值；统计unknown，不回滚业务、不借旧F | I |
| T24 | sidecar各崩溃切点→恢复 | 未写、半JSON、有效JSON错digest、完整写未ACK、ACK后未final、published后 | 损坏fail-closed；完整candidate只做新认证，不恢复旧published/ACK | P/I |
| T25 | metadata迁移各切点→恢复 | preferred写前/后、legacy清理前/后、未知/损坏header | preferred优先、无stats修meta；未知版本不降级volatile；业务异常不假成功 | S/I |
| T26 | 两次历史save交叠→planned/confirmed | S1成功S2失败、S1失败S2成功、两失败，穿插rename | 每次ACK对应本次；F不倒退；uncertain无伪证书；U saveEpoch失败不回退 | S/A/I |
| T27 | purge→业务delete及槽预算 | purge pending/reject；两槽满时连续create/delete | delete不等purge；purge算槽；无无限清理队列；遗留物不进业务list | Q/I |
| T28 | 旧版本读写→新版本再升级 | 合成无header/有header业务文件；旧serializer写/overlay写后重启新协议 | 业务可读；header丢失即volatile；旧inline不认证；无反灌sidecar | S/I |
| T29 | native能力不可用/越界输入 | vaultPath缺失、异常id/token、未知schema、损坏envelope | stats负态且零越界写；无共享overlay fallback；正常业务不被stats初始化阻塞 | P/M/I |
| T30 | 基案UI/来源退化回归 | 真onOpen/menu/tab绑定、OpenCode unsupported、closed菜单、final通知 | U原正负结果/单aria-label/禁止hydrate要求仍成立；统计读不改变B机制 | I/L + U矩阵 |
| T31 | 标题真实入口→main输入身份 | Input初次标题/Controller regenerateTitle的响应挂起，旧callback mutation尚无storage ticket；delete→同ID同title recreate后放行 | main先拒旧origin，新R title/status/providerState与业务write增量均不变；正常原owner、silent、手工标题优先另作回归 | I/L + U Controller/Input回归 |
| T32 | 两步手工rename与必要延迟调用者 | inline/tab输入、回填/save/resume/fork失败cleanup/环境批次，异步期间原登记退役 | 全链只用原origin，不在main晚捕；旧写/旧delete不能作用新R；不改变原业务行为 | M/I/L + U调用者回归 |
| T33 | 真实Claude cache→gate投影→写后stat | gate开、无proof；rawBefore/rawFinal同V及known count；另在write后改变来源 | 稳定组files known/history stale、gate不动、sidecar history stale；变更组拒发布；真实本次ACK/final stat不可省 | I/A + U provider矩阵 |
| T34 | 枚举完成后新ID→旧列表晚安装 | L1枚举仅A后create B，B从未在旧行中；另L2先完成 | B保留且按原排序；L1不得整表覆盖；L2之后L1全批不安装 | M/I |
| T35 | 旧Claude metadata缺省provider→资格探针 | preferred/legacy、无header/合法header各缺providerId；null默认及显式codex/非法值对照 | 和正常loader同默认claude，可走完整正向known；显式错provider仍拒；不因探针补字段或迁移 | P/M/I |
| T36 | 业务delete reject→恢复原记录→新ticket重试 | 在T19真实metadata失败后用正常loadSettings恢复原R；再次delete，再同IDcreate | D1始终reject；H1/O1退役，新H2/O2、D2≠D1；D2真完成后create新R；已等待失败create不自动覆盖旧记录 | S/M/I |
| T37 | delete reject→正常loadSettings→确认absent/不可判定 | 两业务路径缺失、枚举无该ID；另测损坏/不可读/身份冲突、旧IO仍pending | main真实重载对scope未决ID定点读；仅确认absent且旧IO全settle才解障，后续明确create可成功；否则uncertain，无旧票据复活/假成功 | S/M/I |
| T38 | 各provider原生策略→业务删除兼容 | Claude best-effort留文件；Codex/OpenCode真实原生保留；metadata删除可完成 | 业务按原Promise契约结束，不能新增native物理删除/扫描、不能因保留原生历史卡create | M/I |
| T39 / U-D01 | READY有消息原tab→正常delete→原UI reset | 真实onOpen/Tab.ts装配，非streaming，provider/metadata完成 | main真返回；原tab完整blank/READY/welcome/空输入，无新conversation；删除后save调用/业务write增量0，O/handle仍retired，无假written | L/M + Controller/Tab回归 |
| T40 / U-D02 | delete pending→同IDcreate→实际同/不同tab重绑 | provider/metadata边界pending时申请create；B持久完成后open/reserve/restore新O2，旧cleanup才运行；跨view | 新binding确已安装，非旧O1 focus；同tab旧cleanup skipped，不同tab仅原tab reset；新meta/stream/messages/input/runtime/claim不被取消/保存/清空，无额外create/stats等待 | L/M + TabManager回归 |
| T41 / U-D03 | reset等待真实projection→新binding→释放前驱 | Q9自有detach/null后新O2实际进入同tab | 旧grant/task/await后全拒；新restore/send正常，旧finally不清新guard，不empty新DOM/清输入/改READY/cleanup新runtime | L + Controller/Tab/TabManager回归 |
| T42 / U-D04 | grant/task/DOM/回调提交各窗口→重绑 | grant后task前、setter同步回调、runStored返回后/onNewConversation内部；同origin detach/rebind、同tabId新实例 | 所有旧余下提交拒绝，回调内部条件cleanup不置null新service；非仅入口token；未覆盖窗口明确未证 | L + Controller/Tab回归 |
| T43 / U-D05 | READY原subagent orphan/迟到取消→Tab.ts回调 | 非streaming active subagent，自有detach前后分别触发 | 原domain orphan可完成，stream/merge/save前短路，save/write增量0；正常新binding回调不被关闭，不按ID merge新O | L + Tab回归 |
| T44 / U-D06 | user/auto streaming delete与新stream绑定 | 原user/auto cancel；新O2同/不同tab streaming后旧cleanup/watchdog/晚finally | 只原binding cancel/bump/S2；auto/user实际lease释放分别观测，默认FIFO不dispose/绕过；新流/UI不变，旧origin零业务写；原前驱不settle不假称reset返回 | L + Input/Controller/Tab回归 |
| T45 / U-D07 | 普通NewChat/普通force→先保存 | READY有消息，真实业务write pending/resolve/reject；shell/no-message/busy对照 | pending不清绑定/消息；本次业务真成功后blank；原reject保留，obsolete/统计ACK不当written；原普通guards不变 | L + Controller/TabManager回归 |
| T46 / U-D08 | provider/metadata/UI错误→原Promise及uncertain | 原provider resolve含真实Claude unlink失败catch；真正provider/metadata/legacy reject；UI reset throw；两stats槽pending | resolve后才metadata/UI；真正持久reject不reset；UI throw外层reject但持久absent不翻案；skipped UI不是written，全链无stats await | I/L/M |
| T47 / U-D09 | 原busy/closed/换实例→旧reset与新reset | 原creating/switching忙、tabclosed/manager替换、同tab新operation | 不抢普通操作，不增加等待/补偿NewChat；skipped/busy/retired不称已blank；旧finally仅释放自己，正常新guard不变 | L + Controller/Tab/TabManager回归 |

T24的有效JSON错digest用于抓“只JSON.parse就信任”的漏洞；有效旧完整envelope若仍匹配当前R/F/V可重新认证，不要求拒绝所有旧文件。T14必须使用真实scope，不手工复用测试counter假装跨实例正确。T01是不可缺少的旧真实FIFO blocked对照。

### 3. 后续执行命令与证据要求

仅在实施获批且目标文件存在后执行；本轮不运行。不安装/更新依赖、不build/deploy/reload。

```bash
node /Users/vincentwang/Documents/NoteVault/tools/claudian/scripts/run-jest.js --selectProjects unit --runInBand --runTestsByPath \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/core/bootstrap/ConversationSizeStore.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/app/ConversationSizeJobCoordinator.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/app/storage/ConversationPersistenceScope.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/app/ConversationSizeService.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/storage/SessionStorage.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/storage/storage.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/providers/claude/storage/storageService.convenience.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/controllers/InputController.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/controllers/ConversationController.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/Tab.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/tabs/TabManager.test.ts

node /Users/vincentwang/Documents/NoteVault/tools/claudian/scripts/run-jest.js --selectProjects integration --runInBand --runTestsByPath \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/conversationSizePersistence.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/conversationSize.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/conversationSizeLifecycle.test.ts \
  /Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/main.test.ts

npm --prefix /Users/vincentwang/Documents/NoteVault/tools/claudian run typecheck
git -C /Users/vincentwang/Documents/NoteVault/tools/claudian diff --check
```

U的provider direct/真实worker/cache完整性矩阵仍须按U命令执行，不以本案存储测试代替。ESLint仅列实际获批改动source/test路径、不用--fix；新增文件另做diff检查。逐矩阵格保留红/绿命令、退出码、operation start/complete、actual读数、最终文件字段、未覆盖项；区分实测/既有读数/推算/纯示意，不只给测试总数。

### 4. 验收标准

同时满足以下条件才可提出“U1-c在明确边界内闭合”，仍不等于部署批准：

1. 任一stats阶段真实pending时，同ID后续业务write可实际开始和完成；业务自身pending时仍不能假成功。旧真实FIFO blocked对照存在。
2. 全部统计路径对业务metadata的write次数为0，业务serializer不含sizeSnapshot；stats不改业务时间与排序。不存在共享enqueue/drain/初始化屏障。
3. 实际统计pipeline最多2，单R实际pipeline最多1；取消、异常、同realm重建/卸载后仍成立；挂起槽不被偷归还。
4. positive/清门均可追到当前原owner+R/F+U世代/完整性+本次typed ACK+最终来源观察，不能拿persist存在性代替证据。
5. delete/recreate及迟到read/write/legacy迁移不复活/换绑；覆盖未发行storage ticket的旧调用、枚举后新ID、缺省provider；保持各provider原生删除/保留策略。真实业务reject后正常恢复、新delete ticket重试与确认absent后的create均可依法推进，uncertain不自锁、不冒进；业务删除与sidecar擦除分开。
6. 恢复只从业务权威记录出发；损坏/旧schema/错误F/source/volatile不假认证；完整但未发布的候选也须新提交，绝不追认旧保存完成。
7. volatile旧格式兼容和自然业务迁移可走真实正向known；不因迁移新增stats占业务队首。双版本兼容经过受控文件测试。
8. T39–T47/U-D01–D09 通过真实删除/Tab/controller/FIFO/回调链：原 READY 有消息 tab 删除真返回并完整免保存复位；同 ID 实际重绑及各 await/回调窗口不取消、保存、清新业务/UI，旧 finally 不清新 guard；普通 New Chat 仍先真实保存，provider/metadata/UI 原异常、uncertain及不等待stats不变。busy/retired skip与真实reset区分，原 UI 前驱永久pending不冒称完成。
9. U原证据、owner、UI与正常加载兼容矩阵无回退，B冻结无越界；D1–D4已明确裁决。OS/跨进程/fsync/同步擦除等未提供项不得包装成PASS。

**本次订正状态：两份既有 draft 的删除后免保存 UI 复位、原 binding/自有 reset guard、实际准入/await/回调及 T39–T47/U-D01–D09 已同步补齐；源码调用链核对完成，以上行为未实测。既有 A–D、持久化/provider/性能取舍不变，具体方案及实施/迁移/部署未批准；frontmatter/status 不变，无新产物。初稿冻结哈希仅为历史读数，不作为本次重测。**

## 关联

- [[tools/claudian/docs/designs/2026-11-07-conversation-size-contract-consolidation-restart]]
- [[tools/claudian/docs/designs/2026-11-06-conversation-size-persistence-ack-resume]]
- [[tools/claudian/docs/designs/2026-11-06-codex-ready-unblock]]
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task-1-review-r0.md`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task1-ready-r0-review-package.md`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/.context/sdd/ethereal-dancing-emerson/task1-ready-r0-snapshot/manifest.json`
