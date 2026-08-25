---
type: design-decision
status: draft
target: /Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/rendering/SubagentRenderer.ts
tags:
  - architect
  - claudian
  - rendering
---

# async subagent 工具详情展开状态保留

## 背景与问题

async subagent 的工具明细刷新会全量重建内容；当前渲染时复制 `ToolCallInfo`，展开回调只修改副本，导致下一次真实数据刷新时 domain 中仍是 `isExpanded: false`，工具详情被折回。

## 方案设计

推荐保留现有全量重建，只消除工具条目的对象身份断裂。

1. 在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/src/features/chat/rendering/SubagentRenderer.ts` 的 `renderAsyncContentLikeSync` 中，直接将 `subagent.toolCalls` 的原条目传给 `createSubagentToolView`，删除仅为渲染创建的浅副本。
2. 复用 `createSubagentToolView` 已有行为：初始化读取 `toolCall.isExpanded`，`onToggle` 回写同一个 `toolCall`。无需修改 `AsyncSubagentState`，无需新增 Map。
3. `updateAsyncSubagentRunning`、`finalizeAsyncSubagent`、`markAsyncSubagentOrphaned` 继续调用同一全量渲染函数；重建时自然按 domain 状态恢复每个工具各自的展开姿态。
4. 在 `/Users/vincentwang/Documents/NoteVault/tools/claudian/tests/unit/features/chat/rendering/SubagentRenderer.test.ts` 增加回归测试：展开某一工具后触发 running 真刷新，以及 terminal 全量渲染，确认该工具仍展开、其他工具不受影响，且 domain 字段已更新。

不采用仅追加或完整 diff：当前问题不是 DOM 重建本身，而是 UI 状态未写回 domain。现有 sidecar 合并已按 id 保留旧条目身份且不覆盖 `isExpanded`，直接复用即可闭环。

## 风险与权衡

- 直接传 domain 对象意味着展开交互会修改 `SubagentInfo.toolCalls[*].isExpanded`；这正符合现有 domain-first 设计及字段用途。
- `renderAsyncContentLikeSync` 同时用于历史 async 卡片，历史卡片点击也会更新传入对象的 `isExpanded`。该变化无持久化副作用，且语义一致。
- 全量重建仍可能重置内容区滚动位置、选区等 DOM 瞬时状态；本次目标仅是展开姿态，暂不为未出现的需求引入增量 DOM 注册表。
- 预计生产代码净减少约 4 行；测试新增约 25–50 行。总净变化约 20–45 行，明显低于 150–250 行。

## 验证方式

1. 单测：展开工具 A，确认 `state.info.toolCalls[0].isExpanded === true`；新增工具 B 或更新 A 状态后调用 `updateAsyncSubagentRunning`，确认 A 的 wrapper/ARIA/内容仍为展开，B 默认折叠。
2. 单测：展开工具后分别调用 `finalizeAsyncSubagent`、`markAsyncSubagentOrphaned`，确认终态内容重建后展开姿态保留，Result 区正常出现。
3. 命令：`npm run test -- --selectProjects unit --runTestsByPath tests/unit/features/chat/rendering/SubagentRenderer.test.ts`。
4. 全量门禁：`npm run typecheck && npm run lint && npm run test && npm run build`。
5. 人工：运行中展开已有工具；等待新工具出现及任务完成，确认已有工具不折回且各工具展开状态互不串扰。

## 关联

- [[2026-08-23-Claudian-subagent工具明细不显示根因与修复]]
