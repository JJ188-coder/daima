#!/usr/bin/env node
/**
 * huice-sync.mjs — 慧经营利润数据同步 CLI（万物 CLI 化）
 *
 * 用途：
 *   1. 复用 private/huice-profile（cookies 已存，免登录）打开慧经营商品排名页
 *   2. 提取表格利润数据（净利/退款/成本/销售额/销量）
 *   3. 自动写入「店透视」(dts) 扩展的 chrome.storage.local
 *
 * 触发方式：
 *   npm run huice:sync              # 同步昨日数据（默认）
 *   npm run huice:sync -- --days 7  # 补采近7天
 *   node scripts/huice-sync.mjs     # 直接跑
 *
 * 前置条件：
 *   - private/huice-profile 已登录慧经营（首次失败需手动扫码一次）
 *   - 「店透视」扩展已在某个 Chrome 中加载（CDP 9222 可达，或手动导入 JSON）
 *
 * 数据写入目标：
 *   - dts 扩展 storage key: pdd_huice_window_<YYYY-MM-DD>
 *   - 通过 CDP 9222 注入到 PDD 页面，调用 window.__PDD_EM.importHuiceData()
 *   - CDP 不可用时，落盘到 output/huice-sync/<date>.json，提示手动导入
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILE_DIR = path.resolve(ROOT, 'private/huice-profile');
const OUTPUT_DIR = path.resolve(ROOT, 'output/huice-sync');

// Chrome 可执行路径（优先系统 Chrome，回退 Playwright 自带）
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const CONFIG = {
  loginUrl: 'https://hjy.huice.com/',
  targetUrl: 'https://hjy.huice.com/#/opertData/CommodityAnalysis',
  cdpPort: 9222,  // dts 扩展所在 Chrome 的 CDP 端口
};

// === 命令行参数解析 ===
const args = process.argv.slice(2);
let days = 1;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i+1]) { days = parseInt(args[i+1]); i++; }
}

function dateStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

/** 提取慧经营表格数据(注入到页面执行)
 *  支持两种容器:
 *  - AG-Grid(商品分析页主力,按 colId 映射,列顺序无关)
 *  - el-table(兜底,按表头文字 includes 匹配)
 *  dateOverride: 覆盖 record.date(由调用方传入目标日期)
 */
function extractHuiceFromDOM(dateOverride) {
  const records = [];

  // === AG-Grid 分支(商品分析页 /opertData/CommodityAnalysis 用此结构)===
  // pinned-left 列顺序固定:[图片?, 店铺, 链接名称, 链接ID, 链接编码?]
  // center 列按 colId 标识字段,无需读表头
  const grids = document.querySelectorAll('.ag-root');
  grids.forEach(grid => {
    const pinnedRows = Array.from(grid.querySelectorAll('.ag-pinned-left-cols-container .ag-row'));
    const centerRows = Array.from(grid.querySelectorAll('.ag-center-cols-container .ag-row'));
    if (!pinnedRows.length && !centerRows.length) return;

    const maxLen = Math.max(pinnedRows.length, centerRows.length);
    for (let i = 0; i < maxLen; i++) {
      const pinned = pinnedRows[i] ? Array.from(pinnedRows[i].querySelectorAll('.ag-cell')).map(c => (c.textContent || '').trim()) : [];
      const center = centerRows[i] ? Array.from(centerRows[i].querySelectorAll('.ag-cell')) : [];

      // pinned 列:店铺(idx 1)、链接名称(idx 2)、链接ID(idx 3)
      const shopName = pinned[1] || '';
      const productName = pinned[2] || '';
      const rawId = pinned[3] || '';
      const productId = rawId.replace(/\D/g, '');
      if (!productId) continue;

      // center 列按 colId 取值(列顺序无关,最稳)
      const byColId = {};
      for (const cell of center) {
        const colId = cell.getAttribute('col-id') || cell.getAttribute('colId') || '';
        if (colId) byColId[colId] = (cell.textContent || '').trim();
      }

      const pn = (v) => { const n = parseFloat(String(v || '').replace(/,/g, '').replace(/%/g, '')); return isNaN(n) ? null : n; };
      const pp = (v) => { const n = pn(v); return n != null ? n / 100 : null; };

      records.push({
        productId,
        productName,
        shopName,
        salesAmount: pn(byColId.receivableAmount),
        salesQuantity: pn(byColId.payQty),
        costPrice: pn(byColId.costAmount),
        refundAmount: pn(byColId.refundAmount),
        refundRate: pp(byColId.refundRateString),
        netProfit: pn(byColId.netProfit),
        netProfitRate: pp(byColId.netInterestString),
        date: dateOverride,
        source: 'huice'
      });
    }
  });
  if (records.length) return records; // AG-Grid 命中则直接返回

  // === el-table 兜底分支(其他页面可能用此结构)===
  const tables = document.querySelectorAll('.el-table');
  tables.forEach(table => {
    const ths = table.querySelectorAll('.el-table__header-wrapper th, .el-table__header th');
    const headers = Array.from(ths).map(th => (th.textContent || '').trim());
    if (!headers.length) return;

    const findIdx = (name) => {
      const i = headers.findIndex(h => h.includes(name));
      return i >= 0 ? i : -1;
    };
    const linkIdx = findIdx('链接ID') !== -1 ? findIdx('链接ID') : findIdx('商品ID');
    const nameIdx = findIdx('链接名称');
    const salesAmtIdx = findIdx('销售额');
    const salesQtyIdx = findIdx('销量');
    const refundAmtIdx = findIdx('退款金额');
    const refundRateIdx = findIdx('退款率');
    const netProfitIdx = findIdx('净利');
    const netProfitRateIdx = findIdx('净利率');
    const costIdx = findIdx('成本');
    const shopIdx = findIdx('店铺');

    if (linkIdx === -1 && nameIdx === -1) return;

    table.querySelectorAll('.el-table__body-wrapper tbody tr, .el-table__body tbody tr').forEach(tr => {
      const cells = Array.from(tr.querySelectorAll('td')).map(td => (td.textContent || '').trim());
      if (!cells.length || cells.length <= Math.max(linkIdx, nameIdx)) return;
      const rawId = linkIdx >= 0 ? cells[linkIdx] : '';
      const productId = rawId.replace(/\D/g, '');
      if (!productId) return;

      const pn = (v) => { const n = parseFloat(String(v || '').replace(/,/g, '')); return isNaN(n) ? null : n; };
      const pp = (v) => { const n = pn(v); return n != null ? n / 100 : null; };

      records.push({
        productId,
        productName: nameIdx >= 0 ? cells[nameIdx] : '',
        shopName: shopIdx >= 0 ? cells[shopIdx] : '',
        salesAmount: pn(cells[salesAmtIdx]),
        salesQuantity: salesQtyIdx >= 0 ? parseInt(String(cells[salesQtyIdx]).replace(/,/g, '')) || 0 : 0,
        refundAmount: pn(cells[refundAmtIdx]),
        refundRate: pp(cells[refundRateIdx]),
        netProfit: pn(cells[netProfitIdx]),
        netProfitRate: pp(cells[netProfitRateIdx]),
        costPrice: pn(cells[costIdx]),
        date: dateOverride,
        source: 'huice'
      });
    });
  });
  return records;
}

/** 通过 CDP 写入 dts 扩展 storage */
async function writeToDtsStorage(allRecords) {
  // 按 date 分组
  const byDate = {};
  for (const r of allRecords) {
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(r);
  }

  // 检查 CDP 9222 是否在线
  const cdpUp = await checkCdp(CONFIG.cdpPort);
  if (!cdpUp) {
    console.log(`⚠️ CDP ${CONFIG.cdpPort} 不在线，数据已落盘到 ${OUTPUT_DIR}`);
    console.log('   如需导入到 dts 扩展，请：');
    console.log('   1. 在加载 dts 的 Chrome 打开 PDD 页面');
    console.log('   2. 在 Console 运行：');
    console.log('      const data = await fetch("file://' + OUTPUT_DIR + '/huice-latest.json").then(r=>r.json());');
    console.log('      await window.__PDD_EM.importHuiceData(data);');
    return false;
  }

  // 找到 PDD 页面
  const tabs = await getCdpTabs(CONFIG.cdpPort);
  const pddTab = tabs.find(t => t.url && t.url.includes('mms.pinduoduo.com'));
  if (!pddTab) {
    console.log(`⚠️ CDP ${CONFIG.cdpPort} 在线但没找到 PDD 页面`);
    console.log('   请在加载 dts 的 Chrome 打开任意 mms.pinduoduo.com 页面后重跑');
    return false;
  }

  console.log(`✅ 找到 PDD 页面，注入数据...`);
  // 通过 CDP 调用 importHuiceData(用 Node 内置全局 WebSocket,无 ws 包依赖)
  const ws = new WebSocket(pddTab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', (e) => reject(new Error(e.message || 'ws error')), { once: true });
  });

  let imported = 0;
  for (const [date, records] of Object.entries(byDate)) {
    const result = await cdpEval(ws, `(() => {
      return new Promise(async resolve => {
        try {
          if (!window.__PDD_EM?.importHuiceData) {
            resolve(JSON.stringify({ok: false, error: 'no importHuiceData'}));
            return;
          }
          const r = await window.__PDD_EM.importHuiceData(${JSON.stringify(records)});
          resolve(JSON.stringify(r));
        } catch(e) { resolve(JSON.stringify({ok: false, error: e.message})); }
      });
    })()`);
    const parsed = JSON.parse(result);
    if (parsed.ok) {
      imported += parsed.count;
      console.log(`  ✓ ${date}: ${parsed.count} 条已写入`);
    } else {
      console.log(`  ✗ ${date}: ${parsed.error}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  ws.close();
  console.log(`✅ 共写入 ${imported} 条记录到 dts 扩展 storage`);
  return true;
}

/** CDP Runtime.evaluate(用内置 WebSocket) */
function cdpEval(ws, expression) {
  return new Promise(resolve => {
    const id = Math.floor(Math.random() * 1000000);
    const handler = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id === id) {
        ws.removeEventListener('message', handler);
        resolve(msg.result?.result?.value || 'null');
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}

function checkCdp(port) {
  return new Promise(resolve => {
    http.get(`http://localhost:${port}/json/version`, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve(d.includes('Browser')));
    }).on('error', () => resolve(false));
  });
}

function getCdpTabs(port) {
  return new Promise(resolve => {
    http.get(`http://localhost:${port}/json`, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve([]); } });
    }).on('error', () => resolve([]));
  });
}

/**
 * 设置 element-ui date-range-picker 的日期范围。
 * 复用 backfill.mjs 的成熟方案：点 .el-range-editor 打开面板 → 单箭头翻月 → 点 td.available 日历单元格。
 * element-ui 的 range input 是 readonly，playwright 的 fill 会永久超时，必须走面板点击。
 * @param {import('playwright').Page} page
 * @param {string} startStr  YYYY-MM-DD
 * @param {string} endStr    YYYY-MM-DD
 */
async function setDateRange(page, startStr, endStr) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // 打开面板
  await page.locator('.el-range-editor').first().click();
  await sleep(1200);

  const start = new Date(startStr);
  const end = new Date(endStr);
  const startMonth = `${start.getFullYear()} 年 ${start.getMonth()+1} 月`;
  const endMonth = `${end.getFullYear()} 年 ${end.getMonth()+1} 月`;

  // ── 翻左日历到 START 所在月（单箭头）──
  let safety = 0;
  while (safety++ < 24) {
    const curHeader = await page.evaluate(() =>
      document.querySelectorAll('.el-date-range-picker__content')[0]?.querySelector('.el-date-range-picker__header')?.textContent?.trim()
    );
    if (curHeader === startMonth) break;
    await page.evaluate(() => {
      const left = document.querySelectorAll('.el-date-range-picker__content')[0];
      const singleLeft = left.querySelector('.el-icon-arrow-left');
      if (singleLeft) (singleLeft.closest('button') || singleLeft).click();
    });
    await sleep(400);
  }

  // ── 点 START 单元格（限定左日历，排除跨月灰格）──
  const startDay = start.getDate();
  await page.evaluate((day) => {
    const c = document.querySelectorAll('.el-date-range-picker__content')[0];
    const tds = c.querySelectorAll('td.available');
    for (const td of tds) {
      if (parseInt(td.querySelector('span')?.textContent?.trim(), 10) === day) { td.click(); return; }
    }
    const tds2 = c.querySelectorAll('td:not(.next-month):not(.prev-month)');
    for (const td of tds2) {
      if (parseInt(td.querySelector('span')?.textContent?.trim(), 10) === day) { td.click(); return; }
    }
  }, startDay);
  await sleep(1200);

  // ── 点 END 单元格 ──
  // 单日范围（start===end）：end 直接在左日历点同一天（点完 start 后 element-ui 仍允许在同面板点 end）
  const endDay = end.getDate();
  const isSingleDay = startStr === endStr;
  let endClicked = false;

  if (isSingleDay) {
    // 左日历已经在 startMonth，直接在左日历点 endDay（与 startDay 同一天）
    endClicked = await page.evaluate((day) => {
      const c = document.querySelectorAll('.el-date-range-picker__content')[0];
      const tds = c.querySelectorAll('td.available');
      for (const td of tds) {
        if (parseInt(td.querySelector('span')?.textContent?.trim(), 10) === day) { td.click(); return true; }
      }
      return false;
    }, endDay);
  }

  const rightHeader = endClicked ? null : await page.evaluate(() =>
    document.querySelectorAll('.el-date-range-picker__content')[1]?.querySelector('.el-date-range-picker__header')?.textContent?.trim()
  );
  if (rightHeader === endMonth) {
    endClicked = await page.evaluate((day) => {
      const c = document.querySelectorAll('.el-date-range-picker__content')[1];
      const tds = c.querySelectorAll('td.available');
      for (const td of tds) {
        if (parseInt(td.querySelector('span')?.textContent?.trim(), 10) === day) { td.click(); return true; }
      }
      return false;
    }, endDay);
  }
  if (!endClicked) {
    let navSafety = 0;
    while (navSafety++ < 24) {
      const rh = await page.evaluate(() =>
        document.querySelectorAll('.el-date-range-picker__content')[1]?.querySelector('.el-date-range-picker__header')?.textContent?.trim()
      );
      if (rh === endMonth) break;
      await page.evaluate(() => {
        const right = document.querySelectorAll('.el-date-range-picker__content')[1];
        const singleRight = right.querySelector('.el-icon-arrow-right');
        if (singleRight) (singleRight.closest('button') || singleRight).click();
      });
      await sleep(400);
    }
    endClicked = await page.evaluate((day) => {
      const c = document.querySelectorAll('.el-date-range-picker__content')[1];
      const tds = c.querySelectorAll('td.available');
      for (const td of tds) {
        if (parseInt(td.querySelector('span')?.textContent?.trim(), 10) === day) { td.click(); return true; }
      }
      return false;
    }, endDay);
  }
  await sleep(500);

  // 校验：读回 range input 的值（兼容 - 和 / 两种分隔符）
  const finalInput = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.el-range-editor input.el-range-input')).map(i => i.value)
  );
  console.log(`  📅 日期范围已设: ${finalInput.join(' ~ ')}`);
  const norm = s => String(s || '').replace(/[-/]/g, '');
  const ok = finalInput.length >= 2 && norm(finalInput[0]) === norm(startStr) && norm(finalInput[1]) === norm(endStr);
  if (!ok) {
    throw new Error(`日期设置失败: 实际 [${finalInput.join(',')}] ≠ 目标 ${startStr}~${endStr}`);
  }
}

async function main() {
  // 支持 --backfill 等价于 --days 30
  if (args.includes('--backfill')) days = 30;

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log(`🚀 慧经营数据同步开始（${days} 天）`);
  console.log(`   目标: 提取 ${dateStr(-1)} ~ ${dateStr(-days)} 的利润数据`);

  // ── 优先 CDP 复用已登录的 Chrome（不启动新 Chrome，不抢焦点）──
  let browser = null;
  let page = null;
  let usingCdp = false;

  const cdpOnline = await checkCdp(CONFIG.cdpPort);
  if (cdpOnline) {
    console.log(`🔌 CDP 9222 在线，尝试复用已登录的 Chrome...`);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CONFIG.cdpPort}`);
      // 找已打开的 hjy.huice.com 标签页
      const contexts = browser.contexts();
      let hjyPage = null;
      for (const ctx of contexts) {
        for (const p of ctx.pages()) {
          if (p.url().includes('hjy.huice.com')) { hjyPage = p; break; }
        }
        if (hjyPage) break;
      }
      if (hjyPage) {
        page = hjyPage;
        usingCdp = true;
        console.log(`✅ 复用已登录的慧经营标签页: ${page.url().slice(0, 60)}`);
        // 确保在 CommodityAnalysis 页
        if (!page.url().includes('CommodityAnalysis')) {
          await page.evaluate(() => { location.hash = '#/opertData/CommodityAnalysis'; });
          await page.waitForTimeout(3000);
        }
      } else {
        console.log(`⚠️ CDP 在线但没有 hjy.huice.com 标签页，fallback 到 launchPersistentContext`);
        await browser.close();
        browser = null;
      }
    } catch (e) {
      console.log(`⚠️ CDP 连接失败: ${e.message}，fallback 到 launchPersistentContext`);
      browser = null;
    }
  }

  // ── Fallback: launchPersistentContext（headless，需要 private/huice-profile 已登录）──
  if (!browser) {
    if (!existsSync(PROFILE_DIR)) {
      console.log(`❌ 慧经营 profile 不存在: ${PROFILE_DIR}`);
      console.log('   首次使用需手动登录一次慧经营，cookies 会自动保存到该 profile');
      console.log('   或在 CDP Chrome（9222 端口）打开 hjy.huice.com 并登录后重试');
      process.exit(1);
    }
    console.log(`🌐 启动 headless Chrome（profile: ${PROFILE_DIR}）...`);
    browser = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      executablePath: CHROME_PATH,
      viewport: { width: 1600, height: 900 },
      locale: 'zh-CN',
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-gpu'],
    });
    await browser.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    }).catch(() => {});
    page = browser.pages()[0] || await browser.newPage();

    console.log('🌐 打开慧经营商品排名页...');
    await page.goto(CONFIG.targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);

    const currentUrl = page.url();
    const needLogin = /login|signin/i.test(currentUrl) || await page.locator('input[type="password"]').isVisible({ timeout: 2000 }).catch(() => false);
    if (needLogin) {
      console.log('⚠️ cookies 已过期或未登录，请在 CDP Chrome 登录慧经营后重试');
      console.log('   或用 --headed 参数手动登录');
      await browser.close();
      process.exit(1);
    }
    console.log('✅ 已登录（cookies 有效）');
  }

  const allRecords = [];

  for (let offset = 1; offset <= days; offset++) {
    const targetDate = dateStr(-offset);
    console.log(`\n📅 [${offset}/${days}] 采集 ${targetDate}...`);

    // 切日期到 targetDate（单日范围）
    // 用 input.value 方式（比 setDateRange 面板点击快且稳）
    const setDateResult = await page.evaluate((dateStr) => {
      const inputs = [...document.querySelectorAll('input')];
      const startInput = inputs.find(i => i.placeholder === '开始日期' || i.placeholder.includes('开始'));
      const endInput = inputs.find(i => i.placeholder === '结束日期' || i.placeholder.includes('结束'));
      if (!startInput || !endInput) return { ok: false, error: 'no date inputs' };

      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(startInput, dateStr);
      startInput.dispatchEvent(new Event('input', { bubbles: true }));
      startInput.dispatchEvent(new Event('change', { bubbles: true }));
      setter.call(endInput, dateStr);
      endInput.dispatchEvent(new Event('input', { bubbles: true }));
      endInput.dispatchEvent(new Event('change', { bubbles: true }));

      // 点查询按钮
      const btn = [...document.querySelectorAll('button, .el-button')].find(b =>
        (b.innerText || '').trim() === '查询' || (b.innerText || '').trim() === '搜索'
      );
      if (btn) btn.click();
      return { ok: true, start: startInput.value, end: endInput.value, queried: !!btn };
    }, targetDate);

    if (!setDateResult.ok) {
      console.log(`  ⚠ 切日期失败: ${setDateResult.error}`);
      continue;
    }
    // 等待数据加载
    await page.waitForTimeout(3000);

    // 提取表格
    const records = await page.evaluate(extractHuiceFromDOM, targetDate);
    if (records.length > 0) {
      allRecords.push(...records);
      console.log(`  ✅ ${records.length} 条记录 (netProfit 有值: ${records.filter(r => r.netProfit != null).length})`);
      // 落盘备份
      writeFileSync(path.join(OUTPUT_DIR, `${targetDate.replace(/-/g, '')}.json`), JSON.stringify({ date: targetDate, records }, null, 2));
    } else {
      console.log(`  ⚠️ 无数据（可能当天无销售或表格未加载）`);
    }
  }

  // 落盘汇总
  const summaryFile = path.join(OUTPUT_DIR, 'huice-latest.json');
  writeFileSync(summaryFile, JSON.stringify(allRecords, null, 2));
  console.log(`\n💾 数据落盘: ${summaryFile} (${allRecords.length} 条)`);

  // CDP 模式只断开连接，不关 Chrome；launchPersistentContext 模式才 close
  if (usingCdp) {
    try { await browser.close(); } catch {}  // connectOverCDP 的 close 只是断开
  } else {
    await browser.close();
  }

  // 入库 SQLite(商品级归档,双写架构:SQLite 归档 + storage 注入报表)
  let sqliteInserted = 0;
  if (allRecords.length > 0) {
    try {
      const { bulkUpsertProductProfit, getDbPath } = await import('./huice/lib/db.mjs');
      sqliteInserted = bulkUpsertProductProfit(allRecords);
      console.log(`📦 SQLite 入库 ${sqliteInserted} 条 → ${getDbPath()} (product_profit)`);
    } catch (e) {
      console.log(`⚠️ SQLite 入库失败(不影响 storage 注入): ${e.message}`);
    }
  }

  // 写入 dts 扩展 storage
  console.log('\n📤 写入店透视扩展 storage...');
  await writeToDtsStorage(allRecords);

  console.log('\n✅ 同步完成！打开商品报表弹窗即可看到净利润数据');
}

main().catch(e => {
  console.error('❌ 失败:', e.message);
  process.exit(1);
});