import { getStore } from '@netlify/blobs';
import type { Context } from '@netlify/functions';
import { ipFingerprint } from './security.ts';

export type AuthEventType = 'login_success'|'login_failed'|'suspicious_login'|'session_revoked'|'sessions_revoked';
export type AuthEvent = {
  id:string;
  createdAt:string;
  type:AuthEventType;
  email:string;
  userId:string;
  ipFingerprint:string;
  userAgent:string;
  device:string;
  detail:string;
  suspicious:boolean;
  reasons:string[];
};

export type ManagedSession = {
  id:string;
  userId:string;
  email:string;
  createdAt:string;
  lastSeenAt:string;
  expiresAt:string;
  ipFingerprint:string;
  userAgent:string;
  device:string;
  revokedAt:string;
  revokedBy:string;
};

function store(){return getStore({name:'koa-auth-security',consistency:'strong'});}
function clean(v:unknown,max=800){return String(v||'').trim().slice(0,max);}
function id(prefix:string){return prefix+'-'+crypto.randomUUID().replaceAll('-','').slice(0,18).toUpperCase();}
function cookie(req:Request,name:string){
  const raw=clean(req.headers.get('cookie'),12000);
  const found=raw.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='));
  return found?decodeURIComponent(found.slice(name.length+1)):'';
}
function b64url(buf:ArrayBuffer){let s='';for(const b of new Uint8Array(buf))s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');}
async function hash(v:string){if(!v)return'';const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v));return b64url(d).slice(0,32);}
function jwtExpiry(jwt:string){
  try{
    const p=jwt.split('.')[1];if(!p)return'';
    const normalized=p.replace(/-/g,'+').replace(/_/g,'/');
    const json=JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length/4)*4,'=')));
    return Number.isFinite(Number(json?.exp))?new Date(Number(json.exp)*1000).toISOString():'';
  }catch{return'';}
}
function deviceLabel(ua:string){
  const v=ua.toLowerCase();
  const os=v.includes('iphone')?'iPhone':v.includes('ipad')?'iPad':v.includes('android')?'Android':v.includes('mac os')?'Mac':v.includes('windows')?'Windows':v.includes('linux')?'Linux':'Unknown device';
  const browser=v.includes('edg/')?'Edge':v.includes('chrome/')&&!v.includes('edg/')?'Chrome':v.includes('firefox/')?'Firefox':v.includes('safari/')&&!v.includes('chrome/')?'Safari':'Browser';
  return browser+' on '+os;
}
export async function requestSessionId(req:Request){
  const stable=cookie(req,'koa_sid');
  return stable||hash(cookie(req,'nf_jwt'));
}
export function requestUserAgent(req:Request){return clean(req.headers.get('user-agent'),800);}
export async function appendAuthEvent(context:Context,event:Omit<AuthEvent,'id'|'createdAt'>){
  const s=store();const current=((await s.get('auth-events/index',{type:'json'}))||[]) as AuthEvent[];
  const row:AuthEvent={id:id('AUTH'),createdAt:new Date().toISOString(),...event};
  await s.setJSON('auth-events/index',[row,...current].slice(0,5000));
  return row;
}
export async function readAuthEvents(limit=500){
  const rows=((await store().get('auth-events/index',{type:'json'}))||[]) as AuthEvent[];
  return rows.slice(0,Math.max(1,Math.min(2000,limit)));
}
export async function registerManagedSession(req:Request,user:any){
  const sessionId=await requestSessionId(req);if(!sessionId||!user?.id)return null;
  const s=store();const key='sessions/'+clean(user.id,160);
  const current=((await s.get(key,{type:'json'}))||[]) as ManagedSession[];
  const now=new Date().toISOString();const ua=requestUserAgent(req);const ip=await ipFingerprint(req);const jwt=cookie(req,'nf_jwt');
  const existing=current.find(row=>row.id===sessionId);
  if(existing?.revokedAt)return existing;
  const row:ManagedSession=existing?{...existing,lastSeenAt:now,ipFingerprint:ip||existing.ipFingerprint,userAgent:ua||existing.userAgent,device:deviceLabel(ua||existing.userAgent)}:{
    id:sessionId,userId:clean(user.id,160),email:clean(user.email,240).toLowerCase(),createdAt:now,lastSeenAt:now,expiresAt:jwtExpiry(jwt),ipFingerprint:ip,userAgent:ua,device:deviceLabel(ua),revokedAt:'',revokedBy:''
  };
  const next=[row,...current.filter(x=>x.id!==sessionId)].slice(0,30);
  await s.setJSON(key,next);
  return row;
}
export async function managedSessionStatus(req:Request,userId:string){
  const sid=await requestSessionId(req);if(!sid)return{sessionId:'',revoked:false};
  const rows=((await store().get('sessions/'+clean(userId,160),{type:'json'}))||[]) as ManagedSession[];
  const row=rows.find(x=>x.id===sid);
  return{sessionId:sid,revoked:Boolean(row?.revokedAt),session:row||null};
}
export async function listManagedSessions(userId:string,currentReq?:Request){
  const rows=((await store().get('sessions/'+clean(userId,160),{type:'json'}))||[]) as ManagedSession[];
  const currentId=currentReq?await requestSessionId(currentReq):'';
  const now=Date.now();
  return rows.map(row=>({...row,current:row.id===currentId,active:!row.revokedAt&&(!row.expiresAt||Date.parse(row.expiresAt)>now)})).sort((a,b)=>Date.parse(b.lastSeenAt)-Date.parse(a.lastSeenAt));
}
export async function revokeManagedSession(userId:string,sessionId:string,actor:string,context:Context,email=''){
  const s=store();const key='sessions/'+clean(userId,160);const rows=((await s.get(key,{type:'json'}))||[]) as ManagedSession[];
  const now=new Date().toISOString();let found=false;
  const next=rows.map(row=>{if(row.id!==sessionId)return row;found=true;return{...row,revokedAt:now,revokedBy:clean(actor,240)};});
  if(!found)throw new Error('Session not found.');
  await s.setJSON(key,next);
  const row=next.find(x=>x.id===sessionId)!;
  await appendAuthEvent(context,{type:'session_revoked',email:clean(email||row.email,240).toLowerCase(),userId:clean(userId,160),ipFingerprint:row.ipFingerprint,userAgent:row.userAgent,device:row.device,detail:'Revoked one active Koa’s session.',suspicious:false,reasons:[]});
  return row;
}
export async function revokeAllManagedSessions(userId:string,actor:string,context:Context,email=''){
  const s=store();const key='sessions/'+clean(userId,160);const rows=((await s.get(key,{type:'json'}))||[]) as ManagedSession[];const now=new Date().toISOString();
  const next=rows.map(row=>row.revokedAt?row:{...row,revokedAt:now,revokedBy:clean(actor,240)});
  await s.setJSON(key,next);
  await appendAuthEvent(context,{type:'sessions_revoked',email:clean(email,240).toLowerCase(),userId:clean(userId,160),ipFingerprint:'',userAgent:'',device:'',detail:'Revoked all tracked Koa’s sessions.',suspicious:false,reasons:[]});
  return next;
}
export async function evaluateLoginRisk(email:string,ip:string,ua:string){
  const events=await readAuthEvents(1000);const cutoff=Date.now()-30*60*1000;const normalized=clean(email,240).toLowerCase();
  const failures=events.filter(e=>e.type==='login_failed'&&e.email===normalized&&Date.parse(e.createdAt)>=cutoff);
  const successes=events.filter(e=>e.type==='login_success'&&e.email===normalized);
  const reasons:string[]=[];
  if(failures.length>=3)reasons.push(failures.length+' failed sign-in attempts in the last 30 minutes');
  if(ip&&successes.length&&!successes.some(e=>e.ipFingerprint===ip))reasons.push('new network fingerprint');
  const device=deviceLabel(ua);
  if(successes.length&&!successes.some(e=>e.device===device))reasons.push('new device/browser');
  return{suspicious:reasons.length>0,reasons,device};
}
export async function sendSuspiciousLoginAlert(input:{email:string;device:string;reasons:string[];createdAt:string;}){
  const key=clean(Netlify.env.get('RESEND_API_KEY'),500);if(!key)return{sent:false,error:'RESEND_API_KEY missing'};
  const recipients=clean(Netlify.env.get('KOA_SECURITY_ALERT_EMAIL'),500).split(',').map(x=>x.trim()).filter(Boolean);
  if(!recipients.length)recipients.push('chris@sibel.org','koasadmin@koasevents.com');
  const from=clean(Netlify.env.get('KOA_FROM_EMAIL'),240)||"Koa's Events <aloha@koasevents.com>";
  const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({
    from,to:recipients,subject:'Koa’s security alert: suspicious sign-in',
    html:'<div style="font-family:Arial,sans-serif;line-height:1.6"><h2>Suspicious Koa’s sign-in</h2><p><strong>Account:</strong> '+input.email+'</p><p><strong>Device:</strong> '+input.device+'</p><p><strong>Time:</strong> '+input.createdAt+'</p><p><strong>Reasons:</strong> '+input.reasons.join('; ')+'</p><p>Review User Management → Security activity and active sessions.</p></div>'
  })});
  return r.ok?{sent:true}:{sent:false,error:'Alert delivery failed'};
}
