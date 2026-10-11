import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  appendTurnstileEvent,
  loadTurnstileEvents,
  probeTurnstileEventStore,
  turnstileEventKey,
  TURNSTILE_EVENT_ROOT,
} from '../netlify/functions/_shared/turnstile-history.mjs';
import { classifyTurnstileRejection, classifyTurnstileAlert, summarizeTurnstileActivity } from '../netlify/functions/_shared/turnstile-alerts.mjs';

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

// Required alert semantics: valid challenges and correctly blocked invalid tokens
// must never be mistaken for a Cloudflare or server-side infrastructure outage.
const makeRejection = (codes, minutesAgo = 1, more = {}) => ({
  ok:false,
  createdAt:new Date(nowMs-minutesAgo*60000).toISOString(),
  codes,
  ...more,
});
assert.equal(classifyTurnstileRejection({ok:true,codes:[]}), 'accepted');
assert.equal(classifyTurnstileRejection(makeRejection(['missing-token'])), 'expected_rejection');
assert.equal(classifyTurnstileRejection(makeRejection(['invalid-input-response','timeout-or-duplicate'])), 'expected_rejection');
assert.equal(classifyTurnstileRejection(makeRejection(['siteverify-unavailable'])), 'infrastructure');
assert.equal(classifyTurnstileRejection(makeRejection(['invalid-input-secret'])), 'infrastructure');
assert.equal(classifyTurnstileRejection(makeRejection(['invalid-input-response','siteverify-http-error'])), 'infrastructure');
assert.equal(classifyTurnstileRejection(makeRejection(['hostname-mismatch'])), 'security_mismatch');
assert.equal(classifyTurnstileRejection(makeRejection(['unknown-new-code'])), 'unclassified_rejection');
const mixedActivity = summarizeTurnstileActivity([
  makeRejection(['missing-token'],2,{sourceHint:'matches-ci-smoke-pattern'}),
  makeRejection(['invalid-input-response'],3),
  makeRejection(['siteverify-unavailable'],4),
  makeRejection(['siteverify-http-error'],18),
  makeRejection(['hostname-mismatch'],6),
  makeRejection(['mystery-code'],7),
  makeRejection(['invalid-input-response'],24*60+1),
  {ok:true,createdAt:new Date(nowMs-60000).toISOString(),codes:[]},
],nowMs);
assert.deepEqual({
  total:mixedActivity.rejected24h, expected:mixedActivity.expectedRejected24h,
  infra:mixedActivity.infrastructureRejected24h, infra15m:mixedActivity.infrastructureRejected15m,
  mismatch:mixedActivity.securityMismatch24h, unknown:mixedActivity.unclassifiedRejected24h,
  smoke:mixedActivity.smokePattern24h,
},{total:6,expected:2,infra:2,infra15m:1,mismatch:1,unknown:1,smoke:1});
const operational = {
  siteKeyConfigured:true,
  secretConfigured:true,
  widgetRendering:{ok:true},
  siteverify:{ok:true},
  telemetry:{ok:true},
  mismatches:{total:0},
};
assert.equal(classifyTurnstileAlert({...operational,activity:{expectedRejected24h:20}}).kind,'expected_rejections');
assert.equal(classifyTurnstileAlert({...operational,activity:{expectedRejected24h:20}}).severity,'info');
assert.equal(classifyTurnstileAlert({...operational,activity:{unclassifiedRejected24h:1}}).severity,'upcoming');
assert.equal(classifyTurnstileAlert({...operational,activity:{infrastructureRejected15m:1}}).severity,'urgent');
assert.equal(classifyTurnstileAlert({...operational,activity:{infrastructureRejected15m:1}}).kind,'infrastructure_failure');
assert.equal(classifyTurnstileAlert({...operational,mismatches:{total:1},activity:{expectedRejected24h:2}}).kind,'security_mismatch');
assert.equal(classifyTurnstileAlert({...operational,siteverify:{ok:false},activity:{expectedRejected24h:100}}).kind,'infrastructure_failure');
assert.equal(classifyTurnstileAlert({...operational,telemetry:{ok:false}}).kind,'infrastructure_failure');
assert.equal(classifyTurnstileAlert({...operational,activity:{}}).kind,'healthy');

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
const workspace = await readFile(new URL('../netlify/functions/admin-workspace-alerts.mts', import.meta.url), 'utf8');
const credential = await readFile(new URL('../netlify/functions/_shared/credential-health.ts', import.meta.url), 'utf8');
assert.match(security, /classifyTurnstileAlert\(status\)/, 'Turnstile security summary must include actionable alert classification');
assert.match(credential, /recentInfrastructureFailures === 0/, 'Live infrastructure failures must affect credential health');
assert.match(workspace, /turnstile:rejected-challenge-activity/, 'Expected token rejections must surface as an informational Action Center alert');
assert.match(workspace, /turnstileAdvisory\.kind==='expected_rejections'\?'info':'upcoming'/, 'Expected rejections must never be urgent');
assert.match(crm, /if \(!result\.ok\) codes\.push\('siteverify-http-error'\)/, 'Non-2xx Siteverify results must be infrastructure errors');
console.log('Turnstile history, security enforcement, infrastructure/bot alert classification: PASS');
