import type { Context, Config } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { ensureLifecycle, markLifecycleEvent } from './_shared/lifecycle';
import { assessCrmRecord } from './_shared/crm-cleanup';

const HST=-10*60*60*1000;
function hstDate(){return new Date(Date.now()+HST).toISOString().slice(0,10);}
function sales(){return getStore({name:'koa-sales',consistency:'strong'});}
function ops(){return getStore({name:'koa-event-ops',consistency:'strong'});}
function relatedIds(root:any,records:any[]){const ids=new Set([root.id]);if(root.quoteId)records.filter(r=>r.quoteId===root.quoteId).forEach(r=>ids.add(r.id));let changed=true;while(changed){changed=false;for(const r of records){if((r.source&&ids.has(r.source))||(root.source&&r.id===root.source)){if(!ids.has(r.id)){ids.add(r.id);changed=true;}if(r.source&&!ids.has(r.source)){ids.add(r.source);changed=true;}}}}return ids;}
async function autoTrashChain(context:Context,root:any,records:any[]){const store=sales();const ids=relatedIds(root,records);const related=records.filter(r=>ids.has(r.id));const protectedRecords=related.filter(r=>r.kind==='proposal'||r.stage==='proposal'||r.stage==='booked'||Boolean(r.booking)||Boolean(r?.accounting?.quickbooks?.invoices?.length));if(protectedRecords.length)return records;const movable=related.filter(r=>['inquiry','lead'].includes(r.kind));if(!movable.length)return records;const now=new Date();let trash:any[]=(await store.get('trash/index',{type:'json'}))||[];let next=records;for(const target of movable){if(!next.some(r=>r.id===target.id))continue;const entry={id:target.id,kind:target.kind,customerName:String(target.customer?.name||'').slice(0,180),customerEmail:String(target.customer?.email||'').slice(0,240),eventDate:String(target.customer?.eventDate||'').slice(0,40),packageId:String(target.packageId||target.quote?.state?.startingPoint||target.inquiry?.venuePackage||target.inquiry?.mobileBarPackage||'').slice(0,80),deletedAt:now.toISOString(),expiresAt:new Date(now.getTime()+30*24*60*60*1000).toISOString(),deletedBy:'system:auto-cleanup'};await store.setJSON('trash/records/'+target.id,target);trash=[entry,...trash.filter(x=>x.id!==target.id)].slice(0,1000);await store.delete('records/'+target.id);next=next.filter(r=>r.id!==target.id);}await store.setJSON('trash/index',trash);await store.setJSON('records/index',next.slice(0,1500));await markLifecycleEvent(context,root,'auto_trashed','High-confidence bogus/test client moved to Trash automatically for 30 days.');return next;}

export default async(_req:Request,context:Context)=>{
  if(context.deploy.context!=='production')return;
  const store=sales();let records:any[]=(await store.get('records/index',{type:'json'}))||[];
  const today=hstDate();
  for(const record of [...records].slice(0,1500)){
    if(!record?.id || !records.some(r=>r.id===record.id))continue;
    const cleanup=assessCrmRecord(record);
    if(cleanup.autoTrash){
      records=await autoTrashChain(context,record,records);
      continue;
    }
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