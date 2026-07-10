# 店铺报表 7 日利润数据 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在店透视浮窗的“店铺报表”中展示当前登录拼多多店铺过去 7 个完整日期的推广和利润数据；同时从慧经营按日下载全部拼多多店铺数据并写入本地数据库。

**Architecture:** 新增慧经营店铺日导出器：在“经营 > 多维利润分析 > 更多店铺展示”中选择全部拼多多店铺，逐日导出，确认选择“不分店铺下载”。店铺数据写入独立表。扩展用当前店铺中已命中慧经营利润的商品 ID 自动建立 `mallId -> 慧经营店铺` 映射；店铺报表按日合并本地利润和拼多多推广数据。

**Tech Stack:** Node.js ESM、CDP Chrome、Playwright 现有工具链、SQLite (`better-sqlite3`)、本地 HTTP 服务、Chrome MV3 内容脚本、Element UI 2。

## Global Constraints

- 扩展运行目录必须是 `dts/`。改代码前按 `docs/OPERATIONS.md` 做加载来源、文件存在和 Git 跟踪三确认。
- 只允许改浮窗的“店铺报表”页签。商品列表和浮窗另外 3 个页签不得增加、删除、重排、着色或写入 DOM。
- 现在追加的 6 个绿色 `huice-*` 列和 7 个紫色 `huice-shop-*` 列必须从店铺报表移除，不能保留隐藏列、空列或旧数据。
- 默认日期为昨天向前连续 7 个完整日期。每个日期一行，不展示今天、7 日平均值或 7 日合计。
- 调整后净利润：`原始净利 - 1.15 * 订单数 - 销售额 * 2%`。销售件数就是订单数；原始净利和调整后净利必须分别保存。
- 净利润率：`调整后净利润 / 销售额`。保本 ROI：`1 / 净利润率`；净利润率小于等于 0 或缺失时显示 `--`。
- 推广费比：`推广费用 / 慧经营店铺销售额`。ROI 使用拼多多推广平台同日官方汇总口径，不能平均商品 ROI。
- XLSX、SQLite、下载缓存、30 天回采数据和登录态只允许存在于已忽略的 `private/`、`output/`，不得提交。
- HTTP 服务继续只监听 `127.0.0.1`。缺数、接口失败和映射不唯一都显示 `--` 或待确认状态，禁止用 0 猜测。

## 展示定义

店铺报表固定列顺序：

~~~text
日期 | 推广费用 | ROI | 保本 ROI | 费比 | 净利润率 | 净利润额
~~~

- 金额显示 `¥1,234.56`；ROI 显示两位小数；费比、净利润率显示两位百分比。
- 调整后净利润小于 0 时，整行所有文字、金额和比例标红。
- 推广接口成功返回无推广：推广费用 `¥0.00`、费比 `0.00%`、ROI `--`。
- 推广接口失败、无登录态或未打开推广平台标签：推广费用、ROI、费比均为 `--`。
- 慧经营该日无店铺数据：净利润额、净利润率、保本 ROI、费比均为 `--`；推广费用和 ROI 可以独立显示。

## 当前代码事实

- `dts/source/pdd-enhancer.js` 目前把 6 个绿色商品利润列和 7 个紫色店铺汇总列插进通用 Element UI 弹窗表格。这是本计划要删除的旧展示。
- `tools/huice-export-cdp.mjs` 已有稳定的单日日期面板、查询、下载中心和失败日期逻辑。店铺导出器应复用这些机制，但不能写入 `product_profit`。
- `scripts/huice/lib/db.mjs` 已有 `shops`、`daily_profit`、`product_profit`。新增店铺日表和店铺映射表，旧表保持兼容。
- `pdd-enhancer.js` 已有 `getEntityId()`、`fetchPromoWindow()`、`triggerOnDemandFetch()`。推广数据继续复用拼多多页面的 `queryEntityReport` service，禁止改成裸请求。
- 当前源代码称目标为“商品报表”，用户界面称“店铺报表”，且浮窗有 5 个页签。因此必须先获得唯一的运行时页签标识；未确认前禁止对通用 `.el-dialog` 或 `.el-table` 做改动。

## 数据流

~~~text
慧经营 trendNew
  全部拼多多店铺 + 单日 + 更多店铺展示
  -> 导出并选择“不分店铺下载”
  -> 下载中心中本次“店铺多维度分析”文件
  -> 动态 XLSX 表头解析
  -> shop_daily_profit（每店、每天）

当前店铺商品报表中已命中慧经营利润的商品 ID
  -> 只按 productId 找 shop_name 候选
  -> pdd_shop_mapping（mallId -> huice_name）
  -> 唯一候选自动确认，多候选人工确认

店铺报表打开
  -> GET /shop-profit?mallId=...&start=...&end=...
  -> 逐日确保拼多多推广分仓存在
  -> 每日合并利润和推广汇总
  -> 仅在店铺报表页签渲染 7 行
~~~

## 文件变更地图

| 文件 | 责任 |
| --- | --- |
| `scripts/huice/lib/shop-profit.mjs`（新建） | XLSX 店铺行解析、字段别名、推广汇总、7 日日期列表、日行计算、映射候选判定等纯函数。 |
| `scripts/huice/lib/db.mjs` | 迁移 `shop_daily_profit` 和 `pdd_shop_mapping`，提供 upsert、查询和映射 API。 |
| `tools/huice-shop-export-cdp.mjs`（新建） | 慧经营按店铺单日导出、全选拼店、选择“不分店铺下载”、下载和入库。 |
| `tools/huice-server.mjs` | 本地店铺利润查询、自动映射、人工确认映射接口。 |
| `scripts/huice-daily.sh`、`scripts/huice-daily.ps1` | 在现有商品导出后加入店铺日导出。 |
| `dts/source/pdd-enhancer.js` | 清理旧列；保留无视觉副作用的商品 ID 匹配；只在目标页签渲染 7 日店铺表。 |
| `test/shop-profit.test.mjs`（新建） | 财务计算、表头解析、映射候选、缺数与负数规则。 |
| `test/huice-shop-export.test.mjs`（新建） | 店铺下载选择、动态表头 fixture、合计行过滤。 |
| `test/huice-server-shop-profit.test.mjs`（新建） | 临时 SQLite 下的映射、查询和 API 状态。 |
| `docs/OPERATIONS.md` | 只补店铺回采与补采命令，不写真实数据。 |

---

### Task 1: 锁定唯一的店铺报表范围并拆除旧列

**Files:**
- Modify: `dts/source/pdd-enhancer.js`
- Test: 已登录拼多多的手工范围验收

**Interfaces:**
- Produces: `getStoreReportContext() -> { root, tableComp, dataComp, activeTabKey } | null`。
- Contract: 只有激活页签为店铺报表时返回上下文；其他 4 个页签永远返回 `null`。

- [ ] **Step 1: 记录实际页签标识**

打开店透视浮窗，逐一切换店铺报表、商品列表和另外 3 个页签。记录每个页签的文本、Vue 激活 key、根节点 class 和表格组件。把目标的真实 key 固定为 `STORE_REPORT_TAB_KEY`，不能依赖“第一个弹窗”或“第一个表格”。

验收：仅店铺报表返回上下文；其他四项均为 `null`。

- [ ] **Step 2: 建立 DOM 作用域守卫**

~~~js
function getStoreReportContext() {
  const popup = findDtsFloatingPopup();
  if (!popup) return null;
  const activeTab = readActiveDtsTab(popup);
  if (activeTab.key !== STORE_REPORT_TAB_KEY) return null;
  return {
    root: popup.querySelector(STORE_REPORT_ROOT_SELECTOR),
    activeTabKey: activeTab.key,
    tableComp: findVueTableComponent(popup),
    dataComp: findVueDataComponent(popup),
  };
}
~~~

`findDtsFloatingPopup`、`readActiveDtsTab` 和 `STORE_REPORT_ROOT_SELECTOR` 必须使用 Step 1 实测的选择器/字段，不能使用无范围的 `document.querySelector('.el-dialog__wrapper')`。

- [ ] **Step 3: 移除旧 13 列**

目标页签中移除以下 property 的列定义和行字段：

~~~text
huice-netProfit, huice-netProfitRate, huice-grossProfitRate,
huice-refundAmount, huice-promoFeeRatio, huice-breakevenROI,
huice-shop-salesAmount, huice-shop-rawNetProfit,
huice-shop-orderFixedCost, huice-shop-platformFee,
huice-shop-netProfit, huice-shop-netProfitRate, huice-shop-coverage
~~~

新增 `removeLegacyStoreReportColumns(context)`，只在有目标上下文时，通过 Element UI 的 `removeColumn` 移除上述列，并从当前 `renderData` 删除同名字段。必须幂等。

保留商品 ID 匹配、商品级原始数据读取和既有亏损行逻辑；商品列表和其余 3 个页签不删除、重排或新增任何列。

- [ ] **Step 4: 范围回归**

1. 店铺报表中完全不存在 13 个旧列。
2. 商品列表和另外 3 个页签的表头、顺序、颜色与改前截图一致。
3. 反复切日期、关闭/重开浮窗，旧列不因 `MutationObserver` 再次插入。

- [ ] **Step 5: 提交**

~~~bash
git add dts/source/pdd-enhancer.js
git commit -m "refactor(report): scope store report and remove legacy profit columns"
~~~

### Task 2: 建立店铺日利润、映射和计算核心

**Files:**
- Create: `scripts/huice/lib/shop-profit.mjs`
- Modify: `scripts/huice/lib/db.mjs`
- Create: `test/shop-profit.test.mjs`

**Interfaces:**
- `listPreviousCompleteDays(now, count) -> string[]`：返回从旧到新的连续日期。
- `normalizeShopExportRow(headers, cells, date) -> ShopDailyRecord | null`。
- `summarizePromoRecords(records) -> { status, spend, roiBase }`。
- `buildStoreReportDay({ date, shop, promo }) -> StoreReportDay`。
- `resolveShopCandidates(productRecords) -> { status, candidates }`。

- [ ] **Step 1: 先写失败测试，固定计算口径**

~~~js
test('uses one over net-profit-rate for break-even ROI', () => {
  const row = buildStoreReportDay({
    date: '2026-07-09',
    shop: { salesAmount: 1000, netProfit: 125 },
    promo: { status: 'ok', spend: 100, roiBase: 420 },
  });
  assert.equal(row.netProfitRate, 0.125);
  assert.equal(row.breakEvenRoi, 8);
  assert.equal(row.promoFeeRatio, 0.1);
  assert.equal(row.roi, 4.2);
});

test('does not average goods ROI and hides break-even ROI on loss', () => {
  const promo = summarizePromoRecords([
    { spend: 10, roiBase: 100 },
    { spend: 100, roiBase: 100 },
  ]);
  const row = buildStoreReportDay({
    date: '2026-07-09',
    shop: { salesAmount: 1000, netProfit: -1 },
    promo,
  });
  assert.equal(row.roi, 200 / 110);
  assert.equal(row.breakEvenRoi, null);
  assert.equal(row.isLoss, true);
});
~~~

另写“推广成功但无活动”和“推广请求失败”两个测试，前者输出 ¥0.00 和 0%，后者输出全 `null`。

`roiBase` 是 ROI 分子，不能用商品 `roi` 平均。先用同日拼多多页面总计验证字段：优先 `totalSumReport`；没有总计时，选择与 `orderSpendNetRoi` 精确对齐的金额字段逐商品求和，并将已验证字段名写入测试。

- [ ] **Step 2: 实现动态表头和日行计算**

规范化记录字段：

~~~js
{
  date, salesAmount, rawNetProfit, orderCount, orderFixedCost,
  platformFee, netProfit, netProfitRate, promoSpend, roi,
  breakEvenRoi, promoFeeRatio, isLoss
}
~~~

`buildStoreReportDay` 直接使用数据库保存的 `netProfit`，绝不再次扣 1.15 或 2%。费比分母只能是慧经营 `salesAmount`。

`normalizeShopExportRow` 按表头名解析，不能用固定列号。真实文件只用于确认表头；测试仅保留脱敏 fixture。最少支持：

~~~js
const SHOP_EXPORT_HEADERS = {
  shopName: ['店铺名称'],
  salesAmount: ['一、销售收入', '销售额'],
  rawNetProfit: ['十一、净利润', '净利润', '原始净利'],
  orderCount: ['订单数', '销售件数', '付款订单数'],
};
~~~

真实表头不同时，在同一提交内加入准确别名与脱敏 fixture；缺指标返回 `null`。

- [ ] **Step 3: 增加独立表与参数化 DB API**

在 `initSchema(db)` 创建：

~~~sql
CREATE TABLE IF NOT EXISTS shop_daily_profit (
  shop_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  sales_amount REAL,
  raw_net_profit REAL,
  order_count INTEGER,
  order_fixed_cost REAL,
  platform_fee REAL,
  net_profit REAL,
  net_profit_rate REAL,
  metrics_json TEXT NOT NULL,
  raw_row_json TEXT,
  captured_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (shop_id, date),
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
);
CREATE INDEX IF NOT EXISTS idx_shop_daily_profit_date ON shop_daily_profit(date);

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
~~~

提供并单测 `upsertShopDailyProfit`、`getShopDailyProfitRangeByMallId`、`findPddShopMapping`、`upsertPddShopMapping`、`listShopCandidatesByProductIds`。SQL 一律占位符。

入库调整计算：

~~~js
orderFixedCost = orderCount == null ? null : orderCount * 1.15;
platformFee = salesAmount == null ? null : salesAmount * 0.02;
netProfit = rawNetProfit == null || orderFixedCost == null || platformFee == null
  ? null
  : rawNetProfit - orderFixedCost - platformFee;
netProfitRate = salesAmount > 0 && netProfit != null ? netProfit / salesAmount : null;
~~~

若店铺导出没有订单数，可只按同一 `huice_name + date` 汇总 `product_profit.order_count` 并记录来源；店铺导出有订单数时优先。两者都没有时调整后净利字段全为 `null`。

- [ ] **Step 4: 固定商品 ID 映射规则**

`resolveShopCandidates` 只接收 `productId` 非空且 `netProfit` 有效的已命中商品：

~~~text
唯一候选且匹配商品数 >= 1 -> auto_confirmed
零候选 -> unmapped
两个及以上候选 -> ambiguous，按命中数量降序返回，绝不自动选第一家
~~~

不在数据库、未卖出、净利润为空的商品不得进入候选或映射接口。

- [ ] **Step 5: 验证并提交**

~~~bash
node --test test/shop-profit.test.mjs
git add scripts/huice/lib/shop-profit.mjs scripts/huice/lib/db.mjs test/shop-profit.test.mjs
git commit -m "feat(profit): add daily shop profit model"
~~~

### Task 3: 实现慧经营“全部拼多多店铺”的单日下载器

**Files:**
- Create: `tools/huice-shop-export-cdp.mjs`
- Create: `test/huice-shop-export.test.mjs`
- Modify: `scripts/huice/lib/db.mjs`

**Interfaces:**

~~~text
node tools/huice-shop-export-cdp.mjs --days 1
node tools/huice-shop-export-cdp.mjs --days 30
node tools/huice-shop-export-cdp.mjs --dates 2026-07-01,2026-07-02
~~~

成功时，每个导出日为每一家 `拼` 开头的慧经营店铺写入一条 `shop_daily_profit`。

- [ ] **Step 1: 单日循环与日期重试**

复用 `tools/huice-export-cdp.mjs` 的 `cdpCall`、`cdpEval`、`setDateRangeByPanel`、3 次日期重试、失败日期记录和下载等待。目标地址：

~~~text
https://hjy.huice.com/#/businessAnalysisCenter/report/trendNew
~~~

`--dates` 优先；没有 `--dates` 时，`--days N` 生成昨天向前 N 天。每次开始与结束都选同一天，然后再次点“查询”。

- [ ] **Step 2: 按用户流程全选拼多多店铺**

每个日期查询前执行 `selectAllPddShops(ws)`：

1. 点击 `.select-tags-box` 中店铺标签右侧空白输入区。
2. 找到 `.dc-shop` 内输入框；发送 `Meta/Control+A` 和 `Backspace`，再额外执行 3 次 `Backspace`，触发 `input`，清理残留“拼”。
3. 输入 `拼` 并触发 `input/change`，等筛选结果稳定。
4. 点击文字严格等于 `全部` 的选项；不得点击 `全部（不包含终止）`。
5. 点击 `确认`，验证至少选中一家且每个已选名称均以 `拼` 开头。
6. 激活 `更多店铺展示`。
7. 点击 `查询`，等 AG Grid 出现正常店铺行或明确空状态。

任何验证失败都写入 `output/huice-shop-exports/failed-dates.json`，不能带着不完整选择继续。

- [ ] **Step 3: 下载时明确选择“不分店铺下载”**

右侧下载按钮按 `use[href='#icon-download']` 定位。点击导出菜单后：

1. 选择当前页导出命令；若菜单项是 `导出全部`，仅点该项。
2. 等“是否分店铺下载”确认框。
3. 点击文字严格等于 `否` 的按钮；`取消`、关闭图标和回车不属于“否”。
4. 等慧经营提示导出完成。
5. 到下载中心，只下载本次创建且名称包含 `店铺多维度分析` 的已完成任务；不能无条件下载第一行。

导出前记录时间戳和目标日期。下载中心任务必须名称匹配且创建时间不早于导出前；未完成轮询 60 秒，超时记失败日期。

- [ ] **Step 4: 动态解析并入库**

扫描 XLSX 前 30 行，找到同时含店铺名称和销售收入语义的表头。逐行读取，保留店名以 `拼` 开头的正常店铺行，丢弃空行、`合计`、非拼店铺和重复表头。

完整表头/单元格映射写入 `metrics_json`、`raw_row_json`；规范字段写入 `shop_daily_profit`。XLSX 仅归档到 `output/huice-shop-exports/<YYYYMMDD>.xlsx`。

新增脱敏 fixture，覆盖千分位、`--`、合计行、非拼店铺和表头列序变化。

- [ ] **Step 5: 验证并提交**

~~~bash
node --test test/huice-shop-export.test.mjs
node --check tools/huice-shop-export-cdp.mjs
node tools/huice-shop-export-cdp.mjs --days 1
git add tools/huice-shop-export-cdp.mjs scripts/huice/lib/db.mjs scripts/huice/lib/shop-profit.mjs test/huice-shop-export.test.mjs
git commit -m "feat(huice): export daily PDD shop profit"
~~~

手工运行只检查本地记录数、日期、店铺前缀、表头映射和“不分店铺下载”。严禁提交 XLSX、SQLite 或日志。

### Task 4: 提供本地店铺利润与映射 API

**Files:**
- Modify: `tools/huice-server.mjs`
- Create: `test/huice-server-shop-profit.test.mjs`
- Modify: `scripts/huice/lib/db.mjs`

**Interfaces:**

~~~text
GET  /shop-profit?mallId=<mallId>&start=YYYY-MM-DD&end=YYYY-MM-DD
POST /shop-profit/mapping/resolve
POST /shop-profit/mapping/confirm
~~~

- [ ] **Step 1: 写 API 测试**

用临时 SQLite 覆盖：

1. 未映射 mallId：HTTP 200、`status: "unmapped"`、空 records。
2. 一个候选店：resolve 自动持久化 `product_id_auto` 映射。
3. 两个候选店：resolve 返回 `ambiguous` 与候选列表，不写映射。
4. confirm 仅接受数据库存在且 `platform = pinduoduo` 的 `huiceName`；非法名返回 400。
5. 已映射查询按日期升序返回；服务不虚构缺失日期。

- [ ] **Step 2: 实现端点**

`GET /shop-profit` 固定响应：

~~~json
{
  "status": "ok",
  "mapping": {
    "mallId": "123",
    "huiceName": "拼【示例店】",
    "method": "product_id_auto"
  },
  "records": [
    {
      "date": "2026-07-09",
      "salesAmount": 1000,
      "rawNetProfit": 200,
      "orderCount": 20,
      "orderFixedCost": 23,
      "platformFee": 20,
      "netProfit": 157,
      "netProfitRate": 0.157
    }
  ]
}
~~~

`POST /shop-profit/mapping/resolve` body：`{ mallId, pddShopName, productIds }`。服务再次以 `product_profit` 中真实存在且 `net_profit IS NOT NULL` 的 ID 过滤。

`POST /shop-profit/mapping/confirm` body：`{ mallId, pddShopName, huiceName }`。成功时 `match_method = manual`。所有响应设置 JSON content type 和扩展所需 CORS；服务只监听 `127.0.0.1`。

- [ ] **Step 3: 验证并提交**

~~~bash
node --test test/huice-server-shop-profit.test.mjs
node --check tools/huice-server.mjs
git add tools/huice-server.mjs scripts/huice/lib/db.mjs test/huice-server-shop-profit.test.mjs
git commit -m "feat(server): expose daily shop profit and mapping"
~~~

### Task 5: 将店铺导出加入日常同步和 30 天回采

**Files:**
- Modify: `scripts/huice-daily.sh`
- Modify: `scripts/huice-daily.ps1`
- Modify: `docs/OPERATIONS.md`

- [ ] **Step 1: 接入两个每日脚本**

在商品导出成功之后、`write-storage` 之前加入：

~~~bash
node tools/huice-shop-export-cdp.mjs --days 1
~~~

PowerShell 用等价命令并检查 `$LASTEXITCODE`。店铺导出失败应使日任务失败，供精确补采；不得静默略过。

- [ ] **Step 2: 写入回采与补采命令**

在 `docs/OPERATIONS.md` 加入：

~~~bash
# 最近 30 个完整日期的店铺数据回采
node tools/huice-shop-export-cdp.mjs --days 30

# 仅补采失败日期
node tools/huice-shop-export-cdp.mjs --dates 2026-07-01,2026-07-02
~~~

注明运行前需要在 CDP Chrome 中打开并登录慧经营；拼多多推广平台需打开以便按需获取推广日数据。不得写真实账号、店铺名或回采结果。

- [ ] **Step 3: 验证并提交**

~~~bash
bash -n scripts/huice-daily.sh
git add scripts/huice-daily.sh scripts/huice-daily.ps1 docs/OPERATIONS.md
git commit -m "chore(sync): include daily shop profit export"
~~~

### Task 6: 用已命中商品 ID 自动映射当前拼多多店铺

**Files:**
- Modify: `dts/source/pdd-enhancer.js`
- Test: `test/shop-profit.test.mjs`

**Interfaces:**
- Consumes: `getEntityId()` 取得的 mallId、当前商品报表已命中的 productId、`POST /shop-profit/mapping/resolve`。
- Produces: 已确认 `pdd_shop_mapping`，或 `ambiguous/unmapped`。

- [ ] **Step 1: 保留无视觉副作用的 ID 收集器**

从 `getDialogPageData` / `collectMatchedReportRecords` 保留分页读取职责：只收集 `huiceMap[productId]` 存在且 `netProfit` 有效的 ID。保留原页恢复、5 秒翻页超时、200 页上限。

该收集器不得注入绿色/紫色列、不得改商品行、不得查询未命中商品，也不得切换到其他浮窗页签。它只在没有现成店铺映射时运行。

- [ ] **Step 2: 自动确认唯一映射**

当前 mallId 没有映射且收集成功时：

~~~js
await fetch("http://127.0.0.1:9911/shop-profit/mapping/resolve", {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ mallId, pddShopName, productIds: [...matchedProductIds] }),
});
~~~

只有返回 `auto_confirmed` 才继续读店铺数据。成功映射按 mallId 写入数据库；之后直接复用，避免每次翻商品页。

- [ ] **Step 3: 目标页签内处理不唯一映射**

`ambiguous` 时，只在店铺报表根节点显示候选店铺单选项和“确认”按钮。确认后调用 `/shop-profit/mapping/confirm` 并刷新 7 日表。

`unmapped` 时，只在店铺报表显示：“未匹配到慧经营店铺；请先打开一次该店铺的商品报表完成匹配。”禁止猜名称，禁止在商品列表或其他页签新增提示/控件。

- [ ] **Step 4: 手工验收**

1. 一个候选：自动持久化；第二次打开不翻商品页。
2. 两个候选：确认前不显示利润数字；人工确认后刷新。
3. 商品列表含大量未卖品：未卖 ID 不进入请求。
4. 重开扩展后已确认 mallId 仍可用。

- [ ] **Step 5: 提交**

~~~bash
git add dts/source/pdd-enhancer.js test/shop-profit.test.mjs
git commit -m "feat(mapping): resolve PDD shop from matched product IDs"
~~~

### Task 7: 在店铺报表渲染过去 7 天数据

**Files:**
- Modify: `dts/source/pdd-enhancer.js`
- Test: `test/shop-profit.test.mjs`

**Interfaces:**
- Consumes: `getStoreReportContext()`、确认的 mallId 映射、`GET /shop-profit`、单日推广分仓。
- Produces: `renderDailyStoreReport(context, rows)`，只创建/更新一个 `dts-shop-report-daily` 根节点。

- [ ] **Step 1: 读取 7 日利润骨架**

使用 `listPreviousCompleteDays(new Date(), 7)` 生成日期并请求：

~~~js
fetch("http://127.0.0.1:9911/shop-profit?mallId=" + encodeURIComponent(mallId)
  + "&start=" + start + "&end=" + end)
~~~

无论服务返回几天，都创建完整 7 天骨架；未返回日期保持 `shop: null`，不能压缩行数。网络、映射或数据错误只写在店铺报表状态区域。

- [ ] **Step 2: 按天补齐拼多多推广**

对 7 个单日窗口 `YYYY-MM-DD~YYYY-MM-DD` 逐个调用 `getPromoDataByWindow(window)`。分仓无数据时调用 `triggerOnDemandFetch(window)`，每 3 秒轮询一次，最多 3 次。为避免频控，串行请求，间隔至少 1.5 秒。

成功时先 `dedupeByScenesMode(records)`，再 `summarizePromoRecords(records)`。不可把“近 7 天”窗口数据拆分或平均给每天。

- [ ] **Step 3: 渲染固定表格和亏损样式**

在 `context.root` 创建紧凑表格，唯一根 class 为 `dts-shop-report-daily`。列严格为：

~~~text
日期 | 推广费用 | ROI | 保本 ROI | 费比 | 净利润率 | 净利润额
~~~

按 `buildStoreReportDay` 格式化。`isLoss === true` 的 `tr` 添加 `dts-shop-report-daily--loss`。CSS 只能匹配：

~~~css
.dts-shop-report-daily .dts-shop-report-daily--loss,
.dts-shop-report-daily .dts-shop-report-daily--loss * {
  color: #f5222d !important;
}
~~~

渲染可重复调用：更新同一根节点，不能在 `MutationObserver` 每次触发时创建第二张表。

- [ ] **Step 4: 限定刷新条件**

仅允许以下事件刷新：打开店铺报表、mallId 变化、映射确认成功、用户点击店铺报表内刷新图标、或本地数据更新时间变化。其他 4 个页签的 DOM 更新不能触发本功能。

同一 `mallId + 7 日窗口` 的进行中请求使用一个 Promise 缓存；离开店铺报表后不更新已移除 DOM。

- [ ] **Step 5: 端到端验收**

1. 已映射店铺默认恰好 7 行，日期从昨天向前连续。
2. 每天推广费用、ROI、费比与拼多多推广平台同日数据核对；ROI 等于官方汇总，不能是商品 ROI 平均。
3. 手算：`净利润率 = 净利润额 / 销售额`，`保本 ROI = 1 / 净利润率`。
4. 亏损日整行红；净利为 0 或缺失不标红。
5. 商品列表和另外 3 个页签与改前截图一致。
6. 停止服务、关闭推广平台标签、删除单日店铺数据时显示约定 `--`，不显示假 0。

- [ ] **Step 6: 总检查并提交**

~~~bash
npm test
npm run check:js
git add dts/source/pdd-enhancer.js test/shop-profit.test.mjs
git commit -m "feat(report): show seven-day shop profit"
~~~

### Task 8: 回采、审计和交付

**Files:**
- Modify: `README.md`（仅补使用入口和故障提示）
- Verify: 本计划涉及的所有文件

- [ ] **Step 1: 30 天回采，不提交数据**

~~~bash
node tools/huice-shop-export-cdp.mjs --days 30
~~~

检查 `failed-dates.json`；仅用其中日期执行 `--dates` 补采。随后检查 `git status --short`，不得出现 `private/`、`output/`、`.xlsx`、`.sqlite` 或真实数据的已暂存文件。

- [ ] **Step 2: 完整审计**

~~~bash
npm test
npm run check:js
git diff --check
git status --short
git diff origin/main...HEAD -- dts/source/pdd-enhancer.js scripts/huice/lib/db.mjs tools/huice-shop-export-cdp.mjs tools/huice-server.mjs
~~~

审计清单：

1. 新 UI 的所有 DOM 查找都从 `getStoreReportContext()` 开始。
2. 店铺报表没有旧 13 列，其他 4 个页签没有 DOM 改动。
3. SQL 仅用占位符，HTTP 仅用本地环回地址。
4. 不存在 SQLite、XLSX、下载、账号或真实数据提交。
5. 保本 ROI、费比、净利润率、推广 ROI 分子分母均符合本计划。

- [ ] **Step 3: 创建审阅 PR**

~~~bash
git add README.md
git commit -m "docs(report): explain daily shop profit"
git push -u origin HEAD
gh pr create --base main --head "$(git branch --show-current)" \
  --title "feat: 店铺报表展示 7 日利润数据" \
  --body "实现慧经营店铺日导出、商品 ID 自动映射和店铺报表 7 日推广利润展示。未包含 SQLite、XLSX 或回采数据。"
~~~

合并到 `main` 前必须完成 Task 7 端到端验收，并由审阅者逐项确认。

## 覆盖检查

- 慧经营全选拼店、清理残留“拼”、单日日期、查询、下载、选择“否”：Task 3。
- 本地店铺表、30 天回采、日常同步和不提交数据：Tasks 2、3、5、8。
- 商品 ID 自动映射、未卖商品排除与人工确认：Task 6。
- 7 个完整日、每天一行、字段与保本 ROI：Tasks 2、7。
- 绿色/紫色旧列清理与只改店铺报表：Task 1。
- 推广费用、ROI、费比、零推广与接口失败：Tasks 2、7。
- 亏损整行标红与其他页签不变：Tasks 1、7。

## 非目标

- 不在拼多多原生 `goods_list` 页面新增列。
- 不在商品列表或浮窗另外 3 个页签添加店铺利润 UI。
- 不按店铺名称模糊匹配；店名只用于显示，映射依据是已命中慧经营利润的商品 ID。
- 不把 7 天推广或利润合并成总数，也不平均任何比例。
- 不覆盖慧经营原始净利，不重复扣包装人工或平台费。

