import { extractTaskCreatedAt } from './export-validation.mjs';

const KIND_MARKERS = {
  product: ['商品排名', '商品分析'],
  shop: ['店铺多维度', '多维度利润'],
};

const PENDING_MARKERS = ['生成中', '处理中', '等待中', '排队中'];
const FAILED_MARKERS = ['生成失败', '导出失败', '失败'];
const READY_MARKERS = ['待下载', '可下载', '完成'];

export const elementUiActiveDialogPredicateSource = `(dialog => {
  if (!dialog || dialog.offsetParent === null) return false;
  const wrapper = dialog.closest?.('.el-dialog__wrapper');
  return !wrapper || !String(wrapper.className || '').includes('leave');
})`;

export function decideExportSubmitState(state = {}) {
  if (state.wrapperLeaving || !state.dialogOpen || state.notices?.length || state.taskEvidence) return 'accepted';
  return 'retry';
}

export function normalizeButtonText(value) {
  return String(value || '').replace(/\s+/g, '');
}

function detectKind(text) {
  for (const [kind, markers] of Object.entries(KIND_MARKERS)) {
    if (markers.some(marker => text.includes(marker))) return kind;
  }
  return 'unknown';
}

function detectState(text) {
  if (FAILED_MARKERS.some(marker => text.includes(marker))) return 'failed';
  if (text.includes('已下载')) return 'consumed';
  if (PENDING_MARKERS.some(marker => text.includes(marker))) return 'pending';
  if (READY_MARKERS.some(marker => text.includes(marker))) return 'ready';
  return 'unknown';
}

export function normalizeExportTask(rawTask = {}) {
  const text = String(rawTask.text || '');
  const createdAt = Number.isFinite(rawTask.createdAt)
    ? rawTask.createdAt
    : extractTaskCreatedAt(text);
  const id = String(rawTask.id || rawTask.taskId || '');
  const kind = detectKind(text);
  const state = detectState(text);
  const buttonText = normalizeButtonText(rawTask.buttonText);
  const buttonVisible = rawTask.buttonVisible === true;
  const stableText = text
    .replace(/生成中|处理中|等待中|排队中|生成失败|导出失败|待下载|可下载|已下载|完成|失败/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const stableIdentity = id || `${kind}|${createdAt || 'no-time'}|${stableText}`;

  return {
    ...rawTask,
    id,
    text,
    kind,
    state,
    createdAt,
    buttonText,
    buttonVisible,
    downloadable: state === 'ready' && buttonVisible && buttonText === '下载',
    key: `${id ? `${id}|` : ''}${stableIdentity}`,
  };
}

export function classifyExportTask(task, criteria = {}) {
  const normalized = normalizeExportTask(task);
  const baseline = new Set(criteria.baselineTaskKeys || []);
  const consumed = new Set(criteria.consumedTaskKeys || []);
  const requestedAt = Number(criteria.requestedAt ?? criteria.after);
  const clockSkewMs = Number(criteria.clockSkewMs ?? 1000);

  if (normalized.kind !== criteria.kind) return { task: normalized, eligible: false, reason: 'wrong_kind' };
  if (!Number.isFinite(normalized.createdAt)) return { task: normalized, eligible: false, reason: 'invalid_created_at' };
  if (baseline.has(normalized.key)) return { task: normalized, eligible: false, reason: 'already_present_before_request' };
  if (consumed.has(normalized.key)) return { task: normalized, eligible: false, reason: 'already_consumed' };
  if (Number.isFinite(requestedAt) && normalized.createdAt < requestedAt - clockSkewMs) {
    return { task: normalized, eligible: false, reason: 'before_request_window' };
  }
  if (normalized.state === 'consumed') return { task: normalized, eligible: false, reason: 'already_downloaded' };
  if (normalized.state === 'failed') return { task: normalized, eligible: false, reason: 'task_failed' };
  if (normalized.state === 'pending') return { task: normalized, eligible: false, reason: 'task_pending' };
  if (normalized.state !== 'ready') return { task: normalized, eligible: false, reason: 'unknown_status' };
  if (!normalized.downloadable) return { task: normalized, eligible: false, reason: 'download_button_pending' };
  return { task: normalized, eligible: true, reason: 'eligible' };
}

export function pickExportTask(tasks, criteria = {}) {
  const candidates = (tasks || []).map(task => classifyExportTask(task, criteria));
  const eligible = candidates
    .filter(candidate => candidate.eligible)
    .sort((a, b) => b.task.createdAt - a.task.createdAt || b.task.key.localeCompare(a.task.key));

  if (eligible.length > 1 && eligible[0].task.createdAt === eligible[1].task.createdAt) {
    return { decision: 'wait', reason: 'ambiguous_tasks', selected: null, candidates: candidates.map(formatCandidate) };
  }
  if (eligible.length > 0) {
    return { decision: 'click', reason: 'eligible', selected: eligible[0].task, candidates: candidates.map(formatCandidate) };
  }

  const relevant = candidates.filter(candidate => candidate.task.kind === criteria.kind);
  const newest = [...relevant].sort((a, b) => (b.task.createdAt || 0) - (a.task.createdAt || 0))[0];
  if (newest?.reason === 'task_failed') {
    return { decision: 'fail', reason: 'task_failed', selected: null, candidates: candidates.map(formatCandidate) };
  }
  if (relevant.some(candidate => candidate.reason === 'download_button_pending')) {
    return { decision: 'wait', reason: 'download_button_pending', selected: null, candidates: candidates.map(formatCandidate) };
  }
  if (relevant.some(candidate => candidate.reason === 'task_pending')) {
    return { decision: 'wait', reason: 'task_pending', selected: null, candidates: candidates.map(formatCandidate) };
  }
  return { decision: 'wait', reason: 'no_new_task', selected: null, candidates: candidates.map(formatCandidate) };
}

function formatCandidate(candidate) {
  return {
    key: candidate.task.key,
    id: candidate.task.id,
    kind: candidate.task.kind,
    state: candidate.task.state,
    createdAt: candidate.task.createdAt,
    reason: candidate.reason,
    rowIndex: candidate.task.rowIndex ?? null,
  };
}

export function decideExportPoll({ attempt, maxAttempts, refreshEvery, taskDecision }) {
  const diagnostics = { reason: taskDecision?.reason || 'waiting', candidates: taskDecision?.candidates || [] };
  if (taskDecision?.decision === 'click') return { action: 'click', taskKey: taskDecision.selected.key, candidates: diagnostics.candidates };
  if (taskDecision?.decision === 'fail') return { action: 'fail', ...diagnostics };
  if (attempt >= maxAttempts - 1) return { action: 'fail', reason: 'task_timeout', candidates: diagnostics.candidates };
  if (attempt > 0 && refreshEvery > 0 && attempt % refreshEvery === 0) {
    return { action: 'reload', ...diagnostics };
  }
  return { action: 'wait', ...diagnostics };
}

export function classifyPopup(popup = {}) {
  const kind = String(popup.kind || 'unknown');
  const text = String(popup.text || '');
  const buttons = (popup.buttons || []).map(normalizeButtonText);
  const radios = popup.radios || [];

  if (kind === 'mask') return { type: 'blocking_mask', safeActions: [] };
  if (kind === 'notification' || kind === 'message' || text.includes('我知道了') || text.includes('300S后关闭')) {
    return { type: 'passive_notice', safeActions: ['dismiss'] };
  }
  if ((kind === 'dialog' || kind === 'message_box') && text.includes('分店铺')) {
    const noSelected = radios.some(radio => normalizeButtonText(radio.label) === '否' && radio.checked === true);
    const actions = noSelected ? [] : ['select_no'];
    if (buttons.includes('确定')) actions.push('confirm');
    return { type: 'export_options', safeActions: actions };
  }
  if (kind === 'dialog' || kind === 'message_box' || kind === 'drawer') {
    return { type: 'unknown_dialog', safeActions: [] };
  }
  return { type: 'unknown', safeActions: [] };
}
