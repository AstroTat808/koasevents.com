import type { Context, Config } from '@netlify/functions';
import { getUser } from '@netlify/identity';
import { appendAuthEvent, evaluateLoginRisk, registerManagedSession, requestUserAgent, sendSuspiciousLoginAlert } from './_shared/auth-security';
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
    await appendAuthEvent(context,{type:'login_failed',email,userId:'',ipFingerprint:ip,userAgent:ua,device:risk.device,detail:'Failed sign-in attempt.',suspicious:false,reasons:[]});
    return Response.json({ok:true});
  }

  if(action==='success'){
    const user=await getUser();
    if(!user?.id)return new Response('Unauthorized',{status:401});
    const normalized=clean(user.email,240).toLowerCase();
    const risk=await evaluateLoginRisk(normalized,ip,ua);
    const session=await registerManagedSession(req,user);
    const createdAt=new Date().toISOString();
    await appendAuthEvent(context,{type:risk.suspicious?'suspicious_login':'login_success',email:normalized,userId:clean(user.id,160),ipFingerprint:ip,userAgent:ua,device:risk.device,detail:risk.suspicious?'Successful sign-in flagged for review.':'Successful sign-in.',suspicious:risk.suspicious,reasons:risk.reasons});
    if(risk.suspicious)await sendSuspiciousLoginAlert({email:normalized,device:risk.device,reasons:risk.reasons,createdAt});
    const response=Response.json({ok:true,suspicious:risk.suspicious,reasons:risk.reasons,session});
    if(session?.id)response.headers.append('Set-Cookie','koa_sid='+encodeURIComponent(session.id)+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000');
    return response;
  }

  return Response.json({error:'Unknown authentication event.'},{status:400});
};

export const config:Config={path:'/api/auth/record'};
