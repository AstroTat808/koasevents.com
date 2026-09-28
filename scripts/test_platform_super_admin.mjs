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
assert.match(api,/stripeCheckoutStarted:false/,'sandbox provisioning must not start billing');
assert.match(org,/support-sessions\/history/,'support sessions must be auditable');
assert.match(org,/expiresAt/,'support sessions must have an expiry');
assert.match(page,/Read-only support mode/,'UI must clearly identify support impersonation as read-only');
assert.match(page,/Create safe sandbox tenant/,'UI must expose isolated Tenant #2 provisioning');
assert.doesNotMatch(api,/@netlify\/blobs/,'platform function must not bypass the control-plane/storage abstractions');

console.log('VenueLoom Super Admin regression test passed.');