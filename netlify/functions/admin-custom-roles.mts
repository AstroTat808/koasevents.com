import type { Context, Config } from '@netlify/functions';
import { admin } from '@netlify/identity';
import { requireAdmin, passwordSecurityFor, readAuthSecurityPolicy } from './_shared/admin';
import { deleteCustomRole, getCustomRole, listCustomRoles, saveCustomRole } from './_shared/custom-roles';
import { appendStaffAudit } from './_shared/staff-audit';

function clean(v:unknown,max=300){return String(v||'').trim().slice(0,max);}
function meta(user:any){return user?.appMetadata||user?.app_metadata||{};}
function email(user:any){return clean(user?.email,240).toLowerCase();}
function sessionVersion(user:any){const n=Number(meta(user)?.sessionVersion||0);return Number.isFinite(n)&&n>=0?Math.floor(n):0;}

export default async(req:Request,context:Context)=>{
  const auth=await requireAdmin(req);if(auth.response)return auth.response;
  const actor=email(auth.user)||'admin';

  if(req.method==='GET'){
    const roles=await listCustomRoles();
    const users=await admin.listUsers({page:1,perPage:200});
    const usage=Object.fromEntries(roles.map(role=>[role.id,users.filter((u:any)=>clean(meta(u)?.customRoleId,100)===role.id).length]));
    return Response.json({roles,usage},{headers:{'Cache-Control':'private, no-store'}});
  }

  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  const body:any=await req.json().catch(()=>null);if(!body)return Response.json({error:'Invalid JSON.'},{status:400});
  const action=clean(body.action,50);

  if(action==='save'){
    try{
      const role=await saveCustomRole(body.role||{},actor);
      await appendStaffAudit(context,{actor,action:'custom_role_saved',detail:'Saved custom role '+role.name+'.',metadata:{roleId:role.id,capabilities:role.capabilities}});
      return Response.json({ok:true,role});
    }catch(error){return Response.json({error:error instanceof Error?error.message:'Unable to save custom role.'},{status:400});}
  }

  if(action==='delete'){
    const roleId=clean(body.roleId,100);
    const users=await admin.listUsers({page:1,perPage:200});
    const assigned=users.filter((u:any)=>clean(meta(u)?.customRoleId,100)===roleId);
    if(assigned.length)return Response.json({error:'This custom role is assigned to '+assigned.length+' user(s). Reassign them before deleting it.'},{status:409});
    try{
      const role=await deleteCustomRole(roleId);
      await appendStaffAudit(context,{actor,action:'custom_role_deleted',detail:'Deleted custom role '+role.name+'.',metadata:{roleId}});
      return Response.json({ok:true,deletedId:roleId});
    }catch(error){return Response.json({error:error instanceof Error?error.message:'Unable to delete custom role.'},{status:404});}
  }

  if(action==='assign'){
    const userId=clean(body.userId,120),roleId=clean(body.roleId,100);
    const [user,role]=await Promise.all([admin.getUser(userId),getCustomRole(roleId)]);
    if(!user)return Response.json({error:'User not found.'},{status:404});
    if(!role)return Response.json({error:'Custom role not found.'},{status:404});
    const nextVersion=sessionVersion(user)+1;
    const updated:any=await admin.updateUser(userId,{
      role:'custom',
      app_metadata:{
        ...meta(user),
        roles:['custom'],
        customRoleId:role.id,
        customRoleName:role.name,
        permissions:role.capabilities,
        active:true,
        previousRole:undefined,
        sessionVersion:nextVersion,
      },
    });
    const policy=await readAuthSecurityPolicy();
    const security=passwordSecurityFor(updated,updated,policy);
    await appendStaffAudit(context,{actor,action:'custom_role_assigned',subjectId:userId,subjectEmail:email(user),detail:'Assigned custom role '+role.name+' to '+email(user)+'. Existing sessions were revoked.',metadata:{roleId:role.id,capabilities:role.capabilities,sessionVersion:nextVersion}});
    return Response.json({ok:true,userId,email:email(user),role,security});
  }

  return Response.json({error:'Unknown custom-role action.'},{status:400});
};

export const config:Config={path:'/api/admin/custom-roles'};
