import type { Context } from '@netlify/functions';
import { createHash } from 'node:crypto';
import { getDeployStore, getStore } from '@netlify/blobs';
import type { TenantProfile } from '../../../src/data/tenants';

export type TenantStorageDomain =
  | 'sales'
  | 'quotes'
  | 'integrations'
  | 'crm'
  | 'eventOps'
  | 'vendors'
  | 'eventFiles'
  | 'vendorFiles'
  | 'emailAnalytics'
  | 'emailRouting'
  | 'authSecurity'
  | 'staffDirectory'
  | 'systemHealth'
  | 'workspaceAlerts';

type GetOptions = { type?: 'text' | 'json' | 'stream' | 'blob' | 'arrayBuffer' };
type ListOptions = { prefix?: string };

const CANONICAL_STORE = 'venueloom-data';

function canonicalStore(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: CANONICAL_STORE, consistency: 'strong' })
    : getDeployStore({ name: CANONICAL_STORE });
}

function compatibilityStore(context: Context, tenant: TenantProfile, domain: TenantStorageDomain) {
  const name = tenant.storage.compatibilityBlobStores[domain];
  if (!name) return null;
  return context.deploy.context === 'production'
    ? getStore({ name, consistency: 'strong' })
    : getDeployStore({ name });
}

function cleanKey(value: unknown) {
  return String(value ?? '').replace(/^\/+/, '').slice(0, 560);
}

export function tenantDataPrefix(tenant: TenantProfile, domain: TenantStorageDomain) {
  return 'tenants/' + tenant.id + '/' + domain + '/';
}

export function tenantDataKey(tenant: TenantProfile, domain: TenantStorageDomain, key: string) {
  return tenantDataPrefix(tenant, domain) + cleanKey(key);
}

async function copyFallbackValue(
  canonical: ReturnType<typeof canonicalStore>,
  targetKey: string,
  value: any,
  options?: GetOptions,
) {
  if (value == null || options?.type === 'stream') return;
  if (options?.type === 'json') {
    await canonical.setJSON(targetKey, value);
    return;
  }
  if (options?.type === 'arrayBuffer') {
    await canonical.set(targetKey, value);
    return;
  }
  if (options?.type === 'blob') {
    await canonical.set(targetKey, value);
    return;
  }
  await canonical.set(targetKey, String(value));
}

function scopeJsonValue(tenant: TenantProfile, value: any) {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      if (entry.tenantId && String(entry.tenantId) !== tenant.id) {
        throw new Error('Cross-tenant data access was blocked.');
      }
      return { ...entry, tenantId: tenant.id };
    });
  }
  if (value && typeof value === 'object') {
    if (value.tenantId && String(value.tenantId) !== tenant.id) {
      throw new Error('Cross-tenant data access was blocked.');
    }
    return { ...value, tenantId: tenant.id };
  }
  return value;
}

export function tenantStoreFor(
  context: Context,
  tenant: TenantProfile,
  domain: TenantStorageDomain,
) {
  const canonical = canonicalStore(context);
  const legacy = compatibilityStore(context, tenant, domain);
  const prefix = tenantDataPrefix(tenant, domain);

  return {
    canonicalKey(key: string) {
      return prefix + cleanKey(key);
    },

    async get(key: string, options?: GetOptions) {
      const logical = cleanKey(key);
      const scoped = prefix + logical;
      const current = await canonical.get(scoped, options as any);
      if (current != null) {
        if (options?.type !== 'json') return current;
        const scopedCurrent = scopeJsonValue(tenant, current);
        if (JSON.stringify(scopedCurrent) !== JSON.stringify(current)) {
          await canonical.setJSON(scoped, scopedCurrent);
        }
        return scopedCurrent;
      }
      if (!legacy || !tenant.storage.legacyDataBelongsToTenant) return null;

      const fallback = await legacy.get(logical, options as any);
      if (fallback != null) {
        const migrated = options?.type === 'json' ? scopeJsonValue(tenant, fallback) : fallback;
        await copyFallbackValue(canonical, scoped, migrated, options);
        return migrated;
      }
      return fallback;
    },

    async getWithMetadata(key: string) {
      const logical = cleanKey(key);
      const scoped = prefix + logical;
      const current = await canonical.getWithMetadata(scoped);
      if (current) return current;
      if (!legacy || !tenant.storage.legacyDataBelongsToTenant) return null;
      return legacy.getWithMetadata(logical);
    },

    async getMetadata(key: string) {
      const logical = cleanKey(key);
      const scoped = prefix + logical;
      const current = await canonical.getMetadata(scoped);
      if (current) return current;
      if (!legacy || !tenant.storage.legacyDataBelongsToTenant) return null;
      return legacy.getMetadata(logical);
    },

    async setJSON(key: string, value: unknown) {
      const logical = cleanKey(key);
      const scopedValue = scopeJsonValue(tenant, value);
      await canonical.setJSON(prefix + logical, scopedValue);
      if (legacy && tenant.storage.legacyDataBelongsToTenant) {
        await legacy.setJSON(logical, scopedValue);
      }
    },

    async set(key: string, value: any, options?: any) {
      const logical = cleanKey(key);
      await canonical.set(prefix + logical, value, options);
      if (legacy && tenant.storage.legacyDataBelongsToTenant) {
        await legacy.set(logical, value, options);
      }
    },

    async delete(key: string) {
      const logical = cleanKey(key);
      await canonical.delete(prefix + logical);
      if (legacy && tenant.storage.legacyDataBelongsToTenant) {
        await legacy.delete(logical);
      }
    },

    async list(options?: ListOptions) {
      const logicalPrefix = cleanKey(options?.prefix || '');
      const canonicalResult = await canonical.list({ prefix: prefix + logicalPrefix });
      const rows = new Map<string, any>();

      for (const blob of canonicalResult.blobs || []) {
        const logical = String(blob.key || '').startsWith(prefix)
          ? String(blob.key).slice(prefix.length)
          : String(blob.key || '');
        rows.set(logical, { ...blob, key: logical });
      }

      if (legacy && tenant.storage.legacyDataBelongsToTenant) {
        const legacyResult = await legacy.list({ prefix: logicalPrefix });
        for (const blob of legacyResult.blobs || []) {
          const key = String(blob.key || '');
          if (!rows.has(key)) rows.set(key, blob);
        }
      }

      return { blobs: [...rows.values()] };
    },
  };
}

export function stampTenantId<T extends Record<string, any>>(tenant: TenantProfile, value: T): T & { tenantId: string } {
  if (value?.tenantId && value.tenantId !== tenant.id) {
    throw new Error('Cross-tenant record access was blocked.');
  }
  return { ...value, tenantId: tenant.id };
}

export function tenantOwnsRecord(tenant: TenantProfile, value: any) {
  if (!value || typeof value !== 'object') return false;
  if (value.tenantId) return String(value.tenantId) === tenant.id;
  return tenant.storage.legacyDataBelongsToTenant;
}

export function normalizeTenantRows<T extends Record<string, any>>(
  tenant: TenantProfile,
  rows: T[],
) {
  let changed = false;
  let rejected = 0;
  const normalized: Array<T & { tenantId: string }> = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    if (row.tenantId && String(row.tenantId) !== tenant.id) {
      rejected += 1;
      continue;
    }
    if (!row.tenantId) {
      if (!tenant.storage.legacyDataBelongsToTenant) {
        rejected += 1;
        continue;
      }
      changed = true;
    }
    normalized.push(stampTenantId(tenant, row));
  }

  return { rows: normalized, changed, rejected };
}

export async function readTenantIndex<T extends Record<string, any>>(
  store: ReturnType<typeof tenantStoreFor>,
  tenant: TenantProfile,
  key: string,
) {
  const raw = ((await store.get(key, { type: 'json' })) || []) as T[];
  const normalized = normalizeTenantRows(tenant, raw);
  if (normalized.changed) await store.setJSON(key, normalized.rows);
  return normalized;
}

const MIGRATION_CRITICAL_KEYS: Partial<Record<TenantStorageDomain, string[]>> = {
  sales: ['records/index','analytics/events/index','settings/wedding-profitability','settings/mobile-bar-profitability'],
  crm: ['settings','templates/index','cleanup/audit/index'],
  eventOps: ['events/index'],
  vendors: ['vendors/index'],
  integrations: ['quickbooks/connection','quickbooks/catalog','quickbooks/settings'],
  emailAnalytics: ['activity/index'],
  systemHealth: ['history/index'],
  workspaceAlerts: ['index'],
};

function stableJson(value:any):string {
  if(Array.isArray(value)) return '['+value.map(stableJson).join(',')+']';
  if(value && typeof value==='object') {
    return '{'+Object.keys(value).sort().map((key)=>JSON.stringify(key)+':'+stableJson(value[key])).join(',')+'}';
  }
  return JSON.stringify(value);
}

function jsonHash(value:any) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export async function tenantMigrationAudit(
  context: Context,
  tenant: TenantProfile,
  domains: TenantStorageDomain[] = [
    'sales','quotes','integrations','crm','eventOps','vendors','eventFiles','vendorFiles',
    'emailAnalytics','emailRouting','authSecurity','staffDirectory','systemHealth','workspaceAlerts',
  ],
) {
  const canonical=canonicalStore(context);
  const results:any[]=[];

  for(const domain of domains) {
    const prefix=tenantDataPrefix(tenant,domain);
    const legacy=compatibilityStore(context,tenant,domain);
    const canonicalList=await canonical.list({prefix});
    const canonicalKeys=new Set((canonicalList.blobs||[]).map((blob:any)=>{
      const key=String(blob.key||'');
      return key.startsWith(prefix)?key.slice(prefix.length):key;
    }));

    const legacyList=legacy && tenant.storage.legacyDataBelongsToTenant
      ? await legacy.list({})
      : {blobs:[] as any[]};
    const legacyKeys=new Set((legacyList.blobs||[]).map((blob:any)=>String(blob.key||'')));

    const missingCanonical=[...legacyKeys].filter((key)=>!canonicalKeys.has(key)).sort();
    const canonicalOnly=[...canonicalKeys].filter((key)=>!legacyKeys.has(key)).sort();
    const critical:any[]=[];

    for(const key of MIGRATION_CRITICAL_KEYS[domain]||[]) {
      const legacyValue=legacy && tenant.storage.legacyDataBelongsToTenant
        ? await legacy.get(key,{type:'json'} as any).catch(()=>null)
        : null;
      const canonicalValue=await canonical.get(prefix+key,{type:'json'} as any).catch(()=>null);
      const normalizedLegacy=legacyValue==null?null:scopeJsonValue(tenant,legacyValue);
      const normalizedCanonical=canonicalValue==null?null:scopeJsonValue(tenant,canonicalValue);
      critical.push({
        key,
        legacyPresent:legacyValue!=null,
        canonicalPresent:canonicalValue!=null,
        legacyHash:normalizedLegacy==null?'':jsonHash(normalizedLegacy),
        canonicalHash:normalizedCanonical==null?'':jsonHash(normalizedCanonical),
        matches:normalizedLegacy==null
          ? canonicalValue==null
          : canonicalValue!=null && jsonHash(normalizedLegacy)===jsonHash(normalizedCanonical),
      });
    }

    results.push({
      domain,
      legacyStore:tenant.storage.compatibilityBlobStores[domain]||'',
      legacyCount:legacyKeys.size,
      canonicalCount:canonicalKeys.size,
      missingCanonicalCount:missingCanonical.length,
      canonicalOnlyCount:canonicalOnly.length,
      missingCanonical:missingCanonical.slice(0,100),
      canonicalOnly:canonicalOnly.slice(0,100),
      critical,
      safeToRetireLegacy:
        missingCanonical.length===0
        && critical.every((row)=>row.matches),
    });
  }

  return {
    tenantId:tenant.id,
    generatedAt:new Date().toISOString(),
    canonicalStore:CANONICAL_STORE,
    legacyDataBelongsToTenant:tenant.storage.legacyDataBelongsToTenant,
    domains:results,
    summary:{
      domains:results.length,
      safeDomains:results.filter((row)=>row.safeToRetireLegacy).length,
      legacyObjects:results.reduce((sum,row)=>sum+row.legacyCount,0),
      canonicalObjects:results.reduce((sum,row)=>sum+row.canonicalCount,0),
      missingCanonical:results.reduce((sum,row)=>sum+row.missingCanonicalCount,0),
      criticalMismatches:results.reduce((sum,row)=>sum+row.critical.filter((item:any)=>!item.matches).length,0),
      safeToRetireLegacy:results.every((row)=>row.safeToRetireLegacy),
    },
  };
}
