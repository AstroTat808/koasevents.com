import { readFileSync } from 'node:fs';
import {
  evaluateProductionReleaseGate,
  isSuccessfulNetlifyState,
  productionDeployMatchesAttestation,
} from '../netlify/functions/_shared/production-release-policy.mjs';

function assert(condition,message){
  if(!condition)throw new Error(message);
}

const sha='a'.repeat(40);
const deployId='0123456789abcdef01234567';
const base={
  expectedSha:sha,
  workflowResults:{
    pending:'success',
    source:'success',
    smoke:'success',
    theme:'success',
    admin:'success',
    mobile:'success',
    visual:'success',
  },
  netlify:{
    deployId,
    deployState:'ready',
    deployContext:'production',
    deployCommit:sha,
    publishedAt:'2026-10-10T06:30:00Z',
    liveCommit:sha,
    liveDeployId:deployId,
  },
  health:{
    ok:true,
    sha,
    overall:'healthy',
    passed:81,
    failed:0,
    checkedAt:'2026-10-10T06:31:00Z',
  },
};

assert(evaluateProductionReleaseGate(base).ok===true,'Known-good release did not pass.');

assert(isSuccessfulNetlifyState('error')===false,'Errored Netlify deploy was treated as successful.');
assert(productionDeployMatchesAttestation({...base.netlify,expectedSha:sha,deployState:'error'})===false,
  'Errored exact-SHA Netlify deploy passed production attestation.');
assert(evaluateProductionReleaseGate({...base,netlify:{...base.netlify,deployState:'error'}}).ok===false,
  'Errored exact-SHA Netlify deploy could publish a green production gate.');

assert(evaluateProductionReleaseGate({
  ...base,
  workflowResults:{...base.workflowResults,visual:'cancelled'},
}).ok===false,'Cancelled Production Visual QA could publish a green production gate.');

assert(evaluateProductionReleaseGate({
  ...base,
  health:{...base.health,overall:'unhealthy',failed:2},
}).ok===false,'Unhealthy System Health snapshot could publish a green production gate.');

assert(evaluateProductionReleaseGate({
  ...base,
  netlify:{...base.netlify,liveDeployId:'fedcba9876543210fedcba98'},
}).ok===false,'Mismatched live Netlify deploy ID could publish a green production gate.');

for(const state of ['building','enqueued','new','error','failed','cancelled','']){
  assert(isSuccessfulNetlifyState(state)===false,'Non-ready Netlify state '+JSON.stringify(state)+' was accepted.');
}
for(const state of ['ready','current']){
  assert(isSuccessfulNetlifyState(state)===true,'Successful Netlify state '+state+' was rejected.');
}

const workflow=readFileSync('.github/workflows/production-visual-qa.yml','utf8');
const server=readFileSync('netlify/functions/github-main-health-signal.ts','utf8');
const gateContextOccurrences=(workflow.match(/System Health production release gate/g)||[]).length;
assert(gateContextOccurrences===2,
  'Production release gate context must appear only in initial pending and final attestation publishers; found '+gateContextOccurrences+'.');
assert(workflow.includes("import { evaluateProductionReleaseGate } from './netlify/functions/_shared/production-release-policy.mjs';"),
  'Final workflow status does not use the tested shared release policy.');
assert(workflow.includes("'context':'System Health responsive audit'"),
  'Mobile System Health status is not isolated from the final production release gate.');
assert(server.includes('planProductionDeployRecovery(deploys)'),
  'Production self-heal does not use the bounded recovery policy.');
assert(server.includes('isSuccessfulNetlifyState(aState)'),
  'Production exact-SHA attestation no longer recognizes successful Netlify states.');
assert(server.includes('productionDeployMatchesAttestation({'),
  'Production Netlify attestation does not use the tested exact deploy policy.');

assert(!workflow.includes('cat visual-results/system-health-dashboard.json'),
  'Production Visual QA must not dump raw signed System Health payloads.');
assert(!workflow.includes('cat /tmp/koa-final-health.json'),
  'Production Visual QA must not dump raw final System Health payloads.');
assert(!workflow.includes('cat visual-results/accounting-adjustment-diagnostics.json'),
  'Production Visual QA must not dump raw accounting diagnostics.');
assert(!workflow.includes('cat visual-results/accounting-repair-bulk-preview.json'),
  'Production Visual QA must not dump raw repair previews.');
assert(workflow.includes('visual-results/production-release-evidence.json'),
  'Production QA redacted release evidence is missing from artifact upload.');

console.log('PASS | production release gate rejects errored deploys, cancelled visual QA, unhealthy System Health, and mismatched deploy IDs.');
