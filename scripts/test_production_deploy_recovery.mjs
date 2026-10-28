import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getCompleteProductionDeployHistory, planExactProductionRecovery as plan } from './production_deploy_recovery_policy.mjs';
const sha='a'.repeat(40);
const deploy=(state,id='d',commit_ref=sha,context='production',error_message='')=>({state,id,commit_ref,context,error_message});
const check=(deploys)=>plan({expectedSha:sha,deploys});
assert.equal(check([]).action,'trigger','missing exact SHA can retrigger');
assert.equal(check([deploy('error')]).action,'trigger','single errored deploy retries once');
assert.equal(
  check([deploy('error','credits',sha,'production','Skipped due to account credit usage exceeded')]).action,
  'manual-deploy',
  'credit exhaustion switches to externally built manual deploy',
);
assert.equal(
  check([
    deploy('error','credits',sha,'production','Skipped due to account credit usage exceeded'),
    deploy('building','replacement'),
  ]).action,
  'manual-deploy',
  'credit exhaustion takes precedence over a hosted replacement build that cannot consume unavailable credits',
);
assert.equal(
  check([
    deploy('error','credits',sha,'production','Skipped due to account credit usage exceeded'),
    deploy('ready','ready'),
  ]).action,
  'wait',
  'a successful exact deploy always takes precedence over credit fallback',
);
assert.equal(check([deploy('error','one'),deploy('error','two')]).action,'block','second failure stops');
assert.equal(check([deploy('ready')]).action,'wait','ready build not replaced');
assert.equal(check([deploy('current')]).action,'wait','published build not replaced');
for(const active of ['new','pending','queued','enqueued','building','preparing','processing','uploaded']){
  assert.equal(check([deploy(active)]).action,'wait',active+' is already active');
}
assert.equal(check([deploy('error'),deploy('building','active')]).action,'wait','active build takes precedence');
assert.equal(check([deploy('error'),deploy('ready','ready')]).action,'wait','successful build takes precedence');
assert.equal(check([deploy('unknown')]).action,'block','unknown state fails closed');
assert.equal(check([deploy('error','wrong', 'b'.repeat(40))]).action,'trigger','other commits do not count');
assert.equal(check([deploy('ready','preview',sha,'deploy-preview')]).action,'trigger','deploy preview cannot certify production');
assert.equal(plan({expectedSha:'bad',deploys:[]}).action,'block','invalid SHA rejected');
assert.equal(plan({expectedSha:sha,deploys:null}).action,'block','missing Netlify evidence fails closed');
assert.equal(check(Array.from({length:100},(_,i)=>deploy('error',String(i),'b'.repeat(40)))).action,'block','truncated deploy history fails closed');

assert.equal(
  plan({expectedSha:sha,deploys:Array.from({length:100},(_,i)=>deploy('error',String(i),'b'.repeat(40))),historyComplete:true}).action,
  'trigger',
  'complete, paginated production history may safely report a missing exact SHA',
);
const unrelated=Array.from({length:100},(_,i)=>deploy('ready','other-'+i,'b'.repeat(40)));
const urls=[];
const pageResults=[unrelated,[deploy('error','credit-failed',sha,'production','Skipped due to account credit usage exceeded')]];
const complete=await getCompleteProductionDeployHistory({
  siteId:'koa-site',token:'test-token',
  getJson:async (url,token)=>{
    assert.equal(token,'test-token');
    const request=new URL(url);
    assert.equal(request.pathname,'/api/v1/sites/koa-site/deploys');
    assert.equal(request.searchParams.get('production'),'true','only production deploys may be counted');
    assert.equal(request.searchParams.get('per_page'),'100','Netlify limits each page to 100');
    urls.push(request.href);
    return pageResults[Number(request.searchParams.get('page'))-1] ?? [];
  },
});
assert.equal(urls.length,2,'scan continues after exactly 100 production deploys');
assert.equal(complete.length,101,'all pages are retained for exact-SHA policy');
assert.equal(plan({expectedSha:sha,deploys:complete,historyComplete:true}).action,'manual-deploy',
  'an exact credit failure on a later page still invokes the external CI fallback');
const missing=await getCompleteProductionDeployHistory({
  siteId:'koa-site',token:'test-token',
  getJson:async url=>Number(new URL(url).searchParams.get('page'))===1?unrelated:[],
});
assert.equal(missing.length,100,'an empty next page proves that the first full page is complete');
assert.equal(plan({expectedSha:sha,deploys:missing,historyComplete:true}).action,'trigger',
  'missing exact SHA after complete pagination can request one replacement build');
await assert.rejects(
  getCompleteProductionDeployHistory({
    siteId:'koa-site',token:'test-token',maxPages:2,getJson:async ()=>unrelated,
  }),
  /page limit reached/,
  'bounded pagination must not trigger a release if history cannot be fully inspected',
);
await assert.rejects(
  getCompleteProductionDeployHistory({
    siteId:'koa-site',token:'test-token',getJson:async ()=>({unexpected:'response'}),
  }),
  /malformed/,
  'malformed Netlify API responses must fail closed',
);
await assert.rejects(
  getCompleteProductionDeployHistory({
    siteId:'koa-site',token:'test-token',getJson:async ()=>Array.from({length:101},()=>deploy('error')),
  }),
  /malformed/,
  'oversized Netlify API responses must fail closed',
);
await assert.rejects(
  getCompleteProductionDeployHistory({
    siteId:'koa-site',token:'test-token',getJson:async ()=>{throw new Error('Netlify request failure');},
  }),
  /Netlify request failure/,
  'API failures must not result in guessed deployment state',
);

const recoverySource=readFileSync('scripts/production_deploy_recovery.mjs','utf8');
const visualWorkflow=readFileSync('.github/workflows/production-visual-qa.yml','utf8');
assert(
  recoverySource.includes('getCompleteProductionDeployHistory({siteId,token:netlifyToken,getJson})')
    && recoverySource.includes('historyComplete:true')
    && recoverySource.includes("netlify-cli@27.14.2")
    && recoverySource.includes("'--prod'")
    && recoverySource.includes("'--context','production'")
    && recoverySource.includes("GITHUB_RELEASE_GATE_TOKEN:githubToken")
    && recoverySource.includes("external-CI deploy completed without a ready exact-SHA Netlify production record."),
  'Credit-exhaustion recovery must build in authenticated GitHub Actions, preserve the release gate, deploy to production, and verify an exact ready SHA.',
);
assert(
  visualWorkflow.includes('timeout-minutes: 40')
    && visualWorkflow.includes("node-version: '22.13.0'")
    && visualWorkflow.includes('node scripts/production_deploy_recovery.mjs'),
  'Production deploy smoke must provide a supported Node runtime and enough time for exact-SHA external-CI recovery.',
);
console.log('PASS | safe exact-SHA production recovery: active/ready/failed/credit-exhaustion/manual-CI/unknown/stale/preview, complete production pagination and bounded retry.');
