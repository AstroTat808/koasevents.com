import fs from 'node:fs';

const surfaces = [
  'netlify/functions/admin-crm.mts',
  'netlify/functions/crm-inquiries.mts',
  'netlify/functions/crm-events.mts',
  'netlify/functions/crm-lifecycle.mts',
  'netlify/functions/admin-events.mts',
  'netlify/functions/admin-vendors.mts',
  'netlify/functions/admin-event-documents.mts',
  'netlify/functions/admin-quotes.mts',
  'netlify/functions/quotes.mts',
  'netlify/functions/admin-quickbooks.mts',
  'netlify/functions/quickbooks-hourly-reconciliation.mts',
  'netlify/functions/quickbooks-webhook.mts',
  'netlify/functions/signwell-webhook.mts',
  'netlify/functions/public-bookings.mts',
  'netlify/functions/public-client-contract.mts',
  'netlify/functions/public-client-portal.mts',
  'netlify/functions/public-planning-documents.mts',
  'netlify/functions/public-planning.mts',
  'netlify/functions/public-proposals.mts',
  'netlify/functions/vendor-event-brief.mts',
  'netlify/functions/vendor-insurance-document.mts',
  'netlify/functions/vendor-marketplace.mts',
  'netlify/functions/vendor-portal.mts',
  'netlify/functions/bartender-portal.mts',
  'netlify/functions/resend-webhook.mts',
];

const legacyStorePattern = /\bkoa-(?:sales|quotes|integrations|crm|event-ops|vendors|event-files|vendor-files|email-analytics|email-routing|auth-security|staff-directory|staff-files|staff-availability|security|system-health|workspace-alerts)\b/;
const failures = [];

for (const file of surfaces) {
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes('@netlify/blobs')) failures.push(file + ': imports @netlify/blobs directly');
  if (/\bgetStore\s*\(|\bgetDeployStore\s*\(/.test(text)) failures.push(file + ': opens a Blob store directly');
  if (legacyStorePattern.test(text)) failures.push(file + ': contains a legacy tenant store literal');
  if (!text.includes('tenantStoreFor(')) failures.push(file + ': does not use tenantStoreFor');
}

const storage = fs.readFileSync('netlify/functions/_shared/tenant-storage.ts','utf8');
const storageAssertions = [
  [storage.includes("from './tenant-boundary.mjs'"), 'tenant storage must delegate pure ownership/key logic to tenant-boundary'],
  [storage.includes('tenantDataPrefix'), 'tenant storage must use canonical tenant prefixes'],
  [storage.includes('normalizeTenantRows'), 'tenant storage must normalize tenant-owned rows'],
  [storage.includes('stampTenantId'), 'tenant storage must stamp tenant ownership'],
  [storage.includes('Cross-tenant data access was blocked.'), 'cross-tenant JSON access must still be rejected at the storage boundary'],
];
for (const [ok,message] of storageAssertions) if (!ok) failures.push('tenant-storage: ' + message);

const migration = fs.readFileSync('migrations/001_venueloom_multitenant_foundation.sql','utf8');
for (const table of ['memberships','tenant_records','tenant_documents','integration_connections','integration_mappings']) {
  if (!migration.includes('alter table ' + table + ' enable row level security')) {
    failures.push('migration: RLS not enabled for ' + table);
  }
  if (!migration.includes(table + '_tenant_isolation')) {
    failures.push('migration: tenant isolation policy missing for ' + table);
  }
}
if (!migration.includes("current_setting('app.tenant_id',true)")) failures.push('migration: app.tenant_id session boundary missing');

if (failures.length) {
  console.error('Tenant isolation regression test failed:');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}

console.log('Tenant isolation regression test passed for ' + surfaces.length + ' protected surfaces.');
console.log('Canonical namespace, record ownership, and PostgreSQL RLS invariants are present.');
