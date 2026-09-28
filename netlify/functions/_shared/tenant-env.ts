import type { TenantProfile } from '../../../src/data/tenants';

function token(value:unknown){
  return String(value??'').trim().toUpperCase().replace(/[^A-Z0-9]+/g,'_').replace(/^_+|_+$/g,'');
}

export function tenantEnvKey(tenant:TenantProfile,name:string){
  return 'VENUELOOM_TENANT_'+token(tenant.id)+'_'+token(name);
}

export function tenantEnv(tenant:TenantProfile,...names:string[]){
  for(const name of names){
    const scoped=String(Netlify.env.get(tenantEnvKey(tenant,name))||'').trim();
    if(scoped)return scoped;
  }
  if(tenant.storage.legacyDataBelongsToTenant){
    for(const name of names){
      const legacy=String(Netlify.env.get(name)||'').trim();
      if(legacy)return legacy;
    }
  }
  return '';
}

export function tenantEnvConfigured(tenant:TenantProfile,...names:string[]){
  return Boolean(tenantEnv(tenant,...names));
}
