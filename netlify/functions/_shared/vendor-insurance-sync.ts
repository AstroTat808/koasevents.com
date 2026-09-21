import type { Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';

function store(context:Context,name:string){
  return context.deploy.context==='production'
    ? getStore({name,consistency:'strong'})
    : getDeployStore({name});
}
function cleanDate(value:unknown){
  const raw=String(value||'').trim().slice(0,10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw)?raw:'';
}
export function todayHst(){
  return new Date(Date.now()-10*60*60*1000).toISOString().slice(0,10);
}
export function masterInsuranceForEvent(vendor:any,eventDateValue:unknown){
  const insurance=vendor?.insurance||{};
  const eventDate=cleanDate(eventDateValue);
  const expiresAt=cleanDate(insurance.expiresAt);
  const hasDocument=Boolean(insurance.document?.id);
  const rejected=Boolean(insurance.rejectionReason)&&insurance.status!=='approved';
  let status='not_requested';
  let issue='';

  if(rejected){status='requested';issue='rejected';}
  else if(insurance.status==='received'){status='received';issue='pending_review';}
  else if(insurance.status==='requested'){status='requested';issue='requested';}
  else if(insurance.status==='expired'){status='requested';issue='expired';}
  else if(insurance.status==='approved'){
    if(!expiresAt){status='requested';issue='missing_expiration';}
    else if(eventDate&&expiresAt<eventDate){status='requested';issue='expires_before_event';}
    else if(expiresAt<todayHst()){status='requested';issue='expired';}
    else{status='approved';issue='';}
  } else if(hasDocument){status='received';issue='pending_review';}
  else{status='not_requested';issue='missing_certificate';}

  return {
    status,
    issue,
    expiresAt,
    verifiedAt:String(insurance.verifiedAt||''),
    documentId:String(insurance.document?.id||''),
    covered:status==='approved',
  };
}

export async function syncVendorInsuranceToUpcomingEvents(context:Context,vendor:any){
  const salesStore=store(context,'koa-sales');
  const opsStore=store(context,'koa-event-ops');
  const records:any[]=(await salesStore.get('records/index',{type:'json'}))||[];
  const today=todayHst();
  const updated:any[]=[];

  for(const record of records){
    if(record?.stage!=='booked'||record?.kind!=='proposal')continue;
    const eventDate=cleanDate(record?.customer?.eventDate);
    if(eventDate&&eventDate<today)continue;
    const ops:any=await opsStore.get('events/'+record.id,{type:'json'});
    if(!ops||!Array.isArray(ops.vendors))continue;
    let changed=false;
    const result=masterInsuranceForEvent(vendor,eventDate);
    ops.vendors=ops.vendors.map((row:any)=>{
      if(String(row?.marketplaceVendorId||'')!==String(vendor?.id||''))return row;
      const next={
        ...row,
        insuranceStatus:result.status,
        insuranceSource:'vendor_master',
        insuranceExpiresAt:result.expiresAt,
        insuranceVerifiedAt:result.verifiedAt,
        insuranceIssue:result.issue,
        insuranceSyncedAt:new Date().toISOString(),
      };
      if(
        row.insuranceStatus!==next.insuranceStatus||
        row.insuranceExpiresAt!==next.insuranceExpiresAt||
        row.insuranceIssue!==next.insuranceIssue||
        row.insuranceVerifiedAt!==next.insuranceVerifiedAt
      ) changed=true;
      return next;
    });
    if(changed){
      ops.updatedAt=new Date().toISOString();
      await opsStore.setJSON('events/'+record.id,ops);
      updated.push({recordId:record.id,eventDate,customerName:String(record.customer?.name||''),status:result.status,issue:result.issue,covered:result.covered});
    }
  }
  return updated;
}
