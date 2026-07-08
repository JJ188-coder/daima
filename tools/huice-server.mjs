#!/usr/bin/env node
/**
 * huice-server.mjs - 本地 HTTP 服务,读 SQLite 数据给扩展用
 *
 * 扩展 pdd-enhancer.js 优先从 http://127.0.0.1:9911 拿数据
 * 这样 CDP Chrome 和日常 Chrome 的扩展都能读到同一份数据
 *
 * 用法:
 *   node tools/huice-server.mjs              # 前台运行
 *   node tools/huice-server.mjs --daemon     # 后台运行
 *
 * API:
 *   GET /health                        -> 健康检查
 *   GET /huice/:date                   -> 某天的商品利润数据
 *   GET /huice?start=...&end=...       -> 日期范围内商品数据(按 productId 聚合)
 *   GET /huice/dates                   -> 有数据的日期列表
 */

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getProductProfitByDate,
  getDbPath,
} from '../scripts/huice/lib/db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.HUICE_SERVER_PORT || '9911', 10);
const HOST = '127.0.0.1';

// SQLite 列名 -> 扩展字段名 映射
function mapRow(row) {
  return {
    productId: String(row.product_id || ''),
    productName: row.product_name || '',
    shopName: row.shop_name || '',
    shopId: row.shop_id || null,
    date: row.date,
    salesAmount: row.sales_amount,
    salesQuantity: row.sales_quantity,
    costPrice: row.cost_price,
    refundAmount: row.refund_amount,
    refundRate: row.refund_rate,
    netProfit: row.net_profit,
    netProfitRate: row.net_profit_rate,
    source: 'huice-server',
  };
}

// 按 productId 聚合多天数据
function aggregateByProduct(records) {
  const byProduct = {};
  for (const r of records) {
    const pid = r.productId;
    if (!pid) continue;
    if (!byProduct[pid]) {
      byProduct[pid] = { ...r };
    } else {
      const existing = byProduct[pid];
      for (const field of ['salesAmount', 'salesQuantity', 'costPrice', 'refundAmount', 'netProfit']) {
        const a = Number(existing[field]) || 0;
        const b = Number(r[field]) || 0;
        existing[field] = a || b ? a + b : null;
      }
      if (r.netProfitRate != null) existing.netProfitRate = r.netProfitRate;
      if (r.refundRate != null) existing.refundRate = r.refundRate;
    }
  }
  return Object.values(byProduct);
}

// 日期范围内所有天数据(直接查 SQLite,比逐天查快)
function getProductProfitByDateRange(startDate, endDate) {
  // 动态 import 避免改 db.mjs
  const { Database } = require('better-sqlite3');
  // 这个函数在 server 端直接查
}

// CORS + JSON 响应
function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

// 路由处理
async function handler(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  // OPTIONS 预检
  if (req.method === 'OPTIONS') {
    sendJson(res, { ok: true });
    return;
  }

  try {
    // GET /health
    if (path === '/health') {
      const dbExists = existsSync(getDbPath());
      sendJson(res, {
        ok: true,
        db: dbExists ? getDbPath() : 'not found',
        port: PORT,
        version: '1.0.0',
      });
      return;
    }

    // GET /huice/dates -> 有数据的日期列表
    if (path === '/huice/dates') {
      const Database = (await import('better-sqlite3')).default;
      const dbPath = getDbPath();
      if (!existsSync(dbPath)) {
        sendJson(res, { dates: [], error: 'database not found' });
        return;
      }
      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare('SELECT DISTINCT date FROM product_profit ORDER BY date DESC').all();
      db.close();
      sendJson(res, { dates: rows.map(r => r.date) });
      return;
    }

    // GET /huice/:date -> 某天的数据
    const dateMatch = path.match(/^\/huice\/(\d{4}-\d{2}-\d{2})$/);
    if (dateMatch) {
      const date = dateMatch[1];
      const rows = getProductProfitByDate(date);
      const records = rows.map(mapRow);
      sendJson(res, { date, records, count: records.length });
      return;
    }

    // GET /huice?start=...&end=... -> 日期范围(按 productId 聚合)
    if (path === '/huice') {
      const start = url.searchParams.get('start');
      const end = url.searchParams.get('end');
      if (!start || !end) {
        sendJson(res, { error: 'missing start or end param', usage: '/huice?start=2026-07-01&end=2026-07-07' }, 400);
        return;
      }

      const Database = (await import('better-sqlite3')).default;
      const dbPath = getDbPath();
      if (!existsSync(dbPath)) {
        sendJson(res, { records: [], count: 0, error: 'database not found' });
        return;
      }
      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare(
        'SELECT * FROM product_profit WHERE date BETWEEN ? AND ? ORDER BY net_profit DESC'
      ).all(start, end);
      db.close();

      const records = aggregateByProduct(rows.map(mapRow));
      sendJson(res, { start, end, records, count: records.length });
      return;
    }

    // 404
    sendJson(res, { error: 'not found', paths: ['/health', '/huice/:date', '/huice?start=...&end=...', '/huice/dates'] }, 404);
  } catch (e) {
    console.error(`[error] ${e.message}`);
    sendJson(res, { error: e.message }, 500);
  }
}

// 启动服务
const server = createServer(handler);
server.listen(PORT, HOST, () => {
  console.log(`🚀 慧经营数据服务: http://${HOST}:${PORT}`);
  console.log(`   数据库: ${getDbPath()}`);
  console.log(`   GET /health  - 健康检查`);
  console.log(`   GET /huice/2026-07-07  - 某天数据`);
  console.log(`   GET /huice?start=2026-07-01&end=2026-07-07  - 范围数据`);
  console.log(`   GET /huice/dates  - 有数据的日期列表`);
  console.log(`   Ctrl+C 停止`);
});

// 后台模式
const isDaemon = process.argv.includes('--daemon');
if (isDaemon) {
  // 静默 stdout/stderr,靠进程活着就行
  process.stdout.write = () => true;
  process.stderr.write = () => true;
}
