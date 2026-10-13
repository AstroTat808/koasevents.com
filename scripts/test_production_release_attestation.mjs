import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateAccordionReleaseEvidence, ACCORDION_EVIDENCE_CASES } from '../netlify/functions/_shared/accordion-release-evidence.mjs';
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
    && healthPage.includes('attestation?.matchingDeployId===true'),
  'The Site Quality release timeline must visibly render certified production attestation history.');
assert(healthPage.includes("overview.dataset.releaseVerificationOverview=''")
    && healthPage.includes('data-release-verification-fields')
    && healthPage.includes('data-release-browser-results')
    && healthPage.includes('card.dataset.releaseBrowser=name')
    && healthPage.includes('exactCertification')
    && healthPage.includes('exactVisual')
    && healthPage.includes('exactAccordion')
    && healthPage.includes("certification?.liveDeployId||'Not recorded'"),
  'One Release History dialog must distinguish exact certified Netlify IDs, browser results, and four accordion screenshots without inventing missing evidence.');


const accordionImage=Buffer.concat([Buffer.from([255,216,255]),Buffer.alloc(1300,3)]);
const accordionBase64=accordionImage.toString('base64');
const accordionDigest=createHash('sha256').update(accordionImage).digest('hex');
const interactions={
  initialClosed:true,criticalInitiallyOpen:true,manuallyOpened:true,
  manuallyClosed:true,criticalForcedOpen:true,recoveredCollapsed:true,
};
const expectedAccordion={
  source:'synthetic-health-qa',commit:sha,deployId,runId:'98765',
  results:ACCORDION_EVIDENCE_CASES.map((item)=>({
    ...item,route:'/admin/health/',synthetic:true,status:'passed',
    results:{...interactions},sha256:accordionDigest,dataBase64:accordionBase64,
  })),
};
const validated=validateAccordionReleaseEvidence(expectedAccordion,{commit:sha,deployId,runId:'98765'});
assert(validated.results.length===4&&validated.status==='passed',
  'Four synthetic Chromium/WebKit phone/desktop screenshots must validate.');
for(const invalid of [
  {...expectedAccordion,commit:'b'.repeat(40)},
  {...expectedAccordion,results:expectedAccordion.results.slice(1)},
  {...expectedAccordion,results:expectedAccordion.results.map((r)=>({...r,key:'chromium-phone'}))},
  {...expectedAccordion,results:expectedAccordion.results.map((r)=>({...r,synthetic:false}))},
  {...expectedAccordion,results:expectedAccordion.results.map((r)=>({...r,results:{...r.results,criticalForcedOpen:false}}))},
  {...expectedAccordion,results:expectedAccordion.results.map((r)=>({...r,dataBase64:'bad-image'}))},
]) {
  let rejected=false;
  try{validateAccordionReleaseEvidence(invalid,{commit:sha,deployId,runId:'98765'});}
  catch{rejected=true;}
  assert(rejected,'Incomplete, mismatched, non-synthetic or failed accordion evidence was accepted.');
}
const accordionPrep=readFileSync('scripts/prepare_accordion_release_evidence.py','utf8');
const healthApi=readFileSync('netlify/functions/admin-health.mts','utf8');
const qaScript=readFileSync('scripts/production_visual_qa.py','utf8');
assert(workflow.includes('Download exact-run synthetic System Health browser evidence')
    &&workflow.includes('actions/download-artifact@v4')
    &&workflow.includes('name: koa-accordion-synthetic-')
    &&!workflow.includes('name: koa-system-health-mobile-')
    &&workflow.includes('python scripts/prepare_accordion_release_evidence.py --collect')
    &&workflow.includes('python scripts/prepare_accordion_release_evidence.py')
    &&workflow.includes('payload["accordionEvidence"]')
    &&workflow.includes('assert len(accordion.get("results") or [])==4'),
  'Production final attestation must refuse missing exact-run accordion screenshots.');
assert(accordionPrep.includes('accordion-synthetic')
    &&accordionPrep.includes('staged_names')
    &&accordionPrep.includes('no raw health snapshot staged')
    &&accordionPrep.includes('sectionCollapse')
    &&accordionPrep.includes('hashlib.sha256')
    &&qaScript.includes('accordion-{viewport_name}.jpg')
    &&qaScript.includes('SYNTHETIC SYSTEM HEALTH QA'),
  'Release screenshots must originate from explicitly marked synthetic browser fixtures.');
assert(server.includes('persistAccordionReleaseEvidence')
    &&server.includes('validateAccordionReleaseEvidence')
    &&server.includes("crypto.subtle.digest('SHA-256',bytes)")
    &&healthShared.includes('readAccordionReleaseScreenshot')
    &&healthApi.includes("requestUrl.searchParams.get('action')==='accordion-qa-screenshot'")
    &&healthPage.includes('data-accordion-release-results'),
  'Durable screenshots must be checksum-verified, access-controlled and visible in release history.');

console.log('PASS | production release gate rejects errored deploys, cancelled visual QA, unhealthy System Health, missing live commit evidence, mismatched deploy IDs, and non-durable certification; API builds recover exact live deploy provenance.');
