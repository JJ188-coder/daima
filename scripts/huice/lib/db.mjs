/**
 * db.mjs — 汇策本地 SQLite 数据库
 *
 * 表结构:
 *   shops       — 店铺主数据(汇策名 ↔ shopId ↔ 平台)
 *   daily_profit — 每店每日利润(宽表,49 核算项做列)
 *   fetch_log   — 抓取日志
 *
 * 数据库文件: private/huice-data.sqlite (gitignored)
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeProfitRecord } from './profit.mjs';

const __dirname = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PATH = resolve(__dirname, 'private/huice-data.sqlite');

// 49 个核算项(从 capture 探测得到的固定顺序)
export const METRICS = [
  '一、销售收入', '正向销售收入(不含特殊单)', '退款', '特殊单收入', '退款费比',
  '二、邮费收入',
  '三、销售成本', '赠品成本(不含特殊单)', '特殊单成本', '销售商品成本(不含特殊单、不含退款)',
  '六、仓库物流费用', '快递费', '包材费', '仓租费', '仓人工成本', '其他仓库物流费用',
  '四、毛利', '五、销售毛利率',
  '七、运营推广费用', '特殊单费用', '阿里妈妈推广', '拼多多推广', '京准通推广', '支付宝推广',
  '抖店推广', '快手带货推广', '微信视频号推广', '淘宝微信推广', '小米有品推广', '抖店带货佣金',
  '八、平台固定费用', '支付宝平台费用', '京东平台费用', '快手平台费用', '小红书平台费用',
  '微信视频号平台费用', '淘宝微信平台费用', '平台佣金', '保险费', '其他平台费用', '罚款-补偿',
  '九、人工成本', '店铺运营人员费用', '分摊人员费用', '其他人工成本费用',
  '十、其它费用', '房租', '水电费', '行政分摊费用',
];

// 多维度页"按时间展示"Tab 的 11 列(动态列,默认)
// 列顺序: 日期 | 一、销售收入 | 正向销售收入(不含特殊单) | 退款 | 特殊单收入 | 退款费比 | 二、邮费收入 | 三、销售成本 | 赠品成本(不含特殊单) | 特殊单成本 | 销售商品成本(不含特殊单、不含退款)
export const MULTI_DIM_COLUMNS = [
  '日期', '一、销售收入', '正向销售收入(不含特殊单)', '退款', '特殊单收入', '退款费比',
  '二、邮费收入', '三、销售成本', '赠品成本(不含特殊单)', '特殊单成本', '销售商品成本(不含特殊单、不含退款)',
];

let _db = null;

/** 获取数据库实例(单例) */
export function getDb() {
  if (_db) return _db;
  if (!existsSync(resolve(DB_PATH, '..'))) mkdirSync(resolve(DB_PATH, '..'), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema(_db);
  return _db;
}

/** 初始化表结构 */
function initSchema(db) {
  // 店铺表
  db.exec(`
    CREATE TABLE IF NOT EXISTS shops (
      shop_id      INTEGER PRIMARY KEY AUTOINCREMENT,
      huice_name   TEXT UNIQUE NOT NULL,        -- 汇策显示名(如 "拼【周贝瑞")
      platform     TEXT,                         -- 平台(拼/淘/抖/快/京...)
      shop_name    TEXT,                         -- 纯店名(去掉平台前缀)
      pdd_goods_id TEXT,                         -- 对应拼多多 goodsId(待匹配)
      status       TEXT DEFAULT 'active',
      created_at   TEXT DEFAULT (datetime('now')),
      updated_at   TEXT DEFAULT (datetime('now'))
    );
  `);

  // 每日利润宽表(每店每天一行)
  // 用 JSON 存所有核算项(灵活,49 项可能变)
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_profit (
      shop_id       INTEGER NOT NULL,
      date          TEXT NOT NULL,               -- YYYY-MM-DD
      metrics_json  TEXT NOT NULL,               -- JSON: { "一、销售收入": 5035.48, ... }
      raw_rows_json TEXT,                         -- 原始抓取行(调试用)
      captured_at   TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (shop_id, date),
      FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_profit_date ON daily_profit(date);
  `);

  // 商品级利润表(huice-sync.mjs 抓商品分析页,每商品每日一行)
  // 区别于 daily_profit(店铺级),这里按 product_id 维度存,带净利/退款/销量等
  db.exec(productProfitTableSql('product_profit'));
  ensureProductProfitSchema(db);

  // 抓取日志
  db.exec(`
    CREATE TABLE IF NOT EXISTS fetch_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id       INTEGER,
      shop_name     TEXT,
      start_date    TEXT,
      end_date      TEXT,
      rows_fetched  INTEGER,
      status        TEXT,
      error         TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );
  `);

  // 店铺日报利润表(慧经营"按店铺展示"导出的真实费用)
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_daily_profit (
      shop_id          INTEGER NOT NULL,
      date             TEXT NOT NULL,
      sales_amount     REAL,
      promo_spend      REAL,
      platform_fee     REAL,
      labor_fee        REAL,
      net_profit       REAL,
      net_profit_rate  REAL,
      promo_fee_ratio  REAL,
      roi              REAL,
      metrics_json     TEXT NOT NULL DEFAULT '{}',
      raw_row_json     TEXT,
      captured_at      TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (shop_id, date),
      FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
    );
    CREATE INDEX IF NOT EXISTS idx_shop_daily_profit_date ON shop_daily_profit(date);
  `);

  // 拼多多店铺映射表
  db.exec(`
    CREATE TABLE IF NOT EXISTS pdd_shop_mapping (
      pdd_mall_id           TEXT PRIMARY KEY,
      pdd_shop_name         TEXT,
      huice_shop_id         INTEGER NOT NULL,
      match_method          TEXT NOT NULL DEFAULT 'product_id_auto' CHECK(match_method IN ('product_id_auto', 'manual')),
      matched_product_count INTEGER NOT NULL DEFAULT 0,
      status                TEXT NOT NULL DEFAULT 'confirmed',
      created_at            TEXT DEFAULT (datetime('now')),
      updated_at            TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (huice_shop_id) REFERENCES shops(shop_id)
    );
  `);

  // 拼多多推广日报表(独立于 shop_daily_profit,避免推广数据覆盖慧经营原始数据)
  db.exec(`
    CREATE TABLE IF NOT EXISTS pdd_promo_daily (
      shop_id       INTEGER NOT NULL,
      date          TEXT NOT NULL,
      promo_spend   REAL,
      roi           REAL,
      gmv           REAL,
      captured_at   TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (shop_id, date),
      FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pdd_promo_daily_date ON pdd_promo_daily(date);
  `);
}

function productProfitTableSql(tableName) {
  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      product_id     TEXT NOT NULL,               -- 商品链接ID(拼多多 goodsId)
      product_name   TEXT,
      shop_name      TEXT NOT NULL DEFAULT '',
      shop_id        INTEGER,                     -- 关联 shops(可空,未匹配时留空)
      date           TEXT NOT NULL,               -- YYYY-MM-DD
      sales_amount   REAL,
      sales_quantity INTEGER,
      order_count    INTEGER,                     -- 当前口径:销售件数即订单数
      refund_amount  REAL,
      refund_rate    REAL,                        -- 小数(0.05 = 5%)
      gross_profit   REAL,
      gross_profit_rate REAL,
      raw_net_profit REAL,                        -- 慧经营原始净利额
      raw_net_profit_rate REAL,
      net_profit     REAL,                        -- 额外扣减后的净利润
      net_profit_rate REAL,                       -- 调整后净利率
      cost_price     REAL,                        -- 慧经营销售成本金额
      order_fixed_cost REAL,                      -- 1.15元/订单
      platform_fee   REAL,
      platform_fee_rate REAL,
      order_fixed_unit_cost REAL,
      profit_formula_version TEXT,
      raw_json       TEXT,                        -- 完整 record(调试)
      captured_at    TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (shop_name, product_id, date),
      FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
    );
    CREATE INDEX IF NOT EXISTS idx_product_profit_date ON product_profit(date);
    CREATE INDEX IF NOT EXISTS idx_product_profit_shop ON product_profit(shop_name, date);
  `;
}

function ensureProductProfitSchema(db) {
  const cols = db.prepare('PRAGMA table_info(product_profit)').all();
  const names = new Set(cols.map(c => c.name));
  const addColumn = (name, ddl) => {
    if (!names.has(name)) db.exec(`ALTER TABLE product_profit ADD COLUMN ${name} ${ddl}`);
  };
  addColumn('order_count', 'INTEGER');
  addColumn('gross_profit', 'REAL');
  addColumn('gross_profit_rate', 'REAL');
  addColumn('raw_net_profit', 'REAL');
  addColumn('raw_net_profit_rate', 'REAL');
  addColumn('order_fixed_cost', 'REAL');
  addColumn('platform_fee', 'REAL');
  addColumn('platform_fee_rate', 'REAL');
  addColumn('order_fixed_unit_cost', 'REAL');
  addColumn('profit_formula_version', 'TEXT');

  const pkCols = cols.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
  if (pkCols.join(',') === 'shop_name,product_id,date') return;

  const backup = `product_profit_backup_${Date.now()}`;
  db.exec(`ALTER TABLE product_profit RENAME TO ${backup}`);
  db.exec(productProfitTableSql('product_profit'));
  db.exec(`
    INSERT OR REPLACE INTO product_profit (
      product_id, product_name, shop_name, shop_id, date,
      sales_amount, sales_quantity, order_count,
      refund_amount, refund_rate, gross_profit, gross_profit_rate,
      raw_net_profit, raw_net_profit_rate, net_profit, net_profit_rate,
      cost_price, order_fixed_cost, platform_fee, platform_fee_rate,
      order_fixed_unit_cost, profit_formula_version, raw_json, captured_at
    )
    SELECT
      product_id, product_name, COALESCE(shop_name, ''), shop_id, date,
      sales_amount, sales_quantity, order_count,
      refund_amount, refund_rate, gross_profit, gross_profit_rate,
      COALESCE(raw_net_profit, net_profit), COALESCE(raw_net_profit_rate, net_profit_rate),
      net_profit, net_profit_rate,
      cost_price, order_fixed_cost, platform_fee, platform_fee_rate,
      order_fixed_unit_cost, profit_formula_version, raw_json, captured_at
    FROM ${backup}
  `);
}

/** 插入或更新店铺 */
export function upsertShop(huiceName) {
  const db = getDb();
  // 解析平台和店名
  const m = huiceName.match(/^(.+?)[【】\(\)（（]/);
  let platform = '';
  if (huiceName.startsWith('拼')) platform = 'pinduoduo';
  else if (huiceName.startsWith('淘')) platform = 'taobao';
  else if (huiceName.startsWith('抖') || huiceName.includes('抖音')) platform = 'douyin';
  else if (huiceName.startsWith('快')) platform = 'kuaishou';
  else if (huiceName.startsWith('京')) platform = 'jd';
  else if (huiceName.includes('天猫')) platform = 'tmall';
  else if (huiceName.includes('小红书')) platform = 'xiaohongshu';
  else if (huiceName.includes('视频号')) platform = 'wechat_video';

  const shopName = huiceName.replace(/^(拼|淘|抖|快|京|【天猫】|抖音|快手|京东|小红书|【视频号】|（抖音）|（淘宝）|（快手）|（淘特）)/, '').replace(/[【】]/g, '');

  const stmt = db.prepare(`
    INSERT INTO shops (huice_name, platform, shop_name)
    VALUES (?, ?, ?)
    ON CONFLICT(huice_name) DO UPDATE SET
      platform = excluded.platform,
      shop_name = excluded.shop_name,
      updated_at = datetime('now')
  `);
  const info = stmt.run(huiceName, platform, shopName);
  // 返回 shop 对象
  const row = db.prepare('SELECT shop_id, huice_name, shop_name FROM shops WHERE huice_name = ?').get(huiceName);
  return row;
}

/** 批量插入每日利润(有则更新) */
export function upsertDailyProfit(shopId, date, metricsJson, rawRowsJson) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO daily_profit (shop_id, date, metrics_json, raw_rows_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(shop_id, date) DO UPDATE SET
      metrics_json = excluded.metrics_json,
      raw_rows_json = excluded.raw_rows_json,
      captured_at = datetime('now')
  `);
  return stmt.run(shopId, date, metricsJson, rawRowsJson);
}

/** 记录抓取日志 */
export function logFetch(shopId, shopName, startDate, endDate, rowsFetched, status, error) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO fetch_log (shop_id, shop_name, start_date, end_date, rows_fetched, status, error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(shopId, shopName, startDate, endDate, rowsFetched, status || 'success', error || null);
}

/** 查询某店铺某日利润 */
export function getDailyProfit(shopId, date) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM daily_profit WHERE shop_id = ? AND date = ?').get(shopId, date);
  if (!row) return null;
  return { ...row, metrics: JSON.parse(row.metrics_json) };
}

/** 查询某店铺日期范围利润 */
export function getDailyProfitRange(shopId, startDate, endDate) {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM daily_profit WHERE shop_id = ? AND date BETWEEN ? AND ? ORDER BY date'
  ).all(shopId, startDate, endDate);
  return rows.map(r => ({ ...r, metrics: JSON.parse(r.metrics_json) }));
}

/** 商品级:单条 upsert(来自 huice-sync.mjs 抓的 record) */
export function upsertProductProfit(record) {
  const db = getDb();
  const normalized = normalizeProfitRecord(record);
  // 尝试用 shopName 反查 shop_id(可选关联)
  let shopId = null;
  if (normalized.shopName) {
    // shopName 可能是"拼【周贝瑞"格式,也可能纯店名;都试一遍
    shopId = db.prepare('SELECT shop_id FROM shops WHERE huice_name = ? OR shop_name = ?').get(normalized.shopName, normalized.shopName)?.shop_id || null;
  }
  const stmt = db.prepare(`
    INSERT INTO product_profit
      (product_id, product_name, shop_name, shop_id, date,
       sales_amount, sales_quantity, order_count,
       refund_amount, refund_rate, gross_profit, gross_profit_rate,
       raw_net_profit, raw_net_profit_rate, net_profit, net_profit_rate,
       cost_price, order_fixed_cost, platform_fee, platform_fee_rate,
       order_fixed_unit_cost, profit_formula_version, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_name, product_id, date) DO UPDATE SET
      product_name  = excluded.product_name,
      shop_id       = excluded.shop_id,
      sales_amount  = excluded.sales_amount,
      sales_quantity= excluded.sales_quantity,
      order_count   = excluded.order_count,
      refund_amount = excluded.refund_amount,
      refund_rate   = excluded.refund_rate,
      gross_profit  = excluded.gross_profit,
      gross_profit_rate = excluded.gross_profit_rate,
      raw_net_profit = excluded.raw_net_profit,
      raw_net_profit_rate = excluded.raw_net_profit_rate,
      net_profit    = excluded.net_profit,
      net_profit_rate = excluded.net_profit_rate,
      cost_price    = excluded.cost_price,
      order_fixed_cost = excluded.order_fixed_cost,
      platform_fee  = excluded.platform_fee,
      platform_fee_rate = excluded.platform_fee_rate,
      order_fixed_unit_cost = excluded.order_fixed_unit_cost,
      profit_formula_version = excluded.profit_formula_version,
      raw_json      = excluded.raw_json,
      captured_at   = datetime('now')
  `);
  return stmt.run(
    String(normalized.productId),
    normalized.productName || null,
    normalized.shopName || '',
    shopId,
    normalized.date,
    normalized.salesAmount ?? null,
    normalized.salesQuantity ?? null,
    normalized.orderCount ?? null,
    normalized.refundAmount ?? null,
    normalized.refundRate ?? null,
    normalized.grossProfit ?? null,
    normalized.grossProfitRate ?? null,
    normalized.rawNetProfit ?? null,
    normalized.rawNetProfitRate ?? null,
    normalized.netProfit ?? null,
    normalized.netProfitRate ?? null,
    normalized.costPrice ?? null,
    normalized.orderFixedCost ?? null,
    normalized.platformFee ?? null,
    normalized.platformFeeRate ?? null,
    normalized.orderFixedUnitCost ?? null,
    normalized.profitFormulaVersion ?? null,
    JSON.stringify(normalized)
  );
}

/** 商品级:批量 upsert(同日多商品),返回入库条数 */
export function bulkUpsertProductProfit(records) {
  if (!records?.length) return 0;
  const db = getDb();
  const tx = db.transaction((rows) => {
    let n = 0;
    for (const r of rows) {
      if (!r.productId || !r.date) continue;
      upsertProductProfit(r);
      n++;
    }
    return n;
  });
  return tx(records);
}

/** 商品级:查某日所有商品记录 */
export function getProductProfitByDate(date) {
  const db = getDb();
  return db.prepare('SELECT * FROM product_profit WHERE date = ? ORDER BY net_profit DESC').all(date);
}

/** 商品级:查某店铺日期范围内商品记录 */
export function getProductProfitRange(shopName, startDate, endDate) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM product_profit WHERE shop_name = ? AND date BETWEEN ? AND ? ORDER BY date, product_id'
  ).all(shopName, startDate, endDate);
}

/** 按汇策店名找 shopId */
export function findShopId(huiceName) {
  const db = getDb();
  const row = db.prepare('SELECT shop_id FROM shops WHERE huice_name = ?').get(huiceName);
  return row?.shop_id || null;
}

/** 列出所有店铺 */
export function listShops() {
  const db = getDb();
  return db.prepare('SELECT * FROM shops ORDER BY shop_id').all();
}

/** 数据库路径(供调试) */
export function getDbPath() { return DB_PATH; }

export function closeDb() { if (_db) { _db.close(); _db = null; } }

// ============ 店铺日报利润 ============

export function findShopByName(huiceName) {
  const db = getDb();
  return db.prepare('SELECT * FROM shops WHERE huice_name = ?').get(huiceName);
}

export function upsertShopDailyProfit(record) {
  const db = getDb();
  db.prepare(`
    INSERT INTO shop_daily_profit (shop_id, date, sales_amount, promo_spend, platform_fee, labor_fee, net_profit, net_profit_rate, promo_fee_ratio, roi, metrics_json, raw_row_json)
    VALUES (@shopId, @date, @salesAmount, @promoSpend, @platformFee, @laborFee, @netProfit, @netProfitRate, @promoFeeRatio, @roi, @metricsJson, @rawRowJson)
    ON CONFLICT(shop_id, date) DO UPDATE SET
      sales_amount = excluded.sales_amount,
      promo_spend = excluded.promo_spend,
      platform_fee = excluded.platform_fee,
      labor_fee = excluded.labor_fee,
      net_profit = excluded.net_profit,
      net_profit_rate = excluded.net_profit_rate,
      promo_fee_ratio = excluded.promo_fee_ratio,
      roi = excluded.roi,
      metrics_json = excluded.metrics_json,
      raw_row_json = excluded.raw_row_json,
      captured_at = datetime('now')
  `).run({
    shopId: record.shopId,
    date: record.date,
    salesAmount: record.salesAmount ?? null,
    promoSpend: record.promoSpend ?? null,
    platformFee: record.platformFee ?? null,
    laborFee: record.laborFee ?? null,
    netProfit: record.netProfit ?? null,
    netProfitRate: record.netProfitRate ?? null,
    promoFeeRatio: record.promoFeeRatio ?? null,
    roi: record.roi ?? null,
    metricsJson: JSON.stringify(record.metrics || {}),
    rawRowJson: JSON.stringify(record.rawRow || {}),
  });
}

export function getShopDailyProfitRange(shopId, startDate, endDate) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM shop_daily_profit WHERE shop_id = ? AND date BETWEEN ? AND ? ORDER BY date'
  ).all(shopId, startDate, endDate);
}

export function getShopDailyProfitRangeByMallId(pddMallId, startDate, endDate) {
  const db = getDb();
  const mapping = db.prepare('SELECT huice_shop_id FROM pdd_shop_mapping WHERE pdd_mall_id = ? AND status = ?').get(pddMallId, 'confirmed');
  if (!mapping) return [];
  return getShopDailyProfitRange(mapping.huice_shop_id, startDate, endDate);
}

// ============ 拼多多店铺映射 ============

export function upsertPddShopMapping(record) {
  const db = getDb();
  db.prepare(`
    INSERT INTO pdd_shop_mapping (pdd_mall_id, pdd_shop_name, huice_shop_id, match_method, matched_product_count, status)
    VALUES (@pddMallId, @pddShopName, @huiceShopId, @matchMethod, @matchedProductCount, @status)
    ON CONFLICT(pdd_mall_id) DO UPDATE SET
      pdd_shop_name = excluded.pdd_shop_name,
      huice_shop_id = excluded.huice_shop_id,
      match_method = excluded.match_method,
      matched_product_count = excluded.matched_product_count,
      status = excluded.status,
      updated_at = datetime('now')
  `).run({
    pddMallId: record.pddMallId,
    pddShopName: record.pddShopName || '',
    huiceShopId: record.huiceShopId,
    matchMethod: record.matchMethod || 'product_id_auto',
    matchedProductCount: record.matchedProductCount || 0,
    status: record.status || 'confirmed',
  });
}

export function getPddShopMapping(pddMallId) {
  const db = getDb();
  return db.prepare('SELECT * FROM pdd_shop_mapping WHERE pdd_mall_id = ?').get(pddMallId);
}

/** 用商品 ID 反查慧经营店铺候选(按匹配数排序,至少匹配2个商品) */
export function findShopCandidatesByProductIds(productIds) {
  if (!productIds || productIds.length === 0) return [];
  const db = getDb();
  const placeholders = productIds.map(() => '?').join(',');
  // product_profit.shop_name 就是慧经营店铺名(拼【xxx),关联是精确的
  // 不用 LIKE '拼%' 因为所有店铺都是拼开头,没有区分度
  // 非拼多多店铺(淘宝/天猫)的 shop_name 不会跟 shops.huice_name 关联上
  // 用 HAVING >= 2 过滤掉碰巧匹配1个商品的错误候选
  return db.prepare(`
    SELECT s.shop_id, s.huice_name AS shop_name, COUNT(DISTINCT p.product_id) AS matched_product_count
    FROM product_profit p
    JOIN shops s ON s.huice_name = p.shop_name
    WHERE p.product_id IN (${placeholders})
    GROUP BY s.shop_id, s.huice_name
    HAVING matched_product_count >= 1
    ORDER BY matched_product_count DESC, s.huice_name ASC
  `).all(...productIds);
}

// ============ 拼多多推广日报(独立表,不覆盖慧经营数据) ============

export function upsertPddPromoDaily(record) {
  const db = getDb();
  db.prepare(`
    INSERT INTO pdd_promo_daily (shop_id, date, promo_spend, roi, gmv)
    VALUES (@shopId, @date, @promoSpend, @roi, @gmv)
    ON CONFLICT(shop_id, date) DO UPDATE SET
      promo_spend = excluded.promo_spend,
      roi = excluded.roi,
      gmv = excluded.gmv,
      captured_at = datetime('now')
  `).run({
    shopId: record.shopId,
    date: record.date,
    promoSpend: record.promoSpend ?? null,
    roi: record.roi ?? null,
    gmv: record.gmv ?? null,
  });
}

export function getPddPromoDaily(shopId, date) {
  const db = getDb();
  return db.prepare('SELECT * FROM pdd_promo_daily WHERE shop_id = ? AND date = ?').get(shopId, date);
}

export function getPddPromoDailyRange(shopId, startDate, endDate) {
  const db = getDb();
  return db.prepare('SELECT * FROM pdd_promo_daily WHERE shop_id = ? AND date BETWEEN ? AND ? ORDER BY date').all(shopId, startDate, endDate);
}
