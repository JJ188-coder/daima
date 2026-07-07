#!/usr/bin/env node
/** probe-grid.mjs — dump AG-Grid pinned column 结构 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../lib/config.mjs';

const config = loadConfig();
const log = (...a) => console.log('[grid-probe]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const lock = resolve(config.profileDir, 'SingletonLock');
  if (existsSync(lock)) { try { const p=parseInt((readFileSync(lock,'utf8').match(/(\d+)$/)||[])[1]||'0',10); if(p){try{process.kill(p,0);}catch{unlinkSync(lock);}}}catch{} }

  const context = await chromium.launchPersistentContext(config.profileDir, {
    executablePath: config.chromePath, headless: true, viewport: { width: 1600, height: 1000 },
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const page = context.pages()[0] || (await context.newPage());

  try {
    await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    await closePopups(page);

    // 选店铺"拼【周贝瑞" + 查询
    await page.evaluate(() => document.querySelector('.select-tags-box')?.click());
    await sleep(1500);
    await page.evaluate(() => {
      const popover = document.querySelector('.dc-shop');
      if (popover) {
        const items = popover.querySelectorAll('.level2-item');
        for (const item of items) {
          const text = item.querySelector('.text-ellipsis-content')?.textContent.trim() || '';
          if (text === '拼【周贝瑞') { item.click(); return; }
        }
      }
    });
    await sleep(800);
    await page.mouse.click(800, 500);
    await sleep(500);
    await page.evaluate(() => { document.querySelectorAll('button').forEach(b => { if(['查询','查 询'].includes(b.textContent.trim())) b.click(); }); });
    await sleep(10000);

    // dump AG-Grid 完整容器结构
    const gridStructure = await page.evaluate(() => {
      const grid = document.querySelector('.v-ag-grid, .ag-root');
      if (!grid) return { error: 'no grid' };

      // 列出所有子容器
      const containers = {};
      const containerSelectors = [
        '.ag-header-container', '.ag-header', '.ag-pinned-left-header', '.ag-pinned-right-header',
        '.ag-body-viewport', '.ag-body-container', '.ag-pinned-left-cols-container',
        '.ag-pinned-right-cols-container', '.ag-full-width-container',
        '.ag-header-row', '.ag-row',
      ];
      for (const sel of containerSelectors) {
        const els = grid.querySelectorAll(sel);
        if (els.length > 0) {
          containers[sel] = {
            count: els.length,
            samples: Array.from(els).slice(0, 3).map(el => ({
              class: el.className,
              text: el.textContent.trim().slice(0, 100),
              childCount: el.children.length,
            })),
          };
        }
      }

      // 专门看 pinned left
      const pinnedLeft = grid.querySelector('.ag-pinned-left-cols-container');
      const pinnedLeftData = pinnedLeft ? {
        exists: true,
        rows: Array.from(pinnedLeft.querySelectorAll('.ag-row')).map(row => ({
          cells: Array.from(row.querySelectorAll('.ag-cell')).map(c => c.textContent.trim()),
        })),
      } : { exists: false };

      // 主 body rows
      const bodyRows = Array.from(grid.querySelectorAll('.ag-body-viewport .ag-row, .ag-body-container .ag-row')).map(row => ({
        cells: Array.from(row.querySelectorAll('.ag-cell')).map(c => c.textContent.trim()),
      }));

      return {
        gridClass: grid.className,
        containers,
        pinnedLeft: pinnedLeftData,
        bodyRowCount: bodyRows.length,
        bodyRows: bodyRows.slice(0, 5),
      };
    });

    log('Grid class:', gridStructure.gridClass);
    log('\n容器:');
    for (const [sel, info] of Object.entries(gridStructure.containers || {})) {
      log(`  ${sel}: ${info.count}个`);
    }
    log('\npinned-left 存在:', gridStructure.pinnedLeft?.exists);
    if (gridStructure.pinnedLeft?.exists) {
      log('pinned-left 行:');
      gridStructure.pinnedLeft.rows.slice(0, 10).forEach((r, i) => log(`  [${i}] ${r.cells.join(' | ')}`));
    }
    log('\nbody 行(前5):');
    gridStructure.bodyRows.forEach((r, i) => log(`  [${i}] ${r.cells.join(' | ')}`));

    writeFileSync(resolve(config.outputDir, 'grid-structure.json'), JSON.stringify(gridStructure, null, 2));
  } catch (err) {
    log('❌', err.message);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}
async function closePopups(page) {
  await page.evaluate(() => { document.querySelectorAll('button, .el-button').forEach(el => { const t=el.textContent.trim(); if(['我知道了','300S后关闭','确定','关闭'].includes(t)&&el.offsetParent!==null) el.click(); }); });
  await sleep(1000);
}
main().catch(e => { console.error('[grid-probe] Fatal:', e); process.exit(1); });
