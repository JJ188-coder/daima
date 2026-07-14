import assert from 'node:assert/strict';
import test from 'node:test';

import { extractTaskCreatedAt, extractWorkbookDateRange, isExpectedExportTask, validateExportRows } from '../scripts/huice/lib/export-validation.mjs';

test('accepts only the requested report task after this export began', () => {
  const criteria = { kind: 'shop', targetDate: '2026-07-09', after: 1_000 };
  // 下载中心任务文本包含"待下载"状态,不含目标日期(文件名用时间戳)
  assert.equal(isExpectedExportTask({ text: '店铺多维度分析20260709102130 待下载', createdAt: 1_001 }, criteria), true);
  assert.equal(isExpectedExportTask({ text: '商品排名导出 2026-07-09 待下载', createdAt: 1_001 }, criteria), false);
  assert.equal(isExpectedExportTask({ text: '店铺多维度分析20260708102130 待下载', createdAt: 1_001 }, criteria), true);
  assert.equal(isExpectedExportTask({ text: '店铺多维度分析20260709102130 待下载', createdAt: 999 }, { ...criteria, clockSkewMs: 0 }), false);
});

test('extracts a task creation timestamp and rejects tasks without one', () => {
  assert.equal(extractTaskCreatedAt('店铺多维度利润 2026-07-09 2026-07-11 10:21:30'), new Date(2026, 6, 11, 10, 21, 30).getTime());
  assert.equal(extractTaskCreatedAt('店铺多维度利润 2026-07-09'), null);
  assert.equal(isExpectedExportTask({ text: '店铺多维度利润 2026-07-09' }, { kind: 'shop', targetDate: '2026-07-09', after: 1 }), false);
});

test('does not treat downloaded tasks as ready and allows second precision', () => {
  const after = new Date(2026, 6, 11, 10, 21, 30, 800).getTime();
  assert.equal(isExpectedExportTask({ text: '店铺多维度分析 2026-07-11 10:21:30 待下载' }, { kind: 'shop', after, clockSkewMs: 1000 }), true);
  assert.equal(isExpectedExportTask({ text: '店铺多维度分析 2026-07-11 10:21:31 已下载' }, { kind: 'shop', after, clockSkewMs: 1000 }), false);
});

test('accepts the verified product workbook date range and exact 链接ID header', () => {
  const rows = Array.from({ length: 12 }, () => []);
  rows[1] = ['日期', '2026-07-11~2026-07-11'];
  rows[9] = ['店铺', '链接名称', '链接ID'];
  rows[10] = ['', '', ''];
  rows[11] = ['测试店铺', '测试商品', '123456789'];

  assert.deepEqual(
    validateExportRows(rows, { kind: 'product', targetDate: '2026-07-11' }),
    { ok: true },
  );
});

test('retains product identity header compatibility', () => {
  for (const identityHeader of ['商品ID', '商品编号']) {
    assert.deepEqual(
      validateExportRows([
        ['日期', '2026-07-11~2026-07-11'],
        ['商品名称', identityHeader],
        ['测试商品', '123456789'],
      ], { kind: 'product', targetDate: '2026-07-11' }),
      { ok: true },
    );
  }
});

test('extracts authoritative product and shop workbook ranges', () => {
  assert.deepEqual(
    extractWorkbookDateRange([
      ['报表名称', '商品排名'],
      ['日期', '2026-07-11~2026-07-11'],
    ], { kind: 'product' }),
    { start: '2026-07-11', end: '2026-07-11' },
  );
  assert.deepEqual(
    extractWorkbookDateRange([
      ['店铺多维度利润分析 时间范围：2026-07-11'],
      ['店铺名称', '销售额'],
    ], { kind: 'shop' }),
    { start: '2026-07-11', end: '2026-07-11' },
  );
  assert.deepEqual(
    extractWorkbookDateRange([
      ['店铺多维度利润分析 时间范围：2026-07-11 至 2026-07-12'],
    ], { kind: 'shop' }),
    { start: '2026-07-11', end: '2026-07-12' },
  );
});

test('rejects authoritative multi-day ranges', () => {
  for (const [kind, rows] of [
    ['product', [['日期', '2026-07-11~2026-07-12'], ['商品名称', '商品ID'], ['测试商品', '123']]],
    ['shop', [['店铺多维度利润分析 时间范围：2026-07-11 至 2026-07-12'], ['店铺名称', '销售额'], ['测试店铺', '100']]],
  ]) {
    const result = validateExportRows(rows, { kind, targetDate: '2026-07-11' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /single-day|date range/i);
  }
});

test('rejects missing authoritative workbook ranges even when the target date appears elsewhere', () => {
  for (const [kind, rows] of [
    ['product', [['商品排名导出 2026-07-11'], ['商品名称', '商品ID'], ['测试商品', '123']]],
    ['shop', [['店铺多维度利润分析 2026-07-11'], ['店铺名称', '销售额'], ['测试店铺', '100']]],
  ]) {
    const result = validateExportRows(rows, { kind, targetDate: '2026-07-11' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /authoritative date range/i);
  }
});

test('rejects exports without the expected headers or target date', () => {
  assert.deepEqual(
    validateExportRows([
      ['店铺多维度利润分析 时间范围：2026-07-09'],
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
