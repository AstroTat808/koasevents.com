#!/usr/bin/env node
import assert from 'node:assert/strict';
import {verifyCurrentCertifiedProduction} from '../netlify/functions/_shared/current-certified-release.mjs';

const commit='a'.repeat(40),deployId='b'.repeat(24),siteId='koa-site-1';
const site={id:siteId,published_deploy:{id:deployId}};
const deployment={id:deployId,site_id:siteId,context:'production',state:'ready',
  commit_ref:commit,published_at:'2026-11-11T21:00:00.000Z'};
const branch={name:'main',commit:{sha:commit}};
function provider({siteRecord=site,deployRecord=deployment,branchRecord=branch,status=200}={}){
  return async url=>{
    const payload=url.includes('/sites/')?siteRecord
      :url.includes('/deploys/')?deployRecord:branchRecord;
    return {ok:status===200,status,async json(){return payload;}};
  };
}
const options={fetchImpl:provider(),netlifyToken:'dummy-test-token',
  githubToken:'dummy-test-github',siteId,servingDeployId:deployId,
  expectedCommit:commit,expectedDeployId:deployId};
const ok=await verifyCurrentCertifiedProduction(options);
assert.equal(ok.commit,commit);
assert.equal(ok.deployId,deployId);
assert.equal(ok.mainCommit,commit);
for(const wrong of [
 {fetchImpl:provider({siteRecord:{...site,published_deploy:{id:'c'.repeat(24)}}})},
 {fetchImpl:provider({deployRecord:{...deployment,context:'deploy-preview'}})},
 {fetchImpl:provider({deployRecord:{...deployment,state:'building'}})},
 {fetchImpl:provider({deployRecord:{...deployment,commit_ref:'f'.repeat(40)}})},
 {fetchImpl:provider({branchRecord:{...branch,commit:{sha:'f'.repeat(40)}}})},
 {expectedCommit:'f'.repeat(40)},
 {servingDeployId:'c'.repeat(24)},
 {runtimeCommit:'f'.repeat(40)},
]){
  await assert.rejects(verifyCurrentCertifiedProduction({...options,...wrong}),
    /CURRENT_RELEASE_STALE_DEPLOYMENT/);
}
await assert.rejects(verifyCurrentCertifiedProduction({...options,netlifyToken:''}),
  /CURRENT_RELEASE_IDENTITY_UNAVAILABLE/);
await assert.rejects(verifyCurrentCertifiedProduction({...options,fetchImpl:provider({status:503})}),
  /CURRENT_RELEASE_PROVIDER_UNAVAILABLE/);
await assert.rejects(verifyCurrentCertifiedProduction({...options,fetchImpl:async()=>{throw Error('timeout')}}),
  /CURRENT_RELEASE_PROVIDER_UNAVAILABLE/);
console.log('PASS | live certification requires exact current GitHub main and published Netlify production ID, commit, state and provider identity.');
