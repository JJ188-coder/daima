import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStoreReportDay,
  parseShopExportRows,
  normalizeShopExportRow,
  fillDateRange,
  resolveShopCandidates,
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

test('keeps Huice real expense fields in metrics and rawRow', () => {
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

test('fills missing dates with placeholder rows', () => {
  const rowsByDate = new Map([
    ['2026-07-03', { date: '2026-07-03', netProfit: 100 }],
    ['2026-07-05', { date: '2026-07-05', netProfit: 200 }],
  ]);
  const days = fillDateRange({ start: '2026-07-03', end: '2026-07-05', rowsByDate });

  assert.equal(days.length, 3);
  assert.equal(days[0].netProfit, 100);
  assert.equal(days[1].missing, true);
  assert.equal(days[2].netProfit, 200);
});

test('resolves unique shop candidate', () => {
  const result = resolveShopCandidates([
    { shopId: 1, shopName: '拼【周贝瑞' },
    { shopId: 1, shopName: '拼【周贝瑞' },
  ]);

  assert.equal(result.status, 'unique');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].matchedProductCount, 2);
});

test('resolves ambiguous shop candidates', () => {
  const result = resolveShopCandidates([
    { shopId: 1, shopName: '拼【周贝瑞' },
    { shopId: 2, shopName: '拼【EGO食品' },
  ]);

  assert.equal(result.status, 'ambiguous');
  assert.equal(result.candidates.length, 2);
});
