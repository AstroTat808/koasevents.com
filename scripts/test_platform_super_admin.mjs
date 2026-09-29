import assert from 'node:assert/strict';
import fs from 'node:fs';

const api=fs.readFileSync('netlify/functions/admin-platform.mts','utf8');
const org=fs.readFileSync('netlify/functions/_shared/organization.ts','utf8');
const page=fs.readFileSync('src/pages/admin/platform/index.astro','utf8');

assert.match(api,/VENUELOOM_SUPER_ADMIN_EMAILS/,'platform access must be explicitly allowlisted');
assert.match(api,/createPlatformSupportSession/,'support sessions must use control-plane audit storage');
assert.match(api,/readOnly:true/,'support mode must remain read-only');
assert.match(api,/ttlMinutes/,'support sessions must expire');
assert.match(api,/tenantMigrationAudit/,'platform detail must expose migration safety');
assert.match(api,/create-sandbox-tenant/,'safe Tenant #2 sandbox provisioning is required');
assert.match(api,/legacyCompatibility:false/,'sandbox safety response must confirm tenant-native storage');
assert.match(api,/syntheticStripe:true/,'sandbox provisioning must use synthetic billing rather than live Stripe');
assert.match(api,/run-tenant-isolation-test/,'platform admin must expose the Tenant #2 leakage test');
assert.match(api,/run-tenant-onboarding-test/,'platform admin must expose the Tenant #2 onboarding E2E');
assert.match(api,/run-migration-audit/,'platform admin must expose deep migration audits');
assert.match(org,/support-sessions\/history/,'support sessions must be auditable');
assert.match(org,/expiresAt/,'support sessions must have an expiry');
assert.match(page,/Read-only support mode/,'UI must clearly identify support impersonation as read-only');
assert.match(page,/Ensure Tenant #2 sandbox/,'UI must expose deterministic isolated Tenant #2 provisioning');
assert.match(page,/Run leakage test/,'UI must expose runtime cross-tenant leakage testing');
assert.match(page,/Run onboarding E2E/,'UI must expose the safe onboarding journey');
assert.doesNotMatch(api,/@netlify\/blobs/,'platform function must not bypass the control-plane/storage abstractions');

console.log('VenueLoom Super Admin regression test passed.');