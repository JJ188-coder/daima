#!/usr/bin/env node
/**
 * probe-v2.mjs — 探测汇策利润页 DOM (V2 修正版)
 *
 * 修正:
 *  - 表格是 AG-Grid,改用 .ag-header-cell / .ag-row / .ag-cell 选择器
 *  - 店铺下拉精准定位"请选择店铺"输入框,不混入口径/建单选项
 *  - 查询后多等几秒让数据渲染
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../lib/config.mjs';

const config = loadConfig();
const log = (...a) => console.log('[probe-v2]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  for (const d of [config.screenshotDir, config.outputDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }

  // 清孤儿锁
  const lock = resolve(config.profileDir, 'SingletonLock');
  if (existsSync(lock)) {
    try {
      const pid = parseInt((readFileSync(lock, 'utf8').match(/(\d+)$/) || [])[1] || '0', 10);
      if (pid) { try { process.kill(pid, 0); } catch { unlinkSync(lock); log('清理孤儿锁'); } }
    } catch {}
  }

  const context = await chromium.launchPersistentContext(config.profileDir, {
    executablePath: config.chromePath,
    headless: true,
    viewport: { width: 1600, height: 1000 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || (await context.newPage());

  try {
    // 关弹窗 + 导航
    await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    await closePopups(page);

    log('已进入:', page.url());

    // ===== AG-Grid 探测(无需查询,看默认有无数据)=====
    log('\n=== 1. AG-Grid 结构探测 ===');
    const gridInfo = await probeAgGrid(page);
    log('Grid 类型:', gridInfo.gridFound ? 'AG-Grid ✓' : '未找到 ✗');
    log('表头列数:', gridInfo.headers.length);
    log('表头:', gridInfo.headers.join(' | '));
    log('数据行数:', gridInfo.rowCount);
    if (gridInfo.sampleRows.length > 0) {
      log('样例数据:');
      gridInfo.sampleRows.slice(0, 3).forEach((r, i) => log(`  [${i}] ${r.join(' | ')}`));
    }

    // ===== 精准选店铺 =====
    log('\n=== 2. 精准选店铺 ===');
    const shopSelected = await selectShop(page);
    log('选店铺结果:', shopSelected);

    if (shopSelected.ok) {
      await sleep(500);
      // 点查询
      log('\n=== 3. 点击查询 ===');
      const queried = await page.evaluate(() => {
        const btns = document.querySelectorAll('button, .el-button');
        for (const btn of btns) {
          const t = btn.textContent.trim();
          if (['查询', '查 询'].includes(t)) { btn.click(); return t; }
        }
        return null;
      });
      log('查询按钮:', queried);

      // 多等一会,AG-Grid 渲染慢
      await sleep(8000);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

      await page.screenshot({ path: resolve(config.screenshotDir, 'probe2-after-query.png'), fullPage: true });

      // 再探测 grid
      log('\n=== 4. 查询后 AG-Grid ===');
      const gridAfter = await probeAgGrid(page);
      log('行数:', gridAfter.rowCount);
      log('表头:', gridAfter.headers.join(' | '));
      if (gridAfter.sampleRows.length > 0) {
        log('数据样例:');
        gridAfter.sampleRows.slice(0, 5).forEach((r, i) => log(`  [${i}] ${r.join(' | ')}`));
      }
    }

    // 写结果
    writeFileSync(
      resolve(config.outputDir, 'probe-v2-result.json'),
      JSON.stringify({ shopSelected, gridBefore: await probeAgGrid(page) }, null, 2),
    );
    log('\n📄 完成');

  } catch (err) {
    log('❌', err.message);
    await page.screenshot({ path: resolve(config.screenshotDir, 'probe2-99-error.png') }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

/** 探测 AG-Grid 表格 */
async function probeAgGrid(page) {
  return page.evaluate(() => {
    const info = { gridFound: false, headers: [], rowCount: 0, sampleRows: [] };

    // AG-Grid 容器
    const grid = document.querySelector('.ag-root, .ag-theme-balham, .ag-theme-alpine, [class*="ag-grid"], .v-ag-grid');
    if (!grid) return info;
    info.gridFound = true;

    // 表头(AG-Grid 的列头在 .ag-header-cell .ag-header-cell-text)
    const headerCells = grid.querySelectorAll('.ag-header-cell-text, .ag-header-cell .ag-cell-label-container');
    info.headers = Array.from(headerCells)
      .map(c => c.textContent.trim())
      .filter(t => t && t.length < 30);

    // 数据行
    const rows = grid.querySelectorAll('.ag-row');
    info.rowCount = rows.length;
    const max = Math.min(5, rows.length);
    for (let i = 0; i < max; i++) {
      const cells = rows[i].querySelectorAll('.ag-cell');
      info.sampleRows.push(Array.from(cells).map(c => c.textContent.trim()).slice(0, 30));
    }
    return info;
  });
}

/** 精准选店铺:找 placeholder 含"店铺"的 select */
async function selectShop(page) {
  // 找"请选择店铺"那个输入框
  const shopSelectFound = await page.evaluate(() => {
    const inputs = document.querySelectorAll('.el-select input, .el-input__inner');
    for (const input of inputs) {
      const ph = input.placeholder || '';
      const parent = input.closest('.el-select');
      const label = parent?.previousElementSibling?.textContent || '';
      // 匹配"请选择店铺"
      if (ph.includes('店铺') || label.includes('店铺')) {
        // 点这个 select 的可点击区域(整个 .el-select 或 input)
        (parent || input).click();
        return true;
      }
    }
    return false;
  });

  if (!shopSelectFound) return { ok: false, reason: '没找到店铺下拉' };

  await sleep(1000);
  await page.screenshot({ path: resolve(config.screenshotDir, 'probe2-shop-dropdown.png') });

  // 取弹出的下拉项(只取第一个分组,通常是店铺列表)
  const options = await page.evaluate(() => {
    // AG-Grid 的下拉可能是自定义 popper,也可能是 el-select 的
    const dropdowns = document.querySelectorAll('.el-select-dropdown, .el-popper, [class*="dropdown"], [class*="popper"]');
    const result = { allDropdowns: [], firstGroupItems: [] };

    for (const dd of dropdowns) {
      const rect = dd.getBoundingClientRect();
      if (rect.width === 0) continue;
      const items = Array.from(dd.querySelectorAll('.el-select-dropdown__item, li, [class*="item"]'))
        .map(el => ({ text: el.textContent.trim(), html: el.innerHTML.slice(0, 100) }))
        .filter(i => i.text && i.text.length < 40);
      if (items.length > 0) {
        result.allDropdowns.push({ text: dd.textContent.trim().slice(0, 100), itemCount: items.length, items: items.slice(0, 10) });
      }
    }
    return result;
  });

  log('  下拉内容:', JSON.stringify(options.allDropdowns.map(d => ({ text: d.text, items: d.items.map(i => i.text) })), null, 2));

  // 选第一个看起来像店铺名的选项(非口径/非建单/非设置)
  const shopName = await page.evaluate(() => {
    const dropdowns = document.querySelectorAll('.el-select-dropdown:not([style*="display: none"]), .el-popper:not([style*="display: none"])');
    const excludeKeywords = ['口径', '建单', '跟单', '成本价', '登录', '退出', '查询条件'];

    for (const dd of dropdowns) {
      const items = dd.querySelectorAll('.el-select-dropdown__item, li');
      for (const item of items) {
        const t = item.textContent.trim();
        if (t && t.length < 40 && !excludeKeywords.some(k => t.includes(k)) && t !== '全部') {
          // 店铺名通常含中文店铺关键词或品牌名
          item.click();
          return t;
        }
      }
    }
    return null;
  });

  return { ok: !!shopName, shopName, dropdowns: options.allDropdowns };
}

async function closePopups(page) {
  await page.evaluate(() => {
    ['我知道了', '300S后关闭', '确定', '关闭'].forEach(text => {
      document.querySelectorAll('button, .el-button').forEach(el => {
        if (el.textContent.trim() === text && el.offsetParent !== null) el.click();
      });
    });
  });
  await sleep(1000);
}

main().catch(e => { console.error('[probe-v2] Fatal:', e); process.exit(1); });
