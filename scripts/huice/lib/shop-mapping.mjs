export function matchedProductIds(records) {
  if (!records || typeof records.keys !== 'function') return [];
  return [...records.keys()].map(String).filter(Boolean);
}

export function decideShopMapping(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { status: 'none', candidate: null };
  }
  // 每个商品ID在慧经营里只属于一个店铺,所以只要1个商品匹配就能确定
  if (candidates.length === 1) {
    return { status: 'unique', candidate: candidates[0] };
  }
  // 多个候选取匹配数最多的
  const best = candidates.reduce((a, b) => (a.matched_product_count >= b.matched_product_count ? a : b));
  return { status: 'ambiguous', candidate: null };
}
