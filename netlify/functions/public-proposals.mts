import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { ensureBooking } from './_shared/booking';
import { createSignWellContract, signWellConfigured } from './_shared/signwell';
import { markLifecycleEvent } from './_shared/lifecycle';

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

async function appendEvent(store: any, event: Record<string, unknown>) {
  const current = (await store.get('analytics/events/index', { type: 'json' })) || [];
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const id = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
  await store.setJSON('analytics/events/index', [{
    id: 'EVT-' + id,
    createdAt: new Date().toISOString(),
    ...event,
  }, ...current].slice(0, 10000));
}

function publicRecord(record: any) {
  const proposal = record?.proposal || {};
  const quoteState = record?.quote?.state || {};
  const originalLines = [];
  const invoiceRows = Array.isArray(record?.accounting?.quickbooks?.invoices) ? record.accounting.quickbooks.invoices : [];
  const schedule = record?.booking?.payments?.length
    ? record.booking.payments
    : (proposal.paymentSchedule || []).map((item: any, index: number) => ({ id: 'pay-' + (index + 1), ...item }));
  const paymentsReceived = schedule.reduce((sum: number, item: any, index: number) => {
    const paymentId = String(item?.id || 'pay-' + (index + 1));
    const invoice = invoiceRows.find((row: any) => String(row?.paymentId || '') === paymentId);
    if (!invoice?.invoiceId || ['void','deleted'].includes(String(invoice?.status || '').toLowerCase())) return sum;
    const amount = Number(item?.amount || 0);
    const balance = Number(invoice?.balance ?? amount);
    return sum + Math.max(0, amount - balance);
  }, 0);
  const remainingBalance = Math.max(0, Number(proposal.total || 0) - paymentsReceived);

  if (Number(quoteState.basePackagePrice || 0) > 0) {
    originalLines.push({
      id: 'collection',
      description: 'Wedding collection',
      quantity: 1,
      amount: Number(quoteState.basePackagePrice || 0),
      custom: false,
      source: 'package',
    });
  }

  (quoteState.selected || []).forEach((item: any) => {
    originalLines.push({
      id: String(item?.id || ''),
      description: String(item?.name || ''),
      quantity: Number(item?.quantity || 1),
      amount: Number(item?.estimatedLineTotal || 0),
      custom: Number(item?.estimatedLineTotal || 0) <= 0,
      source: item?.auto ? 'suggested' : 'customer',
    });
  });

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
    taxRate: Number(proposal.taxRate || 4.712),
    taxAmount: Number(proposal.taxAmount || 0),
    total: Number(proposal.total || 0),
    depositAmount: Number(proposal.depositAmount || 0),
    paymentsReceived,
    remainingBalance,
    paymentSchedule: proposal.paymentSchedule || [],
    notesToClient: proposal.notesToClient || '',
    acceptedAt: proposal.acceptance?.acceptedAt || '',
    acceptedName: proposal.acceptance?.name || '',
    originalQuote: record?.quote ? {
      guestCount: Number(quoteState.guestCount || 0),
      estimatedFurnitureTotal: Number(quoteState.estimatedFurnitureTotal || 0),
      publishedAddOnTotal: Number(quoteState.publishedAddOnTotal || 0),
      basePackagePrice: Number(quoteState.basePackagePrice || 0),
      estimatedKnownSavings: Number(quoteState.estimatedKnownSavings || 0),
      estimatedSavingsPercent: Number(quoteState.estimatedSavingsPercent || 0),
      customQuoteCount: Number(quoteState.customQuoteCount || 0),
      estimatedStartingTotal: Number(quoteState.estimatedStartingTotal || 0),
      lines: originalLines,
    } : null,
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
      await appendEvent(store, {
        type: 'proposal_viewed',
        recordId: record.id,
        quoteId: record.quoteId || '',
        packageId: record.packageId || '',
        detail: 'Client viewed the proposal.',
      });
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

      const booking = ensureBooking(record);
      const signwell = booking?.contract?.signwell || {};
      if (!signwell.documentId && signWellConfigured()) {
        try {
          const created:any = await createSignWellContract(record, new URL(req.url).origin);
          if (created?.documentId) {
            booking.contract.signwell = {
              status: created.status || 'sent',
              documentId: created.documentId,
              clientSigningUrl: created.embeddedSigningUrl || '',
              sentAt: now,
              completedAt: '',
              signedPdfStored: false,
            };
            await appendEvent(store, {
              type: 'signwell_contract_sent',
              recordId: record.id,
              quoteId: record.quoteId || '',
              packageId: record.packageId || '',
              detail: 'Personalized SignWell agreement created and sent for ordered signatures.',
              reference: created.documentId,
            });
          }
        } catch (error) {
          booking.contract.signwell = {
            ...signwell,
            status: 'send_failed',
            lastError: error instanceof Error ? error.message : 'SignWell request failed',
            lastAttemptAt: now,
          };
          await appendEvent(store, {
            type: 'signwell_contract_failed',
            recordId: record.id,
            quoteId: record.quoteId || '',
            packageId: record.packageId || '',
            detail: booking.contract.signwell.lastError,
          });
        }
      } else if (!signWellConfigured()) {
        booking.contract.signwell = { ...signwell, status: 'configuration_required' };
      }

      await appendEvent(store, {
        type: 'proposal_accepted',
        recordId: record.id,
        quoteId: record.quoteId || '',
        packageId: record.packageId || '',
        detail: 'Proposal accepted by ' + name,
      });
      await markLifecycleEvent(context, record, 'proposal_accepted', 'Proposal accepted; contract and deposit workflow activated.');
    } else {
      proposal.status = 'declined';
      proposal.declinedAt = now;
      record.status = 'declined';
      await appendEvent(store, {
        type: 'proposal_declined',
        recordId: record.id,
        quoteId: record.quoteId || '',
        packageId: record.packageId || '',
        detail: 'Client declined the proposal.',
      });
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
