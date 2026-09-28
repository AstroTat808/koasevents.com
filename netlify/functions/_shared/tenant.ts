import { tenantByHost, tenantById, tenantProfiles, type TenantProfile } from '../../../src/data/tenants';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context } from '@netlify/functions';
import { listOrganizations, profileFromOrganization, readOrganizationByHost, readOrganizationById } from './organization';

const tenantScope = new AsyncLocalStorage<TenantProfile>();

export function runWithTenant<T>(tenant: TenantProfile, operation: () => T): T {
  return tenantScope.run(tenant, operation);
}

export function scopedTenant() {
  return tenantScope.getStore() || null;
}

function clean(value: unknown, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function requestHost(req?: Request) {
  if (!req) return '';
  try {
    return new URL(req.url).host;
  } catch {
    return clean(req.headers.get('host'), 240);
  }
}

export function resolveTenant(req?: Request): TenantProfile {
  const scoped = scopedTenant();
  if (scoped) return scoped;
  const configuredId = clean(Netlify.env.get('VENUELOOM_DEFAULT_TENANT_ID'), 120);
  if (configuredId) {
    const configured = tenantById(configuredId);
    if (!configured) throw new Error('Configured VenueLoom tenant was not found: ' + configuredId);
    return configured;
  }

  const byHost = tenantByHost(requestHost(req));
  if (byHost) return byHost;

  if (tenantProfiles.length === 1) return tenantProfiles[0];
  throw new Error('Unable to resolve VenueLoom tenant for this request.');
}

export function tenantTaxDefaults(tenant: TenantProfile) {
  return {
    enabled: tenant.tax.enabled,
    label: tenant.tax.label,
    statutoryRate: tenant.tax.statutoryRate,
    customerRate: tenant.tax.customerRate,
    maxPassOnRate: tenant.tax.maxPassOnRate,
  };
}

export function clientTenantProfile(tenant: TenantProfile) {
  return {
    id: tenant.id,
    slug: tenant.slug,
    displayName: tenant.displayName,
    locale: tenant.locale,
    currency: tenant.currency,
    timezone: tenant.timezone,
    domains: tenant.domains,
    tax: tenant.tax,
    accounting: tenant.accounting,
  };
}

export function tenantStoragePrefix(tenant: TenantProfile) {
  return 'tenants/' + tenant.id;
}

export function tenantBlobStoreName(tenant: TenantProfile, kind: 'sales' | 'integrations') {
  return tenant.storage.compatibilityBlobStores[kind];
}


export async function resolveTenantAsync(req?: Request, context?: Context): Promise<TenantProfile> {
  const scoped = scopedTenant();
  if (scoped) return scoped;
  let queryTenant = '';
  try { queryTenant = clean(req ? new URL(req.url).searchParams.get('tenant') : '', 120); } catch {}
  const requestedId = clean(req?.headers.get('x-venueloom-tenant') || queryTenant, 120);
  if (requestedId) {
    const staticTenant = tenantById(requestedId);
    if (staticTenant) return staticTenant;
    const dynamic = await readOrganizationById(context, requestedId);
    if (dynamic) return profileFromOrganization(dynamic);
  }

  const host = requestHost(req);
  const staticByHost = tenantByHost(host);
  if (staticByHost) return staticByHost;
  const dynamicByHost = await readOrganizationByHost(context, host);
  if (dynamicByHost) return profileFromOrganization(dynamicByHost);

  const configuredId = clean(Netlify.env.get('VENUELOOM_DEFAULT_TENANT_ID'), 120);
  if (configuredId) {
    const configured = tenantById(configuredId);
    if (configured) return configured;
    const dynamic = await readOrganizationById(context, configuredId);
    if (dynamic) return profileFromOrganization(dynamic);
    throw new Error('Configured VenueLoom tenant was not found: ' + configuredId);
  }

  if (tenantProfiles.length === 1) return tenantProfiles[0];
  throw new Error('Unable to resolve VenueLoom tenant for this request.');
}


export async function listActiveTenantProfiles(context?: Context) {
  const byId = new Map<string,TenantProfile>();
  for (const tenant of tenantProfiles) byId.set(tenant.id, tenant);

  const organizations = await listOrganizations(context).catch(() => []);
  for (const row of organizations) {
    if (byId.has(row.id)) continue;
    const organization = await readOrganizationById(context, row.id).catch(() => null);
    if (!organization || ['suspended','canceled'].includes(organization.status)) continue;
    byId.set(organization.id, profileFromOrganization(organization));
  }
  return [...byId.values()];
}

export async function runForEachTenant<T>(
  context: Context | undefined,
  operation: (tenant: TenantProfile) => Promise<T>,
) {
  const tenants = await listActiveTenantProfiles(context);
  const results: Array<{tenantId:string;ok:boolean;value?:T;error?:string}> = [];
  for (const tenant of tenants) {
    try {
      const value = await runWithTenant(tenant, () => operation(tenant));
      results.push({ tenantId:tenant.id, ok:true, value });
    } catch (error) {
      results.push({
        tenantId:tenant.id,
        ok:false,
        error:error instanceof Error ? error.message : 'Tenant job failed.',
      });
    }
  }
  return results;
}
