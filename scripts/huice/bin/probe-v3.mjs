#!/usr/bin/env node
/**
 * probe-v3.mjs — dump 汇策利润页真实 DOM 结构
 *
 * 不走 CDP 9222(那是拼多多页),直接在 Playwright context 内 dump HTML。
 * 重点 dump:店铺选择器 + AG-Grid 完整结构。
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../lib/config.mjs';

const config = loadConfig();
const log = (...a) => console.log('[probe-v3]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  for (const d of [config.screenshotDir, config.outputDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
  const lock = resolve(config.profileDir, 'SingletonLock');
  if (existsSync(lock)) {
    try {
      const pid = parseInt((readFileSync(lock, 'utf8').match(/(\d+)$/) || [])[1] || '0', 10);
      if (pid) { try { process.kill(pid, 0); } catch { unlinkSync(lock); } }
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
    await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    // 关弹窗
    await page.evaluate(() => {
      document.querySelectorAll('button, .el-button').forEach(el => {
        const t = el.textContent.trim();
        if (['我知道了', '300S后关闭', '确定', '关闭'].includes(t) && el.offsetParent !== null) el.click();
      });
    });
    await sleep(1000);
    log('页面:', page.url());

    // ===== 1. Dump 筛选区完整 HTML =====
    log('\n=== 1. 筛选区结构 ===');
    const filterHTML = await page.evaluate(() => {
      // 找包含"店铺"文字的最小容器
      const all = document.querySelectorAll('div, section, form');
      let container = null;
      for (const el of all) {
        if (el.textContent.includes('店铺') && el.textContent.includes('查询') &&
            el.getBoundingClientRect().width > 200 && el.getBoundingClientRect().width < 1600) {
          // 选最小的
          if (!container || el.innerHTML.length < container.innerHTML.length) {
            container = el;
          }
        }
      }
      return container ? container.outerHTML.slice(0, 6000) : 'NOT FOUND';
    });
    log('筛选区 HTML(前3000):', filterHTML.slice(0, 3000));

    // ===== 2. Dump 店铺选择器详细结构 =====
    log('\n=== 2. 店铺选择器 ===');
    const shopSelector = await page.evaluate(() => {
      // 找所有文本含"店铺"且宽度合适的元素
      const candidates = [];
      document.querySelectorAll('*').forEach(el => {
        const ownText = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
        if (ownText === '店铺' || ownText.includes('店铺')) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 20 && rect.width < 300 && rect.top > 60 && rect.top < 300) {
            candidates.push({
              tag: el.tagName,
              text: ownText.slice(0, 30),
              class: el.className,
              parentClass: el.parentElement?.className,
              parentHTML: el.parentElement?.outerHTML?.slice(0, 500),
              rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
            });
          }
        }
      });
      return candidates.slice(0, 5);
    });
    log('店铺相关元素:', JSON.stringify(shopSelector, null, 2));

    // ===== 3. AG-Grid 完整结构 dump =====
    log('\n=== 3. AG-Grid 结构 ===');
    const gridDump = await page.evaluate(() => {
      const grid = document.querySelector('.ag-root, [class*="ag-grid"], .v-ag-grid, [class*="ag-theme"]');
      if (!grid) return { found: false };

      // 列出所有可能的表头选择器
      const headerSelectors = [
        '.ag-header-cell-text',
        '.ag-header-cell .ag-cell-label-container',
        '.ag-header-cell',
        '[class*="header-cell"]',
        '[col-id]',  // AG-Grid cell 通常带 col-id
      ];
      const headerResults = {};
      for (const sel of headerSelectors) {
        const els = grid.querySelectorAll(sel);
        headerResults[sel] = {
          count: els.length,
          texts: Array.from(els).slice(0, 30).map(e => e.textContent.trim()).filter(Boolean),
        };
      }

      // 列出所有可能的行选择器
      const rowSelectors = ['.ag-row', '[class*="ag-row"]', '[row-id]', '[role="row"]'];
      const rowResults = {};
      for (const sel of rowSelectors) {
        const els = grid.querySelectorAll(sel);
        rowResults[sel] = {
          count: els.length,
          firstRowCells: els[0] ? Array.from(els[0].querySelectorAll('.ag-cell, [col-id], [role="gridcell"]')).slice(0, 30).map(c => c.textContent.trim()) : [],
        };
      }

      return {
        found: true,
        gridClass: grid.className,
        gridTag: grid.tagName,
        headerResults,
        rowResults,
        // col-id 列表(AG-Grid 特征)
        colIds: Array.from(grid.querySelectorAll('[col-id]')).map(e => e.getAttribute('col-id')).filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 40),
      };
    });
    log('Grid 找到:', gridDump.found);
    if (gridDump.found) {
      log('Grid class:', gridDump.gridClass);
      log('col-ids:', gridDump.colIds.join(' | '));
      for (const [sel, r] of Object.entries(gridDump.headerResults)) {
        if (r.count > 0) log(`表头[${sel}]: ${r.count}个 → ${r.texts.join(' | ')}`);
      }
      for (const [sel, r] of Object.entries(gridDump.rowResults)) {
        if (r.count > 0) log(`行[${sel}]: ${r.count}行 → 首行: ${r.firstRowCells.join(' | ')}`);
      }
    }

    // ===== 4. 尝试点击"店铺"标签附近的选择器 =====
    log('\n=== 4. 点击店铺选择器 ===');
    const clickResult = await page.evaluate(() => {
      // 店铺选择器可能是自定义组件,找"店铺"文字右边/下边的可点击元素
      const shopLabels = Array.from(document.querySelectorAll('*')).filter(el => {
        const t = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
        return t === '店铺';
      });

      const results = [];
      for (const label of shopLabels) {
        const parent = label.parentElement;
        const next = label.nextElementSibling;
        // 标签的下一个兄弟或父元素的下一个兄弟往往是选择器
        const candidates = [next, parent?.nextElementSibling, parent].filter(Boolean);
        for (const cand of candidates) {
          const style = window.getComputedStyle(cand);
          if (style.cursor === 'pointer' || cand.onclick || cand.getAttribute('@click')) {
            results.push({
              candidate: cand.tagName + '.' + cand.className,
              text: cand.textContent.trim().slice(0, 50),
              clicked: false,
            });
            // 不直接点,只记录
          }
        }
      }
      return results;
    });
    log('店铺选择器候选:', JSON.stringify(clickResult, null, 2));

    // ===== 5. 写完整 HTML dump 供分析 =====
    const fullHTML = await page.content();
    writeFileSync(resolve(config.outputDir, 'profit-page.html'), fullHTML);
    log('\n📄 完整 HTML 已保存: output/huice-explore/profit-page.html (' + fullHTML.length + ' chars)');

    await page.screenshot({ path: resolve(config.screenshotDir, 'probe3-full.png'), fullPage: true });

  } catch (err) {
    log('❌', err.message);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

main().catch(e => { console.error('[probe-v3] Fatal:', e); process.exit(1); });
