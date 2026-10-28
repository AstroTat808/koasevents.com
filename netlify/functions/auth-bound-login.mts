import type { Config, Context } from '@netlify/functions';
import { login, verifyRequestOrigin } from '@netlify/identity';
import { createBoundManagedSession } from './_shared/auth-security';

export default async(req:Request,_context:Context)=>{
  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  try {verifyRequestOrigin(req);}
  catch {return Response.json({error:'Invalid request origin.'},{status:403});}
  const body=await req.json().catch(()=>null);
  const email=String(body?.email||'').trim().toLowerCase();
  const password=String(body?.password||'');
  if(!email.includes('@')||!password||password.length>1024)
    return Response.json({error:'Email and password required.'},{status:400});
  // Only a fresh Identity password grant may mint a new Koa binding. An
  // already-valid JWT alone is never sufficient to replace a revoked session.
  let user:any;
  try {user=await login(email,password);}
  catch {return Response.json({error:'Invalid email or password.'},{status:401,headers:{'Cache-Control':'no-store'}});}
  if(!user?.id)return Response.json({error:'Authentication could not be verified.'},{status:401});
  const bound=await createBoundManagedSession(req,user,body.remember===true);
  const response=Response.json({ok:true},{headers:{'Cache-Control':'private, no-store'}});
  response.headers.append('Set-Cookie',bound.cookie);
  if(bound.deviceCookie)response.headers.append('Set-Cookie',bound.deviceCookie);
  return response;
};
export const config:Config={path:'/api/auth/bound-login'};
