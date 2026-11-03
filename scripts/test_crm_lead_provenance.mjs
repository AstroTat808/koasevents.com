import assert from 'node:assert/strict';
import {
  normalizeLeadAttribution, buildLeadOriginSnapshot, leadOriginEvidence,
  makeLeadSourceCorrection, appendLeadSourceCorrection, readLeadSourceCorrections,
} from '../netlify/functions/_shared/lead-provenance.mjs';

const lead={
  id:'INQ-TEST',createdAt:'2026-11-03T12:00:00.000Z',source:'koa-event-inquiry',
  customer:{eventDate:'2027-07-04',notes:'Venue and dinner'},
  packageId:'plumeria',inquiry:{formName:'koa-event-inquiry',source:'Instagram',
    referralSource:'Event planner',service:'venue',eventType:'wedding',guestCount:40,
    budget:'5000',priorities:'Venue and dinner'},
};
const snapshot=buildLeadOriginSnapshot(lead,{attribution:{
  utmSource:'google',utmMedium:'cpc',utmCampaign:'wedding_2026',
  pagePath:'/inquire/',referringHost:'google.com',
}});
assert.equal(snapshot.channel,'koa-event-inquiry');
assert.equal(snapshot.initialInquiry.guestCount,40);
assert.equal(snapshot.referralSource,'Event planner');
assert.equal(snapshot.attribution.utmSource,'google');
assert.equal(snapshot.capturedAt,lead.createdAt);
assert.equal(snapshot.attribution.pagePath,'/inquire/');
const invalid=normalizeLeadAttribution({pagePath:'https://evil.example/?password=x',referringHost:'evil.com/?key=x'});
assert.equal(invalid.pagePath,'');
assert.equal(invalid.referringHost,'');
assert.equal(leadOriginEvidence({...lead,leadProvenance:snapshot}).reliability,'saved_at_intake');
assert.equal(leadOriginEvidence(lead).reliability,'legacy_record_fields');
const manual=buildLeadOriginSnapshot({
  source:'crm-manual-entry',createdAt:'2026-11-01T11:00:00.000Z',
  inquiry:{formName:'crm-manual-entry'},customer:{name:'Example'},
},{mode:'manual',actor:'staff@example.com'});
assert.equal(manual.intakeMode,'manual');
assert.equal(manual.capturedBy,'staff@example.com');

const values=new Map();
const store={
  async readJSON(key){return {data:values.has(key)?structuredClone(values.get(key)):null,etag:values.has(key)?String(JSON.stringify(values.get(key)).length):null};},
  async readOnlyJSON(key){return {data:values.has(key)?structuredClone(values.get(key)):null};},
  async writeJSON(key,value,etag){
    if(etag===null&&values.has(key))return {modified:false};
    if(etag!==null&&(!values.has(key)||String(JSON.stringify(values.get(key)).length)!==etag))return {modified:false};
    values.set(key,structuredClone(value));return {modified:true};
  },
};
const event=makeLeadSourceCorrection({recordId:'INQ-TEST',before:'Google',after:'Planner',actor:'admin@example.com'});
assert.equal(await appendLeadSourceCorrection(store,event),true);
assert.equal(await appendLeadSourceCorrection(store,event),true);
const history=await readLeadSourceCorrections(store,'INQ-TEST');
assert.equal(history.length,1);
assert.deepEqual(history[0],event);
assert.equal(values.has('lead-provenance/INQ-TEST/events/'+event.id),true);
await assert.rejects(appendLeadSourceCorrection(store,{...event,after:'unrelated'}),/conflict/i);
console.log('PASS | lead origin snapshots, safe attribution, legacy labeling, and idempotent audit ledger');
