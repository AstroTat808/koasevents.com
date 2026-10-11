import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  appendTurnstileEvent,
  loadTurnstileEvents,
  probeTurnstileEventStore,
  turnstileEventKey,
  TURNSTILE_EVENT_ROOT,
} from '../netlify/functions/_shared/turnstile-history.mjs';

class MemoryStore {
  records = new Map();
  async setJSON(key, value) { this.records.set(key, structuredClone(value)); }
  async get(key) { return structuredClone(this.records.get(key) ?? null); }
  async delete(key) { this.records.delete(key); }
  async list({ prefix }) {
    return { blobs: [...this.records.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
  }
}

const store = new MemoryStore();
const nowMs = Date.parse('2026-10-10T19:40:00.000Z');
const mkRow = (num, date = new Date(nowMs).toISOString()) => ({
  id: 'TS-' + num.toString(16).padStart(12, '0').toUpperCase(),
  createdAt: date,
  ok: num % 2 === 0,
  action: 'event_inquiry',
  expectedAction: 'event_inquiry',
  hostname: 'koasevents.com',
  requestHostname: 'koasevents.com',
  codes: num % 2 ? ['invalid-input-response'] : [],
  detail: 'Test event without private data',
});

assert.ok(turnstileEventKey(mkRow(1)).startsWith(TURNSTILE_EVENT_ROOT + '2026-10/'));
assert.throws(() => turnstileEventKey({ id: 'invalid', createdAt: 'invalid' }));
await Promise.all(Array.from({ length: 40 }, (_, num) => appendTurnstileEvent(store, mkRow(num))));
await appendTurnstileEvent(store, mkRow(99, '2026-09-01T00:00:00.000Z'));
await appendTurnstileEvent(store, mkRow(100, '2026-09-30T21:00:00.000Z'));
const history = await loadTurnstileEvents(store, 30, nowMs);
assert.equal(history.rows.length, 41, 'All concurrent writes must survive');
assert.equal(history.unreadable, 0);
assert.equal(history.truncated, false);
assert.equal(history.rows.some((row) => row.id === mkRow(99).id), false);
assert.equal(await probeTurnstileEventStore(store), true);
assert.equal([...store.records.keys()].filter((key) => key.startsWith('turnstile/history-probes/')).length, 0);
const failing = new MemoryStore();
failing.setJSON = async () => { throw new Error('Blob writes failed'); };
assert.equal(await probeTurnstileEventStore(failing), false, 'Failed telemetry writes must not appear healthy');
store.records.set(turnstileEventKey(mkRow(200)), { ...mkRow(200), ok: 'yes' });
store.records.set(turnstileEventKey(mkRow(201)), { ...mkRow(201), id: 'malformed' });
const corrupted = await loadTurnstileEvents(store, 30, nowMs);
assert.equal(corrupted.unreadable, 2, 'Corrupted history must be surfaced, without breaking the entire status page');

const security = await readFile(new URL('../netlify/functions/_shared/security.ts', import.meta.url), 'utf8');
const health = await readFile(new URL('../netlify/functions/_shared/system-health.ts', import.meta.url), 'utf8');
const crm = await readFile(new URL('../netlify/functions/crm-inquiries.mts', import.meta.url), 'utf8');
const smoke = await readFile(new URL('../.github/workflows/turnstile-security-smoke.yml', import.meta.url), 'utf8');
assert.match(security, /return appendTurnstileEvent\(store, row\)/, 'Real verification results must use the immutable logger');
assert.doesNotMatch(security, /store\.setJSON\('turnstile\/validations'/, 'Unsafe index writes must remain removed');
assert.match(health, /ok:turnstileRecordingHealthy/, 'Health must reflect storage integrity, not traffic volume');
assert.match(crm, /verifiedAction === expectedAction/, 'Action matching must remain mandatory');
assert.match(crm, /verifiedHostname === requestHostname/, 'Hostname matching must remain mandatory');
assert.match(crm, /code: 'turnstile_failed'/, 'Failed validation must still block submissions');
assert.match(smoke, /status == 403 and parsed\.get\("code"\)/, 'Live security-smoke negative tests must remain enforced');
console.log('Turnstile append-only history, storage health, and fail-closed verification regressions: PASS');
