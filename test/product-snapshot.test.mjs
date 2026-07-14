import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(join(tmpdir(), 'huice-product-snapshot-'));
const tempDbPath = join(tempDir, 'huice-data.sqlite');
const previousDbPath = process.env.HUICE_DB_PATH;
process.env.HUICE_DB_PATH = tempDbPath;

const {
  bulkUpsertProductProfit,
  closeDb,
  getDbPath,
  getProductProfitByDate,
  replaceProductProfitDateSnapshot,
} = await import('../scripts/huice/lib/db.mjs');

const TEST_DATES = [
  '2099-01-11',
  '2099-01-12',
  '2099-01-13',
  '2099-01-14',
  '2099-01-15',
  '2099-01-16',
];

function record(productId, date, overrides = {}) {
  return {
    productId,
    productName: `商品 ${productId}`,
    shopName: '测试店铺',
    date,
    salesAmount: 100,
    salesQuantity: 2,
    rawNetProfit: 20,
    ...overrides,
  };
}

function idsForDate(date) {
  return getProductProfitByDate(date).map(row => row.product_id).sort();
}

test.before(() => {
  assert.equal(getDbPath(), tempDbPath, 'snapshot tests must use an isolated temporary database');
});

test.after(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
  if (previousDbPath === undefined) delete process.env.HUICE_DB_PATH;
  else process.env.HUICE_DB_PATH = previousDbPath;
});

test('replacing a same-date snapshot removes products absent from the second snapshot', () => {
  const date = TEST_DATES[0];
  assert.equal(replaceProductProfitDateSnapshot([
    record('a', date),
    record('b', date),
  ]), 2);

  assert.equal(replaceProductProfitDateSnapshot([
    record('a', date, { salesAmount: 250 }),
  ]), 1);

  assert.deepEqual(idsForDate(date), ['a']);
  assert.equal(getProductProfitByDate(date)[0].sales_amount, 250);
});

test('replacing one date preserves product rows for another date', () => {
  const replacedDate = TEST_DATES[1];
  const preservedDate = TEST_DATES[2];
  bulkUpsertProductProfit([
    record('old', replacedDate),
    record('keep', preservedDate),
  ]);

  replaceProductProfitDateSnapshot([record('new', replacedDate)]);

  assert.deepEqual(idsForDate(replacedDate), ['new']);
  assert.deepEqual(idsForDate(preservedDate), ['keep']);
});

test('invalid snapshots throw without deleting an existing date snapshot', async (t) => {
  const date = TEST_DATES[3];
  bulkUpsertProductProfit([record('existing', date)]);

  const invalidSnapshots = [
    ['empty array', []],
    ['mixed dates', [record('a', date), record('b', TEST_DATES[4])]],
    ['missing product ID', [record('', date)]],
    ['missing date', [record('a', '')]],
  ];

  for (const [name, snapshot] of invalidSnapshots) {
    await t.test(name, () => {
      assert.throws(() => replaceProductProfitDateSnapshot(snapshot));
      assert.deepEqual(idsForDate(date), ['existing']);
    });
  }
});

test('an insert failure rolls back the date deletion', () => {
  const date = TEST_DATES[4];
  bulkUpsertProductProfit([record('existing', date)]);
  const invalid = record('circular', date);
  invalid.circular = invalid;

  assert.throws(() => replaceProductProfitDateSnapshot([invalid]));
  assert.deepEqual(idsForDate(date), ['existing']);
});

test('bulk upsert keeps same-date rows absent from later batches', () => {
  const date = TEST_DATES[5];
  bulkUpsertProductProfit([
    record('a', date),
    record('b', date),
  ]);

  assert.equal(bulkUpsertProductProfit([
    record('a', date, { salesAmount: 300 }),
  ]), 1);

  assert.deepEqual(idsForDate(date), ['a', 'b']);
});
