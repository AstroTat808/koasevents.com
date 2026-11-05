/**
 * Opaque, server-verified admin session binding. The Identity JWT remains the
 * primary authentication credential; this is an additional revocable binding.
 * Browser trust (`koa_sid`) never grants application access.
 */
export const ADMIN_BINDING_COOKIE='__Host-koa_admin_session';
export const ADMIN_BINDING_SECONDS=30*24*60*60;
export const ADMIN_BINDING_MAX_AGE_MS=ADMIN_BINDING_SECONDS*1000;
export const STANDARD_BINDING_MAX_AGE_MS=12*60*60*1000;
export function newAdminBinding(){
  const bytes=new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let text='';
  for(const byte of bytes)text+=String.fromCharCode(byte);
  return btoa(text).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
}
export function validAdminBinding(value:string){
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}
export function adminBindingCookie(value:string,remember=false){
  if(!validAdminBinding(value))throw new Error('Invalid admin session credential.');
  return ADMIN_BINDING_COOKIE+'='+value+'; Path=/; HttpOnly; Secure; SameSite=Lax'
    +(remember?'; Max-Age='+ADMIN_BINDING_SECONDS:'');
}
export function clearAdminBindingCookie(){
  return ADMIN_BINDING_COOKIE+'=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}
export function sessionBindingStatus(
  row:{id?:string;userId?:string;revokedAt?:string;boundUntil?:string}|null,
  expectedId:string,userId:string,now=Date.now(),
){
  if(!expectedId)return 'missing' as const;
  if(!row||row.id!==expectedId||row.userId!==userId)return 'unrecognized' as const;
  if(row.revokedAt)return 'revoked' as const;
  const until=Date.parse(String(row.boundUntil||''));
  if(!Number.isFinite(until)||until<=now)return 'expired' as const;
  return 'active' as const;
}
