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
  getShopDailyProfitRangeByMallId,
  getPddShopMapping,
  upsertPddShopMapping,
  findShopCandidatesByProductIds,
} from '../scripts/huice/lib/db.mjs';
import { aggregateProfitRecords } from '../scripts/huice/lib/profit.mjs';
import { buildStoreReportDay, fillDateRange } from '../scripts/huice/lib/shop-profit.mjs';

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
    orderCount: row.order_count,
    costPrice: row.cost_price,
    grossProfit: row.gross_profit,
    grossProfitRate: row.gross_profit_rate,
    refundAmount: row.refund_amount,
    refundRate: row.refund_rate,
    rawNetProfit: row.raw_net_profit,
    rawNetProfitRate: row.raw_net_profit_rate,
    netProfit: row.net_profit,
    netProfitRate: row.net_profit_rate,
    orderFixedCost: row.order_fixed_cost,
    platformFee: row.platform_fee,
    platformFeeRate: row.platform_fee_rate,
    orderFixedUnitCost: row.order_fixed_unit_cost,
    profitFormulaVersion: row.profit_formula_version,
    source: 'huice-server',
  };
}

// 按 productId 聚合多天数据
function aggregateByProduct(records) {
  return aggregateProfitRecords(records);
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
        sendJson(res, { error: 'missing start or end param', usage: '/huice?start=YYYY-MM-DD&end=YYYY-MM-DD' }, 400);
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

    // === 店铺日报利润 ===
    // GET /shop-profit?pddShopName=昀诺零食专营店&start=...&end=...
    if (path === '/shop-profit') {
      const pddShopName = url.searchParams.get('pddShopName') || '';
      const start = url.searchParams.get('start');
      const end = url.searchParams.get('end');
      if (!start || !end) {
        sendJson(res, { error: 'missing start or end', status: 'no_mapping' }, 400);
        return;
      }

      // 用 pddShopName 匹配慧经营店铺
      // 拼多多店铺名"昀诺零食专营店" -> 慧经营店铺名"拼【昀诺"或"拼【昀诺食品"
      const Database = (await import('better-sqlite3')).default;
      const dbPath = getDbPath();
      if (!existsSync(dbPath)) {
        sendJson(res, { status: 'no_mapping', mapping: null, days: [] });
        return;
      }
      const db = new Database(dbPath, { readonly: true });

      // 从 shop_daily_profit 表里找匹配的店铺
      // 策略: 1.精确匹配 pddShopName 2.模糊匹配 3.返回所有有数据的店铺
      let shopRow = null;
      if (pddShopName) {
        // 从拼多多店铺名提取关键词: "昀诺零食专营店" -> "昀诺"
        const keywords = pddShopName.replace(/(食品|零食|专营|旗舰|专卖|店|官方|总动员|食品大卖场|零食卖场|食品专营店)/g, '').trim();
        if (keywords) {
          // 在 shops 表里找 huice_name 包含关键词的
          const candidates = db.prepare("SELECT s.shop_id, s.huice_name FROM shops s WHERE s.huice_name LIKE ? ORDER BY LENGTH(s.huice_name) ASC LIMIT 1").get('%' + keywords + '%');
          if (candidates) shopRow = candidates;
        }
        // 精确匹配
        if (!shopRow) {
          shopRow = db.prepare("SELECT s.shop_id, s.huice_name FROM shops s WHERE s.huice_name = ? OR s.shop_name = ? LIMIT 1").get(pddShopName, pddShopName);
        }
      }
      // fallback: 找有数据的第一个店铺
      if (!shopRow) {
        shopRow = db.prepare('SELECT s.shop_id, s.huice_name FROM shop_daily_profit d JOIN shops s ON s.shop_id = d.shop_id WHERE d.date BETWEEN ? AND ? LIMIT 1').get(start, end);
      }
      db.close();

      if (!shopRow) {
        sendJson(res, { status: 'no_mapping', mapping: null, days: [] });
        return;
      }

      const Database2 = (await import('better-sqlite3')).default;
      const db2 = new Database2(dbPath, { readonly: true });
      const shopRows = db2.prepare('SELECT * FROM shop_daily_profit WHERE shop_id = ? AND date BETWEEN ? AND ? ORDER BY date').all(shopRow.shop_id, start, end);
      db2.close();

      const rowsByDate = new Map(shopRows.map(r => [r.date, r]));
      const filledDays = fillDateRange({ start, end, rowsByDate });

      const days = filledDays.map(day => {
        if (day.missing) {
          return { date: day.date, missing: true };
        }
        return buildStoreReportDay({
          date: day.date,
          shop: {
            salesAmount: day.sales_amount,
            promoSpend: day.promo_spend,
            netProfit: day.net_profit,
            netProfitRate: day.net_profit_rate,
            promoFeeRatio: day.promo_fee_ratio,
            roi: day.roi,
          },
        });
      });

      sendJson(res, {
        status: 'ok',
        mapping: {
          huiceShopId: shopRow.shop_id,
          huiceShopName: shopRow.huice_name,
        },
        days,
      });
      return;
    }

    // POST /shop-mapping/candidates
    if (path === '/shop-mapping/candidates' && req.method === 'POST') {
      const body = await new Promise(resolve => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(JSON.parse(data || '{}')));
      });

      const { mallId, pddShopName, productIds } = body;
      if (!mallId || !productIds || !Array.isArray(productIds)) {
        sendJson(res, { error: 'missing mallId or productIds' }, 400);
        return;
      }

      const candidates = findShopCandidatesByProductIds(productIds);
      if (candidates.length === 0) {
        sendJson(res, { status: 'none', candidates: [] });
      } else if (candidates.length === 1) {
        upsertPddShopMapping({
          pddMallId: mallId,
          pddShopName: pddShopName || '',
          huiceShopId: candidates[0].shop_id,
          matchMethod: 'product_id_auto',
          matchedProductCount: candidates[0].matched_product_count,
          status: 'confirmed',
        });
        sendJson(res, { status: 'unique', candidates });
      } else {
        sendJson(res, { status: 'ambiguous', candidates });
      }
      return;
    }

    // POST /shop-mapping/confirm
    if (path === '/shop-mapping/confirm' && req.method === 'POST') {
      const body = await new Promise(resolve => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(JSON.parse(data || '{}')));
      });

      const { mallId, pddShopName, huiceShopId } = body;
      if (!mallId || !huiceShopId) {
        sendJson(res, { error: 'missing mallId or huiceShopId' }, 400);
        return;
      }

      upsertPddShopMapping({
        pddMallId: mallId,
        pddShopName: pddShopName || '',
        huiceShopId,
        matchMethod: 'manual',
        status: 'confirmed',
      });
      sendJson(res, { status: 'ok' });
      return;
    }

    // 404
    sendJson(res, { error: 'not found', paths: ['/health', '/huice/:date', '/huice?start=...&end=...', '/huice/dates', '/shop-profit', '/shop-mapping/candidates', '/shop-mapping/confirm'] }, 404);
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
  console.log(`   GET /huice/YYYY-MM-DD  - 某天数据`);
  console.log(`   GET /huice?start=YYYY-MM-DD&end=YYYY-MM-DD  - 范围数据`);
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
