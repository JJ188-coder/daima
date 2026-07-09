const BUSINESS_PAGE_PRIORITY = [
  /:\/\/[^/]*pinduoduo\.com\//,
  /:\/\/[^/]*yangkeduo\.com\//,
  /:\/\/hjy\.huice\.com\//,
];

function priorityForUrl(url = '') {
  const index = BUSINESS_PAGE_PRIORITY.findIndex(re => re.test(url));
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

export function selectWakeupPageTabs(tabs = []) {
  return tabs
    .filter(tab => tab?.type === 'page' && Number.isFinite(priorityForUrl(tab.url || '')))
    .sort((a, b) => priorityForUrl(a.url || '') - priorityForUrl(b.url || ''));
}

export const DEFAULT_WAKEUP_URL = 'https://mms.pinduoduo.com/';
