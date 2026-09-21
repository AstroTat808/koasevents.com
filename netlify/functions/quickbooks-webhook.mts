import type { Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { quickBooksWebhookVerifierToken } from './_shared/quickbooks';

function integrationStore(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-integrations', consistency: 'strong' })
    : getDeployStore({ name: 'koa-integrations' });
}

function verifySignature(rawBody: string, signature: string, verifierToken: string) {
  if (!rawBody || !signature || !verifierToken) return false;
  const expected = createHmac('sha256', verifierToken).update(rawBody, 'utf8').digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async (req: Request, context: Context) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const verifierToken = quickBooksWebhookVerifierToken();
  if (!verifierToken) {
    console.error('QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN is not configured');
    return new Response('Webhook verifier is not configured', { status: 503 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get('intuit-signature') || '';

  if (!verifySignature(rawBody, signature, verifierToken)) {
    console.warn('Rejected QuickBooks webhook with invalid signature');
    return new Response('Invalid signature', { status: 401 });
  }

  const payload: any = JSON.parse(rawBody || '{}');
  const notifications = Array.isArray(payload?.eventNotifications) ? payload.eventNotifications : [];

  const receipt = {
    receivedAt: new Date().toISOString(),
    notifications: notifications.map((notification: any) => ({
      realmId: String(notification?.realmId || ''),
      entities: Array.isArray(notification?.dataChangeEvent?.entities)
        ? notification.dataChangeEvent.entities.map((entity: any) => ({
            name: String(entity?.name || ''),
            id: String(entity?.id || ''),
            operation: String(entity?.operation || ''),
            lastUpdated: String(entity?.lastUpdated || ''),
          }))
        : [],
    })),
  };

  const store = integrationStore(context);
  await store.setJSON('quickbooks/webhook-last-receipt', receipt);

  return new Response(null, { status: 200 });
};
