import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const productUrl = new URL('../tools/huice-export-cdp.mjs', import.meta.url);
const shopUrl = new URL('../tools/huice-shop-export-cdp.mjs', import.meta.url);

async function sources() {
  return Promise.all([readFile(productUrl, 'utf8'), readFile(shopUrl, 'utf8')]);
}

test('both exporters use the shared task picker and poll decision with a pre-submit baseline', async () => {
  const [product, shop] = await sources();
  for (const source of [product, shop]) {
    assert.match(source, /pickExportTask\(/);
    assert.match(source, /decideExportPoll\(/);
    assert.match(source, /baselineTaskKeys/);
    assert.match(source, /consumedTaskKeys/);
    assert.match(source, /collectDownloadCenterTasks\(/);
  }
});

test('download-center task extraction prefers Vue AG-Grid row data without returning URL fields', async () => {
  const [product, shop] = await sources();
  for (const source of [product, shop]) {
    const start = source.indexOf('async function collectDownloadCenterTasks');
    const end = source.indexOf('\nasync function queryDownloadCenter', start);
    const collector = source.slice(start, end);

    assert.match(collector, /\.v-ag-grid/);
    assert.match(collector, /gridApi/);
    assert.match(collector, /forEachNode/);
    assert.match(collector, /node\.data/);
    assert.match(collector, /String\(data\.id\)/);
    assert.match(collector, /taskName/);
    assert.match(collector, /updateTime/);
    assert.match(collector, /createrName/);
    assert.match(collector, /statusName/);
    assert.doesNotMatch(collector, /urlList/);

    assert.match(collector, /\.ag-center-cols-container/);
    assert.match(collector, /\.ag-pinned-left-cols-container/);
    assert.match(collector, /\.ag-pinned-right-cols-container/);
  }
});

test('selected task click materializes the virtualized AG-Grid row and operation column before retrying DOM lookup', async () => {
  const [product, shop] = await sources();
  for (const source of [product, shop]) {
    const start = source.indexOf('async function downloadFromCenter');
    const end = source.indexOf('\n/**', start + 1);
    const downloader = source.slice(start, end);

    assert.match(downloader, /String\(node\.data\?\.id \?\? ''\) ===/);
    assert.match(downloader, /ensureIndexVisible\(selectedRowIndex, ['"]middle['"]\)/);
    assert.match(downloader, /ensureColumnVisible\(['"]operation['"]\)/);
    assert.match(downloader, /for \(let clickAttempt = 0; clickAttempt < \d+; clickAttempt\+\+\)/);
    assert.match(downloader, /await new Promise\(resolve => setTimeout\(resolve, \d+\)\)/);
    assert.match(downloader, /\.ag-center-cols-container/);
    assert.match(downloader, /\.ag-pinned-left-cols-container/);
    assert.match(downloader, /\.ag-pinned-right-cols-container/);
    assert.doesNotMatch(downloader, /urlList/);
  }
});

test('passive cleanup excludes business confirmation labels and product popover is visible and scoped', async () => {
  const [product, shop] = await sources();
  assert.doesNotMatch(shop, /\['我知道了', '300S后关闭', '确定'/);
  assert.doesNotMatch(shop, /\['我知道了', '300S后关闭', '确定', '关闭', '取消'\]/);
  assert.match(product, /\.el-popover[^'"\n]*is-visible|offsetParent !== null/);
  assert.match(product, /export menu not found|export all control not found/);
});

test('aggregate latest files are written only when the run produced records without failures', async () => {
  const [product, shop] = await sources();
  assert.match(product, /allRecords\.length > 0 && failedDates\.length === 0/);
  assert.match(shop, /allRecords\.length > 0 && failedDates\.length === 0/);
  assert.match(product, /failures: result\.failures/);
  assert.match(shop, /failures: result\.failures/);
});

test('both exporters reject zero parsed records before archive, snapshot, or success logging', async () => {
  const [product, shop] = await sources();
  for (const source of [product, shop]) {
    const recordsIndex = source.indexOf('const records =');
    const guardIndex = source.indexOf('records.length === 0', recordsIndex);
    const failureIndex = source.indexOf('markCollectorFailure', guardIndex);
    const archiveIndex = source.indexOf('renameSync(', recordsIndex);
    const snapshotIndex = source.indexOf('writeFileSync(', recordsIndex);

    assert.ok(recordsIndex >= 0, 'expected parsed records assignment');
    assert.ok(guardIndex > recordsIndex, 'expected zero-record guard after parsing');
    assert.ok(failureIndex > guardIndex, 'expected collector failure marking in zero-record guard');
    assert.ok(archiveIndex > failureIndex, 'archive must occur after zero-record guard');
    assert.ok(snapshotIndex > failureIndex, 'snapshot must occur after zero-record guard');
  }
});

test('download completion requires stable files and validation before returning', async () => {
  const [product, shop] = await sources();
  for (const source of [product, shop]) {
    assert.match(source, /snapshotDownloadFiles\(/);
    assert.match(source, /stableCount < 2/);
    assert.match(source, /invalidSignature/);
    assert.match(source, /\{ targetDate, validator, timeout/);
    assert.match(source, /value: validate\(fullPath\)/);
    assert.doesNotMatch(source, /for \(let i = 0; i < 10; i\+\+\)[\s\S]{0,350}return fullPath;\s*\n\s*}/);
  }
  assert.match(product, /waitForNewXlsx\(beforeFiles, \{ targetDate/);
  assert.match(shop, /waitForNewXlsx\(beforeFiles, \{ targetDate/);
});

test('product workbook validation accepts exact 链接ID and uses normal openpyxl mode', async () => {
  const [product] = await sources();
  const start = product.indexOf('function parseXlsx');
  const end = product.indexOf('\nasync function main', start);
  const parser = product.slice(start, end);

  assert.match(parser, /['"]链接ID['"]/);
  assert.match(parser, /['"]商品ID['"]/);
  assert.match(parser, /['"]商品编号['"]/);
  assert.match(parser, /openpyxl\.load_workbook\([^\n]+\)/);
  assert.doesNotMatch(parser, /read_only\s*=\s*True/);
  assert.match(parser, /rows\[11:\]/);
  assert.match(parser, /row\[2\]/);
});
