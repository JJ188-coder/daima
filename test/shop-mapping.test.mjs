import assert from 'node:assert/strict';
import test from 'node:test';

import { decideShopMapping, matchedProductIds } from '../scripts/huice/lib/shop-mapping.mjs';

test('uses only matched products when collecting mapping IDs', () => {
  assert.deepEqual(
    matchedProductIds(new Map([
      ['100', { netProfit: 1 }],
      ['200', { netProfit: 2 }],
    ])),
    ['100', '200'],
  );
});

test('confirms exactly one candidate and leaves ambiguous candidates unconfirmed', () => {
  // matched_product_count >= 2 才算 reliable
  assert.deepEqual(
    decideShopMapping([{ shop_id: 7, shop_name: '拼【周贝瑞', matched_product_count: 3 }]),
    { status: 'unique', candidate: { shop_id: 7, shop_name: '拼【周贝瑞', matched_product_count: 3 } },
  );
  assert.deepEqual(
    decideShopMapping([
      { shop_id: 7, shop_name: '拼【周贝瑞', matched_product_count: 3 },
      { shop_id: 8, shop_name: '拼【甜心', matched_product_count: 1 },
    ]),
    { status: 'unique', candidate: { shop_id: 7, shop_name: '拼【周贝瑞', matched_product_count: 3 } },
  );
  // 只匹配1个商品的候选不够可靠
  assert.deepEqual(
    decideShopMapping([{ shop_id: 9, shop_name: '拼【测试', matched_product_count: 1 }]),
    { status: 'ambiguous', candidate: { shop_id: 9, shop_name: '拼【测试', matched_product_count: 1 } },
  );
});

