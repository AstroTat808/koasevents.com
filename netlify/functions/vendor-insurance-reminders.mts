import type { Config, Context } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { sendVendorEmail } from './_shared/vendor-email.ts';
import { syncVendorInsuranceToUpcomingEvents } from './_shared/vendor-insurance-sync.ts';

const DAY=86_400_000;
function daysUntil(date:unknown){
  const raw=String(date||'').slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(raw))return null;
  const target=Date.parse(raw+'T00:00:00Z');const today=Date.parse(new Date(Date.now()-10*60*60*1000).toISOString().slice(0,10)+'T00:00:00Z');
  return Math.ceil((target-today)/DAY);
}
export default async(_req:Request,context:Context)=>{
  if(context.deploy.context!=='production')return;
  const store=getStore({name:'koa-vendors',consistency:'strong'});
  const vendors:any[]=(await store.get('vendors/index',{type:'json'}))||[];
  let changed=false;const now=new Date().toISOString();
  for(const vendor of vendors){
    const insurance=vendor.insurance||{};const days=daysUntil(insurance.expiresAt);if(days===null)continue;
    if(days<0&&insurance.status!=='expired'){insurance.status='expired';insurance.expiredAt=now;changed=true;await syncVendorInsuranceToUpcomingEvents(context,vendor);}
    const checkpoints=[30,14,7,0];
    if(!checkpoints.includes(days))continue;
    const key=String(days);const sent=insurance.reminders||{};if(sent[key])continue;
    const token=String(vendor.portalToken||'');const url=token?'https://koasevents.com/vendor-portal/?token='+encodeURIComponent(token):'';
    const result=await sendVendorEmail({
      to:[vendor.email],
      subject:days===0?'Your Koa’s vendor insurance expires today':'Koa’s vendor insurance expires in '+days+' days',
      title:days===0?'Your insurance certificate expires today.':'Your insurance certificate is approaching expiration.',
      body:'Please update your current liability insurance information so future Koa’s events are not delayed by compliance review.',
      detail:['Expiration: '+insurance.expiresAt,insurance.carrier?'Carrier: '+insurance.carrier:'','Koa’s should be listed as additional insured when required.'].filter(Boolean).join(' · '),
      actionLabel:'Update Insurance',
      actionUrl:url,
      idempotencyKey:'koa-vendor-insurance-'+vendor.id+'-'+insurance.expiresAt+'-'+key,
    });
    insurance.reminders={...sent,[key]:{sentAt:now,messageId:result.id||'',sent:result.sent}};changed=true;
  }
  if(changed)await store.setJSON('vendors/index',vendors.slice(0,2000));
};
export const config:Config={schedule:'0 18 * * *'};