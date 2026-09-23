export type VenueLoomBusinessUnit = {
  id: string;
  name: string;
  sourcePrefixes?: string[];
};

export type VenueLoomTenantConfig = {
  id: string;
  slug: string;
  displayName: string;
  platformName: 'VenueLoom';
  hosts: string[];
  timezone: {
    iana: string;
    microsoft: string;
    utcOffset: string;
  };
  legacyStores: {
    sales: string;
    eventOps: string;
    calendarSync: string;
    authSecurity: string;
  };
  integrations: {
    microsoft365: {
      recordMarkerPrefix: string;
      defaultCalendarOwner: string;
      defaultCalendarName: string;
      syncBodyLabel: string;
    };
  };
  businessUnits: VenueLoomBusinessUnit[];
};

/**
 * VenueLoom Tenant #1.
 *
 * This object deliberately preserves every Koa production default. The first
 * productization phase is compatibility-first: code reads formerly hard-coded
 * values from this tenant object without changing behavior, storage names,
 * identifiers, calendar markers, or integrations.
 */
export const KOA_TENANT: VenueLoomTenantConfig = {
  id: 'tenant_koa_events',
  slug: 'koa',
  displayName: 'Koa’s Events',
  platformName: 'VenueLoom',
  hosts: ['koasevents.com', 'www.koasevents.com'],
  timezone: {
    iana: 'Pacific/Honolulu',
    microsoft: 'Hawaiian Standard Time',
    utcOffset: '-10:00',
  },
  legacyStores: {
    sales: 'koa-sales',
    eventOps: 'koa-event-ops',
    calendarSync: 'koa-calendar-sync',
    authSecurity: 'koa-auth-security',
  },
  integrations: {
    microsoft365: {
      recordMarkerPrefix: 'KOA_RECORD_ID:',
      defaultCalendarOwner: 'chris@koas.us',
      defaultCalendarName: "Koa's Events",
      syncBodyLabel: 'Synced with Koa’s Master Calendar.',
    },
  },
  businessUnits: [
    { id: 'events', name: 'Koa’s Events' },
    { id: 'mobile-bar', name: 'Koa’s Mobile Bar', sourcePrefixes: ['koa-mobile-bar-'] },
    { id: 'wild-ones', name: 'Wild Ones', sourcePrefixes: ['wild-ones-'] },
  ],
};

export const DEFAULT_TENANT_ID = KOA_TENANT.id;

const TENANTS = new Map<string, VenueLoomTenantConfig>([
  [KOA_TENANT.id, KOA_TENANT],
]);

export function tenantConfigById(id = DEFAULT_TENANT_ID) {
  return TENANTS.get(id) || KOA_TENANT;
}

export function resolveTenantFromHost(hostname: string | null | undefined) {
  const host = String(hostname || '').trim().toLowerCase().split(':')[0];
  for (const tenant of TENANTS.values()) {
    if (tenant.hosts.includes(host)) return tenant;
  }

  // Compatibility fallback during productization. Until authenticated tenant
  // resolution is wired across the application, unknown/preview hosts continue
  // to behave exactly like the existing Koa production system.
  return KOA_TENANT;
}

export function defaultTenantConfig() {
  return KOA_TENANT;
}
