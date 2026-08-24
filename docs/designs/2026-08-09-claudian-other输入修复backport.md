---
type: design-decision
status: draft
target: .obsidian/plugins/claudian/main.js
tags:
  - architect
  - obsidian-plugin
  - claudian
  - backport
---

# Backport 上游 #675：AskUserQuestion "Other" 自定义输入修复（2.0.11）

## 背景与问题

2.0.11 上 Claude 的 `AskUserQuestion` 工具的 "Other"（自定义文本输入）选项**不可达**。上游 commit `be722e20`（#675，2026-05-23，落进 2.0.18）修复。用户高频使用 AskUserQuestion，这是本地 2.0.11 唯一的实质功能缺陷。目标：在不升级的前提下，把该修复 backport 进未压缩的本地 bundle。

**结论：可 backport**。#675 只触及两个文件，都已在本地 bundle 中定位到对应未压缩代码，且与 2.0.18→2.1.2 之间引入的其他重构**无依赖**（自包含的 UI 焦点逻辑 + 一处输入注入）。工作量：6 处小编辑，约 40 行净改动。

## bug 的两个独立成因（PR 描述 + diff 实证）

#675 实际修了两件事，缺一不可：

**成因 A（功能性，根因）**：Claude SDK 的 JSDoc 声称 "Other will be provided automatically"，但 SDK **并不会**把 `isOther` 注入 `canUseTool` 的 input。Claudian 在 `canUseTool` 拦截并自绘 UI，而 UI 只在 `question.isOther === true` 时才渲染自定义输入行（`canShowCustomInputForQuestion`）。结果：**"Other" 行根本不出现**。

**成因 B（键盘导航，体验）**：即便有了 `isOther`（成因 A 修好后），键盘操作仍有两个 bug：
1. `updateFocusIndicator()` 在箭头导航到 custom 行时**自动 focus 输入框并置 `isInputFocused=true`**，导致下一次 Enter 被当成"结束编辑、切到下一题"，用户没机会打字。
2. 焦点在输入框时按 ArrowUp/ArrowDown 被键盘处理器吞掉，无法导航回普通选项。

**用户在 2.0.11 的实际现象**：让 Claude 问一个带选项的问题（`AskUserQuestion`），选项列表里**没有 "Other" / 自定义输入这一项**，只能选预设选项，无法自由作答。（注：成因 B 的两个键盘 bug 在 2.0.11 上被成因 A 掩盖——因为 "Other" 行压根不渲染。修了 A 之后 B 才会暴露，所以两者必须一起 backport。）

## 证据锚点

- 上游 commit：`be722e20`（full diff 已读，见下）
- 成因 A diff：`src/providers/claude/runtime/ClaudeApprovalHandler.ts` +12 行（注入 `isOther`）
- 成因 B diff：`src/features/chat/rendering/InlineAskUserQuestion.ts` 4 处 hunk
- 本地 2.0.11 bundle 对应位置（未压缩，`// src/...` 注释标记保留，可精确定位）

## Patch 清单（可直接交付 implementer）

**唯一目标文件**：`/Users/vincentwang/Documents/NoteVault/.obsidian/plugins/claudian/main.js`
**不涉及 styles.css**（#675 无样式改动）。

### Patch 0（备份，先做）

现有备份均不要覆盖。新建：
```
main.js.bak-before-other-fix-patch
```

### Patch 1 — 成因 A：注入 isOther（关键，独立见效）

位置：`main.js:60746`（`createClaudeApprovalCallback` 内的 askUserQuestion 分支）。
锚点（全文命中 **1** 次，已验证）：
```
        const answers = await askUserQuestionCallback(input, options.signal);
```

old:
```js
      try {
        const answers = await askUserQuestionCallback(input, options.signal);
```
new:
```js
      try {
        const questions = input.questions;
        if (Array.isArray(questions)) {
          for (const q of questions) {
            if (q && typeof q === "object" && !("isOther" in q)) {
              q.isOther = true;
            }
          }
        }
        const answers = await askUserQuestionCallback(input, options.signal);
```

说明：上游 TS 有类型断言 `(input as Record<string, unknown>).questions`，bundle 是 JS 无需断言，直接 `input.questions`。语义与上游一致：对每个缺 `isOther` 的 question 无条件置 `true`，匹配 Claude Code CLI 内建行为。

**仅做 Patch 1 就能让 "Other" 行出现**（成因 A 修复）。但键盘选中它仍受成因 B 困扰，故需 Patch 2-6。鼠标点击 "Other" 行输入框在 Patch 1 后理论上已可用（输入框 focus 有 `focus` 监听器置 `isInputFocused`），所以 **Patch 1 是最小可用修复**；Patch 2-6 补全键盘导航。

### Patch 2 — 移除 `updateFocusIndicator` 的自动 focus 副作用（hunk B 上半）

范围：**仅 `InlineAskUserQuestion` 类内**（`main.js:78402-78427`）。
⚠️ 类边界：`var InlineAskUserQuestion = class {`（78045，全文 1 次）到 `var InlineExitPlanMode = class {`（78608，全文 1 次）之间。**不可改到 InlineExitPlanMode / InlinePlanApproval**——上游有意保留它们的 auto-focus（它们的 custom 行是 feedback，恒存在，无此 bug）。类内锚点命中 1 次。

old（类内唯一）:
```js
        item.scrollIntoView({ block: "nearest" });
        if (item.hasClass("claudian-ask-custom-item")) {
          const input = item.querySelector(".claudian-ask-custom-text");
          if (input) {
            input.focus();
            this.isInputFocused = true;
          }
        }
      } else {
```
new:
```js
        item.scrollIntoView({ block: "nearest" });
      } else {
```

### Patch 3 — 移除 `updateFocusIndicator` 的自动 blur 副作用（hunk B 下半）

紧随 Patch 2 的 else 分支（`main.js:78419-78425`）。类内锚点命中 1 次。

old:
```js
        item.removeClass("is-focused");
        if (cursor) cursor.textContent = "\xA0";
        if (item.hasClass("claudian-ask-custom-item")) {
          const input = item.querySelector(".claudian-ask-custom-text");
          if (input && document.activeElement === input) {
            input.blur();
            this.isInputFocused = false;
          }
        }
      }
```
new:
```js
        item.removeClass("is-focused");
        if (cursor) cursor.textContent = "\xA0";
      }
```

注：上游用 `this.rootEl.ownerDocument.activeElement`，bundle 此处是 `document.activeElement`（等价，因 rootEl 挂在 document 上）。整块删除即可。

### Patch 4 — 输入框内 ArrowUp/ArrowDown 导航守卫（hunk B 中段）

位置：`handleKeyDown` 的 `if (this.isInputFocused)` 块尾部（`main.js:78505` 的孤立 `return;` 之后、`}` 之前）。
锚点（全文命中 **1** 次）：
```
      return;
    }
    if (this.config.immediateSelect) {
```

old:
```js
      return;
    }
    if (this.config.immediateSelect) {
```
new:
```js
      if (e2.key === "ArrowUp" || e2.key === "ArrowDown") {
        e2.preventDefault();
        e2.stopPropagation();
        const activeEl = document.activeElement;
        if (activeEl) activeEl.blur();
        this.isInputFocused = false;
        const q = this.questions[this.activeTabIndex];
        const maxIdx = this.canShowCustomInputForQuestion(q) ? q.options.length : q.options.length - 1;
        if (e2.key === "ArrowUp") {
          this.focusedItemIndex = Math.max(this.focusedItemIndex - 1, 0);
        } else {
          this.focusedItemIndex = Math.min(this.focusedItemIndex + 1, maxIdx);
        }
        this.updateFocusIndicator();
        this.rootEl.focus();
        return;
      }
      return;
    }
    if (this.config.immediateSelect) {
```

注：bundle 用 `e2`（非上游的 `e`）、`q10`/`q11` 已被占用故用 `q`。上游此处还有个"移除 handleNavigationKey 里死守卫"的清理，但 2.0.11 的 `handleNavigationKey`（78445）结构不同、无对应死代码，**跳过**。

### Patch 5 — Enter 处理器：querySelector 作用域收窄到当前行（hunk B 末段）

位置：`main.js:78546-78552`。锚点（全文命中 **1** 次）：
```
          const input = this.contentArea.querySelector(
            ".claudian-ask-custom-text"
          );
```

old:
```js
          this.isInputFocused = true;
          const input = this.contentArea.querySelector(
            ".claudian-ask-custom-text"
          );
          input == null ? void 0 : input.focus();
```
new:
```js
          this.isInputFocused = true;
          const customRow = this.currentItems[this.focusedItemIndex];
          const input = customRow == null ? void 0 : customRow.querySelector(".claudian-ask-custom-text");
          input == null ? void 0 : input.focus();
```

注：bundle 用 `== null ? void 0 :` 可选链形式，非上游 TS 的 `?.`。语义一致。

### Patch 6 — custom 行点击处理器（hunk A）

位置：custom 行渲染末尾（`main.js:78273`，`this.currentItems.push(customRow);` 之前）。
范围：`InlineAskUserQuestion` 类内，锚点（类内命中 **1** 次）：
```
      this.currentItems.push(customRow);
```

old:
```js
      inputEl.addEventListener("blur", () => {
        this.isInputFocused = false;
      });
      this.currentItems.push(customRow);
```
new:
```js
      inputEl.addEventListener("blur", () => {
        this.isInputFocused = false;
      });
      customRow.addEventListener("click", () => {
        this.focusedItemIndex = customIdx;
        this.updateFocusIndicator();
        inputEl.focus();
      });
      this.currentItems.push(customRow);
```

注：`customIdx` 与 `inputEl` 均在该作用域内已定义（`main.js:78242` `const customIdx = q10.options.length;`、`78255` `const inputEl = ...`），可直接引用。

## 连带依赖核查（为什么这个 backport 干净）

- #675 的 4 个文件中，`tests/helpers/mockElement.ts` 和两个 `.test.ts` **不需要 backport**（测试设施，运行时无此文件）
- 两个运行时文件（`ClaudeApprovalHandler`、`InlineAskUserQuestion`）在 2.0.11 bundle 均有对应未压缩代码，且 **2.0.12–2.1.2 之间没有这两个文件的前置重构**被 #675 依赖（diff 的 context 行与 2.0.11 现状逐行吻合）
- 不触碰你已打的 attention / review / 换色 / xhigh patch（区域不重叠：#675 在 60746 / 78045-78608，你的 patch 在 55733 / 85247+ / 90089+ / 80245 / styles.css）

## 风险与权衡

1. **改 bundle 失败 = 整个插件加载失败**。`node --check main.js` 必过；先备份。
2. **Patch 2/3 必须严格限定在 `InlineAskUserQuestion` 类内**。同样的 auto-focus 代码块在 `InlineExitPlanMode`（78796）和 `InlinePlanApproval`（78955）也有，**绝不能删那两个**（它们的 custom 行靠 auto-focus 正常工作，删了反而引入 bug）。implementer 必须先定位 `var InlineAskUserQuestion = class {`，只在其与 `var InlineExitPlanMode = class {` 之间的范围内改。
3. **升级即失效**：与既有 patch 一样，升级到 ≥2.0.36（minified）后此 patch 无法移植；且上游 2.0.18+ 已含此修复，届时直接升级即可，无需保留本 patch。
4. 多行锚点须用 `python3 str.count()` 验证唯一性（`grep -c` 对多行模式不可靠）。

## 验证方式

**静态**：
```bash
cd /Users/vincentwang/Documents/NoteVault/.obsidian/plugins/claudian/
node --check main.js && echo OK
grep -c 'q.isOther = true' main.js   # 预期 1
# 确认没误改兄弟类：这两个类的 auto-focus 应仍在
python3 -c "s=open('main.js').read(); ep=s[s.find('var InlineExitPlanMode = class {'):]; print('ExitPlan autofocus kept:', ep.count('input.focus();'))"   # 预期 >0
```

**实机**（重启 Obsidian / 重载插件后）：
1. 让 Claude 用 `AskUserQuestion` 问一个带选项的问题（例如指令里明确要求"用 AskUserQuestion 问我，给几个选项"）
2. **预期**：选项列表底部出现 "Other" 自定义输入行（修复前没有）
3. 键盘 ArrowDown 到 "Other" 行 → 按 Enter → **预期**：光标进入输入框、可打字（修复前 Enter 会直接跳走）
4. 输入框内按 ArrowUp → **预期**：焦点回到上一个选项（修复前被吞）
5. 打字后按 Enter → **预期**：提交该自定义文本作为回答，进入下一题/提交
6. Esc → 正常取消，无残留（与既有 attention patch 的 cancel 路径兼容——AskUserQuestion 也是 begin/endAttention 的触发源，确认橙色状态正常消退）

## 关联

- 升级价值评估：[[2026-08-09-claudian升级价值评估]]
- attention 方案：[[2026-08-06-claudian标题栏等待回答状态颜色方案]]
- review 第5色方案：[[2026-08-07-claudian待查看状态第5色方案]]
- 上游 commit： https://github.com/YishenTu/claudian/commit/be722e20
