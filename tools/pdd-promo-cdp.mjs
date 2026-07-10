#!/usr/bin/env node
/**
 * pdd-promo-cdp.mjs - 从拼多多推广平台读取每日推广费,更新到 shop_daily_profit
 *
 * 流程（每天）:
 *   1. 导航到 yingxiao 推广平台
 *   2. 切日期到单日（点 .anq-picker 打开日历,点日期两次）
 *   3. 读界面数字: 成交营销花费/交易额/实际投产比
 *   4. 更新 shop_daily_profit 表的 promo_spend/roi 字段
 *
 * 用法:
 *   node tools/pdd-promo-cdp.mjs --days 30
 *   node tools/pdd-promo-cdp.mjs --dates 2026-07-09,2026-07-08
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DB_PATH = resolve(ROOT, 'private/huice-data.sqlite');
const PROMO_URL = 'https://yingxiao.pinduoduo.com/goods/report/promotion/overView';

const args = process.argv.slice(2);
let days = 1;
let customDates = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i+1]) { days = parseInt(args[i+1]); i++; }
  if (args[i] === '--dates' && args[i+1]) { customDates = args[i+1].split(','); i++; }
}

function dateStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cdpCall(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1000000);
    const handler = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id === id) { ws.removeEventListener('message', handler); resolve(msg); }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.removeEventListener('message', handler); reject(new Error(`${method} 超时`)); }, 30000);
  });
}

async function cdpEval(ws, expression) {
  const res = await cdpCall(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return res.result?.result?.value;
}

/** 切日期到单日 - 点 .anq-picker 打开日历,翻月,点日期两次 */
async function setSingleDate(ws, targetDate) {
  const [year, month, day] = targetDate.split('-').map(Number);
  const targetDateSlash = `${year}/${String(month).padStart(2,'0')}/${String(day).padStart(2,'0')}`;
  const targetYearMonth = `${year}年${month}月`;

  // 0. 关闭旧面板
  await cdpEval(ws, `document.body.click()`);
  await sleep(300);

  // 1. 点 .anq-picker 打开日历
  await cdpEval(ws, `(() => {
    const picker = document.querySelector('.anq-picker');
    if (picker) { picker.click(); return 'ok'; }
    return 'no picker';
  })()`);
  await sleep(1500);

  // 2. 翻月到目标月(面板文字含"2026年7月")
  for (let attempt = 0; attempt < 12; attempt++) {
    const found = await cdpEval(ws, `(() => {
      const dropdown = document.querySelector('.anq-picker-dropdown');
      if (!dropdown) return 'no dropdown';
      return (dropdown.innerText || '').includes('${targetYearMonth}') ? 'found' : 'not found';
    })()`);
    if (found === 'found') break;

    // 翻月: 找箭头按钮
    await cdpEval(ws, `(() => {
      const dropdown = document.querySelector('.anq-picker-dropdown');
      if (!dropdown) return 'no dropdown';
      // 找左箭头(上个月)
      const arrows = [...dropdown.querySelectorAll('[class*=arrow], [class*=prev], [class*=next], button')];
      const leftArrow = arrows.find(a => a.offsetParent !== null && /left|prev|arrow-left/i.test(a.className || ''));
      if (leftArrow) { leftArrow.click(); return 'prev'; }
      // 也试 class 含 icon 的
      const icons = [...dropdown.querySelectorAll('[class*=icon-arrow-left], [class*=left]')];
      const icon = icons.find(a => a.offsetParent !== null);
      if (icon) { icon.click(); return 'prev icon'; }
      return 'no arrow';
    })()`);
    await sleep(600);
  }

  // 3. 点目标日期两次
  for (let click = 0; click < 2; click++) {
    await cdpEval(ws, `(() => {
      const dropdown = document.querySelector('.anq-picker-dropdown');
      if (!dropdown) return 'no dropdown';
      const tds = [...dropdown.querySelectorAll('td')];
      // 找目标日: 文字匹配,不是 disabled/prev/next
      let dayCell = tds.find(td => td.textContent.trim() === '${day}' && !td.classList.contains('disabled') && !td.classList.contains('prev') && !td.classList.contains('next'));
      if (!dayCell) dayCell = tds.find(td => td.textContent.trim() === '${day}');
      if (!dayCell) return 'no day ${day}';
      dayCell.click();
      return 'clicked ${day}';
    })()`);
    await sleep(800);
  }

  // 4. 关面板
  await cdpEval(ws, `document.body.click()`);
  await sleep(300);

  // 5. 验证日期
  const dateVal = await cdpEval(ws, `(() => {
    const inputs = [...document.querySelectorAll('input')];
    const start = inputs.find(i => i.placeholder === '开始日期')?.value;
    const end = inputs.find(i => i.placeholder === '结束日期')?.value;
    return JSON.stringify({ start, end });
  })()`);
  return dateVal ? JSON.parse(dateVal) : { start: null, end: null };
}

/** 从页面读推广费数据 */
async function readPromoData(ws) {
  const result = await cdpEval(ws, `(() => {
    const els = [...document.querySelectorAll('*')];
    function findVal(label) {
      const label2 = els.find(el => (el.innerText || '').trim() === label);
      if (!label2) return null;
      let p = label2.parentElement;
      for (let i = 0; i < 5 && p; i++) {
        const nums = [...p.querySelectorAll('*')].filter(el => el.children.length === 0 && /^[\\d,.]+$/.test((el.innerText||'').trim()));
        if (nums.length > 0) return parseFloat(nums[0].innerText.trim().replace(/,/g, ''));
        p = p.parentElement;
      }
      return null;
    }
    // 读店铺名
    const shopMatch = (document.body.innerText || '').match(/([\u4e00-\u9fa5\w]+(?:专营店|旗舰店|专卖店))/);
    return JSON.stringify({
      promoSpend: findVal('成交营销花费(元)'),
      gmv: findVal('交易额(元)'),
      roi: findVal('实际投产比'),
      shopName: shopMatch ? shopMatch[1] : '',
    });
  })()`);
  return result ? JSON.parse(result) : null;
}

/** 更新 shop_daily_profit 的推广费字段 */
function updatePromoSpend(date, promoData) {
  if (!existsSync(DB_PATH)) return false;
  const db = new Database(DB_PATH);

  const pddShopName = promoData.shopName || '';
  let shopRow = null;
  if (pddShopName) {
    const cleaned = pddShopName.replace(/(食品|零食|专营|旗舰|专卖|官方|总动员|大卖场|卖场|专营店|旗舰店|专卖店|店|铺)/g, '').trim();
    const keyword = cleaned.slice(0, 2);
    if (keyword) {
      shopRow = db.prepare("SELECT shop_id, huice_name FROM shops WHERE huice_name LIKE ? AND huice_name LIKE '拼%' ORDER BY LENGTH(huice_name) ASC LIMIT 1").get('%' + keyword + '%');
    }
  }

  if (!shopRow) { db.close(); return false; }

  const result = db.prepare(`
    UPDATE shop_daily_profit SET promo_spend = ?, roi = ? WHERE shop_id = ? AND date = ?
  `).run(promoData.promoSpend ?? null, promoData.roi ?? null, shopRow.shop_id, date);

  db.close();
  return result.changes > 0;
}

async function main() {
  if (!existsSync(DB_PATH)) { console.error('❌ 数据库不存在:', DB_PATH); process.exit(1); }

  const dateList = customDates.length > 0
    ? customDates.sort()
    : Array.from({ length: days }, (_, i) => dateStr(-(i + 1)));

  console.log(`🚀 拼多多推广费采集（${dateList.length} 天）`);
  console.log(`   日期范围: ${dateList[0]} ~ ${dateList[dateList.length - 1]}`);

  // 找拼多多推广平台标签页
  const tabs = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  let pddTab = tabs.find(t => t.type === 'page' && t.url.includes('yingxiao.pinduoduo.com'));

  if (!pddTab) {
    pddTab = tabs.find(t => t.type === 'page' && t.url.includes('pinduoduo.com'));
    if (pddTab) {
      const ws = new WebSocket(pddTab.webSocketDebuggerUrl);
      await new Promise((r, rej) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', rej, { once: true }); setTimeout(rej, 5000); });
      await cdpEval(ws, `location.href = "${PROMO_URL}"`);
      ws.close();
      await sleep(8000);
      const tabs2 = await (await fetch('http://127.0.0.1:9222/json/list')).json();
      pddTab = tabs2.find(t => t.type === 'page' && t.url.includes('yingxiao.pinduoduo.com'));
    }
  }

  if (!pddTab) { console.error('❌ 没找到拼多多推广平台标签页'); process.exit(1); }

  const ws = new WebSocket(pddTab.webSocketDebuggerUrl);
  await new Promise((r, rej) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', rej, { once: true }); setTimeout(rej, 5000); });
  console.log(`✅ CDP 已连接`);

  const failedDates = [];

  for (let i = 0; i < dateList.length; i++) {
    const targetDate = dateList[i];
    console.log(`\n📅 [${i + 1}/${dateList.length}] 采集 ${targetDate}...`);

    // 1. 切日期
    let dateOk = false;
    for (let retry = 0; retry < 3; retry++) {
      if (retry > 0) {
        console.log(`  🔄 重试 ${retry + 1}/3`);
        await cdpEval(ws, `location.href = "${PROMO_URL}"`);
        await sleep(5000);
      }
      const dateResult = await setSingleDate(ws, targetDate);
      const targetDateSlash = targetDate.replace(/-/g, '/');
      if (dateResult.start === targetDateSlash && dateResult.end === targetDateSlash) {
        dateOk = true;
        break;
      }
      console.log(`  ⚠ 日期切换失败(尝试 ${retry + 1}): ${JSON.stringify(dateResult)}`);
    }
    if (!dateOk) {
      console.log(`  ❌ 日期切换失败,跳过`);
      failedDates.push(targetDate);
      continue;
    }
    console.log(`  ✅ 日期已切换`);

    // 2. 等数据加载
    await sleep(3000);

    // 3. 读推广费
    const promo = await readPromoData(ws);
    if (!promo || promo.promoSpend == null) {
      console.log(`  ⚠️ 读不到推广费数据`);
      failedDates.push(targetDate);
      continue;
    }
    console.log(`  📊 推广费=¥${promo.promoSpend} 交易额=¥${promo.gmv} ROI=${promo.roi} 店铺=${promo.shopName}`);

    // 4. 入库
    const updated = updatePromoSpend(targetDate, promo);
    if (updated) {
      console.log(`  ✅ 已更新 shop_daily_profit`);
    } else {
      console.log(`  ⚠️ 未匹配到慧经营店铺,跳过`);
    }
  }

  ws.close();
  console.log(`\n✅ 完成`);
  if (failedDates.length > 0) {
    console.log(`⚠️ ${failedDates.length} 天失败: ${failedDates.join(', ')}`);
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
