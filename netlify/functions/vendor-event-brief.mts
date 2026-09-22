import type { Context, Config } from '@netlify/functions';
import { getDeployStore,getStore } from '@netlify/blobs';
import { setupForVendor, vendorBriefRules, sanitizeSetupItems } from './_shared/vendor-event-ops.ts';

function store(c:Context,name:string){return c.deploy.context==='production'?getStore({name,consistency:'strong'}):getDeployStore({name});}
function clean(v:unknown,max=3000){return String(v??'').trim().slice(0,max);}
export default async(req:Request,context:Context)=>{
  const token=clean(context.params.token,120);
  if(!/^veb_[A-Za-z0-9]{24,100}$/.test(token))return Response.json({error:'Invalid Event Brief link.'},{status:400});
  const sales=store(context,'koa-sales'),opsStore=store(context,'koa-event-ops');
  const records:any[]=(await sales.get('records/index',{type:'json'}))||[];
  let match:any=null;
  for(const record of records){
    if(record?.stage!=='booked'||record?.kind!=='proposal')continue;
    const ops:any=await opsStore.get('events/'+record.id,{type:'json'});
    const vendor=(ops?.vendors||[]).find((v:any)=>String(v?.briefToken||'')===token);
    if(vendor){match={record,ops,vendor};break;}
  }
  if(!match)return Response.json({error:'Event Brief not found.'},{status:404});
  const {record,ops,vendor}=match;
  const setupItems=setupForVendor(sanitizeSetupItems(ops.setupItems||[]),vendor.id);
  const rules=vendorBriefRules(vendor);
  const payload={
    event:{clientName:record.customer?.name||'',eventDate:record.customer?.eventDate||'',venueArea:ops.venueArea||'Koa’s Events',guestArrival:ops.guestArrival||'',eventStart:ops.eventStart||'',eventEnd:ops.eventEnd||'',teardownEnd:ops.teardownEnd||''},
    vendor:{id:vendor.id,company:vendor.company||'',contact:vendor.contact||'',role:vendor.role||'',arrivalTime:vendor.arrivalTime||'',loadInZone:vendor.loadInZone||'',parkingInstructions:vendor.parkingInstructions||'',powerWaterNeeds:vendor.powerWaterNeeds||'',departureTime:vendor.departureTime||'',emergencyContact:vendor.emergencyContact||'',briefNote:vendor.briefNote||'',acknowledgedAt:vendor.briefAcknowledgedAt||'',acknowledgedName:vendor.briefAcknowledgedName||''},
    setupItems,
    rules,
  };
  if(req.method==='GET')return Response.json(payload,{headers:{'Cache-Control':'private, no-store'}});
  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  const body:any=await req.json().catch(()=>null);
  const selected=Array.isArray(body?.acknowledgements)?body.acknowledgements.map((x:any)=>clean(x,80)).filter(Boolean):[];
  const required=rules.map((r:any)=>r.id);
  if(!required.every((id:string)=>selected.includes(id)))return Response.json({error:'Please acknowledge every applicable Event Brief rule.'},{status:400});
  const name=clean(body?.name,180);if(!name)return Response.json({error:'Enter the name of the person acknowledging the brief.'},{status:400});
  vendor.briefAcknowledgements=selected;vendor.briefAcknowledgedName=name;vendor.briefAcknowledgedAt=new Date().toISOString();vendor.briefVendorNote=clean(body?.note,1200);ops.updatedAt=new Date().toISOString();
  await opsStore.setJSON('events/'+record.id,ops);
  return Response.json({ok:true,acknowledgedAt:vendor.briefAcknowledgedAt});
};
export const config:Config={path:'/api/vendor-brief/:token'};