#!/usr/bin/env node
// CDP 刷新页面 + 轮询等浮层出现
const TARGET_SUBSTR = process.argv[2] || 'goods_list';
const WAIT_SEC = parseInt(process.argv[3] || '30');

async function main() {
  const listRes = await fetch('http://127.0.0.1:9222/json/list');
  const tabs = await listRes.json();
  const target = tabs.find(t => t.type === 'page' && t.url.includes(TARGET_SUBSTR));
  if (!target) { console.error('❌ 没找到标签页'); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 1;
  const send = (method, params={}) => new Promise((resolve, reject) => {
    const id = msgId++;
    const handler = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === id) { ws.removeEventListener('message', handler); resolve(msg); }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => reject(new Error(`${method} 超时`)), 10000);
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
    setTimeout(() => reject(new Error('WS 连接超时')), 5000);
  });

  // 1. 刷新页面
  console.error('🔄 刷新页面...');
  await send('Page.reload', { ignoreCache: false });

  // 2. 轮询等浮层
  for (let i = 0; i < WAIT_SEC; i += 2) {
    await new Promise(r => setTimeout(r, 2000));
    const r = await send('Runtime.evaluate', {
      expression: '(() => ({ hasToolBox: !!document.querySelector(".sycmToolBox, .dts-entry, [class*=plugins-entry]"), hasPddEm: typeof window.__PDD_EM_V7__ !== "undefined", ready: document.readyState }))()',
      returnByValue: true
    });
    const v = r.result?.result?.value || {};
    console.error(`  [${i}s] ready=${v.ready} pddEm=${v.hasPddEm} toolBox=${v.hasToolBox}`);
    if (v.hasToolBox) {
      console.log(JSON.stringify({ success: true, waitedSec: i, state: v }));
      ws.close();
      return;
    }
  }
  console.log(JSON.stringify({ success: false, waitedSec: WAIT_SEC, state: v }));
  ws.close();
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });
