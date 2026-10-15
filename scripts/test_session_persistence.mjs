#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const layout=read('src/layouts/BaseLayout.astro');
const login=read('src/pages/admin/index.astro');
const sessions=read('netlify/functions/_shared/auth-security.ts');
const refresh=read('netlify/functions/session-refresh.mts');
const adminHealth=read('netlify/functions/admin-session-health.mts');
const systemHealth=read('src/pages/admin/health/index.astro');
const record=read('netlify/functions/auth-record.mts');
const remembered=read('src/lib/remembered-session.ts');
const staff=read('src/components/StaffUtilityNav.astro');

function must(pattern,source,description){
  assert.match(source,pattern,description);
}
must(/name="remember"[^>]*checked/,login,'30-day opt-in login checkbox must be checked by default');
must(/body:JSON\.stringify\(\{action:'success',email,remember:/,login,'login must send remember preference to server');
must(/REMEMBER_SESSION_MAX_AGE_SECONDS=30\*24\*60\*60/,sessions,'remembered-session TTL must be 30 days');
must(/koa_remember/,sessions,'remember marker must be distinct from koa_sid');
must(/if\(prior\?\.revokedAt\)return prior/,sessions,'revoked session must not be revived by bookkeeping endpoint');
must(/if\(action==='logout'\)/,record,'explicit logout must revoke the current session');
must(/revokeManagedSession\(/,record,'logout must revoke server-side session record');
must(/koa_sid=; Path=\//,record,'logout must clear the old managed-session handle');
must(/COOKIE_NAMES=\['nf_jwt','nf_refresh'\]/,remembered,'both Identity cookies must survive restarts');
must(/Max-Age='\+MAX_AGE/,remembered,'client refresh rotation must preserve browser cookie persistence');
must(/keepIdentitySessionAlive\(\)/,staff,'refresh listener must run in protected workspace');
must(/rawCookieValue\(req,name\)/,record,'authenticated server records must preserve Identity cookie lifetime');
must(/HttpOnly; Secure; SameSite=Lax; Max-Age=/,record,'preference must use safe cookie attributes');
must(/hasRememberCookie\(req\)/,refresh,'refresh requires remembered login preference');
must(/promoteExistingIdentityCookies\\(req,response\\)/,refresh,'valid Identity rotation must use server Set-Cookie');
must(/event==='token_refresh'/,staff,'browser refresh must trigger server-backed persistence');
must(/event==='token_refresh'/,login,'login page refresh must trigger server-backed persistence');
must(/await refreshSession\(\)/,refresh,'Netlify Identity remains the refresh credential authority');
must(/recordManagedSessionRefresh/,refresh,'successful refresh must record session health');
must(/Vary':'Cookie'/,refresh,'refresh response must not be shared between users');
must(/requireCapability\('health.view',req\)/,adminHealth,'Session Health API must enforce health permission');
must(/row.trusted\|\|row.current/,adminHealth,'Session Health cannot list unrelated user activity');
assert.doesNotMatch(adminHealth,/ipFingerprint|userAgent|accessToken|refreshToken|nf_jwt|nf_refresh/,'Session Health must not expose sensitive credential or fingerprint fields');
must(/data-session-health-section/,systemHealth,'Session Health panel must be present');
must(/data-session-health-details/,systemHealth,'Session Health panel must be collapsible');
must(/document\.createElement\('article'\)/,systemHealth,'device names must be rendered safely using DOM text nodes');

const begin=layout.indexOf("      (() => {\n        const currentPath = String(window.location.pathname || '/');");
const end=layout.indexOf("\n      (() => {\n        if (window.__koaClickFeedbackInstalled)",begin);
assert.ok(begin>0&&end>begin,'admin session guard must be isolated for runtime testing');
const guard=layout.slice(begin,end);
const url='https://koasevents.com';
const json=(status,code)=>new Response(JSON.stringify({code}),{status,headers:{'Content-Type':'application/json'}});

async function scenario(name,fetchHandler,expectation){
  const calls=[],redirects=[];
  const window={
    location:{pathname:'/admin/health/',search:'',hash:'',origin:url,replace:value=>redirects.push(value)},
    fetch:async(input,options={})=>{
      const path=new URL(typeof input==='string'?input:input.url,url).pathname;
      const method=String(options?.method||input?.method||'GET').toUpperCase();
      calls.push({path,method});
      return fetchHandler(path,method,calls);
    },
  };
  runInNewContext(guard,{window,URL,Request,Response,console});
  await expectation(window,calls,redirects);
  console.log('PASS '+name);
}
await scenario('unrelated API 401 leaves valid login intact',(path)=>{
  if(path==='/api/admin/session')return json(200,'');
  return json(401,'endpoint_specific');
},async(window,calls,redirects)=>{
  const res=await window.fetch('/api/admin/calendar');
  assert.equal(res.status,401);
  assert.equal(redirects.length,0);
  assert.equal(calls.filter(x=>x.path==='/api/auth/session-refresh').length,0);
});
await scenario('expired access token is renewed and GET retried', (path,method,calls)=>{
  if(path==='/api/admin/session')return calls.filter(x=>x.path==='/api/auth/session-refresh').length?json(200,''):json(401,'unauthenticated');
  if(path==='/api/auth/session-refresh')return json(200,'');
  return calls.filter(x=>x.path==='/api/admin/calendar').length===1?json(401,'unauthenticated'):json(200,'');
},async(window,calls,redirects)=>{
  const res=await window.fetch('/api/admin/calendar');
  assert.equal(res.status,200);
  assert.equal(calls.filter(x=>x.path==='/api/admin/calendar').length,2);
  assert.equal(redirects.length,0);
});
await scenario('POST is never automatically repeated', (path,method,calls)=>{
  if(path==='/api/admin/session')return calls.filter(x=>x.path==='/api/auth/session-refresh').length?json(200,''):json(401,'unauthenticated');
  if(path==='/api/auth/session-refresh')return json(200,'');
  return json(401,'unauthenticated');
},async(window,calls,redirects)=>{
  const res=await window.fetch('/api/admin/crm',{method:'POST',body:'{}'});
  assert.equal(res.status,401);
  assert.equal(calls.filter(x=>x.path==='/api/admin/crm').length,1);
  assert.equal(redirects.length,0);
});
await scenario('revoked session triggers login',path=>path==='/api/admin/session'?json(401,'session_revoked'):json(401,'denied'),async(window,calls,redirects)=>{
  await window.fetch('/api/admin/calendar');
  assert.equal(redirects.length,1);
  assert.match(redirects[0],/reason=session_expired/);
  assert.equal(calls.filter(x=>x.path==='/api/auth/session-refresh').length,0);
});
await scenario('unrecoverable authentication redirects once',path=>path==='/api/auth/session-refresh'?json(401,'unauthenticated'):json(401,'unauthenticated'),async(window,calls,redirects)=>{
  await window.fetch('/api/admin/calendar');
  assert.equal(redirects.length,1);
  assert.equal(calls.filter(x=>x.path==='/api/auth/session-refresh').length,1);
});
await scenario('service outage is not an automatic logout',path=>path==='/api/admin/session'?json(503,'unavailable'):json(401,'endpoint_denied'),async(window,calls,redirects)=>{
  await window.fetch('/api/admin/calendar');
  assert.equal(redirects.length,0);
});
await scenario('Identity refresh outage cannot force logout',path=>
  path==='/api/auth/session-refresh'?json(503,'refresh_unavailable'):
  json(401,'unauthenticated'),async(window,calls,redirects)=>{
  await window.fetch('/api/admin/calendar');
  assert.equal(calls.filter(x=>x.path==='/api/auth/session-refresh').length,1);
  assert.equal(redirects.length,0);
});
await scenario('403 permission denial does not log the user out',()=>json(403,'forbidden'),async(window,calls,redirects)=>{
  const res=await window.fetch('/api/admin/calendar');
  assert.equal(res.status,403);
  assert.equal(calls.length,1);
  assert.equal(redirects.length,0);
});
console.log('PASS · remembered-session contract and 401 redirect runtime regression');
