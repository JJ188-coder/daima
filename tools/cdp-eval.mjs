#!/usr/bin/env node
// CDP WS 注入工具 — 用 Node 22+ 内置全局 WebSocket（不依赖 ws 包）
// 用法: node cdp-eval.mjs <url-substr> '<JS>'
// 教训来源: memory/mistakes.md [2026-06-26] Node 22+ 内置 WebSocket

const TARGET_SUBSTR = process.argv[2] || 'mms.pinduoduo';
const JS_CODE = process.argv[3] || '({url: location.href, title: document.title})';

async function main() {
  const listRes = await fetch('http://127.0.0.1:9222/json/list');
  const tabs = await listRes.json();
  const target = tabs.find(t => t.type === 'page' && t.url.includes(TARGET_SUBSTR));
  if (!target) {
    console.error(`❌ 没找到 URL 含 "${TARGET_SUBSTR}" 的标签页`);
    console.error('当前 page 标签页:');
    tabs.filter(t => t.type === 'page').forEach(t => console.error(`  ${t.url}`));
    process.exit(1);
  }
  console.error(`🎯 目标: ${target.url}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 1;

  const result = await new Promise((resolve, reject) => {
    const onOpen = () => {
      ws.send(JSON.stringify({
        id: msgId,
        method: 'Runtime.evaluate',
        params: {
          expression: JS_CODE,
          returnByValue: true,
          awaitPromise: true,
        }
      }));
    };
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === msgId) {
        ws.removeEventListener('message', onMessage);
        resolve(msg);
      }
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', (e) => reject(new Error('WS 错误: ' + (e.message || 'unknown'))));
    setTimeout(() => reject(new Error('CDP 响应超时 10s')), 10000);
  });

  ws.close();

  if (result.result?.result?.value !== undefined) {
    const val = result.result.result.value;
    if (typeof val === 'string') console.log(val);
    else console.log(JSON.stringify(val, null, 2));
  } else if (result.result?.exceptionDetails) {
    console.error('❌ JS 异常:', JSON.stringify(result.result.exceptionDetails, null, 2));
    process.exit(2);
  } else {
    console.log(JSON.stringify(result.result, null, 2));
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
