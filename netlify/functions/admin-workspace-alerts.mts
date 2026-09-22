import type { Config, Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { hasCapability, requireOperations } from './_shared/admin';
import { buildQuickBooksAccountingAudit } from './admin-quickbooks.mts';
import { masterInsuranceForEvent, todayHst } from './_shared/vendor-insurance-sync.ts';
import { readLatestHealth } from './_shared/system-health';

type Severity='urgent'|'upcoming'|'info';
type AlertDetail={
  id:string;
  severity:Severity;
  title:string;
  context:string;
  detail:string;
  href:string;
};

function store(context:Context,name:string){
  return context.deploy.context==='production'
    ? getStore({name,consistency:'strong'})
    : getDeployStore({name});
}

function dateKey(value:unknown){
  const raw=String(value||'').trim().slice(0,10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw)?raw:'';
}

function daysBetween(from:string,to:string){
  const a=Date.parse(from+'T00:00:00Z');
  const b=Date.parse(to+'T00:00:00Z');
  return Number.isFinite(a)&&Number.isFinite(b)?Math.round((b-a)/86400000):0;
}

function clip(value:unknown,max=180){
  return String(value||'').trim().slice(0,max);
}

export default async(req:Request,context:Context)=>{
  const auth=await requireOperations(req);
  if(auth.response)return auth.response;
  if(req.method!=='GET')return new Response('Method not allowed',{status:405});

  const user=auth.user;
  const canCrm=hasCapability(user,'crm.view');
  const canInsurance=hasCapability(user,'insurance.view');
  const canQuickBooks=hasCapability(user,'quickbooks.view');
  const canHealth=hasCapability(user,'health.view');
  const today=todayHst();

  const crm=store(context,'koa-crm');
  const sales=store(context,'koa-sales');
  const vendorsStore=store(context,'koa-vendors');
  const ops=store(context,'koa-event-ops');

  const [tasksRaw,recordsRaw,vendorsRaw,latestHealth]=await Promise.all([
    canCrm?crm.get('tasks/index',{type:'json'}):Promise.resolve([]),
    (canInsurance||canQuickBooks||canCrm)?sales.get('records/index',{type:'json'}):Promise.resolve([]),
    canInsurance?vendorsStore.get('vendors/index',{type:'json'}):Promise.resolve([]),
    canHealth?readLatestHealth(context):Promise.resolve(null),
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
          severity:urgent?'urgent':'upcoming',
          title:clip(task?.title||'Overdue CRM task'),
          context:customer,
          detail:overdueDays+' day'+(overdueDays===1?'':'s')+' overdue · due '+due,
          href:'/admin/crm/?q='+encodeURIComponent(String(task?.recordId||customer)),
        } as AlertDetail;
      }).sort((a,b)=>a.severity===b.severity?0:(a.severity==='urgent'?-1:1))
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
          severity,
          title:clip(vendor?.name||assignment?.name||'Vendor')+' · insurance '+clip(result.issue||result.status,80).replaceAll('_',' '),
          context:clip(record?.customer?.name||record?.id||'Upcoming event'),
          detail:'Event '+eventDate+(daysToEvent===0?' · today':' · '+daysToEvent+' days away'),
          href:'/admin/insurance/',
        });
      }
    }
    insuranceDetails.sort((a,b)=>a.severity===b.severity?0:(a.severity==='urgent'?-1:1));
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
        .filter((check:any)=>!check?.ok)
        .map((check:any)=>({
          id:'health:'+clip(check?.id,100),
          severity:'urgent' as Severity,
          title:clip(check?.name||check?.id||'System health failure'),
          context:clip(check?.kind||'Protected service').replaceAll('_',' '),
          detail:clip(check?.detail||('Status '+String(check?.status||'unknown')),220),
          href:'/admin/health/',
        }))
    : [];

  const items={
    overdueTasks:{
      count:overdueTaskDetails.length,
      label:'Overdue tasks',
      href:'/admin/crm/',
      capability:'crm.view',
      alerts:overdueTaskDetails.slice(0,50),
    },
    vendorInsurance:{
      count:insuranceDetails.length,
      label:'Vendor insurance problems',
      href:'/admin/insurance/',
      capability:'insurance.view',
      alerts:insuranceDetails.slice(0,50),
    },
    accountingMismatches:{
      count:accountingDetails.length,
      label:'Accounting mismatches',
      href:'/admin/quickbooks/#accounting-audit',
      capability:'quickbooks.view',
      alerts:accountingDetails.slice(0,50),
    },
    healthWarnings:{
      count:healthDetails.length,
      label:'System health warnings',
      href:'/admin/health/',
      capability:'health.view',
      alerts:healthDetails.slice(0,50),
    },
  };

  const allAlerts=Object.values(items).flatMap((item:any)=>item.alerts||[]);
  const severityOrder:Record<Severity,number>={urgent:0,upcoming:1,info:2};
  allAlerts.sort((a:any,b:any)=>severityOrder[a.severity as Severity]-severityOrder[b.severity as Severity]);
  const severityCounts={
    urgent:allAlerts.filter((alert:any)=>alert.severity==='urgent').length,
    upcoming:allAlerts.filter((alert:any)=>alert.severity==='upcoming').length,
    info:allAlerts.filter((alert:any)=>alert.severity==='info').length,
  };

  return Response.json({
    generatedAt:new Date().toISOString(),
    total:allAlerts.length,
    severityCounts,
    alerts:allAlerts.slice(0,100),
    items,
  },{headers:{'Cache-Control':'private, no-store'}});
};

export const config:Config={path:'/api/admin/workspace-alerts'};
