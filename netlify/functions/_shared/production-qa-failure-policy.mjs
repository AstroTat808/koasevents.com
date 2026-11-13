/**
 * Exact-main, completed production QA failures only. No raw job logs or PII.
 */
const SHA=/^[0-9a-f]{40}$/;
const RUN=/^[0-9]{6,18}$/;
const PATH='.github/workflows/production-visual-qa.yml';
const RELEVANT=new Set([
  'Source + Astro build audit',
  'Deploy route + asset smoke',
  'Live Light / Dark / System audit',
  'Protected admin post-deploy audit',
  'System Health authenticated mobile screenshots',
  'Responsive visual audit',
  'Final production release attestation',
]);
export function validProductionQaFailureRun(run={},runId='',expectedSha='') {
  return RUN.test(String(runId))
    && String(run.id)===String(runId)
    && SHA.test(expectedSha)
    && String(run.head_sha||'')===expectedSha
    && String(run.head_branch||'')==='main'
    && String(run.path||'').split('@')[0]===PATH
    && run.status==='completed' && run.conclusion==='failure'
    && ['push','schedule','workflow_dispatch'].includes(String(run.event||''));
}
export function failedProductionQaJobs(run={},jobs=[]) {
  const rows=Array.isArray(jobs)?jobs:[];
  if(run.event==='workflow_dispatch' && !rows.some(x=>
    x.name==='Final production release attestation' && x.status==='completed'
    && ['success','failure'].includes(x.conclusion))) return [];
  return rows.filter(x=>RELEVANT.has(String(x.name||''))
    && x.status==='completed' && x.conclusion==='failure')
    .map(x=>({name:String(x.name),conclusion:'failure'}));
}
