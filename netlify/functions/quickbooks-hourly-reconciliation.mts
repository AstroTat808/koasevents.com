import type { Config, Context } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import {
  applyQuickBooksReconciliationHistory,
  buildQuickBooksAccountingAudit,
  readQuickBooksSalesRecords,
  refreshQuickBooksPaymentSnapshot,
  saveQuickBooksSalesRecord,
  syncQuickBooksAccountingStatus,
} from './admin-quickbooks.mts';

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

async function sendAccountingTransitionAlerts(transitions: any[], runId: string) {
  const detected = transitions.filter((entry) => entry.type === 'mismatch_detected');
  const resolved = transitions.filter((entry) => entry.type === 'resolved');
  if (!detected.length && !resolved.length) return { changed:false, channels:[] };

  const subject = detected.length && resolved.length
    ? 'Koa’s accounting reconciliation changed'
    : detected.length
      ? 'Koa’s accounting mismatch detected'
      : 'Koa’s accounting mismatch resolved';
  const summaryLines = [
    detected.length ? detected.length + ' client reconciliation mismatch' + (detected.length === 1 ? '' : 'es') + ' detected.' : '',
    resolved.length ? resolved.length + ' client reconciliation mismatch' + (resolved.length === 1 ? '' : 'es') + ' resolved.' : '',
  ].filter(Boolean);
  const details = [
    ...detected.map((entry) => ({ heading:'New mismatch', name:entry.clientName || entry.recordId, issues:issueSummary(entry.after) })),
    ...resolved.map((entry) => ({ heading:'Resolved', name:entry.clientName || entry.recordId, issues:issueSummary(entry.before) })),
  ];

  const channels:any[] = [];
  const apiKey=clean(Netlify.env.get('RESEND_API_KEY'),500);
  const configuredEmails=clean(Netlify.env.get('KOA_ACCOUNTING_ALERT_EMAILS'),500)
    || clean(Netlify.env.get('KOA_HEALTH_ALERT_EMAILS'),500)
    || clean(Netlify.env.get('KOA_LEAD_EMAIL_TO'),500)
    || 'chris@sibel.org';
  const recipients=configuredEmails.split(',').map(v=>v.trim()).filter(v=>v.includes('@'));

  if(apiKey&&recipients.length){
    const from=clean(Netlify.env.get('KOA_ACCOUNTING_ALERT_FROM'),240)
      || clean(Netlify.env.get('KOA_HEALTH_ALERT_FROM'),240)
      || clean(Netlify.env.get('KOA_LEAD_EMAIL_FROM'),240)
      || 'Koa’s Events <leads@koasevents.com>';
    const html='<!doctype html><html><body style="margin:0;background:#f5f0e7;padding:28px;font-family:Arial,sans-serif;color:#173d30">'
      +'<div style="max-width:700px;margin:auto;background:#fff;border:1px solid #e7dfd0;border-radius:20px;padding:28px">'
      +'<div style="font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#a96d4a">Koa’s Events · Accounting Reconciliation</div>'
      +'<h1 style="font-family:Georgia,serif;font-size:30px;margin:10px 0 14px">'+esc(subject)+'</h1>'
      +'<p style="line-height:1.6;color:#52635b">'+esc(summaryLines.join(' '))+'</p>'
      +details.map((entry)=>'<div style="margin:14px 0;padding:14px;border:1px solid #e7dfd0;border-radius:12px"><strong>'+esc(entry.heading)+': '+esc(entry.name)+'</strong>'
        +(entry.issues.length?'<ul>'+entry.issues.map((line)=>'<li>'+esc(line)+'</li>').join('')+'</ul>':'')
        +'</div>').join('')
      +'<p><a href="https://koasevents.com/admin/quotes/" style="display:inline-block;background:#173d30;color:white;text-decoration:none;border-radius:999px;padding:12px 18px;font-size:12px;font-weight:800">Open Sales CRM</a></p>'
      +'</div></body></html>';
    const textBody=[...summaryLines,...details.flatMap((entry)=>[entry.heading+': '+entry.name,...entry.issues]),'Sales CRM: https://koasevents.com/admin/quotes/'].join('\n');
    try{
      const response=await fetch('https://api.resend.com/emails',{
        method:'POST',
        headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json','Idempotency-Key':('koa-accounting-'+runId).slice(0,256)},
        body:JSON.stringify({from,to:recipients,subject,html,text:textBody}),
        signal:AbortSignal.timeout(12_000),
      });
      const body:any=await response.json().catch(()=>({}));
      channels.push(response.ok?{channel:'email',sent:true,id:clean(body?.id,120)}:{channel:'email',sent:false,status:response.status,error:clean(body?.message,240)});
    }catch(error){
      channels.push({channel:'email',sent:false,error:error instanceof Error?clean(error.message,240):'request-error'});
    }
  } else {
    channels.push({channel:'email',sent:false,reason:'not-configured'});
  }

  const webhook=clean(Netlify.env.get('KOA_ACCOUNTING_SLACK_WEBHOOK_URL'),1000)
    || clean(Netlify.env.get('KOA_HEALTH_SLACK_WEBHOOK_URL'),1000);
  if(webhook){
    const lines=[
      detected.length?'🚨 *Accounting mismatch detected:* '+detected.map((entry)=>entry.clientName||entry.recordId).join(', '):'',
      resolved.length?'✅ *Accounting mismatch resolved:* '+resolved.map((entry)=>entry.clientName||entry.recordId).join(', '):'',
      '<https://koasevents.com/admin/quotes/|Open Sales CRM>',
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

  const sid=clean(Netlify.env.get('TWILIO_ACCOUNT_SID'),200);
  const token=clean(Netlify.env.get('TWILIO_AUTH_TOKEN'),300);
  const fromNumber=clean(Netlify.env.get('TWILIO_FROM_NUMBER'),80);
  const smsRecipients=(clean(Netlify.env.get('KOA_ACCOUNTING_SMS_TO'),500)||clean(Netlify.env.get('KOA_HEALTH_SMS_TO'),500))
    .split(',').map(v=>v.trim()).filter(Boolean);
  if(sid&&token&&fromNumber&&smsRecipients.length){
    const smsBody=[
      detected.length?'Accounting mismatch: '+detected.map((entry)=>entry.clientName||entry.recordId).join(', ')+'.':'',
      resolved.length?'Resolved: '+resolved.map((entry)=>entry.clientName||entry.recordId).join(', ')+'.':'',
      'https://koasevents.com/admin/quotes/',
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

  return {changed:true,detected:detected.length,resolved:resolved.length,channels};
}

function isReconciliationCandidate(record: any) {
  if (!record || record.kind !== 'proposal' || !record.proposal) return false;
  const qbo = record?.accounting?.quickbooks || {};
  return Boolean(
    qbo.customerId ||
    qbo.estimateId ||
    (Array.isArray(qbo.invoices) && qbo.invoices.some((entry: any) => entry?.invoiceId))
  );
}

export default async (_req: Request, context: Context) => {
  if (context.deploy.context !== 'production') return;

  let records = await readQuickBooksSalesRecords(context);
  const candidates = records.filter(isReconciliationCandidate);
  const errors: Array<{ recordId: string; message: string }> = [];

  for (const record of candidates) {
    try {
      await syncQuickBooksAccountingStatus(context, record);
      await refreshQuickBooksPaymentSnapshot(context, record);
      record.accounting ||= {};
      record.accounting.quickbooks ||= {};
      record.accounting.quickbooks.hourlyReconciledAt = new Date().toISOString();
      record.accounting.quickbooks.hourlyReconciliationError = '';
      records = await saveQuickBooksSalesRecord(context, record, records);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'QuickBooks reconciliation failed.';
      record.accounting ||= {};
      record.accounting.quickbooks ||= {};
      record.accounting.quickbooks.hourlyReconciledAt = new Date().toISOString();
      record.accounting.quickbooks.hourlyReconciliationError = String(message).slice(0, 500);
      errors.push({ recordId: String(record.id || ''), message: String(message).slice(0, 500) });
      records = await saveQuickBooksSalesRecord(context, record, records);
    }
  }

  const audit = buildQuickBooksAccountingAudit(records);
  const reconciliation = applyQuickBooksReconciliationHistory(records, audit, 'hourly');
  for (const recordId of reconciliation.changedRecordIds) {
    const record = records.find((entry: any) => String(entry?.id || '') === String(recordId));
    if (record) records = await saveQuickBooksSalesRecord(context, record, records);
  }

  const runAt = new Date().toISOString();
  const alertTransitions = reconciliation.transitions.filter((entry: any) => ['mismatch_detected','resolved'].includes(entry.type));
  const alerts = await sendAccountingTransitionAlerts(alertTransitions, runAt);
  const store = getStore({ name: 'koa-integrations', consistency: 'strong' });
  await store.setJSON('quickbooks/accounting-hourly-last', {
    ...audit,
    runAt,
    refreshedClients: candidates.length,
    errorCount: errors.length,
    errors: errors.slice(0, 100),
    transitions: reconciliation.transitions.slice(0, 100),
    alerts,
  });
};

export const config: Config = {
  schedule: '@hourly',
};
