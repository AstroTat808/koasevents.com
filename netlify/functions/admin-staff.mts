import type { Context, Config } from '@netlify/functions';
import { admin, requestPasswordRecovery } from '@netlify/identity';
import {
  requireAdmin,
  STAFF_CAPABILITIES,
  ROLE_IDS,
  ROLE_LABELS,
  ROLE_CAPABILITIES,
  readAuthSecurityPolicy,
  saveAuthSecurityPolicy,
  passwordSecurityFor,
  type StaffRole,
} from './_shared/admin';
import { appendStaffAudit, readStaffAudit } from './_shared/staff-audit';

const PROTECTED_ADMIN_EMAILS = new Set(['chris@sibel.org','koasadmin@koasevents.com']);
const USER_ROLES = new Set<string>(ROLE_IDS);

const CAPABILITY_LABELS:Record<string,string>={
  'admin.dashboard.view':'View Admin dashboard',
  'users.manage':'Manage users + security',
  'crm.view':'View Business CRM',
  'crm.manage':'Edit Business CRM',
  'crm.destructive':'Trash / restore CRM clients',
  'crm.workflows':'Manage CRM workflows',
  'crm.templates':'Manage CRM templates',
  'crm.cleanup_policy':'Change CRM cleanup policy',
  'sales.view':'View Sales CRM',
  'sales.manage':'Edit Sales CRM',
  'sales.profit_settings':'Change sales profitability settings',
  'events.view':'View Event Ops',
  'event_ops.manage':'Edit Event Ops',
  'calendar.view':'View Master Calendar',
  'quickbooks.view':'View QuickBooks',
  'quickbooks.manage':'Manage QuickBooks',
  'vendors.view':'View Vendor CRM',
  'vendors.manage':'Manage vendors',
  'insurance.view':'View insurance compliance',
  'insurance.manage':'Manage insurance compliance',
  'blog.view':'View Blog Admin',
  'blog.manage':'Publish + manage Blog',
  'gallery.view':'View Gallery Admin',
  'gallery.manage':'Manage Gallery',
  'seo.view':'View Local SEO',
  'seo.manage':'Manage Local SEO',
  'security.view':'View Security + Spam',
  'security.manage':'Manage Security + Spam',
  'health.view':'View System Health',
  'health.manage':'Manage System Health',
};

function clean(value:unknown,max=300){return String(value||'').trim().slice(0,max);}
function normalizeEmail(value:unknown){return clean(value,240).toLowerCase();}
function normalizeRole(value:unknown){return clean(value,60).toLowerCase().replaceAll('-','_').replaceAll(' ','_');}
function strongTemporaryPassword(){const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);const raw=Array.from(bytes,b=>b.toString(36).padStart(2,'0')).join('');return 'Koa!'+raw.slice(0,28)+'9a';}
function validatePassword(value:unknown){const password=String(value??'');if(password.length<10)return{ok:false,error:'Password must be at least 10 characters.'};if(password.length>128)return{ok:false,error:'Password must be 128 characters or fewer.'};return{ok:true,password};}
function metadataFor(user:any){return user?.appMetadata||user?.app_metadata||{};}
function rolesFor(user:any){const candidates=[user?.roles,user?.appMetadata?.roles,user?.app_metadata?.roles];const roles=candidates.find(Array.isArray)||[];return roles.map((role:any)=>normalizeRole(role)).filter(Boolean);}
function permissionsFor(user:any){const values=metadataFor(user)?.permissions;return Array.isArray(values)?values.map((permission:any)=>clean(permission,100).toLowerCase()).filter((permission:string)=>STAFF_CAPABILITIES.includes(permission as any)):[];}
function sessionVersion(user:any){const n=Number(metadataFor(user)?.sessionVersion??0);return Number.isFinite(n)&&n>=0?Math.floor(n):0;}
function isDeactivated(user:any){return rolesFor(user).includes('deactivated')||metadataFor(user)?.active===false;}
function effectiveRole(user:any):StaffRole|'custom'|'deactivated'|'none'{
  const email=normalizeEmail(user?.email);
  if(PROTECTED_ADMIN_EMAILS.has(email))return 'admin';
  if(isDeactivated(user))return 'deactivated';
  const candidates=[...rolesFor(user),normalizeRole(user?.role)];
  for(const role of ROLE_IDS)if(candidates.includes(role))return role;
  if(candidates.includes('custom'))return 'custom';
  if(candidates.includes('staff'))return 'sales';
  return 'none';
}
function normalizedName(user:any){return clean(user?.name||user?.userMetadata?.full_name||user?.user_metadata?.full_name,180);}
function publicRoleLabel(role:string){return (ROLE_LABELS as Record<string,string>)[role]||role.replaceAll('_',' ');}
async function allUsers(){return await admin.listUsers({page:1,perPage:200});}
function activeAdminCount(users:any[]){return users.filter(user=>!isDeactivated(user)&&effectiveRole(user)==='admin').length;}
function ensureCanModifyTarget(actor:any,target:any,action:string){
  const actorEmail=normalizeEmail(actor?.email),targetEmail=normalizeEmail(target?.email);
  const actorId=clean(actor?.id,120),targetId=clean(target?.id,120);
  if(PROTECTED_ADMIN_EMAILS.has(targetEmail)&&!PROTECTED_ADMIN_EMAILS.has(actorEmail))return 'Only a protected Koa’s administrator can modify another protected administrator account.';
  if(actorId&&actorId===targetId&&['deactivate','delete','revoke-sessions'].includes(action))return 'You cannot perform that action on the account you are currently using.';
  return '';
}
async function normalizeUser(user:any,policy:any){
  const confirmedAt=clean(user?.confirmedAt||user?.confirmed_at,80);
  const security=passwordSecurityFor(user,user,policy);
  return {
    id:clean(user?.id,120),
    email:normalizeEmail(user?.email),
    name:normalizedName(user),
    role:effectiveRole(user),
    roleLabel:effectiveRole(user)==='custom'?(clean(metadataFor(user)?.customRoleName,100)||'Custom Role'):publicRoleLabel(effectiveRole(user)),
    customRoleId:clean(metadataFor(user)?.customRoleId,100),
    permissions:permissionsFor(user),
    active:!isDeactivated(user),
    status:isDeactivated(user)?'deactivated':confirmedAt?'active':'pending',
    confirmedAt,
    createdAt:clean(user?.createdAt||user?.created_at,80),
    updatedAt:clean(user?.updatedAt||user?.updated_at,80),
    lastSignInAt:clean(user?.lastSignInAt||user?.last_sign_in_at,80),
    protected:PROTECTED_ADMIN_EMAILS.has(normalizeEmail(user?.email)),
    security:{
      forcePasswordChange:security.forcePasswordChange,
      passwordChangedAt:security.passwordChangedAt,
      passwordExpiresAt:security.passwordExpiresAt,
      passwordExpired:security.passwordExpired,
      passwordExpiryDays:security.passwordExpiryDays,
      sessionVersion:sessionVersion(user),
    },
  };
}

export default async(req:Request,context:Context)=>{
  const auth=await requireAdmin();if(auth.response)return auth.response;
  const actor=normalizeEmail(auth.user?.email)||'admin';
  const actorId=clean(auth.user?.id,120);
  const policy=await readAuthSecurityPolicy();

  if(req.method==='GET'){
    const [users,audit]=await Promise.all([allUsers(),readStaffAudit(context,500)]);
    const normalized=await Promise.all(users.map((user:any)=>normalizeUser(user,policy)));
    normalized.sort((a,b)=>{
      const order:Record<string,number>={admin:0,manager:1,event_coordinator:2,vendor_manager:3,content_editor:4,accounting:5,sales:6,custom:7,read_only:8,deactivated:9,none:10};
      return (order[a.role]??99)-(order[b.role]??99)||a.email.localeCompare(b.email);
    });
    return Response.json({
      users:normalized,
      audit,
      policy,
      roles:ROLE_IDS.map(id=>({id,label:ROLE_LABELS[id],capabilities:ROLE_CAPABILITIES[id]})),
      capabilities:STAFF_CAPABILITIES.map(id=>({id,label:CAPABILITY_LABELS[id]||id})),
      summary:{
        total:normalized.length,
        active:normalized.filter(user=>user.status==='active').length,
        pending:normalized.filter(user=>user.status==='pending').length,
        deactivated:normalized.filter(user=>user.status==='deactivated').length,
        passwordAttention:normalized.filter(user=>user.security?.forcePasswordChange||user.security?.passwordExpired).length,
      },
    },{headers:{'Cache-Control':'private, no-store'}});
  }

  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  const body:any=await req.json().catch(()=>null);if(!body)return Response.json({error:'Invalid JSON.'},{status:400});
  const action=clean(body.action,60);

  if(action==='save-security-policy'){
    const saved=await saveAuthSecurityPolicy({
      passwordExpiryDays:Number(body.passwordExpiryDays),
      requireChangeOnAdminSet:body.requireChangeOnAdminSet!==false,
    },actor);
    await appendStaffAudit(context,{actor,action:'auth_security_policy_changed',detail:'Updated password-expiration and forced-change policy.',metadata:saved});
    return Response.json({ok:true,policy:saved});
  }

  if(action==='create-user'||action==='invite'){
    const email=normalizeEmail(body.email),name=clean(body.name,180),role=normalizeRole(body.role),setupMode=clean(body.setupMode||'email',20).toLowerCase();
    if(!email.includes('@'))return Response.json({error:'A valid email is required.'},{status:400});
    if(!name)return Response.json({error:'Name is required.'},{status:400});
    if(!USER_ROLES.has(role))return Response.json({error:'Choose a valid Koa’s role.'},{status:400});
    if(!['email','manual'].includes(setupMode))return Response.json({error:'Choose email setup or set password now.'},{status:400});
    const users=await allUsers();if(users.find((user:any)=>normalizeEmail(user?.email)===email))return Response.json({error:'That email already has an account. Edit the existing user instead.'},{status:409});

    let password=strongTemporaryPassword();
    if(setupMode==='manual'){const validation=validatePassword(body.password);if(!validation.ok)return Response.json({error:validation.error},{status:400});password=validation.password!;}
    const now=new Date().toISOString();
    const created:any=await admin.createUser({
      email,password,
      data:{
        role,
        app_metadata:{
          roles:[role],
          active:true,
          permissions:[],
          forcePasswordChange:setupMode==='manual'||policy.requireChangeOnAdminSet,
          passwordChangedAt:setupMode==='manual'?now:'',
          sessionVersion:0,
        },
        user_metadata:{full_name:name},
      },
    });

    let setupEmailSent=false,setupEmailError='';
    if(setupMode==='email'){
      try{await requestPasswordRecovery(email);setupEmailSent=true;}
      catch(error){setupEmailError=error instanceof Error?clean(error.message,500):'Password setup email failed.';}
    }
    await appendStaffAudit(context,{actor,action:'user_created',subjectId:clean(created?.id,120),subjectEmail:email,detail:'Created '+publicRoleLabel(role)+' account for '+email+'.',metadata:{role,setupMode,setupEmailSent}});
    return Response.json({ok:true,user:await normalizeUser(created,policy),setupMode,setupEmailSent,setupEmailError,message:setupMode==='email'?(setupEmailSent?'Account created and password setup email sent.':'Account created, but the setup email could not be sent.'):'Account created with the password you set. A password change will be required at next sign-in.'});
  }

  const userId=clean(body.userId,120);if(!userId)return Response.json({error:'User ID required.'},{status:400});
  const current:any=await admin.getUser(userId);if(!current)return Response.json({error:'User not found.'},{status:404});
  const email=normalizeEmail(current?.email);
  const guardError=ensureCanModifyTarget(auth.user,current,action);if(guardError)return Response.json({error:guardError},{status:403});

  if(action==='reset-password'||action==='resend-setup'){
    const nextVersion=sessionVersion(current)+1;
    await admin.updateUser(userId,{app_metadata:{...metadataFor(current),forcePasswordChange:true,sessionVersion:nextVersion}});
    await requestPasswordRecovery(email);
    await appendStaffAudit(context,{actor,action:'password_reset_sent',subjectId:userId,subjectEmail:email,detail:'Sent password setup/reset email and revoked existing sessions for '+email+'.',metadata:{sessionVersion:nextVersion}});
    return Response.json({ok:true,message:'Password setup/reset email sent. Existing sessions were revoked.'});
  }

  if(action==='set-password'){
    const validation=validatePassword(body.password);if(!validation.ok)return Response.json({error:validation.error},{status:400});
    const nextVersion=sessionVersion(current)+1;
    const now=new Date().toISOString();
    await admin.updateUser(userId,{
      password:validation.password,
      app_metadata:{
        ...metadataFor(current),
        forcePasswordChange:policy.requireChangeOnAdminSet,
        passwordChangedAt:now,
        sessionVersion:nextVersion,
      },
    });
    await appendStaffAudit(context,{actor,action:'password_set_by_admin',subjectId:userId,subjectEmail:email,detail:'Administrator set a new password for '+email+' and revoked existing sessions.',metadata:{sessionVersion:nextVersion,forcePasswordChange:policy.requireChangeOnAdminSet}});
    return Response.json({ok:true,message:policy.requireChangeOnAdminSet?'Password updated. User must change it at next sign-in.':'Password updated.'});
  }

  if(action==='force-password-change'){
    const force=body.force!==false;
    const updated:any=await admin.updateUser(userId,{app_metadata:{...metadataFor(current),forcePasswordChange:force}});
    await appendStaffAudit(context,{actor,action:force?'password_change_forced':'password_change_force_cleared',subjectId:userId,subjectEmail:email,detail:(force?'Required':'Cleared required')+' password change for '+email+'.',metadata:{force}});
    return Response.json({ok:true,user:await normalizeUser(updated,policy)});
  }

  if(action==='revoke-sessions'){
    const nextVersion=sessionVersion(current)+1;
    const updated:any=await admin.updateUser(userId,{app_metadata:{...metadataFor(current),sessionVersion:nextVersion}});
    await appendStaffAudit(context,{actor,action:'sessions_revoked',subjectId:userId,subjectEmail:email,detail:'Signed '+email+' out everywhere by revoking existing sessions.',metadata:{sessionVersion:nextVersion}});
    return Response.json({ok:true,user:await normalizeUser(updated,policy),message:'Existing sessions revoked. The user must sign in again.'});
  }

  if(action==='set-name'){
    const name=clean(body.name,180);if(!name)return Response.json({error:'Name is required.'},{status:400});
    const updated:any=await admin.updateUser(userId,{user_metadata:{...(current?.userMetadata||current?.user_metadata||{}),full_name:name}});
    await appendStaffAudit(context,{actor,action:'user_name_changed',subjectId:userId,subjectEmail:email,detail:'Changed display name for '+email+' to '+name+'.',metadata:{from:normalizedName(current),to:name}});
    return Response.json({ok:true,user:await normalizeUser(updated,policy)});
  }

  if(action==='set-role'){
    const role=normalizeRole(body.role);if(!USER_ROLES.has(role))return Response.json({error:'Choose a valid Koa’s role.'},{status:400});
    const previous=effectiveRole(current);
    if(current?.id===actorId&&role!=='admin')return Response.json({error:'You cannot remove Administrator access from the account you are currently using.'},{status:403});
    if(PROTECTED_ADMIN_EMAILS.has(email)&&role!=='admin')return Response.json({error:'Protected administrator accounts must remain Administrators.'},{status:403});
    if(previous==='admin'&&role!=='admin'){const users=await allUsers();if(activeAdminCount(users)<=1)return Response.json({error:'At least one active Administrator account must remain.'},{status:409});}
    const nextVersion=sessionVersion(current)+1;
    const updated:any=await admin.updateUser(userId,{role,app_metadata:{...metadataFor(current),roles:[role],active:true,previousRole:undefined,customRoleId:undefined,customRoleName:undefined,permissions:permissionsFor(current),sessionVersion:nextVersion}});
    await appendStaffAudit(context,{actor,action:'user_role_changed',subjectId:userId,subjectEmail:email,detail:'Changed role for '+email+' from '+previous+' to '+role+'. Existing sessions were revoked.',metadata:{from:previous,to:role,sessionVersion:nextVersion}});
    return Response.json({ok:true,user:await normalizeUser(updated,policy)});
  }

  if(action==='set-permissions'){
    if(effectiveRole(current)==='admin')return Response.json({error:'Administrators already have all permissions.'},{status:400});
    const requested=Array.isArray(body.permissions)?body.permissions.map((value:any)=>clean(value,100).toLowerCase()):[];
    const permissions=[...new Set(requested.filter((value:string)=>STAFF_CAPABILITIES.includes(value as any)))];
    const nextVersion=sessionVersion(current)+1;
    const updated:any=await admin.updateUser(userId,{app_metadata:{...metadataFor(current),permissions,sessionVersion:nextVersion}});
    await appendStaffAudit(context,{actor,action:'user_permissions_changed',subjectId:userId,subjectEmail:email,detail:'Updated individual permissions for '+email+'. Existing sessions were revoked.',metadata:{from:permissionsFor(current),to:permissions,sessionVersion:nextVersion}});
    return Response.json({ok:true,user:await normalizeUser(updated,policy)});
  }

  if(action==='deactivate'){
    if(PROTECTED_ADMIN_EMAILS.has(email))return Response.json({error:'Protected administrator accounts cannot be deactivated.'},{status:403});
    if(effectiveRole(current)==='admin'){const users=await allUsers();if(activeAdminCount(users)<=1)return Response.json({error:'At least one active Administrator account must remain.'},{status:409});}
    const previous=effectiveRole(current),nextVersion=sessionVersion(current)+1;
    const updated:any=await admin.updateUser(userId,{role:'deactivated',app_metadata:{...metadataFor(current),roles:['deactivated'],active:false,previousRole:previous==='deactivated'?clean(metadataFor(current)?.previousRole,60)||'sales':previous,permissions:permissionsFor(current),sessionVersion:nextVersion}});
    await appendStaffAudit(context,{actor,action:'user_deactivated',subjectId:userId,subjectEmail:email,detail:'Deactivated '+email+' and revoked existing sessions.',metadata:{previousRole:previous,sessionVersion:nextVersion}});
    return Response.json({ok:true,user:await normalizeUser(updated,policy)});
  }

  if(action==='reactivate'){
    const requested=normalizeRole(body.role),stored=normalizeRole(metadataFor(current)?.previousRole);
    const role=USER_ROLES.has(requested)?requested:USER_ROLES.has(stored)?stored:'sales';
    const nextVersion=sessionVersion(current)+1;
    const updated:any=await admin.updateUser(userId,{role,app_metadata:{...metadataFor(current),roles:[role],active:true,previousRole:undefined,customRoleId:undefined,customRoleName:undefined,permissions:permissionsFor(current),sessionVersion:nextVersion}});
    await appendStaffAudit(context,{actor,action:'user_reactivated',subjectId:userId,subjectEmail:email,detail:'Reactivated '+email+' as '+role+'.',metadata:{role,sessionVersion:nextVersion}});
    return Response.json({ok:true,user:await normalizeUser(updated,policy)});
  }

  if(action==='delete'){
    if(PROTECTED_ADMIN_EMAILS.has(email))return Response.json({error:'Protected administrator accounts cannot be deleted.'},{status:403});
    if(effectiveRole(current)==='admin'){const users=await allUsers();if(activeAdminCount(users)<=1)return Response.json({error:'At least one active Administrator account must remain.'},{status:409});}
    await appendStaffAudit(context,{actor,action:'user_deleted',subjectId:userId,subjectEmail:email,detail:'Permanently deleted account '+email+'.',metadata:{role:effectiveRole(current),permissions:permissionsFor(current)}});
    await admin.deleteUser(userId);return Response.json({ok:true,deletedId:userId});
  }

  return Response.json({error:'Unknown user-management action.'},{status:400});
};

export const config:Config={path:'/api/admin/staff'};
