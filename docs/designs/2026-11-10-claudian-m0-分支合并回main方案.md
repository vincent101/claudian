---
type: design-decision
status: confirmed
target: "[[tools/claudian]]"
tags:
  - architect
  - claudian
  - git-merge
  - release
---

# M0：fix/model-identity-sorting 合并回 main 方案

## 背景与问题

fix/model-identity-sorting 上沉淀了 37 个 main 没有的 commit（24 个历史主线 + 11 个今日收口线 + 2 个 MCP 对齐线），且 MCP 线仍有实施 agent 在途（工作区 8 改 1 增未提交）。需设计合并形态、上游关系、时序、版本与回滚，产出可交付部署的 main。

## Git 实况核查（2026-11-10，均为实测）

- **main = origin/main = 1ab2ab831**（本地与远程同步，0 差异）。merge-base(main, fix/model-identity-sorting) = 1ab2ab831 即 main HEAD 本身 → 分支严格领先 main 37 commit，**可 fast-forward，无冲突可能**。
- 分支结构（线性）：main → 24 个旧 commit（至基线 cf47730d2）→ 11 个收口线 commit（c1331b2ea…fd30a3ff4）→ 2 个 MCP 线 commit（ae25ec0e6、72f98c187）→ 工作区未提交 MCP 增量。
- 收口线 diff vs main：199 文件，+51801/−2854。MCP 线 diff vs fd30a3ff4：95 文件，+959/−6826（净删内置 MCP 管理，与上游 #1084 同区域不同实现）。
- **上游解耦已是事实**：merge-base(main, upstream/main) = 043b0d87f（2.0.11，2026-05-05）；fork 独有 230 commit，upstream 独有 1050 commit；版本谱系分叉（fork 3.2.8 vs upstream 2.3.41）。
- manifest：main 与分支 tip 均为 3.2.8。tag 惯例：裸版本号（2.3.6…2.3.9）、backup-0824。分支未推过 origin（仅本地存在）。
- 主工作区 dirty（MCP agent 在途）→ **任何 merge 不得在主工作区 checkout/stash**。

## 方案设计

### 1. 合并形态：merge --no-ff，保留全部细粒度 commit

推荐 **--no-ff 全量保留**（merge 1 收口线 11 commit、merge 2 MCP 线后续 commit，各自成 merge commit）。
- commit message 是设计决策与已知偏离的审计载体（R2/T1/H-P8、#1482 四档、W0-W4d 等），squash 即销毁。
- 细粒度 commit 保留 bisect 与对上游单 PR cherry-pick（#1482 已示范）的能力；squash 后该能力不可逆丧失。
- 37 commit 对 main 可读性：fork 本已 230 commit 独立演进史，增量可接受。
- 分组 squash：需人工按主题切分 199 文件 diff，错组即造伪史，否决。

### 2. 上游关系：自主演进 + 单 PR cherry-pick

推荐**与 upstream/main 结构性解耦**：不把 upstream/main 合入 main（1050 commit、#1084 净删 MCP 与我们刚做完的 MCP 对齐线同区域结构性冲突、版本谱系已分叉）；upstream 保留为只读参考，未来按 PR 粒度评估 cherry-pick（沿用 #1482 模式）。已知代价：上游大改不再自动跟进，需人工盯 upstream release。

### 3. 时序：两次 merge，收口线先行（不等 MCP 线）

- **merge 1（立即）**：main 合入 fd30a3ff4（收口线终点，含 11 commit），树 ≡ fd30a3ff4，MCP 改动零混入，独立可部署。
- **merge 2（MCP 线收口后）**：main 合入 fix/model-identity-sorting tip，manifest 冲突解到 3.3.0。
- 理由：用户在等部署产物；两次 merge 各自可独立 revert（-m 1 只回本线）。
- 执行环境：临时 git worktree（主工作区 dirty 且属在途 agent，禁 checkout/stash）。qw 属 vault 仓工具，此处不适用，用原生 `git worktree`。

### 4. 版本与发布

- merge 1 后单独 bump commit：manifest.json + package.json → **3.2.9**，tag `3.2.9`（沿裸版本号惯例）。
- merge 2 后 bump **3.3.0**（MCP 管理面移除属行为变更，占 minor 位），tag `3.3.0`。
- 3.2.9 vs 收口线也含 feature 的严格 semver 争议：私有 fork 部署记账为主，patch 位可用；若用户坚持 semver 严格则改 3.3.0/3.4.0，见裁决点。

### 5. 远程操作边界（须用户逐项授权，默认不执行）

1. `git push origin main`（merge 1 后）
2. `git push origin 3.2.9`（tag）
3. merge 2 后 `git push origin main 3.3.0`
4. 可选：推送 feature 分支本身（分支现仅本地，不推则 merge 后其历史已由 main 承载，可不推）

### 6. 回滚预案

| 状态 | 操作 | 说明 |
|---|---|---|
| merge commit 已做、未 push | `git checkout main && git reset --hard 1ab2ab831 && git tag -d 3.2.9` | solo 仓无人基于其工作，reset 干净 |
| 已 push | `git revert -m 1 <merge-sha>` | merge 1 的 -m 1 回收口线；merge 2 的 -m 1 只回 MCP 线（保留收口线） |
| tag 已 push | `git push origin :refs/tags/3.2.9` | 需单独授权 |

选择依据：push 前历史未公开 → reset；push 后已公开 → revert 保留历史。

### 执行步骤（merge 1，交实施者）

```bash
cd /Users/vincentwang/Documents/NoteVault/tools/claudian
# 禁止在主工作区 checkout/stash（MCP agent 在途）
git worktree add /tmp/claudian-m0 main
cd /tmp/claudian-m0
git merge --no-ff fd30a3ff4 -m "$(cat <<'EOF'
merge: 收口线 11 commits —— takeover R2/T1/H-P8、PersistenceCoordinator(S)、
#1482 permission 四档、W0-W4d command discovery、identity suffix、
size service、i18n literal gate、terminal chain、evidence tests/docs
EOF
)"
# 验证闸门（fresh worktree 无依赖，先符号链接复用主区 node_modules）
ln -s /Users/vincentwang/Documents/NoteVault/tools/claudian/node_modules node_modules
npm run typecheck && npm run lint && npm run test && npm run build
# 全绿后 bump（manifest.json + package.json version → 3.2.9）
rm node_modules   # 先删符号链接再提交，勿让其进 git status
git add manifest.json package.json
git commit -m "chore(release): 3.2.9 (收口线)"
git tag 3.2.9
git worktree remove /tmp/claudian-m0
```

merge 2（MCP 线收口、工作区干净后）：同 worktree 模式（或届时主区已干净可就地），`git merge --no-ff fix/model-identity-sorting`，manifest 冲突解到 3.3.0，跑闸门，bump + tag `3.3.0`。

### 推演小节

- **树等价**〔推算〕：main 为分支祖先 → merge 1 无冲突，合并后 main 树 ≡ fd30a3ff4 树；闸门跑在该等价树上，结论可迁移。若 fd30a3ff4 当时未跑过全量 gate，此闸门即首次关账，属方案要求而非风险。
- **时序/并发**〔推演〕：MCP agent 的 dirty 文件若被误 checkout，git 会因覆盖未提交改动而拒绝（fail-fast），但仍明文禁令 + worktree 隔离双保险。
- **revert 坑位**〔推演〕：merge 2 回滚若误用 `-m 2` 会连同收口线一起回退——步骤里固定写 `-m 1`。
- **上游解耦论证反例**：若上游出关键安全修复，cherry-pick 单 PR 仍可行（解耦不阻断）；但若未来想恢复全量 merge upstream，成本只升不降（1050+ commit 且 MCP 区域结构性冲突）——此为解耦的不可逆代价，知情接受。

## 风险与权衡

- node_modules 符号链接跑测试的理论偏差（原生模块/路径敏感）：gate 异常即回退为 `npm ci` 重装，宁慢勿假绿。
- 上游解耦后跟进靠人工：建议每次 upstream release 扫一眼 changelog 决定是否 cherry-pick（流程化沉淀，暂不强制）。
- 临时 worktree 残留：收尾 `--force` 移除 + `git worktree prune`。
- main 无 CI 流水线，每次 merge 靠手动闸门，靠本清单约束。

## 用户裁决点

1. 收口线版本号：3.2.9（推荐）vs 严格 semver 的 3.3.0。
2. 上游"自主演进 + cherry-pick"策略确认（意味着放弃未来低成本全量 merge upstream）。
3. push 授权：上述第 5 节 4 项逐项确认。
4. merge 2 后是否删除 feature 分支与 `-baseline` 书签分支。

## 验证方式

- `git log --graph --oneline -5 main`：merge commit 双父、--no-ff 成形。
- bump 前 `git diff fd30a3ff4 main --stat` 应为空；bump 后仅 manifest.json/package.json 两文件。
- 闸门四件套全绿；`git tag --list '3.*'` 见 3.2.9。
- 人工核对 merge commit message 覆盖收口线各主题。

## 关联

- [[2026-11-09-claudian-两线遗留现状核查与收口方案]]
- [[2026-11-09-provider-native-mcp-alignment]]
- [[2026-11-09-upstream-1482-claude-permission-port]]
