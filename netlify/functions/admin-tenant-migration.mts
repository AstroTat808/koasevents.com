import type { Context, Config } from '@netlify/functions';
import { createHash } from 'node:crypto';
import { requireAdmin } from './_shared/admin';
import { resolveTenant } from './_shared/tenant';
import { backfillTenantRows, tenantIdOf, tenantStore } from './_shared/tenant-storage';

function hash(value:any){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function clean(v:unknown,max=200){return String(v??'').trim().slice(0,max);}

const INDEXES=[
  {kind:'sales' as const,key:'records/index'},
  {kind:'sales' as const,key:'trash/index'},
  {kind:'crm' as const,key:'tasks/index'},
  {kind:'crm' as const,key:'appointments/index'},
  {kind:'crm' as const,key:'notes/index'},
  {kind:'crm' as const,key:'workflows/index'},
  {kind:'crm' as const,key:'enrollments/index'},
  {kind:'crm' as const,key:'templates/index'},
  {kind:'crm' as const,key:'projects/index'},
  {kind:'crm' as const,key:'activity/index'},
  {kind:'crm' as const,key:'client-messages/index'},
  {kind:'vendors' as const,key:'vendors/index'},
  {kind:'vendors' as const,key:'reviews/index'},
  {kind:'vendors' as const,key:'requests/index'},
];

async function inspectIndex(context:Context,tenant:any,spec:any){
  const store=tenantStore(context,spec.kind,tenant);
  const rows=((await store.get(spec.key,{type:'json'}))||[]) as any[];
  const missing=rows.filter((row)=>!tenantIdOf(row)).length;
  const foreign=rows.filter((row)=>tenantIdOf(row)&&tenantIdOf(row)!==tenant.id).length;
  return {spec,store,rows,missing,foreign,beforeHash:hash(rows)};
}

async function inspectEventOps(context:Context,tenant:any){
  const store=tenantStore(context,'eventOps',tenant);
  const listing:any=await store.list({prefix:'events/'});
  const blobs=Array.isArray(listing?.blobs)?listing.blobs:[];
  const rows:any[]=[];
  for(const blob of blobs.slice(0,5000)){
    const key=String(blob?.key||'');
    if(!key||key.endsWith('/__health__'))continue;
    const value=await store.get(key,{type:'json'});
    if(value)rows.push({key,value});
  }
  return {
    store,
    rows,
    missing:rows.filter((row)=>!tenantIdOf(row.value)).length,
    foreign:rows.filter((row)=>tenantIdOf(row.value)&&tenantIdOf(row.value)!==tenant.id).length,
  };
}

export default async(req:Request,context:Context)=>{
  const auth=await requireAdmin(req);
  if(auth.response)return auth.response;
  const tenant=resolveTenant(req);
  const url=new URL(req.url);
  const action=req.method==='GET'?'preview':clean((await req.json().catch(()=>null) as any)?.action,40);
  if(!['preview','apply'].includes(action))return Response.json({error:'Use preview or apply.'},{status:400});

  const inspected=await Promise.all(INDEXES.map((spec)=>inspectIndex(context,tenant,spec)));
  const eventOps=await inspectEventOps(context,tenant);
  const foreignCount=inspected.reduce((sum,row)=>sum+row.foreign,0)+eventOps.foreign;
  const missingCount=inspected.reduce((sum,row)=>sum+row.missing,0)+eventOps.missing;
  const preview={
    tenantId:tenant.id,
    generatedAt:new Date().toISOString(),
    indexes:inspected.map((row)=>({store:row.spec.kind,key:row.spec.key,count:row.rows.length,missingTenantId:row.missing,foreignTenantId:row.foreign,hash:row.beforeHash})),
    eventOps:{count:eventOps.rows.length,missingTenantId:eventOps.missing,foreignTenantId:eventOps.foreign},
    missingTenantId:missingCount,
    foreignTenantId:foreignCount,
    safeToApply:foreignCount===0,
  };

  if(action==='preview')return Response.json({preview},{headers:{'Cache-Control':'private, no-store'}});
  if(foreignCount>0)return Response.json({error:'Migration blocked because records owned by another tenant were detected.',preview},{status:409});

  const migrationId='TENANT-MIG-'+Date.now();
  const snapshotStore=tenantStore(context,'integrations',tenant);
  const applied:any[]=[];

  for(const row of inspected){
    if(!row.missing)continue;
    await snapshotStore.setJSON('tenant-migrations/'+migrationId+'/'+row.spec.kind+'/'+row.spec.key.replaceAll('/','__'),row.rows);
    const backfill=backfillTenantRows(row.rows,tenant);
    await row.store.setJSON(row.spec.key,backfill.rows);
    applied.push({store:row.spec.kind,key:row.spec.key,changed:backfill.changed,beforeHash:row.beforeHash,afterHash:hash(backfill.rows)});
  }

  for(const row of eventOps.rows){
    if(tenantIdOf(row.value))continue;
    await snapshotStore.setJSON('tenant-migrations/'+migrationId+'/eventOps/'+row.key.replaceAll('/','__'),row.value);
    await eventOps.store.setJSON(row.key,{...row.value,tenant_id:tenant.id});
    applied.push({store:'eventOps',key:row.key,changed:1});
  }

  const verification=await Promise.all(INDEXES.map((spec)=>inspectIndex(context,tenant,spec)));
  const verificationEventOps=await inspectEventOps(context,tenant);
  const remainingMissing=verification.reduce((sum,row)=>sum+row.missing,0)+verificationEventOps.missing;
  const result={
    migrationId,
    tenantId:tenant.id,
    appliedAt:new Date().toISOString(),
    applied,
    remainingMissing,
    verified:remainingMissing===0,
  };
  await snapshotStore.setJSON('tenant-migrations/'+migrationId+'/result',result);
  return Response.json({ok:result.verified,result},{headers:{'Cache-Control':'private, no-store'}});
};

export const config:Config={path:'/api/admin/tenant-migration'};