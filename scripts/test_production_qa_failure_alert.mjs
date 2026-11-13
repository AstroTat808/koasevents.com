import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { validProductionQaFailureRun,failedProductionQaJobs } from '../netlify/functions/_shared/production-qa-failure-policy.mjs';
const SHA='55f85b4c32cfad432c4fb82ef0d7dfa5ec330996';
const run={id:43413513078,head_sha:SHA,head_branch:'main',path:'.github/workflows/production-visual-qa.yml',status:'completed',conclusion:'failure',event:'push'};
const jobs=[{name:'Responsive visual audit',status:'completed',conclusion:'failure'},{name:'Visual QA summary',status:'completed',conclusion:'success'}];
assert.equal(validProductionQaFailureRun(run,String(run.id),SHA),true);
assert.deepEqual(failedProductionQaJobs(run,jobs),[{name:'Responsive visual audit',conclusion:'failure'}]);
for(const bad of [
 {...run,head_sha:'a'.repeat(40)},
 {...run,head_branch:'feature'},
 {...run,status:'in_progress'},
 {...run,conclusion:'cancelled'},
 {...run,path:'.github/workflows/other.yml'},
 {...run,event:'pull_request'},
]){
 assert.equal(validProductionQaFailureRun(bad,String(run.id),SHA),false);
}
const custom={...run,event:'workflow_dispatch'};
assert.deepEqual(failedProductionQaJobs(custom,jobs),[],'Unverified dispatch must not alert');
assert.equal(failedProductionQaJobs(custom,[...jobs,{name:'Final production release attestation',status:'completed',conclusion:'failure'}]).length,2);
const handler=readFileSync('netlify/functions/_shared/production-qa-failure-alert.mts','utf8');
const entry=readFileSync('netlify/functions/github-main-health-signal.ts','utf8');
const workflow=readFileSync('.github/workflows/notify-production-qa-failures.yml','utf8');
assert.match(entry,/notify-production-qa-failure/);
assert.match(handler,/claims\?\.event_name/);
assert.match(handler,/KOA_GITHUB_READ_TOKEN/);
assert.match(handler,/Idempotency-Key/);
assert.match(workflow,/workflow_run:/);
assert.match(workflow,/id-token: write/);
assert.ok(!workflow.includes('secrets.RESEND_API_KEY'));
console.log('Fail-only, exact-main OIDC QA notifier contract: PASS');
