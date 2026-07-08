#!/usr/bin/env node
/**
 * explore-three.mjs — 一次启动浏览器,探索三个关键页面
 *
 * 1. 日期选择器(利润页内):能否程序化选择历史日期
 * 2. 商品排名页面:URL/DOM/字段
 * 3. 多维度每日利润分析:URL/DOM/字段
 *
 * 输出: output/huice-explore/explore-three.json + 截图
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../lib/config.mjs';

const config = loadConfig();
const log = (...a) => console.log('[explore3]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shotDir = config.screenshotDir;
if (!existsSync(shotDir)) mkdirSync(shotDir, { recursive: true });

async function main() {
  // 清孤儿锁
  const lock = resolve(config.profileDir, 'SingletonLock');
  if (existsSync(lock)) {
    try { const p=parseInt((readFileSync(lock,'utf8').match(/(\d+)$/)||[])[1]||'0',10); if(p){try{process.kill(p,0);}catch{unlinkSync(lock);}}}catch{}
  }

  const context = await chromium.launchPersistentContext(config.profileDir, {
    executablePath: config.chromePath,
    headless: true,
    viewport: { width: 1600, height: 1000 },
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const page = context.pages()[0] || (await context.newPage());

  const result = { startedAt: new Date().toISOString() };

  try {
    // ===== 1. 日期选择器探索 =====
    log('\n' + '='.repeat(60));
    log('=== 1. 日期选择器探索 ===');
    result.datePicker = await exploreDatePicker(page);

    // ===== 2. 商品排名 =====
    log('\n' + '='.repeat(60));
    log('=== 2. 商品排名 ===');
    result.productRank = await exploreProductRank(page);

    // ===== 3. 多维度每日利润分析 =====
    log('\n' + '='.repeat(60));
    log('=== 3. 多维度每日利润分析 ===');
    result.multiDimension = await exploreMultiDimension(page);

    result.endedAt = new Date().toISOString();
    writeFileSync(resolve(config.outputDir, 'explore-three.json'), JSON.stringify(result, null, 2));
    log('\n📄 explore-three.json 已保存');

  } catch (err) {
    log('❌', err.message);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

/** 关弹窗 */
async function closePopups(page) {
  await page.evaluate(() => {
    document.querySelectorAll('button, .el-button').forEach(el => {
      const t = el.textContent.trim();
      if (['我知道了','300S后关闭','确定','关闭'].includes(t) && el.offsetParent !== null) el.click();
    });
  });
  await sleep(800);
}

/** 选店铺+查询 */
async function selectShopAndQuery(page, shopName) {
  await page.evaluate(() => document.querySelector('.select-tags-box')?.click());
  await sleep(1200);
  await page.evaluate((name) => {
    const p = document.querySelector('.dc-shop');
    if (p) p.querySelectorAll('.level2-item').forEach(i => {
      if (i.querySelector('.text-ellipsis-content')?.textContent.trim() === name) i.click();
    });
  }, shopName);
  await sleep(700);
  await page.mouse.click(800, 500);
  await sleep(400);
  await page.evaluate(() => {
    document.querySelectorAll('button').forEach(b => {
      if (['查询','查 询'].includes(b.textContent.trim())) b.click();
    });
  });
}

/** 探测 AG-Grid(复用) */
async function probeGrid(page) {
  return page.evaluate(() => {
    const grid = document.querySelector('.v-ag-grid, .ag-root');
    if (!grid) return { found: false };
    const headers = Array.from(grid.querySelectorAll('.ag-header-container .ag-header-cell-text'))
      .map(e => e.textContent.trim()).filter(Boolean);
    const pinnedHeader = grid.querySelector('.ag-pinned-left-header .ag-header-cell-text')?.textContent.trim();
    const allHeaders = pinnedHeader ? [pinnedHeader, ...headers] : headers;

    const pinnedRows = Array.from(grid.querySelectorAll('.ag-pinned-left-cols-container .ag-row'));
    const centerRows = Array.from(grid.querySelectorAll('.ag-center-cols-container .ag-row'));
    const rows = [];
    const maxLen = Math.max(pinnedRows.length, centerRows.length);
    for (let i = 0; i < maxLen; i++) {
      const name = pinnedRows[i]?.querySelector('.ag-cell')?.textContent.trim() || '';
      const vals = centerRows[i] ? Array.from(centerRows[i].querySelectorAll('.ag-cell')).map(c => c.textContent.trim()) : [];
      if (name || vals.length) rows.push([name, ...vals]);
    }
    return { found: true, headers: allHeaders, rowCount: rows.length, sampleRows: rows.slice(0, 10) };
  });
}

// ============================================================
// 1. 日期选择器探索
// ============================================================
async function exploreDatePicker(page) {
  await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);
  await closePopups(page);

  // dump 日期选择器结构
  const dpInfo = await page.evaluate(() => {
    const dp = document.querySelector('.el-date-editor, .ba-m-datePickerContainer, [class*="datePicker"]');
    if (!dp) return { found: false };
    return {
      found: true,
      html: dp.outerHTML.slice(0, 2000),
      // 输入框
      inputs: Array.from(dp.querySelectorAll('input')).map(i => ({
        type: i.type, readonly: i.readOnly, placeholder: i.placeholder, value: i.value, name: i.name,
      })),
      // 快捷单选(昨日/前日)
      radios: Array.from(dp.querySelectorAll('.el-radio-button__inner')).map(r => r.textContent.trim()),
      // 是否有日期范围(双输入)
      isRange: !!dp.querySelector('.el-range-editor, [class*="range"]'),
    };
  });
  log('日期选择器:', JSON.stringify(dpInfo, null, 2).slice(0, 1500));

  // 尝试点开日期面板看结构
  await page.evaluate(() => document.querySelector('.el-date-editor input, .ba-m-datePickerContainer input')?.click());
  await sleep(1500);
  await page.screenshot({ path: resolve(shotDir, 'datepicker-panel.png') });

  const panelInfo = await page.evaluate(() => {
    const panel = document.querySelector('.el-date-picker, .el-picker-panel, [class*="date-picker"], [class*="picker-panel"]');
    if (!panel) return { found: false, visiblePanels: [] };
    // 列出日期单元格
    const cells = Array.from(panel.querySelectorAll('.el-date-table td, .available, .el-date-table__row td, [class*="cell"]'));
    return {
      found: true,
      panelClass: panel.className,
      cellCount: cells.length,
      sampleCells: cells.slice(0, 40).map(c => ({
        text: c.textContent.trim().slice(0, 5),
        class: c.className,
        disabled: c.className.includes('disabled'),
      })),
      // 月份导航
      navButtons: Array.from(panel.querySelectorAll('.el-picker-panel__icon-btn, [class*="prev"], [class*="next"], button')).map(b => b.textContent.trim()).filter(Boolean).slice(0, 10),
    };
  });
  log('日期面板 cell 数:', panelInfo.cellCount);
  log('示例 cell:', JSON.stringify(panelInfo.sampleCells?.slice(0, 10)));

  // 尝试选 7 天前的日期
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() - 7);
  const targetDay = targetDate.getDate();
  log(`\n尝试选 7 天前: ${targetDate.toISOString().slice(0,10)} (day=${targetDay})`);

  const picked = await page.evaluate((day) => {
    const cells = document.querySelectorAll('.el-date-table td:not(.disabled)');
    for (const cell of cells) {
      const t = cell.textContent.trim();
      // 匹配数字(排除"XX周"等)
      if (new RegExp(`^${day}$`).test(t) || cell.querySelector('.el-date-table-cell span')?.textContent.trim() === String(day)) {
        cell.click();
        return { ok: true, text: t };
      }
    }
    return { ok: false };
  }, targetDay);
  log('选 7 天前结果:', picked);
  await sleep(800);

  // 看选中后的输入框值
  const afterPick = await page.evaluate(() => {
    const input = document.querySelector('.el-date-editor input, .ba-m-datePickerContainer input');
    return input ? input.value : '(无输入框)';
  });
  log('选中后输入框值:', afterPick);

  // 重新选店铺+查询,确认日期生效
  await selectShopAndQuery(page, '拼【周贝瑞');
  await sleep(8000);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const gridAfterDatePick = await probeGrid(page);
  log('选7天前查询后 grid:', gridAfterDatePick.found ? `${gridAfterDatePick.rowCount}行` : '无');
  if (gridAfterDatePick.sampleRows?.[0]) log('  首行:', gridAfterDatePick.sampleRows[0].join(' | '));

  await page.screenshot({ path: resolve(shotDir, 'datepicker-7days-ago.png'), fullPage: true });

  return { dpInfo, panelInfo, picked, afterPick, gridAfterDatePick };
}

// ============================================================
// 2. 商品排名
// ============================================================
async function exploreProductRank(page) {
  // 先回首页找"商品排名"入口
  await page.goto('https://hjy.huice.com/#/index', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  await closePopups(page);

  // 尝试点"商品排名"卡片
  log('点击首页"商品排名"卡片...');
  let clicked = await page.evaluate(() => {
    const els = document.querySelectorAll('div, span, a');
    for (const el of els) {
      if (el.textContent.trim() === '商品排名' && el.offsetParent !== null) {
        const style = window.getComputedStyle(el);
        if (style.cursor === 'pointer' || el.onclick) { el.click(); return true; }
      }
    }
    return false;
  });
  log('点击首页卡片结果:', clicked);
  await sleep(3000);

  // 如果没点动,尝试已知路由
  let rankUrl = page.url();
  if (rankUrl.includes('/index') || rankUrl.endsWith('huice.com/') || rankUrl.includes('home')) {
    log('首页未跳转,尝试直接导航候选路由...');
    const candidates = [
      '/#/opertData/commoditySalesRank',
      '/#/opertData/commodityRank',
      '/#/opertData/productRank',
      '/#/opertData/CommodityAnalysis',
      '/#/operationCenter/rank',
      '/#/dataCenter/commoditySalesRank',
      '/#/opertData',
    ];
    for (const route of candidates) {
      const full = `https://hjy.huice.com${route}`;
      await page.goto(full, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await sleep(2500);
      const title = await page.title();
      const hasTable = await page.locator('.v-ag-grid, .ag-root, .el-table').count();
      log(`  ${route} → ${page.url().slice(-40)} | 标题:${title} | 表格:${hasTable>0}`);
      if (hasTable > 0 && !title.includes('404')) {
        rankUrl = page.url();
        break;
      }
    }
  }

  log('商品排名页 URL:', rankUrl);
  await page.screenshot({ path: resolve(shotDir, 'product-rank-page.png'), fullPage: true });

  // 探测该页 DOM
  const pageDom = await page.evaluate(() => {
    return {
      url: location.href,
      title: document.title,
      hasAgGrid: !!document.querySelector('.v-ag-grid, .ag-root'),
      hasElTable: !!document.querySelector('.el-table'),
      // 所有表格容器
      containers: ['v-ag-grid','ag-root','el-table','[class*="grid"]','[class*="table"]'].map(sel => ({
        sel, count: document.querySelectorAll(sel).length,
      })),
      // 筛选区
      filters: document.querySelector('.c-search, .search-area, [class*="search"], [class*="filter"]')?.textContent?.trim()?.slice(0, 500),
      // tabs
      tabs: Array.from(document.querySelectorAll('.el-tabs__item')).map(t => t.textContent.trim()),
    };
  });
  log('商品排名页 DOM:', JSON.stringify(pageDom, null, 2).slice(0, 1500));

  // 选店铺+查询,再抓 grid
  await selectShopAndQuery(page, '拼【周贝瑞');
  await sleep(8000);
  const gridData = await probeGrid(page);
  log('商品排名 grid:', gridData.found ? `${gridData.rowCount}行,表头:${gridData.headers.join(',')}` : '无');
  if (gridData.sampleRows?.[0]) {
    log('前3行:');
    gridData.sampleRows.slice(0, 3).forEach((r, i) => log(`  [${i}] ${r.join(' | ')}`));
  }

  await page.screenshot({ path: resolve(shotDir, 'product-rank-after-query.png'), fullPage: true });

  return { rankUrl, pageDom, gridData };
}

// ============================================================
// 3. 多维度每日利润分析
// ============================================================
async function exploreMultiDimension(page) {
  await page.goto('https://hjy.huice.com/#/index', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  await closePopups(page);

  // 点"多维度利润分析"卡片
  log('点击首页"多维度利润分析"卡片...');
  let clicked = await page.evaluate(() => {
    const els = document.querySelectorAll('div, span, a');
    for (const el of els) {
      const t = el.textContent.trim();
      if ((t === '多维度利润分析' || t === '多维度每日利润分析') && el.offsetParent !== null) {
        const style = window.getComputedStyle(el);
        if (style.cursor === 'pointer' || el.onclick) { el.click(); return true; }
      }
    }
    return false;
  });
  log('点击结果:', clicked);
  await sleep(3000);

  let mdUrl = page.url();
  if (mdUrl.includes('/index') || mdUrl.endsWith('huice.com/')) {
    log('首页未跳转,尝试候选路由...');
    const candidates = [
      '/#/businessAnalysisCenter/report/multiDailyProfit',
      '/#/businessAnalysisCenter/report/multiDaily',
      '/#/businessAnalysisCenter/report/multiProfit',
      '/#/businessAnalysisCenter/multiDimension',
      '/#/businessAnalysisCenter/report/dailyMulti',
      '/#/multiDailyProfit',
      '/#/businessAnalysisCenter/report/daily?type=multi',
    ];
    for (const route of candidates) {
      const full = `https://hjy.huice.com${route}`;
      await page.goto(full, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await sleep(2500);
      const title = await page.title();
      const hasTable = await page.locator('.v-ag-grid, .ag-root, .el-table').count();
      log(`  ${route} → 标题:${title} | 表格:${hasTable>0}`);
      if (hasTable > 0 && title.includes('多维')) {
        mdUrl = page.url();
        break;
      }
    }
  }

  log('多维度页 URL:', mdUrl);
  await page.screenshot({ path: resolve(shotDir, 'multi-dim-page.png'), fullPage: true });

  // dump 页面 DOM
  const pageDom = await page.evaluate(() => {
    return {
      url: location.href,
      title: document.title,
      tabs: Array.from(document.querySelectorAll('.el-tabs__item')).map(t => t.textContent.trim()),
      filters: document.querySelector('.c-search, .search-area')?.textContent?.trim()?.slice(0, 600),
      // 维度选项(多维度特有)
      dimensions: Array.from(document.querySelectorAll('.el-checkbox-button__inner, .el-radio-button__inner, [class*="dimension"], [class*="group-by"]'))
        .map(d => d.textContent.trim()).filter(Boolean).slice(0, 20),
      hasAgGrid: !!document.querySelector('.v-ag-grid, .ag-root'),
    };
  });
  log('多维度页 DOM:', JSON.stringify(pageDom, null, 2).slice(0, 1500));

  // 选店铺+查询
  await selectShopAndQuery(page, '拼【周贝瑞');
  await sleep(8000);
  const gridData = await probeGrid(page);
  log('多维度 grid:', gridData.found ? `${gridData.rowCount}行` : '无');
  if (gridData.sampleRows?.[0]) {
    log('前5行:');
    gridData.sampleRows.slice(0, 5).forEach((r, i) => log(`  [${i}] ${r.join(' | ')}`));
  }

  await page.screenshot({ path: resolve(shotDir, 'multi-dim-after-query.png'), fullPage: true });

  return { mdUrl, pageDom, gridData };
}

main().catch(e => { console.error('[explore3] Fatal:', e); process.exit(1); });
