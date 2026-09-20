import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';

function salesStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-sales', consistency: 'strong' })
    : getDeployStore({ name: 'koa-sales' });
}

function cleanText(value: unknown, max = 1200) {
  return String(value || '').trim().slice(0, max);
}

function cleanNumber(value: unknown, min = 0, max = 1000000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : 0;
}

function cleanLineItems(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).map((line: any, index: number) => {
    const quantity = Math.max(1, Math.round(cleanNumber(line?.quantity, 1, 2000)));
    const unitPrice = cleanNumber(line?.unitPrice, 0, 1000000);
    const amount = cleanNumber(line?.amount ?? quantity * unitPrice, 0, 10000000);
    return {
      id: cleanText(line?.id || 'line-' + (index + 1), 80),
      description: cleanText(line?.description, 240),
      quantity,
      unitPrice: Math.round(unitPrice * 100) / 100,
      amount: Math.round(amount * 100) / 100,
      custom: Boolean(line?.custom),
    };
  }).filter((line) => line.description);
}

function cleanStringList(value: unknown, maxItems = 30, maxLength = 160) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((item) => cleanText(item, maxLength)).filter(Boolean);
}

function idSuffix() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function verifyTurnstile(req: Request, token: unknown) {
  const secret = String(process.env.TURNSTILE_SECRET_KEY || '').trim();
  if (!secret) return { ok: true, configured: false };

  const responseToken = cleanText(token, 4096);
  if (!responseToken) return { ok: false, configured: true, error: 'Complete the security check and try again.' };

  const remoteIp =
    cleanText(req.headers.get('x-nf-client-connection-ip'), 80) ||
    cleanText(req.headers.get('cf-connecting-ip'), 80) ||
    cleanText(req.headers.get('x-forwarded-for')?.split(',')[0], 80);

  const body = new URLSearchParams({
    secret,
    response: responseToken,
    ...(remoteIp ? { remoteip: remoteIp } : {}),
  });

  try {
    const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data: any = await result.json().catch(() => null);
    return {
      ok: Boolean(result.ok && data?.success),
      configured: true,
      error: data?.success ? '' : 'Security verification failed. Please try again.',
      codes: Array.isArray(data?.['error-codes']) ? data['error-codes'] : [],
    };
  } catch {
    return { ok: false, configured: true, error: 'Security verification is temporarily unavailable. Please try again.' };
  }
}

async function appendEvent(store: any, event: Record<string, unknown>) {
  const current = (await store.get('analytics/events/index', { type: 'json' })) || [];
  await store.setJSON('analytics/events/index', [event, ...current].slice(0, 10000));
}

function allowedOrigin(req: Request) {
  const origin = req.headers.get('origin') || '';
  if (!origin) return '';
  const requestOrigin = new URL(req.url).origin;
  const allowed = new Set([
    requestOrigin,
    'https://koasmobilebar.com',
    'https://www.koasmobilebar.com',
  ]);
  return allowed.has(origin) ? origin : '';
}

function responseHeaders(req: Request) {
  const origin = allowedOrigin(req);
  return {
    'Cache-Control': 'private, no-store',
    ...(origin ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Koa-Inquiry-Capture, X-Koa-Inquiry-QA',
      'Vary': 'Origin',
    } : {}),
  };
}

function json(req: Request, body: unknown, status = 200) {
  return Response.json(body, { status, headers: responseHeaders(req) });
}

export default async (req: Request, context: Context) => {
  const origin = req.headers.get('origin');
  if (origin && !allowedOrigin(req)) {
    return Response.json({ error: 'Cross-site inquiry capture is not allowed.' }, { status: 403 });
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: responseHeaders(req) });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: responseHeaders(req) });

  if (req.headers.get('x-koa-inquiry-capture') !== '1') {
    return json(req, { error: 'Missing inquiry-capture request header.' }, 400);
  }

  const rawBody = await req.text();
  if (rawBody.length > 80_000) return json(req, { error: 'Inquiry is too large.' }, 413);

  let payload: any;
  try { payload = JSON.parse(rawBody); } catch { return json(req, { error: 'Invalid JSON.' }, 400); }

  if (cleanText(payload.honeypot, 120)) {
    return json(req, { ok: true, id: '' });
  }

  const turnstile = await verifyTurnstile(req, payload.turnstileToken);
  if (!turnstile.ok) {
    return json(req, {
      error: turnstile.error || 'Security verification failed.',
      code: 'turnstile_failed',
    }, 403);
  }

  const now = new Date();
  const id = 'KEI-' + now.getUTCFullYear() + '-' + idSuffix();
  const formName = cleanText(payload.formName, 80);
  const quoteId = cleanText(payload.quoteId, 24).toUpperCase();
  const packageId = cleanText(payload.packageId, 80);
  const store = salesStoreFor(context);

  const record = {
    id,
    kind: 'inquiry',
    stage: 'inquiry',
    status: 'new',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    source: formName || 'website',
    quoteId,
    packageId,
    customer: {
      name: cleanText(payload.customer?.name, 180),
      email: cleanText(payload.customer?.email, 240),
      phone: cleanText(payload.customer?.phone, 80),
      eventDate: cleanText(payload.customer?.eventDate, 40),
      notes: cleanText(payload.customer?.notes, 4000),
    },
    inquiry: {
      formName,
      service: cleanText(payload.inquiry?.service, 80),
      eventType: cleanText(payload.inquiry?.eventType, 120),
      guestCount: Math.round(cleanNumber(payload.inquiry?.guestCount, 0, 1000)),
      budget: cleanText(payload.inquiry?.budget, 120),
      venuePackage: cleanText(payload.inquiry?.venuePackage, 80),
      mobileBarPackage: cleanText(payload.inquiry?.mobileBarPackage, 80),
      eventLocation: cleanText(payload.inquiry?.eventLocation, 320),
      priorities: cleanText(payload.inquiry?.priorities, 4000),
      source: cleanText(payload.inquiry?.source, 200),
      alternativeDate: cleanText(payload.inquiry?.alternativeDate, 40),
      contactMethod: cleanText(payload.inquiry?.contactMethod, 80),
      referralSource: cleanText(payload.inquiry?.referralSource, 120),
      serviceHours: cleanNumber(payload.inquiry?.serviceHours, 0, 24),
      oneWayMiles: cleanNumber(payload.inquiry?.oneWayMiles, 0, 500),
      bartenderCount: Math.round(cleanNumber(payload.inquiry?.bartenderCount, 0, 20)),
      gratuityMode: cleanText(payload.inquiry?.gratuityMode, 80),
      glasswareCount: Math.round(cleanNumber(payload.inquiry?.glasswareCount, 0, 2000)),
      estimatedTotal: Math.round(cleanNumber(payload.inquiry?.estimatedTotal, 0, 10000000) * 100) / 100,
      estimateLineItems: cleanLineItems(payload.inquiry?.estimateLineItems),
      customAddOns: cleanStringList(payload.inquiry?.customAddOns),
      calculatorVersion: cleanText(payload.inquiry?.calculatorVersion, 40),
      selectedCatalogItems: cleanText(payload.inquiry?.selectedCatalogItems, 8000),
      automaticRentalBreakdown: cleanText(payload.inquiry?.automaticRentalBreakdown, 8000),
      manualAddOns: cleanText(payload.inquiry?.manualAddOns, 8000),
      catalogSelectionState: cleanText(payload.inquiry?.catalogSelectionState, 30000),
    },
  };

  const qaMode =
    req.headers.get('x-koa-inquiry-qa') === '1' &&
    formName === 'koa-mobile-bar-qa' &&
    /^qa\+[a-z0-9._-]+@example\.com$/i.test(record.customer.email);

  if (qaMode) {
    const qaKey = 'qa/records/' + id;
    await store.setJSON(qaKey, record);
    const stored = await store.get(qaKey, { type: 'json' });
    await store.delete(qaKey);
    if (!stored) return json(req, { error: 'CRM QA round-trip storage failed.' }, 500);
    return json(req, {
      ok: true,
      id,
      qa: true,
      record: {
        id: stored.id,
        source: stored.source,
        packageId: stored.packageId,
        customer: stored.customer,
        inquiry: stored.inquiry,
      },
    });
  }

  const current = (await store.get('records/index', { type: 'json' })) || [];
  await store.setJSON('records/' + id, record);
  await store.setJSON('records/index', [record, ...current].slice(0, 1500));

  await appendEvent(store, {
    id: 'EVT-' + idSuffix(),
    type: 'inquiry',
    packageId: packageId || record.inquiry.venuePackage || record.inquiry.mobileBarPackage || '',
    quoteId,
    recordId: id,
    createdAt: now.toISOString(),
    detail: record.inquiry.service === 'mobile-bar' && record.inquiry.estimatedTotal
      ? 'Mobile bar estimate submitted at $' + Number(record.inquiry.estimatedTotal).toFixed(2)
      : '',
  });

  return json(req, { ok: true, id });
};

export const config: Config = { path: '/api/crm/inquiries' };
