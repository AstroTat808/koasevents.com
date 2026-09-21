import type { Context, Config } from '@netlify/functions';
import { getDeployStore,getStore } from '@netlify/blobs';
function sales(context:Context){return context.deploy.context==='production'?getStore({name:'koa-sales',consistency:'strong'}):getDeployStore({name:'koa-sales'});}
function ops(context:Context){return context.deploy.context==='production'?getStore({name:'koa-event-ops',consistency:'strong'}):getDeployStore({name:'koa-event-ops'});}
function vendors(context:Context){return context.deploy.context==='production'?getStore({name:'koa-vendors',consistency:'strong'}):getDeployStore({name:'koa-vendors'});}
function clean(v:unknown,max=4000){return String(v??'').trim().slice(0,max);}
function id(prefix='REV'){return prefix+'-'+crypto.randomUUID().replaceAll('-','').slice(0,12).toUpperCase();}
async function list(store:any,key:string){return ((await store.get(key,{type:'json'}))||[]) as any[];}
function score(v:unknown){const n=Math.round(Number(v)||0);return Math.max(1,Math.min(5,n));}
export default async(req:Request,context:Context)=>{
  const token=clean(context.params.token,100);
  if(!/^[A-Za-z0-9_-]{24,100}$/.test(token))return Response.json({error:'Invalid marketplace link.'},{status:400});
  const ss=sales(context), os=ops(context), vs=vendors(context);
  const records=await list(ss,'records/index');const record=records.find(r=>r?.kind==='proposal'&&r?.proposal?.publicToken===token);
  if(!record)return Response.json({error:'Client portal not found.'},{status:404});
  if(record.stage!=='booked')return Response.json({error:'Vendor Marketplace becomes available after booking.'},{status:403});
  let event:any=await os.get('events/'+record.id,{type:'json'});if(!event)event={recordId:record.id,vendors:[],documents:[]};
  const all=(await list(vs,'vendors/index')).filter(v=>v.status==='published');
  const reviews=await list(vs,'reviews/index');const favorites=await list(vs,'favorites/'+record.id);
  const publicVendors=all.map(v=>{
    const rows=reviews.filter(r=>r.vendorId===v.id&&r.status==='published');
    const avg=rows.length?rows.reduce((s,r)=>s+Number(r.overall||0),0)/rows.length:0;
    return {id:v.id,name:v.name,category:v.category,additionalCategories:v.additionalCategories||[],tier:v.tier,headline:v.headline,description:v.description,specialties:v.specialties||[],styles:v.styles||[],serviceAreas:v.serviceAreas||[],contactName:v.contactName,email:v.email,phone:v.phone,website:v.website,instagram:v.instagram,startingPrice:v.startingPrice,priceNotes:v.priceNotes,travelFees:v.travelFees,responseTime:v.responseTime,logoUrl:v.logoUrl,coverImage:v.coverImage,gallery:v.gallery||[],insuranceStatus:v.insurance?.status||'not_requested',eventsWorked:Number(v.internal?.eventsWorked||0),lastEventAt:v.internal?.lastEventAt||'',featured:Boolean(v.featured),rating:{average:Number(avg.toFixed(1)),count:rows.length},reviews:rows.slice(-8).reverse().map(r=>({id:r.id,overall:r.overall,communication:r.communication,professionalism:r.professionalism,quality:r.quality,value:r.value,wouldHireAgain:r.wouldHireAgain,comment:r.comment,clientName:r.clientName,eventDate:r.eventDate}))};
  });
  if(req.method==='GET')return Response.json({record:{id:record.id,customerName:record.customer?.name||'',eventDate:record.customer?.eventDate||'',packageId:record.packageId||''},vendors:publicVendors,favorites,eventTeam:(event.vendors||[]).filter((v:any)=>v.marketplaceVendorId).map((v:any)=>({id:v.id,marketplaceVendorId:v.marketplaceVendorId,company:v.company,role:v.role,arrivalTime:v.arrivalTime,insuranceStatus:v.insuranceStatus}))},{headers:{'Cache-Control':'private, no-store'}});
  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  const body:any=await req.json().catch(()=>null);const action=clean(body?.action,50);const vendorId=clean(body?.vendorId,100);const vendor=all.find(v=>v.id===vendorId);
  if(['toggle-favorite','select-vendor','remove-vendor','submit-review'].includes(action)&&!vendor)return Response.json({error:'Vendor not found.'},{status:404});
  if(action==='toggle-favorite'){
    const current=await list(vs,'favorites/'+record.id);const next=current.includes(vendorId)?current.filter(x=>x!==vendorId):[vendorId,...current].slice(0,200);
    await vs.setJSON('favorites/'+record.id,next);return Response.json({ok:true,favorites:next});
  }
  if(action==='select-vendor'){
    const existing=(event.vendors||[]).find((v:any)=>v.marketplaceVendorId===vendorId);
    if(!existing)(event.vendors||=[]).push({id:id('V'),marketplaceVendorId:vendor.id,company:vendor.name,contact:vendor.contactName||'',role:vendor.category,email:vendor.email||'',phone:vendor.phone||'',arrivalTime:'',insuranceStatus:vendor.insurance?.status==='approved'?'approved':'not_requested',notes:'Selected through Koa’s Vendor Marketplace'});
    event.updatedAt=new Date().toISOString();await os.setJSON('events/'+record.id,event);return Response.json({ok:true});
  }
  if(action==='remove-vendor'){
    event.vendors=(event.vendors||[]).filter((v:any)=>v.marketplaceVendorId!==vendorId);event.updatedAt=new Date().toISOString();await os.setJSON('events/'+record.id,event);return Response.json({ok:true});
  }
  if(action==='submit-review'){
    const eventDate=clean(record.customer?.eventDate,40);if(!eventDate||eventDate>new Date().toISOString().slice(0,10))return Response.json({error:'Reviews open after your event date.'},{status:403});
    const used=(event.vendors||[]).some((v:any)=>v.marketplaceVendorId===vendorId);if(!used)return Response.json({error:'Only vendors on your Koa’s event team can be reviewed.'},{status:403});
    const reviews=await list(vs,'reviews/index');const prior=reviews.find(r=>r.recordId===record.id&&r.vendorId===vendorId);
    const row={id:prior?.id||id(),recordId:record.id,vendorId,status:'pending',clientName:clean(record.customer?.name,180),eventDate,overall:score(body?.overall),communication:score(body?.communication),professionalism:score(body?.professionalism),quality:score(body?.quality),value:score(body?.value),wouldHireAgain:Boolean(body?.wouldHireAgain),comment:clean(body?.comment,3000),createdAt:prior?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
    await vs.setJSON('reviews/index',[row,...reviews.filter(r=>r.id!==row.id)].slice(0,10000));return Response.json({ok:true,review:row});
  }
  return Response.json({error:'Unknown marketplace action.'},{status:400});
};
export const config:Config={path:'/api/vendor-marketplace/:token'};