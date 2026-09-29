import assert from 'node:assert/strict';
import {
  buildDuplicateMergePreview,
  duplicateBookingGroups,
  findExistingBookingCandidate,
  mergeDuplicateSalesRecord,
  relinkRecordIdRows,
} from '../netlify/functions/_shared/duplicate-bookings.mjs';

const weak = {
  id:'CRM-WEAK',
  kind:'proposal',
  stage:'proposal',
  source:'website-inquiry',
  createdAt:'2026-09-20T00:00:00Z',
  customer:{name:'Chris Sibel',email:'chris@sibel.org',eventDate:'2027-09-18'},
  packageId:'hibiscus',
  proposal:{status:'draft',total:0},
};
const strong = {
  id:'CRM-STRONG',
  kind:'proposal',
  stage:'proposal',
  source:'quickbooks-import',
  createdAt:'2026-09-21T00:00:00Z',
  customer:{name:'Chris Sibel',email:'chris@sibel.org',eventDate:'2027-09-18'},
  packageId:'hibiscus',
  proposal:{status:'sent',total:15707},
  accounting:{quickbooks:{origin:'quickbooks',customerId:'46',estimateId:'176',estimates:[{id:'176',total:15707}],invoices:[],payments:[]}},
};
const otherDate = {
  id:'CRM-OTHER',
  customer:{name:'Chris Sibel',email:'chris@sibel.org',eventDate:'2027-09-19'},
  proposal:{status:'draft',total:100},
};

const groups=duplicateBookingGroups([weak,strong,otherDate]);
assert.equal(groups.length,1);
assert.equal(groups[0].count,2);
assert.equal(groups[0].recommendedSurvivorId,'CRM-STRONG');

const candidate=findExistingBookingCandidate([weak,strong],{
  id:'QBO-CANDIDATE',
  customer:{name:'Chris Sibel',email:'chris@sibel.org',eventDate:'2027-09-18'},
});
assert.equal(candidate?.id,'CRM-STRONG');

const preview=buildDuplicateMergePreview([weak,strong],'CRM-STRONG',['CRM-WEAK']);
assert.equal(preview.canApply,true);
assert.equal(preview.survivorId,'CRM-STRONG');

const conflicting={
  ...weak,
  id:'CRM-CONFLICT',
  accounting:{quickbooks:{customerId:'999'}},
};
const blocked=buildDuplicateMergePreview([strong,conflicting],'CRM-STRONG',['CRM-CONFLICT']);
assert.equal(blocked.canApply,false);
assert.match(blocked.blockingReasons.join(' '),/QuickBooks/);

const merged=mergeDuplicateSalesRecord(
  {...strong,booking:{contract:{signwell:{documentId:'DOC-1'}},payments:[]}},
  [{...weak,communications:{welcome:{status:'sent'}},booking:{payments:[{id:'PAY-1',amount:100,status:'paid'}]}}],
  'tester@example.com',
);
assert.equal(merged.accounting.quickbooks.customerId,'46');
assert.equal(merged.booking.contract.signwell.documentId,'DOC-1');
assert.equal(merged.booking.payments.length,1);
assert.equal(merged.communications.welcome.status,'sent');
assert.deepEqual(merged.mergedRecordIds,['CRM-WEAK']);

const relinked=relinkRecordIdRows([{id:'N1',recordId:'CRM-WEAK'},{id:'N2',recordId:'CRM-STRONG'}],['CRM-WEAK'],'CRM-STRONG');
assert.equal(relinked.every((row)=>row.recordId==='CRM-STRONG'),true);

console.log('Duplicate booking regression passed: detection, survivor selection, external-link blocking, merge preservation, and relinking are intact.');
