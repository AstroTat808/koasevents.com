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
  security?: {
    disposition: 'allowed' | 'flagged';
    riskScore: number;
    reasons: string[];
    reasonCodes: string[];
  };
  communications?: Record<string, {
    messageId?: string;
    status?: 'pending' | 'sent' | 'delivered' | 'bounced' | 'failed' | string;
    sentAt?: string;
    updatedAt?: string;
  }>;
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

type TrashEntry = {
  id: string;
  kind: 'inquiry' | 'lead';
  customerName: string;
  customerEmail: string;
  eventDate: string;
  packageId: string;
  deletedAt: string;
  expiresAt: string;
  deletedBy: string;
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
  'mobile-oahu': 1200,
  'mobile-maui': 1500,
  'mobile-big-island': 1800,
};

const PACKAGE_NAMES: Record<string, string> = {
  gardenia: 'Gardenia Wedding Collection',
  orchid: 'Orchid Wedding Collection',
  hibiscus: 'Hibiscus Wedding Collection',
  'signature-wedding': 'Koa’s Signature Wedding Experience',
  'mobile-oahu': 'Koa’s Mobile Bar — Oahu Package',
  'mobile-maui': 'Koa’s Mobile Bar — Maui Package',
  'mobile-big-island': 'Koa’s Mobile Bar — Big Island Package',
  'mobile-custom': 'Koa’s Mobile Bar — Custom Service',
};

async function readSalesIndex(context: Context): Promise<SalesRecord[]> {
  const store = salesStoreFor(context);
  const raw = ((await store.get('records/index', { type: 'json' })) || []) as SalesRecord[];
  return raw.map((record: any) => ({
    ...record,
    stage: record.stage || (record.kind === 'proposal' ? 'proposal' : record.kind === 'lead' ? 'lead' : 'inquiry'),
    updatedAt: record.updatedAt || record.createdAt,
    packageId: normalizePackage(record.packageId || record.quote?.state?.startingPoint || record.inquiry?.venuePackage || record.inquiry?.mobileBarPackage),
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

async function readTrashIndex(context: Context): Promise<TrashEntry[]> {
  return ((await salesStoreFor(context).get('trash/index', { type: 'json' })) || []) as TrashEntry[];
}

async function writeTrashIndex(context: Context, entries: TrashEntry[]) {
  await salesStoreFor(context).setJSON('trash/index', entries.slice(0, 1000));
}

async function purgeExpiredTrash(context: Context, entries?: TrashEntry[]) {
  const store = salesStoreFor(context);
  const current = entries || await readTrashIndex(context);
  const now = Date.now();
  const expired = current.filter((entry) => new Date(entry.expiresAt).getTime() <= now);
  if (!expired.length) return current;
  await Promise.all(expired.map((entry) => store.delete('trash/records/' + entry.id)));
  const active = current.filter((entry) => new Date(entry.expiresAt).getTime() > now);
  await writeTrashIndex(context, active);
  return active;
}

async function moveRecordToTrash(
  context: Context,
  record: SalesRecord,
  records: SalesRecord[],
  deletedBy: string,
) {
  const store = salesStoreFor(context);
  const now = new Date();
  const entry: TrashEntry = {
    id: record.id,
    kind: record.kind as 'inquiry' | 'lead',
    customerName: cleanText(record.customer?.name, 180),
    customerEmail: cleanText(record.customer?.email, 240),
    eventDate: cleanText(record.customer?.eventDate, 40),
    packageId: normalizePackage(record.packageId || record.quote?.state?.startingPoint || record.inquiry?.venuePackage || record.inquiry?.mobileBarPackage),
    deletedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    deletedBy: cleanText(deletedBy, 240),
  };

  await store.setJSON('trash/records/' + record.id, record);
  const trash = await purgeExpiredTrash(context);
  await writeTrashIndex(context, [entry, ...trash.filter((item) => item.id !== entry.id)]);
  const next = records.filter((item) => item.id !== record.id);
  await store.delete('records/' + record.id);
  await writeSalesIndex(context, next);
  return { records: next, entry };
}

async function restoreTrashRecord(context: Context, recordId: string, records: SalesRecord[]) {
  const store = salesStoreFor(context);
  const trash = await purgeExpiredTrash(context);
  const entry = trash.find((item) => item.id === recordId);
  if (!entry) throw new Error('Trash record not found or has expired.');
  if (records.some((record) => record.id === recordId)) throw new Error('A live CRM record with this ID already exists.');

  const record = await store.get('trash/records/' + recordId, { type: 'json' }) as SalesRecord | null;
  if (!record) throw new Error('Trash record data is no longer available.');

  const next = [record, ...records].slice(0, 1500);
  await store.setJSON('records/' + record.id, record);
  await writeSalesIndex(context, next);
  await store.delete('trash/records/' + recordId);
  await writeTrashIndex(context, trash.filter((item) => item.id !== recordId));
  return { records: next, record };
}

async function permanentlyDeleteTrashRecord(context: Context, recordId: string) {
  const store = salesStoreFor(context);
  const trash = await purgeExpiredTrash(context);
  const exists = trash.some((item) => item.id === recordId);
  if (!exists) return false;
  await store.delete('trash/records/' + recordId);
  await writeTrashIndex(context, trash.filter((item) => item.id !== recordId));
  return true;
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
  const packageId = normalizePackage(record.packageId);
  const packageName = PACKAGE_NAMES[packageId] || 'Koa’s Events services';
  const isMobileBar = packageId.startsWith('mobile-');

  if (isMobileBar) {
    return [
      { heading: '1. Event & Service Scope', body: 'This Mobile Bar Services Agreement is between Koa’s Events / Koa’s Mobile Bar (“Koa’s”) and ' + (record.customer?.name || 'the Client') + '. The event is scheduled for ' + (record.customer?.eventDate || 'the date shown in the accepted proposal') + '. The accepted proposal controls the selected package, guest count, service hours, staffing, travel, add-ons, pricing, and other event-specific details.' },
      { heading: '2. Dry-Bar Alcohol Responsibility', body: 'Koa’s Mobile Bar operates as a dry-bar service. The Client is responsible for purchasing and supplying all alcoholic beverages. Koa’s may provide planning guidance and a shopping list based on the agreed menu and guest count, but the Client remains responsible for the alcohol purchase and availability.' },
      { heading: '3. Mobile Bar Access, Setup & Utilities', body: 'The Client is responsible for providing safe and reasonably level access for the mobile bar and adequate space for setup, service, and breakdown. Any venue restrictions, access limitations, utility requirements, parking instructions, or load-in rules must be disclosed before the event. Generator hookup or other service equipment will be used as described in the accepted proposal.' },
      { heading: '4. Staffing, Service Time & Guest Count', body: 'Bartender staffing, service duration, guest count, additional guests, additional service hours, gratuity structure, and any related charges are governed by the accepted proposal. Changes requested after proposal acceptance may require revised pricing and are subject to availability.' },
      { heading: '5. Travel & Location', body: 'Travel charges are based on the event location and the travel terms shown in the accepted proposal. The Client is responsible for providing an accurate event address and notifying Koa’s of location changes before the event.' },
      { heading: '6. Payments & Reservation', body: 'The finalized proposal total is $' + Number(proposal?.total || 0).toFixed(2) + ' for the ' + packageName + ' and finalized scope. Payment amounts and due dates are those shown in the accepted proposal and booking payment schedule. The event date is not reserved until the required agreement and reservation payment are completed.' },
      { heading: '7. Add-ons, Custom Items & Final Adjustments', body: 'Custom-priced enhancements, personalized items, glassware, beverage stations, decor, menu presentation, and other selected add-ons are subject to the specifications, lead times, and pricing shown in the final proposal. Any approved changes will be reflected in the CRM proposal and payment records.' },
      { heading: '8. Safety, Service & Client Cooperation', body: 'Koa’s may pause or stop service when reasonably necessary for guest safety, staff safety, venue compliance, or responsible beverage service. The Client agrees to cooperate with Koa’s staff and venue requirements and to prevent unauthorized self-service from the mobile bar.' },
      { heading: '9. Electronic Signature & Entire Agreement', body: 'The accepted proposal, this agreement, and any written amendments recorded by Koa’s form the agreement for the mobile bar services. By signing electronically, the Client confirms review of the scope and pricing and agrees that the recorded name, acknowledgement, and timestamp constitute the Client’s electronic signature.' },
    ];
  }

  return [
    { heading: '1. Event Details', body: 'This Event Venue Rental Agreement is between Koa’s Events, 11-3330 Hibiscus St, Mountain View, HI 96771 (“Lessor” or “Koa’s”) and ' + (record.customer?.name || 'the Client') + ' (“Lessee”). The event is scheduled for ' + (record.customer?.eventDate || 'the date shown in the accepted proposal') + '. The accepted proposal and finalized event plan supply the event type, rental period, package, quantities, and other event-specific details.' },
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
        title: normalizePackage(record.packageId).startsWith('mobile-') ? 'Koa’s Mobile Bar Services Agreement' : 'Koa’s Events Venue & Services Agreement',
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

function relatedRecordIds(record: SalesRecord, records: SalesRecord[]) {
  const ids = new Set<string>([record.id]);
  if (record.quoteId) {
    records.filter((entry) => entry.quoteId === record.quoteId).forEach((entry) => ids.add(entry.id));
  }
  let changed = true;
  while (changed) {
    changed = false;
    records.forEach((entry) => {
      if ((entry.source && ids.has(entry.source)) || (record.source && entry.id === record.source)) {
        if (!ids.has(entry.id)) { ids.add(entry.id); changed = true; }
        if (entry.source && !ids.has(entry.source)) { ids.add(entry.source); changed = true; }
      }
    });
  }
  return ids;
}

function timelineForRecord(record: SalesRecord, records: SalesRecord[], events: any[]) {
  const ids = relatedRecordIds(record, records);
  const quoteId = record.quoteId || '';
  return events
    .filter((event) =>
      (quoteId && event.quoteId === quoteId) ||
      ids.has(String(event.recordId || '')) ||
      ids.has(String(event.sourceRecordId || ''))
    )
    .map((event) => ({
      id: event.id || '',
      type: event.type || 'activity',
      createdAt: event.createdAt || '',
      detail: event.detail || '',
      recordId: event.recordId || '',
      quoteId: event.quoteId || '',
      amount: Number(event.amount || 0),
      reference: event.reference || '',
    }))
    .sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0,150);
}

function hoursSince(value?: string) {
  if (!value) return 0;
  return Math.max(0, (Date.now() - new Date(value).getTime()) / 3600000);
}

function daysUntil(value?: string) {
  if (!value) return null;
  const due = new Date(value + 'T23:59:59Z').getTime();
  if (Number.isNaN(due)) return null;
  return Math.ceil((due - Date.now()) / 86400000);
}

function quickBooksInvoiceMap(record: SalesRecord) {
  const rows = (record as any)?.accounting?.quickbooks?.invoices;
  return Array.isArray(rows) ? rows : [];
}

function remindersForRecord(record: SalesRecord) {
  const reminders: Array<{id:string;priority:number;type:string;title:string;detail:string;due:string}> = [];
  const ageHours = hoursSince(record.updatedAt || record.createdAt);
  const proposalStatus = record.proposal?.status || record.status;

  if (record.stage === 'inquiry' && ageHours >= 24) {
    reminders.push({ id:record.id+'-inquiry', priority:2, type:'follow_up', title:'New inquiry needs response', detail:'Inquiry has been open for '+Math.floor(ageHours/24)+' day(s).', due:'now' });
  }
  if (record.stage === 'lead' && ageHours >= 48) {
    reminders.push({ id:record.id+'-lead', priority:5, type:'follow_up', title:'Lead follow-up due', detail:'Qualified lead has had no CRM update for '+Math.floor(ageHours/24)+' day(s).', due:'now' });
  }
  if (record.kind === 'proposal' && proposalStatus === 'draft' && ageHours >= 24) {
    reminders.push({ id:record.id+'-draft', priority:4, type:'proposal', title:'Finalize draft proposal', detail:'Draft has been open for more than 24 hours.', due:'now' });
  }
  if (record.kind === 'proposal' && proposalStatus === 'sent' && ageHours >= 72) {
    reminders.push({ id:record.id+'-sent', priority:6, type:'proposal', title:'Proposal follow-up due', detail:'Proposal was sent more than 3 days ago and has not been viewed.', due:'now' });
  }
  if (record.kind === 'proposal' && proposalStatus === 'viewed' && ageHours >= 48) {
    reminders.push({ id:record.id+'-viewed', priority:3, type:'proposal', title:'Viewed proposal needs follow-up', detail:'Client viewed the proposal more than 2 days ago.', due:'now' });
  }

  if (record.kind === 'proposal' && proposalStatus === 'accepted') {
    const booking = record.booking;
    if (!booking?.contract || booking.contract.status !== 'signed') {
      reminders.push({ id:record.id+'-contract', priority:1, type:'contract', title:'Client signature pending', detail:'Proposal is accepted; send or follow up on the booking agreement.', due:'now' });
    } else if (!booking.contract.koaSignature) {
      reminders.push({ id:record.id+'-countersign', priority:1, type:'contract', title:'Koa countersignature pending', detail:'Client signed the agreement. Koa’s must countersign before the agreement is fully executed.', due:'now' });
    }
  }

  if (record.kind === 'proposal' && ['accepted','booked'].includes(proposalStatus)) {
    const schedule = record.booking?.payments?.length
      ? record.booking.payments
      : (record.proposal?.paymentSchedule || []).map((item:any,index:number)=>({ id:'pay-'+(index+1), ...item }));
    const invoices = quickBooksInvoiceMap(record);

    schedule.forEach((payment:any,index:number) => {
      const invoice = invoices.find((row:any) => row.paymentId === payment.id);
      const isDeposit = /deposit/i.test(payment.label || '') || index === 0;
      const days = daysUntil(payment.dueDate);

      if (!invoice?.invoiceId) {
        if (isDeposit && proposalStatus === 'accepted' && record.booking?.contract?.status === 'signed' && record.booking?.contract?.koaSignature) {
          reminders.push({ id:record.id+'-'+payment.id+'-invoice', priority:1, type:'payment', title:'Create QuickBooks deposit invoice', detail:'The agreement is fully signed; issue the reservation-deposit invoice in QuickBooks.', due:payment.dueDate || 'now' });
        } else if (days != null && days <= 14) {
          reminders.push({ id:record.id+'-'+payment.id+'-invoice', priority:days < 0 ? 0 : 7, type:'payment', title:days < 0 ? 'QuickBooks invoice overdue to issue' : 'Create QuickBooks invoice', detail:payment.label+' is '+(days < 0 ? Math.abs(days)+' day(s) past its due date.' : 'due in '+days+' day(s).'), due:payment.dueDate || 'now' });
        }
        return;
      }

      const balance = Number(invoice.balance ?? invoice.amount ?? payment.amount ?? 0);
      if (balance <= 0) return;
      if (isDeposit || (days != null && days <= 14)) {
        reminders.push({
          id:record.id+'-'+payment.id+'-balance',
          priority:days != null && days < 0 ? 0 : isDeposit ? 1 : 7,
          type:'payment',
          title:days != null && days < 0 ? payment.label+' overdue in QuickBooks' : payment.label+' unpaid in QuickBooks',
          detail:'QuickBooks invoice '+(invoice.docNumber || invoice.invoiceId)+' has '+Number(balance).toFixed(2)+' remaining.'+(days != null ? ' Due '+payment.dueDate+'.' : ''),
          due:payment.dueDate || 'now',
        });
      }
    });
  }

  return reminders.sort((a,b) => a.priority-b.priority);
}

function bookingSummary(record: SalesRecord) {
  if (!record.proposal || !['accepted','booked'].includes(record.proposal.status)) return null;
  const booking = record.booking;
  const invoices = quickBooksInvoiceMap(record);
  const schedule = booking?.payments?.length
    ? booking.payments
    : record.proposal.paymentSchedule.map((item,index) => ({ id:'pay-'+(index+1), ...item }));

  const payments = schedule.map((item:any,index:number) => {
    const invoice = invoices.find((row:any) => row.paymentId === item.id);
    const balance = invoice?.invoiceId ? Number(invoice.balance ?? invoice.amount ?? item.amount ?? 0) : Number(item.amount || 0);
    return {
      id: item.id || 'pay-'+(index+1),
      label: item.label,
      dueDate: item.dueDate,
      amount: Number(item.amount || 0),
      status: !invoice?.invoiceId ? 'not_invoiced' : balance <= 0 ? 'paid' : 'open',
      invoiceId: invoice?.invoiceId || '',
      docNumber: invoice?.docNumber || '',
      balance,
      emailStatus: invoice?.emailStatus || '',
      lastSyncedAt: invoice?.lastSyncedAt || '',
    };
  });

  const paid = payments.reduce((sum:number,item:any) => {
    if (!item.invoiceId) return sum;
    return sum + Math.max(0, Number(item.amount || 0) - Number(item.balance || 0));
  }, 0);

  return {
    status: booking?.status || 'contract_pending',
    contractStatus: booking?.contract?.status || 'pending',
    signedAt: booking?.contract?.signature?.signedAt || '',
    koaSignedAt: booking?.contract?.koaSignature?.signedAt || '',
    koaSigner: booking?.contract?.koaSignature?.name || '',
    payments,
    paid,
    outstanding: Math.max(0, Number(record.proposal.total || 0)-paid),
    bookingUrl: record.proposal.publicToken ? '/booking/?token='+record.proposal.publicToken : '',
    quickbooks: (record as any)?.accounting?.quickbooks || null,
  };
}

function proposalFromQuote(quote: SavedQuote | null, eventDate = '', packageId = '', inquiry?: Record<string, unknown>) {
  const lines: ProposalLine[] = [];
  const state = quote?.state || {};
  const normalizedPackage = normalizePackage(state.startingPoint || packageId);
  const inquiryLines = Array.isArray((inquiry as any)?.estimateLineItems) ? (inquiry as any).estimateLineItems : [];
  const mobileEstimate = finite((inquiry as any)?.estimatedTotal || 0);
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

  if (!quote && inquiryLines.length) {
    lines.length = 0;
    inquiryLines.slice(0, 50).forEach((item: any, index: number) => {
      const quantity = Math.max(1, Math.round(finite(item?.quantity, 1, 2000)));
      const unitPrice = finite(item?.unitPrice);
      const amount = finite(item?.amount || quantity * unitPrice);
      const description = cleanText(item?.description, 240);
      if (!description) return;
      lines.push({
        id: cleanText(item?.id || 'mobile-line-' + (index + 1), 80),
        description,
        quantity,
        unitPrice: amount > 0 ? unitPrice || amount / quantity : 0,
        amount,
        custom: Boolean(item?.custom) || amount <= 0,
      });
    });
  }

  if (!quote && !lines.length && mobileEstimate > 0) {
    lines.push({
      id: 'mobile-estimate',
      description: PACKAGE_NAMES[normalizedPackage] || 'Koa’s Mobile Bar estimated service',
      quantity: 1,
      unitPrice: mobileEstimate,
      amount: mobileEstimate,
      custom: false,
    });
  }

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
  const ids = ['gardenia','orchid','hibiscus','signature-wedding','mobile-oahu','mobile-maui','mobile-big-island','mobile-custom'];
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


function mobileBarAnalytics(records: SalesRecord[]) {
  const mobile = records.filter((record: any) => {
    const packageId = normalizePackage(record.packageId || record.quote?.state?.startingPoint || record.inquiry?.venuePackage || record.inquiry?.mobileBarPackage);
    return packageId.startsWith('mobile-') || record.inquiry?.service === 'mobile-bar';
  });
  const active = mobile.filter((record) => !['converted','lost'].includes(record.stage));
  const inquiries = mobile.filter((record) => record.kind === 'inquiry');
  const leads = mobile.filter((record) => record.kind === 'lead');
  const proposals = mobile.filter((record) => record.kind === 'proposal');
  const booked = mobile.filter((record) => record.stage === 'booked');

  const valueFor = (record: any) => {
    const proposalTotal = finite(record.proposal?.total);
    const websiteEstimate = finite(record.inquiry?.estimatedTotal);
    const base = PACKAGE_PRICES[normalizePackage(record.packageId || record.inquiry?.mobileBarPackage)] || 0;
    return proposalTotal || websiteEstimate || base;
  };
  const bartendersFor = (record: any) => {
    const selected = Math.round(finite(record.inquiry?.bartenderCount));
    if (selected > 0) return selected;
    const guests = Math.max(1, Math.round(finite(record.inquiry?.guestCount)));
    return Math.max(1, Math.ceil(guests / 75));
  };
  const hoursFor = (record: any) => {
    const selected = finite(record.inquiry?.serviceHours);
    return selected > 0 ? selected : 4;
  };
  const weightFor = (record: any) => {
    if (record.stage === 'booked') return 1;
    if (record.kind === 'proposal') {
      const status = record.proposal?.status || record.status;
      if (status === 'accepted') return .95;
      if (status === 'viewed') return .75;
      if (status === 'sent') return .65;
      if (status === 'draft') return .50;
      return .45;
    }
    if (record.stage === 'lead') return .30;
    return .15;
  };
  const rate = (numerator: number, denominator: number) => denominator ? Math.min(1, numerator / denominator) : null;

  const today = new Date();
  const todayKey = today.toISOString().slice(0,10);
  const monthKeys = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + index, 1));
    return date.toISOString().slice(0,7);
  });

  const monthlyForecast = monthKeys.map((month) => {
    const rows = active.filter((record: any) => String(record.customer?.eventDate || '').slice(0,7) === month);
    const bookedRevenue = rows.filter((record) => record.stage === 'booked').reduce((sum, record) => sum + valueFor(record), 0);
    const weightedPipeline = rows.filter((record) => record.stage !== 'booked').reduce((sum, record) => sum + valueFor(record) * weightFor(record), 0);
    const grossPipeline = rows.reduce((sum, record) => sum + valueFor(record), 0);
    const bartenderShifts = rows.reduce((sum, record) => sum + bartendersFor(record), 0);
    const bartenderHours = rows.reduce((sum, record) => sum + bartendersFor(record) * hoursFor(record), 0);
    return {
      month,
      eventCount: rows.length,
      bookedRevenue: Math.round(bookedRevenue * 100) / 100,
      weightedPipeline: Math.round(weightedPipeline * 100) / 100,
      forecastRevenue: Math.round((bookedRevenue + weightedPipeline) * 100) / 100,
      grossPipeline: Math.round(grossPipeline * 100) / 100,
      bartenderShifts,
      bartenderHours: Math.round(bartenderHours * 10) / 10,
    };
  });

  const packageIds = ['mobile-oahu','mobile-maui','mobile-big-island','mobile-custom'];
  const packagePopularity = packageIds.map((packageId) => ({
    packageId,
    inquiries: inquiries.filter((record: any) => normalizePackage(record.packageId || record.inquiry?.mobileBarPackage) === packageId).length,
    active: active.filter((record: any) => normalizePackage(record.packageId || record.inquiry?.mobileBarPackage) === packageId).length,
    booked: booked.filter((record: any) => normalizePackage(record.packageId || record.inquiry?.mobileBarPackage) === packageId).length,
  })).sort((a,b) => b.inquiries - a.inquiries || b.active - a.active);

  const sourceCounts = new Map<string, number>();
  inquiries.forEach((record: any) => {
    const source = cleanText(record.inquiry?.referralSource || record.inquiry?.source || 'Direct / unknown', 120) || 'Direct / unknown';
    sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
  });
  const leadSources = [...sourceCounts.entries()]
    .map(([source,count]) => ({ source,count }))
    .sort((a,b) => b.count-a.count || a.source.localeCompare(b.source))
    .slice(0,12);

  const upcomingEvents = active
    .filter((record: any) => String(record.customer?.eventDate || '') >= todayKey)
    .sort((a:any,b:any) => String(a.customer?.eventDate || '').localeCompare(String(b.customer?.eventDate || '')))
    .slice(0,20)
    .map((record: any) => ({
      id: record.id,
      eventDate: record.customer?.eventDate || '',
      customerName: record.customer?.name || 'Client name TBD',
      packageId: normalizePackage(record.packageId || record.inquiry?.mobileBarPackage),
      stage: record.stage,
      quoteStatus: record.proposal?.status || (record.inquiry?.estimatedTotal ? 'website-estimate' : record.status),
      value: Math.round(valueFor(record) * 100) / 100,
      bartenders: bartendersFor(record),
      serviceHours: hoursFor(record),
      guestCount: Math.round(finite(record.inquiry?.guestCount)),
      eventLocation: cleanText(record.inquiry?.eventLocation, 320),
    }));

  const bookedValues = booked.map(valueFor).filter((value) => value > 0);
  return {
    counts: {
      inquiries: inquiries.length,
      leads: leads.length,
      proposals: proposals.length,
      booked: booked.length,
      active: active.length,
    },
    conversions: {
      inquiryToLead: rate(leads.length, inquiries.length),
      leadToProposal: rate(proposals.length, leads.length),
      proposalToBooked: rate(booked.length, proposals.length),
      inquiryToBooked: rate(booked.length, inquiries.length),
    },
    averageBookingValue: bookedValues.length
      ? Math.round((bookedValues.reduce((sum,value) => sum + value, 0) / bookedValues.length) * 100) / 100
      : 0,
    bookedRevenue: Math.round(bookedValues.reduce((sum,value) => sum + value, 0) * 100) / 100,
    monthlyForecast,
    packagePopularity,
    leadSources,
    upcomingEvents,
  };
}

export default async (req: Request, context: Context) => {
  const auth = await requireAdmin();
  if (auth.response) return auth.response;

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const q = cleanText(url.searchParams.get('q'), 120).toLowerCase();
    const [allQuotes, records, events, trashRaw] = await Promise.all([listQuotes(context), readSalesIndex(context), readEvents(context), readTrashIndex(context)]);
    const trash = await purgeExpiredTrash(context, trashRaw);

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

    const enrichedRecords = filteredRecords.slice(0, 500).map((record) => ({
      ...record,
      timeline: timelineForRecord(record, records, events),
      reminders: remindersForRecord(record),
      bookingSummary: bookingSummary(record),
    }));

    const reminders = enrichedRecords
      .flatMap((record: any) => (record.reminders || []).map((reminder: any) => ({
        ...reminder,
        recordId: record.id,
        customerName: record.customer?.name || 'Client name TBD',
        eventDate: record.customer?.eventDate || '',
        stage: record.stage,
      })))
      .sort((a: any, b: any) => a.priority - b.priority || String(a.due).localeCompare(String(b.due)));

    return Response.json({
      quotes: filteredQuotes.slice(0, 300),
      analytics: quoteAnalytics(allQuotes),
      funnel: funnelAnalytics(events, records),
      mobileBarAnalytics: mobileBarAnalytics(records),
      conversions,
      reminders,
      records: enrichedRecords,
      trash,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const payload: any = await req.json().catch(() => null);
  if (!payload?.action) return Response.json({ error: 'Missing action.' }, { status: 400 });

  let records = await readSalesIndex(context);

  if (payload.action === 'delete-record') {
    const recordId = cleanText(payload.recordId, 80);
    const record = records.find((entry) => entry.id === recordId);
    if (!record) return Response.json({ error: 'CRM record not found.' }, { status: 404 });

    if (!['inquiry', 'lead'].includes(record.kind) || ['proposal', 'booked'].includes(record.stage)) {
      return Response.json({
        error: 'Only inquiry and lead records can be moved to Trash. Proposals and booked records are protected.',
      }, { status: 400 });
    }

    const downstream = records.filter((entry) => entry.source === record.id);
    if (downstream.length) {
      return Response.json({
        error: 'This record has a downstream ' + downstream.map((entry) => entry.kind).join(', ') + ' record. Trash is blocked to protect the CRM history.',
      }, { status: 409 });
    }

    const moved = await moveRecordToTrash(context, record, records, cleanText(auth.user?.email, 240));
    records = moved.records;
    await appendEvent(context, {
      type: 'record_trashed',
      recordId: record.id,
      quoteId: record.quoteId || '',
      packageId: record.packageId || '',
      detail: 'Administrator moved a ' + record.kind + ' record to Trash for 30 days.',
    });

    return Response.json({
      ok: true,
      deletedId: record.id,
      kind: record.kind,
      trash: moved.entry,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  if (payload.action === 'restore-record') {
    const recordId = cleanText(payload.recordId, 80);
    try {
      const restored = await restoreTrashRecord(context, recordId, records);
      records = restored.records;
      await appendEvent(context, {
        type: 'record_restored',
        recordId: restored.record.id,
        quoteId: restored.record.quoteId || '',
        packageId: restored.record.packageId || '',
        detail: 'Administrator restored a CRM record from Trash.',
      });
      return Response.json({ ok: true, record: restored.record }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Unable to restore CRM record.' }, { status: 400 });
    }
  }

  if (payload.action === 'permanent-delete-record') {
    const recordId = cleanText(payload.recordId, 80);
    const removed = await permanentlyDeleteTrashRecord(context, recordId);
    if (!removed) return Response.json({ error: 'Trash record not found.' }, { status: 404 });
    await appendEvent(context, {
      type: 'record_permanently_deleted',
      recordId,
      detail: 'Administrator permanently deleted a CRM record from Trash.',
    });
    return Response.json({ ok: true, deletedId: recordId }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  if (payload.action === 'delete-quote') {
    const quoteId = cleanText(payload.quoteId, 24).toUpperCase();
    if (!/^[2-9A-HJ-NP-Z]{16}$/.test(quoteId)) return Response.json({ error: 'Valid quote ID required.' }, { status: 400 });
    const quote = await getQuote(context, quoteId);
    if (!quote) return Response.json({ error: 'Saved quote not found.' }, { status: 404 });

    const protectedRecords = records.filter((record) =>
      record.quoteId === quoteId && (record.kind === 'proposal' || record.stage === 'booked')
    );
    if (protectedRecords.length) {
      return Response.json({
        error: 'This saved quote is attached to a proposal or booked record and is protected from deletion.',
      }, { status: 409 });
    }

    await quoteStoreFor(context).delete('quotes/' + quoteId);
    await appendEvent(context, {
      type: 'quote_deleted',
      quoteId,
      detail: 'Administrator permanently deleted a saved quote snapshot.',
    });
    return Response.json({ ok: true, deletedQuoteId: quoteId }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  if (payload.action === 'bulk-trash') {
    const ids = Array.from(new Set((Array.isArray(payload.recordIds) ? payload.recordIds : [])
      .map((value: unknown) => cleanText(value, 80))
      .filter(Boolean))).slice(0, 100);
    if (!ids.length) return Response.json({ error: 'Select at least one inquiry or lead.' }, { status: 400 });

    const moved: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const id of ids) {
      const record = records.find((entry) => entry.id === id);
      if (!record) { skipped.push({ id, reason: 'Record not found.' }); continue; }
      if (!['inquiry', 'lead'].includes(record.kind) || ['proposal', 'booked'].includes(record.stage)) {
        skipped.push({ id, reason: 'Only inquiry and lead records can be moved to Trash.' });
        continue;
      }
      if (records.some((entry) => entry.source === record.id)) {
        skipped.push({ id, reason: 'Downstream CRM record exists.' });
        continue;
      }
      const result = await moveRecordToTrash(context, record, records, cleanText(auth.user?.email, 240));
      records = result.records;
      moved.push(id);
    }

    for (const id of moved) {
      await appendEvent(context, { type: 'record_trashed', recordId: id, detail: 'Administrator bulk-moved CRM record to Trash for 30 days.' });
    }
    return Response.json({ ok: true, moved, skipped }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  if (payload.action === 'bulk-lost') {
    const ids = Array.from(new Set((Array.isArray(payload.recordIds) ? payload.recordIds : [])
      .map((value: unknown) => cleanText(value, 80))
      .filter(Boolean))).slice(0, 100);
    if (!ids.length) return Response.json({ error: 'Select at least one inquiry or lead.' }, { status: 400 });

    const updated: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const id of ids) {
      const record = records.find((entry) => entry.id === id);
      if (!record) { skipped.push({ id, reason: 'Record not found.' }); continue; }
      if (!['inquiry', 'lead'].includes(record.kind) || ['proposal', 'booked'].includes(record.stage)) {
        skipped.push({ id, reason: 'Only inquiry and lead records can be marked lost in bulk.' });
        continue;
      }
      record.stage = 'lost';
      record.status = 'lost';
      record.updatedAt = new Date().toISOString();
      records = await saveRecord(context, record, records);
      updated.push(id);
    }

    for (const id of updated) {
      await appendEvent(context, { type: 'stage_changed', recordId: id, detail: 'Administrator bulk-marked CRM record as lost.' });
    }
    return Response.json({ ok: true, updated, skipped }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

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
    const packageId = normalizePackage(source.packageId || quote?.state?.startingPoint || source.inquiry?.venuePackage || source.inquiry?.mobileBarPackage);
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
      security: source.security ? {
        disposition: source.security.disposition,
        riskScore: Number(source.security.riskScore || 0),
        reasons: Array.isArray(source.security.reasons) ? [...source.security.reasons] : [],
        reasonCodes: Array.isArray(source.security.reasonCodes) ? [...source.security.reasonCodes] : [],
      } : undefined,
      communications: source.communications ? Object.fromEntries(
        Object.entries(source.communications).map(([key, value]) => [key, { ...(value as any) }])
      ) : undefined,
      inquiry: source.inquiry ? { ...source.inquiry } : undefined,
      quote: quote || undefined,
      proposal: kind === 'proposal' ? proposalFromQuote(quote, source.customer?.eventDate || '', packageId, source.inquiry) : undefined,
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

  if (payload.action === 'log-activity') {
    const record = records.find((entry) => entry.id === cleanText(payload.recordId, 80));
    const allowed = new Set(['call', 'email', 'note', 'meeting', 'responded']);
    const type = cleanText(payload.type, 30);
    if (!record || !allowed.has(type)) return Response.json({ error: 'Record or activity type not found.' }, { status: 400 });

    const detail = cleanText(payload.detail, 2000);
    await appendEvent(context, {
      type,
      recordId: record.id,
      quoteId: record.quoteId || '',
      packageId: record.packageId || '',
      detail,
    });
    record.updatedAt = new Date().toISOString();
    records = await saveRecord(context, record, records);
    return Response.json({ ok: true, record });
  }

  if (payload.action === 'countersign-contract') {
    const record = records.find((entry) => entry.id === cleanText(payload.recordId, 80) && entry.kind === 'proposal');
    if (!record || !record.proposal || !['accepted', 'booked'].includes(record.proposal.status)) {
      return Response.json({ error: 'Accepted proposal not found.' }, { status: 404 });
    }

    const booking = ensureBooking(record);
    if (!booking || booking.contract.status !== 'signed') {
      return Response.json({ error: 'Client signature must be recorded before Koa’s countersigns.' }, { status: 400 });
    }

    const name = cleanText(payload.name, 180);
    if (name.length < 2) return Response.json({ error: 'Enter the Koa’s signer name.' }, { status: 400 });

    const now = new Date().toISOString();
    booking.contract.koaSignature = { name, signedAt: now };
    booking.updatedAt = now;

    const deposit = booking.payments.find((item) => /deposit/i.test(item.label)) || booking.payments[0];
    if (deposit?.status === 'paid') {
      booking.status = 'booked';
      record.stage = 'booked';
      record.status = 'booked';
      record.proposal.status = 'booked';
    }

    record.updatedAt = now;
    records = await saveRecord(context, record, records);
    await appendEvent(context, {
      type: 'contract_countersigned',
      recordId: record.id,
      quoteId: record.quoteId || '',
      packageId: record.packageId || '',
      detail: 'Agreement countersigned for Koa’s Events by ' + name,
    });
    if (record.stage === 'booked') {
      await appendEvent(context, {
        type: 'booked',
        recordId: record.id,
        quoteId: record.quoteId || '',
        packageId: record.packageId || '',
        detail: 'Agreement fully executed and reservation deposit received.',
      });
    }

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