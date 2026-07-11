import assert from 'node:assert/strict';
import test from 'node:test';

import { extractTaskCreatedAt, isExpectedExportTask, validateExportRows } from '../scripts/huice/lib/export-validation.mjs';

test('accepts only the requested report task after this export began', () => {
  const criteria = { kind: 'shop', targetDate: '2026-07-09', after: 1_000 };
  assert.equal(isExpectedExportTask({ text: '店铺多维度利润分析 2026-07-09', createdAt: 1_001 }, criteria), true);
  assert.equal(isExpectedExportTask({ text: '商品排名导出 2026-07-09', createdAt: 1_001 }, criteria), false);
  assert.equal(isExpectedExportTask({ text: '店铺多维度利润分析 2026-07-08', createdAt: 1_001 }, criteria), false);
  assert.equal(isExpectedExportTask({ text: '店铺多维度利润分析 2026-07-09', createdAt: 999 }, criteria), false);
});

test('extracts a task creation timestamp and rejects tasks without one', () => {
  assert.equal(extractTaskCreatedAt('店铺多维度利润 2026-07-09 2026-07-11 10:21:30'), new Date(2026, 6, 11, 10, 21, 30).getTime());
  assert.equal(extractTaskCreatedAt('店铺多维度利润 2026-07-09'), null);
  assert.equal(isExpectedExportTask({ text: '店铺多维度利润 2026-07-09' }, { kind: 'shop', targetDate: '2026-07-09', after: 1 }), false);
});

test('rejects exports without the expected headers or target date', () => {
  assert.deepEqual(
    validateExportRows([
      ['店铺多维度利润分析 2026-07-09'],
      ['店铺名称', '一、销售收入'],
      ['拼【周贝瑞', '100'],
    ], { kind: 'shop', targetDate: '2026-07-09' }),
    { ok: true },
  );
  assert.equal(
    validateExportRows([['商品排名导出 2026-07-09'], ['商品名称', '商品ID']], { kind: 'shop', targetDate: '2026-07-09' }).ok,
    false,
  );
});
