# 慧经营与拼多多采集可靠性修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让商品重采原子覆盖同日旧行，稳定日期选择和下载业务层，正确管理失败标记，并确保推广费只从 `mallId=338884784` 的目标店铺页面采集。

**Architecture:** 保留现有三个采集器和数据库结构，只增加日期快照替换 API、明确的成功状态、可见日期面板规则、AG-Grid 业务层句柄及纯函数推广标签页规划器。所有破坏性操作先由测试约束，商品删除与写入在同一 SQLite 事务中完成，下载操作始终绑定同一个已验证业务根层。

**Tech Stack:** Node.js ESM、`better-sqlite3`、Chrome DevTools Protocol、Vue AG-Grid、Python/openpyxl、Node `node:test`。

---

## 文件结构

- Modify: `scripts/huice/lib/db.mjs` — 新增日期商品快照原子替换，不改变通用 bulk upsert 语义。
- Modify: `scripts/huice/lib/export-flow.mjs` — 提供可复用的下载业务层解析器。
- Create: `scripts/huice/lib/pdd-promo-target.mjs` — 纯函数规划目标推广页与待关闭页面。
- Modify: `tools/huice-export-cdp.mjs` — 商品按日期持久化、成功状态、日期面板、XLSX、下载层句柄。
- Modify: `tools/huice-shop-export-cdp.mjs` — 店铺成功状态、日期面板、XLSX、下载层句柄。
- Modify: `tools/pdd-promo-cdp.mjs` — 逐页识别 mallId、保留目标店铺并关闭另一推广页。
- Create: `test/product-snapshot.test.mjs` — 商品快照替换回归测试。
- Create: `test/pdd-promo-target.test.mjs` — 推广页规划回归测试。
- Modify: `test/export-flow.test.mjs` — 下载业务层解析测试。
- Modify: `test/exporter-state-machine.test.mjs` — 导出器状态、日期、XLSX 与下载层集成约束。

> 当前 `tools/huice-export-cdp.mjs`、`tools/huice-shop-export-cdp.mjs`、`test/exporter-state-machine.test.mjs` 已有未提交修复。禁止 reset、checkout 覆盖或 `git add -A`；提交时必须显式列文件或使用 `git add -p`。

---

### Task 1: 商品日期快照原子替换

**Files:**
- Create: `test/product-snapshot.test.mjs`
- Modify: `scripts/huice/lib/db.mjs:311-394`

- [ ] **Step 1: 写失败测试，固定替换与 bulk upsert 的不同语义**

在 `test/product-snapshot.test.mjs` 使用临时 SQLite 文件和 `HUICE_DB_PATH` 隔离数据库，测试：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const makeRecord = (date, productId, shopName = '拼【测试店') => ({
  date,
  productId,
  productName: `商品-${productId}`,
  shopName,
  salesAmount: 10,
  salesQuantity: 1,
});

test('replace removes rows missing from the newer same-date snapshot', async () => {
  // 动态导入隔离数据库模块，先写 3 条，再替换为 2 条。
  // 断言最终只剩新快照中的两个 (shop_name, product_id)。
});

test('replace preserves other dates and rejects empty or mixed-date snapshots', async () => {
  // 断言空数组、混合日期抛错，且已有数据不变。
});

test('bulk upsert still retains rows absent from the input', async () => {
  // 回归：bulkUpsertProductProfit 不得被改成快照替换。
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
node --test test/product-snapshot.test.mjs
```

Expected: FAIL，提示 `replaceProductProfitDateSnapshot` 尚未导出。

- [ ] **Step 3: 抽取数据库绑定的内部 upsert**

在 `db.mjs` 把现有 `upsertProductProfit()` 主体抽成：

```js
function upsertProductProfitWithDb(db, record, { normalized = false } = {}) {
  const value = normalized ? record : normalizeProfitRecord(record);
  // 保留原 shop_id 反查、INSERT 字段和 ON CONFLICT UPDATE 子句。
  return stmt.run(/* 原参数 */);
}

export function upsertProductProfit(record) {
  return upsertProductProfitWithDb(getDb(), record);
}
```

`bulkUpsertProductProfit()` 继续跳过缺少 `productId/date` 的普通增量记录，不删除旧行。

- [ ] **Step 4: 实现快照替换 API**

```js
export function replaceProductProfitDateSnapshot(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('product snapshot must contain records');
  }

  const normalized = records.map(normalizeProfitRecord);
  if (normalized.some(row => !row.productId || !row.date)) {
    throw new Error('product snapshot contains an invalid record');
  }

  const dates = new Set(normalized.map(row => row.date));
  if (dates.size !== 1) {
    throw new Error('product snapshot must contain exactly one date');
  }

  const db = getDb();
  const replace = db.transaction(() => {
    const [date] = dates;
    db.prepare('DELETE FROM product_profit WHERE date = ?').run(date);
    for (const row of normalized) {
      upsertProductProfitWithDb(db, row, { normalized: true });
    }
    return normalized.length;
  });

  return replace();
}
```

- [ ] **Step 5: 运行测试**

Run:

```bash
node --test test/product-snapshot.test.mjs
```

Expected: PASS，且 bulk upsert 回归测试仍保留未传入的第三条记录。

- [ ] **Step 6: 提交数据库边界**

```bash
git add test/product-snapshot.test.mjs scripts/huice/lib/db.mjs
git commit -m "feat(db): 原子替换单日商品快照"
```

---

### Task 2: 导出成功状态与 failed-dates 生命周期

**Files:**
- Modify: `tools/huice-export-cdp.mjs:479-669`
- Modify: `tools/huice-shop-export-cdp.mjs:708-853`
- Modify: `test/exporter-state-machine.test.mjs:185-191`

- [ ] **Step 1: 强化失败测试**

将现有“成功删除失败标记”测试扩展为同时要求：

```js
assert.match(source, /const fullySuccessful\s*=/);
assert.match(source, /dateList\.every\(date => successfulDates\.has\(date\)\)/);
assert.match(source, /else if \(fullySuccessful\)/);
assert.match(source, /if \(existsSync\(failLog\)\) unlinkSync\(failLog\)/);
```

并断言不能仅用 `failedDates.length === 0` 删除标记。

- [ ] **Step 2: 运行聚焦测试确认失败**

```bash
node --test test/exporter-state-machine.test.mjs
```

Expected: 当前成功标记测试 FAIL。

- [ ] **Step 3: 商品导出改为逐日期快照替换**

导入：

```js
import {
  getDbPath,
  replaceProductProfitDateSnapshot,
} from '../scripts/huice/lib/db.mjs';
```

主循环增加：

```js
const successfulDates = new Set();
```

每个日期解析且非零后按顺序执行：

```js
const persisted = replaceProductProfitDateSnapshot(records);
if (persisted !== records.length) {
  throw new Error(`SQLite snapshot mismatch: ${persisted}/${records.length}`);
}
// 然后归档 XLSX、写当日 JSON、append allRecords。
successfulDates.add(targetDate);
```

删除循环结束后的 run-wide `bulkUpsertProductProfit(allRecords)`。

- [ ] **Step 4: 两个导出器加入完整成功谓词**

```js
const fullySuccessful =
  dateList.length > 0 &&
  dateList.every(date => successfulDates.has(date)) &&
  allRecords.length > 0 &&
  failedDates.length === 0 &&
  !result.fatalError;
```

店铺导出器只有在 `inserted === records.length`、归档和 JSON 写入完成后才执行：

```js
successfulDates.add(targetDate);
```

- [ ] **Step 5: 实现失败标记删除**

两个导出器统一：

```js
const failLog = path.join(OUTPUT_DIR, 'failed-dates.json');
if (failedDates.length > 0) {
  writeFileSync(failLog, JSON.stringify({ dates: failedDates, failures: result.failures }, null, 2));
} else if (fullySuccessful) {
  if (existsSync(failLog)) unlinkSync(failLog);
}
```

商品保留现有 `unlinkSync` 导入；店铺补充该导入。

- [ ] **Step 6: 运行聚焦测试和快照测试**

```bash
node --test test/product-snapshot.test.mjs test/exporter-state-machine.test.mjs
```

Expected: PASS。

- [ ] **Step 7: 提交状态修复**

```bash
git add -p tools/huice-export-cdp.mjs tools/huice-shop-export-cdp.mjs test/exporter-state-machine.test.mjs
git commit -m "fix(huice): 完整持久化日期并管理失败标记"
```

---

### Task 3: 日期面板与 XLSX 解析稳定性

**Files:**
- Modify: `tools/huice-export-cdp.mjs:setDateRangeByPanel, parseXlsx`
- Modify: `tools/huice-shop-export-cdp.mjs:setDateRangeByPanel, parseXlsxRaw`
- Modify: `test/exporter-state-machine.test.mjs`

- [ ] **Step 1: 写日期面板和警告过滤失败测试**

对两个导出器分别截取 `setDateRangeByPanel()`，断言：

```js
assert.match(picker, /offsetParent !== null/);
assert.match(picker, /getBoundingClientRect\(\)/);
assert.match(picker, /matches\[matches\.length - 1\]/);
assert.doesNotMatch(picker, /otherCell/);
```

对两个 Python 解析器断言：

```js
assert.match(parser, /warnings\.filterwarnings/);
assert.match(parser, /\^Workbook contains no default style, apply openpyxl's default\$/);
assert.match(parser, /category=UserWarning/);
assert.match(parser, /finally:/);
assert.match(parser, /wb\.close\(\)/);
assert.doesNotMatch(parser, /read_only\s*=\s*True/);
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/exporter-state-machine.test.mjs
```

Expected: 日期可见性、店铺第二次面板选择和 workbook close 断言 FAIL。

- [ ] **Step 3: 统一可见面板算法**

两个导出器每次重新查询：

```js
const matches = [...document.querySelectorAll('.el-date-range-picker__content')]
  .filter(panel => {
    const rect = panel.getBoundingClientRect();
    return panel.offsetParent !== null && rect.width > 0 && rect.height > 0;
  })
  .filter(panel => {
    const header = panel.querySelector('.el-date-range-picker__header')?.textContent?.trim() || '';
    return header === '${targetHeader}';
  });
const targetPanel = matches[matches.length - 1];
```

两次点击都先找 `td.available`，再在同一面板内回退到目标日期 `td`；绝不点击其他日期。

- [ ] **Step 4: 精确过滤 openpyxl 警告并关闭 workbook**

两个嵌入式 Python 脚本加入：

```python
import warnings
warnings.filterwarnings(
    'ignore',
    message=r"^Workbook contains no default style, apply openpyxl's default$",
    category=UserWarning,
)
wb = openpyxl.load_workbook(...)
try:
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
finally:
    wb.close()
```

业务解析在 `rows` 物化后继续，保持普通加载模式。

- [ ] **Step 5: 运行测试与语法检查**

```bash
node --test test/exporter-state-machine.test.mjs
node --check tools/huice-export-cdp.mjs
node --check tools/huice-shop-export-cdp.mjs
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add -p tools/huice-export-cdp.mjs tools/huice-shop-export-cdp.mjs test/exporter-state-machine.test.mjs
git commit -m "fix(huice): 稳定日期面板和工作簿解析"
```

---

### Task 4: 以 AG-Grid 为锚点解析下载业务层

**Files:**
- Modify: `scripts/huice/lib/export-flow.mjs`
- Modify: `tools/huice-export-cdp.mjs`
- Modify: `tools/huice-shop-export-cdp.mjs`
- Modify: `test/export-flow.test.mjs`
- Modify: `test/exporter-state-machine.test.mjs`

- [ ] **Step 1: 写业务层解析器失败测试**

在 `test/export-flow.test.mjs` 为浏览器函数加入 DOM fixture，覆盖：

- 隐藏旧业务层 + 当前可见层；
- 两个可见且同等有效候选返回 ambiguity；
- 被选根层和 grid 写入相同 `data-huice-download-layer-id`；
- 高层通知存在时仍选择业务层。

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/export-flow.test.mjs test/exporter-state-machine.test.mjs
```

Expected: FAIL，解析器尚未导出或导出器尚未传递 `layerId`。

- [ ] **Step 3: 在 export-flow.mjs 增加浏览器解析器源码**

导出：

```js
export const downloadCenterBusinessResolverSource = `(() => {
  const visible = element => {
    if (!element || element.offsetParent === null) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const candidates = [...document.querySelectorAll('.v-ag-grid')]
    .filter(visible)
    .map(grid => {
      const root = grid.closest('.analyzerContainer.view');
      const api = grid.__vue__?.gridApi;
      return { grid, root, api, knownRoot: visible(root) };
    })
    .filter(item => item.knownRoot && item.api);
  if (candidates.length !== 1) {
    return { ok: false, reason: candidates.length ? 'ambiguous' : 'not-found' };
  }
  const layerId = `huice-download-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  candidates[0].root.dataset.huiceDownloadLayerId = layerId;
  candidates[0].grid.dataset.huiceDownloadLayerId = layerId;
  return { ok: true, layerId };
})()`;
```

实现时补充祖先链、任务结构、操作列和通知诊断；相同有效候选必须报歧义，不静默选第一个。

- [ ] **Step 4: 两个导出器贯穿 layerId**

接口改为：

```js
async function collectDownloadCenterTasks(ws, layerId)
async function queryDownloadCenter(ws, layerId)
```

每次 CDP evaluate 只通过属性读取根层和 grid：

```js
const root = document.querySelector(`[data-huice-download-layer-id="${layerId}"]`);
const grid = root?.querySelector(`.v-ag-grid[data-huice-download-layer-id="${layerId}"]`);
```

保留当前 `gridApi`、`ensureIndexVisible()`、`ensureColumnVisible('operation')`、baseline 和 consumed keys。页面 reload 后必须重新解析并取得新 `layerId`。

- [ ] **Step 5: 验证不会依赖通知清理**

测试断言 `collectDownloadCenterTasks`、`queryDownloadCenter`、`downloadFromCenter` 内没有 `dismissPassiveUi()`，且没有全局第一个 `.v-ag-grid` 回退。

- [ ] **Step 6: 运行聚焦测试**

```bash
node --test test/export-flow.test.mjs test/exporter-state-machine.test.mjs
```

Expected: PASS，原有虚拟行、操作列、可选查询按钮测试保持通过。

- [ ] **Step 7: 提交**

```bash
git add scripts/huice/lib/export-flow.mjs test/export-flow.test.mjs
git add -p tools/huice-export-cdp.mjs tools/huice-shop-export-cdp.mjs test/exporter-state-machine.test.mjs
git commit -m "fix(huice): 将下载绑定到已验证业务层"
```

---

### Task 5: 推广页按目标 mallId 保留并关闭另一页

**Files:**
- Create: `scripts/huice/lib/pdd-promo-target.mjs`
- Create: `test/pdd-promo-target.test.mjs`
- Modify: `tools/pdd-promo-cdp.mjs:172-262`

- [ ] **Step 1: 写纯函数失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { planPromoTargets } from '../scripts/huice/lib/pdd-promo-target.mjs';

test('keeps mall 338884784 and closes the other promo page', () => {
  const plan = planPromoTargets([
    { targetId: 'old', mallId: 'other', url: 'https://yingxiao.pinduoduo.com/a' },
    { targetId: 'target', mallId: '338884784', url: 'https://yingxiao.pinduoduo.com/b' },
  ]);
  assert.equal(plan.keep.targetId, 'target');
  assert.deepEqual(plan.close.map(item => item.targetId), ['old']);
});

test('refuses unreadable or missing target mall identity', () => {
  assert.throws(() => planPromoTargets([{ targetId: 'x', mallId: '' }]));
  assert.throws(() => planPromoTargets([{ targetId: 'x', mallId: 'other' }]));
});
```

- [ ] **Step 2: 运行确认失败**

```bash
node --test test/pdd-promo-target.test.mjs
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现规划器**

```js
export const TARGET_PDD_MALL_ID = '338884784';

export function planPromoTargets(candidates, targetMallId = TARGET_PDD_MALL_ID) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('no promotion pages found');
  }
  if (candidates.some(candidate => !candidate.mallId)) {
    throw new Error('promotion page mallId could not be read');
  }
  const matches = candidates.filter(candidate => String(candidate.mallId) === String(targetMallId));
  if (matches.length === 0) {
    throw new Error(`target promotion mallId ${targetMallId} not found`);
  }
  const keep = matches[0];
  return { keep, close: candidates.filter(candidate => candidate.targetId !== keep.targetId) };
}
```

- [ ] **Step 4: 修改推广采集器**

1. 只枚举 `yingxiao.pinduoduo.com` 页面；
2. 逐页连接并复用 `readMallId()`；
3. 调用 `planPromoTargets()`；
4. 保留目标页；
5. 通过 CDP `Target.closeTarget` 关闭 `plan.close`；
6. 任一关闭失败则停止采集；
7. 再次读取保留页 `mallId`，必须等于 `338884784`；
8. 然后调用现有 `getPddShopMapping(mallId)` 和 `upsertPddPromoDaily()`，不硬编码 `shop_id=9`。

- [ ] **Step 5: 运行测试与语法检查**

```bash
node --test test/pdd-promo-target.test.mjs
node --check scripts/huice/lib/pdd-promo-target.mjs
node --check tools/pdd-promo-cdp.mjs
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add scripts/huice/lib/pdd-promo-target.mjs tools/pdd-promo-cdp.mjs test/pdd-promo-target.test.mjs
git commit -m "fix(pdd): 保留配置店铺的推广页面"
```

---

### Task 6: 全量自动验证

**Files:**
- Verify all modified files

- [ ] **Step 1: 运行聚焦测试**

```bash
node --test \
  test/product-snapshot.test.mjs \
  test/pdd-promo-target.test.mjs \
  test/export-flow.test.mjs \
  test/exporter-state-machine.test.mjs
```

Expected: 全部 PASS。

- [ ] **Step 2: 运行完整测试**

```bash
npm test
```

Expected: 现有套件与新增测试全部 PASS。

- [ ] **Step 3: 运行语法和格式检查**

```bash
node --check scripts/huice/lib/db.mjs
node --check scripts/huice/lib/export-flow.mjs
node --check scripts/huice/lib/pdd-promo-target.mjs
node --check tools/huice-export-cdp.mjs
node --check tools/huice-shop-export-cdp.mjs
node --check tools/pdd-promo-cdp.mjs
npm run check:js
git diff --check
```

Expected: 全部退出码 0。

- [ ] **Step 4: 检查未提交范围**

```bash
git status --short
git diff --stat
```

Expected: 只包含本设计列出的文件和原有三处未提交修复，不包含 `private/`、SQLite、输出文件、下载文件或凭据。

---

### Task 7: 真实 CDP 与数据一致性验证

**Files:**
- Runtime verification only; do not commit generated output/private data

- [ ] **Step 1: CDP 预检**

```bash
curl --fail --silent http://127.0.0.1:9222/json/version
curl --fail --silent http://127.0.0.1:9222/json/list
```

Expected: 当前 Chrome 可连接；不得重启或杀掉用户 Chrome。

- [ ] **Step 2: 保留通知层验证商品下载**

保持“我知道了”通知可见，不预清理：

```bash
node tools/huice-export-cdp.mjs --dates 2026-07-13
```

Expected: 日志显示唯一下载业务层，日期输入为单日，任务识别和下载成功，通知层未作为业务按钮操作。

- [ ] **Step 3: 验证店铺下载**

```bash
node tools/huice-shop-export-cdp.mjs --dates 2026-07-13
```

Expected: 同样不依赖关闭通知，单日选择、导出、任务匹配和下载成功。

- [ ] **Step 4: 验证推广页关闭与目标店铺**

在两个推广页同时打开时：

```bash
node tools/pdd-promo-cdp.mjs --dates 2026-07-13
```

Expected:

- 保留页输出 `mallId=338884784`；
- 另一个 `yingxiao.pinduoduo.com` 标签页关闭；
- 普通拼多多页面不关闭；
- 现有映射输出“吃了会快乐零食店”，并通过映射写入而非硬编码店铺 ID。

- [ ] **Step 5: 比对 JSON 与 SQLite**

```bash
python3 - <<'PY'
import json
import sqlite3

date = '2026-07-13'
with open('output/huice-exports/20260713.json', encoding='utf-8') as f:
    payload = json.load(f)
rows = payload if isinstance(payload, list) else payload['records']
json_keys = {(str(r.get('shopName') or ''), str(r['productId'])) for r in rows}
with sqlite3.connect('private/huice-data.sqlite') as db:
    db_keys = {
        (str(shop or ''), str(product))
        for shop, product in db.execute(
            'SELECT shop_name, product_id FROM product_profit WHERE date = ?',
            (date,),
        )
    }
assert json_keys == db_keys, {
    'json_only': sorted(json_keys - db_keys)[:20],
    'db_only': sorted(db_keys - json_keys)[:20],
    'json_count': len(json_keys),
    'db_count': len(db_keys),
}
print(f'snapshot verified: {len(json_keys)} keys')
PY
```

Expected: 输出 `snapshot verified: 665 keys`，集合完全一致，不再存在 21 条数据库旧行。

- [ ] **Step 6: 最终提交与远程备份**

仅在所有验证通过后提交剩余明确文件，然后：

```bash
git status --short
git push origin codex/2026-07-14-fix-product-date-picker
git log --oneline --graph --all --decorate --branches=codex/2026-07-14-fix-product-date-picker --max-count=15
```

Expected: 任务分支最新提交已推送；生成分支树供最终报告。
