/* Koa's Events: first-party, tab-scoped inquiry attribution. No cookies or identifiers. */
(function (root) {
  'use strict';
  const KEY = 'koa-first-touch-v1';
  const TTL_MS = 24 * 60 * 60 * 1000;
  const UTM = ['utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm'];
  const BLOCKED = /^\/(?:admin|staff|bartender|booking|proposal|planning|portal|api)(?:\/|$)/i;

  function safeText(value, max) {
    const raw = String(value || '').trim().slice(0, max);
    if (/@|https?:\/\/|[?&#=]|\b(?:\+?\d[\d ()-]{7,}\d)\b/i.test(raw)) return '';
    return raw.replace(/[^\p{L}\p{N} _.-]/gu, '');
  }
  function safePath(value) {
    const path = String(value || '');
    return /^\/[a-z0-9/_-]*\/?$/i.test(path) && !path.includes('..') && !BLOCKED.test(path)
      ? path.slice(0, 180) : '';
  }
  function safeHost(value) {
    const host = String(value || '').trim().toLowerCase().slice(0, 180);
    return /^[a-z0-9.-]+$/.test(host) && !host.includes('..') ? host : '';
  }
  function isOptedOut() {
    const nav = root.navigator || {};
    return nav.globalPrivacyControl === true || nav.doNotTrack === '1' || root.doNotTrack === '1';
  }
  function store() {
    try { return root.sessionStorage; } catch { return null; }
  }
  function clear() {
    try { store()?.removeItem(KEY); } catch { /* Private browsing can block storage. */ }
  }
  function normalized(value) {
    if (!value || typeof value !== 'object' || value.schemaVersion !== 1) return null;
    const date = Date.parse(String(value.capturedAt || ''));
    const now = Date.now();
    if (!Number.isFinite(date) || date > now + 60 * 1000 || now - date > TTL_MS) return null;
    const entryPage = safePath(value.entryPage);
    if (!entryPage) return null;
    const result = {
      schemaVersion: 1,
      capturedAt: new Date(date).toISOString(),
      entryPage,
      referringHost: safeHost(value.referringHost),
    };
    for (const name of UTM) result[name] = safeText(value[name], 120);
    return result;
  }
  function read() {
    if (isOptedOut()) { clear(); return null; }
    try {
      const raw = store()?.getItem(KEY);
      if (!raw) return null;
      const value = normalized(JSON.parse(raw));
      if (!value) clear();
      return value;
    } catch { clear(); return null; }
  }
  function capture() {
    if (isOptedOut()) { clear(); return null; }
    const page = safePath(root.location?.pathname);
    if (!page) return null;
    const previous = read();
    if (previous) return previous;
    let url;
    try { url = new URL(root.location.href); } catch { return null; }
    const result = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      entryPage: page,
      referringHost: '',
    };
    try {
      const ref = new URL(root.document?.referrer || '');
      if (ref.hostname !== url.hostname) result.referringHost = safeHost(ref.hostname);
    } catch { /* Direct visit or withheld referrer. */ }
    for (const name of UTM) {
      const param = name.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase());
      result[name] = safeText(url.searchParams.get(param), 120);
    }
    try { store()?.setItem(KEY, JSON.stringify(result)); } catch { /* In-memory current-page fallback. */ }
    return result;
  }
  let inMemory = capture();
  root.KoaFirstTouch = Object.freeze({
    get() {
      if (isOptedOut()) { clear(); inMemory = null; return null; }
      const saved = read();
      if (saved) return saved;
      const memory = normalized(inMemory);
      if (memory) return memory;
      inMemory = capture();
      return inMemory;
    },
    clear() { clear(); inMemory = null; },
  });
})(window);
