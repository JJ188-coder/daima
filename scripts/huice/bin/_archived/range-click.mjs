#!/usr/bin/env node
/** range-click.mjs — 用点击日历单元格的方式设日期范围 */
import { chromium } from 'playwright';
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../lib/config.mjs';

const config = loadConfig();
const log = (...a) => console.log('[click]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fmt(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
const START = fmt(new Date(Date.now() - 30*86400000));
const END = fmt(new Date(Date.now() - 1*86400000));

async function main() {
  const lock = resolve(config.profileDir, 'SingletonLock');
  if (existsSync(lock)) { try { const p=parseInt((readFileSync(lock,'utf8').match(/(\d+)$/)||[])[1]||'0',10); if(p){try{process.kill(p,0);}catch{unlinkSync(lock);}}}catch{} }
  for (const d of [config.outputDir]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

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
    await selectShop(page, '拼【周贝瑞');
    await sleep(500);

    log(`目标: ${START} ~ ${END}`);

    // 点开日期范围面板
    await page.locator('.el-range-editor').first().click();
    await sleep(1500);

    // dump 面板日历结构
    const calDump = await page.evaluate(() => {
      const panel = document.querySelector('.el-date-range-picker:not([style*="display: none"])');
      if (!panel) return { found: false };
      const contents = panel.querySelectorAll('.el-date-range-picker__content');
      const cals = [];
      contents.forEach((c, idx) => {
        const header = c.querySelector('.el-date-range-picker__header div')?.textContent?.trim();
        const tables = c.querySelectorAll('.el-date-table');
        const cells = [];
        tables.forEach(t => {
          t.querySelectorAll('td').forEach(td => {
            const text = td.textContent.trim();
            const num = td.querySelector('.el-date-table-cell span, span')?.textContent?.trim();
            cells.push({
              text,
              num,
              class: td.className,
              disabled: td.className.includes('disabled') || td.className.includes('next-month') || td.className.includes('prev-month'),
              // data 属性(element-ui 有时用 data-* 存日期)
              dataAttrs: Object.assign({}, td.dataset),
            });
          });
        });
        cals.push({ idx, header, cellCount: cells.length, cells: cells.slice(0, 42) });
      });
      return { found: true, calCount: cals.length, cals };
    });
    log('日历数:', calDump.calCount);
    if (calDump.cals) {
      calDump.cals.forEach(c => log(`  日历[${c.idx}] ${c.header} (${c.cellCount} cells)`));
    }
    writeFileSync(resolve(config.outputDir, 'calendar-dump.json'), JSON.stringify(calDump, null, 2));

    // 策略:导航到目标月份,点选起止日期
    // 先翻月份到 START 所在月(5月),需要点"上个月"按钮
    log('\n=== 翻到 5 月(START 所在月)===');
    // 左侧日历的 prev 按钮
    for (let i = 0; i < 3; i++) {
      const headerText = await page.evaluate(() => {
        const c = document.querySelectorAll('.el-date-range-picker__content')[0];
        return c?.querySelector('.el-date-range-picker__header div')?.textContent?.trim();
      });
      log(`  当前左日历: ${headerText}`);
      if (headerText && headerText.includes('5')) break;
      // 点左日历的上一月
      await page.evaluate(() => {
        const c = document.querySelectorAll('.el-date-range-picker__content')[0];
        const prevs = c.querySelectorAll('.el-icon-arrow-left, .el-picker-panel__icon-btn');
        if (prevs[0]) prevs[0].click();
      });
      await sleep(500);
    }

    // dump 当前能看到的日历
    const afterNav = await page.evaluate(() => {
      const contents = document.querySelectorAll('.el-date-range-picker__content');
      return Array.from(contents).map(c => c.querySelector('.el-date-range-picker__header div')?.textContent?.trim());
    });
    log('翻页后日历:', afterNav);

    // 点 START 单元格(在左日历找 day=27 的可用 cell)
    const startDay = parseInt(START.split('-')[2], 10);
    log(`\n点选开始日 ${START} (day=${startDay})`);
    const startClicked = await page.evaluate((day) => {
      const c = document.querySelectorAll('.el-date-range-picker__content')[0];
      if (!c) return false;
      const tds = c.querySelectorAll('td:not(.disabled):not(.next-month):not(.prev-month)');
      for (const td of tds) {
        const num = td.querySelector('span')?.textContent?.trim();
        if (parseInt(num, 10) === day) { td.click(); return true; }
      }
      // 退而求其次:文本匹配
      for (const td of tds) {
        if (td.textContent.trim() === String(day)) { td.click(); return true; }
      }
      return false;
    }, startDay);
    log('开始日点击:', startClicked);
    await sleep(1000);

    // 点 END 单元格(右日历找 day=25)
    const endDay = parseInt(END.split('-')[2], 10);
    log(`点选结束日 ${END} (day=${endDay})`);
    const endClicked = await page.evaluate((day) => {
      // END 在 6 月,可能在右日历
      const contents = document.querySelectorAll('.el-date-range-picker__content');
      for (const c of contents) {
        const tds = c.querySelectorAll('td:not(.disabled):not(.next-month):not(.prev-month)');
        for (const td of tds) {
          const num = td.querySelector('span')?.textContent?.trim();
          if (parseInt(num, 10) === day) { td.click(); return true; }
        }
      }
      return false;
    }, endDay);
    log('结束日点击:', endClicked);
    await sleep(1000);

    // 确认 input 值
    const finalInput = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.el-range-editor input.el-range-input')).map(i => ({ ph: i.placeholder, val: i.value }));
    });
    log('最终 input:', JSON.stringify(finalInput));

    // 查询
    await page.evaluate(() => { document.querySelectorAll('button').forEach(b=>{if(['查询','查 询'].includes(b.textContent.trim())) b.click();}); });
    log('已查询,等待...');
    await sleep(12000);

    const data = await dumpGrid(page);
    log(`\n返回 ${data.rows.length} 行:`);
    data.rows.forEach((r, i) => log(`  [${i}] ${r[0]} → ${r[1]}`));
    log(`\n${data.rows.length >= 20 ? '✅ 多日范围设置成功!' : '⚠ 还是默认范围,需逐日回采'}`);

  } catch (err) {
    log('❌', err.message);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

async function closePopups(p) {
  await p.evaluate(() => { document.querySelectorAll('button, .el-button').forEach(el => { const t=el.textContent.trim(); if(['我知道了','300S后关闭','确定','关闭'].includes(t)&&el.offsetParent!==null) el.click(); }); });
  await sleep(800);
}
async function selectShop(p, shop) {
  await p.evaluate(() => document.querySelector('.select-tags-box')?.click());
  await sleep(1200);
  await p.evaluate((name) => { const pp=document.querySelector('.dc-shop'); if(pp) pp.querySelectorAll('.level2-item').forEach(i=>{if(i.querySelector('.text-ellipsis-content')?.textContent.trim()===name) i.click();}); }, shop);
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

main().catch(e => { console.error('[click] Fatal:', e); process.exit(1); });
