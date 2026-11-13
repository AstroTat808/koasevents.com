import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizeProductionMonitoring } from '../src/lib/production-monitoring-overview.mjs';

const SHA = '55f85b4c32cfad432c4fb82ef0d7dfa5ec330996';
const DEPLOY = '6af52f91a212fad7910d6c30';
const now = Date.parse('2026-11-13T18:00:00Z');
const good = {
  current: { overall:'healthy',failed:0,alertFailedIds:[],checkedAt:'2026-11-13T17:45:00Z' },
  deployments: {
    current: { deployId:DEPLOY,commit:SHA,mainCommit:SHA,behindMain:false,deployStatus:'ready' },
    deploymentHealthy:true,
    latestQaForCurrentDeploy: { conclusion:'success',commit:SHA,deployId:DEPLOY,runId:'43314450106' },
  },
  visualQuality: { status:'passed',deployId:DEPLOY,commit:SHA,chromium:{failureCount:0},webkit:{failureCount:0} },
};
const pass = summarizeProductionMonitoring(good,now);
assert.equal(pass.health.state,'healthy');
assert.equal(pass.deployment.state,'healthy');
assert.equal(pass.release.state,'healthy');
assert.equal(pass.browsers.state,'healthy');
assert.equal(pass.browsers.failures,0);
assert.equal(pass.cdn.state,'external', 'Never treat synthetic browser health as an edge-log count');
const stale = summarizeProductionMonitoring({...good,current:{...good.current,checkedAt:'2026-11-12T12:00:00Z'}},now);
assert.equal(stale.health.state,'unknown','Stale health must not be green');
const wrongSha = summarizeProductionMonitoring({
  ...good,deployments:{...good.deployments,current:{...good.deployments.current,commit:'a'.repeat(40)}}
},now);
assert.notEqual(wrongSha.deployment.state,'healthy','Mismatched deploy cannot be certified');
assert.notEqual(wrongSha.release.state,'healthy','Mismatched release cannot be certified');
assert.notEqual(wrongSha.browsers.state,'healthy','Old SHA visual evidence cannot be reused');
const missingEvidence = summarizeProductionMonitoring({
  current:{ overall:'healthy',failed:0,checkedAt:'2026-11-13T17:45:00Z' },
  deployments:{current:{deployId:DEPLOY,mainCommit:SHA,behindMain:false}},
},now);
assert.equal(missingEvidence.release.state,'unknown');
assert.equal(missingEvidence.deployment.state,'unknown');
const unknownDeployState = summarizeProductionMonitoring({
  ...good, deployments:{...good.deployments,current:{...good.deployments.current,deployStatus:''}}
},now);
assert.equal(unknownDeployState.deployment.state,'unknown','Unknown deploy state must not read as healthy');
const missingQaCommit = summarizeProductionMonitoring({
  ...good, deployments:{...good.deployments,latestQaForCurrentDeploy:{conclusion:'success'}}
},now);
assert.notEqual(missingQaCommit.release.state,'healthy','Unbound QA evidence cannot certify a release');
const failure = summarizeProductionMonitoring({
  ...good,deployments:{...good.deployments,deploymentHealthy:false,latestQaForCurrentDeploy:{...good.deployments.latestQaForCurrentDeploy,conclusion:'failure'}},
  visualQuality:{...good.visualQuality,status:'failed',chromium:{failureCount:1},webkit:{failureCount:0}}
},now);
assert.equal(failure.release.state,'failed');
assert.equal(failure.browsers.state,'failed');
assert.equal(failure.browsers.failures,1);
const view = readFileSync('src/components/admin/ProductionMonitoringOverview.astro','utf8');
const route = readFileSync('src/pages/admin/health/index.astro','utf8');
assert.match(view,/External edge watch/);
assert.match(view,/koa:production-monitoring/);
assert.match(route,/ProductionMonitoringOverview/);
assert.match(route,/summarizeProductionMonitoring/);
console.log('Production monitoring summary contract: PASS');
