import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  TARGET_PDD_MALL_ID,
  acquirePromoTarget,
  connectCdp,
  planPromoTargets,
} from '../scripts/huice/lib/pdd-promo-target.mjs';

const PROMO_URL = 'https://yingxiao.pinduoduo.com/goods/report/promotion/overView';
const BROWSER_WS_URL = 'ws://browser';

function candidate(targetId, wsUrl) {
  return {
    targetId,
    url: `${PROMO_URL}?tab=${targetId}`,
    webSocketDebuggerUrl: wsUrl,
  };
}

function createHarness({ mallIds, closeResponse = { result: { success: true } }, mapping = { huice_shop_id: 9 } }) {
  const sockets = [];
  const readsByUrl = new Map();
  const closeCalls = [];
  let mappingCalls = 0;

  return {
    sockets,
    closeCalls,
    get mappingCalls() { return mappingCalls; },
    deps: {
      connectCdp: async (url) => {
        const ws = {
          url,
          closeCount: 0,
          close() { this.closeCount += 1; },
        };
        sockets.push(ws);
        return ws;
      },
      readMallId: async (ws) => {
        const values = mallIds[ws.url];
        const readIndex = readsByUrl.get(ws.url) ?? 0;
        readsByUrl.set(ws.url, readIndex + 1);
        const value = Array.isArray(values) ? values[readIndex] : values;
        if (value instanceof Error) throw value;
        return value;
      },
      cdpCall: async (ws, method, params) => {
        assert.equal(ws.url, BROWSER_WS_URL);
        assert.equal(method, 'Target.closeTarget');
        closeCalls.push(params.targetId);
        const response = typeof closeResponse === 'function'
          ? closeResponse(params.targetId)
          : closeResponse;
        if (response instanceof Error) throw response;
        return response;
      },
      getMapping: async (mallId) => {
        mappingCalls += 1;
        assert.equal(mallId, TARGET_PDD_MALL_ID);
        if (mapping instanceof Error) throw mapping;
        return mapping;
      },
    },
  };
}

function socketsFor(harness, url) {
  return harness.sockets.filter(ws => ws.url === url);
}

test('connection timeout closes the unreturned socket and ignores a late open', async () => {
  let socket;
  class FakeWebSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.closeCount = 0;
      socket = this;
    }

    close() {
      this.closeCount += 1;
    }
  }

  await assert.rejects(
    connectCdp('ws://late', { WebSocketClass: FakeWebSocket, timeoutMs: 1 }),
    /超时/,
  );

  assert.equal(socket.closeCount, 1);
  socket.dispatchEvent(new Event('open'));
  assert.equal(socket.closeCount, 1);
});

test('plans exactly one target without mutating candidates', () => {
  const candidates = [
    { targetId: 'old', mallId: 'other', url: `${PROMO_URL}?tab=old` },
    { targetId: 'target', mallId: TARGET_PDD_MALL_ID, url: `${PROMO_URL}?tab=target` },
  ];
  const before = structuredClone(candidates);

  const plan = planPromoTargets(candidates);

  assert.equal(plan.keep.targetId, 'target');
  assert.deepEqual(plan.close.map(item => item.targetId), ['old']);
  assert.deepEqual(candidates, before);
  assert.notEqual(plan.close, candidates);
});

test('rejects invalid or ambiguous target plans', () => {
  assert.throws(() => planPromoTargets([]), /no promotion pages/i);
  assert.throws(() => planPromoTargets([
    { targetId: 'x', mallId: '', url: `${PROMO_URL}?tab=x` },
  ]), /mallId.*read/i);
  assert.throws(() => planPromoTargets([
    { targetId: 'x', mallId: 'other', url: `${PROMO_URL}?tab=x` },
  ]), /target promotion mallId.*not found/i);
  assert.throws(() => planPromoTargets([
    { targetId: 'target-a', mallId: TARGET_PDD_MALL_ID, url: `${PROMO_URL}?tab=a` },
    { targetId: 'target-b', mallId: TARGET_PDD_MALL_ID, url: `${PROMO_URL}?tab=b` },
  ]), /ambiguous|multiple/i);
  assert.throws(() => planPromoTargets([
    { targetId: 'x', mallId: TARGET_PDD_MALL_ID, url: 'https://mms.pinduoduo.com/a' },
  ]), /promotion.*host/i);
});

test('unreadable candidate identity aborts before mapping and closes every candidate socket', async () => {
  const tabs = [candidate('old', 'ws://old'), candidate('target', 'ws://target')];
  const harness = createHarness({
    mallIds: {
      'ws://old': new Error('read failed'),
      'ws://target': TARGET_PDD_MALL_ID,
    },
  });

  await assert.rejects(
    acquirePromoTarget({ candidates: tabs, browserWebSocketDebuggerUrl: BROWSER_WS_URL }, harness.deps),
    /mallId.*read|read failed/i,
  );

  assert.equal(harness.mappingCalls, 0);
  assert.equal(socketsFor(harness, 'ws://old')[0].closeCount, 1);
  assert.equal(socketsFor(harness, 'ws://target')[0].closeCount, 1);
  assert.equal(socketsFor(harness, BROWSER_WS_URL).length, 0);
});

test('missing target aborts before mapping and closes every candidate socket', async () => {
  const tabs = [candidate('old-a', 'ws://old-a'), candidate('old-b', 'ws://old-b')];
  const harness = createHarness({
    mallIds: {
      'ws://old-a': 'other-a',
      'ws://old-b': 'other-b',
    },
  });

  await assert.rejects(
    acquirePromoTarget({ candidates: tabs, browserWebSocketDebuggerUrl: BROWSER_WS_URL }, harness.deps),
    /target promotion mallId.*not found/i,
  );

  assert.equal(harness.mappingCalls, 0);
  assert.deepEqual(harness.sockets.map(ws => [ws.url, ws.closeCount]), [
    ['ws://old-a', 1],
    ['ws://old-b', 1],
  ]);
});

for (const [label, closeResponse] of [
  ['protocol rejection', new Error('protocol rejected')],
  ['protocol error response', { error: { message: 'not allowed' } }],
  ['success false response', { result: { success: false } }],
]) {
  test(`${label} aborts before mapping and closes the browser socket`, async () => {
    const tabs = [
      candidate('old-a', 'ws://old-a'),
      candidate('old-b', 'ws://old-b'),
      candidate('target', 'ws://target'),
    ];
    const harness = createHarness({
      mallIds: {
        'ws://old-a': 'other-a',
        'ws://old-b': 'other-b',
        'ws://target': TARGET_PDD_MALL_ID,
      },
      closeResponse: targetId => targetId === 'old-a'
        ? closeResponse
        : { result: { success: true } },
    });

    await assert.rejects(
      acquirePromoTarget({ candidates: tabs, browserWebSocketDebuggerUrl: BROWSER_WS_URL }, harness.deps),
      /protocol rejected|failed to close promotion target/i,
    );

    assert.equal(harness.mappingCalls, 0);
    assert.deepEqual(harness.closeCalls.sort(), ['old-a', 'old-b']);
    assert.equal(socketsFor(harness, BROWSER_WS_URL)[0].closeCount, 1);
    assert.equal(socketsFor(harness, 'ws://target').length, 1);
  });
}

test('revalidation mismatch aborts before mapping and closes the keep socket', async () => {
  const tabs = [candidate('old', 'ws://old'), candidate('target', 'ws://target')];
  const harness = createHarness({
    mallIds: {
      'ws://old': 'other',
      'ws://target': [TARGET_PDD_MALL_ID, 'changed-mall'],
    },
  });

  await assert.rejects(
    acquirePromoTarget({ candidates: tabs, browserWebSocketDebuggerUrl: BROWSER_WS_URL }, harness.deps),
    /verification failed/i,
  );

  assert.equal(harness.mappingCalls, 0);
  assert.equal(socketsFor(harness, BROWSER_WS_URL)[0].closeCount, 1);
  assert.deepEqual(socketsFor(harness, 'ws://target').map(ws => ws.closeCount), [1, 1]);
});

test('mapping failure after revalidation closes the keep socket', async () => {
  const tabs = [candidate('target', 'ws://target')];
  const harness = createHarness({
    mallIds: { 'ws://target': [TARGET_PDD_MALL_ID, TARGET_PDD_MALL_ID] },
    mapping: null,
  });

  await assert.rejects(
    acquirePromoTarget({ candidates: tabs, browserWebSocketDebuggerUrl: BROWSER_WS_URL }, harness.deps),
    /mapping not found/i,
  );

  assert.equal(harness.mappingCalls, 1);
  assert.deepEqual(socketsFor(harness, 'ws://target').map(ws => ws.closeCount), [1, 1]);
});

test('success returns only the verified target and transfers explicit keep socket ownership', async () => {
  const tabs = [candidate('old', 'ws://old'), candidate('target', 'ws://target')];
  const mapping = { huice_shop_id: 123, pdd_shop_name: 'target shop' };
  const harness = createHarness({
    mallIds: {
      'ws://old': 'other',
      'ws://target': [TARGET_PDD_MALL_ID, TARGET_PDD_MALL_ID],
    },
    mapping,
  });

  const acquired = await acquirePromoTarget(
    { candidates: tabs, browserWebSocketDebuggerUrl: BROWSER_WS_URL },
    harness.deps,
  );

  assert.equal(acquired.keep.targetId, 'target');
  assert.equal(acquired.verifiedMallId, TARGET_PDD_MALL_ID);
  assert.equal(acquired.mapping, mapping);
  assert.equal(harness.mappingCalls, 1);
  assert.deepEqual(harness.closeCalls, ['old']);
  assert.equal(socketsFor(harness, 'ws://old')[0].closeCount, 1);
  assert.deepEqual(socketsFor(harness, 'ws://target').map(ws => ws.closeCount), [1, 0]);
  assert.equal(socketsFor(harness, BROWSER_WS_URL)[0].closeCount, 1);
  assert.equal(acquired.keepWs, socketsFor(harness, 'ws://target')[1]);
  assert.equal(typeof acquired.closeKeepWs, 'function');

  acquired.closeKeepWs();
  acquired.closeKeepWs();
  assert.equal(acquired.keepWs.closeCount, 1);
});

test('collector delegates target acquisition and closes retained ownership in finally', async () => {
  const source = await readFile(new URL('../tools/pdd-promo-cdp.mjs', import.meta.url), 'utf8');

  assert.match(source, /acquirePromoTarget\(/);
  assert.match(source, /finally\s*{\s*targetSession\.closeKeepWs\(\)/);
  assert.match(source, /updatePromoSpend\([^;]*targetSession\.mapping\)/s);
  assert.doesNotMatch(source, /shopId\s*:\s*9\b/);
});
