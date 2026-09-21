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

export type CleanupDimensions = {
  websiteForm:string;
  referralSource:string;
  emailDomain:string;
  brand:string;
  securityReasons:string[];
};

export type CleanupClientSnapshot = {
  name:string;
  email:string;
  eventDate:string;
  kind:string;
};

export type CleanupAuditEntry = {
  id:string;
  recordId:string;
  action:CleanupAuditAction;
  actor:string;
  detail:string;
  score:number;
  reasons:string[];
  chainIds:string[];
  dimensions?:CleanupDimensions;
  client?:CleanupClientSnapshot;
  createdAt:string;
  dedupeKey:string;
};

function clean(v:unknown,max=1000){return String(v??'').trim().slice(0,max);}
export function cleanupClientSnapshotFromRecord(record:any):CleanupClientSnapshot{
  return {
    name:clean(record?.customer?.name,180)||'Unnamed client',
    email:clean(record?.customer?.email,240),
    eventDate:clean(record?.customer?.eventDate,40),
    kind:clean(record?.kind,40)||'record',
  };
}
export function cleanupDimensionsFromRecord(record:any):CleanupDimensions{
  const email=clean(record?.customer?.email,240).toLowerCase();
  const emailDomain=email.includes('@')?email.split('@').pop()||'':'';
  const websiteForm=clean(record?.inquiry?.formName||record?.source||'Unknown',120)||'Unknown';
  const referralSource=clean(record?.inquiry?.referralSource||record?.inquiry?.source||'Unknown',160)||'Unknown';
  const mobile=String(record?.packageId||'').toLowerCase().startsWith('mobile-') ||
    /mobile[ -]?bar/i.test(String(record?.inquiry?.service||'')) ||
    /mobile/i.test(websiteForm);
  const securityReasons=Array.isArray(record?.security?.reasonCodes)
    ? record.security.reasonCodes.map((x:any)=>clean(x,120)).filter(Boolean).slice(0,20)
    : [];
  return {
    websiteForm,
    referralSource,
    emailDomain:emailDomain||'Unknown',
    brand:mobile?'Koa’s Mobile Bar':'Koa’s Events',
    securityReasons,
  };
}
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
    dimensions?:CleanupDimensions;
    client?:CleanupClientSnapshot;
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
    dimensions:input.dimensions ? {
      websiteForm:clean(input.dimensions.websiteForm,120)||'Unknown',
      referralSource:clean(input.dimensions.referralSource,160)||'Unknown',
      emailDomain:clean(input.dimensions.emailDomain,160)||'Unknown',
      brand:clean(input.dimensions.brand,80)||'Unknown',
      securityReasons:Array.isArray(input.dimensions.securityReasons)?input.dimensions.securityReasons.map(x=>clean(x,120)).filter(Boolean).slice(0,20):[],
    } : undefined,
    client:input.client ? {
      name:clean(input.client.name,180)||'Unnamed client',
      email:clean(input.client.email,240),
      eventDate:clean(input.client.eventDate,40),
      kind:clean(input.client.kind,40)||'record',
    } : undefined,
    createdAt:new Date().toISOString(),
    dedupeKey,
  };
  await store.setJSON('cleanup-audit/index',[row,...current].slice(0,5000));
  return row;
}