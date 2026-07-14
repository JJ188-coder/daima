import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCorsHeaders, isAllowedMutationRequest, resolveAllowedOrigin } from '../scripts/huice/lib/http-security.mjs';

test('allows exact Pinduoduo and extension origins', () => {
  assert.equal(resolveAllowedOrigin('https://mms.pinduoduo.com'), 'https://mms.pinduoduo.com');
  assert.equal(resolveAllowedOrigin('https://yingxiao.pinduoduo.com'), 'https://yingxiao.pinduoduo.com');
  assert.equal(resolveAllowedOrigin('chrome-extension://abcdefghijklmnopabcdefghijklmnop'), 'chrome-extension://abcdefghijklmnopabcdefghijklmnop');
});

test('allows mutations only from approved JSON origins', () => {
  assert.equal(isAllowedMutationRequest('https://mms.pinduoduo.com', 'application/json'), true);
  assert.equal(isAllowedMutationRequest('chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'application/json; charset=utf-8'), true);
  assert.equal(isAllowedMutationRequest('https://example.com', 'application/json'), false);
  assert.equal(isAllowedMutationRequest('https://mms.pinduoduo.com', 'text/plain'), false);
  assert.equal(isAllowedMutationRequest(undefined, 'application/json'), false);
});

test('does not emit an invalid wildcard-port origin', () => {
  assert.equal(resolveAllowedOrigin('http://127.0.0.1:9911'), null);
  assert.equal(resolveAllowedOrigin('https://example.com'), null);
  assert.deepEqual(buildCorsHeaders('https://example.com'), {});
});

