import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as model from '../netlify/functions/_shared/crm-record-editor.mjs';
const { prepareRecordMutation: prepare, persistRecordMutation: persist, editorSnapshot, recordRevision } = model;
const ctx = { actor: 'staff@example.test', tenantId: 'test-tenant', now: '2026-10-21T12:00:00.000Z' };
const create = (fields = {}, action = 'create-project') => ({ action, requestId: randomUUID(), fields: { name: 'Synthetic Client', email: 'client@example.test', projectName: 'Synthetic reception', eventDate: '2027-02-01', businessLine: 'events', ...fields } });
const customer = (fields = {}) => ({ action: 'create-customer', requestId: randomUUID(), fields: { name: 'Synthetic Client', ...fields } });
const row = (overrides = {}) => ({ id: 'INQ-SYNTHETIC', tenantId: ctx.tenantId, kind: 'inquiry', stage: 'inquiry', customer: { name: 'Synthetic Client', email: 'client@example.test', phone: '8085550101', eventDate: '2027-02-01', consent: false }, inquiry: { eventType: 'Wedding', guestCount: 40, message: 'Keep original inquiry' }, projectName: 'Original', createdAt: ctx.now, ...overrides });
const update = (record, fields, action = 'update-customer') => ({ action, requestId: randomUUID(), recordId: record.id, expectedRevision: recordRevision(record), fields });
const rejects = (fn, code) => assert.throws(fn, error => error.code === code);
class Memory {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries).map(([key, data]) => [key, { data: structuredClone(data), etag: '1' }])); this.beforeWrite = null; this.failWrites = new Set(); this.failMirrors = false; this.mirrors = new Map(); }
  async readJSON(key) { return structuredClone(this.values.get(key) || { data: null, etag: null }); }
  async writeJSON(key, data, etag) {
    if (this.failWrites.has(key)) throw new Error('Synthetic unavailable');
    if (this.beforeWrite) await this.beforeWrite(key, data, etag);
    const current = this.values.get(key);
    if ((current?.etag || null) !== etag) return { modified: false };
    this.values.set(key, { data: structuredClone(data), etag: String(Number(current?.etag || 0) + 1) });
    return { modified: true };
  }
  async mirrorJSON(key) { if (this.failMirrors) return false; this.mirrors.set(key, (await this.readJSON(key)).data); return true; }
}
const stores = (records = []) => ({ sales: new Memory({ 'records/index': records, ...Object.fromEntries(records.map(r => ['records/' + r.id, r])) }), crm: new Memory(), ...ctx });

test('customer without email or date becomes an undated lead, not a booking', () => {
  const r = prepare([], customer({ phone: '+1 (808) 555-0101' }), ctx).record;
  assert.equal(r.kind, 'lead'); assert.equal(r.stage, 'lead'); assert.equal(r.customer.eventDate, ''); assert.equal(r.customer.email, '');
  assert.equal(r.source, 'crm-manual-entry'); assert.equal(r.booking, undefined); assert.equal(r.proposal, undefined); assert.equal(r.accounting, undefined);
});
test('project preserves exact calendar date and normalizes whitespace/email', () => {
  const r = prepare([], create({ name: '  Synthetic Client  ', email: ' CLIENT@EXAMPLE.TEST ', guestCount: '42' }), ctx).record;
  assert.equal(r.customer.name, 'Synthetic Client'); assert.equal(r.customer.email, 'client@example.test'); assert.equal(r.customer.eventDate, '2027-02-01'); assert.equal(r.inquiry.guestCount, 42);
});
for (const [label, fields] of Object.entries({ missingName: { name: '' }, missingTitle: { projectName: '' }, email: { email: 'bad@@example.test' }, markup: { name: '<script>' }, phone: { phone: '123' }, count: { guestCount: '-2' }, fraction: { guestCount: '2.5' }, impossibleDate: { eventDate: '2027-02-29' }, nonIsoDate: { eventDate: '02/01/2027' }, brand: { businessLine: 'unknown' }, protectedFields: { booking: { status: 'paid' } } })) {
  test('rejects invalid ' + label, () => rejects(() => prepare([], create(fields), ctx), 'validation_failed'));
}
test('valid leap day and undecided dates are accepted', () => {
  assert.equal(prepare([], create({ eventDate: '2028-02-29' }), ctx).record.customer.eventDate, '2028-02-29');
  assert.equal(prepare([], create({ eventDate: '' }), ctx).record.customer.eventDate, '');
});
test('rejects forged actor, tenant, and write-to-existing ID', () => {
  rejects(() => prepare([], { ...customer(), actor: 'admin' }, ctx), 'invalid_request');
  rejects(() => prepare([], { ...customer(), tenantId: 'other' }, ctx), 'invalid_request');
  rejects(() => prepare([], { ...customer(), recordId: 'EXISTING' }, ctx), 'validation_failed');
});
test('duplicates require explicit confirmation; later events remain independent', () => {
  const existing = row();
  rejects(() => prepare([existing], create(), ctx), 'possible_duplicate');
  assert.equal(prepare([existing], { ...create(), allowDuplicate: true }, ctx).records.length, 2);
  assert.equal(prepare([existing], create({ eventDate: '2027-02-02' }), ctx).records.length, 2);
  rejects(() => prepare([existing], customer({ email: 'CLIENT@EXAMPLE.TEST' }), ctx), 'possible_duplicate');
  rejects(() => prepare([existing], customer({ phone: '+1 808 555 0101' }), ctx), 'possible_duplicate');
});
test('source contact is linked without mutating existing project', () => {
  const existing = row(); const initial = structuredClone(existing);
  const result = prepare([existing], { ...create({ eventDate: '2027-03-01' }), sourceCustomerRecordId: existing.id }, ctx);
  assert.equal(result.record.customerReferenceId, existing.id); assert.deepEqual(existing, initial);
  rejects(() => prepare([], { ...create(), sourceCustomerRecordId: 'missing' }, ctx), 'customer_not_found');
});
test('contact patches preserve financial, contract, consent and unrelated fields', () => {
  const existing = row({ kind: 'proposal', proposal: { publicToken: 'synthetic-not-a-secret', total: 12000 }, booking: { contract: { status: 'signed' }, payments: [{ amount: 100, status: 'paid' }] }, accounting: { quickbooks: { customerId: 'synthetic' } } });
  const before = structuredClone(existing); const r = prepare([existing], update(existing, { name: 'Changed synthetic', email: '', phone: '' }), ctx).record;
  assert.equal(r.id, existing.id); assert.equal(r.customer.email, ''); assert.equal(r.customer.consent, false); assert.deepEqual(r.booking, existing.booking); assert.deepEqual(r.accounting, existing.accounting); assert.deepEqual(r.proposal, existing.proposal); assert.deepEqual(existing, before);
});
test('project patches clear optional values without replacing inquiry metadata', () => {
  const existing = row(); const r = prepare([existing], update(existing, { projectName: 'New title', eventDate: '', eventType: '', guestCount: '' }, 'update-project'), ctx).record;
  assert.equal(r.projectName, 'New title'); assert.equal(r.customer.eventDate, ''); assert.equal(r.customer.name, existing.customer.name); assert.equal(r.inquiry.message, existing.inquiry.message); assert.equal(r.inquiry.guestCount, '');
});
test('proposal and booking dates cannot be silently changed', () => {
  for (const attrs of [{ kind: 'proposal' }, { stage: 'booked' }, { booking: { contract: { status: 'signed' } } }, { booking: { payments: [{ status: 'due' }] } }]) {
    const r = row(attrs); assert.equal(editorSnapshot(r).eventDateLocked, true);
    rejects(() => prepare([r], update(r, { eventDate: '2027-03-01' }, 'update-project'), ctx), 'date_change_requires_booking_review');
    assert.equal(prepare([r], update(r, { projectName: 'Renamed' }, 'update-project'), ctx).record.projectName, 'Renamed');
  }
});
test('stale revision and removed records fail without writes', () => {
  const r = row(); const input = update(r, { phone: '' });
  rejects(() => prepare([{ ...r, updatedAt: 'new' }], input, ctx), 'stale_record');
  rejects(() => prepare([], input, ctx), 'record_not_found');
});
test('tenant mismatch fails closed', () => rejects(() => prepare([row({ tenantId: 'other-tenant' })], customer(), ctx), 'invalid_record_index'));
test('same request retries return same result; changed payload cannot reuse ID', () => {
  const input = create(); const first = prepare([], input, ctx);
  const replay = prepare(first.records, input, ctx); assert.equal(replay.replay, true); assert.equal(replay.record.id, first.record.id); assert.equal(replay.records.length, 1);
  rejects(() => prepare(first.records, { ...input, fields: { ...input.fields, name: 'Different' } }, ctx), 'request_reused');
});
test('canonical/index/record/activity persist with one timeline entry across retries', async () => {
  const s = stores(); const input = create(); const first = await persist(input, s); const again = await persist(input, s);
  assert.equal(first.syncPending, false); assert.equal(again.replay, true); assert.equal((await s.sales.readJSON('records/index')).data.length, 1); assert.equal((await s.crm.readJSON('activity/index')).data.length, 1);
  assert.deepEqual((await s.sales.readJSON('records/' + first.recordId)).data, (await s.sales.readJSON('records/index')).data[0]);
});
test('concurrent creates use CAS and retain both records', async () => {
  const s = stores(); const results = await Promise.all([persist(create(), s), persist(create({ name: 'Second Synthetic', email: 'second@example.test' }), s)]);
  assert.equal(results.length, 2); assert.equal((await s.sales.readJSON('records/index')).data.length, 2); assert.equal((await s.crm.readJSON('activity/index')).data.length, 2);
});
test('concurrent edits of same revision permit only one winner', async () => {
  const r = row(); const s = stores([r]); const results = await Promise.allSettled([persist(update(r, { name: 'One' }), s), persist(update(r, { name: 'Two' }), s)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.find(r => r.status === 'rejected').reason.code, 'stale_record');
});
test('partial projection and mirror failures are repaired by idempotent retry', async () => {
  const s = stores(); s.crm.failWrites.add('activity/index'); s.sales.failMirrors = true;
  const input = create(); const first = await persist(input, s); assert.equal(first.syncPending, true);
  s.crm.failWrites.clear(); s.sales.failMirrors = false;
  const second = await persist(input, s); assert.equal(second.replay, true); assert.equal(second.syncPending, false); assert.equal(s.sales.mirrors.get('records/index').length, 1);
});
test('independently changed record copy is never overwritten', async () => {
  const r = row(); const s = stores([r]); s.sales.values.set('records/' + r.id, { data: { ...r, status: 'changed-elsewhere' }, etag: '2' });
  await assert.rejects(persist(update(r, { name: 'One' }), s), error => error.code === 'record_sync_required');
  assert.equal((await s.sales.readJSON('records/index')).data[0].customer.name, r.customer.name);
});
test('timeline contains actor and field names, not old or new contact values', async () => {
  const s = stores(); await persist(create(), s); const activity = (await s.crm.readJSON('activity/index')).data[0];
  assert.ok(activity.detail.includes(ctx.actor)); assert.ok(activity.detail.includes('email')); assert.ok(!activity.detail.includes('client@example.test'));
});

// Exercise the real HTTP wrapper with isolated authentication/storage adapters.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = await readFile(new URL('../netlify/functions/admin-crm-records.mts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function endpoint(auth = { user: { email: ctx.actor }, tenant: { id: ctx.tenantId } }, s = stores()) {
  const requested = [];
  const modules = {
    './_shared/admin': { requireCapability: async capability => { requested.push(capability); return auth; } },
    './_shared/tenant': { runWithTenant: async (_, fn) => fn() },
    './_shared/tenant-storage': { conditionalTenantStoreFor: (_, tenant, domain) => { assert.equal(tenant.id, ctx.tenantId); return s[domain]; } },
    './_shared/crm-record-editor.mjs': model,
  };
  const module = { exports: {} }; new Function('require', 'module', 'exports', compiled)(name => { assert.ok(modules[name], name); return modules[name]; }, module, module.exports);
  return { handle: module.exports.default, requested, s };
}
const request = (payload = create(), options = {}) => new Request('https://crm.example.test/api/admin/crm-records', { method: 'POST', headers: { origin: 'https://crm.example.test', 'content-type': 'application/json', ...options.headers }, body: typeof payload === 'string' ? payload : JSON.stringify(payload) });
test('unauthenticated and read-only writers are rejected before storage', async () => {
  for (const status of [401, 403]) { const e = endpoint({ response: new Response('Denied', { status }) }); assert.equal((await e.handle(request(), {})).status, status); assert.deepEqual(e.requested, ['crm.manage']); }
});
test('cross-origin, non-JSON, malformed and oversized requests are rejected', async () => {
  const e = endpoint();
  assert.equal((await e.handle(request(create(), { headers: { origin: 'https://attacker.example.test' } }), {})).status, 403);
  assert.equal((await e.handle(request(create(), { headers: { 'content-type': 'text/plain' } }), {})).status, 415);
  assert.equal((await e.handle(request('{bad'), {})).status, 400);
  assert.equal((await e.handle(request(' '.repeat(17000)), {})).status, 413);
});
test('GET needs view capability and returns only the editor DTO', async () => {
  const r = row({ accounting: { quickbooks: { private: 'never-return' } } }); const e = endpoint(undefined, stores([r]));
  const response = await e.handle(new Request('https://crm.example.test/api/admin/crm-records?recordId=' + r.id), {});
  assert.equal(response.status, 200); assert.deepEqual(e.requested, ['crm.view']); const data = await response.json(); assert.equal(data.editor.id, r.id); assert.equal(data.editor.accounting, undefined); assert.equal(data.editor.values.name, r.customer.name);
});
test('HTTP save is tenant scoped, successful and no-store', async () => {
  const e = endpoint(); const response = await e.handle(request(), {}); assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/); assert.equal((await response.json()).syncPending, false);
});
test('storage failures return privacy-safe uncertain-save diagnostics', async () => {
  const s = stores(); s.sales.readJSON = async () => { throw new Error('secret should never leak'); }; const e = endpoint(undefined, s); const response = await e.handle(request(), {}); assert.equal(response.status, 503); const raw = await response.text(); assert.match(raw, /save_unconfirmed/); assert.ok(!raw.includes('secret'));
});
