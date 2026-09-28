import { tenantByHost, tenantById, tenantProfiles, type TenantProfile } from '../../../src/data/tenants';

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
  };
}

export function tenantStoragePrefix(tenant: TenantProfile) {
  return 'tenants/' + tenant.id;
}
