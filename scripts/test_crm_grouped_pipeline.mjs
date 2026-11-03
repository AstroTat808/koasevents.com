import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { reviewCustomerDuplicates } from '../netlify/functions/_shared/crm-duplicate-review.mjs';
import { inquiryReplayFingerprint, findInquiryReplay } from '../netlify/functions/_shared/crm-inquiry-replay.mjs';
import { buildDuplicateMergePreview } from '../netlify/functions/_shared/duplicate-bookings.mjs';

const context = { window: {} };
vm.runInNewContext(readFileSync(new URL('../public/scripts/crm-pipeline-groups.js', import.meta.url), 'utf8'), context);
const { groupProjects, isPipelineProject } = context.window.KoaCrmPipelineGroups;

const base = (id, overrides = {}) => ({
  id, kind:'inquiry', stage:'inquiry', createdAt:'2026-10-21T00:00:00Z',
  source:'koa-event-inquiry', businessLine:'events', packageId:'hibiscus',
  customer: { name:'Synthetic Client', email:'synthetic@example.test', phone:'8085550123', eventDate:'2027-09-18' },
  inquiry:{formName:'koa-event-inquiry',service:'venue',eventType:'wedding'},
  ...overrides,
});
const dir = (id, recordIds, more = {}) => ({
  id,name:'Synthetic Client',email:'synthetic@example.test',verified:true,
  recordIds,primaryRecordId:recordIds[0],projectCount:recordIds.length,...more,
});

test('pipeline groups verified contacts once and preserves independent projects', () => {
  const records = [base('INQ-1',{customerId:'CUST-A'}),base('INQ-2',{customerId:'CUST-A',
    customer:{...base('X').customer,eventDate:'2028-11-11'}})];
  const original = structuredClone(records);
  const groups=groupProjects(records,[dir('CUST-A',['INQ-1','INQ-2'])]);
  assert.equal(groups.length,1);
  assert.deepEqual(groups[0].records.map(p=>p.id),['INQ-1','INQ-2']);
  assert.deepEqual(records,original);
});

test('same names with distinct customer IDs stay separate; untrusted server links do not group', () => {
  const records=[base('INQ-1',{customerId:'CUST-A'}),base('INQ-2',{customerId:'CUST-B'})];
  assert.equal(groupProjects(records,[dir('CUST-A',['INQ-1']),dir('CUST-B',['INQ-2'])]).length,2);
  const unsafe=groupProjects(records,[dir('CUST-A',['INQ-2'])]);
  assert.equal(unsafe.length,2);
  assert.equal(unsafe[0].records.length,1);
  assert.ok(unsafe.every(row=>row.records.length===1));
});

test('converted parents are excluded from active pipeline, not deleted from history', () => {
  const inquiry=base('INQ-1',{stage:'converted'});
  const proposal=base('PRP-1',{stage:'proposal',kind:'proposal'});
  assert.equal(isPipelineProject(inquiry,'all'),false);
  assert.equal(isPipelineProject(proposal,'all'),true);
  assert.equal(isPipelineProject(inquiry,'converted'),true);
  assert.equal(groupProjects([inquiry,proposal],[dir('CUST-A',['INQ-1','PRP-1'])]).reduce((n,g)=>n+g.records.length,0),2);
});

test('name audit distinguishes explicit test, lifecycle, potential duplicates and separate dates', () => {
  const records=[
    base('INQ-A'),
    base('INQ-B'),
    base('LEAD-C',{stage:'converted',source:'INQ-A'}),
    base('INQ-D',{customer:{...base('X').customer,eventDate:'2028-03-03'}}),
    base('TEST-E',{isTest:true,source:'crm-manual-entry'}),
  ];
  const audit=reviewCustomerDuplicates(records,{name:'SYNTHETIC CLIENT'});
  assert.equal(audit.readOnly,true);
  assert.equal(audit.totals.active,5);
  assert.equal(audit.records.find(r=>r.id==='TEST-E').classification,'verified_test');
  assert.equal(audit.records.find(r=>r.id==='LEAD-C').classification,'conversion_history');
  assert.equal(audit.records.find(r=>r.id==='INQ-A').classification,'possible_redundant_opportunity');
  assert.equal(audit.records.find(r=>r.id==='INQ-D').classification,'distinct_event_date');
  assert.ok(audit.records.find(r=>r.id==='INQ-A').potentialDuplicateIds.includes('INQ-B'));
});

test('audit never assumes that a matching name with different contact means a duplicate', () => {
  const rows=[base('INQ-A'),base('INQ-B',{customer:{name:'Synthetic Client',email:'other@example.test',eventDate:'2027-09-18'}})];
  const audit=reviewCustomerDuplicates(rows,{name:'Synthetic Client'});
  assert.ok(audit.records.every(r=>r.potentialDuplicateIds.length===0));
});
test('archived and trash are reported separately, and linked accounting protects records', () => {
  const r=base('INQ-A',{accounting:{quickbooks:{customerId:'QBO-1',invoices:[{id:'I1'}]}}});
  const report=reviewCustomerDuplicates([r],{name:'Synthetic Client',
    archivedRecords:[base('ARCHIVED',{mergedInto:'INQ-A'})],
    trashedRecords:[base('TRASH')]});
  assert.equal(report.totals.active,1);
  assert.equal(report.totals.archived,1);
  assert.equal(report.totals.trash,1);
  assert.equal(report.records.find(x=>x.id==='INQ-A').protectedLinks.quickBooks,true);
});

test('exact inquiry submission is reused, distinct event/service/answers never suppressed', () => {
  const old=base('INQ-A');
  const same={...structuredClone(old),id:'INQ-B'};
  assert.equal(inquiryReplayFingerprint(old),inquiryReplayFingerprint(same));
  const opts={now:Date.parse(old.createdAt)+10000};
  assert.equal(findInquiryReplay([old],same,opts).replay.id,'INQ-A');
  const distinctEvent=base('INQ-C',{customer:{...old.customer,eventDate:'2028-01-01'}});
  assert.equal(findInquiryReplay([old],distinctEvent,opts).replay,null);
  const distinctService=base('INQ-C',{inquiry:{...old.inquiry,service:'photo-booth'}});
  assert.equal(findInquiryReplay([old],distinctService,opts).replay,null);
  const changedAnswer=base('INQ-C',{customer:{...old.customer,notes:'Need another layout'}});
  assert.equal(findInquiryReplay([old],changedAnswer,opts).replay,null);
  assert.equal(findInquiryReplay([old],same,{now:Date.parse(old.createdAt)+86400001}).replay,null);
});

test('submission-id replay rejects conflicting payloads', () => {
  const old=base('INQ-A',{submissionId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});
  const recheck=base('INQ-B',{submissionId:old.submissionId});
  assert.equal(findInquiryReplay([old],recheck,{now:Date.parse(old.createdAt)+1000}).replay.id,'INQ-A');
  const conflicting=base('INQ-C',{submissionId:old.submissionId,customer:{...old.customer,eventDate:'2029-01-01'}});
  assert.equal(findInquiryReplay([old],conflicting,{now:Date.parse(old.createdAt)+1000}).conflict,true);
});

test('merge preview blocks name-only, package, quotes, customer identity conflicts', () => {
  const first=base('INQ-A',{customer:{name:'Synthetic Client',email:'',eventDate:'2027-09-18'}});
  const second=base('INQ-B',{customer:{...first.customer}});
  const weak=buildDuplicateMergePreview([first,second],'INQ-A',['INQ-B']);
  assert.equal(weak.canApply,false);
  assert.match(weak.blockingReasons.join(' '),/matching name/);
  const verified=base('INQ-C'),same=base('INQ-D');
  const valid=buildDuplicateMergePreview([verified,same],'INQ-C',['INQ-D']);
  assert.equal(valid.canApply,true);
  assert.match(valid.previewRevision,/^[a-f0-9]{64}$/);
  const modified=buildDuplicateMergePreview([verified,{...same,updatedAt:'2030-01-01'}],'INQ-C',['INQ-D']);
  assert.notEqual(valid.previewRevision,modified.previewRevision);
  const conflict=buildDuplicateMergePreview([verified,{...same,packageId:'sunset',quoteId:'QUOTE-2',customerId:'CUST-X'}],'INQ-C',['INQ-D']);
  assert.equal(conflict.canApply,false);
  assert.match(conflict.blockingReasons.join(' '),/package/);
});

test('source integration has protected audit and conditional index write gates', () => {
  const handler=readFileSync(new URL('../netlify/functions/admin-crm.mts',import.meta.url),'utf8');
  const ingest=readFileSync(new URL('../netlify/functions/crm-inquiries.mts',import.meta.url),'utf8');
  const page=readFileSync(new URL('../src/pages/admin/crm/index.astro',import.meta.url),'utf8');
  assert.match(handler,/readOnlyJSON\('records\/index'\)/);
  assert.match(handler,/body\.previewRevision!==preview\.previewRevision/);
  assert.match(ingest,/conditionalTenantStoreFor\(/);
  assert.match(ingest,/findInquiryReplay\(/);
  assert.match(page,/KoaCrmPipelineGroups\.groupProjects/);
  assert.match(page,/data-client-name-audit-form/);
});
