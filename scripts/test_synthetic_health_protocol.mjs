import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

const [
  systemHealth,
  syntheticHealth,
  eventDocuments,
  vendorInsurance,
  quickBooksWebhook,
  signWellWebhook,
  healthUi,
  githubHealthSignal,
  productionQa,
  postDeployVerification,
  adminHealth,
  releaseGuard,
  rollbackDrillScript,
  rollbackDrillWorkflow,
] = await Promise.all([
  read('netlify/functions/_shared/system-health.ts'),
  read('netlify/functions/_shared/synthetic-health.ts'),
  read('netlify/functions/admin-event-documents.mts'),
  read('netlify/functions/vendor-insurance-document.mts'),
  read('netlify/functions/quickbooks-webhook.mts'),
  read('netlify/functions/signwell-webhook.mts'),
  read('src/pages/admin/health/index.astro'),
  read('netlify/functions/github-main-health-signal.ts'),
  read('.github/workflows/production-visual-qa.yml'),
  read('netlify/functions/post-deploy-verification.mts'),
  read('netlify/functions/admin-health.mts'),
  read('netlify/functions/_shared/critical-integration-release-guard.mjs'),
  read('scripts/test_critical_integration_rollback_drill.mjs'),
  read('.github/workflows/critical-integrations-rollback-drill.yml'),
]);

function mustMatch(source, pattern, message) {
  assert.match(source, pattern, message);
}

const canonical = {
  requestTokenHeader: 'X-VenueLoom-Synthetic-Token',
  responseMarkerHeader: 'X-VenueLoom-Synthetic-Check',
  healthCheckHeader: 'X-VenueLoom-Health-Check',
  payloadMarker: 'venueLoomHealthCheck',
  expectedStatus: 204,
};

mustMatch(
  systemHealth,
  /headers\.get\('x-venueloom-synthetic-check'\)/,
  'System Health must read the canonical synthetic response marker header.',
);
mustMatch(
  systemHealth,
  /status===204/,
  'System Health must require HTTP 204 for successful zero-write synthetic probes.',
);
mustMatch(
  systemHealth,
  /'X-VenueLoom-Synthetic-Token':internalSyntheticToken/,
  'Event-document and vendor-insurance probes must send the canonical synthetic token header.',
);
mustMatch(
  syntheticHealth,
  /headers\.get\('x-venueloom-synthetic-token'\)/,
  'Protected synthetic endpoints must accept the canonical synthetic token header.',
);

for (const [label, source, marker] of [
  ['Event Documents', eventDocuments, 'event-documents'],
  ['Vendor Insurance', vendorInsurance, 'vendor-insurance-document'],
]) {
  mustMatch(
    source,
    /isSyntheticHealthRequest\(req\)/,
    label + ' must validate the internal synthetic health token.',
  );
  mustMatch(
    source,
    /status:\s*204/,
    label + ' must return HTTP 204 when the zero-write health probe succeeds.',
  );
  mustMatch(
    source,
    new RegExp("'X-VenueLoom-Synthetic-Check'\\s*:\\s*'" + marker + "'"),
    label + ' must return the expected synthetic marker.',
  );
}

mustMatch(
  systemHealth,
  /JSON\.stringify\(\{venueLoomHealthCheck:true,koaHealthCheck:true,eventNotifications:\[\]\}\)/,
  'QuickBooks synthetic request must carry the canonical payload marker.',
);
mustMatch(
  systemHealth,
  /'X-VenueLoom-Health-Check':'1'/,
  'QuickBooks synthetic request must carry the canonical health-check header.',
);
mustMatch(
  quickBooksWebhook,
  /headers\.get\('x-venueloom-health-check'\)/,
  'QuickBooks webhook must read the canonical health-check header.',
);
mustMatch(
  quickBooksWebhook,
  /payload\?\.venueLoomHealthCheck\s*===\s*true/,
  'QuickBooks webhook must accept the canonical payload marker.',
);
mustMatch(
  quickBooksWebhook,
  /status:204[\s\S]*'X-VenueLoom-Synthetic-Check':'quickbooks-webhook'/,
  'QuickBooks webhook must return HTTP 204 with the quickbooks-webhook marker.',
);

mustMatch(
  systemHealth,
  /venueLoomHealthCheck:true,[\s\S]*event:\{type:signWellEventType/,
  'SignWell synthetic request must carry the canonical payload marker.',
);
mustMatch(
  signWellWebhook,
  /payload\?\.venueLoomHealthCheck===true/,
  'SignWell webhook must accept the canonical payload marker.',
);
mustMatch(
  signWellWebhook,
  /status:204,[\s\S]*'X-VenueLoom-Synthetic-Check':'signwell-webhook'/,
  'SignWell webhook must return HTTP 204 with the signwell-webhook marker.',
);

for (const [marker, label] of [
  ['event-documents', 'Event Documents'],
  ['vendor-insurance-document', 'Vendor Insurance'],
  ['quickbooks-webhook', 'QuickBooks'],
  ['signwell-webhook', 'SignWell'],
]) {
  mustMatch(
    systemHealth,
    new RegExp("syntheticResult\\([^\\n]*'" + marker + "'"),
    label + ' System Health expectation must use the same response marker as its endpoint.',
  );
}

mustMatch(
  systemHealth,
  /syntheticDetails:\{/,
  'Synthetic checks must expose diagnostic metadata.',
);
mustMatch(
  systemHealth,
  /expectedStatus:204/,
  'Synthetic diagnostics must expose the expected HTTP status.',
);
mustMatch(
  healthUi,
  /syntheticDetails/,
  'System Health UI must render synthetic diagnostics.',
);
mustMatch(
  healthUi,
  /Last live /,
  'System Health UI must show the last live synthetic verification time.',
);
mustMatch(
  healthUi,
  /Marker /,
  'System Health UI must show the returned synthetic marker.',
);
mustMatch(
  githubHealthSignal,
  /action==='verify-synthetic-probes'/,
  'GitHub OIDC health signal must support a live synthetic-probe verification action.',
);
mustMatch(
  githubHealthSignal,
  /runSystemHealth\(context,'post-deploy'\)/,
  'OIDC verification must run live post-deploy System Health rather than reading cached results.',
);
mustMatch(
  githubHealthSignal,
  /action==='verify-production-health'/,
  'GitHub OIDC health signal must support the full production-health verification action.',
);
mustMatch(
  productionQa,
  /verify-production-health/,
  'Production QA must request the full live production-health verification.',
);
mustMatch(
  productionQa,
  /accountingInvariant/,
  'Production QA must gate the deploy on the live accounting invariant.',
);
mustMatch(
  productionQa,
  /liveClientEstimateTotal/,
  'Production QA must require the live Chris Sibel estimate total.',
);
mustMatch(
  systemHealth,
  /dynamicClientStatus:String\(liveClients\?\.status\|\|'unverified'\)/,
  'Shared production accounting verification must expose the dynamic accepted/booked client invariant status.',
);
mustMatch(
  githubHealthSignal,
  /productionAccountingVerification\(health\)/,
  'Signed production health must use the shared accounting verifier before persisting release evidence.',
);
mustMatch(
  productionQa,
  /dynamicClientFailedCount/,
  'Production QA must fail when any accepted/booked client accounting invariant fails.',
);
mustMatch(
  systemHealth,
  /accounting\/client-invariant-incidents/,
  'System Health must persist client accounting invariant transitions outside the rolling health history.',
);
mustMatch(
  systemHealth,
  /readAccountingInvariantIncidents/,
  'System Health must expose the persistent accounting invariant incident timeline.',
);
mustMatch(
  healthUi,
  /Accounting incident timeline/,
  'System Health UI must label the persistent accounting transition history as an incident timeline.',
);
mustMatch(
  healthUi,
  /Before: CRM /,
  'Accounting incident rows must display before/after CRM and QuickBooks totals.',
);
mustMatch(
  productionQa,
  /p\.get\("status"\)==204/,
  'Production QA must fail unless every live synthetic probe returns HTTP 204.',
);
mustMatch(
  systemHealth,
  /export function criticalIntegrationsSummary/,
  'System Health must publish one Critical Integrations summary for the four release-critical probes.',
);
mustMatch(
  systemHealth,
  /lastLiveVerification/,
  'Critical Integrations must expose the most recent live verification time.',
);
mustMatch(
  systemHealth,
  /oldestCached/,
  'Critical Integrations must expose the oldest cached result when hourly checks are using cache.',
);
mustMatch(
  healthUi,
  /data-critical-integrations-card/,
  'System Health UI must render the Critical Integrations summary card.',
);
mustMatch(
  healthUi,
  /data-critical-integrations-oldest-cache/,
  'Critical Integrations UI must display the oldest cached result.',
);
mustMatch(
  systemHealth,
  /deployments\/releases\/by-id\//,
  'Each production release must have a durable per-deploy audit record outside the rolling release list.',
);
mustMatch(
  systemHealth,
  /syntheticProbeVerification/,
  'Production release records must carry the four-probe verification evidence.',
);
mustMatch(
  postDeployVerification,
  /syntheticProbeReleaseVerification\(current,'post-deploy-scheduled'\)/,
  'Scheduled post-deploy verification must archive the four synthetic probes with the release.',
);
mustMatch(
  postDeployVerification,
  /accountingVerification=productionAccountingVerification\(current\)/,
  'Scheduled post-deploy verification must archive accounting evidence from the same health snapshot.',
);
mustMatch(
  githubHealthSignal,
  /deploymentSyncCheck\?\.deploymentDetails\?\.netlifyDeployId/,
  'Signed production QA must resolve the immutable Netlify deploy id from the live deployment health check when runtime DEPLOY_ID is unavailable.',
);
mustMatch(
  githubHealthSignal,
  /releaseRecord\?\.accountingVerification\?\.checkedAt===health\.checkedAt/,
  'Signed production QA must only report the release audit as recorded when probe and accounting evidence came from the same health run.',
);
mustMatch(
  githubHealthSignal,
  /recordProductionRelease\(context,/,
  'Signed production QA must persist the live four-probe release audit before reporting success.',
);
mustMatch(
  postDeployVerification,
  /deploymentSyncCheck\?\.deploymentDetails\?\.netlifyDeployId/,
  'Scheduled post-deploy verification must also resolve release identity from live deployment evidence.',
);
mustMatch(
  githubHealthSignal,
  /rollbackFailedProductionRelease/,
  'Signed production QA must invoke the automatic rollback guard when release-critical probes fail.',
);
mustMatch(
  systemHealth,
  /\/deploys\/'\+encodeURIComponent\(target\.deployId\)\+'\/restore'/,
  'Automatic rollback must restore the last production deploy whose four-probe audit passed.',
);
mustMatch(
  productionQa,
  /auditRecorded/,
  'Production QA must fail if the per-release synthetic probe audit could not be persisted.',
);
mustMatch(
  productionQa,
  /http_status=/,
  'Production QA must capture a failing verification response so rollback evidence remains visible before CI fails.',
);
mustMatch(systemHealth,/export async function rollbackReadySummary/,'System Health must expose the exact last-known-good rollback target.');
mustMatch(systemHealth,/targetAgeSeconds/,'Rollback Ready must expose the age of the selected known-good release.');
mustMatch(systemHealth,/accountingStatus/,'Rollback Ready must expose the selected release accounting invariant status.');
mustMatch(systemHealth,/accountingVerification:input\?\.accountingVerification/,'Production release audits must persist same-release accounting evidence.');
mustMatch(systemHealth,/PRODUCTION_RELEASE_AUDIT_INDEX_KEY='deployments\/releases\/audit-index'/,'Critical Integrations must maintain an uncapped release-audit index for complete exports.');
mustMatch(systemHealth,/export async function readAllProductionReleaseAudits/,'Critical Integrations must enumerate durable per-deploy audit records.');
mustMatch(systemHealth,/selectRollbackTargetFromReleases\(releases,deployId\)/,'Production rollback and rollback readiness must share the same target-selection algorithm.');
mustMatch(githubHealthSignal,/accountingVerification/,'Signed release verification must persist QuickBooks accounting evidence with the same production release audit.');
mustMatch(githubHealthSignal,/run-real-sandbox-rollback-drill/,'GitHub OIDC health signal must expose the isolated real Netlify rollback drill.');
mustMatch(githubHealthSignal,/KOA_ROLLBACK_DRILL_SANDBOX_SITE_ID/,'Real rollback drills must target an explicitly configured sandbox site id.');
mustMatch(githubHealthSignal,/sandboxSiteId===productionSiteId/,'Real rollback drills must block any attempt to target the production site.');
mustMatch(githubHealthSignal,/koasevents-rollback-drill-sandbox/,'Real rollback drills must verify the dedicated sandbox site name.');
mustMatch(githubHealthSignal,/\/restore'/,'Real sandbox drill must exercise Netlify restore infrastructure.');
mustMatch(adminHealth,/searchParams\.get\('export'\)==='critical-integrations'/,'System Health API must expose a Critical Integrations audit export.');
mustMatch(adminHealth,/criticalIntegrationAuditFilters/,'Critical Integrations export must parse date, integration, failure, and rollback filters.');
mustMatch(adminHealth,/filterCriticalIntegrationAudits/,'Critical Integrations export must apply the selected filters before serialization.');
mustMatch(adminHealth,/text\/csv; charset=utf-8/,'Critical Integrations audit export must support CSV.');
mustMatch(adminHealth,/application\/json; charset=utf-8/,'Critical Integrations audit export must support JSON.');
mustMatch(healthUi,/data-critical-integrations-rollback-status/,'Critical Integrations UI must show a Rollback Ready indicator.');
mustMatch(healthUi,/data-critical-integrations-rollback-target/,'Critical Integrations UI must show the exact rollback deploy and commit.');
mustMatch(healthUi,/data-critical-integrations-rollback-age/,'Rollback Ready UI must show the known-good release age.');
mustMatch(healthUi,/data-critical-integrations-rollback-accounting/,'Rollback Ready UI must show whether QuickBooks invariants passed at release verification.');
mustMatch(healthUi,/data-critical-integrations-export-from/,'Critical Integrations UI must expose a start-date export filter.');
mustMatch(healthUi,/data-critical-integrations-export-to/,'Critical Integrations UI must expose an end-date export filter.');
mustMatch(healthUi,/data-critical-integrations-export-integration/,'Critical Integrations UI must expose an integration export filter.');
mustMatch(healthUi,/data-critical-integrations-export-failed/,'Critical Integrations UI must expose failed-release filtering.');
mustMatch(healthUi,/data-critical-integrations-export-rollback/,'Critical Integrations UI must expose rollback-event filtering.');
mustMatch(releaseGuard,/environment === 'production'/,'Rollback drill state machine must refuse production.');
mustMatch(systemHealth,/Critical Integrations rollback drill is blocked in production/,'Server-side preview rollback drill must be hard-blocked in production.');
mustMatch(adminHealth,/run-critical-integrations-rollback-drill/,'System Health admin API must expose the safe non-production rollback simulation.');
mustMatch(rollbackDrillScript,/\['detection','failed-audit','rollback','recovery'\]/,'Rollback drill regression must assert the complete detection-to-recovery sequence.');
mustMatch(rollbackDrillScript,/productionMutationAttempted,false/,'Rollback drill regression must prove no production mutation was attempted.');
mustMatch(rollbackDrillWorkflow,/pull_request:/,'Rollback drill workflow must run the simulated drill in PR CI.');
mustMatch(rollbackDrillWorkflow,/push:/,'Rollback drill workflow must run the real isolated infrastructure drill after main changes.');
mustMatch(rollbackDrillWorkflow,/id-token: write/,'Real sandbox rollback drill must use signed GitHub OIDC rather than a repository Netlify token.');
mustMatch(rollbackDrillWorkflow,/run-real-sandbox-rollback-drill/,'Post-merge rollback drill must invoke the real isolated Netlify restore action.');
mustMatch(rollbackDrillWorkflow,/productionMutationAttempted/,'Real sandbox rollback workflow must assert that production was not mutated.');
mustMatch(rollbackDrillWorkflow,/sandboxSiteName/,'Real sandbox rollback workflow must assert the expected dedicated site identity.');

// This gate intentionally validates the shared protocol contract rather than making network calls.
console.log(
  'Synthetic health protocol regression passed: request headers, payload markers, response markers, HTTP 204 expectations, and diagnostics are synchronized.',
);
