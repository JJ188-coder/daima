#!/usr/bin/env node
// CDP 注入:在 hjy.huice.com 页面跑 extractHuiceFromDOM,把结果写入 dts 扩展的 chrome.storage.local
// 数据流:慧经营页 extractHuiceFromDOM → CDP WS 传回 Node → Node 再通过 CDP 注入到 mms 标签页写 storage
//
// 用法: node tools/inject-huice-data.mjs <date>
const TARGET_DATE = process.argv[2] || new Date(Date.now() - 86400000).toISOString().slice(0,10);

async function main() {
  // 1. 在 hjy.huice.com 页面跑 extractHuiceFromDOM 提取数据
  console.error(`📅 采集日期: ${TARGET_DATE}`);
  console.error('📊 在慧经营页提取数据...');

  const hjyTabs = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const hjyTab = hjyTabs.find(t => t.type === 'page' && t.url.includes('hjy.huice.com'));
  if (!hjyTab) { console.error('❌ 没找到 hjy.huice.com 标签页'); process.exit(1); }

  const wsHjy = new WebSocket(hjyTab.webSocketDebuggerUrl);
  await new Promise((r, rej) => { wsHjy.addEventListener('open', r); wsHjy.addEventListener('error', rej); setTimeout(rej, 5000); });

  const extractJS = `(() => {
    const records = [];
    const useDate = "${TARGET_DATE}";
    const grids = document.querySelectorAll('.ag-root');
    grids.forEach(grid => {
      const pinnedRows = Array.from(grid.querySelectorAll('.ag-pinned-left-cols-container .ag-row'));
      const centerRows = Array.from(grid.querySelectorAll('.ag-center-cols-container .ag-row'));
      if (!pinnedRows.length && !centerRows.length) return;
      const maxLen = Math.max(pinnedRows.length, centerRows.length);
      for (let i = 0; i < maxLen; i++) {
        const pinned = pinnedRows[i] ? Array.from(pinnedRows[i].querySelectorAll('.ag-cell')).map(c => (c.textContent || '').trim()) : [];
        const center = centerRows[i] ? Array.from(centerRows[i].querySelectorAll('.ag-cell')) : [];
        const shopName = pinned[1] || '';
        const productName = pinned[2] || '';
        const rawId = pinned[3] || '';
        const productId = rawId.replace(/\\D/g, '');
        if (!productId) continue;
        const byColId = {};
        for (const cell of center) {
          const colId = cell.getAttribute('col-id') || cell.getAttribute('colId') || '';
          if (colId) byColId[colId] = (cell.textContent || '').trim();
        }
        const parseNum = (v) => { const n = parseFloat(String(v || '').replace(/,/g, '').replace(/%/g, '')); return isNaN(n) ? null : n; };
        const parsePct = (v) => { const n = parseNum(v); return n != null ? n / 100 : null; };
        records.push({
          productId, productName, shopName,
          salesAmount: parseNum(byColId.receivableAmount),
          salesQuantity: parseNum(byColId.payQty),
          costPrice: parseNum(byColId.costAmount),
          refundAmount: parseNum(byColId.refundAmount),
          refundRate: parsePct(byColId.refundRateString),
          netProfit: parseNum(byColId.netProfit),
          netProfitRate: parsePct(byColId.netInterestString),
          date: useDate, source: 'huice'
        });
      }
    });
    return JSON.stringify(records);
  })()`;

  const extractRes = await new Promise((resolve, reject) => {
    let id = 1;
    const handler = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === id) { wsHjy.removeEventListener('message', handler); resolve(msg); }
    };
    wsHjy.addEventListener('message', handler);
    wsHjy.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: extractJS, returnByValue: true } }));
    setTimeout(() => reject(new Error('extract 超时')), 15000);
  });

  wsHjy.close();

  const recordsJson = extractRes.result?.result?.value;
  if (!recordsJson) { console.error('❌ 提取失败:', JSON.stringify(extractRes.result)); process.exit(1); }
  const records = JSON.parse(recordsJson);
  console.error(`✅ 提取 ${records.length} 条记录`);
  console.error(`   netProfit 有值: ${records.filter(r => r.netProfit != null).length}/${records.length}`);

  // 2. 找 mms 标签页,通过 dts 扩展的 content script 写 storage
  const mmsTabs = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const mmsTab = mmsTabs.find(t => t.type === 'page' && t.url.includes('mms.pinduoduo.com'));
  if (!mmsTab) { console.error('❌ 没找到 mms 标签页'); process.exit(1); }

  const wsMms = new WebSocket(mmsTab.webSocketDebuggerUrl);
  await new Promise((r, rej) => { wsMms.addEventListener('open', r); wsMms.addEventListener('error', rej); setTimeout(rej, 5000); });

  // mms 页跑在 MAIN world,__PDD_EM 已注入。用 swCall 写 storage。
  // 但 MAIN world 不能直接调 chrome.storage,要走 content_scripts.js 桥接。
  // 最稳:直接通过 chrome.runtime.sendMessage 给扩展 SW,SW 写 storage。
  // 但 CDP 注入的 JS 跑在 page context,没有 chrome.runtime 权限。
  // 换路:找扩展的 service_worker,通过 SW 的 action handler 写 storage。
  console.error('💾 写入 dts 扩展 storage...');

  // 扩展 SW 标签页
  const swTabs = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const swTab = swTabs.find(t => t.type === 'service_worker' && t.url.includes('service_worker.js') && t.url.includes('chrome-extension'));
  if (!swTab) { console.error('❌ 没找到 dts 扩展 service worker'); process.exit(1); }

  const wsSw = new WebSocket(swTab.webSocketDebuggerUrl);
  await new Promise((r, rej) => { wsSw.addEventListener('open', r); wsSw.addEventListener('error', rej); setTimeout(rej, 5000); });

  // SW 里有 chrome.storage.local 权限,直接写
  const storageKey = `pdd_huice_window_${TARGET_DATE}`;
  const writeJS = `chrome.storage.local.set({ '${storageKey}': ${JSON.stringify(records).replace(/'/g, "\\'")} }).then(() => 'OK').catch(e => 'ERR:' + e.message)`;

  const writeRes = await new Promise((resolve, reject) => {
    let id = 2;
    const handler = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === id) { wsSw.removeEventListener('message', handler); resolve(msg); }
    };
    wsSw.addEventListener('message', handler);
    wsSw.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: writeJS, returnByValue: true, awaitPromise: true } }));
    setTimeout(() => reject(new Error('write 超时')), 10000);
  });

  wsSw.close();

  const writeResult = writeRes.result?.result?.value;
  if (writeResult === 'OK') {
    console.log(`✅ 数据已写入 chrome.storage.local`);
    console.log(`   key: ${storageKey}`);
    console.log(`   records: ${records.length}`);
    console.log(`   含 netProfit: ${records.filter(r => r.netProfit != null).length}`);
  } else {
    console.error('❌ 写入失败:', writeResult, JSON.stringify(writeRes.result));
    process.exit(1);
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
