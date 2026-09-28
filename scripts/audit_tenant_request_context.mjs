import fs from 'node:fs';
import path from 'node:path';

const root=path.join(process.cwd(),'netlify','functions');
const failures=[];
const checked=[];

for(const entry of fs.readdirSync(root,{withFileTypes:true})){
  if(!entry.isFile()||!/\.(?:ts|mts|js|mjs)$/.test(entry.name))continue;
  const full=path.join(root,entry.name);
  const text=fs.readFileSync(full,'utf8');
  const tenantAware=/\b(?:resolveTenant|tenantStoreFor|tenantEnv)\s*\(/.test(text);
  if(!tenantAware)continue;
  checked.push(entry.name);

  const configIndex=text.lastIndexOf('export const config');
  const configSource=configIndex>=0?text.slice(configIndex):'';
  const scheduled=/\bschedule\s*:/.test(configSource);
  const webhook=/webhook/i.test(entry.name);
  const dynamic=/\bresolveTenantAsync\s*\(/.test(text)&&/\brunWithTenant\s*\(/.test(text);
  const authorized=/\b(?:requireCapability|requireAdmin|requireManager|requireOperations|getAccessContext)\s*\(/.test(text);
  const iterated=scheduled&&/\brunForEachTenant\s*\(/.test(text);
  const unsafeAuthorizedResolve=authorized
    && /\b(?:const|let)\s+tenant\s*=\s*resolveTenant\s*\(\s*req\s*\)/.test(text)
    && !/\btenant\s*=\s*auth\.tenant\s*\|\|\s*resolveTenant\s*\(\s*req\s*\)/.test(text);

  if(unsafeAuthorizedResolve){
    failures.push(entry.name+': authorized request discards auth.tenant and re-resolves synchronously');
    continue;
  }

  if(webhook)continue; // webhook-specific invariants are enforced by tenant_isolation_qa.mjs
  if(dynamic||authorized||iterated)continue;

  failures.push(entry.name+': uses tenant runtime state without dynamic/authenticated/scheduled tenant binding');
}

if(failures.length){
  console.error('Tenant request-context audit failed:');
  for(const failure of failures)console.error('- '+failure);
  console.error('Bind request tenant with resolveTenantAsync()+runWithTenant(), tenant-aware admin authorization, or runForEachTenant().');
  process.exit(1);
}
console.log('Tenant request-context audit passed for '+checked.length+' tenant-aware API/function surfaces.');
