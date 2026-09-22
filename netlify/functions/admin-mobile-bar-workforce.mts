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
function dateList(value:unknown,limit=730){
  const raw=Array.isArray(value)?value:String(value||'').split(/[\s,]+/);
  return Array.from(new Set(raw.map((item:any)=>clean(item,20)).filter((item:string)=>/^\d{4}-\d{2}-\d{2}$/.test(item)))).sort().slice(0,limit);
}
function token(){
  const bytes=new Uint8Array(24);crypto.getRandomValues(bytes);
  return Array.from(bytes,(v)=>v.toString(36).slice(-1)).join('')+crypto.randomUUID().replaceAll('-','').slice(0,12);
}
function isMobile(record:any){
  const id=clean(record?.packageId||record?.quote?.state?.startingPoint||record?.inquiry?.mobileBarPackage,80).toLowerCase();
  return id.startsWith('mobile-')||clean(record?.inquiry?.service,80).toLowerCase()==='mobile-bar';
}
function eventDate(record:any){return clean(record?.customer?.eventDate,20);}
function normalizeBartenders(value:unknown,current:any[]=[]){
  if(!Array.isArray(value))return current;
  const currentById=new Map(current.map((row:any)=>[clean(row?.id,80),row]));
  return value.slice(0,60).map((entry:any,index:number)=>{
    const id=clean(entry?.id||('bartender-'+(index+1)),80)||('bartender-'+(index+1));
    const previous=currentById.get(id)||{};
    return {
      id,
      name:clean(entry?.name,120),
      active:entry?.active!==false,
      hourlyRate:Math.round(num(entry?.hourlyRate??previous.hourlyRate??40,0,500)*100)/100,
      maxEventsPerWeek:Math.round(num(entry?.maxEventsPerWeek??previous.maxEventsPerWeek??0,0,31)),
      maxEventsPerMonth:Math.round(num(entry?.maxEventsPerMonth??previous.maxEventsPerMonth??0,0,100)),
      unavailableDates:dateList(entry?.unavailableDates??previous.unavailableDates,366),
      portalToken:clean(previous?.portalToken||entry?.portalToken,120)||token(),
    };
  }).filter((row:any)=>row.name);
}
async function readState(context:Context){
  const store=storeFor(context);
  const [recordsRaw,settingsRaw]=await Promise.all([
    store.get('records/index',{type:'json'}),
    store.get('settings/mobile-bar-profitability',{type:'json'}),
  ]);
  const records=Array.isArray(recordsRaw)?recordsRaw as any[]:[];
  const settings:any=settingsRaw||{};
  settings.staffing ||= {blackoutDates:[],bartenders:[]};
  settings.staffing.blackoutDates=dateList(settings.staffing.blackoutDates,730);
  settings.staffing.bartenders=normalizeBartenders(settings.staffing.bartenders,settings.staffing.bartenders);
  const mobileBookings=records.filter((record:any)=>record?.stage==='booked'&&isMobile(record)).map((record:any)=>({
    recordId:record.id,
    clientName:clean(record?.customer?.name,180),
    eventDate:eventDate(record),
    packageId:clean(record?.packageId||record?.inquiry?.mobileBarPackage,80),
    guestCount:Math.round(num(record?.inquiry?.guestCount,0,5000)),
    assignments:Array.isArray(record?.booking?.bartenderAssignments)?record.booking.bartenderAssignments:[],
    performance:Array.isArray(record?.booking?.bartenderPerformance)?record.booking.bartenderPerformance:[],
  })).sort((a:any,b:any)=>String(a.eventDate).localeCompare(String(b.eventDate)));
  return {store,records,settings,mobileBookings};
}
async function saveRecord(store:any,records:any[],record:any){
  const next=records.map((row:any)=>row.id===record.id?record:row);
  await store.setJSON('records/'+record.id,record);
  await store.setJSON('records/index',next.slice(0,1500));
  return next;
}
export default async(req:Request,context:Context)=>{
  const auth=await requireOperations(req);if(auth.response)return auth.response;
  const state=await readState(context);
  if(req.method==='GET'){
    return Response.json({
      staffing:state.settings.staffing,
      bookings:state.mobileBookings,
    },{headers:{'Cache-Control':'private, no-store'}});
  }
  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  const body:any=await req.json().catch(()=>({}));
  const action=clean(body?.action,60);
  const now=new Date().toISOString();

  if(action==='save-roster'){
    state.settings.staffing={
      blackoutDates:dateList(body?.blackoutDates,730),
      bartenders:normalizeBartenders(body?.bartenders,state.settings.staffing.bartenders),
    };
    state.settings.updatedAt=now;
    await state.store.setJSON('settings/mobile-bar-profitability',state.settings);
    return Response.json({ok:true,staffing:state.settings.staffing});
  }

  const recordId=clean(body?.recordId,80);
  const record=state.records.find((row:any)=>row?.id===recordId&&row?.stage==='booked'&&isMobile(row));
  if(!record)return Response.json({error:'Booked Mobile Bar event not found.'},{status:404});
  record.booking ||= {};

  if(action==='assign-bartenders'){
    const ids=Array.from(new Set((Array.isArray(body?.bartenderIds)?body.bartenderIds:[]).map((id:any)=>clean(id,80)).filter(Boolean)));
    const roster=new Map(state.settings.staffing.bartenders.map((row:any)=>[row.id,row]));
    const warnings:string[]=[];
    const assignments=ids.map((id:string)=>{
      const bartender:any=roster.get(id);
      if(!bartender){warnings.push('Unknown bartender '+id+'.');return null;}
      if(!bartender.active)warnings.push(bartender.name+' is inactive.');
      if(bartender.unavailableDates.includes(eventDate(record)))warnings.push(bartender.name+' is unavailable on '+eventDate(record)+'.');
      const existing=(record.booking.bartenderAssignments||[]).find((row:any)=>row.id===id);
      return {
        id,
        name:bartender.name,
        assignedAt:existing?.assignedAt||now,
        assignedBy:existing?.assignedBy||clean(auth.user?.email,240)||'staff',
        responseStatus:existing?.responseStatus||'pending',
        respondedAt:existing?.respondedAt||'',
      };
    }).filter(Boolean);
    for(const other of state.records){
      if(other.id===record.id||other.stage!=='booked'||eventDate(other)!==eventDate(record))continue;
      for(const assigned of (other.booking?.bartenderAssignments||[])){
        if(ids.includes(clean(assigned?.id,80)))warnings.push(clean(assigned?.name,120)+' is also assigned to '+clean(other?.customer?.name,180)+' on '+eventDate(record)+'.');
      }
    }
    record.booking.bartenderAssignments=assignments;
    record.booking.updatedAt=now;record.updatedAt=now;
    await saveRecord(state.store,state.records,record);
    return Response.json({ok:true,assignments,warnings:Array.from(new Set(warnings))});
  }

  if(action==='update-performance'){
    const bartenderId=clean(body?.bartenderId,80);
    const bartender=state.settings.staffing.bartenders.find((row:any)=>row.id===bartenderId);
    if(!bartender)return Response.json({error:'Bartender not found.'},{status:404});
    const rows=Array.isArray(record.booking.bartenderPerformance)?record.booking.bartenderPerformance:[];
    const current=rows.find((row:any)=>row.bartenderId===bartenderId)||{};
    const next={
      bartenderId,
      name:bartender.name,
      actualHours:Math.round(num(body?.actualHours??current.actualHours,0,24)*100)/100,
      tips:Math.round(num(body?.tips??current.tips,0,100000)*100)/100,
      reliability:['on-time','late','cancelled','no-show'].includes(clean(body?.reliability,30))?clean(body?.reliability,30):'not-rated',
      clientRating:Math.round(num(body?.clientRating??current.clientRating,0,5)*10)/10,
      clientFeedback:clean(body?.clientFeedback??current.clientFeedback,1000),
      updatedAt:now,
      updatedBy:clean(auth.user?.email,240)||'staff',
    };
    record.booking.bartenderPerformance=[...rows.filter((row:any)=>row.bartenderId!==bartenderId),next];
    record.booking.updatedAt=now;record.updatedAt=now;
    await saveRecord(state.store,state.records,record);
    return Response.json({ok:true,performance:next});
  }

  return Response.json({error:'Unknown workforce action.'},{status:400});
};
export const config:Config={path:'/api/admin/mobile-bar-workforce'};
