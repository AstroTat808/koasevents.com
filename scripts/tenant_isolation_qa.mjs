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

const storageSource=source('netlify/functions/_shared/tenant-storage.ts');
assert.match(storageSource,/tenantDataPrefix\(tenant, domain\)/);
assert.match(storageSource,/Cross-tenant data access was blocked\./);
assert.match(storageSource,/legacyDataBelongsToTenant/);

console.log('Tenant isolation QA passed: production boundary primitives, storage imports, and critical module contracts are isolated.');
