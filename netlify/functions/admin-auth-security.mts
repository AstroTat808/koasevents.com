import type { Context, Config } from '@netlify/functions';
import { admin } from '@netlify/identity';
import { requireAdmin } from './_shared/admin';
import {
  auditHistoricalLoginAlerts,
  listManagedSessions,
  readAuthEvents,
  readTrustedDevices,
  revokeAllManagedSessions,
  revokeManagedSession,
  summarizeSecurityActivity,
  trustKnownDevice,
  untrustKnownDevice,
} from './_shared/auth-security';
import { appendStaffAudit } from './_shared/staff-audit';

function clean(v:unknown,max=300){return String(v||'').trim().slice(0,max);}
function email(user:any){return clean(user?.email,240).toLowerCase();}

export default async(req:Request,context:Context)=>{
  const auth=await requireAdmin(req);if(auth.response)return auth.response;
  const actor=email(auth.user)||'admin';

  if(req.method==='GET'){
    const url=new URL(req.url);
    const userId=clean(url.searchParams.get('userId'),120);
    const events=await readAuthEvents(2000);
    if(userId){
      const user:any=await admin.getUser(userId);
      if(!user)return Response.json({error:'User not found.'},{status:404});
      const [sessions,trustedDevices]=await Promise.all([
        listManagedSessions(userId,req),
        readTrustedDevices(userId),
      ]);
      const trusted=new Set(trustedDevices.map((row)=>row.fingerprint));
      const userEvents=events
        .filter((event)=>event.userId===userId||event.email===email(user))
        .slice(0,300)
        .map((event)=>({
          ...event,
          trustedDevice:event.deviceFingerprint
            ?trusted.has(event.deviceFingerprint)
            :Boolean(event.trustedDevice),
        }));
      return Response.json({
        user:{id:userId,email:email(user),name:clean(user?.userMetadata?.full_name||user?.user_metadata?.full_name,180)},
        sessions,
        trustedDevices,
        events:userEvents,
        policyAudit:auditHistoricalLoginAlerts(userEvents),
        activitySummary:[7,30,90].map((days)=>summarizeSecurityActivity(userEvents,trustedDevices.length,days)),
      },{headers:{'Cache-Control':'private, no-store'}});
    }

    const users=await admin.listUsers({page:1,perPage:200});
    const summaries=await Promise.all(users.map(async(user:any)=>{
      const userId=clean(user.id,120);
      const [sessions,trustedDevices]=await Promise.all([
        listManagedSessions(userId),
        readTrustedDevices(userId),
      ]);
      const trusted=new Set(trustedDevices.map((row)=>row.fingerprint));
      const userEvents=events.filter((event)=>event.userId===user.id||event.email===email(user));
      return {
        id:userId,
        email:email(user),
        name:clean(user?.userMetadata?.full_name||user?.user_metadata?.full_name,180),
        activeSessions:sessions.filter((session)=>session.active).length,
        trustedDevices:trustedDevices.length,
        lastSeen:sessions[0]?.lastSeenAt||'',
        suspiciousEvents:userEvents.filter((event)=>event.suspicious&&!(event.deviceFingerprint&&trusted.has(event.deviceFingerprint))).length,
      };
    }));
    const trustedDeviceCount=summaries.reduce((sum,row)=>sum+Number(row.trustedDevices||0),0);
    return Response.json({
      users:summaries,
      events:events.slice(0,500),
      policyAudit:auditHistoricalLoginAlerts(events),
      activitySummary:[7,30,90].map((days)=>summarizeSecurityActivity(events,trustedDeviceCount,days)),
      mfa:{
        status:'readiness_only',
        provider:'Netlify Identity',
        enforced:false,
        note:'MFA policy hooks and UI readiness are present; account-level MFA enforcement requires an Identity provider that exposes supported MFA enrollment and verification APIs.',
      },
    },{headers:{'Cache-Control':'private, no-store'}});
  }

  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  const body:any=await req.json().catch(()=>null);if(!body)return Response.json({error:'Invalid JSON.'},{status:400});
  const action=clean(body.action,50),userId=clean(body.userId,120);
  if(!userId)return Response.json({error:'User ID required.'},{status:400});
  const user:any=await admin.getUser(userId);if(!user)return Response.json({error:'User not found.'},{status:404});

  if(action==='revoke-session'){
    const sessionId=clean(body.sessionId,160);if(!sessionId)return Response.json({error:'Session ID required.'},{status:400});
    const row=await revokeManagedSession(userId,sessionId,actor,context,email(user));
    await appendStaffAudit(context,{actor,action:'session_revoked',subjectId:userId,subjectEmail:email(user),detail:'Revoked one tracked session for '+email(user)+'.',metadata:{sessionId}});
    return Response.json({ok:true,session:row});
  }

  if(action==='revoke-all'){
    const rows=await revokeAllManagedSessions(userId,actor,context,email(user));
    await appendStaffAudit(context,{actor,action:'sessions_revoked',subjectId:userId,subjectEmail:email(user),detail:'Revoked all tracked sessions for '+email(user)+'.',metadata:{count:rows.length}});
    return Response.json({ok:true,count:rows.length});
  }

  if(action==='trust-device'){
    const deviceFingerprint=clean(body.deviceFingerprint||body.sessionId,160);
    if(!deviceFingerprint)return Response.json({error:'Device fingerprint required.'},{status:400});
    const row=await trustKnownDevice(userId,deviceFingerprint,actor,context,email(user));
    await appendStaffAudit(context,{
      actor,
      action:'device_trusted',
      subjectId:userId,
      subjectEmail:email(user),
      detail:'Marked '+row.device+' as a trusted sign-in device for '+email(user)+'.',
      metadata:{deviceFingerprint:row.fingerprint,device:row.device},
    });
    return Response.json({ok:true,trustedDevice:row});
  }

  if(action==='untrust-device'){
    const deviceFingerprint=clean(body.deviceFingerprint||body.sessionId,160);
    if(!deviceFingerprint)return Response.json({error:'Device fingerprint required.'},{status:400});
    const row=await untrustKnownDevice(userId,deviceFingerprint,actor,context,email(user));
    await appendStaffAudit(context,{
      actor,
      action:'device_untrusted',
      subjectId:userId,
      subjectEmail:email(user),
      detail:'Removed trusted-device status from '+row.device+' for '+email(user)+'.',
      metadata:{deviceFingerprint:row.fingerprint,device:row.device},
    });
    return Response.json({ok:true,deviceFingerprint:row.fingerprint});
  }

  return Response.json({error:'Unknown authentication-security action.'},{status:400});
};

export const config:Config={path:'/api/admin/auth-security'};
