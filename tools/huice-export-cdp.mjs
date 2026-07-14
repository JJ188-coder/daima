#!/usr/bin/env node
/**
 * huice-export-cdp.mjs - 通过慧经营「导出全部」按钮下载 xlsx,解析入库
 *
 * 流程（每天）:
 *   1. 打开日期面板,翻月到目标月,点日期两次(单日范围),点查询
 *   2. 等数据加载,点下载按钮(#icon-download),点「导出全部」
 *   3. 去下载中心,点 operation 列的下载 button
 *   4. 等下载完成,解析 xlsx -> 入库 SQLite
 *
 * 用法:
 *   node tools/huice-export-cdp.mjs --days 7    # 回采最近 7 天
 *   node tools/huice-export-cdp.mjs --days 1     # 采昨天
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceProductProfitDateSnapshot, getDbPath } from '../scripts/huice/lib/db.mjs';
import { collectorExitCode, createCollectorResult, markCollectorFailure } from '../scripts/huice/lib/collector-result.mjs';
import { decideExportPoll, downloadCenterBusinessResolverSource, normalizeExportTask, pickExportTask } from '../scripts/huice/lib/export-flow.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.resolve(ROOT, 'output/huice-exports');
const DOWNLOAD_DIR = path.resolve(process.env.HOME, 'Downloads');
const DOWNLOAD_CENTER_URL = 'https://hjy.huice.com/#/baseSettings/downloadCenter';

const args = process.argv.slice(2);
let days = 1;
let customDates = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i+1]) { days = parseInt(args[i+1]); i++; }
  if (args[i] === '--dates' && args[i+1]) { customDates = args[i+1].split(','); i++; }
}

function dateStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function snapshotDownloadFiles() {
  return new Map(readdirSync(DOWNLOAD_DIR).map(name => {
    const stat = statSync(path.join(DOWNLOAD_DIR, name));
    return [name, { mtimeMs: stat.mtimeMs, size: stat.size }];
  }));
}

async function cdpCall(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1000000);
    const handler = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id === id) { ws.removeEventListener('message', handler); resolve(msg); }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.removeEventListener('message', handler); reject(new Error(`${method} 超时`)); }, 15000);
  });
}

async function cdpEval(ws, expression) {
  const res = await cdpCall(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return res.result?.result?.value;
}

/** 切日期到 targetDate（单日范围）- 面板点击方式 */
async function setDateRangeByPanel(ws, targetDate) {
  const [year, month, day] = targetDate.split('-').map(Number);
  const targetHeader = `${year} 年 ${month} 月`;

  // 0. 打开前点击页面空白，收起可能残留的日期面板。
  await cdpEval(ws, `document.body.click()`);
  await sleep(300);

  // 1. 打开日期面板。
  await cdpEval(ws, `(() => {
    const editor = document.querySelector('.el-range-editor');
    if (editor) editor.click();
    return 'ok';
  })()`);
  await sleep(1500);

  // 2. 找目标月面板（如果不存在,往前翻月让它出现）。每次都重新查询可见 DOM。
  for (let attempt = 0; attempt < 12; attempt++) {
    const found = await cdpEval(ws, `(() => {
      const panels = [...document.querySelectorAll('.el-date-range-picker__content')];
      const matches = panels.filter(p => {
        const rect = p.getBoundingClientRect();
        const h = p.querySelector('.el-date-range-picker__header')?.textContent?.trim() || '';
        return p.offsetParent !== null && rect.width > 0 && rect.height > 0 && h === '${targetHeader}';
      });
      return matches.length ? 'found' : 'not found';
    })()`);
    if (found === 'found') break;

    await cdpEval(ws, `(() => {
      const panels = [...document.querySelectorAll('.el-date-range-picker__content')].filter(p => {
        const rect = p.getBoundingClientRect();
        return p.offsetParent !== null && rect.width > 0 && rect.height > 0;
      });
      const first = panels[0];
      if (!first) return 'no panel';
      const btn = first.querySelector('.el-icon-arrow-left');
      if (btn) { (btn.closest('button') || btn).click(); return 'prev'; }
      return 'no arrow';
    })()`);
    await sleep(600);
  }

  // 3. 第一次点击目标日期；只在最后一个可见的目标月面板内查找同一天。
  await cdpEval(ws, `(() => {
    const panels = [...document.querySelectorAll('.el-date-range-picker__content')];
    const matches = panels.filter(p => {
      const rect = p.getBoundingClientRect();
      const h = p.querySelector('.el-date-range-picker__header')?.textContent?.trim() || '';
      return p.offsetParent !== null && rect.width > 0 && rect.height > 0 && h === '${targetHeader}';
    });
    const targetPanel = matches[matches.length - 1];
    if (!targetPanel) return 'no target panel';
    let dayCell = [...targetPanel.querySelectorAll('td.available:not(.prev-month):not(.next-month)')].find(td => td.textContent.trim() === '${day}');
    if (!dayCell) dayCell = [...targetPanel.querySelectorAll('td')].find(td => !td.classList.contains('prev-month') && !td.classList.contains('next-month') && td.textContent.trim() === '${day}');
    if (!dayCell) return 'no day ${day}';
    dayCell.click();
    return 'first click';
  })()`);
  await sleep(1000);

  // 4. DOM 可能已刷新，重新查询同一规则的目标面板并再次点击目标日期。
  await cdpEval(ws, `(() => {
    const panels = [...document.querySelectorAll('.el-date-range-picker__content')];
    const matches = panels.filter(p => {
      const rect = p.getBoundingClientRect();
      const h = p.querySelector('.el-date-range-picker__header')?.textContent?.trim() || '';
      return p.offsetParent !== null && rect.width > 0 && rect.height > 0 && h === '${targetHeader}';
    });
    const targetPanel = matches[matches.length - 1];
    if (!targetPanel) return 'no target panel';
    let dayCell = [...targetPanel.querySelectorAll('td.available:not(.prev-month):not(.next-month)')].find(td => td.textContent.trim() === '${day}');
    if (!dayCell) dayCell = [...targetPanel.querySelectorAll('td')].find(td => !td.classList.contains('prev-month') && !td.classList.contains('next-month') && td.textContent.trim() === '${day}');
    if (!dayCell) return 'no day ${day}';
    dayCell.click();
    return 'second click';
  })()`);
  await sleep(800);

  // 5. 关面板（点空白处）。
  await cdpEval(ws, `document.body.click()`);
  await sleep(500);

  // 6. 最终以输入框实际值验证日期是否切成功。
  const dateVals = await cdpEval(ws, `(() => {
    const inputs = [...document.querySelectorAll('input')];
    return {
      start: inputs.find(i => i.placeholder === '开始日期')?.value,
      end: inputs.find(i => i.placeholder === '结束日期')?.value
    };
  })()`);
  return dateVals;
}

/** 等待新的 xlsx 下载完成并通过目标日期/报表类型校验 */
async function waitForNewXlsx(beforeFiles, { targetDate, validator, timeout = 60000 } = {}) {
  const validate = validator || (xlsxPath => parseXlsx(xlsxPath, targetDate));
  const start = Date.now();
  const observations = new Map();
  while (Date.now() - start < timeout) {
    await sleep(2000);
    const files = readdirSync(DOWNLOAD_DIR).filter(f => f.endsWith('.xlsx') && !f.endsWith('.crdownload'));
    for (const f of files) {
      const fullPath = path.join(DOWNLOAD_DIR, f);
      const stat = statSync(fullPath);
      const before = beforeFiles.get(f);
      if (stat.size <= 5000 || (before && stat.mtimeMs <= before.mtimeMs && stat.size === before.size)) continue;
      const signature = `${stat.size}:${stat.mtimeMs}`;
      const previous = observations.get(f);
      const stableCount = previous?.size === stat.size ? previous.stableCount + 1 : 0;
      const observation = { size: stat.size, stableCount, invalidSignature: previous?.invalidSignature || '' };
      observations.set(f, observation);
      if (stableCount < 2 || observation.invalidSignature === signature) continue;
      try {
        return { path: fullPath, value: validate(fullPath) };
      } catch {
        observation.invalidSignature = signature;
      }
    }
  }
  return null;
}

async function waitForDownloadCenterLayer(ws, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await cdpEval(ws, `(() => ({
      routeReady: location.hash === '#/baseSettings/downloadCenter',
      visibleGridReady: [...document.querySelectorAll('.v-ag-grid')].some(grid => {
        const rect = grid.getBoundingClientRect();
        return grid.offsetParent !== null && rect.width > 0 && rect.height > 0 && Boolean(grid.__vue__?.gridApi);
      })
    }))()`);
    if (state?.routeReady && state?.visibleGridReady) return state;
    if (!state?.routeReady) await cdpEval(ws, `location.href = "${DOWNLOAD_CENTER_URL}"`);
    await sleep(500);
  }
  throw new Error('download center layer not ready');
}

async function resolveDownloadCenterBusinessLayer(ws) {
  const maxAttempts = 20;
  let lastResult = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await cdpEval(ws, downloadCenterBusinessResolverSource);
    if (result?.ok) return result.layerId;
    if (result?.reason === 'ambiguous') throw new Error(`download center business layer ambiguous: ${JSON.stringify(result?.diagnostics || {})}`);
    if (result?.reason !== 'not-found') throw new Error(`download center business layer ${result?.reason || 'unknown'}: ${JSON.stringify(result?.diagnostics || {})}`);
    lastResult = result;
    if (attempt < maxAttempts - 1) await sleep(500);
  }
  throw new Error(`download center business layer not-found after ${maxAttempts} attempts: ${JSON.stringify(lastResult?.diagnostics || {})}`);
}

async function collectDownloadCenterTasks(ws, layerId) {
  return await cdpEval(ws, `(() => {
    const layerId = ${JSON.stringify(layerId)};
    const escapedLayerId = CSS.escape(layerId);
    const downloadRoot = document.querySelector('.analyzerContainer.view[data-huice-download-layer-id="' + escapedLayerId + '"]');
    if (!downloadRoot) return [];
    const gridElement = downloadRoot.querySelector('.v-ag-grid[data-huice-download-layer-id="' + escapedLayerId + '"]');
    const gridApi = gridElement?.__vue__?.gridApi;
    if (gridApi?.forEachNode) {
      const tasks = [];
      gridApi.forEachNode(node => {
        const data = node.data;
        if (!data || data.id == null) return;
        const statusName = String(data.statusName || '');
        const hasDownload = data.download === true || data.download === 1 || data.download === '1';
        const statusAllowsDownload = /待下载|可下载|完成/.test(statusName) && !/已下载|失败|生成中|处理中|等待中|排队中/.test(statusName);
        tasks.push({
          id: String(data.id),
          rowIndex: node.rowIndex == null ? '' : String(node.rowIndex),
          text: [data.taskName, data.updateTime, data.createrName, statusName].filter(Boolean).map(String).join(' '),
          buttonText: '下载',
          buttonVisible: hasDownload && statusAllowsDownload,
        });
      });
      if (tasks.length) return tasks;
    }

    const roots = ['.ag-center-cols-container', '.ag-pinned-left-cols-container', '.ag-pinned-right-cols-container'];
    const rows = new Map();
    const getImmutableTaskId = row => row.getAttribute('data-task-id') || row.getAttribute('task-id') || '';
    for (const rootSelector of roots) {
      for (const row of gridElement.querySelectorAll(rootSelector + ' .ag-row')) {
        const rowIndex = row.getAttribute('row-index') || '';
        const id = getImmutableTaskId(row);
        const logicalKey = id || rowIndex;
        if (!logicalKey) continue;
        const current = rows.get(logicalKey) || { id, rowIndex, textParts: [], buttonText: '', buttonVisible: false };
        const text = (row.innerText || '').trim();
        if (text) current.textParts.push(text);
        const operation = row.querySelector('[col-id="operation"]') || [...row.querySelectorAll('.ag-cell')].find(cell => cell.getAttribute('col-id') === 'operation');
        const button = operation?.querySelector('button, .el-button, [role=button]');
        if (button) {
          current.buttonText = (button.innerText || button.textContent || '').trim();
          current.buttonVisible = button.offsetParent !== null && !button.disabled;
        }
        rows.set(logicalKey, current);
      }
    }
    return [...rows.values()].map(row => ({ ...row, text: [...new Set(row.textParts)].join(' ') }));
  })()`);
}

async function queryDownloadCenter(ws, layerId) {
  const result = await cdpEval(ws, `(() => {
    const layerId = ${JSON.stringify(layerId)};
    const escapedLayerId = CSS.escape(layerId);
    const downloadRoot = document.querySelector('.analyzerContainer.view[data-huice-download-layer-id="' + escapedLayerId + '"]');
    if (!downloadRoot) return { ok: true, clicked: false, layerReady: false };
    const gridElement = downloadRoot.querySelector('.v-ag-grid[data-huice-download-layer-id="' + escapedLayerId + '"]');
    if (!gridElement) return { ok: true, clicked: false, layerReady: false };
    const button = [...downloadRoot.querySelectorAll('button, .el-button, [role=button]')]
      .find(item => ['查询', '搜索'].includes((item.innerText || '').trim()) && !item.disabled);
    if (!button) return { ok: true, clicked: false, layerReady: true };
    button.click();
    return { ok: true, clicked: true, layerReady: true };
  })()`);
  if (result?.clicked) await sleep(1500);
  return result;
}

async function collectDownloadCenterBaseline(ws) {
  await cdpEval(ws, `location.href = "${DOWNLOAD_CENTER_URL}"`);
  await waitForDownloadCenterLayer(ws);
  const layerId = await resolveDownloadCenterBusinessLayer(ws);
  await queryDownloadCenter(ws, layerId);
  const tasks = await collectDownloadCenterTasks(ws, layerId);
  return { layerId, taskKeys: tasks.map(task => normalizeExportTask(task).key) };
}

async function downloadFromCenter(ws, layerId, criteria) {
  await cdpEval(ws, `location.href = "${DOWNLOAD_CENTER_URL}"`);
  await waitForDownloadCenterLayer(ws);
  layerId = await resolveDownloadCenterBusinessLayer(ws);
  await queryDownloadCenter(ws, layerId);
  const maxAttempts = 20;
  let lastDecision = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tasks = await collectDownloadCenterTasks(ws, layerId);
    const taskDecision = pickExportTask(tasks, criteria);
    const poll = decideExportPoll({ attempt, maxAttempts, refreshEvery: 3, taskDecision });
    lastDecision = poll;
    if (poll.action === 'click') {
      const selected = taskDecision.selected;
      const clicked = await cdpEval(ws, `(async () => {
        const selectedTaskId = ${JSON.stringify(selected.id)};
        const layerId = ${JSON.stringify(layerId)};
        const escapedLayerId = CSS.escape(layerId);
        const roots = ['.ag-center-cols-container', '.ag-pinned-left-cols-container', '.ag-pinned-right-cols-container'];
        const downloadRoot = document.querySelector('.analyzerContainer.view[data-huice-download-layer-id="' + escapedLayerId + '"]');
        const gridElement = downloadRoot?.querySelector('.v-ag-grid[data-huice-download-layer-id="' + escapedLayerId + '"]');
        const gridApi = gridElement?.__vue__?.gridApi;
        if (!selectedTaskId || !gridApi?.forEachNode) return { ok: false, reason: 'selected task row unavailable' };
        let selectedRowIndex = null;
        gridApi.forEachNode(node => {
          if (String(node.data?.id ?? '') === selectedTaskId && node.rowIndex != null) selectedRowIndex = node.rowIndex;
        });
        if (selectedRowIndex == null) return { ok: false, reason: 'selected task row unavailable' };
        gridApi.ensureIndexVisible(selectedRowIndex, 'middle');
        if (gridApi.ensureColumnVisible) gridApi.ensureColumnVisible('operation');
        else gridApi.columnApi?.ensureColumnVisible?.('operation');
        const rowIndexText = String(selectedRowIndex);
        for (let clickAttempt = 0; clickAttempt < 6; clickAttempt++) {
          await new Promise(resolve => setTimeout(resolve, 150));
          for (const rootSelector of roots) {
            const row = [...gridElement.querySelectorAll(rootSelector + ' .ag-row')]
              .find(item => item.getAttribute('row-index') === rowIndexText);
            const operation = row?.querySelector('[col-id="operation"]');
            const button = operation?.querySelector('button, .el-button, [role=button]');
            if (button && (button.innerText || '').trim().replace(/\\s/g, '') === '下载' && button.offsetParent !== null && !button.disabled) {
              button.click();
              return { ok: true };
            }
          }
        }
        return { ok: false, reason: 'selected task download button disappeared' };
      })()`);
      if (!clicked?.ok) return { ok: false, reason: clicked?.reason || 'download click failed', candidates: poll.candidates };
      return { ok: true, taskKey: poll.taskKey };
    }
    if (poll.action === 'fail') return { ok: false, reason: poll.reason, candidates: poll.candidates };
    if (poll.action === 'reload') {
      await cdpEval(ws, 'location.reload()');
      await waitForDownloadCenterLayer(ws);
      layerId = await resolveDownloadCenterBusinessLayer(ws);
      await queryDownloadCenter(ws, layerId);
    } else {
      await sleep(1500);
    }
  }
  return { ok: false, reason: lastDecision?.reason || 'task_timeout', candidates: lastDecision?.candidates || [] };
}

/** 解析 xlsx -> records 数组 */
function parseXlsx(xlsxPath, targetDate) {
  const script = `
import openpyxl, json, sys
import warnings
warnings.filterwarnings('ignore', message=r"^Workbook contains no default style, apply openpyxl's default$", category=UserWarning)
wb = openpyxl.load_workbook('${xlsxPath}')
try:
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
finally:
    wb.close()
date_range = None
for row in rows:
    for index, cell in enumerate(row):
        if str(cell).strip() != '日期':
            continue
        value = str(row[index + 1]).strip() if index + 1 < len(row) and row[index + 1] is not None else ''
        match = __import__('re').match(r'^(\\d{4}-\\d{2}-\\d{2})\\s*[~至]\\s*(\\d{4}-\\d{2}-\\d{2})$', value)
        if match:
            date_range = match.groups()
            break
    if date_range:
        break
if date_range != ('${targetDate}', '${targetDate}'):
    raise ValueError('single-day date range mismatch')
product_identity_headers = {'链接ID', '商品ID', '商品编号'}
if not any(any(str(c).strip() in product_identity_headers for c in row if c is not None) for row in rows):
    raise ValueError('product ID header missing from export')
records = []
for row in rows[11:]:
    if not row[2]:
        continue
    product_id = str(row[2]).strip() if row[2] else ''
    if not product_id or product_id == 'None':
        continue
    def pn(v):
        if v is None: return None
        s = str(v).replace(',','').replace('%','').strip()
        try: return float(s)
        except: return None
    def pp(v):
        # 百分比转小数: "12.50%"->0.125, 12.5->0.125, 0.125->0.125
        if v is None: return None
        s = str(v)
        has_percent = '%' in s
        n = pn(v)
        if n is None: return None
        if has_percent: return n / 100
        if n > 1 or n < -1: return n / 100
        return n
    # 慧经营原始净利额
    raw_net_profit = pn(row[15])
    raw_net_profit_rate = pp(row[16])
    sales_amt = pn(row[5])
    sales_qty = pn(row[7])
    gross_profit = pn(row[10])
    gross_profit_rate = pp(row[12])
    # 真实净利润 = 慧经营净利额 - 1.15×销售件数(按订单数) - 销售额×2%
    order_count = sales_qty
    order_fixed_cost = 1.15 * order_count if order_count is not None else 0
    platform_fee = sales_amt * 0.02 if sales_amt is not None else 0
    real_net_profit = None
    if raw_net_profit is not None:
        real_net_profit = raw_net_profit - order_fixed_cost - platform_fee
    # 真实净利率 = 真实净利润 / 销售额
    real_net_profit_rate = None
    if real_net_profit is not None and sales_amt and sales_amt > 0:
        real_net_profit_rate = real_net_profit / sales_amt
    records.append({
        'productId': product_id,
        'productName': str(row[1] or '').strip(),
        'shopName': str(row[0] or '').strip(),
        'salesAmount': sales_amt,
        'salesQuantity': sales_qty,
        'orderCount': order_count,
        'costPrice': pn(row[8]),
        'grossProfit': gross_profit,
        'grossProfitRate': gross_profit_rate,
        'refundAmount': pn(row[13]),
        'refundRate': pp(row[14]),
        'rawNetProfit': raw_net_profit,
        'rawNetProfitRate': raw_net_profit_rate,
        'netProfit': real_net_profit,
        'netProfitRate': real_net_profit_rate,
        'orderFixedCost': order_fixed_cost,
        'platformFee': platform_fee,
        'platformFeeRate': 0.02,
        'orderFixedUnitCost': 1.15,
        'profitFormulaVersion': 'order-fixed-v1',
        'date': '${targetDate}',
        'source': 'huice-export'
    })
print(json.dumps(records))
`;
  const result = execSync(`python3 -c '${script.replace(/'/g, "'\\''")}'`, { encoding: 'utf8', timeout: 30000 });
  return JSON.parse(result.trim());
}

function publishJsonAtomically(filePath, payload) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(payload, null, 2));
    renameSync(tempPath, filePath);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

async function main() {
  const result = createCollectorResult();
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  // 日期列表:--dates 优先,否则按 --days 生成
  const dateList = [...new Set(customDates.length > 0
    ? customDates
    : Array.from({ length: days }, (_, i) => dateStr(-(i + 1))))];

  console.log(`🚀 慧经营导出回采（${dateList.length} 天）`);
  console.log(`   日期范围: ${dateList[0]} ~ ${dateList[dateList.length - 1]}`);

  // 找 hjy 标签页
  const tabs = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const hjyTab = tabs.find(t => t.type === 'page' && t.url.includes('hjy.huice.com'));
  if (!hjyTab) {
    console.error('❌ 没找到 hjy.huice.com 标签页');
    result.fatalError = new Error('hjy tab not found');
    return result;
  }

  const allRecords = [];
  const failedDates = result.failedDates;
  const successfulDates = new Set();
  const consumedTaskKeys = new Set();
  const ws = new WebSocket(hjyTab.webSocketDebuggerUrl);

  try {
    await new Promise((r, rej) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', rej, { once: true }); setTimeout(rej, 5000); });
    console.log(`✅ CDP 已连接`);

    // 确保在 CommodityAnalysis 页
    const curUrl = await cdpEval(ws, 'location.href');
    if (!curUrl.includes('CommodityAnalysis')) {
      await cdpEval(ws, 'location.href = "https://hjy.huice.com/#/opertData/CommodityAnalysis"');
      await sleep(4000);
    }

  for (let i = 0; i < dateList.length; i++) {
    const targetDate = dateList[i];
    console.log(`\n📅 [${i + 1}/${dateList.length}] 采集 ${targetDate}...`);

    // 0. 每天先刷新页面,清除日期选择器的残留 Vue 状态
    if (i > 0) {
      await cdpEval(ws, 'location.reload()');
      await sleep(5000);
    }

    // 1. 切日期（面板点击方式,失败自动重试 3 次）
    let dateResult = null;
    let dateOk = false;
    for (let retry = 0; retry < 3; retry++) {
      if (retry > 0) {
        console.log(`  🔄 日期切换重试 ${retry + 1}/3 (重载页面清 Vue 状态)`);
        await cdpEval(ws, 'location.href = "https://hjy.huice.com/#/opertData/CommodityAnalysis"');
        await sleep(5000);
      }
      dateResult = await setDateRangeByPanel(ws, targetDate);
      if (dateResult.start === targetDate && dateResult.end === targetDate) {
        dateOk = true;
        break;
      }
      console.log(`  ⚠ 日期切换失败(尝试 ${retry + 1}): ${JSON.stringify(dateResult)}`);
    }
    if (!dateOk) {
      console.log(`  ❌ 日期切换 3 次均失败,跳过 ${targetDate}`);
      // 记录失败日期,供后续补采
      markCollectorFailure(result, targetDate, 'date selection failed');
      continue;
    }

    // 2. 点查询
    const queryResult = await cdpEval(ws, `(() => {
      const btn = [...document.querySelectorAll('button, .el-button')].find(b =>
        ((b.innerText || '').trim() === '查询' || (b.innerText || '').trim() === '搜索') &&
        b.offsetParent !== null && !b.disabled
      );
      if (!btn) return { ok: false, reason: 'query button not found' };
      btn.click();
      return { ok: true };
    })()`);
    if (!queryResult?.ok) {
      markCollectorFailure(result, targetDate, queryResult?.reason || 'query failed');
      continue;
    }
    await sleep(5000);

    // 3. 提交导出前先记录下载中心已有任务。
    const baseline = await collectDownloadCenterBaseline(ws);
    const baselineTaskKeys = baseline.taskKeys;
    await cdpEval(ws, 'location.href = "https://hjy.huice.com/#/opertData/CommodityAnalysis"');
    await sleep(4000);
    const restoredDate = await setDateRangeByPanel(ws, targetDate);
    if (restoredDate?.start !== targetDate || restoredDate?.end !== targetDate) {
      markCollectorFailure(result, targetDate, 'date restore failed before export');
      continue;
    }
    const restoredQuery = await cdpEval(ws, `(() => {
      const btn = [...document.querySelectorAll('button, .el-button')].find(b =>
        ((b.innerText || '').trim() === '查询' || (b.innerText || '').trim() === '搜索') &&
        b.offsetParent !== null && !b.disabled
      );
      if (!btn) return { ok: false, reason: 'query button not found' };
      btn.click();
      return { ok: true };
    })()`);
    if (!restoredQuery?.ok) {
      markCollectorFailure(result, targetDate, restoredQuery?.reason || 'query restore failed');
      continue;
    }
    await sleep(5000);

    const downloadMenuResult = await cdpEval(ws, `(() => {
      const downloadBtn = [...document.querySelectorAll('button')].find(b => {
        const use = b.querySelector('use');
        const href = use?.getAttribute('href') || use?.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
        return href === '#icon-download' && b.offsetParent !== null && !b.disabled;
      });
      if (!downloadBtn) return { ok: false, reason: 'download toolbar button not found' };
      downloadBtn.click();
      return { ok: true };
    })()`);
    if (!downloadMenuResult?.ok) {
      markCollectorFailure(result, targetDate, downloadMenuResult?.reason || 'export menu open failed');
      continue;
    }
    await sleep(1500);

    // 4. 只在当前可见 popover 内点「导出全部」。
    const exportResult = await cdpEval(ws, `(() => {
      const popovers = [...document.querySelectorAll('.el-popover, .el-dropdown-menu')]
        .filter(el => el.offsetParent !== null || el.classList.contains('is-visible'));
      const popover = popovers.find(el => (el.innerText || '').includes('导出全部'));
      if (!popover) return { ok: false, reason: 'export menu not found' };
      const control = [...popover.querySelectorAll('button, .el-button, li, [role=menuitem], *')]
        .find(el => (el.innerText || '').trim() === '导出全部' && el.offsetParent !== null);
      if (!control) return { ok: false, reason: 'export all control not found' };
      const requestedAt = Date.now();
      control.click();
      return { ok: true, requestedAt };
    })()`);
    if (!exportResult?.ok) {
      markCollectorFailure(result, targetDate, exportResult?.reason || 'export submit failed');
      continue;
    }
    const exportRequestedAt = exportResult.requestedAt;
    await sleep(6000);

    const beforeFiles = snapshotDownloadFiles();
    const downloadResult = await downloadFromCenter(ws, baseline.layerId, {
      kind: 'product',
      requestedAt: exportRequestedAt,
      baselineTaskKeys,
      consumedTaskKeys: [...consumedTaskKeys],
      clockSkewMs: 1000,
    });
    if (!downloadResult.ok) {
      console.log(`  ⚠️ 下载中心失败: ${downloadResult.reason} ${JSON.stringify(downloadResult.candidates || [])}`);
      markCollectorFailure(result, targetDate, `download center ${downloadResult.reason}`);
      continue;
    }
    consumedTaskKeys.add(downloadResult.taskKey);

    // 等下载完成
    const downloadedXlsx = await waitForNewXlsx(beforeFiles, { targetDate, timeout: 60000 });
    if (!downloadedXlsx) {
      console.log(`  ⚠️ 下载超时,跳过`);
      markCollectorFailure(result, targetDate, 'download timeout');
      continue;
    }
    const xlsxPath = downloadedXlsx.path;
    const records = downloadedXlsx.value;
    console.log(`  📄 下载完成: ${path.basename(xlsxPath)}`);
    if (records.length === 0) {
      console.log(`  ⚠️ xlsx 没有有效商品记录,跳过`);
      markCollectorFailure(result, targetDate, 'no valid product records');
      continue;
    }

    try {
      // 6. 原子替换该日期的完整 SQLite 快照；失败时事务回滚并保留旧数据。
      const inserted = replaceProductProfitDateSnapshot(records);
      if (inserted !== records.length) throw new Error(`SQLite snapshot count mismatch: ${inserted}/${records.length}`);
      console.log(`  📦 SQLite 入库 ${inserted} 条 -> ${getDbPath()}`);

      const netProfitCount = records.filter(r => r.netProfit != null).length;
      console.log(`  ✅ ${records.length} 条 (netProfit 有值: ${netProfitCount})`);

      const archivePath = path.join(OUTPUT_DIR, `${targetDate.replace(/-/g, '')}.xlsx`);
      renameSync(xlsxPath, archivePath);
      publishJsonAtomically(
        path.join(OUTPUT_DIR, `${targetDate.replace(/-/g, '')}.json`),
        { date: targetDate, records }
      );
      allRecords.push(...records);
      successfulDates.add(targetDate);
    } catch (e) {
      console.log(`  ⚠️ 持久化或发布失败: ${e.message}`);
      markCollectorFailure(result, targetDate, `persistence or publication failed: ${e.message}`);
      continue;
    }

    // 8. 回到商品排名页（为下一天准备）
    await cdpEval(ws, 'location.href = "https://hjy.huice.com/#/opertData/CommodityAnalysis"');
    await sleep(3000);
  }
  } finally {
    ws.close();
  }

  const fullySuccessful = allRecords.length > 0
    && successfulDates.size === dateList.length
    && dateList.every(date => successfulDates.has(date))
    && failedDates.length === 0
    && !result.fatalError;
  const failLog = path.join(OUTPUT_DIR, 'failed-dates.json');

  if (fullySuccessful) {
    const summaryFile = path.join(OUTPUT_DIR, 'huice-latest.json');
    writeFileSync(summaryFile, JSON.stringify(allRecords, null, 2));
    console.log(`💾 数据落盘: ${summaryFile} (${allRecords.length} 条)`);
  } else {
    console.log(`⚠️ 本次运行不完整或无数据,保留现有 huice-latest.json`);
  }
  console.log(`✅ 回采完成`);

  // 失败日期汇总；只有完整成功才清理历史失败标记。
  if (failedDates.length > 0) {
    writeFileSync(failLog, JSON.stringify({ dates: failedDates, failures: result.failures, ts: new Date().toISOString() }, null, 2));
    console.log(`⚠️ ${failedDates.length} 天采集失败,已记录到 ${failLog}`);
    console.log(`   失败日期: ${failedDates.join(', ')}`);
    console.log(`   补采命令: node tools/huice-export-cdp.mjs --dates ${failedDates.join(',')}`);
  } else if (fullySuccessful) {
    if (existsSync(failLog)) unlinkSync(failLog);
  }
  return result;
}

main().then(result => { process.exit(collectorExitCode(result)); }).catch(e => { console.error("❌", e.message); process.exit(1); });
