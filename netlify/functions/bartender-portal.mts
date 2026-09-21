import type { Config, Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';

function storeFor(context:Context){
  return context.deploy.context==='production'
    ? getStore({name:'koa-sales',consistency:'strong'})
    : getDeployStore({name:'koa-sales'});
}
function clean(value:unknown,max=1200){return String(value??'').trim().slice(0,max);}
function num(value:unknown,min=0,max=100000){const n=Number(value);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):0;}
function isMobile(record:any){
  const id=clean(record?.packageId||record?.quote?.state?.startingPoint||record?.inquiry?.mobileBarPackage,80).toLowerCase();
  return id.startsWith('mobile-')||clean(record?.inquiry?.service,80).toLowerCase()==='mobile-bar';
}
function eventDate(record:any){return clean(record?.customer?.eventDate,20);}
function packageLabel(id:string){
  return ({'mobile-oahu':'Oahu','mobile-maui':'Maui','mobile-big-island':'Big Island','mobile-custom':'Custom'} as Record<string,string>)[id]||id||'Mobile Bar';
}
function activeAssignment(record:any,bartenderId:string){
  return (Array.isArray(record?.booking?.bartenderAssignments)?record.booking.bartenderAssignments:[])
    .find((entry:any)=>clean(entry?.id,80)===bartenderId);
}
function timecard(record:any,bartenderId:string){
  return (Array.isArray(record?.booking?.bartenderTimecards)?record.booking.bartenderTimecards:[])
    .find((entry:any)=>clean(entry?.bartenderId,80)===bartenderId);
}
function performance(record:any,bartenderId:string){
  return (Array.isArray(record?.booking?.bartenderPerformance)?record.booking.bartenderPerformance:[])
    .find((entry:any)=>clean(entry?.bartenderId,80)===bartenderId);
}
function hawaiiDateKey(now=new Date()){
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Pacific/Honolulu',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
function payForShift(record:any,bartender:any){
  const card=timecard(record,bartender.id);
  const perf=performance(record,bartender.id);
  const hours=card?.totalMinutes>0?card.totalMinutes/60:num(perf?.actualHours||0,0,24);
  const tips=num(perf?.tips||0,0,100000);
  const wages=Math.round(hours*num(bartender.hourlyRate||0,0,500)*100)/100;
  return {hours:Math.round(hours*100)/100,tips,wages,total:Math.round((wages+tips)*100)/100};
}
function publicShift(record:any,bartender:any){
  const assignment=activeAssignment(record,bartender.id);
  const card=timecard(record,bartender.id);
  const pay=payForShift(record,bartender);
  return {
    recordId:record.id,
    eventDate:eventDate(record),
    clientName:clean(record?.customer?.name,180),
    packageId:clean(record?.packageId||record?.inquiry?.mobileBarPackage,80),
    packageName:packageLabel(clean(record?.packageId||record?.inquiry?.mobileBarPackage,80)),
    eventType:clean(record?.inquiry?.eventType,120),
    guestCount:Math.round(num(record?.inquiry?.guestCount,0,5000)),
    serviceHours:num(record?.inquiry?.serviceHours,0,24),
    responseStatus:clean(assignment?.responseStatus||'pending',30),
    respondedAt:clean(assignment?.respondedAt,60),
    clockInAt:clean(card?.clockInAt,60),
    clockOutAt:clean(card?.clockOutAt,60),
    totalMinutes:Math.round(num(card?.totalMinutes,0,24*60)),
    clockedIn:Boolean(card?.clockInAt&&!card?.clockOutAt),
    pay,
  };
}
async function persistRecord(store:any,record:any,records:any[]){
  const next=records.map((entry:any)=>entry.id===record.id?record:entry);
  await store.setJSON('records/'+record.id,record);
  await store.setJSON('records/index',next.slice(0,1500));
  return next;
}
function upsertPerformanceHours(record:any,bartender:any,hours:number,now:string){
  record.booking ||= {};
  const rows=Array.isArray(record.booking.bartenderPerformance)?record.booking.bartenderPerformance:[];
  const current=rows.find((entry:any)=>clean(entry?.bartenderId,80)===bartender.id)||{};
  const next={
    bartenderId:bartender.id,
    name:bartender.name,
    actualHours:Math.round(hours*100)/100,
    tips:num(current.tips||0,0,100000),
    reliability:clean(current.reliability||'not-rated',30),
    clientRating:num(current.clientRating||0,0,5),
    clientFeedback:clean(current.clientFeedback,1000),
    updatedAt:now,
    updatedBy:'bartender-portal',
  };
  record.booking.bartenderPerformance=[...rows.filter((entry:any)=>clean(entry?.bartenderId,80)!==bartender.id),next];
}
export default async(req:Request,context:Context)=>{
  const token=clean(context.params.token,120);
  if(!token||token.length<20)return Response.json({error:'Invalid bartender portal link.'},{status:400});
  const store=storeFor(context);
  let records=((await store.get('records/index',{type:'json'}))||[]) as any[];
  const settings=((await store.get('settings/mobile-bar-profitability',{type:'json'}))||{}) as any;
  const bartenders=Array.isArray(settings?.staffing?.bartenders)?settings.staffing.bartenders:[];
  const bartender=bartenders.find((entry:any)=>clean(entry?.portalToken,120)===token);
  if(!bartender)return Response.json({error:'Bartender portal not found.'},{status:404});

  const assigned=records.filter((record:any)=>record?.stage==='booked'&&isMobile(record)&&activeAssignment(record,bartender.id));
  const shifts=assigned.map((record:any)=>publicShift(record,bartender)).sort((a:any,b:any)=>String(a.eventDate).localeCompare(String(b.eventDate)));
  const payroll=shifts.reduce((acc:any,shift:any)=>({
    hours:acc.hours+shift.pay.hours,
    wages:acc.wages+shift.pay.wages,
    tips:acc.tips+shift.pay.tips,
    total:acc.total+shift.pay.total,
  }),{hours:0,wages:0,tips:0,total:0});
  Object.keys(payroll).forEach((key)=>payroll[key]=Math.round(payroll[key]*100)/100);

  if(req.method==='GET'){
    return Response.json({
      bartender:{
        id:bartender.id,
        name:bartender.name,
        hourlyRate:num(bartender.hourlyRate||0,0,500),
        unavailableDates:Array.isArray(bartender.unavailableDates)?bartender.unavailableDates:[],
      },
      shifts,
      payroll,
    },{headers:{'Cache-Control':'private, no-store'}});
  }
  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  const body:any=await req.json().catch(()=>null);
  const action=clean(body?.action,60);
  const now=new Date().toISOString();

  if(action==='save-availability'){
    const dates=Array.from(new Set((Array.isArray(body?.unavailableDates)?body.unavailableDates:[])
      .map((value:any)=>clean(value,20))
      .filter((value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)))).sort().slice(0,366);
    bartender.unavailableDates=dates;
    settings.staffing ||= {};
    settings.staffing.bartenders=bartenders;
    settings.updatedAt=now;
    await store.setJSON('settings/mobile-bar-profitability',settings);
    return Response.json({ok:true,unavailableDates:dates});
  }

  const record=records.find((entry:any)=>entry.id===clean(body?.recordId,80)&&entry.stage==='booked'&&isMobile(entry)&&activeAssignment(entry,bartender.id));
  if(!record)return Response.json({error:'Assigned Mobile Bar shift not found.'},{status:404});
  record.booking ||= {};
  const assignments=Array.isArray(record.booking.bartenderAssignments)?record.booking.bartenderAssignments:[];

  if(action==='respond-shift'){
    const response=clean(body?.response,20);
    if(!['confirmed','declined'].includes(response))return Response.json({error:'Invalid shift response.'},{status:400});
    if(response==='declined'){
      record.booking.bartenderAssignments=assignments.filter((entry:any)=>clean(entry?.id,80)!==bartender.id);
    }else{
      const assignment=assignments.find((entry:any)=>clean(entry?.id,80)===bartender.id);
      assignment.responseStatus='confirmed';
      assignment.respondedAt=now;
    }
    record.booking.updatedAt=now;record.updatedAt=now;
    records=await persistRecord(store,record,records);
    return Response.json({ok:true,response});
  }

  if(action==='clock-in'){
    const assignment=activeAssignment(record,bartender.id);
    if(assignment?.responseStatus==='declined')return Response.json({error:'Declined shifts cannot be clocked in.'},{status:409});
    if(eventDate(record)!==hawaiiDateKey())return Response.json({error:'Clock-in is available on the assigned event date in Hawaiʻi time.'},{status:409});
    const cards=Array.isArray(record.booking.bartenderTimecards)?record.booking.bartenderTimecards:[];
    const existing=cards.find((entry:any)=>clean(entry?.bartenderId,80)===bartender.id);
    if(existing?.clockInAt&&!existing?.clockOutAt)return Response.json({error:'Already clocked in.'},{status:409});
    const next={bartenderId:bartender.id,name:bartender.name,clockInAt:now,clockOutAt:'',totalMinutes:0,updatedAt:now};
    record.booking.bartenderTimecards=[...cards.filter((entry:any)=>clean(entry?.bartenderId,80)!==bartender.id),next];
    record.booking.updatedAt=now;record.updatedAt=now;
    records=await persistRecord(store,record,records);
    return Response.json({ok:true,shift:publicShift(record,bartender)});
  }

  if(action==='clock-out'){
    const cards=Array.isArray(record.booking.bartenderTimecards)?record.booking.bartenderTimecards:[];
    const existing=cards.find((entry:any)=>clean(entry?.bartenderId,80)===bartender.id);
    if(!existing?.clockInAt||existing?.clockOutAt)return Response.json({error:'No active clock-in found.'},{status:409});
    const start=Date.parse(existing.clockInAt);
    const end=Date.parse(now);
    const minutes=Math.max(0,Math.min(24*60,Math.round((end-start)/60000)));
    existing.clockOutAt=now;existing.totalMinutes=minutes;existing.updatedAt=now;
    upsertPerformanceHours(record,bartender,minutes/60,now);
    record.booking.updatedAt=now;record.updatedAt=now;
    records=await persistRecord(store,record,records);
    return Response.json({ok:true,shift:publicShift(record,bartender)});
  }

  return Response.json({error:'Unknown bartender portal action.'},{status:400});
};
export const config:Config={path:'/api/bartender/:token'};
