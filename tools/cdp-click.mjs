#!/usr/bin/env node
// CDP 鼠标点击工具 - 用 Input.dispatchMouseEvent 在浏览器层面真实点击
// 用法: node tools/cdp-click.mjs <url-substr> <x> <y>
const TARGET_SUBSTR = process.argv[2] || 'hjy.huice';
const X = parseFloat(process.argv[3] || '0');
const Y = parseFloat(process.argv[4] || '0');

async function main() {
  const listRes = await fetch('http://127.0.0.1:9222/json/list');
  const tabs = await listRes.json();
  const target = tabs.find(t => t.type === 'page' && t.url.includes(TARGET_SUBSTR));
  if (!target) { console.error(`❌ 没找到标签页`); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, rej) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', rej, { once: true }); setTimeout(rej, 5000); });

  let id = 1;
  const send = (method, params) => new Promise((resolve, reject) => {
    const curId = id++;
    const handler = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === curId) { ws.removeEventListener('message', handler); resolve(msg); }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id: curId, method, params }));
    setTimeout(() => { ws.removeEventListener('message', handler); reject(new Error(`${method} 超时`)); }, 10000);
  });

  // 真实鼠标点击: mouseMoved -> mousePressed -> mouseReleased
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X, y: Y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: X, y: Y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: X, y: Y, button: 'left', clickCount: 1 });

  ws.close();
  console.log(`✅ 点击 (${X}, ${Y})`);
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });
