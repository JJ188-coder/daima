const KIND_MARKERS = {
  product: ['商品排名', '商品分析'],
  shop: ['店铺多维度', '多维度利润'],
};

export function extractTaskCreatedAt(text) {
  const matches = String(text || '').match(/\d{4}[-/]\d{2}[-/]\d{2}\s+\d{2}:\d{2}:\d{2}/g);
  if (!matches?.length) return null;
  const timestamps = matches
    .map(value => new Date(value.replace(/-/g, '/')).getTime())
    .filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : null;
}

export function isExpectedExportTask(task, { kind, targetDate, after }) {
  const text = String(task?.text || '');
  const hasKind = (KIND_MARKERS[kind] || []).some(marker => text.includes(marker));
  const createdAt = task?.createdAt ?? extractTaskCreatedAt(text);
  // 只校验任务类型+创建时间,不校验任务文本里的 targetDate
  // (下载中心任务名是"店铺多维度分析+时间戳",不含目标日期)
  // 状态必须是"待下载"或"可下载"
  const isReady = text.includes('待下载') || text.includes('可下载') || text.includes('已下载');
  return hasKind && Number.isFinite(createdAt) && createdAt >= Number(after) && isReady;
}

export function validateExportRows(rows, { kind, targetDate }) {
  if (!Array.isArray(rows) || rows.length < 2) return { ok: false, reason: 'empty export' };
  const content = rows.flat().map(value => String(value ?? '')).join(' ');
  if (!content.includes(targetDate)) return { ok: false, reason: 'target date missing' };
  const headers = rows.find(row => Array.isArray(row) && row.some(value => String(value ?? '').includes(kind === 'shop' ? '店铺名称' : '商品ID')));
  if (!headers) return { ok: false, reason: 'expected header missing' };
  const headerIndex = rows.indexOf(headers);
  if (!rows.slice(headerIndex + 1).some(row => Array.isArray(row) && row.some(value => String(value ?? '').trim()))) {
    return { ok: false, reason: 'no data rows' };
  }
  return { ok: true };
}
