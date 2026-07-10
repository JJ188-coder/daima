# 商品报表店铺利润汇总 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在拼多多商品报表的绿色商品利润列后显示按完整商品 ID 集合汇总的当前店铺利润。

**Architecture:** 慧经营每日“导出全部”继续写入 SQLite。扩展先自动读取当前商品报表所有分页的商品 ID，然后调用本地 HTTP 接口按日期和 ID 集合查询并汇总；本地服务不可用时复用扩展 storage 的记录。店铺名不参与匹配，所有空数据保持为空。

**Tech Stack:** Node.js ESM、better-sqlite3、原生 HTTP、Chrome MV3 content script、Element UI 2 的表格 store。

## Global Constraints

- 利润公式固定为 `原始净利 - 1.15 * 订单数 - 销售额 * 2%`，不得二次扣减。
- 销售件数等于订单数。
- 多日比例必须按汇总金额重新计算，不能平均比例。
- 匹配键只使用完整拼多多商品 ID；不得使用店名、商品名称或近似匹配。
- 数据缺失、超时或全量分页未完成时必须显示 `--`，不能返回零或估算值。
- 慧经营生产采集只使用 `tools/huice-export-cdp.mjs` 的“导出全部”路径。
- 保留用户原商品报表页码；自动收集完所有页或失败后均恢复。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `scripts/huice/lib/shop-summary.mjs` | 过滤指定商品 ID、聚合已入库记录、计算覆盖数与店铺金额。纯函数，可单测。 |
| `scripts/huice/lib/shop-summary-request.mjs` | 校验店铺汇总 HTTP 请求的日期和商品 ID 数组。纯函数，可单测。 |
| `scripts/huice/lib/db.mjs` | 在指定日期范围内按商品 ID 分批读取 `product_profit`。 |
| `tools/huice-server.mjs` | 增加 `POST /huice/shop-summary`，校验请求并返回 `shop-summary.mjs` 的结果。 |
| `dts/source/pdd-enhancer.js` | 收集商品报表全部分页 ID、请求汇总、storage 兜底，并在现有绿色列后插入店铺汇总列。 |
| `test/shop-summary.test.mjs` | 汇总金额、覆盖数、空数据、多日比例的单元测试。 |
| `test/shop-summary-db.test.mjs` | SQLite 商品 ID 过滤、日期边界与分批查询测试。 |
| `test/shop-summary-http.test.mjs` | HTTP 请求校验与成功响应测试。 |
| `README.md` | 说明店铺汇总依赖“导出全部”、覆盖商品的含义和空值规则。 |

### Task 1: 可测试的店铺汇总计算

**Files:**
- Create: `scripts/huice/lib/shop-summary.mjs`
- Create: `test/shop-summary.test.mjs`

**Interfaces:**
- Consumes: `aggregateProfitRecords(records)` from `scripts/huice/lib/profit.mjs`.
- Produces: `summarizeShopProfit(records, productIds)`.
- Return type:

```js
{
  productCount: number,
  matchedProductCount: number,
  unmatchedProductCount: number,
  summary: {
    salesAmount: number | null,
    rawNetProfit: number | null,
    orderFixedCost: number | null,
    platformFee: number | null,
    netProfit: number | null,
    netProfitRate: number | null,
  },
}
```

- [ ] **Step 1: 写失败测试，锁定 ID 过滤、多日汇总和覆盖数**

```js
test('summarizes only requested product IDs and recomputes rate', () => {
  const result = summarizeShopProfit([
    { productId: 'a', date: '2026-07-02', salesAmount: 100, rawNetProfit: 20, orderCount: 1 },
    { productId: 'a', date: '2026-07-03', salesAmount: 200, rawNetProfit: 60, orderCount: 2 },
    { productId: 'b', date: '2026-07-02', salesAmount: 100, rawNetProfit: 10, orderCount: 1 },
    { productId: 'outside', date: '2026-07-02', salesAmount: 999, rawNetProfit: 999, orderCount: 1 },
  ], ['a', 'b', 'missing']);

  assert.equal(result.productCount, 3);
  assert.equal(result.matchedProductCount, 2);
  assert.equal(result.unmatchedProductCount, 1);
  assert.equal(result.summary.salesAmount, 400);
  assert.equal(result.summary.rawNetProfit, 90);
  assert.equal(Number(result.summary.orderFixedCost.toFixed(2)), 4.6);
  assert.equal(result.summary.platformFee, 8);
  assert.equal(Number(result.summary.netProfit.toFixed(2)), 77.4);
  assert.equal(Number(result.summary.netProfitRate.toFixed(4)), 0.1935);
});
```

- [ ] **Step 2: 运行测试并确认因模块不存在而失败**

Run: `node --test test/shop-summary.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/huice/lib/shop-summary.mjs`.

- [ ] **Step 3: 实现纯汇总函数**

```js
import { aggregateProfitRecords } from './profit.mjs';

function sum(records, field) {
  const values = records.map(record => record[field]).filter(Number.isFinite);
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

export function summarizeShopProfit(records, productIds) {
  const requestedIds = new Set((productIds || []).map(String).filter(Boolean));
  const aggregated = aggregateProfitRecords(
    (records || []).filter(record => requestedIds.has(String(record.productId || record.product_id || '')))
  );
  const matched = aggregated.filter(record => Number.isFinite(record.netProfit));
  const salesAmount = sum(matched, 'salesAmount');
  const netProfit = sum(matched, 'netProfit');
  return {
    productCount: requestedIds.size,
    matchedProductCount: matched.length,
    unmatchedProductCount: requestedIds.size - matched.length,
    summary: {
      salesAmount,
      rawNetProfit: sum(matched, 'rawNetProfit'),
      orderFixedCost: sum(matched, 'orderFixedCost'),
      platformFee: sum(matched, 'platformFee'),
      netProfit,
      netProfitRate: salesAmount && salesAmount > 0 && netProfit !== null ? netProfit / salesAmount : null,
    },
  };
}
```

Keep records whose `netProfit` is zero. Exclude records whose `netProfit` is `null`, so coverage and money use the same population.

- [ ] **Step 4: 增加空 ID、重复 ID、缺少净利和零销售额测试**

```js
test('does not turn missing data into zero profit', () => {
  const result = summarizeShopProfit([
    { productId: 'a', salesAmount: 100, rawNetProfit: null, netProfit: null },
  ], ['a', 'a', '', 'missing']);
  assert.equal(result.productCount, 2);
  assert.equal(result.matchedProductCount, 0);
  assert.equal(result.summary.salesAmount, null);
  assert.equal(result.summary.netProfitRate, null);
});
```

- [ ] **Step 5: 运行新测试和现有利润测试**

Run: `node --test test/shop-summary.test.mjs test/profit-math.test.mjs`

Expected: all tests pass.

- [ ] **Step 6: 提交本任务**

```bash
git add scripts/huice/lib/shop-summary.mjs test/shop-summary.test.mjs
git commit -m "feat(profit): add store profit summary"
```

### Task 2: SQLite 按商品 ID 查询和本地汇总接口

**Files:**
- Modify: `scripts/huice/lib/db.mjs`
- Create: `scripts/huice/lib/shop-summary-request.mjs`
- Modify: `tools/huice-server.mjs`
- Create: `test/shop-summary-db.test.mjs`
- Create: `test/shop-summary-http.test.mjs`

**Interfaces:**
- Consumes: `summarizeShopProfit(records, productIds)` from Task 1.
- Produces: `getProductProfitRangeByIds(startDate, endDate, productIds)` and `POST /huice/shop-summary`.
- Request body must contain exactly `start`, `end`, and `productIds`; unknown keys are ignored.

- [ ] **Step 1: 写数据库查询失败测试**

Create an in-memory `product_profit` table with `product_id`, `date`, `sales_amount`, `raw_net_profit`, `net_profit`, `order_fixed_cost`, and `platform_fee`. Insert rows for IDs `a`, `b`, `outside` and dates on both sides of the range. Assert that `queryProductProfitRangeByIds(db, '2026-07-02', '2026-07-08', ['a', 'b'])` returns only `a` and `b` inside the range.

```js
test('queries only selected product IDs within the date range', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE product_profit (product_id TEXT, date TEXT, net_profit REAL)');
  db.prepare('INSERT INTO product_profit VALUES (?, ?, ?)').run('a', '2026-07-02', 1);
  db.prepare('INSERT INTO product_profit VALUES (?, ?, ?)').run('b', '2026-07-08', 2);
  db.prepare('INSERT INTO product_profit VALUES (?, ?, ?)').run('outside', '2026-07-02', 3);
  db.prepare('INSERT INTO product_profit VALUES (?, ?, ?)').run('a', '2026-07-01', 4);

  const rows = queryProductProfitRangeByIds(db, '2026-07-02', '2026-07-08', ['a', 'b']);
  assert.deepEqual(rows.map(row => row.product_id).sort(), ['a', 'b']);
});
```

- [ ] **Step 2: 运行数据库测试并确认查询函数不存在**

Run: `node --test test/shop-summary-db.test.mjs`

Expected: FAIL because `queryProductProfitRangeByIds` is not exported.

- [ ] **Step 3: 在数据库库中实现分批参数查询**

```js
export function queryProductProfitRangeByIds(db, startDate, endDate, productIds) {
  const ids = [...new Set((productIds || []).map(String).filter(Boolean))];
  const rows = [];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500);
    const placeholders = batch.map(() => '?').join(', ');
    rows.push(...db.prepare(
      `SELECT * FROM product_profit WHERE date BETWEEN ? AND ? AND product_id IN (${placeholders})`
    ).all(startDate, endDate, ...batch));
  }
  return rows;
}

export function getProductProfitRangeByIds(startDate, endDate, productIds) {
  return queryProductProfitRangeByIds(getDb(), startDate, endDate, productIds);
}
```

Chunk at 500 IDs so a large store never exceeds SQLite placeholder limits. Preserve the existing `getProductProfitByDate` and `getProductProfitRange` APIs.

- [ ] **Step 4: 写 HTTP 失败测试**

Create `scripts/huice/lib/shop-summary-request.mjs` with `parseShopSummaryRequest(payload)`. Test that pure parser with these cases:

```js
test('validates and de-duplicates a shop summary request', () => {
  assert.deepEqual(
    parseShopSummaryRequest({ start: '2026-07-02', end: '2026-07-08', productIds: ['a', 'a', 'b'] }),
    { start: '2026-07-02', end: '2026-07-08', productIds: ['a', 'b'] },
  );
});

test('rejects invalid shop summary requests', () => {
  assert.throws(() => parseShopSummaryRequest({ start: 'bad', end: '2026-07-08', productIds: ['a'] }));
  assert.throws(() => parseShopSummaryRequest({ start: '2026-07-02', end: '2026-07-08', productIds: [] }));
  assert.throws(() => parseShopSummaryRequest({ start: '2026-07-02', end: '2026-07-08', productIds: Array(10001).fill('a') }));
});
```

- [ ] **Step 5: 增加 HTTP 路由，保持现有 GET 行为不变**

Add a bounded JSON body reader and route before the existing 404 branch:

```js
if (path === '/huice/shop-summary') {
  if (req.method !== 'POST') return sendJson(res, { error: 'method not allowed' }, 405);
  const { start, end, productIds } = await readJsonBody(req, 1024 * 1024);
  validateDateRange(start, end);
  const ids = normalizeProductIds(productIds, 10000);
  const rows = getProductProfitRangeByIds(start, end, ids).map(mapRow);
  const result = summarizeShopProfit(rows, ids);
  return sendJson(res, { start, end, ...result });
}
```

Use this bounded reader; malformed JSON and bodies larger than 1 MiB must reject into the route's existing error response path:

```js
function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
```

Update CORS to allow `POST`, import the new database and summary helpers, and return structured 400 errors for invalid JSON, invalid dates, missing arrays and over-limit ID lists. Do not return unfiltered `product_profit` records from this endpoint.

Implement the parser exactly as follows so the route and test share validation behavior:

```js
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseShopSummaryRequest(payload) {
  if (!payload || !DATE.test(payload.start || '') || !DATE.test(payload.end || '')) {
    throw new Error('start and end must be YYYY-MM-DD');
  }
  if (!Array.isArray(payload.productIds)) throw new Error('productIds must be an array');
  const productIds = [...new Set(payload.productIds.map(value => String(value || '').trim()).filter(Boolean))];
  if (!productIds.length) throw new Error('productIds must not be empty');
  if (productIds.length > 10000) throw new Error('productIds exceeds 10000');
  return { start: payload.start, end: payload.end, productIds };
}
```

- [ ] **Step 6: 运行接口、数据库和旧测试**

Run: `npm test && npm run check:js`

Expected: all tests pass and `node --check tools/huice-server.mjs` passes.

- [ ] **Step 7: 提交本任务**

```bash
git add scripts/huice/lib/db.mjs tools/huice-server.mjs test/shop-summary-db.test.mjs test/shop-summary-http.test.mjs
git commit -m "feat(server): add store summary endpoint"
```

### Task 3: 商品报表完整分页商品 ID 收集

**Files:**
- Modify: `dts/source/pdd-enhancer.js`

**Interfaces:**
- Consumes: current dialog, current `renderData`, `readDialogDateWindow()` and the HTTP interface from Task 2.
- Produces: `collectAllDialogProductIds(dialog)` returning `{ ok, productIds, pageCount, reason }`.
- The collector never uses product name or shop name and never produces partial totals.

- [ ] **Step 1: 在现有 Vue 表格定位旁新增可复用的页面读取函数**

```js
function getDialogPageData(dialog) {
  const elTable = dialog.querySelector('.el-table');
  let tableComp = elTable?.__vue__ || null;
  for (let el = elTable; el && !tableComp; el = el.parentElement) tableComp = el.__vue__ || null;
  let dataComp = tableComp?.$parent || null;
  for (let depth = 0; dataComp && depth < 8; depth++, dataComp = dataComp.$parent) {
    if (Array.isArray(dataComp.$data?.renderData)) {
      const productIds = dataComp.$data.renderData
        .map(row => String(row?.itemId || row?.goodsId || ''))
        .filter(Boolean);
      return { tableComp, dataComp, productIds, signature: productIds.join(',') };
    }
  }
  return null;
}
```

- [ ] **Step 2: 实现逐页收集和恢复原页**

```js
async function collectAllDialogProductIds(dialog) {
  const first = getDialogPageData(dialog);
  const pager = dialog.querySelector('.el-pagination');
  const next = pager?.querySelector('.btn-next');
  const previous = pager?.querySelector('.btn-prev');
  if (!first || !pager || !next || !previous) return { ok: false, reason: 'pager or renderData unavailable' };

  const originalPage = Number(pager.querySelector('.number.active')?.textContent || 1);
  const ids = new Set();
  let pageCount = 0;
  try {
    while (true) {
      const page = getDialogPageData(dialog);
      if (!page) throw new Error('renderData unavailable');
      page.productIds.forEach(id => ids.add(id));
      pageCount++;
      if (next.disabled || next.classList.contains('disabled')) break;
      const before = page.signature;
      next.click();
      await waitForDialogPageChange(dialog, before, 5000);
    }
    return ids.size ? { ok: true, productIds: [...ids], pageCount } : { ok: false, reason: 'no product IDs' };
  } catch (error) {
    return { ok: false, reason: error.message };
  } finally {
    await restoreDialogPage(dialog, originalPage, previous, 5000);
  }
}
```

Implement the page wait and recovery helpers exactly as follows:

```js
async function waitForDialogPageChange(dialog, beforeSignature, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const page = getDialogPageData(dialog);
    if (page && page.signature !== beforeSignature) return page;
  }
  throw new Error('product report page did not change');
}

async function restoreDialogPage(dialog, originalPage, previous, timeoutMs) {
  try {
    while (true) {
      const activePage = Number(dialog.querySelector('.el-pager .number.active')?.textContent || 1);
      if (activePage <= originalPage || previous.disabled || previous.classList.contains('disabled')) return;
      const before = getDialogPageData(dialog)?.signature || '';
      previous.click();
      await waitForDialogPageChange(dialog, before, timeoutMs);
    }
  } catch (error) {
    console.warn(HUICE_NS, 'failed to restore original product-report page:', error.message);
  }
}
```

Add `if (pageCount >= 200) throw new Error('product report page limit exceeded');` before every next-page click. The `finally` block must await `restoreDialogPage` but must not replace a previous collection failure with a recovery error.

- [ ] **Step 3: 增加并发状态和缓存失效**

```js
let shopSummaryState = { key: '', status: 'idle', promise: null, result: null, reason: '' };

function shopSummaryKey(startDate, endDate, productIds) {
  return `${startDate}~${endDate}:${[...productIds].sort().join(',')}`;
}
```

Only one collection may run while `status === 'loading'`. Reuse a completed result only when the date range and complete ID set key are identical. The existing dialog mutation observer must call `tryInject()` after a collection resolves, while `tryInject()` must not start a second collection during page changes made by the collector.

- [ ] **Step 4: 在真实商品报表进行手动验证**

Verify with an already logged-in account:

1. Open a one-page product report and confirm one collection pass and no page movement after completion.
2. Open a multi-page report, start on a non-first page, confirm every page is visited, IDs are de-duplicated, and the original page is restored.
3. Change to another date range and confirm cache invalidates before a new result is shown.
4. Force one page-read timeout in the browser console and confirm the original page is restored and no partial summary is displayed.

- [ ] **Step 5: 运行语法检查并提交本任务**

Run: `npm run check:js`

Expected: PASS.

```bash
git add dts/source/pdd-enhancer.js
git commit -m "feat(report): collect all product IDs"
```

### Task 4: 店铺汇总请求、storage 兜底和表格列

**Files:**
- Modify: `dts/source/pdd-enhancer.js`

**Interfaces:**
- Consumes: `collectAllDialogProductIds`, `readDialogDateWindow`, `getHuiceDataByDateRange`, and `POST /huice/shop-summary`.
- Produces: `loadShopSummary(startDate, endDate, productIds)` and seven `huice-shop-*` row properties.

- [ ] **Step 1: 请求本地服务并实现 storage 兜底**

```js
async function loadShopSummary(startDate, endDate, productIds) {
  try {
    const response = await fetch('http://127.0.0.1:9911/huice/shop-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: startDate, end: endDate, productIds }),
      signal: AbortSignal.timeout(10000),
    });
    if (response.ok) return { ok: true, ...(await response.json()), source: 'http' };
  } catch (error) {}

  const records = await getHuiceDataByDateRange(startDate, endDate);
  const fallback = summarizeHuiceRecordsForProductIds(records, productIds);
  return fallback.matchedProductCount > 0
    ? { ok: true, ...fallback, source: 'storage' }
    : { ok: false, reason: 'no Huice data for selected report range' };
}
```

Implement the storage fallback with the same field and coverage rules as the server:

```js
function summarizeHuiceRecordsForProductIds(records, productIds) {
  const wanted = new Set(productIds.map(String));
  const byProduct = aggregateHuiceRecords((records || []).filter(record => wanted.has(String(record.productId || ''))));
  const matched = byProduct.filter(record => Number.isFinite(record.netProfit));
  const sum = field => {
    const values = matched.map(record => Number(record[field])).filter(Number.isFinite);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const salesAmount = sum('salesAmount');
  const netProfit = sum('netProfit');
  return {
    productCount: wanted.size,
    matchedProductCount: matched.length,
    unmatchedProductCount: wanted.size - matched.length,
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

- [ ] **Step 2: 定义并插入店铺汇总列**

Extend the existing `injectHuiceColumns` definition list after `huice-breakevenROI` with:

```js
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

Insert `SHOP_SUMMARY_COLS` immediately after the existing green profit columns, before any pre-existing “趋势” column. Use the same Element UI `store.commit('insertColumn', ...)` pattern, idempotency check and 100px width as existing columns. Render `huice-shop-netProfit` in red if negative; keep other populated values green; render `null` as `--`.

Define formatters before `SHOP_SUMMARY_COLS`:

```js
const money = value => value == null ? '--' : `¥${Number(value).toFixed(2)}`;
const percent = value => value == null ? '--' : `${(Number(value) * 100).toFixed(2)}%`;
const coverage = value => value == null ? '--' : String(value);
```

- [ ] **Step 3: 回填当前页的同一店铺汇总值**

```js
function fillShopSummaryRows(dataComp, renderData, result) {
  const summary = result?.summary;
  const coverage = result ? `${result.matchedProductCount} / ${result.productCount}` : null;
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

Call it after the product-level `huiceMap` fill. When the summary is pending or failed, pass `null`, which resets every store property to `null` and prevents stale totals from the prior date/search.

- [ ] **Step 4: 验收视觉和数据行为**

In the real product report verify:

1. Headers appear in this order: six existing green columns, seven store summary columns, then “趋势”.
2. Every row on a page has the same store summary values, while the first six columns remain product-specific.
3. Negative store adjusted profit is red.
4. A multi-day selected report has `店铺调整净利率 = 店铺调整净利 / 店铺销售额` to four decimal places before formatting.
5. Remove or hide one known product record locally: coverage drops, values change, and no column becomes `¥0.00` solely because data is missing.
6. Stop the local HTTP service: storage fallback produces the same values when storage exists; otherwise every store column is `--`.

- [ ] **Step 5: 运行全套检查并提交本任务**

Run: `npm test && npm run check:js && git diff --check`

Expected: all tests and syntax checks pass; no whitespace errors.

```bash
git add dts/source/pdd-enhancer.js
git commit -m "feat(report): show store profit summary columns"
```

### Task 5: 操作文档与最终回归

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: completed Tasks 1-4.
- Produces: a concise “商品报表店铺汇总” explanation for end users.

- [ ] **Step 1: 更新 README 的功能列表和常见问题**

Add these facts without changing the existing profit formula:

```markdown
- 商品报表会按当前店铺全部分页商品 ID 汇总店铺利润。
- “覆盖商品”显示“有慧经营利润的商品数 / 商品报表商品总数”。
- 覆盖不足或没有回采数据时，店铺汇总显示 `--`，不是零利润。
- 店铺汇总依赖每日的慧经营“导出全部”任务正常完成。
```

- [ ] **Step 2: 最终自动检查**

Run: `npm test && npm run check:js && git diff --check`

Expected: all tests pass and working tree contains only the README edit.

- [ ] **Step 3: 最终浏览器回归**

Use an already logged-in 商品报表 to verify one single-page case and one multi-page case against a manually calculated sample. Confirm the final visible order and the original-page restoration requirement.

- [ ] **Step 4: 提交本任务**

```bash
git add README.md
git commit -m "docs: explain product report store summary"
```

## Plan Self-Review

- Spec coverage: Tasks 1-2 implement exact ID filtering, database lookup, multi-day recomputation and empty data semantics. Tasks 3-4 implement full pagination collection, restore the user page, local HTTP/storage behavior and the requested column position. Task 5 documents the operational dependency and performs regression checks.
- Placeholder scan: passed; every failure case has a defined empty-result behavior.
- Type consistency: Task 1 returns `productCount`, `matchedProductCount`, `unmatchedProductCount` and `summary`; Task 2 returns that same object over HTTP; Task 4 reads exactly those field names.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-10-store-profit-summary.md`.

Two execution options:

1. **Subagent-Driven (recommended):** dispatch a fresh worker for each task, review between tasks.
2. **Inline Execution:** execute tasks in this session with checkpoints.
