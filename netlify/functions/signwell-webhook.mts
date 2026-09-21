import type { Context, Config } from '@netlify/functions';
import { getDeployStore,getStore } from '@netlify/blobs';
import { getCompletedPdf, eventStoreFor } from './_shared/signwell';
import { markLifecycleEvent } from './_shared/lifecycle';

function sales(context:Context){return context.deploy.context==='production'?getStore({name:'koa-sales',consistency:'strong'}):getDeployStore({name:'koa-sales'});}
function clean(v:unknown,max=1000){return String(v??'').trim().slice(0,max);}
function id(){return 'EVT-'+crypto.randomUUID().replaceAll('-','').slice(0,12).toUpperCase();}
async function appendEvent(context:Context,event:any){const s=sales(context);const current:any[]=(await s.get('analytics/events/index',{type:'json'}))||[];await s.setJSON('analytics/events/index',[{id:id(),createdAt:new Date().toISOString(),...event},...current].slice(0,10000));}
function docId(payload:any){return clean(payload?.data?.object?.id||payload?.data?.document?.id||payload?.document?.id||payload?.data?.id||payload?.document_id||payload?.id,120);}
function eventName(payload:any){return clean(payload?.event?.type||payload?.event||payload?.event_type||payload?.type||payload?.data?.event,120).toLowerCase();}
function recipients(payload:any){return payload?.data?.object?.recipients||payload?.data?.document?.recipients||payload?.document?.recipients||payload?.data?.recipients||[];}

export default async(req:Request,context:Context)=>{
  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  const url=new URL(req.url);
  const expected=String(Netlify.env.get('SIGNWELL_WEBHOOK_TOKEN')||'').trim();
  if(!expected||url.searchParams.get('token')!==expected)return new Response('Unauthorized',{status:401});
  const payload:any=await req.json().catch(()=>null);
  if(!payload)return new Response('Invalid JSON',{status:400});
  const documentId=docId(payload); if(!documentId)return new Response(null,{status:200});
  const store=sales(context); const records:any[]=(await store.get('records/index',{type:'json'}))||[];
  const record=records.find(r=>String(r?.booking?.contract?.signwell?.documentId||'')===documentId);
  if(!record)return new Response(null,{status:200});
  const name=eventName(payload), now=new Date().toISOString();
  const sw=record.booking.contract.signwell||(record.booking.contract.signwell={});
  sw.lastWebhookEvent=name; sw.lastWebhookAt=now;
  if(name.includes('view')) sw.status='viewed';
  if(name.includes('declin')||name.includes('cancel')) sw.status='declined';
  if(name.includes('sign')) sw.status='signing';
  const completed=name.includes('complete')||name==='document_completed'||name==='completed';
  if(completed){
    sw.status='completed';sw.completedAt=now;
    const rs=Array.isArray(recipients(payload))?recipients(payload):[];
    const client=rs[0]||{}, koa=rs[1]||{};
    record.booking.contract.status='signed';
    record.booking.contract.signature={name:clean(client.name||record.customer?.name,180),signedAt:clean(client.signed_at||client.completed_at||now,80),acknowledgement:'Signed through SignWell.'};
    record.booking.contract.koaSignature={name:clean(koa.name||Netlify.env.get('SIGNWELL_KOA_SIGNER_NAME')||'Koa’s Events',180),signedAt:clean(koa.signed_at||koa.completed_at||now,80)};
    record.booking.status=record?.accounting?.quickbooks?.depositPaid?'booked':'deposit_pending';
    if(record?.accounting?.quickbooks?.depositPaid){record.stage='booked';record.status='booked';record.proposal.status='booked';}
    try{
      const pdf=await getCompletedPdf(documentId);
      const key='signed-contracts/'+record.id+'/agreement.pdf';
      await eventStoreFor(context).set(key,pdf);
      sw.signedPdfStored=true;sw.signedPdfKey=key;sw.signedPdfStoredAt=now;
    }catch(error){sw.signedPdfStored=false;sw.pdfError=error instanceof Error?error.message:'Unable to store completed PDF';}
    await appendEvent(context,{type:'signwell_contract_completed',recordId:record.id,quoteId:record.quoteId||'',packageId:record.packageId||'',detail:'SignWell agreement completed by all required signers and synchronized to the CRM.',reference:documentId});
    await markLifecycleEvent(context,record,'contract_completed','SignWell contract completed; booking awaits deposit if not already paid.');
  }
  record.updatedAt=now;
  const next=records.map(r=>r.id===record.id?record:r);
  await store.setJSON('records/'+record.id,record);await store.setJSON('records/index',next.slice(0,1500));
  return new Response(null,{status:200});
};
export const config:Config={path:'/api/webhooks/signwell'};
