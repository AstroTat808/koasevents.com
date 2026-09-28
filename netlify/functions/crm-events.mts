import type { Context, Config } from '@netlify/functions';
import { resolveTenant, resolveTenantAsync, runWithTenant } from './_shared/tenant.ts';
import { tenantStoreFor } from './_shared/tenant-storage.ts';

const ALLOWED_TYPES = new Set(['package_view']);

function salesStoreFor(context: Context, req: Request) {
  return tenantStoreFor(context, resolveTenant(req), 'sales');
}

function clean(value: unknown, max = 120) {
  return String(value || '').trim().slice(0, max);
}

export default async (req: Request, context: Context) => {
  const tenant=await resolveTenantAsync(req,context).catch(()=>null);
  if(!tenant)return new Response('Unknown tenant',{status:404,headers:{'Cache-Control':'no-store'}});
  return runWithTenant(tenant,async()=>{
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const origin = req.headers.get('origin');
  const requestOrigin = new URL(req.url).origin;
  if (origin && origin !== requestOrigin) return new Response('Forbidden', { status: 403 });

  const payload: any = await req.json().catch(() => null);
  const type = clean(payload?.type, 40);
  const packageId = clean(payload?.packageId, 80);
  const sessionId = clean(payload?.sessionId, 100);
  if (!ALLOWED_TYPES.has(type) || !packageId) {
    return Response.json({ error: 'Invalid event.' }, { status: 400 });
  }

  const store = salesStoreFor(context, req);
  const current = (await store.get('analytics/events/index', { type: 'json' })) || [];
  const duplicate = sessionId && current.some((event: any) =>
    event?.type === type && event?.packageId === packageId && event?.sessionId === sessionId
  );
  if (!duplicate) {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    const eventId = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
    const event = { id: 'EVT-' + eventId, type, packageId, sessionId, createdAt: new Date().toISOString() };
    await store.setJSON('analytics/events/index', [event, ...current].slice(0, 10000));
  }

  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'private, no-store' } });
  });
};
export const config: Config = { path: '/api/crm/events' };
