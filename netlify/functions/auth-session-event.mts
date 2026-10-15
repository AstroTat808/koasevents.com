import type { Config, Context } from '@netlify/functions';
import { requireOperations } from './_shared/admin';
import { appendAuthEvent, readAuthEvents, registerManagedSession } from './_shared/auth-security';

export default async (req:Request,context:Context)=>{
  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  const origin=req.headers.get('origin');
  try {
    if(!origin||new URL(origin).origin!==new URL(req.url).origin)
      return Response.json({error:'Origin mismatch.'},{status:403});
  } catch {
    return Response.json({error:'Origin mismatch.'},{status:403});
  }
  const auth=await requireOperations(req,context);
  if(auth.response)return auth.response;
  const user=auth.user;
  if(!user?.id)return Response.json({error:'Authentication required.'},{status:401});
  const body=await req.json().catch(()=>null);
  if(body?.event!=='refresh_succeeded')return Response.json({error:'Invalid session event.'},{status:400});

  // Client-reported TOKEN_REFRESH is not independent proof of token rotation.
  // Rate-limit reporting per account to prevent event-store flooding.
  const recent=await readAuthEvents(100);
  if(recent.some(row=>row.userId===user.id&&row.type==='session_refreshed'&&
    Date.now()-Date.parse(row.createdAt)<60_000)){
    return Response.json({ok:true,recorded:false},{headers:{'Cache-Control':'private, no-store'}});
  }
  const session=await registerManagedSession(req,user);
  if(session?.revokedAt)return Response.json({error:'Session revoked.'},{status:401});
  await appendAuthEvent(context,{
    type:'session_refreshed',
    email:'',userId:String(user.id).slice(0,160),
    ipFingerprint:'',userAgent:'',device:'',
    deviceFingerprint:'',
    detail:'Authenticated browser reported a successful Netlify Identity session refresh.',
    suspicious:false,reasons:[],riskLevel:'normal',
    alertSent:false,alertSuppressed:false,trustedDevice:false,
  });
  return Response.json({ok:true,recorded:true},{headers:{'Cache-Control':'private, no-store'}});
};
export const config:Config={path:'/api/auth/session-event'};
