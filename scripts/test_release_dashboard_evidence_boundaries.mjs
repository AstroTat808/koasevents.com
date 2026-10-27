// Synthetic, read-only evidence-boundary regressions. No network or tenant data.
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  boundedArtifactBytes, extractAttestationZip, productionSummary, netlifyPreview, NETLIFY_SITE_ID,
} from '../netlify/functions/_shared/release-dashboard.mjs';

const MAIN='a'.repeat(40),OLD='b'.repeat(40);
const active={id:'c'.repeat(24),site_id:NETLIFY_SITE_ID,commit_ref:MAIN,
  context:'production',state:'ready',published_at:'2026-10-13T18:00:00Z'};
const health={overall:'healthy',passed:82,failed:0,checkedAt:'2026-10-13T18:10:00Z',
  checks:[{id:'netlify-github-sync',ok:true, deploymentDetails:{netlifyCommit:MAIN,netlifyDeployId:active.id}}]};
const history=[active,{...active,id:'d'.repeat(24),commit_ref:OLD,published_at:'2026-10-13T19:00:00Z'}];
assert.equal(productionSummary(MAIN,history,health,active).deployId,active.id,
  'A newer historically published build must not replace the authoritative live pointer.');
assert.equal(productionSummary(MAIN,history,health,active).health.status,'healthy');
assert.equal(productionSummary(MAIN,null,health,active).deployId,active.id,
  'Missing preview history must not hide a separately verified published pointer.');
assert.equal(productionSummary(MAIN,history,health).status,'unavailable');
for(const invalid of [null,{...active,site_id:'other-site'},
  {...active,state:'building'},{...active,context:'deploy-preview'},
  {...active,published_at:'invalid'},{...active,id:'missing'}, {...active,commit_ref:''}]){
  assert.equal(productionSummary(MAIN,history,health,invalid).status,'unavailable');
}
const rollback={...active,id:'e'.repeat(24),commit_ref:OLD};
assert.equal(productionSummary(MAIN,history,health,rollback).status,'behind');
assert.equal(productionSummary(MAIN,history,health,rollback).health.status,'stale');
assert.equal(productionSummary(MAIN,history,{...health,checkedAt:'2026-10-13T17:00:00Z'},active).health.status,'stale');
for(const value of [null,undefined,-1,NaN,'0',0.5]){
  const result=productionSummary(MAIN,history,{...health,failed:value},active);
  assert.equal(result.health.failed,null);
  assert.notEqual(result.health.status,'healthy');
}
assert.notEqual(productionSummary(MAIN,history,{...health,passed:null},active).health.status,'healthy');
const synthetic='SYNTHETIC_PRIVATE_DETAIL_DO_NOT_RETURN';
const redacted=productionSummary(MAIN,history,{...health,checks:[...health.checks,
  {id:synthetic,name:synthetic,detail:synthetic,ok:false}]},active);
assert.equal(redacted.health.status,'unhealthy','Explicit failed checks must not be hidden by inconsistent zero totals.');
assert.ok(!JSON.stringify(redacted).includes(synthetic));
assert.equal(redacted.health.unhealthy[0].id,'failed-check-1');

let cancelled=false;
const overflow=new Response(new ReadableStream({
  start(controller){controller.enqueue(new Uint8Array(3));controller.enqueue(new Uint8Array(3));},
  cancel(){cancelled=true;},
}),{headers:{'content-length':'1'}});
await assert.rejects(()=>boundedArtifactBytes(overflow,5),/exceeds size budget/);
assert.equal(cancelled,true,'A dishonest Content-Length must not bypass the streaming byte limit.');
await assert.rejects(()=>boundedArtifactBytes(new Response(new Uint8Array(6)),5),/exceeds size budget/);
await assert.rejects(()=>boundedArtifactBytes(new Response(new Uint8Array(2),{headers:{'content-length':'99'}}),5),/exceeds size budget/);
await assert.rejects(()=>boundedArtifactBytes(new Response(null)),/body is missing/);
await assert.rejects(()=>boundedArtifactBytes(new Response(new Uint8Array(1)),0),/Invalid archive byte budget/);
const streamed=new Response(new ReadableStream({start(controller){
  controller.enqueue(new Uint8Array([1,2]));controller.enqueue(new Uint8Array([3,4,5]));controller.close();
}}));
assert.deepEqual([...await boundedArtifactBytes(streamed,5)],[1,2,3,4,5]);

function archive(payload,declaredLength){
  const file=Buffer.from('final-attestation.json'),bytes=Buffer.from(payload),compressed=deflateRawSync(bytes);
  const local=Buffer.alloc(30),directory=Buffer.alloc(46),end=Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);
  local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(declaredLength??bytes.length,22);local.writeUInt16LE(file.length,26);
  directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(8,10);
  directory.writeUInt32LE(compressed.length,20);directory.writeUInt32LE(declaredLength??bytes.length,24);directory.writeUInt16LE(file.length,28);
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);
  end.writeUInt32LE(directory.length+file.length,12);end.writeUInt32LE(local.length+file.length+compressed.length,16);
  return Buffer.concat([local,file,compressed,directory,file,end]);
}
const previewError=netlifyPreview([{review_id:250,context:'deploy-preview',commit_ref:MAIN,state:'error',error_message:synthetic}],250,MAIN);
assert.ok(!JSON.stringify(previewError).includes(synthetic));
assert.throws(()=>extractAttestationZip(archive(synthetic)),error=>error.message==='Release attestation JSON is malformed.');
const valid=archive(JSON.stringify({head:MAIN}));
assert.deepEqual(extractAttestationZip(await boundedArtifactBytes(new Response(valid))),{head:MAIN});
const dishonest=archive(JSON.stringify({text:'x'.repeat(250000)}),100);
assert.throws(()=>extractAttestationZip(dishonest),error=>error?.code==='ERR_BUFFER_TOO_LARGE',
  'The inflater must stop at the declared bounded output, not allocate the expanded payload first.');
assert.throws(()=>extractAttestationZip(archive('{}',0)),/oversized/);
assert.throws(()=>extractAttestationZip(archive('{}',150001)),/oversized/);
console.log('PASS | synthetic published-pointer, rollback, stale health, metadata privacy, streaming-size and bounded-inflation regressions.');
