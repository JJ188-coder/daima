#!/usr/bin/env node
/**
 * write-storage.mjs - 从 SQLite 读最近 N 天数据,写入 dts 扩展 chrome.storage.local
 *
 * 用法: node tools/write-storage.mjs [--days 7]
 */
import { getProductProfitByDate } from '../scripts/huice/lib/db.mjs';
import { DEFAULT_WAKEUP_URL, selectWakeupPageTabs } from '../scripts/huice/lib/sw-wakeup.mjs';

const args = process.argv.slice(2);
let days = 30;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i+1]) { days = parseInt(args[i+1]); i++; }
}

function dateStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`CDP request failed: ${res.status}`);
  return res.json();
}

async function cdpCommand(wsUrl, method, params = {}, timeoutMs = 5000) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
    setTimeout(() => reject(new Error('CDP websocket open timeout')), timeoutMs);
  });

  try {
    return await new Promise((resolve, reject) => {
      const id = 1;
      const timer = setTimeout(() => reject(new Error('CDP command timeout')), timeoutMs);
      const handler = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id !== id) return;
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        if (msg.error) reject(new Error(msg.error.message || 'CDP command failed'));
        else resolve(msg.result);
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });
  } finally {
    ws.close();
  }
}

async function findSw() {
  const tabs = await fetchJson('http://127.0.0.1:9222/json/list');
  return tabs.find(t => t.type === 'service_worker' && t.url.includes('chrome-extension'));
}

async function openTemporaryWakeupPage() {
  const target = await fetchJson(`http://127.0.0.1:9222/json/new?${encodeURIComponent(DEFAULT_WAKEUP_URL)}`, { method: 'PUT' });
  if (!target?.webSocketDebuggerUrl) return null;
  try {
    await cdpCommand(target.webSocketDebuggerUrl, 'Page.enable');
    await sleep(1500);
  } catch {}
  return target;
}

async function closeTemporaryWakeupPage(target) {
  if (!target?.id) return;
  try {
    await fetch(`http://127.0.0.1:9222/json/close/${encodeURIComponent(target.id)}`);
  } catch {}
}

async function wakeSwWithoutReloadingUserPages() {
  const tabs = await fetchJson('http://127.0.0.1:9222/json/list');
  const businessTabs = selectWakeupPageTabs(tabs);
  if (businessTabs.length > 0) {
    console.log(`ℹ️ 检测到 ${businessTabs.length} 个业务页面,不刷新用户页面,改用临时页面唤醒 SW`);
  }

  const tempTarget = await openTemporaryWakeupPage();
  try {
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      const swTab = await findSw();
      if (swTab) return swTab;
    }
    return null;
  } finally {
    await closeTemporaryWakeupPage(tempTarget);
  }
}

async function main() {
  // 0. 检查 CDP Chrome 是否在线,不在线则重试 3 次
  let cdpOnline = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(3000) });
      if (r.ok) { cdpOnline = true; break; }
    } catch {}
    if (attempt < 3) {
      console.error(`⚠️ CDP Chrome 不在线,${attempt}/3,10 秒后重试...`);
      await sleep(10000);
    }
  }
  if (!cdpOnline) {
    console.error('❌ CDP Chrome 9222 不在线,数据保留在 SQLite,下次运行时会写入');
    console.error('   请启动 CDP Chrome: /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --user-data-dir=~/.chrome-cdp-profile --remote-debugging-port=9222 --enable-extensions --load-extension=~/Documents/daima/dts');
    process.exit(1);
  }

  let swTab = await findSw();

  if (!swTab) {
    console.log('⚠️ 扩展 SW 不在线,打开临时页面触发唤醒...');
    swTab = await wakeSwWithoutReloadingUserPages();
    if (swTab) {
      console.log('✅ SW 已唤醒');
    }
  }

  if (!swTab) {
    console.error('❌ 没找到 dts 扩展 SW（扩展可能未加载）');
    console.error('   数据保留在 SQLite,下次运行时会写入');
    console.error('   请检查 CDP Chrome 是否加载了 dts 扩展');
    process.exit(1);
  }

  const ws = new WebSocket(swTab.webSocketDebuggerUrl);
  await new Promise((r, rej) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', rej, { once: true }); setTimeout(rej, 5000); });
  console.log(`✅ 连接 dts SW`);

  let id = 1;
  const cdpEval = (expression) => new Promise((resolve, reject) => {
    const curId = id++;
    const handler = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === curId) { ws.removeEventListener('message', handler); resolve(msg.result?.result?.value); }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id: curId, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    setTimeout(() => { ws.removeEventListener('message', handler); reject(new Error('timeout')); }, 15000);
  });

  // 2. 逐天读 SQLite -> 写 storage
  let totalWritten = 0;
  for (let offset = 1; offset <= days; offset++) {
    const targetDate = dateStr(-offset);
    const records = getProductProfitByDate(targetDate);
    if (records.length === 0) {
      console.log(`  ⚠ ${targetDate}: 无数据,跳过`);
      continue;
    }

    // 转 pdd-enhancer.js 期望的格式
    const formatted = records.map(r => ({
      productId: String(r.product_id),
      productName: r.product_name || '',
      shopName: r.shop_name || '',
      salesAmount: r.sales_amount ?? null,
      salesQuantity: r.sales_quantity ?? null,
      orderCount: r.order_count ?? r.sales_quantity ?? null,
      costPrice: r.cost_price ?? null,
      grossProfit: r.gross_profit ?? null,
      grossProfitRate: r.gross_profit_rate ?? null,
      refundAmount: r.refund_amount ?? null,
      refundRate: r.refund_rate ?? null,
      rawNetProfit: r.raw_net_profit ?? null,
      rawNetProfitRate: r.raw_net_profit_rate ?? null,
      netProfit: r.net_profit ?? null,
      netProfitRate: r.net_profit_rate ?? null,
      orderFixedCost: r.order_fixed_cost ?? null,
      platformFee: r.platform_fee ?? null,
      platformFeeRate: r.platform_fee_rate ?? null,
      orderFixedUnitCost: r.order_fixed_unit_cost ?? null,
      profitFormulaVersion: r.profit_formula_version ?? null,
      date: targetDate,
      source: 'huice-export'
    }));

    // 写 storage
    const key = `pdd_huice_window_${targetDate}`;
    const dataJson = JSON.stringify(formatted).replace(/'/g, "\\'");
    const result = await cdpEval(`chrome.storage.local.set({ '${key}': ${dataJson} }).then(() => 'OK').catch(e => 'ERR:' + e.message)`);

    if (result === 'OK') {
      const npCount = formatted.filter(r => r.netProfit != null).length;
      console.log(`  ✓ ${targetDate}: ${formatted.length} 条 (netProfit: ${npCount})`);
      totalWritten += formatted.length;
    } else {
      console.log(`  ✗ ${targetDate}: ${result}`);
    }
    await sleep(200);
  }

  ws.close();
  console.log(`\n✅ 共写入 ${totalWritten} 条到 dts storage`);

  // 3. 验证:读回 storage 里的 huice key 数
  const ws2 = new WebSocket(swTab.webSocketDebuggerUrl);
  await new Promise((r, rej) => { ws2.addEventListener('open', r, { once: true }); ws2.addEventListener('error', rej, { once: true }); setTimeout(rej, 5000); });
  const verify = await new Promise((resolve) => {
    const curId = id++;
    const handler = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === curId) { ws2.removeEventListener('message', handler); resolve(msg.result?.result?.value); }
    };
    ws2.addEventListener('message', handler);
    ws2.send(JSON.stringify({ id: curId, method: 'Runtime.evaluate', params: { expression: `chrome.storage.local.get(null).then(d => { const keys = Object.keys(d).filter(k => k.includes('huice')); return JSON.stringify({ huiceKeys: keys.length, sampleKeys: keys.slice(0, 5) }); })`, returnByValue: true, awaitPromise: true } }));
    setTimeout(() => resolve(null), 10000);
  });
  ws2.close();
  if (verify) console.log(`📋 storage 验证: ${verify}`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
