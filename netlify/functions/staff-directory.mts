import type { Config } from '@netlify/functions';
import { admin } from '@netlify/identity';
import { operationsRole, requireOperations, ROLE_LABELS } from './_shared/admin';

function clean(value:unknown,max=300){return String(value??'').trim().slice(0,max);}
function metadata(user:any){return user?.user_metadata||user?.userMetadata||{};}
function appMeta(user:any){return user?.app_metadata||user?.appMetadata||{};}

export default async(req:Request)=>{
  const auth=await requireOperations(req);
  if(auth.response)return auth.response;
  if(req.method!=='GET')return new Response('Method not allowed',{status:405});

  const users:any[]=await admin.listUsers({page:1,perPage:200});
  const rows=users
    .filter((user:any)=>{
      const role=operationsRole(user);
      return role!=='none'&&role!=='deactivated'&&appMeta(user)?.active!==false;
    })
    .map((user:any)=>{
      const meta=metadata(user);
      const role=operationsRole(user);
      const roleLabel=role&&role!=='custom'&&role in ROLE_LABELS?ROLE_LABELS[role as keyof typeof ROLE_LABELS]:clean(appMeta(user)?.customRoleName,100)||'Staff';
      const version=clean(meta?.profile_photo_version,80);
      return {
        id:clean(user?.id,120),
        email:clean(user?.email,240).toLowerCase(),
        name:clean(meta?.full_name||meta?.name||user?.name||user?.email,180),
        jobTitle:clean(meta?.job_title||meta?.jobTitle,120),
        role,
        roleLabel,
        photoUrl:meta?.has_profile_photo===true?('/api/staff/photo/'+encodeURIComponent(clean(user?.id,120))+(version?'?v='+encodeURIComponent(version):'')):'',
      };
    })
    .sort((a:any,b:any)=>a.name.localeCompare(b.name));

  return Response.json({staff:rows},{headers:{'Cache-Control':'private, no-store'}});
};

export const config:Config={path:'/api/staff/directory'};
