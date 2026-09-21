import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';

function salesStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-sales', consistency: 'strong' })
    : getDeployStore({ name: 'koa-sales' });
}
function opsStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-event-ops', consistency: 'strong' })
    : getDeployStore({ name: 'koa-event-ops' });
}
function clean(value: unknown, max = 1200) {
  return String(value || '').trim().slice(0, max);
}
function num(value: unknown, min = 0, max = 10000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : 0;
}
function id(prefix='ROW') {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return prefix + '-' + Array.from(bytes, (value) => value.toString(16).padStart(2,'0')).join('').toUpperCase();
}
function offsetDate(date: string, days: number) {
  const parsed = new Date(date + 'T12:00:00Z');
  if (Number.isNaN(parsed.getTime())) return '';
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0,10);
}
function seedVendorRequirements() {
  return [
    ['Wedding Planner','recommended'],['Photographer','recommended'],['Videographer','optional'],['Caterer','recommended'],
    ['Florist','optional'],['Officiant','recommended'],['DJ','optional'],['Live Musician','optional'],['Entertainment','optional'],
    ['Hair & Makeup','optional'],['Cake / Dessert','optional'],['Rentals','optional'],['Transportation','optional'],['Bartender / Mobile Bar','optional'],
  ].map(([category,importance])=>({category,importance,note:''}));
}
function seedQuestionnaire() {
  const rows = [
    ['event','Confirm the final guest count.'],
    ['event','What time should guests begin arriving?'],
    ['event','What are the ceremony and reception start times?'],
    ['event','Are there accessibility, mobility, or special accommodation needs?'],
    ['vendors','Are all vendors finalized? List any vendors still pending.'],
    ['vendors','Are there vendor power, water, staging, loading, or parking requirements?'],
    ['layout','What layout or floor-plan decisions are still open?'],
    ['rentals','Which Koa’s rental inventory or outside rental items are confirmed?'],
    ['bar','What bar package/menu and alcohol-service details are confirmed?'],
    ['decor','What decor, floral, signage, cake, or specialty installation details need coordination?'],
    ['timeline','Are there any special entrances, announcements, dances, speeches, ceremonies, or surprise moments?'],
    ['logistics','Who are the day-of decision makers and emergency contacts?'],
  ];
  return rows.map(([category,question])=>({id:id('Q'),category,question,answer:'',status:'open'}));
}
function seedChecklist(eventDate: string) {
  const due60=eventDate?offsetDate(eventDate,-60):'';
  const due30=eventDate?offsetDate(eventDate,-30):'';
  const rows = [
    ['before','Final payment completed',due60],
    ['before','Event insurance certificate submitted',due60],
    ['before','Vendor list submitted',due30],
    ['before','Damage deposit submitted',due30],
    ['before','All vendor arrival times confirmed',''],
    ['before','Bartender confirmed from approved list',''],
    ['event_day','Setup starts no earlier than 12:00 PM unless approved',eventDate||''],
    ['event_day','DJ / music volume remains under 75 dB',eventDate||''],
    ['event_day','Shot drinks end by 8:00 PM',eventDate||''],
    ['event_day','Guests follow conduct, occupancy, and smoking policies',eventDate||''],
    ['event_day','Music off by 10:00 PM',eventDate||''],
    ['after','All decorations and personal items removed',eventDate||''],
    ['after','Vendors cleared out by 9:00 AM next day',eventDate?offsetDate(eventDate,1):''],
    ['after','No trash, spills, or extra mess left behind',eventDate||''],
    ['after','No vehicles left overnight',eventDate||''],
  ];
  return rows.map(([phase,text,dueDate])=>({id:id('C'),phase,text,dueDate,owner:'',status:'not_started'}));
}
function seedTasks() {
  return [
    'Venue opening / access check',
    'Vendor arrival and load-in coordination',
    'Floor plan / furniture placement verification',
    'Bar setup and bartender check-in',
    'Sound / music level check',
    'Guest arrival readiness check',
    '8:00 PM alcohol-service cutoff check',
    '10:00 PM music-off check',
    'Post-event cleanup / property walk-through',
  ].map((task)=>({id:id('T'),time:'',task,owner:'',status:'not_started',notes:''}));
}
function defaultOps(record:any) {
  const eventDate=clean(record?.customer?.eventDate,40);
  const guestCount=Math.round(num(record?.quote?.state?.guestCount || record?.inquiry?.guestCount,0,1000));
  const now=new Date().toISOString();
  return {
    recordId:record.id,createdAt:now,updatedAt:now,status:'planning',
    finalGuestCount:guestCount,setupStart:'',guestArrival:'',eventStart:'',eventEnd:'',teardownEnd:'',venueArea:'Koa’s Events',
    notes:'',vendors:[],vendorRequirements:seedVendorRequirements(),questionnaire:seedQuestionnaire(),timeline:[],checklist:seedChecklist(eventDate),tasks:seedTasks(),documents:[]
  };
}
async function appendEvent(context: Context, event: Record<string,unknown>) {
  const store=salesStoreFor(context);
  const current=(await store.get('analytics/events/index',{type:'json'})) || [];
  await store.setJSON('analytics/events/index',[{id:id('EVT'),createdAt:new Date().toISOString(),...event},...current].slice(0,10000));
}
function publicOps(record:any,ops:any) {
  return {
    record:{
      id:record.id,
      customerName:record.customer?.name || '',
      eventDate:record.customer?.eventDate || '',
      packageId:record.packageId || '',
    },
    planning:{
      status:ops.status || 'planning',
      finalGuestCount:Number(ops.finalGuestCount || 0),
      vendors:(ops.vendors || []).map((v:any)=>({
        id:v.id,marketplaceVendorId:v.marketplaceVendorId||'',company:v.company||'',contact:v.contact||'',role:v.role||'',email:v.email||'',phone:v.phone||'',arrivalTime:v.arrivalTime||'',notes:v.notes||'',
        insuranceStatus:v.insuranceStatus || 'not_requested',
      })),
      vendorRequirements:(ops.vendorRequirements||seedVendorRequirements()).map((r:any)=>({category:r.category,importance:r.importance||'optional',note:r.note||'',booked:(ops.vendors||[]).some((v:any)=>String(v.role||'')===String(r.category||''))})),
      questionnaire:(ops.questionnaire || []).map((q:any)=>({
        id:q.id,category:q.category||'general',question:q.question||'',answer:q.answer||'',status:q.status||'open'
      })),
      documents:(ops.documents || []).filter((d:any)=>d.uploadedBy === 'client').map((d:any)=>({
        id:d.id,name:d.name,label:d.label,category:d.category,type:d.type,size:d.size,uploadedAt:d.uploadedAt
      })),
      updatedAt:ops.updatedAt || '',
    }
  };
}
function sanitizeClientVendors(input:unknown,existing:any[]) {
  if(!Array.isArray(input)) return existing || [];
  const existingById=new Map((existing||[]).map((v:any)=>[String(v.id),v]));
  return input.slice(0,100).map((row:any)=>{
    const rowId=clean(row?.id,80) || id('V');
    const current=existingById.get(rowId) || {};
    return {
      id:rowId,
      marketplaceVendorId:clean(current.marketplaceVendorId||row?.marketplaceVendorId,100),
      company:clean(row?.company,180),
      contact:clean(row?.contact,180),
      role:clean(row?.role,120),
      email:clean(row?.email,240),
      phone:clean(row?.phone,80),
      arrivalTime:clean(row?.arrivalTime,40),
      insuranceStatus:current.insuranceStatus || 'not_requested',
      notes:clean(row?.notes,1600),
    };
  }).filter((row:any)=>row.company || row.contact || row.role);
}
function sanitizeClientQuestionnaire(input:unknown,existing:any[]) {
  if(!Array.isArray(input)) return existing || [];
  const incoming=new Map(input.map((q:any)=>[String(q?.id||''),q]));
  return (existing||[]).map((q:any)=>{
    const row:any=incoming.get(String(q.id));
    if(!row) return q;
    const answer=clean(row.answer,4000);
    return {
      ...q,
      answer,
      status:q.status === 'confirmed' ? 'confirmed' : answer ? 'answered' : 'open',
    };
  });
}

export default async (req:Request,context:Context)=>{
  const token=clean(context.params.token,100);
  if(!/^[A-Za-z0-9_-]{24,100}$/.test(token)) return Response.json({error:'Invalid planning link.'},{status:400});

  const sales=salesStoreFor(context);
  const opsStore=opsStoreFor(context);
  const records=((await sales.get('records/index',{type:'json'})) || []) as any[];
  const record=records.find((entry:any)=>entry?.kind==='proposal' && entry?.proposal?.publicToken===token);
  if(!record) return Response.json({error:'Planning portal not found.'},{status:404});
  if(record.stage !== 'booked' || record.proposal?.status !== 'booked') {
    return Response.json({error:'The planning portal becomes available after your event is fully booked.'},{status:403});
  }

  let ops:any=await opsStore.get('events/'+record.id,{type:'json'});
  if(!ops){ops=defaultOps(record);await opsStore.setJSON('events/'+record.id,ops);}
  else if(!Array.isArray(ops.vendorRequirements)){ops.vendorRequirements=seedVendorRequirements();await opsStore.setJSON('events/'+record.id,ops);}

  if(req.method==='GET') {
    return Response.json(publicOps(record,ops),{headers:{'Cache-Control':'private, no-store'}});
  }
  if(req.method!=='POST') return new Response('Method not allowed',{status:405});

  const payload:any=await req.json().catch(()=>null);
  const action=clean(payload?.action,40);

  if(action==='save-guest-count') {
    ops.finalGuestCount=Math.round(num(payload?.finalGuestCount,0,1000));
  } else if(action==='save-vendors') {
    ops.vendors=sanitizeClientVendors(payload?.vendors,ops.vendors||[]);
  } else if(action==='save-questionnaire') {
    ops.questionnaire=sanitizeClientQuestionnaire(payload?.questionnaire,ops.questionnaire||[]);
  } else {
    return Response.json({error:'Unknown planning action.'},{status:400});
  }

  ops.updatedAt=new Date().toISOString();
  await opsStore.setJSON('events/'+record.id,ops);
  await appendEvent(context,{
    type:'client_planning_updated',
    recordId:record.id,
    quoteId:record.quoteId||'',
    packageId:record.packageId||'',
    detail:action.replace('save-','')+' updated by client in the planning portal.'
  });
  return Response.json({ok:true,...publicOps(record,ops)},{headers:{'Cache-Control':'private, no-store'}});
};

export const config:Config={path:'/api/planning/:token'};
