import type { Context, Config } from '@netlify/functions';
import { requireCapability } from './_shared/admin';
import { runWithTenant } from './_shared/tenant';
import { conditionalTenantStoreFor } from './_shared/tenant-storage';
import { buildCustomerDirectory } from './_shared/customer-directory.mjs';
import { leadOriginEvidence, readLeadSourceCorrections } from './_shared/lead-provenance.mjs';

const headers = { 'Cache-Control':'private, no-store', 'X-Content-Type-Options':'nosniff', Vary:'Cookie, Authorization' };
const validId = (value:string) => /^[a-zA-Z0-9_-]{1,120}$/.test(value);
export default async (req:Request, context:Context) => {
  if(req.method!=='GET') return new Response('Method not allowed',{status:405,headers:{...headers,Allow:'GET'}});
  const auth=await requireCapability('crm.view',req,context);
  if(auth.response)return auth.response;
  const tenant=auth.tenant;
  if(!tenant)return Response.json({error:'Organization access required'},{status:403,headers});
  const url=new URL(req.url);
  const recordId=url.searchParams.get('recordId')||'';
  if(!validId(recordId))return Response.json({error:'A valid CRM record is required'},{status:400,headers});
  const requestedOffset=Number(url.searchParams.get('offset')||0);
  if(!Number.isSafeInteger(requestedOffset)||requestedOffset<0||requestedOffset>1500)
    return Response.json({error:'Invalid page offset'},{status:400,headers});
  return runWithTenant(tenant,async()=>{
    const sales=conditionalTenantStoreFor(context,tenant,'sales');
    const crm=conditionalTenantStoreFor(context,tenant,'crm');
    const snapshot=await sales.readOnlyJSON('records/index');
    const records=Array.isArray(snapshot.data)?snapshot.data:[];
    if(!records.some((entry:any)=>entry?.id===recordId))return Response.json({error:'CRM record not found'},{status:404,headers});
    const directory=buildCustomerDirectory(records,{tenantId:tenant.id});
    const customer=directory.customers.find((row:any)=>row.recordIds.includes(recordId));
    const recordIds=customer?.recordIds||[recordId];
    const pageIds=recordIds.slice(requestedOffset,requestedOffset+20);
    const matches=pageIds.map(id=>records.find((row:any)=>row.id===id)).filter(Boolean);
    const rows=await Promise.all(matches.map(async(record:any)=>{
      const metadata=await crm.readOnlyJSON('projects/'+record.id);
      let events:any[]=[];
      try{events=await readLeadSourceCorrections(crm,record.id);}catch{events=[];}
      const combined=[...(events||[]),...(Array.isArray(metadata.data?.sourceCorrections)?metadata.data.sourceCorrections:[])];
      const eventIds=new Set<string>();
      const corrections=combined.filter((event:any)=>{
        if(!event?.id||eventIds.has(event.id))return false;
        eventIds.add(event.id);return true;
      }).sort((a:any,b:any)=>String(a.at||'').localeCompare(String(b.at||'')));
      const manualHistory=(Array.isArray(record.crmManualHistory)?record.crmManualHistory:[]).map((entry:any)=>({
        action:String(entry.action||''),at:String(entry.at||''),actor:String(entry.actor||''),
        fields:Array.isArray(entry.fields)?entry.fields.map(String):[],
      }));
      return {
        recordId:record.id,
        projectName:String(record.projectName||''),
        recordKind:String(record.kind||''),
        origin:leadOriginEvidence(record),
        corrections,
        manualHistory,
      };
    }));
    const nextOffset=requestedOffset+pageIds.length<recordIds.length?requestedOffset+pageIds.length:null;
    return Response.json({
      ok:true,customerId:customer?.id||'',customerIdentityNeedsReview:Boolean(customer?.needsReview),
      totalRecords:recordIds.length,nextOffset,records:rows,
    },{headers});
  });
};
export const config:Config={path:'/api/admin/crm/lead-origin'};
