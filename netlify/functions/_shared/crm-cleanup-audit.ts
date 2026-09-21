import type { Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';

export type CleanupAuditAction =
  | 'auto_flagged'
  | 'manual_flagged'
  | 'approved_legitimate'
  | 'review_reset'
  | 'moved_to_trash'
  | 'bulk_moved_to_trash'
  | 'auto_trashed'
  | 'restored'
  | 'permanently_deleted'
  | 'policy_changed';

export type CleanupAuditEntry = {
  id:string;
  recordId:string;
  action:CleanupAuditAction;
  actor:string;
  detail:string;
  score:number;
  reasons:string[];
  chainIds:string[];
  createdAt:string;
  dedupeKey:string;
};

function clean(v:unknown,max=1000){return String(v??'').trim().slice(0,max);}
function storeFor(context:Context){
  return context.deploy.context==='production'
    ? getStore({name:'koa-crm',consistency:'strong'})
    : getDeployStore({name:'koa-crm'});
}
function id(){return 'AUD-'+crypto.randomUUID().replaceAll('-','').slice(0,16).toUpperCase();}

export async function readCleanupAudit(context:Context,limit=1000){
  const store=storeFor(context);
  const rows=((await store.get('cleanup-audit/index',{type:'json'}))||[]) as CleanupAuditEntry[];
  return rows.slice(0,Math.max(1,Math.min(5000,limit)));
}

export async function appendCleanupAudit(
  context:Context,
  input:{
    recordId?:string;
    action:CleanupAuditAction;
    actor?:string;
    detail?:string;
    score?:number;
    reasons?:string[];
    chainIds?:string[];
    dedupeKey?:string;
  },
){
  const store=storeFor(context);
  const current=((await store.get('cleanup-audit/index',{type:'json'}))||[]) as CleanupAuditEntry[];
  const dedupeKey=clean(input.dedupeKey,500);
  if(dedupeKey && current.some(row=>row.dedupeKey===dedupeKey)) return null;

  const row:CleanupAuditEntry={
    id:id(),
    recordId:clean(input.recordId,100),
    action:input.action,
    actor:clean(input.actor||'system',240),
    detail:clean(input.detail,1000),
    score:Math.max(0,Math.min(100,Math.round(Number(input.score)||0))),
    reasons:Array.isArray(input.reasons)?input.reasons.map(x=>clean(x,220)).filter(Boolean).slice(0,16):[],
    chainIds:Array.isArray(input.chainIds)?input.chainIds.map(x=>clean(x,100)).filter(Boolean).slice(0,100):[],
    createdAt:new Date().toISOString(),
    dedupeKey,
  };
  await store.setJSON('cleanup-audit/index',[row,...current].slice(0,5000));
  return row;
}