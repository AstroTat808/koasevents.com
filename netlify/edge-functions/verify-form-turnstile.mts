import type { Context, Config } from '@netlify/edge-functions';

const PROOF_TTL_SECONDS = 300;
const MAX_CLOCK_SKEW_SECONDS = 30;

function clean(value: unknown, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function validProof(secret: string, formName: string, email: string, proof: string) {
  const dot = proof.indexOf('.');
  if (dot < 1) return false;

  const issuedAtText = proof.slice(0, dot);
  const signatureText = proof.slice(dot + 1);
  if (!/^\d{10}$/.test(issuedAtText) || !signatureText) return false;

  const issuedAt = Number(issuedAtText);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(issuedAt)) return false;
  if (issuedAt < now - PROOF_TTL_SECONDS || issuedAt > now + MAX_CLOCK_SKEW_SECONDS) return false;

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const message = formName + '|' + email.toLowerCase() + '|' + issuedAtText;
    return await crypto.subtle.verify(
      'HMAC',
      key,
      decodeBase64Url(signatureText),
      encoder.encode(message),
    );
  } catch {
    return false;
  }
}

function blocked(message = 'Security verification failed. Please return to the form and try again.') {
  return new Response(message, {
    status: 403,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export default async (req: Request, context: Context) => {
  const secret = String(Netlify.env.get('TURNSTILE_SECRET_KEY') || Netlify.env.get('TURNSTILE_SECRET') || '').trim();
  if (!secret) return context.next();

  const pathname = new URL(req.url).pathname;
  const expectedForms: Record<string, string[]> = {
    '/thank-you/': ['koa-event-inquiry', 'koa-discovery-call-request', 'koa-stay-inquiry'],
    '/wedding-inquiry-thank-you/': ['koa-wedding-inquiry'],
  };
  const allowedFormNames = expectedForms[pathname];
  if (!allowedFormNames) return context.next();

  const contentType = req.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/x-www-form-urlencoded')) {
    return blocked('Invalid form submission.');
  }

  const params = new URLSearchParams(await req.text());

  if (clean(params.get('bot-field'), 120)) {
    return Response.redirect(new URL(pathname, req.url), 303);
  }

  const formName = clean(params.get('form-name'), 80);
  if (!allowedFormNames.includes(formName)) return blocked();

  const email = clean(params.get('email'), 240);
  const proof = clean(params.get('koa-turnstile-proof'), 1000);
  if (!email || !proof || !(await validProof(secret, formName, email, proof))) {
    return blocked();
  }

  return context.next();
};

export const config: Config = {
  path: ['/thank-you/', '/wedding-inquiry-thank-you/'],
  method: 'POST',
  rateLimit: {
    windowLimit: 12,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};
