import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);

test('daily sync runs both shop and PDD promotion collectors on macOS and Windows', async () => {
  const [shell, powershell] = await Promise.all([
    readFile(new URL('./scripts/huice-daily.sh', root), 'utf8'),
    readFile(new URL('./scripts/huice-daily.ps1', root), 'utf8'),
  ]);

  for (const source of [shell, powershell]) {
    assert.match(source, /huice-shop-export-cdp\.mjs/);
    assert.match(source, /pdd-promo-cdp\.mjs/);
  }
  assert.doesNotMatch(shell, /失败不影响商品同步/);
  assert.doesNotMatch(shell, /set -e/);
  assert.match(shell, /STATUS=0/);
  assert.match(shell, /存在失败步骤/);
});
