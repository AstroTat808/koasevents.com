#!/usr/bin/env node
// Recovery fault injection: a successful Blob mutation can lose its response.
// No production calls or customer data; all storage is an isolated fake.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {casMergeReleaseHistory} from '../netlify/functions/_shared/release-history-cas.mjs';

function fake({interrupt='none'}={}){
  let etag=0, data=null, writes=0, interrupts=0;
  return {
    get writes(){return writes;},
    get data(){return structuredClone(data);},
    async readJSON(){
      return {data:structuredClone(data),etag:data===null?null:String(etag)};
    },
    async writeJSON(key,value,version){
      assert.equal(key,'deployments/releases/by-id/deploy-1');
      writes++;
      const current=data===null?null:String(etag);
      if(current!==version)return {modified:false};
      const commit=()=>{
        data=structuredClone(value);
        etag++;
      };
      if(interrupt==='before'&&!interrupts++){
        throw new Error('simulated socket close before commit');
      }
      commit();
      if(interrupt==='after'&&!interrupts++){
        throw new Error('simulated socket close after durable commit');
      }
      return {modified:true};
    },
  };
}

const key='deployments/releases/by-id/deploy-1';
const merger=current=>({
  ...(current||{}),deployId:'deploy-1',commit:'a'.repeat(40),
  evidence:{...(current?.evidence||{}),chromium:{runId:'43130466854',passed:true}},
});
const post=fake({interrupt:'after'});
const postResult=await casMergeReleaseHistory(post,key,merger);
assert.equal(post.writes,1,'Post-commit response loss must not produce an unnecessary replay.');
assert.deepEqual(postResult,post.data);
assert.equal(postResult.evidence.chromium.passed,true);

const pre=fake({interrupt:'before'});
const preResult=await casMergeReleaseHistory(pre,key,merger);
assert.equal(pre.writes,2,'Pre-commit interruption should recover by retrying against latest ETag.');
assert.deepEqual(preResult,pre.data);

const alwaysBroken={
  async readJSON(){return {data:null,etag:null};},
  async writeJSON(){throw new Error('unavailable before commit');},
};
await assert.rejects(()=>casMergeReleaseHistory(alwaysBroken,key,merger,{maxAttempts:3}),
  /RELEASE_HISTORY_CONCURRENT_WRITE_EXHAUSTED/);
const noFalsePositive={
  async readJSON(){return {data:{deployId:'deploy-1',evidence:{webkit:{passed:true}}},etag:'1'};},
  async writeJSON(){throw new Error('interrupted before commit');},
};
await assert.rejects(()=>casMergeReleaseHistory(noFalsePositive,key,merger,{maxAttempts:2}),
  /RELEASE_HISTORY_CONCURRENT_WRITE_EXHAUSTED/,
  'Another writer or an incomplete readback cannot masquerade as committed evidence.');

const last=fake();
const baseline=await casMergeReleaseHistory(last,key,()=>({
  deployId:'deploy-1',commit:'a'.repeat(40),
  evidence:{webkit:{runId:'43130466854',passed:true}},
}));
assert.equal(baseline.evidence.webkit.passed,true);
const recovered=await casMergeReleaseHistory(last,key,merger);
assert.equal(recovered.evidence.chromium.passed,true);
assert.equal(recovered.evidence.webkit.passed,true,
  'Recovery merges must preserve independent evidence written previously.');

// The rolling dashboard must never advertise a release before the durable
// immutable per-deploy record is committed. Simulate an interruption between
// the two distinct CAS keys and then an idempotent recovery.
const source=readFileSync(new URL('../netlify/functions/_shared/system-health.ts',import.meta.url),'utf8');
const durableStage=source.indexOf("const durable=await casMergeReleaseHistory(conditional,'deployments/releases/by-id/'+deployId");
const visibleStage=source.indexOf("const rows=await casMergeReleaseHistory(conditional,'deployments/releases'");
assert(durableStage>0&&visibleStage>durableStage,
  'Durable exact-deploy attestation must commit before the dashboard index can expose it.');
const records=new Map();
let seq=0;
const twoKeyStore={
  async readJSON(name){
    const item=records.get(name);
    return {data:structuredClone(item?.data??null),etag:item?.etag??null};
  },
  async writeJSON(name,value,previousEtag){
    const current=records.get(name);
    if((current?.etag??null)!==previousEtag)return {modified:false};
    records.set(name,{data:structuredClone(value),etag:String(++seq)});
    return {modified:true};
  },
};
const writeBoth=async(interrupt)=>{
  await casMergeReleaseHistory(twoKeyStore,key,merger);
  if(interrupt)throw new Error('simulated crash between immutable and visible writes');
  await casMergeReleaseHistory(twoKeyStore,'deployments/releases',rows=>[
    ...(Array.isArray(rows)?rows.filter(row=>row.deployId!=='deploy-1'):[]),
    records.get(key).data,
  ]);
};
await assert.rejects(writeBoth(true),/simulated crash/);
assert.equal((await twoKeyStore.readJSON('deployments/releases')).data,null,
  'An interrupted immutable write must not fabricate a visible green release.');
assert.equal((await twoKeyStore.readJSON(key)).data.deployId,'deploy-1');
await writeBoth(false);
assert.equal((await twoKeyStore.readJSON('deployments/releases')).data.length,1,
  'An idempotent recovery must safely publish the already-committed release.');

console.log('PASS | Release History interrupted pre/post-commit write recovery, exactly-once post-commit recognition, conflict merge and fail-closed exhaustion.');
