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
  productionQa,
  /dynamicClientStatus/,
  'Production QA must require the dynamic accepted/booked client invariant status.',
);
mustMatch(
  githubHealthSignal,
  /dynamicClientFailedCount/,
  'Signed production verification must expose dynamic client invariant failures.',
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
  githubHealthSignal,
  /deploymentSyncCheck\?\.deploymentDetails\?\.netlifyDeployId/,
  'Signed production QA must resolve the immutable Netlify deploy id from the live deployment health check when runtime DEPLOY_ID is unavailable.',
);
mustMatch(
  githubHealthSignal,
  /auditRecorded=Boolean\(releaseRecord\?\.deployId\)/,
  'Signed production QA must only report the release audit as recorded when a deploy-keyed record was actually written.',
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

// This gate intentionally validates the shared protocol contract rather than making network calls.
console.log(
  'Synthetic health protocol regression passed: request headers, payload markers, response markers, HTTP 204 expectations, and diagnostics are synchronized.',
);
