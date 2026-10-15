// @netlify/identity writes session cookies without Max-Age by default.
// Only when the user opts in do we promote those same SDK-owned cookies to
// persistent (up to 30 days). No token value enters localStorage or telemetry.
// This is a cookie-lifetime adjustment, NOT an alternate authentication system.
const KEY='koa:remember-session:30d';
const MAX_AGE=30*24*60*60;
const COOKIE_NAMES=['nf_jwt','nf_refresh'];
function cookiePair(name:string){
  return document.cookie.split(';').map(pair=>pair.trim())
    .find(pair=>pair.startsWith(name+'='))||'';
}
function applyCookieLifetime(enabled:boolean){
  if(typeof document==='undefined')return false;
  const pairs=COOKIE_NAMES.map(cookiePair);
  if(pairs.some(pair=>!pair))return false;
  for(const pair of pairs){
    document.cookie=pair+'; Path=/; Secure; SameSite=Lax'+(enabled?'; Max-Age='+MAX_AGE:'');
  }
  return true;
}
export function rememberIdentitySession(enabled:boolean){
  try{
    if(enabled)window.localStorage.setItem(KEY,'1');
    else window.localStorage.removeItem(KEY);
  }catch{}
  return applyCookieLifetime(enabled);
}
export function keepIdentitySessionAlive(){
  try{
    if(window.localStorage.getItem(KEY)!=='1')return false;
  }catch{return false;}
  return applyCookieLifetime(true);
}
export function forgetIdentityRememberPreference(){
  try{window.localStorage.removeItem(KEY);}catch{}
}
