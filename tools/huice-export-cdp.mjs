#!/usr/bin/env node
/**
 * huice-export-cdp.mjs - 通过慧经营「导出全部」按钮下载 xlsx,解析入库
 *
 * 流程（每天）:
 *   1. 打开日期面板,翻月到目标月,点日期两次(单日范围),点查询
 *   2. 等数据加载,点下载按钮(#icon-download),点「导出全部」
 *   3. 去下载中心,点 operation 列的下载 button
 *   4. 等下载完成,解析 xlsx -> 入库 SQLite
 *
 * 用法:
 *   node tools/huice-export-cdp.mjs --days 30   # 回采 30 天
 *   node tools/huice-export-cdp.mjs --days 1     # 采昨天
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bulkUpsertProductProfit, getDbPath } from '../scripts/huice/lib/db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.resolve(ROOT, 'output/huice-exports');
const DOWNLOAD_DIR = path.resolve(process.env.HOME, 'Downloads');

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
    setTimeout(() => { ws.removeEventListener('message', handler); reject(new Error(`${method} 超时`)); }, 15000);
  });
}

async function cdpEval(ws, expression) {
  const res = await cdpCall(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return res.result?.result?.value;
}

/** 切日期到 targetDate（单日范围）- 面板点击方式 */
async function setDateRangeByPanel(ws, targetDate) {
  const [year, month, day] = targetDate.split('-').map(Number);
  const targetMonthHeader = `${year} 年 ${month} 月`;

  // 1. 打开日期面板
  await cdpEval(ws, `(() => {
    const editor = document.querySelector('.el-range-editor');
    if (editor) editor.click();
    return 'ok';
  })()`);
  await sleep(1500);

  // 2. 翻左面板到目标月
  for (let attempt = 0; attempt < 24; attempt++) {
    const header = await cdpEval(ws, `(() => {
      const panels = document.querySelectorAll('.el-date-range-picker__content');
      return panels[0]?.querySelector('.el-date-range-picker__header')?.textContent?.trim() || '';
    })()`);
    if (header === targetMonthHeader) break;

    // 点单箭头翻月（往前往后）
    const direction = await cdpEval(ws, `(() => {
      const panels = document.querySelectorAll('.el-date-range-picker__content');
      const left = panels[0];
      if (!left) return 'no panel';
      const curHeader = left.querySelector('.el-date-range-picker__header')?.textContent?.trim() || '';
      // 比较年月
      const curMatch = curHeader.match(/(\\d{4}) 年 (\\d{1,2}) 月/);
      const targetMatch = '${targetMonthHeader}'.match(/(\\d{4}) 年 (\\d{1,2}) 月/);
      if (!curMatch || !targetMatch) return 'no match';
      const curVal = parseInt(curMatch[1]) * 12 + parseInt(curMatch[2]);
      const targetVal = parseInt(targetMatch[1]) * 12 + parseInt(targetMatch[2]);
      if (curVal > targetVal) {
        // 往前翻: 点单箭头 .el-icon-arrow-left（不是双箭头 d-arrow-left）
        const btn = left.querySelector('.el-icon-arrow-left');
        if (btn) { (btn.closest('button') || btn).click(); return 'prev'; }
      } else {
        // 往后翻: 点单箭头 .el-icon-arrow-right
        const btn = left.querySelector('.el-icon-arrow-right');
        if (btn) { (btn.closest('button') || btn).click(); return 'next'; }
      }
      return 'stuck';
    })()`);
    await sleep(600);
    if (direction === 'stuck' || direction === 'no match') break;
  }

  // 3. 点日期两次（第一次设开始,第二次设结束）
  await cdpEval(ws, `(() => {
    const panels = document.querySelectorAll('.el-date-range-picker__content');
    const leftPanel = panels[0];
    if (!leftPanel) return 'no left panel';
    const dayCell = [...leftPanel.querySelectorAll('td.available')].find(td =>
      td.textContent.trim() === '${day}'
    );
    if (!dayCell) return 'no day ${day}';
    dayCell.click();  // 第一次:设开始日期
    return 'first click';
  })()`);
  await sleep(800);

  await cdpEval(ws, `(() => {
    const panels = document.querySelectorAll('.el-date-range-picker__content');
    const leftPanel = panels[0];
    if (!leftPanel) return 'no left panel';
    const dayCell = [...leftPanel.querySelectorAll('td.available')].find(td =>
      td.textContent.trim() === '${day}'
    );
    if (!dayCell) return 'no day ${day}';
    dayCell.click();  // 第二次:设结束日期
    return 'second click';
  })()`);
  await sleep(800);

  // 4. 关面板（点空白处）
  await cdpEval(ws, `(() => {
    document.body.click();
    return 'ok';
  })()`);
  await sleep(500);

  // 5. 验证日期是否切成功
  const dateVals = await cdpEval(ws, `(() => {
    const inputs = [...document.querySelectorAll('input')];
    return {
      start: inputs.find(i => i.placeholder === '开始日期')?.value,
      end: inputs.find(i => i.placeholder === '结束日期')?.value
    };
  })()`);
  return dateVals;
}

/** 等待新的 xlsx 下载完成 */
async function waitForNewXlsx(beforeMtime, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await sleep(2000);
    const files = readdirSync(DOWNLOAD_DIR).filter(f => f.includes('商品排名导出'));
    for (const f of files) {
      const fullPath = path.join(DOWNLOAD_DIR, f);
      const stat = statSync(fullPath);
      if (stat.mtimeMs > beforeMtime && stat.size > 5000) {
        let lastSize = 0;
        for (let i = 0; i < 10; i++) {
          const size = statSync(fullPath).size;
          if (size === lastSize && size > 5000) return fullPath;
          lastSize = size;
          await sleep(1000);
        }
        return fullPath;
      }
    }
  }
  return null;
}

/** 解析 xlsx -> records 数组 */
function parseXlsx(xlsxPath, targetDate) {
  const script = `
import openpyxl, json, sys
wb = openpyxl.load_workbook('${xlsxPath}')
ws = wb.active
rows = list(ws.iter_rows(values_only=True))
records = []
for row in rows[11:]:
    if not row[2]:
        continue
    product_id = str(row[2]).strip() if row[2] else ''
    if not product_id or product_id == 'None':
        continue
    def pn(v):
        if v is None: return None
        s = str(v).replace(',','').replace('%','').strip()
        try: return float(s)
        except: return None
    def pp(v):
        n = pn(v)
        return n/100 if n is not None else None
    records.append({
        'productId': product_id,
        'productName': str(row[1] or '').strip(),
        'shopName': str(row[0] or '').strip(),
        'salesAmount': pn(row[5]),
        'salesQuantity': pn(row[7]),
        'costPrice': pn(row[8]),
        'refundAmount': pn(row[13]),
        'refundRate': pp(row[14]),
        'netProfit': pn(row[15]),
        'netProfitRate': pp(row[16]),
        'date': '${targetDate}',
        'source': 'huice-export'
    })
print(json.dumps(records))
`;
  const result = execSync(`python3 -c '${script.replace(/'/g, "'\\''")}'`, { encoding: 'utf8', timeout: 30000 });
  return JSON.parse(result.trim());
}

async function main() {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log(`🚀 慧经营导出回采（${days} 天）`);
  console.log(`   日期范围: ${dateStr(-1)} ~ ${dateStr(-days)}`);

  // 找 hjy 标签页
  const tabs = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const hjyTab = tabs.find(t => t.type === 'page' && t.url.includes('hjy.huice.com'));
  if (!hjyTab) { console.error('❌ 没找到 hjy.huice.com 标签页'); process.exit(1); }

  const ws = new WebSocket(hjyTab.webSocketDebuggerUrl);
  await new Promise((r, rej) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', rej, { once: true }); setTimeout(rej, 5000); });
  console.log(`✅ CDP 已连接`);

  // 确保在 CommodityAnalysis 页
  const curUrl = await cdpEval(ws, 'location.href');
  if (!curUrl.includes('CommodityAnalysis')) {
    await cdpEval(ws, 'location.href = "https://hjy.huice.com/#/opertData/CommodityAnalysis"');
    await sleep(4000);
  }

  const allRecords = [];

  for (let offset = 1; offset <= days; offset++) {
    const targetDate = dateStr(-offset);
    console.log(`\n📅 [${offset}/${days}] 采集 ${targetDate}...`);

    // 1. 切日期（面板点击方式）
    const dateResult = await setDateRangeByPanel(ws, targetDate);
    if (dateResult.start !== targetDate || dateResult.end !== targetDate) {
      console.log(`  ⚠ 日期切换失败: ${JSON.stringify(dateResult)},跳过`);
      continue;
    }

    // 2. 点查询
    await cdpEval(ws, `(() => {
      const btn = [...document.querySelectorAll('button, .el-button')].find(b =>
        (b.innerText || '').trim() === '查询' || (b.innerText || '').trim() === '搜索'
      );
      if (btn) btn.click();
      return 'ok';
    })()`);
    await sleep(5000);

    // 3. 点下载按钮（toolbar-right 里的 #icon-download）
    await cdpEval(ws, `(() => {
      const btns = [...document.querySelectorAll('button')];
      const downloadBtn = btns.find(b => {
        const use = b.querySelector('use');
        if (!use) return false;
        const href = use.getAttribute('href') || use.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
        return href === '#icon-download';
      });
      if (downloadBtn) downloadBtn.click();
      return 'ok';
    })()`);
    await sleep(1500);

    // 4. 点「导出全部」
    await cdpEval(ws, `(() => {
      const items = [...document.querySelectorAll('.el-popover *')];
      const exportAll = items.find(el => (el.innerText || '').trim() === '导出全部');
      if (exportAll) exportAll.click();
      return 'ok';
    })()`);

    // 等慧经营后台生成 xlsx
    await sleep(6000);

    // 关闭「导出完成」提示
    await cdpEval(ws, `(() => {
      const btn = [...document.querySelectorAll('button, .el-button')].find(b =>
        (b.innerText || '').trim() === '我知道了'
      );
      if (btn) btn.click();
      return 'ok';
    })()`);

    // 5. 去下载中心下载 xlsx
    await cdpEval(ws, 'location.href = "https://hjy.huice.com/#/baseSettings/downloadCenter"');
    await sleep(4000);

    const beforeMtime = Date.now();

    // 点第一行 operation 列的下载 button
    await cdpEval(ws, `(() => {
      const grid = document.querySelector('.ag-root');
      if (!grid) return 'no grid';
      const firstRow = grid.querySelector('.ag-center-cols-container .ag-row');
      if (!firstRow) return 'no row';
      const cells = [...firstRow.querySelectorAll('.ag-cell')];
      const opCell = cells.find(c => c.getAttribute('col-id') === 'operation');
      if (!opCell) return 'no operation cell';
      const btn = opCell.querySelector('button');
      if (!btn) return 'no button';
      btn.click();
      return 'ok';
    })()`);

    // 等下载完成
    const xlsxPath = await waitForNewXlsx(beforeMtime, 60000);
    if (!xlsxPath) {
      console.log(`  ⚠️ 下载超时,跳过`);
      continue;
    }
    console.log(`  📄 下载完成: ${path.basename(xlsxPath)}`);

    // 6. 解析 xlsx
    const records = parseXlsx(xlsxPath, targetDate);
    const netProfitCount = records.filter(r => r.netProfit != null).length;
    console.log(`  ✅ ${records.length} 条 (netProfit 有值: ${netProfitCount})`);

    // 7. 归档 xlsx
    const archivePath = path.join(OUTPUT_DIR, `${targetDate.replace(/-/g, '')}.xlsx`);
    renameSync(xlsxPath, archivePath);

    allRecords.push(...records);
    writeFileSync(path.join(OUTPUT_DIR, `${targetDate.replace(/-/g, '')}.json`), JSON.stringify({ date: targetDate, records }, null, 2));

    // 8. 回到商品排名页（为下一天准备）
    await cdpEval(ws, 'location.href = "https://hjy.huice.com/#/opertData/CommodityAnalysis"');
    await sleep(3000);
  }

  ws.close();

  // SQLite 入库
  if (allRecords.length > 0) {
    try {
      const inserted = bulkUpsertProductProfit(allRecords);
      console.log(`\n📦 SQLite 入库 ${inserted} 条 -> ${getDbPath()}`);
    } catch (e) {
      console.log(`⚠️ SQLite 入库失败: ${e.message}`);
    }
  }

  const summaryFile = path.join(OUTPUT_DIR, 'huice-latest.json');
  writeFileSync(summaryFile, JSON.stringify(allRecords, null, 2));
  console.log(`💾 数据落盘: ${summaryFile} (${allRecords.length} 条)`);
  console.log(`✅ 回采完成`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
