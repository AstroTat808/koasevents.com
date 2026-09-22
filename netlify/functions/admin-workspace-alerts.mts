import type { Config, Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { hasCapability, requireOperations } from './_shared/admin';
import { buildQuickBooksAccountingAudit } from './admin-quickbooks.mts';
import { masterInsuranceForEvent, todayHst } from './_shared/vendor-insurance-sync.ts';
import { readLatestHealth } from './_shared/system-health';

function store(context:Context,name:string){
  return context.deploy.context==='production'
    ? getStore({name,consistency:'strong'})
    : getDeployStore({name});
}

function dateKey(value:unknown){
  const raw=String(value||'').trim().slice(0,10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw)?raw:'';
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
    (canInsurance||canQuickBooks)?sales.get('records/index',{type:'json'}):Promise.resolve([]),
    canInsurance?vendorsStore.get('vendors/index',{type:'json'}):Promise.resolve([]),
    canHealth?readLatestHealth(context):Promise.resolve(null),
  ]);

  const tasks:Array<any>=Array.isArray(tasksRaw)?tasksRaw:[];
  const records:Array<any>=Array.isArray(recordsRaw)?recordsRaw:[];
  const vendors:Array<any>=Array.isArray(vendorsRaw)?vendorsRaw:[];

  const overdueTasks=canCrm
    ? tasks.filter((task:any)=>{
        const due=dateKey(task?.dueDate);
        return task?.status==='open'&&Boolean(due)&&due<today;
      }).length
    : 0;

  let vendorInsurance=0;
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
      for(const assignment of Array.isArray(event?.vendors)?event.vendors:[]){
        const vendorId=String(assignment?.marketplaceVendorId||'');
        const vendor=vendorById.get(vendorId);
        if(!vendor)continue;
        if(!masterInsuranceForEvent(vendor,record?.customer?.eventDate).covered)vendorInsurance+=1;
      }
    }
  }

  const accounting=canQuickBooks?buildQuickBooksAccountingAudit(records):null;
  const accountingMismatches=canQuickBooks?Number(accounting?.flaggedCount||0):0;
  const healthWarnings=canHealth?Number(latestHealth?.failed||0):0;

  const items={
    overdueTasks:{
      count:overdueTasks,
      label:'Overdue tasks',
      href:'/admin/crm/',
      capability:'crm.view',
    },
    vendorInsurance:{
      count:vendorInsurance,
      label:'Vendor insurance problems',
      href:'/admin/insurance/',
      capability:'insurance.view',
    },
    accountingMismatches:{
      count:accountingMismatches,
      label:'Accounting mismatches',
      href:'/admin/quickbooks/#accounting-audit',
      capability:'quickbooks.view',
    },
    healthWarnings:{
      count:healthWarnings,
      label:'System health warnings',
      href:'/admin/health/',
      capability:'health.view',
    },
  };
  const total=Object.values(items).reduce((sum:number,item:any)=>sum+Number(item.count||0),0);

  return Response.json({
    generatedAt:new Date().toISOString(),
    total,
    items,
  },{headers:{'Cache-Control':'private, no-store'}});
};

export const config:Config={path:'/api/admin/workspace-alerts'};
