import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';

function salesStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-sales', consistency: 'strong' })
    : getDeployStore({ name: 'koa-sales' });
}

function clean(value: unknown, max = 1000) {
  return String(value || '').trim().slice(0, max);
}

function idSuffix(bytesCount = 6) {
  const bytes = new Uint8Array(bytesCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function offsetDate(iso: string, days: number) {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

async function appendEvent(store: any, event: Record<string, unknown>) {
  const current = (await store.get('analytics/events/index', { type: 'json' })) || [];
  await store.setJSON('analytics/events/index', [{
    id: 'EVT-' + idSuffix(),
    createdAt: new Date().toISOString(),
    ...event,
  }, ...current].slice(0, 10000));
}

function contractSections(record: any) {
  const proposal = record?.proposal || {};
  const customer = record?.customer || {};
  const packageName = record?.packageId === 'signature-wedding'
    ? 'Koa’s Signature Wedding Experience'
    : record?.packageId
      ? record.packageId.charAt(0).toUpperCase() + record.packageId.slice(1) + ' Wedding Collection'
      : 'Koa’s Events services';

  return [
    {
      heading: '1. Parties and event',
      body: 'This agreement is between Koa’s Events LLC (“Koa’s”) and ' + (customer.name || 'the Client') + ' for the event scheduled for ' + (customer.eventDate || 'the date shown in the accepted proposal') + '. The accepted proposal and this agreement together define the booked scope.'
    },
    {
      heading: '2. Services and pricing',
      body: 'Koa’s will provide the ' + packageName + ' and the finalized items listed in proposal ' + record.id + '. The finalized proposal total is $' + Number(proposal.total || 0).toFixed(2) + '. Any later additions, substitutions, quantity changes, overtime, damage, or approved change orders may alter the final amount.'
    },
    {
      heading: '3. Reservation deposit and payment schedule',
      body: 'A 10% non-refundable reservation deposit is required. Under Koa’s current payment policy, the deposit is due within 14 days of signing, the second payment is due 90 days before the event, and the final payment is due 60 days before the event. A $150 late fee may apply per occurrence; two missed payments may result in cancellation.'
    },
    {
      heading: '4. Cancellation and date changes',
      body: 'Cancellation within 15 calendar days of signing receives a full refund. After that period, payments are non-refundable. One date change may be requested at least eight months before the original event date, subject to availability and the applicable $500 single-day or $1,000 weekend change fee.'
    },
    {
      heading: '5. Damage deposit and insurance',
      body: 'The current damage-deposit policy is $500 for a one-day event and $1,000 for a weekend event, due 30 days before the event and refundable within 14 days after the event less applicable deductions. Event insurance is due 60 days before the event, and vendor proof of insurance is due 30 days before the event.'
    },
    {
      heading: '6. Alcohol, music, access and event rules',
      body: 'Alcohol service must use pre-approved bartenders; self-service is not permitted and shots are not served after 8:00 PM. Music must end by 10:00 PM. Setup begins no earlier than 12:00 PM unless Koa’s approves otherwise. Client and vendors are responsible for following venue rules and the finalized event plan.'
    },
    {
      heading: '7. Electronic signature',
      body: 'By signing electronically, the Client confirms that they reviewed the accepted proposal and this agreement, intend to sign electronically, and agree that the electronic signature and timestamp constitute their signature for this booking.'
    }
  ];
}

function ensureBooking(record: any) {
  const proposal = record?.proposal || {};
  if (!record.booking) {
    const schedule = (proposal.paymentSchedule || []).map((item: any, index: number) => ({
      id: 'pay-' + (index + 1),
      label: clean(item?.label || 'Payment', 120),
      dueDate: clean(item?.dueDate || '', 40),
      amount: Number(item?.amount || 0),
      status: 'pending',
      paidAt: '',
      reference: '',
      paymentUrl: '',
    }));
    record.booking = {
      status: 'contract_pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      contract: {
        version: 1,
        title: 'Koa’s Events Venue & Services Agreement',
        generatedAt: new Date().toISOString(),
        status: 'pending',
        sections: contractSections(record),
        signature: null,
      },
      payments: schedule,
    };
  }
  return record.booking;
}

function publicBooking(record: any) {
  const booking = ensureBooking(record);
  const proposal = record.proposal || {};
  return {
    id: record.id,
    status: booking.status,
    customerName: record.customer?.name || '',
    eventDate: record.customer?.eventDate || '',
    packageId: record.packageId || '',
    proposalTotal: Number(proposal.total || 0),
    proposalId: record.id,
    contract: {
      title: booking.contract?.title || 'Koa’s Events Venue & Services Agreement',
      version: booking.contract?.version || 1,
      generatedAt: booking.contract?.generatedAt || '',
      status: booking.contract?.status || 'pending',
      sections: booking.contract?.sections || [],
      signature: booking.contract?.signature || null,
    },
    payments: (booking.payments || []).map((item: any) => ({
      id: item.id,
      label: item.label,
      dueDate: item.dueDate,
      amount: Number(item.amount || 0),
      status: item.status || 'pending',
      paidAt: item.paidAt || '',
      reference: item.reference || '',
      paymentUrl: item.paymentUrl || '',
    })),
    onlinePaymentConfigured: Boolean((booking.payments || []).some((item: any) => item.paymentUrl)),
  };
}

export default async (req: Request, context: Context) => {
  const token = clean(context.params.token, 100);
  if (!/^[A-Za-z0-9_-]{24,100}$/.test(token)) {
    return Response.json({ error: 'Invalid booking link.' }, { status: 400 });
  }

  const store = salesStoreFor(context);
  const list = ((await store.get('records/index', { type: 'json' })) || []) as any[];
  const record = list.find((entry: any) => entry?.kind === 'proposal' && entry?.proposal?.publicToken === token);
  if (!record) return Response.json({ error: 'Booking not found.' }, { status: 404 });
  if (!['accepted','booked'].includes(record.proposal?.status)) {
    return Response.json({ error: 'This booking becomes available after proposal acceptance.' }, { status: 403 });
  }

  const booking = ensureBooking(record);

  if (req.method === 'GET') {
    const next = list.map((entry: any) => entry.id === record.id ? record : entry);
    await store.setJSON('records/' + record.id, record);
    await store.setJSON('records/index', next);
    return Response.json({ booking: publicBooking(record) }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  if (req.method === 'POST') {
    const payload: any = await req.json().catch(() => null);
    const action = clean(payload?.action, 30);
    if (action !== 'sign') return Response.json({ error: 'Invalid booking action.' }, { status: 400 });

    if (booking.contract?.status === 'signed') {
      return Response.json({ ok: true, booking: publicBooking(record), alreadySigned: true }, { headers: { 'Cache-Control': 'private, no-store' } });
    }

    const name = clean(payload?.name, 180);
    if (name.length < 2 || payload?.acknowledged !== true) {
      return Response.json({ error: 'Enter your full name and confirm the electronic-signature acknowledgement.' }, { status: 400 });
    }

    const now = new Date().toISOString();
    booking.contract.status = 'signed';
    booking.contract.signature = {
      name,
      signedAt: now,
      acknowledgement: 'I reviewed and agree to the Koa’s Events Venue & Services Agreement and consent to sign electronically.',
    };
    booking.status = 'deposit_pending';
    booking.updatedAt = now;

    const deposit = (booking.payments || []).find((item: any) => /deposit/i.test(item.label)) || booking.payments?.[0];
    if (deposit && !deposit.dueDate) deposit.dueDate = offsetDate(now, 14);

    record.updatedAt = now;
    const next = list.map((entry: any) => entry.id === record.id ? record : entry);
    await store.setJSON('records/' + record.id, record);
    await store.setJSON('records/index', next);
    await appendEvent(store, {
      type: 'contract_signed',
      recordId: record.id,
      quoteId: record.quoteId || '',
      packageId: record.packageId || '',
      detail: 'Contract electronically signed by ' + name,
    });

    return Response.json({ ok: true, booking: publicBooking(record) }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config: Config = { path: '/api/bookings/:token' };
