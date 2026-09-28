import fs from 'node:fs';
import path from 'node:path';

const root=path.join(process.cwd(),'netlify','functions');
const failures=[];
const scheduled=[];

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
  const configIndex=text.lastIndexOf('export const config');
  if(configIndex<0)continue;
  const configSource=text.slice(configIndex);
  if(!/\bschedule\s*:/.test(configSource))continue;
  scheduled.push(rel);
  if(!/\brunForEachTenant\s*\(/.test(text)){
    failures.push(rel+': scheduled function does not iterate active tenants');
  }
}

if(failures.length){
  console.error('Tenant scheduled-job audit failed:');
  for(const failure of failures)console.error('- '+failure);
  console.error('Scheduled business jobs must execute through runForEachTenant().');
  process.exit(1);
}
console.log('Tenant scheduled-job audit passed for '+scheduled.length+' scheduled functions:');
for(const file of scheduled)console.log('- '+file);
