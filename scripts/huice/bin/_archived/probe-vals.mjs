#!/usr/bin/env node
/** probe-vals.mjs — dump 每行的完整 HTML 找数值在哪 */
import { chromium } from 'playwright';
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../lib/config.mjs';

const config = loadConfig();
const log = (...a) => console.log('[probe-vals]', ...a);
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

    // 选店铺+查询
    await page.evaluate(() => document.querySelector('.select-tags-box')?.click());
    await sleep(1500);
    await page.evaluate(() => { const p=document.querySelector('.dc-shop'); if(p){p.querySelectorAll('.level2-item').forEach(i=>{if(i.querySelector('.text-ellipsis-content')?.textContent.trim()==='拼【周贝瑞') i.click();});} });
    await sleep(800);
    await page.mouse.click(800, 500);
    await sleep(500);
    await page.evaluate(() => { document.querySelectorAll('button').forEach(b=>{if(['查询','查 询'].includes(b.textContent.trim())) b.click();}); });
    await sleep(12000);

    // dump 第一行("一、销售收入")的完整结构 + 它在 body 的对应行
    const rowDump = await page.evaluate(() => {
      const grid = document.querySelector('.v-ag-grid, .ag-root');
      if (!grid) return { error: 'no grid' };

      // ===== 全容器扫描:列出 grid 下所有容器及其行数 =====
      const allContainers = [];
      grid.querySelectorAll('*').forEach(el => {
        if (el.className && typeof el.className === 'string' && el.className.includes('container')) {
          const rows = el.querySelectorAll(':scope > .ag-row');
          const roleRows = el.querySelectorAll(':scope > [role="row"]');
          const total = rows.length + roleRows.length;
          if (total > 0) {
            const firstRow = rows[0] || roleRows[0];
            allContainers.push({
              class: el.className.slice(0, 80),
              tag: el.tagName,
              rowCount: total,
              firstRowText: firstRow?.textContent?.trim().slice(0, 100),
              firstRowNumbers: (firstRow?.textContent?.match(/-?\d[\d,.]*%?/g) || []).slice(0, 6),
            });
          }
        }
      });

      // ===== 第一行的所有 col-id =====
      const pinnedRows = grid.querySelectorAll('.ag-pinned-left-cols-container .ag-row');
      const allPinnedContainers = grid.querySelectorAll('.ag-pinned-left-cols-container, .ag-pinned-right-cols-container, .ag-center-cols-container, .ag-body-container');

      const containerDetails = {};
      for (const c of allPinnedContainers) {
        const rows = c.querySelectorAll('.ag-row');
        containerDetails[c.className.split(' ')[0]] = {
          rowCount: rows.length,
          row0Cells: rows[0] ? Array.from(rows[0].querySelectorAll('.ag-cell')).map(cell => ({
            text: cell.textContent.trim(),
            colId: cell.getAttribute('col-id'),
          })) : [],
          row1Cells: rows[1] ? Array.from(rows[1].querySelectorAll('.ag-cell')).map(cell => ({
            text: cell.textContent.trim(),
            colId: cell.getAttribute('col-id'),
          })) : [],
        };
      }

      const result = {
        allContainers,
        containerDetails,
        firstNumber: (grid.textContent.match(/-?\d[\d,.]*%?/g) || []).slice(0, 20),
      };

      return result;
    });

    log('=== 所有含 ag-row 的容器 ===');
    rowDump.allContainers.forEach(c => log(`  ${c.tag}.${c.class.slice(0,40)} | ${c.rowCount}行 | 首行: "${c.firstRowText}" | 数字: ${c.firstRowNumbers.join(',')}`));

    log('\n=== 关键容器详情 ===');
    for (const [cls, detail] of Object.entries(rowDump.containerDetails)) {
      log(`\n[${cls}] ${detail.rowCount}行`);
      log(`  row0 cells:`, JSON.stringify(detail.row0Cells));
      log(`  row1 cells:`, JSON.stringify(detail.row1Cells));
    }

    log('\ngrid 数字:', rowDump.firstNumber.slice(0, 10));
    writeFileSync(resolve(config.outputDir, 'row-dump.json'), JSON.stringify(rowDump, null, 2));
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
main().catch(e => { console.error('[probe-vals] Fatal:', e); process.exit(1); });
