#!/usr/bin/env node
/** nav-debug.mjs — dump 日历翻页按钮结构,找到正确的"上一月"按钮 */
import { chromium } from 'playwright';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../lib/config.mjs';

const config = loadConfig();
const log = (...a) => console.log('[nav]', ...a);
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
    await page.goto('https://hjy.huice.com/#/businessAnalysisCenter/report/trendNew', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    await closePopups(page);
    await page.locator('.el-range-editor').first().click();
    await sleep(1500);

    // dump 所有 header 按钮(含 class/text/作用)
    const btns = await page.evaluate(() => {
      const panel = document.querySelector('.el-date-range-picker:not([style*="display: none"])');
      if (!panel) return [];
      const headers = panel.querySelectorAll('.el-date-range-picker__header');
      const result = [];
      headers.forEach((h, idx) => {
        result.push({ calIdx: idx, headerText: h.textContent.trim().slice(0, 30) });
        h.querySelectorAll('button, [class*="icon"], i').forEach(b => {
          const rect = b.getBoundingClientRect();
          if (rect.width > 0) {
            result.push({
              calIdx: idx,
              tag: b.tagName,
              class: b.className.slice(0, 60),
              text: b.textContent.trim(),
              ariaLabel: b.getAttribute('aria-label') || '',
              // 双箭头 vs 单箭头
              isDouble: b.className.includes('d-arrow') || b.className.includes('double'),
              isSingle: b.className.includes('arrow'),
            });
          }
        });
      });
      return result;
    });
    log('=== header 按钮 dump ===');
    btns.forEach(b => log(`  日历[${b.calIdx}] ${b.tag}.${(b.class||'').slice(0,30)} | text="${b.text}" | aria="${b.ariaLabel}" | ${b.isDouble?'双箭头':''}${b.isSingle?'单箭头':''}`));

    // 现在精确点:左侧日历的"上一月"是单左箭头(el-icon-arrow-left),不是双箭头(el-icon-d-arrow-left)
    log('\n=== 测试点单左箭头翻月 ===');
    // 记录当前 header
    let h = await page.evaluate(() => document.querySelectorAll('.el-date-range-picker__content')[0]?.querySelector('.el-date-range-picker__header')?.textContent?.trim());
    log(`  翻页前左日历: ${h}`);

    for (let i = 0; i < 2; i++) {
      // 只点 .el-icon-arrow-left (单箭头 = 上一月)
      await page.evaluate(() => {
        const left = document.querySelectorAll('.el-date-range-picker__content')[0];
        // 单左箭头
        const singleLeft = left.querySelector('.el-icon-arrow-left, .el-picker-panel__icon-btn.el-icon-arrow-left, button .el-icon-arrow-left');
        if (singleLeft) {
          // 找它的父 button
          const btn = singleLeft.closest('button') || singleLeft;
          btn.click();
        }
      });
      await sleep(500);
      h = await page.evaluate(() => document.querySelectorAll('.el-date-range-picker__content')[0]?.querySelector('.el-date-range-picker__header')?.textContent?.trim());
      log(`  第${i+1}次点单左箭头后: ${h}`);
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
main().catch(e => { console.error('[nav] Fatal:', e); process.exit(1); });
