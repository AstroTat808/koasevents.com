import type { Context, Config } from '@netlify/functions';
import { admin } from '@netlify/identity';
import { requireAdmin } from './_shared/admin';

const PROTECTED_ADMIN_EMAILS = new Set(['chris@sibel.org','koasadmin@koasevents.com']);
const STAFF_ROLES = new Set(['sales','manager']);

function clean(value: unknown, max=300) {
  return String(value || '').trim().slice(0,max);
}
function normalizeEmail(value: unknown) {
  return clean(value,240).toLowerCase();
}
function randomPassword() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  const raw = Array.from(bytes, b => b.toString(36).padStart(2,'0')).join('');
  return 'Koa!' + raw.slice(0,18) + '9a';
}
function rolesFor(user:any) {
  const candidates=[user?.roles,user?.appMetadata?.roles,user?.app_metadata?.roles];
  const roles=candidates.find(Array.isArray)||[];
  return roles.map((role:any)=>clean(role,40).toLowerCase()).filter(Boolean);
}
function effectiveRole(user:any) {
  const email=normalizeEmail(user?.email);
  if(PROTECTED_ADMIN_EMAILS.has(email)||rolesFor(user).includes('admin')||clean(user?.role,40).toLowerCase()==='admin') return 'admin';
  const roles=rolesFor(user);
  if(roles.includes('deactivated')||user?.appMetadata?.active===false||user?.app_metadata?.active===false) return 'deactivated';
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
      from,
      to:[email],
      subject:'Your Koa\'s Events staff account',
      html:`<div style="font-family:Arial,sans-serif;line-height:1.6;color:#23352f">
        <h2 style="margin:0 0 16px">Aloha ${name||'there'},</h2>
        <p>Your Koa's Events staff account has been created with <strong>${role==='manager'?'Manager':'Sales Rep'}</strong> access.</p>
        <p>Sign in at <a href="https://koasevents.com/staff/">https://koasevents.com/staff/</a> using:</p>
        <p><strong>Email:</strong> ${email}<br><strong>Temporary password:</strong> ${password}</p>
        <p>After signing in, use the Change Password option in the Staff Workspace to set your own password.</p>
        <p>Mahalo,<br>Koa's Events</p>
      </div>`,
    }),
  });
  const data:any=await response.json().catch(()=>({}));
  return response.ok?{sent:true,id:clean(data?.id,120)}:{sent:false,error:clean(data?.message||data?.error||'Email delivery failed.',500)};
}

export default async (req:Request,_context:Context) => {
  const auth=await requireAdmin();
  if(auth.response) return auth.response;

  if(req.method==='GET'){
    const users=await admin.listUsers({page:1,perPage:200});
    return Response.json({users:users.map(normalizeUser).sort((a,b)=>a.email.localeCompare(b.email))},{headers:{'Cache-Control':'private, no-store'}});
  }

  if(req.method!=='POST') return new Response('Method not allowed',{status:405});
  const body:any=await req.json().catch(()=>null);
  if(!body) return Response.json({error:'Invalid JSON.'},{status:400});
  const action=clean(body.action,40);

  if(action==='invite'){
    const email=normalizeEmail(body.email);
    const name=clean(body.name,180);
    const role=clean(body.role,40).toLowerCase();
    if(!email.includes('@')) return Response.json({error:'A valid email is required.'},{status:400});
    if(!STAFF_ROLES.has(role)) return Response.json({error:'Choose Sales Rep or Manager.'},{status:400});
    const existing=(await admin.listUsers({page:1,perPage:200})).find((u:any)=>normalizeEmail(u?.email)===email);
    if(existing) return Response.json({error:'That email already has an Identity account. Change its role instead.'},{status:409});
    const password=randomPassword();
    const created:any=await admin.createUser({
      email,
      password,
      data:{
        role,
        app_metadata:{roles:[role],active:true},
        user_metadata:{full_name:name},
      },
    });
    const delivery=await sendInviteEmail(email,name,role,password);
    return Response.json({
      ok:true,
      user:normalizeUser(created),
      inviteEmailSent:delivery.sent,
      inviteMessageId:delivery.sent?delivery.id:'',
      temporaryPassword:delivery.sent?'':password,
      emailError:delivery.sent?'':delivery.error,
    });
  }

  const userId=clean(body.userId,120);
  if(!userId) return Response.json({error:'User ID required.'},{status:400});
  const current:any=await admin.getUser(userId);
  const email=normalizeEmail(current?.email);
  if(PROTECTED_ADMIN_EMAILS.has(email) && ['set-role','deactivate','delete'].includes(action)){
    return Response.json({error:'Protected administrator accounts cannot be changed here.'},{status:403});
  }

  if(action==='set-role'||action==='reactivate'){
    const role=clean(body.role,40).toLowerCase();
    if(!STAFF_ROLES.has(role)) return Response.json({error:'Choose Sales Rep or Manager.'},{status:400});
    const appMetadata={...(current?.appMetadata||current?.app_metadata||{}),roles:[role],active:true};
    const updated:any=await admin.updateUser(userId,{role,app_metadata:appMetadata});
    return Response.json({ok:true,user:normalizeUser(updated)});
  }

  if(action==='deactivate'){
    const appMetadata={...(current?.appMetadata||current?.app_metadata||{}),roles:['deactivated'],active:false};
    const updated:any=await admin.updateUser(userId,{role:'deactivated',app_metadata:appMetadata});
    return Response.json({ok:true,user:normalizeUser(updated)});
  }

  if(action==='delete'){
    await admin.deleteUser(userId);
    return Response.json({ok:true,deletedId:userId});
  }

  return Response.json({error:'Unknown staff action.'},{status:400});
};

export const config: Config = { path:'/api/admin/staff' };
