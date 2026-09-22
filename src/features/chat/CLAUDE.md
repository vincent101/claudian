# Chat Feature

Main sidebar chat interface. `ClaudianView` assembles tabs, controllers, renderers, and provider-backed services around the shared `ChatRuntime` boundary.

## Provider Boundary Status

- Chat features depend on `ChatRuntime`, `ProviderCapabilities`, and provider-neutral conversation data. `InputController` builds `ChatTurnRequest`; runtimes own prompt encoding through `prepareTurn()`.
- Session bookkeeping lives in `Conversation.providerState` and is usually updated through `ChatRuntime.buildSessionUpdates()`, with fork/bootstrap state also seeded through provider history services. Feature code must not read provider-specific fields directly.
- Provider-owned services are resolved through registries
  - `ProviderRegistry`: runtime, title generation, instruction refinement, inline edit, task-result interpretation
  - `ProviderWorkspaceRegistry`: command catalogs, agent mention providers, MCP managers, CLI resolution
- Current feature split
  - Claude exposes rewind, instruction mode, runtime command discovery, and in-app MCP controls
  - Codex exposes fork, history reload, plan mode, instruction mode, images, inline edit, `$` skills, and subagents, but not rewind

## Architecture

```text
ClaudianView (lifecycle + assembly)
├── ChatState
├── Controllers
│   ├── ConversationController
│   ├── StreamController
│   ├── InputController
│   ├── TurnCoordinator
│   ├── AutoTurnProjectionController
│   ├── SelectionController
│   ├── BrowserSelectionController
│   ├── CanvasSelectionController
│   └── NavigationController
├── Services
│   ├── SubagentManager
│   └── BangBashService
├── History (windowed)
│   ├── HistoryPageStore
│   ├── HistoryWindowRenderer
│   ├── HistoryPageUiState
│   ├── HistoryResourcePolicy
│   └── HistoryDiagnostics
├── Rendering
│   ├── MessageRenderer
│   ├── HistoryWindowRenderer
│   ├── ToolCallRenderer
│   ├── ThinkingBlockRenderer
│   ├── WriteEditRenderer
│   ├── DiffRenderer
│   ├── TodoListRenderer
│   ├── SubagentRenderer
│   ├── InlineExitPlanMode
│   ├── InlinePlanApproval
│   └── InlineAskUserQuestion
├── Tabs
│   ├── TabManager
│   ├── TabBar
│   └── Tab
└── UI Components
    ├── InputToolbar
    ├── FileContextManager
    ├── ImageContextManager
    ├── StatusPanel
    ├── NavigationSidebar
    ├── InstructionModeManager
    └── BangBashModeManager
```

## State Flow

```text
User Input
  -> InputController
  -> ensure runtime for active provider
  -> ChatRuntime.prepareTurn()
  -> ChatRuntime.query()
  -> StreamController
  -> MessageRenderer + ChatState persistence
```

The feature layer consumes provider-neutral `StreamChunk` values. Providers own prompt encoding, history/session fallback, and task-result interpretation.

## Controllers

| Controller | Responsibility |
|------------|----------------|
| `ConversationController` | Session switching, windowed history (lease lifecycle, paging, search snapshot refresh, rewind/fork exact-content resolution), save, and rewind |
| `StreamController` | Consume stream chunks, update streaming state, auto-scroll, abort handling |
| `InputController` | Text input, mentions, images, resume dispatch, command dispatch, ask-user cards (auto-turn 5-minute bound), and post-plan approval flow |
| `TurnCoordinator` | Exclusive per-tab turn lease (`user`/`auto` kinds) pinned to conversation + tab lifecycle; release drives queued-message processing |
| `AutoTurnProjectionController` | Project observer-seen auto turns into the live page behind the projection FIFO; re-evaluate rewind affordances on the preceding user message at clean finalize |
| `SelectionController` | Editor selection polling and CM6 decorations |
| `BrowserSelectionController` | Browser view selection tracking |
| `CanvasSelectionController` | Canvas selection tracking |
| `NavigationController` | Vim-style keyboard navigation |

## Rendering Pipeline

| Renderer | Handles |
|----------|---------|
| `MessageRenderer` | Single-message rendering inside a page; rewind/fork affordances, interrupt markers |
| `HistoryWindowRenderer` | Page containers, spacers, mount/unmount, anchor correction — DOM windowing above the single-message renderers |
| `ToolCallRenderer` | Tool blocks and tool state |
| `ThinkingBlockRenderer` | Thinking / reasoning summaries |
| `WriteEditRenderer` | File writes and edits with diff previews |
| `DiffRenderer` | Inline diff rendering |
| `InlineExitPlanMode` | Claude tool-driven exit-plan approval |
| `InlinePlanApproval` | Shared post-plan approval flow driven by consumed turn metadata (currently Codex) |
| `InlineAskUserQuestion` | Ask-user cards emitted by provider runtimes |
| `TodoListRenderer` | Todo items and status icons |
| `SubagentRenderer` | Background agent lifecycle rendering |

## Key Patterns

### Lazy Runtime Initialization

Tabs stay cold until the first send. The tab wiring exposes `ensureServiceInitialized()` so provider runtime creation happens only when needed.

### Message Streaming

```typescript
const preparedTurn = runtime.prepareTurn(request);
const turnContext = createTurnProjectionContext({ turnId, message, renderTarget, generation });

for await (const chunk of runtime.query(preparedTurn, history)) {
  turnContext.message = activeAssistantMessage;
  turnContext.renderTarget = state.currentContentEl;
  streamController.handleStreamChunk(chunk, turnContext);
}
```

Domain-first projection (S3): `TurnProjectionContext` is the data truth for a
turn — message content, toolCalls, contentBlocks and subagent domain records
are always updated; DOM rendering happens only when `renderTarget` is set.
`SubagentManager` keeps sync/async `SubagentInfo` maps as the domain truth with
DOM states as an optional projector cache (`attachProjection(taskId, parentEl)`
attaches one later and renders the current state in a single pass).

### Auto-Scroll

- Enabled by default during streaming
- User scroll-up disables it
- Scroll-to-bottom re-enables it
- Resets to the saved setting on a new query

### History Windowing (Paged Transcripts)

Two load paths, two entry points, capability-routed — never by provider id:

- `getHistoryIndexCapableService` (deps-injected, adapted in `Tab.ts` from `typeof service.acquireHistoryIndex === 'function'`) decides the path. Index-capable providers (Claude) window through `acquireHistoryIndex`; others (Codex/OpenCode) keep full hydration — `ChatState.messages = [...conversation.messages]`.
- `loadActive` (tab restore / app open): acquire lease → `ready` → first-screen window (anchor = totalTurns, direction `older`, `HISTORY_RESOURCE_POLICY.firstScreen`) → bind lease → `restoreConversation(page)`. Transcriptless drafts (no session id, not a pending fork) skip the index.
- `switchTo` (dropdown/history switch): `reserveConversation` CAS claim → release the outgoing tab's lease (same release point as closeTab, or the protected index stays pinned out of the LRU forever) → `windowRenderer.reset()` → acquire fresh. The restored projection owns the pager: the dropdown entry bypasses `loadActive`, so `renderHistoryPager()` runs in both entry points.
- `ChatState.messages` is the only per-tab materialized view (loaded pages + live page). For Claude, `Conversation.messages` holds only a not-yet-persisted draft tail or `[]` — never a window. Feature code must not treat a loaded window as the complete history (fork/rewind go through `resolveExactUserMessage`).

DOM windowing invariants (`HistoryWindowRenderer` + `HistoryPageStore`):

- Unmounting only activates past `250` total turns or `16 MiB` mounted projected weight (`HISTORY_WINDOW_LIMITS`); below that, pages mount permanently and no spacer is ever created. Target soft window `180` mounted turns, hard cap `200`; a single visible page above the cap is the sole exception (`dom_overcommit` diagnostic) — turns are never split.
- Every `messagesEl` structure change (page mount, unmount, replace) goes through the `ProjectionWriteCoordinator` stored grant. Data rematerialization runs **outside** the grant (a slow disk load must never occupy the projection write lease); only the DOM commit re-acquires and revalidates conversation id + DOM epoch + page identity at write time.
- Each page lives in a `claudian-history-page` wrapper that replicates `messagesEl`'s `flex column + gap` context: gap only applies to direct children, so without the wrapper layer the message spacing inside pages would collapse.
- Unmount waits for the current page render ticket to settle (3 s timeout → `estimated` height + `page_render_timeout` diagnostic, never a fake settle); spacer height is measured only from settled tickets. Re-visits re-mount, then correct scroll by the stable `data-message-id` anchor delta. Width/font/theme changes mark all heights stale instead of rebuilding pages.
- Live pages (`live:` prefix, created by `beginLivePage`) and `memory-only` pages (rewind rebuilds — the disk snapshot still contains the discarded branches, so eviction would destroy the truth) are exempt from data-LRU eviction; eviction only clears `messages` and keeps range/height/UI state. All-pinned pressure overcommits with a diagnostic rather than evicting.
- Scroll handlers only sample positions and record one intent per direction per frame; `runLatestStoredIntent` drops superseded intents so a stale window op never replays after a live turn releases.

Stored transaction protocol (`runStoredTransaction` in `ConversationController`): history load + ChatState merge + render + queue drain is one unit under the projection write lease, FIFO-queued behind any live streaming turn. The task body revalidates the conversation id captured at request time after every await — a stale page must never merge into, render into, or paginate the newly displayed conversation. The search snapshot refresh inverts this on purpose: the forced index rebuild runs **outside** the stored grant (grant-held rebuilds head-blocked the FIFO for tens of seconds), the old lease keeps serving reads, and only the revalidated exchange is a short stored transaction. `refreshHistorySearchSnapshot(trigger)` records which surface forced the refresh (`search`/`rewind`/`fork`) on every `search_snapshot_refresh` diagnostic event.

## Gotchas

- `ClaudianView.onClose()` must abort active tabs and dispose runtimes
- `ChatState` is per-tab; `TabManager` coordinates tab-level operations such as fork targets and provider-aware command catalogs
- Title generation runs concurrently per conversation; title material comes from the bounded `loadTitleMaterial` (first user + recent user excerpts through the index), never a full hydrate
- Rewind and fork resolve exact user content through one shared entry: `ConversationController.resolveExactUserMessage` (fork in `Tab.ts` calls the same, 3.1.4). Only a `summary` projection loads detail through the index (16 MiB cap) — live/detail/draft messages are already exact in memory, and live messages carry local ids that would always miss the index regardless of snapshot freshness (real-world regression: rewinding a just-sent message failed). A `not_found` summary triggers one forced snapshot refresh (search-refresh exchange semantics) plus a single retry — the stale-lease self-heal; `too_large` is a property of the message and never refreshes; a conversation switch mid-refresh aborts silently. A lease-less summary can only abort (fail-closed: pre-filling the input from a trimmed summary would rewrite the user's message). Pages rebuilt by rewind are `memory-only` — rematerializing them from the index is refused loudly (the snapshot still contains the discarded branches)
- Auto turns (task-notification continuations, peer-forwarded runs) have no guaranteed attending user, but their ask cards still render (3.1.3): the pending `canUseTool` promise races a 5-minute timeout that settles deny+interrupt with a visible timeout notice; any earlier answer/abort/dismiss cancels the race one-shot. User turns keep the unbounded path. The exclusive turn lease's kind (`TurnCoordinator`) attributes the ask — never provider-id checks
- When an auto turn finalizes cleanly, `AutoTurnProjectionController` re-evaluates the rewind buttons on the nearest user message preceding the turn's anchor: `findRewindContext` stops at the first user message, so an evaluation that ran while the auto turn's user row sat ahead of it saw no response yet and hid the button (3.1.5). Idempotent — the renderer skips messages already carrying buttons or ineligible
- Lease-less search (Codex/OpenCode) enumerates visible DOM matches only; it must never be reported as a staleness problem by the search snapshot refresh
- `/compact`
  - Claude skips context injection so the provider recognizes the built-in command and persists the compaction boundary
  - Codex routes compact turns to `thread/compact/start` and persists the durable `context_compacted` boundary from JSONL history
- Plan mode
  - Claude uses provider/runtime events for enter and exit plan mode
  - Codex sets `collaborationMode` on `turn/start` and triggers shared post-plan approval from consumed turn metadata
- Bang-bash mode bypasses provider runtimes and executes a local shell command directly
  - It is available only when an enabled provider exposes it in `ProviderChatUIConfig` (currently Claude)
- Forking is provider-owned under the hood
  - Both Claude and Codex support fork
  - `ChatRuntime.resolveSessionIdForFork()` and provider history services own the provider-specific fork/session mapping
