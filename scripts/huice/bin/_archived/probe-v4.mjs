#!/usr/bin/env node
/**
 * probe-v4.mjs — 精准操作:点 .select-tags-box 弹出店铺 popover,选店铺,查询,抓 grid
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../lib/config.mjs';

const config = loadConfig();
const log = (...a) => console.log('[probe-v4]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  for (const d of [config.screenshotDir]) if (!existsSync(d)) mkdirSync(d, { recursive: true });
  const lock = resolve(config.profileDir, 'SingletonLock');
  if (existsSync(lock)) {
    try { const pid = parseInt((readFileSync(lock,'utf8').match(/(\d+)$/)||[])[1]||'0',10);
      if (pid) { try { process.kill(pid,0); } catch { unlinkSync(lock); } } } catch {}
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

  try {
    await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    await closePopups(page);
    log('页面:', page.url());

    // ===== 1. 点 .select-tags-box =====
    log('\n=== 1. 点击店铺选择框 .select-tags-box ===');
    const clicked = await page.evaluate(() => {
      const box = document.querySelector('.select-tags-box');
      if (box && box.offsetParent !== null) { box.click(); return true; }
      return false;
    });
    log('点击结果:', clicked);
    await sleep(1200);
    await page.screenshot({ path: resolve(config.screenshotDir, 'probe4-shop-popover.png') });

    // ===== 2. dump .dc-shop popover 内容 =====
    log('\n=== 2. 店铺 popover 内容 ===');
    const shopList = await page.evaluate(() => {
      // popover 可能在 body 末尾(el-popover 默认 append to body)
      const popover = document.querySelector('.dc-shop:not([style*="display: none"])') ||
                      document.querySelector('.dc-shop');
      if (!popover) {
        // 找所有可见的 popover
        const all = Array.from(document.querySelectorAll('.el-popover, .el-popper')).filter(p => {
          const s = window.getComputedStyle(p);
          return s.display !== 'none' && p.getBoundingClientRect().width > 0;
        });
        return { found: false, visiblePopovers: all.map(p => ({ cls: p.className, text: p.textContent.trim().slice(0, 200) })) };
      }
      // 提取店铺项
      const items = popover.querySelectorAll('.shop-item, [class*="shop"], li, .el-checkbox, label');
      const shops = [];
      items.forEach(el => {
        const t = el.textContent.trim();
        if (t && t.length < 60 && t.length > 1) {
          // 取店铺名(排除"全选""搜索店铺"等)
          if (!['全选','搜索店铺','全部'].includes(t) && !t.includes('input')) {
            shops.push({ text: t, class: el.className, tag: el.tagName });
          }
        }
      });
      return { found: true, popoverHTML: popover.outerHTML.slice(0, 3000), shops: shops.slice(0, 30) };
    });
    log('popover 找到:', shopList.found);
    if (shopList.found) {
      log('店铺列表:');
      shopList.shops.forEach((s, i) => log(`  [${i}] ${s.tag}.${s.class.split(' ')[0]} → ${s.text}`));
      log('popover HTML 前1000:', shopList.popoverHTML.slice(0, 1000));
    } else {
      log('可见 popovers:', JSON.stringify(shopList.visiblePopovers, null, 2));
    }

    // ===== 3. 选第一个店铺 =====
    log('\n=== 3. 选第一个店铺 ===');
    const selected = await page.evaluate(() => {
      const popover = document.querySelector('.dc-shop:not([style*="display: none"])') || document.querySelector('.dc-shop');
      if (!popover) return { ok: false, reason: 'popover 不可见' };
      // 找店铺项(checkbox 形式)
      const items = popover.querySelectorAll('.el-checkbox, [class*="shop-item"], label.el-checkbox');
      for (const item of items) {
        const t = item.textContent.trim();
        if (t && t.length < 60 && !['全选','搜索店铺','全部'].includes(t)) {
          item.click();
          return { ok: true, shop: t };
        }
      }
      return { ok: false, reason: 'popover 内无店铺项' };
    });
    log('选中:', JSON.stringify(selected));
    await sleep(800);

    // 点别处关闭 popover
    await page.mouse.click(800, 500);
    await sleep(500);

    // ===== 4. 点查询 =====
    log('\n=== 4. 点击查询 ===');
    await page.evaluate(() => {
      document.querySelectorAll('button, .el-button').forEach(btn => {
        if (['查询','查 询'].includes(btn.textContent.trim())) btn.click();
      });
    });
    log('已点查询,等待数据...');
    await sleep(10000);
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.screenshot({ path: resolve(config.screenshotDir, 'probe4-after-query.png'), fullPage: true });

    // ===== 5. 抓 AG-Grid 数据 =====
    log('\n=== 5. AG-Grid 数据 ===');
    const gridData = await page.evaluate(() => {
      const grid = document.querySelector('.v-ag-grid, .ag-root');
      if (!grid) return { found: false };

      // AG-Grid 列头(多种选择器)
      let headers = [];
      for (const sel of ['.ag-header-cell-text', '.ag-header-cell .ag-cell-label-container', '[class*="header-cell-text"]']) {
        const els = grid.querySelectorAll(sel);
        if (els.length > headers.length) {
          headers = Array.from(els).map(e => e.textContent.trim()).filter(Boolean);
        }
      }

      // AG-Grid 行(虚拟滚动,可能需要滚动)
      const rows = grid.querySelectorAll('.ag-row, [role="row"]');
      const dataRows = [];
      const max = Math.min(10, rows.length);
      for (let i = 0; i < max; i++) {
        const cells = rows[i].querySelectorAll('.ag-cell, [role="gridcell"], [col-id]');
        const rowData = Array.from(cells).map(c => c.textContent.trim()).filter(Boolean);
        if (rowData.length > 0) dataRows.push(rowData);
      }

      return {
        found: true,
        headerCount: headers.length,
        headers,
        rowCount: rows.length,
        dataRows,
        // grid 的整个文本(兜底)
        gridText: grid.textContent.trim().slice(0, 2000),
      };
    });
    log('Grid 找到:', gridData.found);
    if (gridData.found) {
      log('表头数:', gridData.headerCount);
      log('表头:', gridData.headers.join(' | '));
      log('行数:', gridData.rowCount);
      if (gridData.dataRows.length > 0) {
        log('\n📊 数据:');
        gridData.dataRows.slice(0, 5).forEach((r, i) => log(`  [${i}] ${r.join(' | ')}`));
      } else {
        log('无数据行,grid 文本兜底:', gridData.gridText.slice(0, 500));
      }
    }

    writeFileSync(resolve(config.outputDir, 'probe-v4-result.json'), JSON.stringify({ selected, gridData }, null, 2));

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
  await sleep(1000);
}

main().catch(e => { console.error('[probe-v4] Fatal:', e); process.exit(1); });
