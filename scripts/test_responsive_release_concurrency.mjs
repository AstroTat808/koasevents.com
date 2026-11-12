#!/usr/bin/env node
// Deterministic concurrency regression using the exact durable browser-evidence
// writer used in production. No Netlify credentials or customer data needed.
import assert from 'node:assert/strict';
import {
  persistIndependentResponsiveBrowserEvidence,
  readIndependentResponsiveBrowserEvidence,
  responsiveBrowserEvidenceKey,
} from '../netlify/functions/_shared/responsive-browser-evidence.mjs';

import { casMergeReleaseHistory } from '../netlify/functions/_shared/release-history-cas.mjs';

const sha='a'.repeat(40), deployId='b'.repeat(24);
const runId='43128521395', oldRunId='41683703455';
const identity={commit:sha,deployId,runId};
const report=browser=>({
  browser,cases:84,viewports:7,viewportNames:['phone','desktop'],
  criticalCount:0,designCount:0,reportMissing:false,
});

// Both write operations are forced to overlap before either can finish.
function concurrentStore(){
  const records=new Map();
  let writes=0,release;
  const barrier=new Promise(resolve=>{release=resolve;});
  return {
    records,
    async setJSON(key,value){
      assert(!records.has(key),'A browser evidence key was overwritten: '+key);
      writes++;
      if(writes===2)release();
      await barrier;
      records.set(key,structuredClone(value));
    },
    async get(key,{type,consistency}={}){
      assert.equal(type,'json');
      assert.equal(consistency,'strong');
      return structuredClone(records.get(key)||null);
    },
  };
}

const store=concurrentStore();
const attempts=await Promise.all([
  persistIndependentResponsiveBrowserEvidence(store,{
    ...identity,browser:'chromium',checkedAt:'2026-11-12T00:00:00Z',report:report('chromium'),
  }),
  persistIndependentResponsiveBrowserEvidence(store,{
    ...identity,browser:'webkit',checkedAt:'2026-11-12T00:00:01Z',report:report('webkit'),
  }),
]);
assert.equal(store.records.size,2,'Two simultaneous browser audits must write two independent records.');
assert.notEqual(
  responsiveBrowserEvidenceKey({...identity,browser:'chromium'}),
  responsiveBrowserEvidenceKey({...identity,browser:'webkit'}),
  'Chromium and WebKit must never share a storage key.');
for(const attempt of attempts){
  assert.equal(attempt.stored,true);
  assert.equal(attempt.complete,true,
    'Both browser writes have completed before either durable read-back.');
  assert.equal(attempt.responsiveQuality.status,'passed');
}
const final=await readIndependentResponsiveBrowserEvidence(store,identity);
assert.equal(final.complete,true);
assert.equal(final.responsiveQuality.runId,runId);
assert.deepEqual(final.responsiveQuality.chromium,report('chromium'));
assert.deepEqual(final.responsiveQuality.webkit,report('webkit'));
assert.equal(final.responsiveQuality.status,'passed');

const old=await readIndependentResponsiveBrowserEvidence(store,{...identity,runId:oldRunId});
assert.equal(old.complete,false,'A stale run must never inherit new-run browser evidence.');
assert.equal(old.responsiveQuality.status,'partial');
assert.equal(old.responsiveQuality.chromium,null);
assert.equal(old.responsiveQuality.webkit,null);
await assert.rejects(
  persistIndependentResponsiveBrowserEvidence(store,{
    ...identity,runId:'bad-run',browser:'webkit',checkedAt:'2026-11-12T00:01:00Z',report:report('webkit'),
  }),
  /RESPONSIVE_EVIDENCE_IDENTITY_INVALID/,
);

const chromiumOnly={
  records:new Map(),
  async setJSON(key,value){this.records.set(key,structuredClone(value));},
  async get(key){return structuredClone(this.records.get(key)||null);},
};
const partial=await persistIndependentResponsiveBrowserEvidence(chromiumOnly,{
  ...identity,browser:'chromium',checkedAt:'2026-11-12T00:02:00Z',report:report('chromium'),
});
assert.equal(partial.complete,false);
assert.equal(partial.responsiveQuality.status,'partial');
assert.equal(partial.responsiveQuality.webkit,null,
  'A missing WebKit report can never be filled from a previous run.');

// Two CAS merges deliberately read the SAME initial ETag. One loses the
// compare-and-swap and must retry against the winner's freshly written state.
let current=null,version=0,reads=0,casAttempts=0,unblock;
const firstReadBarrier=new Promise(resolve=>{unblock=resolve;});
const casStore={
  async readJSON(key){
    assert.equal(key,'deployments/releases');
    const snapshot={data:structuredClone(current),etag:version?String(version):null};
    reads++;
    if(reads<=2){
      if(reads===2)unblock();
      await firstReadBarrier;
    }
    return snapshot;
  },
  async writeJSON(key,value,etag){
    assert.equal(key,'deployments/releases');
    casAttempts++;
    if(etag!==(version?String(version):null))return {modified:false};
    current=structuredClone(value);
    version++;
    return {modified:true};
  },
};
const merged=await Promise.all([
  casMergeReleaseHistory(casStore,'deployments/releases',row=>({
    ...(row||{}),chromium:{browser:'chromium',passed:true},
  })),
  casMergeReleaseHistory(casStore,'deployments/releases',row=>({
    ...(row||{}),webkit:{browser:'webkit',passed:true},
  })),
]);
assert.equal(merged.length,2);
assert.equal(current.chromium.passed,true,'CAS must retain Chromium update.');
assert.equal(current.webkit.passed,true,'CAS must retain WebKit update.');
assert(casAttempts>=3,'Test must exercise at least one real CAS conflict and retry.');
await assert.rejects(
  casMergeReleaseHistory({
    async readJSON(){return {data:null,etag:null};},
    async writeJSON(){return {modified:false};},
  },'deployments/releases',()=>({}),{maxAttempts:2}),
  /RELEASE_HISTORY_CONCURRENT_WRITE_EXHAUSTED/,
  'CAS exhaustion must fail closed rather than losing a write.');
console.log('PASS | two simultaneous CAS updates preserve both browser fields after a forced ETag collision.');

console.log('PASS | two simultaneous signed browser audits retain independent durable proofs; current-run aggregate is complete with zero critical findings; stale run and missing browser fail closed.');
