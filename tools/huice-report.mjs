#!/usr/bin/env node
/**
 * huice-report.mjs - 运营数据看板
 *
 * 从 SQLite 汇总数据生成运营报告:
 *   - 总净利润 / 总销售额 / 总退款
 *   - 亏损商品数 / 亏损金额
 *   - 最佳商品 / 最差商品
 *   - 店铺排名
 *
 * 用法:
 *   node tools/huice-report.mjs                 # 昨天
 *   node tools/huice-report.mjs --days 7        # 近 7 天
 *   node tools/huice-report.mjs --date 2026-07-07  # 指定日期
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..', '..');
const DB_PATH = resolve(__dirname, 'private/huice-data.sqlite');

const args = process.argv.slice(2);
let days = 1;
let targetDate = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i+1]) { days = parseInt(args[i+1]); i++; }
  if (args[i] === '--date' && args[i+1]) { targetDate = args[i+1]; i++; }
}

function dateStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

const db = new Database(DB_PATH, { readonly: true });

// 确定日期范围
let startDate, endDate;
if (targetDate) {
  startDate = endDate = targetDate;
} else {
  endDate = dateStr(-1);
  startDate = dateStr(-days);
}

console.log(`\n📊 慧经营运营报告`);
console.log(`   日期范围: ${startDate} ~ ${endDate}`);
console.log(`   ${'═'.repeat(60)}`);

// 1. 总览
const overview = db.prepare(`
  SELECT
    COUNT(*) as product_count,
    COUNT(DISTINCT shop_name) as shop_count,
    SUM(CASE WHEN net_profit > 0 THEN net_profit ELSE 0 END) as total_profit,
    SUM(CASE WHEN net_profit < 0 THEN net_profit ELSE 0 END) as total_loss,
    SUM(net_profit) as net_total,
    SUM(sales_amount) as total_sales,
    SUM(refund_amount) as total_refund
  FROM product_profit
  WHERE date BETWEEN ? AND ?
`).get(startDate, endDate);

console.log(`\n📈 总览`);
console.log(`   商品数: ${overview.product_count}`);
console.log(`   店铺数: ${overview.shop_count}`);
console.log(`   总销售额: ¥${Number(overview.total_sales || 0).toLocaleString('zh-CN', {maximumFractionDigits: 2})}`);
console.log(`   总退款: ¥${Number(overview.total_refund || 0).toLocaleString('zh-CN', {maximumFractionDigits: 2})}`);
console.log(`   总净利润: ¥${Number(overview.net_total || 0).toLocaleString('zh-CN', {maximumFractionDigits: 2})}`);
console.log(`   盈利商品净利润: ¥${Number(overview.total_profit || 0).toLocaleString('zh-CN', {maximumFractionDigits: 2})}`);
console.log(`   亏损商品净亏损: ¥${Number(overview.total_loss || 0).toLocaleString('zh-CN', {maximumFractionDigits: 2})}`);

// 2. 亏损商品
const lossProducts = db.prepare(`
  SELECT product_name, shop_name, net_profit, sales_amount, date
  FROM product_profit
  WHERE date BETWEEN ? AND ? AND net_profit < 0
  ORDER BY net_profit ASC
  LIMIT 10
`).all(startDate, endDate);

console.log(`\n🔴 亏损 TOP 10`);
if (lossProducts.length === 0) {
  console.log(`   无亏损商品 🎉`);
} else {
  lossProducts.forEach((p, i) => {
    console.log(`   ${i+1}. ${p.product_name.slice(0, 25)}... | ${p.shop_name.slice(0, 10)} | ¥${p.net_profit.toFixed(2)} | ${p.date}`);
  });
}

// 3. 最佳商品
const topProducts = db.prepare(`
  SELECT product_name, shop_name, net_profit, sales_amount, net_profit_rate, date
  FROM product_profit
  WHERE date BETWEEN ? AND ? AND net_profit > 0
  ORDER BY net_profit DESC
  LIMIT 10
`).all(startDate, endDate);

console.log(`\n🟢 盈利 TOP 10`);
topProducts.forEach((p, i) => {
  const rate = p.net_profit_rate ? (p.net_profit_rate * 100).toFixed(1) + '%' : '--';
  console.log(`   ${i+1}. ${p.product_name.slice(0, 25)}... | ${p.shop_name.slice(0, 10)} | ¥${p.net_profit.toFixed(2)} | 利率${rate} | ${p.date}`);
});

// 4. 店铺排名
const shopRanking = db.prepare(`
  SELECT shop_name,
    COUNT(*) as product_count,
    SUM(net_profit) as total_profit,
    SUM(sales_amount) as total_sales,
    SUM(CASE WHEN net_profit < 0 THEN 1 ELSE 0 END) as loss_count
  FROM product_profit
  WHERE date BETWEEN ? AND ?
  GROUP BY shop_name
  ORDER BY total_profit DESC
  LIMIT 10
`).all(startDate, endDate);

console.log(`\n🏪 店铺净利润 TOP 10`);
shopRanking.forEach((s, i) => {
  console.log(`   ${i+1}. ${s.shop_name.slice(0, 20)} | ${s.product_count}商品 | 净利¥${Number(s.total_profit||0).toFixed(0)} | 销售¥${Number(s.total_sales||0).toFixed(0)} | 亏损${s.loss_count}个`);
});

console.log(`\n${'═'.repeat(60)}`);
console.log(`   报告生成时间: ${new Date().toISOString()}\n`);
