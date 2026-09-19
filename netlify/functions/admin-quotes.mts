import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { requireAdmin } from './_shared/admin';

type QuoteItem = {
  id: string;
  name: string;
  quantity: number;
  auto?: boolean;
  estimatedLineTotal?: number;
};

type SavedQuote = {
  id: string;
  createdAt: string;
  expiresAt: string;
  state: {
    startingPoint?: string;
    guestCount?: number;
    selected?: QuoteItem[];
    estimatedFurnitureTotal?: number;
    publishedAddOnTotal?: number;
    basePackagePrice?: number;
    estimatedStartingTotal?: number;
    estimatedSavingsPercent?: number;
    estimatedKnownSavings?: number;
    customQuoteCount?: number;
    packageIncludes?: string[];
    packageIncludedInventory?: string;
  };
};

type ProposalLine = {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  custom: boolean;
};

type PaymentItem = {
  label: string;
  dueDate: string;
  amount: number;
};

type BookingPayment = PaymentItem & {
  id: string;
  status: 'pending' | 'paid';
  paidAt?: string;
  reference?: string;
  paymentUrl?: string;
};

type BookingState = {
  status: 'contract_pending' | 'deposit_pending' | 'booked';
  createdAt: string;
  updatedAt: string;
  contract: {
    version: number;
    title: string;
    generatedAt: string;
    viewedAt?: string;
    status: 'pending' | 'signed';
    sections: Array<{ heading: string; body: string }>;
    signature?: { name: string; signedAt: string; acknowledgement: string } | null;
    koaSignature?: { name: string; signedAt: string } | null;
  };
  payments: BookingPayment[];
};

type SalesRecord = {
  id: string;
  kind: 'inquiry' | 'lead' | 'proposal';
  stage: 'inquiry' | 'lead' | 'proposal' | 'booked' | 'lost' | 'converted';
  quoteId?: string;
  packageId?: string;
  createdAt: string;
  updatedAt?: string;
  status: string;
  source?: string;
  customer: {
    name: string;
    email: string;
    phone: string;
    eventDate: string;
    notes: string;
  };
  inquiry?: Record<string, unknown>;
  quote?: SavedQuote;
  proposal?: {
    publicToken: string;
    status: 'draft' | 'sent' | 'viewed' | 'accepted' | 'declined' | 'expired' | 'booked';
    expirationDate: string;
    lineItems: ProposalLine[];
    subtotal: number;
    discountAmount: number;
    taxRate: number;
    taxAmount: number;
    total: number;
    depositAmount: number;
    paymentSchedule: PaymentItem[];
    notesToClient: string;
    acceptance?: { name: string; acceptedAt: string };
  };
  booking?: BookingState;
};

function quoteStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-quotes', consistency: 'strong' })
    : getDeployStore({ name: 'koa-quotes' });
}

function salesStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-sales', consistency: 'strong' })
    : getDeployStore({ name: 'koa-sales' });
}

function cleanText(value: unknown, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

function finite(value: unknown, min = 0, max = 10_000_000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : 0;
}

function idSuffix(bytesCount = 5) {
  const bytes = new Uint8Array(bytesCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function publicToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(36).slice(-1)).join('') + idSuffix(6);
}

function normalizePackage(value: unknown) {
  const raw = cleanText(value, 80).toLowerCase();
  if (raw === 'plumeria' || raw === 'signature') return 'signature-wedding';
  return raw;
}

const PACKAGE_PRICES: Record<string, number> = {
  gardenia: 5000,
  orchid: 10000,
  hibiscus: 15000,
  'signature-wedding': 20000,
};

const PACKAGE_NAMES: Record<string, string> = {
  gardenia: 'Gardenia Wedding Collection',
  orchid: 'Orchid Wedding Collection',
  hibiscus: 'Hibiscus Wedding Collection',
  'signature-wedding': 'Koa’s Signature Wedding Experience',
};

async function readSalesIndex(context: Context): Promise<SalesRecord[]> {
  const store = salesStoreFor(context);
  const raw = ((await store.get('records/index', { type: 'json' })) || []) as SalesRecord[];
  return raw.map((record: any) => ({
    ...record,
    stage: record.stage || (record.kind === 'proposal' ? 'proposal' : record.kind === 'lead' ? 'lead' : 'inquiry'),
    updatedAt: record.updatedAt || record.createdAt,
    packageId: normalizePackage(record.packageId || record.quote?.state?.startingPoint || record.inquiry?.venuePackage),
  }));
}

async function writeSalesIndex(context: Context, records: SalesRecord[]) {
  const store = salesStoreFor(context);
  await store.setJSON('records/index', records.slice(0, 1500));
}

async function saveRecord(context: Context, record: SalesRecord, records: SalesRecord[]) {
  const store = salesStoreFor(context);
  const next = records.some((entry) => entry.id === record.id)
    ? records.map((entry) => entry.id === record.id ? record : entry)
    : [record, ...records];
  await store.setJSON('records/' + record.id, record);
  await writeSalesIndex(context, next);
  return next;
}

async function listQuotes(context: Context): Promise<SavedQuote[]> {
  const store = quoteStoreFor(context);
  const result = await store.list({ prefix: 'quotes/' });
  const keys = (result.blobs || [])
    .map((entry: any) => String(entry.key || ''))
    .filter((key: string) => /^quotes\/[2-9A-HJ-NP-Z]{16}$/.test(key))
    .slice(0, 750);

  const quotes = await Promise.all(
    keys.map((key: string) => store.get(key, { type: 'json' }) as Promise<SavedQuote | null>)
  );

  return quotes
    .filter((quote): quote is SavedQuote => Boolean(quote?.id))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function getQuote(context: Context, quoteId: string) {
  if (!quoteId) return null;
  return await quoteStoreFor(context).get('quotes/' + quoteId, { type: 'json' }) as SavedQuote | null;
}

async function readEvents(context: Context): Promise<any[]> {
  return (await salesStoreFor(context).get('analytics/events/index', { type: 'json' })) || [];
}

async function appendEvent(context: Context, event: Record<string, unknown>) {
  const store = salesStoreFor(context);
  const current = await readEvents(context);
  await store.setJSON('analytics/events/index', [{
    id: 'EVT-' + idSuffix(6),
    createdAt: new Date().toISOString(),
    ...event,
  }, ...current].slice(0, 10000));
}


function contractSections(record: SalesRecord) {
  const proposal = record.proposal;
  const packageName = PACKAGE_NAMES[normalizePackage(record.packageId)] || 'Koa’s Events services';
  return [
    { heading: '1. Event Details', body: 'This Event Venue Rental Agreement is between Koa’s Events, 11-3334 Hibiscus St, Mountain View, HI 96771 (“Lessor” or “Koa’s”) and ' + (record.customer?.name || 'the Client') + ' (“Lessee”). The event is scheduled for ' + (record.customer?.eventDate || 'the date shown in the accepted proposal') + '. The accepted proposal and finalized event plan supply the event type, rental period, package, quantities, and other event-specific details.' },
    { heading: '2. Premises Use & Access', body: 'Lessee is granted exclusive access to the property for the scheduled event. Koa’s Events reserves the right to define accessible areas if only a portion of the venue is being rented. Unauthorized access to non-designated areas is prohibited.' },
    { heading: '3. Payment Terms', body: 'The finalized proposal total is $' + Number(proposal?.total || 0).toFixed(2) + ' for the ' + packageName + ' and finalized proposal scope. A 10% non-refundable deposit is required to reserve the event date. The first payment is due within 14 days of signing, the second payment is due 90 days before the event, and the final payment is due 60 days before the event. A $150 late fee applies per occurrence; two missed payments may result in event cancellation with no refund.' },
    { heading: '4. Security / Damage Deposit', body: 'The separate security or damage deposit required for the event is due 30 days before the event. Failure to pay authorizes cancellation by Koa’s. The deposit will be refunded within 14 days after the event, less deductions for damage, excessive cleanup, or breach.' },
    { heading: '5. Cancellation & Change of Date', body: 'Lessee may cancel within 15 calendar days of signing for a full refund. After that, all payments are non-refundable. Lessee may request one change to the event date by submitting a written request at least eight months before the originally scheduled date, subject to availability. A non-refundable change fee of $500 for single-day rentals or $1,000 for weekend rentals applies. Prior payments transfer to the approved new date; no additional date changes are permitted after the new date is confirmed.' },
    { heading: '6. Conduct, Safety, and Clean-Up', body: 'Lessee is responsible for guest behavior. Excess-mess cleanup, including vomit or spills, is charged at $50 per hour or per occurrence. All personal items and decor must be removed after the event. Children under 16 must be supervised by an adult. Smoking is allowed only in designated areas.' },
    { heading: '7. Vendors, Insurance, and Alcohol', body: 'Vendors must carry insurance naming Koa’s as additional insured, with proof due 30 days before the event. Event insurance is required, with the certificate due 60 days before the event. Only pre-approved bartenders are allowed. Self-serve bars and shots after 8:00 PM are prohibited; violation may result in event termination.' },
    { heading: '8. Intellectual Property & Media Use', body: 'Koa’s reserves all rights to its brand, decor, and imagery. Lessee may not use photos or likenesses of the venue for commercial purposes without written consent. By default, Koa’s may use photos from the event for promotional purposes unless the client opts out in writing.' },
    { heading: '9. Legal Terms & Electronic Signature', body: 'This Agreement is governed by Hawaii state law. Disputes are to be resolved through mediation, followed by binding arbitration in Hilo, Hawaii if necessary. Neither party is liable for events outside its control (Force Majeure). By signing electronically, Lessee confirms review of the accepted proposal and this Agreement, intends to sign electronically, and agrees that the recorded name, acknowledgement, and timestamp constitute Lessee’s signature.' },
  ];
}

function ensureBooking(record: SalesRecord) {
  if (!record.proposal) return null;
  if (!record.booking) {
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
        koaSignature: null,
      },
      payments: (record.proposal.paymentSchedule || []).map((item, index) => ({
        id: 'pay-' + (index + 1),
        label: item.label,
        dueDate: item.dueDate,
        amount: Number(item.amount || 0),
        status: 'pending',
        paidAt: '',
        reference: '',
        paymentUrl: '',
      })),
    };
  }
  return record.booking;
}

function proposalFromQuote(quote: SavedQuote | null, eventDate = '', packageId = '') {
  const lines: ProposalLine[] = [];
  const state = quote?.state || {};
  const normalizedPackage = normalizePackage(state.startingPoint || packageId);
  const base = finite(state.basePackagePrice || PACKAGE_PRICES[normalizedPackage] || 0);
  if (base > 0) {
    lines.push({
      id: 'collection',
      description: PACKAGE_NAMES[normalizedPackage] || 'Wedding collection',
      quantity: 1,
      unitPrice: base,
      amount: base,
      custom: false,
    });
  }

  (state.selected || []).forEach((item) => {
    const amount = finite(item.estimatedLineTotal);
    const quantity = Math.max(1, Math.round(finite(item.quantity, 1, 500)));
    lines.push({
      id: cleanText(item.id, 80),
      description: cleanText(item.name, 180),
      quantity,
      unitPrice: amount > 0 ? amount / quantity : 0,
      amount,
      custom: amount <= 0,
    });
  });

  const subtotal = lines.reduce((sum, line) => sum + finite(line.amount), 0);
  const discountAmount = Math.min(subtotal, finite(state.estimatedKnownSavings || 0));
  const total = Math.max(0, Math.round((subtotal - discountAmount) * 100) / 100);
  const depositAmount = Math.round(total * 0.10 * 100) / 100;
  const remaining = Math.max(0, total - depositAmount);
  const secondAmount = Math.round((remaining / 2) * 100) / 100;
  const finalAmount = Math.round((remaining - secondAmount) * 100) / 100;
  const schedule: PaymentItem[] = [
    { label: 'Reservation deposit', dueDate: '', amount: depositAmount },
    { label: 'Second payment', dueDate: eventDate ? offsetDate(eventDate, -90) : '', amount: secondAmount },
    { label: 'Final payment', dueDate: eventDate ? offsetDate(eventDate, -60) : '', amount: finalAmount },
  ];

  return {
    publicToken: publicToken(),
    status: 'draft' as const,
    expirationDate: offsetDate(new Date().toISOString().slice(0, 10), 14),
    lineItems: lines,
    subtotal,
    discountAmount,
    taxRate: 0,
    taxAmount: 0,
    total,
    depositAmount,
    paymentSchedule: schedule,
    notesToClient: '',
  };
}

function offsetDate(date: string, days: number) {
  const parsed = new Date(date + 'T12:00:00Z');
  if (Number.isNaN(parsed.getTime())) return '';
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function sanitizeLines(input: unknown): ProposalLine[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 80).map((line: any, index) => {
    const quantity = Math.max(1, Math.round(finite(line?.quantity, 1, 500)));
    const unitPrice = finite(line?.unitPrice);
    return {
      id: cleanText(line?.id || 'line-' + (index + 1), 80),
      description: cleanText(line?.description, 240),
      quantity,
      unitPrice,
      amount: Math.round(quantity * unitPrice * 100) / 100,
      custom: Boolean(line?.custom),
    };
  }).filter((line) => line.description);
}

function sanitizeSchedule(input: unknown): PaymentItem[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 12).map((item: any) => ({
    label: cleanText(item?.label, 160),
    dueDate: cleanText(item?.dueDate, 40),
    amount: finite(item?.amount),
  })).filter((item) => item.label);
}

function updateProposal(record: SalesRecord, payload: any) {
  const current = record.proposal || proposalFromQuote(record.quote || null, record.customer?.eventDate || '', record.packageId || '');
  const lineItems = sanitizeLines(payload.lineItems);
  const subtotal = Math.round(lineItems.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;
  const discountAmount = Math.min(subtotal, finite(payload.discountAmount));
  const taxable = Math.max(0, subtotal - discountAmount);
  const taxRate = finite(payload.taxRate, 0, 100);
  const taxAmount = Math.round(taxable * taxRate) / 100;
  const total = Math.round((taxable + taxAmount) * 100) / 100;
  const statusValues = new Set(['draft','sent','viewed','accepted','declined','expired','booked']);
  const requestedStatus = cleanText(payload.status, 30);
  const status = statusValues.has(requestedStatus) ? requestedStatus as any : current.status;

  record.customer = {
    ...record.customer,
    name: cleanText(payload.customer?.name ?? record.customer?.name, 180),
    email: cleanText(payload.customer?.email ?? record.customer?.email, 240),
    phone: cleanText(payload.customer?.phone ?? record.customer?.phone, 80),
    eventDate: cleanText(payload.customer?.eventDate ?? record.customer?.eventDate, 40),
    notes: cleanText(payload.customer?.notes ?? record.customer?.notes, 4000),
  };

  record.proposal = {
    ...current,
    status,
    expirationDate: cleanText(payload.expirationDate || current.expirationDate, 40),
    lineItems,
    subtotal,
    discountAmount,
    taxRate,
    taxAmount,
    total,
    depositAmount: Math.min(total, finite(payload.depositAmount)),
    paymentSchedule: sanitizeSchedule(payload.paymentSchedule),
    notesToClient: cleanText(payload.notesToClient, 6000),
  };
  record.status = status;
  record.stage = status === 'booked' ? 'booked' : 'proposal';
  record.updatedAt = new Date().toISOString();
  return record;
}

function quoteAnalytics(quotes: SavedQuote[]) {
  const packageCounts = new Map<string, number>();
  const addOnCounts = new Map<string, { name: string; count: number; quantity: number }>();
  let totalGuestCount = 0;
  let estimatedValue = 0;
  quotes.forEach((quote) => {
    const start = normalizePackage(quote.state?.startingPoint) || 'unspecified';
    packageCounts.set(start, (packageCounts.get(start) || 0) + 1);
    totalGuestCount += Number(quote.state?.guestCount || 0);
    estimatedValue += Number(quote.state?.estimatedStartingTotal || 0);
    (quote.state?.selected || []).forEach((item) => {
      if (item.auto) return;
      const current = addOnCounts.get(item.id) || { name: item.name || item.id, count: 0, quantity: 0 };
      current.count += 1;
      current.quantity += Number(item.quantity || 0);
      addOnCounts.set(item.id, current);
    });
  });
  return {
    quoteCount: quotes.length,
    averageGuestCount: quotes.length ? Math.round(totalGuestCount / quotes.length) : 0,
    estimatedPipelineValue: estimatedValue,
    packages: [...packageCounts.entries()].map(([id,count]) => ({ id,count })).sort((a,b) => b.count-a.count),
    addOns: [...addOnCounts.entries()].map(([id,value]) => ({ id,...value })).sort((a,b) => b.count-a.count || b.quantity-a.quantity).slice(0,20),
  };
}

function funnelAnalytics(events: any[], records: SalesRecord[]) {
  const ids = ['gardenia','orchid','hibiscus','signature-wedding'];
  return ids.map((packageId) => {
    const views = new Set(events.filter((e) => e.type === 'package_view' && normalizePackage(e.packageId) === packageId).map((e) => e.sessionId || e.id)).size;
    const saves = new Set(events.filter((e) => e.type === 'quote_saved' && normalizePackage(e.packageId) === packageId).map((e) => e.quoteId || e.id)).size;
    const leads = records.filter((r) => r.kind === 'lead' && normalizePackage(r.packageId || r.quote?.state?.startingPoint) === packageId).length;
    const proposals = records.filter((r) => r.kind === 'proposal' && normalizePackage(r.packageId || r.quote?.state?.startingPoint) === packageId).length;
    const booked = records.filter((r) => r.stage === 'booked' && normalizePackage(r.packageId || r.quote?.state?.startingPoint) === packageId).length;
    return {
      packageId,
      views,
      saves,
      leads,
      proposals,
      booked,
      viewToSave: views ? saves / views : null,
      saveToLead: saves ? leads / saves : null,
      leadToProposal: leads ? proposals / leads : null,
      proposalToBooked: proposals ? booked / proposals : null,
    };
  });
}

export default async (req: Request, context: Context) => {
  const auth = await requireAdmin();
  if (auth.response) return auth.response;

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const q = cleanText(url.searchParams.get('q'), 120).toLowerCase();
    const [allQuotes, records, events] = await Promise.all([listQuotes(context), readSalesIndex(context), readEvents(context)]);

    const filteredQuotes = q ? allQuotes.filter((quote) => [
      quote.id, quote.state?.startingPoint, quote.state?.guestCount,
      ...(quote.state?.selected || []).flatMap((item) => [item.id, item.name]),
    ].join(' ').toLowerCase().includes(q)) : allQuotes;

    const filteredRecords = q ? records.filter((record) => [
      record.id, record.kind, record.stage, record.status, record.quoteId, record.packageId,
      record.customer?.name, record.customer?.email, record.customer?.phone, record.customer?.eventDate,
    ].join(' ').toLowerCase().includes(q)) : records;

    const conversions = records.reduce<Record<string, SalesRecord[]>>((acc, record) => {
      if (record.quoteId) (acc[record.quoteId] ||= []).push(record);
      return acc;
    }, {});

    return Response.json({
      quotes: filteredQuotes.slice(0, 300),
      analytics: quoteAnalytics(allQuotes),
      funnel: funnelAnalytics(events, records),
      conversions,
      records: filteredRecords.slice(0, 500),
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const payload: any = await req.json().catch(() => null);
  if (!payload?.action) return Response.json({ error: 'Missing action.' }, { status: 400 });

  let records = await readSalesIndex(context);

  if (payload.action === 'convert') {
    const quoteId = cleanText(payload.quoteId, 24).toUpperCase();
    const kind = payload.kind === 'proposal' ? 'proposal' : payload.kind === 'lead' ? 'lead' : '';
    if (!/^[2-9A-HJ-NP-Z]{16}$/.test(quoteId) || !kind) return Response.json({ error: 'Valid quote and conversion type required.' }, { status: 400 });
    const quote = await getQuote(context, quoteId);
    if (!quote) return Response.json({ error: 'Quote not found.' }, { status: 404 });

    const existing = records.find((entry) =>
      entry.quoteId === quoteId &&
      entry.kind === kind &&
      entry.stage !== 'lost'
    );
    if (existing) {
      return Response.json({ ok: true, record: existing, reused: true }, { headers: { 'Cache-Control': 'private, no-store' } });
    }

    const now = new Date().toISOString();
    const packageId = normalizePackage(quote.state?.startingPoint);
    const record: SalesRecord = {
      id: (kind === 'proposal' ? 'KEP-' : 'KEL-') + new Date().getUTCFullYear() + '-' + idSuffix(),
      kind,
      stage: kind === 'proposal' ? 'proposal' : 'lead',
      quoteId,
      packageId,
      createdAt: now,
      updatedAt: now,
      status: kind === 'proposal' ? 'draft' : 'new',
      customer: {
        name: cleanText(payload.customer?.name, 180),
        email: cleanText(payload.customer?.email, 240),
        phone: cleanText(payload.customer?.phone, 80),
        eventDate: cleanText(payload.customer?.eventDate, 40),
        notes: cleanText(payload.customer?.notes, 4000),
      },
      quote,
      proposal: kind === 'proposal' ? proposalFromQuote(quote, cleanText(payload.customer?.eventDate, 40), packageId) : undefined,
    };
    records = await saveRecord(context, record, records);
    await appendEvent(context, { type: kind, packageId, quoteId, recordId: record.id });
    return Response.json({ ok: true, record }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  if (payload.action === 'promote') {
    const source = records.find((entry) => entry.id === cleanText(payload.recordId, 80));
    const kind = payload.kind === 'proposal' ? 'proposal' : payload.kind === 'lead' ? 'lead' : '';
    if (!source || !kind) return Response.json({ error: 'Record or promotion type not found.' }, { status: 404 });

    const existing = records.find((entry) =>
      entry.kind === kind &&
      entry.stage !== 'lost' &&
      (
        (source.quoteId && entry.quoteId === source.quoteId) ||
        entry.source === source.id
      )
    );
    if (existing) return Response.json({ ok: true, record: existing, reused: true });

    const quote = source.quote || await getQuote(context, source.quoteId || '');
    const now = new Date().toISOString();
    const packageId = normalizePackage(source.packageId || quote?.state?.startingPoint || source.inquiry?.venuePackage);
    const record: SalesRecord = {
      id: (kind === 'proposal' ? 'KEP-' : 'KEL-') + new Date().getUTCFullYear() + '-' + idSuffix(),
      kind,
      stage: kind === 'proposal' ? 'proposal' : 'lead',
      quoteId: source.quoteId,
      packageId,
      createdAt: now,
      updatedAt: now,
      status: kind === 'proposal' ? 'draft' : 'new',
      source: source.id,
      customer: { ...source.customer },
      quote: quote || undefined,
      proposal: kind === 'proposal' ? proposalFromQuote(quote, source.customer?.eventDate || '', packageId) : undefined,
    };
    source.stage = 'converted';
    source.status = 'converted';
    source.updatedAt = now;
    records = await saveRecord(context, source, records);
    records = await saveRecord(context, record, records);
    await appendEvent(context, { type: kind, packageId, quoteId: source.quoteId || '', recordId: record.id, sourceRecordId: source.id });
    return Response.json({ ok: true, record, convertedSourceId: source.id });
  }

  if (payload.action === 'update-proposal') {
    const record = records.find((entry) => entry.id === cleanText(payload.recordId, 80) && entry.kind === 'proposal');
    if (!record) return Response.json({ error: 'Proposal not found.' }, { status: 404 });
    const before = record.proposal?.status;
    updateProposal(record, payload.proposal || {});
    records = await saveRecord(context, record, records);
    if (before !== 'sent' && record.proposal?.status === 'sent') await appendEvent(context, { type: 'proposal_sent', packageId: record.packageId, recordId: record.id, quoteId: record.quoteId || '' });
    if (before !== 'booked' && record.proposal?.status === 'booked') await appendEvent(context, { type: 'booked', packageId: record.packageId, recordId: record.id, quoteId: record.quoteId || '' });
    return Response.json({ ok: true, record });
  }

  if (payload.action === 'mark-booked') {
    const record = records.find((entry) => entry.id === cleanText(payload.recordId, 80));
    if (!record) return Response.json({ error: 'Record not found.' }, { status: 404 });
    record.stage = 'booked';
    record.status = 'booked';
    record.updatedAt = new Date().toISOString();
    if (record.proposal) record.proposal.status = 'booked';
    records = await saveRecord(context, record, records);
    await appendEvent(context, { type: 'booked', packageId: record.packageId || record.quote?.state?.startingPoint, recordId: record.id, quoteId: record.quoteId || '' });
    return Response.json({ ok: true, record });
  }

  if (payload.action === 'update-stage') {
    const record = records.find((entry) => entry.id === cleanText(payload.recordId, 80));
    const allowed = new Set(['inquiry','lead','proposal','booked','lost']);
    const stage = cleanText(payload.stage, 30);
    if (!record || !allowed.has(stage)) return Response.json({ error: 'Record or stage not found.' }, { status: 400 });
    record.stage = stage as any;
    record.status = stage;
    record.updatedAt = new Date().toISOString();
    records = await saveRecord(context, record, records);
    if (stage === 'booked') await appendEvent(context, { type: 'booked', packageId: record.packageId || record.quote?.state?.startingPoint, recordId: record.id, quoteId: record.quoteId || '' });
    return Response.json({ ok: true, record });
  }

  return Response.json({ error: 'Unknown action.' }, { status: 400 });
};

export const config: Config = { path: '/api/admin/quotes' };