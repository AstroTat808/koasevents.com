import type { Context } from '@netlify/functions';
import { resolveTenant } from './tenant';
import { tenantStoreFor } from './tenant-storage';
import { createHmac, timingSafeEqual } from 'node:crypto';

const API='https://www.signwell.com/api/v1';
const WEBHOOK_TOLERANCE_SECONDS=300;
const clean=(v:unknown,max=4000)=>String(v??'').trim().slice(0,max);
const esc=(v:unknown)=>clean(v,20000).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m] as string));
const wait=(ms:number)=>new Promise((resolve)=>setTimeout(resolve,ms));

function salesStoreFor(context:Context){
  return context.deploy.context==='production'
    ? getStore({name:'koa-sales',consistency:'strong'})
    : getDeployStore({name:'koa-sales'});
}

function healthStoreFor(context:Context){
  return context.deploy.context==='production'
    ? getStore({name:'koa-system-health',consistency:'strong'})
    : getDeployStore({name:'koa-system-health'});
}

function apiKey(){
  return clean(Netlify.env.get('SIGNWELL_API_KEY'),1200);
}

export function signWellWebhookId(){
  return clean(Netlify.env.get('SIGNWELL_WEBHOOK_ID'),240);
}

export function signWellWebhookEndpoint(){
  const tenant=resolveTenant();
  const origin=clean(Netlify.env.get('URL'),500)||('https://'+tenant.domains.primary);
  return origin.replace(/\/$/,'')+'/api/webhooks/signwell';
}

export function signWellConfiguration(){
  const key=apiKey();
  const webhookId=signWellWebhookId();
  return {
    apiKeyConfigured:Boolean(key),
    webhookIdConfigured:Boolean(webhookId),
    webhookId,
    webhookEndpoint:signWellWebhookEndpoint(),
    koaSignerEmail:clean(Netlify.env.get('SIGNWELL_KOA_SIGNER_EMAIL')||tenant.contact.email,240),
    koaSignerName:clean(Netlify.env.get('SIGNWELL_KOA_SIGNER_NAME')||tenant.displayName,180),
    testMode:String(Netlify.env.get('SIGNWELL_TEST_MODE')||'false').toLowerCase()==='true',
  };
}

export function signWellConfigured(){
  return Boolean(apiKey()&&signWellWebhookId());
}

function headers(){
  return {'X-Api-Key':apiKey(),'Content-Type':'application/json','Accept':'application/json'};
}

async function signWellJson(path:string,init:RequestInit={}){
  const started=Date.now();
  try{
    const response=await fetch(API+path,{
      ...init,
      headers:{...headers(),...(init.headers||{})},
      signal:AbortSignal.timeout(10000),
    });
    const text=await response.text();
    let body:any={};
    if(text){
      try{body=JSON.parse(text);}catch{body={raw:clean(text,1000)};}
    }
    return {ok:response.ok,status:response.status,body,ms:Date.now()-started,error:''};
  }catch(error){
    return {
      ok:false,
      status:0,
      body:{},
      ms:Date.now()-started,
      error:error instanceof Error?clean(error.message,800):'SignWell request failed.',
    };
  }
}

async function sw(path:string,init:RequestInit={}){
  const result=await signWellJson(path,init);
  if(!result.ok){
    throw new Error(clean(result.body?.message||result.body?.error||result.error||('SignWell '+result.status),500));
  }
  return result.body;
}

function hookRows(body:any){
  if(Array.isArray(body))return body;
  if(Array.isArray(body?.data))return body.data;
  if(Array.isArray(body?.hooks))return body.hooks;
  if(Array.isArray(body?.webhooks))return body.webhooks;
  return [];
}

export function verifySignWellWebhookEvent(payload:any,toleranceSeconds=WEBHOOK_TOLERANCE_SECONDS){
  const webhookId=signWellWebhookId();
  if(!webhookId)return {ok:false,error:'SIGNWELL_WEBHOOK_ID is not configured.',eventType:'',eventTime:0,eventHash:'',replayKey:''};

  const event=payload?.event;
  const eventTypeRaw=clean(event?.type,160);
  const eventType=eventTypeRaw.toLowerCase();
  const eventTime=Number(event?.time||0);
  const eventHash=clean(event?.hash,200).toLowerCase();
  if(!eventTypeRaw||!Number.isFinite(eventTime)||eventTime<=0||!/^[0-9a-f]{64}$/i.test(eventHash)){
    return {ok:false,error:'SignWell event metadata is incomplete or malformed.',eventType,eventTime,eventHash,replayKey:''};
  }

  const ageSeconds=Math.abs(Math.floor(Date.now()/1000)-eventTime);
  if(ageSeconds>Math.max(30,Number(toleranceSeconds||WEBHOOK_TOLERANCE_SECONDS))){
    return {ok:false,error:'SignWell event timestamp is outside the allowed verification window.',eventType,eventTime,eventHash,replayKey:''};
  }

  const expected=createHmac('sha256',webhookId).update(eventTypeRaw+'@'+String(eventTime),'utf8').digest('hex');
  const expectedBytes=Buffer.from(expected,'hex');
  const receivedBytes=Buffer.from(eventHash,'hex');
  const valid=expectedBytes.length===receivedBytes.length&&timingSafeEqual(expectedBytes,receivedBytes);
  return {
    ok:valid,
    error:valid?'':'SignWell webhook HMAC verification failed.',
    eventType,
    eventTime,
    eventHash,
    replayKey:valid?'signwell/replay/'+eventHash:'',
  };
}

export async function signWellWebhookReplaySeen(context:Context,verification:any){
  const key=clean(verification?.replayKey,300);
  if(!key)return false;
  return Boolean(await healthStoreFor(context).get(key,{type:'json'}));
}

export async function recordSignWellWebhookReplay(context:Context,verification:any){
  const key=clean(verification?.replayKey,300);
  if(!key)return null;
  const row={
    receivedAt:new Date().toISOString(),
    eventType:clean(verification?.eventType,160),
    eventTime:Number(verification?.eventTime||0),
    eventHash:clean(verification?.eventHash,200),
  };
  await healthStoreFor(context).setJSON(key,row);
  return row;
}

export async function recordSignWellWebhookReceipt(context:Context,input:any){
  const row={
    receivedAt:new Date().toISOString(),
    eventType:clean(input?.eventType,160),
    eventTime:Number(input?.eventTime||0),
    documentId:clean(input?.documentId,180),
    hmacVerified:true,
    requestId:clean(input?.requestId,180),
  };
  await healthStoreFor(context).setJSON('signwell/webhook-last-receipt',row);
  return row;
}

export async function recordSignWellSyntheticReceipt(context:Context,input:any){
  const row={
    receivedAt:new Date().toISOString(),
    eventType:clean(input?.eventType,160),
    hmacVerified:true,
    requestId:clean(input?.requestId,180),
  };
  await healthStoreFor(context).setJSON('signwell/webhook-last-synthetic',row);
  return row;
}

export async function readSignWellWebhookReceipt(context:Context){
  return ((await healthStoreFor(context).get('signwell/webhook-last-receipt',{type:'json'}))||null) as any;
}

async function verifyLatestSignedPdf(context:Context){
  const key=apiKey();
  if(!key){
    return {available:false,ok:false,status:0,recordId:'',documentId:'',detail:'SIGNWELL_API_KEY is not configured.'};
  }
  const records:any[]=((await salesStoreFor(context).get('records/index',{type:'json'}))||[]) as any[];
  const candidates=records
    .filter((record:any)=>{
      const sw=record?.booking?.contract?.signwell||{};
      return Boolean(sw?.documentId)&&(
        record?.booking?.contract?.status==='signed'
        || sw?.status==='completed'
        || sw?.signedPdfStored===true
      );
    })
    .sort((a:any,b:any)=>{
      const aAt=Date.parse(String(a?.booking?.contract?.signwell?.completedAt||a?.updatedAt||''));
      const bAt=Date.parse(String(b?.booking?.contract?.signwell?.completedAt||b?.updatedAt||''));
      return (Number.isFinite(bAt)?bAt:0)-(Number.isFinite(aAt)?aAt:0);
    });
  const record=candidates[0]||null;
  if(!record){
    return {
      available:false,
      ok:true,
      status:0,
      recordId:'',
      documentId:'',
      detail:'No completed SignWell agreement exists yet, so completed-PDF retrieval has not been exercised.',
    };
  }

  const documentId=clean(record?.booking?.contract?.signwell?.documentId,180);
  const result=await signWellJson('/documents/'+encodeURIComponent(documentId)+'/completed_pdf?url_only=true&audit_page=true&file_format=pdf');
  return {
    available:true,
    ok:result.ok,
    status:result.status,
    recordId:clean(record?.id,180),
    documentId,
    detail:result.ok
      ? 'Completed PDF retrieval succeeded for the most recent signed agreement.'
      : clean(result.body?.message||result.body?.error||result.error||'Completed PDF retrieval failed.',800),
  };
}

export async function verifySignWellCredentials(context:Context){
  const config=signWellConfiguration();
  const lastWebhook=await readSignWellWebhookReceipt(context);
  if(!config.apiKeyConfigured){
    return {
      configured:false,
      ok:false,
      status:0,
      detail:'SIGNWELL_API_KEY is not configured. The booking signature workflow cannot create SignWell agreements.',
      api:{configured:false,ok:false,status:0},
      webhook:{idConfigured:config.webhookIdConfigured,registered:false,endpointMatch:false,status:0,endpoint:config.webhookEndpoint,id:config.webhookId},
      delivery:{verified:false,lastWebhookAt:'',eventType:'',documentId:''},
      signedPdf:{available:false,ok:false,status:0,detail:'SignWell API key is required before completed-PDF retrieval can be verified.'},
      configuration:config,
    };
  }

  const [me,hooks,pdf]=await Promise.all([
    signWellJson('/me'),
    signWellJson('/hooks'),
    verifyLatestSignedPdf(context),
  ]);
  const rows=hookRows(hooks.body);
  const configuredHook=config.webhookId
    ? rows.find((row:any)=>clean(row?.id,240)===config.webhookId)
    : null;
  const endpoint=clean(configuredHook?.callback_url||configuredHook?.url,600);
  const registered=Boolean(configuredHook);
  const endpointMatch=registered&&endpoint===config.webhookEndpoint;
  const apiOk=Boolean(me.ok);
  const registrationOk=Boolean(hooks.ok&&config.webhookIdConfigured&&registered&&endpointMatch);
  const deliveryVerified=Boolean(lastWebhook?.hmacVerified&&lastWebhook?.receivedAt);
  const pdfFailed=Boolean(pdf.available&&!pdf.ok);
  const ok=apiOk&&registrationOk&&!pdfFailed;

  const detailParts=[
    apiOk?'API key verified with GET /me':'API key verification failed'+(me.status?' with HTTP '+me.status:''),
    config.webhookIdConfigured?'webhook ID configured':'SIGNWELL_WEBHOOK_ID missing',
    registered?'configured webhook ID exists in SignWell':'configured webhook ID not found in SignWell',
    endpointMatch?'callback matches '+config.webhookEndpoint:(registered?'callback does not match '+config.webhookEndpoint:'callback not verified'),
    deliveryVerified?'last verified webhook received '+String(lastWebhook.receivedAt):'no verified production webhook delivery recorded yet',
    pdf.available?(pdf.ok?'completed-PDF retrieval verified':'completed-PDF retrieval failed'):'completed-PDF retrieval not exercised yet',
  ];

  return {
    configured:config.apiKeyConfigured&&config.webhookIdConfigured,
    ok,
    status:!apiOk?me.status:!registrationOk?hooks.status||503:pdfFailed?pdf.status||503:200,
    detail:clean(detailParts.join(' · '),1200),
    api:{
      configured:true,
      ok:apiOk,
      status:me.status,
      ms:me.ms,
      detail:apiOk?'SignWell API key authenticated successfully.':clean(me.body?.message||me.body?.error||me.error||'SignWell API authentication failed.',800),
    },
    webhook:{
      idConfigured:config.webhookIdConfigured,
      id:config.webhookId,
      listOk:hooks.ok,
      status:hooks.status,
      registered,
      endpoint,
      expectedEndpoint:config.webhookEndpoint,
      endpointMatch,
      detail:!hooks.ok
        ? clean(hooks.body?.message||hooks.body?.error||hooks.error||'SignWell webhook registration lookup failed.',800)
        : registrationOk
          ? 'Configured webhook ID is registered with the expected callback URL.'
          : 'Webhook registration is incomplete or does not match the configured production callback.',
    },
    delivery:{
      verified:deliveryVerified,
      lastWebhookAt:clean(lastWebhook?.receivedAt,100),
      eventType:clean(lastWebhook?.eventType,160),
      documentId:clean(lastWebhook?.documentId,180),
      detail:deliveryVerified
        ? 'Most recent verified SignWell webhook was accepted with valid HMAC.'
        : 'No verified production SignWell webhook delivery has been recorded yet.',
    },
    signedPdf:pdf,
    configuration:config,
  };
}

function contractHtml(record:any){
  const sections=record?.booking?.contract?.sections||[];
  const title=record?.booking?.contract?.title||(resolveTenant().displayName+' Agreement');
  return '<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;color:#17231d;line-height:1.55;padding:28px}h1{font-size:26px}h2{font-size:17px;margin-top:24px}.meta{padding:14px;background:#f6f0e7;margin:18px 0}.sig{color:white;font-size:18px}</style></head><body>'+
    '<h1>'+esc(title)+'</h1><div class="meta"><strong>Client:</strong> '+esc(record?.customer?.name)+'<br><strong>Event date:</strong> '+esc(record?.customer?.eventDate)+'<br><strong>Proposal total:</strong> $'+Number(record?.proposal?.total||0).toFixed(2)+'</div>'+
    sections.map((s:any)=>'<h2>'+esc(s.heading)+'</h2><p>'+esc(s.body)+'</p>').join('')+
    '<h2>Electronic signatures</h2><p>Client signature:</p><div class="sig">{{signature:1:y}}</div><p>Date signed:</p><div class="sig">{{date:1:y}}</div>'+
    '<p>'+resolveTenant().displayName+' authorized signature:</p><div class="sig">{{signature:2:y}}</div><p>Date signed:</p><div class="sig">{{date:2:y}}</div>'+
    '</body></html>';
}

export async function createSignWellContract(record:any,origin:string){
  if(!signWellConfigured()) return {configured:false};
  const clientEmail=clean(record?.customer?.email,240);
  if(!clientEmail) throw new Error('Client email is required for SignWell.');
  const cfg=signWellConfiguration();
  const html=contractHtml(record);
  const fileBase64=Buffer.from(html,'utf8').toString('base64');
  const payload={
    test_mode:cfg.testMode,draft:false,name:(record.booking?.contract?.title||(resolveTenant().displayName+' Agreement'))+' · '+(record.customer?.name||record.id),
    subject:'Your '+resolveTenant().displayName+' agreement is ready to sign',
    message:'Aloha '+(record.customer?.name||'')+', please review and sign your '+resolveTenant().displayName+' agreement.',
    files:[{name:'Agreement-'+record.id+'.html',file_base64:fileBase64}],
    recipients:[
      {id:'1',name:clean(record.customer?.name,180),email:clientEmail},
      {id:'2',name:cfg.koaSignerName,email:cfg.koaSignerEmail}
    ],
    apply_signing_order:true,embedded_signing:true,embedded_signing_notifications:true,with_signature_page:true,
    reminders:true,expires_in:14,allow_decline:true,allow_reassign:false,
    redirect_url:origin+'/portal/?token='+encodeURIComponent(record.proposal?.publicToken||''),
    metadata:{record_id:record.id,quote_id:record.quoteId||'',public_token:record.proposal?.publicToken||''},
    custom_requester_name:resolveTenant().displayName,custom_requester_email:resolveTenant().contact.email
  };
  const doc=await sw('/documents',{method:'POST',body:JSON.stringify(payload)});
  return {configured:true,documentId:String(doc.id||''),status:String(doc.status||''),recipients:doc.recipients||[],embeddedSigningUrl:String(doc.recipients?.[0]?.embedded_signing_url||doc.embedded_signing_url||''),raw:doc};
}

export async function getCompletedPdf(documentId:string){
  const key=apiKey();
  let lastStatus=0;
  let lastDetail='Completed SignWell PDF is not ready.';
  for(let attempt=0;attempt<4;attempt+=1){
    if(attempt)await wait(900*attempt);
    const res=await fetch(API+'/documents/'+encodeURIComponent(documentId)+'/completed_pdf?file_format=pdf&audit_page=true',{
      headers:{'X-Api-Key':key},
      signal:AbortSignal.timeout(12000),
    });
    lastStatus=res.status;
    if(res.ok)return await res.arrayBuffer();
    lastDetail=clean(await res.text().catch(()=>''),500)||('SignWell completed PDF HTTP '+res.status);
    if(![400,404,409,425].includes(res.status))break;
  }
  throw new Error(lastDetail+' · HTTP '+lastStatus);
}

export function eventStoreFor(context:Context){
  return context.deploy.context==='production'?getStore({name:'koa-event-files',consistency:'strong'}):getDeployStore({name:'koa-event-files'});
}
