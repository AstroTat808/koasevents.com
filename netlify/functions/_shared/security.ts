import type { Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';

export type SecurityDisposition = 'allowed' | 'flagged' | 'blocked';

export interface SecurityEvent {
  id: string;
  createdAt: string;
  disposition: SecurityDisposition;
  category: string;
  formName: string;
  reasons: string[];
  reasonCodes: string[];
  riskScore: number;
  ipFingerprint: string;
  emailDomain: string;
  emailPreview: string;
  phonePreview: string;
  messageFingerprint: string;
  recordId: string;
  detail: string;
}

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  '10minutemail.com',
  'guerrillamail.com',
  'guerrillamailblock.com',
  'mailinator.com',
  'maildrop.cc',
  'sharklasers.com',
  'temp-mail.org',
  'tempmail.com',
  'throwawaymail.com',
  'trashmail.com',
  'yopmail.com',
]);

function clean(value: unknown, max = 1200) {
  return String(value || '').trim().slice(0, max);
}

function idSuffix(bytesCount = 6) {
  const bytes = new Uint8Array(bytesCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function storeFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-security', consistency: 'strong' })
    : getDeployStore({ name: 'koa-security' });
}

function securitySecret() {
  return String(Netlify.env.get('TURNSTILE_SECRET_KEY') || '').trim();
}

function base64Url(bytes: ArrayBuffer) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function hmacFingerprint(value: string) {
  const normalized = clean(value, 4000).toLowerCase();
  if (!normalized) return '';

  const encoder = new TextEncoder();
  const secret = securitySecret();
  if (!secret) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(normalized));
    return base64Url(digest).slice(0, 24);
  }

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(normalized));
  return base64Url(signature).slice(0, 24);
}

export function clientIp(req: Request) {
  return (
    clean(req.headers.get('x-nf-client-connection-ip'), 80) ||
    clean(req.headers.get('cf-connecting-ip'), 80) ||
    clean(req.headers.get('x-forwarded-for')?.split(',')[0], 80)
  );
}

export async function ipFingerprint(req: Request) {
  return hmacFingerprint(clientIp(req));
}

function emailDomain(value: unknown) {
  const email = clean(value, 240).toLowerCase();
  const at = email.lastIndexOf('@');
  return at > 0 ? email.slice(at + 1) : '';
}

function emailPreview(value: unknown) {
  const email = clean(value, 240);
  const at = email.lastIndexOf('@');
  if (at < 1) return email ? 'invalid-email' : '';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  return (local[0] || '*') + '***@' + domain;
}

function phonePreview(value: unknown) {
  const digits = clean(value, 80).replace(/\D/g, '');
  if (!digits) return '';
  return '•••' + digits.slice(-4);
}

function uniqueMessageText(payload: any) {
  const values = [
    payload?.customer?.notes,
    payload?.inquiry?.priorities,
    payload?.inquiry?.eventLocation,
  ]
    .map((value) => clean(value, 8000))
    .filter(Boolean);
  return Array.from(new Set(values)).join('\n').trim();
}

export async function messageFingerprint(payload: any) {
  const normalized = uniqueMessageText(payload)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' <url> ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized ? hmacFingerprint(normalized) : '';
}

export async function getSecurityEvents(context: Context) {
  const store = storeFor(context);
  return ((await store.get('events/index', { type: 'json', consistency: 'strong' })) || []) as SecurityEvent[];
}

async function prependEvent(context: Context, event: SecurityEvent) {
  const store = storeFor(context);
  await store.setJSON('events/' + event.createdAt.replace(/[:.]/g, '-') + '-' + event.id, event, { onlyIfNew: true });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await store.getWithMetadata('events/index', { type: 'json', consistency: 'strong' });
    const list = Array.isArray(current?.data) ? current.data : [];
    const next = [event, ...list.filter((item: any) => item?.id !== event.id)].slice(0, 5000);
    const write = current
      ? await store.setJSON('events/index', next, { onlyIfMatch: current.etag })
      : await store.setJSON('events/index', next, { onlyIfNew: true });
    if (write.modified) return;
  }

  const fallback = ((await store.get('events/index', { type: 'json', consistency: 'strong' })) || []) as SecurityEvent[];
  await store.setJSON('events/index', [event, ...fallback.filter((item) => item.id !== event.id)].slice(0, 5000));
}

export async function recordSecurityEvent(
  context: Context,
  req: Request,
  input: Partial<SecurityEvent> & { disposition: SecurityDisposition; category: string },
) {
  const createdAt = input.createdAt || new Date().toISOString();
  const event: SecurityEvent = {
    id: input.id || 'SEC-' + idSuffix(),
    createdAt,
    disposition: input.disposition,
    category: clean(input.category, 80),
    formName: clean(input.formName, 80),
    reasons: Array.isArray(input.reasons) ? input.reasons.slice(0, 12).map((value) => clean(value, 180)).filter(Boolean) : [],
    reasonCodes: Array.isArray(input.reasonCodes) ? input.reasonCodes.slice(0, 12).map((value) => clean(value, 80)).filter(Boolean) : [],
    riskScore: Math.max(0, Math.min(100, Math.round(Number(input.riskScore || 0)))),
    ipFingerprint: clean(input.ipFingerprint, 40) || await ipFingerprint(req),
    emailDomain: clean(input.emailDomain, 180),
    emailPreview: clean(input.emailPreview, 260),
    phonePreview: clean(input.phonePreview, 40),
    messageFingerprint: clean(input.messageFingerprint, 40),
    recordId: clean(input.recordId, 100),
    detail: clean(input.detail, 500),
  };
  await prependEvent(context, event);
  return event;
}

export function securityIdentity(payload: any) {
  return {
    emailDomain: emailDomain(payload?.customer?.email),
    emailPreview: emailPreview(payload?.customer?.email),
    phonePreview: phonePreview(payload?.customer?.phone),
  };
}

function addSignal(signals: Array<{ code: string; label: string; score: number }>, code: string, label: string, score: number) {
  if (!signals.some((signal) => signal.code === code)) signals.push({ code, label, score });
}

export async function analyzeInquirySecurity(payload: any, recentEvents: SecurityEvent[], sourceFingerprint: string) {
  const signals: Array<{ code: string; label: string; score: number }> = [];
  const email = clean(payload?.customer?.email, 240).toLowerCase();
  const domain = emailDomain(email);
  const phone = clean(payload?.customer?.phone, 80);
  const digits = phone.replace(/\D/g, '');
  const text = uniqueMessageText(payload);
  const lower = text.toLowerCase();
  const fingerprint = await messageFingerprint(payload);

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    addSignal(signals, 'invalid_email', 'Email address has an invalid format', 30);
  }
  if (domain && DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
    addSignal(signals, 'disposable_email', 'Disposable or temporary email domain', 40);
  }

  if (digits) {
    const repeatedDigits = /^(\d)\1{7,}$/.test(digits);
    const obviousSequence = /1234567890|0987654321|0123456789/.test(digits);
    if (digits.length < 10 || digits.length > 15 || repeatedDigits || obviousSequence) {
      addSignal(signals, 'suspicious_phone', 'Phone number appears synthetic or malformed', 25);
    }
  }

  const urls = lower.match(/(?:https?:\/\/|www\.)[^\s<>()]+/g) || [];
  const bareDomains = lower.match(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|biz|xyz|top|site|online|info)\b/g) || [];
  const standaloneDomains = bareDomains.filter((domain) => !urls.some((url) => url.includes(domain)));
  const linkCount = new Set([...urls, ...standaloneDomains]).size;
  if (linkCount === 1) addSignal(signals, 'external_link', 'Message contains an external link', 20);
  if (linkCount >= 2) addSignal(signals, 'multiple_links', 'Message contains multiple external links', 35);
  if (/\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|rb\.gy|cutt\.ly)\b/i.test(lower)) {
    addSignal(signals, 'shortened_url', 'Message contains a shortened URL', 25);
  }

  const cryptoPitch = /\b(?:crypto(?:currency)?|bitcoin|ethereum|blockchain|forex|airdrop|token sale|trading platform|investment opportunity|digital asset)\b/i.test(lower);
  const marketingPitch = /\b(?:seo|backlinks?|guest posts?|domain authority|google ranking|website traffic|web design|marketing agency|marketing services|lead generation|sponsored content|paid ads)\b/i.test(lower);
  const remotePitch = /\b(?:whatsapp|telegram)\b/i.test(lower);

  if (cryptoPitch) addSignal(signals, 'crypto_pitch', 'Crypto, trading, or investment solicitation language', 65);
  if (marketingPitch) addSignal(signals, 'marketing_solicitation', 'SEO, backlink, marketing, or website-sales solicitation language', 50);
  if ((cryptoPitch || marketingPitch) && linkCount > 0) {
    addSignal(signals, 'solicitation_with_link', 'Commercial solicitation includes an external link', 20);
  }
  if (remotePitch && (cryptoPitch || marketingPitch || linkCount > 0)) {
    addSignal(signals, 'offplatform_contact', 'Solicitation pushes conversation to WhatsApp or Telegram', 15);
  }
  if (/<(?:script|iframe|object|embed|form|style)\b/i.test(text)) {
    addSignal(signals, 'html_payload', 'Message contains embedded HTML or script-like markup', 45);
  }

  if (fingerprint) {
    const now = Date.now();
    const same = recentEvents.filter((event) =>
      event.messageFingerprint === fingerprint &&
      event.createdAt &&
      now - new Date(event.createdAt).getTime() <= 7 * 24 * 60 * 60 * 1000
    );
    const same24h = same.filter((event) => now - new Date(event.createdAt).getTime() <= 24 * 60 * 60 * 1000);
    if (same24h.length >= 4) {
      addSignal(signals, 'repeated_message_burst', 'Same message has been submitted repeatedly', 80);
    } else if (same24h.length >= 2) {
      addSignal(signals, 'repeated_message', 'Same message was submitted multiple times recently', 45);
    } else if (same.length >= 1) {
      addSignal(signals, 'duplicate_message', 'Same message was submitted previously', 25);
    }
  }

  const sameSourceRecent = recentEvents.filter((event) =>
    sourceFingerprint &&
    event.ipFingerprint === sourceFingerprint &&
    event.category === 'inquiry_screened' &&
    event.createdAt &&
    Date.now() - new Date(event.createdAt).getTime() <= 10 * 60 * 1000
  ).length;

  const sameSourceHour = recentEvents.filter((event) =>
    sourceFingerprint &&
    event.ipFingerprint === sourceFingerprint &&
    event.category === 'inquiry_screened' &&
    event.createdAt &&
    Date.now() - new Date(event.createdAt).getTime() <= 60 * 60 * 1000
  ).length;

  const velocityBlocked = sameSourceRecent >= 6 || sameSourceHour >= 20;
  const score = Math.min(100, signals.reduce((total, signal) => total + signal.score, 0));
  const disposition: SecurityDisposition = score >= 80 ? 'blocked' : score >= 20 ? 'flagged' : 'allowed';

  return {
    disposition,
    riskScore: score,
    reasons: signals.map((signal) => signal.label),
    reasonCodes: signals.map((signal) => signal.code),
    messageFingerprint: fingerprint,
    velocityBlocked,
    velocityReason: sameSourceRecent >= 6 ? 'More than 6 verified submissions from this network in 10 minutes' : sameSourceHour >= 20 ? 'More than 20 verified submissions from this network in one hour' : '',
  };
}
