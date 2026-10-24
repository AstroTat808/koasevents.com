import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomerDirectory } from '../netlify/functions/_shared/customer-directory.mjs';
import { prepareRecordMutation } from '../netlify/functions/_shared/crm-record-editor.mjs';
const tenantId = 'test-tenant';
const ctx = { tenantId, actor: 'synthetic@example.test', now: '2026-10-21T12:00:00Z' };
const project = (id, values = {}) => ({
  id, tenantId, kind: 'inquiry', stage: 'inquiry',
  customer: { name: 'Synthetic Client', email: 'SYNTHETIC@example.test', phone: '8085550101', eventDate: '2027-09-18', ...values },
  booking: { contract: { status: 'signed' }, payments: [{ id: id + '-payment', amount: 250 }] },
  accounting: { quickbooks: { customerId: 'qbo-synthetic' } },
  proposal: { publicToken: 'proposal-' + id }, createdAt: '2026-10-01T00:00:00Z',
});
const request = (sourceCustomerRecordId, fields = {}) => ({
  action: 'create-project', requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sourceCustomerRecordId,
  fields: { name: 'Synthetic Client', email: 'synthetic@example.test',
    phone: '8085550101', projectName: 'Another project', eventDate: '2027-11-12', businessLine: 'events', ...fields },
});
test('same customer multiple projects shows once, without deleting any records', () => {
  const records = [project('INQ-1'), project('INQ-2')];
  const original = structuredClone(records);
  const directory = buildCustomerDirectory(records, { tenantId });
  assert.equal(directory.customers.length, 1);
  assert.equal(directory.customers[0].projectCount, 2);
  assert.deepEqual(records, original);
  assert.equal(directory.audit.writeActionsTaken, 0);
});
test('project dates remain independent and do not affect identity grouping', () => {
  const directory = buildCustomerDirectory([project('INQ-1'),
    project('INQ-2', { eventDate: '2028-03-09' })], { tenantId });
  assert.equal(directory.customers.length, 1);
  assert.equal(directory.customers[0].projects.length, 2);
  assert.equal(directory.audit.totals.reviewGroups, 0);
});
test('a same-name contact with different verified email stays separate', () => {
  const directory = buildCustomerDirectory([project('INQ-1'),
    project('INQ-2', { email: 'other@example.test', phone: '' })], { tenantId });
  assert.equal(directory.customers.length, 2);
});
test('shared email with different names is flagged, not automatically joined', () => {
  const directory = buildCustomerDirectory([project('INQ-1'),
    project('INQ-2', { name: 'Different Person', phone: '' })], { tenantId });
  assert.equal(directory.customers.length, 2);
  assert.ok(directory.audit.reviewGroups.some(group => group.category === 'shared_email'));
});
test('name-only customers never merge automatically', () => {
  const directory = buildCustomerDirectory([project('INQ-1', { email: '', phone: '' }),
    project('INQ-2', { email: '', phone: '' })], { tenantId });
  assert.equal(directory.customers.length, 2);
  assert.ok(directory.audit.reviewGroups.some(group => group.category === 'unverified_name_match'));
});
test('multiple same-day projects remain separate and flagged for review', () => {
  const directory = buildCustomerDirectory([project('INQ-1'), project('INQ-2')], { tenantId });
  assert.equal(directory.customers[0].projects.length, 2);
  assert.ok(directory.audit.reviewGroups.some(group => group.category === 'possible_duplicate_project'));
});
test('source selection reuses customer ID without mutating signed records or payments', () => {
  const existing = project('INQ-1');
  const original = structuredClone(existing);
  const directory = buildCustomerDirectory([existing], { tenantId });
  const result = prepareRecordMutation([existing], request(directory.customers[0].id), ctx);
  assert.equal(result.record.customerId, directory.customers[0].id);
  assert.equal(result.record.customerReferenceId, existing.id);
  assert.equal(result.records.length, 2);
  assert.deepEqual(existing, original);
  assert.deepEqual(result.records[1].accounting, original.accounting);
  assert.deepEqual(result.records[1].booking, original.booking);
});
test('selected customer contact mismatch blocks linking', () => {
  const existing = project('INQ-1');
  const customerId = buildCustomerDirectory([existing], { tenantId }).customers[0].id;
  assert.throws(() => prepareRecordMutation([existing], request(customerId, { email: 'another@example.test', phone: '8085550123' }), ctx),
    error => error.code === 'customer_identity_mismatch');
});
test('project following creation remains grouped by explicit customer ID', () => {
  const existing = project('INQ-1');
  const directory = buildCustomerDirectory([existing], { tenantId });
  const next = prepareRecordMutation([existing], request(directory.customers[0].id), ctx);
  const after = buildCustomerDirectory(next.records, { tenantId });
  assert.equal(after.customers.length, 1);
  assert.equal(after.customers[0].projects.length, 2);
});
