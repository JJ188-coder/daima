const PDD_ORIGINS = new Set([
  'https://mms.pinduoduo.com',
  'https://yingxiao.pinduoduo.com',
]);

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

export function resolveAllowedOrigin(origin) {
  if (typeof origin !== 'string') return null;
  if (PDD_ORIGINS.has(origin) || EXTENSION_ORIGIN.test(origin)) return origin;
  return null;
}

export function isAllowedMutationRequest(origin, contentType) {
  return resolveAllowedOrigin(origin) !== null
    && typeof contentType === 'string'
    && contentType.toLowerCase().startsWith('application/json');
}

export function buildCorsHeaders(origin) {
  const allowedOrigin = resolveAllowedOrigin(origin);
  if (!allowedOrigin) return {};
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}
