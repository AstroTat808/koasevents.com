import type { Config } from '@netlify/functions';
import { requireCapability } from './_shared/admin';
import { listManagedSessions, trustedDeviceHandle } from './_shared/auth-security';

const headers={'Cache-Control':'private, no-store','Vary':'Cookie'};
const validDate=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v))?v:'';
export default async(req:Request)=>{
  if(req.method!=='GET')return Response.json({error:'Method not allowed.'},{status:405,headers});
  const auth=await requireCapability('health.view',req);
  if(auth.response)return auth.response;
  const rows=await listManagedSessions(String(auth.user?.id||''),req);
  const now=Date.now();
  const sessions=await Promise.all(rows.filter(row=>row.trusted||row.current).map(async row=>{
    const expired=Boolean(validDate(row.expiresAt)&&Date.parse(row.expiresAt)<=now);
    const revoked=Boolean(row.revokedAt);
    const rememberActive=Boolean(validDate(row.rememberedUntil)&&Date.parse(row.rememberedUntil)>now);
    return {
      id:await trustedDeviceHandle(row.id),
      name:String(row.trustedName||row.device||'Browser').slice(0,120),
      device:String(row.device||'Browser').slice(0,120),
      current:Boolean(row.current),trusted:Boolean(row.trusted),
      status:revoked?'revoked':expired?'refresh_required':'access_token_active',
      reason:revoked?'Session explicitly revoked':expired
        ?rememberActive?'Access token expired; remembered login can renew':'Access token expired; sign-in may be needed'
        :'Access token valid',
      createdAt:validDate(row.createdAt),lastSeenAt:validDate(row.lastSeenAt),
      accessExpiresAt:validDate(row.expiresAt),
      rememberedUntil:validDate(row.rememberedUntil),
      lastRefreshedAt:validDate(row.lastRefreshedAt),
      refreshCount:Math.max(0,Number(row.refreshCount)||0),
      revokedAt:validDate(row.revokedAt),
    };
  }));
  return Response.json({
    ok:true,checkedAt:new Date().toISOString(),
    current:sessions.find(s=>s.current)||null,
    trustedCount:sessions.filter(s=>s.trusted).length,
    activeTokenCount:sessions.filter(s=>s.status==='access_token_active').length,
    sessions,
    note:'Session status is a last-observed access-token snapshot; a refresh token may renew an expired access token. Device trust by itself does not authorize sign-in.',
  },{headers});
};
export const config:Config={path:'/api/admin/session-health'};
