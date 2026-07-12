export function createCollectorResult() {
  return { failedDates: [], failures: [], fatalError: null };
}

export function markCollectorFailure(result, date, reason) {
  if (!result.failedDates.includes(date)) result.failedDates.push(date);
  result.failures.push({ date, reason });
  return result;
}

export function collectorExitCode(result) {
  return result?.fatalError || result?.failedDates?.length ? 1 : 0;
}

export function hasCompletePromoMetrics(promo) {
  const isMetric = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  if (!isMetric(promo?.promoSpend)) return false;
  return Number(promo.promoSpend) === 0 || isMetric(promo?.roi);
}
