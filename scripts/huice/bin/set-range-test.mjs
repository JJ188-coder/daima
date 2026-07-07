#!/usr/bin/env node
/**
 * set-range-test.mjs — 验证多维度页日期范围设置
 *
 * 目标:设日期范围 [30天前 ~ 昨日],查询,确认能拿到"昨日(2026-06-25)"行
 *
 * 技巧:Element UI 的 el-date-editor 是 readonly,不能 fill。
 *       正确方式:点开面板 → 输入框聚焦 → 用键盘输入或点日历。
 *       更可靠:直接改 Vue 组件的 value,然后触发 'input' 事件。
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../lib/config.mjs';

const config = loadConfig();
const log = (...a) => console.log('[set-range]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 昨日 = 今天 -1;30天前 = 今天 -30
function dateStr(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
const START = dateStr(-30);  // 30天前
const END = dateStr(-1);     // 昨日
log(`目标范围: ${START} ~ ${END} (含昨日)`);

async function main() {
  const lock = resolve(config.profileDir, 'SingletonLock');
  if (existsSync(lock)) { try { const p=parseInt((readFileSync(lock,'utf8').match(/(\d+)$/)||[])[1]||'0',10); if(p){try{process.kill(p,0);}catch{unlinkSync(lock);}}}catch{} }
  for (const d of [config.screenshotDir, config.outputDir]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

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
    log('已进入多维度页');

    // 选店铺
    await selectShop(page, '拼【周贝瑞');
    await sleep(800);

    // ========== 方法 1:用 page.fill 强写 + 触发事件 ==========
    log('\n=== 方法1: 强写 range input + dispatch input 事件 ===');
    const rangeResult = await page.evaluate(({ start, end }) => {
      // 找两个 range input(开始/结束)
      const inputs = document.querySelectorAll('.el-range-editor input.el-range-input');
      const result = { foundCount: inputs.length, before: [], after: [] };
      inputs.forEach(i => result.before.push({ placeholder: i.placeholder, value: i.value }));

      if (inputs.length >= 2) {
        // 用 Vue 的方式:改 value + dispatch input event
        // 开始日期 input(placeholder = 开始日期)
        const startInput = Array.from(inputs).find(i => i.placeholder.includes('开始')) || inputs[0];
        const endInput = Array.from(inputs).find(i => i.placeholder.includes('结束')) || inputs[1];

        // 设值并触发事件(element-ui 监听 input 事件)
        const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputSetter.call(startInput, start);
        startInput.dispatchEvent(new Event('input', { bubbles: true }));
        startInput.dispatchEvent(new Event('change', { bubbles: true }));

        nativeInputSetter.call(endInput, end);
        endInput.dispatchEvent(new Event('input', { bubbles: true }));
        endInput.dispatchEvent(new Event('change', { bubbles: true }));

        inputs.forEach(i => result.after.push({ placeholder: i.placeholder, value: i.value }));
      }
      return result;
    }, { start: START, end: END });
    log('range input:', JSON.stringify(rangeResult, null, 2));

    await sleep(500);
    // 点查询
    await page.evaluate(() => {
      document.querySelectorAll('button').forEach(b => { if(['查询','查 询'].includes(b.textContent.trim())) b.click(); });
    });
    log('已点查询,等待...');
    await sleep(10000);

    // 抓数据,看是否含 6/25
    const data1 = await dumpGridData(page);
    log(`方法1 返回 ${data1.rows.length} 行`);
    data1.rows.slice(0, 3).forEach((r, i) => log(`  [${i}] ${r.join(' | ')}`));
    if (data1.rows.length > 3) log(`  ...`);
    data1.rows.slice(-3).forEach((r, i) => log(`  [${data1.rows.length-3+i}] ${r.join(' | ')}`));

    const hasYesterday1 = data1.rows.some(r => r[0] === END);
    log(`\n✅ 是否含昨日(${END}): ${hasYesterday1}`);

    await page.screenshot({ path: resolve(config.screenshotDir, 'range-method1.png'), fullPage: true });

    // ========== 方法 2: 如果方法1没生效,点开面板手动选 ==========
    if (!hasYesterday1) {
      log('\n=== 方法2: 点开日历面板手动选日期 ===');
      // 点日期范围输入框打开面板
      await page.locator('.el-range-editor').first().click();
      await sleep(1500);

      // dump 面板结构
      const panelInfo = await page.evaluate(() => {
        const panel = document.querySelector('.el-date-range-picker:not([style*="display: none"])');
        if (!panel) return { found: false };
        return {
          found: true,
          class: panel.className,
          // 两个日历(左/右)
          calendars: Array.from(panel.querySelectorAll('.el-date-range-picker__content')).map(c => ({
            header: c.querySelector('.el-date-range-picker__header')?.textContent?.trim().slice(0, 50),
            cellCount: c.querySelectorAll('td').length,
          })),
          // 快捷选项
          shortcuts: Array.from(panel.querySelectorAll('.el-picker-panel__shortcut')).map(s => s.textContent.trim()),
        };
      });
      log('面板:', JSON.stringify(panelInfo, null, 2).slice(0, 600));

      // 试试点快捷选项(如果有"最近30天")
      const quickClicked = await page.evaluate(() => {
        const shortcuts = document.querySelectorAll('.el-picker-panel__shortcut');
        for (const s of shortcuts) {
          const t = s.textContent.trim();
          if (t.includes('30') || t.includes('最近一月') || t.includes('一个月')) { s.click(); return t; }
        }
        return null;
      });
      log('快捷点击:', quickClicked);
      await sleep(1000);

      await page.evaluate(() => {
        document.querySelectorAll('button').forEach(b => { if(['查询','查 询'].includes(b.textContent.trim())) b.click(); });
      });
      await sleep(10000);

      const data2 = await dumpGridData(page);
      log(`方法2 返回 ${data2.rows.length} 行`);
      data2.rows.slice(-3).forEach((r, i) => log(`  [${data2.rows.length-3+i}] ${r.join(' | ')}`));
      const hasYesterday2 = data2.rows.some(r => r[0] === END);
      log(`✅ 是否含昨日: ${hasYesterday2}`);

      await page.screenshot({ path: resolve(config.screenshotDir, 'range-method2.png'), fullPage: true });
    }

    // 保存结果
    writeFileSync(resolve(config.outputDir, 'range-test-result.json'), JSON.stringify({
      target: { start: START, end: END },
      method1: { rowCount: data1.rows.length, hasYesterday: hasYesterday1, rows: data1.rows },
    }, null, 2));

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

async function dumpGridData(p) {
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

main().catch(e => { console.error('[set-range] Fatal:', e); process.exit(1); });
