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

function idSuffix() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function appendEvent(store: any, event: Record<string, unknown>) {
  const current = (await store.get('analytics/events/index', { type: 'json' })) || [];
  await store.setJSON('analytics/events/index', [event, ...current].slice(0, 10000));
}

export default async (req: Request, context: Context) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const origin = req.headers.get('origin');
  const requestOrigin = new URL(req.url).origin;
  if (origin && origin !== requestOrigin) {
    return Response.json({ error: 'Cross-site inquiry capture is not allowed.' }, { status: 403 });
  }
  if (req.headers.get('x-koa-inquiry-capture') !== '1') {
    return Response.json({ error: 'Missing inquiry-capture request header.' }, { status: 400 });
  }

  const rawBody = await req.text();
  if (rawBody.length > 80_000) return Response.json({ error: 'Inquiry is too large.' }, { status: 413 });

  let payload: any;
  try { payload = JSON.parse(rawBody); } catch { return Response.json({ error: 'Invalid JSON.' }, { status: 400 }); }

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
      selectedCatalogItems: cleanText(payload.inquiry?.selectedCatalogItems, 8000),
      automaticRentalBreakdown: cleanText(payload.inquiry?.automaticRentalBreakdown, 8000),
      manualAddOns: cleanText(payload.inquiry?.manualAddOns, 8000),
      catalogSelectionState: cleanText(payload.inquiry?.catalogSelectionState, 30000),
    },
  };

  const current = (await store.get('records/index', { type: 'json' })) || [];
  await store.setJSON('records/' + id, record);
  await store.setJSON('records/index', [record, ...current].slice(0, 1500));

  await appendEvent(store, {
    id: 'EVT-' + idSuffix(),
    type: 'inquiry',
    packageId: packageId || record.inquiry.venuePackage || '',
    quoteId,
    recordId: id,
    createdAt: now.toISOString(),
  });

  return Response.json({ ok: true, id }, { headers: { 'Cache-Control': 'private, no-store' } });
};

export const config: Config = { path: '/api/crm/inquiries' };
