import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(join(tmpdir(), 'huice-shop-daily-batch-'));
const tempDbPath = join(tempDir, 'huice-data.sqlite');
const previousDbPath = process.env.HUICE_DB_PATH;
process.env.HUICE_DB_PATH = tempDbPath;

const {
  bulkUpsertShopDailyProfit,
  closeDb,
  getDbPath,
  getShopDailyProfitRange,
  listShops,
} = await import('../scripts/huice/lib/db.mjs');

function record(shopName, date, overrides = {}) {
  return {
    shopName,
    date,
    salesAmount: 100,
    promoSpend: 10,
    netProfit: 20,
    metrics: { salesAmount: 100 },
    rawRow: { 店铺名称: shopName },
    ...overrides,
  };
}

test.before(() => {
  assert.equal(getDbPath(), tempDbPath, 'shop batch tests must use an isolated temporary database');
});

test.after(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
  if (previousDbPath === undefined) delete process.env.HUICE_DB_PATH;
  else process.env.HUICE_DB_PATH = previousDbPath;
});

test('shop daily batch persists every row and returns the persisted count', () => {
  const date = '2099-02-01';

  assert.equal(bulkUpsertShopDailyProfit([
    record('拼【甲店', date),
    record('拼【乙店', date),
  ]), 2);

  const shops = listShops();
  assert.equal(shops.length, 2);
  for (const shop of shops) {
    assert.equal(getShopDailyProfitRange(shop.shop_id, date, date).length, 1);
  }
});

test('shop creation and daily-profit writes roll back together when any batch row fails', () => {
  const date = '2099-02-02';
  const invalid = record('拼【失败店', date);
  invalid.rawRow.circular = invalid.rawRow;

  assert.throws(() => bulkUpsertShopDailyProfit([
    record('拼【不应保留', date),
    invalid,
  ]));

  assert.deepEqual(listShops().map(shop => shop.huice_name).sort(), ['拼【乙店', '拼【甲店']);
  for (const shop of listShops()) {
    assert.equal(getShopDailyProfitRange(shop.shop_id, date, date).length, 0);
  }
});
