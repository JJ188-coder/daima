#!/usr/bin/env node
/**
 * write-storage.mjs - 从 SQLite 读 30 天数据,写入 dts 扩展 chrome.storage.local
 *
 * 用法: node tools/write-storage.mjs [--days 30]
 */
import { getProductProfitByDate } from '../scripts/huice/lib/db.mjs';

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

async function main() {
  // 1. 找 dts 扩展 SW
  const tabs = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const swTab = tabs.find(t => t.type === 'service_worker' && t.url.includes('chrome-extension'));
  if (!swTab) { console.error('❌ 没找到 dts 扩展 SW'); process.exit(1); }

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
      costPrice: r.cost_price ?? null,
      refundAmount: r.refund_amount ?? null,
      refundRate: r.refund_rate ?? null,
      netProfit: r.net_profit ?? null,
      netProfitRate: r.net_profit_rate ?? null,
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
