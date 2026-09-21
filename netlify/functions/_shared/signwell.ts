import type { Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';

const API='https://www.signwell.com/api/v1';
const clean=(v:unknown,max=4000)=>String(v??'').trim().slice(0,max);
const esc=(v:unknown)=>clean(v,20000).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m] as string));

export function signWellConfigured(){
  return Boolean(String(Netlify.env.get('SIGNWELL_API_KEY')||'').trim());
}
function headers(){return {'X-Api-Key':String(Netlify.env.get('SIGNWELL_API_KEY')||'').trim(),'Content-Type':'application/json'};}
async function sw(path:string,init:RequestInit={}){
  const res=await fetch(API+path,{...init,headers:{...headers(),...(init.headers||{})}});
  const text=await res.text();
  const body=text?JSON.parse(text):{};
  if(!res.ok) throw new Error(clean(body?.message||body?.error||('SignWell '+res.status),500));
  return body;
}
function contractHtml(record:any){
  const sections=record?.booking?.contract?.sections||[];
  const title=record?.booking?.contract?.title||'Koa’s Events Agreement';
  return '<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;color:#17231d;line-height:1.55;padding:28px}h1{font-size:26px}h2{font-size:17px;margin-top:24px}.meta{padding:14px;background:#f6f0e7;margin:18px 0}.sig{color:white;font-size:18px}</style></head><body>'+
    '<h1>'+esc(title)+'</h1><div class="meta"><strong>Client:</strong> '+esc(record?.customer?.name)+'<br><strong>Event date:</strong> '+esc(record?.customer?.eventDate)+'<br><strong>Proposal total:</strong> $'+Number(record?.proposal?.total||0).toFixed(2)+'</div>'+
    sections.map((s:any)=>'<h2>'+esc(s.heading)+'</h2><p>'+esc(s.body)+'</p>').join('')+
    '<h2>Electronic signatures</h2><p>Client signature:</p><div class="sig">{{signature:1:y}}</div><p>Date signed:</p><div class="sig">{{date:1:y}}</div>'+
    '<p>Koa’s Events authorized signature:</p><div class="sig">{{signature:2:y}}</div><p>Date signed:</p><div class="sig">{{date:2:y}}</div>'+
    '</body></html>';
}
export async function createSignWellContract(record:any,origin:string){
  if(!signWellConfigured()) return {configured:false};
  const clientEmail=clean(record?.customer?.email,240);
  if(!clientEmail) throw new Error('Client email is required for SignWell.');
  const koaEmail=clean(Netlify.env.get('SIGNWELL_KOA_SIGNER_EMAIL')||'aloha@koasevents.com',240);
  const koaName=clean(Netlify.env.get('SIGNWELL_KOA_SIGNER_NAME')||'Koa’s Events',180);
  const testMode=String(Netlify.env.get('SIGNWELL_TEST_MODE')||'false').toLowerCase()==='true';
  const html=contractHtml(record);
  const fileBase64=btoa(unescape(encodeURIComponent(html)));
  const payload={
    test_mode:testMode,draft:false,name:(record.booking?.contract?.title||'Koa’s Events Agreement')+' · '+(record.customer?.name||record.id),
    subject:'Your Koa’s Events agreement is ready to sign',
    message:'Aloha '+(record.customer?.name||'')+', please review and sign your Koa’s Events agreement.',
    files:[{name:'Koa-Agreement-'+record.id+'.html',file_base64:fileBase64}],
    recipients:[
      {id:'1',name:clean(record.customer?.name,180),email:clientEmail},
      {id:'2',name:koaName,email:koaEmail}
    ],
    apply_signing_order:true,embedded_signing:true,embedded_signing_notifications:true,text_tags:true,
    reminders:true,expires_in:14,allow_decline:true,allow_reassign:false,
    redirect_url:origin+'/portal/?token='+encodeURIComponent(record.proposal?.publicToken||''),
    metadata:{record_id:record.id,quote_id:record.quoteId||'',public_token:record.proposal?.publicToken||''},
    custom_requester_name:'Koa’s Events',custom_requester_email:'aloha@koasevents.com'
  };
  const doc=await sw('/documents',{method:'POST',body:JSON.stringify(payload)});
  return {configured:true,documentId:String(doc.id||''),status:String(doc.status||''),recipients:doc.recipients||[],embeddedSigningUrl:String(doc.recipients?.[0]?.embedded_signing_url||doc.embedded_signing_url||''),raw:doc};
}
export async function getCompletedPdf(documentId:string){
  const key=String(Netlify.env.get('SIGNWELL_API_KEY')||'').trim();
  const res=await fetch(API+'/documents/'+encodeURIComponent(documentId)+'/completed_pdf?file_format=pdf&audit_page=true',{headers:{'X-Api-Key':key}});
  if(!res.ok) throw new Error('Completed SignWell PDF is not ready.');
  return await res.arrayBuffer();
}
export function eventStoreFor(context:Context){
  return context.deploy.context==='production'?getStore({name:'koa-event-files',consistency:'strong'}):getDeployStore({name:'koa-event-files'});
}
