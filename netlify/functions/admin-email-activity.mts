import type { Config, Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { requireCapability } from './_shared/admin';
import { readEmailHealthEvents } from './_shared/email-health';

function clean(value:unknown,max=500){return String(value??'').trim().slice(0,max);}
function normalizeStatus(value:unknown){return clean(value,80).toLowerCase().replace(/^email\./,'').replace(/-/g,'_');}
function addresses(value:unknown){
  if(Array.isArray(value))return value.map((row)=>clean(row,240)).filter(Boolean).slice(0,50);
  return String(value??'').split(/[\n,;]+/).map((row)=>clean(row,240)).filter(Boolean).slice(0,50);
}
function classify(subject:unknown){
  const value=clean(subject,500).toLowerCase();
  if(/security alert/.test(value))return 'Security alert';
  if(/follow-up due/.test(value))return 'Lead response reminder';
  if(/received your .*inquiry|received your koa/.test(value))return 'Client inquiry confirmation';
  if(/quick follow-up/.test(value))return 'Client follow-up';
  if(/would you share your experience|google review/.test(value))return 'Review request';
  if(/vendor.*brief|vendor event brief/.test(value))return 'Vendor event brief';
  if(/insurance|compliance/.test(value))return 'Vendor insurance reminder';
  if(/new .*inquiry|new discovery call request|new private event inquiry|new mobile bar inquiry/.test(value))return 'New lead notification';
  if(/test/.test(value))return 'Admin test';
  return 'Other';
}
function routeFor(type:string){
  if(type==='New lead notification')return 'lead-notification';
  if(type==='Lead response reminder')return 'lead-response-reminder';
  if(type==='Client inquiry confirmation')return 'client-confirmation';
  if(type==='Client follow-up')return 'client-follow-up';
  if(type==='Review request')return 'review-request';
  if(type==='Vendor event brief')return 'vendor-event-brief';
  if(type==='Vendor insurance reminder')return 'vendor-insurance-reminder';
  if(type==='Admin test')return 'email-preview';
  if(type==='Security alert')return 'security-alert';
  return 'other';
}
function problem(status:string){return ['failed','bounced','complained','suppressed'].includes(status);}
function delivered(status:string){return ['delivered','opened','clicked'].includes(status);}
function recommendation(status:string,bounceType:string,bounceSubType:string,message:string){
  const hay=(bounceType+' '+bounceSubType+' '+message).toLowerCase();
  if(status==='complained')return 'Do not resend automatically. Confirm the recipient expected this message and review consent or list source before contacting them again.';
  if(status==='suppressed'||/suppression/.test(hay))return 'The address is suppressed. Verify the address and the reason for suppression before attempting another send.';
  if(status==='bounced'&&(/permanent|hard/.test(hay)))return 'Treat this as a hard bounce. Verify or replace the recipient address before resending.';
  if(status==='bounced'&&(/transient|soft|mailbox full|temporary/.test(hay)))return 'This appears temporary. Verify the address, then retry later if the mailbox or receiving server recovers.';
  if(status==='failed')return 'Review the failure reason and sender/recipient configuration. Correct the underlying issue before retrying.';
  return 'Review the delivery details and recipient address before taking action.';
}
async function resend(path:string){
  const key=clean(Netlify.env.get('RESEND_MONITORING_API_KEY'),500);
  if(!key)return {ok:false,status:0,body:{message:'RESEND_MONITORING_API_KEY is not configured.'}};
  try{
    const response=await fetch('https://api.resend.com'+path,{
      headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','User-Agent':'KoaEvents-EmailActivity/1.0'},
      signal:AbortSignal.timeout(10000),
    });
    const body:any=await response.json().catch(()=>({}));
    return {ok:response.ok,status:response.status,body};
  }catch(error){
    return {ok:false,status:0,body:{message:error instanceof Error?error.message:'Resend request failed.'}};
  }
}
function mapEmail(row:any){
  const status=normalizeStatus(row?.last_event||row?.status||row?.event)||'unknown';
  const emailType=classify(row?.subject);
  return {
    emailId:clean(row?.id,180),
    resendMessageId:clean(row?.message_id,300)||clean(row?.id,180),
    recipient:addresses(row?.to).join(', '),
    recipients:addresses(row?.to),
    subject:clean(row?.subject,500)||'(subject unavailable)',
    emailType,
    route:routeFor(emailType),
    status,
    sent:!problem(status),
    createdAt:clean(row?.created_at||row?.createdAt,100),
    from:clean(row?.from,300),
    problem:problem(status),
  };
}
function domainOf(value:unknown){
  const match=String(value??'').toLowerCase().match(/@([a-z0-9.-]+)(?:>|\s|$)/i);
  return match?.[1]?.replace(/\.$/,'')||'';
}
function roundRate(numerator:number,denominator:number){
  return denominator?Math.round((numerator/denominator)*1000)/10:0;
}
function summarizeRange(rows:any[],start:number,end:number,includeDomains=false){
  const period=rows.filter((row)=>{
    const at=Date.parse(String(row?.createdAt||''));
    return Number.isFinite(at)&&at>=start&&at<end;
  });
  let deliveredCount=0,bounced=0,failed=0,suppressed=0,complaints=0;
  const domains=new Map<string,number>();
  for(const row of period){
    const status=normalizeStatus(row?.status);
    if(delivered(status))deliveredCount+=1;
    if(status==='bounced')bounced+=1;
    if(status==='failed')failed+=1;
    if(status==='suppressed')suppressed+=1;
    if(status==='complained')complaints+=1;
    if(includeDomains&&problem(status)){
      for(const recipient of addresses(row?.recipients?.length?row.recipients:row?.recipient)){
        const domain=domainOf(recipient);
        if(domain)domains.set(domain,(domains.get(domain)||0)+1);
      }
    }
  }
  const totalSent=period.length;
  return {
    totalSent,
    delivered:deliveredCount,
    deliveryRate:roundRate(deliveredCount,totalSent),
    bounced,
    bounceRate:roundRate(bounced,totalSent),
    failures:failed+suppressed,
    failed,
    suppressed,
    complaints,
    topFailingDomains:includeDomains
      ? [...domains.entries()]
          .map(([domain,count])=>({domain,count}))
          .sort((a,b)=>b.count-a.count||a.domain.localeCompare(b.domain))
          .slice(0,5)
      : [],
  };
}
function comparisonMetric(current:number,previous:number,higherIsBetter:boolean,comparable:boolean){
  const delta=Math.round((current-previous)*10)/10;
  if(!comparable)return {current,previous,delta,state:'no_prior_data'};
  if(delta===0)return {current,previous,delta,state:'unchanged'};
  const improved=higherIsBetter?delta>0:delta<0;
  return {current,previous,delta,state:improved?'improved':'worsened'};
}
function summarizePeriod(rows:any[],days:number,now:number){
  const span=days*24*60*60*1000;
  const currentStart=now-span;
  const previousStart=now-span*2;
  const current=summarizeRange(rows,currentStart,now,true);
  const previous=summarizeRange(rows,previousStart,currentStart,false);
  const comparable=previous.totalSent>0;
  return {
    days,
    ...current,
    previous:{
      totalSent:previous.totalSent,
      deliveryRate:previous.deliveryRate,
      bounceRate:previous.bounceRate,
      failures:previous.failures,
      complaints:previous.complaints,
    },
    comparison:{
      deliveryRate:comparisonMetric(current.deliveryRate,previous.deliveryRate,true,comparable),
      bounceRate:comparisonMetric(current.bounceRate,previous.bounceRate,false,comparable),
      failures:comparisonMetric(current.failures,previous.failures,false,comparable),
      complaints:comparisonMetric(current.complaints,previous.complaints,false,comparable),
    },
  };
}
function summaryStore(context:Context){
  return context.deploy.context==='production'
    ? getStore({name:'koa-email-analytics',consistency:'strong'})
    : getDeployStore({name:'koa-email-analytics'});
}
async function emailAnalyticsSummary(context:Context,force=false){
  const store=summaryStore(context);
  const cached:any=await store.get('summary-v2',{type:'json'});
  const cachedAt=Date.parse(String(cached?.generatedAt||''));
  if(!force&&Number.isFinite(cachedAt)&&Date.now()-cachedAt<15*60*1000)return cached;

  const now=Date.now();
  const cutoff180=now-180*24*60*60*1000;
  const rows:any[]=[];
  const seen=new Set<string>();
  let after='';
  let hasMore=true;
  let coverageComplete=false;
  let pages=0;
  while(hasMore&&pages<100){
    const params=new URLSearchParams({limit:'100'});
    if(after)params.set('after',after);
    const result=await resend('/emails?'+params.toString());
    if(!result.ok)throw new Error(clean(result.body?.message||'Unable to load email analytics history.',500));
    const raw=Array.isArray(result.body?.data)?result.body.data:Array.isArray(result.body)?result.body:[];
    const mapped=raw.map(mapEmail);
    for(const row of mapped){
      if(row.emailId&&!seen.has(row.emailId)){seen.add(row.emailId);rows.push(row);}
    }
    pages+=1;
    hasMore=Boolean(result.body?.has_more);
    after=mapped.length?String(mapped[mapped.length-1]?.emailId||''):'';
    const oldest=mapped.reduce((min,row)=>{
      const at=Date.parse(String(row?.createdAt||''));
      return Number.isFinite(at)?Math.min(min,at):min;
    },Number.POSITIVE_INFINITY);
    if(!hasMore||!mapped.length||!after||oldest<cutoff180){
      coverageComplete=!hasMore||oldest<cutoff180;
      break;
    }
  }
  const oldestLoaded=rows.reduce((min,row)=>{
    const at=Date.parse(String(row?.createdAt||''));
    return Number.isFinite(at)?Math.min(min,at):min;
  },Number.POSITIVE_INFINITY);
  const summary={
    ok:true,
    generatedAt:new Date().toISOString(),
    retainedRowsScanned:rows.length,
    coverageComplete180d:coverageComplete,
    oldestLoadedAt:Number.isFinite(oldestLoaded)?new Date(oldestLoaded).toISOString():'',
    note:coverageComplete
      ? 'Metrics cover the current and immediately preceding equivalent windows needed for 7, 30, and 90-day comparisons.'
      : 'Metrics use the newest 10,000 retained Resend records; very high-volume activity may limit the oldest comparison window.',
    periods:[
      summarizePeriod(rows,7,now),
      summarizePeriod(rows,30,now),
      summarizePeriod(rows,90,now),
    ],
  };
  await store.setJSON('summary-v2',summary);
  return summary;
}

export default async (req:Request,context:Context)=>{
  const auth=await requireCapability('email.view',req);
  if(auth.response)return auth.response;
  const url=new URL(req.url);

  if(url.searchParams.get('summary')==='1'){
    try{
      return Response.json(await emailAnalyticsSummary(context,url.searchParams.get('refresh')==='1'),{
        headers:{'Cache-Control':'private, max-age=60'},
      });
    }catch(error){
      return Response.json({error:error instanceof Error?error.message:'Unable to calculate email analytics.'},{status:400});
    }
  }

  if(url.searchParams.get('scan')==='domain-failures'){
    const domain=clean(url.searchParams.get('domain'),180).toLowerCase().replace(/^@/,'');
    const days=Math.max(1,Math.min(180,Number(url.searchParams.get('days')||30)||30));
    if(!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)){
      return Response.json({error:'A valid recipient domain is required.'},{status:400});
    }
    const cutoff=Date.now()-days*24*60*60*1000;
    const matches:any[]=[];
    const seen=new Set<string>();
    let after='';
    let hasMore=true;
    let complete=false;
    let pages=0;
    while(hasMore&&pages<100){
      const params=new URLSearchParams({limit:'100'});
      if(after)params.set('after',after);
      const result=await resend('/emails?'+params.toString());
      if(!result.ok)return Response.json({error:clean(result.body?.message||'Unable to scan email history.',500)},{status:result.status||400});
      const raw=Array.isArray(result.body?.data)?result.body.data:Array.isArray(result.body)?result.body:[];
      const mapped=raw.map(mapEmail);
      for(const row of mapped){
        const at=Date.parse(String(row?.createdAt||''));
        if(!Number.isFinite(at)||at<cutoff||!problem(row.status))continue;
        const hasDomain=addresses(row?.recipients?.length?row.recipients:row?.recipient).some((recipient)=>domainOf(recipient)===domain);
        if(hasDomain&&row.emailId&&!seen.has(row.emailId)){
          seen.add(row.emailId);
          matches.push(row);
        }
      }
      pages+=1;
      hasMore=Boolean(result.body?.has_more);
      after=mapped.length?String(mapped[mapped.length-1]?.emailId||''):'';
      const oldest=mapped.reduce((min,row)=>{
        const at=Date.parse(String(row?.createdAt||''));
        return Number.isFinite(at)?Math.min(min,at):min;
      },Number.POSITIVE_INFINITY);
      if(!hasMore||!mapped.length||!after||oldest<cutoff){
        complete=!hasMore||oldest<cutoff;
        break;
      }
    }
    matches.sort((a,b)=>Date.parse(String(b.createdAt||''))-Date.parse(String(a.createdAt||'')));
    return Response.json({
      ok:true,
      rows:matches,
      domain,
      days,
      complete,
      scannedPages:pages,
      retentionNote:complete
        ? 'Complete retained-history scan for '+domain+' failures in the last '+days+' days.'
        : 'Scanned the newest 10,000 retained emails; older matching rows may exist.',
    },{headers:{'Cache-Control':'private, no-store'}});
  }

  const detailId=clean(url.searchParams.get('id'),180);
  if(detailId){
    const [emailResult,events]=await Promise.all([
      resend('/emails/'+encodeURIComponent(detailId)),
      readEmailHealthEvents(context,5000),
    ]);
    if(!emailResult.ok)return Response.json({error:clean(emailResult.body?.message||'Unable to load email detail.',500)},{status:emailResult.status||400});
    const email:any=emailResult.body||{};
    const related=(Array.isArray(events)?events:[]).filter((row:any)=>String(row?.emailId||'')===detailId);
    const diagnostic=related.find((row:any)=>row?.bounceMessage||row?.failureReason||row?.bounceType)||related[0]||{};
    const status=normalizeStatus(email?.last_event||email?.status||diagnostic?.status);
    const emailType=classify(email?.subject||diagnostic?.subject);
    const bounceType=clean(diagnostic?.bounceType,120);
    const bounceSubType=clean(diagnostic?.bounceSubType,160);
    const reason=clean(diagnostic?.bounceMessage||diagnostic?.failureReason,1000);
    return Response.json({
      ok:true,
      email:{
        id:detailId,
        resendMessageId:clean(email?.message_id,300)||clean(diagnostic?.messageId,300)||detailId,
        recipient:addresses(email?.to?.length?email.to:diagnostic?.to).join(', '),
        recipients:addresses(email?.to?.length?email.to:diagnostic?.to),
        from:clean(email?.from||diagnostic?.from,300),
        subject:clean(email?.subject||diagnostic?.subject,500),
        createdAt:clean(email?.created_at||diagnostic?.createdAt,100),
        status,
        emailType,
        route:routeFor(emailType),
        bounceType,
        bounceSubType,
        reason,
        recommendation:recommendation(status,bounceType,bounceSubType,reason),
        archivedEvents:related.map((row:any)=>({type:row.type,status:row.status,createdAt:row.createdAt,recordedAt:row.recordedAt})).slice(0,20),
      },
    },{headers:{'Cache-Control':'private, no-store'}});
  }

  const limit=Math.max(1,Math.min(100,Number(url.searchParams.get('limit')||100)||100));
  const after=clean(url.searchParams.get('after'),180);
  const before=clean(url.searchParams.get('before'),180);
  const params=new URLSearchParams({limit:String(limit)});
  if(after)params.set('after',after);
  else if(before)params.set('before',before);
  const result=await resend('/emails?'+params.toString());
  if(!result.ok)return Response.json({error:clean(result.body?.message||'Unable to load email history.',500)},{status:result.status||400});
  const raw=Array.isArray(result.body?.data)?result.body.data:Array.isArray(result.body)?result.body:[];
  const rows=raw.map(mapEmail);
  return Response.json({
    ok:true,
    rows,
    hasMore:Boolean(result.body?.has_more),
    nextAfter:rows.length?rows[rows.length-1].emailId:'',
    previousBefore:rows.length?rows[0].emailId:'',
    retentionNote:'History is limited to email records retained by the connected Resend account. Koa’s signed webhook archive preserves lifecycle diagnostics going forward.',
  },{headers:{'Cache-Control':'private, no-store'}});
};

export const config:Config={path:'/api/admin/email-activity'};
