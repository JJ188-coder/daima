import assert from 'node:assert/strict';
import test from 'node:test';

import { collectorExitCode, createCollectorResult, hasCompletePromoMetrics, markCollectorFailure } from '../scripts/huice/lib/collector-result.mjs';

test('returns non-zero when any date failed', () => {
  const result = createCollectorResult();
  markCollectorFailure(result, '2026-07-09', 'download timeout');
  assert.equal(collectorExitCode(result), 1);
});

test('returns zero only when no date and no fatal error failed', () => {
  assert.equal(collectorExitCode(createCollectorResult()), 0);
  assert.equal(collectorExitCode({ failedDates: [], fatalError: new Error('offline') }), 1);
});

test('requires ROI only when promotion spend is positive', () => {
  assert.equal(hasCompletePromoMetrics({ promoSpend: 12, roi: 3.5 }), true);
  assert.equal(hasCompletePromoMetrics({ promoSpend: 12, roi: null }), false);
  assert.equal(hasCompletePromoMetrics({ promoSpend: 0, roi: null }), true);
  assert.equal(hasCompletePromoMetrics({ promoSpend: null, roi: null }), false);
});
