# 商品报表店铺利润汇总 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在拼多多商品报表的绿色商品利润列后显示店铺汇总，且只汇总当前报表中已显示慧经营绿色利润数据的商品。

**Architecture:** 慧经营每日“导出全部”继续写入 SQLite，并由现有 `getHuiceDataByDateRange` 读成按商品 ID 聚合的 `huiceMap`。扩展逐页查看当前拼多多报表行，仅把 `huiceMap` 中已有有效净利的商品收录进店铺汇总；不把未卖商品 ID 传给数据库，也不新增数据库查询接口。

**Tech Stack:** Node.js ESM、Chrome MV3 content script、Element UI 2 的表格 store、现有本地 HTTP 数据服务和 `chrome.storage.local`。

## Global Constraints

- 利润公式固定为 `原始净利 - 1.15 * 订单数 - 销售额 * 2%`，不得二次扣减。
- 销售件数等于订单数。
- 多日比例必须按汇总金额重新计算，不能平均比例。
- 可汇总商品必须同时满足：商品报表 ID 与 `huiceMap` 键精确相同，且 `netProfit` 为有效数值。
- 未卖、未导出、无净利的商品不得进入店铺总额、不得触发数据库查询。
- 某商品的调整后净利润小于零时，该商品行所有数据单元格必须标红；店铺调整净利为负时只标红店铺调整净利单元格。
- 商品报表仍需逐页读取，避免漏掉后面页里已有绿色利润的商品；逐页读取仅做内存 `Map` 判断。
- 数据缺失、超时或分页未完成时必须显示 `--`，不能返回零或估算值。
- 慧经营生产采集只使用 `tools/huice-export-cdp.mjs` 的“导出全部”路径。
- 保留用户原商品报表页码；自动读取结束或失败后均恢复。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `scripts/huice/lib/profit.mjs` | 增加可测试的“已筛选商品记录 -> 店铺总额”纯汇总函数。 |
| `dts/source/pdd-enhancer.js` | 从现有 `huiceMap` 筛选绿色利润商品、逐页收录、恢复页码并插入店铺汇总列。 |
| `test/profit-math.test.mjs` | 验证店铺汇总金额、多日比例、零利润和空数据。 |
| `README.md` | 说明店铺汇总只计算绿色慧经营利润商品，以及“覆盖商品”的含义。 |

### Task 1: 店铺汇总纯计算与测试

**Files:**
- Modify: `scripts/huice/lib/profit.mjs`
- Modify: `test/profit-math.test.mjs`

**Interfaces:**
- Consumes: `aggregateProfitRecords(records)` from the same module.
- Produces: `summarizeProfitRecords(records)`.
- Input records are already exact-ID filtered by the extension; this function must not perform fuzzy matching or database work.

- [ ] **Step 1: 先写失败测试，锁定金额、比例与空值口径**

```js
test('summarizes only already matched Huice records for a store', () => {
  const result = summarizeProfitRecords([
    { productId: 'a', date: '2026-07-02', salesAmount: 100, rawNetProfit: 20, orderCount: 1 },
    { productId: 'a', date: '2026-07-03', salesAmount: 200, rawNetProfit: 60, orderCount: 2 },
    { productId: 'b', date: '2026-07-02', salesAmount: 100, rawNetProfit: 10, orderCount: 1 },
  ]);

  assert.equal(result.matchedProductCount, 2);
  assert.equal(result.summary.salesAmount, 400);
  assert.equal(result.summary.rawNetProfit, 90);
  assert.equal(Number(result.summary.orderFixedCost.toFixed(2)), 4.6);
  assert.equal(result.summary.platformFee, 8);
  assert.equal(Number(result.summary.netProfit.toFixed(2)), 77.4);
  assert.equal(Number(result.summary.netProfitRate.toFixed(4)), 0.1935);
});

test('keeps missing Huice profit out of the store summary', () => {
  const result = summarizeProfitRecords([
    { productId: 'missing-profit', salesAmount: 100, rawNetProfit: null, netProfit: null },
  ]);
  assert.equal(result.matchedProductCount, 0);
  assert.equal(result.summary.salesAmount, null);
  assert.equal(result.summary.netProfit, null);
  assert.equal(result.summary.netProfitRate, null);
});
```

- [ ] **Step 2: 运行测试并确认新函数尚不存在**

Run: `node --test test/profit-math.test.mjs`

Expected: FAIL because `summarizeProfitRecords` is not exported.

- [ ] **Step 3: 实现只汇总已筛选记录的纯函数**

```js
export function summarizeProfitRecords(records) {
  const aggregated = aggregateProfitRecords(records);
  const matched = aggregated.filter(record => Number.isFinite(record.netProfit));
  const sum = field => {
    const values = matched.map(record => record[field]).filter(Number.isFinite);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const salesAmount = sum('salesAmount');
  const netProfit = sum('netProfit');
  return {
    matchedProductCount: matched.length,
    summary: {
      salesAmount,
      rawNetProfit: sum('rawNetProfit'),
      orderFixedCost: sum('orderFixedCost'),
      platformFee: sum('platformFee'),
      netProfit,
      netProfitRate: salesAmount && salesAmount > 0 && netProfit !== null ? netProfit / salesAmount : null,
    },
  };
}
```

Keep `netProfit === 0` as a valid match. `netProfit === null` means the product must not contribute any monetary field.

- [ ] **Step 4: 运行回归测试并提交**

Run: `npm test && npm run check:js`

Expected: all tests pass.

```bash
git add scripts/huice/lib/profit.mjs test/profit-math.test.mjs
git commit -m "feat(profit): summarize matched store records"
```

### Task 2: 只收录已有绿色利润的商品 ID

**Files:**
- Modify: `dts/source/pdd-enhancer.js`

**Interfaces:**
- Consumes: `getHuiceDataByDateRange(startDate, endDate)`, `readDialogDateWindow()` and current Vue `renderData`.
- Produces: `collectMatchedReportRecords(dialog, huiceMap)` returning `{ ok, scannedProductIds, matchedRecords, pageCount, reason }`.
- `matchedRecords` is a `Map<productId, huiceRecord>` and contains only records whose existing green product-level profit is usable.

- [ ] **Step 1: 抽出当前页商品 ID 与已命中慧经营记录**

Add a helper adjacent to the existing `renderData` lookup:

```js
function getDialogPageData(dialog, huiceMap) {
  const elTable = dialog.querySelector('.el-table');
  let tableComp = elTable?.__vue__ || null;
  for (let el = elTable; el && !tableComp; el = el.parentElement) tableComp = el.__vue__ || null;
  let dataComp = tableComp?.$parent || null;
  for (let depth = 0; dataComp && depth < 8; depth++, dataComp = dataComp.$parent) {
    const renderData = dataComp.$data?.renderData;
    if (!Array.isArray(renderData)) continue;
    const scannedProductIds = new Set();
    const matchedRecords = new Map();
    for (const row of renderData) {
      const productId = String(row?.itemId || row?.goodsId || '');
      if (!productId) continue;
      scannedProductIds.add(productId);
      const huice = huiceMap[productId];
      if (huice && Number.isFinite(huice.netProfit)) matchedRecords.set(productId, huice);
    }
    return {
      tableComp,
      dataComp,
      renderData,
      scannedProductIds,
      matchedRecords,
      signature: [...scannedProductIds].sort().join(','),
    };
  }
  return null;
}
```

Do not call `fetch`, `chrome.storage`, the local server or a database in this helper. Its only lookup is `huiceMap[productId]`.

- [ ] **Step 2: 逐页合并已命中记录并恢复原页**

```js
async function collectMatchedReportRecords(dialog, huiceMap) {
  const initial = getDialogPageData(dialog, huiceMap);
  const pager = dialog.querySelector('.el-pagination');
  const next = pager?.querySelector('.btn-next');
  const previous = pager?.querySelector('.btn-prev');
  if (!initial || !pager || !next || !previous) return { ok: false, reason: 'pager or renderData unavailable' };

  const originalPage = Number(pager.querySelector('.el-pager .number.active')?.textContent || 1);
  const scannedProductIds = new Set();
  const matchedRecords = new Map();
  let pageCount = 0;
  try {
    while (true) {
      const page = getDialogPageData(dialog, huiceMap);
      if (!page) throw new Error('renderData unavailable');
      page.scannedProductIds.forEach(id => scannedProductIds.add(id));
      page.matchedRecords.forEach((record, id) => matchedRecords.set(id, record));
      pageCount++;
      if (next.disabled || next.classList.contains('disabled')) break;
      if (pageCount >= 200) throw new Error('product report page limit exceeded');
      next.click();
      await waitForDialogPageChange(dialog, page.signature, huiceMap, 5000);
    }
    return { ok: true, scannedProductIds, matchedRecords, pageCount };
  } catch (error) {
    return { ok: false, reason: error.message };
  } finally {
    await restoreDialogPage(dialog, originalPage, previous, huiceMap, 5000);
  }
}
```

```js
async function waitForDialogPageChange(dialog, beforeSignature, huiceMap, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const page = getDialogPageData(dialog, huiceMap);
    if (page && page.signature !== beforeSignature) return page;
  }
  throw new Error('product report page did not change');
}

async function restoreDialogPage(dialog, originalPage, previous, huiceMap, timeoutMs) {
  try {
    while (true) {
      const activePage = Number(dialog.querySelector('.el-pager .number.active')?.textContent || 1);
      if (activePage <= originalPage || previous.disabled || previous.classList.contains('disabled')) return;
      const before = getDialogPageData(dialog, huiceMap)?.signature || '';
      previous.click();
      await waitForDialogPageChange(dialog, before, huiceMap, timeoutMs);
    }
  } catch (error) {
    console.warn(HUICE_NS, 'failed to restore original product-report page:', error.message);
  }
}
```

The collector must discard every temporary set on failure. A page that has no green data is valid and contributes only to `scannedProductIds`; it must not cause a database lookup.

- [ ] **Step 3: 防止并发翻页与过期汇总**

```js
let shopSummaryState = { status: 'idle', key: '', promise: null, result: null, reason: '' };

function shopSummaryKey(dialog, startDate, endDate, huiceRecords, firstPage) {
  const filters = [...dialog.querySelectorAll('input, select')]
    .map(element => `${element.placeholder || element.name || element.type}:${element.value || ''}`)
    .join('|');
  const pager = (dialog.querySelector('.el-pagination')?.innerText || '').replace(/\s+/g, ' ');
  const huiceIds = (huiceRecords || []).map(record => String(record.productId || '')).filter(Boolean).sort().join(',');
  return `${startDate}~${endDate}:${filters}:${pager}:${firstPage.signature}:${huiceIds}`;
}
```

Call `getDialogPageData(dialog, huiceMap)` before building this key. Set `status` to `loading` before any pagination click. While loading, the existing `MutationObserver` may refresh product-level green cells but must not start another collection. When the promise resolves, set `status` to `ready` or `failed`, store the result/reason and call `tryInject()` once after the original page has been restored. Create a new state whenever the date range, search input, filter control, pager total, first-page IDs or loaded `huiceRecords` ID signature changes.

- [ ] **Step 4: 在真实商品报表验证收录范围**

1. 打开一页商品报表，记下有绿色净利润的商品 ID；确认 `matchedRecords` 只包含这些 ID。
2. 打开多页商品报表，确认每页都被读取、没有绿色数据的页不会增加 `matchedRecords`、原页码会恢复。
3. 在含大量未卖商品的店铺确认：每页只执行 `huiceMap[id]` 判断，控制台没有新的 `/huice/shop-summary`、数据库或慧经营请求。
4. 模拟一页切换超时，确认店铺汇总不显示、当前页恢复。

- [ ] **Step 5: 运行语法检查并提交**

Run: `npm run check:js`

Expected: PASS.

```bash
git add dts/source/pdd-enhancer.js
git commit -m "feat(report): collect matched product records"
```

### Task 3: 店铺汇总列回填与整行亏损标红

**Files:**
- Modify: `dts/source/pdd-enhancer.js`

**Interfaces:**
- Consumes: completed `collectMatchedReportRecords`, `aggregateHuiceRecords` and current page `renderData`.
- Produces: `summarizeMatchedHuiceRecords(records)` and seven `huice-shop-*` row properties.

- [ ] **Step 1: 在扩展内汇总已命中的慧经营记录**

```js
function summarizeMatchedHuiceRecords(records) {
  const aggregated = aggregateHuiceRecords(records);
  const matched = aggregated.filter(record => Number.isFinite(record.netProfit));
  const sum = field => {
    const values = matched.map(record => Number(record[field])).filter(Number.isFinite);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const salesAmount = sum('salesAmount');
  const netProfit = sum('netProfit');
  return {
    matchedProductCount: matched.length,
    summary: {
      salesAmount,
      rawNetProfit: sum('rawNetProfit'),
      orderFixedCost: sum('orderFixedCost'),
      platformFee: sum('platformFee'),
      netProfit,
      netProfitRate: salesAmount && salesAmount > 0 && netProfit !== null ? netProfit / salesAmount : null,
    },
  };
}
```

Pass `Array.from(collection.matchedRecords.values())` to this function only after `collection.ok === true`. Set `scannedProductCount` from `collection.scannedProductIds.size` and retain no result after a failed collection.

- [ ] **Step 2: 定义并插入店铺汇总列**

Extend the existing `injectHuiceColumns` definition after `huice-breakevenROI` with:

```js
const money = value => value == null ? '--' : `¥${Number(value).toFixed(2)}`;
const percent = value => value == null ? '--' : `${(Number(value) * 100).toFixed(2)}%`;
const coverage = value => value == null ? '--' : String(value);

const SHOP_SUMMARY_COLS = [
  { property: 'huice-shop-salesAmount', label: '店铺销售额', fmt: money },
  { property: 'huice-shop-rawNetProfit', label: '店铺原始净利', fmt: money },
  { property: 'huice-shop-orderFixedCost', label: '包装人工', fmt: money },
  { property: 'huice-shop-platformFee', label: '平台费', fmt: money },
  { property: 'huice-shop-netProfit', label: '店铺调整净利', fmt: money },
  { property: 'huice-shop-netProfitRate', label: '店铺调整净利率', fmt: percent },
  { property: 'huice-shop-coverage', label: '覆盖商品', fmt: coverage },
];
```

Insert these seven columns immediately after the existing green product columns and before “趋势”. Use the existing Element UI `store.commit('insertColumn', ...)` and idempotency pattern. Render `huice-shop-netProfit` in red when negative, other populated values in green, and all `null` values as `--`.

- [ ] **Step 3: 回填当前页的同一店铺汇总值**

```js
function fillShopSummaryRows(dataComp, renderData, result) {
  const summary = result?.summary;
  const coverage = result ? `${result.matchedProductCount} / ${result.scannedProductCount}` : null;
  for (const row of renderData) {
    dataComp.$set(row, 'huice-shop-salesAmount', summary?.salesAmount ?? null);
    dataComp.$set(row, 'huice-shop-rawNetProfit', summary?.rawNetProfit ?? null);
    dataComp.$set(row, 'huice-shop-orderFixedCost', summary?.orderFixedCost ?? null);
    dataComp.$set(row, 'huice-shop-platformFee', summary?.platformFee ?? null);
    dataComp.$set(row, 'huice-shop-netProfit', summary?.netProfit ?? null);
    dataComp.$set(row, 'huice-shop-netProfitRate', summary?.netProfitRate ?? null);
    dataComp.$set(row, 'huice-shop-coverage', coverage);
  }
}
```

Call this after the current product-level green column fill. Pass `null` while loading or after any failure to reset all seven properties and prevent stale store totals from a prior date or filter.

- [ ] **Step 4: 给亏损商品整行添加样式类**

```js
function ensureLossRowStyle() {
  if (document.getElementById('dts-huice-loss-row-style')) return;
  const style = document.createElement('style');
  style.id = 'dts-huice-loss-row-style';
  style.textContent = `
    .dts-huice-loss-row > td,
    .dts-huice-loss-row > td .cell,
    .dts-huice-loss-row > td .cell * {
      color: #f5222d !important;
    }
  `;
  document.head.appendChild(style);
}

function applyLossRowHighlight(dialog, renderData, huiceMap) {
  ensureLossRowStyle();
  const table = dialog.querySelector('.el-table');
  const bodies = [
    table?.querySelector('.el-table__body-wrapper'),
    table?.querySelector('.el-table__fixed .el-table__fixed-body-wrapper'),
    table?.querySelector('.el-table__fixed-right .el-table__fixed-body-wrapper'),
  ].filter(Boolean);
  for (const body of bodies) {
    const rows = body.querySelectorAll('tbody tr.el-table__row');
    rows.forEach((element, index) => {
      const productId = String(renderData[index]?.itemId || renderData[index]?.goodsId || '');
      const isLoss = Number(huiceMap[productId]?.netProfit) < 0;
      element.classList.toggle('dts-huice-loss-row', isLoss);
    });
  }
}
```

Call `applyLossRowHighlight(dialog, renderData, huiceMap)` after every product-level and store-level row fill, including after a date switch and table page change. The `!important` color is required because existing green-column render functions set inline colors.

- [ ] **Step 5: 验收页面与数据行为**

1. 列顺序为：六个原商品绿色列、七个店铺汇总列、“趋势”。
2. 当前页每一行显示同一组店铺汇总，原六列仍是商品各自数据。
3. 所有店铺金额只等于有绿色利润商品的金额之和；未卖商品不纳入。
4. 多日的店铺调整净利率等于 `店铺调整净利 / 店铺销售额`。
5. 停止本地 HTTP 服务后，已有 storage 数据仍能产生相同结果；两个数据通道都无数据时全部显示 `--`。
6. 选一个商品级调整后净利润小于零的行，确认它的商品名称、原始拼多多数据、商品利润列和店铺汇总列均显示红色；相邻盈利行不变。
7. 让店铺总调整净利为负但当前商品净利为正，确认只“店铺调整净利”单元格为红色，当前商品行其他单元格不被误标。

- [ ] **Step 6: 运行全套检查并提交**

Run: `npm test && npm run check:js && git diff --check`

Expected: all tests and syntax checks pass; no whitespace errors.

```bash
git add dts/source/pdd-enhancer.js
git commit -m "feat(report): show matched store profit summary"
```

### Task 4: 操作文档与最终回归

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: a concise “商品报表店铺汇总” explanation for end users.

- [ ] **Step 1: 更新 README 的功能列表和常见问题**

Add these facts without changing the existing profit formula:

```markdown
- 商品报表会只汇总已显示慧经营绿色利润数据的商品。
- “覆盖商品”显示“有绿色慧经营利润的商品数 / 已扫描商品报表商品数”。
- 未卖商品不会触发数据库查询，也不会被按零利润计入。
- 覆盖不足或没有回采数据时，店铺汇总显示 `--`，不是零利润。
- 店铺汇总依赖每日的慧经营“导出全部”任务正常完成。
```

- [ ] **Step 2: 最终自动检查**

Run: `npm test && npm run check:js && git diff --check`

Expected: all tests pass and working tree contains only the README edit.

- [ ] **Step 3: 最终浏览器回归**

Use an already logged-in 商品报表 to verify one single-page case and one multi-page case. Manually add only the item-level green profits and confirm the store total equals that sum; confirm the original page is restored.

- [ ] **Step 4: 提交本任务**

```bash
git add README.md
git commit -m "docs: explain matched product store summary"
```

## Plan Self-Review

- Spec coverage: Task 1 locks down the amount and multi-day formula. Task 2 implements exact in-memory filtering, full report-page scanning, failure reset and page restoration without database ID lookups. Task 3 adds the requested columns and ensures empty results remain empty. Task 4 documents the final operating rule and runs regression checks.
- Placeholder scan: passed; every failure case has a defined empty-result behavior.
- Type consistency: Task 2 returns `scannedProductIds` and `matchedRecords`; Task 3 produces `scannedProductCount`, `matchedProductCount` and `summary` before it fills columns with those fields.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-10-store-profit-summary.md`.

Two execution options:

1. **Subagent-Driven (recommended):** dispatch a fresh worker for each task, review between tasks.
2. **Inline Execution:** execute tasks in this session with checkpoints.
