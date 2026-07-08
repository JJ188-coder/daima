#!/usr/bin/env node
/**
 * backfill.mjs — 汇策多维度利润按天数回采 + 入库
 *
 * 流程:
 *   1. 多维度页"按时间展示"Tab
 *   2. 点单箭头翻月到 START 所在月 → 点 START 起始日 → 点 END 结束日
 *   3. 查询 → 抓 AG-Grid(每天一行)
 *   4. 写入 SQLite(daily_profit 表)
 *
 * 用法:
 *   node scripts/huice/bin/backfill.mjs                         # 默认店铺和默认天数
 *   node scripts/huice/bin/backfill.mjs --shop "拼【甜心"        # 指定店铺
 *   node scripts/huice/bin/backfill.mjs --days 60               # 指定回采天数
 *   node scripts/huice/bin/backfill.mjs --all-pdd               # 回采所有拼多多店铺
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { upsertShop, upsertDailyProfit, logFetch, listShops, getDb, MULTI_DIM_COLUMNS, getDbPath } from '../lib/db.mjs';

const config = loadConfig();
const log = (...a) => console.log('[backfill]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fmt(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { shop: '拼【周贝瑞', days: 30, allPdd: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--shop') opts.shop = args[++i];
    else if (args[i] === '--days') opts.days = parseInt(args[++i], 10);
    else if (args[i] === '--all-pdd') opts.allPdd = true;
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  // 数据库初始化
  getDb();
  log(`📦 数据库: ${getDbPath()}`);

  // 回采范围:从昨日往前 N 天(昨日数据需 8:30 后才有,取昨日前 N 天确保有数据)
  const end = new Date();
  end.setDate(end.getDate() - 1); // 昨日
  const start = new Date();
  start.setDate(start.getDate() - opts.days);
  const startStr = fmt(start);
  const endStr = fmt(end);
  log(`📅 回采范围: ${startStr} ~ ${endStr} (${opts.days} 天)`);

  const lock = resolve(config.profileDir, 'SingletonLock');
  if (existsSync(lock)) { try { const p=parseInt((readFileSync(lock,'utf8').match(/(\d+)$/)||[])[1]||'0',10); if(p){try{process.kill(p,0);}catch{unlinkSync(lock);}}}catch{} }
  for (const d of [config.screenshotDir]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

  const context = await chromium.launchPersistentContext(config.profileDir, {
    executablePath: config.chromePath, headless: true, viewport: { width: 1600, height: 1000 },
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const page = context.pages()[0] || (await context.newPage());

  try {
    await page.goto('https://hjy.huice.com/#/businessAnalysisCenter/report/trendNew', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    await closePopups(page);

    // 确认在"按时间展示"Tab(默认就是)
    const onTimeTab = await page.evaluate(() => {
      const tabs = document.querySelectorAll('.el-tabs__item');
      const first = tabs[0];
      if (first && !first.className.includes('is-active')) { first.click(); return 'switched'; }
      return first?.textContent?.trim() || 'unknown';
    });
    log(`📑 Tab 状态: ${onTimeTab}`);
    await sleep(1000);

    const shops = opts.allPdd ? await getAllShops(page) : [opts.shop];
    log(`🏪 待回采店铺 ${shops.length} 个: ${shops.length <= 5 ? shops.join(', ') : shops.slice(0,5).join(', ') + '...'}`);

    let totalRows = 0;
    for (const shop of shops) {
      log(`\n${'='.repeat(50)}`);
      log(`🏪 回采: ${shop}`);
      try {
        const rows = await backfillShop(page, shop, startStr, endStr);
        totalRows += rows.length;
        log(`  ✅ ${shop}: 入库 ${rows.length} 天`);
      } catch (e) {
        log(`  ❌ ${shop}: ${e.message}`);
      }
      await sleep(2000); // 店铺间间隔
    }

    log(`\n${'='.repeat(50)}`);
    log(`🎉 回采完成: ${shops.length} 店铺,共 ${totalRows} 天数据入库`);

  } catch (err) {
    log('❌ 致命:', err.message);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

/** 单店铺回采 */
async function backfillShop(page, shopName, startStr, endStr) {
  // 1. 选店铺
  await selectShop(page, shopName);
  await sleep(500);

  // 2. 设置日期范围
  await setDateRange(page, startStr, endStr);
  await sleep(800);

  // 3. 查询
  await page.evaluate(() => { document.querySelectorAll('button').forEach(b=>{if(['查询','查 询'].includes(b.textContent.trim())) b.click();}); });
  await sleep(10000);
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

  // 4. 抓 AG-Grid 数据
  const gridData = await dumpGrid(page);
  log(`  返回 ${gridData.rows.length} 行`);

  if (gridData.rows.length === 0) {
    log(`  ⚠ 无数据,可能店铺未选成功或日期范围问题`);
    await page.screenshot({ path: resolve(config.screenshotDir, `backfill-${Date.now()}-empty.png`) });
    return [];
  }

  // 5. 入库
  const shopId = upsertShop(shopName);
  let inserted = 0;
  for (const row of gridData.rows) {
    // 第一列是日期(YYYY-MM-DD)
    const date = row[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      log(`  跳过非日期行: ${row[0]}`);
      continue;
    }
    // 其余列对应 MULTI_DIM_COLUMNS[1..]
    const metrics = {};
    for (let i = 1; i < MULTI_DIM_COLUMNS.length; i++) {
      const colName = MULTI_DIM_COLUMNS[i];
      const val = row[i] || '';
      metrics[colName] = parseNum(val);
    }
    upsertDailyProfit(shopId, date, JSON.stringify(metrics), JSON.stringify(row));
    inserted++;
  }

  logFetch(shopId, shopName, startStr, endStr, inserted, 'success', null);
  return gridData.rows;
}

/** 设置日期范围(点单箭头翻月 + 点日期单元格) */
async function setDateRange(page, startStr, endStr) {
  // 打开面板
  await page.locator('.el-range-editor').first().click();
  await sleep(1200);

  const start = new Date(startStr);
  const end = new Date(endStr);
  const startMonth = `${start.getFullYear()} 年 ${start.getMonth()+1} 月`;
  const endMonth = `${end.getFullYear()} 年 ${end.getMonth()+1} 月`;

  // ── 翻左日历到 START 所在月(用单箭头)──
  let safety = 0;
  while (safety++ < 24) {
    const curHeader = await page.evaluate(() =>
      document.querySelectorAll('.el-date-range-picker__content')[0]?.querySelector('.el-date-range-picker__header')?.textContent?.trim()
    );
    if (curHeader === startMonth) break;
    await page.evaluate(() => {
      const left = document.querySelectorAll('.el-date-range-picker__content')[0];
      const singleLeft = left.querySelector('.el-icon-arrow-left');
      if (singleLeft) (singleLeft.closest('button') || singleLeft).click();
    });
    await sleep(400);
  }

  // ── 点 START 单元格(限定在左日历,排除跨月灰格)──
  const startDay = start.getDate();
  await page.evaluate((day) => {
    const c = document.querySelectorAll('.el-date-range-picker__content')[0];
    const tds = c.querySelectorAll('td.available');
    for (const td of tds) {
      if (parseInt(td.querySelector('span')?.textContent?.trim(), 10) === day) { td.click(); return; }
    }
    // fallback: 非灰格
    const tds2 = c.querySelectorAll('td:not(.next-month):not(.prev-month)');
    for (const td of tds2) {
      if (parseInt(td.querySelector('span')?.textContent?.trim(), 10) === day) { td.click(); return; }
    }
  }, startDay);
  await sleep(1200); // element-ui 点完起始日后,面板可能自动跳月

  // ── 点 END 单元格 ──
  // 关键:END 必须在正确的月。先确认当前哪个日历显示 endMonth
  // 策略:在右日历(索引1)找,找不到再翻页
  const endDay = end.getDate();
  let endClicked = false;

  // 先看右日历是不是 endMonth
  const rightHeader = await page.evaluate(() =>
    document.querySelectorAll('.el-date-range-picker__content')[1]?.querySelector('.el-date-range-picker__header')?.textContent?.trim()
  );
  log(`  点START后 → 左:[${await page.evaluate(()=>document.querySelectorAll('.el-date-range-picker__content')[0]?.querySelector('.el-date-range-picker__header')?.textContent?.trim())}] 右:[${rightHeader}]`);

  if (rightHeader === endMonth) {
    // 直接在右日历点 END
    endClicked = await page.evaluate((day) => {
      const c = document.querySelectorAll('.el-date-range-picker__content')[1];
      const tds = c.querySelectorAll('td.available');
      for (const td of tds) {
        if (parseInt(td.querySelector('span')?.textContent?.trim(), 10) === day) { td.click(); return true; }
      }
      return false;
    }, endDay);
  }

  // 如果右日历不对,翻右日历(单右箭头)到 endMonth
  if (!endClicked) {
    let navSafety = 0;
    while (navSafety++ < 24) {
      const rh = await page.evaluate(() =>
        document.querySelectorAll('.el-date-range-picker__content')[1]?.querySelector('.el-date-range-picker__header')?.textContent?.trim()
      );
      if (rh === endMonth) break;
      // 翻右日历到下一月(单右箭头)
      await page.evaluate(() => {
        const right = document.querySelectorAll('.el-date-range-picker__content')[1];
        const singleRight = right.querySelector('.el-icon-arrow-right');
        if (singleRight) (singleRight.closest('button') || singleRight).click();
      });
      await sleep(400);
    }
    // 现在点 END
    endClicked = await page.evaluate((day) => {
      const c = document.querySelectorAll('.el-date-range-picker__content')[1];
      const tds = c.querySelectorAll('td.available');
      for (const td of tds) {
        if (parseInt(td.querySelector('span')?.textContent?.trim(), 10) === day) { td.click(); return true; }
      }
      return false;
    }, endDay);
  }

  await sleep(500);

  // 确认
  const finalInput = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.el-range-editor input.el-range-input')).map(i => i.value)
  );
  log(`  日期范围已设: ${finalInput.join(' ~ ')}`);
  if (!finalInput.includes(startStr) || !finalInput.includes(endStr)) {
    log(`  ⚠ 警告: 实际范围与目标不符!目标 ${startStr}~${endStr}`);
  }
}

async function closePopups(p) {
  await p.evaluate(() => { document.querySelectorAll('button, .el-button').forEach(el => { const t=el.textContent.trim(); if(['我知道了','300S后关闭','确定','关闭'].includes(t)&&el.offsetParent!==null) el.click(); }); });
  await sleep(800);
}
async function selectShop(p, shop) {
  await p.evaluate(() => document.querySelector('.select-tags-box')?.click());
  await sleep(1200);
  const ok = await p.evaluate((name) => {
    const pp = document.querySelector('.dc-shop');
    if (!pp) return false;
    let found = false;
    pp.querySelectorAll('.level2-item').forEach(i => {
      if (i.querySelector('.text-ellipsis-content')?.textContent.trim() === name) { i.click(); found = true; }
    });
    return found;
  }, shop);
  if (!ok) log(`  ⚠ 店铺 "${shop}" 未找到`);
  await sleep(500);
  await p.mouse.click(800, 500);
}
async function dumpGrid(p) {
  return p.evaluate(() => {
    const grid = document.querySelector('.v-ag-grid, .ag-root');
    if (!grid) return { rows: [] };
    const pinnedRows = Array.from(grid.querySelectorAll('.ag-pinned-left-cols-container .ag-row'));
    const centerRows = Array.from(grid.querySelectorAll('.ag-center-cols-container .ag-row'));
    const rows = [];
    const maxLen = Math.max(pinnedRows.length, centerRows.length);
    for (let i = 0; i < maxLen; i++) {
      const name = pinnedRows[i]?.querySelector('.ag-cell')?.textContent.trim() || '';
      const vals = centerRows[i] ? Array.from(centerRows[i].querySelectorAll('.ag-cell')).map(c => c.textContent.trim()) : [];
      if (name || vals.length) rows.push([name, ...vals]);
    }
    return { rows };
  });
}

/** 获取所有拼多多店铺(回采 --all-pdd 用) */
async function getAllShops(page) {
  await page.evaluate(() => document.querySelector('.select-tags-box')?.click());
  await sleep(1500);
  const all = await page.evaluate(() => {
    const p = document.querySelector('.dc-shop');
    if (!p) return [];
    return Array.from(p.querySelectorAll('.level2-item'))
      .map(i => i.querySelector('.text-ellipsis-content')?.textContent.trim())
      .filter(Boolean);
  });
  await page.mouse.click(800, 500);
  // 只选拼多多店铺
  return all.filter(name => name.startsWith('拼'));
}

/** 解析数字字符串 → number(支持千分位逗号、百分号、--) */
function parseNum(str) {
  if (!str || str === '--' || str === '') return null;
  const s = str.replace(/,/g, '').replace(/%$/, '');
  const n = parseFloat(s);
  return isNaN(n) ? str : n; // 非数字保留原值(如 "--")
}

main().catch(e => { console.error('[backfill] Fatal:', e); process.exit(1); });
