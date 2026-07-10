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

import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShopExportRows } from '../scripts/huice/lib/shop-profit.mjs';
import { upsertShop, upsertShopDailyProfit, getDbPath } from '../scripts/huice/lib/db.mjs';

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
    dateList = [...dates].sort();
  } else {
    const n = days || 1;
    dateList = Array.from({ length: n }, (_, i) => dateStr(-(i + 1)));
  }
  return { dates: dateList, outputDir: OUTPUT_DIR };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

/** 关闭弹窗（"我知道了"等） */
async function closePopups(ws) {
  await cdpEval(ws, `(() => {
    document.querySelectorAll('button, .el-button').forEach(el => {
      const t = (el.innerText || '').trim();
      if (['我知道了', '300S后关闭', '确定', '关闭'].includes(t) && el.offsetParent !== null) el.click();
    });
    return 'ok';
  })()`);
  await sleep(800);
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

  // 0. 先关闭旧面板(可能有残留)
  await cdpEval(ws, `document.body.click()`);
  await sleep(300);

  // 1. 打开日期面板
  await cdpEval(ws, `(() => {
    const editor = document.querySelector('.el-range-editor');
    if (editor) editor.click();
    return 'ok';
  })()`);
  await sleep(1500);

  // 2. 翻月到目标月（最多翻 12 次）
  // 注意: 页面可能有多个残留面板,用 querySelectorAll 取所有
  for (let attempt = 0; attempt < 12; attempt++) {
    const found = await cdpEval(ws, `(() => {
      const panels = document.querySelectorAll('.el-date-range-picker__content');
      for (const p of panels) {
        const h = p.querySelector('.el-date-range-picker__header')?.textContent?.trim() || '';
        if (h === '${targetHeader}') return 'found';
      }
      return 'not found';
    })()`);
    if (found === 'found') break;

    // 往前翻一个月:点第一个面板的单箭头
    await cdpEval(ws, `(() => {
      const panels = document.querySelectorAll('.el-date-range-picker__content');
      const first = panels[0];
      if (!first) return 'no panel';
      const btn = first.querySelector('.el-icon-arrow-left');
      if (btn) { (btn.closest('button') || btn).click(); return 'prev'; }
      // 也可能需要往后翻
      const btnRight = first.querySelector('.el-icon-arrow-right');
      if (btnRight) { (btnRight.closest('button') || btnRight).click(); return 'next'; }
      return 'no arrow';
    })()`);
    await sleep(800);
  }

  // 3. 点目标日期两次(用最后一个匹配的面板,避免残留面板干扰)
  await cdpEval(ws, `(() => {
    const panels = [...document.querySelectorAll('.el-date-range-picker__content')];
    // 取最后一个匹配目标月的面板(最新的)
    let targetPanel = null;
    for (const p of panels) {
      const h = p.querySelector('.el-date-range-picker__header')?.textContent?.trim() || '';
      if (h === '${targetHeader}') targetPanel = p;
    }
    if (!targetPanel) return 'no target panel';
    // 直接找目标日期,不管状态(start-date/end-date/in-range 都不管)
    let dayCell = [...targetPanel.querySelectorAll('td.available')].find(td =>
      td.textContent.trim() === '${day}'
    );
    if (!dayCell) return 'no day ${day}';
    dayCell.click();  // 第一次:设开始日期
    return 'first click';
  })()`);
  await sleep(1000);

  // 4. 第二次点同一日期(设结束 = 开始 = 单日范围)
  await cdpEval(ws, `(() => {
    const panels = document.querySelectorAll('.el-date-range-picker__content');
    let targetPanel = null;
    for (const p of panels) {
      const h = p.querySelector('.el-date-range-picker__header')?.textContent?.trim() || '';
      if (h === '${targetHeader}') { targetPanel = p; break; }
    }
    if (!targetPanel) return 'no target panel';
    // 重新找(可能 DOM 变了)
    let dayCell = [...targetPanel.querySelectorAll('td.available')].find(td =>
      td.textContent.trim() === '${day}'
    );
    if (!dayCell) {
      // 也找 td 不带 available 的(选中后可能 class 变了)
      dayCell = [...targetPanel.querySelectorAll('td')].find(td =>
        td.textContent.trim() === '${day}'
      );
    }
    if (!dayCell) return 'no day';
    dayCell.click();  // 第二次:设结束日期
    return 'second click';
  })()`);
  await sleep(800);

  // 5. 关面板（点空白处）
  await cdpEval(ws, `document.body.click()`);
  await sleep(500);

  // 6. 验证日期是否切成功
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
  await cdpEval(ws, `(() => {
    const btn = [...document.querySelectorAll('button, .el-button')].find(b =>
      (b.innerText || '').trim() === '查询' || (b.innerText || '').trim() === '搜索'
    );
    if (btn) btn.click();
    return 'ok';
  })()`);
  await sleep(5000);
}

/** 点导出图标 -> 选"否"(不分店铺) -> 点"确 定" -> 去下载中心 */
async function clickExport(ws) {
  // 1. 点导出图标
  const exportResult = await cdpEval(ws, `(() => {
    const el = document.querySelector('${HUICE_SHOP_SELECTORS.exportIcon}');
    if (el) { el.click(); return 'ok'; }
    return 'no export icon';
  })()`);
  console.log(`  📤 导出图标: ${exportResult}`);
  await sleep(2000);

  // 2. 选"否"(分店铺导出选否) - 点 radio 的 input
  const noResult = await cdpEval(ws, `(() => {
    const dialogs = [...document.querySelectorAll('.el-dialog')].filter(d => d.offsetParent !== null);
    const target = dialogs.find(d => d.innerText.includes('分店铺'));
    if (!target) return 'no dialog';
    // 找"否"的 radio input
    const labels = [...target.querySelectorAll('label.el-radio-button')];
    const noLabel = labels.find(l => (l.innerText || '').trim() === '否');
    if (!noLabel) return 'no 否 label';
    // 如果还没选中,点 input
    if (!noLabel.classList.contains('is-active')) {
      const input = noLabel.querySelector('input[type=radio]');
      if (input) { input.click(); return 'clicked input'; }
      noLabel.click(); return 'clicked label';
    }
    return 'already selected';
  })()`);
  console.log(`  📤 分店铺选否: ${noResult}`);
  await sleep(500);

  // 3. 点"确 定"(用 DOM click + CDP 鼠标点击双保险)
  const confirmResult = await cdpEval(ws, `(() => {
    const btns = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
    const confirmBtn = btns.find(b => (b.innerText||'').trim().replace(/\\s/g, '') === '确定');
    if (!confirmBtn) return 'not found';
    // 点 button
    confirmBtn.click();
    // 也点 span
    const span = confirmBtn.querySelector('span');
    if (span) span.click();
    return 'clicked';
  })()`);
  console.log(`  📤 确 定: ${confirmResult}`);
  await sleep(1000);

  // 4. 用 CDP 真实鼠标点击(双保险)
  const coords = await cdpEval(ws, `(() => {
    const btns = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
    const confirmBtn = btns.find(b => (b.innerText||'').trim().replace(/\\s/g, '') === '确定');
    if (!confirmBtn) return null;
    const rect = confirmBtn.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(rect.left + rect.width/2), y: Math.round(rect.top + rect.height/2) });
  })()`);
  if (coords) {
    const { x, y } = JSON.parse(coords);
    await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(200);
    await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(100);
    await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    console.log(`  📤 CDP鼠标点击: (${x}, ${y})`);
  }

  // 5. 等后台生成(最多 40 秒)
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    const knowResult = await cdpEval(ws, `(() => {
      const btn = [...document.querySelectorAll('button')].find(b => {
        const t = (b.innerText || '').trim();
        return t.includes('我知道了') || t.includes('300S');
      });
      if (btn && btn.offsetParent !== null) { btn.click(); return 'clicked'; }
      return 'not found';
    })()`);
    if (knowResult === 'clicked') {
      console.log(`  📤 我知道了: 已关闭`);
      break;
    }
  }
  
  // 不管弹窗关没关,等 3 秒去下载中心
  await sleep(3000);
}

/** 去下载中心,等新任务出现再下载 */
async function downloadFromCenter(ws) {
  // 去下载中心
  await cdpEval(ws, `location.href = "${DOWNLOAD_CENTER_URL}"`);
  await sleep(3000);

  // 先关掉所有"我知道了"通知(通知太多会挡住 AG-Grid 的下载按钮)
  for (let i = 0; i < 5; i++) {
    const n = await cdpEval(ws, `(() => {
      const btns = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
      let count = 0;
      for (const b of btns) { if ((b.innerText||'').includes('我知道了')) { b.click(); count++; } }
      return count;
    })()`);
    if (n === 0) break;
    await sleep(500);
  }

  // 点"查询"让 AG-Grid 加载数据
  await cdpEval(ws, `(() => { const btn = [...document.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '查询'); if (btn) btn.click(); return 'ok'; })()`);
  await sleep(5000);

  const beforeMtime = Date.now();

  // 轮询等 AG-Grid 行加载 + 找下载按钮
  let result = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    // 每轮先关通知
    await cdpEval(ws, `(() => { [...document.querySelectorAll('button')].forEach(b => { if ((b.innerText||'').includes('我知道了')) b.click(); }); return 'ok'; })()`);

    result = await cdpEval(ws, `(() => {
      // 找所有"下载"按钮(文字匹配)
      const btns = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
      const dlBtns = btns.filter(b => (b.innerText || '').trim() === '下载');
      if (dlBtns.length > 0) {
        // 点第一个下载按钮(最新的任务在第一行)
        dlBtns[0].click();
        return 'ok';
      }
      return 'no download btn';
    })()`);
    
    if (result === 'ok') {
      console.log(`  ✅ 下载中心: 找到下载按钮并点击`);
      break;
    }
    
    // 每 3 次刷新一下
    if (attempt > 0 && attempt % 3 === 0) {
      await cdpEval(ws, 'location.reload()');
      await sleep(4000);
      // 刷新后再关通知+查询
      await cdpEval(ws, `(() => { [...document.querySelectorAll('button')].forEach(b => { if ((b.innerText||'').includes('我知道了')) b.click(); }); return 'ok'; })()`);
      await sleep(500);
      await cdpEval(ws, `(() => { const btn = [...document.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '查询'); if (btn) btn.click(); return 'ok'; })()`);
      await sleep(5000);
    }
    
    await sleep(1500);
  }

  if (result !== 'ok') {
    console.log(`  ⚠ 下载中心: 未找到下载按钮`);
  }

  return beforeMtime;
}

/** 等待新的 xlsx 下载完成（检测 Downloads 目录中新出现的 .xlsx 文件） */
async function waitForNewXlsx(beforeMtime, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await sleep(2000);
    const files = readdirSync(DOWNLOAD_DIR).filter(f =>
      f.endsWith('.xlsx') && !f.endsWith('.crdownload')
    );
    for (const f of files) {
      const fullPath = path.join(DOWNLOAD_DIR, f);
      const stat = statSync(fullPath);
      if (stat.mtimeMs > beforeMtime && stat.size > 5000) {
        // 等文件大小稳定（下载完成）
        let lastSize = 0;
        for (let i = 0; i < 10; i++) {
          const size = statSync(fullPath).size;
          if (size === lastSize && size > 5000) return fullPath;
          lastSize = size;
          await sleep(1000);
        }
        return fullPath;
      }
    }
  }
  return null;
}

/** 用 Python openpyxl 读取 xlsx 原始行,找到"店铺名称"表头行,返回 2D 数组 */
function parseXlsxRaw(xlsxPath) {
  const script = [
    'import openpyxl, json, sys',
    'wb = openpyxl.load_workbook(sys.argv[1])',
    'ws = wb.active',
    'rows = list(ws.iter_rows(values_only=True))',
    'header_idx = 0',
    'for i, row in enumerate(rows):',
    '    if any(c is not None and "店铺名称" in str(c) for c in row):',
    '        header_idx = i',
    '        break',
    'result = []',
    'for row in rows[header_idx:]:',
    '    result.append([str(c) if c is not None else "" for c in row])',
    'print(json.dumps(result, ensure_ascii=False))',
  ].join('\n');
  const result = execFileSync('python3', ['-c', script, xlsxPath], { encoding: 'utf8', timeout: 30000 });
  return JSON.parse(result.trim());
}

/** 将解析后的记录入库（upsertShop + upsertShopDailyProfit） */
function insertRecords(records) {
  let count = 0;
  for (const record of records) {
    const shop = upsertShop(record.shopName);
    if (!shop || !shop.shop_id) continue;
    upsertShopDailyProfit({
      shopId: shop.shop_id,
      date: record.date,
      salesAmount: record.salesAmount,
      promoSpend: record.promoSpend,
      platformFee: record.platformFee,
      laborFee: record.laborFee,
      netProfit: record.netProfit,
      netProfitRate: record.netProfitRate,
      promoFeeRatio: record.promoFeeRatio,
      roi: record.roi,
      metrics: record.metrics,
      rawRow: record.rawRow,
    });
    count++;
  }
  return count;
}

// ============ 主流程 ============

async function main() {
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
  if (!hjyTab) { console.error('❌ 没找到 hjy.huice.com 标签页'); process.exit(1); }

  const ws = new WebSocket(hjyTab.webSocketDebuggerUrl);
  await new Promise((r, rej) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', rej, { once: true });
    setTimeout(rej, 5000);
  });
  console.log(`✅ CDP 已连接`);

  const allRecords = [];
  const failedDates = [];

  for (let i = 0; i < dateList.length; i++) {
    const targetDate = dateList[i];
    console.log(`\n📅 [${i + 1}/${dateList.length}] 采集 ${targetDate}...`);

    try {
      // 1. 导航到多维利润分析页
      await cdpEval(ws, `location.href = "${TARGET_URL}"`);
      await sleep(5000);
      await closePopups(ws);

      // 2. 切换到"更多店铺展示"Tab
      await switchToShopTab(ws);

      // 3. 切日期（失败重试 3 次）
      let dateOk = false;
      for (let retry = 0; retry < 3; retry++) {
        if (retry > 0) {
          console.log(`  🔄 日期切换重试 ${retry + 1}/3 (重载页面)`);
          await cdpEval(ws, `location.href = "${TARGET_URL}"`);
          await sleep(5000);
          await closePopups(ws);
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
        failedDates.push(targetDate);
        continue;
      }

      // 4. 选所有拼多多店铺(只有第一次需要,后续切日期+查询就行)
      if (i === 0) {
        await selectAllPddShops(ws);
      }

      // 5. 点查询
      await clickQuery(ws);

      // 6. 点导出 -> 处理弹窗
      await clickExport(ws);

      // 7. 去下载中心下载 xlsx
      const beforeMtime = await downloadFromCenter(ws);

      // 8. 等下载完成
      const xlsxPath = await waitForNewXlsx(beforeMtime, 60000);
      if (!xlsxPath) {
        console.log(`  ⚠️ 下载超时,跳过`);
        failedDates.push(targetDate);
        continue;
      }
      console.log(`  📄 下载完成: ${path.basename(xlsxPath)}`);

      // 9. 解析 xlsx
      const rawRows = parseXlsxRaw(xlsxPath);

      // 9.1 验证 xlsx 里的时间范围是否跟目标日期一致
      const titleStr = String(rawRows[0]?.[0] || '');
      const xlsxDateMatch = titleStr.match(/时间范围[：:]\s*(\d{4}-\d{2}-\d{2})/);
      const xlsxDate = xlsxDateMatch ? xlsxDateMatch[1] : '';
      if (xlsxDate && xlsxDate !== targetDate) {
        console.log(`  ⚠️ xlsx 时间范围是 ${xlsxDate}, 不是 ${targetDate}, 日期切换失败,跳过`);
        failedDates.push(targetDate);
        continue;
      }

      const records = parseShopExportRows(rawRows, targetDate);
      const profitCount = records.filter(r => r.netProfit != null).length;
      console.log(`  ✅ ${records.length} 家店铺 (netProfit 有值: ${profitCount})`);

      // 10. 归档 xlsx
      const archivePath = path.join(OUTPUT_DIR, `${targetDate.replace(/-/g, '')}.xlsx`);
      renameSync(xlsxPath, archivePath);

      // 11. 保存 JSON 快照
      allRecords.push(...records);
      writeFileSync(
        path.join(OUTPUT_DIR, `${targetDate.replace(/-/g, '')}.json`),
        JSON.stringify({ date: targetDate, records }, null, 2)
      );

      // 12. 入库（upsertShop + upsertShopDailyProfit）
      if (records.length > 0) {
        try {
          const inserted = insertRecords(records);
          console.log(`  📦 SQLite 入库 ${inserted} 条 -> ${getDbPath()}`);
        } catch (e) {
          console.log(`  ⚠️ SQLite 入库失败: ${e.message}`);
        }
      }

    } catch (e) {
      console.log(`  ❌ 采集失败: ${e.message}`);
      failedDates.push(targetDate);
    }
  }

  ws.close();

  // 汇总落盘
  const summaryFile = path.join(OUTPUT_DIR, 'huice-shop-latest.json');
  writeFileSync(summaryFile, JSON.stringify(allRecords, null, 2));
  console.log(`\n💾 数据落盘: ${summaryFile} (${allRecords.length} 条)`);
  console.log(`✅ 回采完成`);

  // 失败日期汇总
  if (failedDates.length > 0) {
    const failLog = path.join(OUTPUT_DIR, 'failed-dates.json');
    writeFileSync(failLog, JSON.stringify({ dates: failedDates, ts: new Date().toISOString() }, null, 2));
    console.log(`⚠️ ${failedDates.length} 天采集失败,已记录到 ${failLog}`);
    console.log(`   失败日期: ${failedDates.join(', ')}`);
    console.log(`   补采命令: node tools/huice-shop-export-cdp.mjs --dates ${failedDates.join(',')}`);
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
