import type { Context, Config } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { ensureLifecycle, markLifecycleEvent } from './_shared/lifecycle';

const HST=-10*60*60*1000;
function hstDate(){return new Date(Date.now()+HST).toISOString().slice(0,10);}
function sales(){return getStore({name:'koa-sales',consistency:'strong'});}
function ops(){return getStore({name:'koa-event-ops',consistency:'strong'});}

export default async(_req:Request,context:Context)=>{
  if(context.deploy.context!=='production')return;
  const store=sales();const records:any[]=(await store.get('records/index',{type:'json'}))||[];
  const today=hstDate();
  for(const record of records.slice(0,1500)){
    if(!record?.id)continue;
    await ensureLifecycle(context,record);
    if(record.stage==='booked'&&record.customer?.eventDate&&String(record.customer.eventDate)<today){
      const o:any=await ops().get('events/'+record.id,{type:'json'});
      if(o&&o.status!=='complete'){
        o.status='complete';o.updatedAt=new Date().toISOString();await ops().setJSON('events/'+record.id,o);
        await markLifecycleEvent(context,record,'event_completed','Event date has passed; Event Ops automatically advanced to complete and post-event follow-up is active.');
      }
    }
  }
};
export const config:Config={schedule:'@hourly'};