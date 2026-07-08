#!/usr/bin/env node
// 从 CDP Chrome 9222 导出当前所有 cookies + localStorage 到 private/huice-state.json
// 用法: node tools/export-huice-state.mjs
const fs = await import('node:fs/promises');
const path = await import('node:path');

const TARGET_SUBSTR = 'hjy.huice.com';
const STATE_FILE = path.resolve(process.cwd(), 'private/huice-state.json');

async function main() {
  // 1. 找 hjy.huice.com 标签页
  const listRes = await fetch('http://127.0.0.1:9222/json/list');
  const tabs = await listRes.json();
  const target = tabs.find(t => t.type === 'page' && t.url.includes(TARGET_SUBSTR));
  if (!target) {
    console.error('❌ 没找到 hjy.huice.com 标签页');
    process.exit(1);
  }
  console.error(`🎯 目标: ${target.url}`);

  // 2. 连 WS
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

  // 3. 用 Network.getAllCookies 拿所有 cookies
  const cookiesRes = await send('Network.getAllCookies', {});
  const cookies = cookiesRes.result?.cookies || [];
  console.error(`🍪 拿到 ${cookies.length} 个 cookies`);

  // 4. 读 localStorage（通过 Runtime.evaluate）
  const lsRes = await send('Runtime.evaluate', {
    expression: '(() => { const o = {}; for (let i=0; i<localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return JSON.stringify(o); })()',
    returnByValue: true
  });
  const localStorage = JSON.parse(lsRes.result?.result?.value || '{}');
  console.error(`📦 拿到 ${Object.keys(localStorage).length} 个 localStorage 项`);

  ws.close();

  // 5. 转 Playwright storageState 格式
  const state = {
    cookies: cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: c.expires || -1,
      httpOnly: c.httpOnly || false,
      secure: c.secure || false,
      sameSite: c.sameSite || 'Lax',
    })),
    origins: [{
      origin: 'https://hjy.huice.com',
      localStorage: Object.entries(localStorage).map(([name, value]) => ({ name, value: String(value) }))
    }]
  };

  // 6. 写文件
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`✅ storageState 已导出: ${STATE_FILE}`);
  console.log(`   cookies: ${cookies.length}, localStorage: ${Object.keys(localStorage).length}`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
