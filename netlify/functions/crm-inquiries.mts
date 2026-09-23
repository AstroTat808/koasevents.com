import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { sendClientConfirmation, sendLeadNotification } from './_shared/lead-email.ts';
import { assignmentFor, leastLoadedStaff, listOperationalStaff } from './_shared/staff-directory';
import {
  analyzeInquirySecurity,
  applyAutomaticBlocks,
  findActiveBlock,
  getSecurityEvents,
  ipFingerprint,
  recordSecurityEvent,
  recordTurnstileValidation,
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
  return String(Netlify.env.get('TURNSTILE_SECRET_KEY') || Netlify.env.get('TURNSTILE_SECRET') || '').trim();
}

function mobileIngestSecret() {
  const dedicated = String(Netlify.env.get('KOA_MOBILE_BAR_INGEST_SECRET') || '').trim();
  if (dedicated) return dedicated;

  const turnstile = turnstileSecret();
  return turnstile ? `koa-mobile-bar-ingest-v1:${turnstile}` : '';
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

function wildOnesIngestSecret() {
  return String(Netlify.env.get('WILD_ONES_INGEST_SECRET') || '').trim();
}

async function verifyWildOnesSource(req: Request, formName: string) {
  if (formName !== 'wild-ones-production-inquiry') return { ok: true, fingerprint: '' };

  const secret = wildOnesIngestSecret();
  if (!secret) return { ok: false, fingerprint: '', reason: 'Wild Ones ingest secret is not configured.' };

  const fingerprint = cleanText(req.headers.get('x-wild-ones-source'), 80).toLowerCase();
  const timestamp = cleanText(req.headers.get('x-wild-ones-timestamp'), 20);
  const signature = cleanText(req.headers.get('x-wild-ones-signature'), 160);
  if (!fingerprint || !timestamp || !signature) {
    return { ok: false, fingerprint: '', reason: 'Wild Ones source authentication is missing.' };
  }

  const issuedAt = Number(timestamp);
  if (!Number.isFinite(issuedAt) || Math.abs(Math.floor(Date.now() / 1000) - issuedAt) > 300) {
    return { ok: false, fingerprint: '', reason: 'Wild Ones source authentication expired.' };
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
    encoder.encode('v1|' + timestamp + '|' + fingerprint + '|wild-ones-production-inquiry'),
  );
  const expected = base64Url(expectedBuffer);
  if (expected.length !== signature.length) return { ok: false, fingerprint: '', reason: 'Wild Ones source authentication failed.' };

  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }
  return mismatch === 0
    ? { ok: true, fingerprint }
    : { ok: false, fingerprint: '', reason: 'Wild Ones source authentication failed.' };
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
  if (!secret) {
    return {
      ok: false,
      configured: false,
      error: 'Security verification is temporarily unavailable. Please try again shortly.',
      codes: ['missing-secret'],
    };
  }

  const responseToken = cleanText(token, 2048);
  if (!responseToken) return {
    ok: false,
    configured: true,
    error: 'Complete the security check and try again.',
    codes: ['missing-token'],
  };

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

    const ok = Boolean(
      result.ok &&
      data?.success &&
      verifiedAction === expectedAction &&
      verifiedHostname === requestHostname
    );
    const codes = Array.isArray(data?.['error-codes']) ? [...data['error-codes']] : [];
    if (data?.success && verifiedAction !== expectedAction) codes.push('action-mismatch');
    if (data?.success && verifiedHostname !== requestHostname) codes.push('hostname-mismatch');
    return {
      ok,
      configured: true,
      error: data?.success ? 'Security verification did not match this form. Please try again.' : 'Security verification failed. Please try again.',
      codes,
      verifiedAction,
      verifiedHostname,
      requestHostname,
      detail: data?.success
        ? (ok ? 'Cloudflare Siteverify accepted the token, action, and hostname.' : 'Cloudflare accepted the token but action or hostname did not match.')
        : 'Cloudflare Siteverify rejected the token.',
    };
  } catch {
    return {
      ok: false,
      configured: true,
      error: 'Security verification is temporarily unavailable. Please try again.',
      codes: ['siteverify-unavailable'],
    };
  }
}

function assessWildOnesQualification(payload: any) {
  const inquiry = payload?.inquiry || {};
  const wild = payload?.wildOnes || {};
  const customer = payload?.customer || {};
  const guests = Math.round(cleanNumber(inquiry.guestCount ?? wild.expectedAttendance, 0, 1000));
  let score = 0;

  const eventType = cleanText(inquiry.eventType || wild.eventType, 120).toLowerCase();
  if (/(concert|edm|dance|festival|retreat|production|brand activation|large private)/.test(eventType)) score += 15;
  else if (eventType) score += 6;

  if (guests >= 75 && guests <= 350) score += 15;
  else if (guests > 0 && guests <= 450) score += 8;

  const budget = cleanText(inquiry.budget || wild.eventBudget, 120);
  if (/50,?000\+/.test(budget)) score += 20;
  else if (/25,?000/.test(budget)) score += 18;
  else if (/10,?000/.test(budget)) score += 14;
  else if (/5,?000/.test(budget)) score += 9;
  else if (budget) score += 4;

  const planning = cleanText(wild.planningStage, 120).toLowerCase();
  if (planning.includes('ready for venue proposal')) score += 15;
  else if (planning.includes('production vendors engaged')) score += 13;
  else if (planning.includes('talent') || planning.includes('programming')) score += 10;
  else if (planning) score += 6;

  const detailFields = ['stagePlan','audioPlan','lightingPlan','powerProfile','parkingPlan','securityPlan'];
  score += Math.min(15, detailFields.filter((key) => {
    const value = cleanText(wild[key], 160);
    return value && !/not sure/i.test(value);
  }).length * 2.5);

  const experience = cleanText(wild.organizerExperience, 160).toLowerCase();
  if (experience.includes('professional') || experience.includes('20+')) score += 10;
  else if (experience.includes('6–20') || experience.includes('6-20')) score += 8;
  else if (experience.includes('1–5') || experience.includes('1-5')) score += 5;
  else if (experience) score += 2;

  const flexibility = cleanText(wild.dateFlexibility, 120).toLowerCase();
  if (flexibility.includes('flexible') || flexibility.includes('month')) score += 5;
  else if (flexibility.includes('week')) score += 3;

  const timing = cleanText(wild.decisionTiming, 120).toLowerCase();
  if (timing.includes('ready to secure')) score += 5;
  else if (timing.includes('2 week')) score += 4;
  else if (timing.includes('30 day')) score += 3;
  else if (timing) score += 1;

  if (cleanText(customer.company || wild.company, 180)) score = Math.min(100, score + 2);
  score = Math.max(0, Math.min(100, Math.round(score)));

  let complexityPoints = 0;
  if (guests > 250) complexityPoints += 2;
  else if (guests > 150) complexityPoints += 1;
  if (/(concert-grade|generator|hybrid)/i.test(cleanText(wild.powerProfile, 160))) complexityPoints += 2;
  if (/(box truck|semi|touring)/i.test(cleanText(wild.largestProductionVehicle, 160))) complexityPoints += 2;
  if (cleanStringList(wild.specialElements, 20, 120).length) complexityPoints += 2;
  if (cleanNumber(wild.vendorCount, 0, 100) >= 8) complexityPoints += 1;
  if (/multi-day|overnight/i.test(cleanText(wild.overnightUse, 120))) complexityPoints += 1;

  return {
    score,
    band: score >= 80 ? 'priority' : score >= 60 ? 'qualified' : score >= 40 ? 'review' : 'nurture',
    productionComplexity: complexityPoints >= 6 ? 'high' : complexityPoints >= 3 ? 'moderate' : 'standard',
    calculatedAt: new Date().toISOString(),
  };
}

async function appendEvent(store: any, event: Record<string, unknown>) {
  const current = (await store.get('analytics/events/index', { type: 'json' })) || [];
  await store.setJSON('analytics/events/index', [event, ...current].slice(0, 10000));
}

async function persistCommunicationResults(
  store: any,
  recordId: string,
  results: Record<string, { sent?: boolean; configured?: boolean; id?: string }>,
) {
  const stored: any = await store.get('records/' + recordId, { type: 'json' });
  if (!stored) return;

  const at = new Date().toISOString();
  const communications = { ...(stored.communications || {}) };
  for (const [key, result] of Object.entries(results)) {
    communications[key] = {
      messageId: String(result?.id || ''),
      status: result?.sent ? 'sent' : 'failed',
      sentAt: result?.sent ? at : '',
      updatedAt: at,
    };
  }
  stored.communications = communications;

  await store.setJSON('records/' + recordId, stored);
  const index = (await store.get('records/index', { type: 'json' })) || [];
  await store.setJSON(
    'records/index',
    index.map((entry: any) => entry?.id === recordId ? { ...entry, communications } : entry).slice(0, 1500),
  );
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
  const wildOnesSource = await verifyWildOnesSource(req, formName);
  if (!wildOnesSource.ok) {
    return json(req, { error: 'Wild Ones source authentication failed.', code: 'wild_ones_source_auth_failed' }, 403);
  }
  const sourceFingerprint = wildOnesSource.fingerprint || mobileSource.fingerprint || await ipFingerprint(req);
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
    'koa-discovery-call-request': 'discovery_call',
    'koa-stay-inquiry': 'stay_inquiry',
  };
  const expectedTurnstileAction = protectedActions[formName] || '';

  if (expectedTurnstileAction) {
    const turnstile = await verifyTurnstile(req, payload.turnstileToken, expectedTurnstileAction);
    await recordTurnstileValidation(context, {
      ok: turnstile.ok,
      action: turnstile.verifiedAction || '',
      expectedAction: expectedTurnstileAction,
      hostname: turnstile.verifiedHostname || '',
      requestHostname: turnstile.requestHostname || new URL(req.url).hostname,
      codes: turnstile.codes || [],
      detail: turnstile.detail || turnstile.error || '',
    });
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
  const businessLine = formName === 'wild-ones-production-inquiry'
    ? 'wild-ones'
    : formName === 'koa-mobile-bar-inquiry'
      ? 'mobile-bar'
      : 'events';
  const projectType = businessLine === 'wild-ones' ? 'large-format-production' : '';
  const wildQualification = businessLine === 'wild-ones' ? assessWildOnesQualification(payload) : null;
  const wildPayload = payload?.wildOnes && typeof payload.wildOnes === 'object' ? payload.wildOnes : {};

  const record = {
    id,
    kind: 'inquiry',
    stage: 'inquiry',
    status: 'new',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    source: formName || 'website',
    businessLine,
    projectType,
    qualification: wildQualification,
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
    communications: {
      internalNotification: { messageId: '', status: 'pending', sentAt: '', updatedAt: now.toISOString() },
      clientConfirmation: { messageId: '', status: 'pending', sentAt: '', updatedAt: now.toISOString() },
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
      glasswareType: cleanText(payload.inquiry?.glasswareType, 40),
      estimatedTotal: Math.round(cleanNumber(payload.inquiry?.estimatedTotal, 0, 10000000) * 100) / 100,
      estimateLineItems: cleanLineItems(payload.inquiry?.estimateLineItems),
      customAddOns: cleanStringList(payload.inquiry?.customAddOns),
      calculatorVersion: cleanText(payload.inquiry?.calculatorVersion, 40),
      selectedCatalogItems: cleanText(payload.inquiry?.selectedCatalogItems, 8000),
      automaticRentalBreakdown: cleanText(payload.inquiry?.automaticRentalBreakdown, 8000),
      manualAddOns: cleanText(payload.inquiry?.manualAddOns, 8000),
      catalogSelectionState: cleanText(payload.inquiry?.catalogSelectionState, 30000),
      preferredDate: cleanText(payload.inquiry?.preferredDate, 40),
      preferredTime: cleanText(payload.inquiry?.preferredTime, 80),
      alternateWindow: cleanText(payload.inquiry?.alternateWindow, 500),
      sourceRecordId: cleanText(payload.inquiry?.sourceRecordId, 80),
      arrival: cleanText(payload.inquiry?.arrival, 40),
      departure: cleanText(payload.inquiry?.departure, 40),
      stayType: cleanText(payload.inquiry?.stayType, 120),
      planningFrom: cleanText(payload.inquiry?.planningFrom, 160),
      barStyle: cleanText(payload.inquiry?.barStyle, 160),
      venueTour: cleanText(payload.inquiry?.venueTour, 160),
    },
    wildOnes: businessLine === 'wild-ones' ? {
      eventConcept: cleanText(wildPayload.eventConcept, 5000),
      preferredDate: cleanText(wildPayload.preferredDate || payload.customer?.eventDate, 40),
      backupDate: cleanText(wildPayload.backupDate, 40),
      dateFlexibility: cleanText(wildPayload.dateFlexibility, 120),
      startTime: cleanText(wildPayload.startTime, 40),
      endTime: cleanText(wildPayload.endTime, 40),
      eventAccess: cleanText(wildPayload.eventAccess, 120),
      stagePlan: cleanText(wildPayload.stagePlan, 160),
      audioPlan: cleanText(wildPayload.audioPlan, 160),
      lightingPlan: cleanText(wildPayload.lightingPlan, 160),
      powerProfile: cleanText(wildPayload.powerProfile, 160),
      fohRequirements: cleanText(wildPayload.fohRequirements, 160),
      largestProductionVehicle: cleanText(wildPayload.largestProductionVehicle, 160),
      specialElements: cleanStringList(wildPayload.specialElements, 20, 120),
      productionRiderUrl: cleanText(wildPayload.productionRiderUrl, 1000),
      vendorCount: Math.round(cleanNumber(wildPayload.vendorCount, 0, 200)),
      eventStaffCount: Math.round(cleanNumber(wildPayload.eventStaffCount, 0, 500)),
      artistCount: Math.round(cleanNumber(wildPayload.artistCount, 0, 500)),
      productionCrewCount: Math.round(cleanNumber(wildPayload.productionCrewCount, 0, 500)),
      beverageService: cleanText(wildPayload.beverageService, 160),
      securityPlan: cleanText(wildPayload.securityPlan, 160),
      parkingPlan: cleanText(wildPayload.parkingPlan, 160),
      insuranceReadiness: cleanText(wildPayload.insuranceReadiness, 160),
      loadInTime: cleanText(wildPayload.loadInTime, 80),
      loadOutTime: cleanText(wildPayload.loadOutTime, 80),
      overnightUse: cleanText(wildPayload.overnightUse, 160),
      operationsNotes: cleanText(wildPayload.operationsNotes, 5000),
      eventBudget: cleanText(wildPayload.eventBudget || payload.inquiry?.budget, 160),
      planningStage: cleanText(wildPayload.planningStage, 160),
      organizerExperience: cleanText(wildPayload.organizerExperience, 160),
      decisionTiming: cleanText(wildPayload.decisionTiming, 160),
      role: cleanText(wildPayload.role, 160),
      website: cleanText(wildPayload.website, 500),
      utmSource: cleanText(wildPayload.utmSource, 200),
      utmMedium: cleanText(wildPayload.utmMedium, 200),
      utmCampaign: cleanText(wildPayload.utmCampaign, 200),
      utmContent: cleanText(wildPayload.utmContent, 200),
      siteTourStatus: 'not_requested',
      proposalStatus: 'not_started',
      contractStatus: 'not_started',
      depositStatus: 'not_due',
    } : null,
  };

  const notificationConfigured = Boolean(String(Netlify.env.get('RESEND_API_KEY') || '').trim());

  if (formName === 'koa-discovery-call-request' && record.inquiry.sourceRecordId) {
    const existingRecords = (await store.get('records/index', { type: 'json' })) || [];
    const existing = existingRecords.find((entry: any) =>
      entry?.id === record.inquiry.sourceRecordId &&
      String(entry.customer?.email || '').trim().toLowerCase() === record.customer.email.toLowerCase()
    );

    if (existing) {
      existing.updatedAt = now.toISOString();
      existing.inquiry = {
        ...(existing.inquiry || {}),
        discoveryCall: {
          preferredDate: record.inquiry.preferredDate || record.customer.eventDate,
          preferredTime: record.inquiry.preferredTime,
          alternateWindow: record.inquiry.alternateWindow,
          requestedAt: now.toISOString(),
        },
      };
      await store.setJSON('records/' + existing.id, existing);
      await store.setJSON(
        'records/index',
        existingRecords.map((entry: any) => entry?.id === existing.id ? existing : entry).slice(0, 1500),
      );
      await appendEvent(store, {
        id: 'EVT-' + idSuffix(),
        type: 'discovery_call_requested',
        packageId: existing.packageId || existing.inquiry?.venuePackage || '',
        quoteId: existing.quoteId || '',
        recordId: existing.id,
        createdAt: now.toISOString(),
        detail: [
          record.inquiry.preferredDate || record.customer.eventDate,
          record.inquiry.preferredTime,
          record.inquiry.alternateWindow,
        ].filter(Boolean).join(' · '),
      });
      context.waitUntil((async () => {
        const discoveryRecord = {
          ...existing,
          source: 'koa-discovery-call-request',
          customer: { ...existing.customer, eventDate: record.inquiry.preferredDate || record.customer.eventDate },
          inquiry: {
            ...(existing.inquiry || {}),
            preferredDate: record.inquiry.preferredDate || record.customer.eventDate,
            preferredTime: record.inquiry.preferredTime,
            alternateWindow: record.inquiry.alternateWindow,
          },
        };
        const [notification, confirmation] = await Promise.all([
          sendLeadNotification(discoveryRecord),
          sendClientConfirmation(discoveryRecord),
        ]);
        await persistCommunicationResults(store, existing.id, {
          discoveryNotification: notification,
          discoveryConfirmation: confirmation,
        });
        await appendEvent(store, {
          id: 'EVT-' + idSuffix(),
          type: notification.sent ? 'lead_notification_sent' : 'lead_notification_failed',
          packageId: existing.packageId || existing.inquiry?.venuePackage || '',
          quoteId: existing.quoteId || '',
          recordId: existing.id,
          createdAt: new Date().toISOString(),
          detail: notification.sent
            ? 'Branded Discovery Call team notification sent' + (notification.id ? ' · ' + notification.id : '')
            : 'Branded Discovery Call team notification could not be sent',
        });
        await appendEvent(store, {
          id: 'EVT-' + idSuffix(),
          type: confirmation.sent ? 'client_confirmation_sent' : 'client_confirmation_failed',
          packageId: existing.packageId || existing.inquiry?.venuePackage || '',
          quoteId: existing.quoteId || '',
          recordId: existing.id,
          createdAt: new Date().toISOString(),
          detail: confirmation.sent
            ? 'Discovery Call confirmation sent to client' + (confirmation.id ? ' · ' + confirmation.id : '')
            : 'Discovery Call confirmation could not be sent',
        });
      })().catch((error) => console.error('Discovery notification tracking failed', error)));
      return json(req, {
        ok: true,
        id: existing.id,
        attached: true,
        notificationConfigured,
      });
    }
  }

  if (['koa-event-inquiry', 'koa-wedding-inquiry', 'koa-mobile-bar-inquiry', 'koa-stay-inquiry'].includes(formName)) {
    const existingRecords = (await store.get('records/index', { type: 'json' })) || [];
    const normalizedEmail = record.customer.email.toLowerCase();
    const duplicate = existingRecords.find((entry: any) => {
      if (!entry || entry.source !== formName) return false;
      if (String(entry.customer?.email || '').trim().toLowerCase() !== normalizedEmail) return false;
      if (String(entry.customer?.eventDate || '') !== record.customer.eventDate) return false;
      if (quoteId && String(entry.quoteId || '') !== quoteId) return false;
      const createdAt = Date.parse(String(entry.createdAt || ''));
      return Number.isFinite(createdAt) && now.getTime() - createdAt >= 0 && now.getTime() - createdAt <= 10 * 60 * 1000;
    });

    if (duplicate) {
      const turnstileProof = expectedTurnstileAction
        ? await createTurnstileProof(formName, record.customer.email)
        : '';
      return json(req, {
        ok: true,
        id: duplicate.id,
        deduplicated: true,
        notificationConfigured,
        ...(turnstileProof ? { turnstileProof } : {}),
      });
    }
  }

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
  try {
    const staff = await listOperationalStaff();
    const assignee = leastLoadedStaff(staff, current);
    if (assignee) (record as any).assignment = assignmentFor(assignee, 'automatic-round-robin');
  } catch (error) {
    console.error('Automatic lead assignment failed', error);
  }
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

  context.waitUntil((async () => {
    const [notification, confirmation] = await Promise.all([
      sendLeadNotification(record),
      sendClientConfirmation(record),
    ]);
    await persistCommunicationResults(store, id, {
      internalNotification: notification,
      clientConfirmation: confirmation,
    });
    await appendEvent(store, {
      id: 'EVT-' + idSuffix(),
      type: notification.sent ? 'lead_notification_sent' : 'lead_notification_failed',
      packageId: packageId || record.inquiry.venuePackage || record.inquiry.mobileBarPackage || '',
      quoteId,
      recordId: id,
      createdAt: new Date().toISOString(),
      detail: notification.sent
        ? 'Branded team lead notification sent' + (notification.id ? ' · ' + notification.id : '')
        : 'Branded team lead notification could not be sent',
    });
    await appendEvent(store, {
      id: 'EVT-' + idSuffix(),
      type: confirmation.sent ? 'client_confirmation_sent' : 'client_confirmation_failed',
      packageId: packageId || record.inquiry.venuePackage || record.inquiry.mobileBarPackage || '',
      quoteId,
      recordId: id,
      createdAt: new Date().toISOString(),
      detail: confirmation.sent
        ? 'Immediate branded confirmation sent to client' + (confirmation.id ? ' · ' + confirmation.id : '')
        : 'Immediate client confirmation could not be sent',
    });
  })().catch((error) => console.error('Lead email tracking failed', error)));

  const turnstileProof = expectedTurnstileAction
    ? await createTurnstileProof(formName, record.customer.email)
    : '';

  return json(req, {
    ok: true,
    id,
    notificationConfigured,
    ...(turnstileProof ? { turnstileProof } : {}),
  });
};

export const config: Config = {
  path: '/api/crm/inquiries',
  rateLimit: {
    windowLimit: 12,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};
