import type { Config, Context } from '@netlify/functions';
import { logout, verifyRequestOrigin } from '@netlify/identity';
import { revokePresentedBoundSession } from './_shared/auth-security';
import { clearAdminBindingCookie } from './_shared/session-binding';

export default async(req:Request,context:Context)=>{
  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  try {verifyRequestOrigin(req);}
  catch {return Response.json({error:'Invalid request origin.'},{status:403});}
  // Independently revoke the presented opaque session: access JWTs may be
  // expired, but logout must still invalidate the server-side credential.
  try{await revokePresentedBoundSession(req,context);}
  catch{return Response.json({error:'Could not revoke this browser session.'},
    {status:503,headers:{'Cache-Control':'no-store'}});}
  try{await logout();}catch{}
  const result=Response.json({ok:true},{headers:{'Cache-Control':'private, no-store'}});
  result.headers.append('Set-Cookie',clearAdminBindingCookie());
  return result;
};
export const config:Config={path:'/api/auth/bound-logout'};
