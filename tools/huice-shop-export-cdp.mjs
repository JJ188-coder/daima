#!/usr/bin/env node
/**
 * huice-shop-export-cdp.mjs - 慧经营店铺维度数据导出器
 *
 * 通过 CDP 控制慧经营「多维利润分析」页面,按日下载所有拼多多店铺的利润数据。
 *
 * 流程（每天）:
 *   1. 导航到多维利润分析页,切换到 #tab-DIM（更多店铺展示）
 *   2. 在店铺选择框输入"拼"筛选拼多多店铺,点全选
 *   3. 切日期到目标日（单日范围）,点查询
 *   4. 点 .export-icon-container 下载
 *   5. 如弹"是否分店铺下载",选"否"
 *   6. 去下载中心,点第一行下载按钮
 *   7. 等下载完成,解析 xlsx（动态表头）-> 入库 shop_daily_profit
 *
 * 用法:
 *   node tools/huice-shop-export-cdp.mjs --dates 2026-07-09
 *   node tools/huice-shop-export-cdp.mjs --days 30
 *
 * 输出目录: output/huice-shop-exports/
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShopExportRows } from '../scripts/huice/lib/shop-profit.mjs';
import { bulkUpsertShopDailyProfit, getDbPath } from '../scripts/huice/lib/db.mjs';
import { collectorExitCode, createCollectorResult, markCollectorFailure } from '../scripts/huice/lib/collector-result.mjs';
import { validateExportRows } from '../scripts/huice/lib/export-validation.mjs';
import { decideExportPoll, decideExportSubmitState, downloadCenterBusinessResolverSource, elementUiActiveDialogPredicateSource, normalizeExportTask, pickExportTask } from '../scripts/huice/lib/export-flow.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.resolve(ROOT, 'output/huice-shop-exports');
const DOWNLOAD_DIR = path.resolve(process.env.HOME, 'Downloads');
const TARGET_URL = 'https://hjy.huice.com/#/businessAnalysisCenter/report/trendNew';
const DOWNLOAD_CENTER_URL = 'https://hjy.huice.com/#/baseSettings/downloadCenter';

/** 导出选择器常量（供测试用） */
export const HUICE_SHOP_SELECTORS = {
  shopSearchInput: '.dc-shop input[placeholder="搜索店铺"]:not([readonly])',
  exportIcon: '.export-icon-container',
  shopViewTab: '#tab-DIM',
};

/** 生成日期字符串（本地时区,offset=0 今天,-1 昨天） */
function dateStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 构建导出参数（供测试用） */
export function buildShopExportArgs({ dates, days }) {
  let dateList;
  if (dates && dates.length > 0) {
    dateList = dates;
  } else {
    const n = days || 1;
    dateList = Array.from({ length: n }, (_, i) => dateStr(-(i + 1)));
  }
  return { dates: [...new Set(dateList)], outputDir: OUTPUT_DIR };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function snapshotDownloadFiles() {
  return new Map(readdirSync(DOWNLOAD_DIR).map(name => {
    const stat = statSync(path.join(DOWNLOAD_DIR, name));
    return [name, { mtimeMs: stat.mtimeMs, size: stat.size }];
  }));
}

// ============ CDP 工具函数 ============

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
    setTimeout(() => { ws.removeEventListener('message', handler); reject(new Error(`${method} 超时`)); }, 30000);
  });
}

async function cdpEval(ws, expression) {
  const res = await cdpCall(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return res.result?.result?.value;
}

/** 只关闭无业务副作用的通知，不碰确定、取消、遮罩或未知弹窗 */
async function dismissPassiveUi(ws) {
  for (let round = 0; round < 10; round++) {
    const result = await cdpEval(ws, `(() => {
      const actions = [];
      const containers = [...document.querySelectorAll('.el-notification, .el-message')]
        .filter(el => el.offsetParent !== null);
      for (const container of containers) {
        const text = (container.innerText || '').trim();
        const targets = [...container.querySelectorAll('button, .el-button, [role=button], .el-notification__closeBtn, .el-message__closeBtn, *')];
        const target = targets.find(el => {
          const label = (el.innerText || el.getAttribute?.('aria-label') || '').trim().replace(/\\s/g, '');
          return ['我知道了', '300S后关闭', '关闭'].includes(label) && el.offsetParent !== null;
        });
        if (target) {
          actions.push(text.slice(0, 120));
          target.click();
        }
      }
      return { count: actions.length, actions };
    })()`);
    if (!result?.count) break;
    result.actions.forEach(text => console.log(`  🧹 已关闭通知: ${text}`));
    await sleep(300);
  }
}

/** 切换到"更多店铺展示"Tab（#tab-DIM） */
async function switchToShopTab(ws) {
  await cdpEval(ws, `(() => {
    const tab = document.querySelector('${HUICE_SHOP_SELECTORS.shopViewTab}');
    if (tab && !tab.classList.contains('is-active')) {
      tab.click();
      return 'clicked';
    }
    return tab ? 'already active' : 'no tab';
  })()`);
  await sleep(2000);
}

/** 选所有拼多多店铺：打开选择器 -> 输入"拼"筛选 -> 等列表过滤 -> 点"全部" -> 确认 */
async function selectAllPddShops(ws) {
  // 1. 打开店铺选择器
  await cdpEval(ws, `(() => {
    const box = document.querySelector('.select-tags-box');
    if (box) box.click();
    return 'ok';
  })()`);
  await sleep(1500);

  // 2. 输入"拼"筛选拼多多店铺（用 native setter 触发 Vue 响应式）
  await cdpEval(ws, `(() => {
    const input = document.querySelector('${HUICE_SHOP_SELECTORS.shopSearchInput}');
    if (!input) return 'no search input';
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '拼');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(2000);

  // 3. 等列表过滤完成: 检查 .level2-item 全部以"拼"开头
  const filterOk = await cdpEval(ws, `(() => {
    const items = [...document.querySelectorAll('.dc-shop .level2-item')];
    if (items.length === 0) return 'no items';
    const allPdd = items.every(el => (el.innerText || '').trim().startsWith('拼'));
    return allPdd ? 'ok' : 'not all 拼: ' + items.map(el => (el.innerText || '').trim().slice(0, 5)).join(',');
  })()`);
  console.log(`  🔍 店铺筛选: ${filterOk}`);

  // 4. 点"全部"(label.el-checkbox)
  const selectResult = await cdpEval(ws, `(() => {
    const popover = document.querySelector('.dc-shop');
    if (!popover) return 'no popover';
    // 找文本含"全部"的 label.el-checkbox
    const checkboxes = [...popover.querySelectorAll('label.el-checkbox')];
    const allBox = checkboxes.find(el => (el.innerText || '').trim().includes('全部'));
    if (allBox) {
      if (!allBox.classList.contains('is-checked')) {
        allBox.click();
        return 'clicked 全部';
      }
      return 'already checked';
    }
    // fallback: 找任何含"全部"文字的可点击元素
    const els = [...popover.querySelectorAll('*')];
    const allEl = els.find(el => (el.innerText || '').trim() === '全部' && el.offsetParent !== null);
    if (allEl) { allEl.click(); return 'clicked 全部 (fallback)'; }
    return 'no 全部 found';
  })()`);
  console.log(`  ☑️ 全选: ${selectResult}`);
  await sleep(1000);

  // 5. 点确认按钮(弹层里的 .confirm)
  const confirmResult = await cdpEval(ws, `(() => {
    const popover = document.querySelector('.dc-shop');
    if (!popover) return 'no popover';
    const confirmBtn = popover.querySelector('.confirm, button.confirm, [class*=confirm]');
    if (confirmBtn) { confirmBtn.click(); return 'clicked confirm'; }
    return 'no confirm';
  })()`);
  console.log(`  ✅ 确认: ${confirmResult}`);
  await sleep(500);

  // 6. 关闭残留 popover
  await cdpEval(ws, `document.body.click()`);
  await sleep(300);
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

  // 2. 翻月到目标月（最多翻 12 次），每次都重新查询可见 DOM。
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
      const btnRight = first.querySelector('.el-icon-arrow-right');
      if (btnRight) { (btnRight.closest('button') || btnRight).click(); return 'next'; }
      return 'no arrow';
    })()`);
    await sleep(800);
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

/** 点查询按钮 */
async function clickQuery(ws) {
  const result = await cdpEval(ws, `(() => {
    const btn = [...document.querySelectorAll('button, .el-button')].find(b =>
      ((b.innerText || '').trim() === '查询' || (b.innerText || '').trim() === '搜索') &&
      b.offsetParent !== null && !b.disabled
    );
    if (!btn) return { ok: false, reason: 'query button not found' };
    btn.click();
    return { ok: true };
  })()`);
  if (!result?.ok) throw new Error(result?.reason || 'query failed');
  await sleep(5000);
}

/** 点导出图标并在目标业务弹窗内选择"否"、提交 */
async function clickExport(ws) {
  await dismissPassiveUi(ws);
  const exportResult = await cdpEval(ws, `(() => {
    const el = document.querySelector('${HUICE_SHOP_SELECTORS.exportIcon}');
    if (!el || el.offsetParent === null) return { ok: false, reason: 'export icon not found' };
    el.click();
    return { ok: true };
  })()`);
  if (!exportResult?.ok) throw new Error(exportResult?.reason || 'export icon click failed');
  console.log(`  📤 导出图标: 已点击`);

  let dialogReady = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(250);
    const probe = await cdpEval(ws, `(() => {
      const isActiveDialog = ${elementUiActiveDialogPredicateSource};
      const dialogs = [...document.querySelectorAll('.el-dialog, [role=dialog]')].filter(isActiveDialog);
      const target = dialogs.find(d => (d.innerText || '').includes('分店铺'));
      return target ? { found: true, text: (target.innerText || '').slice(0, 300) } : { found: false };
    })()`);
    if (probe?.found) { dialogReady = true; break; }
    await dismissPassiveUi(ws);
  }
  if (!dialogReady) throw new Error('export options dialog not found');

  const selection = await cdpEval(ws, `(() => {
    const isActiveDialog = ${elementUiActiveDialogPredicateSource};
    const dialogs = [...document.querySelectorAll('.el-dialog, [role=dialog]')].filter(isActiveDialog);
    const target = dialogs.find(d => (d.innerText || '').includes('分店铺'));
    if (!target) return { ok: false, reason: 'export options dialog disappeared' };
    const labels = [...target.querySelectorAll('label.el-radio-button, label.el-radio')];
    const noLabel = labels.find(l => (l.innerText || '').trim().replace(/\\s/g, '') === '否');
    if (!noLabel) return { ok: false, reason: 'no option missing' };
    const input = noLabel.querySelector('input[type=radio]');
    if (!noLabel.classList.contains('is-active') && !input?.checked) (input || noLabel).click();
    return { ok: true };
  })()`);
  if (!selection?.ok) throw new Error(selection?.reason || 'select no failed');

  let selected = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    await sleep(200);
    selected = await cdpEval(ws, `(() => {
      const isActiveDialog = ${elementUiActiveDialogPredicateSource};
      const dialogs = [...document.querySelectorAll('.el-dialog, [role=dialog]')].filter(isActiveDialog);
      const target = dialogs.find(d => (d.innerText || '').includes('分店铺'));
      const label = [...(target?.querySelectorAll('label.el-radio-button, label.el-radio') || [])]
        .find(l => (l.innerText || '').trim().replace(/\\s/g, '') === '否');
      return !!label && (label.classList.contains('is-active') || label.querySelector('input[type=radio]')?.checked);
    })()`);
    if (selected) break;
  }
  if (!selected) throw new Error('no option was not selected');
  console.log(`  📤 分店铺选否: 已确认`);

  const exportRequestedAt = Date.now();
  const submitted = await cdpEval(ws, `(() => {
    const isActiveDialog = ${elementUiActiveDialogPredicateSource};
    const dialogs = [...document.querySelectorAll('.el-dialog, [role=dialog]')].filter(isActiveDialog);
    const target = dialogs.find(d => (d.innerText || '').includes('分店铺'));
    if (!target) return { ok: false, reason: 'export options dialog missing before submit' };
    const noLabel = [...target.querySelectorAll('label.el-radio-button, label.el-radio')]
      .find(l => (l.innerText || '').trim().replace(/\\s/g, '') === '否');
    const noInput = noLabel?.querySelector('input[type=radio]');
    if (!noLabel || (!noLabel.classList.contains('is-active') && !noInput?.checked)) {
      return { ok: false, reason: 'no option lost selection before submit' };
    }
    const confirm = [...target.querySelectorAll('button, .el-button')]
      .find(b => (b.innerText || '').trim().replace(/\\s/g, '') === '确定' && b.offsetParent !== null && !b.disabled);
    if (!confirm) return { ok: false, reason: 'scoped confirm button missing' };
    const rect = confirm.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { ok: false, reason: 'scoped confirm has no clickable rect' };
    confirm.click();
    return { ok: true };
  })()`);
  if (!submitted?.ok) throw new Error(submitted?.reason || 'export submit failed');

  const readSubmitState = async () => await cdpEval(ws, `(() => {
    const isActiveDialog = ${elementUiActiveDialogPredicateSource};
    const dialogs = [...document.querySelectorAll('.el-dialog, [role=dialog]')];
    const target = dialogs.find(d => (d.innerText || '').includes('分店铺'));
    const wrapper = target?.closest?.('.el-dialog__wrapper');
    const wrapperLeaving = !!wrapper && String(wrapper.className || '').includes('leave');
    const dialogOpen = !!target && isActiveDialog(target);
    const notices = [...document.querySelectorAll('.el-notification, .el-message')]
      .filter(n => n.offsetParent !== null)
      .map(n => (n.innerText || '').trim())
      .filter(Boolean);
    const taskEvidence = [...document.querySelectorAll('[class*=task], [class*=download], .ag-row')]
      .filter(el => el.offsetParent !== null)
      .map(el => (el.innerText || '').trim())
      .find(text => /导出.{0,20}(生成中|处理中|排队|成功|已提交)|待下载/.test(text));
    return { dialogOpen, wrapperLeaving, notices, taskEvidence: taskEvidence || '' };
  })()`);

  for (let poll = 0; poll < 40; poll++) {
    await sleep(300);
    const state = await readSubmitState();
    if (state?.notices?.length) state.notices.forEach(text => console.log(`  📤 导出反馈: ${text.slice(0, 160)}`));
    if (decideExportSubmitState(state) === 'accepted') {
      await dismissPassiveUi(ws);
      return exportRequestedAt;
    }
  }

  throw new Error('export options dialog remained active after single scoped submit');

}


/** 等下载中心业务层和 AG-Grid 就绪；通知层是否覆盖不影响判断。 */
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

/** 只读取下载中心业务层的 AG-Grid 逻辑行,不读取通知浮层。 */
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

/** 去下载中心,只在下载业务层等本次新任务出现并精确下载。 */
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
      console.log(`  ✅ 下载中心: 点击任务 ${poll.taskKey}`);
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

/** 等待新的 xlsx 下载完成并通过目标日期/报表类型校验 */
async function waitForNewXlsx(beforeFiles, { targetDate, validator, timeout = 60000 } = {}) {
  const validate = validator || (xlsxPath => {
    const rawRows = parseXlsxRaw(xlsxPath);
    const validation = validateExportRows(rawRows, { kind: 'shop', targetDate });
    if (!validation.ok) throw new Error(validation.reason);
    return rawRows;
  });
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

/** 用 Python openpyxl 读取 xlsx 原始行,找到"店铺名称"表头行,返回 2D 数组 */
function parseXlsxRaw(xlsxPath) {
  const script = [
    'import openpyxl, json, sys',
    'import warnings',
    'warnings.filterwarnings(\'ignore\', message=r"^Workbook contains no default style, apply openpyxl\'s default$", category=UserWarning)',
    'wb = openpyxl.load_workbook(sys.argv[1])',
    'try:',
    '    ws = wb.active',
    '    rows = list(ws.iter_rows(values_only=True))',
    'finally:',
    '    wb.close()',
    'result = []',
    'for row in rows:',
    '    result.append([str(c) if c is not None else "" for c in row])',
    'print(json.dumps(result, ensure_ascii=False))',
  ].join('\n');
  const result = execFileSync('python3', ['-c', script, xlsxPath], { encoding: 'utf8', timeout: 30000 });
  return JSON.parse(result.trim());
}

// ============ 主流程 ============

async function main() {
  const result = createCollectorResult();
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  // 解析命令行参数
  const args = process.argv.slice(2);
  let days = 1;
  let customDates = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) { days = parseInt(args[i + 1], 10); i++; }
    if (args[i] === '--dates' && args[i + 1]) { customDates = args[i + 1].split(','); i++; }
  }

  const { dates: dateList } = buildShopExportArgs({ dates: customDates, days });

  console.log(`🚀 慧经营店铺维度导出回采（${dateList.length} 天）`);
  console.log(`   日期范围: ${dateList[0]} ~ ${dateList[dateList.length - 1]}`);
  console.log(`   输出目录: ${OUTPUT_DIR}`);

  // 找 hjy 标签页
  const tabs = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const hjyTab = tabs.find(t => t.type === 'page' && t.url.includes('hjy.huice.com'));
  if (!hjyTab) {
    console.error('❌ 没找到 hjy.huice.com 标签页');
    result.fatalError = new Error('hjy tab not found');
    return result;
  }

  const ws = new WebSocket(hjyTab.webSocketDebuggerUrl);
  await new Promise((r, rej) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', rej, { once: true });
    setTimeout(rej, 5000);
  });
  console.log(`✅ CDP 已连接`);

  const allRecords = [];
  const failedDates = result.failedDates;
  const successfulDates = new Set();
  const consumedTaskKeys = new Set();

  for (let i = 0; i < dateList.length; i++) {
    const targetDate = dateList[i];
    console.log(`\n📅 [${i + 1}/${dateList.length}] 采集 ${targetDate}...`);

    try {
      // 1. 导航到多维利润分析页
      await cdpEval(ws, `location.href = "${TARGET_URL}"`);
      await sleep(5000);
      await dismissPassiveUi(ws);

      // 2. 切换到"更多店铺展示"Tab
      await switchToShopTab(ws);

      // 3. 切日期（失败重试 3 次）
      let dateOk = false;
      for (let retry = 0; retry < 3; retry++) {
        if (retry > 0) {
          console.log(`  🔄 日期切换重试 ${retry + 1}/3 (重载页面)`);
          await cdpEval(ws, `location.href = "${TARGET_URL}"`);
          await sleep(5000);
          await dismissPassiveUi(ws);
          await switchToShopTab(ws);
        }
        const dateResult = await setDateRangeByPanel(ws, targetDate);
        if (dateResult && dateResult.start === targetDate && dateResult.end === targetDate) {
          dateOk = true;
          break;
        }
        console.log(`  ⚠ 日期切换失败(尝试 ${retry + 1}): ${JSON.stringify(dateResult)}`);
      }
      if (!dateOk) {
        console.log(`  ❌ 日期切换 3 次均失败,跳过 ${targetDate}`);
        markCollectorFailure(result, targetDate, 'date selection failed');
        continue;
      }

      // 4. 每次导航后重新筛选拼多多店铺，页面重载不会保留上一次的选择。
      await selectAllPddShops(ws);

      // 5. 点查询
      await clickQuery(ws);

      // 6. 提交导出前记录下载中心已有任务,避免复用旧任务。
      const baseline = await collectDownloadCenterBaseline(ws);
      const baselineTaskKeys = baseline.taskKeys;
      await cdpEval(ws, `location.href = "${TARGET_URL}"`);
      await sleep(5000);
      await dismissPassiveUi(ws);
      await switchToShopTab(ws);
      await selectAllPddShops(ws);
      const restoredDate = await setDateRangeByPanel(ws, targetDate);
      if (restoredDate?.start !== targetDate || restoredDate?.end !== targetDate) throw new Error('date restore failed before export');
      await clickQuery(ws);

      // 7. 点导出 -> 处理弹窗,使用 clickExport 返回的实际提交时间。
      const exportRequestedAt = await clickExport(ws);

      // 8. 去下载中心下载 xlsx
      const beforeFiles = snapshotDownloadFiles();
      const download = await downloadFromCenter(ws, baseline.layerId, {
        kind: 'shop',
        requestedAt: exportRequestedAt,
        baselineTaskKeys,
        consumedTaskKeys: [...consumedTaskKeys],
        clockSkewMs: 1000,
      });
      if (!download.ok) {
        console.log(`  ⚠️ 下载中心失败: ${download.reason} ${JSON.stringify(download.candidates || [])}`);
        markCollectorFailure(result, targetDate, `download center ${download.reason}`);
        continue;
      }
      consumedTaskKeys.add(download.taskKey);

      // 9. 等下载完成
      const downloadedXlsx = await waitForNewXlsx(beforeFiles, { targetDate, timeout: 60000 });
      if (!downloadedXlsx) {
        console.log(`  ⚠️ 下载超时,跳过`);
        markCollectorFailure(result, targetDate, 'download timeout');
        continue;
      }
      const xlsxPath = downloadedXlsx.path;
      const rawRows = downloadedXlsx.value;
      console.log(`  📄 下载完成: ${path.basename(xlsxPath)}`);

      // 9. xlsx 已在等待阶段完成解析和校验
      const records = parseShopExportRows(rawRows, targetDate);
      if (records.length === 0) {
        console.log(`  ⚠️ xlsx 没有有效店铺记录,跳过`);
        markCollectorFailure(result, targetDate, 'no valid shop records');
        continue;
      }
      // 10. 必须完整入库，部分插入不能视为该日期成功。
      const inserted = bulkUpsertShopDailyProfit(records);
      if (inserted !== records.length) throw new Error(`SQLite insert count mismatch: ${inserted}/${records.length}`);
      console.log(`  📦 SQLite 入库 ${inserted} 条 -> ${getDbPath()}`);

      const profitCount = records.filter(r => r.netProfit != null).length;
      console.log(`  ✅ ${records.length} 家店铺 (netProfit 有值: ${profitCount})`);

      // 11. 仅在完整入库后发布归档和 JSON 快照。
      const archivePath = path.join(OUTPUT_DIR, `${targetDate.replace(/-/g, '')}.xlsx`);
      renameSync(xlsxPath, archivePath);
      writeFileSync(
        path.join(OUTPUT_DIR, `${targetDate.replace(/-/g, '')}.json`),
        JSON.stringify({ date: targetDate, records }, null, 2)
      );
      allRecords.push(...records);
      successfulDates.add(targetDate);

    } catch (e) {
      console.log(`  ❌ 采集失败: ${e.message}`);
      markCollectorFailure(result, targetDate, e.message);
    }
  }

  ws.close();

  const fullySuccessful = allRecords.length > 0
    && successfulDates.size === dateList.length
    && dateList.every(date => successfulDates.has(date))
    && failedDates.length === 0
    && !result.fatalError;
  const failLog = path.join(OUTPUT_DIR, 'failed-dates.json');

  // 汇总落盘
  if (fullySuccessful) {
    const summaryFile = path.join(OUTPUT_DIR, 'huice-shop-latest.json');
    writeFileSync(summaryFile, JSON.stringify(allRecords, null, 2));
    console.log(`\n💾 数据落盘: ${summaryFile} (${allRecords.length} 条)`);
  } else {
    console.log(`\n⚠️ 本次运行不完整或无数据,保留现有 huice-shop-latest.json`);
  }
  console.log(`✅ 回采完成`);

  // 失败日期汇总；只有完整成功才清理历史失败标记。
  if (failedDates.length > 0) {
    writeFileSync(failLog, JSON.stringify({ dates: failedDates, failures: result.failures, ts: new Date().toISOString() }, null, 2));
    console.log(`⚠️ ${failedDates.length} 天采集失败,已记录到 ${failLog}`);
    console.log(`   失败日期: ${failedDates.join(', ')}`);
    console.log(`   补采命令: node tools/huice-shop-export-cdp.mjs --dates ${failedDates.join(',')}`);
  } else if (fullySuccessful) {
    if (existsSync(failLog)) unlinkSync(failLog);
  }
  return result;
}

main().then(result => { process.exit(collectorExitCode(result)); }).catch(e => { console.error("❌", e.message); process.exit(1); });
