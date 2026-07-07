# 操作铁律（按需加载，不进 AGENTS.md 前缀）

> 📖 本文件由 `AGENTS.md` 入口指针表引用。所有「操作流程类」规范集中于此，避免污染缓存前缀。
> 版本号单一可信源：**`dts/manifest.json`** 的 `version` 字段。

---

## 1. 版本号机制

每轮回答结束时输出（无额外说明）：

```
> 📦 v<dts/manifest.json 中 version> @ <当前 commit hash 前 7 位>
```

读取方式（**只在需要输出版本号时即时读一次，不每轮读**）：

```bash
grep '"version"' dts/manifest.json | head -1
```

---

## 2. 自动 git 提交推送

- **修改前**：检查工作树是否干净；脏则先 `git stash` 或暂存。
- **修改完成后**：立即 `git add <明确目标文件>` + `commit` + `push`。
- **commit message 格式**：`<类型>(<范围>): <描述>`
  - 示例：`feat(cdp-inject): 创建技能并同步档案`、`fix(login): 修复透视王白屏问题`
- **不提交**：API key / `.env` / `memory/config.json` / `*.sqlite` / `private/` / `*-unpacked/` / `output/` / `.playwright-cli/` / `screenshots/`。
- **禁止裸 `git add -A`**：会误提 `output/`、`screenshots/`、临时探索脚本。提交前必须 `git status`，只 `git add <明确目标文件>`。
  - 教训：commit `cd3e51c` 曾误提 100+ 张 playwright 探索截图，已 revert。

---

## 3. 浏览器验证（CDP-inject，禁止幻觉）

所有代码修改、配置变更完成后，必须打开浏览器目标页面验证效果，才能声称完成。

```bash
# 1. 检查 CDP 端口
node ~/.zcode/skills/cdp-inject/scripts/check-port.mjs

# 2. 导航到受影响的页面
osascript -e 'tell application "Google Chrome" to set URL of active tab of front window to "https://<目标网址>"'

# 3. 注入 JS 提取数据，确认修改生效
node ~/.zcode/skills/cdp-inject/scripts/extract-json.mjs '
(() => {
  // 提取验证修改的关键指标
  return JSON.stringify({...}, null, 2);
})()
'
```

- CDP 端口不可用 → `node ~/.zcode/skills/cdp-inject/scripts/restart-chrome.mjs`
- 页面需要登录 → 等待用户扫码完成再验证
- **不截图、不依赖视觉识别** — 只认 CDP 注入的精确 JSON

---

## 4. 改代码前的「三确认」铁律

**背景**：2026-06-25 曾把针对「店透视」(`dts/`) 的改动全部错写到「透视王 5.1.65」(`透视王-Chrome_5.1.65-unpacked/`)。实际运行的扩展是 `dts/`，5.1.65 是另一个独立旧扩展、从未被加载。改了等于白改 + 把旧版本改坏。

每次开始改代码**之前**，必须执行三确认，缺一不可：

### 4.1 确认「这个扩展从哪个目录加载」

打开 Chrome → 扩展程序 → 找到目标扩展 → 看「加载来源」字段。**只信这个字段，不信推测**。

- 看到「加载来源：`~/.../dts`」→ 只能改 `dts/`
- 看到「加载来源：`~/.../透视王-Chrome_xxx-unpacked`」→ 才能改那个 unpacked 目录

> 本仓库状态：**店透视** 走 `dts/`（运行中），**透视王 5.1.6x** 走 `透视王-Chrome_5.1.6x-unpacked/`（独立旧扩展，实际未跑）。

### 4.2 确认「目标目录里有这个文件」

```bash
ls -la <目标目录>/<要改的文件>
```

文件不存在就**先问用户**，不要自己猜路径、不要扫到哪个同名文件就改哪个。本仓库存在多个相似目录（多个 `*-unpacked/` + `dts/`），同名文件一堆。

### 4.3 确认「改动会被 git 追踪 / 或明确告知用户改动不进 git」

```bash
git check-ignore <要改的文件>   # 有输出 = 被 .gitignore 排除，不会进版本控制
```

- `.gitignore` 排除了 `*-unpacked/` 整族目录 → 改 `透视王-Chrome_*-unpacked/` 不会进 git
- 改 `dts/` 会进 git
- 改动不进 git 时，**必须显式告诉用户**「这个改动只在磁盘，不进版本控制」

---

## 5. 自动记忆纪律（强制）

### 5.1 解决非平凡问题后必须写记忆

每次解决一个**非平凡问题**（踩坑、调试成功、架构决策、新术语、工具配置跑通），**立即**追加到对应记忆文件，不等用户催：

| 问题类型 | 写到哪 | 触发时机 |
| --- | --- | --- |
| 踩坑 / bug / 失败 → 修复 | `memory/mistakes.md` | 排查超过 2 步、或绕了弯路 |
| 架构决策 / 技术选型 / 流程定型 | `memory/decisions.md` | 做了「选 A 不选 B」的判断 |
| 新术语 / 缩写 / 项目黑话 | `memory/glossary.md` | 遇到第一次见的概念 |

格式参照各文件现有条目（`- [YYYY-MM-DD] 现象 → 根因 → 修复/规避`，决策文件用 `## [日期] 标题 + 背景/决策/理由/影响/撤销条件`）。**追加式，不删改历史条目**。

### 5.2 改记忆文件前的分支确认

记忆文件改动**必须最终落到 `main` 分支**。改之前先确认：

```bash
git branch --show-current  # 必须在 main，或改完 merge 到 main
```

**绝不**让记忆只活在一个特性分支里——分支删了记忆就丢。教训见 `memory/decisions.md`「记忆只在子分支、main 没有记忆」。

### 5.3 记忆跟着代码一起备份

记忆文件改动后，和代码一起 `git add` + `commit` + `push`（origin = `zhangsugang/daima`）。备份网址 https://github.com/zhangsugang/daima。

### 5.4 判断「非平凡」的阈值

- 超过 2 步才解决的问题 → 写
- 绕了弯路、做错方向再纠正 → 写（教训比成功更值钱）
- 改了配置/权限/凭证/远程仓库 → 写
- 纯打字、改 typo、读文件 → **不写**
