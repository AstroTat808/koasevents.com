import type { Context, Config } from '@netlify/functions';
import { getUser } from '@netlify/identity';
import {
  appendAuthEvent,
  evaluateLoginRisk,
  registerManagedSession,
  managedSessionStatus,
  revokeManagedSession,
  recordLoginFailureSignal,
  requestDeviceFingerprint,
  requestUserAgent,
  sendSuspiciousLoginAlert,
  TRUSTED_DEVICE_COOKIE_MAX_AGE_SECONDS,
  REMEMBER_SESSION_MAX_AGE_SECONDS,
  REMEMBER_SESSION_COOKIE,
} from './_shared/auth-security';
import { ipFingerprint } from './_shared/security';

function clean(v:unknown,max=300){return String(v||'').trim().slice(0,max);}
function rawCookieValue(req:Request,name:string){
  const entry=String(req.headers.get('cookie')||'').split(';').map(p=>p.trim())
    .find(p=>p.startsWith(name+'='));
  const raw=entry?entry.slice(name.length+1):'';
  // Strictly constrain Set-Cookie value syntax; do not decode or expose it.
  return /^[A-Za-z0-9_~.%+\/-]{1,8192}$/.test(raw)?raw:'';
}
function sameOrigin(req:Request){
  const origin=clean(req.headers.get('origin'),300);
  if(!origin)return true;
  try{return new URL(origin).origin===new URL(req.url).origin;}catch{return false;}
}

export default async(req:Request,context:Context)=>{
  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  if(!sameOrigin(req))return Response.json({error:'Invalid request origin.'},{status:403});
  const body:any=await req.json().catch(()=>null);if(!body)return Response.json({error:'Invalid JSON.'},{status:400});
  const action=clean(body.action,40);
  const email=clean(body.email,240).toLowerCase();
  const ip=await ipFingerprint(req);
  const ua=requestUserAgent(req);

  if(action==='logout'){
    const user=await getUser();
    if(user?.id){
      const status=await managedSessionStatus(req,String(user.id));
      if(status.session&&!status.revoked)await revokeManagedSession(
        String(user.id),status.session.id,clean(user.email,240)||'self',context,clean(user.email,240),
      ).catch(()=>null);
    }
    const response=Response.json({ok:true},{headers:{'Cache-Control':'private, no-store'}});
    response.headers.append('Set-Cookie',REMEMBER_SESSION_COOKIE+'=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    // koa_sid identifies the old managed session. Do not let a subsequent
    // fresh login silently inherit that revoked session or its fingerprint.
    response.headers.append('Set-Cookie','koa_sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    return response;
  }

  if(action==='failure'){
    if(!email.includes('@'))return Response.json({ok:true});
    await recordLoginFailureSignal(email);
    const risk=await evaluateLoginRisk(email,ip,ua);
    await appendAuthEvent(context,{
      type:'login_failed',
      email,
      userId:'',
      ipFingerprint:ip,
      userAgent:ua,
      device:risk.device,
      detail:'Failed sign-in attempt.',
      suspicious:false,
      reasons:[],
      riskLevel:'normal',
      alertSent:false,
      alertSuppressed:false,
      trustedDevice:false,
    });
    return Response.json({ok:true});
  }

  if(action==='success'){
    const user=await getUser();
    if(!user?.id)return new Response('Unauthorized',{status:401});
    const normalized=clean(user.email,240).toLowerCase();
    const deviceFingerprint=await requestDeviceFingerprint(req);
    const risk=await evaluateLoginRisk(normalized,ip,ua,{
      userId:clean(user.id,160),
      deviceFingerprint,
    });
    const session=await registerManagedSession(req,user,{remember:body.remember===true});
    const createdAt=new Date().toISOString();

    let alert:{sent:boolean;suppressed:boolean;error?:string;reason?:string;lastSentAt?:string}={
      sent:false,
      suppressed:false,
    };
    if(risk.shouldAlert){
      alert=await sendSuspiciousLoginAlert({
        email:normalized,
        userId:clean(user.id,160),
        device:risk.device,
        deviceFingerprint,
        reasons:risk.reasons,
        createdAt,
      });
    }

    const detail=alert.sent
      ?'Successful sign-in triggered a security alert.'
      :alert.suppressed
        ?'Successful sign-in met the alert threshold; duplicate email suppressed.'
        :risk.shouldAlert
          ?'Successful sign-in met the alert threshold; alert delivery failed.'
          :risk.suspicious
            ?'Successful sign-in flagged for Security activity review; no email sent.'
            :risk.riskLevel==='notice'
              ?'Successful sign-in recorded with new context; no email sent.'
              :'Successful sign-in.';

    await appendAuthEvent(context,{
      type:risk.suspicious?'suspicious_login':'login_success',
      email:normalized,
      userId:clean(user.id,160),
      ipFingerprint:ip,
      userAgent:ua,
      device:risk.device,
      deviceFingerprint,
      detail,
      suspicious:risk.suspicious,
      reasons:risk.reasons,
      riskLevel:risk.riskLevel,
      alertSent:alert.sent,
      alertSuppressed:alert.suppressed,
      trustedDevice:risk.trustedDevice,
    });

    const response=Response.json({
      ok:true,
      suspicious:risk.suspicious,
      shouldAlert:risk.shouldAlert,
      riskLevel:risk.riskLevel,
      reasons:risk.reasons,
      trustedDevice:risk.trustedDevice,
      alert:{sent:alert.sent,suppressed:alert.suppressed,reason:alert.reason||''},
      // Never return the raw HttpOnly device handle or session fingerprints.
      session:session?{
        device:session.device,
        expiresAt:session.expiresAt,
        rememberedUntil:session.rememberedUntil||'',
        revoked:Boolean(session.revokedAt),
      }:null,
    });
    if(session?.id)response.headers.append('Set-Cookie','koa_sid='+encodeURIComponent(session.id)+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age='+TRUSTED_DEVICE_COOKIE_MAX_AGE_SECONDS);
    response.headers.append('Set-Cookie',REMEMBER_SESSION_COOKIE+'='+(body.remember===true?'1':'')+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age='+(body.remember===true?REMEMBER_SESSION_MAX_AGE_SECONDS:0));
    // The Identity SDK's nf_jwt/nf_refresh cookies are session-only by
    // default. Promote the already-authenticated cookies for an opted-in
    // browser so they survive a restart (including iPhone Safari).
    // They intentionally stay browser-readable because SDK hydration requires it.
    if(body.remember===true){
      for(const name of ['nf_jwt','nf_refresh']){
        const value=rawCookieValue(req,name);
        if(value)response.headers.append('Set-Cookie',name+'='+value+'; Path=/; Secure; SameSite=Lax; Max-Age='+REMEMBER_SESSION_MAX_AGE_SECONDS);
      }
    }
    return response;
  }

  return Response.json({error:'Unknown authentication event.'},{status:400});
};

export const config:Config={path:'/api/auth/record'};
