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
  const packageName = (
    record?.packageId === 'signature-wedding'
      ? 'Koa’s Signature Wedding Experience'
      : record?.packageId
        ? record.packageId.charAt(0).toUpperCase() + record.packageId.slice(1) + ' Wedding Collection'
        : 'Koa’s Events services'
  );

  return [
    {
      heading: '1. Event Details',
      body: 'This Event Venue Rental Agreement is between Koa’s Events, 11-3334 Hibiscus St, Mountain View, HI 96771 (“Lessor” or “Koa’s”) and ' + (customer.name || 'the Client') + ' (“Lessee”). The event is scheduled for ' + (customer.eventDate || 'the date shown in the accepted proposal') + '. The accepted proposal and finalized event plan supply the event type, rental period, package, quantities, and other event-specific details.'
    },
    {
      heading: '2. Premises Use & Access',
      body: 'Lessee is granted exclusive access to the property for the scheduled event. Koa’s Events reserves the right to define accessible areas if only a portion of the venue is being rented. Unauthorized access to non-designated areas is prohibited.'
    },
    {
      heading: '3. Payment Terms',
      body: 'The finalized proposal total is $' + Number(proposal.total || 0).toFixed(2) + ' for the ' + packageName + ' and finalized proposal scope. A 10% non-refundable deposit is required to reserve the event date. The first payment is due within 14 days of signing, the second payment is due 90 days before the event, and the final payment is due 60 days before the event. A $150 late fee applies per occurrence; two missed payments may result in event cancellation with no refund.'
    },
    {
      heading: '4. Security / Damage Deposit',
      body: 'The separate security or damage deposit required for the event is due 30 days before the event. Failure to pay authorizes cancellation by Koa’s. The deposit will be refunded within 14 days after the event, less deductions for damage, excessive cleanup, or breach.'
    },
    {
      heading: '5. Cancellation & Change of Date',
      body: 'Lessee may cancel within 15 calendar days of signing for a full refund. After that, all payments are non-refundable. Lessee may request one change to the event date by submitting a written request at least eight months before the originally scheduled date, subject to availability. A non-refundable change fee of $500 for single-day rentals or $1,000 for weekend rentals applies. Prior payments transfer to the approved new date; no additional date changes are permitted after the new date is confirmed.'
    },
    {
      heading: '6. Conduct, Safety, and Clean-Up',
      body: 'Lessee is responsible for guest behavior. Excess-mess cleanup, including vomit or spills, is charged at $50 per hour or per occurrence. All personal items and decor must be removed after the event. Children under 16 must be supervised by an adult. Smoking is allowed only in designated areas.'
    },
    {
      heading: '7. Vendors, Insurance, and Alcohol',
      body: 'Vendors must carry insurance naming Koa’s as additional insured, with proof due 30 days before the event. Event insurance is required, with the certificate due 60 days before the event. Only pre-approved bartenders are allowed. Self-serve bars and shots after 8:00 PM are prohibited; violation may result in event termination.'
    },
    {
      heading: '8. Intellectual Property & Media Use',
      body: 'Koa’s reserves all rights to its brand, decor, and imagery. Lessee may not use photos or likenesses of the venue for commercial purposes without written consent. By default, Koa’s may use photos from the event for promotional purposes unless the client opts out in writing.'
    },
    {
      heading: '9. Legal Terms & Electronic Signature',
      body: 'This Agreement is governed by Hawaii state law. Disputes are to be resolved through mediation, followed by binding arbitration in Hilo, Hawaii if necessary. Neither party is liable for events outside its control (Force Majeure). By signing electronically, Lessee confirms review of the accepted proposal and this Agreement, intends to sign electronically, and agrees that the recorded name, acknowledgement, and timestamp constitute Lessee’s signature.'
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
