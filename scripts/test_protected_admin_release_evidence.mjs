#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizeProtectedAdminQa} from '../netlify/functions/_shared/protected-admin-release-evidence.mjs';

const meta={commit:'a'.repeat(40),deployId:'b'.repeat(24),runId:'12345678901',
  checkedAt:'2026-10-15T19:00:00.000Z'};
const healthy={ok:true,totalFailures:0,failures:[]};
const passed=normalizeProtectedAdminQa(healthy,meta);
assert.equal(passed.status,'passed');
assert.equal(passed.failureCount,0);
assert.equal(passed.source,'github-actions-oidc');
assert.equal(passed.commit,meta.commit);
assert.equal(passed.deployId,meta.deployId);
assert.equal(passed.runId,meta.runId);
const failed={ok:false,totalFailures:2,failures:[
  {route:'admin-health',code:'ADMIN_QA_CLIENT_EXCEPTION'},
  {route:'system-health-api',code:'ADMIN_QA_AUTHORIZATION_GUARD_FAILED'},
]};
const bad=normalizeProtectedAdminQa(failed,meta);
assert.equal(bad.status,'failed');
assert.equal(bad.failureCount,2);
assert.deepEqual(bad.failures,failed.failures);
for(const result of [
  {...healthy,rawResponse:'PRIVATE_CLIENT_EMAIL_MARKER'},
  {...healthy,failures:[{route:'admin-health',code:'ADMIN_QA_TIMEOUT'}]},
  {...healthy,ok:false},
  {...healthy,totalFailures:1,ok:false},
  {...healthy,code:'UNSAFE_USER_VALUE'},
  {...failed,failures:[{route:'admin-health',code:'ADMIN_QA_CLIENT_EXCEPTION',customer:'PRIVATE_CLIENT_EMAIL_MARKER'}]},
  {...failed,failures:[{route:'customer-PRIVATE_CLIENT_EMAIL_MARKER',code:'ADMIN_QA_TIMEOUT'}]},
  {...failed,failures:[{route:'admin-health',code:'PRIVATE_CLIENT_EMAIL_MARKER'}]},
  {...failed,totalFailures:0},
  {...healthy,totalFailures:151},
])assert.throws(()=>normalizeProtectedAdminQa(result,meta));
for(const attrs of [
  {...meta,commit:'f'.repeat(39)},
  {...meta,deployId:'wrong'},
  {...meta,runId:'untrusted'},
  {...meta,checkedAt:'not-a-time'},
])assert.throws(()=>normalizeProtectedAdminQa(healthy,attrs));
const read=(file)=>readFileSync(new URL(file,import.meta.url),'utf8');
const storage=read('../netlify/functions/_shared/system-health.ts');
const endpoint=read('../netlify/functions/github-main-health-signal.ts');
const workflow=read('../.github/workflows/production-visual-qa.yml');
const page=read('../src/pages/admin/health/index.astro');
assert(storage.includes('protectedAdminQa:input?.protectedAdminQa||previous?.protectedAdminQa||null'));
assert(storage.includes("store.setJSON('deployments/releases/by-id/'+deployId,record)"));
assert(endpoint.includes("if(body?.action==='record-protected-admin-qa')"));
assert(endpoint.includes('productionDeployMatchesAttestation('));
assert(endpoint.includes('const persisted=Boolean('));
assert(workflow.includes('publish_protected_admin_release_evidence.mjs'));
assert(page.includes('release.protectedAdminQa||null'));
console.log('PASS | Signed protected-admin QA: strict PII allowlist, exact deploy, durable readback, and Release History contract.');
