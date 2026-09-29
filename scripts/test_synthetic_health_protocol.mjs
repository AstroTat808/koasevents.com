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
] = await Promise.all([
  read('netlify/functions/_shared/system-health.ts'),
  read('netlify/functions/_shared/synthetic-health.ts'),
  read('netlify/functions/admin-event-documents.mts'),
  read('netlify/functions/vendor-insurance-document.mts'),
  read('netlify/functions/quickbooks-webhook.mts'),
  read('netlify/functions/signwell-webhook.mts'),
  read('src/pages/admin/health/index.astro'),
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

// This gate intentionally validates the shared protocol contract rather than making network calls.
console.log(
  'Synthetic health protocol regression passed: request headers, payload markers, response markers, HTTP 204 expectations, and diagnostics are synchronized.',
);
