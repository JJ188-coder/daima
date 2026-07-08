#!/usr/bin/env node
/**
 * huice-backfill-cdp.mjs - 通过 CDP 9222 批量回采慧经营数据
 *
 * 不依赖 playwright page.evaluate,直接用 CDP Runtime.evaluate 注入,
 * 跟手动验证时一样的方式,更稳定。
 *
 * 用法:
 *   node tools/huice-backfill-cdp.mjs --days 30   # 回采 30 天
 *   node tools/huice-backfill-cdp.mjs --days 1     # 采昨天
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bulkUpsertProductProfit, getDbPath, getProductProfitByDate } from '../scripts/huice/lib/db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.resolve(ROOT, 'output/huice-sync');

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

// CDP WebSocket 调用
async function cdpCall(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1000000);
    const handler = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id === id) {
        ws.removeEventListener('message', handler);
        resolve(msg);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.removeEventListener('message', handler); reject(new Error(`${method} 超时`)); }, 15000);
  });
}

async function cdpEval(ws, expression) {
  const res = await cdpCall(ws, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true
  });
  return res.result?.result?.value;
}

async function main() {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log(`🚀 慧经营 CDP 回采（${days} 天）`);
  console.log(`   日期范围: ${dateStr(-1)} ~ ${dateStr(-days)}`);

  // 1. 找 hjy.huice.com 标签页
  const tabs = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const hjyTab = tabs.find(t => t.type === 'page' && t.url.includes('hjy.huice.com'));
  if (!hjyTab) {
    console.error('❌ 没找到 hjy.huice.com 标签页,请先在 CDP Chrome 打开并登录慧经营');
    process.exit(1);
  }
  console.log(`✅ 找到慧经营标签页: ${hjyTab.url.slice(0, 60)}`);

  const ws = new WebSocket(hjyTab.webSocketDebuggerUrl);
  await new Promise((r, rej) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', rej, { once: true });
    setTimeout(rej, 5000);
  });
  console.log(`✅ CDP WebSocket 已连接`);

  // 确保在 CommodityAnalysis 页
  const curUrl = await cdpEval(ws, 'location.href');
  if (!curUrl.includes('CommodityAnalysis')) {
    await cdpEval(ws, 'location.hash = "#/opertData/CommodityAnalysis"');
    await sleep(4000);
  }

  const allRecords = [];

  for (let offset = 1; offset <= days; offset++) {
    const targetDate = dateStr(-offset);
    console.log(`\n📅 [${offset}/${days}] 采集 ${targetDate}...`);

    // 切日期（input.value 方式）
    // 关键:改 input 后要等 Vue 消化 change event,再点查询,否则查询用旧日期
    await cdpEval(ws, `(() => {
      const inputs = [...document.querySelectorAll('input')];
      const startInput = inputs.find(i => i.placeholder === '开始日期' || i.placeholder.includes('开始'));
      const endInput = inputs.find(i => i.placeholder === '结束日期' || i.placeholder.includes('结束'));
      if (!startInput || !endInput) return 'no date inputs';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(startInput, '${targetDate}');
      startInput.dispatchEvent(new Event('input', { bubbles: true }));
      startInput.dispatchEvent(new Event('change', { bubbles: true }));
      setter.call(endInput, '${targetDate}');
      endInput.dispatchEvent(new Event('input', { bubbles: true }));
      endInput.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`);

    // 等 Vue 消化 input change（1 秒,让组件内部 state 更新）
    await sleep(1000);

    // 点查询按钮
    await cdpEval(ws, `(() => {
      const btn = [...document.querySelectorAll('button, .el-button')].find(b =>
        (b.innerText || '').trim() === '查询' || (b.innerText || '').trim() === '搜索'
      );
      if (btn) btn.click();
      return 'ok';
    })()`);

    // 等数据加载（AG-Grid 重新渲染需要时间）
    await sleep(4000);

    // 提取数据（跟手动验证完全一致的逻辑）
    const recordsJson = await cdpEval(ws, `(() => {
      const records = [];
      const useDate = "${targetDate}";
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
          const pn = (v) => { const n = parseFloat(String(v || '').replace(/,/g, '').replace(/%/g, '')); return isNaN(n) ? null : n; };
          const pp = (v) => { const n = pn(v); return n != null ? n / 100 : null; };
          records.push({
            productId, productName, shopName,
            salesAmount: pn(byColId.receivableAmount),
            salesQuantity: pn(byColId.payQty),
            costPrice: pn(byColId.costAmount),
            refundAmount: pn(byColId.refundAmount),
            refundRate: pp(byColId.refundRateString),
            netProfit: pn(byColId.netProfit),
            netProfitRate: pp(byColId.netInterestString),
            date: useDate, source: 'huice'
          });
        }
      });
      return JSON.stringify(records);
    })()`);

    const records = JSON.parse(recordsJson || '[]');
    if (records.length > 0) {
      const netProfitCount = records.filter(r => r.netProfit != null).length;
      allRecords.push(...records);
      console.log(`  ✅ ${records.length} 条 (netProfit 有值: ${netProfitCount})`);
      // 落盘
      writeFileSync(path.join(OUTPUT_DIR, `${targetDate.replace(/-/g, '')}.json`), JSON.stringify({ date: targetDate, records }, null, 2));
    } else {
      console.log(`  ⚠️ 无数据`);
    }
  }

  ws.close();

  // 落盘汇总
  const summaryFile = path.join(OUTPUT_DIR, 'huice-latest.json');
  writeFileSync(summaryFile, JSON.stringify(allRecords, null, 2));
  console.log(`\n💾 数据落盘: ${summaryFile} (${allRecords.length} 条)`);

  // SQLite 入库
  if (allRecords.length > 0) {
    try {
      const inserted = bulkUpsertProductProfit(allRecords);
      console.log(`📦 SQLite 入库 ${inserted} 条 -> ${getDbPath()} (product_profit)`);
    } catch (e) {
      console.log(`⚠️ SQLite 入库失败: ${e.message}`);
    }
  }

  // 写入 dts storage
  console.log('\n📤 写入店透视扩展 storage...');
  await writeToDtsStorage(allRecords);

  console.log('\n✅ 回采完成');
}

async function writeToDtsStorage(records) {
  // 按 date 分组
  const byDate = {};
  for (const r of records) {
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(r);
  }

  // 找 SW
  const tabs = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const swTab = tabs.find(t => t.type === 'service_worker' && t.url.includes('chrome-extension'));
  if (!swTab) {
    console.log('⚠️ 没找到 dts 扩展 SW,跳过 storage 写入');
    return;
  }

  const ws = new WebSocket(swTab.webSocketDebuggerUrl);
  await new Promise((r, rej) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', rej, { once: true });
    setTimeout(rej, 5000);
  });

  let written = 0;
  for (const [date, dayRecords] of Object.entries(byDate)) {
    const key = `pdd_huice_window_${date}`;
    const dataJson = JSON.stringify(dayRecords).replace(/'/g, "\\'");
    const result = await cdpEval(ws, `chrome.storage.local.set({ '${key}': ${dataJson} }).then(() => 'OK').catch(e => 'ERR:' + e.message)`);
    if (result === 'OK') {
      written += dayRecords.length;
      console.log(`  ✓ ${date}: ${dayRecords.length} 条`);
    } else {
      console.log(`  ✗ ${date}: ${result}`);
    }
    await sleep(300);
  }

  ws.close();
  console.log(`✅ 共写入 ${written} 条到 dts storage`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
