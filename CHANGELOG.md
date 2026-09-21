# Changelog

Notable, user-visible changes in this fork's release line. Format follows [Keep a Changelog](https://keepachangelog.com/); dates are release-commit dates. The line starts at 2.2.0 — the local 2.1.x batches (on top of upstream 2.0.11) are folded into the 2.2.0 baseline entry.

## [3.1.1] - 2026-09-20

### Fixed
- Forking a large session no longer shows post-checkpoint messages: the transcript index cache now keys on the resume variant, so a forked conversation starts exactly at its checkpoint.
- Search snapshot refresh no longer stalls behind an in-flight stored grant — eliminated a queue-head block (previously p95 ~14s, worst ~65s) when refreshing the Ctrl+F index.
- Page-level history diagnostics now carry a hashed page key, so log events are attributable to a concrete page.

## [3.1.0] - 2026-09-20

### Fixed
- Rewind/fork across a fork boundary now renders exactly the new branch's messages; messages without stable IDs no longer leak across the fork history boundary.
- Sending a message right after a streaming turn finishes no longer stalls: the context-usage refresh is decoupled from the pending-save gate.
- Codex usage chunks are stamped with the resolved model, so the context gauge reflects the model actually in use.
- Oversized-row identity recovery scans a bounded tail from both ends of a transcript line, instead of failing the whole line.
- Diagnostics: identity-recovery provenance is persisted and redundant reveal remounts are skipped.

## [3.0.3] - 2026-09-20

### Fixed
- Rewind on windowed (large) sessions goes through a clean reset plus a single synthetic page instead of a full history reload.
- Re-opening a session mid-write recovers from the last complete newline, so half-written transcript lines no longer break the view.

## [3.0.2] - 2026-09-20

### Fixed
- The context-usage denominator is re-derived when recovering or switching back to a session, falling back to the provider's current model when the saved selection is empty.

## [3.0.1] - 2026-09-20

### Fixed
- Message layout inside paged history restored — page wrappers lost their flex layout context after windowing.
- The pager UI now renders after switching to a paged session.

## [3.0.0] - 2026-09-20

### Added
- DOM windowing for chat history: arbitrarily large sessions browse at constant memory, with "Load earlier" paging, pinned live/search pages, and scroll/expansion state preserved across page evictions.
- Oversized transcript lines (multi-MiB single lines) degrade to collapsed placeholders instead of failing the whole session — previously poisoned sessions (e.g. a 16 MiB line) now open.
- Search snapshot refresh is a visible state machine with structured outcomes and an explicit retry when the first refresh fails.

### Fixed
- Superseded auto-turn notifications are suppressed: no more late "task completed" notices after you have already moved on.
- Hard-cap omission markers are localized across all 10 locales.

## [2.6.1] - 2026-09-18

### Fixed
- Recovery injections are invisible in the conversation flow: no more "User: … / Assistant: …" blocks after amnesia recovery, internal search no longer matches them, and titles/counts stay correct.
- Recovery source re-binds atomically with the conversation, preventing cross-session contamination; restore drafts are bound to the recovery lifecycle.

## [2.6.0] - 2026-09-18

### Changed
- Unified Claude index loading onto a single path: all sessions load through the same acquire → ready → loadWindow pipeline, with an adaptive first-screen budget (200 turns / 8 MiB / 2M chars) — large sessions open fast from any entry point.
- A conversation can no longer be opened twice concurrently (ownership token + compare-and-swap).
- Switching back to a session backfills stale conversation metadata (message count, preview, first excerpt).

## [2.5.1] - 2026-09-17

### Fixed
- ESC reliably cancels: stuck question cards are unlocked, pending plan-mode inline prompts are dismissed, and background auto-turn questions are denied outright.
- Auto turns no longer dead-lock after a user cancel (promote-after-cancel race closed; buffered content is kept).

## [2.5.0] - 2026-09-17

### Changed
- Rewind/fork restore exactly: message details are always explicitly materialized, and shortcut rendering no longer loses tool results.
- History paging keeps pages around your current view warm (around-window + weighted LRU); the legacy load-range path is gone.
- Clicking a search hit loads the precise message detail through the same path.

## [2.4.0] - 2026-09-17

### Added
- Session amnesia auto-recovery: when the provider loses a session, a bounded recovery state machine replays the conversation and resumes it, with clean fallback on cancel/interrupt.
- Full-conversation export from the session list context menu — streams to `.claudian/exports` or the clipboard instead of building everything in memory.

## [2.3.2] - 2026-09-17

### Fixed
- Cancelling leaves a clean terminal state: in-flight tools and subagent panels are marked interrupted instead of hanging.
- Background task-notification turns no longer falsely complete your active turn (per-turn result attribution).
- The context-usage denominator is sourced solely from the selected model preset.
- Crash-recovery replay no longer leaves a stale pending-notification flag behind.

## [2.3.1] - 2026-09-16

### Fixed
- Fresh/empty conversations show a correct context-usage denominator: the settings page is the single source of truth and first-launch hydration goes through the preset chain (hardcoded `[1m]`/fable fallbacks removed).

## [2.3.0] - 2026-09-16

### Added
- Tab drag-to-reorder and a tab context menu.
- Message-level copy toolbar on assistant replies.
- Settings and chat UI fully localized — the Codex/OpenCode settings tabs join the 10-locale coverage.

### Fixed
- Notification false positives: notifications now subscribe to explicit turn-success terminal states instead of `isStreaming=false`, and cancels inside a turn no longer emit a completion notice.
- Cmd+F search: snapshot binding and a canonical result order — no more jumping or duplicated keys across pages.
- Codex context denominator fallback respects custom window caps.

## [2.2.0] - 2026-09-16

Baseline entry of this fork's release line (folds the local 2.1.0–2.1.3 batches on top of upstream 2.0.11 + local patches).

### Added
- Model presets: configurable model tiers with custom context windows (incl. Fable-family models); the context-usage denominator follows the selected model, and 1M sessions no longer drift to a 200k denominator.
- Large-session groundwork: background transcript indexing with paged loading, full-history Ctrl+F search, budgeted/frame-batched rendering, and a main-thread fallback where worker threads are unavailable.
- Ctrl/Cmd+F works inside the chat view — Obsidian's window-level keymap no longer swallows the hotkey.
- Desktop system notifications when background turns complete.
- Subagent tool details stream live while the subagent runs, instead of appearing only at completion.

### Fixed
- Turn-stability family: no more ghost auto-turns, silently dropped first messages in new conversations, or turns hung on aborted renders.
