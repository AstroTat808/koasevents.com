import fs from 'node:fs';
import path from 'node:path';

const root=path.join(process.cwd(),'netlify','functions');
const allowed=new Set([
  '_shared/tenant-storage.ts',
  '_shared/organization.ts',
]);
const failures=[];

function walk(dir){
  const out=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name);
    if(entry.isDirectory()) out.push(...walk(full));
    else if(/\.(?:ts|mts|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

for(const full of walk(root)){
  const rel=path.relative(root,full).split(path.sep).join('/');
  if(allowed.has(rel)) continue;
  const text=fs.readFileSync(full,'utf8');
  if(/from\s+['"]@netlify\/blobs['"]/.test(text)){
    failures.push(rel+': imports @netlify/blobs directly');
  }
  if (/(?:^|[^.A-Za-z0-9_$])getStore\s*\(|(?:^|[^.A-Za-z0-9_$])getDeployStore\s*\(/m.test(text)){
    failures.push(rel+': opens a Blob store directly');
  }
}

if(failures.length){
  console.error('Tenant storage access audit failed:');
  for(const failure of failures) console.error('- '+failure);
  console.error('Use resolveTenant/authorized tenant context plus tenantStoreFor().');
  process.exit(1);
}

console.log('Tenant storage access audit passed: all runtime Blob access is tenant-scoped or an approved control-plane primitive.');
