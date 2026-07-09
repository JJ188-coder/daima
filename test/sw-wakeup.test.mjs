import assert from 'node:assert/strict';
import test from 'node:test';

import { selectWakeupPageTabs } from '../scripts/huice/lib/sw-wakeup.mjs';

test('selects business pages for SW wakeup and ignores chrome pages', () => {
  const tabs = [
    { type: 'page', url: 'chrome://extensions/', id: 'chrome' },
    { type: 'page', url: 'https://example.com/', id: 'other' },
    { type: 'page', url: 'https://hjy.huice.com/#/dashboard', id: 'huice' },
    { type: 'page', url: 'https://mms.pinduoduo.com/sycm/goods_effect', id: 'pdd' },
    { type: 'service_worker', url: 'chrome-extension://abc/background.js', id: 'sw' },
  ];

  assert.deepEqual(selectWakeupPageTabs(tabs).map(t => t.id), ['pdd', 'huice']);
});

test('keeps all matching pages so wakeup can try the next candidate', () => {
  const tabs = [
    { type: 'page', url: 'https://mms.pinduoduo.com/page-a', id: 'pdd-a' },
    { type: 'page', url: 'https://mms.pinduoduo.com/page-b', id: 'pdd-b' },
  ];

  assert.deepEqual(selectWakeupPageTabs(tabs).map(t => t.id), ['pdd-a', 'pdd-b']);
});
