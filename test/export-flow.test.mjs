import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  classifyPopup,
  decideExportPoll,
  decideExportSubmitState,
  downloadCenterBusinessResolverSource,
  elementUiActiveDialogPredicateSource,
  normalizeButtonText,
  normalizeExportTask,
  pickExportTask,
} from '../scripts/huice/lib/export-flow.mjs';

const requestedAt = new Date(2026, 6, 11, 10, 21, 30, 800).getTime();

function task(overrides = {}) {
  return {
    id: overrides.id || 'task-1',
    text: overrides.text || '店铺多维度分析 2026-07-11 10:21:31 待下载',
    buttonText: overrides.buttonText ?? '下载',
    buttonVisible: overrides.buttonVisible ?? true,
    ...overrides,
  };
}

function resolverElement({ className = '', visible = true, parent = null, gridApi = null, textContent = '' } = {}) {
  const attributes = new Map();
  return {
    className,
    parentElement: parent,
    offsetParent: visible ? {} : null,
    textContent,
    __vue__: gridApi ? { gridApi } : undefined,
    getBoundingClientRect: () => ({ width: visible ? 900 : 0, height: visible ? 500 : 0 }),
    closest(selector) {
      let current = this;
      while (current) {
        if (selector === '.analyzerContainer.view') {
          const classes = String(current.className || '').split(/\s+/);
          if (classes.includes('analyzerContainer') && classes.includes('view')) return current;
        }
        current = current.parentElement;
      }
      return null;
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    querySelector(selector) {
      if (selector === '.v-ag-grid') return this.grid || null;
      return null;
    },
  };
}

function downloadCenterGridApi(rows = [{ id: 'task-1', taskName: '商品排名导出', updateTime: '2026-07-11 10:21:31', statusName: '待下载', download: true }]) {
  return {
    forEachNode(callback) { rows.forEach((data, rowIndex) => callback({ data, rowIndex })); },
    getColumnDef(columnId) { return columnId === 'operation' ? { field: 'operation' } : undefined; },
  };
}

function runDownloadCenterResolver({ roots, grids, notifications = [] }) {
  const document = {
    querySelectorAll(selector) {
      if (selector === '.v-ag-grid') return grids;
      if (selector === '.el-notification, .el-message') return notifications;
      return [];
    },
  };
  const location = { hash: '#/baseSettings/downloadCenter' };
  return new Function('document', 'location', `return (${downloadCenterBusinessResolverSource});`)(document, location);
}

function validResolverLayer({ visible = true, rows } = {}) {
  const root = resolverElement({ className: 'analyzerContainer view', visible });
  const gridApi = rows === undefined ? downloadCenterGridApi() : downloadCenterGridApi(rows);
  const grid = resolverElement({ className: 'v-ag-grid', visible, parent: root, gridApi });
  root.grid = grid;
  return { root, grid };
}

test('selects the newest eligible task instead of the first DOM row', () => {
  const old = task({ id: 'old', text: '店铺多维度分析 2026-07-11 10:20:00 待下载' });
  const product = task({ id: 'product', text: '商品排名导出 2026-07-11 10:21:32 待下载' });
  const fresh = task({ id: 'fresh', text: '店铺多维度分析 2026-07-11 10:21:33 待下载' });
  const result = pickExportTask([old, product, fresh], { kind: 'shop', requestedAt, clockSkewMs: 1000 });

  assert.equal(result.selected.key.includes('fresh'), true);
  assert.equal(result.decision, 'click');
});

test('never reuses baseline, consumed, or already downloaded tasks', () => {
  const baseline = normalizeExportTask(task({ id: 'baseline' }));
  const consumed = normalizeExportTask(task({ id: 'consumed', text: '店铺多维度分析 2026-07-11 10:21:32 待下载' }));
  const downloaded = task({ id: 'downloaded', text: '店铺多维度分析 2026-07-11 10:21:33 已下载' });
  const result = pickExportTask([baseline, consumed, downloaded], {
    kind: 'shop',
    requestedAt,
    clockSkewMs: 1000,
    baselineTaskKeys: [baseline.key],
    consumedTaskKeys: [consumed.key],
  });

  assert.equal(result.selected, null);
  assert.equal(result.candidates.find(item => item.key === baseline.key).reason, 'already_present_before_request');
  assert.equal(result.candidates.find(item => item.key === consumed.key).reason, 'already_consumed');
  assert.equal(result.candidates.find(item => item.key.includes('downloaded')).reason, 'already_downloaded');
});

test('waits while a new task is pending or its button is late', () => {
  const pending = pickExportTask([
    task({ id: 'new', text: '店铺多维度分析 2026-07-11 10:21:31 生成中', buttonText: '', buttonVisible: false }),
  ], { kind: 'shop', requestedAt, clockSkewMs: 1000 });
  const buttonPending = pickExportTask([
    task({ id: 'new', text: '店铺多维度分析 2026-07-11 10:21:31 待下载', buttonText: '', buttonVisible: false }),
  ], { kind: 'shop', requestedAt, clockSkewMs: 1000 });

  assert.equal(pending.decision, 'wait');
  assert.equal(pending.reason, 'task_pending');
  assert.equal(buttonPending.decision, 'wait');
  assert.equal(buttonPending.reason, 'download_button_pending');
});

test('fails immediately when the newest matching task failed', () => {
  const result = pickExportTask([
    task({ id: 'failed', text: '店铺多维度分析 2026-07-11 10:21:31 生成失败', buttonText: '', buttonVisible: false }),
  ], { kind: 'shop', requestedAt, clockSkewMs: 1000 });

  assert.equal(result.decision, 'fail');
  assert.equal(result.reason, 'task_failed');
});

test('allows second-level task timestamps for a millisecond request time', () => {
  const result = pickExportTask([
    task({ id: 'same-second', text: '店铺多维度分析 2026-07-11 10:21:30 待下载', buttonText: '下 载' }),
  ], { kind: 'shop', requestedAt, clockSkewMs: 1000 });

  assert.equal(result.decision, 'click');
  assert.equal(normalizeButtonText('下 载'), '下载');
});

test('normalizeExportTask ignores rowIndex when deriving a stable key', () => {
  const first = normalizeExportTask(task({ id: '', rowIndex: '0' }));
  const second = normalizeExportTask(task({ id: '', rowId: '7', rowIndex: '7' }));

  assert.equal(first.id, '');
  assert.equal(first.key, second.key);
  assert.doesNotMatch(first.key, /(^|\|)0($|\|)/);
  assert.doesNotMatch(second.key, /(^|\|)7($|\|)/);
});

test('returns ambiguity for two newest eligible same-second tasks with different IDs', () => {
  const first = task({ id: 'immutable-task-a', text: '店铺多维度分析 2026-07-11 10:21:31 待下载' });
  const second = task({ id: 'immutable-task-b', text: '店铺多维度分析 2026-07-11 10:21:31 待下载' });
  const older = task({ id: 'older', text: '店铺多维度分析 2026-07-11 10:21:30 待下载' });
  const result = pickExportTask([older, first, second], { kind: 'shop', requestedAt, clockSkewMs: 1000 });

  assert.equal(result.selected, null);
  assert.equal(result.decision, 'wait');
  assert.equal(result.reason, 'ambiguous_tasks');
});

test('poll policy waits, refreshes, clicks, and times out deterministically', () => {
  assert.deepEqual(decideExportPoll({ attempt: 0, maxAttempts: 10, refreshEvery: 3, taskDecision: { decision: 'wait', reason: 'no_new_task' } }), { action: 'wait', reason: 'no_new_task', candidates: [] });
  assert.deepEqual(decideExportPoll({ attempt: 3, maxAttempts: 10, refreshEvery: 3, taskDecision: { decision: 'wait', reason: 'task_pending' } }), { action: 'reload', reason: 'task_pending', candidates: [] });
  assert.deepEqual(decideExportPoll({ attempt: 2, maxAttempts: 10, refreshEvery: 3, taskDecision: { decision: 'click', selected: { key: 'new' } } }), { action: 'click', taskKey: 'new', candidates: [] });
  assert.deepEqual(decideExportPoll({ attempt: 9, maxAttempts: 10, refreshEvery: 3, taskDecision: { decision: 'wait', reason: 'no_new_task' } }), { action: 'fail', reason: 'task_timeout', candidates: [] });
});

test('download-center resolver accepts and tags a valid visible empty grid', () => {
  const current = validResolverLayer({ rows: [] });
  const result = runDownloadCenterResolver({ roots: [current.root], grids: [current.grid] });

  assert.equal(result.ok, true);
  assert.ok(result.layerId);
  assert.equal(current.root.getAttribute('data-huice-download-layer-id'), result.layerId);
  assert.equal(current.grid.getAttribute('data-huice-download-layer-id'), result.layerId);
  assert.equal(result.diagnostics.totalRows, 0);
  assert.equal(result.diagnostics.validTaskRows, 0);
});

test('download-center resolver returns ambiguity for two valid visible empty grids', () => {
  const first = validResolverLayer({ rows: [] });
  const second = validResolverLayer({ rows: [] });
  const result = runDownloadCenterResolver({ roots: [first.root, second.root], grids: [first.grid, second.grid] });

  assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: 'ambiguous' });
  assert.equal(result.diagnostics.candidateCount, 2);
  assert.deepEqual(result.diagnostics.candidates, [
    { totalRows: 0, validTaskRows: 0 },
    { totalRows: 0, validTaskRows: 0 },
  ]);
  assert.equal(first.root.getAttribute('data-huice-download-layer-id'), null);
  assert.equal(first.grid.getAttribute('data-huice-download-layer-id'), null);
  assert.equal(second.root.getAttribute('data-huice-download-layer-id'), null);
  assert.equal(second.grid.getAttribute('data-huice-download-layer-id'), null);
});

test('download-center resolver ignores a hidden old layer and selects the current visible layer', () => {
  const hidden = validResolverLayer({ visible: false });
  const current = validResolverLayer();
  const result = runDownloadCenterResolver({
    roots: [hidden.root, current.root],
    grids: [hidden.grid, current.grid],
  });

  assert.equal(result.ok, true);
  assert.equal(hidden.root.getAttribute('data-huice-download-layer-id'), null);
  assert.equal(current.root.getAttribute('data-huice-download-layer-id'), result.layerId);
});

test('download-center resolver returns ambiguity instead of choosing the first valid layer', () => {
  const first = validResolverLayer();
  const second = validResolverLayer();
  const result = runDownloadCenterResolver({ roots: [first.root, second.root], grids: [first.grid, second.grid] });

  assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: 'ambiguous' });
  assert.equal(first.root.getAttribute('data-huice-download-layer-id'), null);
  assert.equal(second.root.getAttribute('data-huice-download-layer-id'), null);
});

test('download-center resolver writes the same generated layerId to the root and grid', () => {
  const current = validResolverLayer();
  const result = runDownloadCenterResolver({ roots: [current.root], grids: [current.grid] });

  assert.equal(result.ok, true);
  assert.ok(result.layerId);
  assert.equal(current.root.getAttribute('data-huice-download-layer-id'), result.layerId);
  assert.equal(current.grid.getAttribute('data-huice-download-layer-id'), result.layerId);
});

test('a visible higher notification layer is diagnostic only and does not affect selection', () => {
  const current = validResolverLayer();
  const notification = resolverElement({ className: 'el-notification', visible: true, textContent: '导出成功' });
  const result = runDownloadCenterResolver({
    roots: [current.root],
    grids: [current.grid],
    notifications: [notification],
  });

  assert.equal(result.ok, true);
  assert.equal(current.root.getAttribute('data-huice-download-layer-id'), result.layerId);
  assert.equal(result.diagnostics.notificationCount, 1);
});

test('Element UI dialog predicate excludes wrappers in leave transition', () => {
  const predicate = new Function(`return (${elementUiActiveDialogPredicateSource})`)();
  const activeWrapper = { className: 'el-dialog__wrapper', matches: selector => selector === '.el-dialog__wrapper' };
  const leavingWrapper = { className: 'el-dialog__wrapper dialog-fade-leave dialog-fade-leave-active', matches: selector => selector === '.el-dialog__wrapper' };
  const activeDialog = { offsetParent: {}, closest: () => activeWrapper };
  const leavingDialog = { offsetParent: {}, closest: () => leavingWrapper };

  assert.equal(predicate(activeDialog), true);
  assert.equal(predicate(leavingDialog), false);
});

test('leave-state submit evidence accepts the first click and forbids retry', () => {
  assert.equal(decideExportSubmitState({ dialogOpen: true, wrapperLeaving: true }), 'accepted');
  assert.equal(decideExportSubmitState({ dialogOpen: true, wrapperLeaving: false }), 'retry');
});

test('clickExport submits the scoped confirmation at most once and only polls afterward', () => {
  const source = readFileSync(new URL('../tools/huice-shop-export-cdp.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function clickExport(ws)');
  const end = source.indexOf('\n\n/** 读取 AG-Grid', start);
  const clickExportSource = source.slice(start, end);
  const confirmClicks = clickExportSource.match(/confirm\.click\(\)/g) || [];

  assert.match(clickExportSource, /elementUiActiveDialogPredicateSource/);
  assert.match(clickExportSource, /wrapperLeaving/);
  assert.match(clickExportSource, /taskEvidence/);
  assert.match(clickExportSource, /return exportRequestedAt/);
  assert.equal(confirmClicks.length, 1, 'confirm must be dispatched exactly once');
  assert.doesNotMatch(clickExportSource, /Input\.dispatchMouseEvent/);
  assert.doesNotMatch(clickExportSource, /maxMouseFallbacks|fallbackAttempt/);
  assert.doesNotMatch(clickExportSource, /exportIcon[\s\S]*exportIcon/);
  assert.doesNotMatch(clickExportSource, /document\.querySelectorAll\('button, \.el-button'\)/);
});

test('popup classification never treats business buttons as passive notices', () => {
  const notice = classifyPopup({ kind: 'notification', text: '导出成功 我知道了', buttons: ['我知道了'] });
  const dialog = classifyPopup({ kind: 'dialog', text: '是否分店铺下载', buttons: ['取消', '确 定'], radios: [{ label: '否', checked: false }] });
  const mask = classifyPopup({ kind: 'mask', text: '', buttons: [] });
  const unknown = classifyPopup({ kind: 'dialog', text: '未知操作', buttons: ['确定'] });

  assert.equal(notice.type, 'passive_notice');
  assert.deepEqual(notice.safeActions, ['dismiss']);
  assert.equal(dialog.type, 'export_options');
  assert.deepEqual(dialog.safeActions, ['select_no', 'confirm']);
  assert.equal(mask.type, 'blocking_mask');
  assert.deepEqual(mask.safeActions, []);
  assert.equal(unknown.type, 'unknown_dialog');
  assert.deepEqual(unknown.safeActions, []);
});
