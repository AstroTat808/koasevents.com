import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  criticalIntegrationProbePassed,
  runCriticalIntegrationRollbackDrill,
} from '../netlify/functions/_shared/critical-integration-release-guard.mjs';

const environment=process.env.DRILL_ENVIRONMENT||'ci-non-production';
assert.notEqual(environment,'production','Rollback drill must never run in production.');

const startedAt='2026-09-29T12:45:00.000Z';
const report=runCriticalIntegrationRollbackDrill({
  environment,
  startedAt,
  failedProbeId:'synthetic-signwell-webhook',
  currentDeployId:'drill-candidate-deploy',
  currentCommit:'drill-candidate-commit',
});

assert.equal(report.safe,true,'Drill must report that no production mutation was attempted.');
assert.equal(report.ok,true,'The full rollback drill must complete successfully.');
assert.equal(report.failedAudit.syntheticProbeVerification.status,'failed');
assert.equal(report.failedAudit.syntheticProbeVerification.healthyCount,3);
assert.equal(report.failedAudit.syntheticProbeVerification.probes.find((row)=>row.id==='synthetic-signwell-webhook')?.status,503);
assert.equal(report.rollback.status,'simulated-rolled-back');
assert.equal(report.rollback.targetDeployId,'drill-known-good-deploy');
assert.equal(report.rollback.targetCommit,'drill-known-good-commit');
assert.equal(report.rollback.productionMutationAttempted,false);
assert.equal(report.recoveryVerification.status,'passed');
assert.equal(report.recoveryVerification.healthyCount,4);
assert.equal(report.recoveryVerification.probes.every(criticalIntegrationProbePassed),true);
assert.deepEqual(
  report.events.map((event)=>event.phase),
  ['detection','failed-audit','rollback','recovery'],
);
assert.equal(report.events.every((event)=>event.ok),true);

await mkdir(new URL('../visual-results/',import.meta.url),{recursive:true});
await writeFile(
  new URL('../visual-results/critical-integration-rollback-drill.json',import.meta.url),
  JSON.stringify(report,null,2)+'\n',
  'utf8',
);

console.log('Critical Integrations rollback drill passed: detection -> failed audit -> rollback -> recovery.');
console.log('Production mutation attempted:',report.rollback.productionMutationAttempted);
console.log('Rollback target:',report.rollback.targetDeployId,report.rollback.targetCommit);
