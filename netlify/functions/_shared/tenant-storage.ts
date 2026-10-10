import type { Context } from '@netlify/functions';
import { createHash } from 'node:crypto';
import { getDeployStore, getStore } from '@netlify/blobs';
import type { TenantProfile } from '../../../src/data/tenants';
import {
  cleanTenantKey,
  normalizeTenantRows,
  stampTenantId,
  tenantDataKey,
  tenantDataPrefix,
  tenantOwnsRecord,
} from './tenant-boundary.mjs';

export { normalizeTenantRows, stampTenantId, tenantDataKey, tenantDataPrefix, tenantOwnsRecord } from './tenant-boundary.mjs';

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
  | 'staffFiles'
  | 'staffAudit'
  | 'staffAvailability'
  | 'security'
  | 'systemHealth'
  | 'calendarSync'
  | 'userPreferences'
  | 'blog'
  | 'gallery'
  | 'localSeo'
  | 'workspaceAlerts';

export const TENANT_STORAGE_DOMAINS: TenantStorageDomain[] = [
  'sales','quotes','integrations','crm','eventOps','vendors','eventFiles','vendorFiles',
  'emailAnalytics','emailRouting','authSecurity','staffDirectory','staffFiles','staffAudit',
  'staffAvailability','security','systemHealth','calendarSync','userPreferences','blog','gallery',
  'localSeo','workspaceAlerts',
];

type GetOptions = { type?: 'text' | 'json' | 'stream' | 'blob' | 'arrayBuffer' };
type ListOptions = { prefix?: string };

const CANONICAL_STORE = 'venueloom-data';

export function controlPlaneStore(name:string){
  return getStore({name,consistency:'strong'});
}

export function controlPlaneDeployStore(name:string,deployID?:string){
  return deployID
    ? getDeployStore({name,deployID})
    : getDeployStore({name});
}

function canonicalStore(context?: Context) {
  if (!context) return getStore({ name: CANONICAL_STORE, consistency: 'strong' });
  return context.deploy.context === 'production'
    ? getStore({ name: CANONICAL_STORE, consistency: 'strong' })
    : getDeployStore({ name: CANONICAL_STORE });
}

function compatibilityStore(context: Context | undefined, tenant: TenantProfile, domain: TenantStorageDomain) {
  const name = tenant.storage.compatibilityBlobStores[domain];
  if (!name) return null;
  if (!context) return getStore({ name, consistency: 'strong' });
  return context.deploy.context === 'production'
    ? getStore({ name, consistency: 'strong' })
    : getDeployStore({ name });
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
  context: Context | undefined,
  tenant: TenantProfile,
  domain: TenantStorageDomain,
) {
  const canonical = canonicalStore(context);
  const legacy = compatibilityStore(context, tenant, domain);
  const prefix = tenantDataPrefix(tenant, domain);

  return {
    canonicalKey(key: string) {
      return prefix + cleanTenantKey(key);
    },

    async get(key: string, options?: GetOptions) {
      const logical = cleanTenantKey(key);
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
      const logical = cleanTenantKey(key);
      const scoped = prefix + logical;
      const current = await canonical.getWithMetadata(scoped);
      if (current) return current;
      if (!legacy || !tenant.storage.legacyDataBelongsToTenant) return null;
      return legacy.getWithMetadata(logical);
    },

    async getMetadata(key: string) {
      const logical = cleanTenantKey(key);
      const scoped = prefix + logical;
      const current = await canonical.getMetadata(scoped);
      if (current) return current;
      if (!legacy || !tenant.storage.legacyDataBelongsToTenant) return null;
      return legacy.getMetadata(logical);
    },

    async setJSON(key: string, value: unknown) {
      const logical = cleanTenantKey(key);
      const scopedValue = scopeJsonValue(tenant, value);
      await canonical.setJSON(prefix + logical, scopedValue);
      if (legacy && tenant.storage.legacyDataBelongsToTenant) {
        await legacy.setJSON(logical, scopedValue);
      }
    },

    async set(key: string, value: any, options?: any) {
      const logical = cleanTenantKey(key);
      await canonical.set(prefix + logical, value, options);
      if (legacy && tenant.storage.legacyDataBelongsToTenant) {
        await legacy.set(logical, value, options);
      }
    },

    async delete(key: string) {
      const logical = cleanTenantKey(key);
      await canonical.delete(prefix + logical);
      if (legacy && tenant.storage.legacyDataBelongsToTenant) {
        await legacy.delete(logical);
      }
    },

    async list(options?: ListOptions) {
      const logicalPrefix = cleanTenantKey(options?.prefix || '');
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

function bytesHash(value:ArrayBuffer) {
  return createHash('sha256').update(Buffer.from(value)).digest('hex');
}

async function normalizedBlobHash(
  store:any,
  key:string,
  tenant:TenantProfile,
) {
  try {
    const value=await store.get(key,{type:'json'} as any);
    if(value!=null)return {hash:jsonHash(scopeJsonValue(tenant,value)),kind:'json'};
  } catch {}
  try {
    const value=await store.get(key,{type:'arrayBuffer'} as any) as ArrayBuffer | null;
    if(value!=null)return {hash:bytesHash(value),kind:'binary'};
  } catch {}
  return {hash:'',kind:'missing'};
}

function aggregateManifestHash(rows:Array<{key:string;hash:string}>) {
  return createHash('sha256')
    .update(rows.slice().sort((a,b)=>a.key.localeCompare(b.key)).map((row)=>row.key+':'+row.hash).join('\n'))
    .digest('hex');
}

export async function tenantMigrationAudit(
  context: Context,
  tenant: TenantProfile,
  domains: TenantStorageDomain[] = TENANT_STORAGE_DOMAINS,
) {
  const canonical=canonicalStore(context);
  const results:any[]=[];
  const auditedAt=new Date().toISOString();

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
    const legacyInfoByKey=new Map((legacyList.blobs||[]).map((blob:any)=>[String(blob.key||''),blob]));
    const canonicalInfoByKey=new Map((canonicalList.blobs||[]).map((blob:any)=>{
      const raw=String(blob.key||'');
      const logical=raw.startsWith(prefix)?raw.slice(prefix.length):raw;
      return [logical,blob];
    }));

    const missingCanonical=[...legacyKeys].filter((key)=>!canonicalKeys.has(key)).sort();
    const canonicalOnly=[...canonicalKeys].filter((key)=>!legacyKeys.has(key)).sort();
    const critical:any[]=[];
    const objectComparisons:any[]=[];
    const legacyManifest:Array<{key:string;hash:string}>=[];
    const canonicalMirrorManifest:Array<{key:string;hash:string}>=[];

    if(legacy && tenant.storage.legacyDataBelongsToTenant) {
      for(const key of [...legacyKeys].sort()) {
        const legacyInfo:any=legacyInfoByKey.get(key);
        const canonicalInfo:any=canonicalInfoByKey.get(key);
        const matchingEtag=Boolean(
          legacyInfo?.etag
          && canonicalInfo?.etag
          && String(legacyInfo.etag)===String(canonicalInfo.etag)
        );
        const legacyHash=matchingEtag
          ? {hash:String(legacyInfo.etag),kind:'etag'}
          : await normalizedBlobHash(legacy,key,tenant);
        const canonicalHash=!canonicalKeys.has(key)
          ? {hash:'',kind:'missing'}
          : matchingEtag
            ? {hash:String(canonicalInfo.etag),kind:'etag'}
            : await normalizedBlobHash(canonical,prefix+key,tenant);
        const matches=Boolean(legacyHash.hash) && legacyHash.hash===canonicalHash.hash;
        legacyManifest.push({key,hash:legacyHash.hash});
        if(canonicalHash.hash)canonicalMirrorManifest.push({key,hash:canonicalHash.hash});
        objectComparisons.push({
          key,
          kind:matchingEtag?'etag':legacyHash.kind,
          legacyHash:legacyHash.hash,
          canonicalHash:canonicalHash.hash,
          matches,
        });
      }
    }

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

    const mirroredCount=objectComparisons.filter((row)=>row.matches).length;
    const checksumMismatch=objectComparisons.filter((row)=>!row.matches && row.canonicalHash).length;
    const objectMismatches=objectComparisons.filter((row)=>!row.matches);
    const safeToRetireLegacy=!tenant.storage.legacyDataBelongsToTenant
      ? true
      : missingCanonical.length===0
        && checksumMismatch===0
        && critical.every((row)=>row.matches);

    results.push({
      domain,
      legacyStore:tenant.storage.compatibilityBlobStores[domain]||'',
      canonicalNamespace:prefix,
      legacyCount:legacyKeys.size,
      canonicalCount:canonicalKeys.size,
      mirroredCount,
      missingCanonicalCount:missingCanonical.length,
      checksumMismatchCount:checksumMismatch,
      canonicalOnlyCount:canonicalOnly.length,
      legacyChecksum:legacyManifest.length?aggregateManifestHash(legacyManifest):'',
      canonicalMirrorChecksum:canonicalMirrorManifest.length?aggregateManifestHash(canonicalMirrorManifest):'',
      missingCanonical:missingCanonical.slice(0,100),
      checksumMismatches:objectMismatches.filter((row)=>row.canonicalHash).slice(0,100),
      canonicalOnly:canonicalOnly.slice(0,100),
      critical,
      safeToRetireLegacy,
      retirementStatus:!tenant.storage.legacyDataBelongsToTenant?'not-applicable':safeToRetireLegacy?'safe':'blocked',
      safeToRetireAsOf:safeToRetireLegacy?auditedAt:'',
      auditedAt,
      blockers:[
        ...(missingCanonical.length?[missingCanonical.length+' legacy object(s) are not mirrored']:[]),
        ...(checksumMismatch?[checksumMismatch+' mirrored object(s) have checksum mismatches']:[]),
        ...(!critical.every((row)=>row.matches)?['Critical-record fingerprints do not all match']:[]),
      ],
    });
  }

  return {
    tenantId:tenant.id,
    generatedAt:auditedAt,
    canonicalStore:CANONICAL_STORE,
    legacyDataBelongsToTenant:tenant.storage.legacyDataBelongsToTenant,
    domains:results,
    summary:{
      domains:results.length,
      safeDomains:results.filter((row)=>row.safeToRetireLegacy).length,
      legacyObjects:results.reduce((sum,row)=>sum+row.legacyCount,0),
      canonicalObjects:results.reduce((sum,row)=>sum+row.canonicalCount,0),
      missingCanonical:results.reduce((sum,row)=>sum+row.missingCanonicalCount,0),
      checksumMismatches:results.reduce((sum,row)=>sum+row.checksumMismatchCount,0),
      mirroredObjects:results.reduce((sum,row)=>sum+row.mirroredCount,0),
      criticalMismatches:results.reduce((sum,row)=>sum+row.critical.filter((item:any)=>!item.matches).length,0),
      safeToRetireLegacy:results.every((row)=>row.safeToRetireLegacy),
    },
  };
}


export async function purgeTenantData(
  context:Context,
  tenant:TenantProfile,
  domains:TenantStorageDomain[]=TENANT_STORAGE_DOMAINS,
) {
  if(tenant.storage.legacyDataBelongsToTenant){
    throw new Error('Legacy-compatible tenants cannot be purged through the VenueLoom tenant-data purge.');
  }
  const deletedByDomain:Record<string,number>={};
  for(const domain of domains){
    const store=tenantStoreFor(context,tenant,domain);
    const listed=await store.list();
    let deleted=0;
    for(const blob of listed.blobs||[]){
      await store.delete(String(blob.key||''));
      deleted+=1;
    }
    deletedByDomain[domain]=deleted;
  }
  return {
    tenantId:tenant.id,
    deletedObjects:Object.values(deletedByDomain).reduce((sum,value)=>sum+value,0),
    deletedByDomain,
  };
}
