import assert from 'node:assert/strict';
import { planExactProductionRecovery as plan } from './production_deploy_recovery_policy.mjs';
const sha='a'.repeat(40);
const deploy=(state,id='d',commit_ref=sha,context='production')=>({state,id,commit_ref,context});
const check=(deploys)=>plan({expectedSha:sha,deploys});
assert.equal(check([]).action,'trigger','missing exact SHA can retrigger');
assert.equal(check([deploy('error')]).action,'trigger','single errored deploy retries once');
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
console.log('PASS | safe exact-SHA production recovery: active/ready/failed/unknown/stale/preview and bounded retry.');
