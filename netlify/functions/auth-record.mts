import type { Context, Config } from '@netlify/functions';
import { getUser } from '@netlify/identity';
import {
  appendAuthEvent,
  evaluateLoginRisk,
  registerManagedSession,
  requestDeviceFingerprint,
  requestUserAgent,
  sendSuspiciousLoginAlert,
} from './_shared/auth-security';
import { ipFingerprint } from './_shared/security';

function clean(v:unknown,max=300){return String(v||'').trim().slice(0,max);}
function sameOrigin(req:Request){
  const origin=clean(req.headers.get('origin'),300);
  return !origin||origin==='https://koasevents.com'||origin==='https://www.koasevents.com';
}

export default async(req:Request,context:Context)=>{
  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  if(!sameOrigin(req))return Response.json({error:'Invalid request origin.'},{status:403});
  const body:any=await req.json().catch(()=>null);if(!body)return Response.json({error:'Invalid JSON.'},{status:400});
  const action=clean(body.action,40);
  const email=clean(body.email,240).toLowerCase();
  const ip=await ipFingerprint(req);
  const ua=requestUserAgent(req);

  if(action==='failure'){
    if(!email.includes('@'))return Response.json({ok:true});
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
    const session=await registerManagedSession(req,user);
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
      session,
    });
    if(session?.id)response.headers.append('Set-Cookie','koa_sid='+encodeURIComponent(session.id)+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000');
    return response;
  }

  return Response.json({error:'Unknown authentication event.'},{status:400});
};

export const config:Config={path:'/api/auth/record'};
