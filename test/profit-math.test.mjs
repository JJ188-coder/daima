import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyProfitFormula,
  aggregateProfitRecords,
  normalizeProfitRecord,
} from '../scripts/huice/lib/profit.mjs';

test('keeps raw Huice profit separate from adjusted profit', () => {
  const record = applyProfitFormula({
    salesAmount: 1000,
    orderCount: 10,
    rawNetProfit: 300,
    rawNetProfitRate: 0.3,
  });

  assert.equal(record.rawNetProfit, 300);
  assert.equal(record.netProfit, 268.5);
  assert.equal(record.orderFixedCost, 11.5);
  assert.equal(record.platformFee, 20);
  assert.equal(record.netProfitRate, 0.2685);
  assert.equal(record.profitFormulaVersion, 'order-fixed-v1');
});

test('uses sales quantity as order count for the fixed order fee', () => {
  const record = applyProfitFormula({
    salesAmount: 1000,
    salesQuantity: 20,
    rawNetProfit: 300,
  });

  assert.equal(record.orderCount, 20);
  assert.equal(record.orderFixedCost, 23);
  assert.equal(record.platformFee, 20);
  assert.equal(record.netProfit, 257);
});

test('does not deduct fees twice when adjusted profit is already present', () => {
  const record = normalizeProfitRecord({
    productId: 'p1',
    salesAmount: 1000,
    salesQuantity: 10,
    rawNetProfit: 300,
    netProfit: 268.5,
  });

  assert.equal(record.rawNetProfit, 300);
  assert.equal(record.netProfit, 268.5);
  assert.equal(record.orderFixedCost, 11.5);
  assert.equal(record.platformFee, 20);
});

test('recomputes rates after multi-day aggregation', () => {
  const records = [
    normalizeProfitRecord({
      productId: 'p1',
      productName: '',
      salesAmount: 100,
      netProfit: 10,
      rawNetProfit: 20,
      refundAmount: 2,
      orderCount: 1,
      orderFixedCost: 1.15,
    }),
    normalizeProfitRecord({
      productId: 'p1',
      productName: 'Filled name',
      salesAmount: 300,
      netProfit: 90,
      rawNetProfit: 120,
      refundAmount: 8,
      orderCount: 2,
      orderFixedCost: 2.3,
    }),
  ];

  const [agg] = aggregateProfitRecords(records);

  assert.equal(agg.productName, 'Filled name');
  assert.equal(agg.salesAmount, 400);
  assert.equal(agg.netProfit, 100);
  assert.equal(agg.netProfitRate, 0.25);
  assert.equal(agg.rawNetProfit, 140);
  assert.equal(agg.rawNetProfitRate, 0.35);
  assert.equal(agg.refundAmount, 10);
  assert.equal(agg.orderCount, 3);
  assert.equal(Number(agg.orderFixedCost.toFixed(2)), 3.45);
});
