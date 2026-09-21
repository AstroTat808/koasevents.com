import type { Context, Config } from '@netlify/functions';
import { getDeployStore,getStore } from '@netlify/blobs';
function storeFor(c:Context){return c.deploy.context==='production'?getStore({name:'koa-vendors',consistency:'strong'}):getDeployStore({name:'koa-vendors'});}
function clean(v:unknown,max=4000){return String(v??'').trim().slice(0,max);}
async function list(store:any,key:string){return ((await store.get(key,{type:'json'}))||[]) as any[];}
function arr(v:unknown,max=40){return Array.isArray(v)?v.map(x=>clean(x,300)).filter(Boolean).slice(0,max):[];}
export default async(req:Request,context:Context)=>{
  const token=clean(context.params.token,120);
  if(!/^vnd_[A-Za-z0-9]{24,100}$/.test(token))return Response.json({error:'Invalid vendor portal link.'},{status:400});
  const store=storeFor(context);const vendors=await list(store,'vendors/index');const vendor=vendors.find(v=>v.portalToken===token);
  if(!vendor)return Response.json({error:'Vendor portal not found.'},{status:404});
  const requests=await list(store,'requests/index');
  if(req.method==='GET'){
    return Response.json({vendor:{
      id:vendor.id,name:vendor.name,legalName:vendor.legalName,category:vendor.category,additionalCategories:vendor.additionalCategories||[],headline:vendor.headline,description:vendor.description,specialties:vendor.specialties||[],styles:vendor.styles||[],serviceAreas:vendor.serviceAreas||[],contactName:vendor.contactName,email:vendor.email,phone:vendor.phone,website:vendor.website,instagram:vendor.instagram,facebook:vendor.facebook,startingPrice:vendor.startingPrice,priceNotes:vendor.priceNotes,travelFees:vendor.travelFees,responseTime:vendor.responseTime,logoUrl:vendor.logoUrl,coverImage:vendor.coverImage,insurance:vendor.insurance||{}
    },requests:requests.filter(r=>r.vendorId===vendor.id).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))},{headers:{'Cache-Control':'private, no-store'}});
  }
  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  const body:any=await req.json().catch(()=>null);const action=clean(body?.action,50);
  if(action==='save-profile'){
    vendor.legalName=clean(body?.legalName,180);vendor.headline=clean(body?.headline,240);vendor.description=clean(body?.description,6000);vendor.specialties=arr(body?.specialties);vendor.styles=arr(body?.styles);vendor.serviceAreas=arr(body?.serviceAreas);vendor.contactName=clean(body?.contactName,180);vendor.email=clean(body?.email,240);vendor.phone=clean(body?.phone,80);vendor.website=clean(body?.website,600);vendor.instagram=clean(body?.instagram,600);vendor.facebook=clean(body?.facebook,600);vendor.startingPrice=clean(body?.startingPrice,120);vendor.priceNotes=clean(body?.priceNotes,800);vendor.travelFees=clean(body?.travelFees,500);vendor.responseTime=clean(body?.responseTime,120);vendor.logoUrl=clean(body?.logoUrl,1000);vendor.coverImage=clean(body?.coverImage,1000);vendor.updatedAt=new Date().toISOString();
    await store.setJSON('vendors/index',vendors);return Response.json({ok:true});
  }
  if(action==='save-insurance'){
    const current=vendor.insurance||{};vendor.insurance={...current,status:'received',carrier:clean(body?.carrier,180),policyNumber:clean(body?.policyNumber,180),expiresAt:clean(body?.expiresAt,40),additionalInsured:Boolean(body?.additionalInsured),certificateUrl:clean(body?.certificateUrl,1000),submittedAt:new Date().toISOString()};vendor.updatedAt=new Date().toISOString();await store.setJSON('vendors/index',vendors);return Response.json({ok:true,insurance:vendor.insurance});
  }
  if(action==='respond-availability'){
    const requestId=clean(body?.requestId,100);const status=clean(body?.status,40);const allowed=new Set(['available','possibly_available','unavailable']);
    const row=requests.find(r=>r.id===requestId&&r.vendorId===vendor.id&&r.type==='availability');if(!row)return Response.json({error:'Availability request not found.'},{status:404});if(!allowed.has(status))return Response.json({error:'Invalid availability response.'},{status:400});
    row.status=status;row.vendorNote=clean(body?.note,1600);row.respondedAt=new Date().toISOString();row.updatedAt=row.respondedAt;await store.setJSON('requests/index',requests);return Response.json({ok:true,request:row});
  }
  return Response.json({error:'Unknown vendor portal action.'},{status:400});
};
export const config:Config={path:'/api/vendor-portal/:token'};