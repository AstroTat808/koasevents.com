import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  evaluateProductionReleaseGate,
  isSuccessfulNetlifyState,
  productionDeployMatchesAttestation,
  productionReleaseRunOrder,
  previousResponsiveForSameRun,
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
assert(gateContextOccurrences===6
  &&workflow.includes('Verify actual certified PDF and JSON serializer bytes')
  &&workflow.includes('fail_export_proof()')
  &&workflow.includes('node scripts/verify_live_certified_export_bytes.mjs')
  &&workflow.includes('Certified PDF/JSON byte-level security evidence verification failed.'),
  'Production release gate must have exactly six authorized publishers: initial pending, pre-attestation decision, history failure override, PDF/JSON byte-proof failure override, finalization failure override, and final certified success; found '+gateContextOccurrences+'.');
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

const persistStep=workflow.indexOf('      - name: Persist certified release attestation history');
const shellStart=workflow.indexOf('        run: |\n',persistStep);
const shellEnd=workflow.indexOf('\n      - name: Verify actual certified PDF and JSON serializer bytes',shellStart);
assert(persistStep>=0&&shellStart>persistStep&&shellEnd>shellStart,
  'Release history persistence shell step was not found.');
const rawShell=workflow.slice(shellStart+'        run: |\n'.length,shellEnd);
const persistShell=rawShell.split('\n').map(line=>line.startsWith('          ')?line.slice(10):line).join('\n');
const bashSyntax=spawnSync('bash',['-n'],{input:persistShell,encoding:'utf8'});
assert(bashSyntax.status===0,
  'Release history persistence shell must pass bash -n: '+String(bashSyntax.stderr||'').slice(0,350));
assert(persistShell.includes('trap fail_history ERR')
    && persistShell.includes('record-production-release-attestation')
    && persistShell.includes('koa-release-history-failure-status.json'),
  'Release-history persistence must preserve fail-closed status publication and durable recorder enforcement.');
const bytesStep=workflow.indexOf('      - name: Verify actual certified PDF and JSON serializer bytes',shellEnd);
const bytesShellStart=workflow.indexOf('        run: |\n',bytesStep);
const bytesShellEnd=workflow.indexOf('\n      - name: Publish certified production gate after durable attestation and export bytes',bytesShellStart);
assert(bytesStep>shellEnd&&bytesShellStart>bytesStep&&bytesShellEnd>bytesShellStart,
  'Certified PDF/JSON byte-proof shell step was not found.');
const bytesShell=workflow.slice(bytesShellStart+'        run: |\n'.length,bytesShellEnd)
  .split('\n').map(line=>line.startsWith('          ')?line.slice(10):line).join('\n');
const bytesSyntax=spawnSync('bash',['-n'],{input:bytesShell,encoding:'utf8'});
assert(bytesSyntax.status===0,
  'Certified export-byte fail-closed shell must pass bash -n: '+String(bytesSyntax.stderr||'').slice(0,350));
assert(bytesShell.includes('trap fail_export_proof ERR')
  &&bytesShell.includes('node scripts/verify_live_certified_export_bytes.mjs'),
  'PDF/JSON byte-proof failure must immediately block production release certification.');
const finalStep=workflow.indexOf('      - name: Publish certified production gate after durable attestation and export bytes');
const finalShellStart=workflow.indexOf('        run: |\n',finalStep);
const finalShellEnd=workflow.indexOf('\n  qa-summary:',finalShellStart);
assert(finalStep>bytesStep&&finalShellStart>finalStep&&finalShellEnd>finalShellStart,
  'Final success must be published only after certified release history and PDF/JSON bytes.');
const finalShell=workflow.slice(finalShellStart+'        run: |\n'.length,finalShellEnd)
  .split('\n').map(line=>line.startsWith('          ')?line.slice(10):line).join('\n');
const finalSyntax=spawnSync('bash',['-n'],{input:finalShell,encoding:'utf8'});
assert(finalSyntax.status===0,
  'Final signed release success shell must pass bash -n: '+String(finalSyntax.stderr||'').slice(0,350));
assert(finalShell.includes('trap fail_closed ERR')
    &&finalShell.includes('koa-final-gate-failure-status.json')
    &&finalShell.includes('koa-final-gate-success-status.json')
    &&finalShell.includes('/branches/main')
    &&finalShell.includes('verify-production-release-attestation')
    &&finalShell.includes("live.get('deployId')==live.get('liveDeployId')"),
  'Final status publishing must fail closed and revalidate current GitHub main and exact live Netlify deploy.');
assert(workflow.includes("state:decision.ok?'pending':'failure'")
  &&workflow.includes("process.exit(x.decision.ok?0:1)"),
  'Successful preliminary release checks must remain pending until durable evidence passes.');
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

// A replay of an older push attempt must never inherit a newer scheduled
// audit's browser evidence, even when commit and deployed Netlify ID match.
const olderRun='41683703455';
const newerRun='43108656869';
assert(productionReleaseRunOrder(newerRun,olderRun)===1,
  'A valid newer GitHub run should be accepted.');
assert(productionReleaseRunOrder(newerRun,newerRun)===0,
  'A second browser in the same run should be accepted.');
assert(productionReleaseRunOrder(olderRun,newerRun)===-1,
  'An older re-run must not overwrite more recent audit evidence.');
assert(productionReleaseRunOrder(olderRun,'')===1,
  'The first valid run should not require pre-existing evidence.');
for(const bad of ['', '1', '-1', 'not-an-id', '041683703455', '123.5']){
  assert(productionReleaseRunOrder(bad,newerRun)===null,
    'Malformed signed run ID must fail closed: '+JSON.stringify(bad));
}
assert(productionReleaseRunOrder(newerRun,'bad-previous-run')===null,
  'Malformed durable run IDs must not be silently ignored.');
assert(productionReleaseRunOrder('99999999999999999999',newerRun)===1,
  'Full-width GitHub run IDs must be compared without floating-point loss.');
const oldResponsive={runId:olderRun,chromium:{browser:'chromium'},webkit:{browser:'webkit'}};
assert(previousResponsiveForSameRun(oldResponsive,newerRun)===null,
  'A new production run must start without browser reports inherited from an old run.');
assert(previousResponsiveForSameRun(oldResponsive,olderRun)===oldResponsive,
  'Both browser reports from the same valid run must be reusable during aggregation.');

const durableStore=readFileSync('netlify/functions/_shared/system-health.ts','utf8');
assert(durableStore.includes("if(runOrder===null||runOrder<0)throw new Error('STALE_RESPONSIVE_RUN_ID')"),
  'A stale responsive run must be rejected before writing Release History.');
assert(durableStore.includes("const sameRun=previous?.commit===commit&&previous?.deployId===deployId")
    &&durableStore.includes("previousResponsiveForSameRun(previous,runId)")
    &&durableStore.includes("sameRun?.chromium||null")
    &&durableStore.includes("sameRun?.webkit||null"),
  'A new run must not silently inherit an old Chromium or WebKit result.');
assert(durableStore.includes("if(order===null||order<0)throw new Error('STALE_RELEASE_EVIDENCE_RUN_ID')"),
  'Stale visual, responsive, protected-admin and attestation records must fail closed.');
console.log('PASS | stale run IDs rejected; newer runs and same-run browser evidence accepted.');

console.log('PASS | production release gate rejects errored deploys, cancelled visual QA, unhealthy System Health, missing live commit evidence, mismatched deploy IDs, and non-durable certification; API builds recover exact live deploy provenance.');
