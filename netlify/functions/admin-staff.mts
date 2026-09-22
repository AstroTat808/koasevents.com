import type { Context, Config } from '@netlify/functions';
import { admin, requestPasswordRecovery } from '@netlify/identity';
import { requireAdmin, STAFF_CAPABILITIES } from './_shared/admin';
import { appendStaffAudit, readStaffAudit } from './_shared/staff-audit';

const PROTECTED_ADMIN_EMAILS = new Set(['chris@sibel.org','koasadmin@koasevents.com']);
const STAFF_ROLES = new Set(['sales','manager','admin']);
const CAPABILITY_LABELS:Record<string,string>={
  'blog.manage':'Publish + manage Blog',
  'event_ops.manage':'Edit Event Ops',
  'crm.destructive':'Trash / restore CRM clients',
  'crm.workflows':'Manage CRM workflows',
  'crm.templates':'Manage CRM templates',
  'crm.cleanup_policy':'Change CRM cleanup policy',
  'sales.profit_settings':'Change sales profitability settings',
};

function clean(value: unknown, max=300) { return String(value || '').trim().slice(0,max); }
function normalizeEmail(value: unknown) { return clean(value,240).toLowerCase(); }
function randomPassword() {
  const bytes = new Uint8Array(18); crypto.getRandomValues(bytes);
  const raw = Array.from(bytes, b => b.toString(36).padStart(2,'0')).join('');
  return 'Koa!' + raw.slice(0,18) + '9a';
}
function metadataFor(user:any) { return user?.appMetadata || user?.app_metadata || {}; }
function rolesFor(user:any) {
  const candidates=[user?.roles,user?.appMetadata?.roles,user?.app_metadata?.roles];
  const roles=candidates.find(Array.isArray)||[];
  return roles.map((role:any)=>clean(role,40).toLowerCase()).filter(Boolean);
}
function permissionsFor(user:any) {
  const values=metadataFor(user)?.permissions;
  return Array.isArray(values)
    ? values.map((permission:any)=>clean(permission,80).toLowerCase()).filter((permission:string)=>STAFF_CAPABILITIES.includes(permission as any))
    : [];
}
function effectiveRole(user:any) {
  const email=normalizeEmail(user?.email);
  if(PROTECTED_ADMIN_EMAILS.has(email)||rolesFor(user).includes('admin')||clean(user?.role,40).toLowerCase()==='admin') return 'admin';
  const roles=rolesFor(user);
  if(roles.includes('deactivated')||metadataFor(user)?.active===false) return 'deactivated';
  if(roles.includes('manager')||clean(user?.role,40).toLowerCase()==='manager') return 'manager';
  if(roles.includes('sales')||roles.includes('staff')||clean(user?.role,40).toLowerCase()==='sales') return 'sales';
  return 'none';
}
function normalizeUser(user:any) {
  return {
    id:clean(user?.id,120),
    email:normalizeEmail(user?.email),
    name:clean(user?.name||user?.userMetadata?.full_name||user?.user_metadata?.full_name,180),
    role:effectiveRole(user),
    permissions:permissionsFor(user),
    confirmedAt:clean(user?.confirmedAt||user?.confirmed_at,80),
    createdAt:clean(user?.createdAt||user?.created_at,80),
    updatedAt:clean(user?.updatedAt||user?.updated_at,80),
    lastSignInAt:clean(user?.lastSignInAt||user?.last_sign_in_at,80),
    protected:PROTECTED_ADMIN_EMAILS.has(normalizeEmail(user?.email)),
  };
}
async function sendInviteEmail(email:string,name:string,role:string,password:string) {
  const key=clean(Netlify.env.get('RESEND_API_KEY'),500);
  if(!key) return {sent:false,error:'RESEND_API_KEY is not configured.'};
  const from=clean(Netlify.env.get('KOA_FROM_EMAIL'),240)||'Koa\'s Events <aloha@koasevents.com>';
  const response=await fetch('https://api.resend.com/emails',{
    method:'POST',
    headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
    body:JSON.stringify({
      from,to:[email],subject:'Your Koa\'s Events staff account',
      html:`<div style="font-family:Arial,sans-serif;line-height:1.6;color:#23352f">
        <h2 style="margin:0 0 16px">Aloha ${name||'there'},</h2>
        <p>Your Koa's Events account has been created with <strong>${role==='admin'?'Administrator':role==='manager'?'Manager':'Sales Rep'}</strong> access.</p>
        <p>Sign in at <a href="${role==='admin'?'https://koasevents.com/admin/':'https://koasevents.com/staff/'}">${role==='admin'?'https://koasevents.com/admin/':'https://koasevents.com/staff/'}</a> using:</p>
        <p><strong>Email:</strong> ${email}<br><strong>Temporary password:</strong> ${password}</p>
        <p>After signing in, use Change Password in the Staff Workspace.</p>
        <p>Mahalo,<br>Koa's Events</p>
      </div>`,
    }),
  });
  const data:any=await response.json().catch(()=>({}));
  return response.ok?{sent:true,id:clean(data?.id,120)}:{sent:false,error:clean(data?.message||data?.error||'Email delivery failed.',500)};
}

export default async (req:Request,context:Context) => {
  const auth=await requireAdmin();
  if(auth.response) return auth.response;
  const actor=normalizeEmail(auth.user?.email)||'admin';

  if(req.method==='GET'){
    const [users,audit]=await Promise.all([admin.listUsers({page:1,perPage:200}),readStaffAudit(context,500)]);
    return Response.json({
      users:users.map(normalizeUser).sort((a,b)=>a.email.localeCompare(b.email)),
      audit,
      capabilities:STAFF_CAPABILITIES.map(id=>({id,label:CAPABILITY_LABELS[id]||id})),
    },{headers:{'Cache-Control':'private, no-store'}});
  }

  if(req.method!=='POST') return new Response('Method not allowed',{status:405});
  const body:any=await req.json().catch(()=>null);
  if(!body) return Response.json({error:'Invalid JSON.'},{status:400});
  const action=clean(body.action,40);

  if(action==='invite'){
    const email=normalizeEmail(body.email); const name=clean(body.name,180); const role=clean(body.role,40).toLowerCase();
    if(!email.includes('@')) return Response.json({error:'A valid email is required.'},{status:400});
    if(!STAFF_ROLES.has(role)) return Response.json({error:'Choose Sales Rep, Manager, or Administrator.'},{status:400});
    const existing=(await admin.listUsers({page:1,perPage:200})).find((u:any)=>normalizeEmail(u?.email)===email);
    if(existing) return Response.json({error:'That email already has an Identity account. Change its role instead.'},{status:409});
    const password=randomPassword();
    const created:any=await admin.createUser({email,password,data:{role,app_metadata:{roles:[role],active:true,permissions:[]},user_metadata:{full_name:name}}});
    const delivery=await sendInviteEmail(email,name,role,password);
    await appendStaffAudit(context,{actor,action:'staff_invited',subjectId:clean(created?.id,120),subjectEmail:email,detail:'Created '+role+' staff account for '+email+'.',metadata:{role,inviteEmailSent:delivery.sent}});
    return Response.json({ok:true,user:normalizeUser(created),inviteEmailSent:delivery.sent,inviteMessageId:delivery.sent?delivery.id:'',temporaryPassword:delivery.sent?'':password,emailError:delivery.sent?'':delivery.error});
  }

  const userId=clean(body.userId,120);
  if(!userId) return Response.json({error:'User ID required.'},{status:400});
  const current:any=await admin.getUser(userId);
  const email=normalizeEmail(current?.email);
  if(action==='reset-password'){
    await requestPasswordRecovery(email);
    await appendStaffAudit(context,{actor,action:'staff_password_reset_sent',subjectId:userId,subjectEmail:email,detail:'Sent password reset email to '+email+'.',metadata:{}});
    return Response.json({ok:true,message:'Password reset email sent.'});
  }

  if(PROTECTED_ADMIN_EMAILS.has(email) && ['set-role','set-permissions','deactivate','delete'].includes(action)){
    return Response.json({error:'Protected administrator accounts cannot be changed here.'},{status:403});
  }

  if(action==='set-role'||action==='reactivate'){
    const role=clean(body.role,40).toLowerCase();
    if(!STAFF_ROLES.has(role)) return Response.json({error:'Choose Sales Rep, Manager, or Administrator.'},{status:400});
    const previous=effectiveRole(current);
    const appMetadata={...metadataFor(current),roles:[role],active:true,permissions:permissionsFor(current)};
    const updated:any=await admin.updateUser(userId,{role,app_metadata:appMetadata});
    await appendStaffAudit(context,{actor,action:action==='reactivate'?'staff_reactivated':'staff_role_changed',subjectId:userId,subjectEmail:email,detail:(action==='reactivate'?'Reactivated ':'Changed role for ')+email+' to '+role+'.',metadata:{from:previous,to:role}});
    return Response.json({ok:true,user:normalizeUser(updated)});
  }

  if(action==='set-permissions'){
    const requested=Array.isArray(body.permissions)?body.permissions.map((v:any)=>clean(v,80).toLowerCase()):[];
    const permissions=[...new Set(requested.filter((v:string)=>STAFF_CAPABILITIES.includes(v as any)))];
    const appMetadata={...metadataFor(current),permissions};
    const updated:any=await admin.updateUser(userId,{app_metadata:appMetadata});
    await appendStaffAudit(context,{actor,action:'staff_permissions_changed',subjectId:userId,subjectEmail:email,detail:'Updated individual permissions for '+email+'.',metadata:{from:permissionsFor(current),to:permissions}});
    return Response.json({ok:true,user:normalizeUser(updated)});
  }

  if(action==='deactivate'){
    const previous=effectiveRole(current);
    const appMetadata={...metadataFor(current),roles:['deactivated'],active:false,previousRole:previous,permissions:permissionsFor(current)};
    const updated:any=await admin.updateUser(userId,{role:'deactivated',app_metadata:appMetadata});
    await appendStaffAudit(context,{actor,action:'staff_deactivated',subjectId:userId,subjectEmail:email,detail:'Deactivated '+email+'.',metadata:{previousRole:previous}});
    return Response.json({ok:true,user:normalizeUser(updated)});
  }

  if(action==='delete'){
    await appendStaffAudit(context,{actor,action:'staff_deleted',subjectId:userId,subjectEmail:email,detail:'Permanently deleted Identity account '+email+'.',metadata:{role:effectiveRole(current),permissions:permissionsFor(current)}});
    await admin.deleteUser(userId);
    return Response.json({ok:true,deletedId:userId});
  }

  return Response.json({error:'Unknown staff action.'},{status:400});
};

export const config: Config = { path:'/api/admin/staff' };
