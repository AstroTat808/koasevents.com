#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyCertifiedExportNegativeProbes } from '../netlify/functions/_shared/certified-export-security-probe.mjs';
const result=verifyCertifiedExportNegativeProbes();
assert.equal(result.ok,true,'Both PDF and JSON must reject every uncertified synthetic release.');
assert.equal(result.denied,result.expected,'All synthetic negative fixtures must be rejected.');
assert.deepEqual(result.formats,['json','pdf']);
assert.equal(result.cases.length,36,'Each synthetic denial must have durable individual evidence.');
assert.equal(new Set(result.cases.map(row=>row.id)).size,36);
assert.equal(result.cases.filter(row=>row.format==='pdf').length,18);
assert.equal(result.cases.filter(row=>row.format==='json').length,18);
assert(result.cases.every(row=>row.outcome==='denied'&&/^(PDF|JSON)_[A-Z0-9_]+$/.test(row.id)));

// Release History must remain durable across dashboard refreshes and preserve
// the test's exact GitHub run, commit, deployment, and server readback.
const read=(path)=>readFileSync(new URL(path,import.meta.url),'utf8');
const backend=read('../netlify/functions/_shared/system-health.ts');
const signal=read('../netlify/functions/github-main-health-signal.ts');
const dashboard=read('../netlify/functions/admin-health.mts');
const ui=read('../src/pages/admin/health/index.astro');
const workflow=read('../.github/workflows/production-visual-qa.yml');
const exportModule=read('../netlify/functions/_shared/release-attestation-export.mjs');
const liveTest=read('./verify_live_certified_export_rejections.mjs');
const certifiedBytes=read('./verify_live_certified_export_bytes.mjs');
for(const needle of [
  'certifiedExportSecurity:input?.certifiedExportSecurity||previous?.certifiedExportSecurity||null',
  "store.setJSON('deployments/releases/by-id/'+deployId,record)",
])assert(backend.includes(needle),'Durable per-deploy evidence contract changed.');
for(const needle of [
  "if(body?.action==='verify-certified-export-rejections')",
  'recordProductionRelease(context,{',
  'const readbackVerified=Boolean(',
  'signedPublishedProof',
  "if(body?.action==='verify-certified-export-artifact-bytes')",
  'pdfText.includes(\'SIGNED RESULT: 36 / 36\')',
  "source:'github-actions-oidc' as const",
])assert(signal.includes(needle),'Signed production-write/readback gate changed.');
assert(dashboard.includes('certifiedExportSecurity')&&ui.includes('data-export-security-total')
  &&ui.includes('release.certifiedExportSecurity||null'),
  'Current System Health and permanent Release History must both render the retained evidence.');
assert(exportModule.includes('verifiedCertifiedExportSecurity(row)')
  &&exportModule.includes('heading(\'PDF / JSON export security')
  &&exportModule.includes('certifiedExportSecurity,'),
  'PDF and JSON certified exports must include the same exact signed 36-case manifest.');
assert(workflow.includes('Verify actual certified PDF and JSON serializer bytes')
  &&workflow.includes('node scripts/verify_live_certified_export_bytes.mjs')
  &&certifiedBytes.includes("verify-certified-export-artifact-bytes")
  &&certifiedBytes.includes('result.caseCount!==36'),
  'The persisted certified release must be validated by the actual deployed PDF and JSON serializers.');
assert(workflow.includes('Verify live uncertified PDF and JSON exports are rejected')
  &&liveTest.includes('result.readbackVerified!==true')
  &&liveTest.includes("for(const format of ['pdf','json'])"),
  'The mandatory live release gate must verify durable evidence and both anonymous HTTP routes.');

console.log('PASS | production export-security contract: '+result.denied+' rejected synthetic PDF/JSON export attempts.');
