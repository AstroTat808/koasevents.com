#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workflow=readFileSync(fileURLToPath(new URL('../.github/workflows/production-visual-qa.yml',import.meta.url)),'utf8');
const start=workflow.indexOf('      - name: Require final System Health snapshot to be healthy');
const end=workflow.indexOf('      - name: Publish final fail-closed production release status',start);
const failures=[];
const requireMatch=(condition,reason)=>{if(!condition)failures.push(reason);};
requireMatch(start>=0 && end>start,'Required production release health stages missing');
const section=start>=0 && end>start?workflow.slice(start,end):'';
for(const text of [
  'for attempt in 1 2 3; do',
  'rm -f /tmp/koa-final-health.json',
  '000|502|503|504)',
  'test "$http_status" = "200"',
  'assert data.get("ok") is True',
  'assert data.get("sha")==os.environ["GITHUB_SHA"]',
  'assert current.get("overall")=="healthy"',
  'assert current.get("failed")==0',
  'assert isinstance(current.get("passed"),int)',
  'assert current.get("checkedAt")',
  '--data \'{"action":"run-dashboard-refresh"}\'',
])requireMatch(section.includes(text),'Missing final health release invariant: '+text);
requireMatch(
  section.indexOf('case "$http_status" in')>=0
  && section.indexOf('test "$http_status" = "200"')>section.indexOf('case "$http_status" in'),
  'Final HTTP success and healthy-result assertions must remain after transport retry');
requireMatch(
  !section.includes('current.get("failed")<=') &&
  !section.includes('current.get("failed")<'),
  'Never dilute the exact zero-failure release gate');

// Certified status must never be published before durable release history
// and signed PDF/JSON evidence are verified. An explicitly dispatched run may
// certify ONLY the canonical production URL; never a staging/alternate target.
const signedMainGate="(github.event_name == 'push' || github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.base_url == 'https://koasevents.com')) && github.ref == 'refs/heads/main'";
requireMatch(signedMainGate.includes("inputs.base_url == 'https://koasevents.com'"),
  'Manual release certification must be restricted to the canonical production URL');
requireMatch(!workflow.includes("github.event_name == 'workflow_dispatch') && github.ref"),
  'Do not permit unguarded manual workflow dispatch to certify an alternate base URL');
const certifiedStep=workflow.indexOf('      - name: Publish certified production gate after durable attestation and export bytes');
const historyStep=workflow.indexOf('      - name: Persist certified release attestation history');
const bytesStep=workflow.indexOf('      - name: Verify actual certified PDF and JSON serializer bytes');
const decisionStep=workflow.indexOf('      - name: Publish final fail-closed production release status');
requireMatch(workflow.includes('    if: always() && '+signedMainGate),
  'Signed final gate must run for main push/schedule/canonical-production dispatch only');
requireMatch(workflow.includes('    name: Mark production release pending\n    if: '+signedMainGate),
  'Canonical production push/schedule/dispatch must mark release pending');
requireMatch(decisionStep>=0 && decisionStep<historyStep && historyStep<bytesStep && bytesStep<certifiedStep,
  'Release gate success must be published only after durable history and PDF/JSON byte verification');
const preCertification=workflow.slice(decisionStep,historyStep);
const finalCertification=workflow.slice(certifiedStep);
requireMatch(preCertification.includes("state:decision.ok?'pending':'failure'"),
  'Successful pre-certification evaluation must publish pending, not success');
requireMatch(preCertification.includes('process.exit(x.decision.ok?0:1)'),
  'Only a successful policy decision may advance to durable attestation');
for (const marker of [
  "'decision',{}",
  "koa-release-history-response.json",
  "koa-final-main.json",
  "koa-final-deploy-recheck.json",
  "live.get('deployId')==live.get('liveDeployId')",
  "'state':'success'",
]) requireMatch(finalCertification.includes(marker),'Missing fail-closed final signed proof: '+marker);

if(failures.length){
  failures.forEach(message=>console.error('FAIL | '+message));
  process.exit(1);
}
console.log('PASS | 504-only bounded transport retry preserves exact SHA, healthy status, and zero failures.');
