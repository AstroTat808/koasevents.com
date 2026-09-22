import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { hasCapability, requireCapability } from './_shared/admin';
import { sendVendorEmail } from './_shared/vendor-email.ts';
import { syncVendorInsuranceToUpcomingEvents } from './_shared/vendor-insurance-sync.ts';

type VendorStatus='draft'|'published'|'paused';
type PartnerTier='preferred'|'verified'|'community';
type InsuranceStatus='not_requested'|'requested'|'received'|'approved'|'expired';

function storeFor(context:Context){return context.deploy.context==='production'?getStore({name:'koa-vendors',consistency:'strong'}):getDeployStore({name:'koa-vendors'});}
function clean(v:unknown,max=4000){return String(v??'').trim().slice(0,max);}
function arr(v:unknown,max=50){return Array.isArray(v)?v.map(x=>clean(x,300)).filter(Boolean).slice(0,max):[];}
function id(prefix='VEN'){return prefix+'-'+crypto.randomUUID().replaceAll('-','').slice(0,12).toUpperCase();}
function num(v:unknown,min=0,max=5){const n=Number(v);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):0;}
async function list(store:any,key:string){return ((await store.get(key,{type:'json'}))||[]) as any[];}
function sanitize(body:any,current:any={}){
  const statusValues=new Set<VendorStatus>(['draft','published','paused']);
  const tiers=new Set<PartnerTier>(['preferred','verified','community']);
  const insuranceValues=new Set<InsuranceStatus>(['not_requested','requested','received','approved','expired']);
  const now=new Date().toISOString();
  return {
    id:clean(current.id||body?.id,80)||id(),
    portalToken:clean(current.portalToken||body?.portalToken,100)||('vnd_'+crypto.randomUUID().replaceAll('-','')),
    name:clean(body?.name,180),
    legalName:clean(body?.legalName,180),
    category:clean(body?.category,100),
    additionalCategories:arr(body?.additionalCategories,15),
    tier:tiers.has(body?.tier)?body.tier:'community',
    status:statusValues.has(body?.status)?body.status:'draft',
    headline:clean(body?.headline,240),
    description:clean(body?.description,6000),
    specialties:arr(body?.specialties,30),
    styles:arr(body?.styles,30),
    serviceAreas:arr(body?.serviceAreas,30),
    contactName:clean(body?.contactName,180),
    email:clean(body?.email,240),
    phone:clean(body?.phone,80),
    website:clean(body?.website,600),
    instagram:clean(body?.instagram,600),
    facebook:clean(body?.facebook,600),
    startingPrice:clean(body?.startingPrice,120),
    priceNotes:clean(body?.priceNotes,800),
    travelFees:clean(body?.travelFees,500),
    responseTime:clean(body?.responseTime,120),
    logoUrl:clean(body?.logoUrl,1000),
    coverImage:clean(body?.coverImage,1000),
    gallery: Array.isArray(body?.gallery)?body.gallery.slice(0,40).map((g:any)=>({src:clean(g?.src,1000),caption:clean(g?.caption,500),eventLabel:clean(g?.eventLabel,180)})).filter((g:any)=>g.src):[],
    insurance:{
      ...(current.insurance||{}),
      status:insuranceValues.has(body?.insurance?.status)?body.insurance.status:(current.insurance?.status||'not_requested'),
      carrier:clean(body?.insurance?.carrier,180),
      policyNumber:clean(body?.insurance?.policyNumber,180),
      expiresAt:clean(body?.insurance?.expiresAt,40),
      additionalInsured:Boolean(body?.insurance?.additionalInsured),
      verifiedAt:clean(body?.insurance?.verifiedAt,60)||clean(current.insurance?.verifiedAt,60),
      document:current.insurance?.document||null,
      reminders:current.insurance?.reminders||{},
      submittedAt:clean(current.insurance?.submittedAt,60),
      reviewedAt:clean(current.insurance?.reviewedAt,60),
      rejectionReason:clean(current.insurance?.rejectionReason,1200),
    },
    internal:{
      staffRating:num(body?.internal?.staffRating),
      punctuality:num(body?.internal?.punctuality),
      communication:num(body?.internal?.communication),
      venueCompliance:num(body?.internal?.venueCompliance),
      cleanliness:num(body?.internal?.cleanliness),
      wouldInviteBack:body?.internal?.wouldInviteBack===true?true:body?.internal?.wouldInviteBack===false?false:null,
      notes:clean(body?.internal?.notes,6000),
      eventsWorked:Math.max(0,Math.round(Number(body?.internal?.eventsWorked)||0)),
      lastEventAt:clean(body?.internal?.lastEventAt,40),
    },
    featured:Boolean(body?.featured),
    createdAt:current.createdAt||now,
    updatedAt:now,
  };
}

export default async(req:Request,context:Context)=>{
  const auth=await requireCapability('vendors.view', req); if(auth.response)return auth.response;
  const store=storeFor(context);
  const vendors=await list(store,'vendors/index');
  if(req.method==='GET'){
    const [reviews,requests]=await Promise.all([list(store,'reviews/index'),list(store,'requests/index')]);
    const enriched=vendors.map(v=>{const rows=reviews.filter(r=>r.vendorId===v.id&&r.status==='published');const avg=rows.length?rows.reduce((s,r)=>s+Number(r.overall||0),0)/rows.length:0;return {...v,reviewSummary:{count:rows.length,average:Number(avg.toFixed(1))}};});
    return Response.json({vendors:enriched,reviews,requests},{headers:{'Cache-Control':'private, no-store'}});
  }
  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  if(!hasCapability(auth.user,'vendors.manage'))return Response.json({error:'Vendor Manager permission required.'},{status:403});
  const body:any=await req.json().catch(()=>null); const action=clean(body?.action,40);
  if(action==='save-vendor'){
    const current=vendors.find(v=>v.id===body?.vendor?.id)||{};
    const vendor=sanitize(body?.vendor,current);
    if(!vendor.name||!vendor.category)return Response.json({error:'Vendor name and category are required.'},{status:400});
    const next=[vendor,...vendors.filter(v=>v.id!==vendor.id)];
    await store.setJSON('vendors/index',next.slice(0,2000));
    const affectedEvents=await syncVendorInsuranceToUpcomingEvents(context,vendor);
    return Response.json({ok:true,vendor,affectedEvents});
  }
  if(action==='archive-vendor'){
    const vendor=vendors.find(v=>v.id===body?.vendorId);if(!vendor)return Response.json({error:'Vendor not found.'},{status:404});
    vendor.status='paused';vendor.updatedAt=new Date().toISOString();
    await store.setJSON('vendors/index',vendors);return Response.json({ok:true,vendor});
  }
  if(action==='review-insurance'){
    const vendor=vendors.find(v=>v.id===body?.vendorId);if(!vendor)return Response.json({error:'Vendor not found.'},{status:404});
    const decision=clean(body?.decision,20);if(!['approve','reject'].includes(decision))return Response.json({error:'Insurance decision must be approve or reject.'},{status:400});
    vendor.insurance={...(vendor.insurance||{}),status:decision==='approve'?'approved':'received',reviewedAt:new Date().toISOString(),verifiedAt:decision==='approve'?new Date().toISOString():'',rejectionReason:decision==='reject'?clean(body?.reason,1200):''};
    vendor.updatedAt=new Date().toISOString();
    await store.setJSON('vendors/index',vendors);
    const affectedEvents=await syncVendorInsuranceToUpcomingEvents(context,vendor);
    if(String(vendor.email||'').includes('@')){
      await sendVendorEmail({to:[vendor.email],subject:decision==='approve'?'Koa’s insurance certificate approved':'Koa’s insurance certificate needs an update',title:decision==='approve'?'Your insurance certificate is approved.':'Your insurance certificate needs an update.',body:decision==='approve'?'Koa’s has reviewed and approved your current insurance certificate.':'Koa’s reviewed your insurance certificate and needs an updated submission before it can be approved.',detail:decision==='approve'?(vendor.insurance.expiresAt?'Expiration: '+vendor.insurance.expiresAt:'Approved'):vendor.insurance.rejectionReason,actionLabel:'Open Vendor Portal',actionUrl:'https://koasevents.com/vendor-portal/?token='+encodeURIComponent(vendor.portalToken),idempotencyKey:'koa-insurance-review-'+vendor.id+'-'+vendor.insurance.reviewedAt});
    }
    return Response.json({ok:true,vendor,affectedEvents});
  }
  if(action==='send-portal-invite'){
    const vendor=vendors.find(v=>v.id===body?.vendorId);if(!vendor)return Response.json({error:'Vendor not found.'},{status:404});
    if(!String(vendor.email||'').includes('@'))return Response.json({error:'Vendor email is required before sending a portal invite.'},{status:400});
    const url='https://koasevents.com/vendor-portal/?token='+encodeURIComponent(vendor.portalToken);
    const result=await sendVendorEmail({to:[vendor.email],subject:'Your Koa’s Vendor Portal',title:'Your Koa’s Vendor Portal is ready.',body:'Use this private link to keep your marketplace profile and insurance information current and to respond to availability requests from Koa’s clients.',detail:'Keep this private link for your team. Koa’s retains control of Preferred/Verified status, reviews and internal performance records.',actionLabel:'Open Vendor Portal',actionUrl:url,idempotencyKey:'koa-vendor-portal-'+vendor.id+'-'+new Date().toISOString().slice(0,10)});
    return Response.json({ok:true,sent:result.sent,url});
  }
  if(action==='moderate-review'){
    const reviews=await list(store,'reviews/index');const row=reviews.find(r=>r.id===body?.reviewId);if(!row)return Response.json({error:'Review not found.'},{status:404});
    row.status=body?.status==='published'?'published':'hidden';row.moderatedAt=new Date().toISOString();
    await store.setJSON('reviews/index',reviews);return Response.json({ok:true,review:row});
  }
  return Response.json({error:'Unknown vendor action.'},{status:400});
};
export const config:Config={path:'/api/admin/vendors'};