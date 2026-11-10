---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian
tags:
  - architect
  - claudian
  - persistence
  - lifecycle
  - p6
---

# Claudian P6 保存接收核心与生产接线边界

## 背景与问题

补齐已批准 R/P6 中“保存 A 不读 runtime B”的绑定、接收与回执合同，先交付可独立测试的内部核心，再接真实 binding 与 metadata writer；快速只约束实施节奏，不降低 M3 的最终架构。

> [!warning] 内部核心，不是生产修复
> P6-0 不接 `ConversationController.save()`，不启动 runtime，不改变 Tab/Manager/Reader/Observer，不声明 A/B 错绑已修复，不允许部署半套协议。本记录是独立细化，不修改、覆盖、替代或变更任何既有设计记录状态。新记录的 draft 不撤回既有批准范围；新增政策、Git、部署仍不在本次范围。

### 证据与限制

证据等级：〔既有读数〕为已读源码、冻结测试日志或既有记录；〔推算〕为源码语义推导；〔纯示意〕为设计案例。本次仅核查、设计和新建本记录，未重跑行为测试。

- 冻结输入：`/private/tmp/claudian-takeover-ab-26043231/work/`。
- `/private/tmp/claudian-takeover-ab-26043231/out-B-int-ab.log`：A/B 组 6 通过、1 失败；同 provider A→B，关闭后 A 的 session/thread 实际被写成 B。〔既有读数〕
- `/private/tmp/claudian-takeover-ab-26043231/work/tests/integration/features/chat/markdownRenderDiagnostics.test.ts:1646–1740`：真实 Plugin/View/Manager/Controller 与临时 metadata，runtime session 行为可控；实机可达性仍未证实。
- 同快照 Controller `:1338–1424`：save 目标取 currentConversationId，session delta 取动态 runtime，成功后无条件清 dirty；main `:945–955` 的 missing update 返回 void。
- 同快照 Tab `:1419–1445`：incoming runtime 先重绑，UI/backing/claim 尚未完整提交。Claude `syncConversationState→setSessionId` 还会触发 recovery listener、query retirement 和 Observer restart，不能把它当纯准备函数。
- 冻结源码尚无 `CommittedTabBinding`、`CommitReceipt`、`SaveAdmission` 或业务版本 owner。现有显示/预留 claim 与 accepted Promise 集合可复用，但它们不是完整保存资格或 written ACK。

工作中 L1 修改 Tab/Manager cleanup，T1 修改 Reader/Observer。本稿不要求工作区静止，依据上述冻结输入设计，不读取其变化作为已验收前提。

## 方案设计

### 1. 解层次与推荐边界

| 候选 | 结果 |
|---|---|
| save 末端比较 ID/session/READY，错配则跳过 | 不选。无法证明原 binding，ABA 和同对象复用仍失败，且会丢合法 outgoing/incoming 保存 |
| 整个 R2/S/H 完成后才开始 P6 | 不选为首切。布局与 tail 字节身份不是保存接收核心的默认前置 |
| **P6-0 内部核心→R-binding→S-metadata→P6 生产接线→M3 完整验收** | 推荐。核心先独立实现，生产协议不拆半上线 |

正向复用：

1. `ConversationOpenRegistry.owns` 是实际纯同步 claim 校验，可用于预检，不另建显示 claim registry。
2. `ProjectionWriteCoordinator` 继续拥有短 backing/projection 提交；不另建 actor，不让磁盘写或 runtime 调用占 grant。
3. `SessionStorage` 已有同实例目标 FIFO 与同步序列化形状，后续 S 将其接入真实接收/写序；P6-0 不复制一条私有生产 writer lane。
4. `buildSessionUpdates` 的 Claude previous/fork、Codex pending/established fork 与 OpenCode 规则继续复用，改成捕获事实后对最新 base 的 provider-owned 归约。
5. 原 accepted-save 账仍用于关闭 drain，但接收后不得重新查当前 manager/claim/runtime 撤资格。

### 2. P6-0 精确范围与写集合

首切只做**已有 record 的内部保存资格、不可变增量接收、关闭 drain 与 ACK**。不做 lazy create、实际历史读取、UI backing 交换、provider capture 实现或实际磁盘接线。

这是内部开发边界，不是生产删减：替换生产 `save()` 前必须完成既有 draft/create 路径；不得把下文 `unbound` 拒绝接到真实非空 draft 后称已兼容。

| 绝对路径 | 首切改动 |
|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationHistoryCoordinator.ts` | 新增核心实现；不 import 具体 provider、Tab/Manager 或 DOM 实现 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/providers/types.ts` | 新增中立保存 DTO、token、record/版本及唯一 MetadataSavePort 契约 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/types.ts` | type-only re-export `CapturedSessionPersistence`；不在两文件重复定义 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/state/types.ts` | 新增 binding/attempt/adoption/close 记录契约；不修改现有 ChatStateData 行为 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/app/ConversationHistoryCoordinator.test.ts` | 新增可观察核心 unit；fixture/helper 内联本文件，不增测试专用生产入口 |

不修改 main、Controller、ChatState 实现、ChatRuntime interface/实现、SessionStorage、README、既有设计、共享集成测试及 L1/T1 文件。中立类型只增加，不改变既有 `AppSessionStorage.saveMetadata(): Promise<void>`、`SessionUpdateResult` 或 `ChatRuntime` 的必需方法，因此现有生产代码仍可编译。

### 3. 精确 TS 契约

以下是实现规格，不是已存在代码。新增类型必须唯一归属、type-only 引用；核心无具体 provider 执行依赖。

#### 3.1 中立类型：core/providers/types.ts

```ts
declare const persistenceTokenBrand: unique symbol;

export type PersistenceToken<K extends string> = Readonly<{
  [persistenceTokenBrand]: K;
}>;

export type RecordToken = PersistenceToken<'record'>;
export type OwnerToken = PersistenceToken<'owner'>;
export type BindingToken = PersistenceToken<'binding'>;
export type AttemptToken = PersistenceToken<'attempt'>;
export type RuntimeAdoptionToken = PersistenceToken<'runtime-adoption'>;
export type SaveToken = PersistenceToken<'save'>;
export type CloseToken = PersistenceToken<'close'>;

export interface RecordHandle {
  readonly id: string;
  readonly providerId: ProviderId;
  readonly token: RecordToken;
}

export interface RecordVersions {
  readonly binding: number;
  readonly materialization: number;
  readonly turn: number;
}

export type JsonValue =
  | null | boolean | number | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

export type FieldPatch<T> =
  | { readonly op: 'keep' }
  | { readonly op: 'set'; readonly value: T }
  | { readonly op: 'delete' };

export type PersistableMetadataKey =
  | 'hasHistory' | 'messageCount' | 'preview' | 'firstUserExcerpt'
  | 'currentNote' | 'externalContextPaths' | 'enabledMcpServers'
  | 'usage' | 'resumeAtMessageId' | 'lastResponseAt';

export type MetadataPatch = Readonly<Partial<{
  [K in PersistableMetadataKey]:
    FieldPatch<Exclude<SessionMetadata[K], undefined>>;
}>>;

export interface SessionBindingPatch {
  readonly sessionId: FieldPatch<string | null>;
  readonly providerFields: Readonly<Record<string, FieldPatch<JsonValue>>>;
}

export interface CapturedSessionPersistence {
  readonly protocolVersion: 1;
  readonly providerId: ProviderId;
  readonly facts: JsonObject;
  readonly invalidation: {
    readonly revision: number;
    readonly invalidated: boolean;
  };
}

export type SessionSaveInput =
  | { readonly kind: 'seed'; readonly patch: SessionBindingPatch }
  | { readonly kind: 'runtime'; readonly capture: CapturedSessionPersistence };

export interface SaveIntent {
  readonly token: SaveToken;
  readonly record: RecordHandle;
  readonly expectedRecordVersions: RecordVersions;
  readonly owner: OwnerToken;
  readonly binding: BindingToken | null;
  readonly dirtyRevision: number | null;
  readonly reason: 'normal' | 'outgoing' | 'final' | 'backfill';
  readonly metadata: MetadataPatch;
  readonly session: SessionSaveInput;
}

export interface SaveTicket {
  readonly token: SaveToken;
  readonly record: RecordHandle;
  readonly owner: OwnerToken;
  readonly binding: BindingToken | null;
  readonly dirtyRevision: number | null;
  readonly reason: SaveIntent['reason'];
  readonly sequence: number;
}

export type SaveFailureStage =
  | 'admission' | 'record-validation' | 'reduce' | 'serialize'
  | 'write' | 'legacy-cleanup' | 'recovery-read' | 'unknown';

export type SaveReceipt = { readonly ticket: SaveTicket } & (
  | { readonly status: 'written'; readonly confirmedRevision: number }
  | { readonly status: 'skipped'; readonly reason: 'missing' | 'deleted' }
  | { readonly status: 'conflict'; readonly reason:
      'record-replaced' | 'binding-version' | 'materialization-version' }
  | { readonly status: 'failed'; readonly stage: SaveFailureStage;
      readonly error: unknown }
);

export type SaveRejectionReason =
  | 'unknown-token' | 'owner-retiring' | 'record-retired' | 'stale-record'
  | 'stale-attempt' | 'stale-binding' | 'binding-sealed' | 'unbound'
  | 'version-mismatch' | 'reservation-lost' | 'provider-mismatch'
  | 'invalid-snapshot' | 'runtime-capture-failed'
  | 'storage-rejected' | 'storage-admission-failed';

export type CaptureAcknowledgement =
  | { readonly status: 'not-needed' }
  | { readonly status: 'acknowledged' }
  | { readonly status: 'failed'; readonly error: unknown };

export type SaveAdmission =
  | { readonly status: 'rejected'; readonly reason: SaveRejectionReason;
      readonly error?: unknown }
  | { readonly status: 'accepted'; readonly ticket: SaveTicket;
      readonly durability: Promise<SaveReceipt>;
      readonly captureAcknowledgement: CaptureAcknowledgement };

export type MetadataWriteResult =
  | { readonly status: 'written'; readonly confirmedRevision: number }
  | { readonly status: 'skipped'; readonly reason: 'missing' | 'deleted' }
  | { readonly status: 'conflict'; readonly reason:
      'record-replaced' | 'binding-version' | 'materialization-version' }
  | { readonly status: 'failed'; readonly stage: SaveFailureStage;
      readonly error: unknown };

export type MetadataAdmission =
  | { readonly status: 'rejected'; readonly reason: string }
  | { readonly status: 'accepted'; readonly sequence: number;
      readonly completion: Promise<MetadataWriteResult> };

export interface MetadataSavePort {
  admit(intent: SaveIntent): MetadataAdmission;
}
```

字段语义：

- token 为核心分配的 frozen 对象，以 Map/WeakMap membership 校验；品牌仅防误用，不代替运行时身份核查。不得生成基于 ID/session/统计 generation 的 token。
- RecordHandle 仅含最小身份，实际 Conversation 对象只用于核心私有 WeakMap 注册；SaveIntent 不持有活 Conversation/消息图。
- counter 是非负安全整数，从 0 单调增加，回到相同 source 值也不回退；溢出返回 version-mismatch 并保留原状态，不偷偷重置。
- MetadataPatch 未提供字段或显式 keep 均保留；undefined 不是 delete。完整空上下文由有权 capture 显式 delete，`resumeAtMessageId: undefined` 的旧 SaveOptions 由后续 adapter 明确转换为 delete。
- 首切不允许 MetadataPatch 改 id/providerId/title/createdAt/messages/providerState；标题、create、共享 messages 与来源变更沿 R/S 的各自意图路径，不混入 shell 保存。
- SessionBindingPatch 的 providerFields 为 provider 明确的顶层字段增量，不能提供“替换整个 providerState”操作。复杂 fork/session 归约仍由 provider 按最新 base 执行，核心不 deepMerge。
- runtime facts 只含 provider 原生 session/路径/失效事实，不含整份旧 providerState、task/attention 图。自然 session 变化不因字符串不等被判错。
- `sequence` 来自目标 writer 接收时的实际序列，不由 P6 根据回调完成顺序猜。其语义是目标内接受顺序，不是跨目标全局时钟。
- first slice 的 sink 是测试 I/O 边界；生产 MetadataSavePort 的实现明确归属 S，不存在“Promise<void> fulfilled→written”的默认 adapter。

#### 3.2 binding 类型：features/chat/state/types.ts

```ts
export interface PersistableBindingState {
  readonly metadata: MetadataPatch;
  readonly sessionSeed: SessionBindingPatch;
}

export interface ReservationWitness {
  readonly claim: object;
  readonly owns: () => boolean;
}

export interface BindingAttempt {
  readonly token: AttemptToken;
  readonly owner: OwnerToken;
  readonly record: RecordHandle;
  readonly expectedRecordVersions: RecordVersions;
  readonly outgoing: BindingToken | null;
}

export interface CommittedTabBinding {
  readonly token: BindingToken;
  readonly owner: OwnerToken;
  readonly record: RecordHandle;
  readonly recordVersions: RecordVersions;
  readonly dirtyRevision: number;
  readonly state: PersistableBindingState;
}

export interface CommitReceipt {
  readonly token: BindingToken;
  readonly attempt: AttemptToken;
  readonly owner: OwnerToken;
  readonly record: RecordHandle;
  readonly recordVersions: RecordVersions;
}

export interface RuntimePersistencePort {
  readonly identity: object;
  readonly providerId: ProviderId;
  captureSessionPersistence(): CapturedSessionPersistence;
  acknowledgeSessionPersistenceCapture(capture: CapturedSessionPersistence): void;
}

export interface RuntimeAdoptionReceipt {
  readonly token: RuntimeAdoptionToken;
  readonly owner: OwnerToken;
  readonly binding: BindingToken;
}

export type CoreRejectReason = SaveRejectionReason | 'outgoing-not-written';

export type CoreResult<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: CoreRejectReason;
      readonly error?: unknown };

export interface CloseSavePlan {
  readonly token: CloseToken;
  readonly owner: OwnerToken;
  readonly acceptedAtSeal: readonly SaveTicket[];
  readonly finalAdmissions: readonly SaveAdmission[];
  readonly completion: Promise<readonly SaveReceipt[]>;
}

export type SaveReceiptState =
  | { readonly status: 'pending' }
  | { readonly status: 'settled'; readonly receipt: SaveReceipt };

export interface BindingPersistenceStatus {
  readonly dirtyRevision: number;
  readonly confirmedDirtyRevision: number;
  readonly dirty: boolean;
}
```

`ReservationWitness.owns` 后续直接适配 `ConversationOpenRegistry.owns(originalClaim)`，必须纯同步、不通知、不 I/O；测试用真实 registry。不把这个函数当 runtime/source/保存 owner。

`PersistableBindingState` 是保存所需字段，不冒称完整 ChatStateData。后续 R-binding 必须从完整 PreparedHistory/backing 的同一个提交产生它与 CommitReceipt，不能由通知后读取 current state 重建。P6-0 内部 binding slot 尚未成为生产 UI backing，这是明确的未接线事实；生产集成必须消除两套可独立变更的 backing 真相。

#### 3.3 核心公开方法：ConversationHistoryCoordinator.ts

```ts
export class ConversationHistoryCoordinator {
  constructor(deps: { metadata: MetadataSavePort });

  registerRecord(record: Conversation): CoreResult<RecordHandle>;
  retireRecord(record: RecordHandle): CoreResult<void>;
  registerOwner(managerIdentity: object, tabIdentity: object): CoreResult<OwnerToken>;

  readRecordVersions(record: RecordHandle): CoreResult<RecordVersions>;
  advanceRecordVersions(input: {
    record: RecordHandle;
    expected: RecordVersions;
    changed: readonly ('binding' | 'materialization' | 'turn')[];
  }): CoreResult<RecordVersions>;

  beginBindingAttempt(input: {
    owner: OwnerToken;
    record: RecordHandle;
    expectedRecordVersions: RecordVersions;
    reservation: ReservationWitness;
  }): CoreResult<BindingAttempt>;
  cancelBindingAttempt(attempt: BindingAttempt): CoreResult<void>;

  commitPreparedBinding(input: {
    attempt: BindingAttempt;
    state: PersistableBindingState;
  }): CoreResult<CommitReceipt>;
  readBinding(binding: CommitReceipt): CoreResult<CommittedTabBinding>;

  updatePersistableBinding(input: {
    binding: CommitReceipt;
    expectedDirtyRevision: number;
    state: PersistableBindingState;
  }): CoreResult<CommittedTabBinding>;
  readPersistenceStatus(binding: CommitReceipt): CoreResult<BindingPersistenceStatus>;

  beginRuntimeAdoption(input: {
    binding: CommitReceipt;
    runtime: RuntimePersistencePort;
  }): CoreResult<RuntimeAdoptionReceipt>;
  completeRuntimeAdoption(adoption: RuntimeAdoptionReceipt): CoreResult<void>;
  failRuntimeAdoption(adoption: RuntimeAdoptionReceipt, error: unknown): CoreResult<void>;

  admitSave(input: { binding: CommitReceipt }): SaveAdmission;
  sealOutgoing(binding: CommitReceipt): SaveAdmission;
  admitRecordDelta(input: {
    attempt: BindingAttempt;
    metadata: MetadataPatch;
  }): SaveAdmission;

  sealForClose(owner: OwnerToken): CoreResult<CloseSavePlan>;
  snapshotAcceptedSaves(owner: OwnerToken): readonly {
    readonly ticket: SaveTicket;
    readonly durability: Promise<SaveReceipt>;
  }[];
  getSaveReceipt(ticket: SaveTicket): CoreResult<SaveReceiptState>;
}
```

这是一份声明规格，实施者按签名实现方法体；不在代码中落 ambient 空类/抛 not-implemented 的替身。参数验证后的业务拒绝用 CoreResult/SaveAdmission 表达，异步写失败保留原错误 identity，禁止统一吞成成功。

首切无公共 `applyWritten`：ACK 只能由核心订阅实际 port completion 后应用，防止调用方伪造 written 清 dirty。核心无公开 `isReady(id)` 或 `saveCurrent()` 兜底。

### 4. 内部状态与转移

#### 4.1 状态最小集合

| 对象 | 私有状态 |
|---|---|
| record | 原对象/incarnation、active/retired、RecordVersions；同 ID 新对象需原 handle 先显式 retire |
| owner | 原 manager/tab pair、open/retiring、当前 binding、当前 attempt、唯一 close plan |
| attempt | active/cancelled/committed；原 claim、expected record versions、原 outgoing token |
| binding | current / sealed-outgoing / superseded；不可变 PersistableBindingState、dirty/confirmedDirty revision、当前 adoption token、outgoing ticket |
| adoption | adopting/adopted/failed/superseded；原 runtime identity/纯 capture port、原 binding token、错误 |
| save | admitting / accepted / rejected / settled；原 immutable intent、ticket、durability、settled receipt |

- 同一 record 对象重复 register 返回同 handle，不重置版本；同 ID 新对象且旧 active 返回 stale-record。
- 同一 manager/tab pair 重复 register 返回同 owner，不开启已 retiring owner；同字符串 tab ID 的新对象形成新 owner。
- begin 新 attempt 撤旧 attempt 的未来提交资格，不撤已接受 record delta；outgoing 字段捕获原 binding，不能返回后补。
- `advanceRecordVersions` 只按 changed 的去重集合各增 1；空集合不增。首切实现真实本地 counter，不声称生产写点已经接入。
- 首个 commit 可无 outgoing；否则新 commit 必须同时满足：原 outgoing 仍 current、sealed-outgoing、其 outgoing ticket 已 written。skipped/failed/conflict/pending 均返回 outgoing-not-written，不允许重绑。
- `commitPreparedBinding` 先做全部可失败校验和快照构造，再同步交换核心 binding slot，dirtyRevision=0、confirmedDirtyRevision=0，并生成新的 CommitReceipt。不得在槽交换后调用 owns、runtime、sink、通知或其它可重入函数。
- `cancelBindingAttempt` 只取消原 active attempt；若其原 outgoing 仍当前 sealed 且未提交新 binding，可解除该 outgoing shell fence。已接受保存继续完成。不能复活退休 owner 或旧 runtime adoption。
- `updatePersistableBinding` 必须原 binding 仍 current、owner open、expectedDirtyRevision 相等；构造 detached state 后复验，再一次交换 state 和 dirtyRevision+1。每次明确业务修改增 1，即使调用前 dirty 已 true；不靠布尔边沿。
- 给已封 outgoing 的 shell 新增可变投影返回 binding-sealed。合法独立 record delta 不以 tab 非活动为拒绝依据；生产必须将其从壳 save 分离，不能在半接线下启这个 fence。

#### 4.2 runtime adoption

1. `beginRuntimeAdoption` 只登记 adopting，不调用 sync/启动/cleanup；核 provider、owner、当前 binding。
2. 每次调用生成新 adoption token，同 runtime 对象复用也如此；旧 adoption 成 superseded。
3. 生产 integrator 后续在登记后、grant 外调用实际 runtime sync，再以原 adoption receipt 调 complete/fail。
4. adopting/failed/无 adoption 时的有权 save 使用该 binding 的 sessionSeed，不读 port。
5. 只有当前 binding 的 adopted token 可以调用对应纯 capture port。调用前后均核 owner/binding/adoption/dirty/record versions；capture 重入切换或 close 时拒绝本次未接受 save。
6. 旧 complete/fail 只返回 stale-binding，不回收 runtime，不修改新 adoption 或 backing。资源回收属于 L1/L2，核心不借此调用 cleanup。
7. sync 改 runtime 却绕过 begin/complete 是生产协议旁路，核心不可能通过同对象比较发现；此入口未迁移时 P6 生产 No-Go，不能用比较 session 字符串补洞。

#### 4.3 admission 的执行顺序

`admitSave` 是同步方法，不在资格形成过程中 await：

1. 核 token membership、原 record active、owner open、binding current/未 sealed。
2. 为这次同步 admission 注册私有 `admitting` settlement；不把它当 accepted。它只覆盖同步 capture/接收窗口，不覆盖历史读取或任意异步任务。
3. 读取该 binding 的不可变 state、dirty revision 与 record versions；若 adopted，调用其原 port 的纯 capture；否则取原 seed。
4. 对所有本次 delta/capture 做 detached JSON-compatible 复制与冻结；校验 provider 和 revision、字段 mask；最后再次复验步骤 1 和捕获版本。
5. 构造 immutable SaveIntent，调用 MetadataSavePort.admit。只有 port 已归一化并立即进入目标 FIFO 后才可返回 accepted；不 await 统计、诊断、runtime/source 恢复。
6. 核心登记真实 accepted ticket 与 durability，settle admitting latch。owner/claim 后来退休不撤 accepted；不在写回时重新查当前 tab/claim。
7. runtime capture 在 accepted 后调用其原 port 的 acknowledgement。只清该 invalidation revision，不等磁盘 ACK。ack 抛错时 accepted 与 durability 不变，返回 captureAcknowledgement.failed(error)，原捕获留在 intent 中；不得抛错让调用者误认“没入队”。
8. 订阅 completion，生成 SaveReceipt；非 written 不清 dirty。失败记录 stage/error，再让 durability 以同一个 error 对象 reject。

port 契约不允许“已入队后同步抛错但不给 ticket”。其同步抛错只允许入队前；核心将其转为 storage-admission-failed。若实际 adapter 违反该契约，结果是 accepted 状态未知，属于 S 的 No-Go，不能假称拒绝即可撤销已经发生的写。

快照验证不得执行 getter/toJSON 来“自动修复”：只接受纯数据 own properties、plain JSON object/array、有限 number；set(undefined)、BigInt、函数、accessor、cycle、非数据类实例均 invalid-snapshot。验证、复制或 Proxy trap 抛错保留原 error；若 trap 重入改变资格，最后复验拒绝。复制仅本次小 metadata/session 增量，不复制 transcript/完整 messages。字符串长度、文件体积或 Reader budget 不当保存身份。

`sealOutgoing` 使用相同 admission 管道但 reason=outgoing；在纯准备/校验完成后的接收窗口封原 shell，记录唯一 outgoing ticket。重复调用同 sealed binding 返回同 accepted ticket/durability，不再 capture 或入队。拒绝入队则不留下成功 fence；失败写保留 sealed 状态，需原 attempt 的明确取消/恢复，不把 failed 当可重绑信号。

`admitRecordDelta` 固定原 attempt.record、expected versions、owner与 claim，reason=backfill、binding/dirtyRevision=null；只能写 MetadataPatch 的白名单，不接受 runtime/session 输入。不要求 incoming UI commit，但在读取结果返回、尚未 accepted 时仍须 owner open、attempt active、原版本/claim 有效。接受后 attempt cancel/owner close 不撤原增量。后续更广 task delta不复用此 backfill API假装其内容归属已证。

#### 4.4 ACK、异常与 dirty

- port `written` 对应该调用 adapter.write 和必要 legacy cleanup 成功，不是 fsync、crash durable 或跨 client exit。
- failed completion 生成可查询的 failed receipt，durability 仍以原 error reject；若 port completion 意外 raw reject，stage=unknown，保持该 rejection identity。
- skipped/conflict resolve 明确结果，不清 dirty。核心不自行重试、自动创建 record或改写另一目标。
- written 只在 receipt.binding 仍是该 owner 当前 token、该 binding dirtyRevision 等于 ticket.dirtyRevision 时推进 confirmedDirtyRevision。旧 ACK7 对 dirty8清除=0；A→B→A b3 不接受 b1 的 ACK。
- record delta 的 binding=null，不清任何壳 dirty；只提供原 record 写结果。
- writer 的 confirmedRevision 与 dirtyRevision 是不同轴，不互相复制。
- 不定义“timeout=写失败/取消”。上层 timeout 后原 durability 继续；其 finally 不得对当前 ChatState 赋 dirty。新业务修改才推进 dirty revision，失败/超时只保留原 ticket 的未确认状态。
- receipt/query 结果 frozen；SnapshotAcceptedSaves 仅返回仍在途的 accepted，不包含长 read 或已 rejected admission。settled payload/port引用可释放，最小结果按 token WeakMap 保留，避免跨会话累积整包数据。

#### 4.5 close

`sealForClose(owner)` 同步完成：

1. 校验原 owner；已存在 plan 则原样返回。
2. 建立并缓存 CloseToken/plan 的 deferred 结果；owner→retiring，撤全部未提交 attempt 的未来准入。
3. 固定 acceptedAtSeal 与已有 admitting settlements。后者只是正在同步接收的窄窗口；不能将“read已开始”登记进去。
4. 若当前 binding 为 current，以 private close grant 对其 state/有效 adoption 做一次 final capture/admission。这个 grant 只允许本次 final，不能供外部在 close 后调用 admitSave。
5. 若当前 binding 为 sealed-outgoing，复用其原 outgoing ticket，不再读取可能已换绑的 runtime；正常 background 独立 accepted delta仍单独 drain。
6. 缓存 finalAdmissions。重复/重入 seal不重复 capture，正常准入在 retiring 后统一拒绝。
7. completion 使用 allSettled 等完固定集合和 admitting settlements；汇总 readonly SaveReceipt[]，failed保留 stage/error，不短路其余写。该 completion 自身 resolve 汇总；后续 L1/Manager 依据 failed条目报告原错误并继续全部 cleanup，不把它当“全部 written”。

若 capture 或 sink 内同步重入 close，admitting latch确保 close不会漏掉“已入队而 accepted登记尚未返回”的保存。capture阶段被 close撤资格、尚未入队则settle为null；sink已实际accepted则必须追踪其原durability。plan completion不等待任何未来历史读，不能借此发展无限drain。

### 5. 首切可观察单测

新测试文件：`/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/app/ConversationHistoryCoordinator.test.ts`。

测试从 registerRecord/registerOwner/begin/commit 公开入口构造 token，使用真实 ConversationOpenRegistry，不手工 cast“有效 receipt”；允许单独一例 forged-token核拒绝。核心方法、guard、capture选择、ACK/drain不得mock。metadata端为独立可控 I/O adapter：同步记录immutable intent、按目标FIFO推进可控 completion，不宣称它已实现生产S。

| 编号/锚值〔纯示意〕 | 操作与可观察断言 |
|---|---|
| C01 原对象身份 | 同record对象重复register同token；同ID新对象在旧active时stale-record；retire后新token；旧handle准入0 |
| C02 同ID新owner | 原manager/tab pair重复同token；新对象但同tab id产生新token；旧close不关新owner |
| C03 资格首次固定 | attempt捕v0，advance materialization到v1，再commit拒绝；state/当前binding未换 |
| C04 ABA | binding/source实际改变两次推进v0→v1→v2，值回A；旧expected-v0仍拒绝，不按ID/session相等复活 |
| C05 原A outgoing | A/b1 adopted RA1；sealOutgoing入1笔A immutable意图；pending时B commit outgoing-not-written；written后才commit B |
| C06 runtime同对象复用 | R在b1→b2产生新adoption token；b2 adopting save使用B seed，capture调用0；adopted后使用R的b2捕获；旧b1新save拒绝，但既有A意图仍A |
| C07 反向/旧complete | B→A/b3同R；b1/b2 complete/fail迟到对b3adoption/state改动0；cleanup调用0 |
| C08 合法incoming backfill | B attempt precommit接受delta；随后cancel/close；端上仍B、write完成；不清A/B壳dirty |
| C09 伪READY无效 | 未commit B仅有claim，不能从claim得到CommitReceipt；不会形成B壳save；C08控制仍能接受 |
| C10 dirty7/8 | update使revision7；save7 pending；update revision8；ACK7 written可查，dirty8仍true；save8 written后false |
| C11 深隔离 | admission后修改caller nested usage/context/facts；端上已冻结intent不变，嵌套对象identity不同；messages图不进入intent |
| C12 捕获拒绝与失效 | getter/toJSON从不调用；cycle/BigInt/accessor拒绝；sink入队0；invalidation ack0；dirty不清 |
| C13 capture重入 | capture中begin新attempt/close并完成新binding条件；本次post-check拒绝未入队；旧capture不消费新flag |
| C14 ack抛错 | 已accepted ticket仍1，durability不变；captureAcknowledgement.failed携同error；write可written；不会伪装rejected |
| C15 原写失败 | 写failure对象E，durability拒绝严格等于E；getSaveReceipt=failed(write,E)；dirty保留 |
| C16 legacy失败 | adapter.write完成但legacy cleanup E；非written，stage=legacy-cleanup；新目标写不被短路 |
| C17 skipped/conflict | missing/deleted或原record/source版本冲突有明确结果；不清dirty、不改目标、不create |
| C18 并发/重入close | save A/B两个已accepted，其中一个失败另一个pending；plan未完成且不提前宣称written；重复seal同plan、final最多1；另一owner正常admit |
| C19 admission窄窗口 | sink记录入队后同步reenter seal，再返回accepted；close须等该原durability；capture前close而未入队时latch=null，不挂住 |
| C20 快照刷新 | sealOutgoing后修改该壳返回binding-sealed；cancel原attempt且仍原current可解除fence；原accepted不取消 |
| C21 版本与异常 | 非安全counter/provider不匹配/未知token拒绝不改变槽；序列化前throw不入队；raw port completion rejection记unknown并保持identity |
| C22 统计/诊断不存在依赖 | core deps无stat/logger；把外部统计Promise永久pending，不影响port写推进及core ACK |

测试须分别断言 intent.target(handle.id/token)、provider seed/capture、字段值、实际接收次数、durability/dirty、plan结果与没有新owner副作用。只断调用计数不足以关门。C19验证短同步admitting，不扩充为任意异步save reservation。

自然退出必须成立，不使用forceExit或timeout让失败flight“结束”。首切没有磁盘/真实SDK/CLI证明，测试名不得叫production-fixed/e2e。

### 6. 精确落地顺序与生产接口

#### 6.1 implementer首切顺序

1. 先新增C01–C10、C12/C15/C18等核心目标测试，因实现缺失形成目标红测；不动共享Markdown测试。
2. 添加§3唯一类型与runtime type-only re-export，确认旧生产代码typecheck仍成立。
3. 实现record/owner/attempt注册、版本、纯binding槽与outgoing fence；实现adoption状态，不调用实际runtime。
4. 实现detached intent与同步admission；接收端为测试I/O边界，生产port缺失时不得构造默认writer。
5. 实现自动ACK、失败查询、admitting latch和CloseSavePlan；补齐C11–C22。
6. 定向unit、typecheck、限定文件lint；冻结本切片owned delta；独立reviewer检查token/重入/异常/不含生产接线。P6-0通过只记“内部核心已验收”。

#### 6.2 R-binding必要接线，不借未实现owner兜底

后续共享文件只由唯一integrator串行修改；L1释放其重叠写集合后再写，不要求所有工作区停止。

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/state/ChatState.ts`：在完整PreparedHistory/backing纯准备完成后，短同步提交内产生core CommitReceipt与相同backing版本；然后才通知。不能先onConversationChanged再register/补receipt。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/controllers/ConversationController.ts`：loadActive/switchTo/restoreConversation/createNew改为prepare→outgoing真实written→短backing commit→runtime adoption→通知/DOM。backfill按原attempt调用admitRecordDelta，不直接Object.assign共享record。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts`：getConversationById/switch的旧隐式共享hydrate不可作新协议兜底；原record/incarnation/version由同一owner登记。
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/history/CodexConversationHistoryService.ts`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/history/OpencodeConversationHistoryService.ts`：返回纯PreparedHistory、显式keep/replace/patch；record级cache只消费真实commit receipt。
- 盘点Input/Stream/AutoTurn、rewind/save、环境reconciler等source/materialization实际写点。共享图写接advance域，或真实证明已隔离成私有投影；原数组浅copy不足。首切counter未接这些写点时，版本相等不证明数据新鲜。

Tab/Manager runtime prepare不能执行sync。prepare/adopt拆开后，所有实际sync入口均接core adoption，包括initializeTabService、ensureServiceForConversation、restore、switchToTab、环境变更及共享runtime的warmup路径。未接入口是No-Go，不靠R对象相等或getSessionId补判断。

#### 6.3 runtime capture必要实现

后续在ChatRuntime上新增纯capture与按capture revision acknowledge能力；不得在P6-0先强制所有现有runtime实现一个假的默认值。

具体路径：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/runtime/ChatRuntime.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeChatRuntime.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/runtime/ClaudeSessionManager.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/runtime/CodexChatRuntime.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/codex/runtime/CodexSessionManager.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/opencode/runtime/OpencodeChatRuntime.ts`

旧consumeInvalidation保留兼容调用时，其标志变更也必须推进capture revision；所有reset/captureSession/invalidate/clear来源接同版本，不能只给新peek包装计数。capture不得调用consume、sync、Observer、通知或I/O；ack只核原capture revision，旧ack不清新flag。

provider-owned归约落各自history/session纯helper，可复用buildSessionUpdates内部规则；归约执行仅使用immutable capture及writer当前base，禁止在FIFOawait后调用live runtime。

#### 6.4 S-metadata与ACK生产门

生产MetadataSavePort由已规划 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/storage/PersistenceCoordinator.ts` 接入；其unit为 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/core/storage/PersistenceCoordinator.test.ts`。

实际adapter接：

- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/bootstrap/SessionStorage.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/providers/claude/storage/StorageService.ts`
- `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/main.ts`

同步归一化/接收后立即入目标FIFO；lane内核原handle、对最新confirmed base按显式delta归约、序列化、adapter.write、必要legacy cleanup，再written。后续已接受增量重投影到内存，不能让旧ACK全包倒灌当前对象。sequence处的base是已确认base＋顺序内前驱，不是未排序的后续活对象快照。

metadata create/update/rename/delete、startup/environment、preferred/legacy迁移及raw save旁路纳入同宿主实际写序，不能只保证P6一种调用。同IDdelete/create需顺序与incarnation护栏；保持现有native删除政策，本项不据此证明物理删除或CLI exit。missing update必须显式结果；write成功legacy失败不是written；磁盘结果不确定按既有S合同有序恢复，不用旧全量providerState重写救场。

P6-0测试port不承担这些保证；生产S未完成时不能用当前Promise<void>包装成它。

#### 6.5 P6生产消费者与正常路径

1. Controller.save返回可观察SaveAdmission/SaveReceipt，或保留一层明确UI封装但真正成功消费者检查回执；不能then(()=>undefined)抹成假ACK。
2. InputController/AutoTurnProjectionController/Tab任务回调携原binding/read ticket调用；旧callback finally不写当前ChatState dirty。updatePersistableBinding接真实保存字段修改，ACK与timeout不伪造新业务revision。
3. Manager beginClose同步取得CloseSavePlan，destroy等待其所有结果再cleanup；不在drain后按currentId重新save。L1原错误身份/继续清理规则保持。
4. nonempty draft/lazy create在首次await前固定DraftHandle、provider capture/目标，共用create-save flight；written新ID仅更新原draft/binding bookkeeping，不发布到新binding。create=1是生产迁移必测，P6-0未覆盖，不能以unbound拒绝替代。
5. 正常同provider runtime复用，普通tab非活动不退役合法后台record写；session自然变化、Claude previous/fork、Codex pending/established fork、OpenCode空读保持原规则。
6. A stat和B logger仍完全旁路；capture/metadata writer不await它们。

### 7. 与L1、T1的交叉界面

| 负责人 | 当前可继续 | 后续唯一integrator需接的界面 |
|---|---|---|
| L1 | Tab/Manager cleanup独立修改，不等P6-0 | beginClose首段sealForClose；cleanup读原计划，不自行判断READY/猜runtime；accepted数组类型更新；完整allSettled后依据failed receipt报告原错；不改claim释放政策、不称CLI已退出 |
| T1 | Reader/Observer接收、prime/recover及其unit；无本切片源码写重叠 | batch accepted、SaveAdmission accepted、metadata written分开；source generation不当binding/dirty；runtime采用后消费者属于原receipt；H仍独立真实source贯通 |

首切不需要H的dev/ino/committedOffset才能测试metadata capture；也不提供tail无损保证。P7布局final ID与reopen读屏障、H完整source移交仍属M3联合收口，不能由P6核心绿测代替。完整task/attention schema、跨client持久header与真实资源exit不是首切默认前置，也不能因首切通过提前启用。

### 8. 推演与结构自检

#### 8.1 因果链与具体反例

- 原合法binding→同步纯capture/seed→immutable intent→真实target FIFO accepted→原ticket written→匹配dirty版本确认。在全部入口遵守该协议的前提下，排队save不再取runtime B写A。原失败磁盘A=B为〔既有读数〕；目标C05/C06为〔纯示意〕，须实测升级。
- **反例一**：R对象相同、生产sync绕过adoption，core仍标R属于b1；capture实际返回B。推翻“同对象就是同binding”，也说明未迁移sync入口时核心不能生产启用。
- **反例二**：仅增加materialization counter，却保留OpenCode旧read直接写共享messages；v0未推进，旧payload可覆盖新数据。推翻“counter存在就表示freshness”。R-writing矩阵未接线时No-Go。
- **反例三**：旧ACK7 finally直接置当前dirty=false；A→B→A/b3时ID相同但token不同。破坏原ticket资格，C10/C07要求对b3改动0。
- **反例四**：port先入队后throw而不给ticket，或只以Promise fulfilled冒written；close无法可靠drain/ACK。推翻port契约前提，必须由S修，不由core假拒绝补洞。

不翻改已关账A/B、P1/Stop或既有记录status；本稿只细化尚未闭合的R/P6执行合同。

#### 8.2 不变量判定

- 正交性：record incarnation、业务source/materialization/turn、binding、adoption、dirty、writer sequence、Reader源代与A/B诊断身份分轴，目标成立；当前动态runtime/currentId拼接与dirty布尔违反。
- 无环：pureprepare→backing commit→runtime adoption/通知；capture→admission→writer→receipt。save不awaitlayout/stat/log/source恢复，projection grant不持磁盘/CLI等待，目标成立。
- 扩展方向：provider解释nativefacts与归约；核心只管中立资格/显式metadata，不解析session/path/pageKey，目标成立。
- 退化：无runtime/adopting用binding seed；missing/conflict/failed不是written；unbound首切不接生产draft，退化边界明确。
- 入口×机制：restore/switch/retry、runtime初始化/环境重绑、normal/auto/subagent/backfill/close/lazy必须接相同协议。当前未接线，**不得判已成立**；生产以§6矩阵逐格验收。

无金额/费率/日历推演触发项；本节身份与revision锚值不是覆盖率实证。

### 9. 交付物规范

#### ① 目标目录树：新增部分

```text
/Users/vincentwang/Documents/NoteVault/tools/claudian/
├── docs/designs/2026-11-08-claudian-p6-save-admission-core.md
├── src/app/ConversationHistoryCoordinator.ts
└── tests/unit/app/ConversationHistoryCoordinator.test.ts
```

本次实际只新建设计记录；另外两文件是P6-0实施产物，不是已经创建。三个既有type文件仅增契约。后续S与独立restore integration沿接管稿已有产物规范，不借首切顺手创建。

#### ② 命名规则与README登记

设计：日期＋claudian-p6-save-admission-core主题，不带首版v，不supersede旧稿。生产PascalCase职责名；unit镜像同名。后续恢复integration进入conversationRestoreLifecycle，不继续扩充Markdown诊断混合文件。由获授权执行者登记到 `/Users/vincentwang/Documents/NoteVault/tools/claudian/README.md` 的设计/回归索引，本次不修改README。

#### ③ 产物清单与消费者

| 绝对路径 | 用途 | 消费者 |
|---|---|---|
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/docs/designs/2026-11-08-claudian-p6-save-admission-core.md` | 首切实施规格、生产门与复核靶子 | 主会话、implementer、独立architect/reviewer |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/app/ConversationHistoryCoordinator.ts` | 内部资格/admission/receipt核心；后续唯一R接线入口 | R-binding、Controller、P6消费者；首切未接生产 |
| `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/app/ConversationHistoryCoordinator.test.ts` | 核心反例、正常控制、错误与reentrancy | implementer、reviewer；不作SDK/实机证据 |

一次性测试数据/缓存只在实际随机 `/private/tmp/claudian-p6-<run-id>/`，不是交付物。不落vault业务数据或新日志库。

#### ④ 归属引用与偏离

沿用 `/Users/vincentwang/Documents/NoteVault/tools/claudian/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/core/CLAUDE.md`、`/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/CLAUDE.md` 与接管稿的中立边界、provider-owned/native-first、mirrored unit/TDD、禁止console及独立design目录。偏离说明：本次只写新记录；后续首切不执行默认裸build/部署；临时材料仅/tmp；README登记留获授权执行者。未新增业务持久schema、依赖库、统计或治理机制。

## 风险与权衡

1. 核心可以独立开发，但不能独立宣称生产修复。record/source版本、完整backing及port的真实生产者仍不存在，缺任一项不得启用；不是用测试fake替其证明。
2. 首切只支持已有record。lazy/create、完整PreparedHistory/cache、runtime纯capture与S写入失败/跨实例合同明确在后续，生产替换必须全部接上相关入口；不能以工作量为由永久留下旧fallback。
3. metadata write、capture acknowledgement、dirty confirmation是三件事。capture ack失败不撤已accepted保存；write/legacy失败不written；上层timeout不销原flight。
4. Same App跨storage排序、跨reload版本接续、持久header、native exit不由本地core证明。P6首切不引新schema/热交接政策，也不把整体R2/S/H一律前置。
5. 当前混合integration中“READY incoming未commit仍必须壳save”需按已批准合同拆成：backing已commit可保存、仅旧READY/claim不可发保存权、原B delta已accepted仍须written。保留正常控制与原错绑磁盘断言，不靠删测试/全跳过save获绿。
6. 实机可达性未证；Claude sync存在真实同步通知/Observer副作用的源码事实，不等于已在Obsidian复现该窗口。生产integration与实机仍分证据等级。
7. 迁移/落地代价：P6-0增加小核心与契约，生产R/S是跨文件正确性耦合；共享Tab/Manager后续由唯一integrator接，不覆盖L1。工作量决定分期，不降低资格与错误真实性。

## 验证方式

### 1. 本次实际执行

只读冻结源码、失败日志与既有合同，并新建本记录。未运行unit/integration/typecheck/lint/build、真实runtime/CLI/Obsidian，未写代码/配置/README，未做Git写操作，未修改任何既有设计记录。

### 2. P6-0实施验收

- C01–C22至少各有一项公开入口断言；失败与正常路径配对。
- 在包含本切片source/tests/types的精确冻结candidate运行自身unit；独立HOME/TMPDIR/cache/localStorage，SDK/Obsidian继续项目mapper，不触真实provider。
- 命令模板中的C必须由派单填实际candidate绝对路径，D为本次新建临时根；不要把模板路径冒充已存在产物。

```bash
# C=包含首切变更的已冻结candidate绝对路径
# D=本次独立临时根；home/tmp/cache已创建
(cd "$C" && env -i PATH=/opt/homebrew/bin:/usr/bin:/bin \
  HOME="$D/home" TMPDIR="$D/tmp" \
  /opt/homebrew/bin/node "$C/scripts/run-jest.js" \
  --selectProjects unit --runInBand --cacheDirectory="$D/cache" \
  --runTestsByPath "$C/tests/unit/app/ConversationHistoryCoordinator.test.ts")
```

同candidate执行typecheck与仅本切片文件lint；本切片不build、不部署。记录input hash、命令、退出码、测试数量、自然退出及未覆盖项。独立reviewer检查全部token成员资格、接收前后重入、冻结内容、ACK/失败identity与no-production-wiring。

### 3. 生产接线与最终门

- R-binding：真实ChatState backing＋Controller通知close/switch/save重入；非index旧读不覆盖新消息、cache只消费原commit；source/materialization写点机械盘点与实测逐项pass/N/A。
- provider capture：真实Claude/Codex/OpenCode capture/reducer/session manager，mock传输但不mock被测capture/归约；invalidation晚新版本不被旧ack清。
- S-metadata：真实临时adapter/SessionStorage，两个storage实例顺序、write/legacy失败、preferred/legacy竞争、delete/create incarnation、unknown字段保留；不能只测受控fakeFIFO。
- P6 integration：保留 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/markdownRenderDiagnostics.test.ts` 原A→B磁盘目标反例；新用例落 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/integration/features/chat/conversationRestoreLifecycle.test.ts`。走Plugin→View→Manager→Controller→provider→真实临时metadata，覆盖A→B/B→A/同对象/旧ACK/close/合法incoming/outgoing/lazy create1/失败/统计与诊断旁路。
- 若prepare/adopt重划使原私有gate位置变化，调整gate到相应公开阶段，但保留“A已保存、关闭不污染A/B”的原磁盘断言，并核完整binding而非宽泛it.failing。
- P7/H及M3全入口与真实sourcefixture仍按接管稿整体验收；不能用P6-0绿测免掉。实机UI/真实CLI另按授权取证，不由Jest自动取得。

## 关联

- [[tools/claudian/docs/designs/2026-11-08-claudian-takeover-calibration-and-staged-integration]]，方案设计§2/§3与M3
- [[tools/claudian/docs/designs/2026-11-08-claudian-local-lifecycle-gated-slices]]，P6与P3/P7/P8依赖
- [[tools/claudian/docs/designs/2026-11-08-upstream-compat-remaining-implementation-contract]]，R1h/R2与accepted delta、writer/版本/ACK合同
- [[tools/claudian/CLAUDE]]
