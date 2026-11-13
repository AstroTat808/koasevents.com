import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {eligibleProductionDeploy,sanitizedDeployFailure} from '../netlify/functions/_shared/production-certification-trigger.mjs';
const commit='55f85b4c32cfad432c4fb82ef0d7dfa5ec330996';
const id='6af52f91a212fad7910d6c30';
assert.equal(eligibleProductionDeploy({context:'production',deployId:id,commitRef:commit,mainSha:commit}),true);
for(const row of [
 {context:'deploy-preview',deployId:id,commitRef:commit,mainSha:commit},
 {context:'production',deployId:id,commitRef:commit,mainSha:'a'.repeat(40)},
 {context:'production',deployId:id,commitRef:'a',mainSha:'a'},
 {context:'production',deployId:'not-valid#',commitRef:commit,mainSha:commit},
]){
 assert.equal(eligibleProductionDeploy(row),false);
}
assert.equal(sanitizedDeployFailure({context:'deploy-preview',deployId:id,commitRef:commit}),null);
const alert=sanitizedDeployFailure({context:'production',deployId:id,commitRef:commit,at:'2026-11-13T18:00:00Z'});
assert.equal(alert.commit,commit);
assert.equal(alert.deployId,id);
assert.ok(!Object.keys(alert).some(key=>/ip|token|cookie|customer|payment|errorMessage/i.test(key)));
const handler=readFileSync('netlify/functions/production-certification-trigger.mts','utf8');
assert.match(handler,/KOA_GITHUB_ACTIONS_TOKEN/);
assert.match(handler,/if\(!token\)/);
assert.match(handler,/eligibleProductionDeploy/);
assert.match(handler,/Idempotency-Key/);
assert.match(handler,/deploySucceeded/);
assert.match(handler,/deployFailed/);
console.log('Exact-main post-deploy certification and failure alert guard: PASS');
