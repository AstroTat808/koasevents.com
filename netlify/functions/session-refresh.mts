import type { Config } from '@netlify/functions';
import { getUser, refreshSession } from '@netlify/identity';
import {
  REMEMBER_SESSION_COOKIE, REMEMBER_SESSION_MAX_AGE_SECONDS,
  recordManagedSessionRefresh,
} from './_shared/auth-security';

// This cookie is a preference, never an authentication credential.
// Identity alone must authenticate and issue any renewed access token.
function hasRememberCookie(req:Request){
  return String(req.headers.get('cookie')||'').split(';').some(item=>item.trim()===REMEMBER_SESSION_COOKIE+'=1');
}
function isSameOrigin(req:Request){
  const origin=req.headers.get('origin');
  if(origin){try{return new URL(origin).origin===new URL(req.url).origin;}catch{return false;}}
  return req.headers.get('sec-fetch-site')==='same-origin';
}
function tokenSubject(token:string){
  try {
    const payload=token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
    const decoded=JSON.parse(atob(payload.padEnd(Math.ceil(payload.length/4)*4,'=')));
    return typeof decoded.sub==='string'?decoded.sub.slice(0,160):'';
  } catch {return '';}
}
const headers={'Cache-Control':'private, no-store','Vary':'Cookie'};
export default async (req:Request)=>{
  if(req.method!=='POST')return Response.json({error:'Method not allowed.'},{status:405,headers});
  if(!isSameOrigin(req))return Response.json({error:'Invalid request origin.'},{status:403,headers});
  try {
    const user=await getUser();
    if(user?.id) return Response.json({ok:true,refreshed:false},{headers});
    if(!hasRememberCookie(req))return Response.json({ok:false,code:'unauthenticated'},{status:401,headers});
    // Netlify Identity verifies the refresh token and rotates credentials.
    // Never return, log, or store either credential.
    const accessToken=await refreshSession();
    if(!accessToken)return Response.json({ok:false,code:'unauthenticated'},{status:401,headers});
    const userId=tokenSubject(accessToken);
    if(userId)await recordManagedSessionRefresh(req,userId,accessToken).catch(()=>false);
    const response=Response.json({ok:true,refreshed:true},{headers});
    response.headers.append('Set-Cookie',REMEMBER_SESSION_COOKIE+'=1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age='+REMEMBER_SESSION_MAX_AGE_SECONDS);
    return response;
  } catch {
    return Response.json({ok:false,code:'refresh_unavailable'},{status:503,headers});
  }
};
export const config:Config={path:'/api/auth/session-refresh'};
