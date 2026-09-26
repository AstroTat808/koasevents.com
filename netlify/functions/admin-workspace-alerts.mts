import type { Config, Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { hasCapability, requireOperations } from './_shared/admin';
import { buildQuickBooksAccountingAudit } from './admin-quickbooks.mts';
import { masterInsuranceForEvent, todayHst } from './_shared/vendor-insurance-sync.ts';
import { inspectDeploymentSync, readLatestHealth } from './_shared/system-health';
import { readCredentialHealthSummary } from './_shared/credential-health';
import { credentialWorkspaceAlert } from './_shared/workspace-alert-lifecycle';

type Severity='urgent'|'upcoming'|'info';
type AlertCategory='overdueTasks'|'vendorInsurance'|'accountingMismatches'|'healthWarnings';
type AlertDetail={
  id:string;
  category:AlertCategory;
  severity:Severity;
  title:string;
  context:string;
  detail:string;
  href:string;
};
type SeverityChange={at:string;from:Severity;to:Severity};
type LifecycleRecord=AlertDetail&{
  occurrenceId:string;
  firstAppearedAt:string;
  lastSeenAt:string;
  severityChanges:SeverityChange[];
  resolvedAt?:string;
};
type UserAlertState={
  seen:Record<string,string>;
  snoozes:Record<string,{until:string;createdAt:string}>;
  dismissed:Record<string,{dismissedAt:string}>;
  updatedAt:string;
};

const CATEGORY_CAPABILITY:Record<AlertCategory,any>={
  overdueTasks:'crm.view',
  vendorInsurance:'insurance.view',
  accountingMismatches:'quickbooks.view',
  healthWarnings:'health.view',
};

function store(context:Context,name:string){
  return context.deploy.context==='production'
    ? getStore({name,consistency:'strong'})
    : getDeployStore({name});
}
function alertStore(context:Context){return store(context,'koa-workspace-alerts');}

function dateKey(value:unknown){
  const raw=String(value||'').trim().slice(0,10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw)?raw:'';
}
function daysBetween(from:string,to:string){
  const a=Date.parse(from+'T00:00:00Z');
  const b=Date.parse(to+'T00:00:00Z');
  return Number.isFinite(a)&&Number.isFinite(b)?Math.round((b-a)/86400000):0;
}
function clip(value:unknown,max=180){return String(value||'').trim().slice(0,max);}
function userKey(user:any){
  return clip(user?.id||user?.email||'staff',180).replace(/[^a-zA-Z0-9._-]/g,'_');
}
function canViewCategory(user:any,category:AlertCategory){
  return hasCapability(user,CATEGORY_CAPABILITY[category]);
}
function occurrenceId(){
  return 'ALT-'+crypto.randomUUID().replaceAll('-','').slice(0,18).toUpperCase();
}
function addDays(date:string,days:number){
  const ms=Date.parse(date+'T12:00:00Z');
  return new Date(ms+days*86400000).toISOString().slice(0,10);
}
function snoozeUntil(payload:any){
  const preset=clip(payload?.preset,20);
  if(preset==='tomorrow')return addDays(todayHst(),1)+'T08:00:00-10:00';
  if(preset==='week')return addDays(todayHst(),7)+'T08:00:00-10:00';
  const custom=dateKey(payload?.date);
  return custom?custom+'T08:00:00-10:00':'';
}
function cleanUserState(value:any):UserAlertState{
  const seen=value?.seen&&typeof value.seen==='object'?value.seen:{};
  const snoozes=value?.snoozes&&typeof value.snoozes==='object'?value.snoozes:{};
  const dismissed=value?.dismissed&&typeof value.dismissed==='object'?value.dismissed:{};
  return {seen,snoozes,dismissed,updatedAt:clip(value?.updatedAt,80)};
}

async function readUserState(context:Context,user:any){
  const value=await alertStore(context).get('users/'+userKey(user),{type:'json'});
  return cleanUserState(value);
}
async function saveUserState(context:Context,user:any,state:UserAlertState){
  state.updatedAt=new Date().toISOString();
  await alertStore(context).setJSON('users/'+userKey(user),state);
}

async function computeAlerts(context:Context,user:any){
  const canCrm=hasCapability(user,'crm.view');
  const canInsurance=hasCapability(user,'insurance.view');
  const canQuickBooks=hasCapability(user,'quickbooks.view');
  const canHealth=hasCapability(user,'health.view');
  const today=todayHst();

  const crm=store(context,'koa-crm');
  const sales=store(context,'koa-sales');
  const vendorsStore=store(context,'koa-vendors');
  const ops=store(context,'koa-event-ops');

  const [tasksRaw,recordsRaw,vendorsRaw,latestHealth,deploymentSync,credentialHealth]=await Promise.all([
    canCrm?crm.get('tasks/index',{type:'json'}):Promise.resolve([]),
    (canInsurance||canQuickBooks||canCrm)?sales.get('records/index',{type:'json'}):Promise.resolve([]),
    canInsurance?vendorsStore.get('vendors/index',{type:'json'}):Promise.resolve([]),
    canHealth?readLatestHealth(context):Promise.resolve(null),
    canHealth?inspectDeploymentSync(context):Promise.resolve(null),
    canHealth?readCredentialHealthSummary(context):Promise.resolve(null),
  ]);

  const tasks:Array<any>=Array.isArray(tasksRaw)?tasksRaw:[];
  const records:Array<any>=Array.isArray(recordsRaw)?recordsRaw:[];
  const vendors:Array<any>=Array.isArray(vendorsRaw)?vendorsRaw:[];
  const recordById=new Map(records.map((record:any)=>[String(record?.id||''),record]));

  const overdueTaskDetails:AlertDetail[]=canCrm
    ? tasks.filter((task:any)=>{
        const due=dateKey(task?.dueDate);
        return task?.status==='open'&&Boolean(due)&&due<today;
      }).map((task:any)=>{
        const due=dateKey(task?.dueDate);
        const overdueDays=Math.max(1,daysBetween(due,today));
        const record=recordById.get(String(task?.recordId||'')) as any;
        const customer=clip(record?.customer?.name||task?.recordId||'CRM client');
        const urgent=String(task?.priority||'').toLowerCase()==='high'||overdueDays>=3;
        return {
          id:'task:'+clip(task?.id||task?.recordId,100),
          category:'overdueTasks',
          severity:urgent?'urgent':'upcoming',
          title:clip(task?.title||'Overdue CRM task'),
          context:customer,
          detail:overdueDays+' day'+(overdueDays===1?'':'s')+' overdue · due '+due,
          href:'/admin/crm/?q='+encodeURIComponent(String(task?.recordId||customer)),
        } as AlertDetail;
      })
    : [];

  const insuranceDetails:AlertDetail[]=[];
  if(canInsurance){
    const vendorById=new Map(vendors.map((vendor:any)=>[String(vendor?.id||''),vendor]));
    const upcoming=records.filter((record:any)=>{
      const eventDate=dateKey(record?.customer?.eventDate);
      return record?.stage==='booked'&&record?.kind==='proposal'&&Boolean(eventDate)&&eventDate>=today;
    });
    const eventRows=await Promise.all(upcoming.map(async(record:any)=>({
      record,
      event:(await ops.get('events/'+record.id,{type:'json'}))||{},
    })));
    for(const {record,event} of eventRows){
      const eventDate=dateKey(record?.customer?.eventDate);
      const daysToEvent=Math.max(0,daysBetween(today,eventDate));
      for(const assignment of Array.isArray(event?.vendors)?event.vendors:[]){
        const vendorId=String(assignment?.marketplaceVendorId||'');
        const vendor=vendorById.get(vendorId) as any;
        if(!vendor)continue;
        const result=masterInsuranceForEvent(vendor,eventDate);
        if(result.covered)continue;
        const immediateIssue=['rejected','expired','expires_before_event','missing_certificate','missing_expiration'].includes(String(result.issue||''));
        const severity:Severity=immediateIssue&&daysToEvent<=30?'urgent':'upcoming';
        insuranceDetails.push({
          id:'insurance:'+vendorId+':'+String(record.id),
          category:'vendorInsurance',
          severity,
          title:clip(vendor?.name||assignment?.name||'Vendor')+' · insurance '+clip(result.issue||result.status,80).replaceAll('_',' '),
          context:clip(record?.customer?.name||record?.id||'Upcoming event'),
          detail:'Event '+eventDate+(daysToEvent===0?' · today':' · '+daysToEvent+' days away'),
          href:'/admin/insurance/',
        });
      }
    }
  }

  const accounting=canQuickBooks?buildQuickBooksAccountingAudit(records):null;
  const accountingDetails:AlertDetail[]=canQuickBooks
    ? (Array.isArray(accounting?.rows)?accounting.rows:[])
        .filter((row:any)=>!row?.reconciled)
        .map((row:any)=>{
          const issues=Array.isArray(row?.issues)?row.issues:[];
          const urgent=issues.some((issue:any)=>['estimate_missing','stored_balance','allocation_total'].includes(String(issue?.code||'')));
          return {
            id:'accounting:'+clip(row?.recordId,100),
            category:'accountingMismatches',
            severity:urgent?'urgent':'info',
            title:clip(row?.clientName||row?.recordId||'Client')+' · '+issues.length+' accounting '+(issues.length===1?'issue':'issues'),
            context:dateKey(row?.eventDate)?'Event '+dateKey(row?.eventDate):'QuickBooks reconciliation',
            detail:issues.slice(0,2).map((issue:any)=>clip(issue?.label,100)).join(' · ')+(issues.length>2?' · +'+(issues.length-2)+' more':''),
            href:'/admin/quickbooks/#accounting-audit',
          } as AlertDetail;
        })
    : [];

  const healthDetails:AlertDetail[]=canHealth&&latestHealth
    ? (Array.isArray(latestHealth?.checks)?latestHealth.checks:[])
        .filter((check:any)=>{
          const checkId=String(check?.id||'');
          if(credentialHealth&&['email-send-access','email-monitoring-access'].includes(checkId))return false;
          if(checkId==='netlify-github-sync'){
            return Boolean(deploymentSync && (deploymentSync.severity==='yellow' || deploymentSync.severity==='red'));
          }
          return !check?.ok || String(check?.severity||'')==='yellow';
        })
        .map((check:any)=>{
          const isDeploySync=String(check?.id||'')==='netlify-github-sync';
          const releaseMeta=[
            (isDeploySync?deploymentSync?.deployId:latestHealth?.deployId)?'Deploy '+clip(isDeploySync?deploymentSync?.deployId:latestHealth?.deployId,40):'',
            (isDeploySync?deploymentSync?.liveCommit:latestHealth?.commit)?'Commit '+clip(isDeploySync?deploymentSync?.liveCommit:latestHealth?.commit,12):'',
          ].filter(Boolean).join(' · ');
          const liveSeverity=isDeploySync?String(deploymentSync?.severity||''):String(check?.severity||'');
          const severity:Severity=liveSeverity==='yellow'?'upcoming':'urgent';
          const sourceDetail=isDeploySync?deploymentSync?.detail:check?.detail;
          const baseDetail=clip(sourceDetail||('Status '+String(check?.status||'unknown')),170);
          return {
            id:'health:'+clip(check?.id,100),
            category:'healthWarnings' as AlertCategory,
            severity,
            title:clip(check?.name||check?.id||'System health failure'),
            context:releaseMeta||clip(check?.kind||'Protected service').replaceAll('_',' '),
            detail:clip(baseDetail+(releaseMeta?' · '+releaseMeta:''),220),
            href:'/admin/health/',
          } as AlertDetail;
        })
    : [];

  const credentialDetails:AlertDetail[]=canHealth&&credentialHealth
    ? (Array.isArray(credentialHealth?.rows)?credentialHealth.rows:[])
        .filter((row:any)=>!row?.ok)
        .map((row:any)=>credentialWorkspaceAlert(row) as AlertDetail)
    : [];

  return {
    overdueTasks:overdueTaskDetails,
    vendorInsurance:insuranceDetails,
    accountingMismatches:accountingDetails,
    healthWarnings:[...credentialDetails,...healthDetails],
  } as Record<AlertCategory,AlertDetail[]>;
}

async function reconcileLifecycle(context:Context,user:any,currentByCategory:Record<AlertCategory,AlertDetail[]>){
  const alerts=alertStore(context);
  const now=new Date().toISOString();
  const saved:any=(await alerts.get('lifecycle/state',{type:'json'}))||{active:{}};
  const active:Record<string,LifecycleRecord>=saved?.active&&typeof saved.active==='object'?saved.active:{};
  const historyRaw:any=await alerts.get('lifecycle/history',{type:'json'});
  const history:LifecycleRecord[]=Array.isArray(historyRaw)?historyRaw:[];

  for(const category of Object.keys(CATEGORY_CAPABILITY) as AlertCategory[]){
    if(!canViewCategory(user,category))continue;
    const current=currentByCategory[category]||[];
    const currentIds=new Set(current.map(alert=>alert.id));

    for(const alert of current){
      const previous=active[alert.id];
      if(!previous){
        active[alert.id]={
          ...alert,
          occurrenceId:occurrenceId(),
          firstAppearedAt:now,
          lastSeenAt:now,
          severityChanges:[],
        };
        continue;
      }
      const changes=[...(Array.isArray(previous.severityChanges)?previous.severityChanges:[])];
      if(previous.severity!==alert.severity){
        changes.unshift({at:now,from:previous.severity,to:alert.severity});
      }
      active[alert.id]={
        ...previous,
        ...alert,
        lastSeenAt:now,
        severityChanges:changes.slice(0,30),
      };
    }

    for(const [baseId,record] of Object.entries(active)){
      if(record.category!==category||currentIds.has(baseId))continue;
      history.unshift({...record,resolvedAt:now});
      delete active[baseId];
    }
  }

  await Promise.all([
    alerts.setJSON('lifecycle/state',{active,updatedAt:now}),
    alerts.setJSON('lifecycle/history',history.slice(0,1000)),
  ]);

  return {active,history:history.slice(0,1000)};
}

function visibleHistory(user:any,active:Record<string,LifecycleRecord>,history:LifecycleRecord[]){
  const rows=[
    ...Object.values(active).map(record=>({...record,status:'active'})),
    ...history.map(record=>({...record,status:'resolved'})),
  ].filter((record:any)=>canViewCategory(user,record.category));
  return rows.sort((a:any,b:any)=>Date.parse(b.resolvedAt||b.lastSeenAt||b.firstAppearedAt)-Date.parse(a.resolvedAt||a.lastSeenAt||a.firstAppearedAt)).slice(0,150);
}

export default async(req:Request,context:Context)=>{
  const auth=await requireOperations(req);
  if(auth.response)return auth.response;
  const user=auth.user;

  if(req.method==='POST'){
    const body:any=await req.json().catch(()=>({}));
    const action=clip(body?.action,40);
    const state=await readUserState(context,user);
    const lifecycle:any=(await alertStore(context).get('lifecycle/state',{type:'json'}))||{active:{}};
    const active:Record<string,LifecycleRecord>=lifecycle?.active&&typeof lifecycle.active==='object'?lifecycle.active:{};
    const activeByOccurrence=new Map(Object.values(active).map((record:any)=>[record.occurrenceId,record]));

    if(action==='mark-seen'){
      const ids=[...new Set((Array.isArray(body?.occurrenceIds)?body.occurrenceIds:[]).map((id:any)=>clip(id,80)).filter(Boolean))].slice(0,150);
      const now=new Date().toISOString();
      for(const id of ids){
        const record=activeByOccurrence.get(id);
        if(record&&canViewCategory(user,record.category))state.seen[id]=state.seen[id]||now;
      }
      await saveUserState(context,user,state);
      return Response.json({ok:true,seen:ids.length},{headers:{'Cache-Control':'private, no-store'}});
    }

    if(action==='snooze'){
      const id=clip(body?.occurrenceId,80);
      const record=activeByOccurrence.get(id);
      if(!record||!canViewCategory(user,record.category))return Response.json({error:'Alert is no longer active.'},{status:404});
      const until=snoozeUntil(body);
      const untilMs=Date.parse(until);
      if(!until||!Number.isFinite(untilMs)||untilMs<=Date.now())return Response.json({error:'Choose a future snooze date.'},{status:400});
      if(untilMs>Date.now()+366*86400000)return Response.json({error:'Snooze date must be within one year.'},{status:400});
      state.snoozes[id]={until:new Date(untilMs).toISOString(),createdAt:new Date().toISOString()};
      state.seen[id]=state.seen[id]||new Date().toISOString();
      await saveUserState(context,user,state);
      return Response.json({ok:true,occurrenceId:id,until:state.snoozes[id].until},{headers:{'Cache-Control':'private, no-store'}});
    }

    if(action==='unsnooze'){
      const id=clip(body?.occurrenceId,80);
      delete state.snoozes[id];
      await saveUserState(context,user,state);
      return Response.json({ok:true,occurrenceId:id},{headers:{'Cache-Control':'private, no-store'}});
    }

    if(action==='dismiss'){
      const id=clip(body?.occurrenceId,80);
      const record=activeByOccurrence.get(id);
      if(!record||!canViewCategory(user,record.category))return Response.json({error:'Alert is no longer active.'},{status:404});
      const now=new Date().toISOString();
      state.dismissed[id]={dismissedAt:now};
      state.seen[id]=state.seen[id]||now;
      delete state.snoozes[id];
      await saveUserState(context,user,state);
      return Response.json({ok:true,occurrenceId:id},{headers:{'Cache-Control':'private, no-store'}});
    }

    if(action==='restore-dismissed'){
      const id=clip(body?.occurrenceId,80);
      delete state.dismissed[id];
      await saveUserState(context,user,state);
      return Response.json({ok:true,occurrenceId:id},{headers:{'Cache-Control':'private, no-store'}});
    }

    return Response.json({error:'Unknown alert action.'},{status:400});
  }

  if(req.method!=='GET')return new Response('Method not allowed',{status:405});

  const currentByCategory=await computeAlerts(context,user);
  const lifecycle=await reconcileLifecycle(context,user,currentByCategory);
  const state=await readUserState(context,user);
  const now=Date.now();

  for(const [id,snooze] of Object.entries(state.snoozes)){
    const until=Date.parse(String(snooze?.until||''));
    if(!Number.isFinite(until)||until<=now)delete state.snoozes[id];
  }
  const activeVisible=Object.values(lifecycle.active)
    .filter((record:any)=>canViewCategory(user,record.category))
    .map((record:any)=>({
      ...record,
      isNew:!state.seen[record.occurrenceId],
      seenAt:state.seen[record.occurrenceId]||'',
      snoozedUntil:state.snoozes[record.occurrenceId]?.until||'',
      dismissedAt:state.dismissed[record.occurrenceId]?.dismissedAt||'',
    }));

  const visibleAlerts=activeVisible.filter((record:any)=>!record.snoozedUntil&&!record.dismissedAt);
  const snoozedAlerts=activeVisible.filter((record:any)=>Boolean(record.snoozedUntil)&&!record.dismissedAt);
  const dismissedAlerts=activeVisible.filter((record:any)=>Boolean(record.dismissedAt));
  const severityOrder:Record<Severity,number>={urgent:0,upcoming:1,info:2};
  visibleAlerts.sort((a:any,b:any)=>{
    if(Boolean(a.isNew)!==Boolean(b.isNew))return a.isNew?-1:1;
    return severityOrder[a.severity as Severity]-severityOrder[b.severity as Severity];
  });

  const itemMeta:Record<AlertCategory,{label:string;href:string;capability:string}>={
    overdueTasks:{label:'Overdue tasks',href:'/admin/crm/',capability:'crm.view'},
    vendorInsurance:{label:'Vendor insurance problems',href:'/admin/insurance/',capability:'insurance.view'},
    accountingMismatches:{label:'Accounting mismatches',href:'/admin/quickbooks/#accounting-audit',capability:'quickbooks.view'},
    healthWarnings:{label:'System health warnings',href:'/admin/health/',capability:'health.view'},
  };
  const items:any={};
  for(const category of Object.keys(itemMeta) as AlertCategory[]){
    const alerts=visibleAlerts.filter((alert:any)=>alert.category===category);
    items[category]={...itemMeta[category],count:alerts.length,alerts:alerts.slice(0,50)};
  }
  const severityCounts={
    urgent:visibleAlerts.filter((alert:any)=>alert.severity==='urgent').length,
    upcoming:visibleAlerts.filter((alert:any)=>alert.severity==='upcoming').length,
    info:visibleAlerts.filter((alert:any)=>alert.severity==='info').length,
  };

  await saveUserState(context,user,state);

  return Response.json({
    generatedAt:new Date().toISOString(),
    total:visibleAlerts.length,
    newCount:visibleAlerts.filter((alert:any)=>alert.isNew).length,
    snoozedCount:snoozedAlerts.length,
    dismissedCount:dismissedAlerts.length,
    severityCounts,
    alerts:visibleAlerts.slice(0,100),
    snoozed:snoozedAlerts.slice(0,100),
    dismissed:dismissedAlerts.slice(0,100),
    history:visibleHistory(user,lifecycle.active,lifecycle.history),
    items,
  },{headers:{'Cache-Control':'private, no-store'}});
};

export const config:Config={path:'/api/admin/workspace-alerts'};
