import { emailGreeting, emailGreetingText, emailHeader, assertEmailInlineAssets, emailLogoAttachment, emailSignature, emailSignatureText } from './email-brand';
import type { Context } from '@netlify/functions';
import { ipFingerprint } from './security.ts';
import { resolveTenant } from './tenant';
import { tenantStoreFor } from './tenant-storage';
import { tenantEnv } from './tenant-env';
import {
  LOGIN_ALERT_COOLDOWN_MS,
  LOGIN_FAILURE_WINDOW_MS,
  classifyLoginRisk,
  loginAlertSuppressionKey,
  successfulAuthEventType,
  type LoginRiskLevel,
} from './auth-security-risk';

export type AuthEventType =
  | 'login_success'
  | 'login_failed'
  | 'suspicious_login'
  | 'session_revoked'
  | 'sessions_revoked'
  | 'device_trusted'
  | 'device_untrusted'
  | 'device_renamed';

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
  deviceFingerprint?:string;
  riskLevel?:LoginRiskLevel;
  alertSent?:boolean;
  alertSuppressed?:boolean;
  trustedDevice?:boolean;
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

export type TrustedDevice = {
  fingerprint:string;
  userId:string;
  email:string;
  device:string;
  name:string;
  trustedAt:string;
  trustedBy:string;
  lastSeenAt:string;
};

type LoginAlertState = {
  suppressionKey:string;
  reservedAt:string;
  sentAt:string;
  nonce:string;
  email:string;
  userId:string;
  device:string;
  deviceFingerprint:string;
};

function store(context?:Context){return tenantStoreFor(context,resolveTenant(),'authSecurity');}
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
function trustedDeviceKey(userId:string){return 'trusted-devices/'+clean(userId,160);}
function failureSignalPrefix(accountHash:string){return 'login-failures/'+clean(accountHash,80)+'/';}
function cooldownKey(key:string){return 'alert-cooldowns/'+key;}
function recent(timestamp:string,windowMs:number){
  const value=Date.parse(timestamp);
  return Number.isFinite(value)&&Date.now()-value>=0&&Date.now()-value<windowMs;
}
function legacyFailureSignal(reasons:string[]){
  return reasons.some((reason)=>/\b([3-9]|\d{2,}) failed sign-in attempts in the last 30 minutes\b/i.test(String(reason||'')));
}

export async function requestSessionId(req:Request){
  const stable=cookie(req,'koa_sid');
  return stable||hash(cookie(req,'nf_jwt'));
}
export const requestDeviceFingerprint=requestSessionId;
export function requestUserAgent(req:Request){return clean(req.headers.get('user-agent'),800);}

export async function recordLoginFailureSignal(email:string){
  const normalized=clean(email,240).toLowerCase();
  if(!normalized.includes('@'))return null;
  const accountHash=await hash(normalized);
  const createdAt=new Date().toISOString();
  const key=failureSignalPrefix(accountHash)+createdAt.replace(/[:.]/g,'-')+'-'+crypto.randomUUID().slice(0,12);
  await store().setJSON(key,{email:normalized,createdAt});
  return{key,createdAt};
}

export async function recentLoginFailureCount(email:string,windowMs=LOGIN_FAILURE_WINDOW_MS){
  const normalized=clean(email,240).toLowerCase();
  if(!normalized.includes('@'))return 0;
  const accountHash=await hash(normalized);
  const s=store();
  const listed=await s.list({prefix:failureSignalPrefix(accountHash)});
  const cutoff=Date.now()-Math.max(1,windowMs);
  let count=0;
  const stale:string[]=[];
  for(const blob of listed.blobs||[]){
    const key=String(blob.key||'');
    const row=((await s.get(key,{type:'json'}))||null) as {createdAt?:string}|null;
    const at=Date.parse(String(row?.createdAt||''));
    if(Number.isFinite(at)&&at>=cutoff)count+=1;
    else if(Number.isFinite(at)&&at<cutoff-24*60*60*1000)stale.push(key);
  }
  await Promise.all(stale.slice(0,100).map((key)=>s.delete(key)));
  return count;
}

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

export async function readTrustedDevices(userId:string){
  const rows=((await store().get(trustedDeviceKey(userId),{type:'json'}))||[]) as TrustedDevice[];
  return rows
    .filter((row)=>row&&row.fingerprint)
    .map((row)=>({...row,name:clean(row.name||row.device||'Trusted device',120)}));
}

export async function trustedDeviceHandle(deviceFingerprint:string){
  const fingerprint=clean(deviceFingerprint,160);
  if(!fingerprint)return'';
  return hash('trusted-device:'+fingerprint);
}

export async function resolveTrustedDeviceHandle(userId:string,deviceId:string){
  const handle=clean(deviceId,80);
  if(!userId||!handle)return null;
  const rows=await readTrustedDevices(userId);
  for(const row of rows){
    if(await trustedDeviceHandle(row.fingerprint)===handle)return row;
  }
  return null;
}
export async function isTrustedDevice(userId:string,deviceFingerprint:string){
  if(!userId||!deviceFingerprint)return false;
  const rows=await readTrustedDevices(userId);
  return rows.some((row)=>row.fingerprint===deviceFingerprint);
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
  const trusted=await readTrustedDevices(userId);
  const trustedByFingerprint=new Map(trusted.map((row)=>[row.fingerprint,row]));
  const currentId=currentReq?await requestSessionId(currentReq):'';
  const now=Date.now();
  return rows.map(row=>{
    const trustedRow=trustedByFingerprint.get(row.id);
    return {
      ...row,
      current:row.id===currentId,
      active:!row.revokedAt&&(!row.expiresAt||Date.parse(row.expiresAt)>now),
      trusted:Boolean(trustedRow),
      trustedName:trustedRow?.name||'',
      trustedAt:trustedRow?.trustedAt||'',
      trustedBy:trustedRow?.trustedBy||'',
    };
  }).sort((a,b)=>Date.parse(b.lastSeenAt)-Date.parse(a.lastSeenAt));
}

async function knownDeviceSource(userId:string,deviceFingerprint:string){
  const s=store();
  const sessions=((await s.get('sessions/'+clean(userId,160),{type:'json'}))||[]) as ManagedSession[];
  const session=sessions.find((row)=>row.id===deviceFingerprint);
  if(session)return{device:session.device,userAgent:session.userAgent,email:session.email,lastSeenAt:session.lastSeenAt};
  const events=await readAuthEvents(2000);
  const event=events.find((row)=>row.userId===userId&&row.deviceFingerprint===deviceFingerprint);
  if(event)return{device:event.device,userAgent:event.userAgent,email:event.email,lastSeenAt:event.createdAt};
  return null;
}

export async function trustKnownDevice(userId:string,deviceFingerprint:string,actor:string,context:Context,email='',friendlyName=''){
  const fingerprint=clean(deviceFingerprint,160);
  if(!userId||!fingerprint)throw new Error('Device fingerprint required.');
  const source=await knownDeviceSource(userId,fingerprint);
  if(!source)throw new Error('Tracked device not found.');
  const current=await readTrustedDevices(userId);
  const existing=current.find((row)=>row.fingerprint===fingerprint);
  const now=new Date().toISOString();
  const row:TrustedDevice={
    fingerprint,
    userId:clean(userId,160),
    email:clean(email||source.email,240).toLowerCase(),
    device:clean(source.device,160),
    name:clean(friendlyName||existing?.name||source.device||'Trusted device',120),
    trustedAt:existing?.trustedAt||now,
    trustedBy:existing?.trustedBy||clean(actor,240),
    lastSeenAt:clean(source.lastSeenAt,80)||now,
  };
  await store().setJSON(trustedDeviceKey(userId),[row,...current.filter((item)=>item.fingerprint!==fingerprint)].slice(0,30));
  if(!existing){
    await appendAuthEvent(context,{
      type:'device_trusted',
      email:row.email,
      userId:row.userId,
      ipFingerprint:'',
      userAgent:clean(source.userAgent,800),
      device:row.device,
      deviceFingerprint:fingerprint,
      detail:'Marked '+row.name+' as a trusted device.',
      suspicious:false,
      reasons:[],
      riskLevel:'normal',
      alertSent:false,
      alertSuppressed:false,
      trustedDevice:true,
    });
  }
  return row;
}

export async function renameTrustedDevice(userId:string,deviceFingerprint:string,name:string,actor:string,context:Context,email=''){
  const fingerprint=clean(deviceFingerprint,160);
  const nextName=clean(name,120);
  if(!nextName)throw new Error('Device name is required.');
  const current=await readTrustedDevices(userId);
  const existing=current.find((row)=>row.fingerprint===fingerprint);
  if(!existing)throw new Error('Trusted device not found.');
  const updated:TrustedDevice={...existing,name:nextName};
  await store().setJSON(trustedDeviceKey(userId),[updated,...current.filter((row)=>row.fingerprint!==fingerprint)]);
  await appendAuthEvent(context,{
    type:'device_renamed',
    email:clean(email||existing.email,240).toLowerCase(),
    userId:clean(userId,160),
    ipFingerprint:'',
    userAgent:'',
    device:existing.device,
    deviceFingerprint:fingerprint,
    detail:'Renamed trusted device to '+nextName+'.',
    suspicious:false,
    reasons:[],
    riskLevel:'normal',
    alertSent:false,
    alertSuppressed:false,
    trustedDevice:true,
  });
  return updated;
}

export async function untrustKnownDevice(userId:string,deviceFingerprint:string,actor:string,context:Context,email=''){
  const fingerprint=clean(deviceFingerprint,160);
  const current=await readTrustedDevices(userId);
  const existing=current.find((row)=>row.fingerprint===fingerprint);
  if(!existing)throw new Error('Trusted device not found.');
  await store().setJSON(trustedDeviceKey(userId),current.filter((row)=>row.fingerprint!==fingerprint));
  await appendAuthEvent(context,{
    type:'device_untrusted',
    email:clean(email||existing.email,240).toLowerCase(),
    userId:clean(userId,160),
    ipFingerprint:'',
    userAgent:'',
    device:existing.device,
    deviceFingerprint:fingerprint,
    detail:'Removed trust from this tracked device.',
    suspicious:false,
    reasons:[],
    riskLevel:'normal',
    alertSent:false,
    alertSuppressed:false,
    trustedDevice:false,
  });
  return existing;
}

export async function revokeManagedSession(userId:string,sessionId:string,actor:string,context:Context,email=''){
  const s=store();const key='sessions/'+clean(userId,160);const rows=((await s.get(key,{type:'json'}))||[]) as ManagedSession[];
  const now=new Date().toISOString();let found=false;
  const next=rows.map(row=>{if(row.id!==sessionId)return row;found=true;return{...row,revokedAt:now,revokedBy:clean(actor,240)};});
  if(!found)throw new Error('Session not found.');
  await s.setJSON(key,next);
  const row=next.find(x=>x.id===sessionId)!;
  await appendAuthEvent(context,{type:'session_revoked',email:clean(email||row.email,240).toLowerCase(),userId:clean(userId,160),ipFingerprint:row.ipFingerprint,userAgent:row.userAgent,device:row.device,deviceFingerprint:row.id,detail:'Revoked one active Koa’s session.',suspicious:false,reasons:[],riskLevel:'normal',alertSent:false,alertSuppressed:false,trustedDevice:await isTrustedDevice(userId,row.id)});
  return row;
}
export async function revokeAllManagedSessions(userId:string,actor:string,context:Context,email=''){
  const s=store();const key='sessions/'+clean(userId,160);const rows=((await s.get(key,{type:'json'}))||[]) as ManagedSession[];const now=new Date().toISOString();
  const next=rows.map(row=>row.revokedAt?row:{...row,revokedAt:now,revokedBy:clean(actor,240)});
  await s.setJSON(key,next);
  await appendAuthEvent(context,{type:'sessions_revoked',email:clean(email,240).toLowerCase(),userId:clean(userId,160),ipFingerprint:'',userAgent:'',device:'',detail:'Revoked all tracked Koa’s sessions.',suspicious:false,reasons:[],riskLevel:'normal',alertSent:false,alertSuppressed:false,trustedDevice:false});
  return next;
}

export async function evaluateLoginRisk(
  email:string,
  ip:string,
  ua:string,
  options:{userId?:string;deviceFingerprint?:string}={},
){
  const events=await readAuthEvents(1000);
  const cutoff=Date.now()-LOGIN_FAILURE_WINDOW_MS;
  const normalized=clean(email,240).toLowerCase();
  const legacyFailures=events.filter(e=>e.type==='login_failed'&&e.email===normalized&&Date.parse(e.createdAt)>=cutoff);
  const durableFailureCount=await recentLoginFailureCount(normalized,LOGIN_FAILURE_WINDOW_MS);
  const failureCount=Math.max(legacyFailures.length,durableFailureCount);
  const successes=events.filter(e=>successfulAuthEventType(e.type)&&e.email===normalized);
  const device=deviceLabel(ua);
  const trusted=Boolean(options.userId&&options.deviceFingerprint&&await isTrustedDevice(options.userId,options.deviceFingerprint));
  const classified=classifyLoginRisk({
    recentFailureCount:failureCount,
    hasHistory:successes.length>0,
    knownNetwork:!ip||successes.some((event)=>event.ipFingerprint===ip),
    knownDevice:successes.some((event)=>event.device===device),
    trustedDevice:trusted,
  });
  return{...classified,device};
}

async function reserveLoginAlert(input:{email:string;userId?:string;device:string;deviceFingerprint?:string}){
  const suppressionKey=await hash(loginAlertSuppressionKey(input));
  const key=cooldownKey(suppressionKey);
  const s=store();
  const existing=((await s.get(key,{type:'json'}))||null) as LoginAlertState|null;
  if(existing?.sentAt&&recent(existing.sentAt,LOGIN_ALERT_COOLDOWN_MS)){
    return{suppressed:true,reason:'24-hour duplicate alert cooldown',lastSentAt:existing.sentAt,key,nonce:''};
  }
  if(existing?.reservedAt&&recent(existing.reservedAt,30_000)){
    return{suppressed:true,reason:'duplicate alert already being processed',lastSentAt:existing.sentAt||'',key,nonce:''};
  }

  const nonce=id('ALERT');
  const reservedAt=new Date().toISOString();
  const reservation:LoginAlertState={
    suppressionKey,
    reservedAt,
    sentAt:'',
    nonce,
    email:clean(input.email,240).toLowerCase(),
    userId:clean(input.userId,160),
    device:clean(input.device,160),
    deviceFingerprint:clean(input.deviceFingerprint,160),
  };
  await s.setJSON(key,reservation);
  await new Promise((resolve)=>setTimeout(resolve,80));
  const winner=((await s.get(key,{type:'json'}))||null) as LoginAlertState|null;
  if(!winner||winner.nonce!==nonce){
    return{suppressed:true,reason:'duplicate alert already being processed',lastSentAt:winner?.sentAt||'',key,nonce:''};
  }
  return{suppressed:false,reason:'',lastSentAt:'',key,nonce};
}

async function finishLoginAlertReservation(key:string,nonce:string,sent:boolean){
  if(!key||!nonce)return;
  const s=store();
  const current=((await s.get(key,{type:'json'}))||null) as LoginAlertState|null;
  if(!current||current.nonce!==nonce)return;
  if(!sent){await s.delete(key);return;}
  await s.setJSON(key,{...current,sentAt:new Date().toISOString(),reservedAt:'',nonce:''});
}

export async function sendSuspiciousLoginAlert(input:{email:string;userId?:string;device:string;deviceFingerprint?:string;reasons:string[];createdAt:string;}){
  const reservation=await reserveLoginAlert(input);
  if(reservation.suppressed)return{sent:false,suppressed:true,error:'',reason:reservation.reason,lastSentAt:reservation.lastSentAt};

  const tenant=resolveTenant();
  const key=clean(tenantEnv(tenant,'RESEND_API_KEY'),500);
  if(!key){
    await finishLoginAlertReservation(reservation.key,reservation.nonce,false);
    return{sent:false,suppressed:false,error:'RESEND_API_KEY missing',reason:'',lastSentAt:''};
  }
  const recipients=clean(tenantEnv(tenant,'SECURITY_ALERT_EMAIL','KOA_SECURITY_ALERT_EMAIL'),500).split(',').map(x=>x.trim()).filter(Boolean);
  if(!recipients.length&&tenant.contact.email)recipients.push(tenant.contact.email);
  const from=clean(tenantEnv(tenant,'FROM_EMAIL','KOA_FROM_EMAIL'),240)||(tenant.displayName+' <'+tenant.contact.email+'>');
  const html='<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="IE=edge"><meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no"><title>Suspicious Koa’s sign-in</title></head><body style="margin:0;padding:0;background:#f5f0e7">'
    +'<table role="presentation" lang="en" dir="ltr" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding-top:20px;padding-right:10px;padding-bottom:20px;padding-left:10px">'
    +'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:650px;background:#fff;border:1px solid #e7dfd0;border-radius:20px">'
    +emailHeader({brand:'events',eyebrow:'Security',title:'Suspicious Koa’s sign-in'})
    +'<tr><td style="padding-top:24px;padding-right:22px;padding-bottom:24px;padding-left:22px">'
    +emailGreeting('Team')
    +'<p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#46564f"><strong>Account:</strong> '+input.email+'</p>'
    +'<p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#46564f"><strong>Device:</strong> '+input.device+'</p>'
    +'<p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#46564f"><strong>Time:</strong> '+input.createdAt+'</p>'
    +'<p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#46564f"><strong>Reasons:</strong> '+input.reasons.join('; ')+'</p>'
    +'<p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#46564f">Review User Management → Security activity and active sessions.</p>'
    +emailSignature()
    +'</td></tr></table></td></tr></table></body></html>';
  const text=[
    emailGreetingText('Team'),'',
    'Suspicious Koa’s sign-in',
    'Account: '+input.email,
    'Device: '+input.device,
    'Time: '+input.createdAt,
    'Reasons: '+input.reasons.join('; '),
    'Review User Management → Security activity and active sessions.','',
    emailSignatureText(),
  ].join('\n');
  const attachments=[emailLogoAttachment()];
  assertEmailInlineAssets(html,attachments);
  const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({
    from,to:recipients,subject:'Koa’s security alert: suspicious sign-in',html,text,attachments
  })});
  await finishLoginAlertReservation(reservation.key,reservation.nonce,r.ok);
  return r.ok
    ?{sent:true,suppressed:false,error:'',reason:'',lastSentAt:''}
    :{sent:false,suppressed:false,error:'Alert delivery failed',reason:'',lastSentAt:''};
}

export async function authenticationSecurityHealthSummary(context:Context){
  const started=Date.now();
  const twoFailures=classifyLoginRisk({recentFailureCount:2,hasHistory:true,knownNetwork:false,knownDevice:false,trustedDevice:false});
  const threeFailures=classifyLoginRisk({recentFailureCount:3,hasHistory:true,knownNetwork:true,knownDevice:true,trustedDevice:false});
  const failureThresholdOk=!twoFailures.shouldAlert&&threeFailures.shouldAlert&&LOGIN_FAILURE_WINDOW_MS===30*60*1000;

  const s=store(context);
  const nonce=crypto.randomUUID().replaceAll('-','').slice(0,18);
  const trustedProbeKey='trusted-devices/__health__-'+nonce;
  const cooldownProbeKey='alert-cooldowns/__health__-'+nonce;
  let trustedDeviceStorageOk=false;
  let cooldownStorageOk=false;
  const storageErrors:string[]=[];

  try{
    await s.setJSON(trustedProbeKey,[{
      fingerprint:'health-'+nonce,
      userId:'__health__',
      email:'health@local.invalid',
      device:'Health probe',
      name:'Health probe',
      trustedAt:new Date().toISOString(),
      trustedBy:'system-health',
      lastSeenAt:new Date().toISOString(),
    }]);
    const trustedProbe=((await s.get(trustedProbeKey,{type:'json'}))||[]) as any[];
    trustedDeviceStorageOk=Array.isArray(trustedProbe)&&trustedProbe.some((row)=>String(row?.fingerprint||'')==='health-'+nonce);
  }catch(error){
    storageErrors.push('trusted-device storage: '+(error instanceof Error?error.message:'probe failed'));
  }finally{
    await s.delete(trustedProbeKey).catch(()=>{});
  }

  try{
    await s.setJSON(cooldownProbeKey,{
      suppressionKey:'health-'+nonce,
      reservedAt:'',
      sentAt:new Date().toISOString(),
      nonce:'',
      email:'health@local.invalid',
      userId:'__health__',
      device:'Health probe',
      deviceFingerprint:'health-'+nonce,
    });
    const cooldownProbe=((await s.get(cooldownProbeKey,{type:'json'}))||null) as any;
    cooldownStorageOk=String(cooldownProbe?.suppressionKey||'')==='health-'+nonce;
  }catch(error){
    storageErrors.push('cooldown storage: '+(error instanceof Error?error.message:'probe failed'));
  }finally{
    await s.delete(cooldownProbeKey).catch(()=>{});
  }

  const events=await readAuthEvents(2000);
  const lastHighRisk=events.find((event)=>event.riskLevel==='high'&&event.alertSent===true)||null;
  const lastDuplicateSuppressed=events.find((event)=>event.alertSuppressed===true)||null;
  const ok=failureThresholdOk&&trustedDeviceStorageOk&&cooldownStorageOk;

  return{
    ok,
    ms:Date.now()-started,
    failureThresholdOk,
    failureThreshold:3,
    failureWindowMinutes:30,
    trustedDeviceStorageOk,
    cooldownStorageOk,
    cooldownHours:Math.round(LOGIN_ALERT_COOLDOWN_MS/(60*60*1000)),
    lastHighRiskAlert:lastHighRisk?{
      sentAt:lastHighRisk.createdAt,
      device:lastHighRisk.device,
      reasons:lastHighRisk.reasons||[],
    }:null,
    lastDuplicateSuppressedAt:lastDuplicateSuppressed?.createdAt||'',
    errors:storageErrors,
  };
}

export function summarizeSecurityActivity(events:AuthEvent[],trustedDeviceCount:number,days:number){
  const safeDays=Math.max(1,Math.min(365,Math.round(Number(days)||30)));
  const cutoff=Date.now()-safeDays*24*60*60*1000;
  const rows=events.filter((event)=>{
    const at=Date.parse(event.createdAt);
    return Number.isFinite(at)&&at>=cutoff;
  });

  const emailsPrevented=rows.filter((event)=>
    ['login_success','suspicious_login'].includes(event.type)
    && event.alertSent===false
    && event.alertSuppressed!==true
    && event.riskLevel!=='high'
    && Array.isArray(event.reasons)
    && event.reasons.length>0
  ).length;

  const highRiskAlertsSent=rows.filter((event)=>
    event.alertSent===true
    && event.riskLevel==='high'
  ).length;

  const duplicateAlertsSuppressed=rows.filter((event)=>event.alertSuppressed===true).length;
  const trustedDevicesAdded=rows.filter((event)=>event.type==='device_trusted').length;

  return{
    days:safeDays,
    emailsPrevented,
    trustedDevices:Math.max(0,Number(trustedDeviceCount)||0),
    trustedDevicesAdded,
    highRiskAlertsSent,
    duplicateAlertsSuppressed,
  };
}

export function auditHistoricalLoginAlerts(events:AuthEvent[]){
  const candidates=events
    .filter((event)=>event.alertSent===true||(event.type==='suspicious_login'&&event.alertSent===undefined))
    .slice()
    .sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt));
  const sentByKey=new Map<string,number>();
  let wouldSendBeforeCooldown=0;
  let wouldSend=0;
  let suppressedLowRisk=0;
  let suppressedCooldown=0;
  const reasons=new Map<string,number>();

  for(const event of candidates){
    for(const reason of event.reasons||[])reasons.set(reason,(reasons.get(reason)||0)+1);
    if(!legacyFailureSignal(event.reasons||[])){
      suppressedLowRisk+=1;
      continue;
    }
    wouldSendBeforeCooldown+=1;
    const key=loginAlertSuppressionKey({email:event.email,deviceFingerprint:event.deviceFingerprint,device:event.device});
    const at=Date.parse(event.createdAt);
    const last=sentByKey.get(key)||0;
    if(last&&at-last<LOGIN_ALERT_COOLDOWN_MS){
      suppressedCooldown+=1;
      continue;
    }
    sentByKey.set(key,at);
    wouldSend+=1;
  }

  return{
    historicalAlertEvents:candidates.length,
    wouldSendBeforeCooldown,
    wouldSend,
    wouldSuppress:candidates.length-wouldSend,
    suppressedLowRisk,
    suppressedCooldown,
    reductionRate:candidates.length?Math.round(((candidates.length-wouldSend)/candidates.length)*1000)/10:0,
    reasonBreakdown:[...reasons.entries()].map(([reason,count])=>({reason,count})).sort((a,b)=>b.count-a.count||a.reason.localeCompare(b.reason)),
  };
}
