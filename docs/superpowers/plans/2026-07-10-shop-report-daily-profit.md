# 店铺报表按日期利润数据 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在店透视浮窗的“店铺报表”里，按用户当前选择的日期范围，逐日展示当前登录拼多多店铺的推广费用、ROI、保本 ROI、费比、净利润率和净利润额；这些指标优先使用慧经营“多维利润分析 > 更多店铺展示/按店铺展示”里已经核算好的真实店铺费用和真实净利。

**Architecture:** 慧经营负责店铺级利润、推广费、人工费、平台费等真实费用口径，店透视浮窗只负责读取本地服务并展示。拼多多推广页只作为核对或慧经营字段缺失时的补充参考，不作为主计算口径。店铺映射不靠店名猜测，而是使用“当前商品列表里已经命中慧经营利润数据的商品 ID”反查它们在慧经营中的店铺；唯一候选自动绑定，多个候选进入待确认状态。

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
- 慧经营当天缺少推广费字段：推广费用、ROI、费比显示 `--`，并保留原始行 JSON 供排查；只有用户确认后才允许用拼多多推广页补字段。
- 慧经营当天无该店铺数据：净利润额、净利润率、保本 ROI、推广费用、ROI、费比均为 `--`。
- 昨天显示 1 行，近 7 日显示 7 行，近 1 月显示完整日期范围内每日一行，自定义日期按实际起止日期显示。

## 当前代码事实

- `dts/source/pdd-enhancer.js` 目前已经有商品利润列、店铺汇总列、商品 ID 抽取、慧经营数据读取、拼多多推广数据读取等逻辑。新功能优先复用商品 ID 抽取和本地服务读取能力，不要另写一套页面探测。
- 当前源码里没有稳定的“店铺报表”字符串和唯一页签 key。页面截图里用户叫它“店铺报表”，源码里此前很多逻辑实际插到了通用弹窗表格。必须先确认运行时页签标识，再动 UI。
- `tools/huice-export-cdp.mjs` 已有商品维度的日期切换、查询、下载中心、失败日期机制。店铺维度导出可以复用思路，但不能把店铺数据写进商品表。
- `scripts/huice/lib/db.mjs` 已有商品利润相关表。新功能必须新增独立店铺日表和店铺映射表，旧表保持兼容。店铺日表保存慧经营真实字段，不保存估算后的“调整净利”。
- 过去已经出现过主仓库误包含 30 天回采数据的问题。之后所有真实数据文件必须被 `.gitignore` 挡住，并在提交前用 `git status --ignored` 检查。

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
  -> 必要时用拼多多推广页做人工核对，不作为默认主口径
  -> 店铺报表逐日展示
```

## 文件变更地图

| 文件 | 责任 |
| --- | --- |
| `scripts/huice/lib/shop-profit.mjs` | 新建。纯函数：日期范围、XLSX 店铺行解析、真实费用字段规范化、店铺指标计算、映射候选、展示行格式化。 |
| `scripts/huice/lib/db.mjs` | 新增 `shop_daily_profit`、`pdd_shop_mapping` 表和查询/upsert API。 |
| `tools/huice-shop-export-cdp.mjs` | 新建。控制慧经营页面，按日下载全部拼多多店铺数据，选择“不分店铺下载”，解析并入库。 |
| `tools/huice-server.mjs` | 新增店铺利润查询、店铺映射候选、人工确认映射接口。 |
| `scripts/huice-daily.sh` | macOS 每日同步中加入店铺日导出。 |
| `scripts/huice-daily.ps1` | Windows 每日同步中加入店铺日导出。 |
| `dts/source/pdd-enhancer.js` | 只在店铺报表页签读取日期范围并渲染逐日店铺数据；商品列表和其他页签不动。 |
| `test/shop-profit.test.mjs` | 新建。单元测试纯计算、解析和映射。 |
| `test/huice-shop-export.test.mjs` | 新建。测试慧经营选择器字符串、表头解析和合计行过滤。 |
| `test/huice-server-shop-profit.test.mjs` | 新建。临时 SQLite 测本地服务查询和映射状态。 |
| `docs/OPERATIONS.md` | 追加店铺回采、补采、排错命令，不写真实数据。 |

---

## Task 0: 停止半成品执行并建立审核分支

**Files:**
- Modify: none

**Interfaces:**
- Produces: 一个只包含计划或后续实现提交的干净分支。

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

- [ ] **Step 2: 确认当前不在 `main` 上改代码**

Run:

```bash
git status --short --branch
```

Expected: 当前分支是 `codex/...`，不是 `main`。如果在 `main`：

```bash
git switch -c codex/2026-07-10-shop-report-daily
git push -u origin HEAD
```

- [ ] **Step 3: 确认真实数据不会入 Git**

Run:

```bash
git status --ignored --short private output | sed -n '1,80p'
```

Expected: `private/`、`output/` 下真实数据只出现在 `!!` 忽略项里，不出现在 `??` 或 `M`。

- [ ] **Step 4: 本任务提交策略**

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
- Create: `scripts/huice/lib/shop-profit.mjs`
- Modify: `scripts/huice/lib/db.mjs`
- Create: `test/shop-profit.test.mjs`
- Create: `test/shop-profit-db.test.mjs`

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
```

Run:

```bash
npm test -- test/shop-profit.test.mjs
```

Expected: FAIL because new functions do not exist.

- [ ] **Step 2: 实现真实店铺指标函数**

在 `scripts/huice/lib/shop-profit.mjs` 实现：

```js
export function toNumber(value) {
  if (value == null || value === '' || value === '--') return null;
  const normalized = String(value).replace(/[,%¥,\s]/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
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
1. 第一行必须当表头。
2. 通过表头文字找列号，不能用固定列号。
3. 店铺名为空、店铺名为“合计”的行跳过。
4. `netProfit` 缺失时整行保留，但净利润额显示 `--`。
5. `promoSpend` 缺失时推广费用、ROI、费比显示 `--`，不能自动改用拼多多推广页，除非用户单独确认。
6. 所有未显式建列的慧经营费用字段放进 `metricsJson`，`rawRowJson` 保存原始行，方便后续查错。
7. 这些规则只作用于新增店铺日报数据，不影响商品级利润解析和商品列表真列。
```

- [ ] **Step 5: 写 DB 测试**

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

  db.upsertShop({ shopName: '拼【周贝瑞' });
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

新增表：

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
```

所有 SQL 使用占位符。不得拼接 `mallId`、`shopName`、日期字符串。

旧的商品级 `daily_profit`、`product_profit` 字段和计算逻辑不改；新增字段只进 `shop_daily_profit`。

- [ ] **Step 7: 提交**

```bash
git add scripts/huice/lib/shop-profit.mjs scripts/huice/lib/db.mjs test/shop-profit.test.mjs test/shop-profit-db.test.mjs
git commit -m "feat(profit): add shop daily profit model"
```

---

## Task 3: 实现慧经营店铺日导出器

**Files:**
- Create: `tools/huice-shop-export-cdp.mjs`
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

不要直接改商品导出器。店铺导出器单独建文件，避免破坏现有每日商品采集。

- [ ] **Step 2: 写 selector 测试**

在 `test/huice-shop-export.test.mjs` 固定选择器常量：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HUICE_SHOP_SELECTORS,
  buildShopExportArgs,
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
  assert.deepEqual(buildShopExportArgs({ dates: '2026-07-09' }).dates, ['2026-07-09']);
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

关键等待表达式：

```js
(() => {
  const names = [...document.querySelectorAll('.dc-shop .level2-item')]
    .map((node) => (node.innerText || '').trim())
    .filter(Boolean);
  return names.length > 0 && names.every((name) => name.startsWith('拼'));
})()
```

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

- [ ] **Step 7: 下载中心匹配本次文件**

跳转到下载中心后，只下载符合全部条件的文件：

```text
文件名或任务名包含“店铺多维度分析”
创建时间 >= 本次点击下载前 60 秒
状态为完成/可下载
不是分店铺多文件包
```

如果一页找不到，等待并刷新，不要下载旧文件。

- [ ] **Step 8: 解析 XLSX 并入库**

使用 `openpyxl` 或现有 XLSX 读取能力把表格转成二维数组，再调用：

```js
const records = parseShopExportRows(rows, date);
for (const record of records) {
  const shop = upsertShop({ shopName: record.shopName });
  upsertShopDailyProfit({ ...record, shopId: shop.shop_id });
}
```

不得把真实 XLSX fixture 提交。测试 fixture 必须脱敏、最小化。

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

- [ ] **Step 2: 服务端反查候选店铺**

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

- [ ] **Step 3: 显示映射状态**

店铺报表数据区域顶部加一行状态：

```text
未匹配到慧经营店铺：--
匹配到多个慧经营店铺：请确认映射
已匹配：拼【周贝瑞
```

不要用店名猜测自动绑定。

- [ ] **Step 4: 人工确认接口**

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

- [ ] **Step 5: 提交**

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
      "roi": 4.2,
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

测试 4 种状态：

```text
ok: 有映射、有利润数据
no_mapping: mallId 没有映射
ambiguous: 候选不唯一
no_data: 有映射但日期无数据
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

这样前端可以保持昨天/近 7 日/近 1 月的日期行完整。

- [ ] **Step 3: 合并推广数据**

本地服务直接返回慧经营店铺导出中的真实推广费、真实净利、净利率、费比和 ROI。前端不再默认从拼多多推广页补主数据；拼多多推广页只作为人工核对或用户另行确认后的缺字段补充来源。

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

- [ ] **Step 4: 提交**

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
const response = await fetch(`http://127.0.0.1:9911/shop-profit?mallId=${encodeURIComponent(mallId)}&start=${start}&end=${end}`);
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

每次渲染前只删除自己创建的节点：

```js
context.root.querySelectorAll('.dts-store-profit-panel').forEach((node) => node.remove());
```

不能清空整个表格、不能删除已有绿色/紫色列、不能动其他页签 DOM。

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

- [ ] **Step 4: 接入 Windows 每日同步**

在 `scripts/huice-daily.ps1` 商品同步完成后追加等价命令：

```powershell
node "$ProjectDir/tools/huice-shop-export-cdp.mjs" --dates $Yesterday
```

- [ ] **Step 5: 文档补命令**

在 `docs/OPERATIONS.md` 写清：

```text
单日店铺补采
30 天店铺回采
失败日期重试
确认 private/output 不入 Git
本地服务启动后如何刷新扩展
```

- [ ] **Step 6: 提交**

```bash
git add scripts/huice-daily.sh scripts/huice-daily.ps1 docs/OPERATIONS.md
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

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-10-shop-report-daily-profit.md`.

推荐执行方式：

1. 先由用户审核本计划，不审核通过不要继续实现。
2. 审核通过后，从干净分支开始做 Task 0。
3. 每完成一个 Task 就提交一次，并把测试结果写进提交说明或 PR 描述。
4. 完成 Task 8 后再由用户确认是否推送和合并。
