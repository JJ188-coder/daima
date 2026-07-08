#!/usr/bin/env node
/**
 * range-fix.mjs — 找到真正能改日期范围的方法
 *
 * 之前方法1(dispatch input) 改了 value 但查询还是返回默认 7 天 → Vue 没收到。
 * 这次试三种方法:
 *   A. 找 Vue 组件实例直接改 data(改 pickOptions)
 *   B. 点"最近七天"快捷 → 看它怎么改 → 复制其行为
 *   C. 用 Playwright 的 keyboard.type 直接在 input 里打字
 */

import { chromium } from 'playwright';
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../lib/config.mjs';

const config = loadConfig();
const log = (...a) => console.log('[range-fix]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

    // 选店铺
    await selectShop(page, '拼【周贝瑞');
    await sleep(800);

    // ========== B. 点"最近七天"快捷,看 Vue 状态怎么变 ==========
    log('\n=== B. 点"最近七天"快捷,反推 Vue 数据流 ===');
    await page.locator('.el-range-editor').first().click();
    await sleep(1500);

    // 点之前 dump Vue 状态
    const beforeClick = await page.evaluate(() => {
      const app = document.querySelector('#app');
      if (!app || !app.__vue__) return null;
      // 找含 date/range 的组件
      function find(vm, depth) {
        if (depth > 10) return null;
        const data = vm.$options?._componentTag ? vm._data : (vm._data || {});
        for (const k of Object.keys(data)) {
          const v = data[k];
          if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && /\d{4}-\d{2}-\d{2}/.test(v[0])) {
            return { path: `${vm.$options?.name || vm.$options?._componentTag || 'comp'}.${k}`, value: v };
          }
        }
        for (const child of (vm.$children || [])) {
          const r = find(child, depth + 1);
          if (r) return r;
        }
        return null;
      }
      return find(app.__vue__, 0);
    });
    log('点击前 Vue 日期状态:', JSON.stringify(beforeClick));

    // 点"最近七天"
    const clicked7 = await page.evaluate(() => {
      const shortcuts = document.querySelectorAll('.el-picker-panel__shortcut');
      for (const s of shortcuts) {
        if (s.textContent.includes('七') || s.textContent.includes('7')) { s.click(); return s.textContent.trim(); }
      }
      return null;
    });
    log('点了快捷:', clicked7);
    await sleep(800);

    // 点之后 dump Vue 状态
    const afterClick = await page.evaluate(() => {
      const app = document.querySelector('#app');
      if (!app || !app.__vue__) return null;
      function find(vm, depth) {
        if (depth > 10) return null;
        const data = vm._data || {};
        for (const k of Object.keys(data)) {
          const v = data[k];
          if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && /\d{4}-\d{2}-\d{2}/.test(v[0])) {
            return { path: `${vm.$options?.name || 'comp'}.${k}`, value: v };
          }
        }
        for (const child of (vm.$children || [])) {
          const r = find(child, depth + 1);
          if (r) return r;
        }
        return null;
      }
      return find(app.__vue__, 0);
    });
    log('点击后 Vue 日期状态:', JSON.stringify(afterClick));

    // input 框值
    const inputVals = await page.evaluate(() => {
      const inputs = document.querySelectorAll('.el-range-editor input.el-range-input');
      return Array.from(inputs).map(i => ({ placeholder: i.placeholder, value: i.value }));
    });
    log('input 值:', JSON.stringify(inputVals));

    // ========== C. 用找到的 Vue 路径直接改 data ==========
    log('\n=== C. 直接改 Vue data 设多日范围 ===');
    if (afterClick && afterClick.path) {
      log(`找到 Vue 路径: ${afterClick.path}`);
      // 改成默认起点到昨日
      const end = new Date(); end.setDate(end.getDate() - 1);
      const start = new Date(); start.setDate(start.getDate() - 30);
      const startStr = `${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}-${String(start.getDate()).padStart(2,'0')}`;
      const endStr = `${end.getFullYear()}-${String(end.getMonth()+1).padStart(2,'0')}-${String(end.getDate()).padStart(2,'0')}`;
      log(`目标: ${startStr} ~ ${endStr}`);

      // 通过 Vue 实例改值
      const setViaVue = await page.evaluate(({ path, startStr, endStr }) => {
        const app = document.querySelector('#app');
        if (!app || !app.__vue__) return { ok: false, reason: 'no vue' };
        // 重新找组件(同路径)
        const parts = path.split('.');
        const key = parts[parts.length - 1];
        function findAndSet(vm, depth) {
          if (depth > 10) return null;
          const data = vm._data || {};
          if (key in data) {
            const old = data[key];
            // 用 $set 触发响应式
            vm.$set(data, key, [startStr, endStr]);
            return { ok: true, old, new: data[key] };
          }
          for (const child of (vm.$children || [])) {
            const r = findAndSet(child, depth + 1);
            if (r) return r;
          }
          return null;
        }
        return findAndSet(app.__vue__, 0);
      }, { path: afterClick.path, startStr, endStr });
      log('Vue $set 结果:', JSON.stringify(setViaVue));
      await sleep(500);

      // 点查询
      await page.evaluate(() => { document.querySelectorAll('button').forEach(b=>{if(['查询','查 询'].includes(b.textContent.trim())) b.click();}); });
      log('已查询,等待...');
      await sleep(10000);

      const data = await dumpGrid(page);
      log(`返回 ${data.rows.length} 行:`);
      data.rows.forEach((r, i) => log(`  [${i}] ${r[0]} → ${r[1]}`));
      const dateCount = data.rows.length;
      log(`\n${dateCount >= 20 ? '✅ 范围设置成功!' : '❌ 还是默认范围'}`);

      writeFileSync(resolve(config.outputDir, 'range-vue-result.json'), JSON.stringify({
        vuePath: afterClick.path,
        target: { startStr: startStr, endStr: endStr },
        rowCount: data.rows.length,
        rows: data.rows,
      }, null, 2));
    } else {
      log('❌ 没找到 Vue 日期状态,无法用方法 C');
    }

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

main().catch(e => { console.error('[range-fix] Fatal:', e); process.exit(1); });
