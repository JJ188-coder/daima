export const TARGET_PDD_MALL_ID = '338884784';

const PROMO_HOST = 'yingxiao.pinduoduo.com';

function closeSocket(ws) {
  if (!ws || typeof ws.close !== 'function') return;
  try {
    ws.close();
  } catch {
    // The protocol operation has already decided success/failure; cleanup is best effort.
  }
}

export async function connectCdp(
  webSocketDebuggerUrl,
  { WebSocketClass = WebSocket, timeoutMs = 5000 } = {},
) {
  const ws = new WebSocketClass(webSocketDebuggerUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;

    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener('open', handleOpen);
      ws.removeEventListener('error', handleError);
    };
    const rejectAndClose = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      closeSocket(ws);
      reject(error);
    };
    const handleOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ws);
    };
    const handleError = () => rejectAndClose(new Error('CDP 连接失败'));

    ws.addEventListener('open', handleOpen, { once: true });
    ws.addEventListener('error', handleError, { once: true });
    timeout = setTimeout(() => rejectAndClose(new Error('CDP 连接超时')), timeoutMs);
  });
}

export function planPromoTargets(candidates, targetMallId = TARGET_PDD_MALL_ID) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('no promotion pages found');
  }

  const normalizedTargetMallId = String(targetMallId ?? '').trim();
  if (!normalizedTargetMallId) {
    throw new Error('target promotion mallId is required');
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error('promotion page candidate is invalid');
    }
    if (typeof candidate.targetId !== 'string' || !candidate.targetId.trim()) {
      throw new Error('promotion page targetId is required');
    }

    let url;
    try {
      url = new URL(candidate.url);
    } catch {
      throw new Error('promotion page url is invalid');
    }
    if (url.hostname !== PROMO_HOST) {
      throw new Error(`promotion page host must be ${PROMO_HOST}`);
    }

    if (String(candidate.mallId ?? '').trim() === '') {
      throw new Error('promotion page mallId could not be read');
    }
  }

  const matches = candidates.filter(
    candidate => String(candidate.mallId).trim() === normalizedTargetMallId,
  );
  if (matches.length === 0) {
    throw new Error(`target promotion mallId ${normalizedTargetMallId} not found`);
  }
  if (matches.length !== 1) {
    throw new Error(`multiple promotion pages found for target mallId ${normalizedTargetMallId}; selection is ambiguous`);
  }

  const keep = matches[0];
  return {
    keep,
    close: candidates.filter(candidate => candidate.targetId !== keep.targetId),
  };
}

export async function acquirePromoTarget(
  { candidates, browserWebSocketDebuggerUrl, targetMallId = TARGET_PDD_MALL_ID },
  { connectCdp, readMallId, cdpCall, getMapping },
) {
  const discovered = [];
  let discoveryError;

  for (const candidate of candidates ?? []) {
    let candidateWs;
    try {
      candidateWs = await connectCdp(candidate.webSocketDebuggerUrl);
      const mallId = await readMallId(candidateWs);
      if (String(mallId ?? '').trim() === '') {
        throw new Error(`promotion page mallId could not be read for target ${candidate.targetId}`);
      }
      discovered.push({ ...candidate, mallId: String(mallId).trim() });
    } catch (error) {
      discoveryError ??= error;
    } finally {
      closeSocket(candidateWs);
    }
  }

  if (discoveryError) throw discoveryError;

  const plan = planPromoTargets(discovered, targetMallId);

  if (plan.close.length > 0) {
    let browserWs;
    try {
      browserWs = await connectCdp(browserWebSocketDebuggerUrl);
      const closeResults = await Promise.allSettled(
        plan.close.map(async candidate => {
          const response = await cdpCall(browserWs, 'Target.closeTarget', { targetId: candidate.targetId });
          if (response?.error || response?.result?.success !== true) {
            throw new Error(`failed to close promotion target ${candidate.targetId}`);
          }
        }),
      );
      const failedClose = closeResults.find(result => result.status === 'rejected');
      if (failedClose) throw failedClose.reason;
    } finally {
      closeSocket(browserWs);
    }
  }

  let keepWs;
  let ownershipTransferred = false;
  try {
    keepWs = await connectCdp(plan.keep.webSocketDebuggerUrl);
    const verifiedMallId = String(await readMallId(keepWs) ?? '').trim();
    const normalizedTargetMallId = String(targetMallId).trim();
    if (verifiedMallId !== normalizedTargetMallId) {
      throw new Error(
        `kept promotion page mallId verification failed: expected=${normalizedTargetMallId} actual=${verifiedMallId || '(empty)'}`,
      );
    }

    const mapping = await getMapping(verifiedMallId);
    if (!mapping) {
      throw new Error(`shop mapping not found for mallId ${verifiedMallId}`);
    }

    let closed = false;
    const closeKeepWs = () => {
      if (closed) return;
      closed = true;
      closeSocket(keepWs);
    };
    ownershipTransferred = true;
    return {
      keep: plan.keep,
      verifiedMallId,
      mapping,
      keepWs,
      closeKeepWs,
    };
  } finally {
    if (!ownershipTransferred) closeSocket(keepWs);
  }
}
