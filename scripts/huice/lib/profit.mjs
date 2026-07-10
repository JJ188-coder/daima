export const PROFIT_FORMULA_VERSION = 'order-fixed-v1';
export const DEFAULT_ORDER_FIXED_COST = 1.15;
export const DEFAULT_PLATFORM_FEE_RATE = 0.02;

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/,/g, '').replace(/%/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function hasNumber(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function ratio(numerator, denominator) {
  const n = toNumber(numerator);
  const d = toNumber(denominator);
  return n !== null && d !== null && d > 0 ? n / d : null;
}

function pickText(current, candidate) {
  if (!current && candidate) return candidate;
  if (candidate && candidate.length > current.length) return candidate;
  return current;
}

export function applyProfitFormula(input, options = {}) {
  const salesAmount = toNumber(input.salesAmount);
  const salesQuantity = toNumber(input.salesQuantity);
  const orderCount = toNumber(input.orderCount ?? input.salesQuantity);
  const rawNetProfit = toNumber(input.rawNetProfit ?? input.huiceNetProfit);
  const rawNetProfitRate = toNumber(input.rawNetProfitRate) ?? ratio(rawNetProfit, salesAmount);
  const orderFixedUnitCost = toNumber(options.orderFixedUnitCost) ?? DEFAULT_ORDER_FIXED_COST;
  const platformFeeRate = toNumber(options.platformFeeRate) ?? DEFAULT_PLATFORM_FEE_RATE;

  const orderFixedCost = orderCount !== null ? orderCount * orderFixedUnitCost : null;
  const platformFee = salesAmount !== null ? salesAmount * platformFeeRate : null;
  const extraDeduction = (orderFixedCost ?? 0) + (platformFee ?? 0);
  const netProfit = rawNetProfit !== null ? rawNetProfit - extraDeduction : null;

  return {
    rawNetProfit,
    rawNetProfitRate,
    netProfit,
    netProfitRate: ratio(netProfit, salesAmount),
    orderCount,
    salesQuantity,
    orderFixedCost,
    platformFee,
    platformFeeRate,
    orderFixedUnitCost,
    profitFormulaVersion: PROFIT_FORMULA_VERSION,
  };
}

export function normalizeProfitRecord(record, options = {}) {
  const salesAmount = toNumber(record.salesAmount);
  const salesQuantity = toNumber(record.salesQuantity);
  const orderCount = toNumber(record.orderCount ?? record.salesQuantity);
  const rawNetProfit = toNumber(record.rawNetProfit ?? record.huiceNetProfit ?? record.netProfit);
  const adjustedNetProfit = toNumber(record.netProfit);
  const formula = applyProfitFormula({
    salesAmount,
    salesQuantity,
    orderCount,
    rawNetProfit,
    rawNetProfitRate: record.rawNetProfitRate ?? record.huiceNetProfitRate ?? record.netProfitRate,
  }, options);

  const refundAmount = toNumber(record.refundAmount);
  const grossProfit = toNumber(record.grossProfit);
  const costPrice = toNumber(record.costPrice);

  return {
    ...record,
    productId: String(record.productId || ''),
    productName: record.productName || '',
    shopName: record.shopName || '',
    salesAmount,
    salesQuantity,
    orderCount: formula.orderCount,
    costPrice,
    grossProfit,
    grossProfitRate: toNumber(record.grossProfitRate) ?? ratio(grossProfit, salesAmount),
    refundAmount,
    refundRate: toNumber(record.refundRate) ?? ratio(refundAmount, salesAmount),
    rawNetProfit: formula.rawNetProfit,
    rawNetProfitRate: formula.rawNetProfitRate,
    netProfit: adjustedNetProfit ?? formula.netProfit,
    netProfitRate: toNumber(record.netProfitRate) ?? ratio(adjustedNetProfit ?? formula.netProfit, salesAmount),
    orderFixedCost: toNumber(record.orderFixedCost) ?? formula.orderFixedCost,
    platformFee: toNumber(record.platformFee) ?? formula.platformFee,
    platformFeeRate: formula.platformFeeRate,
    orderFixedUnitCost: formula.orderFixedUnitCost,
    profitFormulaVersion: formula.profitFormulaVersion,
  };
}

export function aggregateProfitRecords(records) {
  const byProduct = {};
  for (const input of records || []) {
    const r = normalizeProfitRecord(input);
    if (!r.productId) continue;
    if (!byProduct[r.productId]) {
      byProduct[r.productId] = { ...r };
      continue;
    }

    const existing = byProduct[r.productId];
    existing.productName = pickText(existing.productName || '', r.productName || '');
    existing.shopName = pickText(existing.shopName || '', r.shopName || '');

    for (const field of [
      'salesAmount',
      'salesQuantity',
      'orderCount',
      'costPrice',
      'grossProfit',
      'refundAmount',
      'rawNetProfit',
      'netProfit',
      'orderFixedCost',
      'platformFee',
    ]) {
      const a = toNumber(existing[field]);
      const b = toNumber(r[field]);
      existing[field] = hasNumber(a) || hasNumber(b) ? (a ?? 0) + (b ?? 0) : null;
    }

    if (!existing.date || r.date > existing.date) existing.date = r.date;
    existing.source = r.source || existing.source;
    existing.profitFormulaVersion = r.profitFormulaVersion || existing.profitFormulaVersion;
  }

  for (const r of Object.values(byProduct)) {
    r.netProfitRate = ratio(r.netProfit, r.salesAmount);
    r.rawNetProfitRate = ratio(r.rawNetProfit, r.salesAmount);
    r.grossProfitRate = ratio(r.grossProfit, r.salesAmount);
    r.refundRate = ratio(r.refundAmount, r.salesAmount);
  }
  return Object.values(byProduct);
}

export function summarizeProfitRecords(records) {
  const aggregated = aggregateProfitRecords(records);
  const matched = aggregated.filter(record => Number.isFinite(record.netProfit));
  const sum = field => {
    const values = matched.map(record => record[field]).filter(Number.isFinite);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const salesAmount = sum('salesAmount');
  const netProfit = sum('netProfit');
  return {
    matchedProductCount: matched.length,
    summary: {
      salesAmount,
      rawNetProfit: sum('rawNetProfit'),
      orderFixedCost: sum('orderFixedCost'),
      platformFee: sum('platformFee'),
      netProfit,
      netProfitRate: salesAmount && salesAmount > 0 && netProfit !== null ? netProfit / salesAmount : null,
    },
  };
}
