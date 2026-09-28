import type { Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import type { TenantProfile } from '../../../src/data/tenants';

export type TenantStorageDomain =
  | 'sales'
  | 'integrations'
  | 'crm'
  | 'eventOps'
  | 'vendors'
  | 'eventFiles'
  | 'vendorFiles'
  | 'emailAnalytics'
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
        throw new Error('Cross-tenant write was blocked.');
      }
      return { ...entry, tenantId: tenant.id };
    });
  }
  if (value && typeof value === 'object') {
    if (value.tenantId && String(value.tenantId) !== tenant.id) {
      throw new Error('Cross-tenant write was blocked.');
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
      if (current != null) return current;
      if (!legacy || !tenant.storage.legacyDataBelongsToTenant) return null;

      const fallback = await legacy.get(logical, options as any);
      if (fallback != null) {
        await copyFallbackValue(canonical, scoped, fallback, options);
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
