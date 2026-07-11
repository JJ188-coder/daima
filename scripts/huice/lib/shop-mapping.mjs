export function matchedProductIds(records) {
  if (!records || typeof records.keys !== 'function') return [];
  return [...records.keys()].map(String).filter(Boolean);
}

export function decideShopMapping(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { status: 'none', candidate: null };
  }
  // 只匹配到1个商品的候选不够可靠(可能是碰巧有相同商品ID),至少2个才算 unique
  const reliable = candidates.filter(c => (c.matched_product_count || 0) >= 2);
  if (reliable.length === 0) {
    // 没有候选达到2个匹配,但可能有1个的,降级但标记为低信心
    if (candidates.length === 1) {
      return { status: 'ambiguous', candidate: candidates[0] };
    }
    return { status: 'ambiguous', candidate: null };
  }
  if (reliable.length === 1) {
    return { status: 'unique', candidate: reliable[0] };
  }
  return { status: 'ambiguous', candidate: null };
}
