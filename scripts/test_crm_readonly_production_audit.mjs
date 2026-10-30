import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReadOnlyCrmProductionAudit } from '../netlify/functions/_shared/crm-readonly-production-audit.mjs';

const tenantId = 'synthetic-tenant';
const row = (id, attrs = {}) => ({
  id, tenantId, kind: 'inquiry', stage: 'booked', createdAt: '2026-01-01T12:00:00Z',
  customer: { name: 'PRIVATE_CUSTOMER_NAME', email: 'PRIVATE_CUSTOMER@example.invalid', phone: '8080007777' },
  projectName: 'PRIVATE_PROJECT_TITLE',
  booking: { contract: { status: 'signed' }, payments: [{ id: 'p1', amount: 3 }] },
  accounting: { quickbooks: { customerId: 'QBO-PRIVATE-999', invoices: [{ id: 'inv1' }], payments: [{ id: 'pay1' }] } },
  ...attrs,
});
test('live preview audit has one customer, distinct projects, and zero mutations', () => {
  const rows=[row('INQ-1'),row('INQ-2',{customer:{name:'PRIVATE_CUSTOMER_NAME',email:'PRIVATE_CUSTOMER@example.invalid',phone:'8080007777',eventDate:'2027-01-01'}})];
  const before=structuredClone(rows);
  const result=buildReadOnlyCrmProductionAudit({
    records:rows,notes:[{recordId:'INQ-1',body:'PRIVATE_NOTE'}],tasks:[{recordId:'INQ-2',title:'PRIVATE_TASK'}],tenantId,
  });
  assert.equal(result.totals.uniqueCustomers,1);
  assert.equal(result.totals.projects,2);
  assert.equal(result.totals.customerGroupsWithMultipleProjects,1);
  assert.equal(result.preview.assignmentCount,2);
  assert.equal(result.preview.maxBatchSize,12);
  assert.equal(result.financeCounts.bookingPayments,2);
  assert.equal(result.financeCounts.quickBooksInvoices,2);
  assert.equal(result.financeCounts.quickBooksPayments,2);
  assert.equal(result.customerDataMutations,0);
  assert.equal(result.readOnly,true);
  assert.deepEqual(rows,before);
  const safe=JSON.stringify(result);
  for (const secret of ['PRIVATE_CUSTOMER','PRIVATE_PROJECT','PRIVATE_NOTE','PRIVATE_TASK','QBO-PRIVATE','INQ-1','INQ-2','8080007777']) {
    assert.equal(safe.includes(secret),false,'PII marker escaped: '+secret);
  }
});
test('unsafe source indexes are blocked rather than certified as clean', () => {
  const rows=[row('INQ-1'),row('INQ-1')];
  const out=buildReadOnlyCrmProductionAudit({records:rows,tenantId});
  assert.equal(out.status,'blocked');
  assert.equal(out.totals.duplicateRecordIds,1);
  assert.equal(out.preview.assignmentCount,0);
  assert.equal(out.preview.reasonCode,'INVALID_RECORD_INDEX');
});
test('cross-tenant records block migration without emitting customer fields', () => {
  const out=buildReadOnlyCrmProductionAudit({records:[row('INQ-1',{tenantId:'other'})],tenantId});
  assert.equal(out.totals.foreignTenantRecords,1);
  assert.equal(out.preview.status,'blocked');
  assert.equal(JSON.stringify(out).includes('PRIVATE_CUSTOMER'),false);
});
test('shared email conflict is review-only, and incomplete records are not assumed eligible', () => {
  const rows=[row('INQ-1'),row('INQ-2',{customer:{name:'Different household member',email:'PRIVATE_CUSTOMER@example.invalid',phone:''}})];
  const out=buildReadOnlyCrmProductionAudit({records:rows,tenantId});
  assert.ok(out.reviewCategories.shared_email >= 1);
  assert.equal(out.preview.assignmentCount,0);
  assert.equal(out.status,'review_required');
  assert.equal(JSON.stringify(out).includes('Different household member'),false);
});
test('orphan notes and tasks stay flagged while customer identity remains read-only', () => {
  const out=buildReadOnlyCrmProductionAudit({
    records:[row('INQ-1')],notes:[{recordId:'MISSING-1',body:'SECRET'}],tasks:[{recordId:'MISSING-2',title:'SECRET'}],tenantId,
  });
  assert.equal(out.totals.noteOrphans,1);
  assert.equal(out.totals.taskOrphans,1);
  assert.equal(out.status,'review_required');
  assert.equal(JSON.stringify(out).includes('MISSING-'),false);
});
