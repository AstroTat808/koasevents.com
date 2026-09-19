import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';

function salesStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-sales', consistency: 'strong' })
    : getDeployStore({ name: 'koa-sales' });
}

function clean(value: unknown, max = 500) {
  return String(value || '').trim().slice(0, max);
}

async function records(context: Context) {
  const store = salesStoreFor(context);
  return { store, list: ((await store.get('records/index', { type: 'json' })) || []) as any[] };
}

function publicRecord(record: any) {
  const proposal = record?.proposal || {};
  return {
    id: record.id,
    status: proposal.status || record.status,
    customerName: record.customer?.name || '',
    eventDate: record.customer?.eventDate || '',
    packageId: record.packageId || record.quote?.state?.startingPoint || '',
    quoteId: record.quoteId || '',
    expirationDate: proposal.expirationDate || '',
    lineItems: proposal.lineItems || [],
    subtotal: Number(proposal.subtotal || 0),
    discountAmount: Number(proposal.discountAmount || 0),
    taxRate: Number(proposal.taxRate || 0),
    taxAmount: Number(proposal.taxAmount || 0),
    total: Number(proposal.total || 0),
    depositAmount: Number(proposal.depositAmount || 0),
    paymentSchedule: proposal.paymentSchedule || [],
    notesToClient: proposal.notesToClient || '',
    acceptedAt: proposal.acceptance?.acceptedAt || '',
    acceptedName: proposal.acceptance?.name || '',
  };
}

export default async (req: Request, context: Context) => {
  const token = clean(context.params.token, 80);
  if (!/^[A-Za-z0-9_-]{24,80}$/.test(token)) return Response.json({ error: 'Invalid proposal link.' }, { status: 400 });

  const { store, list } = await records(context);
  const record = list.find((entry: any) => entry?.kind === 'proposal' && entry?.proposal?.publicToken === token);
  if (!record) return Response.json({ error: 'Proposal not found.' }, { status: 404 });

  const proposal = record.proposal || {};
  const expired = proposal.expirationDate && new Date(proposal.expirationDate + 'T23:59:59Z').getTime() < Date.now();
  if (expired && !['accepted', 'booked'].includes(proposal.status)) {
    proposal.status = 'expired';
    record.status = 'expired';
    record.updatedAt = new Date().toISOString();
    await store.setJSON('records/' + record.id, record);
    await store.setJSON('records/index', list);
  }

  if (req.method === 'GET') {
    if (proposal.status === 'draft') return Response.json({ error: 'This proposal has not been sent yet.' }, { status: 403 });
    if (proposal.status === 'sent') {
      proposal.status = 'viewed';
      proposal.viewedAt = new Date().toISOString();
      record.status = 'viewed';
      record.updatedAt = proposal.viewedAt;
      const next = list.map((entry: any) => entry.id === record.id ? record : entry);
      await store.setJSON('records/' + record.id, record);
      await store.setJSON('records/index', next);
    }
    return Response.json({ proposal: publicRecord(record) }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  if (req.method === 'POST') {
    const payload: any = await req.json().catch(() => null);
    const action = clean(payload?.action, 20);
    if (!['accept', 'decline'].includes(action)) return Response.json({ error: 'Invalid action.' }, { status: 400 });
    if (['accepted', 'booked'].includes(proposal.status)) return Response.json({ error: 'This proposal has already been accepted.' }, { status: 409 });
    if (proposal.status === 'expired') return Response.json({ error: 'This proposal has expired.' }, { status: 410 });

    const now = new Date().toISOString();
    if (action === 'accept') {
      const name = clean(payload?.name, 180);
      if (name.length < 2 || payload?.acknowledged !== true) {
        return Response.json({ error: 'Enter your name and confirm acceptance.' }, { status: 400 });
      }
      proposal.status = 'accepted';
      proposal.acceptance = { name, acceptedAt: now };
      record.status = 'accepted';
    } else {
      proposal.status = 'declined';
      proposal.declinedAt = now;
      record.status = 'declined';
    }
    record.updatedAt = now;
    const next = list.map((entry: any) => entry.id === record.id ? record : entry);
    await store.setJSON('records/' + record.id, record);
    await store.setJSON('records/index', next);

    return Response.json({ ok: true, proposal: publicRecord(record) }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config: Config = { path: '/api/proposals/:token' };
