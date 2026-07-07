#!/usr/bin/env node
/** probe-v5.mjs — 深度 dump 店铺 popover 内部结构 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../lib/config.mjs';

const config = loadConfig();
const log = (...a) => console.log('[probe-v5]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const lock = resolve(config.profileDir, 'SingletonLock');
  if (existsSync(lock)) { try { const pid=parseInt((readFileSync(lock,'utf8').match(/(\d+)$/)||[])[1]||'0',10); if(pid){try{process.kill(pid,0);}catch{unlinkSync(lock);}}} catch{} }
  if (!existsSync(config.screenshotDir)) mkdirSync(config.screenshotDir, { recursive: true });

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

    // 点店铺框
    await page.evaluate(() => document.querySelector('.select-tags-box')?.click());
    await sleep(1500);

    // 深度 dump popover 所有可点击的店铺项
    const shopTree = await page.evaluate(() => {
      const popover = document.querySelector('.dc-shop');
      if (!popover) return { error: 'no popover' };

      const result = { html: popover.innerHTML.slice(0, 8000) };

      // 找所有 level2-item / level1-item 的文本和结构
      const levels = ['.level1-item', '.level2-item', '.level3-item', '[class*="level"]'];
      result.levels = {};
      for (const sel of levels) {
        const els = popover.querySelectorAll(sel);
        if (els.length > 0) {
          result.levels[sel] = Array.from(els).slice(0, 20).map(el => ({
            text: el.textContent.trim().slice(0, 80),
            class: el.className,
            childCount: el.children.length,
            // 是否可点击
            clickable: window.getComputedStyle(el).cursor === 'pointer' || !!el.onclick,
          }));
        }
      }

      // 找所有 checkbox
      result.checkboxes = Array.from(popover.querySelectorAll('.el-checkbox, input[type="checkbox"], [class*="check"]'))
        .slice(0, 30)
        .map(el => ({ text: el.textContent.trim().slice(0, 60), class: el.className }));

      // 找所有文本节点(< 30 字符,可能是店铺名)
      result.shortTexts = [];
      popover.querySelectorAll('span, div, p, label').forEach(el => {
        // 只取直接文本(不含子元素文本)
        const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
        if (own && own.length > 1 && own.length < 40 && !['店铺名称','全选','搜索店铺','店铺'].includes(own)) {
          result.shortTexts.push({ text: own, tag: el.tagName, class: el.className });
        }
      });

      return result;
    });

    log('popover levels:');
    for (const [sel, items] of Object.entries(shopTree.levels || {})) {
      log(`  ${sel} (${items.length}个):`);
      items.forEach((it, i) => log(`    [${i}] "${it.text}" clickable=${it.clickable}`));
    }
    log('\ncheckboxes:', (shopTree.checkboxes || []).length);
    (shopTree.checkboxes || []).forEach((c, i) => log(`  [${i}] ${c.text}`));
    log('\n短文本(可能是店铺名):');
    (shopTree.shortTexts || []).slice(0, 30).forEach((t, i) => log(`  [${i}] ${t.tag}.${(t.class||'').split(' ')[0]} → "${t.text}"`));

    writeFileSync(resolve(config.outputDir, 'shop-popover.json'), JSON.stringify(shopTree, null, 2));
    log('\n📄 shop-popover.json 已保存');
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
main().catch(e => { console.error('[probe-v5] Fatal:', e); process.exit(1); });
