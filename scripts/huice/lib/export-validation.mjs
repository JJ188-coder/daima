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

export function isExpectedExportTask(task, { kind, targetDate, after, clockSkewMs = 1000 }) {
  const text = String(task?.text || '');
  const hasKind = (KIND_MARKERS[kind] || []).some(marker => text.includes(marker));
  const createdAt = task?.createdAt ?? extractTaskCreatedAt(text);
  // 只校验任务类型+创建时间,不校验任务文本里的 targetDate
  // (下载中心任务名是"店铺多维度分析+时间戳",不含目标日期)
  // 状态必须是"待下载"或"可下载"
  const isReady = text.includes('待下载') || text.includes('可下载');
  return hasKind && Number.isFinite(createdAt) && createdAt >= Number(after) - clockSkewMs && isReady;
}

export function extractWorkbookDateRange(rows, { kind }) {
  if (!Array.isArray(rows)) return null;

  if (kind === 'product') {
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const labelIndex = row.findIndex(value => String(value ?? '').trim() === '日期');
      if (labelIndex < 0) continue;
      const value = String(row[labelIndex + 1] ?? '').trim();
      const match = value.match(/(\d{4}-\d{2}-\d{2})\s*[~至]\s*(\d{4}-\d{2}-\d{2})/);
      if (match) return { start: match[1], end: match[2] };
    }
    return null;
  }

  const content = rows.flat().map(value => String(value ?? '')).join(' ');
  const range = content.match(/时间范围[：:]\s*(\d{4}-\d{2}-\d{2})\s*至\s*(\d{4}-\d{2}-\d{2})/);
  if (range) return { start: range[1], end: range[2] };
  const single = content.match(/时间范围[：:]\s*(\d{4}-\d{2}-\d{2})(?!\s*至)/);
  return single ? { start: single[1], end: single[1] } : null;
}

export function validateExportRows(rows, { kind, targetDate }) {
  if (!Array.isArray(rows) || rows.length < 2) return { ok: false, reason: 'empty export' };
  const dateRange = extractWorkbookDateRange(rows, { kind });
  if (!dateRange) return { ok: false, reason: 'authoritative date range missing' };
  if (dateRange.start !== targetDate || dateRange.end !== targetDate) {
    return { ok: false, reason: 'single-day date range mismatch' };
  }
  const productIdentityHeaders = new Set(['链接ID', '商品ID', '商品编号']);
  const headers = rows.find(row => Array.isArray(row) && row.some(value => {
    const header = String(value ?? '').trim();
    return kind === 'shop' ? header.includes('店铺名称') : productIdentityHeaders.has(header);
  }));
  if (!headers) return { ok: false, reason: 'expected header missing' };
  const headerIndex = rows.indexOf(headers);
  if (!rows.slice(headerIndex + 1).some(row => Array.isArray(row) && row.some(value => String(value ?? '').trim()))) {
    return { ok: false, reason: 'no data rows' };
  }
  return { ok: true };
}
