import type { Config, Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { requireOperations } from './_shared/admin';

function storeFor(context:Context){
  return context.deploy.context==='production'
    ? getStore({name:'koa-sales',consistency:'strong'})
    : getDeployStore({name:'koa-sales'});
}
function clean(value:unknown,max=1200){return String(value??'').trim().slice(0,max);}
function num(value:unknown,min=0,max=100000){const n=Number(value);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):0;}
function eventDate(record:any){return clean(record?.customer?.eventDate,20);}
function isMobile(record:any){
  const id=clean(record?.packageId||record?.quote?.state?.startingPoint||record?.inquiry?.mobileBarPackage,80).toLowerCase();
  return id.startsWith('mobile-')||clean(record?.inquiry?.service,80).toLowerCase()==='mobile-bar';
}
function defaultRange(){
  const now=new Date();
  const start=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)).toISOString().slice(0,10);
  const end=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,0)).toISOString().slice(0,10);
  return {start,end};
}
function payrollEntry(record:any,bartender:any){
  const assignment=(record?.booking?.bartenderAssignments||[]).find((entry:any)=>entry.id===bartender.id);
  if(!assignment)return null;
  const card=(record?.booking?.bartenderTimecards||[]).find((entry:any)=>entry.bartenderId===bartender.id);
  const perf=(record?.booking?.bartenderPerformance||[]).find((entry:any)=>entry.bartenderId===bartender.id);
  const hours=card?.totalMinutes>0?card.totalMinutes/60:num(perf?.actualHours||0,0,24);
  const rate=num(bartender.hourlyRate||0,0,500);
  const wages=Math.round(hours*rate*100)/100;
  const tips=num(perf?.tips||0,0,100000);
  return {
    recordId:record.id,
    eventDate:eventDate(record),
    clientName:clean(record?.customer?.name,180),
    packageId:clean(record?.packageId||record?.inquiry?.mobileBarPackage,80),
    hours:Math.round(hours*100)/100,
    rate,
    wages,
    tips,
    total:Math.round((wages+tips)*100)/100,
    clockInAt:clean(card?.clockInAt,60),
    clockOutAt:clean(card?.clockOutAt,60),
    estimated:!card?.totalMinutes&&!perf?.actualHours,
  };
}
export default async(req:Request,context:Context)=>{
  const auth=await requireOperations();
  if(auth.response)return auth.response;
  if(req.method!=='GET')return new Response('Method not allowed',{status:405});

  const url=new URL(req.url);
  const fallback=defaultRange();
  const start=/^\d{4}-\d{2}-\d{2}$/.test(clean(url.searchParams.get('start'),20))?clean(url.searchParams.get('start'),20):fallback.start;
  const end=/^\d{4}-\d{2}-\d{2}$/.test(clean(url.searchParams.get('end'),20))?clean(url.searchParams.get('end'),20):fallback.end;
  const store=storeFor(context);
  const [recordsRaw,settings]=await Promise.all([
    store.get('records/index',{type:'json'}),
    store.get('settings/mobile-bar-profitability',{type:'json'}),
  ]);
  const records=(Array.isArray(recordsRaw)?recordsRaw:[]).filter((record:any)=>record?.stage==='booked'&&isMobile(record)&&eventDate(record)>=start&&eventDate(record)<=end);
  const bartenders=Array.isArray((settings as any)?.staffing?.bartenders)?(settings as any).staffing.bartenders:[];
  const rows=bartenders.map((bartender:any)=>{
    const events=records.map((record:any)=>payrollEntry(record,bartender)).filter(Boolean);
    const totals=events.reduce((acc:any,event:any)=>({
      hours:acc.hours+event.hours,
      wages:acc.wages+event.wages,
      tips:acc.tips+event.tips,
      total:acc.total+event.total,
      estimatedEvents:acc.estimatedEvents+(event.estimated?1:0),
    }),{hours:0,wages:0,tips:0,total:0,estimatedEvents:0});
    Object.keys(totals).forEach((key)=>{if(key!=='estimatedEvents')totals[key]=Math.round(totals[key]*100)/100;});
    return {
      bartenderId:bartender.id,
      name:bartender.name,
      hourlyRate:num(bartender.hourlyRate||0,0,500),
      events,
      totals,
    };
  }).filter((row:any)=>row.events.length||row.totals.total>0);

  const summary=rows.reduce((acc:any,row:any)=>({
    bartenders:acc.bartenders+1,
    hours:acc.hours+row.totals.hours,
    wages:acc.wages+row.totals.wages,
    tips:acc.tips+row.totals.tips,
    total:acc.total+row.totals.total,
  }),{bartenders:0,hours:0,wages:0,tips:0,total:0});
  Object.keys(summary).forEach((key)=>{if(key!=='bartenders')summary[key]=Math.round(summary[key]*100)/100;});

  return Response.json({start,end,summary,rows},{headers:{'Cache-Control':'private, no-store'}});
};
export const config:Config={path:'/api/admin/payroll'};
