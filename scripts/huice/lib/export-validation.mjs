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
  return hasKind && text.includes(targetDate) && Number.isFinite(createdAt) && createdAt >= Number(after);
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
