import type { Config, Context } from '@netlify/functions';
import { resolveTenantAsync, runWithTenant } from './_shared/tenant.ts';
import { tenantStoreFor } from './_shared/tenant-storage.ts';

const ALLOWED_TYPES = new Set([
  'page_view','cta_click','package_card_click','comparison_package_click',
  'comparison_guest_count_change','quote_package_select','estimate_configured',
  'event_details_started','security_complete','submit_attempt',
  'quote_submit_success','quote_submit_error','quote_abandon',
]);
const ALLOWED_PACKAGES = new Set(['mobile-oahu','mobile-maui','mobile-big-island','mobile-custom']);

function clean(value: unknown, max = 180) {
  return String(value ?? '').trim().slice(0, max);
}

function mobileIngestSecret() {
  const dedicated = clean(Netlify.env.get('KOA_MOBILE_BAR_INGEST_SECRET'), 300);
  if (dedicated) return dedicated;
  const turnstile = clean(Netlify.env.get('TURNSTILE_SECRET_KEY') || Netlify.env.get('TURNSTILE_SECRET'), 300);
  return turnstile ? 'koa-mobile-bar-ingest-v1:' + turnstile : '';
}

function base64Url(bytes: ArrayBuffer) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function hmac(secret: string, value: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

async function verifyMobileAnalyticsSource(req: Request) {
  const secret = mobileIngestSecret();
  if (!secret) return false;

  const fingerprint = clean(req.headers.get('x-koa-mobile-source'), 40).toLowerCase();
  const timestamp = clean(req.headers.get('x-koa-mobile-timestamp'), 20);
  const signature = clean(req.headers.get('x-koa-mobile-signature'), 160);
  if (!fingerprint || !timestamp || !signature) return false;

  const issuedAt = Number(timestamp);
  if (!Number.isFinite(issuedAt) || Math.abs(Math.floor(Date.now() / 1000) - issuedAt) > 300) return false;

  const expected = await hmac(secret, 'v1|' + timestamp + '|' + fingerprint + '|koa-mobile-bar-analytics');
  if (expected.length !== signature.length) return false;

  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }
  return mismatch === 0;
}

export default async (req: Request, context: Context) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const tenant = await resolveTenantAsync(req, context).catch(() => null);
  if (!tenant) return new Response('Unknown tenant', { status: 404 });

  return runWithTenant(tenant, async () => {
    if (!(await verifyMobileAnalyticsSource(req))) {
      return Response.json({ error: 'Mobile Bar analytics source authentication failed.' }, { status: 403 });
    }

    const raw = await req.text();
    if (raw.length > 8_000) return Response.json({ error: 'Analytics event is too large.' }, { status: 413 });

    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return Response.json({ error: 'Invalid analytics event.' }, { status: 400 });
    }

    const type = clean(body?.type, 64);
    const sessionId = clean(body?.sessionId, 100);
    if (!ALLOWED_TYPES.has(type) || !/^[a-zA-Z0-9-]{12,100}$/.test(sessionId)) {
      return Response.json({ error: 'Invalid analytics event.' }, { status: 400 });
    }

    const packageValue = clean(body?.packageId, 80);
    const packageId = ALLOWED_PACKAGES.has(packageValue) ? packageValue : '';
    const guestCountRaw = Number(body?.guestCount);
    const estimatedTotalRaw = Number(body?.estimatedTotal);
    const now = new Date().toISOString();

    const event = {
      eventId: clean(body?.eventId, 100) || 'AN-' + crypto.randomUUID(),
      sessionId,
      type,
      page: clean(body?.page, 180),
      referrerHost: clean(body?.referrerHost, 180),
      stage: clean(body?.stage, 64),
      packageId,
      placement: clean(body?.placement, 80),
      guestCount: Number.isFinite(guestCountRaw) ? Math.max(0, Math.min(1000, Math.round(guestCountRaw))) : 0,
      estimatedTotal: Number.isFinite(estimatedTotalRaw)
        ? Math.max(0, Math.min(1_000_000, Math.round(estimatedTotalRaw * 100) / 100))
        : 0,
      recordId: clean(body?.recordId, 100),
      clientAt: clean(body?.clientAt, 60),
      serverAt: now,
    };

    const store = tenantStoreFor(context, tenant, 'sales');
    const key = 'analytics/mobile-bar/events/index';
    const current = (await store.get(key, { type: 'json' })) || [];
    const rows = Array.isArray(current) ? current : [];

    if (!rows.some((row: any) => row?.eventId === event.eventId)) {
      await store.setJSON(key, [event, ...rows].slice(0, 25_000));
    }

    return Response.json({ ok: true }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  });
};

export const config: Config = {
  path: '/api/crm/mobile-bar-analytics',
  rateLimit: {
    windowLimit: 140,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};
