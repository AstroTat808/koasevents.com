import type { Context, Config } from '@netlify/functions';
import { admin } from '@netlify/identity';
import { requireAdmin } from './_shared/admin';
import { listManagedSessions, readAuthEvents, revokeAllManagedSessions, revokeManagedSession } from './_shared/auth-security';
import { appendStaffAudit } from './_shared/staff-audit';

function clean(v:unknown,max=300){return String(v||'').trim().slice(0,max);}
function email(user:any){return clean(user?.email,240).toLowerCase();}

export default async(req:Request,context:Context)=>{
  const auth=await requireAdmin(req);if(auth.response)return auth.response;
  const actor=email(auth.user)||'admin';

  if(req.method==='GET'){
    const url=new URL(req.url);
    const userId=clean(url.searchParams.get('userId'),120);
    const events=await readAuthEvents(1000);
    if(userId){
      const user:any=await admin.getUser(userId);
      if(!user)return Response.json({error:'User not found.'},{status:404});
      const sessions=await listManagedSessions(userId,req);
      return Response.json({user:{id:userId,email:email(user),name:clean(user?.userMetadata?.full_name||user?.user_metadata?.full_name,180)},sessions,events:events.filter(e=>e.userId===userId||e.email===email(user)).slice(0,300)},{headers:{'Cache-Control':'private, no-store'}});
    }
    const users=await admin.listUsers({page:1,perPage:200});
    const summaries=await Promise.all(users.map(async(user:any)=>{
      const sessions=await listManagedSessions(clean(user.id,120));
      return {id:clean(user.id,120),email:email(user),name:clean(user?.userMetadata?.full_name||user?.user_metadata?.full_name,180),activeSessions:sessions.filter(s=>s.active).length,lastSeen:sessions[0]?.lastSeenAt||'',suspiciousEvents:events.filter(e=>(e.userId===user.id||e.email===email(user))&&e.suspicious).length};
    }));
    return Response.json({users:summaries,events:events.slice(0,500),mfa:{status:'readiness_only',provider:'Netlify Identity',enforced:false,note:'MFA policy hooks and UI readiness are present; account-level MFA enforcement requires an Identity provider that exposes supported MFA enrollment and verification APIs.'}},{headers:{'Cache-Control':'private, no-store'}});
  }

  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  const body:any=await req.json().catch(()=>null);if(!body)return Response.json({error:'Invalid JSON.'},{status:400});
  const action=clean(body.action,50),userId=clean(body.userId,120);
  if(!userId)return Response.json({error:'User ID required.'},{status:400});
  const user:any=await admin.getUser(userId);if(!user)return Response.json({error:'User not found.'},{status:404});

  if(action==='revoke-session'){
    const sessionId=clean(body.sessionId,100);if(!sessionId)return Response.json({error:'Session ID required.'},{status:400});
    const row=await revokeManagedSession(userId,sessionId,actor,context,email(user));
    await appendStaffAudit(context,{actor,action:'session_revoked',subjectId:userId,subjectEmail:email(user),detail:'Revoked one tracked session for '+email(user)+'.',metadata:{sessionId}});
    return Response.json({ok:true,session:row});
  }

  if(action==='revoke-all'){
    const rows=await revokeAllManagedSessions(userId,actor,context,email(user));
    await appendStaffAudit(context,{actor,action:'sessions_revoked',subjectId:userId,subjectEmail:email(user),detail:'Revoked all tracked sessions for '+email(user)+'.',metadata:{count:rows.length}});
    return Response.json({ok:true,count:rows.length});
  }

  return Response.json({error:'Unknown authentication-security action.'},{status:400});
};

export const config:Config={path:'/api/admin/auth-security'};
