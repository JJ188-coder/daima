/**
 * shop-profit.mjs - 店铺日报利润纯计算模块
 *
 * 使用慧经营"按店铺展示"导出的真实店铺费用,不套商品级估算公式。
 * 核心函数: buildStoreReportDay, parseShopExportRows, normalizeShopExportRow
 */

const SHOP_EXPORT_HEADERS = {
  shopName: ['店铺名称'],
  salesAmount: ['一、销售收入', '销售收入', '销售额'],
  promoSpend: ['七、运营推广费用', '推广费', '推广费用', '广告费'],
  platformFee: ['八、平台固定费用', '平台费', '平台服务费'],
  laborFee: ['九、人工成本', '人工费', '包装人工', '包装人工费'],
  netProfit: ['十二、净利润', '净利润', '十一、净利润'],
  netProfitRate: ['十三、净利润率', '净利润率', '净利率'],
  promoFeeRatio: ['十四、推广费比', '推广费比', '费比'],
  roi: ['ROI', '投入产出比'],
};

export function toNumber(value) {
  if (value == null || value === '' || value === '--') return null;
  const normalized = String(value).replace(/[,%¥\s]/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 百分比字符串转小数 ("12.50%" -> 0.125) */
export function toPercent(value) {
  if (value == null || value === '' || value === '--') return null;
  const s = String(value).replace(/%/g, '').trim();
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n / 100 : null;
}

export function buildStoreReportDay({ date, shop }) {
  const salesAmount = toNumber(shop?.salesAmount);
  const netProfit = toNumber(shop?.netProfit);
  const promoSpend = toNumber(shop?.promoSpend);
  const exportedNetProfitRate = toNumber(shop?.netProfitRate);
  const exportedPromoFeeRatio = toNumber(shop?.promoFeeRatio);
  const exportedRoi = toNumber(shop?.roi);
  const netProfitRate =
    exportedNetProfitRate ?? (salesAmount && netProfit != null ? netProfit / salesAmount : null);
  const promoFeeRatio =
    exportedPromoFeeRatio ?? (salesAmount && promoSpend != null ? promoSpend / salesAmount : null);
  const roi = exportedRoi ?? (promoSpend ? salesAmount / promoSpend : null);

  return {
    date,
    salesAmount,
    promoSpend,
    roi,
    breakEvenRoi: netProfitRate && netProfitRate > 0 ? 1 / netProfitRate : null,
    promoFeeRatio,
    netProfitRate,
    netProfit,
    isLoss: netProfit != null && netProfit < 0,
  };
}

/** 按表头名找列号 */
function findColIndex(headers, candidates) {
  for (const candidate of candidates) {
    const idx = headers.findIndex(h => String(h).trim() === candidate);
    if (idx >= 0) return idx;
  }
  return -1;
}

/** 从一行数据提取已知字段 + 保留未知字段到 metrics */
export function normalizeShopExportRow(headers, row, date) {
  const colMap = {};
  for (const [field, candidates] of Object.entries(SHOP_EXPORT_HEADERS)) {
    const idx = findColIndex(headers, candidates);
    if (idx >= 0) colMap[field] = idx;
  }

  const shopName = colMap.shopName != null ? String(row[colMap.shopName] || '').trim() : '';
  if (!shopName || shopName === '合计' || shopName === '总计') return null;

  const record = {
    shopName,
    date,
    salesAmount: colMap.salesAmount != null ? toNumber(row[colMap.salesAmount]) : null,
    promoSpend: colMap.promoSpend != null ? toNumber(row[colMap.promoSpend]) : null,
    platformFee: colMap.platformFee != null ? toNumber(row[colMap.platformFee]) : null,
    laborFee: colMap.laborFee != null ? toNumber(row[colMap.laborFee]) : null,
    netProfit: colMap.netProfit != null ? toNumber(row[colMap.netProfit]) : null,
    netProfitRate: colMap.netProfitRate != null ? toPercent(row[colMap.netProfitRate]) : null,
    promoFeeRatio: colMap.promoFeeRatio != null ? toPercent(row[colMap.promoFeeRatio]) : null,
    roi: colMap.roi != null ? toNumber(row[colMap.roi]) : null,
  };

  // 保留未知字段
  const metrics = {};
  const rawRow = {};
  headers.forEach((h, i) => {
    const headerName = String(h).trim();
    rawRow[headerName] = row[i];
    // 已知字段也存进 metrics
    for (const [field, candidates] of Object.entries(SHOP_EXPORT_HEADERS)) {
      if (candidates.includes(headerName) && record[field] != null) {
        metrics[field] = record[field];
      }
    }
    // 未知费用字段
    if (!Object.values(SHOP_EXPORT_HEADERS).flat().includes(headerName)) {
      const numVal = toNumber(row[i]);
      if (numVal != null) metrics[headerName] = numVal;
    }
  });

  record.metrics = metrics;
  record.rawRow = rawRow;
  return record;
}

/** 解析 XLSX 行数组为店铺日报记录 */
export function parseShopExportRows(rows, date) {
  if (!rows || rows.length < 2) return [];
  // 找表头行: 第一行可能是标题信息,真正的表头是含"店铺名称"的行
  let headerIdx = 0;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    if (rows[i].some(c => String(c).includes('店铺名称'))) {
      headerIdx = i;
      break;
    }
  }
  const headers = rows[headerIdx];
  const records = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const record = normalizeShopExportRow(headers, rows[i], date);
    if (record) records.push(record);
  }
  return records;
}

/** 生成日期范围内每一天 */
export function eachDate(start, end) {
  const dates = [];
  const cur = new Date(start);
  const stop = new Date(end);
  while (cur <= stop) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

/** 日期范围补空行 */
export function fillDateRange({ start, end, rowsByDate }) {
  return eachDate(start, end).map(date =>
    rowsByDate.get(date) ?? { date, missing: true }
  );
}

/** 解析店铺映射候选 */
export function resolveShopCandidates(records) {
  if (!records || records.length === 0) {
    return { status: 'none', candidates: [] };
  }
  // 按 shopId 聚合
  const byShop = new Map();
  for (const r of records) {
    if (!r.shopId) continue;
    if (!byShop.has(r.shopId)) {
      byShop.set(r.shopId, { shopId: r.shopId, shopName: r.shopName || '', matchedProductCount: 0 });
    }
    byShop.get(r.shopId).matchedProductCount++;
  }
  const candidates = [...byShop.values()].sort((a, b) => b.matchedProductCount - a.matchedProductCount);
  if (candidates.length === 0) return { status: 'none', candidates: [] };
  if (candidates.length === 1) return { status: 'unique', candidates };
  return { status: 'ambiguous', candidates };
}
