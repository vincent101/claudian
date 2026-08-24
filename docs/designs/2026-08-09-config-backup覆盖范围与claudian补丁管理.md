---
type: design-decision
status: draft
target: "[[tools/config_backup]]"
tags:
  - architect
  - config-backup
  - claudian
  - obsidian
created: 2026-08-09
---

# config_backup 覆盖范围核查 & Claudian 补丁管理

## 背景与问题

近期给 Claudian 插件 bundle（main.js/styles.css）和 Obsidian/Claude Code 配置打了一批补丁，其中 main.js 补丁最怕插件升级被官方覆盖。核查 `tools/config_backup/` 的三通道（git / 备份包 / git 软链）能否兜住这些补丁，并对未覆盖项给出补全方案。

## 方案设计

### 一、覆盖判定表（逐项对照）

| 补丁项 | git 通道 | 备份包通道 | 判定 |
|---|---|---|---|
| claudian/main.js（含历次 patch） | ✅ 已追踪，patch 有独立 commit（4e56e43d、2c156cec） | ❌ **硬排除**（backup.sh:659 `[[ "$name" == "claudian" ]] && continue`） | **覆盖（仅靠 git）** |
| claudian/styles.css + `.bak-before-*` | ✅ 已追踪 | ❌ 同上 | 覆盖（仅靠 git） |
| claudian/data.json | ✅ 已追踪（当前有未提交修改） | ❌ 同上 | 覆盖（仅靠 git） |
| `.obsidian/community-plugins.json` | ✅ | ✅ `obsidian.plugins_meta=on` | 双通道覆盖 |
| `.obsidian/workspace*.json` | ❌ gitignore | ❌ `obsidian.workspace=off` | **未覆盖（有意设计，机器相关）** |
| vault `.claude/settings.json` / `.mcp.json` / skills / agents | ✅ 已追踪 | ❌ `claude.project=off`（有意，归 git） | 覆盖（仅靠 git） |
| `~/.claude/settings.json`（token） | ❌ vault 外 | ✅ `claude.global.settings=on` | **名义覆盖，实际裸奔（见风险1）** |
| `~/.claude/plugins/installed_plugins.json` | ❌ | ⚠️ 文件本身不备，但备份时蒸馏为各 marketplace 的 `_plugins.json`；context7 条目删除 = 不存在 → 恢复时不会重装 → 语义等价 | **部分覆盖**（够用） |
| `~/.claude/plugins/cache/`（context7 缓存已删） | ❌ | ❌ 有意不备（运行时缓存，重装再生）；删除属负向操作，无需还原 | N/A |
| tools/ 脚本（video-downloader、model_proxy） | ✅ 已追踪 | — | 覆盖 |
| `.claudian/claudian-settings.json` | ✅ | ✅ `claudian.settings=on` | 双通道覆盖 |
| `.claudian/sessions/` | ❌ gitignore | ❌ `claudian.sessions=off` | 未覆盖（有意设计） |

### 二、补全建议

1. **（最高优先）当前磁盘没有任何备份包**。日志显示 2026-08-07 10:33 launchd 成功跑出三类 tar.gz，但现已全部消失（从未进 git、无删除记录，疑手动清理）。`~/.claude` 的 token/settings 目前**无还原点**。立即手动 `bash tools/config_backup/config_backup.sh backup -y`，并查清包为何消失（若是为仓库瘦身手动删的，需重新定义"备份包进 git"的契约，README 与此矛盾）。
2. **claudian bundle 建议仍走 git，不进备份包**（3.7MB minified，备份包留 2 份 = 每轮 +7MB 仓库膨胀，git 已有完整历史，重复备份性价比低）。但需订正两处名不副实：
   - `backup.sh:797` 注释"插件本体已由 backup_obsidian 的 obsidian.plugins 节处理"与现实相反（实际被硬排除）；
   - `backup_claudian` 只备 `.claudian/` 运行时，建议改名或在 README 明确"claudian 插件本体归 git 通道"。
3. **`.bak-before-*` 系列建议移出 git**（8 个 main.js 备份 ≈ 29MB，且每次 patch 继续累积）。这些是"打补丁前的官方原版"，还原价值低（官方原版可由插件重装获得），真正要保的是 patch 本身（见下节）。移出方式：加入 .gitignore + `git rm --cached`，历史留存不清（或结合 [[2026-08-09-vault-git仓库瘦身方案]] 一并处理）。
4. **workspace.json 维持不覆盖**（布局状态机器相关，丢了重排即可），无需动作。

### 三、Claudian bundle 补丁的更优管理（核心）

**现状结构性缺陷**：补丁直接打在 3.7MB minified bundle 上，靠"整个 main.js + 全量 .bak"保存。插件升级时官方新 main.js 覆盖 → 只能整文件回滚到旧版 → **丢官方新版的所有修复**；补丁知识散落在 git commit 和 .bak 对比里，重放靠人肉 diff。

三方案对比：

| 方案 | 做法 | 利 | 弊 |
|---|---|---|---|
| A. 维持现状 | git 全量历史 + .bak | 零额外成本，已在跑 | 升级后手工重打全部补丁；意图不显式；git 持续膨胀 |
| **B. patch 单元化 + apply 脚本（推荐）** | 每个补丁沉淀为独立"锚点替换"脚本（非 unified diff——minified 后行号/上下文极脆弱，用精确子串锚点 search→replace，幂等校验、锚点失效即报错）；存 `tools/claudian_patches/<slug>.{md,patch.js}` + `apply_all.sh`；升级后跑一遍，失效锚点一目了然 | 补丁意图显式、可重放、升级后只修失效项；.bak 可退役 | 首次整理需把现有 6+ 个 patch 逆向成锚点脚本（每个约半小时）；写锚点要纪律（锚串须带足够上下文防误匹配） |
| C. vendored fork | fork claudian 源码仓库，patch 作为 commit，升级 = merge upstream | 最严谨，有真正版本管理 | claudian 是否开源可得未验证；patch 目前打在构建产物上，反推源码成本高；重 |

**推荐 B**。配套动作：
- `manifest.json` 的 version 字段可作为"插件已升级"检测信号：升级后 version 变化 → 提示需重放 `apply_all.sh`（可做进 SessionStart hook 或仅写进 checklist）。
- apply 脚本设计要点：每个 patch 独立函数、`--check` 模式（只验锚点是否存在不改文件）、应用前自动留一次性 .bak（不再进 git）。
- 已 confirmed 的 patch 设计记录（如标题自动刷新 v3）是逆向锚点脚本的依据，整理时对照 [[2026-08-09-claudian标题自动刷新patch]] 等文档。

## 风险与权衡

- **风险1（已暴露）**：备份包全消失 + launchd 周一才跑 = `~/.claude` 当前无还原点。若接受"备份包不进 git"的新契约，则 token 级灾难恢复能力实际丧失，需用户明确取舍。
- **风险2**：方案 B 的锚点替换对 minified bundle 并非免疫——官方重构后锚点照样失效。它解决的是"补丁显式化 + 可重放 + 部分失效可定位"，不解决"永远不失效"。
- **风险3**：.bak 移出 git 后，历史 patch 的"前态"只能从 git 历史找，不再随工作区可见。整理锚点脚本之前不要删。
- **待用户确认**：① 备份包消失的契约问题（补进 git or 接受本地不留）；② 是否启动方案 B 的 patch 逆向整理（一次性成本约半天）；③ workspace/sessions 不覆盖维持确认。

## 验证方式

1. 立即跑一次 `bash tools/config_backup/config_backup.sh backup -y`，`inspect` 确认 tar.gz 落盘且含 `~/.claude/settings.json`。
2. 覆盖判定表复核：`bash tools/config_backup/config_backup.sh policy list` 对照本表逐条核对。
3. 方案 B 落地后：人为升级（或重装）claudian → 跑 `apply_all.sh --check` → 全部锚点命中 → apply → Obsidian 内验证各 patch 行为（标题刷新、hook 诊断日志、配色）。
4. `git ls-files .obsidian/plugins/claudian/` 确认 `.bak-before-*` 已移出追踪。

## 关联

- [[2026-08-09-vault-git仓库瘦身方案]]
- [[2026-08-09-obsidian-git只同步手写文档-嵌套repo隔离理想架构]]
- [[2026-08-09-context7-remote-http-migration]]
- [[tools/config_backup/README]]
