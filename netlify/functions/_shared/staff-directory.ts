import { admin } from '@netlify/identity';

export type OperationalStaff = {
  id: string;
  email: string;
  name: string;
  role: 'sales' | 'manager';
  permissions: string[];
};

function clean(value: unknown, max=300) { return String(value || '').trim().slice(0,max); }
function metadataFor(user:any) { return user?.appMetadata || user?.app_metadata || {}; }
function rolesFor(user:any) {
  const candidates=[user?.roles,user?.appMetadata?.roles,user?.app_metadata?.roles];
  const roles=candidates.find(Array.isArray)||[];
  return roles.map((role:any)=>clean(role,40).toLowerCase()).filter(Boolean);
}

export async function listOperationalStaff():Promise<OperationalStaff[]> {
  const users:any[]=await admin.listUsers({page:1,perPage:200});
  return users
    .map((user:any)=>{
      const roles=rolesFor(user);
      const meta=metadataFor(user);
      const role:OperationalStaff['role']|null=roles.includes('manager')||clean(user?.role,40).toLowerCase()==='manager'
        ? 'manager'
        : roles.includes('sales')||roles.includes('staff')||clean(user?.role,40).toLowerCase()==='sales'
          ? 'sales'
          : null;
      if(!role||roles.includes('deactivated')||meta?.active===false) return null;
      const permissions=Array.isArray(meta?.permissions)?meta.permissions.map((v:any)=>clean(v,80).toLowerCase()).filter(Boolean):[];
      return {
        id:clean(user?.id,120),
        email:clean(user?.email,240).toLowerCase(),
        name:clean(user?.name||user?.userMetadata?.full_name||user?.user_metadata?.full_name||user?.email,180),
        role,
        permissions,
      } as OperationalStaff;
    })
    .filter((row:any):row is OperationalStaff=>Boolean(row?.id&&row?.email))
    .sort((a,b)=>a.name.localeCompare(b.name)||a.email.localeCompare(b.email));
}

export function leastLoadedStaff(staff:OperationalStaff[], records:any[]) {
  if(!staff.length) return null;
  const counts=new Map(staff.map(member=>[member.id,0]));
  const counted=new Set<string>();
  for(const record of records||[]){
    const assignment=record?.assignment;
    if(!assignment?.userId||!counts.has(assignment.userId)) continue;
    const key=String(record.quoteId||record.source||record.id||'');
    if(!key||counted.has(key)) continue;
    counted.add(key);
    counts.set(assignment.userId,(counts.get(assignment.userId)||0)+1);
  }
  return [...staff].sort((a,b)=>(counts.get(a.id)||0)-(counts.get(b.id)||0)||a.name.localeCompare(b.name))[0]||null;
}

export function assignmentFor(member:OperationalStaff, assignedBy='system') {
  return {
    userId:member.id,
    email:member.email,
    name:member.name,
    assignedAt:new Date().toISOString(),
    assignedBy,
  };
}
