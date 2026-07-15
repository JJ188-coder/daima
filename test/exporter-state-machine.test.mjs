import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const productUrl = new URL('../tools/huice-export-cdp.mjs', import.meta.url);
const shopUrl = new URL('../tools/huice-shop-export-cdp.mjs', import.meta.url);

async function sources() {
  return Promise.all([readFile(productUrl, 'utf8'), readFile(shopUrl, 'utf8')]);
}

function withoutJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
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

test('both exporters import and invoke the shared download-center business resolver', async () => {
  const [product, shop] = await sources();
  for (const source of [product, shop]) {
    assert.match(source, /import \{[^}]*downloadCenterBusinessResolverSource[^}]*\} from ['"]\.\.\/scripts\/huice\/lib\/export-flow\.mjs['"]/s);
    assert.match(source, /async function resolveDownloadCenterBusinessLayer\(ws\)/);
    assert.match(source, /cdpEval\(ws,\s*downloadCenterBusinessResolverSource\)/);
  }
});

test('both business-layer helpers retry only not-found, fail ambiguous immediately, and retain exhaustion diagnostics', async () => {
  const [product, shop] = await sources();
  for (const source of [product, shop]) {
    const start = source.indexOf('async function resolveDownloadCenterBusinessLayer');
    const end = source.indexOf('\nasync function collectDownloadCenterTasks', start);
    const resolver = source.slice(start, end);

    assert.match(resolver, /const maxAttempts = 20/);
    assert.match(resolver, /for \(let attempt = 0; attempt < maxAttempts; attempt\+\+\)/);
    assert.match(resolver, /const result = await cdpEval\(ws,\s*downloadCenterBusinessResolverSource\)/);
    assert.match(resolver, /if \(result\?\.ok\) return result\.layerId/);
    assert.match(resolver, /if \(result\?\.reason === ['"]ambiguous['"]\) throw new Error\([^\n]*JSON\.stringify\(result\?\.diagnostics \|\| \{\}\)/);
    assert.match(resolver, /if \(result\?\.reason !== ['"]not-found['"]\) throw new Error/);
    assert.match(resolver, /if \(attempt < maxAttempts - 1\) await sleep\(500\)/);
    assert.match(resolver, /throw new Error\([^\n]*maxAttempts[^\n]*JSON\.stringify\(lastResult\?\.diagnostics \|\| \{\}\)/);

    const ambiguousIndex = resolver.indexOf("result?.reason === 'ambiguous'");
    const sleepIndex = resolver.indexOf('await sleep(500)');
    const exhaustionIndex = resolver.lastIndexOf('throw new Error');
    assert.ok(ambiguousIndex >= 0 && ambiguousIndex < sleepIndex, 'ambiguous must throw before any retry sleep');
    assert.ok(exhaustionIndex > sleepIndex, 'retry exhaustion must throw after the bounded loop');
  }
});

test('download-center layerId is threaded through collection, query, baseline, and download operations', async () => {
  const [product, shop] = await sources();
  for (const source of [product, shop]) {
    assert.match(source, /async function collectDownloadCenterTasks\(ws, layerId\)/);
    assert.match(source, /async function queryDownloadCenter\(ws, layerId\)/);
    assert.match(source, /async function downloadFromCenter\(ws, layerId, criteria\)/);
    assert.match(source, /collectDownloadCenterTasks\(ws, layerId\)/);
    assert.match(source, /queryDownloadCenter\(ws, layerId\)/);
    assert.match(source, /downloadFromCenter\(ws, layerId,/);
    assert.match(source, /data-huice-download-layer-id/);
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

test('aggregate latest files require every requested date to complete successfully', async () => {
  const [product, shop] = await sources();
  for (const source of [product, shop]) {
    assert.match(source, /const successfulDates = new Set\(\)/);
    assert.match(source, /const fullySuccessful =/);
    assert.match(source, /allRecords\.length > 0/);
    assert.match(source, /successfulDates\.size === dateList\.length/);
    assert.match(source, /dateList\.every\(date => successfulDates\.has\(date\)\)/);
    assert.match(source, /failedDates\.length === 0/);
    assert.match(source, /!result\.fatalError/);
    assert.match(source, /if \(fullySuccessful\)/);
    assert.match(source, /failures: result\.failures/);
  }
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

test('download-center operations use only the resolved layerId root and never a global-first grid', async () => {
  const [product, shop] = await sources();
  for (const source of [product, shop]) {
    const collectStart = source.indexOf('async function collectDownloadCenterTasks');
    const queryStart = source.indexOf('\nasync function queryDownloadCenter', collectStart);
    const baselineStart = source.indexOf('\nasync function collectDownloadCenterBaseline', queryStart);
    const downloadStart = source.indexOf('\nasync function downloadFromCenter', baselineStart);
    const downloadEnd = source.indexOf('\n/**', downloadStart + 1);
    const collector = source.slice(collectStart, queryStart);
    const query = source.slice(queryStart, baselineStart);
    const downloader = source.slice(downloadStart, downloadEnd);

    for (const operation of [collector, query, downloader]) {
      assert.match(operation, /data-huice-download-layer-id/);
      assert.match(operation, /CSS\.escape\(layerId\)/);
      assert.doesNotMatch(operation, /querySelectorAll\(['"]\.analyzerContainer\.view['"]\)/);
      assert.doesNotMatch(operation, /document\.querySelector\(['"]\.v-ag-grid['"]\)/);
      assert.doesNotMatch(operation, /dismissPassiveUi\(/);
    }

    assert.match(collector, /downloadRoot\.querySelector\(['"]\.v-ag-grid\[data-huice-download-layer-id=/);
    assert.match(query, /downloadRoot\.querySelector\(['"]\.v-ag-grid\[data-huice-download-layer-id=/);
    assert.match(query, /downloadRoot\.querySelectorAll\(['"]button, \.el-button, \[role=button\]['"]\)/);
    assert.doesNotMatch(query, /document\.querySelectorAll\(['"]button, \.el-button/);
    assert.doesNotMatch(query, /download center query button not found/);
    assert.doesNotMatch(query, /throw new Error/);
    assert.match(downloader, /downloadRoot\?\.querySelector\(['"]\.v-ag-grid\[data-huice-download-layer-id=/);
  }
});

test('download-center query is optional and route readiness is checked before polling', async () => {
  const [product, shop] = await sources();
  for (const source of [product, shop]) {
    assert.match(source, /async function waitForDownloadCenterLayer/);
    assert.match(source, /location\.hash === ['"]#\/baseSettings\/downloadCenter['"]/);
    assert.match(source, /if \(!button\) return \{ ok: true, clicked: false/);

    const baselineStart = source.indexOf('async function collectDownloadCenterBaseline');
    const downloadStart = source.indexOf('async function downloadFromCenter', baselineStart);
    const baseline = source.slice(baselineStart, downloadStart);
    const downloaderEnd = source.indexOf('\n/**', downloadStart + 1);
    const downloader = source.slice(downloadStart, downloaderEnd);

    assert.match(baseline, /waitForDownloadCenterLayer\(ws\)/);
    assert.match(baseline, /resolveDownloadCenterBusinessLayer\(ws\)/);
    assert.match(downloader, /waitForDownloadCenterLayer\(ws\)/);
  }
});

test('download-center reload invalidates the old DOM identity and resolves a fresh layerId', async () => {
  const [product, shop] = await sources();
  for (const source of [product, shop]) {
    const downloadStart = source.indexOf('async function downloadFromCenter');
    const downloadEnd = source.indexOf('\n/**', downloadStart + 1);
    const downloader = source.slice(downloadStart, downloadEnd);
    const reloadStart = downloader.indexOf("if (poll.action === 'reload')");
    const reloadBranch = downloader.slice(reloadStart, downloader.indexOf('\n    }', reloadStart) + 6);

    assert.match(reloadBranch, /location\.reload\(\)/);
    assert.match(reloadBranch, /layerId\s*=\s*await resolveDownloadCenterBusinessLayer\(ws\)/);
    assert.match(reloadBranch, /queryDownloadCenter\(ws, layerId\)/);
  }
});

test('both date pickers use the last visible exact-month panel and re-query it for each target-date click', async () => {
  const [product, shop] = await sources();
  for (const source of [product, shop]) {
    const start = source.indexOf('async function setDateRangeByPanel');
    const end = source.indexOf('\n/**', start + 1);
    const picker = withoutJsComments(source.slice(start, end));

    const closeIndex = picker.indexOf('document.body.click()');
    const openIndex = picker.indexOf("document.querySelector('.el-range-editor')");
    assert.ok(closeIndex >= 0 && closeIndex < openIndex, 'stale panels must be closed before the editor opens');
    assert.ok(countMatches(picker, /document\.querySelectorAll\(['"]\.el-date-range-picker__content['"]\)/g) >= 4,
      'panel DOM must be queried again while navigating and before both clicks');
    assert.match(picker, /offsetParent\s*!==\s*null/);
    assert.match(picker, /getBoundingClientRect\(\)/);
    assert.match(picker, /rect\.width\s*>\s*0\s*&&\s*rect\.height\s*>\s*0/);
    assert.match(picker, /===\s*['"]\$\{targetHeader\}['"]/);
    assert.equal(countMatches(picker, /matches\[matches\.length\s*-\s*1\]/g), 2,
      'both clicks must select the last visible exact-month match');
    assert.equal(countMatches(picker, /targetPanel\.querySelectorAll\(['"]td\.available:not\(\.prev-month\):not\(\.next-month\)['"]\)/g), 2,
      'both preferred available lookups must exclude adjacent-month cells');
    assert.doesNotMatch(picker, /targetPanel\.querySelectorAll\(['"]td\.available['"]\)/,
      'unfiltered available lookups can select an adjacent-month duplicate day');
    assert.equal(countMatches(picker, /targetPanel\.querySelectorAll\(['"]td['"]\)/g), 2,
      'both clicks must fall back only to the same target date in the selected panel');
    assert.equal(countMatches(picker, /\[\.\.\.targetPanel\.querySelectorAll\(['"]td['"]\)\]\.find\(td\s*=>\s*!td\.classList\.contains\(['"]prev-month['"]\)\s*&&\s*!td\.classList\.contains\(['"]next-month['"]\)\s*&&\s*td\.textContent\.trim\(\)\s*===\s*['"]\$\{day\}['"]\)/g), 2,
      'both generic td fallbacks must exclude adjacent-month cells before matching the target day');
    assert.doesNotMatch(picker, /otherCell/);
    assert.match(picker, /placeholder === ['"]开始日期['"]/);
    assert.match(picker, /placeholder === ['"]结束日期['"]/);
  }
});

test('both embedded xlsx parsers suppress only the openpyxl default-style warning and always close materialized workbooks', async () => {
  const [product, shop] = await sources();
  const productStart = product.indexOf('function parseXlsx');
  const productEnd = product.indexOf('\nfunction publishJsonAtomically', productStart);
  const shopStart = shop.indexOf('function parseXlsxRaw');
  const shopEnd = shop.indexOf('\n// ============ 主流程', shopStart);

  for (const parserSource of [product.slice(productStart, productEnd), shop.slice(shopStart, shopEnd)]) {
    const parser = withoutJsComments(parserSource).replace(/\\'/g, "'");
    assert.match(parser, /import warnings/);
    assert.match(parser, /warnings\.filterwarnings\(['"]ignore['"],\s*message\s*=\s*r["']\^Workbook contains no default style, apply openpyxl's default\$["'],\s*category\s*=\s*UserWarning\)/);
    assert.match(parser, /wb\s*=\s*openpyxl\.load_workbook\([^\n]+\)/);
    assert.doesNotMatch(parser, /read_only\s*=\s*True/);
    assert.match(parser, /try:/);
    assert.match(parser, /ws\s*=\s*wb\.active/);
    assert.match(parser, /rows\s*=\s*list\(ws\.iter_rows\(values_only\s*=\s*True\)\)/);
    assert.match(parser, /finally:/);
    assert.match(parser, /wb\.close\(\)/);
    assert.ok(parser.indexOf('rows = list(') < parser.indexOf('for row in rows'), 'business parsing must use materialized rows');
  }
});

test('a stale failed-dates marker is deleted only by the fully successful branch', async () => {
  const [product, shop] = await sources();
  for (const source of [product, shop]) {
    assert.match(source, /unlinkSync/);
    assert.match(source, /if \(failedDates\.length > 0\)[\s\S]*else if \(fullySuccessful\) \{[\s\S]*if \(existsSync\(failLog\)\) unlinkSync\(failLog\)/);
    assert.doesNotMatch(source, /(?:if|else if) \(failedDates\.length === 0\)[\s\S]{0,200}unlinkSync\(failLog\)/);
  }
});

test('product exporter atomically replaces each validated date before publishing its artifacts', async () => {
  const [product] = await sources();
  assert.match(product, /import \{ replaceProductProfitDateSnapshot, getDbPath \}/);
  assert.doesNotMatch(product, /bulkUpsertProductProfit/);

  const loopStart = product.indexOf('for (let i = 0; i < dateList.length; i++)');
  const loopEnd = product.indexOf('\n  const fullySuccessful =', loopStart);
  const loop = product.slice(loopStart, loopEnd);
  const recordsIndex = loop.indexOf('const records = downloadedXlsx.value');
  const replaceIndex = loop.indexOf('replaceProductProfitDateSnapshot(records)', recordsIndex);
  const countGuardIndex = loop.indexOf('inserted !== records.length', replaceIndex);
  const archiveIndex = loop.indexOf('renameSync(xlsxPath, archivePath)', countGuardIndex);
  const publishIndex = loop.indexOf('publishJsonAtomically(', archiveIndex);
  const appendIndex = loop.indexOf('allRecords.push(...records)', publishIndex);
  const successIndex = loop.indexOf('successfulDates.add(targetDate)', appendIndex);
  const catchIndex = loop.indexOf('catch (e)', successIndex);
  const failureIndex = loop.indexOf('markCollectorFailure(result, targetDate', catchIndex);

  assert.ok(loopStart >= 0 && loopEnd > loopStart, 'expected the per-date export loop');
  assert.ok(recordsIndex >= 0, 'expected parsed records inside the per-date loop');
  assert.ok(replaceIndex > recordsIndex, 'product date snapshot must be persisted after parsing');
  assert.ok(countGuardIndex > replaceIndex, 'product persistence must reject a count mismatch');
  assert.ok(archiveIndex > countGuardIndex, 'product archive must follow successful persistence');
  assert.ok(publishIndex > archiveIndex, 'atomic product JSON publication must follow archive');
  assert.ok(appendIndex > publishIndex, 'product aggregate append must follow JSON publication');
  assert.ok(successIndex > appendIndex, 'product date is successful only after all artifacts are published');
  assert.ok(catchIndex > successIndex, 'per-date catch must cover persistence and artifact publication');
  assert.ok(failureIndex > catchIndex, 'per-date catch must mark collector failure');
});

test('shop exporter uses the transactional DB batch before publishing and marking a date successful', async () => {
  const [, shop] = await sources();
  assert.match(shop, /import \{ bulkUpsertShopDailyProfit, getDbPath \}/);
  assert.doesNotMatch(shop, /function insertRecords\(/);

  const recordsIndex = shop.indexOf('const records = parseShopExportRows');
  const insertIndex = shop.indexOf('bulkUpsertShopDailyProfit(records)', recordsIndex);
  const countGuardIndex = shop.indexOf('inserted !== records.length', insertIndex);
  const archiveIndex = shop.indexOf('renameSync(', recordsIndex);
  const snapshotIndex = shop.indexOf('writeFileSync(', archiveIndex);
  const appendIndex = shop.indexOf('allRecords.push(...records)', snapshotIndex);
  const successIndex = shop.indexOf('successfulDates.add(targetDate)', appendIndex);

  assert.ok(insertIndex > recordsIndex, 'shop records must be inserted after parsing');
  assert.ok(countGuardIndex > insertIndex, 'shop persistence must reject partial inserts');
  assert.ok(archiveIndex > countGuardIndex, 'shop archive must follow complete persistence');
  assert.ok(snapshotIndex > archiveIndex, 'shop JSON snapshot must follow archive');
  assert.ok(appendIndex > snapshotIndex, 'shop aggregate append must follow JSON snapshot');
  assert.ok(successIndex > appendIndex, 'shop date is successful only after persistence and artifacts');
});

test('both exporters deduplicate requested dates before looping while preserving first occurrence order', async () => {
  const [product, shop] = await sources();
  for (const source of [product, shop]) {
    const dateListIndex = source.indexOf('dateList');
    const loopIndex = source.indexOf('for (let i = 0; i < dateList.length; i++)', dateListIndex);
    const setup = source.slice(dateListIndex, loopIndex);

    assert.match(setup, /(?:Array\.from|\[\.\.\.)\(?(?:new )?Set\(/);
    assert.doesNotMatch(setup, /customDates\.sort\(|\[\.\.\.dates\]\.sort\(/);
    assert.ok(loopIndex > dateListIndex, 'date deduplication must happen before the exporter loop');
  }
});

test('product per-date persistence and publication failures are marked without skipping finalization', async () => {
  const [product] = await sources();
  const loopStart = product.indexOf('for (let i = 0; i < dateList.length; i++)');
  const loopEnd = product.indexOf('\n  const fullySuccessful =', loopStart);
  const loop = product.slice(loopStart, loopEnd);
  const persistenceIndex = loop.indexOf('replaceProductProfitDateSnapshot(records)');
  const archiveIndex = loop.indexOf('renameSync(xlsxPath, archivePath)', persistenceIndex);
  const jsonIndex = loop.indexOf('publishJsonAtomically(', archiveIndex);
  const catchIndex = loop.lastIndexOf('catch (e)');
  const failureIndex = loop.indexOf('markCollectorFailure(result, targetDate', catchIndex);

  assert.ok(persistenceIndex >= 0, 'expected per-date persistence');
  assert.ok(archiveIndex > persistenceIndex, 'expected per-date archive publication');
  assert.ok(jsonIndex > archiveIndex, 'expected atomic per-date JSON publication');
  assert.ok(catchIndex > jsonIndex, 'one per-date catch must cover persistence and publication');
  assert.ok(failureIndex > catchIndex, 'per-date catch must mark collector failure');
  assert.match(product.slice(loopEnd), /const fullySuccessful =/);
  assert.match(product.slice(loopEnd), /failed-dates\.json/);
});

test('product JSON publication uses a sibling temp file and rename, and websocket closes in finally', async () => {
  const [product] = await sources();
  const publishStart = product.indexOf('function publishJsonAtomically');
  const publishEnd = product.indexOf('\nasync function main', publishStart);
  const publisher = product.slice(publishStart, publishEnd);

  assert.match(publisher, /writeFileSync\(tempPath/);
  assert.match(publisher, /renameSync\(tempPath, filePath\)/);
  assert.match(publisher, /finally/);
  assert.match(publisher, /unlinkSync\(tempPath\)/);
  assert.match(product, /finally \{\s*ws\.close\(\);\s*\}/);
});
