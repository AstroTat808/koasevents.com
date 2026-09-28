import type { Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { resolveTenant, tenantStoragePrefix } from './tenant';
import type { TenantProfile } from '../../../src/data/tenants';

export type TenantStoreKind =
  | 'sales'
  | 'crm'
  | 'quotes'
  | 'eventOps'
  | 'eventFiles'
  | 'vendors'
  | 'integrations'
  | 'email'
  | 'emailRouting'
  | 'emailAnalytics'
  | 'health'
  | 'calendar'
  | 'authSecurity';

const GENERIC_STORE_NAMES: Record<TenantStoreKind,string> = {
  sales:'venueloom-sales',
  crm:'venueloom-crm',
  quotes:'venueloom-quotes',
  eventOps:'venueloom-event-ops',
  eventFiles:'venueloom-event-files',
  vendors:'venueloom-vendors',
  integrations:'venueloom-integrations',
  email:'venueloom-email',
  emailRouting:'venueloom-email-routing',
  emailAnalytics:'venueloom-email-analytics',
  health:'venueloom-health',
  calendar:'venueloom-calendar',
  authSecurity:'venueloom-auth-security',
};

function configuredCompatibilityName(tenant:TenantProfile,kind:TenantStoreKind){
  return tenant.storage.compatibilityBlobStores[kind] || '';
}

export function tenantStore(context:Context,kind:TenantStoreKind,tenant:TenantProfile=resolveTenant()){
  const compatibilityName=configuredCompatibilityName(tenant,kind);
  const name=compatibilityName || GENERIC_STORE_NAMES[kind];
  const store=context.deploy.context==='production'
    ? getStore({name,consistency:'strong'})
    : getDeployStore({name});
  const prefix=compatibilityName ? '' : tenantStoragePrefix(tenant) + '/';

  const key=(value:string)=>prefix+String(value||'').replace(/^\/+/,'');

  return {
    tenant,
    name,
    compatibilityMode:Boolean(compatibilityName),
    key,
    get:(path:string,options?:any)=>store.get(key(path),options),
    set:(path:string,value:any,options?:any)=>store.set(key(path),value,options),
    setJSON:(path:string,value:any)=>store.setJSON(key(path),value),
    delete:(path:string)=>store.delete(key(path)),
    list:(options:any={})=>store.list({...options,prefix:key(options?.prefix||'')}),
    raw:store,
  };
}

export function tenantIdOf(value:any){
  return String(value?.tenant_id || value?.tenantId || '').trim();
}

export function belongsToTenant(value:any,tenant:TenantProfile){
  const id=tenantIdOf(value);
  if(id) return id===tenant.id;
  return tenant.id==='koa-events';
}

export function stampTenant<T extends Record<string,any>>(value:T,tenant:TenantProfile):T & {tenant_id:string}{
  return {...value,tenant_id:tenant.id};
}

export function tenantRows<T extends Record<string,any>>(rows:T[],tenant:TenantProfile){
  return (Array.isArray(rows)?rows:[]).filter((row)=>belongsToTenant(row,tenant));
}

export function backfillTenantRows<T extends Record<string,any>>(rows:T[],tenant:TenantProfile){
  let changed=0;
  const next=(Array.isArray(rows)?rows:[]).map((row)=>{
    if(tenantIdOf(row)) return row;
    changed+=1;
    return stampTenant(row,tenant);
  });
  return {rows:next,changed};
}
