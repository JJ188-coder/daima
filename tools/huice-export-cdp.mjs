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
 *   node tools/huice-export-cdp.mjs --days 7    # 回采最近 7 天
 *   node tools/huice-export-cdp.mjs --days 1     # 采昨天
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bulkUpsertProductProfit, getDbPath } from '../scripts/huice/lib/db.mjs';
import { collectorExitCode, createCollectorResult, markCollectorFailure } from '../scripts/huice/lib/collector-result.mjs';
import { isExpectedExportTask } from '../scripts/huice/lib/export-validation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.resolve(ROOT, 'output/huice-exports');
const DOWNLOAD_DIR = path.resolve(process.env.HOME, 'Downloads');

const args = process.argv.slice(2);
let days = 1;
let customDates = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i+1]) { days = parseInt(args[i+1]); i++; }
  if (args[i] === '--dates' && args[i+1]) { customDates = args[i+1].split(','); i++; }
}

function dateStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
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

  // 2. 找目标月面板（如果不存在,往前翻月让它出现）
  const targetHeader = `${year} 年 ${month} 月`;

  // 最多翻 12 次（覆盖一年）
  for (let attempt = 0; attempt < 12; attempt++) {
    const found = await cdpEval(ws, `(() => {
      const panels = document.querySelectorAll('.el-date-range-picker__content');
      for (const p of panels) {
        const h = p.querySelector('.el-date-range-picker__header')?.textContent?.trim() || '';
        if (h === '${targetHeader}') return 'found';
      }
      return 'not found';
    })()`);
    if (found === 'found') break;

    // 往前翻一个月:点第一个面板的单箭头
    await cdpEval(ws, `(() => {
      const panels = document.querySelectorAll('.el-date-range-picker__content');
      const first = panels[0];
      if (!first) return 'no panel';
      // 单箭头 .el-icon-arrow-left（不是双箭头 d-arrow-left）
      const btn = first.querySelector('.el-icon-arrow-left');
      if (btn) { (btn.closest('button') || btn).click(); return 'prev'; }
      return 'no arrow';
    })()`);
    await sleep(600);
  }

  // 3. 在目标月的面板里点日期两次（第一次设开始,第二次设结束）
  //    如果面板有残留选择,先点别的日期清掉
  await cdpEval(ws, `(() => {
    const panels = document.querySelectorAll('.el-date-range-picker__content');
    let targetPanel = null;
    for (const p of panels) {
      const h = p.querySelector('.el-date-range-picker__header')?.textContent?.trim() || '';
      if (h === '${targetHeader}') { targetPanel = p; break; }
    }
    if (!targetPanel) return 'no target panel';

    // 找目标日期(干净的,未被选中的)
    let dayCell = [...targetPanel.querySelectorAll('td.available')].find(td =>
      td.textContent.trim() === '${day}' &&
      !td.classList.contains('start-date') &&
      !td.classList.contains('end-date') &&
      !td.classList.contains('in-range')
    );

    // 如果目标日期已被选中(在 in-range/start-date/end-date 状态),先点别的日期清掉
    if (!dayCell) {
      const otherCell = [...targetPanel.querySelectorAll('td.available')].find(td =>
        td.textContent.trim() !== '${day}'
      );
      if (otherCell) {
        otherCell.click();  // 点别的日期清旧选择
      }
      // 重新找目标日期(此时应该是干净的)
      dayCell = [...targetPanel.querySelectorAll('td.available')].find(td =>
        td.textContent.trim() === '${day}'
      );
    }

    if (!dayCell) return 'no day ${day}';
    dayCell.click();  // 第一次:设开始日期
    return 'first click';
  })()`);
  await sleep(1000);

  // 第二次点同一个日期(设结束 = 开始 = 单日范围)
  await cdpEval(ws, `(() => {
    const panels = document.querySelectorAll('.el-date-range-picker__content');
    let targetPanel = null;
    for (const p of panels) {
      const h = p.querySelector('.el-date-range-picker__header')?.textContent?.trim() || '';
      if (h === '${targetHeader}') { targetPanel = p; break; }
    }
    if (!targetPanel) return 'no target panel';
    const dayCell = [...targetPanel.querySelectorAll('td.available')].find(td =>
      td.textContent.trim() === '${day}'
    );
    if (!dayCell) return 'no day';
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
all_text = '\\n'.join(' '.join(str(c) for c in row if c is not None) for row in rows)
if '${targetDate}' not in all_text and '${targetDate.replace(/-/g, '/')}' not in all_text:
    raise ValueError('target date missing from export')
if not any(any('商品ID' in str(c) or '商品编号' in str(c) for c in row if c is not None) for row in rows):
    raise ValueError('product ID header missing from export')
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
        # 百分比转小数: "12.50%"->0.125, 12.5->0.125, 0.125->0.125
        if v is None: return None
        s = str(v)
        has_percent = '%' in s
        n = pn(v)
        if n is None: return None
        if has_percent: return n / 100
        if n > 1 or n < -1: return n / 100
        return n
    # 慧经营原始净利额
    raw_net_profit = pn(row[15])
    raw_net_profit_rate = pp(row[16])
    sales_amt = pn(row[5])
    sales_qty = pn(row[7])
    gross_profit = pn(row[10])
    gross_profit_rate = pp(row[12])
    # 真实净利润 = 慧经营净利额 - 1.15×销售件数(按订单数) - 销售额×2%
    order_count = sales_qty
    order_fixed_cost = 1.15 * order_count if order_count is not None else 0
    platform_fee = sales_amt * 0.02 if sales_amt is not None else 0
    real_net_profit = None
    if raw_net_profit is not None:
        real_net_profit = raw_net_profit - order_fixed_cost - platform_fee
    # 真实净利率 = 真实净利润 / 销售额
    real_net_profit_rate = None
    if real_net_profit is not None and sales_amt and sales_amt > 0:
        real_net_profit_rate = real_net_profit / sales_amt
    records.append({
        'productId': product_id,
        'productName': str(row[1] or '').strip(),
        'shopName': str(row[0] or '').strip(),
        'salesAmount': sales_amt,
        'salesQuantity': sales_qty,
        'orderCount': order_count,
        'costPrice': pn(row[8]),
        'grossProfit': gross_profit,
        'grossProfitRate': gross_profit_rate,
        'refundAmount': pn(row[13]),
        'refundRate': pp(row[14]),
        'rawNetProfit': raw_net_profit,
        'rawNetProfitRate': raw_net_profit_rate,
        'netProfit': real_net_profit,
        'netProfitRate': real_net_profit_rate,
        'orderFixedCost': order_fixed_cost,
        'platformFee': platform_fee,
        'platformFeeRate': 0.02,
        'orderFixedUnitCost': 1.15,
        'profitFormulaVersion': 'order-fixed-v1',
        'date': '${targetDate}',
        'source': 'huice-export'
    })
print(json.dumps(records))
`;
  const result = execSync(`python3 -c '${script.replace(/'/g, "'\\''")}'`, { encoding: 'utf8', timeout: 30000 });
  return JSON.parse(result.trim());
}

async function main() {
  const result = createCollectorResult();
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  // 日期列表:--dates 优先,否则按 --days 生成
  const dateList = customDates.length > 0
    ? customDates.sort()
    : Array.from({ length: days }, (_, i) => dateStr(-(i + 1)));

  console.log(`🚀 慧经营导出回采（${dateList.length} 天）`);
  console.log(`   日期范围: ${dateList[0]} ~ ${dateList[dateList.length - 1]}`);

  // 找 hjy 标签页
  const tabs = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const hjyTab = tabs.find(t => t.type === 'page' && t.url.includes('hjy.huice.com'));
  if (!hjyTab) {
    console.error('❌ 没找到 hjy.huice.com 标签页');
    result.fatalError = new Error('hjy tab not found');
    return result;
  }

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
  const failedDates = result.failedDates;

  for (let i = 0; i < dateList.length; i++) {
    const targetDate = dateList[i];
    console.log(`\n📅 [${i + 1}/${dateList.length}] 采集 ${targetDate}...`);

    // 0. 每天先刷新页面,清除日期选择器的残留 Vue 状态
    if (i > 0) {
      await cdpEval(ws, 'location.reload()');
      await sleep(5000);
    }

    // 1. 切日期（面板点击方式,失败自动重试 3 次）
    let dateResult = null;
    let dateOk = false;
    for (let retry = 0; retry < 3; retry++) {
      if (retry > 0) {
        console.log(`  🔄 日期切换重试 ${retry + 1}/3 (重载页面清 Vue 状态)`);
        await cdpEval(ws, 'location.href = "https://hjy.huice.com/#/opertData/CommodityAnalysis"');
        await sleep(5000);
      }
      dateResult = await setDateRangeByPanel(ws, targetDate);
      if (dateResult.start === targetDate && dateResult.end === targetDate) {
        dateOk = true;
        break;
      }
      console.log(`  ⚠ 日期切换失败(尝试 ${retry + 1}): ${JSON.stringify(dateResult)}`);
    }
    if (!dateOk) {
      console.log(`  ❌ 日期切换 3 次均失败,跳过 ${targetDate}`);
      // 记录失败日期,供后续补采
      markCollectorFailure(result, targetDate, 'date selection failed');
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
    const exportRequestedAt = Date.now();
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

    // 只下载本次导出后生成的商品排名任务，禁止按第一行猜测。
    const tasks = await cdpEval(ws, `(() => {
      const grid = document.querySelector('.ag-root');
      if (!grid) return [];
      return [...grid.querySelectorAll('.ag-center-cols-container .ag-row')].map(row => ({
        rowIndex: row.getAttribute('row-index'),
        text: row.innerText || '',
      }));
    })()`);
    const task = Array.isArray(tasks) && tasks.find(candidate =>
      isExpectedExportTask(candidate, { kind: 'product', targetDate, after: exportRequestedAt })
    );
    const downloadResult = task ? await cdpEval(ws, `(() => {
      const row = [...document.querySelectorAll('.ag-center-cols-container .ag-row')]
        .find(item => item.getAttribute('row-index') === ${JSON.stringify(task.rowIndex)});
      const opCell = [...(row?.querySelectorAll('.ag-cell') || [])]
        .find(cell => cell.getAttribute('col-id') === 'operation');
      const btn = opCell?.querySelector('button');
      if (!btn) return 'no matching task button';
      btn.click();
      return 'ok';
    })()`) : 'no matching task';
    if (downloadResult !== 'ok') {
      console.log(`  ⚠️ 下载中心没有匹配任务,跳过`);
      markCollectorFailure(result, targetDate, 'matching download task not found');
      continue;
    }

    // 等下载完成
    const xlsxPath = await waitForNewXlsx(beforeMtime, 60000);
    if (!xlsxPath) {
      console.log(`  ⚠️ 下载超时,跳过`);
      markCollectorFailure(result, targetDate, 'download timeout');
      continue;
    }
    console.log(`  📄 下载完成: ${path.basename(xlsxPath)}`);

    // 6. 解析并校验 xlsx
    let records;
    try {
      records = parseXlsx(xlsxPath, targetDate);
    } catch (error) {
      console.log(`  ⚠️ xlsx 校验失败: ${error.message}`);
      markCollectorFailure(result, targetDate, 'xlsx validation failed');
      continue;
    }
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
      result.fatalError = e;
    }
  }

  const summaryFile = path.join(OUTPUT_DIR, 'huice-latest.json');
  writeFileSync(summaryFile, JSON.stringify(allRecords, null, 2));
  console.log(`💾 数据落盘: ${summaryFile} (${allRecords.length} 条)`);
  console.log(`✅ 回采完成`);

  // 失败日期汇总
  if (failedDates.length > 0) {
    const failLog = path.join(OUTPUT_DIR, 'failed-dates.json');
    writeFileSync(failLog, JSON.stringify({ dates: failedDates, ts: new Date().toISOString() }, null, 2));
    console.log(`⚠️ ${failedDates.length} 天采集失败,已记录到 ${failLog}`);
    console.log(`   失败日期: ${failedDates.join(', ')}`);
    console.log(`   补采命令: node tools/huice-export-cdp.mjs --dates ${failedDates.join(',')}`);
  }
  return result;
}

main().then(result => { process.exit(collectorExitCode(result)); }).catch(e => { console.error("❌", e.message); process.exit(1); });
