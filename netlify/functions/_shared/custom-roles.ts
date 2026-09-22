import { getStore } from '@netlify/blobs';
import { STAFF_CAPABILITIES, type StaffCapability } from './admin';

export type CustomRole = {
  id:string;
  name:string;
  description:string;
  capabilities:StaffCapability[];
  createdAt:string;
  updatedAt:string;
  createdBy:string;
  updatedBy:string;
};

function store(){return getStore({name:'koa-auth-security',consistency:'strong'});}
function clean(v:unknown,max=300){return String(v||'').trim().slice(0,max);}
function normalizeCaps(v:unknown){
  const rows=Array.isArray(v)?v:[];
  return [...new Set(rows.map(x=>clean(x,100).toLowerCase()).filter((x):x is StaffCapability=>STAFF_CAPABILITIES.includes(x as StaffCapability)))];
}
function roleId(){return 'role_'+crypto.randomUUID().replaceAll('-','').slice(0,14);}

export async function listCustomRoles(){
  return (((await store().get('custom-roles/index',{type:'json'}))||[]) as CustomRole[]).sort((a,b)=>a.name.localeCompare(b.name));
}
export async function getCustomRole(id:string){
  return (await listCustomRoles()).find(r=>r.id===id)||null;
}
export async function saveCustomRole(input:any,actor:string){
  const roles=await listCustomRoles();
  const existing=roles.find(r=>r.id===clean(input?.id,100));
  const name=clean(input?.name,100);
  if(name.length<2)throw new Error('Role name is required.');
  const capabilities=normalizeCaps(input?.capabilities);
  const now=new Date().toISOString();
  const role:CustomRole={
    id:existing?.id||roleId(),
    name,
    description:clean(input?.description,500),
    capabilities,
    createdAt:existing?.createdAt||now,
    updatedAt:now,
    createdBy:existing?.createdBy||clean(actor,240),
    updatedBy:clean(actor,240),
  };
  const next=[role,...roles.filter(r=>r.id!==role.id)];
  await store().setJSON('custom-roles/index',next.slice(0,100));
  return role;
}
export async function deleteCustomRole(id:string){
  const roles=await listCustomRoles();
  const found=roles.find(r=>r.id===id);
  if(!found)throw new Error('Custom role not found.');
  await store().setJSON('custom-roles/index',roles.filter(r=>r.id!==id));
  return found;
}
