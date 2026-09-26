import type { Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';

export type EmailHealthEvent = {
  id: string;
  emailId: string;
  type: string;
  status: string;
  createdAt: string;
  recordedAt: string;
};

type EmailHealthSummaryOptions = {
  force?: boolean;
};

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
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-system-health', consistency: 'strong' })
    : getDeployStore({ name: 'koa-system-health' });
}

function clean(value: unknown, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function canonicalStatus(value: unknown) {
  return clean(value, 80).toLowerCase().replace(/^email\./, '').replace(/-/g, '_');
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
  const url = 'https://koasevents.com/brand/koa-mark.png';
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

export async function checkResendSendAccess() {
  const apiKey = clean(Netlify.env.get('RESEND_API_KEY'), 500);
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

export async function listResendEmails() {
  const apiKey = clean(Netlify.env.get('RESEND_MONITORING_API_KEY'), 500);
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

export async function recordEmailHealthEvent(context: Context, input: {
  emailId?: string;
  type?: string;
  createdAt?: string;
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

  const [logo, sendAccess, resend, webhookEvents] = await Promise.all([
    checkLogo(),
    checkResendSendAccess(),
    listResendEmails(),
    readEmailHealthEvents(context, 5000),
  ]);

  const webhookConfigured = clean(Netlify.env.get('RESEND_WEBHOOK_SECRET'), 500).startsWith('whsec_');
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

  const overall = !logo.ok || !templateCompatibility.passed || deliverySeverity === 'red' || !sendAccess.ok
    ? 'red'
    : deliverySeverity === 'yellow' || monitoringAccessSeverity === 'yellow' || !webhookConfigured
      ? 'yellow'
      : 'green';

  const summary = {
    generatedAt: new Date().toISOString(),
    overall,
    logo,
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
      period24h,
      period7d,
      recentIssues,
    },
    templateCompatibility,
  };
  await store.setJSON('email/summary', summary);
  return summary;
}
