import { koaEventsTenantProfile } from './koa-events.ts';
import type { TenantProfile } from './types.ts';

export type { TenantProfile, TenantTaxProfile, TenantCatalogConfig, TenantCatalogSeedItem, TenantCatalogPlacementRule } from './types.ts';

export const tenantProfiles: TenantProfile[] = [
  koaEventsTenantProfile,
];

export function tenantById(id: string) {
  const key = String(id || '').trim().toLowerCase();
  return tenantProfiles.find((tenant) => tenant.id.toLowerCase() === key || tenant.slug.toLowerCase() === key) || null;
}

export function tenantByHost(host: string) {
  const normalized = String(host || '').trim().toLowerCase().replace(/^www\./, '').split(':')[0];
  if (!normalized) return null;
  return tenantProfiles.find((tenant) => {
    const domains = [tenant.domains.primary, tenant.domains.admin]
      .map((value) => String(value || '').trim().toLowerCase().replace(/^www\./, ''))
      .filter(Boolean);
    return domains.includes(normalized);
  }) || null;
}
