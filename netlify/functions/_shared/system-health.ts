import type { Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';

export type HealthCheck = {
  id: string;
  name: string;
  kind: 'page' | 'api';
  path: string;
  ok: boolean;
  status: number;
  ms: number;
  detail: string;
};

export type HealthSnapshot = {
  id: string;
  checkedAt: string;
  overall: 'healthy' | 'unhealthy';
  passed: number;
  failed: number;
  failedIds: string[];
  alertFailedIds?: string[];
  checks: HealthCheck[];
  source: 'hourly' | 'manual' | 'post-deploy';
};

export type HealthAlertRule = {
  id: string;
  alertAfter: 1 | 2;
  publicVisible: boolean;
  publicName: string;
};

export type HealthAlertPolicy = {
  updatedAt: string;
  updatedBy: string;
  publicStatusEnabled: boolean;
  rules: HealthAlertRule[];
};

const PAGE_CHECKS = [
  ['admin-home','Content Admin','/admin/','data-auth-shell'],
  ['business-crm','Business CRM','/admin/crm/','data-admin-ui'],
  ['sales-crm','Sales CRM','/admin/quotes/','data-admin-ui'],
  ['event-ops','Event Ops','/admin/events/','data-app'],
  ['master-calendar','Master Calendar','/admin/calendar/','data-app'],
  ['blog-admin','Blog Admin','/admin/blog/','data-admin-ui'],
  ['staff-management','Staff Management','/admin/staff/','data-app'],
  ['quickbooks','QuickBooks','/admin/quickbooks/','data-app'],
  ['gallery','Gallery','/admin/gallery/','data-admin-ui'],
  ['security','Security + Spam','/admin/security/','data-app'],
  ['local-seo','Local SEO','/admin/seo/','data-admin-ui'],
  ['system-health','System Health','/admin/health/','data-app'],
  ['vendor-crm','Vendor CRM','/admin/vendors/','data-app'],
  ['insurance','Vendor Insurance','/admin/insurance/','data-app'],
  ['staff-home','Staff Home','/staff/','data-staff-ui'],
] as const;

const API_CHECKS = [
  ['admin-session','Admin session API','/api/admin/session'],
  ['business-crm-api','Business CRM API','/api/admin/crm'],
  ['sales-crm-api','Sales CRM API','/api/admin/quotes'],
  ['event-ops-api','Event Ops API','/api/admin/events'],
  ['calendar-api','Master Calendar API','/api/admin/calendar'],
  ['blog-api','Blog API','/api/blog?admin=1'],
  ['staff-api','Staff Management API','/api/admin/staff'],
  ['custom-roles-api','Custom Roles API','/api/admin/custom-roles'],
  ['auth-security-api','Authentication Security API','/api/admin/auth-security'],
  ['quickbooks-api','QuickBooks API','/api/admin/quickbooks'],
  ['gallery-api','Gallery API','/api/gallery'],
  ['security-api','Security API','/api/admin/security?days=7'],
  ['seo-api','Local SEO API','/api/admin/local-seo'],
  ['vendor-crm-api','Vendor CRM API','/api/admin/vendors'],
  ['vendor-insurance-api','Vendor Insurance API','/api/admin/vendor-insurance-compliance'],
  ['system-health-api','System Health API','/api/admin/health'],
] as const;

export function healthComponents() {
  return [
    ...PAGE_CHECKS.map(([id,name,path])=>({id,name,path,kind:'page' as const})),
    ...API_CHECKS.map(([id,name,path])=>({id,name,path,kind:'api' as const})),
  ];
}

function defaultAlertAfter(id:string):1|2 {
  const immediate=new Set([
    'business-crm','sales-crm','event-ops','master-calendar','staff-home',
    'admin-session','business-crm-api','sales-crm-api','event-ops-api','calendar-api',
  ]);
  return immediate.has(id)?1:2;
}

function defaultPublicName(id:string,name:string) {
  if(id==='staff-home'||id==='admin-session') return 'Account access';
  if(id.includes('sales-crm')||id.includes('business-crm')) return 'Booking and inquiry operations';
  if(id.includes('calendar')||id.includes('event-ops')) return 'Event planning operations';
  if(id.includes('blog')) return 'Website content';
  if(id.includes('gallery')) return 'Website media';
  return name.replace(/ API$/,'');
}

export function defaultHealthAlertPolicy():HealthAlertPolicy {
  return {
    updatedAt:'',
    updatedBy:'',
    publicStatusEnabled:false,
    rules:healthComponents().map(component=>({
      id:component.id,
      alertAfter:defaultAlertAfter(component.id),
      publicVisible:false,
      publicName:defaultPublicName(component.id,component.name),
    })),
  };
}

export async function readHealthAlertPolicy(context:Context):Promise<HealthAlertPolicy> {
  const stored:any=await healthStore(context).get('settings/alert-policy',{type:'json'});
  const defaults=defaultHealthAlertPolicy();
  if(!stored||!Array.isArray(stored.rules)) return defaults;
  const byId=new Map(stored.rules.map((rule:any)=>[String(rule?.id||''),rule]));
  return {
    updatedAt:clean(stored.updatedAt,80),
    updatedBy:clean(stored.updatedBy,240),
    publicStatusEnabled:Boolean(stored.publicStatusEnabled),
    rules:defaults.rules.map(rule=>{
      const saved:any=byId.get(rule.id);
      return {
        id:rule.id,
        alertAfter:saved?.alertAfter===1?1:2,
        publicVisible:Boolean(saved?.publicVisible),
        publicName:clean(saved?.publicName,120)||rule.publicName,
      };
    }),
  };
}

export async function saveHealthAlertPolicy(context:Context,input:any,actor:string):Promise<HealthAlertPolicy> {
  const defaults=defaultHealthAlertPolicy();
  const incoming=Array.isArray(input?.rules)?input.rules:[];
  const byId=new Map(incoming.map((rule:any)=>[String(rule?.id||''),rule]));
  const policy:HealthAlertPolicy={
    updatedAt:new Date().toISOString(),
    updatedBy:clean(actor,240)||'admin',
    publicStatusEnabled:Boolean(input?.publicStatusEnabled),
    rules:defaults.rules.map(rule=>{
      const saved:any=byId.get(rule.id);
      return {
        id:rule.id,
        alertAfter:saved?.alertAfter===1?1:2,
        publicVisible:Boolean(saved?.publicVisible),
        publicName:clean(saved?.publicName,120)||rule.publicName,
      };
    }),
  };
  await healthStore(context).setJSON('settings/alert-policy',policy);
  return policy;
}

function healthStore(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-system-health', consistency: 'strong' })
    : getDeployStore({ name: 'koa-system-health' });
}

function clean(value: unknown, max=500) {
  return String(value || '').trim().slice(0,max);
}

function baseUrl() {
  return clean(Netlify.env.get('URL'),500) || 'https://koasevents.com';
}

async function timedFetch(url:string, init:RequestInit={}) {
  const started=Date.now();
  try {
    const response=await fetch(url,{
      ...init,
      headers:{'Cache-Control':'no-cache','User-Agent':'KoaEvents-Health/1.0',...(init.headers||{})},
      signal:AbortSignal.timeout(12_000),
    });
    return {response,ms:Date.now()-started,error:''};
  } catch (error) {
    return {response:null,ms:Date.now()-started,error:error instanceof Error?error.message:'Request failed'};
  }
}

export async function runSystemHealth(source:'hourly'|'manual'|'post-deploy'='hourly'):Promise<HealthSnapshot> {
  const origin=baseUrl().replace(/\/$/,'');
  const pageChecks=PAGE_CHECKS.map(async ([id,name,path,marker]):Promise<HealthCheck>=>{
    const result=await timedFetch(origin+path);
    let body='';
    if(result.response) body=await result.response.text().catch(()=>'');
    const ok=Boolean(result.response?.ok && body.includes(marker));
    return {
      id,name,kind:'page',path,ok,status:result.response?.status||0,ms:result.ms,
      detail:result.error || (ok?'Page shell + startup marker present':result.response?.ok?'Expected startup marker missing':'Page request failed'),
    };
  });
  const apiChecks=API_CHECKS.map(async ([id,name,path]):Promise<HealthCheck>=>{
    const result=await timedFetch(origin+path);
    const status=result.response?.status||0;
    const ok=Boolean(result.response && [200,401,403].includes(status));
    return {
      id,name,kind:'api',path,ok,status,ms:result.ms,
      detail:result.error || (ok?(status===200?'Endpoint reachable':'Endpoint reachable and authorization enforced'):'Unexpected API response'),
    };
  });
  const checks=await Promise.all([...pageChecks,...apiChecks]);
  const failedIds=checks.filter(row=>!row.ok).map(row=>row.id).sort();
  return {
    id:'HLT-'+crypto.randomUUID().replaceAll('-','').slice(0,14).toUpperCase(),
    checkedAt:new Date().toISOString(),
    overall:failedIds.length?'unhealthy':'healthy',
    passed:checks.length-failedIds.length,
    failed:failedIds.length,
    failedIds,
    checks,
    source,
  };
}

export async function readLatestHealth(context:Context):Promise<HealthSnapshot|null> {
  return ((await healthStore(context).get('latest',{type:'json'})) || null) as HealthSnapshot|null;
}

export async function readLatestHourlyHealth(context:Context):Promise<HealthSnapshot|null> {
  const rows=((await healthStore(context).get('history',{type:'json'})) || []) as HealthSnapshot[];
  return rows.find(row=>row?.source==='hourly') || null;
}

export async function readHealthHistory(context:Context,limit=100):Promise<HealthSnapshot[]> {
  const rows=((await healthStore(context).get('history',{type:'json'})) || []) as HealthSnapshot[];
  return rows.slice(0,Math.max(1,Math.min(500,limit)));
}

export async function applyHealthAlertPolicy(context:Context,current:HealthSnapshot,previousHourly:HealthSnapshot|null) {
  const policy=await readHealthAlertPolicy(context);
  const ruleById=new Map(policy.rules.map(rule=>[rule.id,rule]));
  const previousFailed=new Set(previousHourly?.failedIds||[]);
  const previousConfirmed=new Set(previousHourly?.alertFailedIds||[]);
  current.alertFailedIds=current.failedIds.filter(id=>{
    const rule=ruleById.get(id);
    if(!rule||rule.alertAfter===1) return true;
    if(current.source==='hourly') return previousFailed.has(id);
    return previousConfirmed.has(id);
  }).sort();
  return {snapshot:current,policy};
}

export async function persistHealth(context:Context,snapshot:HealthSnapshot) {
  const store=healthStore(context);
  const history=((await store.get('history',{type:'json'})) || []) as HealthSnapshot[];
  await store.setJSON('latest',snapshot);
  await store.setJSON('history',[snapshot,...history].slice(0,500));

  if(snapshot.source==='hourly'){
    const uptimeRows=((await store.get('uptime/hourly',{type:'json'})) || []) as any[];
    const compact={
      checkedAt:snapshot.checkedAt,
      checks:(snapshot.checks||[]).map(check=>({id:check.id,name:check.name,kind:check.kind,path:check.path,ok:check.ok})),
    };
    await store.setJSON('uptime/hourly',[compact,...uptimeRows].slice(0,2300));
  }
}

export async function readUptimeHistory(context:Context,limit=2300) {
  const rows=((await healthStore(context).get('uptime/hourly',{type:'json'})) || []) as any[];
  return rows.slice(0,Math.max(1,Math.min(2300,limit)));
}

export function calculateUptime(history:any[]) {
  const hourly=(history||[]).filter(row=>Number.isFinite(Date.parse(String(row.checkedAt||''))));
  const windows=[
    {id:'24h',label:'24 hours',hours:24,expected:24},
    {id:'7d',label:'7 days',hours:24*7,expected:24*7},
    {id:'30d',label:'30 days',hours:24*30,expected:24*30},
    {id:'90d',label:'90 days',hours:24*90,expected:24*90},
  ];
  const componentMap=new Map<string,{id:string;name:string;kind:string;path:string}>();
  for(const snapshot of hourly){
    for(const check of snapshot.checks||[]){
      if(!componentMap.has(check.id)) componentMap.set(check.id,{id:check.id,name:check.name,kind:check.kind,path:check.path});
    }
  }
  const now=Date.now();
  const rows=[...componentMap.values()].map(component=>{
    const periods:Record<string,{uptime:number|null;samples:number;expected:number}>={};
    for(const window of windows){
      const cutoff=now-window.hours*60*60*1000;
      const samples=hourly.filter(snapshot=>Date.parse(snapshot.checkedAt)>=cutoff)
        .map(snapshot=>snapshot.checks?.find(check=>check.id===component.id))
        .filter(Boolean) as HealthCheck[];
      const healthy=samples.filter(check=>check.ok).length;
      periods[window.id]={
        uptime:samples.length?Math.round((healthy/samples.length)*10000)/100:null,
        samples:samples.length,
        expected:window.expected,
      };
    }
    return {...component,periods};
  }).sort((a,b)=>a.kind.localeCompare(b.kind)||a.name.localeCompare(b.name));
  return {generatedAt:new Date().toISOString(),windows,rows,hourlySamples:hourly.length};
}

export function calculateIncidents(history:any[]) {
  const hourly=(history||[])
    .filter(row=>Number.isFinite(Date.parse(String(row.checkedAt||''))))
    .sort((a,b)=>Date.parse(a.checkedAt)-Date.parse(b.checkedAt));
  const components=new Map<string,{id:string;name:string;kind:string;path:string}>();
  for(const snapshot of hourly){
    for(const check of snapshot.checks||[]){
      if(!components.has(check.id)) components.set(check.id,{id:check.id,name:check.name,kind:check.kind,path:check.path});
    }
  }
  const now=Date.now();
  const windows=[
    {id:'7d',days:7},
    {id:'30d',days:30},
    {id:'90d',days:90},
  ];
  const rows=[...components.values()].map(component=>{
    const incidents:any[]=[];
    let active:any=null;
    for(const snapshot of hourly){
      const check=(snapshot.checks||[]).find((row:any)=>row.id===component.id);
      if(!check) continue;
      const at=Date.parse(snapshot.checkedAt);
      if(!check.ok && !active){
        active={startedAt:snapshot.checkedAt,startedMs:at,endedAt:null,endedMs:null,ongoing:true};
      } else if(check.ok && active){
        active.endedAt=snapshot.checkedAt;
        active.endedMs=at;
        active.ongoing=false;
        active.durationMinutes=Math.max(0,Math.round((at-active.startedMs)/60000));
        incidents.push(active);
        active=null;
      }
    }
    if(active){
      active.durationMinutes=Math.max(0,Math.round((now-active.startedMs)/60000));
      incidents.push(active);
    }
    const totals:Record<string,{downtimeMinutes:number;incidentCount:number}>={};
    for(const window of windows){
      const cutoff=now-window.days*86400000;
      let downtime=0, count=0;
      for(const incident of incidents){
        const start=Math.max(incident.startedMs,cutoff);
        const end=Math.min(incident.endedMs||now,now);
        if(end>start){
          downtime+=end-start;
          count+=1;
        }
      }
      totals[window.id]={downtimeMinutes:Math.round(downtime/60000),incidentCount:count};
    }
    return {
      ...component,
      currentIncident:incidents.find(row=>row.ongoing)||null,
      recentIncidents:[...incidents].reverse().slice(0,20).map(({startedMs,endedMs,...row})=>row),
      totals,
    };
  }).sort((a,b)=>a.kind.localeCompare(b.kind)||a.name.localeCompare(b.name));
  const allIncidents=rows.flatMap(row=>row.recentIncidents.map(incident=>({componentId:row.id,componentName:row.name,...incident})))
    .sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt));
  return {generatedAt:new Date().toISOString(),rows,recentIncidents:allIncidents.slice(0,50)};
}

export function buildPublicStatus(
  latest:HealthSnapshot|null,
  incidents:any,
  uptime:any,
  policy:HealthAlertPolicy,
) {
  if(!policy.publicStatusEnabled){
    return {
      enabled:false,
      overall:'not-published',
      checkedAt:latest?.checkedAt||'',
      services:[],
      incidents:[],
    };
  }

  const ruleById=new Map(policy.rules.map(rule=>[rule.id,rule]));
  const latestById=new Map((latest?.checks||[]).map(check=>[check.id,check]));
  const uptimeById=new Map((uptime?.rows||[]).map((row:any)=>[row.id,row]));
  const incidentById=new Map((incidents?.rows||[]).map((row:any)=>[row.id,row]));
  const groups=new Map<string,any[]>();

  for(const rule of policy.rules){
    if(!rule.publicVisible) continue;
    const name=clean(rule.publicName,120)||'Koa’s Events service';
    const item={
      id:rule.id,
      check:latestById.get(rule.id),
      uptime:uptimeById.get(rule.id),
      incidents:incidentById.get(rule.id),
    };
    groups.set(name,[...(groups.get(name)||[]),item]);
  }

  const services=[...groups.entries()].map(([name,items])=>{
    const degraded=items.some(item=>item.check && !item.check.ok);
    const uptime90=items
      .map(item=>item.uptime?.periods?.['90d']?.uptime)
      .filter((value:any)=>typeof value==='number');
    const uptime90d=uptime90.length
      ? Math.round((Math.min(...uptime90))*100)/100
      : null;
    return {name,status:degraded?'degraded':'operational',uptime90d};
  }).sort((a,b)=>a.name.localeCompare(b.name));

  const publicIncidents:any[]=[];
  for(const [name,items] of groups){
    for(const item of items){
      for(const incident of item.incidents?.recentIncidents||[]){
        publicIncidents.push({
          service:name,
          startedAt:incident.startedAt,
          endedAt:incident.endedAt||null,
          ongoing:Boolean(incident.ongoing),
          durationMinutes:Number(incident.durationMinutes||0),
        });
      }
    }
  }

  const dedup=new Map<string,any>();
  for(const incident of publicIncidents){
    const key=[incident.service,incident.startedAt,incident.endedAt||'ongoing'].join('|');
    if(!dedup.has(key)) dedup.set(key,incident);
  }
  const recent=[...dedup.values()]
    .sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt))
    .slice(0,20);

  return {
    enabled:true,
    overall:services.some(service=>service.status==='degraded')?'degraded':'operational',
    checkedAt:latest?.checkedAt||'',
    services,
    incidents:recent,
  };
}

export function healthTransition(previous:HealthSnapshot|null,current:HealthSnapshot) {
  const prev=new Set(previous?.alertFailedIds||[]);
  const curr=new Set(current.alertFailedIds||[]);
  const broken=[...curr].filter(id=>!prev.has(id));
  const recovered=[...prev].filter(id=>!curr.has(id));
  if(!broken.length&&!recovered.length) return {changed:false,type:'none' as const,broken,recovered};
  return {
    changed:true,
    type:curr.size===0?'recovered' as const:broken.length?'broken' as const:'partial-recovery' as const,
    broken,recovered,
  };
}

function esc(value:unknown){
  return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

async function sendHealthEmail(current:HealthSnapshot,transition:any,failedNames:string[],recoveredNames:string[],brokenNames:string[]) {
  const apiKey=clean(Netlify.env.get('RESEND_API_KEY'),500);
  if(!apiKey) return {channel:'email',sent:false,reason:'resend-not-configured'};

  const configured=clean(Netlify.env.get('KOA_HEALTH_ALERT_EMAILS'),500)
    || clean(Netlify.env.get('KOA_LEAD_EMAIL_TO'),500)
    || 'chris@sibel.org';
  const recipients=configured.split(',').map(v=>v.trim()).filter(v=>v.includes('@'));
  if(!recipients.length) return {channel:'email',sent:false,reason:'no-recipient'};

  const from=clean(Netlify.env.get('KOA_HEALTH_ALERT_FROM'),240)
    || clean(Netlify.env.get('KOA_LEAD_EMAIL_FROM'),240)
    || 'Koa’s Events <leads@koasevents.com>';
  const fullyRecovered=(current.alertFailedIds||[]).length===0;
  const subject=fullyRecovered
    ? 'Koa’s System Health recovered'
    : 'Koa’s System Health alert — '+failedNames.length+' confirmed check'+(failedNames.length===1?'':'s')+' failing';
  const summary=fullyRecovered
    ? 'All monitored Koa’s admin/staff services are healthy again.'
    : 'The health monitor detected a change in system health.';
  const html='<!doctype html><html><body style="margin:0;background:#f5f0e7;padding:28px;font-family:Arial,sans-serif;color:#173d30">'
    +'<div style="max-width:680px;margin:auto;background:#fff;border:1px solid #e7dfd0;border-radius:20px;padding:28px">'
    +'<div style="font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#a96d4a">Koa’s Events · System Health</div>'
    +'<h1 style="font-family:Georgia,serif;font-size:30px;margin:10px 0 14px">'+esc(fullyRecovered?'System recovered':'Health change detected')+'</h1>'
    +'<p style="line-height:1.6;color:#52635b">'+esc(summary)+'</p>'
    +(brokenNames.length?'<p><strong>Newly failing:</strong> '+brokenNames.map(esc).join(', ')+'</p>':'')
    +(recoveredNames.length?'<p><strong>Recovered:</strong> '+recoveredNames.map(esc).join(', ')+'</p>':'')
    +(failedNames.length?'<p><strong>Still failing:</strong> '+failedNames.map(esc).join(', ')+'</p>':'')
    +'<p style="font-size:12px;color:#78827d">Checked '+esc(current.checkedAt)+' · '+failedNames.length+' confirmed alert condition'+(failedNames.length===1?'':'s')+'</p>'
    +'<p><a href="https://koasevents.com/admin/health/" style="display:inline-block;background:#173d30;color:white;text-decoration:none;border-radius:999px;padding:12px 18px;font-size:12px;font-weight:800">Open System Health</a></p>'
    +'</div></body></html>';
  const text=[
    'Koa’s Events System Health',summary,
    brokenNames.length?'Newly failing: '+brokenNames.join(', '):'',
    recoveredNames.length?'Recovered: '+recoveredNames.join(', '):'',
    failedNames.length?'Still failing: '+failedNames.join(', '):'',
    'Checked: '+current.checkedAt,
    'System Health: https://koasevents.com/admin/health/',
  ].filter(Boolean).join('\n');
  try{
    const response=await fetch('https://api.resend.com/emails',{
      method:'POST',
      headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json','Idempotency-Key':('koa-health-email-'+current.id).slice(0,256)},
      body:JSON.stringify({from,to:recipients,subject,html,text}),
      signal:AbortSignal.timeout(12_000),
    });
    const body:any=await response.json().catch(()=>({}));
    if(!response.ok) return {channel:'email',sent:false,reason:'resend-error',status:response.status,error:clean(body?.message,240)};
    return {channel:'email',sent:true,id:clean(body?.id,120)};
  }catch(error){
    return {channel:'email',sent:false,reason:'request-error',error:error instanceof Error?clean(error.message,240):'request-error'};
  }
}

async function sendHealthSlack(current:HealthSnapshot,failedNames:string[],recoveredNames:string[],brokenNames:string[]) {
  const webhook=clean(Netlify.env.get('KOA_HEALTH_SLACK_WEBHOOK_URL'),1000);
  if(!webhook) return {channel:'slack',sent:false,reason:'not-configured'};
  const recovered=(current.alertFailedIds||[]).length===0;
  const lines=[
    recovered?'✅ *Koa’s System Health recovered*':'🚨 *Koa’s System Health changed*',
    brokenNames.length?'*Newly failing:* '+brokenNames.join(', '):'',
    recoveredNames.length?'*Recovered:* '+recoveredNames.join(', '):'',
    failedNames.length?'*Still failing:* '+failedNames.join(', '):'',
    failedNames.length+' confirmed alert condition'+(failedNames.length===1?'':'s'),
    '<https://koasevents.com/admin/health/|Open System Health>',
  ].filter(Boolean);
  try{
    const response=await fetch(webhook,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({text:lines.join('\n')}),
      signal:AbortSignal.timeout(12_000),
    });
    return response.ok?{channel:'slack',sent:true}:{channel:'slack',sent:false,reason:'slack-error',status:response.status};
  }catch(error){
    return {channel:'slack',sent:false,reason:'request-error',error:error instanceof Error?clean(error.message,240):'request-error'};
  }
}

async function sendHealthSms(current:HealthSnapshot,failedNames:string[],recoveredNames:string[],brokenNames:string[]) {
  const sid=clean(Netlify.env.get('TWILIO_ACCOUNT_SID'),200);
  const token=clean(Netlify.env.get('TWILIO_AUTH_TOKEN'),300);
  const from=clean(Netlify.env.get('TWILIO_FROM_NUMBER'),80);
  const recipients=clean(Netlify.env.get('KOA_HEALTH_SMS_TO'),500).split(',').map(v=>v.trim()).filter(Boolean);
  if(!sid||!token||!from||!recipients.length) return {channel:'sms',sent:false,reason:'not-configured'};
  const recovered=(current.alertFailedIds||[]).length===0;
  const parts=[
    recovered?'Koa’s System Health recovered.':'Koa’s System Health alert.',
    brokenNames.length?'New failing: '+brokenNames.join(', ')+'.':'',
    recoveredNames.length?'Recovered: '+recoveredNames.join(', ')+'.':'',
    failedNames.length?'Still failing: '+failedNames.join(', ')+'.':'',
    'https://koasevents.com/admin/health/',
  ].filter(Boolean);
  const body=parts.join(' ').slice(0,1200);
  const auth='Basic '+btoa(sid+':'+token);
  const results:any[]=[];
  for(const to of recipients){
    try{
      const form=new URLSearchParams({From:from,To:to,Body:body});
      const response=await fetch('https://api.twilio.com/2010-04-01/Accounts/'+encodeURIComponent(sid)+'/Messages.json',{
        method:'POST',
        headers:{Authorization:auth,'Content-Type':'application/x-www-form-urlencoded'},
        body:form.toString(),
        signal:AbortSignal.timeout(12_000),
      });
      const data:any=await response.json().catch(()=>({}));
      results.push({to,sent:response.ok,status:response.status,id:clean(data?.sid,120),error:response.ok?'':clean(data?.message,240)});
    }catch(error){
      results.push({to,sent:false,status:0,error:error instanceof Error?clean(error.message,240):'request-error'});
    }
  }
  return {channel:'sms',sent:results.some(row=>row.sent),results};
}

export async function sendHealthTransitionAlerts(previous:HealthSnapshot|null,current:HealthSnapshot) {
  const transition=healthTransition(previous,current);
  if(!transition.changed) return {changed:false,transition,channels:[]};
  const confirmed=new Set(current.alertFailedIds||[]);
  const failedNames=current.checks.filter(row=>confirmed.has(row.id)).map(row=>row.name);
  const recoveredNames=(previous?.checks||[]).filter(row=>transition.recovered.includes(row.id)).map(row=>row.name);
  const brokenNames=current.checks.filter(row=>transition.broken.includes(row.id)).map(row=>row.name);
  const channels=await Promise.all([
    sendHealthEmail(current,transition,failedNames,recoveredNames,brokenNames),
    sendHealthSlack(current,failedNames,recoveredNames,brokenNames),
    sendHealthSms(current,failedNames,recoveredNames,brokenNames),
  ]);
  return {changed:true,transition,channels};
}


export async function readPostDeployVerification(context:Context) {
  return ((await healthStore(context).get('deployments/post-deploy-verification',{type:'json'})) || null) as any;
}

export async function savePostDeployVerification(context:Context,record:any) {
  await healthStore(context).setJSON('deployments/post-deploy-verification',record);
  return record;
}

export async function cachedDeploymentHistory(context:Context) {
  const store=healthStore(context);
  const cached:any=await store.get('deployments/cache',{type:'json'});
  if(cached && Date.now()-Date.parse(String(cached.generatedAt||''))<10*60*1000) return cached;

  const origin=baseUrl().replace(/\/$/,'');
  const home=await timedFetch(origin+'/');
  const html=home.response?await home.response.text().catch(()=>''):'';
  const match=(name:string)=>html.match(new RegExp('<meta\\s+name=["\\\']'+name+'["\\\']\\s+content=["\\\']([^"\\\']+)["\\\']','i'))?.[1]||'';
  const current:any={
    commit:match('koa-build-commit'),
    deployId:match('koa-deploy-id'),
    builtAt:match('koa-build-time'),
    deployTime:match('koa-build-time'),
    functionCount:null,
    mainCommit:'',
    behindMain:null,
    commitsBehind:null,
    compareStatus:'',
  };

  const githubToken=clean(Netlify.env.get('KOA_GITHUB_READ_TOKEN'),500);
  const headers:Record<string,string>={
    'Accept':'application/vnd.github+json',
    'User-Agent':'KoaEvents-Health/1.0',
    ...(githubToken?{Authorization:'Bearer '+githubToken}:{}),
  };

  try{
    const response=await fetch('https://api.github.com/repos/AstroTat808/koasevents.com/commits/main',{headers,signal:AbortSignal.timeout(12_000)});
    if(response.ok){
      const body:any=await response.json();
      current.mainCommit=clean(body?.sha,80);
    }
  }catch{}

  if(current.commit){
    try{
      const response=await fetch('https://api.github.com/repos/AstroTat808/koasevents.com/contents/netlify/functions?ref='+encodeURIComponent(current.commit),{headers,signal:AbortSignal.timeout(12_000)});
      if(response.ok){
        const rows:any[]=await response.json();
        current.functionCount=rows.filter((row:any)=>
          row?.type==='file' && /\.(?:mts|ts|mjs|js|cjs)$/i.test(String(row?.name||''))
        ).length;
      }
    }catch{}
  }

  if(current.commit && current.mainCommit){
    if(current.commit===current.mainCommit){
      current.behindMain=false;
      current.commitsBehind=0;
      current.compareStatus='identical';
    }else{
      try{
        const response=await fetch(
          'https://api.github.com/repos/AstroTat808/koasevents.com/compare/'+encodeURIComponent(current.commit)+'...'+encodeURIComponent(current.mainCommit),
          {headers,signal:AbortSignal.timeout(12_000)},
        );
        if(response.ok){
          const body:any=await response.json();
          current.compareStatus=clean(body?.status,40);
          const mainAhead=Math.max(0,Number(body?.ahead_by||0));
          current.commitsBehind=Number.isFinite(mainAhead)?mainAhead:null;
          current.behindMain=mainAhead>0;
        }else{
          current.behindMain=current.commit!==current.mainCommit;
        }
      }catch{
        current.behindMain=current.commit!==current.mainCommit;
      }
    }
  }

  let runs:any[]=[];
  try{
    const response=await fetch('https://api.github.com/repos/AstroTat808/koasevents.com/actions/workflows/production-visual-qa.yml/runs?per_page=20',{headers,signal:AbortSignal.timeout(12_000)});
    if(response.ok) runs=(await response.json()).workflow_runs||[];
  }catch{}

  const history:any[]=[];
  for(const run of runs.slice(0,15)){
    let failedJobs:string[]=[];
    if(run.conclusion==='failure'){
      try{
        const response=await fetch('https://api.github.com/repos/AstroTat808/koasevents.com/actions/runs/'+run.id+'/jobs?per_page=50',{headers,signal:AbortSignal.timeout(12_000)});
        if(response.ok){
          const jobs=(await response.json()).jobs||[];
          failedJobs=jobs.filter((job:any)=>job.conclusion==='failure').map((job:any)=>clean(job.name,180));
        }
      }catch{}
    }
    history.push({
      runId:String(run.id||''),
      commit:clean(run.head_sha,80),
      branch:clean(run.head_branch,100),
      status:clean(run.status,40),
      conclusion:clean(run.conclusion,40),
      event:clean(run.event,40),
      createdAt:clean(run.created_at,80),
      updatedAt:clean(run.updated_at,80),
      url:clean(run.html_url,500),
      failedJobs,
    });
  }

  const lastSuccessfulQa=history.find(row=>
    row.conclusion==='success' && row.event==='push' && row.branch==='main'
  )||null;
  const latestQaForCurrentDeploy=history.find(row=>
    row.commit===current.commit && row.event==='push' && row.branch==='main'
  )||null;
  const failedBuilds=history.filter(row=>row.conclusion==='failure');
  const deploymentHealthy=Boolean(
    current.commit &&
    current.deployId &&
    current.behindMain===false &&
    lastSuccessfulQa &&
    lastSuccessfulQa.commit===current.commit
  );
  const postDeployVerification=await readPostDeployVerification(context);
  const result={
    generatedAt:new Date().toISOString(),
    current,
    deploymentHealthy,
    postDeployVerification,
    lastSuccessfulDeployment:current,
    lastSuccessfulQa,
    latestQaForCurrentDeploy,
    failedBuilds,
    history,
  };
  await store.setJSON('deployments/cache',result);
  return result;
}
