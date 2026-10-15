#!/usr/bin/env node
// Validate private signed evidence without returning customer fields or response text.
import assert from 'node:assert/strict';
import { sanitizeFailedHealthChecks } from './safe_health_diagnostic_codes.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function requireValue(ok, message) { if (!ok) throw new Error(message); }
function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function money(value) { return typeof value === 'number' && Number.isFinite(value); }
function sha(value) { return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value); }
function deploy(value) { return typeof value === 'string' && /^[a-f0-9]{24}$/.test(value); }
function date(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[0-9:.+Z-]+$/.test(value) && Number.isFinite(Date.parse(value)); }

export function verifyPrivateHealth(data) {
  requireValue(data?.ok === true && data.auditRecorded === true, 'Signed health verification or audit persistence failed.');
  const probes = data.probes;
  requireValue(Array.isArray(probes) && probes.length === 4
    && probes.every(p => p?.ok === true && p.status === 204 && p.source === 'live'
      && typeof p.marker === 'string' && p.marker.length > 0 && p.marker === p.expectedMarker),
  'Four live synthetic protocol probes must pass with matching markers.');
  const a = data.accountingInvariant || {};
  requireValue(a.ok === true && a.status === 200, 'The private accounting invariant must pass.');
  requireValue(money(a.expectedTotal) && money(a.actualTotal) && money(a.liveClientEstimateTotal)
    && a.expectedTotal === a.actualTotal && a.liveClientEstimateTotal === a.expectedTotal,
  'Private accounting totals must be finite and reconcile.');
  requireValue(a.taxablePayload === 0 && a.liveClientTaxableLineCount === 0
    && a.historicalTaxOnTaxDetected === false, 'Private accounting tax invariants failed.');
  requireValue(a.liveClientStatus === 'passed' && a.dynamicClientStatus === 'passed'
    && a.dynamicClientFailedCount === 0 && a.dynamicClientUnverifiedCount === 0
    && count(a.dynamicClientCount) && count(a.dynamicClientPassedCount)
    && a.dynamicClientPassedCount === a.dynamicClientCount,
  'The full private accounting cohort must be verified without failed or unverified rows.');
  return { ok: true, liveProbeCount: probes.length, accountingInvariantVerified: true };
}

function safeBrowser(report, browser) {
  requireValue(report?.browser === browser && count(report.routes) && report.routes > 0
    && count(report.cases) && report.cases > 0 && count(report.failureCount)
    && count(report.failedRouteCount) && typeof report.reportMissing === 'boolean'
    && Array.isArray(report.routeResults) && report.routeResults.length === report.routes,
  'Browser evidence is missing or malformed.');
  const seen = new Set();
  const routeResults = report.routeResults.map(row => {
    requireValue(typeof row?.route === 'string' && /^\/[a-zA-Z0-9_./-]*$/.test(row.route)
      && row.route.length <= 300 && !row.route.includes('..') && !seen.has(row.route)
      && count(row.cases) && row.cases > 0 && count(row.failureCount)
      && row.failureCount <= row.cases && ['passed', 'failed'].includes(row.status)
      && (row.status === 'failed') === (row.failureCount > 0), 'Route evidence is missing or malformed.');
    seen.add(row.route);
    return { route: row.route, status: row.status, cases: row.cases, failureCount: row.failureCount,
      failures: row.failureCount ? ['Failure details remain in protected release evidence.'] : [] };
  });
  requireValue(routeResults.reduce((sum, row) => sum + row.cases, 0) === report.cases
    && routeResults.reduce((sum, row) => sum + row.failureCount, 0) === report.failureCount
    && routeResults.filter(row => row.failureCount > 0).length === report.failedRouteCount,
  'Browser route counts do not reconcile with the retained totals.');
  return { browser, routes: report.routes, cases: report.cases, failureCount: report.failureCount,
    failedRouteCount: report.failedRouteCount, reportMissing: report.reportMissing, routeResults };
}

export function sanitizeDashboard(data, expectedSha) {
  const dashboard = data?.dashboard && typeof data.dashboard === 'object' && !Array.isArray(data.dashboard)
    ? data.dashboard : data;
  const current = dashboard?.current || {};
  requireValue(sha(expectedSha) && data?.ok === true && data.sha === expectedSha && deploy(data.deployId),
    'Signed dashboard evidence must match the exact release SHA and deploy.');
  requireValue(['healthy', 'unhealthy'].includes(current.overall) && count(current.passed)
    && count(current.failed) && date(current.checkedAt), 'Dashboard health totals or timestamp are invalid.');
  if (data?.dashboard) {
    const outer = data.current || {};
    requireValue(['overall', 'passed', 'failed', 'checkedAt'].every(key => outer[key] === current[key]),
      'Signed envelope and dashboard health summaries disagree.');
  }
  const q = dashboard.visualQuality || {};
  requireValue(q.commit === expectedSha && q.deployId === data.deployId
    && ['passed', 'failed'].includes(q.status) && date(q.checkedAt)
    && Array.isArray(q.screenshots) && q.screenshots.length === 4,
    'Retained theme evidence and four thumbnails must match this release.');
  const chromium = safeBrowser(q.chromium, 'chromium');
  const webkit = safeBrowser(q.webkit, 'webkit');
  const keys = new Set();
  const screenshots = q.screenshots.map(shot => {
    const dimensions = { phone: [390, 844], desktop: [1440, 900] }[shot?.viewport];
    requireValue(dimensions && ['light', 'dark'].includes(shot.theme)
      && ['chromium', 'webkit'].includes(shot.browser)
      && shot.key === shot.theme + '-' + shot.viewport && !keys.has(shot.key)
      && shot.width === dimensions[0] && shot.height === dimensions[1], 'Thumbnail evidence is malformed.');
    keys.add(shot.key);
    return { key: shot.key, theme: shot.theme, viewport: shot.viewport, browser: shot.browser,
      route: '/admin/health/', width: dimensions[0], height: dimensions[1], contentType: 'image/jpeg',
      url: '/api/admin/health?action=dark-mode-qa-screenshot&deployId=' + encodeURIComponent(data.deployId)
        + '&key=' + encodeURIComponent(shot.key) };
  });
  requireValue(Array.isArray(dashboard.enrichmentWarnings), 'Enrichment warning evidence is missing.');
  // Preserve component identifiers only. Never expose check names, paths,
  // details, upstream payloads, client records or credential metadata in CI.
  const failedDiagnostics=sanitizeFailedHealthChecks(current.checks,current.failed);
  const failedCheckIds=failedDiagnostics.map(row=>row.id);
  // Only these internally generated stable recovery codes may escape the
  // private signed production snapshot; provider messages remain withheld.
  const recoveryCodes=new Set([
    'KOA_RECOVERY_EVIDENCE_READ_FAILED','KOA_RECOVERY_EVIDENCE_MISSING',
    'KOA_RECOVERY_TOKEN_UNCONFIGURED','KOA_RECOVERY_SITE_MISMATCH',
    'KOA_RECOVERY_CREDENTIAL_UNUSABLE','KOA_RECOVERY_EVIDENCE_STALE',
    'KOA_RECOVERY_RUNTIME_SHA_MISMATCH','KOA_RECOVERY_PUBLISHED_PROOF_MISSING',
    'KOA_RECOVERY_PUBLISHED_IDENTITY_MISMATCH',
  ]);
  const recoveryRow=Array.isArray(current.checks)
    ?current.checks.find(row=>row?.id==='netlify-recovery-credential'
      &&(row?.ok===false||row?.severity==='red')):null;
  const recoveryFailureCode=recoveryCodes.has(recoveryRow?.diagnosticCode)
    ?recoveryRow.diagnosticCode:null;
  requireValue(current.failed===0||failedCheckIds.length<=current.failed,
    'A sanitized health failure count exceeds the authoritative snapshot.');
  return {
    ok: true, sha: expectedSha, deployId: data.deployId,
    current: { overall: current.overall, passed: current.passed, failed: current.failed,
      checkedAt: current.checkedAt, failedCheckIds, failedDiagnostics, recoveryFailureCode, checks: [] },
    coverage: {}, criticalIntegrations: {}, rollbackReady: {}, runtime: {}, deployments: {},
    office365: {}, emailHealth: {}, credentialHealth: {}, weeklyExecutiveSummary: {}, accountingHealth: {},
    visualQuality: { status: q.status, checkedAt: q.checkedAt, source: 'production-visual-qa',
      runId: /^\d+$/.test(String(q.runId || '')) ? String(q.runId) : '',
      commit: expectedSha, deployId: data.deployId, productionCommit: expectedSha,
      productionDeployId: data.deployId, commitMatchesProduction: true, deployMatchesProduction: true,
      mismatch: false, chromium, webkit, screenshots, detail: 'Sanitized exact-release browser evidence.' },
    enrichmentWarnings: dashboard.enrichmentWarnings.map(() => ({ message: 'Enrichment warning details redacted from CI.' })),
  };
}

function selfTest() {
  const commit = 'a'.repeat(40), deployId = 'b'.repeat(24), checkedAt = '2026-10-13T12:00:00Z';
  const browser = name => ({ browser: name, routes: 1, cases: 4, failureCount: 0, failedRouteCount: 0,
    reportMissing: false, routeResults: [{ route: '/admin/health/', status: 'passed', cases: 4, failureCount: 0,
      email: 'private@example.invalid' }] });
  const shots = ['light', 'dark'].flatMap(theme => ['phone', 'desktop'].map(viewport => ({
    key: theme + '-' + viewport, theme, viewport, browser: 'chromium',
    width: viewport === 'phone' ? 390 : 1440, height: viewport === 'phone' ? 844 : 900,
    url: 'https://private.example.invalid/customer', dataBase64: 'PRIVATE_IMAGE_CONTENT',
  })));
  const input = { ok: true, sha: commit, deployId,
    current: { overall: 'healthy', passed: 82, failed: 0, checkedAt, checks: [{ detail: 'PRIVATE_CUSTOMER' }] },
    visualQuality: { status: 'passed', checkedAt, commit, deployId, runId: '123',
      chromium: browser('chromium'), webkit: browser('webkit'), screenshots: shots },
    accountingHealth: { customer: 'PRIVATE_CUSTOMER' }, enrichmentWarnings: [{ detail: 'PRIVATE_CUSTOMER' }] };
  const safe = sanitizeDashboard(input, commit);
  const serialized = JSON.stringify(safe);
  for (const forbidden of ['PRIVATE_CUSTOMER', 'private@example.invalid', 'private.example.invalid', 'PRIVATE_IMAGE_CONTENT']) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(safe.visualQuality.chromium.routes, 1);
  assert.equal(safe.visualQuality.chromium.cases, 4);
  assert.equal(safe.visualQuality.screenshots.length, 4);
  assert.equal(safe.enrichmentWarnings.length, 1);
  const failedFixture={...input, current:{...input.current, overall:'unhealthy',passed:81,failed:1,
    checks:[{id:'netlify-recovery-credential',ok:false,detail:'PRIVATE_CUSTOMER'},
      {id:'customer@example.invalid',ok:false,detail:'PRIVATE_CUSTOMER'}]}};
  const failedSafe=sanitizeDashboard(failedFixture,commit);
  assert.deepEqual(failedSafe.current.failedCheckIds,['netlify-recovery-credential']);
  assert.deepEqual(failedSafe.current.failedDiagnostics,[{id:'netlify-recovery-credential',category:'deployment',errorCode:'HEALTH_DEPLOYMENT_FAILED'}]);
  assert.equal(failedSafe.current.recoveryFailureCode,null);
  const classified=sanitizeDashboard({
    ...failedFixture,current:{...failedFixture.current,checks:[
      {id:'netlify-recovery-credential',ok:false,diagnosticCode:'KOA_RECOVERY_PUBLISHED_PROOF_MISSING'},
    ]},
  },commit);
  assert.equal(classified.current.recoveryFailureCode,'KOA_RECOVERY_PUBLISHED_PROOF_MISSING');
  assert(!JSON.stringify(sanitizeDashboard({
    ...failedFixture,current:{...failedFixture.current,checks:[
      {id:'netlify-recovery-credential',ok:false,diagnosticCode:'PRIVATE_CLIENT_MARKER_EMAIL'},
    ]},
  },commit)).includes('PRIVATE_CLIENT_MARKER_EMAIL'));

  assert(!JSON.stringify(failedSafe).includes('PRIVATE_CUSTOMER'));
  assert(!JSON.stringify(failedSafe).includes('customer@example.invalid'));
  // Match the actual OIDC run-dashboard-refresh response, whose detailed
  // browser evidence is nested under dashboard rather than at the top level.
  const envelope = { ok: true, sha: commit, deployId, source: 'github-actions-oidc',
    current: input.current, enrichmentWarnings: input.enrichmentWarnings, dashboard: input };
  assert.deepEqual(sanitizeDashboard(envelope, commit), safe);
  assert.throws(() => sanitizeDashboard({ ...envelope, current: { ...input.current, failed: 1 } }, commit));
  assert.throws(() => sanitizeDashboard({ ...envelope, dashboard: { ...input, visualQuality: {} } }, commit));
  for (const bad of [ { ...input, sha: 'c'.repeat(40) }, { ...input, deployId: '' },
    { ...input, current: { ...input.current, passed: true } },
    { ...input, visualQuality: {} },
    { ...input, visualQuality: { ...input.visualQuality, screenshots: shots.slice(1) } },
    { ...input, visualQuality: { ...input.visualQuality, chromium: { ...browser('chromium'), cases: 8 } } } ]) {
    assert.throws(() => sanitizeDashboard(bad, commit));
  }
  const health = { ok: true, auditRecorded: true,
    probes: Array.from({ length: 4 }, () => ({ ok: true, status: 204, source: 'live', marker: 'synthetic', expectedMarker: 'synthetic' })),
    accountingInvariant: { ok: true, status: 200, expectedTotal: 1234.50, actualTotal: 1234.50,
      liveClientEstimateTotal: 1234.50, taxablePayload: 0, liveClientTaxableLineCount: 0,
      historicalTaxOnTaxDetected: false, liveClientStatus: 'passed', dynamicClientStatus: 'passed',
      dynamicClientFailedCount: 0, dynamicClientUnverifiedCount: 0, dynamicClientCount: 2, dynamicClientPassedCount: 2 } };
  assert.equal(verifyPrivateHealth(health).ok, true);
  for (const delta of [ { actualTotal: 9 }, { expectedTotal: null }, { actualTotal: NaN },
    { liveClientTaxableLineCount: 1 }, { historicalTaxOnTaxDetected: true },
    { dynamicClientUnverifiedCount: 1 }, { dynamicClientPassedCount: 1 }, { dynamicClientCount: true } ]) {
    assert.throws(() => verifyPrivateHealth({ ...health, accountingInvariant: { ...health.accountingInvariant, ...delta } }));
  }
  assert.throws(() => verifyPrivateHealth({ ...health, probes: [] }));
  console.log('PASS | private release evidence validation, PII stripping, exact-SHA browser coverage, signed nested envelope, and 17 fail-closed fixtures.');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv[2] === '--self-test') selfTest();
    else {
      const [mode, inputFile, outputFile, expectedSha] = process.argv.slice(2);
      requireValue(typeof inputFile === 'string' && resolve(inputFile).startsWith('/tmp/'), 'Private evidence input must be a temporary file.');
      const data = JSON.parse(readFileSync(inputFile, 'utf8'));
      if (mode === 'verify-health') console.log(JSON.stringify(verifyPrivateHealth(data)));
      else if (mode === 'sanitize-dashboard') {
        requireValue(typeof outputFile === 'string' && outputFile.endsWith('.json'), 'A sanitized JSON output path is required.');
        const safe = sanitizeDashboard(data, expectedSha);
        writeFileSync(outputFile, JSON.stringify(safe));
        console.log(JSON.stringify({ ok: true, overall: safe.current.overall, passed: safe.current.passed,
          failed: safe.current.failed, failedCheckIds: safe.current.failedCheckIds,
          failedDiagnostics: safe.current.failedDiagnostics,
          recoveryFailureCode: safe.current.recoveryFailureCode,
          checkedAt: safe.current.checkedAt, enrichmentWarningCount: safe.enrichmentWarnings.length }));
      } else throw new Error('Unknown private evidence mode.');
    }
  } catch {
    // Never serialize the untrusted response or parser exception into public Actions logs.
    console.error('Private release evidence validation failed; raw response withheld.');
    process.exitCode = 1;
  }
}
