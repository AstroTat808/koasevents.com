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
  ['admin-home','Content Admin','/admin/','data-auth-panel'],
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

export type ProductionRelease = {
  deployId:string;
  commit:string;
  commitTitle:string;
  commitMessage:string;
  publishedAt:string;
  deployDurationSeconds:number|null;
  features:string[];
  changedFiles:string[];
  verification:any;
  authorName:string;
  authorLogin:string;
  pullRequestNumber:number|null;
  pullRequestUrl:string;
  summary:string;
  recordedAt:string;
};

export async function readProductionReleases(context:Context,limit=50):Promise<ProductionRelease[]> {
  const rows=((await healthStore(context).get('deployments/releases',{type:'json'})) || []) as ProductionRelease[];
  return rows.slice(0,Math.max(1,Math.min(100,limit)));
}

export function featureLabelsForFiles(files:string[]) {
  const labels=new Set<string>();
  for(const path of files){
    if(path.includes('/admin/staff')||path.includes('admin-staff')||path.includes('custom-roles')) labels.add('User Management');
    if(path.includes('identity')||path.includes('account-security')||path.includes('auth-security')||path.includes('/staff/')) labels.add('Authentication & Security');
    if(path.includes('/admin/crm')||path.includes('admin-crm')||path.includes('crm-')) labels.add('Business CRM');
    if(path.includes('/admin/quotes')||path.includes('admin-quotes')||path.includes('quotes.')) labels.add('Sales CRM & Proposals');
    if(path.includes('/admin/events')||path.includes('admin-events')||path.includes('event-')) labels.add('Event Ops');
    if(path.includes('/admin/calendar')||path.includes('admin-calendar')) labels.add('Master Calendar');
    if(path.includes('quickbooks')) labels.add('QuickBooks');
    if(path.includes('/admin/vendors')||path.includes('admin-vendors')||path.includes('vendor-marketplace')||path.includes('vendor-portal')) labels.add('Vendor CRM');
    if(path.includes('/admin/insurance')||path.includes('insurance')) labels.add('Insurance Compliance');
    if(path.includes('/admin/blog')||path.includes('blog.')) labels.add('Blog');
    if(path.includes('/admin/gallery')||path.includes('gallery.')) labels.add('Gallery');
    if(path.includes('/admin/seo')||path.includes('local-seo')) labels.add('Local SEO');
    if(path.includes('/admin/health')||path.includes('system-health')||path.includes('health-monitor')||path.includes('post-deploy')) labels.add('System Health');
    if(path.startsWith('src/pages/')&&!path.includes('/admin/')&&!path.includes('/staff/')) labels.add('Public Website');
    if(path.startsWith('.github/')||path==='netlify.toml'||path.startsWith('scripts/')) labels.add('Deployment & QA');
  }
  return [...labels];
}

function plainEnglishReleaseSummary(title:string,features:string[]) {
  const staffAreas=features.filter((feature)=>[
    'User Management','Authentication & Security','Business CRM','Sales CRM & Proposals',
    'Event Ops','Master Calendar','QuickBooks','Vendor CRM','Insurance Compliance','System Health',
    'Deployment & QA'
  ].includes(feature));
  const clientAreas=features.filter((feature)=>[
    'Public Website','Blog','Gallery','Local SEO'
  ].includes(feature));
  const parts:string[]=[];
  if(staffAreas.length) parts.push('Staff systems changed: '+staffAreas.join(', ')+'.');
  if(clientAreas.length) parts.push('Client-facing website changed: '+clientAreas.join(', ')+'.');
  if(!parts.length) parts.push('Technical release with no categorized staff/client feature area.');
  if(title) parts.push('Release focus: '+clean(title,220)+'.');
  return parts.join(' ');
}

function releaseRiskFlags(files:any[],commits:any[]) {
  const definitions=[
    {id:'authentication',label:'Authentication / access',severity:'high',path:/identity|auth-|account-security|admin-staff|custom-roles|staff-directory|admin-session/i,content:/password|session|role|permission|login|logout|token|identity|auth/i},
    {id:'payments',label:'Payments / accounting',severity:'high',path:/quickbooks|payment|invoice|billing|price|estimate|deposit/i,content:/payment|invoice|quickbooks|billing|refund|deposit|balance|amount/i},
    {id:'crm-deletion',label:'CRM deletion / cleanup',severity:'high',path:/crm|quotes|sales|security/i,content:/delete|trash|restore|cleanup|purge|remove.*record|auto.?trash|confirmed.?spam/i,requireBoth:true},
    {id:'forms',label:'Public forms / lead capture',severity:'medium',path:/inquire|contact|wedding-inquiry|thank-you|stay|crm-inquiries|forms?/i,content:/form|submit|inquiry|turnstile|honeypot|lead/i},
    {id:'security',label:'Security controls',severity:'high',path:/security|turnstile|rate.?limit|edge-functions|headers|admin\.ts/i,content:/block|security|turnstile|siteverify|rate.?limit|permission|csrf|origin/i},
    {id:'storage',label:'Database / storage',severity:'high',path:/store|storage|blobs?|database|postgres|neon|schema|migration/i,content:/getStore|getDeployStore|database|storage|blob|migration|schema/i},
    {id:'environment',label:'Environment / deployment variables',severity:'high',path:/netlify\.toml|(^|\/)\.env|env\.d|config/i,content:/Netlify\.env|process\.env|\$\{\{\s*secrets\.|environment variable|site.?id|secret key|api key/i},
  ];
  const flags:any[]=[];
  for(const definition of definitions){
    const matchingFiles=files.filter((file:any)=>{
      const filename=String(file?.filename||'');
      const patch=String(file?.patch||'');
      const pathMatch=definition.path.test(filename);
      const contentMatch=definition.content.test(patch);
      return definition.requireBoth ? (pathMatch&&contentMatch) : (pathMatch||contentMatch);
    }).map((file:any)=>file.filename);
    const matchingCommits=commits.filter((commit:any)=>definition.content.test(String(commit?.message||commit?.title||''))).map((commit:any)=>commit.title);
    if(matchingFiles.length||matchingCommits.length){
      flags.push({
        id:definition.id,
        label:definition.label,
        severity:definition.severity,
        files:[...new Set(matchingFiles)].slice(0,25),
        commits:[...new Set(matchingCommits)].slice(0,12),
      });
    }
  }
  return flags;
}

export async function compareProductionReleaseCommits(baseCommit:string,headCommit:string) {
  const base=clean(baseCommit,120);
  const head=clean(headCommit,120);
  if(!base||!head) throw new Error('Both release commits are required.');
  if(base===head) return {
    baseCommit:base,
    headCommit:head,
    status:'identical',
    aheadBy:0,
    behindBy:0,
    totalCommits:0,
    features:[],
    commits:[],
    files:[],
    behaviorChanges:[],
  };

  const githubToken=clean(Netlify.env.get('KOA_GITHUB_READ_TOKEN'),500);
  const headers:Record<string,string>={
    'Accept':'application/vnd.github+json',
    'User-Agent':'KoaEvents-Health/1.0',
    ...(githubToken?{Authorization:'Bearer '+githubToken}:{}),
  };
  const response=await fetch(
    'https://api.github.com/repos/AstroTat808/koasevents.com/compare/'+encodeURIComponent(base)+'...'+encodeURIComponent(head),
    {headers,signal:AbortSignal.timeout(15_000)},
  );
  if(!response.ok) throw new Error('GitHub release comparison failed with HTTP '+response.status+'.');
  const body:any=await response.json();
  const rawFiles=Array.isArray(body?.files)?body.files:[];
  const files=rawFiles.map((file:any)=>({
    filename:clean(file?.filename,400),
    status:clean(file?.status,40),
    additions:Number(file?.additions||0),
    deletions:Number(file?.deletions||0),
    changes:Number(file?.changes||0),
    previousFilename:clean(file?.previous_filename,400),
  })).filter((file:any)=>file.filename);
  const commits=(Array.isArray(body?.commits)?body.commits:[]).map((commit:any)=>{
    const message=clean(commit?.commit?.message,3000);
    return {
      sha:clean(commit?.sha,80),
      title:clean(message.split('\n')[0],300),
      message,
      authoredAt:clean(commit?.commit?.author?.date,80),
      committedAt:clean(commit?.commit?.committer?.date,80),
    };
  });
  const features=featureLabelsForFiles(files.map((file:any)=>file.filename));
  const behaviorChanges=commits.map((commit:any)=>commit.title).filter(Boolean);
  const riskFlags=releaseRiskFlags(rawFiles,commits);
  return {
    baseCommit:clean(body?.base_commit?.sha,80)||base,
    headCommit:clean(body?.merge_base_commit?.sha,80)===head?head:(clean(body?.commits?.at?.(-1)?.sha,80)||head),
    status:clean(body?.status,40),
    aheadBy:Number(body?.ahead_by||0),
    behindBy:Number(body?.behind_by||0),
    totalCommits:Number(body?.total_commits||commits.length),
    features,
    commits,
    files,
    behaviorChanges,
    riskFlags,
    riskLevel:riskFlags.some((flag:any)=>flag.severity==='high')?'high':riskFlags.length?'medium':'low',
  };
}

export async function recordProductionRelease(context:Context,input:any) {
  const deployId=clean(input?.deployId,120);
  const commit=clean(input?.commit,120);
  if(!deployId) return null;
  const store=healthStore(context);
  const existing=await readProductionReleases(context,100);
  const previous=existing.find(row=>row.deployId===deployId);

  const githubToken=clean(Netlify.env.get('KOA_GITHUB_READ_TOKEN'),500);
  const githubHeaders:Record<string,string>={
    'Accept':'application/vnd.github+json',
    'User-Agent':'KoaEvents-Health/1.0',
    ...(githubToken?{Authorization:'Bearer '+githubToken}:{}),
  };

  let commitTitle=previous?.commitTitle||'';
  let commitMessage=previous?.commitMessage||'';
  let changedFiles=previous?.changedFiles||[];
  let authorName=previous?.authorName||'';
  let authorLogin=previous?.authorLogin||'';
  let pullRequestNumber=previous?.pullRequestNumber??null;
  let pullRequestUrl=previous?.pullRequestUrl||'';
  let displayCommit=commit;
  let parentCommit='';
  if(commit){
    try{
      const response=await fetch('https://api.github.com/repos/AstroTat808/koasevents.com/commits/'+encodeURIComponent(commit),{
        headers:githubHeaders,signal:AbortSignal.timeout(12_000),
      });
      if(response.ok){
        const body:any=await response.json();
        commitMessage=clean(body?.commit?.message,2000);
        commitTitle=clean(commitMessage.split('\n')[0],300);
        parentCommit=clean(body?.parents?.[0]?.sha,80);
        changedFiles=Array.isArray(body?.files)
          ? body.files.map((file:any)=>clean(file?.filename,300)).filter(Boolean).slice(0,300)
          : changedFiles;
        authorName=clean(body?.commit?.author?.name,180)||authorName;
        authorLogin=clean(body?.author?.login,120)||authorLogin;

        if(/^Trigger .*production deploy/i.test(commitTitle)&&parentCommit){
          try{
            const parentResponse=await fetch('https://api.github.com/repos/AstroTat808/koasevents.com/commits/'+encodeURIComponent(parentCommit),{
              headers:githubHeaders,signal:AbortSignal.timeout(12_000),
            });
            if(parentResponse.ok){
              const parentBody:any=await parentResponse.json();
              const parentMessage=clean(parentBody?.commit?.message,2000);
              if(parentMessage){
                displayCommit=parentCommit;
                commitMessage=parentMessage;
                commitTitle=clean(parentMessage.split('\n')[0],300);
                authorName=clean(parentBody?.commit?.author?.name,180)||authorName;
                authorLogin=clean(parentBody?.author?.login,120)||authorLogin;
              }
            }
          }catch{}
        }

        const titlePr=commitTitle.match(/\(#(\d+)\)\s*$/);
        if(titlePr){
          pullRequestNumber=Number(titlePr[1]);
          pullRequestUrl='https://github.com/AstroTat808/koasevents.com/pull/'+pullRequestNumber;
        }
      }
    }catch{}
    if(!pullRequestNumber){
      try{
        const response=await fetch('https://api.github.com/repos/AstroTat808/koasevents.com/commits/'+encodeURIComponent(displayCommit||commit)+'/pulls',{
          headers:{...githubHeaders,'Accept':'application/vnd.github+json'},
          signal:AbortSignal.timeout(12_000),
        });
        if(response.ok){
          const pulls:any[]=await response.json();
          const merged=pulls.find((pull:any)=>pull?.merged_at)||pulls[0];
          if(merged){
            pullRequestNumber=Number(merged?.number||0)||null;
            pullRequestUrl=clean(merged?.html_url,500);
            authorLogin=authorLogin||clean(merged?.user?.login,120);
          }
        }
      }catch{}
    }
  }

  const previousRelease=existing
    .filter(row=>row.deployId!==deployId&&row.commit&&row.commit!==commit)
    .sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))[0];
  if(previousRelease?.commit&&commit){
    try{
      const response=await fetch(
        'https://api.github.com/repos/AstroTat808/koasevents.com/compare/'+encodeURIComponent(previousRelease.commit)+'...'+encodeURIComponent(commit),
        {headers:githubHeaders,signal:AbortSignal.timeout(15_000)},
      );
      if(response.ok){
        const body:any=await response.json();
        const releaseFiles=(Array.isArray(body?.files)?body.files:[])
          .map((file:any)=>clean(file?.filename,300))
          .filter(Boolean)
          .slice(0,500);
        if(releaseFiles.length) changedFiles=releaseFiles;
      }
    }catch{}
  }

  let publishedAt=clean(input?.publishedAt,80)||previous?.publishedAt||clean(input?.checkedAt,80);
  let deployDurationSeconds=Number.isFinite(Number(input?.deployDurationSeconds))
    ? Number(input.deployDurationSeconds)
    : previous?.deployDurationSeconds??null;
  const netlifyToken=clean(Netlify.env.get('NETLIFY_AUTH_TOKEN'),500);
  if(netlifyToken){
    try{
      const response=await fetch('https://api.netlify.com/api/v1/deploys/'+encodeURIComponent(deployId),{
        headers:{Authorization:'Bearer '+netlifyToken,'User-Agent':'KoaEvents-Health/1.0'},
        signal:AbortSignal.timeout(12_000),
      });
      if(response.ok){
        const deploy:any=await response.json();
        publishedAt=clean(deploy?.published_at||deploy?.updated_at||deploy?.created_at,80)||publishedAt;
        const seconds=Number(deploy?.deploy_time);
        if(Number.isFinite(seconds)) deployDurationSeconds=seconds;
      }
    }catch{}
  }

  const record:ProductionRelease={
    deployId,
    commit,
    commitTitle:commitTitle||('Production deploy '+deployId.slice(0,8)),
    commitMessage,
    publishedAt:publishedAt||new Date().toISOString(),
    deployDurationSeconds,
    features:featureLabelsForFiles(changedFiles),
    changedFiles,
    verification:input?.verification||previous?.verification||null,
    authorName,
    authorLogin,
    pullRequestNumber,
    pullRequestUrl,
    summary:plainEnglishReleaseSummary(commitTitle,featureLabelsForFiles(changedFiles)),
    recordedAt:new Date().toISOString(),
  };
  const next=[record,...existing.filter(row=>row.deployId!==deployId)]
    .sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))
    .slice(0,100);
  await store.setJSON('deployments/releases',next);
  return record;
}

export async function hydrateProductionReleaseMetadata(context:Context,releases:ProductionRelease[],limit=20) {
  const hydrated:ProductionRelease[]=[];
  let refreshed=0;
  for(const release of releases){
    const missing=!release.summary||!release.authorName||!release.pullRequestUrl;
    if(missing&&refreshed<Math.max(1,Math.min(25,limit))){
      try{
        const row=await recordProductionRelease(context,release);
        hydrated.push((row||release) as ProductionRelease);
        refreshed+=1;
        continue;
      }catch{}
    }
    hydrated.push(release);
  }
  return hydrated;
}

export function releaseTimelineWithIncidents(releases:ProductionRelease[],qaHistory:any[],incidents:any) {
  const sorted=[...(releases||[])].sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt));
  return sorted.map((release,index)=>{
    const newer=sorted[index-1];
    const start=Date.parse(release.publishedAt);
    const end=newer?Date.parse(newer.publishedAt):Date.now();
    const releaseIncidents=(incidents?.recentIncidents||[]).filter((incident:any)=>{
      const at=Date.parse(String(incident?.startedAt||''));
      return Number.isFinite(at)&&at>=start&&at<end;
    });
    const qa=qaHistory.find((row:any)=>
      row.commit===release.commit && row.event==='push' && row.branch==='main'
    )||null;
    return {...release,qa,incidents:releaseIncidents};
  });
}

export async function savePostDeployVerification(context:Context,record:any) {
  await healthStore(context).setJSON('deployments/post-deploy-verification',record);
  return record;
}

function normalizedDeployRootCause(value: unknown) {
  const raw=clean(value,1000).replace(/\s+/g,' ').trim();
  if(!raw) return 'Unknown deployment failure';
  if(/build script returned non-zero exit code:\s*2/i.test(raw)) return 'Build script exited with code 2';
  if(/build script returned non-zero exit code/i.test(raw)) return raw.replace(/^.*?(Build script returned non-zero exit code[^.]*).*$/i,'$1');
  if(/build command failed|command failed/i.test(raw)) return 'Build command failed';
  if(/dependency|npm|package/i.test(raw) && /fail|error/i.test(raw)) return 'Dependency / package installation failure';
  if(/timeout|timed out/i.test(raw)) return 'Build timed out';
  return raw.slice(0,220);
}

function groupConsecutiveDeployFailures(rows:any[]) {
  const sorted=[...(rows||[])].sort((a,b)=>Date.parse(String(b.createdAt||''))-Date.parse(String(a.createdAt||'')));
  const groups:any[]=[];
  let active:any=null;
  for(const row of sorted){
    if(row.state!=='error'&&row.state!=='failed'){
      active=null;
      continue;
    }
    const rootCause=normalizedDeployRootCause(row.errorMessage||row.title||'Unknown deployment failure');
    if(active&&active.rootCause===rootCause){
      active.count+=1;
      active.firstAt=row.createdAt||active.firstAt;
      active.commits.push(row.commit);
      active.deployIds.push(row.deployId);
      active.titles.push(row.title);
      continue;
    }
    active={
      rootCause,
      count:1,
      firstAt:row.createdAt||'',
      lastAt:row.createdAt||'',
      commits:[row.commit].filter(Boolean),
      deployIds:[row.deployId].filter(Boolean),
      titles:[row.title].filter(Boolean),
    };
    groups.push(active);
  }
  return groups.slice(0,12);
}

function billingCycleWindow(now=new Date()) {
  const configured=Number(Netlify.env.get('KOA_NETLIFY_BILLING_CYCLE_DAY') || 22);
  const cycleDay=Number.isFinite(configured)?Math.min(28,Math.max(1,Math.floor(configured))):22;
  const year=now.getUTCFullYear();
  const month=now.getUTCMonth();
  const thisMonthStart=new Date(Date.UTC(year,month,cycleDay,0,0,0,0));
  const start=now>=thisMonthStart
    ? thisMonthStart
    : new Date(Date.UTC(year,month-1,cycleDay,0,0,0,0));
  const end=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,cycleDay,0,0,0,0));
  return {cycleDay,start:start.toISOString(),end:end.toISOString()};
}

function positiveNumber(value:unknown,fallback:number) {
  const parsed=Number(value);
  return Number.isFinite(parsed)&&parsed>=0?parsed:fallback;
}

function netlifyCreditRates() {
  return {
    productionDeploy:positiveNumber(Netlify.env.get('KOA_NETLIFY_PRODUCTION_DEPLOY_CREDITS'),15),
    computeGbHour:positiveNumber(Netlify.env.get('KOA_NETLIFY_COMPUTE_CREDITS_PER_GB_HOUR'),10),
    bandwidthGb:positiveNumber(Netlify.env.get('KOA_NETLIFY_BANDWIDTH_CREDITS_PER_GB'),20),
    webRequests10k:positiveNumber(Netlify.env.get('KOA_NETLIFY_WEB_REQUEST_CREDITS_PER_10K'),2),
  };
}

function creditSeverity(percent:number|null) {
  if(percent==null||!Number.isFinite(percent)) return 'unknown';
  if(percent>=90) return 'red';
  if(percent>=80) return 'orange';
  if(percent>=60) return 'yellow';
  return 'green';
}

function scheduledRunsPerDay(schedules:any[]) {
  let total=0;
  for(const item of schedules||[]){
    const cron=clean(item?.cron,80);
    if(!cron) continue;
    if(cron==='@hourly'){total+=24;continue;}
    let match=cron.match(/^\*\/(\d+) \* \* \* \*$/);
    if(match){total+=1440/Math.max(1,Number(match[1]));continue;}
    match=cron.match(/^0 \*\/(\d+) \* \* \*$/);
    if(match){total+=24/Math.max(1,Number(match[1]));continue;}
    if(/^0 \d{1,2} \* \* \*$/.test(cron)){total+=1;continue;}
  }
  return Math.round(total*100)/100;
}

async function fetchNetlifyBandwidthUsage(token:string) {
  if(!token) return null;
  const teamSlug=clean(Netlify.env.get('KOA_NETLIFY_TEAM_SLUG') || 'koasadmin',120);
  try{
    const response=await fetch('https://api.netlify.com/api/v1/accounts/'+encodeURIComponent(teamSlug)+'/bandwidth',{
      headers:{Authorization:'Bearer '+token,'User-Agent':'KoaEvents-Health/1.0'},
      signal:AbortSignal.timeout(12_000),
    });
    if(!response.ok) return null;
    const body:any=await response.json();
    const used=Number(body?.used);
    if(!Number.isFinite(used)||used<0) return null;
    return {
      usedBytes:used,
      includedBytes:Number.isFinite(Number(body?.included))?Number(body.included):null,
      additionalBytes:Number.isFinite(Number(body?.additional))?Number(body.additional):null,
      periodStart:clean(body?.period_start_date,80),
      periodEnd:clean(body?.period_end_date,80),
      lastUpdatedAt:clean(body?.last_updated_at,80),
      source:'Netlify account bandwidth meter',
    };
  }catch{
    return null;
  }
}

function estimateNetlifyCredits(rows:any[], bandwidth:any, schedules:any[]) {
  const fallbackWindow=billingCycleWindow();
  const cycleStart=bandwidth?.periodStart && Number.isFinite(Date.parse(bandwidth.periodStart))
    ? bandwidth.periodStart
    : fallbackWindow.start;
  const cycleEnd=bandwidth?.periodEnd && Number.isFinite(Date.parse(bandwidth.periodEnd))
    ? bandwidth.periodEnd
    : fallbackWindow.end;
  const startMs=Date.parse(cycleStart);
  const endMs=Date.parse(cycleEnd);
  const nowMs=Date.now();
  const rates=netlifyCreditRates();
  const monthlyAllowance=positiveNumber(Netlify.env.get('KOA_NETLIFY_MONTHLY_CREDIT_ALLOWANCE'),1000);

  const successful=(rows||[]).filter((row:any)=>{
    const published=Date.parse(String(row?.publishedAt||row?.createdAt||''));
    return row?.state==='ready' && Number.isFinite(published) && published>=startMs && published<endMs;
  });
  const deployCredits=successful.length*rates.productionDeploy;

  const bandwidthBytes=bandwidth?.usedBytes==null?null:Number(bandwidth.usedBytes);
  const bandwidthGb=bandwidthBytes==null?null:bandwidthBytes/1073741824;
  const bandwidthCredits=bandwidthGb==null?null:bandwidthGb*rates.bandwidthGb;

  const configuredRequests=Number(Netlify.env.get('KOA_NETLIFY_WEB_REQUESTS_ESTIMATE'));
  const averageBytesPerRequest=Math.max(1024,positiveNumber(Netlify.env.get('KOA_NETLIFY_AVG_BYTES_PER_REQUEST'),180*1024));
  const webRequests=Number.isFinite(configuredRequests)&&configuredRequests>=0
    ? configuredRequests
    : bandwidthBytes==null?null:Math.round(bandwidthBytes/averageBytesPerRequest);
  const webRequestCredits=webRequests==null?null:(webRequests/10000)*rates.webRequests10k;

  const configuredCompute=Number(Netlify.env.get('KOA_NETLIFY_FUNCTION_GB_HOURS_ESTIMATE'));
  const scheduleRunsDay=scheduledRunsPerDay(schedules);
  const elapsedDays=Math.max(0,(Math.min(nowMs,endMs)-startMs)/86400000);
  const scheduledInvocations=Math.max(0,Math.round(scheduleRunsDay*elapsedDays));
  const scheduledAverageMs=Math.max(1,positiveNumber(Netlify.env.get('KOA_NETLIFY_SCHEDULED_FUNCTION_AVG_MS'),1000));
  const functionRequestShare=Math.min(1,Math.max(0,positiveNumber(Netlify.env.get('KOA_NETLIFY_FUNCTION_REQUEST_SHARE'),0.05)));
  const functionAverageMs=Math.max(1,positiveNumber(Netlify.env.get('KOA_NETLIFY_FUNCTION_AVG_MS'),250));
  const memoryGb=Math.max(0.125,positiveNumber(Netlify.env.get('KOA_NETLIFY_FUNCTION_MEMORY_GB'),1));
  const estimatedOnDemandInvocations=webRequests==null?0:Math.round(webRequests*functionRequestShare);
  const estimatedRuntimeMs=scheduledInvocations*scheduledAverageMs+estimatedOnDemandInvocations*functionAverageMs;
  const computeGbHours=Number.isFinite(configuredCompute)&&configuredCompute>=0
    ? configuredCompute
    : (estimatedRuntimeMs/3600000)*memoryGb;
  const computeCredits=computeGbHours*rates.computeGbHour;

  const components=[
    {id:'deploys',label:'Production deploys',usage:successful.length,unit:'deploys',credits:deployCredits,mode:'measured'},
    {id:'compute',label:'Functions compute',usage:computeGbHours,unit:'GB-hour',credits:computeCredits,mode:Number.isFinite(configuredCompute)&&configuredCompute>=0?'configured':'estimated'},
    {id:'bandwidth',label:'Bandwidth',usage:bandwidthGb,unit:'GB',credits:bandwidthCredits,mode:bandwidthGb==null?'unavailable':'measured'},
    {id:'requests',label:'Web requests',usage:webRequests,unit:'requests',credits:webRequestCredits,mode:Number.isFinite(configuredRequests)&&configuredRequests>=0?'configured':webRequests==null?'unavailable':'estimated'},
  ];
  const knownCredits=components.reduce((sum,item)=>sum+(Number.isFinite(Number(item.credits))?Number(item.credits):0),0);
  const totalCredits=Math.round(knownCredits*100)/100;
  const percent=monthlyAllowance?Math.round((totalCredits/monthlyAllowance)*1000)/10:null;
  const remaining=monthlyAllowance?Math.max(0,Math.round((monthlyAllowance-totalCredits)*100)/100):null;

  return {
    version:2,
    basis:'Measured deploys + measured bandwidth + modeled compute and request usage',
    cycleStart,
    cycleEnd,
    productionDeploys:successful.length,
    monthlyAllowance,
    totalEstimatedCredits:totalCredits,
    estimatedAllowancePercent:percent,
    estimatedRemainingCredits:remaining,
    severity:creditSeverity(percent),
    rates,
    components:components.map(item=>({
      ...item,
      usage:item.usage==null?null:Math.round(Number(item.usage)*1000)/1000,
      credits:item.credits==null?null:Math.round(Number(item.credits)*100)/100,
    })),
    assumptions:{
      averageBytesPerRequest:Math.round(averageBytesPerRequest),
      functionRequestShare:Math.round(functionRequestShare*1000)/10,
      functionAverageMs:Math.round(functionAverageMs),
      scheduledFunctionAverageMs:Math.round(scheduledAverageMs),
      functionMemoryGb:Math.round(memoryGb*1000)/1000,
      scheduledRunsPerDay:scheduleRunsDay,
      scheduledInvocations,
      bandwidthLastUpdatedAt:bandwidth?.lastUpdatedAt||'',
    },
    thresholds:{yellow:60,orange:80,red:90},
    note:'Deploys and bandwidth use Netlify data. Compute and web requests are estimates unless configured overrides are supplied; compare against Netlify Usage & billing for the invoice-grade total.',
  };
}

export async function cachedDeploymentHistory(context:Context) {
  const store=healthStore(context);
  const cached:any=await store.get('deployments/cache',{type:'json'});
  if(cached?.creditUsage?.version===2 && Date.now()-Date.parse(String(cached.generatedAt||''))<10*60*1000) return cached;

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
    functionSchedules:[],
  };

  const netlifyToken=clean(Netlify.env.get('NETLIFY_AUTH_TOKEN'),500);
  let netlifyDeployHistory:any[]=[];
  if(netlifyToken){
    try{
      const siteId=clean((context as any)?.site?.id || Netlify.env.get('SITE_ID') || 'd1f3ab06-be2a-41c4-b770-59e6a6acd1b9',120);
      const collected:any[]=[];
      for(let page=1;page<=5;page+=1){
        const response=await fetch('https://api.netlify.com/api/v1/sites/'+encodeURIComponent(siteId)+'/deploys?per_page=100&page='+page,{
          headers:{Authorization:'Bearer '+netlifyToken,'User-Agent':'KoaEvents-Health/1.0'},
          signal:AbortSignal.timeout(12_000),
        });
        if(!response.ok) break;
        const rows:any[]=await response.json();
        collected.push(...rows);
        if(rows.length<100) break;
      }
      netlifyDeployHistory=collected
        .filter((row:any)=>clean(row?.context,40)==='production')
        .map((row:any)=>({
          deployId:clean(row?.id,120),
          commit:clean(row?.commit_ref,80),
          state:clean(row?.state,40),
          title:clean(row?.title,300),
          createdAt:clean(row?.created_at,80),
          publishedAt:clean(row?.published_at,80),
          deployTime:Number.isFinite(Number(row?.deploy_time))?Number(row.deploy_time):null,
          errorMessage:clean(row?.error_message || row?.summary?.messages?.find?.((message:any)=>message?.type==='error')?.description,1000),
        }));
    }catch{}
  }
  if(current.deployId && netlifyToken){
    try{
      const response=await fetch('https://api.netlify.com/api/v1/deploys/'+encodeURIComponent(current.deployId),{
        headers:{Authorization:'Bearer '+netlifyToken,'User-Agent':'KoaEvents-Health/1.0'},
        signal:AbortSignal.timeout(12_000),
      });
      if(response.ok){
        const deploy:any=await response.json();
        current.deployTime=clean(deploy?.published_at||deploy?.updated_at||deploy?.created_at,80)||current.deployTime;
        const availableFunctions=Array.isArray(deploy?.available_functions)?deploy.available_functions:[];
        if(availableFunctions.length) current.functionCount=availableFunctions.length;
        current.functionSchedules=Array.isArray(deploy?.function_schedules)?deploy.function_schedules:[];
      }
    }catch{}
  }

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
  const failedDeployGroups=groupConsecutiveDeployFailures(netlifyDeployHistory);
  const deploymentHealthy=Boolean(
    current.commit &&
    current.deployId &&
    current.behindMain===false &&
    lastSuccessfulQa &&
    lastSuccessfulQa.commit===current.commit
  );
  const postDeployVerification=await readPostDeployVerification(context);
  const bandwidthUsage=await fetchNetlifyBandwidthUsage(netlifyToken);
  const creditUsage=estimateNetlifyCredits(netlifyDeployHistory,bandwidthUsage,current.functionSchedules||[]);
  const result={
    generatedAt:new Date().toISOString(),
    current,
    deploymentHealthy,
    postDeployVerification,
    lastSuccessfulDeployment:current,
    lastSuccessfulQa,
    latestQaForCurrentDeploy,
    failedBuilds,
    failedDeployGroups,
    netlifyDeployHistory,
    creditUsage,
    history,
  };
  await store.setJSON('deployments/cache',result);
  return result;
}
