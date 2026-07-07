#!/usr/bin/env node
/** explore-headers.mjs — dump 多维度页 grid 表头结构 + 日期范围组件 */
import { chromium } from 'playwright';
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../lib/config.mjs';

const config = loadConfig();
const log = (...a) => console.log('[hdr]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const lock = resolve(config.profileDir, 'SingletonLock');
  if (existsSync(lock)) { try { const p=parseInt((readFileSync(lock,'utf8').match(/(\d+)$/)||[])[1]||'0',10); if(p){try{process.kill(p,0);}catch{unlinkSync(lock);}}}catch{} }
  if (!existsSync(config.outputDir)) mkdirSync(config.outputDir, { recursive: true });

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

    // 选店铺"拼【周贝瑞" + 查询
    await page.evaluate(() => document.querySelector('.select-tags-box')?.click());
    await sleep(1200);
    await page.evaluate(() => { const p=document.querySelector('.dc-shop'); if(p) p.querySelectorAll('.level2-item').forEach(i=>{if(i.querySelector('.text-ellipsis-content')?.textContent.trim()==='拼【周贝瑞') i.click();}); });
    await sleep(700);
    await page.mouse.click(800, 500);
    await sleep(400);
    await page.evaluate(() => { document.querySelectorAll('button').forEach(b=>{if(['查询','查 询'].includes(b.textContent.trim())) b.click();}); });
    await sleep(8000);

    // dump grid 完整表头
    const headerDump = await page.evaluate(() => {
      const grid = document.querySelector('.v-ag-grid, .ag-root');
      if (!grid) return { error: 'no grid' };

      const result = { gridClass: grid.className };

      // 列出所有含 header 的容器
      const headerContainers = [];
      grid.querySelectorAll('[class*="header"]').forEach(el => {
        if (el.className.includes('container') || el.className.includes('row')) {
          const cells = el.querySelectorAll('.ag-header-cell');
          if (cells.length > 0) {
            headerContainers.push({
              class: el.className.slice(0, 60),
              cellCount: cells.length,
              cellTexts: Array.from(cells).map(c => c.querySelector('.ag-header-cell-text')?.textContent.trim() || c.textContent.trim().slice(0, 30)),
            });
          }
        }
      });
      result.headerContainers = headerContainers;

      // 直接找所有 .ag-header-cell-text
      result.allHeaderTexts = Array.from(grid.querySelectorAll('.ag-header-cell-text')).map(e => e.textContent.trim());

      // 找所有 col-id(确认列定义)
      const allColIds = new Set();
      grid.querySelectorAll('[col-id]').forEach(c => allColIds.add(c.getAttribute('col-id')));
      result.colIds = Array.from(allColIds);

      // 第一行数据(确认列顺序)
      const firstRow = grid.querySelector('.ag-row');
      if (firstRow) {
        result.firstRowCells = Array.from(firstRow.querySelectorAll('.ag-cell')).map(c => ({
          text: c.textContent.trim(),
          colId: c.getAttribute('col-id'),
        }));
      }

      return result;
    });
    log('=== grid 表头 dump ===');
    log('gridClass:', headerDump.gridClass);
    log('所有 header text:', headerDump.allHeaderTexts);
    log('col-ids:', headerDump.colIds);
    log('header 容器:');
    (headerDump.headerContainers || []).forEach(c => log(`  ${c.class} (${c.cellCount}): ${c.cellTexts.join(' | ')}`));
    log('首行 cells:');
    (headerDump.firstRowCells || []).forEach(c => log(`  col=${c.colId?.slice(0,8)} → "${c.text}"`));

    writeFileSync(resolve(config.outputDir, 'multi-headers.json'), JSON.stringify(headerDump, null, 2));

    // ===== 日期范围组件 =====
    log('\n=== 日期范围组件 ===');
    const dateRangeComp = await page.evaluate(() => {
      // el-range-editor 是 element-ui 的范围选择器
      const range = document.querySelector('.el-range-editor, .el-date-editor--daterange');
      if (!range) return { found: false };
      return {
        found: true,
        class: range.className,
        html: range.outerHTML.slice(0, 1500),
        // 两个输入框
        inputs: Array.from(range.querySelectorAll('input')).map(i => ({ placeholder: i.placeholder, value: i.value })),
        // 是否有快捷面板
        hasShortcuts: !!document.querySelector('.el-picker-panel__shortcut, .el-picker-panel__sidebar'),
      };
    });
    log('日期范围:', JSON.stringify(dateRangeComp, null, 2).slice(0, 1500));

    // 尝试点开日期范围面板,看有没有快捷选项
    log('\n=== 点开日期范围面板 ===');
    await page.evaluate(() => {
      const range = document.querySelector('.el-range-editor');
      if (range) range.click();
    });
    await sleep(1500);

    const panelInfo = await page.evaluate(() => {
      const panel = document.querySelector('.el-picker-panel:not([style*="display: none"]), .el-date-range-picker');
      if (!panel) return { found: false };
      return {
        found: true,
        class: panel.className,
        // 快捷选项
        shortcuts: Array.from(panel.querySelectorAll('.el-picker-panel__shortcut, [class*="shortcut"]')).map(s => s.textContent.trim()),
        // 日期类型按钮(按日/按周/按月)
        typeButtons: Array.from(panel.querySelectorAll('.el-radio-button__inner')).map(b => b.textContent.trim()),
        // 面板文字
        text: panel.textContent.trim().slice(0, 500),
      };
    });
    log('面板:', JSON.stringify(panelInfo, null, 2).slice(0, 1200));

    await page.screenshot({ path: resolve(config.screenshotDir, 'date-range-panel.png') });

  } catch (err) {
    log('❌', err.message);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}
async function closePopups(page) {
  await page.evaluate(() => { document.querySelectorAll('button, .el-button').forEach(el => { const t=el.textContent.trim(); if(['我知道了','300S后关闭','确定','关闭'].includes(t)&&el.offsetParent!==null) el.click(); }); });
  await sleep(800);
}
main().catch(e => { console.error('[hdr] Fatal:', e); process.exit(1); });
