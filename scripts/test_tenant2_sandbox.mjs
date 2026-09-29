import assert from 'node:assert/strict';
import fs from 'node:fs';

const helper=fs.readFileSync('netlify/functions/_shared/tenant-sandbox-qa.ts','utf8');
const platform=fs.readFileSync('netlify/functions/admin-platform.mts','utf8');
const storage=fs.readFileSync('netlify/functions/_shared/tenant-storage.ts','utf8');
const dashboard=fs.readFileSync('src/pages/admin/platform/migrations/index.astro','utf8');
const runner=fs.readFileSync('netlify/functions/internal-tenant2-runtime-runner.mts','utf8');

for(const invariant of [
  /vl-sandbox-tenant-2/,
  /TENANT2_ONLY/,
  /koaReadWasNull/,
  /crossTenantWriteBlocked/,
  /getQuickBooksConnection/,
  /signWellConfiguration/,
  /RESEND_API_KEY/,
  /resolveTenantAsync/,
  /runForEachTenant/,
  /koaInventoryUnchanged/,
  /tenant2-sandbox\.venueloom\.invalid/,
  /sandbox_subscription_/,
  /VL-SANDBOX-PROPOSAL-001/,
  /post-onboarding-isolation/,
]) {
  assert.match(helper,invariant,'Tenant #2 runtime QA invariant is missing: '+String(invariant));
}

assert.match(helper,/enabled:false/,'Sandbox integrations must stay disabled.');
assert.match(helper,/syntheticBilling:true/,'Sandbox must identify synthetic platform billing.');
assert.match(helper,/syntheticDomainVerification:true/,'Sandbox must identify synthetic DNS verification.');
assert.doesNotMatch(helper,/fetch\s*\(\s*['"]https:\/\/api\.stripe\.com/,'Sandbox QA must not call Stripe.');
assert.doesNotMatch(helper,/fetch\s*\(\s*['"]https:\/\/.*quickbooks/i,'Sandbox QA must not call QuickBooks directly.');
assert.doesNotMatch(helper,/fetch\s*\(\s*['"]https:\/\/.*signwell/i,'Sandbox QA must not call SignWell directly.');

for(const invariant of [
  /run-tenant-isolation-test/,
  /run-tenant-onboarding-test/,
  /run-migration-audit/,
  /ensureTenant2Sandbox/,
  /readPlatformTenantTestReport/,
]) {
  assert.match(platform,invariant,'Super Admin runtime test action missing: '+String(invariant));
}

for(const invariant of [
  /logicalObjectFingerprint/,
  /fullChecksumMismatchCount/,
  /legacyInventoryHash/,
  /canonicalInventoryHash/,
  /evidenceLevel/,
]) {
  assert.match(storage,invariant,'Deep migration checksum invariant missing: '+String(invariant));
}

for(const invariant of [
  /Migration Dashboard/,
  /Run full checksum audit/,
  /Legacy store/,
  /Safe since/,
  /Checksum mismatches/,
]) {
  assert.match(dashboard,invariant,'Migration dashboard invariant missing: '+String(invariant));
}

console.log('VenueLoom Tenant #2 sandbox, leakage-test, onboarding and migration-dashboard contracts are present.');


assert.match(runner,/VENUELOOM_TENANT2_RUNNER_TOKEN_SHA256/,'Temporary production runner must require a hashed secret token.');
assert.match(runner,/timingSafeEqual/,'Temporary production runner token comparison must be timing safe.');
assert.match(runner,/context\.deploy\.context!=='production'/,'Runtime runner must refuse non-production contexts.');
assert.match(runner,/mode==='isolation'/,'Runtime runner must expose the isolation probe.');
assert.match(runner,/mode==='onboarding'/,'Runtime runner must expose the onboarding probe.');
assert.match(runner,/mode==='migration'/,'Runtime runner must expose the full migration audit.');
assert.doesNotMatch(runner,/VENUELOOM_TENANT2_RUNNER_TOKEN_SHA256\s*=\s*['"]/,'Runner secret must never be committed.');
