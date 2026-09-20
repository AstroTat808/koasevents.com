import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import {
  analyzeInquirySecurity,
  applyAutomaticBlocks,
  findActiveBlock,
  getSecurityEvents,
  ipFingerprint,
  recordSecurityEvent,
  securityIdentity,
} from './_shared/security.ts';

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

function turnstileSecret() {
  return String(Netlify.env.get('TURNSTILE_SECRET_KEY') || '').trim();
}

function mobileIngestSecret() {
  return String(Netlify.env.get('KOA_MOBILE_BAR_INGEST_SECRET') || '').trim();
}

async function verifyMobileSource(req: Request, formName: string) {
  if (formName !== 'koa-mobile-bar-inquiry') return { ok: true, fingerprint: '' };

  const secret = mobileIngestSecret();
  if (!secret) return { ok: false, fingerprint: '', reason: 'Mobile Bar ingest secret is not configured.' };

  const fingerprint = cleanText(req.headers.get('x-koa-mobile-source'), 40).toLowerCase();
  const timestamp = cleanText(req.headers.get('x-koa-mobile-timestamp'), 20);
  const signature = cleanText(req.headers.get('x-koa-mobile-signature'), 160);

  if (!fingerprint || !timestamp || !signature) {
    return { ok: false, fingerprint: '', reason: 'Mobile Bar source authentication is missing.' };
  }

  const issuedAt = Number(timestamp);
  if (!Number.isFinite(issuedAt) || Math.abs(Math.floor(Date.now() / 1000) - issuedAt) > 300) {
    return { ok: false, fingerprint: '', reason: 'Mobile Bar source authentication expired.' };
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expectedBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode('v1|' + timestamp + '|' + fingerprint + '|koa-mobile-bar-inquiry'),
  );
  const expected = base64Url(expectedBuffer);

  if (expected.length !== signature.length) return { ok: false, fingerprint: '', reason: 'Mobile Bar source authentication failed.' };

  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }
  return mismatch === 0
    ? { ok: true, fingerprint }
    : { ok: false, fingerprint: '', reason: 'Mobile Bar source authentication failed.' };
}

function base64Url(bytes: ArrayBuffer) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function createTurnstileProof(formName: string, email: unknown) {
  const secret = turnstileSecret();
  if (!secret) return '';

  const issuedAt = Math.floor(Date.now() / 1000);
  const normalizedEmail = cleanText(email, 240).toLowerCase();
  const message = formName + '|' + normalizedEmail + '|' + issuedAt;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return issuedAt + '.' + base64Url(signature);
}

async function verifyTurnstile(req: Request, token: unknown, expectedAction: string) {
  const secret = turnstileSecret();
  if (!secret) return { ok: true, configured: false };

  const responseToken = cleanText(token, 2048);
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
      signal: AbortSignal.timeout(10_000),
    });
    const data: any = await result.json().catch(() => null);
    const requestHostname = new URL(req.url).hostname.toLowerCase();
    const verifiedHostname = cleanText(data?.hostname, 255).toLowerCase();
    const verifiedAction = cleanText(data?.action, 64);

    return {
      ok: Boolean(
        result.ok &&
        data?.success &&
        verifiedAction === expectedAction &&
        verifiedHostname === requestHostname
      ),
      configured: true,
      error: data?.success ? 'Security verification did not match this form. Please try again.' : 'Security verification failed. Please try again.',
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
      'Access-Control-Allow-Headers': 'Content-Type, X-Koa-Inquiry-Capture, X-Koa-Inquiry-QA, X-Koa-Mobile-Source, X-Koa-Mobile-Timestamp, X-Koa-Mobile-Signature',
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

  const formName = cleanText(payload.formName, 80);
  const mobileSource = await verifyMobileSource(req, formName);
  if (!mobileSource.ok) {
    return json(req, { error: 'Mobile Bar source authentication failed.', code: 'mobile_source_auth_failed' }, 403);
  }
  const sourceFingerprint = mobileSource.fingerprint || await ipFingerprint(req);
  const identity = await securityIdentity(payload);

  const activeBlock = await findActiveBlock(context, {
    networkFingerprint: sourceFingerprint,
    emailFingerprint: identity.emailFingerprint,
    emailDomain: identity.emailDomain,
  });

  if (activeBlock) {
    const securityEvent = await recordSecurityEvent(context, req, {
      disposition: 'blocked',
      category: 'blocklist',
      formName,
      reasons: ['Submission matched an active ' + activeBlock.target + ' blocklist entry'],
      reasonCodes: ['blocklist_' + activeBlock.target],
      riskScore: 100,
      ipFingerprint: sourceFingerprint,
      ...identity,
      detail: activeBlock.permanent
        ? 'Blocked by a permanent ' + activeBlock.target + ' rule.'
        : 'Blocked until ' + activeBlock.expiresAt + ' by a ' + activeBlock.target + ' rule.',
    });
    const blockHistory = await getSecurityEvents(context);
    await applyAutomaticBlocks(context, securityEvent, blockHistory);
    return json(req, {
      error: 'We could not accept this submission.',
      code: 'blocked',
    }, 403);
  }

  if (cleanText(payload.honeypot, 120)) {
    const securityEvent = await recordSecurityEvent(context, req, {
      disposition: 'blocked',
      category: 'honeypot',
      formName,
      reasons: ['Hidden honeypot field was populated'],
      reasonCodes: ['honeypot'],
      riskScore: 100,
      ipFingerprint: sourceFingerprint,
      ...identity,
      detail: 'Submission silently discarded by the honeypot check.',
    });
    const honeypotHistory = await getSecurityEvents(context);
    await applyAutomaticBlocks(context, securityEvent, honeypotHistory);
    return json(req, { ok: true, id: '' });
  }


  const protectedActions: Record<string, string> = {
    'koa-event-inquiry': 'event_inquiry',
    'koa-wedding-inquiry': 'wedding_inquiry',
  };
  const expectedTurnstileAction = protectedActions[formName] || '';

  if (expectedTurnstileAction) {
    const turnstile = await verifyTurnstile(req, payload.turnstileToken, expectedTurnstileAction);
    if (!turnstile.ok) {
      const securityEvent = await recordSecurityEvent(context, req, {
        disposition: 'blocked',
        category: 'turnstile_failed',
        formName,
        reasons: ['Cloudflare Turnstile verification failed'],
        reasonCodes: ['turnstile_failed', ...((turnstile.codes || []).slice(0, 4))],
        riskScore: 100,
        ipFingerprint: sourceFingerprint,
        ...identity,
        detail: 'Rejected before CRM storage.',
      });
      const turnstileHistory = await getSecurityEvents(context);
      await applyAutomaticBlocks(context, securityEvent, turnstileHistory);
      return json(req, {
        error: turnstile.error || 'Security verification failed.',
        code: 'turnstile_failed',
      }, 403);
    }
  }

  const recentSecurityEvents = await getSecurityEvents(context);
  const security = await analyzeInquirySecurity(payload, recentSecurityEvents.slice(0, 2500), sourceFingerprint);

  if (security.velocityBlocked) {
    const securityEvent = await recordSecurityEvent(context, req, {
      disposition: 'blocked',
      category: 'rate_limited',
      formName,
      reasons: [security.velocityReason],
      reasonCodes: ['verified_submission_velocity'],
      riskScore: 100,
      ipFingerprint: sourceFingerprint,
      messageFingerprint: security.messageFingerprint,
      ...identity,
      detail: 'Verified visitor exceeded the application-level inquiry velocity limit.',
    });
    await applyAutomaticBlocks(context, securityEvent, [securityEvent, ...recentSecurityEvents]);
    return json(req, {
      error: 'Too many inquiries have been submitted from this network. Please try again later.',
      code: 'rate_limited',
    }, 429);
  }

  if (security.disposition === 'blocked') {
    const securityEvent = await recordSecurityEvent(context, req, {
      disposition: 'blocked',
      category: 'inquiry_screened',
      formName,
      reasons: security.reasons,
      reasonCodes: security.reasonCodes,
      riskScore: security.riskScore,
      ipFingerprint: sourceFingerprint,
      messageFingerprint: security.messageFingerprint,
      ...identity,
      detail: 'Submission blocked by the Koa’s inquiry risk screen.',
    });
    await applyAutomaticBlocks(context, securityEvent, [securityEvent, ...recentSecurityEvents]);
    return json(req, {
      error: 'We could not accept this submission. Please review the information and try again.',
      code: 'submission_blocked',
    }, 403);
  }

  const now = new Date();
  const id = 'KEI-' + now.getUTCFullYear() + '-' + idSuffix();
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
    security: {
      disposition: security.disposition,
      riskScore: security.riskScore,
      reasons: security.reasons,
      reasonCodes: security.reasonCodes,
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

  await recordSecurityEvent(context, req, {
    disposition: security.disposition,
    category: 'inquiry_screened',
    formName,
    reasons: security.reasons,
    reasonCodes: security.reasonCodes,
    riskScore: security.riskScore,
    ipFingerprint: sourceFingerprint,
    messageFingerprint: security.messageFingerprint,
    recordId: id,
    ...identity,
    detail: security.disposition === 'flagged'
      ? 'Accepted into CRM with a security review flag.'
      : 'Accepted into CRM after security screening.',
  });

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

  const turnstileProof = expectedTurnstileAction
    ? await createTurnstileProof(formName, record.customer.email)
    : '';

  return json(req, { ok: true, id, ...(turnstileProof ? { turnstileProof } : {}) });
};

export const config: Config = {
  path: '/api/crm/inquiries',
  rateLimit: {
    windowLimit: 12,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};
