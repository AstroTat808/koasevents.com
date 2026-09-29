import type { Context } from '@netlify/functions';
import { resolveTenant } from './tenant';
import { tenantStoreFor } from './tenant-storage';
import { tenantEnv } from './tenant-env';
import { assertEmailInlineAssets, emailDocumentClose, emailDocumentOpen, emailGreeting, emailGreetingText, emailHeader, emailInlineAssetAudit, emailLogoAttachment, emailLogoMetadata, emailSignature, emailSignatureText } from './email-brand';

export type EmailHealthEvent = {
  id: string;
  emailId: string;
  type: string;
  status: string;
  createdAt: string;
  recordedAt: string;
  from?: string;
  to?: string[];
  subject?: string;
  messageId?: string;
  bounceType?: string;
  bounceSubType?: string;
  bounceMessage?: string;
  failureReason?: string;
};

type EmailHealthSummaryOptions = {
  force?: boolean;
};

export type BrandedEmailProductionVerification = {
  deployId: string;
  commit: string;
  checkedAt: string;
  required: boolean;
  status: 'success' | 'failure' | 'skipped';
  changedFiles: string[];
  messageId: string;
  resendStatus: string;
  htmlCidPresent: boolean;
  attachmentPresent: boolean;
  contentId: string;
  filename: string;
  contentType: string;
  lastSuccessfulAt: string;
  lastSuccessfulCommit: string;
  lastSuccessfulMessageId: string;
  detail: string;
};

export const EMAIL_RENDERING_PATH_PATTERNS = [
  /^netlify\/functions\/_shared\/(?:email-brand|lead-email|review-email|vendor-email|accounting-alerts|auth-security|system-health|email-health|email-routing)\.ts$/,
  /^netlify\/functions\/(?:admin-email-preview|admin-email-routing|admin-crm)\.mts$/,
  /^netlify\/functions\/resend-webhook\.mts$/,
  /^src\/pages\/admin\/email(?:-preview)?\/index\.astro$/,
  /^src\/pages\/admin\/health\/index\.astro$/,
  /^scripts\/build_safety_check\.mjs$/,
] as const;

export function emailRenderingFiles(files: unknown[]) {
  return (Array.isArray(files) ? files : [])
    .map((file)=>clean(typeof file === 'string' ? file : (file as any)?.filename, 400))
    .filter((file)=>file && EMAIL_RENDERING_PATH_PATTERNS.some((pattern)=>pattern.test(file)));
}

const COMPATIBILITY_TEMPLATES = [
  'lead-notification',
  'client-confirmation',
  'response-reminder',
  'client-follow-up',
  'review-request',
  'vendor-brief',
  'vendor-insurance',
  'accounting-alert',
  'system-health',
  'security-alert',
  'staff-response',
] as const;

const COMPATIBILITY_CHECKS = [
  'embedded CID PNG logo',
  'explicit image width and height',
  'table-based layout',
  'Outlook-safe linked buttons',
  'no flexbox or grid in email HTML',
  'no CSS background images',
  'viewport + Outlook metadata',
  'lang + direction + document title',
  'plain-text alternative',
] as const;

function storeFor(context: Context) {
  return tenantStoreFor(context, resolveTenant(), 'emailAnalytics');
}

function tenantSetting(...names:string[]){ return tenantEnv(resolveTenant(),...names); }
function tenantOrigin(){
  const tenant=resolveTenant();
  const host=tenant.domains.primary||tenant.domains.admin;
  return host ? 'https://'+host : '';
}
function resendWebhookEndpoint(){
  return tenantSetting('RESEND_WEBHOOK_ENDPOINT') || (tenantOrigin() ? tenantOrigin()+'/api/webhooks/resend' : '');
}

function clean(value: unknown, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function canonicalStatus(value: unknown) {
  return clean(value, 80).toLowerCase().replace(/^email\./, '').replace(/-/g, '_');
}

function normalizeAddressList(value: unknown) {
  return String(value ?? '').split(/[\n,;]+/).map((row)=>clean(row,240)).filter(Boolean).slice(0,50);
}

function classifyEmailType(subject: unknown) {
  const value=clean(subject,500).toLowerCase();
  if(/follow-up due/.test(value)) return 'Lead response reminder';
  if(/received your .*inquiry|received your koa/.test(value)) return 'Client inquiry confirmation';
  if(/quick follow-up/.test(value)) return 'Client follow-up';
  if(/would you share your experience|google review/.test(value)) return 'Review request';
  if(/vendor.*brief|vendor event brief/.test(value)) return 'Vendor event brief';
  if(/insurance|compliance/.test(value)) return 'Vendor insurance reminder';
  if(/new .*inquiry|new discovery call request|new private event inquiry|new mobile bar inquiry/.test(value)) return 'New lead notification';
  if(/test/.test(value)) return 'Admin test';
  return 'Other';
}

function statusCounts(rows: any[], cutoffMs: number) {
  const filtered = rows.filter((row) => {
    const at = Date.parse(String(row?.createdAt || row?.created_at || row?.recordedAt || ''));
    return Number.isFinite(at) && at >= cutoffMs;
  });
  const counts = {
    total: filtered.length,
    delivered: 0,
    sent: 0,
    delayed: 0,
    bounced: 0,
    complained: 0,
    failed: 0,
    suppressed: 0,
    opened: 0,
    clicked: 0,
  };
  for (const row of filtered) {
    const status = canonicalStatus(row?.status || row?.type);
    if (status === 'delivered') counts.delivered += 1;
    else if (status === 'sent' || status === 'scheduled') counts.sent += 1;
    else if (status === 'delivery_delayed') counts.delayed += 1;
    else if (status === 'bounced') counts.bounced += 1;
    else if (status === 'complained') counts.complained += 1;
    else if (status === 'failed') counts.failed += 1;
    else if (status === 'suppressed') counts.suppressed += 1;
    else if (status === 'opened') { counts.opened += 1; counts.delivered += 1; }
    else if (status === 'clicked') { counts.clicked += 1; counts.delivered += 1; }
  }
  const problemCount = counts.bounced + counts.complained + counts.failed + counts.suppressed;
  return {
    ...counts,
    problemCount,
    failureRate: counts.total ? Math.round((problemCount / counts.total) * 1000) / 10 : 0,
  };
}

async function checkLogo() {
  const tenant=resolveTenant();
  const logo=String(tenant.brand.logoPath||'').trim();
  const url=/^https?:\/\//i.test(logo) ? logo : (tenantOrigin()+ (logo.startsWith('/')?logo:'/'+logo));
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'KoaEvents-EmailHealth/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    const contentType = response.headers.get('content-type') || '';
    const contentLength = Number(response.headers.get('content-length') || 0);
    const ok = response.ok && contentType.toLowerCase().includes('image/png');
    return {
      ok,
      url,
      status: response.status,
      ms: Date.now() - started,
      contentType,
      contentLength: Number.isFinite(contentLength) ? contentLength : 0,
      detail: ok ? 'Koa source logo asset is reachable as PNG; sent emails embed this PNG inline via CID.' : 'Koa source logo asset did not return a healthy PNG response.',
    };
  } catch (error) {
    return {
      ok: false,
      url,
      status: 0,
      ms: Date.now() - started,
      contentType: '',
      contentLength: 0,
      detail: error instanceof Error ? error.message : 'Logo request failed.',
    };
  }
}

function checkInlineAssets() {
  const html = emailHeader({ brand: 'events', eyebrow: 'Email Health', title: 'Inline asset verification' });
  const attachments = [emailLogoAttachment()];
  const audit = emailInlineAssetAudit(html, attachments);
  return {
    ...audit,
    severity: audit.ok ? 'green' : 'red',
    detail: audit.ok
      ? 'Branded email HTML references a CID logo and the matching inline PNG attachment is present.'
      : audit.detail,
  };
}

export async function checkResendSendAccess() {
  const apiKey = clean(tenantSetting('RESEND_API_KEY'), 500);
  if (!apiKey) {
    return {
      ok: false,
      configured: false,
      status: 0,
      verification: 'missing',
      detail: 'RESEND_API_KEY is not configured, so outbound email cannot be sent.',
    };
  }
  try {
    // A send-only Resend key intentionally cannot list API keys. Resend's explicit
    // send-only 401 therefore verifies that the credential is valid and restricted
    // to sending without dispatching a test message.
    const response = await fetch('https://api.resend.com/api-keys?limit=1', {
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'KoaEvents-EmailHealth/1.0',
      },
      signal: AbortSignal.timeout(10000),
    });
    const body: any = await response.json().catch(() => ({}));
    const message = clean(body?.message || body?.error || '', 300);
    const explicitlySendOnly = response.status === 401 && /restricted to only send emails|only send emails/i.test(message);
    const ok = response.ok || explicitlySendOnly;
    return {
      ok,
      configured: true,
      status: response.status,
      verification: explicitlySendOnly ? 'send-only-permission' : response.ok ? 'full-access-credential' : 'unverified',
      detail: explicitlySendOnly
        ? 'Resend confirmed the production credential is valid and restricted to sending email.'
        : response.ok
          ? 'Resend confirmed the production credential is valid; this key also has broader account access.'
          : (message || 'Resend could not verify the sending credential.'),
    };
  } catch (error) {
    return {
      ok: false,
      configured: true,
      status: 0,
      verification: 'unverified',
      detail: error instanceof Error ? error.message : 'Resend sending credential verification failed.',
    };
  }
}

async function checkResendWebhookConfig() {
  const apiKey = clean(tenantSetting('RESEND_MONITORING_API_KEY'), 500);
  const signingSecretConfigured = clean(tenantSetting('RESEND_WEBHOOK_SECRET'), 500).startsWith('whsec_');
  const endpoint = resendWebhookEndpoint();

  if (!apiKey) {
    return {
      endpoint,
      webhookId: '',
      existsInResend: null,
      enabled: null,
      signingSecretConfigured,
      status: 0,
      detail: signingSecretConfigured
        ? 'Webhook signing secret is configured in Netlify, but Resend webhook existence could not be verified because the monitoring credential is unavailable.'
        : 'Webhook signing secret is missing in Netlify, and Resend webhook existence could not be verified because the monitoring credential is unavailable.',
    };
  }

  try {
    const response = await fetch('https://api.resend.com/webhooks', {
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'KoaEvents-EmailHealth/1.0',
      },
      signal: AbortSignal.timeout(10000),
    });
    const body:any = await response.json().catch(() => ({}));
    const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    const webhook = rows.find((row:any)=>clean(row?.endpoint || row?.url, 500)===endpoint) || null;
    const existsInResend = Boolean(webhook);
    const enabled = webhook ? String(webhook?.status || 'enabled').toLowerCase() !== 'disabled' : false;

    let detail = '';
    if (!response.ok) {
      detail = clean(body?.message || body?.error || 'Resend webhook lookup failed.', 500);
    } else if (!existsInResend) {
      detail = signingSecretConfigured
        ? 'Signing secret is configured in Netlify, but no matching Resend webhook exists for '+endpoint+'.'
        : 'No matching Resend webhook exists, and the signing secret is also missing in Netlify.';
    } else if (!signingSecretConfigured) {
      detail = 'Resend webhook exists'+(enabled?' and is enabled':' but is disabled')+', but RESEND_WEBHOOK_SECRET is missing in Netlify.';
    } else {
      detail = 'Resend webhook exists'+(enabled?' and is enabled':' but is disabled')+', and the Netlify signing secret is configured.';
    }

    return {
      endpoint,
      webhookId: webhook ? clean(webhook?.id, 180) : '',
      existsInResend: response.ok ? existsInResend : null,
      enabled: response.ok ? enabled : null,
      signingSecretConfigured,
      status: response.status,
      detail,
    };
  } catch (error) {
    return {
      endpoint,
      webhookId: '',
      existsInResend: null,
      enabled: null,
      signingSecretConfigured,
      status: 0,
      detail: error instanceof Error ? error.message : 'Resend webhook lookup failed.',
    };
  }
}

function resendHeaders(apiKey:string) {
  return {
    Authorization: 'Bearer ' + apiKey,
    'Content-Type': 'application/json',
    'User-Agent': 'KoaEvents-EmailHealth/1.0',
  };
}

function webhookEventRows(body:any){
  return Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
}

async function listResendWebhookEvents(webhookId:string, limit=10) {
  const apiKey=clean(tenantSetting('RESEND_MONITORING_API_KEY'),500);
  if(!apiKey||!webhookId)return {ok:false,status:0,rows:[] as any[],detail:'Resend monitoring credential or webhook id is unavailable.'};
  try{
    const response=await fetch(
      'https://api.resend.com/webhooks/'+encodeURIComponent(webhookId)+'/events?limit='+Math.max(1,Math.min(100,limit)),
      {headers:resendHeaders(apiKey),signal:AbortSignal.timeout(10000)}
    );
    const body:any=await response.json().catch(()=>({}));
    return {
      ok:response.ok,
      status:response.status,
      rows:webhookEventRows(body),
      detail:response.ok?'Webhook delivery history is available.':clean(body?.message||body?.error||'Webhook event lookup failed.',500),
    };
  }catch(error){
    return {ok:false,status:0,rows:[] as any[],detail:error instanceof Error?error.message:'Webhook event lookup failed.'};
  }
}

async function listResendWebhookAttempts(webhookId:string,eventId:string,limit=10) {
  const apiKey=clean(tenantSetting('RESEND_MONITORING_API_KEY'),500);
  if(!apiKey||!webhookId||!eventId)return {ok:false,status:0,rows:[] as any[],detail:'Resend monitoring credential, webhook id, or event id is unavailable.'};
  try{
    const response=await fetch(
      'https://api.resend.com/webhooks/'+encodeURIComponent(webhookId)+'/events/'+encodeURIComponent(eventId)+'/attempts?limit='+Math.max(1,Math.min(100,limit)),
      {headers:resendHeaders(apiKey),signal:AbortSignal.timeout(10000)}
    );
    const body:any=await response.json().catch(()=>({}));
    return {
      ok:response.ok,
      status:response.status,
      rows:webhookEventRows(body),
      detail:response.ok?'Webhook delivery attempts are available.':clean(body?.message||body?.error||'Webhook attempt lookup failed.',500),
    };
  }catch(error){
    return {ok:false,status:0,rows:[] as any[],detail:error instanceof Error?error.message:'Webhook attempt lookup failed.'};
  }
}

export async function resendWebhookDeliveryStatus() {
  const webhook=await checkResendWebhookConfig();
  if(!webhook.webhookId){
    return {
      available:false,
      webhookId:'',
      endpoint:webhook.endpoint,
      status:'unknown',
      eventId:'',
      eventType:'',
      createdAt:'',
      attempt:null as any,
      detail:webhook.detail,
    };
  }

  const events=await listResendWebhookEvents(webhook.webhookId,10);
  if(!events.ok){
    return {
      available:false,
      webhookId:webhook.webhookId,
      endpoint:webhook.endpoint,
      status:'unknown',
      eventId:'',
      eventType:'',
      createdAt:'',
      attempt:null as any,
      detail:events.detail,
    };
  }

  const event=events.rows.find((row:any)=>['success','failed','pending','attempting'].includes(clean(row?.status,40).toLowerCase()))||events.rows[0]||null;
  if(!event){
    return {
      available:true,
      webhookId:webhook.webhookId,
      endpoint:webhook.endpoint,
      status:'none',
      eventId:'',
      eventType:'',
      createdAt:'',
      attempt:null as any,
      detail:'The Resend webhook is configured, but no delivery events are available yet.',
    };
  }

  const eventId=clean(event?.id,180);
  const attempts=eventId?await listResendWebhookAttempts(webhook.webhookId,eventId,5):null;
  const attempt=attempts?.rows?.[0]||null;
  const status=clean(event?.status,40).toLowerCase()||'unknown';
  const httpStatus=Number(attempt?.http_status_code||0);

  return {
    available:true,
    webhookId:webhook.webhookId,
    endpoint:webhook.endpoint,
    status,
    eventId,
    eventType:clean(event?.type,120),
    createdAt:clean(event?.created_at,100),
    attempt:attempt?{
      id:clean(attempt?.id,180),
      httpStatus,
      sentAt:clean(attempt?.sent_at,100),
      response:clean(attempt?.response,500),
    }:null,
    detail:status==='success'
      ? 'Latest Resend webhook delivery succeeded'+(httpStatus?' with HTTP '+httpStatus:'')+'.'
      : status==='failed'
        ? 'Latest Resend webhook delivery failed'+(httpStatus?' with HTTP '+httpStatus:'')+'.'
        : 'Latest Resend webhook delivery is '+status+'.',
  };
}

function wait(ms:number){
  return new Promise((resolve)=>setTimeout(resolve,ms));
}

export async function testResendWebhookDelivery() {
  const webhook=await checkResendWebhookConfig();
  if(!webhook.webhookId)throw new Error(webhook.detail||'Resend webhook is not available.');
  if(webhook.enabled===false)throw new Error('The Resend webhook exists but is disabled.');

  const events=await listResendWebhookEvents(webhook.webhookId,20);
  if(!events.ok)throw new Error(events.detail||'Unable to list Resend webhook events.');
  const event=events.rows.find((row:any)=>['success','failed'].includes(clean(row?.status,40).toLowerCase()));
  if(!event?.id)throw new Error('No completed Resend webhook event is available to replay safely.');

  const apiKey=clean(tenantSetting('RESEND_MONITORING_API_KEY'),500);
  const eventId=clean(event.id,180);
  const startedAt=Date.now();
  const replay=await fetch(
    'https://api.resend.com/webhooks/'+encodeURIComponent(webhook.webhookId)+'/events/'+encodeURIComponent(eventId)+'/replay',
    {method:'POST',headers:resendHeaders(apiKey),signal:AbortSignal.timeout(10000)}
  );
  const replayBody:any=await replay.json().catch(()=>({}));
  if(!replay.ok)throw new Error(clean(replayBody?.message||replayBody?.error||'Resend webhook replay failed.',500));

  let latestAttempt:any=null;
  for(let index=0;index<8;index+=1){
    await wait(index===0?350:650);
    const attempts=await listResendWebhookAttempts(webhook.webhookId,eventId,10);
    latestAttempt=(attempts.rows||[]).find((row:any)=>{
      const sentAt=Date.parse(String(row?.sent_at||''));
      return Number.isFinite(sentAt)&&sentAt>=startedAt-1000;
    })||null;
    if(latestAttempt)break;
  }

  if(!latestAttempt){
    return {
      ok:true,
      queued:true,
      completed:false,
      eventId,
      eventType:clean(event?.type,120),
      message:'Webhook replay was queued. Resend has not reported the new delivery attempt yet.',
    };
  }

  const httpStatus=Number(latestAttempt?.http_status_code||0);
  const success=httpStatus>=200&&httpStatus<300;
  return {
    ok:success,
    queued:true,
    completed:true,
    eventId,
    eventType:clean(event?.type,120),
    attemptId:clean(latestAttempt?.id,180),
    httpStatus,
    sentAt:clean(latestAttempt?.sent_at,100),
    response:clean(latestAttempt?.response,500),
    message:success
      ? 'Resend replay reached /api/webhooks/resend successfully with HTTP '+httpStatus+'.'
      : 'Resend replay reached /api/webhooks/resend but returned HTTP '+httpStatus+'.',
  };
}

export async function listResendEmails() {
  const apiKey = clean(tenantSetting('RESEND_MONITORING_API_KEY'), 500);
  if (!apiKey) {
    return {
      ok: false,
      configured: false,
      permissionDenied: false,
      status: 0,
      rows: [] as any[],
      detail: 'RESEND_MONITORING_API_KEY is not configured. Delivery history can still use signed webhook events when available.',
    };
  }
  try {
    const response = await fetch('https://api.resend.com/emails?limit=100', {
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'KoaEvents-EmailHealth/1.0',
      },
      signal: AbortSignal.timeout(10000),
    });
    const body: any = await response.json().catch(() => ({}));
    const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    const detail = response.ok
      ? 'Resend delivery history is available through the dedicated monitoring credential.'
      : clean(body?.message || 'Resend history request failed.', 300);
    return {
      ok: response.ok,
      configured: true,
      permissionDenied: response.status === 401 || response.status === 403,
      status: response.status,
      rows: rows.map((row: any) => ({
        emailId: clean(row?.id, 180),
        status: canonicalStatus(row?.last_event || row?.status || row?.event),
        createdAt: clean(row?.created_at || row?.createdAt, 100),
        from: clean(row?.from, 300),
        to: Array.isArray(row?.to) ? row.to.map((value:any)=>clean(value,240)).filter(Boolean) : normalizeAddressList(row?.to),
        subject: clean(row?.subject, 500),
      })),
      detail,
    };
  } catch (error) {
    return {
      ok: false,
      configured: true,
      permissionDenied: false,
      status: 0,
      rows: [] as any[],
      detail: error instanceof Error ? error.message : 'Resend history request failed.',
    };
  }
}

export async function emailActivityLog(limit=100) {
  const resend=await listResendEmails();
  if(!resend.ok) return {ok:false,configured:resend.configured,status:resend.status,detail:resend.detail,rows:[] as any[]};
  return {
    ok:true,
    configured:true,
    status:resend.status,
    detail:resend.detail,
    rows:resend.rows.slice(0,Math.max(1,Math.min(100,limit))).map((row:any)=>({
      emailId:clean(row?.emailId,180),
      resendMessageId:clean(row?.emailId,180),
      recipient:Array.isArray(row?.to)?row.to.join(', '):clean(row?.to,500),
      recipients:Array.isArray(row?.to)?row.to:normalizeAddressList(row?.to),
      subject:clean(row?.subject,500)||'(subject unavailable)',
      emailType:classifyEmailType(row?.subject),
      status:canonicalStatus(row?.status)||'unknown',
      sent:!['failed','bounced','complained','suppressed'].includes(canonicalStatus(row?.status)),
      createdAt:clean(row?.createdAt,100),
      from:clean(row?.from,300),
    })),
  };
}

export async function recordEmailHealthEvent(context: Context, input: {
  emailId?: string;
  type?: string;
  createdAt?: string;
  from?: string;
  to?: string[];
  subject?: string;
  messageId?: string;
  bounceType?: string;
  bounceSubType?: string;
  bounceMessage?: string;
  failureReason?: string;
}) {
  const emailId = clean(input?.emailId, 180);
  const type = canonicalStatus(input?.type);
  if (!emailId || !type) return null;
  const event: EmailHealthEvent = {
    id: 'EML-' + crypto.randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase(),
    emailId,
    type,
    status: type,
    createdAt: clean(input?.createdAt, 100) || new Date().toISOString(),
    recordedAt: new Date().toISOString(),
    from: clean(input?.from, 300),
    to: Array.isArray(input?.to) ? input.to.map((value)=>clean(value,240)).filter(Boolean).slice(0,50) : [],
    subject: clean(input?.subject, 500),
    messageId: clean(input?.messageId, 300),
    bounceType: clean(input?.bounceType, 120),
    bounceSubType: clean(input?.bounceSubType, 160),
    bounceMessage: clean(input?.bounceMessage, 1000),
    failureReason: clean(input?.failureReason, 1000),
  };
  const store = storeFor(context);
  const rows = ((await store.get('email/events', { type: 'json' })) || []) as EmailHealthEvent[];
  const deduped = rows.filter((row) => !(row.emailId === event.emailId && row.type === event.type));
  await store.setJSON('email/events', [event, ...deduped].slice(0, 5000));
  return event;
}

export async function readEmailHealthEvents(context: Context, limit = 1000) {
  const rows = ((await storeFor(context).get('email/events', { type: 'json' })) || []) as EmailHealthEvent[];
  return rows.slice(0, Math.max(1, Math.min(5000, limit)));
}

export async function emailHealthSummary(context: Context, options: EmailHealthSummaryOptions = {}) {
  const store = storeFor(context);
  const cached: any = await store.get('email/summary', { type: 'json' });
  const cachedAt = Date.parse(String(cached?.generatedAt || ''));
  if (!options.force && Number.isFinite(cachedAt) && Date.now() - cachedAt < 5 * 60 * 1000) return cached;

  const inlineAssets = checkInlineAssets();
  const [logo, sendAccess, resend, webhookEvents, webhook, webhookDelivery] = await Promise.all([
    checkLogo(),
    checkResendSendAccess(),
    listResendEmails(),
    readEmailHealthEvents(context, 5000),
    checkResendWebhookConfig(),
    resendWebhookDeliveryStatus(),
  ]);

  const webhookConfigured = Boolean(webhook.signingSecretConfigured);
  const rows = resend.ok && resend.rows.length ? resend.rows : webhookEvents;
  const source = resend.ok && resend.rows.length ? 'resend-api' : webhookEvents.length ? 'signed-webhook-history' : 'none';
  const now = Date.now();
  const period24h = statusCounts(rows, now - 24 * 60 * 60 * 1000);
  const period7d = statusCounts(rows, now - 7 * 24 * 60 * 60 * 1000);
  const recentIssues = rows
    .map((row: any) => ({
      emailId: clean(row?.emailId || row?.id, 180),
      status: canonicalStatus(row?.status || row?.type),
      createdAt: clean(row?.createdAt || row?.created_at || row?.recordedAt, 100),
    }))
    .filter((row: any) => ['bounced', 'complained', 'failed', 'suppressed', 'delivery_delayed'].includes(row.status))
    .sort((a: any, b: any) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''))
    .slice(0, 10);

  const monitoringAccessSeverity = resend.ok
    ? 'green'
    : resend.permissionDenied || !resend.configured
      ? 'yellow'
      : 'yellow';
  const deliverySeverity = period24h.complained > 0 || period24h.failureRate >= 5
    ? 'red'
    : period24h.problemCount > 0 || period24h.delayed > 0 || (!resend.ok && !webhookEvents.length)
      ? 'yellow'
      : 'green';

  const templateCompatibility = {
    passed: true,
    source: 'build-safety',
    commit: clean(Netlify.env.get('COMMIT_REF'), 100),
    templateCount: COMPATIBILITY_TEMPLATES.length,
    templates: [...COMPATIBILITY_TEMPLATES],
    checks: [...COMPATIBILITY_CHECKS],
    detail: 'Production deploys are blocked when the automated email compatibility gate fails.',
  };

  const webhookAttention = webhook.existsInResend === false || webhook.enabled === false || !webhookConfigured;
  const overall = !logo.ok || !inlineAssets.ok || !templateCompatibility.passed || deliverySeverity === 'red' || !sendAccess.ok
    ? 'red'
    : deliverySeverity === 'yellow' || monitoringAccessSeverity === 'yellow' || webhookAttention
      ? 'yellow'
      : 'green';

  const summary = {
    generatedAt: new Date().toISOString(),
    overall,
    logo,
    inlineAssets,
    sendAccess,
    monitoringAccess: {
      severity: monitoringAccessSeverity,
      configured: resend.configured,
      reachable: resend.ok,
      permissionDenied: Boolean(resend.permissionDenied),
      status: resend.status,
      detail: resend.detail,
    },
    delivery: {
      source,
      severity: deliverySeverity,
      apiConfigured: resend.configured,
      apiReachable: resend.ok,
      apiStatus: resend.status,
      apiDetail: resend.detail,
      webhookConfigured,
      webhook: {
        endpoint: webhook.endpoint,
        webhookId: webhook.webhookId,
        existsInResend: webhook.existsInResend,
        enabled: webhook.enabled,
        signingSecretConfigured: webhook.signingSecretConfigured,
        lookupStatus: webhook.status,
        detail: webhook.detail,
      },
      webhookDelivery,
      period24h,
      period7d,
      recentIssues,
    },
    templateCompatibility,
  };
  await store.setJSON('email/summary', summary);
  return summary;
}
