import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCorsHeaders, resolveAllowedOrigin } from '../scripts/huice/lib/http-security.mjs';

test('allows exact Pinduoduo and extension origins', () => {
  assert.equal(resolveAllowedOrigin('https://mms.pinduoduo.com'), 'https://mms.pinduoduo.com');
  assert.equal(resolveAllowedOrigin('https://yingxiao.pinduoduo.com'), 'https://yingxiao.pinduoduo.com');
  assert.equal(resolveAllowedOrigin('chrome-extension://abcdefghijklmnopabcdefghijklmnop'), 'chrome-extension://abcdefghijklmnopabcdefghijklmnop');
});

test('does not emit an invalid wildcard-port origin', () => {
  assert.equal(resolveAllowedOrigin('http://127.0.0.1:9911'), null);
  assert.equal(resolveAllowedOrigin('https://example.com'), null);
  assert.deepEqual(buildCorsHeaders('https://example.com'), {});
});

