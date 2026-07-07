#!/usr/bin/env node
/**
 * explore-multi-deep.mjs — 深入多维度利润分析页
 *
 * 重点:
 * 1. 完整 dump 表头(每列含义)
 * 2. 设置日期范围(过去30天)后查询,拿到完整时间序列
 * 3. 探索 4 个 Tab(按时间/店铺/明细/平台)各自字段
 * 4. 找商品ID字段(匹配拼多多 goodsId)
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../lib/config.mjs';

const config = loadConfig();
const log = (...a) => console.log('[multi-deep]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shotDir = config.screenshotDir;
if (!existsSync(shotDir)) mkdirSync(shotDir, { recursive: true });

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
  const result = {};

  try {
    // 导航到多维度页
    await page.goto('https://hjy.huice.com/#/businessAnalysisCenter/report/trendNew', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    await closePopups(page);
    log('已进入多维度页:', page.url());

    // ===== 1. dump 完整筛选区 =====
    log('\n=== 1. 筛选区完整结构 ===');
    const filterFull = await page.evaluate(() => {
      const search = document.querySelector('.c-search, .search-area, [class*="search-area"]');
      if (!search) return { found: false };
      return {
        found: true,
        // 所有 input(日期范围)
        inputs: Array.from(search.querySelectorAll('input')).map(i => ({
          type: i.type, placeholder: i.placeholder, value: i.value,
          readonly: i.readOnly, class: i.className.slice(0, 50),
        })),
        // 所有 label
        labels: Array.from(search.querySelectorAll('.el-form-item__label, label')).map(l => l.textContent.trim()).filter(Boolean),
        // tabs
        tabs: Array.from(search.querySelectorAll('.el-tabs__item')).map(t => t.textContent.trim()),
        // 日期快捷
        dateRadios: Array.from(search.querySelectorAll('.el-radio-button__inner, .el-radio__label')).map(r => r.textContent.trim()).filter(Boolean),
        // 文本概览
        text: search.textContent.trim().slice(0, 1500),
      };
    });
    log('筛选区:', JSON.stringify(filterFull, null, 2).slice(0, 2500));

    // ===== 2. 看默认 Tab "按时间展示" 的表头和字段 =====
    log('\n=== 2. 默认 Tab "按时间展示" 表头 ===');
    await selectShopAndQuery(page, '拼【周贝瑞');
    await sleep(8000);

    const headers = await dumpGridHeaders(page);
    log('表头:', JSON.stringify(headers, null, 2));

    // 完整行数据(默认查询范围)
    const fullData = await dumpGridAll(page);
    log(`默认查询返回 ${fullData.rows.length} 行:`);
    fullData.rows.slice(0, 8).forEach((r, i) => log(`  [${i}] ${r.join(' | ')}`));

    await page.screenshot({ path: resolve(shotDir, 'multi-time-tab.png'), fullPage: true });

    // ===== 3. 设置日期范围为过去30天 =====
    log('\n=== 3. 尝试设置30天日期范围 ===');
    const dateSet = await setDateRange(page, 30);
    log('设日期范围:', dateSet);

    if (dateSet.ok) {
      await sleep(8000);
      const data30 = await dumpGridAll(page);
      log(`30天范围返回 ${data30.rows.length} 行:`);
      data30.rows.slice(0, 5).forEach((r, i) => log(`  [${i}] ${r.join(' | ')}`));
      data30.rows.slice(-3).forEach((r, i) => log(`  ...[${data30.rows.length-3+i}] ${r.join(' | ')}`));
      result.data30Days = data30;
      await page.screenshot({ path: resolve(shotDir, 'multi-30days.png'), fullPage: true });
    }

    // ===== 4. 探索其他 Tab =====
    log('\n=== 4. 其他 Tab 探索 ===');
    const otherTabs = ['按店铺展示', '明细表', '按平台展示'];
    result.tabs = {};
    for (const tabName of otherTabs) {
      log(`\n--- 切换到 Tab: ${tabName} ---`);
      const switched = await page.evaluate((name) => {
        const tabs = document.querySelectorAll('.el-tabs__item');
        for (const t of tabs) {
          if (t.textContent.trim() === name && t.offsetParent !== null) { t.click(); return true; }
        }
        return false;
      }, tabName);
      await sleep(3000);
      if (switched) {
        // 再查询
        await page.evaluate(() => {
          document.querySelectorAll('button').forEach(b => { if(['查询','查 询'].includes(b.textContent.trim())) b.click(); });
        });
        await sleep(6000);
        const tabHeaders = await dumpGridHeaders(page);
        const tabData = await dumpGridAll(page);
        log(`  表头(${tabHeaders.length}): ${tabHeaders.join(' | ')}`);
        log(`  行数: ${tabData.rows.length}`);
        if (tabData.rows[0]) log(`  首行: ${tabData.rows[0].join(' | ')}`);
        result.tabs[tabName] = { headers: tabHeaders, rowCount: tabData.rows.length, sampleRows: tabData.rows.slice(0, 3) };
        await page.screenshot({ path: resolve(shotDir, `multi-tab-${tabName}.png`.replace(/\//g,'_')), fullPage: true });
      } else {
        log(`  ⚠ Tab "${tabName}" 不可点`);
      }
    }

    writeFileSync(resolve(config.outputDir, 'multi-dim-deep.json'), JSON.stringify(result, null, 2));
    log('\n📄 multi-dim-deep.json 已保存');

  } catch (err) {
    log('❌', err.message);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

async function closePopups(page) {
  await page.evaluate(() => {
    document.querySelectorAll('button, .el-button').forEach(el => {
      const t = el.textContent.trim();
      if (['我知道了','300S后关闭','确定','关闭'].includes(t) && el.offsetParent !== null) el.click();
    });
  });
  await sleep(800);
}

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

async function dumpGridHeaders(page) {
  return page.evaluate(() => {
    const grid = document.querySelector('.v-ag-grid, .ag-root');
    if (!grid) return [];
    // 完整表头(包括 pinned)
    const all = [];
    // 先看 pinned-left
    const pinnedHeader = grid.querySelector('.ag-pinned-left-header .ag-header-cell-text')?.textContent.trim();
    if (pinnedHeader) all.push(pinnedHeader);
    // center header
    grid.querySelectorAll('.ag-header-container .ag-header-cell-text').forEach(e => {
      const t = e.textContent.trim();
      if (t) all.push(t);
    });
    // 如果是单容器 grid(明细表可能),用全表头
    if (all.length === 0) {
      grid.querySelectorAll('.ag-header-cell-text, .ag-header-cell .ag-cell-label-container').forEach(e => {
        const t = e.textContent.trim();
        if (t && !all.includes(t)) all.push(t);
      });
    }
    return all;
  });
}

async function dumpGridAll(page) {
  return page.evaluate(() => {
    const grid = document.querySelector('.v-ag-grid, .ag-root');
    if (!grid) return { headers: [], rows: [] };

    const pinnedRows = Array.from(grid.querySelectorAll('.ag-pinned-left-cols-container .ag-row'));
    const centerRows = Array.from(grid.querySelectorAll('.ag-center-cols-container .ag-row'));

    // 如果是普通单容器(明细表),直接取所有行
    if (pinnedRows.length === 0) {
      const rows = Array.from(grid.querySelectorAll('.ag-row')).map(row =>
        Array.from(row.querySelectorAll('.ag-cell')).map(c => c.textContent.trim())
      ).filter(r => r.length > 0);
      return { headers: [], rows };
    }

    const rows = [];
    const maxLen = Math.max(pinnedRows.length, centerRows.length);
    for (let i = 0; i < maxLen; i++) {
      const name = pinnedRows[i]?.querySelector('.ag-cell')?.textContent.trim() || '';
      const vals = centerRows[i] ? Array.from(centerRows[i].querySelectorAll('.ag-cell')).map(c => c.textContent.trim()) : [];
      if (name || vals.length) rows.push([name, ...vals]);
    }
    return { headers: [], rows };
  });
}

/** 设置日期范围为过去 N 天 */
async function setDateRange(page, days) {
  // 多维度页有日期范围选择器,找它
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startStr = formatDate(startDate);
  const endStr = formatDate(endDate);
  log(`目标范围: ${startStr} ~ ${endStr}`);

  // 找日期范围输入框
  const rangeInputFound = await page.evaluate(() => {
    const inputs = document.querySelectorAll('.el-range-editor input, [class*="range"] input, .el-date-editor--daterange input');
    if (inputs.length >= 1) { inputs[0].click(); return true; }
    // 也可能是单日期
    const dp = document.querySelector('.ba-m-datePickerContainer input, .el-date-editor--date input');
    if (dp) { dp.click(); return true; }
    return false;
  });

  if (!rangeInputFound) return { ok: false, reason: 'no date input' };
  await sleep(1500);

  // 直接用 JS 设值并触发 input 事件(Vue 双向绑定)
  // 找到 Vue 组件实例,改它的 dateRange
  const setViaVue = await page.evaluate(({ startStr, endStr }) => {
    // 方案 A: 找 Vue 根实例,直接改 data
    const app = document.querySelector('#app');
    if (app && app.__vue__) {
      // 递归找含 dateRange/date 的组件
      function findDateComp(vm, depth) {
        if (depth > 8) return null;
        if (vm._data) {
          for (const k of Object.keys(vm._data)) {
            if (/date|time|range/i.test(k) && vm._data[k] !== null) {
              return { vm, key: k, value: vm._data[k] };
            }
          }
        }
        for (const child of (vm.$children || [])) {
          const r = findDateComp(child, depth + 1);
          if (r) return r;
        }
        return null;
      }
      return findDateComp(app.__vue__, 0);
    }
    return null;
  }, { startStr, endStr });
  log('Vue 日期组件探测:', JSON.stringify(setViaVue)?.slice(0, 200));

  // 方案 B: 点日期面板的快捷按钮(如果有"最近30天")
  const quickSet = await page.evaluate(() => {
    const panels = document.querySelectorAll('.el-picker-panel, .el-date-picker, [class*="picker"]');
    for (const p of panels) {
      const shortcuts = p.querySelectorAll('.el-picker-panel__sidebar-item, .el-picker-panel__shortcut, [class*="shortcut"]');
      for (const s of shortcuts) {
        const t = s.textContent.trim();
        if (t.includes('30') || t.includes('最近一个月') || t.includes('近一个月')) {
          s.click(); return t;
        }
      }
    }
    return null;
  });
  log('快捷按钮:', quickSet);

  return { ok: true, startStr, endStr, quickSet, setViaVue };
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

main().catch(e => { console.error('[multi-deep] Fatal:', e); process.exit(1); });
