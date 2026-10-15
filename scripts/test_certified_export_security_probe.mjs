#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyCertifiedExportNegativeProbes } from '../netlify/functions/_shared/certified-export-security-probe.mjs';
const result=verifyCertifiedExportNegativeProbes();
assert.equal(result.ok,true,'Both PDF and JSON must reject every uncertified synthetic release.');
assert.equal(result.denied,result.expected,'All synthetic negative fixtures must be rejected.');
assert.deepEqual(result.formats,['json','pdf']);
// Release History must remain durable across dashboard refreshes and preserve
// the test's exact GitHub run, commit, deployment, and server readback.
const read=(path)=>readFileSync(new URL(path,import.meta.url),'utf8');
const backend=read('../netlify/functions/_shared/system-health.ts');
const signal=read('../netlify/functions/github-main-health-signal.ts');
const dashboard=read('../netlify/functions/admin-health.mts');
const ui=read('../src/pages/admin/health/index.astro');
const workflow=read('../.github/workflows/production-visual-qa.yml');
const liveTest=read('./verify_live_certified_export_rejections.mjs');
for(const needle of [
  'certifiedExportSecurity:input?.certifiedExportSecurity||previous?.certifiedExportSecurity||null',
  "store.setJSON('deployments/releases/by-id/'+deployId,record)",
])assert(backend.includes(needle),'Durable per-deploy evidence contract changed.');
for(const needle of [
  "if(body?.action==='verify-certified-export-rejections')",
  'recordProductionRelease(context,{',
  'const readbackVerified=Boolean(',
  'signedPublishedProof',
  "source:'github-actions-oidc' as const",
])assert(signal.includes(needle),'Signed production-write/readback gate changed.');
assert(dashboard.includes('certifiedExportSecurity')&&ui.includes('data-export-security-total')
  &&ui.includes('release.certifiedExportSecurity||null'),
  'Current System Health and permanent Release History must both render the retained evidence.');
assert(workflow.includes('Verify live uncertified PDF and JSON exports are rejected')
  &&liveTest.includes('result.readbackVerified!==true')
  &&liveTest.includes("for(const format of ['pdf','json'])"),
  'The mandatory live release gate must verify durable evidence and both anonymous HTTP routes.');

console.log('PASS | production export-security contract: '+result.denied+' rejected synthetic PDF/JSON export attempts.');
