import { emailButton, emailGreeting, emailGreetingText, emailHeader, emailLogoAttachment, emailSignature, emailSignatureText } from './email-brand';
import type { TenantProfile } from '../../../src/data/tenants';
import { tenantEnv } from './tenant-env';
type AccountingTransition = {
  recordId?: string;
  clientName?: string;
  type: string;
  before?: any[];
  after?: any[];
};

function clean(value: unknown, max = 1200) {
  return String(value || '').trim().slice(0, max);
}

function esc(value: unknown) {
  return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function issueSummary(issues: any[]) {
  return (Array.isArray(issues) ? issues : []).slice(0, 6).map((issue: any) => {
    const expected = issue?.expected == null ? '—' : '$' + Number(issue.expected || 0).toFixed(2);
    const actual = issue?.actual == null ? '—' : '$' + Number(issue.actual || 0).toFixed(2);
    return clean(issue?.label, 160) + ' expected ' + expected + ', actual ' + actual;
  });
}

export async function sendAccountingTransitionAlerts(
  transitions: AccountingTransition[],
  runId: string,
  options: { test?: boolean; tenant?: TenantProfile } = {},
) {
  const detected = transitions.filter((entry) => entry.type === 'mismatch_detected');
  const resolved = transitions.filter((entry) => entry.type === 'resolved');
  if (!detected.length && !resolved.length) return { changed:false, test:Boolean(options.test), channels:[] };

  const tenant=options.tenant;
  if(!tenant) throw new Error('Tenant context is required for accounting alerts.');
  const brand=tenant.displayName || 'VenueLoom tenant';
  const adminOrigin='https://' + tenant.domains.admin;
  const prefix = options.test ? '[TEST] ' : '';
  const subject = prefix + (
    detected.length && resolved.length
      ? brand + ' accounting reconciliation changed'
      : detected.length
        ? brand + ' accounting mismatch detected'
        : brand + ' accounting mismatch resolved'
  );
  const summaryLines = [
    options.test ? 'This is a delivery test. No client accounting data was changed.' : '',
    detected.length ? detected.length + ' client reconciliation mismatch' + (detected.length === 1 ? '' : 'es') + ' detected.' : '',
    resolved.length ? resolved.length + ' client reconciliation mismatch' + (resolved.length === 1 ? '' : 'es') + ' resolved.' : '',
  ].filter(Boolean);
  const details = [
    ...detected.map((entry) => ({ heading:options.test?'Test mismatch':'New mismatch', name:entry.clientName || entry.recordId || 'Test client', issues:issueSummary(entry.after || []) })),
    ...resolved.map((entry) => ({ heading:options.test?'Test resolved':'Resolved', name:entry.clientName || entry.recordId || 'Test client', issues:issueSummary(entry.before || []) })),
  ];

  const channels:any[] = [];
  const apiKey=clean(tenantEnv(tenant,'RESEND_API_KEY'),500);
  const configuredEmails=clean(tenantEnv(tenant,'ACCOUNTING_ALERT_EMAILS','KOA_ACCOUNTING_ALERT_EMAILS'),500)
    || clean(tenantEnv(tenant,'HEALTH_ALERT_EMAILS','KOA_HEALTH_ALERT_EMAILS'),500)
    || clean(tenantEnv(tenant,'LEAD_EMAIL_TO','KOA_LEAD_EMAIL_TO'),500)
    || clean(tenant.contact.email,500);
  const recipients=configuredEmails.split(',').map(v=>v.trim()).filter(v=>v.includes('@'));

  if(apiKey&&recipients.length){
    const from=clean(tenantEnv(tenant,'ACCOUNTING_ALERT_FROM','KOA_ACCOUNTING_ALERT_FROM'),240)
      || clean(tenantEnv(tenant,'HEALTH_ALERT_FROM','KOA_HEALTH_ALERT_FROM'),240)
      || clean(tenantEnv(tenant,'LEAD_EMAIL_FROM','KOA_LEAD_EMAIL_FROM'),240)
      || (brand+' <'+tenant.contact.email+'>');
    const html='<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="IE=edge"><meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no"><title>'+esc(subject)+'</title></head><body style="margin:0;padding:0;background:#f5f0e7;font-family:Arial,Helvetica,sans-serif;color:#173d30">'
      +'<table role="presentation" lang="en" dir="ltr" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding-top:20px;padding-right:10px;padding-bottom:20px;padding-left:10px">'
      +'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:700px;background:#fff;border:1px solid #e7dfd0;border-radius:20px">'
      +emailHeader({brand:'events',eyebrow:'Accounting Reconciliation',title:subject})
      +'<tr><td style="padding-top:24px;padding-right:22px;padding-bottom:24px;padding-left:22px">'
      +emailGreeting('Team')
      +'<p style="line-height:1.6;color:#52635b">'+esc(summaryLines.join(' '))+'</p>'
      +details.map((entry)=>'<div style="margin:14px 0;padding:14px;border:1px solid #e7dfd0;border-radius:12px"><strong>'+esc(entry.heading)+': '+esc(entry.name)+'</strong>'
        +(entry.issues.length?'<ul>'+entry.issues.map((line)=>'<li>'+esc(line)+'</li>').join('')+'</ul>':'')
        +'</div>').join('')
      +emailButton({href:''+adminOrigin+'/admin/quotes/',label:'Open Sales CRM',marginTop:20})
      +emailSignature()
      +'</td></tr></table></td></tr></table></body></html>';
    const textBody=[emailGreetingText('Team'),'',
      ...summaryLines,
      ...details.flatMap((entry)=>[entry.heading+': '+entry.name,...entry.issues]),
      'Sales CRM: '+adminOrigin+'/admin/quotes/','',
      emailSignatureText()
    ].join('\n');
    try{
      const response=await fetch('https://api.resend.com/emails',{
        method:'POST',
        headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json','Idempotency-Key':('koa-accounting-'+runId).slice(0,256)},
        body:JSON.stringify({from,to:recipients,subject,html,text:textBody,attachments:[emailLogoAttachment()]}),
        signal:AbortSignal.timeout(12_000),
      });
      const body:any=await response.json().catch(()=>({}));
      channels.push(response.ok?{channel:'email',sent:true,id:clean(body?.id,120)}:{channel:'email',sent:false,status:response.status,error:clean(body?.message,240)});
    }catch(error){
      channels.push({channel:'email',sent:false,error:error instanceof Error?clean(error.message,240):'request-error'});
    }
  } else {
    channels.push({channel:'email',sent:false,reason:apiKey?'no-recipient':'not-configured'});
  }

  const webhook=clean(tenantEnv(tenant,'ACCOUNTING_SLACK_WEBHOOK_URL','KOA_ACCOUNTING_SLACK_WEBHOOK_URL'),1000)
    || clean(tenantEnv(tenant,'HEALTH_SLACK_WEBHOOK_URL','KOA_HEALTH_SLACK_WEBHOOK_URL'),1000);
  if(webhook){
    const lines=[
      options.test?'🧪 *'+brand+' accounting alert test*':'',
      detected.length?'🚨 *Accounting mismatch detected:* '+detected.map((entry)=>entry.clientName||entry.recordId||'Test client').join(', '):'',
      resolved.length?'✅ *Accounting mismatch resolved:* '+resolved.map((entry)=>entry.clientName||entry.recordId||'Test client').join(', '):'',
      '<'+adminOrigin+'/admin/quotes/|Open Sales CRM>',
    ].filter(Boolean);
    try{
      const response=await fetch(webhook,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({text:lines.join('\n')}),
        signal:AbortSignal.timeout(12_000),
      });
      channels.push({channel:'slack',sent:response.ok,status:response.status});
    }catch(error){
      channels.push({channel:'slack',sent:false,error:error instanceof Error?clean(error.message,240):'request-error'});
    }
  } else {
    channels.push({channel:'slack',sent:false,reason:'not-configured'});
  }

  const sid=clean(tenantEnv(tenant,'TWILIO_ACCOUNT_SID'),200);
  const token=clean(tenantEnv(tenant,'TWILIO_AUTH_TOKEN'),300);
  const fromNumber=clean(tenantEnv(tenant,'TWILIO_FROM_NUMBER'),80);
  const smsRecipients=(clean(tenantEnv(tenant,'ACCOUNTING_SMS_TO','KOA_ACCOUNTING_SMS_TO'),500)||clean(tenantEnv(tenant,'HEALTH_SMS_TO','KOA_HEALTH_SMS_TO'),500))
    .split(',').map(v=>v.trim()).filter(Boolean);
  if(sid&&token&&fromNumber&&smsRecipients.length){
    const smsBody=[
      options.test?'TEST accounting alert.':'',
      detected.length?'Accounting mismatch: '+detected.map((entry)=>entry.clientName||entry.recordId||'Test client').join(', ')+'.':'',
      resolved.length?'Resolved: '+resolved.map((entry)=>entry.clientName||entry.recordId||'Test client').join(', ')+'.':'',
      ''+adminOrigin+'/admin/quotes/',
    ].filter(Boolean).join(' ').slice(0,1200);
    const auth='Basic '+btoa(sid+':'+token);
    const results:any[]=[];
    for(const to of smsRecipients){
      try{
        const form=new URLSearchParams({From:fromNumber,To:to,Body:smsBody});
        const response=await fetch('https://api.twilio.com/2010-04-01/Accounts/'+encodeURIComponent(sid)+'/Messages.json',{
          method:'POST',
          headers:{Authorization:auth,'Content-Type':'application/x-www-form-urlencoded'},
          body:form.toString(),
          signal:AbortSignal.timeout(12_000),
        });
        results.push({to,sent:response.ok,status:response.status});
      }catch(error){
        results.push({to,sent:false,error:error instanceof Error?clean(error.message,240):'request-error'});
      }
    }
    channels.push({channel:'sms',sent:results.some(row=>row.sent),results});
  } else {
    channels.push({channel:'sms',sent:false,reason:'not-configured'});
  }

  return {changed:true,test:Boolean(options.test),detected:detected.length,resolved:resolved.length,channels};
}
