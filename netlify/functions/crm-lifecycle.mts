import type { Context, Config } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { ensureLifecycle, markLifecycleEvent } from './_shared/lifecycle';
import { assessCrmRecord, normalizeCleanupMode } from './_shared/crm-cleanup';
import { appendCleanupAudit, cleanupClientSnapshotFromRecord, cleanupDimensionsFromRecord } from './_shared/crm-cleanup-audit';
import { shouldRunScheduledJob } from './_shared/credit-saver';

const HST=-10*60*60*1000;
function hstDate(){return new Date(Date.now()+HST).toISOString().slice(0,10);}
function sales(){return getStore({name:'koa-sales',consistency:'strong'});}
function ops(){return getStore({name:'koa-event-ops',consistency:'strong'});}
function relatedIds(root:any,records:any[]){const ids=new Set([root.id]);if(root.quoteId)records.filter(r=>r.quoteId===root.quoteId).forEach(r=>ids.add(r.id));let changed=true;while(changed){changed=false;for(const r of records){if((r.source&&ids.has(r.source))||(root.source&&r.id===root.source)){if(!ids.has(r.id)){ids.add(r.id);changed=true;}if(r.source&&!ids.has(r.source)){ids.add(r.source);changed=true;}}}}return ids;}
async function autoTrashChain(context:Context,root:any,records:any[]){const store=sales();const ids=relatedIds(root,records);const related=records.filter(r=>ids.has(r.id));const protectedRecords=related.filter(r=>r.kind==='proposal'||r.stage==='proposal'||r.stage==='booked'||Boolean(r.booking)||Boolean(r?.accounting?.quickbooks?.invoices?.length));if(protectedRecords.length)return records;const movable=related.filter(r=>['inquiry','lead'].includes(r.kind));if(!movable.length)return records;const now=new Date();let trash:any[]=(await store.get('trash/index',{type:'json'}))||[];let next=records;for(const target of movable){if(!next.some(r=>r.id===target.id))continue;const entry={id:target.id,kind:target.kind,customerName:String(target.customer?.name||'').slice(0,180),customerEmail:String(target.customer?.email||'').slice(0,240),eventDate:String(target.customer?.eventDate||'').slice(0,40),packageId:String(target.packageId||target.quote?.state?.startingPoint||target.inquiry?.venuePackage||target.inquiry?.mobileBarPackage||'').slice(0,80),deletedAt:now.toISOString(),expiresAt:new Date(now.getTime()+30*24*60*60*1000).toISOString(),deletedBy:'system:auto-cleanup'};await store.setJSON('trash/records/'+target.id,target);trash=[entry,...trash.filter(x=>x.id!==target.id)].slice(0,1000);await store.delete('records/'+target.id);next=next.filter(r=>r.id!==target.id);}await store.setJSON('trash/index',trash);await store.setJSON('records/index',next.slice(0,1500));await markLifecycleEvent(context,root,'auto_trashed','High-confidence bogus/test client moved to Trash automatically for 30 days.');return next;}

export default async(_req:Request,context:Context)=>{
  if(context.deploy.context!=='production')return;
  if(!(await shouldRunScheduledJob(context,'crm-lifecycle')))return;
  const store=sales();let records:any[]=(await store.get('records/index',{type:'json'}))||[];
  const settings:any=(await store.get('settings/crm-cleanup',{type:'json'}))||{mode:'auto_trash'};
  const cleanupMode=normalizeCleanupMode(settings.mode);
  const today=hstDate();
  for(const record of [...records].slice(0,1500)){
    if(!record?.id || !records.some(r=>r.id===record.id))continue;
    const cleanup=assessCrmRecord(record);
    const classificationKey=[record.id,cleanup.disposition,cleanup.score,...cleanup.reasonCodes].join('|');
    if(cleanup.autoTrash && cleanupMode==='auto_trash'){
      await appendCleanupAudit(context,{
        recordId:record.id,
        action:'auto_trashed',
        actor:'system',
        detail:'High-confidence bogus/test client automatically moved to 30-day Trash.',
        score:cleanup.score,
        reasons:cleanup.reasons,
        chainIds:[record.id],
        dedupeKey:'auto-trash|'+classificationKey,
        dimensions:cleanupDimensionsFromRecord(record),client:cleanupClientSnapshotFromRecord(record),
      });
      records=await autoTrashChain(context,record,records);
      continue;
    }
    if((cleanup.disposition==='review'||cleanup.disposition==='auto_trash') && !cleanup.approvedLegitimate){
      await appendCleanupAudit(context,{
        recordId:record.id,
        action:'auto_flagged',
        actor:'system',
        detail:'Client automatically flagged for review under cleanup policy '+cleanupMode+'.',
        score:cleanup.score,
        reasons:cleanup.reasons,
        dedupeKey:'auto-flag|'+classificationKey+'|'+cleanupMode,
        dimensions:cleanupDimensionsFromRecord(record),client:cleanupClientSnapshotFromRecord(record),
      });
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
export const config:Config={schedule:'0 */6 * * *'};