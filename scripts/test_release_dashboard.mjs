import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import {
  latestRun,checkSummary,netlifyPreview,extractAttestationZip,qaFromAttestation,
  releaseRow,productionSummary,dashboardTotals,RELEASE_WORKFLOWS,
} from '../netlify/functions/_shared/release-dashboard.mjs';

function archive(name,content){
  const file=Buffer.from(name),bytes=Buffer.from(content);
  const compressed=deflateRawSync(bytes);
  const local=Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);
  local.writeUInt16LE(8,8);local.writeUInt32LE(0,14);
  local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(bytes.length,22);
  local.writeUInt16LE(file.length,26);
  const directory=Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);
  directory.writeUInt16LE(8,10);directory.writeUInt32LE(compressed.length,20);
  directory.writeUInt32LE(bytes.length,24);directory.writeUInt16LE(file.length,28);
  const end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);
  end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);
  end.writeUInt32LE(directory.length+file.length,12);
  end.writeUInt32LE(local.length+file.length+compressed.length,16);
  return Buffer.concat([local,file,compressed,directory,file,end]);
}
const HEAD='a'.repeat(40),MAIN='b'.repeat(40),MERGE='c'.repeat(40);
const attestation={
  head:HEAD,main:MAIN,checkedAt:'2026-10-08T19:18:51.783Z',
  evidence:{
    serviceFailure:true,failedQaStatus:422,
    browsers:['chromium','webkit'].map(browser=>({
      browser,routes:70,cases:287,failures:0,
      platform:{phone:'passed',desktop:'passed'},
    })),
  },
};
assert.deepEqual(extractAttestationZip(archive('final-attestation.json',JSON.stringify(attestation))),attestation);
assert.throws(()=>extractAttestationZip(Buffer.from('invalid')),/ZIP/);
assert.equal(qaFromAttestation(attestation,HEAD).status,'passed');
assert.equal(qaFromAttestation(attestation,MERGE).status,'unknown');
assert.equal(qaFromAttestation({...attestation,evidence:{...attestation.evidence,failedQaStatus:503}},HEAD).status,'failed');
const broken=structuredClone(attestation);
broken.evidence.browsers[1].platform.desktop='failed';
assert.equal(qaFromAttestation(broken,HEAD).status,'failed');
const brokenRoutes=structuredClone(attestation);
brokenRoutes.evidence.browsers[0].failures=1;
assert.equal(qaFromAttestation(brokenRoutes,HEAD).status,'failed');
const preview={id:'d'.repeat(24),context:'deploy-preview',review_id:249,commit_ref:HEAD,state:'ready',created_at:'2026-10-08T19:00:00Z',deploy_ssl_url:'https://deploy-preview-249--koasevents-website.netlify.app'};
assert.equal(netlifyPreview([preview],249,HEAD).exact,true);
assert.equal(netlifyPreview([preview],249,MERGE).status,'stale');
assert.equal(netlifyPreview(null,249,HEAD).status,'unavailable');
const workflowRuns=RELEASE_WORKFLOWS.map((name,i)=>({
  name,head_sha:HEAD,event:'pull_request',run_number:i+1,id:10+i,
  status:'completed',conclusion:'success',
}));
assert.equal(checkSummary(latestRun(workflowRuns,'Release Certification',HEAD)).status,'passed');
assert.equal(checkSummary(latestRun(workflowRuns,'Release Certification',MERGE)).status,'missing');
assert.equal(checkSummary({status:'completed',conclusion:'failure'}).status,'failed');
const prod=productionSummary(MERGE,[{
  id:'e'.repeat(24),commit_ref:MERGE,context:'production',state:'ready',
  published_at:'2026-10-08T18:59:00Z',
}],{
  checkedAt:'2026-10-08T19:13:36Z',overall:'healthy',passed:81,failed:0,
  checks:[{id:'netlify-github-sync',deploymentDetails:{netlifyCommit:MERGE,netlifyDeployId:'e'.repeat(24)}}],
});
assert.equal(prod.status,'synced');
assert.equal(prod.health.status,'healthy');
assert.equal(productionSummary(MERGE,[{...preview,context:'production',published_at:'2026-10-08T18:59:00Z'}],null).status,'behind');
const pr={
  number:249,title:'Permanent release gate',state:'open',head:{sha:HEAD,ref:'release-gate'},
  base:{ref:'main'},updated_at:'2026-10-08T19:00:00Z',user:{login:'operator'},
  html_url:'https://github.com/AstroTat808/koasevents.com/pull/249',
};
const ready=releaseRow({pr,runs:workflowRuns,deploys:[preview],comparison:{behind_by:0},attestation,prod});
assert.equal(ready.certified,true);
assert.equal(ready.releaseStatus,'ready');
const behind=releaseRow({pr,runs:workflowRuns,deploys:[preview],comparison:{behind_by:1},attestation,prod});
assert.equal(behind.certified,false);
assert.equal(behind.releaseStatus,'pending');
const failed=releaseRow({pr,runs:[...workflowRuns.filter(x=>x.name!=='Production visual QA'),
  {name:'Production visual QA',head_sha:HEAD,event:'pull_request',status:'completed',conclusion:'failure'}],
  deploys:[preview],comparison:{behind_by:0},attestation,prod});
assert.equal(failed.releaseStatus,'blocked');
const merged=releaseRow({
  pr:{...pr,state:'closed',merged_at:'2026-10-08T19:00:00Z',merge_commit_sha:MERGE},
  runs:workflowRuns,deploys:[preview],comparison:null,attestation,prod,
});
assert.equal(merged.certified,true,'A merged PR must retain its historical certification.');
assert.equal(merged.deployStatus,'live');
assert.equal(dashboardTotals([ready,failed,merged]).blocked,1);

const api=await readFile(new URL('../netlify/functions/admin-release-dashboard.mts',import.meta.url),'utf8');
const html=await readFile(new URL('../src/pages/admin/releases/index.astro',import.meta.url),'utf8');
const nav=await readFile(new URL('../src/components/StaffUtilityNav.astro',import.meta.url),'utf8');
const admin=await readFile(new URL('../netlify/functions/_shared/admin.ts',import.meta.url),'utf8');
const home=await readFile(new URL('../src/pages/admin/index.astro',import.meta.url),'utf8');
const health=await readFile(new URL('../src/pages/admin/health/index.astro',import.meta.url),'utf8');
for(const [ok,label] of [
  [api.includes("requireCapability('health.view',req,context)"),'API must enforce authenticated health.view'],
  [api.includes('legacyDataBelongsToTenant'),'API must enforce Koa tenant isolation'],
  [api.includes("runWithTenant(auth.tenant"),'API must preserve tenant context on health reads'],
  [api.includes("config:Config={path:'/api/admin/release-dashboard'}"),'API route must be registered'],
  [api.includes('releaseRow({pr,runs,deploys,comparison,attestation,prod:production,certError})'),'API must pass exact-head GitHub evidence'],
  [api.includes("headers={'Cache-Control':'private, no-store'"),'API must disable shared cache'],
  [html.includes("getAdminSession"),'Dashboard must check current session'],
  [html.includes("row.qa"),'Dashboard must expose browser evidence'],
  [html.includes('data-release-search')&&html.includes('data-prev-page'),'Dashboard must have search and pagination'],
  [html.includes("q('[data-release-dashboard]')"),'Dashboard must use scoped DOM hooks'],
  [nav.includes('href="/admin/releases/"'),'Workspace navbar must link dashboard'],
  [home.includes("data-module-id=\"release-command-center\""),'Admin home must surface dashboard'],
  [admin.includes("'/admin/releases/': 'health.view'"),'Access map must protect dashboard'],
  [health.includes('href="/admin/releases/"'),'System Health must link executive release view'],
])assert(ok,label);
assert(!api.includes('Access-Control-Allow-Origin'),'Protected API must not enable public CORS.');
console.log('PASS | release dashboard parser, stale/failure cases, tenant/auth guards, production sync, current/main and all admin navigation.');
