import type { Config, Context } from '@netlify/functions';
import {
  profileFromOrganization,
  readOrganizationById,
  saveOrganization,
} from './_shared/organization';

function clean(value:unknown,max=1000){return String(value??'').trim().slice(0,max);}

function timingSafeEqual(a:string,b:string){
  if(a.length!==b.length)return false;
  let diff=0;
  for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}

function hex(bytes:ArrayBuffer){
  return Array.from(new Uint8Array(bytes),(b)=>b.toString(16).padStart(2,'0')).join('');
}

async function verifyStripeSignature(raw:string,header:string,secret:string){
  const parts=header.split(',').map((entry)=>entry.trim());
  const timestamp=parts.find((entry)=>entry.startsWith('t='))?.slice(2)||'';
  const signatures=parts.filter((entry)=>entry.startsWith('v1=')).map((entry)=>entry.slice(3));
  const ts=Number(timestamp);
  if(!timestamp||!Number.isFinite(ts)||Math.abs(Date.now()/1000-ts)>300||!signatures.length)return false;
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const digest=hex(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(timestamp+'.'+raw)));
  return signatures.some((candidate)=>timingSafeEqual(candidate,digest));
}

function stripeStatus(value:unknown){
  const status=clean(value,40);
  if(status==='trialing')return 'trialing' as const;
  if(status==='active')return 'active' as const;
  if(['past_due','unpaid','incomplete','incomplete_expired','paused'].includes(status))return 'past_due' as const;
  if(['canceled'].includes(status))return 'canceled' as const;
  return 'not_configured' as const;
}

function isoFromUnix(value:unknown){
  const n=Number(value);
  return Number.isFinite(n)&&n>0?new Date(n*1000).toISOString():'';
}

export default async(req:Request,context:Context)=>{
  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  const secret=clean(Netlify.env.get('VENUELOOM_STRIPE_WEBHOOK_SECRET'),4000);
  if(!secret)return new Response('Stripe webhook secret is not configured',{status:503});

  const raw=await req.text();
  if(raw.length>250000)return new Response('Payload too large',{status:413});
  const signature=clean(req.headers.get('stripe-signature'),12000);
  if(!(await verifyStripeSignature(raw,signature,secret)))return new Response('Invalid Stripe signature',{status:401});

  let event:any;
  try{event=JSON.parse(raw);}catch{return new Response('Invalid JSON',{status:400});}
  const object=event?.data?.object||{};
  const tenantId=clean(
    object?.metadata?.tenant_id
    || object?.subscription_details?.metadata?.tenant_id
    || object?.subscription_data?.metadata?.tenant_id,
    120
  );
  if(!tenantId)return new Response(null,{status:204});

  const organization=await readOrganizationById(context,tenantId);
  if(!organization)return new Response(null,{status:204});
  const profile=profileFromOrganization(organization);
  const type=clean(event?.type,120);
  const now=new Date().toISOString();

  if(type==='checkout.session.completed'){
    await saveOrganization(context,profile,(current)=>({
      ...current,
      subscription:{
        ...current.subscription,
        stripeCustomerId:clean(object?.customer,180)||current.subscription.stripeCustomerId,
        stripeSubscriptionId:clean(object?.subscription,180)||current.subscription.stripeSubscriptionId,
        status:current.subscription.status==='not_configured'?'trialing':current.subscription.status,
      },
      integrations:(current.integrations||[]).map((row)=>row.provider==='stripe'?{
        ...row,enabled:true,status:'connected',remoteAccountId:clean(object?.customer,180),connectedAt:row.connectedAt||now,lastVerifiedAt:now,
      }:row),
    }));
  } else if(type.startsWith('customer.subscription.')){
    await saveOrganization(context,profile,(current)=>({
      ...current,
      status:stripeStatus(object?.status)==='past_due'?'past_due':stripeStatus(object?.status)==='canceled'?'canceled':current.status,
      subscription:{
        ...current.subscription,
        status:stripeStatus(object?.status),
        stripeCustomerId:clean(object?.customer,180)||current.subscription.stripeCustomerId,
        stripeSubscriptionId:clean(object?.id,180)||current.subscription.stripeSubscriptionId,
        currentPeriodEnd:isoFromUnix(object?.current_period_end),
        trialEndsAt:isoFromUnix(object?.trial_end),
      },
      integrations:(current.integrations||[]).map((row)=>row.provider==='stripe'?{
        ...row,
        enabled:true,
        status:['active','trialing'].includes(clean(object?.status,40))?'connected':'attention',
        remoteAccountId:clean(object?.customer,180)||row.remoteAccountId,
        lastVerifiedAt:now,
      }:row),
    }));
  }

  return new Response(null,{status:204,headers:{'Cache-Control':'no-store'}});
};

export const config:Config={path:'/api/webhooks/stripe'};
