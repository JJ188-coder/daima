#!/usr/bin/env node
// 抓网络请求 + 点击下载
const WS_URL = process.argv[2];
const CLICK_X = parseFloat(process.argv[3] || '1169');
const CLICK_Y = parseFloat(process.argv[4] || '211');

const ws = new WebSocket(WS_URL);
let id = 1;
const requests = [];

const send = (method, params={}) => new Promise((resolve, reject) => {
  const curId = id++;
  const handler = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id === curId) { ws.removeEventListener('message', handler); resolve(msg); }
  };
  ws.addEventListener('message', handler);
  ws.send(JSON.stringify({ id: curId, method, params }));
  setTimeout(() => { ws.removeEventListener('message', handler); reject(new Error(`${method} 超时`)); }, 10000);
});

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === 'Network.requestWillBeSent') {
    const r = msg.params.request;
    requests.push({ url: r.url, method: r.method, type: r.type });
  }
});

await new Promise(r => ws.addEventListener('open', r, { once: true }));
await send('Network.enable');
await new Promise(r => setTimeout(r, 1000));

// CDP 真实点击
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: CLICK_X, y: CLICK_Y });
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: CLICK_X, y: CLICK_Y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: CLICK_X, y: CLICK_Y, button: 'left', clickCount: 1 });

await new Promise(r => setTimeout(r, 5000));
ws.close();

const interesting = requests.filter(r =>
  !r.url.includes('.css') && !r.url.includes('.js') && !r.url.includes('.png') &&
  !r.url.includes('.svg') && !r.url.includes('.woff') && !r.url.includes('favicon')
);
console.log(JSON.stringify(interesting, null, 2));
