# 店铺报表真实店铺日报 V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在店透视浮窗的“店铺报表”里，按用户当前选择的日期范围，逐日展示当前登录拼多多店铺的推广费用、ROI、保本 ROI、费比、净利润率和净利润额；这些指标只使用慧经营“多维利润分析 > 更多店铺展示/按店铺展示”里已经核算好的真实店铺费用和真实净利。

**Architecture:** 以慧经营店铺维度导出作为唯一权威利润数据源，SQLite 分开保存“慧经营真实店铺日报”和“拼多多推广参考数据”，两者禁止互相覆盖。店透视浮窗使用 `mallId` 查询已确认映射，再读取慧经营日报；映射只使用当前商品列表中已命中慧经营数据的商品 ID 集合，绝不使用店名模糊匹配或“随便取第一家店”的回退逻辑。

**Tech Stack:** Chrome MV3 extension、`dts/source/pdd-enhancer.js`、Node.js ESM、CDP Chrome、SQLite (`better-sqlite3`)、本地 HTTP 服务、慧经营店铺维度 XLSX 导出、拼多多推广页面现有 `queryEntityReport` 数据仅作可选校验。

## Global Constraints

- 这是审核计划，不是直接执行清单。未经过用户确认前，不要继续跑下载脚本、不要改主分支、不要推送新实现。
- 扩展运行目录必须是 `dts/`。改代码前按 `docs/OPERATIONS.md` 做加载来源、文件存在和 Git 跟踪三确认。
- 只允许改店透视浮窗的“店铺报表”页签。商品列表和浮窗另外 3 个页签不得增加、删除、重排、着色或写入 DOM。
- 本计划所有“真实费用口径”要求只适用于新增的整店铺日报数据；以前单个商品数据、商品列表利润列、商品级原始净利/调整净利逻辑一律不改。
- 现在已有绿色 `huice-*` 列和紫色 `huice-shop-*` 列不强制删除。除非实施者已经拿到“店铺报表”的唯一运行时标识，并能证明删除只影响店铺报表，否则保留旧列，只补齐本计划的新店铺报表数据。
- 保留店铺报表原有日期选项：昨天、近 7 日、近 1 月、自定义。默认可以是近 7 日，但实现不能写死 7 天；必须按当前页面实际选择范围逐日展示。
- 不展示今天的未完整数据，除非用户明确选择今天且产品已有一致口径。默认日报只使用完整过去日期。
- 店铺报表口径必须使用慧经营“按店铺展示”导出的真实店铺数据。不要再用 `1.15/单`、`2% 平台费`、`2.85` 或任何估算费用重算店铺净利。
- 慧经营店铺导出里已经包含人工费、推广费、平台费等真实费用时，必须直接保存原始字段和原始行 JSON，展示指标从这些真实字段计算或直接读取。
- 商品级旧口径中“销售件数就是订单数”和 `1.15/单` 只适用于之前商品利润逻辑；本计划的新增店铺数据不得套用该口径，也不得反向修改商品级逻辑。
- 多日聚合时，比例类指标必须用汇总后的分子/分母重算，不能平均每日比例、不能平均商品 ROI。
- 净利润率：优先使用慧经营导出的店铺净利润率；缺失时用 `慧经营店铺净利润 / 慧经营店铺销售收入` 重算。保本 ROI：`1 / 净利润率`；净利润率小于等于 0 或缺失时显示 `--`。
- 推广费比：优先使用慧经营导出的推广费比；缺失时用 `慧经营店铺推广费用 / 慧经营店铺销售收入` 重算。
- ROI：优先使用慧经营导出的店铺 ROI；缺失时用 `慧经营店铺销售收入 / 慧经营店铺推广费用` 重算；推广费用为 0 或缺失时显示 `--`。
- 只收集商品列表里“已经能显示毛利率、净利率等慧经营数据”的商品 ID。不要把商品列表全部商品 ID 都扫一遍。
- XLSX、SQLite、下载缓存、30 天回采数据和登录态只允许存在于已忽略的 `private/`、`output/`，不得提交。
- HTTP 服务继续只监听 `127.0.0.1`。缺数、接口失败和映射不唯一都显示 `--` 或待确认状态，禁止用 0 猜测。
- 本计划以最新 `origin/main` 为实施基线；截至本次审核，基线提交为 `d933b03`。实施者必须先更新 `main`，不得从旧计划分支直接继续写业务代码。
- `shop_daily_profit` 只能由慧经营店铺导出写入。`tools/pdd-promo-cdp.mjs` 不得 `UPDATE shop_daily_profit`，拼多多推广数据必须进入独立参考表。
- `GET /shop-profit` 必须以 `mallId` 的已确认映射为唯一入口。禁止根据 `pddShopName` 做 `LIKE`、截取前两个字、`LIMIT 1` 或日期范围内第一家拼多多店铺回退。

## 展示定义

店铺报表新增数据以“逐日行”展示。每行字段顺序：

```text
日期 | 推广费用 | ROI | 保本 ROI | 费比 | 净利润率 | 净利润额
```

- 金额显示 `¥1,234.56`。
- ROI 和保本 ROI 显示两位小数。
- 费比、净利润率显示两位百分比。
- 慧经营真实净利润小于 0 时，整行标红，不只是净利润额标红。
- 慧经营当天推广费为 0：推广费用 `¥0.00`、费比 `0.00%`、ROI `--`。
- 慧经营当天缺少推广费字段：推广费用、ROI、费比显示 `--`，并保留原始行 JSON 供排查；当前任务不得用拼多多推广页静默补字段。
- 慧经营当天无该店铺数据：净利润额、净利润率、保本 ROI、推广费用、ROI、费比均为 `--`。
- 昨天显示 1 行，近 7 日显示 7 行，近 1 月显示完整日期范围内每日一行，自定义日期按实际起止日期显示。

## 当前代码事实

- 最新 `main` 已经包含 `scripts/huice/lib/shop-profit.mjs`、`tools/huice-shop-export-cdp.mjs`、`shop_daily_profit`、`pdd_shop_mapping` 和店铺报表面板。因此下面各任务是修复和加固现有实现，不是重新创建同名模块。
- `dts/source/pdd-enhancer.js` 目前已经有商品利润列、店铺汇总列、商品 ID 抽取、慧经营数据读取、拼多多推广数据读取等逻辑。新功能优先复用商品 ID 抽取和本地服务读取能力，不要另写一套页面探测。
- 当前源码里没有稳定的“店铺报表”字符串和唯一页签 key。页面截图里用户叫它“店铺报表”，源码里此前很多逻辑实际插到了通用弹窗表格。必须先确认运行时页签标识，再动 UI。
- `tools/huice-export-cdp.mjs` 已有商品维度的日期切换、查询、下载中心、失败日期机制。店铺维度导出可以复用思路，但不能把店铺数据写进商品表。
- `scripts/huice/lib/db.mjs` 已有商品利润、店铺日报和店铺映射相关表。本次要保持旧表兼容，并新增独立的拼多多推广参考表。店铺日表只保存慧经营真实字段，不保存估算后的“调整净利”。
- 过去已经出现过主仓库误包含 30 天回采数据的问题。之后所有真实数据文件必须被 `.gitignore` 挡住，并在提交前用 `git status --ignored` 检查。

## 最新 main 审核发现（必须先修）

以下问题来自对 `origin/main@d933b03` 的完整代码审核。现有 15 项测试虽然通过，但实际上只覆盖 3 个纯函数模块，没有覆盖 SQLite、本地 HTTP 服务、两个下载器、安装脚本和浮窗运行流程。以下任一 P0/P1 未修复，都不能认为本功能完成。

1. **P0：店铺可能匹配错。** `dts/source/pdd-enhancer.js` 当前请求 `/shop-profit` 时只传 `pddShopName`；`tools/huice-server.mjs` 会截取店名片段后用 `LIKE ... LIMIT 1`，失败时还会取日期范围内第一家拼多多店铺。这会把甲店利润展示到乙店。
2. **P0：拼多多推广费覆盖了慧经营真实字段。** `tools/pdd-promo-cdp.mjs` 当前直接更新 `shop_daily_profit.promo_spend/roi`，服务端再用被覆盖后的值重算费比和 ROI。这违反“新增整店铺数据以慧经营真实费用为准”的确认口径。
3. **P1：下载中心可能拿错文件。** `tools/huice-shop-export-cdp.mjs` 当前倾向点击第一条可下载记录，并主要用日期复核。若下载中心同时存在同一天的商品报表或旧店铺报表，可能导入错误文件。
4. **P1：UI 范围保护和回归测试不足。** 当前主要依赖弹窗标题包含“店铺报表”。必须补充唯一页签/根节点判断，并测试商品列表和另外 3 个页签不会被写入。
5. **P0：Excel 数值型百分比会缩小 100 倍。** `openpyxl` 可能把 Excel 的 12.5% 读成数值 `0.125`，现有 `toPercent()` 和商品导出器仍无条件除以 100，结果会变成 `0.00125`，保本 ROI 会从 8 变成 800。
6. **P0：商品和店铺下载都可能把错误文件写进目标日期。** 商品下载器直接取下载中心第一行且不校验文件日期；店铺下载器点击第一个“下载”。必须同时校验任务类型、请求时间、状态、工作簿表头和日期。
7. **P1：本地服务可被任意网页读取。** 当前返回 `Access-Control-Allow-Origin: *`，访问任意恶意网页时都可能被读取本地经营数据；同时允许方法只有 `GET, OPTIONS`，实际 `POST /shop-mapping/*` 的浏览器预检会失败。
8. **P1：相同日期切换店铺可能残留上一家数据。** 店铺日报面板的幂等 key 只有日期范围，没有 `mallId`；异步请求也没有取消或请求序号，慢请求可能把甲店结果写到乙店面板。
9. **P1：单页商品报表可能无法汇总。** `collectMatchedReportRecords()` 要求分页器、上一页和下一页全部存在；只有一页且没有分页器时会直接失败。
10. **P1：多日店铺采集只在第一天选店铺。** 每天都会从下载中心返回慧经营页面，但代码只在 `i === 0` 时筛选“拼”并全选；筛选失败也只打印日志继续执行，可能混入其他平台店铺。
11. **P1：失败会被误报成功。** XLSX 解析 0 行、SQLite 入库失败、下载按钮没找到等情况没有统一写入失败日期或返回非零退出码，定时任务可能继续使用旧数据。
12. **P1：Windows 和新机器部署不完整。** Windows 每日任务没有店铺采集，服务计划任务使用了新进程里不存在的 `$SCRIPT_DIR`；安装脚本也没有验证 `python3 + openpyxl`。
13. **P2：日期、CDP 和 HTML 仍有稳定性问题。** 多处用 UTC `toISOString()` 计算中国自然日；CDP 成功后 timeout 未清理；店铺名和错误消息直接拼入 `innerHTML`。

修复后的不可退让结果：

```text
mallId -> confirmed pdd_shop_mapping -> huice_shop_id -> shop_daily_profit
```

任何情况下都不能走：

```text
pddShopName 模糊匹配 -> LIMIT 1
没有映射 -> 日期范围内第一家店
PDD 推广采集 -> UPDATE shop_daily_profit
下载中心 -> 第一条“下载”
Excel 数值 0.125 -> 再除以 100
只按日期复用店铺面板
任意 Origin -> 读取本地利润接口
采集失败 -> 仍以退出码 0 结束
```

## 这次已经踩过的坑

实施者必须先读这一节，避免重复踩坑。

1. **不要固定 7 天。** 用户最后确认要保留昨天、近 7 日、近 1 月、自定义这些原有选项；实现必须读当前选项。
2. **不要上来就删绿色/紫色列。** 源码没有稳定标识能证明只删店铺报表。删错会影响商品列表或其他页签。能精准定位再删，否则只补齐。
3. **不要扫描全店所有商品 ID。** 商品报表里很多商品没卖过，数据库没有 ID。只用已经命中慧经营利润数据的商品 ID 做店铺映射。
4. **不要用店名字符串硬匹配。** 拼多多店铺名和慧经营店铺名不完全一致，必须用商品 ID 反查慧经营店铺候选。
5. **不要在店铺报表里套商品级估算公式。** 慧经营按店铺展示里已经有真实人工费、推广费、平台费等费用，店铺净利必须以这些真实数据为准。
6. **不要用 `1.15`、`2%` 或 `2.85` 重算店铺净利。** 这些都不是本次店铺报表的主口径。
7. **不要平均比例。** 净利润率、费比、ROI 都用总分子/总分母重算；如果慧经营直接导出了比例，单日展示可直接使用，多日汇总必须重算。
8. **不要把新店铺口径反套到商品数据。** 以前单个商品的数据、商品列表上的真列和历史商品逻辑保持原状。
9. **慧经营店铺选择框里有两个输入框。** 第一个 `placeholder="请选择"` 是只读显示框，不是搜索框；真正输入 `拼` 的是弹层里的 `input[placeholder="搜索店铺"]:not([readonly])`。
10. **选择全部店铺后要等列表过滤完成。** 不能输入 `拼` 后立刻点全选；要等可见店铺名全部以 `拼` 开头，再点 `全部`。
11. **慧经营“全部”不是普通按钮。** 它是 `label.el-checkbox`，需要检查 `is-checked`；如果已经勾上，不要重复点成取消。
12. **慧经营确认按钮是弹层里的 `.confirm`。** 不能点页面上的查询按钮误认为确认。
13. **慧经营下载图标不是 button。** 实测下载入口是 `.export-icon-container`，里面有 `svg.export`，按 button 查找会找不到。
14. **下载后可能先弹“导出全部链接”确认框。** 这个框的确认按钮文字可能是“确实定”，选择器必须按对话框内容精确限定，不能点页面上第一个蓝色按钮。
15. **之后还会弹“是否分店铺下载”。** 用户要求选择“否”。如果点了“是”，会导出一堆分店铺文件，不符合入库流程。
16. **页面可能同时有多个弹窗。** 例如转向提醒、查询结果导出、导出全部链接。必须按弹窗标题或正文精确匹配。
17. **Codex 浏览器插件和 CDP 9222 可能不是同一个 Chrome 页面。** 用浏览器插件观察到的 DOM 不能直接代表 `tools/*.mjs` 正在控制的目标页。
18. **下载中心匹配不能只靠最新一行。** 应按请求时间之后、文件类型/名称包含“店铺多维度分析”、状态完成来找本次文件。
19. **XLSX 不能按固定列号读。** 慧经营表头很宽，列顺序会变。必须按表头名解析，并保留脱敏 fixture。
20. **CDP 调用要清理 timeout。** 如果 `Runtime.evaluate` 成功后没有 `clearTimeout`，脚本可能看似结束但进程仍挂着。
21. **先跑单日，再跑 30 天。** 不能一上来回采 30 天；必须先用昨天一日验证下载、解析、入库、展示全链路。
22. **百分比必须区分显示值和底层值。** `"12.5%"`、`12.5` 和 Excel 数值 `0.125` 都可能表示 12.5%；解析时必须结合是否带 `%`、数值范围或单元格格式，不能统一除以 100。
23. **单页不能依赖分页器。** 没有分页器时，当前页就是完整结果，应直接返回成功。
24. **面板 key 必须包含店铺。** 至少使用 `mallId + start + end`；切店铺时取消旧请求或丢弃过期响应。
25. **每个采集日期都要重新确认店铺筛选。** 不依赖上一天页面状态；筛选、全选、确认任一步失败都停止当天采集。
26. **本地监听不等于浏览器数据安全。** `127.0.0.1` 仍可被网页跨域请求，必须限制 Origin、允许正确的 POST 预检，并限制请求体和日期范围。
27. **业务日期不能用 UTC 截断。** 所有“昨天/近 7 日/近 30 日”用本地年月日格式化，避免中国时间凌晨 0:00-08:00 错一天。
28. **成功必须有完整证据。** 正确文件、非空有效记录、SQLite 事务成功缺一不可；否则写失败日期并返回非零退出码。

## 数据流

```text
慧经营 trendNew
  经营 > 多维利润分析 > 更多店铺展示
  -> 店铺筛选输入“拼”
  -> 全选全部拼多多店铺
  -> 单日查询
  -> 下载
  -> 弹窗选择“不分店铺下载”
  -> 下载中心拿本次 XLSX
  -> 动态表头解析
  -> shop_daily_profit

当前拼多多商品列表里已命中慧经营利润的商品 ID
  -> productId 反查慧经营 shop_id/shop_name
  -> 唯一候选自动写入 pdd_shop_mapping
  -> 多候选或无候选显示待确认/--

店透视浮窗店铺报表
  -> 读取当前日期选项
  -> GET /shop-profit?mallId=...&start=...&end=...
  -> 本地服务返回慧经营真实店铺费用和真实净利
  -> 拼多多推广参考数据只做独立人工核对，不参与返回值
  -> 店铺报表逐日展示
```

## 文件变更地图

| 文件 | 责任 |
| --- | --- |
| `scripts/huice/lib/shop-profit.mjs` | 修改。保留纯计算，确保全部展示指标以慧经营字段为准。 |
| `scripts/huice/lib/db.mjs` | 修改。保留 `shop_daily_profit`、`pdd_shop_mapping`，新增独立 `pdd_shop_promo_daily` 参考表及查询/upsert API。 |
| `tools/huice-shop-export-cdp.mjs` | 修改。精确选择本次“店铺多维度分析”下载任务，再解析入库。 |
| `tools/pdd-promo-cdp.mjs` | 修改。停止覆盖 `shop_daily_profit`，只写拼多多推广参考表。 |
| `tools/huice-server.mjs` | 修改。`/shop-profit` 只接受 `mallId` 映射查询；删除店名模糊匹配和第一家店回退。 |
| `scripts/huice-daily.sh` | macOS 每日同步中加入店铺日导出。 |
| `scripts/huice-daily.ps1` | Windows 每日同步中加入店铺日导出。 |
| `install.sh` / `install.ps1` | 创建项目私有 Python 环境并验证 `openpyxl`；安装正确的每日任务。 |
| `scripts/start-huice-server.ps1` | 新建。使用确定项目路径启动 Windows 本地服务。 |
| `scripts/start-cdp-chrome.ps1` | 修复 Windows 日志重定向和启动验证。 |
| `scripts/huice/lib/date.mjs` | 新建。Node 采集工具共用中国本地自然日计算。 |
| `dts/source/pdd-enhancer.js` | 只在店铺报表页签读取日期范围并渲染逐日店铺数据；商品列表和其他页签不动。 |
| `test/shop-profit.test.mjs` | 修改。补充真实费用优先、缺失值、亏损与比例计算测试。 |
| `test/shop-profit-db.test.mjs` | 新建。证明拼多多推广参考写入不会改变慧经营日报。 |
| `test/huice-shop-export.test.mjs` | 新建。测试选择器、下载任务精确匹配和错误文件拒绝。 |
| `test/huice-server-shop-profit.test.mjs` | 新建。临时 SQLite 测 `mallId` 查询、映射状态和禁止回退。 |
| `test/huice-export-parser.test.mjs` | 新建。测试商品/店铺百分比、工作簿日期和错误文件拒绝。 |
| `test/date-utils.test.mjs` | 新建。覆盖中国时间凌晨的昨天/日期范围计算。 |
| `README.md` | 修正数据来源和自动任务说明，避免继续宣称拼多多推广费覆盖慧经营。 |
| `docs/OPERATIONS.md` | 追加店铺回采、补采、排错命令，不写真实数据。 |

---

## Task 0: 从最新 main 建立干净实施分支

**Files:**
- Modify: none

**Interfaces:**
- Produces: 一个从最新 `origin/main` 创建、只包含本次修复的干净分支。

- [ ] **Step 1: 确认没有下载脚本还在跑**

Run:

```bash
ps -axo pid,command | rg 'huice-shop-export-cdp|node tools/huice-shop' || true
```

Expected: 只出现本次 `rg` 命令，不能有 `node tools/huice-shop-export-cdp.mjs`。

如果有旧进程，先停止旧进程，再继续：

```bash
kill <pid>
```

- [ ] **Step 2: 更新本地 main**

Run:

```bash
git status --short
git fetch origin
git switch main
git pull --ff-only origin main
```

Expected: 工作区干净，`main` 与 `origin/main` 一致。若 `git status --short` 有用户未提交内容，立即停止，不要 stash、reset 或覆盖。

- [ ] **Step 3: 创建并提前推送实施分支**

Run:

```bash
git switch -c codex/2026-07-10-shop-report-real-huice-v2
git push -u origin HEAD
```

Expected: 后续所有业务代码提交都进入该分支，不直接写 `main`，也不在旧的计划分支上开发。

- [ ] **Step 4: 记录实施基线**

Run:

```bash
git log -1 --oneline --decorate
```

Expected: 能记录朋友实际开始实施时的最新 `main` 提交。若已晚于 `d933b03`，先重新检查本文“最新 main 审核发现”是否仍存在，再按实际代码调整行号，业务约束不变。

- [ ] **Step 5: 确认真实数据不会入 Git**

Run:

```bash
git status --ignored --short private output | sed -n '1,80p'
```

Expected: `private/`、`output/` 下真实数据只出现在 `!!` 忽略项里，不出现在 `??` 或 `M`。

- [ ] **Step 6: 本任务提交策略**

每个任务一个提交。不要把真实 XLSX、SQLite、下载缓存、登录态放入提交。

提交前统一执行：

```bash
git status --short
npm test
npm run check:js
```

---

## Task 1: 先确认店铺报表的唯一 UI 范围

**Files:**
- Modify: `dts/source/pdd-enhancer.js`

**Interfaces:**
- Produces: `getStoreReportContext() -> { root, activeTabText, activeTabKey, tableComp, dataComp } | null`
- Contract: 只有“店铺报表”页签激活时返回对象；商品列表和另外 3 个页签必须返回 `null`。

- [ ] **Step 1: 手工记录 5 个页签**

打开拼多多店铺页面，打开店透视浮窗，记录：

```text
页签文本
Vue active key
页签 DOM class
内容根节点 class
表格组件引用路径
```

验收：能说清楚“店铺报表”和其他 4 个页签在运行时的区别。

- [ ] **Step 2: 加只读探针，不改页面**

在 `dts/source/pdd-enhancer.js` 临时增加只读函数，打印当前浮窗页签上下文：

```js
function inspectDtsReportTabs() {
  const dialogs = [...document.querySelectorAll('.el-dialog__wrapper, .el-dialog')];
  return dialogs.map((dialog) => ({
    text: (dialog.innerText || '').slice(0, 300),
    tabs: [...dialog.querySelectorAll('[role="tab"], .el-tabs__item, .tab-item')]
      .map((tab) => ({
        text: (tab.innerText || '').trim(),
        className: tab.className,
        id: tab.id || '',
        active: /\bis-active\b/.test(tab.className),
      })),
  }));
}
```

只用它找标识。确认后删除临时代码，不提交探针。

- [ ] **Step 3: 写范围守卫**

实现：

```js
const STORE_REPORT_TAB_TEXT = '店铺报表';

function getStoreReportContext() {
  const popup = findDtsFloatingPopup();
  if (!popup) return null;

  const activeTab = readActiveDtsTab(popup);
  if (!activeTab || activeTab.text !== STORE_REPORT_TAB_TEXT) return null;

  const tableComp = findStoreReportTableComponent(popup);
  const dataComp = findStoreReportDataComponent(popup);
  if (!tableComp || !dataComp) return null;

  return {
    root: popup,
    activeTabText: activeTab.text,
    activeTabKey: activeTab.key,
    tableComp,
    dataComp,
  };
}
```

`findDtsFloatingPopup`、`readActiveDtsTab`、`findStoreReportTableComponent` 必须使用 Step 1 的实测结构，不能用无范围的 `document.querySelector('.el-table')`。

- [ ] **Step 4: 验证不会影响其他页签**

手工切换 5 个页签，在控制台验证：

```js
getStoreReportContext()
```

Expected:

```text
店铺报表: object
商品列表: null
另外 3 个页签: null
```

- [ ] **Step 5: 提交**

```bash
git add dts/source/pdd-enhancer.js
git commit -m "refactor(report): scope store report context"
```

---

## Task 2: 建立店铺真实日报解析和数据库模型

**Files:**
- Modify: `scripts/huice/lib/shop-profit.mjs`
- Modify: `scripts/huice/lib/db.mjs`
- Modify: `tools/pdd-promo-cdp.mjs`
- Modify: `tools/huice-export-cdp.mjs`
- Modify: `test/shop-profit.test.mjs`
- Create: `test/shop-profit-db.test.mjs`
- Create: `test/huice-export-parser.test.mjs`

**Interfaces:**
- `normalizeShopExportRow(headers, row, date) -> HuiceShopDailyRecord | null`
- `parseShopExportRows(rows, date) -> ShopDailyRecord[]`
- `buildStoreReportDay({ date, shop }) -> StoreReportDay`
- `resolveShopCandidates(records) -> { status: 'none' | 'unique' | 'ambiguous', candidates: ShopCandidate[] }`

- [ ] **Step 1: 写真实店铺口径测试**

在 `test/shop-profit.test.mjs` 写：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStoreReportDay,
  parseShopExportRows,
  toPercent,
} from '../scripts/huice/lib/shop-profit.mjs';

test('uses Huice real shop net profit without product-level estimated deductions', () => {
  const row = buildStoreReportDay({
    date: '2026-07-09',
    shop: {
      salesAmount: 1000,
      promoSpend: 100,
      netProfit: 125,
      netProfitRate: 0.125,
    },
  });

  assert.equal(row.netProfit, 125);
  assert.equal(row.netProfitRate, 0.125);
  assert.equal(row.breakEvenRoi, 8);
  assert.equal(row.promoFeeRatio, 0.1);
  assert.equal(row.roi, 10);
});

test('marks the whole store day as loss when Huice real net profit is negative', () => {
  const row = buildStoreReportDay({
    date: '2026-07-09',
    shop: { salesAmount: 1000, promoSpend: 100, netProfit: -1 },
  });

  assert.equal(row.breakEvenRoi, null);
  assert.equal(row.isLoss, true);
});

test('parses Huice shop export rows by real header names and skips total rows', () => {
  const rows = [
    ['店铺名称', '一、销售收入', '推广费', '净利润', '净利润率'],
    ['拼【周贝瑞', '1000.00', '100.00', '125.00', '12.50%'],
    ['合计', '9999.00', '999.00', '999.00', '9.99%'],
  ];

  const parsed = parseShopExportRows(rows, '2026-07-09');

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].shopName, '拼【周贝瑞');
  assert.equal(parsed[0].salesAmount, 1000);
  assert.equal(parsed[0].promoSpend, 100);
  assert.equal(parsed[0].netProfit, 125);
  assert.equal(parsed[0].netProfitRate, 0.125);
});

test('normalizes formatted and numeric Excel percentages without dividing twice', () => {
  assert.equal(toPercent('12.50%'), 0.125);
  assert.equal(toPercent(0.125), 0.125);
  assert.equal(toPercent('0.125'), 0.125);
  assert.equal(toPercent(12.5), 0.125);
});

test('keeps break-even ROI at 8 when Excel stores 12.5% as 0.125', () => {
  const [parsed] = parseShopExportRows([
    ['店铺名称', '一、销售收入', '七、运营推广费用', '十二、净利润', '十三、净利润率'],
    ['拼【周贝瑞', 1000, 80, 125, 0.125],
  ], '2026-07-09');
  const day = buildStoreReportDay({ date: parsed.date, shop: parsed });
  assert.equal(parsed.netProfitRate, 0.125);
  assert.equal(day.breakEvenRoi, 8);
});
```

Run:

```bash
npm test -- test/shop-profit.test.mjs
```

Expected: 新增的数值型百分比测试 FAIL；基线会把 `0.125` 解析成 `0.00125`，保本 ROI 得到 `800`。已有真实费用和亏损测试应继续 PASS。

- [ ] **Step 2: 实现真实店铺指标函数**

在 `scripts/huice/lib/shop-profit.mjs` 实现：

```js
export function toNumber(value) {
  if (value == null || value === '' || value === '--') return null;
  const normalized = String(value).replace(/[,%¥,\s]/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toPercent(value) {
  if (value == null || value === '' || value === '--') return null;
  const text = String(value).trim();
  const number = Number(text.replace(/[,%\s]/g, ''));
  if (!Number.isFinite(number)) return null;
  if (text.includes('%')) return number / 100;
  return Math.abs(number) <= 1 ? number : number / 100;
}

export function buildStoreReportDay({ date, shop }) {
  const salesAmount = toNumber(shop?.salesAmount);
  const netProfit = toNumber(shop?.netProfit);
  const promoSpend = toNumber(shop?.promoSpend);
  const exportedNetProfitRate = toNumber(shop?.netProfitRate);
  const exportedPromoFeeRatio = toNumber(shop?.promoFeeRatio);
  const exportedRoi = toNumber(shop?.roi);
  const netProfitRate =
    exportedNetProfitRate ?? (salesAmount && netProfit != null ? netProfit / salesAmount : null);
  const promoFeeRatio =
    exportedPromoFeeRatio ?? (salesAmount && promoSpend != null ? promoSpend / salesAmount : null);
  const roi = exportedRoi ?? (promoSpend ? salesAmount / promoSpend : null);

  return {
    date,
    salesAmount,
    promoSpend,
    roi,
    breakEvenRoi: netProfitRate && netProfitRate > 0 ? 1 / netProfitRate : null,
    promoFeeRatio,
    netProfitRate,
    netProfit,
    isLoss: netProfit != null && netProfit < 0,
  };
}
```

注意：这里没有 `calculateAdjustedShopProfit`，也没有 `1.15/单`、`2% 平台费`。这些不能出现在新增店铺日报模块里。

Run:

```bash
npm test -- test/shop-profit.test.mjs
```

Expected: PASS.

- [ ] **Step 3: 写 XLSX 表头解析测试**

追加：

```js
import { normalizeShopExportRow, parseShopExportRows } from '../scripts/huice/lib/shop-profit.mjs';

test('keeps Huice real expense fields in metricsJson and rawRowJson', () => {
  const rows = [
    ['店铺名称', '一、销售收入', '推广费', '平台费', '人工费', '净利润', '净利润率'],
    ['拼【周贝瑞', '1000.00', '100.00', '20.00', '30.00', '125.00', '12.50%'],
  ];

  const parsed = parseShopExportRows(rows, '2026-07-09');

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].promoSpend, 100);
  assert.equal(parsed[0].platformFee, 20);
  assert.equal(parsed[0].laborFee, 30);
  assert.equal(parsed[0].netProfit, 125);
  assert.equal(parsed[0].metrics.platformFee, 20);
  assert.equal(parsed[0].metrics.laborFee, 30);
  assert.deepEqual(parsed[0].rawRow['人工费'], '30.00');
});
```

- [ ] **Step 4: 实现动态表头解析**

实现要求：

```js
const SHOP_EXPORT_HEADERS = {
  shopName: ['店铺名称'],
  salesAmount: ['一、销售收入', '销售收入', '销售额'],
  promoSpend: ['推广费', '推广费用', '广告费'],
  platformFee: ['平台费', '平台服务费'],
  laborFee: ['人工费', '包装人工', '包装人工费'],
  netProfit: ['净利润', '十一、净利润'],
  netProfitRate: ['净利润率', '净利率'],
  promoFeeRatio: ['推广费比', '费比'],
  roi: ['ROI', '投入产出比'],
};
```

解析规则：

```text
1. 在前 20 行中寻找包含精确“店铺名称”的表头；找不到必须报错，不能默认拿第一行。
2. 通过表头文字找列号，不能用固定列号。
3. 店铺名为空、店铺名为“合计”的行跳过。
4. `netProfit` 缺失时整行保留，但净利润额显示 `--`。
5. `promoSpend` 缺失时推广费用、ROI、费比显示 `--`，不能自动改用拼多多推广页，除非用户单独确认。
6. 所有未显式建列的慧经营费用字段放进 `metricsJson`，`rawRowJson` 保存原始行，方便后续查错。
7. 这些规则只作用于新增店铺日报数据，不影响商品级利润解析和商品列表真列。
8. `"12.5%"`、`12.5`、`0.125` 都要规范化成 `0.125`；测试必须覆盖三种输入。
```

- [ ] **Step 4A: 修复商品导出器的相同百分比错误**

`tools/huice-export-cdp.mjs` 目前 Python 内嵌函数 `pp(v)` 对任何数字都 `/100`。把 XLSX 读取结果改成保留原始数值类型和 `number_format`，或把解析逻辑抽成可测试的 JS 函数；不得继续按固定的“所有百分比都除 100”处理。

在 `test/huice-export-parser.test.mjs` 写：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExcelPercent } from '../tools/huice-export-cdp.mjs';

test('normalizes product report percentage cells', () => {
  assert.equal(normalizeExcelPercent({ value: 0.3191, numberFormat: '0.00%' }), 0.3191);
  assert.equal(normalizeExcelPercent({ value: '31.91%', numberFormat: '' }), 0.3191);
  assert.equal(normalizeExcelPercent({ value: 31.91, numberFormat: '' }), 0.3191);
});
```

Run:

```bash
node --test test/shop-profit.test.mjs test/huice-export-parser.test.mjs
```

Expected: PASS，并确认商品净利润的 `1.15/单 + 2%` 旧公式没有被改动；这里只修复毛利率、退款率、原始净利率的读取。

- [ ] **Step 5: 写 DB 测试**

先让 `scripts/huice/lib/db.mjs` 支持测试数据库路径，同时保持生产默认值不变：

```js
const DEFAULT_DB_PATH = resolve(__dirname, 'private/huice-data.sqlite');
const DB_PATH = process.env.HUICE_DB_PATH
  ? resolve(process.env.HUICE_DB_PATH)
  : DEFAULT_DB_PATH;
```

测试必须在首次 `import db.mjs` 之前设置 `HUICE_DB_PATH`，并在临时目录创建数据库；禁止单元测试触碰真实 `private/huice-data.sqlite`。

在 `test/shop-profit-db.test.mjs` 使用临时 DB：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

test('stores and reads shop daily profit by mall mapping', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'huice-shop-')), 'data.sqlite');
  process.env.HUICE_DB_PATH = dbPath;
  const db = await import('../scripts/huice/lib/db.mjs');

  db.upsertShop('拼【周贝瑞');
  const shop = db.findShopByName('拼【周贝瑞');
  db.upsertPddShopMapping({
    pddMallId: '123',
    pddShopName: '周贝瑞食品专营店',
    huiceShopId: shop.shop_id,
    matchMethod: 'product_id_auto',
    matchedProductCount: 8,
  });
  db.upsertShopDailyProfit({
    shopId: shop.shop_id,
    date: '2026-07-09',
    salesAmount: 1000,
    promoSpend: 100,
    platformFee: 20,
    laborFee: 30,
    netProfit: 125,
    netProfitRate: 0.125,
    metrics: { platformFee: 20, laborFee: 30 },
  });

  const rows = db.getShopDailyProfitRangeByMallId({
    pddMallId: '123',
    start: '2026-07-09',
    end: '2026-07-09',
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].net_profit, 125);
  assert.equal(rows[0].promo_spend, 100);

  db.closeDb();
  delete process.env.HUICE_DB_PATH;
});
```

- [ ] **Step 6: 实现 DB 表**

核对并迁移现有表（已有字段不得破坏）：

```sql
CREATE TABLE IF NOT EXISTS shop_daily_profit (
  shop_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  sales_amount REAL,
  promo_spend REAL,
  platform_fee REAL,
  labor_fee REAL,
  net_profit REAL,
  net_profit_rate REAL,
  promo_fee_ratio REAL,
  roi REAL,
  metrics_json TEXT NOT NULL,
  raw_row_json TEXT,
  captured_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (shop_id, date),
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
);

CREATE INDEX IF NOT EXISTS idx_shop_daily_profit_date
ON shop_daily_profit(date);

CREATE TABLE IF NOT EXISTS pdd_shop_mapping (
  pdd_mall_id TEXT PRIMARY KEY,
  pdd_shop_name TEXT,
  huice_shop_id INTEGER NOT NULL,
  match_method TEXT NOT NULL CHECK(match_method IN ('product_id_auto', 'manual')),
  matched_product_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'confirmed',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (huice_shop_id) REFERENCES shops(shop_id)
);

CREATE TABLE IF NOT EXISTS pdd_shop_promo_daily (
  pdd_mall_id TEXT NOT NULL,
  date TEXT NOT NULL,
  pdd_shop_name TEXT,
  promo_spend REAL,
  gmv REAL,
  roi REAL,
  raw_json TEXT,
  captured_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (pdd_mall_id, date)
);
```

所有 SQL 使用占位符。不得拼接 `mallId`、`shopName`、日期字符串。

旧的商品级 `daily_profit`、`product_profit` 字段和计算逻辑不改。慧经营真实店铺数据只进 `shop_daily_profit`；拼多多推广页采集结果只进 `pdd_shop_promo_daily`。

- [ ] **Step 7: 写“拼多多参考数据不得覆盖慧经营”失败测试**

在 `test/shop-profit-db.test.mjs` 追加：

```js
test('keeps Huice shop promo spend authoritative when PDD reference is saved', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'huice-source-')), 'data.sqlite');
  process.env.HUICE_DB_PATH = dbPath;
  const db = await import(`../scripts/huice/lib/db.mjs?case=${Date.now()}`);

  const shop = db.upsertShop('拼【周贝瑞');
  db.upsertShopDailyProfit({
    shopId: shop.shop_id,
    date: '2026-07-09',
    salesAmount: 1000,
    promoSpend: 80,
    netProfit: 125,
  });
  db.upsertPddShopPromoDaily({
    pddMallId: '123',
    pddShopName: '周贝瑞食品专营店',
    date: '2026-07-09',
    promoSpend: 100,
    gmv: 900,
    roi: 9,
  });

  assert.equal(db.getShopDailyProfitRange(shop.shop_id, '2026-07-09', '2026-07-09')[0].promo_spend, 80);
  assert.equal(db.getPddShopPromoDaily('123', '2026-07-09').promo_spend, 100);
  db.closeDb();
  delete process.env.HUICE_DB_PATH;
});
```

Run:

```bash
node --test test/shop-profit-db.test.mjs
```

Expected: FAIL，因为独立参考表/API 尚未实现，或当前脚本仍覆盖权威表。

- [ ] **Step 8: 隔离拼多多推广参考数据**

在 `scripts/huice/lib/db.mjs` 实现 `upsertPddShopPromoDaily(record)` 和 `getPddShopPromoDaily(mallId, date)`。然后修改 `tools/pdd-promo-cdp.mjs`：

```text
删除/禁止：UPDATE shop_daily_profit SET promo_spend = ?, roi = ? ...
改为：upsertPddShopPromoDaily({ pddMallId, pddShopName, date, promoSpend, gmv, roi, raw })
```

再次运行：

```bash
node --test test/shop-profit-db.test.mjs
rg -n "UPDATE shop_daily_profit" tools/pdd-promo-cdp.mjs
```

Expected: 测试 PASS；`rg` 无输出。此任务完成后，拼多多数据即使为 `100`，慧经营权威值仍保持 `80`。

- [ ] **Step 9: 提交**

```bash
git add scripts/huice/lib/shop-profit.mjs scripts/huice/lib/db.mjs tools/pdd-promo-cdp.mjs tools/huice-export-cdp.mjs test/shop-profit.test.mjs test/shop-profit-db.test.mjs test/huice-export-parser.test.mjs
git commit -m "fix(shop-profit): keep Huice shop expenses authoritative"
```

---

## Task 3: 实现慧经营店铺日导出器

**Files:**
- Modify: `tools/huice-shop-export-cdp.mjs`
- Create: `test/huice-shop-export.test.mjs`

**Interfaces:**
- CLI: `node tools/huice-shop-export-cdp.mjs --dates 2026-07-09`
- CLI: `node tools/huice-shop-export-cdp.mjs --days 30`
- Produces: `shop_daily_profit` rows.
- Produces only ignored files under `output/huice-shop-exports/`.

- [ ] **Step 1: 复制商品导出器的安全外壳**

从 `tools/huice-export-cdp.mjs` 复用这些能力：

```text
CDP 连接
目标页查找
单日日期设置
查询等待
下载中心轮询
失败日期 JSON
下载文件归档到 output/
```

不要把店铺页面选择和店铺入库流程塞进商品导出器。店铺导出器保持独立；只允许在商品导出器中同步修复本次审核确认的共性错误：百分比解析、下载任务识别、日期校验、失败退出和 CDP timeout。

两个导出器都要增加“直接执行才运行 main”的入口保护，否则单元测试 `import` 时会立刻连接 CDP：

```js
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error('采集失败:', error.message);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 2: 写 selector 测试**

在 `test/huice-shop-export.test.mjs` 固定选择器常量：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HUICE_SHOP_SELECTORS,
  buildShopExportArgs,
  pickShopDownloadTask,
} from '../tools/huice-shop-export-cdp.mjs';

test('uses the real shop search input and export icon selectors', () => {
  assert.equal(
    HUICE_SHOP_SELECTORS.shopSearchInput,
    '.dc-shop input[placeholder="搜索店铺"]:not([readonly])',
  );
  assert.equal(HUICE_SHOP_SELECTORS.exportIcon, '.export-icon-container');
  assert.equal(HUICE_SHOP_SELECTORS.shopViewTab, '#tab-DIM');
});

test('builds explicit date args before running export', () => {
  assert.deepEqual(buildShopExportArgs({ dates: ['2026-07-09'] }).dates, ['2026-07-09']);
});

test('selects only the completed shop report created by this request', () => {
  const requestedAt = new Date('2026-07-10T14:00:00+08:00').getTime();
  const tasks = [
    { name: '商品利润分析_2026-07-09', createdAt: '2026-07-10 14:01:00', status: '完成' },
    { name: '店铺多维度分析_2026-07-09', createdAt: '2026-07-10 13:50:00', status: '完成' },
    { name: '店铺多维度分析_2026-07-09', createdAt: '2026-07-10 14:02:00', status: '生成中' },
    { name: '店铺多维度分析_2026-07-09', createdAt: '2026-07-10 14:03:00', status: '完成', id: 'correct' },
  ];

  assert.equal(pickShopDownloadTask(tasks, { requestedAt }).id, 'correct');
});

test('returns null instead of downloading the wrong report', () => {
  const requestedAt = new Date('2026-07-10T14:00:00+08:00').getTime();
  const tasks = [
    { name: '商品利润分析_2026-07-09', createdAt: '2026-07-10 14:01:00', status: '完成' },
  ];
  assert.equal(pickShopDownloadTask(tasks, { requestedAt }), null);
});
```

- [ ] **Step 3: 实现进入店铺展示**

脚本打开：

```text
https://hjy.huice.com/#/businessAnalysisCenter/report/trendNew
```

并点击：

```js
document.querySelector('#tab-DIM')?.click();
```

确认 `#tab-DIM` 的文本是“更多店铺展示”。如果实测 ID 变化，改为更稳的文本匹配：

```js
[...document.querySelectorAll('[role="tab"], .el-tabs__item')]
  .find((node) => /更多店铺展示/.test(node.innerText || ''))
  ?.click();
```

- [ ] **Step 4: 实现选择全部拼多多店铺**

流程必须是：

```text
点击店铺选择区域空白处
打开 `.dc-shop`
找到 `input[placeholder="搜索店铺"]:not([readonly])`
执行多次 select/delete 清空旧的“拼”
输入“拼”
等待 `.level2-item` 全部可见项都以“拼”开头
找到文本为“全部”的 `label.el-checkbox`
如果没有 `is-checked` 再点击
点击弹层 `.confirm`
```

以上流程必须在**每一个目标日期**查询前执行，不允许只在 `i === 0` 时执行。进入页面后先对搜索框执行 `focus -> select -> Backspace/Delete` 多次并派发 `input`，再输入“拼”，兼容页面保留上一次搜索文字的情况。

关键等待表达式：

```js
(() => {
  const names = [...document.querySelectorAll('.dc-shop .level2-item')]
    .map((node) => (node.innerText || '').trim())
    .filter(Boolean);
  return names.length > 0 && names.every((name) => name.startsWith('拼'));
})()
```

等待结束后若结果不是 `ok`、找不到“全部”、确认失败，或确认后已选店铺数为 0，必须 `throw new Error(...)` 并把当天写入 `failedDates`。禁止仅打印日志后继续下载。

- [ ] **Step 5: 单日查询**

每个日期设置为同一天：

```text
start = date
end = date
```

设置完日期必须点页面查询按钮：

```js
document.querySelector('button.search.el-button--primary')?.click();
```

等待表格不再 loading，并且至少出现一个店铺行或合计行。

- [ ] **Step 6: 下载并选择“不分店铺下载”**

点击下载：

```js
document.querySelector('.export-icon-container')?.click();
```

然后按弹窗内容处理：

```text
如果出现“导出全部链接” -> 点该弹窗内主按钮确认
如果出现“是否分店铺下载” -> 点“否”
如果出现“查询结果导出” -> 按当前页面实际按钮确认
```

按钮选择必须限定在匹配到的弹窗里，禁止使用页面第一个 `.el-button--primary`。

伪代码：

```js
function clickDialogButtonByText(dialogText, buttonText) {
  const dialog = [...document.querySelectorAll('.el-dialog, [role="dialog"]')]
    .find((node) => node.offsetParent && (node.innerText || '').includes(dialogText));
  if (!dialog) return false;
  const button = [...dialog.querySelectorAll('button')]
    .find((node) => (node.innerText || '').trim().includes(buttonText));
  button?.click();
  return Boolean(button);
}
```

每次点击后都要验证弹窗状态发生变化；如果“是否分店铺下载”仍可见，或没有成功选中“否”，当天立即失败。禁止用页面第一个可见“确定”作为兜底。

- [ ] **Step 7: 下载中心匹配本次文件**

跳转到下载中心后，只下载符合全部条件的文件：

```text
文件名或任务名包含“店铺多维度分析”
创建时间 >= 本次点击下载前 60 秒
状态为完成/可下载
不是分店铺多文件包
```

如果一页找不到，等待并刷新，不要下载旧文件。

实现 `pickShopDownloadTask(tasks, { requestedAt })` 时必须同时满足：

```js
export function pickShopDownloadTask(tasks, { requestedAt }) {
  return tasks
    .filter((task) => /店铺多维度分析/.test(task.name || task.taskName || ''))
    .filter((task) => parseHuiceTime(task.createdAt) >= requestedAt - 60_000)
    .filter((task) => /完成|可下载/.test(task.status || ''))
    .filter((task) => !/分店铺|压缩包|zip/i.test(`${task.name || ''} ${task.type || ''}`))
    .sort((a, b) => parseHuiceTime(b.createdAt) - parseHuiceTime(a.createdAt))[0] ?? null;
}
```

同文件实现时间解析，下载中心缺时间或时间格式无效的记录必须被排除：

```js
export function parseHuiceTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value || '').trim();
  if (!text) return Number.NEGATIVE_INFINITY;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(' ', 'T')}+08:00`
    : text;
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}
```

若返回 `null`，继续轮询直到超时并把该日期写入失败日期文件；禁止退回“第一条下载按钮”。下载后除日期外，还要验证工作簿表头同时包含“店铺名称”和“销售收入/一、销售收入”，否则删除本次临时文件并判定失败，不能入库。

商品导出器 `tools/huice-export-cdp.mjs` 同步修复相同问题：新增 `pickProductDownloadTask()`，按“商品排名导出/商品利润报表 + 请求时间 + 完成状态”选择任务；XLSX 内日期必须与 `targetDate` 一致后才能给记录写入该日期。禁止继续“下载第一行后直接把所有记录标成 targetDate”。

在 `test/huice-export-parser.test.mjs` 增加：

```js
test('rejects a stale product export from another date', () => {
  const result = validateProductWorkbook({
    targetDate: '2026-07-09',
    workbookDate: '2026-07-08',
    headers: ['店铺名称', '链接名称', '链接ID'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'date_mismatch');
});
```

- [ ] **Step 8: 解析 XLSX 并入库**

使用 `openpyxl` 或现有 XLSX 读取能力把表格转成二维数组，再调用：

```js
const records = parseShopExportRows(rows, date);
for (const record of records) {
  const shop = upsertShop(record.shopName);
  upsertShopDailyProfit({ ...record, shopId: shop.shop_id });
}
```

不得把真实 XLSX fixture 提交。测试 fixture 必须脱敏、最小化。

解析和入库必须同时满足：

```text
找到“店铺名称”表头
至少解析到 1 家“拼”开头店铺
不存在淘宝/天猫/抖音等非拼多多店铺行
目标日期与工作簿日期一致
SQLite 事务全部提交成功
```

任一条件失败：不归档为成功文件、不写成功快照、加入 `failedDates`。SQLite 写入使用事务，禁止逐行写到一半后留下半份数据。

- [ ] **Step 8A: 让失败正确传递给定时任务**

主流程结束时执行：

```js
if (failedDates.length > 0) process.exitCode = 1;
```

下载按钮未找到、XLSX 0 行、日期不符、数据库失败都必须进入 `failedDates`。商品导出器 `tools/huice-export-cdp.mjs` 同样修正：下载超时要记录失败日期，数据库失败要非零退出，禁止“打印警告后显示回采完成”。

- [ ] **Step 8B: 清理 CDP timeout**

所有 `cdpCall()` 在成功、协议错误和超时三个分支都清除定时器：

```js
const timer = setTimeout(onTimeout, timeoutMs);
function finish(callback) {
  clearTimeout(timer);
  ws.removeEventListener('message', handler);
  callback();
}
```

单日实测结束后 Node 进程应立即退出，不再额外挂住 15-30 秒。

- [ ] **Step 9: 单日实测**

Run:

```bash
node tools/huice-shop-export-cdp.mjs --dates 2026-07-09
```

验收：

```bash
sqlite3 private/huice-data.sqlite "select date, count(*) from shop_daily_profit group by date order by date;"
```

Expected: `2026-07-09` 有店铺行数。

- [ ] **Step 10: 提交**

```bash
git add tools/huice-shop-export-cdp.mjs test/huice-shop-export.test.mjs
git commit -m "feat(huice): export daily shop profit"
```

---

## Task 4: 建立拼多多店铺映射

**Files:**
- Modify: `dts/source/pdd-enhancer.js`
- Modify: `tools/huice-server.mjs`
- Modify: `scripts/huice/lib/db.mjs`
- Create: `test/huice-server-shop-profit.test.mjs`

**Interfaces:**
- `POST /shop-mapping/candidates`
- Request: `{ mallId, pddShopName, productIds }`
- Response:

```json
{
  "status": "unique",
  "candidates": [
    { "shopId": 1, "shopName": "拼【周贝瑞", "matchedProductCount": 8 }
  ]
}
```

- `POST /shop-mapping/confirm`
- Request: `{ mallId, pddShopName, huiceShopId }`

- [ ] **Step 1: 前端只收集已命中慧经营的商品 ID**

在商品列表已有利润列渲染完成后收集：

```js
function collectMatchedHuiceProductIds(rows) {
  return [...new Set(rows
    .filter((row) => row['huice-netProfit'] != null || row.huiceRecord)
    .map((row) => String(row.productId || row.goodsId || '').trim())
    .filter(Boolean))];
}
```

禁止从商品列表全量扫未命中商品。

- [ ] **Step 2: 写映射失败测试**

在 `test/huice-server-shop-profit.test.mjs` 准备两个慧经营店铺，并断言：

```js
test('does not guess a shop from a similar PDD shop name', async () => {
  seedHuiceShop({ shopId: 1, shopName: '拼【周贝瑞' });
  seedHuiceShop({ shopId: 2, shopName: '拼【周贝瑞二店' });

  const response = await requestJson('/shop-profit?pddShopName=周贝瑞&start=2026-07-09&end=2026-07-09');

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.status, 'mall_id_required');
});

test('does not fall back to the first Huice shop when mapping is absent', async () => {
  seedHuiceShopDailyProfit({ shopId: 1, date: '2026-07-09', netProfit: 999 });

  const response = await requestJson('/shop-profit?mallId=unmapped&start=2026-07-09&end=2026-07-09');

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, 'no_mapping');
  assert.deepEqual(response.body.days, []);
});
```

Run:

```bash
node --test test/huice-server-shop-profit.test.mjs
```

Expected: 至少一项 FAIL，因为最新基线仍有店名模糊匹配和第一家店回退。

- [ ] **Step 3: 服务端反查候选店铺**

SQL 逻辑：

```sql
SELECT
  s.shop_id,
  s.shop_name,
  COUNT(DISTINCT p.product_id) AS matched_product_count
FROM product_profit p
JOIN shops s ON s.shop_id = p.shop_id
WHERE p.product_id IN (...)
GROUP BY s.shop_id, s.shop_name
ORDER BY matched_product_count DESC, s.shop_name ASC;
```

判定：

```text
0 个候选 -> status = none
1 个候选 -> status = unique，自动写 pdd_shop_mapping
多个候选 -> status = ambiguous，不自动写确认映射
```

额外规则：`productIds` 为空时直接返回 `none`，不能改用店名；候选 SQL 只使用参数占位符；自动映射必须记录实际命中的商品数。

- [ ] **Step 4: 显示映射状态**

店铺报表数据区域顶部加一行状态：

```text
未匹配到慧经营店铺：--
匹配到多个慧经营店铺：请确认映射
已匹配：拼【周贝瑞
```

不要用店名猜测自动绑定。

- [ ] **Step 5: 人工确认接口**

当多个候选时，前端可以弹简单选择器；用户选定后调用：

```http
POST /shop-mapping/confirm
```

写入：

```text
match_method = manual
status = confirmed
matched_product_count = 当前候选命中数
```

- [ ] **Step 6: 删除全部猜测式回退并复测**

在 `tools/huice-server.mjs` 删除以下行为：

```text
读取 /shop-profit 的 pddShopName 作为匹配条件
店名清洗后 LIKE '%关键字%'
任何店铺查询中的 LIMIT 1 猜测
无映射时取日期范围内第一家“拼%”店铺
```

Run:

```bash
rg -n "pddShopName.*LIKE|LIKE.*keyword|日期范围|LIMIT 1" tools/huice-server.mjs
node --test test/huice-server-shop-profit.test.mjs
```

Expected: `rg` 不再命中上述回退逻辑；测试 PASS。

- [ ] **Step 7: 提交**

```bash
git add dts/source/pdd-enhancer.js tools/huice-server.mjs scripts/huice/lib/db.mjs test/huice-server-shop-profit.test.mjs
git commit -m "feat(report): map PDD mall to Huice shop by matched products"
```

---

## Task 5: 本地服务提供店铺日报接口

**Files:**
- Modify: `tools/huice-server.mjs`
- Modify: `scripts/huice/lib/shop-profit.mjs`
- Modify: `test/huice-server-shop-profit.test.mjs`

**Interfaces:**
- `GET /shop-profit?mallId=123&start=2026-07-03&end=2026-07-09`
- `pddShopName` 只允许作为映射记录的显示信息出现在 POST 请求体中，不允许作为 GET 查询或自动匹配依据。
- `createHuiceServer({ host = '127.0.0.1', port = 0 }) -> http.Server`，供测试使用随机端口。

Response:

```json
{
  "status": "ok",
  "mapping": {
    "pddMallId": "123",
    "huiceShopId": 1,
    "huiceShopName": "拼【周贝瑞"
  },
  "days": [
    {
      "date": "2026-07-09",
      "salesAmount": 1000,
      "promoSpend": 100,
      "roi": 10,
      "breakEvenRoi": 8,
      "promoFeeRatio": 0.1,
      "netProfitRate": 0.125,
      "netProfit": 125,
      "isLoss": false
    }
  ]
}
```

- [ ] **Step 1: 写 API 测试**

先把服务启动改成可测试入口，模块被测试 `import` 时不得自动监听 9911：

```js
export function createHuiceServer() {
  return createServer(handler);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  createHuiceServer().listen(PORT, HOST, () => {
    console.log(`慧经营数据服务: http://${HOST}:${PORT}`);
  });
}
```

测试设置临时 `HUICE_DB_PATH`，调用 `server.listen(0, '127.0.0.1')` 获取随机端口，并在 `after()` 中关闭服务和数据库。禁止测试连接用户正在运行的 9911 服务。

测试 4 种状态：

```text
ok: 有映射、有利润数据
no_mapping: mallId 没有映射
ambiguous: 候选不唯一
no_data: 有映射但日期无数据
```

再加一个来源优先级测试：慧经营日报 `promo_spend=80`、拼多多参考表 `promo_spend=100` 时，接口必须返回慧经营的 `80`：

```js
test('returns Huice promotion cost instead of PDD reference cost', async () => {
  seedConfirmedMapping({ mallId: '123', huiceShopId: 1 });
  seedHuiceShopDailyProfit({
    shopId: 1,
    date: '2026-07-09',
    salesAmount: 1000,
    promoSpend: 80,
    netProfit: 125,
  });
  seedPddPromoReference({ mallId: '123', date: '2026-07-09', promoSpend: 100 });

  const response = await requestJson('/shop-profit?mallId=123&start=2026-07-09&end=2026-07-09');
  assert.equal(response.body.days[0].promoSpend, 80);
  assert.equal(response.body.days[0].promoFeeRatio, 0.08);
  assert.equal(response.body.days[0].roi, 12.5);
});
```

- [ ] **Step 2: 实现日期范围补空行**

即使某天无慧经营数据，也要返回该日期：

```js
function fillDateRange({ start, end, rowsByDate }) {
  const days = [];
  for (const date of eachDate(start, end)) {
    days.push(rowsByDate.get(date) ?? { date, missing: true });
  }
  return days;
}
```

`eachDate` 必须按自然日推进，避免夏令时或本地时区造成漏日：

```js
function* eachDate(start, end) {
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    yield cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}
```

这样前端可以保持昨天/近 7 日/近 1 月的日期行完整。

- [ ] **Step 3: 合并推广数据**

本地服务直接返回慧经营店铺导出中的真实推广费、真实净利、净利率、费比和 ROI。前端不再默认从拼多多推广页补主数据；拼多多推广页只保存在独立参考表中。

本任务内不得实现“慧经营缺字段时自动拿拼多多数据补齐”。慧经营字段缺失就返回 `null`，前端显示 `--`。以后若用户确认需要补充，必须新增带来源标记的独立设计和审核任务。

服务端返回字段：

```text
date, salesAmount, promoSpend, platformFee, laborFee, netProfit,
netProfitRate, promoFeeRatio, roi, breakEvenRoi, metricsJson
```

字段来源：

```text
salesAmount     <- 慧经营“销售收入/一、销售收入”
promoSpend      <- 慧经营“推广费/推广费用/广告费”
platformFee     <- 慧经营“平台费/平台服务费”
laborFee        <- 慧经营“人工费/包装人工/包装人工费”
netProfit       <- 慧经营“净利润”
netProfitRate   <- 慧经营“净利润率/净利率”，缺失时用 netProfit / salesAmount
promoFeeRatio   <- 慧经营“推广费比/费比”，缺失时用 promoSpend / salesAmount
roi             <- 慧经营“ROI/投入产出比”，缺失时用 salesAmount / promoSpend
breakEvenRoi    <- 1 / netProfitRate
```

- [ ] **Step 4: 收紧本地 HTTP 服务安全边界**

允许来源固定为：

```js
const ALLOWED_ORIGINS = new Set([
  'https://mms.pinduoduo.com',
  'https://yingxiao.pinduoduo.com',
]);
if (process.env.DTS_EXTENSION_ID) {
  ALLOWED_ORIGINS.add(`chrome-extension://${process.env.DTS_EXTENSION_ID}`);
}
```

规则：

```text
没有 Origin 的本机 CLI/curl 请求允许
Origin 在白名单内允许，并原样返回 Access-Control-Allow-Origin
其他 Origin 返回 403，绝不返回经营数据
Access-Control-Allow-Methods 必须是 GET, POST, OPTIONS
响应增加 Vary: Origin
POST 请求体上限 64 KiB
日期必须是 YYYY-MM-DD、start <= end、最多 366 天
/health 不返回数据库绝对路径
```

在 `test/huice-server-shop-profit.test.mjs` 增加：

```js
test('rejects an unrelated website origin', async () => {
  const response = await requestJson('/huice?start=2026-07-09&end=2026-07-09', {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(response.statusCode, 403);
});

test('allows JSON POST preflight from Pinduoduo', async () => {
  const response = await requestOptions('/shop-mapping/candidates', {
    Origin: 'https://mms.pinduoduo.com',
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type',
  });
  assert.equal(response.statusCode, 204);
  assert.match(response.headers['access-control-allow-methods'], /POST/);
});

test('rejects an excessive date range', async () => {
  const response = await requestJson('/shop-profit?mallId=123&start=2020-01-01&end=2026-07-09');
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.status, 'invalid_date_range');
});
```

- [ ] **Step 5: 提交**

```bash
git add tools/huice-server.mjs scripts/huice/lib/shop-profit.mjs test/huice-server-shop-profit.test.mjs
git commit -m "feat(server): expose shop profit range"
```

---

## Task 6: 前端按当前日期范围渲染店铺报表

**Files:**
- Modify: `dts/source/pdd-enhancer.js`
- Modify: `test/shop-profit.test.mjs`

**Interfaces:**
- `readStoreReportDateRange(context) -> { start, end, preset }`
- `fetchShopProfitRange({ mallId, start, end }) -> Promise<ShopProfitResponse>`
- `renderStoreReportDailyRows(context, days) -> void`

- [ ] **Step 1: 读取现有日期选择**

不要写死 7 天。读取店铺报表当前控件：

```js
function readStoreReportDateRange(context) {
  const text = context.root.innerText || '';
  const dates = [...text.matchAll(/20\d{2}-\d{2}-\d{2}/g)].map((match) => match[0]);
  if (dates.length >= 2) return { start: dates[0], end: dates[1], preset: 'custom' };
  if (dates.length === 1) return { start: dates[0], end: dates[0], preset: 'single' };
  return getDefaultCompleteRange(7);
}
```

如果运行时能拿到 Vue 里的准确日期字段，优先用 Vue 字段；文本解析只作为 fallback。

- [ ] **Step 2: 获取慧经营店铺日报**

调用本地服务：

```js
async function fetchShopProfitRange({ mallId, start, end }) {
  if (!mallId) return { status: 'mall_id_required', days: [] };
  const query = new URLSearchParams({ mallId: String(mallId), start, end });
  const response = await fetch(`http://127.0.0.1:9911/shop-profit?${query}`);
  if (!response.ok) throw new Error(`shop-profit HTTP ${response.status}`);
  return response.json();
}
```

禁止保留旧签名 `fetchShopProfitRange(start, end, pddShopName)`。`mallId` 从当前拼多多登录店铺的稳定页面数据读取；拿不到时显示“无法识别当前店铺”，不能退回店名匹配。

若首次返回 `no_mapping`：

```js
const productIds = collectMatchedHuiceProductIds(currentProductRows);
const mappingResponse = await fetch('http://127.0.0.1:9911/shop-mapping/candidates', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mallId, pddShopName, productIds }),
}).then((res) => res.json());
```

处理规则：

```text
unique    -> 服务端自动保存映射，再请求一次 /shop-profit
ambiguous -> 展示候选供人工确认，不展示任何一家利润
none      -> 展示“未匹配到慧经营店铺”
productIds 为空 -> 展示“暂无已匹配商品，无法识别店铺”
```

失败时展示：

```text
店铺利润服务未启动
```

不要阻断原浮窗其他功能。

- [ ] **Step 3: 使用慧经营真实店铺日报字段**

前端直接使用 `/shop-profit` 返回的字段：

```text
promoSpend, roi, promoFeeRatio, netProfitRate, netProfit, breakEvenRoi
```

不要在这个主流程里调用 `fetchPromoWindow()` 或 `triggerOnDemandFetch()` 来重算推广费用。只有当慧经营导出缺少推广费字段、且用户另行确认要用拼多多推广页补字段时，才新开一个独立任务实现补充逻辑。

- [ ] **Step 4: 格式化**

```js
const displayDays = profitDays.map((day) => buildStoreReportDay({
  date: day.date,
  shop: day,
}));
```

格式化规则：

```js
function formatMoney(value) {
  return value == null ? '--' : `¥${Number(value).toFixed(2)}`;
}

function formatPercent(value) {
  return value == null ? '--' : `${(Number(value) * 100).toFixed(2)}%`;
}

function formatRatio(value) {
  return value == null ? '--' : Number(value).toFixed(2);
}
```

- [ ] **Step 5: 渲染时只作用于店铺报表**

所有入口先执行：

```js
const context = getStoreReportContext();
if (!context) return;
```

新增行 class：

```text
dts-store-profit-row
dts-store-profit-loss
```

亏损整行标红：

```css
.dts-store-profit-loss,
.dts-store-profit-loss * {
  color: #d93025 !important;
  font-weight: 600;
}
```

不要复用商品列表的红色规则，避免影响别的表。

- [ ] **Step 6: 保持幂等**

面板幂等 key 必须包含店铺和日期：

```js
const requestKey = `${mallId}:${start}:${end}`;
const previous = context.root.querySelector('.dts-store-profit-panel');
if (previous?.dataset.requestKey === requestKey && previous.dataset.state === 'ready') return;
previous?.remove();

const controller = new AbortController();
activeStoreProfitRequest?.abort();
activeStoreProfitRequest = controller;
panel.dataset.requestKey = requestKey;
panel.dataset.state = 'loading';
```

响应回来后再次检查：

```js
if (controller.signal.aborted) return;
if (!panel.isConnected || panel.dataset.requestKey !== requestKey) return;
if (getCurrentMallId() !== String(mallId)) return;
```

失败面板不能永久命中幂等判断，用户重开或点击重试时必须重新请求。不能清空整个表格、不能删除已有绿色/紫色列、不能动其他页签 DOM。

- [ ] **Step 6A: 禁止动态数据直接进入 innerHTML**

店铺名、日期、接口错误和所有金额都使用 `textContent` 创建单元格：

```js
function appendCell(row, text, className = '') {
  const cell = document.createElement('td');
  cell.className = className;
  cell.textContent = text == null ? '--' : String(text);
  row.appendChild(cell);
  return cell;
}
```

允许使用固定模板创建静态表头，但禁止以下形式：

```js
panel.innerHTML = '...' + data.mapping.huiceShopName + '...';
panel.innerHTML = '加载失败: ' + error.message;
```

- [ ] **Step 6B: 修复只有一页时汇总失败**

修改现有 `collectMatchedReportRecords()`：

```js
const initial = getDialogPageData(dialog, huiceMap);
if (!initial) return { ok: false, reason: 'renderData unavailable' };

const pager = dialog.querySelector('.el-pagination');
const pageNumbers = pager
  ? [...pager.querySelectorAll('.el-pager .number')]
      .map((node) => Number(node.textContent))
      .filter(Number.isFinite)
  : [];
const hasMultiplePages = pageNumbers.some((number) => number > 1);

if (!pager || !hasMultiplePages) {
  return {
    ok: true,
    scannedProductIds: new Set(initial.scannedProductIds),
    matchedRecords: new Map(initial.matchedRecords),
    pageCount: 1,
  };
}
```

只有确认存在多页时才强制要求上一页/下一页按钮。新增手工验收：一家只有 1 页的店铺能正常汇总；一家超过 1 页的店铺逐页收集后能恢复原页。

- [ ] **Step 7: 手工验收**

检查：

```text
昨天 -> 1 行
近 7 日 -> 7 行
近 1 月 -> 多日逐日行
自定义 -> 起止日期内逐日行
亏损日 -> 整行红
商品列表 -> 无新增店铺日报面板
商品列表 -> 原有商品级利润、原始净利/调整净利逻辑不变
另外 3 个页签 -> 无新增店铺日报面板
相同日期从店铺 A 切换到店铺 B -> 不显示 A 的店铺名或数据
店铺 A 慢请求返回时当前已在店铺 B -> A 的响应被丢弃
只有 1 页商品 -> 店铺汇总正常显示
接口失败后点击重试 -> 可以重新请求
```

- [ ] **Step 8: 提交**

```bash
git add dts/source/pdd-enhancer.js test/shop-profit.test.mjs
git commit -m "feat(report): render daily shop profit in store report"
```

---

## Task 7: 加入每日同步和 30 天回采

**Files:**
- Modify: `scripts/huice-daily.sh`
- Modify: `scripts/huice-daily.ps1`
- Modify: `install.sh`
- Modify: `install.ps1`
- Modify: `scripts/start-cdp-chrome.ps1`
- Create: `scripts/start-huice-server.ps1`
- Create: `scripts/huice/lib/date.mjs`
- Create: `test/date-utils.test.mjs`
- Modify: `tools/huice-export-cdp.mjs`
- Modify: `tools/pdd-promo-cdp.mjs`
- Modify: `tools/write-storage.mjs`
- Modify: `dts/source/pdd-enhancer.js`
- Modify: `README.md`
- Modify: `docs/OPERATIONS.md`

**Interfaces:**
- Daily: 商品导出成功后执行昨天店铺导出。
- Backfill: 手工执行 `node tools/huice-shop-export-cdp.mjs --days 30`。

- [ ] **Step 1: 先跑单日，不跑 30 天**

Run:

```bash
node tools/huice-shop-export-cdp.mjs --dates 2026-07-09
```

必须确认：

```text
下载成功
XLSX 归档到 output/huice-shop-exports/
shop_daily_profit 入库
git status 不出现 XLSX 或 SQLite
```

- [ ] **Step 2: 再跑 30 天回采**

Run:

```bash
node tools/huice-shop-export-cdp.mjs --days 30
```

如果失败日期存在：

```bash
cat output/huice-shop-exports/failed-dates.json
node tools/huice-shop-export-cdp.mjs --dates 2026-07-01,2026-07-02
```

不要把 `failed-dates.json` 提交。

- [ ] **Step 3: 接入 macOS 每日同步**

在 `scripts/huice-daily.sh` 商品同步完成后追加：

```bash
node "$PROJECT_DIR/tools/huice-shop-export-cdp.mjs" --dates "$YESTERDAY"
```

如果店铺同步失败，记录日志和失败日期，但不要影响已有商品同步数据。

具体做法：先完成商品同步，再记录 `SHOP_SYNC_FAILED=1`；脚本末尾返回非零退出码，让 launchd/监控知道当天店铺数据失败。不能因为店铺失败删除或回滚已经成功的商品数据，也不能静默返回成功。

- [ ] **Step 4: 接入 Windows 每日同步**

在 `scripts/huice-daily.ps1` 商品同步完成后追加等价命令：

```powershell
node "$ProjectDir/tools/huice-shop-export-cdp.mjs" --dates $Yesterday
```

检查 `$LASTEXITCODE`，规则与 macOS 一致：保留已成功商品数据，但整个任务最终返回失败并在日志写明失败日期。

- [ ] **Step 4A: 修复 Windows 开机任务**

新增 `scripts/start-huice-server.ps1`：

```powershell
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$Server = Join-Path $ProjectDir "tools\huice-server.mjs"
Start-Process -FilePath "node" -ArgumentList @($Server) -WindowStyle Hidden
```

`install.ps1` 的计划任务改为调用这个确定路径的脚本，禁止把字面量 `$SCRIPT_DIR` 写入新 PowerShell 进程：

```powershell
$serverScript = Join-Path $SCRIPT_DIR "scripts\start-huice-server.ps1"
schtasks /Create /TN "Daima_Huice_Server" /TR "powershell -ExecutionPolicy Bypass -File `"$serverScript`"" /SC ONLOGON /F
```

`scripts/start-cdp-chrome.ps1` 的标准输出和错误输出使用两个不同文件：

```powershell
-RedirectStandardOutput (Join-Path $env:TEMP "chrome-cdp.out.log") `
-RedirectStandardError  (Join-Path $env:TEMP "chrome-cdp.err.log")
```

- [ ] **Step 4B: 为两个平台安装并验证 openpyxl**

不得要求 sudo 或写系统 Python。在 `private/pyenv` 创建项目私有虚拟环境：

```bash
python3 -m venv private/pyenv
private/pyenv/bin/python -m pip install --upgrade pip openpyxl
private/pyenv/bin/python -c "import openpyxl; print(openpyxl.__version__)"
```

Windows 等价命令：

```powershell
python -m venv private\pyenv
private\pyenv\Scripts\python.exe -m pip install --upgrade pip openpyxl
private\pyenv\Scripts\python.exe -c "import openpyxl; print(openpyxl.__version__)"
```

两个导出器统一优先读取：

```text
HUICE_PYTHON 环境变量
macOS: private/pyenv/bin/python
Windows: private/pyenv/Scripts/python.exe
最后才尝试系统 python3/python
```

找不到解释器或 `import openpyxl` 失败时，安装和采集都必须明确失败，不能只显示“部分功能可能受限”。

- [ ] **Step 4C: 统一中国本地业务日期**

在 `tools/huice-export-cdp.mjs`、`tools/pdd-promo-cdp.mjs`、`tools/write-storage.mjs` 和 `dts/source/pdd-enhancer.js` 中，把业务日期的 `toISOString().slice(0, 10)` 改成本地年月日格式：

```js
function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
```

增加测试固定在中国时间 `2026-07-10 00:30`，昨天必须是 `2026-07-09`，不能变成 `2026-07-08`。

Node 工具共用 `scripts/huice/lib/date.mjs`；浏览器内容脚本保留等价的小函数。运行测试：

```bash
TZ=Asia/Shanghai node --test test/date-utils.test.mjs
```

- [ ] **Step 5: 文档补命令**

在 `docs/OPERATIONS.md` 写清：

```text
单日店铺补采
30 天店铺回采
失败日期重试
确认 private/output 不入 Git
本地服务启动后如何刷新扩展
Windows 开机服务和每日任务验证
openpyxl 私有环境检查
凌晨业务日期验证
```

同时修正 `README.md`：新增整店铺日报使用慧经营真实推广费；拼多多推广采集只作为独立参考，不再宣称每天默认覆盖店铺日报。

- [ ] **Step 6: 提交**

```bash
git add scripts/huice-daily.sh scripts/huice-daily.ps1 scripts/start-cdp-chrome.ps1 scripts/start-huice-server.ps1 scripts/huice/lib/date.mjs tools/huice-export-cdp.mjs tools/pdd-promo-cdp.mjs tools/write-storage.mjs dts/source/pdd-enhancer.js test/date-utils.test.mjs install.sh install.ps1 README.md docs/OPERATIONS.md
git commit -m "chore(sync): add shop profit daily export"
```

---

## Task 8: 全链路验收和提交审核

**Files:**
- Modify: none unless fixing defects

**Interfaces:**
- Produces: 一个可审查 PR 或待用户确认的分支。

- [ ] **Step 1: 自动测试**

Run:

```bash
npm test
npm run check:js
```

Expected: all pass.

其中测试套件必须至少覆盖以下回归用例，不能只看总数通过：

```text
慧经营 promo_spend=80、拼多多参考=100 -> 接口和 UI 使用 80
没有 mallId -> mall_id_required
有 mallId 但无确认映射 -> no_mapping，不返回任何店铺利润
两个相似店名 -> 不使用 LIKE/LIMIT 1 猜测
商品 ID 唯一候选 -> 自动映射
商品 ID 多候选 -> ambiguous，不自动选择
下载中心同时有商品报表、旧店铺报表和生成中任务 -> 只选本次已完成店铺报表
下载工作簿缺“店铺名称”或“销售收入” -> 拒绝入库
Excel 数值 0.125 和字符串 12.5% -> 都解析为 0.125，保本 ROI 为 8
商品下载文件日期与目标日期不同 -> 拒绝入库，不允许强制改日期
店铺筛选不是全部“拼”开头 -> 当天失败，不下载
XLSX 0 行或 SQLite 事务失败 -> 写失败日期并返回非零退出码
慧经营净利润小于 0 -> 整个店铺日报行标红
商品列表和另外 3 个页签 -> 不出现店铺日报 DOM
恶意网页 Origin -> 本地服务返回 403
拼多多 Origin 的 POST 预检 -> 允许 POST
相同日期切换店铺 -> 不残留上一家数据
单页商品报表 -> 店铺汇总正常
中国时间凌晨 00:30 计算昨天 -> 日期正确
```

- [ ] **Step 2: 数据安全检查**

Run:

```bash
git status --short
git status --ignored --short private output | sed -n '1,120p'
```

Expected:

```text
源代码和文档可以是 M/??。
private/output 真实数据必须是 !! ignored。
不能有 .sqlite、.xlsx、.csv、登录态文件待提交。
```

- [ ] **Step 3: 手工 UI 验收**

验收矩阵：

```text
店铺报表 / 昨天 / 有数据 / 显示 1 行
店铺报表 / 近 7 日 / 部分日期无慧经营 / 缺数显示 --
店铺报表 / 近 1 月 / 展示每日行，不平均比例
店铺报表 / 自定义 / 按用户起止日期
店铺报表 / 亏损日 / 整行红
商品列表 / 任意日期 / 不出现店铺日报面板
其他 3 个页签 / 任意日期 / 不出现店铺日报面板
本地服务关闭 / 店铺报表 / 显示服务未启动，不影响弹窗
映射无候选 / 店铺报表 / 显示未匹配
映射多候选 / 店铺报表 / 显示请确认映射
两个名称相近店铺 / 店铺报表 / 不串店
慧经营推广费与拼多多参考费不同 / 店铺报表 / 展示慧经营值
相同日期切换两家店 / 店铺报表 / 请求 key 随 mallId 改变
单页店铺 / 商品报表汇总 / 无分页器也能汇总
断开 SQLite 写权限 / 采集脚本 / 非零退出且失败日期可补采
Windows 重启后 / 计划任务 / 9911 服务与店铺日报任务均启动
```

- [ ] **Step 4: 提交最后修复**

如果验收中修了 bug：

```bash
git add <changed files>
git commit -m "fix(report): harden shop profit display"
```

- [ ] **Step 5: 推送审核分支**

只有用户确认后执行：

```bash
git push -u origin HEAD
```

- [ ] **Step 6: 打开 PR**

PR 描述必须包含：

```text
做了什么
没有动什么
怎么验证
真实数据未提交的证据
已知限制
```

不要把本计划里的真实截图、真实店铺数据、XLSX 或 SQLite 上传。

---

## Review Checklist

审核时逐条看：

- [ ] 计划没有要求直接改 `main`。
- [ ] 计划没有要求提交真实数据。
- [ ] 计划保留昨天、近 7 日、近 1 月、自定义日期。
- [ ] 计划只改店铺报表，不动商品列表和其他 3 个页签。
- [ ] 计划没有强制删除绿色/紫色列；只有确认范围后才允许处理。
- [ ] 计划使用商品 ID 映射店铺，不靠店名猜测。
- [ ] 计划只收集已命中慧经营数据的商品 ID。
- [ ] 计划明确：真实费用口径只用于新增整店铺日报，不修改单个商品数据。
- [ ] 计划明确：新增整店铺日报使用慧经营按店铺展示真实费用，不按 `1.15/订单`、`2% 平台费` 或 `2.85` 重算。
- [ ] 计划保本 ROI 是 `1 / 净利润率`。
- [ ] 计划明确亏损整行标红。
- [ ] 计划先跑单日，再跑 30 天回采。
- [ ] 计划写明了慧经营选择、下载、弹窗和下载中心踩坑。
- [ ] `/shop-profit` 只按 `mallId` 的确认映射查询，没有店名 `LIKE`、关键字截取或第一家店回退。
- [ ] `tools/pdd-promo-cdp.mjs` 不再更新 `shop_daily_profit`，拼多多数据只进独立参考表。
- [ ] 下载中心同时按任务类型、请求时间、完成状态和工作簿表头校验，没有“第一条下载”回退。
- [ ] 慧经营字段缺失时显示 `--`，不会静默混入拼多多参考值。
- [ ] 百分比数值和百分号字符串都不会重复除以 100。
- [ ] 商品与店铺下载都校验任务类型、请求时间、状态、表头和日期。
- [ ] 店铺面板以 `mallId + 日期范围` 为 key，并丢弃过期响应。
- [ ] 单页商品报表不依赖分页器。
- [ ] 本地服务拒绝非白名单网页 Origin，POST 预检可用，请求体和日期范围有限制。
- [ ] macOS/Windows 都验证私有 `openpyxl` 环境并执行店铺日报同步。
- [ ] 任何采集或入库失败都会产生失败记录和非零退出码。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-10-shop-report-daily-profit.md`.

推荐执行方式：

1. 先由用户审核本计划，不审核通过不要继续实现。
2. 审核通过后，从干净分支开始做 Task 0。
3. 每完成一个 Task 就提交一次，并把测试结果写进提交说明或 PR 描述。
4. 完成 Task 8 后再由用户确认是否推送和合并。
