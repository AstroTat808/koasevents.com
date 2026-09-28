import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeTenantRows,
  stampTenantId,
  tenantDataKey,
  tenantDataPrefix,
  tenantOwnsRecord,
} from '../netlify/functions/_shared/tenant-boundary.mjs';

const root=process.cwd();
const tenantA={id:'tenant-a',storage:{legacyDataBelongsToTenant:false}};
const tenantB={id:'tenant-b',storage:{legacyDataBelongsToTenant:false}};
const legacyKoa={id:'koa-events',storage:{legacyDataBelongsToTenant:true}};

assert.notEqual(tenantDataPrefix(tenantA,'sales'),tenantDataPrefix(tenantB,'sales'));
assert.equal(tenantDataKey(tenantA,'sales','records/index'),'tenants/tenant-a/sales/records/index');
assert.equal(tenantDataKey(tenantB,'sales','records/index'),'tenants/tenant-b/sales/records/index');

assert.deepEqual(stampTenantId(tenantA,{id:'A1'}),{id:'A1',tenantId:'tenant-a'});
assert.throws(()=>stampTenantId(tenantA,{id:'B1',tenantId:'tenant-b'}),/Cross-tenant/);
assert.equal(tenantOwnsRecord(tenantA,{id:'A1',tenantId:'tenant-a'}),true);
assert.equal(tenantOwnsRecord(tenantA,{id:'B1',tenantId:'tenant-b'}),false);
assert.equal(tenantOwnsRecord(tenantA,{id:'legacy'}),false);
assert.equal(tenantOwnsRecord(legacyKoa,{id:'legacy'}),true);

const isolated=normalizeTenantRows(tenantA,[
  {id:'A1',tenantId:'tenant-a'},
  {id:'B1',tenantId:'tenant-b'},
  {id:'legacy'},
]);
assert.deepEqual(isolated.rows,[{id:'A1',tenantId:'tenant-a'}]);
assert.equal(isolated.rejected,2);

const koaMigrated=normalizeTenantRows(legacyKoa,[{id:'legacy'}]);
assert.deepEqual(koaMigrated.rows,[{id:'legacy',tenantId:'koa-events'}]);
assert.equal(koaMigrated.changed,true);
assert.equal(koaMigrated.rejected,0);

const requestedIsolationScenarios = [
  ['Business CRM','crm','clients/index'],
  ['Sales CRM','sales','records/index'],
  ['Events','eventOps','events/index'],
  ['Vendors','vendors','vendors/index'],
  ['Documents','eventFiles','events/EVT-1/contract.pdf'],
  ['Quotes','quotes','quotes/index'],
  ['QuickBooks','integrations','quickbooks/connection'],
  ['SignWell','integrations','signwell/connection'],
  ['Client portal','sales','records/CLIENT-1'],
  ['Vendor portal','vendorFiles','vendors/VENDOR-1/insurance.pdf'],
];

for (const [label,domain,key] of requestedIsolationScenarios) {
  const aKey=tenantDataKey(tenantA,domain,key);
  const bKey=tenantDataKey(tenantB,domain,key);
  assert.notEqual(aKey,bKey,label+' must use distinct canonical keys per tenant');
  assert.ok(aKey.startsWith('tenants/tenant-a/'+domain+'/'),label+' Tenant A key must stay in Tenant A namespace');
  assert.ok(bKey.startsWith('tenants/tenant-b/'+domain+'/'),label+' Tenant B key must stay in Tenant B namespace');

  const ownedA=stampTenantId(tenantA,{id:label+'-A'});
  assert.equal(tenantOwnsRecord(tenantA,ownedA),true,label+' Tenant A owns its record');
  assert.equal(tenantOwnsRecord(tenantB,ownedA),false,label+' Tenant B cannot own Tenant A record');
  assert.throws(()=>stampTenantId(tenantB,ownedA),/Cross-tenant record access was blocked/,label+' cross-tenant mutation must be rejected');

  const filtered=normalizeTenantRows(tenantB,[ownedA,{id:label+'-B',tenantId:'tenant-b'}]);
  assert.deepEqual(filtered.rows,[{id:label+'-B',tenantId:'tenant-b'}],label+' cross-tenant read must filter Tenant A');
  assert.equal(filtered.rejected,1,label+' must report the rejected foreign row');
}

function walk(dir){
  const rows=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())rows.push(...walk(full));
    else if(/\.(?:ts|mts|js|mjs)$/.test(entry.name))rows.push(full);
  }
  return rows;
}
function rel(file){return path.relative(root,file).split(path.sep).join('/');}
function source(file){return fs.readFileSync(path.join(root,file),'utf8');}

const functionFiles=walk(path.join(root,'netlify/functions'));
const blobImports=functionFiles
  .filter((file)=>source(rel(file)).includes("@netlify/blobs"))
  .map(rel)
  .sort();
assert.deepEqual(blobImports,[
  'netlify/functions/_shared/organization.ts',
  'netlify/functions/_shared/tenant-storage.ts',
]);

const tenantStoreModules=[
  'netlify/functions/admin-crm.mts',
  'netlify/functions/crm-inquiries.mts',
  'netlify/functions/crm-events.mts',
  'netlify/functions/admin-events.mts',
  'netlify/functions/admin-vendors.mts',
  'netlify/functions/admin-event-documents.mts',
  'netlify/functions/admin-quotes.mts',
  'netlify/functions/_shared/quickbooks.ts',
  'netlify/functions/quickbooks-webhook.mts',
  'netlify/functions/quickbooks-hourly-reconciliation.mts',
  'netlify/functions/_shared/signwell.ts',
  'netlify/functions/signwell-webhook.mts',
  'netlify/functions/public-client-portal.mts',
  'netlify/functions/vendor-portal.mts',
];
for(const file of tenantStoreModules){
  assert.match(source(file),/tenantStoreFor\s*\(/,file+' must use tenantStoreFor');
}

const dynamicPublicRoutes=[
  'netlify/functions/crm-inquiries.mts',
  'netlify/functions/crm-events.mts',
  'netlify/functions/public-bookings.mts',
  'netlify/functions/public-client-contract.mts',
  'netlify/functions/public-client-portal.mts',
  'netlify/functions/public-planning-documents.mts',
  'netlify/functions/public-planning.mts',
  'netlify/functions/public-proposals.mts',
  'netlify/functions/vendor-portal.mts',
];
for(const file of dynamicPublicRoutes){
  const text=source(file);
  assert.match(text,/resolveTenantAsync\s*\(/,file+' must resolve dynamic organizations');
  assert.match(text,/runWithTenant\s*\(/,file+' must bind the resolved tenant for nested services');
}

const adminSource=source('netlify/functions/_shared/admin.ts');
assert.match(adminSource,/resolveTenantAsync\s*\(/,'admin auth must resolve dynamic organizations');
assert.match(adminSource,/runWithTenant\s*\(/,'admin auth must bind tenant before security and membership reads');

const storageSource=source('netlify/functions/_shared/tenant-storage.ts');
assert.match(storageSource,/tenantDataPrefix\(tenant, domain\)/);
assert.match(storageSource,/Cross-tenant data access was blocked\./);
assert.match(storageSource,/legacyDataBelongsToTenant/);

const scheduledTenantJobs=[
  'netlify/functions/lead-response-reminders.mts',
  'netlify/functions/quickbooks-hourly-reconciliation.mts',
  'netlify/functions/health-monitor.mts',
  'netlify/functions/office365-calendar-sync.mts',
  'netlify/functions/vendor-insurance-reminders.mts',
  'netlify/functions/post-deploy-verification.mts',
  'netlify/functions/review-requests.mts',
  'netlify/functions/crm-lifecycle.mts',
];
for(const file of scheduledTenantJobs){
  const text=source(file);
  assert.match(text,/runForEachTenant\s*\(/,file+' must iterate active tenants');
  assert.match(text,/schedule\s*:/,file+' must remain a scheduled function');
}

const quickBooksWebhook=source('netlify/functions/quickbooks-webhook.mts');
assert.match(quickBooksWebhook,/resolveQuickBooksWebhookTenant\s*\(/,'QuickBooks webhook must resolve tenant from realm + verifier');
assert.match(quickBooksWebhook,/runWithTenant\s*\(/,'QuickBooks webhook must bind the resolved tenant');

const resendWebhook=source('netlify/functions/resend-webhook.mts');
assert.match(resendWebhook,/resolveTenantAsync\s*\(/,'Resend webhook must resolve tenant from its endpoint host');
assert.match(resendWebhook,/runWithTenant\s*\(/,'Resend webhook must bind tenant before signature verification and CRM writes');
assert.match(resendWebhook,/tenantEnv\(resolveTenant\(\),'RESEND_WEBHOOK_SECRET'\)/,'Resend webhook must use the tenant signing secret');

const signWellSource=source('netlify/functions/_shared/signwell.ts');
assert.match(signWellSource,/metadata:\{tenant_id:resolveTenant\(\)\.id,/, 'SignWell documents must carry tenant_id metadata');
const signWellWebhook=source('netlify/functions/signwell-webhook.mts');
assert.match(signWellWebhook,/payloadTenantId\s*\(/, 'SignWell webhook must resolve tenant from signed document metadata');
assert.match(signWellWebhook,/readOrganizationById\s*\(/, 'SignWell webhook must resolve dynamic organizations');
assert.match(signWellWebhook,/runWithTenant\s*\(/, 'SignWell webhook must bind tenant before verification and storage access');

const orgApi=source('netlify/functions/admin-organization.mts');
for(const invariant of [
  /action === 'create-organization'/,
  /action === 'verify-domain'/,
  /action === 'validate-catalog-import'/,
  /action === 'save-integration'/,
  /action === 'create-subscription-checkout'/,
]) {
  assert.match(orgApi,invariant,'Organization onboarding capability is missing: '+String(invariant));
}
const stripeWebhook=source('netlify/functions/stripe-webhook.mts');
assert.match(stripeWebhook,/tenant_id/, 'Stripe events must carry tenant_id metadata');
assert.match(stripeWebhook,/readOrganizationById\s*\(/, 'Stripe webhook must resolve the organization from signed tenant metadata');
assert.match(stripeWebhook,/verifyStripeSignature\s*\(/, 'Stripe webhook must verify the platform billing signature before organization updates');
assert.match(source('netlify/functions/_shared/tenant-env.ts'),/VENUELOOM_TENANT_/, 'Integration credentials must support tenant-scoped environment keys');

console.log('Tenant isolation QA passed: production boundary primitives, storage imports, scheduled jobs, webhooks, and onboarding contracts are isolated.');
