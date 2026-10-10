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

assert(evaluateProductionReleaseGate({
  ...base,
  netlify:{...base.netlify,liveCommit:''},
}).ok===false,'Missing live commit evidence could publish a green production gate.');


for(const state of ['building','enqueued','new','error','failed','cancelled','']){
  assert(isSuccessfulNetlifyState(state)===false,'Non-ready Netlify state '+JSON.stringify(state)+' was accepted.');
}
for(const state of ['ready','current']){
  assert(isSuccessfulNetlifyState(state)===true,'Successful Netlify state '+state+' was rejected.');
}

const workflow=readFileSync('.github/workflows/production-visual-qa.yml','utf8');
const server=readFileSync('netlify/functions/github-main-health-signal.ts','utf8');
const healthShared=readFileSync('netlify/functions/_shared/system-health.ts','utf8');
const healthPage=readFileSync('src/pages/admin/health/index.astro','utf8');
const gateContextOccurrences=(workflow.match(/System Health production release gate/g)||[]).length;
assert(gateContextOccurrences===3,
  'Production release gate context must appear only in initial pending, final attestation, and release-history failure override publishers; found '+gateContextOccurrences+'.');
assert(workflow.includes("import { evaluateProductionReleaseGate } from './netlify/functions/_shared/production-release-policy.mjs';"),
  'Final workflow status does not use the tested shared release policy.');
assert(workflow.includes("'context':'System Health responsive audit'"),
  'Mobile System Health status is not isolated from the final production release gate.');
assert(server.includes('isSuccessfulNetlifyState(existingState)'),
  'Production self-heal does not use the tested successful-deploy-state policy.');
assert(server.includes('productionDeployMatchesAttestation({'),
  'Production Netlify attestation does not use the tested exact deploy policy.');
assert(server.includes("netlifyJson(token,'/deploys/'+encodeURIComponent(liveDeployId))")
    && server.includes("liveCommitSource='netlify-live-deploy'"),
  'API-triggered production deploys must recover live commit provenance from the exact serving Netlify deploy record.');
assert(workflow.includes('Persist certified release attestation history')
    && workflow.includes('record-production-release-attestation'),
  'A green release must persist its certified attestation and fail closed if persistence fails.');
assert(server.includes("body?.action==='record-production-release-attestation'"),
  'The OIDC control plane must expose exact-release attestation persistence.');
assert(healthShared.includes('releaseAttestation?:ProductionReleaseAttestation|null')
    && healthShared.includes('6aca20d60f83c2e4cae6c338')
    && healthShared.includes('b5830d422c36a2c9c2869e228f5fa470ea650337'),
  'Certified PR #260 production evidence must be backfilled into permanent release history.');
assert(healthPage.includes('Release certification')
    && healthPage.includes("certificationLabel=certified?'Certified':'Not certified'")
    && healthPage.includes('attestation.matchingDeployId===true'),
  'The Site Quality release timeline must visibly render certified production attestation history.');

console.log('PASS | production release gate rejects errored deploys, cancelled visual QA, unhealthy System Health, missing live commit evidence, mismatched deploy IDs, and non-durable certification; API builds recover exact live deploy provenance.');
