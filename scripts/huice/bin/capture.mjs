#!/usr/bin/env node
/**
 * capture.mjs — 汇策利润数据抓取 (正式版)
 *
 * 流程:
 *  1. 复用 private/huice-profile 登录态
 *  2. 导航到每日利润分析页
 *  3. 选店铺 (默认"拼【周贝瑞",可通过 --shop 指定)
 *  4. 查询
 *  5. 抓 AG-Grid 表格数据
 *  6. 输出 JSON 到 output/huice-explore/capture-<date>.json
 *
 * 用法:
 *   node scripts/huice/bin/capture.mjs                    # 默认店铺"拼【周贝瑞"
 *   node scripts/huice/bin/capture.mjs --shop "拼【甜心"  # 指定店铺
 *   node scripts/huice/bin/capture.mjs --list-shops       # 只列出所有店铺
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../lib/config.mjs';

const config = loadConfig();
const log = (...a) => console.log('[capture]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 解析命令行参数
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { shop: '拼【周贝瑞', listShops: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--shop') opts.shop = args[++i];
    else if (args[i] === '--list-shops') opts.listShops = true;
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  for (const d of [config.screenshotDir, config.outputDir]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

  // 清孤儿锁
  const lock = resolve(config.profileDir, 'SingletonLock');
  if (existsSync(lock)) {
    try { const pid=parseInt((readFileSync(lock,'utf8').match(/(\d+)$/)||[])[1]||'0',10); if(pid){try{process.kill(pid,0);}catch{unlinkSync(lock);}}} catch{}
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
    // 导航 + 关弹窗
    await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    await closePopups(page);
    log('已进入利润分析页');

    // ===== 列出所有店铺 =====
    log('\n📂 打开店铺选择器...');
    await page.evaluate(() => document.querySelector('.select-tags-box')?.click());
    await sleep(1500);

    const allShops = await page.evaluate(() => {
      const popover = document.querySelector('.dc-shop');
      if (!popover) return [];
      return Array.from(popover.querySelectorAll('.level2-item')).map(el => {
        const textEl = el.querySelector('.text-ellipsis-content');
        return textEl ? textEl.textContent.trim() : el.textContent.trim().slice(0, 40);
      }).filter(Boolean);
    });
    log(`找到 ${allShops.length} 个店铺:`);
    allShops.forEach((s, i) => log(`  [${i}] ${s}`));

    if (opts.listShops) {
      writeFileSync(resolve(config.outputDir, 'shops.json'), JSON.stringify(allShops, null, 2));
      log('\n📄 shops.json 已保存');
      return;
    }

    // ===== 选指定店铺 =====
    let shopToSelect = opts.shop;
    // 精确匹配,否则模糊匹配
    if (!allShops.includes(shopToSelect)) {
      const fuzzy = allShops.find(s => s.includes(shopToSelect) || shopToSelect.includes(s));
      if (fuzzy) shopToSelect = fuzzy;
      else {
        log(`\n❌ 店铺 "${opts.shop}" 不存在`);
        log('可用店铺见上方列表,或用 --list-shops 导出');
        return;
      }
    }

    log(`\n✓ 选中店铺: ${shopToSelect}`);
    const selected = await page.evaluate((name) => {
      const popover = document.querySelector('.dc-shop');
      if (!popover) return false;
      const items = popover.querySelectorAll('.level2-item');
      for (const item of items) {
        const text = item.querySelector('.text-ellipsis-content')?.textContent.trim() || item.textContent.trim();
        if (text === name) { item.click(); return true; }
      }
      return false;
    }, shopToSelect);

    if (!selected) { log('❌ 点击店铺项失败'); return; }
    await sleep(800);

    // 点别处关闭 popover
    await page.mouse.click(800, 500);
    await sleep(500);

    // ===== 查询 =====
    log('\n🔍 点击查询...');
    await page.evaluate(() => {
      document.querySelectorAll('button, .el-button').forEach(btn => {
        if (['查询','查 询'].includes(btn.textContent.trim())) btn.click();
      });
    });
    await sleep(10000);
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

    await page.screenshot({ path: resolve(config.screenshotDir, `capture-${Date.now()}.png`), fullPage: true });
    log('截图已保存');

    // ===== 抓 AG-Grid 数据 =====
    log('\n📊 抓取表格数据...');
    const gridData = await extractGridData(page);
    log(`表头: ${gridData.headers.join(' | ')}`);
    log(`数据行数: ${gridData.rows.length}`);
    if (gridData.rows.length > 0) {
      log('\n前 5 行:');
      gridData.rows.slice(0, 5).forEach((r, i) => log(`  [${i}] ${r.join(' | ')}`));
    }

    // 写结果
    const result = {
      shop: shopToSelect,
      url: page.url(),
      capturedAt: new Date().toISOString(),
      headers: gridData.headers,
      rows: gridData.rows,
      rawGridText: gridData.rawText,
    };
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const outFile = resolve(config.outputDir, `capture-${dateStr}.json`);
    writeFileSync(outFile, JSON.stringify(result, null, 2));
    log(`\n📄 数据已保存: ${outFile}`);

  } catch (err) {
    log('❌', err.message);
    await page.screenshot({ path: resolve(config.screenshotDir, 'capture-error.png') }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

/** 提取 AG-Grid 数据
 * AG-Grid 结构:
 *   .ag-pinned-left-cols-container  → 49行项目名(每行1个cell)
 *   .ag-center-cols-container       → 49行数值(每行5个cell: 本日/昨日/环比/上月同日/同比)
 *   两容器行数相同,按 DOM 顺序对齐
 */
async function extractGridData(page) {
  return page.evaluate(() => {
    const grid = document.querySelector('.v-ag-grid, .ag-root');
    if (!grid) return { headers: [], rows: [], rawText: '' };

    // ── 表头 ──
    const pinnedHeader = grid.querySelector('.ag-pinned-left-header .ag-header-cell-text')?.textContent.trim() || '核算项目';
    const mainHeaders = Array.from(grid.querySelectorAll('.ag-header-container .ag-header-cell-text'))
      .map(e => e.textContent.trim())
      .filter(t => t && t.length < 40);
    const headers = [pinnedHeader, ...mainHeaders];

    // ── 项目名(pinned-left)──
    const pinnedRows = Array.from(grid.querySelectorAll('.ag-pinned-left-cols-container .ag-row'));
    const itemNames = pinnedRows.map(row => {
      const cell = row.querySelector('.ag-cell');
      return cell ? cell.textContent.trim() : '';
    });

    // ── 数值(center)──
    const centerRows = Array.from(grid.querySelectorAll('.ag-center-cols-container .ag-row'));
    const values = centerRows.map(row => {
      return Array.from(row.querySelectorAll('.ag-cell')).map(c => c.textContent.trim());
    });

    // ── 按 DOM 顺序拼接 ──
    const rows = [];
    const maxLen = Math.max(itemNames.length, values.length);
    for (let i = 0; i < maxLen; i++) {
      const name = itemNames[i] || '';
      const vals = values[i] || [];
      if (name || vals.length > 0) {
        rows.push([name, ...vals]);
      }
    }

    return {
      headers,
      rows,
      rawText: grid.textContent.trim().slice(0, 3000),
    };
  });
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

main().catch(e => { console.error('[capture] Fatal:', e); process.exit(1); });
