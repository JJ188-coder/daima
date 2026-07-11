import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('reselects PDD shops after every navigation during multi-day export', async () => {
  const source = await readFile(new URL('../tools/huice-shop-export-cdp.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /if \(i === 0\) \{\s*await selectAllPddShops\(ws\);\s*\}/);
  assert.match(source, /await selectAllPddShops\(ws\);/);
});
