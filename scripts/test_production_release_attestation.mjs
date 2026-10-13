import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { evaluateReleaseHistoryPersistence, RELEASE_HISTORY_CONTEXT } from '../netlify/functions/_shared/release-history-integrity.mjs';
import { persistenceStatusForOutcome } from './publish_release_history_status.mjs';
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

function extractReleaseHistoryShell(text){
  // Extract only this literal run scalar, never a following YAML step or job.
  // Preserve relative shell indentation so bash -n still detects bad heredocs.
  const lines=text.split(/\r?\n/);
  const marker='      - name: Persist certified release attestation history';
  const starts=lines.flatMap((line,index)=>line===marker?[index]:[]);
  assert(starts.length===1,'Exactly one release history persistence step is required.');
  let runLine=-1;
  for(let index=starts[0]+1;index<lines.length;index++){
    const line=lines[index];
    if(line.trim()&&!line.startsWith('        '))break;
    if(/^        run: \|[-+]?\s*$/.test(line)){runLine=index;break;}
  }
  assert(runLine>=0,'Release history persistence must contain a literal shell block.');
  const body=[];
  for(let index=runLine+1;index<lines.length;index++){
    const line=lines[index];
    if(line.trim()&&!line.startsWith('          '))break;
    body.push(line.startsWith('          ')?line.slice(10):'');
  }
  assert(body.some(line=>line.trim()),'Release history persistence shell must not be empty.');
  return body.join('\n').trimEnd()+'\n';
}

const shellFixture=[
  '      - name: Persist certified release attestation history',
  '        id: persist-history',
  '        if: success()',
  '        run: |',
  '          set -euo pipefail',
  "          python - <<'PY'",
  "          print('synthetic')",
  '          PY',
].join('\n');
const expectedFixtureShell="set -euo pipefail\npython - <<'PY'\nprint('synthetic')\nPY\n";
for(const suffix of [
  '\n      - name: Publish independent release-history persistence status\n        if: always()\n        run: node scripts/publish_release_history_status.mjs',
  '\n      - uses: actions/upload-artifact@v4\n        if: always()',
  '\n  qa-summary:\n    if: always()',
  '',
]){
  const extracted=extractReleaseHistoryShell(shellFixture+suffix);
  assert(extracted===expectedFixtureShell,
    'Shell extraction included adjacent YAML or lost persistence shell content.');
  assert(spawnSync('bash',['-n'],{input:extracted,encoding:'utf8',timeout:10000}).status===0,
    'A valid persistence shell fixture failed syntax validation.');
}
assert(extractReleaseHistoryShell(shellFixture.replaceAll('\n','\r\n'))===expectedFixtureShell,
  'Shell extraction must support CRLF without changing relative indentation.');
for(const invalidFixture of [
  shellFixture.replace('        run: |','        run: echo wrong'),
  shellFixture+'\n'+shellFixture,
  '      - name: Persist certified release attestation history\n        run: |\n',
]){
  let rejected=false;
  try{extractReleaseHistoryShell(invalidFixture);}catch{rejected=true;}
  assert(rejected,'Ambiguous, empty, or nonliteral persistence shell was accepted.');
}
const invalidHeredoc=[
  '      - name: Persist certified release attestation history',
  '        run: |',
  '          fail_history() {',
  "          python - <<'PY'",
  "          print('synthetic')",
  '            PY',
  '          }',
].join('\n');
assert(spawnSync('bash',['-n'],{
  input:extractReleaseHistoryShell(invalidHeredoc),encoding:'utf8',timeout:10000,
}).status!==0,'The historical indented-heredoc defect must still fail bash -n.');

const persistShell=extractReleaseHistoryShell(workflow);
const bashSyntax=spawnSync('bash',['-n'],{input:persistShell,encoding:'utf8',timeout:10000});
assert(bashSyntax.status===0,
  'Release history persistence shell must pass bash -n: '+String(bashSyntax.stderr||'').slice(0,350));
assert(persistShell.includes('trap fail_history ERR')
    && persistShell.includes('record-production-release-attestation')
    && persistShell.includes('koa-release-history-failure-status.json'),
  'Release-history persistence must preserve fail-closed status publication and durable recorder enforcement.');
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


const historyAttestation={
  status:'verified',expectedSha:sha,deployId,liveDeployId:deployId,
  matchingDeployId:true,productionGateState:'success',visualQaConclusion:'success',
  visualQaRunId:'777',verifiedAt:'2026-10-12T10:00:00Z',
  systemHealth:{overall:'healthy',passed:82,failed:0},
};
const release={commit:sha,deployId,publishedAt:'2026-10-12T09:55:00Z',releaseAttestation:historyAttestation};
const statuses=(state)=>[{context:RELEASE_HISTORY_CONTEXT,state}];
const historyGood=evaluateReleaseHistoryPersistence({
  commit:sha,deployId,release,statuses:statuses('success'),now:Date.parse('2026-10-12T10:10:00Z'),
});
assert(historyGood.state==='healthy'&&historyGood.verified===true,
  'Only a matching durable record with independent green GitHub status may show Healthy.');
const historyFailed=evaluateReleaseHistoryPersistence({commit:sha,deployId,release,statuses:statuses('failure')});
assert(historyFailed.state==='failed'&&historyFailed.severity==='critical',
  'A failed persistence check must be critical even when the production deploy is ready.');
const historyMissing=evaluateReleaseHistoryPersistence({commit:sha,deployId,release:null,statuses:statuses('success')});
assert(historyMissing.state==='failed'&&historyMissing.severity==='critical',
  'Successful GitHub status without a durable record must be critical.');
const historyRecent=evaluateReleaseHistoryPersistence({
  commit:sha,deployId,release:null,statuses:statuses('pending'),
  publishedAt:'2026-10-12T10:00:00Z',now:Date.parse('2026-10-12T10:15:00Z'),
});
assert(historyRecent.state==='pending'&&historyRecent.verified===false,
  'Pending releases may not appear certified before durable persistence.');
const historyOverdue=evaluateReleaseHistoryPersistence({
  commit:sha,deployId,release:null,statuses:[],
  publishedAt:'2026-10-12T09:00:00Z',now:Date.parse('2026-10-12T10:00:00Z'),
});
assert(historyOverdue.state==='failed'&&historyOverdue.severity==='critical',
  'Uncertified production deploy older than 45 minutes must be critical.');
const stillTesting=evaluateReleaseHistoryPersistence({
  commit:sha,deployId,release:null,
  statuses:[
    {context:'System Health production release gate',state:'pending'},
  ],
  publishedAt:'2026-10-12T09:00:00Z',now:Date.parse('2026-10-12T10:30:00Z'),
});
assert(stillTesting.state==='pending'&&stillTesting.verified===false,
  'Long-running Chromium/WebKit release certification must remain pending, never false critical.');
const failedGate=evaluateReleaseHistoryPersistence({
  commit:sha,deployId,release:null,
  statuses:[{context:'System Health production release gate',state:'failure'}],
});
assert(failedGate.state==='failed'&&failedGate.severity==='critical',
  'A failed exact production gate must be independently visible before any durable record exists.');

const mismatch=evaluateReleaseHistoryPersistence({
  commit:sha,deployId,release:{...release,releaseAttestation:{...historyAttestation,deployId:'other'}},
  statuses:statuses('success'),
});
assert(mismatch.state==='failed','Exact deploy mismatch must never display a green certificate.');
assert(persistenceStatusForOutcome('success').state==='success'
    &&persistenceStatusForOutcome('failure').state==='failure'
    &&persistenceStatusForOutcome('skipped').state==='failure',
  'Only a completed successful durable recorder can publish independent success.');
assert(workflow.includes('id: persist-history')
    &&workflow.includes('Publish independent release-history persistence status')
    &&workflow.includes('node scripts/publish_release_history_status.mjs')
    &&workflow.includes('steps.persist-history.outcome'),
  'Production workflow must publish independent status after the history persistence step.');
assert(server.includes('const persistedReleases=await readProductionReleases(context,100)'),
  'Production recorder must read the durable certification back before returning success.');
const healthApi=readFileSync('netlify/functions/admin-health.mts','utf8');
assert(healthApi.includes("const sha=String(Netlify.env.get('COMMIT_REF')||deployments?.current?.commit||'')")
    && healthApi.includes("const deployId=String(context.deploy?.id||Netlify.env.get('DEPLOY_ID')||deployments?.current?.deployId||'')"),
  'Independent certification must use the actual serving runtime SHA/deploy ID before possibly stale cached Netlify metadata.');
assert(healthApi.includes('releaseHistoryPersistence')
    &&healthApi.includes('independentReleaseHistoryPersistence')
    &&healthPage.includes('data-release-history-persistence-card')
    &&healthPage.includes('data-release-history-persistence-status')
    &&healthPage.includes('Critical — not certified'),
  'System Health must show a dedicated independent persistence failure even when deployment succeeds.');

console.log('PASS | production release gate rejects errored deploys, cancelled visual QA, unhealthy System Health, missing live commit evidence, mismatched deploy IDs, and non-durable certification; API builds recover exact live deploy provenance.');
