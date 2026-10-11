// Append-only Turnstile event storage. One immutable key per verification avoids
// lost updates when multiple Netlify Functions record outcomes concurrently.
export const TURNSTILE_EVENT_ROOT = 'turnstile/history-events/v2/';
const MAX_EVENTS_PER_WINDOW = 2000;
const PARALLEL_READS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

export function turnstileEventKey(row) {
  const timestamp = Date.parse(String(row?.createdAt || ''));
  const id = String(row?.id || '');
  if (!Number.isFinite(timestamp) || !/^TS-[A-F0-9]{12}$/.test(id)) {
    throw new Error('Invalid Turnstile validation record.');
  }
  const instant = new Date(timestamp).toISOString();
  return `${TURNSTILE_EVENT_ROOT}${instant.slice(0, 7)}/${instant}-${id}`;
}

export async function appendTurnstileEvent(store, row) {
  await store.setJSON(turnstileEventKey(row), row);
  return row;
}

export async function loadTurnstileEvents(store, days = 30, nowMs = Date.now()) {
  const windowDays = Math.max(1, Math.min(90, Math.round(Number(days) || 30)));
  const cutoff = nowMs - windowDays * DAY_MS;
  const firstMonth = new Date(cutoff);
  const cursor = new Date(Date.UTC(firstMonth.getUTCFullYear(), firstMonth.getUTCMonth(), 1));
  const monthPrefixes = [];
  while (cursor.getTime() <= nowMs) {
    monthPrefixes.push(`${TURNSTILE_EVENT_ROOT}${cursor.toISOString().slice(0, 7)}/`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  const pages = await Promise.all(monthPrefixes.map((prefix) => store.list({ prefix })));
  const keys = new Set();
  for (let index = 0; index < pages.length; index += 1) {
    const prefix = monthPrefixes[index];
    for (const blob of pages[index]?.blobs || []) {
      const key = String(blob.key || '');
      if (!key.startsWith(prefix)) continue;
      const timestamp = Date.parse(key.slice(prefix.length, prefix.length + 24));
      if (Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= nowMs) keys.add(key);
    }
  }

  const sortedKeys = [...keys].sort().reverse();
  const truncated = sortedKeys.length > MAX_EVENTS_PER_WINDOW;
  const rows = [];
  let unreadable = 0;
  for (let start = 0; start < Math.min(sortedKeys.length, MAX_EVENTS_PER_WINDOW); start += PARALLEL_READS) {
    const selected = sortedKeys.slice(start, start + PARALLEL_READS);
    const values = await Promise.all(selected.map((key) => store.get(key, { type: 'json' })));
    for (let index = 0; index < values.length; index += 1) {
      const row = values[index];
      const parsed = Date.parse(String(row?.createdAt || ''));
      let correctKey = false;
      try { correctKey = turnstileEventKey(row) === selected[index]; } catch { /* corrupt record */ }
      if (!row || typeof row !== 'object' || typeof row.ok !== 'boolean' ||
          !Array.isArray(row.codes) || !Number.isFinite(parsed) ||
          parsed < cutoff || parsed > nowMs || !correctKey) {
        unreadable += 1;
        continue;
      }
      rows.push(row);
    }
  }

  rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { rows, unreadable, truncated, windowDays };
}

// Independent storage round-trip: it never claims Cloudflare accepted a token.
// The probe is scoped to the same tenant and deploy as real validation events.
export async function probeTurnstileEventStore(store) {
  const key = `turnstile/history-probes/${crypto.randomUUID()}`;
  const nonce = crypto.randomUUID();
  let wrote = false;
  let healthy = false;
  try {
    await store.setJSON(key, { nonce });
    wrote = true;
    const stored = await store.get(key, { type: 'json' });
    healthy = stored?.nonce === nonce;
  } catch {
    healthy = false;
  }
  if (wrote) {
    try {
      await store.delete(key);
    } catch {
      healthy = false;
    }
  }
  return healthy;
}
