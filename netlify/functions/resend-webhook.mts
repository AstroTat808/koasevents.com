import type { Config, Context } from '@netlify/functions';
import { getStore } from '@netlify/blobs';

type CommunicationState = {
  messageId?: string;
  status?: string;
  sentAt?: string;
  updatedAt?: string;
};

function normalizeStatus(value: unknown) {
  const event = String(value || '').trim().toLowerCase().replace(/^email\./, '');
  if (event === 'delivered') return 'delivered';
  if (event === 'bounced') return 'bounced';
  if (event === 'failed' || event === 'suppressed' || event === 'complained') return 'failed';
  if (event === 'sent' || event === 'delivery_delayed' || event === 'scheduled') return 'sent';
  return '';
}

function statusEventType(status: string) {
  if (status === 'delivered') return 'email_delivered';
  if (status === 'bounced') return 'email_bounced';
  if (status === 'failed') return 'email_failed';
  return 'email_sent';
}

function communicationLabel(key: string) {
  const labels: Record<string, string> = {
    internalNotification: 'Team lead notification',
    clientConfirmation: 'Client confirmation',
    discoveryNotification: 'Discovery Call team notification',
    discoveryConfirmation: 'Discovery Call client confirmation',
    responseReminder: 'Internal response reminder',
  };
  return labels[key] || key.replace(/([A-Z])/g, ' $1').trim();
}

function base64ToBytes(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}

async function verifyWebhookSignature(req: Request, rawBody: string) {
  const secret = String(Netlify.env.get('RESEND_WEBHOOK_SECRET') || '').trim();
  if (!secret.startsWith('whsec_')) return false;

  const messageId = req.headers.get('svix-id') || '';
  const timestamp = req.headers.get('svix-timestamp') || '';
  const signatureHeader = req.headers.get('svix-signature') || '';
  if (!messageId || !timestamp || !signatureHeader) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(Date.now() / 1000 - timestampSeconds) > 5 * 60) return false;

  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(secret.slice('whsec_'.length));
  } catch {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signedContent = messageId + '.' + timestamp + '.' + rawBody;
  const digest = new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signedContent),
  ));

  const signatures = signatureHeader
    .split(' ')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.startsWith('v1,') ? entry.slice(3) : '')
    .filter(Boolean);

  return signatures.some((value) => {
    try {
      return timingSafeEqual(digest, base64ToBytes(value));
    } catch {
      return false;
    }
  });
}

export default async (req: Request, context: Context) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const raw = await req.text();
  if (raw.length > 100_000) return new Response('Payload too large', { status: 413 });

  if (!(await verifyWebhookSignature(req, raw))) {
    return new Response('Invalid webhook signature', { status: 401 });
  }

  const payload: any = (() => {
    try { return JSON.parse(raw); } catch { return null; }
  })();
  if (!payload) return new Response('Invalid JSON', { status: 400 });

  const emailId = String(payload?.data?.email_id || payload?.data?.id || '').trim();
  if (!emailId) return new Response(null, { status: 204 });

  // The payload is authoritative only after Svix signature verification above.
  // Using the signed event type also keeps this endpoint compatible with a
  // sending-only Resend API key.
  const status = normalizeStatus(payload?.type);
  if (!status) return new Response(null, { status: 204 });

  const store = getStore({ name: 'koa-sales', consistency: 'strong' });
  const records: any[] = (await store.get('records/index', { type: 'json' })) || [];
  const matches: Array<{ record: any; key: string }> = [];

  for (const record of records) {
    const communications = record?.communications || {};
    for (const [key, value] of Object.entries(communications) as Array<[string, CommunicationState]>) {
      if (String(value?.messageId || '') === emailId) matches.push({ record, key });
    }
  }

  if (!matches.length) return new Response(null, { status: 204 });

  const now = new Date().toISOString();
  const changedRecordIds = new Set<string>();
  const newEvents: any[] = [];

  for (const match of matches) {
    const current = match.record.communications?.[match.key] || {};
    if (current.status === status) continue;

    match.record.communications = {
      ...(match.record.communications || {}),
      [match.key]: {
        ...current,
        messageId: emailId,
        status,
        updatedAt: now,
      },
    };
    changedRecordIds.add(match.record.id);
    newEvents.push({
      id: 'EVT-' + crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase(),
      type: statusEventType(status),
      packageId: match.record.packageId || match.record.inquiry?.venuePackage || match.record.inquiry?.mobileBarPackage || '',
      quoteId: match.record.quoteId || '',
      recordId: match.record.id,
      createdAt: now,
      detail: communicationLabel(match.key) + ': ' + (status === 'sent' ? 'Email sent' : status.charAt(0).toUpperCase() + status.slice(1)),
      reference: emailId,
    });
  }

  if (!changedRecordIds.size) return new Response(null, { status: 204 });

  for (const record of records) {
    if (changedRecordIds.has(record.id)) {
      await store.setJSON('records/' + record.id, record);
    }
  }
  await store.setJSON('records/index', records.slice(0, 1500));

  if (newEvents.length) {
    const currentEvents = (await store.get('analytics/events/index', { type: 'json' })) || [];
    await store.setJSON('analytics/events/index', [...newEvents, ...currentEvents].slice(0, 10000));
  }

  return Response.json({ ok: true, updated: changedRecordIds.size }, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
};

export const config: Config = {
  path: '/api/webhooks/resend',
  rateLimit: {
    windowLimit: 120,
    windowSize: 60,
    aggregateBy: ['ip'],
  },
};
