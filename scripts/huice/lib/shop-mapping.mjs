export function matchedProductIds(records) {
  if (!records || typeof records.keys !== 'function') return [];
  return [...records.keys()].map(String).filter(Boolean);
}

export function decideShopMapping(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { status: 'none', candidate: null };
  }
  if (candidates.length === 1) {
    return { status: 'unique', candidate: candidates[0] };
  }
  return { status: 'ambiguous', candidate: null };
}
