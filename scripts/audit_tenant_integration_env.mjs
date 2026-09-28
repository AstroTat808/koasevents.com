import fs from 'node:fs';
import path from 'node:path';

const root=path.join(process.cwd(),'netlify','functions');
const failures=[];
const credential=/Netlify\.env\.get\(\s*['"]((?:RESEND|MICROSOFT_GRAPH|SIGNWELL|QUICKBOOKS|INTUIT)_[A-Z0-9_]+)['"]\s*\)/g;

function walk(dir){
  const out=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())out.push(...walk(full));
    else if(/\.(?:ts|mts|js|mjs)$/.test(entry.name))out.push(full);
  }
  return out;
}

for(const full of walk(root)){
  const rel=path.relative(root,full).split(path.sep).join('/');
  const text=fs.readFileSync(full,'utf8');
  for(const match of text.matchAll(credential)){
    failures.push(rel+': reads '+match[1]+' directly instead of tenantEnv()');
  }
}

if(failures.length){
  console.error('Tenant integration credential audit failed:');
  for(const failure of failures)console.error('- '+failure);
  console.error('Tenant-owned integration credentials must resolve through tenantEnv().');
  process.exit(1);
}
console.log('Tenant integration credential audit passed: no runtime integration secret bypasses remain.');
