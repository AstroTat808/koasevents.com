import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIdentityMigrationPlan, migrateIdentityRows, rollbackIdentityRows,
  recordIndexRevision } from '../netlify/functions/_shared/customer-identity-migration.mjs';
import { buildCustomerDirectory } from '../netlify/functions/_shared/customer-directory.mjs';
import { migrationAction, migrationPreview } from '../netlify/functions/_shared/customer-identity-workflow.mjs';

const tenantId = 'test-tenant';
const baseDate = '2026-10-21T12:00:00Z';
const record = (id, attrs = {}) => ({
  id, tenantId, kind: 'inquiry', stage: 'booked', createdAt: baseDate,
  customer: { name: 'Synthetic Account', email: 'ACCOUNT@example.test', phone: '8085550111', eventDate: '2027-10-01' },
  proposal: { publicToken: 'proposal-' + id, total: 8000 },
  booking: { contract: { status: 'signed' }, payments: [{ id: id + '-deposit', amount: 800, status: 'paid' }] },
  accounting: { quickbooks: { customerId: 'QBO-001', invoices: [{ invoiceId: 'INV-' + id, total: 8000 }] } },
  timeline: [{ id: 'ACT-' + id, detail: 'Synthetic initial note' }],
  ...attrs,
});
class Memory {
  constructor(entries = {}) {
    this.map = new Map(Object.entries(entries).map(([key, value]) => [key, { data: structuredClone(value), etag: '1' }]));
    this.failWrites = new Set(); this.mirrorFailed = false;
  }
  async readJSON(key) { return structuredClone(this.map.get(key) || { data: null, etag: null }); }
  async writeJSON(key, data, expectedEtag) {
    if (this.failWrites.has(key)) throw new Error('synthetic storage outage');
    const current = this.map.get(key);
    if ((current?.etag || null) !== expectedEtag) return { modified: false };
    this.map.set(key, { data: structuredClone(data), etag: String(Number(current?.etag || '0') + 1) });
    return { modified: true };
  }
  async mirrorJSON() { return !this.mirrorFailed; }
}
const fixture = (records = [record('INQ-SYNT-1'), record('INQ-SYNT-2')]) => ({
  sales: new Memory({ 'records/index': records, ...Object.fromEntries(records.map(r => ['records/' + r.id, r])) }),
  crm: new Memory(),
  tenantId,
});
async function execute(s, action, planId, actorId='second-admin', now=baseDate) {
  return migrationAction({ action, planId, tenantId, actorId, now, sales:s.sales, crm:s.crm });
}
async function ready(s) {
  const {plan} = await migrationPreview(s);
  await execute(s,'propose',plan.planId,'first-admin');
  await execute(s,'approve',plan.planId,'second-admin');
  return plan;
}
test('dry-run plan does not alter projects or financial data', () => {
  const records=[record('INQ-1'),record('INQ-2',{ customer: { name:'Synthetic Account', email:'ACCOUNT@example.test', phone:'8085550111', eventDate:'2028-01-01' } })];
  const before=structuredClone(records);
  const plan=buildIdentityMigrationPlan(records,tenantId);
  assert.equal(plan.assignmentCount,2);
  assert.deepEqual(records,before);
  const applied=migrateIdentityRows(records,plan.assignments);
  for(let i=0;i<records.length;i++){
    assert.deepEqual(applied[i].accounting,records[i].accounting);
    assert.deepEqual(applied[i].booking,records[i].booking);
    assert.deepEqual(applied[i].proposal,records[i].proposal);
    assert.deepEqual(applied[i].timeline,records[i].timeline);
    assert.equal(applied[i].id,records[i].id);
  }
  assert.deepEqual(rollbackIdentityRows(applied,plan.assignments),records);
});
test('single customer with multiple dates gets one reusable customer identity', () => {
  const rows=[record('INQ-1'),record('INQ-2',{customer:{name:'Synthetic Account',email:'ACCOUNT@example.test',phone:'8085550111',eventDate:'2028-01-01'}})];
  const applied=migrateIdentityRows(rows,buildIdentityMigrationPlan(rows,tenantId).assignments);
  assert.equal(buildCustomerDirectory(applied,{tenantId}).customers.length,1);
  assert.equal(buildCustomerDirectory(applied,{tenantId}).customers[0].projects.length,2);
});
test('ambiguous identities, name-only records and conflicting external financial links are excluded', () => {
  const rows=[
    record('INQ-1',{accounting:{quickbooks:{customerId:'QBO-A'}}}),
    record('INQ-2',{accounting:{quickbooks:{customerId:'QBO-B'}}}),
    record('INQ-3',{customer:{name:'Unverified Person',email:'',phone:'',eventDate:'2027-01-01'}}),
    record('INQ-4',{customer:{name:'Another Person',email:'ACCOUNT@example.test',phone:'',eventDate:'2027-05-01'}}),
  ];
  const plan=buildIdentityMigrationPlan(rows,tenantId);
  assert.equal(plan.assignmentCount,0);
  assert.ok(plan.skipped.ambiguous>=2);
  assert.ok(plan.skipped.unverified>=1);
  assert.ok(plan.conflicts.length>=1);
});
test('proposal requires a distinct approving administrator', async () => {
  const s=fixture();
  const plan=(await migrationPreview(s)).plan;
  await execute(s,'propose',plan.planId,'first-admin');
  await assert.rejects(execute(s,'approve',plan.planId,'first-admin'),error=>error.code==='second_approver_required');
  await assert.rejects(execute(s,'apply',plan.planId),error=>error.code==='approval_required');
  assert.equal(recordIndexRevision((await s.sales.readJSON('records/index')).data),plan.sourceRevision);
  await execute(s,'approve',plan.planId,'second-admin');
});
test('approved migration writes only customer IDs and rollback restores exact original index', async () => {
  const s=fixture();
  const before=(await s.sales.readJSON('records/index')).data;
  const plan=await ready(s);
  const applied=await execute(s,'apply',plan.planId,'second-admin');
  assert.equal(applied.approval.status,'applied');
  assert.equal(applied.approval.syncPending,false);
  const after=(await s.sales.readJSON('records/index')).data;
  assert.equal(after.length,before.length);
  assert.ok(after.every(r=>r.customerId===plan.assignments[0].afterCustomerId));
  assert.deepEqual(after.map(r=>r.booking),before.map(r=>r.booking));
  assert.deepEqual(after.map(r=>r.accounting),before.map(r=>r.accounting));
  assert.deepEqual(after.map(r=>r.proposal),before.map(r=>r.proposal));
  const reverted=await execute(s,'rollback',plan.planId,'second-admin');
  assert.equal(reverted.approval.status,'rolled_back');
  assert.deepEqual((await s.sales.readJSON('records/index')).data,before);
  assert.deepEqual((await s.sales.readJSON('records/INQ-SYNT-1')).data,before[0]);
});
test('approval rejects a changed index rather than applying a stale plan', async () => {
  const s=fixture();const plan=(await migrationPreview(s)).plan;
  await execute(s,'propose',plan.planId,'first-admin');
  const snap=await s.sales.readJSON('records/index');
  await s.sales.writeJSON('records/index',[...snap.data,record('INQ-SYNT-3')],snap.etag);
  await assert.rejects(execute(s,'approve',plan.planId,'second-admin'),error=>error.code==='plan_changed');
});
test('rollback blocks modifications made after the migration', async () => {
  const s=fixture();const plan=await ready(s);
  await execute(s,'apply',plan.planId,'second-admin');
  const snap=await s.sales.readJSON('records/index');
  const modified=structuredClone(snap.data);
  modified[0].booking.payments.push({id:'real-followup',amount:500});
  await s.sales.writeJSON('records/index',modified,snap.etag);
  await assert.rejects(execute(s,'rollback',plan.planId,'second-admin'),error=>error.code==='rollback_conflict');
  assert.deepEqual((await s.sales.readJSON('records/index')).data[0].booking.payments,modified[0].booking.payments);
});
test('projection failures are reported and can be recovered without a second index commit', async () => {
  const s=fixture();const plan=await ready(s);
  s.sales.mirrorFailed=true;
  const applied=await execute(s,'apply',plan.planId);
  assert.equal(applied.syncPending,true);
  s.sales.mirrorFailed=false;
  const recovered=await execute(s,'reconcile',plan.planId);
  assert.equal(recovered.syncPending,false);
  assert.equal(recovered.approval.status,'applied');
});
test('apply is recoverable after index commit but before ledger update', async () => {
  const s=fixture();const plan=await ready(s);
  s.crm.failWrites.add('identity-migrations/'+plan.planId);
  await assert.rejects(execute(s,'apply',plan.planId),/synthetic storage outage/);
  s.crm.failWrites.clear();
  const recovered=await execute(s,'apply',plan.planId);
  assert.equal(recovered.approval.status,'applied');
  assert.equal(recovered.syncPending,false);
});
test('rollback is recoverable after index commit but before ledger update', async () => {
  const s=fixture();const plan=await ready(s);
  await execute(s,'apply',plan.planId);
  s.crm.failWrites.add('identity-migrations/'+plan.planId);
  await assert.rejects(execute(s,'rollback',plan.planId),/synthetic storage outage/);
  s.crm.failWrites.clear();
  const recovered=await execute(s,'rollback',plan.planId);
  assert.equal(recovered.approval.status,'rolled_back');
  assert.equal(recovered.syncPending,false);
  assert.equal(recordIndexRevision((await s.sales.readJSON('records/index')).data),plan.sourceRevision);
});
test('cross-tenant rows cannot be included in a migration', () => {
  assert.throws(()=>buildIdentityMigrationPlan([record('INQ-X',{tenantId:'other'})],tenantId),
    error=>error.code==='invalid_record_index');
});
test('small batches preserve additional eligible records for later approved plans', () => {
  const rows=Array.from({length:16},(_,i)=>record('INQ-'+String(i).padStart(3,'0'),{
    customer:{name:'Synthetic Person '+i,email:'person'+i+'@example.test',phone:'808555'+String(1000+i),eventDate:'2027-01-01'},
  }));
  const plan=buildIdentityMigrationPlan(rows,tenantId);
  assert.equal(plan.assignmentCount,12);
  assert.equal(plan.remainingAfterBatch,4);
  const next=buildIdentityMigrationPlan(migrateIdentityRows(rows,plan.assignments),tenantId);
  assert.equal(next.assignmentCount,4);
});
