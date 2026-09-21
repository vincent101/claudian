# Claude Provider

SDK adaptor wrapping `@anthropic-ai/claude-agent-sdk` behind `ChatRuntime`, with Claude Code CLI compatibility layered around it.

## Design Decisions

### Persistent Query — Why Not Restart

The persistent query stays alive across turns. Model, thinking budget, permission mode, MCP servers, and effort level are updated dynamically via SDK API calls (`setModel`, `setMaxThinkingTokens`, `setPermissionMode`, `setMcpServers`, `applyFlagSettings`). Restart is still required when the effective system prompt, disabled-tool set, plugin set, settings source set, CLI path, Chrome enablement, or external context paths change. This eliminates cold-start latency for turns that only change dynamic knobs.

### Text Deduplication

The SDK delivers assistant text twice: incrementally via `stream_event/content_block_delta`, and again as complete text in the `assistant` message. The handler tracks `sawStreamText` — if stream events were seen, the assistant message's text blocks are skipped. Without this, every response would render double.

### Usage Chunk Single-Source (Assistant Message)

Usage info comes from one SDK message — the assistant message: accurate input-side token counts (`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`), but only from main-agent messages (`parent_tool_use_id === null` filter) — subagent messages are excluded to avoid inflated counts. Within a turn, a request-boundary snapshot state machine aggregates usage per request (assistant opens/updates the request's input-side snapshot, the matching `result` closes it with the whole usage object replaced atomically) — cross-request per-field `Math.max` double-counted a cache-miss request's uncached input against the next cache-hit request's `cache_read` (2.6.1 hotfix 9536151e).

The `contextWindow` denominator is single-sourced from the model selector's preset configuration (2.3.2 ②, user ruling 2026-09-17: "我选什么模型，显示什么模型的上下文长度才对"); the result-side `modelUsage` window chain was removed because result-message token counts aggregate across subagents and the SDK-reported window must never override the selector preset. Four chains keep it derived (3.0.2): streaming turns snapshot the resolved model; hydration re-derives via `ConversationController.refreshUsageWindow` from the provider settings snapshot model; settings refresh (`ClaudianView.refreshModelSelector`) re-derives every tab from the provider's current model; READY-tab passive sync calls the same hydration entry so a stale stored denominator cannot survive a tab switch back. The persisted `usage.model` is a runtime label (CLI-reported form like `claude-sonnet[1m]`) and never denominates — only when no model resolves at all does the stored snapshot survive.

### Custom Spawn — Electron Workarounds

`createCustomSpawnFunction()` works around two Obsidian/Electron-specific issues:
- Resolves `node` to a full path because GUI apps don't inherit shell PATH
- Does NOT pass `signal` to `spawn()` — Obsidian's Electron uses a different `AbortSignal` realm that breaks Node's internal `instanceof` check; manually calls `child.kill()` on abort instead

### Transcript Indexing — Single-Track Windowed History

`hydrateConversationHistory` no longer exists for Claude (B4): every restored tab goes through `acquireHistoryIndex` → `loadWindow` with a fixed snapshot; small sessions are just the degenerate case where the first screen covers `[0, total)`. One contract, one completeness semantics — no size-threshold reader branch may return.

The index (`ClaudeTranscriptHistoryIndex`) is byte-offset based and survives poisoned rows:

- A line above `DEFAULT_MAX_LINE_BYTES` (16 MiB) does not throw and is not truncated into garbage — a discard state machine drops bytes until the closing newline, then emits an opaque entry (`projectionKind: 'skip'`, `oversized: true`). Identity (uuid/parentUuid/type/timestamp) is recovered from bounded prefix + tail reads (256 KiB each); a row occluded at both bounds stays unresolved — recovery must be provable, not guessed. `finalizeIndex` refuses a resume anchor that falls inside an opaque row or cannot be verified across one (explicit error, never a guessed truncation point).
- `committedSize` only advances past the last fully processed newline; the tail reader resumes there, never at the stat-time EOF, so a half-written final line is never split in two. EOF inside the discard state leaves the line uncommitted and does not report `line_skipped` (the rebuild that observes the closing newline would double-count it).
- Completed indexes are LRU-cached (8 snapshots / 128 MiB metadata) keyed by snapshot identity **plus the resume variant** (`resumeVariantKey`): a fork's main-path index and the full-chain index of the same file are distinct cache entries — without the variant, a fork polluted the cache for every later full open (3.1.1). In-flight builds and the request cache share the same key rule so the layers can never drift apart. Worker builds degrade to direct (main-thread) builds on probe failure; a degraded mode stays visible in the `history-index` diagnostics log.

## Non-Obvious Behaviors

### SDK Amnesia Detection

When the SDK returns a different session ID than the one provided in `resume`, `SessionManager.captureSession()` sets `needsHistoryRebuild = true`. `ClaudeChatRuntime` detects this and injects full conversation history into the next user message before dispatching the turn. This handles the case where the SDK silently lost context without explicit error signaling.

**Fork interaction**: on the first `session_init` after a fork, `clearHistoryRebuild()` prevents the amnesia logic from triggering — the SDK legitimately returns a different session ID for forks.

### Crash Recovery

On consumer loop error, if `!crashRecoveryAttempted && lastSentMessage && !handler.sawAnyChunk` (first failure, message was sent, nothing was streamed yet): restart the persistent query with `preserveHandlers: true` and re-enqueue the message. Single retry only — second failure surfaces the error.

### Auto-Triggered Turns

The SDK can send messages without a registered handler (e.g., background subagent completion notifications). These chunks buffer in `_autoTurnBuffer` and deliver via `_autoTurnCallback` on the `result` event.

### Auto-Turn Notification Attribution (transcript lineOffset)

Auto-turn completion notifications are attributed by transcript causality, not wall-clock time (`src/providers/claude/transcript/` — tail reader, turn mapper, turn observer). The observer tracks `lastHostUserOffset`; a finished auto turn whose `terminalOffset` precedes a later host user line reports `supersededByHostUser: true` — the host user already replaced that turn's result in the transcript, so the late "已完成" notification is suppressed. Offsets come from the tail reader's committed boundary; ordering is byte-position causal order within one transcript file, which is why the reader must never resume at the stat-time EOF (see indexing above).

### MessageChannel Queue

- Text-only messages merge with `\n\n` up to 12000 chars while a turn is active (fast follow-up messages coalesce)
- Attachment messages replace the previous queued attachment (one at a time)
- Queue overflow beyond 8 messages drops the newest

### Branch Filtering

SDK session files are tree-structured — rewind + re-prompt creates branches. `filterActiveBranchEntries` (in `sdkBranchFilter`) finds the canonical branch by locating the latest leaf, walking ancestry to root, then including non-user-branch siblings (tool results belonging to ancestors); with a `resumeAtMessageId` (fork) it truncates at the resume anchor instead. The index layer runs it on raw entries before turns/search corpus are derived, so every projection consumer (window/detail/title/export) shares one branch truth.

## Storage Traps

### CC Settings Merge

`CCSettingsStorage.save()` reads the existing `.claude/settings.json` first and merges — it only manages `permissions` and `enabledPlugins`. Without the merge, saving would clobber CC-owned fields (model, env, MCP settings) that users set via the CLI.

### MCP Dual-Namespace

`.claude/mcp.json` stores servers in two namespaces: `mcpServers` (CC-compatible, read by the CLI) and `_claudian.servers` (Claudian metadata: enabled, contextSaving, disabledTools, description). CC ignores the `_claudian` key. This avoids polluting the CC-compatible format with Claudian-specific data.

### Plugin Dual-Write

Plugin enabled state is written to both `.claude/settings.json` (so the CC CLI also respects it) and kept in `PluginManager.plugins[].enabled` (for Claudian's restart check). These must stay in sync.

### Slash Command ID Encoding

Dashes are escaped as `-_`, slashes become `--`. This is a reversible encoding for subdirectory support: `a/b-c.md` → `cmd-a--b-_c`.

## Gotchas

- `DISABLED_BUILTIN_SUBAGENTS = ['Task(statusline-setup)']` — disabled because it has no meaning in Obsidian
- `previousProviderSessionIds` tracks all prior SDK sessions for a conversation (e.g., after forks). All are indexed in one chained pass (`[...previousProviderSessionIds, currentSessionId]`) to build the complete message set — not just the current session. There is no full hydration anymore: windows, search, and title material all read through the index
- `EnterPlanMode` never hits `canUseTool` — the SDK auto-approves it; the runtime detects it in the stream to sync UI. `ExitPlanMode` does go through `canUseTool`
