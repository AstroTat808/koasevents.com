import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { hasCapability, isApprovedManager, requireCapability } from './_shared/admin';
import { appendCleanupAudit, cleanupClientSnapshotFromRecord, cleanupDimensionsFromRecord } from './_shared/crm-cleanup-audit';
import { assignmentFor, listOperationalStaff, type OperationalStaff } from './_shared/staff-directory';
import { appendStaffAudit } from './_shared/staff-audit';
import { getQuickBooksDepositSettings, type QuickBooksDepositSettings } from './_shared/quickbooks';

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
  catalogItemId?: string;
  quickBooksItemId?: string;
  category?: 'service' | 'rental' | 'mileage' | 'fee';
  unitLabel?: string;
  getExempt?: boolean;
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

type ProfitModel = {
  costMode: 'auto' | 'manual';
  bartenderWageRate: number;
  iceCost: number;
  mixersCost: number;
  garnishesCost: number;
  cupsCost: number;
  suppliesCost: number;
  travelCost: number;
  addOnCost: number;
  gratuityCost: number;
  otherDirectCosts: number;
  notes: string;
  updatedAt: string;
};
type MobileBarProfitSettings = {
  monthlyGrossProfitTarget: number;
  updatedAt: string;
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
    depositPercent: number;
    depositAmount: number;
    paymentSchedule: PaymentItem[];
    paymentRuleDecision?: {
      ruleId: string;
      ruleName: string;
      presetId: string;
      presetName: string;
      priority: number;
      category: string;
      leadDays: number | null;
      contractValueBasis: 'beforeGet' | 'afterGet';
      contractValue: number;
      beforeGetValue: number;
      afterGetValue: number;
      matchedRuleIds: string[];
      matchedRuleNames: string[];
      explanation: string[];
      decidedAt: string;
    } | null;
    notesToClient: string;
    acceptance?: { name: string; acceptedAt: string };
  };
  booking?: BookingState;
  profitModel?: ProfitModel;
  assignment?: {
    userId: string;
    email: string;
    name: string;
    assignedAt: string;
    assignedBy: string;
  };
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
  'mobile-oahu': 1500,
  'mobile-maui': 2000,
  'mobile-big-island': 2500,
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
async function readMobileBarProfitSettings(context: Context): Promise<MobileBarProfitSettings> {
  const saved = await salesStoreFor(context).get('settings/mobile-bar-profitability', { type: 'json' }) as MobileBarProfitSettings | null;
  return {
    monthlyGrossProfitTarget: finite(saved?.monthlyGrossProfitTarget ?? 0, 0, 1_000_000),
    updatedAt: cleanText(saved?.updatedAt || '', 60),
  };
}

async function writeMobileBarProfitSettings(context: Context, input: any): Promise<MobileBarProfitSettings> {
  const settings: MobileBarProfitSettings = {
    monthlyGrossProfitTarget: finite(input?.monthlyGrossProfitTarget ?? 0, 0, 1_000_000),
    updatedAt: new Date().toISOString(),
  };
  await salesStoreFor(context).setJSON('settings/mobile-bar-profitability', settings);
  return settings;
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

async function trashChainFromStoredRecords(context: Context, recordId: string) {
  const store = salesStoreFor(context);
  const trash = await purgeExpiredTrash(context);
  const rows = await Promise.all(trash.map(async (entry) => ({
    entry,
    record: await store.get('trash/records/' + entry.id, { type: 'json' }) as SalesRecord | null,
  })));
  const root = rows.find((row) => row.entry.id === recordId && row.record)?.record;
  if (!root) return { trash, rows, ids: new Set<string>() };

  const ids = new Set<string>([root.id]);
  if (root.quoteId) rows.filter((row) => row.record?.quoteId === root.quoteId).forEach((row) => ids.add(row.entry.id));

  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const record = row.record;
      if (!record) continue;
      if ((record.source && ids.has(record.source)) || (root.source && record.id === root.source)) {
        if (!ids.has(record.id)) { ids.add(record.id); changed = true; }
        if (record.source && !ids.has(record.source)) { ids.add(record.source); changed = true; }
      }
    }
  }

  return { trash, rows, ids };
}

async function restoreTrashClientChain(context: Context, recordId: string, records: SalesRecord[]) {
  const store = salesStoreFor(context);
  const chain = await trashChainFromStoredRecords(context, recordId);
  if (!chain.ids.size) throw new Error('Trash client chain not found or has expired.');

  const restoring = chain.rows
    .filter((row) => row.record && chain.ids.has(row.entry.id))
    .map((row) => row.record as SalesRecord);

  if (restoring.some((record) => records.some((live) => live.id === record.id))) {
    throw new Error('One or more CRM records in this client chain already exist.');
  }

  let next = records;
  for (const record of restoring) {
    await store.setJSON('records/' + record.id, record);
    next = [record, ...next.filter((item) => item.id !== record.id)].slice(0, 1500);
  }
  await writeSalesIndex(context, next);

  for (const id of chain.ids) await store.delete('trash/records/' + id);
  await writeTrashIndex(context, chain.trash.filter((entry) => !chain.ids.has(entry.id)));
  return { records: next, restored: restoring };
}

async function permanentlyDeleteTrashClientChain(context: Context, recordId: string) {
  const store = salesStoreFor(context);
  const chain = await trashChainFromStoredRecords(context, recordId);
  if (!chain.ids.size) return [] as string[];
  for (const id of chain.ids) await store.delete('trash/records/' + id);
  await writeTrashIndex(context, chain.trash.filter((entry) => !chain.ids.has(entry.id)));
  return [...chain.ids];
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
  const quickbooks = (record as any)?.accounting?.quickbooks || null;
  const invoices = quickBooksInvoiceMap(record);
  const schedule = booking?.payments?.length
    ? booking.payments
    : record.proposal.paymentSchedule.map((item,index) => ({ id:'pay-'+(index+1), ...item }));

  const payments = schedule.map((item:any,index:number) => {
    const invoice = invoices.find((row:any) => row.paymentId === item.id);
    const activeInvoice = invoice?.invoiceId && !['void','deleted'].includes(String(invoice?.status || '').toLowerCase());
    const balance = activeInvoice ? Number(invoice.balance ?? invoice.amount ?? item.amount ?? 0) : Number(item.amount || 0);
    return {
      id: item.id || 'pay-'+(index+1),
      label: item.label,
      dueDate: item.dueDate,
      amount: Number(item.amount || 0),
      status: !activeInvoice ? 'not_invoiced' : balance <= 0 ? 'paid' : 'open',
      invoiceId: activeInvoice ? (invoice?.invoiceId || '') : '',
      docNumber: activeInvoice ? (invoice?.docNumber || '') : '',
      balance,
      emailStatus: activeInvoice ? (invoice?.emailStatus || '') : '',
      paidAt: activeInvoice ? (invoice?.paidAt || '') : '',
      lastSyncedAt: activeInvoice ? (invoice?.lastSyncedAt || '') : '',
    };
  });

  const paid = payments.reduce((sum:number,item:any) => {
    if (!item.invoiceId) return sum;
    return sum + Math.max(0, Number(item.amount || 0) - Number(item.balance || 0));
  }, 0);
  const outstanding = Math.max(0, Number(record.proposal.total || 0)-paid);
  const qboBalanceDue = quickbooks?.balanceDue != null
    ? Math.max(0, Number(quickbooks.balanceDue || 0))
    : payments.filter((item:any)=>item.invoiceId).reduce((sum:number,item:any)=>sum+Math.max(0,Number(item.balance||0)),0);
  const hasInvoices = payments.some((item:any)=>Boolean(item.invoiceId));
  const depositPaid = Boolean(quickbooks?.depositPaid || payments[0]?.status === 'paid');

  let paymentStatus = 'Balance Due';
  if (outstanding <= 0 && Number(record.proposal.total || 0) > 0) paymentStatus = 'Paid in Full';
  else if (paid > 0 && qboBalanceDue > 0) paymentStatus = 'Partially Paid';
  else if (paid > 0 && qboBalanceDue <= 0) paymentStatus = 'Paid';
  else if (!hasInvoices && outstanding > 0) paymentStatus = 'Balance Due';

  return {
    status: booking?.status || 'contract_pending',
    contractStatus: booking?.contract?.status || 'pending',
    signedAt: booking?.contract?.signature?.signedAt || '',
    koaSignedAt: booking?.contract?.koaSignature?.signedAt || '',
    koaSigner: booking?.contract?.koaSignature?.name || '',
    subtotal: Number(record.proposal.subtotal || 0),
    discountAmount: Number(record.proposal.discountAmount || 0),
    taxRate: 4.712,
    taxAmount: Number(record.proposal.taxAmount || 0),
    total: Number(record.proposal.total || 0),
    depositAmount: Number(record.proposal.depositAmount || 0),
    payments,
    paid,
    paymentsReceived: paid,
    outstanding,
    remainingBalance: outstanding,
    qboBalanceDue,
    hasInvoices,
    depositPaid,
    paymentStatus,
    bookingUrl: record.proposal.publicToken ? '/booking/?token='+record.proposal.publicToken : '',
    quickbooks,
  };
}

function proposalCategory(packageId = '', inquiry?: Record<string, unknown>) {
  const normalizedPackage = normalizePackage(packageId);
  const eventType = cleanText((inquiry as any)?.eventType, 120).toLowerCase();
  const service = cleanText((inquiry as any)?.service, 80).toLowerCase();
  if (normalizedPackage.startsWith('mobile-') || service.includes('mobile bar')) return 'mobile-bar';
  if (['gardenia','orchid','hibiscus','signature-wedding'].includes(normalizedPackage) || eventType.includes('wedding')) return 'venue-wedding';
  if (eventType || service) return 'private-event';
  return 'default';
}

function paymentCategoryKey(packageId = '', inquiry?: Record<string, unknown>) {
  const category = proposalCategory(packageId, inquiry);
  if (category === 'venue-wedding') return 'venueWedding';
  if (category === 'mobile-bar') return 'mobileBar';
  if (category === 'private-event') return 'privateEvent';
  return 'default';
}

function builtInPaymentPreset(id: string) {
  const presets: Record<string, { id:string; name:string; category:string; depositPercent:number; milestones:Array<{label:string;dueDaysBefore:number;percentOfRemaining:number}> }> = {
    'builtin-standard-wedding': {
      id:'builtin-standard-wedding', name:'Standard Wedding', category:'venueWedding', depositPercent:10,
      milestones:[{label:'Second payment',dueDaysBefore:90,percentOfRemaining:50},{label:'Final payment',dueDaysBefore:60,percentOfRemaining:100}],
    },
    'builtin-extended-wedding': {
      id:'builtin-extended-wedding', name:'Extended Wedding', category:'venueWedding', depositPercent:10,
      milestones:[{label:'120-day payment',dueDaysBefore:120,percentOfRemaining:25},{label:'90-day payment',dueDaysBefore:90,percentOfRemaining:25},{label:'60-day payment',dueDaysBefore:60,percentOfRemaining:25},{label:'30-day final payment',dueDaysBefore:30,percentOfRemaining:100}],
    },
    'builtin-micro-wedding': {
      id:'builtin-micro-wedding', name:'Micro Wedding', category:'venueWedding', depositPercent:10,
      milestones:[{label:'Second payment',dueDaysBefore:60,percentOfRemaining:50},{label:'Final payment',dueDaysBefore:30,percentOfRemaining:100}],
    },
    'builtin-mobile-bar': {
      id:'builtin-mobile-bar', name:'Mobile Bar', category:'mobileBar', depositPercent:10,
      milestones:[{label:'Final balance',dueDaysBefore:14,percentOfRemaining:100}],
    },
    'builtin-private-event': {
      id:'builtin-private-event', name:'Private Event', category:'privateEvent', depositPercent:10,
      milestones:[{label:'Final balance',dueDaysBefore:30,percentOfRemaining:100}],
    },
    'builtin-general-fallback': {
      id:'builtin-general-fallback', name:'General Fallback', category:'default', depositPercent:10,
      milestones:[{label:'Final balance',dueDaysBefore:30,percentOfRemaining:100}],
    },
  };
  return presets[id] || null;
}

function leadDaysBetween(bookingDate: string, eventDate: string) {
  const start = Date.parse(String(bookingDate || '').slice(0,10) + 'T12:00:00Z');
  const end = Date.parse(String(eventDate || '').slice(0,10) + 'T12:00:00Z');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.ceil((end - start) / 86400000));
}

function selectedPaymentPreset(
  settings: QuickBooksDepositSettings,
  packageId = '',
  inquiry?: Record<string, unknown>,
  eventDate = '',
  bookingDate = '',
  beforeGetValue = 0,
  afterGetValue = beforeGetValue,
) {
  const category = paymentCategoryKey(packageId, inquiry);
  const leadDays = leadDaysBetween(bookingDate || new Date().toISOString().slice(0,10), eventDate);
  const rules = (Array.isArray(settings.autoRules) ? settings.autoRules : [])
    .filter((rule) => rule.active !== false && rule.category === category)
    .sort((a,b) => Number(a.priority || 0) - Number(b.priority || 0));
  const matches = rules.filter((rule) => {
    if (leadDays == null) {
      if (rule.minLeadDays != null || rule.maxLeadDays != null) return false;
    } else {
      if (rule.minLeadDays != null && leadDays < Number(rule.minLeadDays)) return false;
      if (rule.maxLeadDays != null && leadDays > Number(rule.maxLeadDays)) return false;
    }
    const basis = rule.contractValueBasis === 'beforeGet' ? 'beforeGet' : 'afterGet';
    const contractValue = basis === 'beforeGet' ? beforeGetValue : afterGetValue;
    if (rule.minContractValue != null && contractValue < Number(rule.minContractValue)) return false;
    if (rule.maxContractValue != null && contractValue > Number(rule.maxContractValue)) return false;
    return true;
  });
  const match = matches[0];

  if (match) {
    const builtin = builtInPaymentPreset(match.presetId);
    const custom = (Array.isArray(settings.customPresets) ? settings.customPresets : []).find((preset) => preset.id === match.presetId);
    const preset = builtin || custom;
    if (preset) {
      const contractValueBasis = match.contractValueBasis === 'beforeGet' ? 'beforeGet' : 'afterGet';
      const contractValue = contractValueBasis === 'beforeGet' ? beforeGetValue : afterGetValue;
      const explanation = [
        'Event category matched ' + category + '.',
        leadDays == null
          ? 'No usable lead-time dates were available; this rule does not require a lead-time range.'
          : 'Lead time was ' + leadDays + ' days and was inside this rule’s range.',
        'Contract-value basis was ' + (contractValueBasis === 'beforeGet' ? 'before Hawaiʻi GET' : 'after Hawaiʻi GET') + ' at $' + contractValue.toFixed(2) + ' and was inside this rule’s range.',
        matches.length > 1
          ? matches.length + ' active rules matched; “' + match.name + '” won because it had the highest priority.'
          : 'This was the only active rule that matched.',
        'Preset “' + preset.name + '” was selected.',
      ];
      return {
        ...preset,
        ruleId:match.id,
        ruleName:match.name,
        priority:Number(match.priority || 0),
        category,
        leadDays,
        contractValueBasis,
        contractValue,
        beforeGetValue,
        afterGetValue,
        matchedRuleIds:matches.map((rule) => rule.id),
        matchedRuleNames:matches.map((rule) => rule.name),
        explanation,
      };
    }
  }

  return null;
}

function configuredDepositPercent(settings: QuickBooksDepositSettings, packageId = '', inquiry?: Record<string, unknown>, eventDate = '', bookingDate = '', beforeGetValue = 0, afterGetValue = beforeGetValue) {
  const preset = selectedPaymentPreset(settings, packageId, inquiry, eventDate, bookingDate, beforeGetValue, afterGetValue);
  if (preset) return Number(preset.depositPercent || 0);
  const category = proposalCategory(packageId, inquiry);
  if (category === 'mobile-bar') return settings.mobileBarPercent;
  if (category === 'venue-wedding') return settings.venueWeddingPercent;
  if (category === 'private-event') return settings.privateEventPercent;
  return settings.defaultPercent;
}

function configuredPaymentSchedule(settings: QuickBooksDepositSettings, total: number, depositAmount: number, eventDate = '', packageId = '', inquiry?: Record<string, unknown>, bookingDate = '', beforeGetValue = total): PaymentItem[] {
  const category = proposalCategory(packageId, inquiry);
  const selected = selectedPaymentPreset(settings, packageId, inquiry, eventDate, bookingDate, beforeGetValue, total);
  const remaining = Math.max(0, roundMoney(total - depositAmount));
  const template = selected?.milestones || (category === 'venue-wedding'
    ? settings.venueWeddingMilestones
    : category === 'mobile-bar'
      ? settings.mobileBarMilestones
      : category === 'private-event'
        ? settings.privateEventMilestones
        : settings.defaultMilestones);
  const rows = Array.isArray(template) && template.length
    ? template
    : [{ label:'Final balance', dueDaysBefore:0, percentOfRemaining:100 }];
  let allocated = 0;
  const milestones = rows.map((item, index) => {
    const last = index === rows.length - 1;
    const amount = last
      ? Math.max(0, roundMoney(remaining - allocated))
      : Math.min(
          Math.max(0, roundMoney(remaining - allocated)),
          Math.max(0, roundMoney(remaining * Math.min(100, Math.max(0, Number(item.percentOfRemaining || 0))) / 100)),
        );
    allocated = roundMoney(allocated + amount);
    return {
      label: cleanText(item.label || (last ? 'Final balance' : 'Payment'), 160),
      dueDate: eventDate ? offsetDate(eventDate, -Math.max(0, Math.round(Number(item.dueDaysBefore || 0)))) : '',
      amount,
    };
  });
  return [{ label:'Reservation deposit', dueDate:'', amount:depositAmount }, ...milestones];
}

function proposalFromQuote(quote: SavedQuote | null, eventDate = '', packageId = '', inquiry?: Record<string, unknown>, configuredPercent = 10, scheduleSettings?: QuickBooksDepositSettings, bookingDate = '') {
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
        catalogItemId: cleanText(item?.catalogItemId, 80) || undefined,
        quickBooksItemId: cleanText(item?.quickBooksItemId, 80) || undefined,
        category: ['service','rental','mileage','fee'].includes(String(item?.category || '')) ? item.category : undefined,
        unitLabel: cleanText(item?.unitLabel, 40) || undefined,
        getExempt: item?.getExempt === true,
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
  const taxableGross = lines.filter((line) => line.getExempt !== true).reduce((sum, line) => sum + finite(line.amount), 0);
  const taxableAfterDiscount = subtotal > 0
    ? Math.max(0, taxableGross - (discountAmount * taxableGross / subtotal))
    : 0;
  const taxRate = 4.712;
  const taxAmount = Math.round(taxableAfterDiscount * taxRate) / 100;
  const beforeGetValue = Math.max(0, Math.round((subtotal - discountAmount) * 100) / 100);
  const total = Math.max(0, Math.round((beforeGetValue + taxAmount) * 100) / 100);
  const selectedPreset = scheduleSettings ? selectedPaymentPreset(scheduleSettings, packageId, inquiry, eventDate, bookingDate, beforeGetValue, total) : null;
  const depositPercent = Math.min(100, Math.max(0, finite(selectedPreset?.depositPercent ?? configuredPercent, 0, 100)));
  const depositAmount = Math.round(total * depositPercent) / 100;
  const schedule = scheduleSettings
    ? configuredPaymentSchedule(scheduleSettings, total, depositAmount, eventDate, packageId, inquiry, bookingDate, beforeGetValue)
    : rebalancePaymentSchedule([], total, depositAmount, eventDate);

  return {
    publicToken: publicToken(),
    status: 'draft' as const,
    expirationDate: offsetDate(new Date().toISOString().slice(0, 10), 14),
    lineItems: lines,
    subtotal,
    discountAmount,
    taxRate,
    taxAmount,
    total,
    depositPercent,
    depositAmount,
    paymentSchedule: schedule,
    paymentRuleDecision: selectedPreset ? {
      ruleId:selectedPreset.ruleId,
      ruleName:selectedPreset.ruleName,
      presetId:selectedPreset.id,
      presetName:selectedPreset.name,
      priority:selectedPreset.priority,
      category:selectedPreset.category,
      leadDays:selectedPreset.leadDays,
      contractValueBasis:selectedPreset.contractValueBasis,
      contractValue:selectedPreset.contractValue,
      beforeGetValue:selectedPreset.beforeGetValue,
      afterGetValue:selectedPreset.afterGetValue,
      matchedRuleIds:selectedPreset.matchedRuleIds,
      matchedRuleNames:selectedPreset.matchedRuleNames,
      explanation:selectedPreset.explanation,
      decidedAt:new Date().toISOString(),
    } : null,
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
      catalogItemId: cleanText(line?.catalogItemId, 80) || undefined,
      quickBooksItemId: cleanText(line?.quickBooksItemId, 80) || undefined,
      category: ['service','rental','mileage','fee'].includes(String(line?.category || '')) ? line.category : undefined,
      unitLabel: cleanText(line?.unitLabel, 40) || undefined,
      getExempt: line?.getExempt === true,
    };
  }).filter((line) => line.description);
}

function sanitizeProfitModel(input: any, current?: ProfitModel): ProfitModel {
  const requestedMode = cleanText(input?.costMode ?? current?.costMode ?? (current ? 'manual' : 'auto'), 20);
  const costMode = requestedMode === 'manual' ? 'manual' : 'auto';
  return {
    costMode,
    bartenderWageRate: finite(input?.bartenderWageRate ?? current?.bartenderWageRate ?? 40, 0, 500),
    iceCost: finite(input?.iceCost ?? current?.iceCost ?? 0),
    mixersCost: finite(input?.mixersCost ?? current?.mixersCost ?? 0),
    garnishesCost: finite(input?.garnishesCost ?? current?.garnishesCost ?? 0),
    cupsCost: finite(input?.cupsCost ?? current?.cupsCost ?? 0),
    suppliesCost: finite(input?.suppliesCost ?? current?.suppliesCost ?? 0),
    travelCost: finite(input?.travelCost ?? current?.travelCost ?? 0),
    addOnCost: finite(input?.addOnCost ?? current?.addOnCost ?? 0),
    gratuityCost: finite(input?.gratuityCost ?? current?.gratuityCost ?? 0),
    otherDirectCosts: finite(input?.otherDirectCosts ?? current?.otherDirectCosts ?? 0),
    notes: cleanText(input?.notes ?? current?.notes ?? '', 3000),
    updatedAt: new Date().toISOString(),
  };
}

function sanitizeSchedule(input: unknown): PaymentItem[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 12).map((item: any) => ({
    label: cleanText(item?.label, 160),
    dueDate: cleanText(item?.dueDate, 40),
    amount: finite(item?.amount),
  })).filter((item) => item.label);
}

function roundMoney(value: unknown) {
  return Math.round(finite(value) * 100) / 100;
}

function effectiveDepositPercent(proposal: any) {
  const explicit = Number(proposal?.depositPercent);
  if (Number.isFinite(explicit)) return Math.min(100, Math.max(0, Math.round(explicit * 1000) / 1000));
  const total = finite(proposal?.total);
  const deposit = finite(proposal?.depositAmount);
  if (total > 0) return Math.min(100, Math.max(0, Math.round((deposit / total) * 100000) / 1000));
  return 10;
}

function rebalancePaymentSchedule(input: unknown, totalValue: number, depositValue: number, eventDate = ''): PaymentItem[] {
  const total = Math.max(0, roundMoney(totalValue));
  const deposit = Math.min(total, Math.max(0, roundMoney(depositValue)));
  let schedule = sanitizeSchedule(input);

  if (!schedule.length) {
    schedule = [
      { label: 'Reservation deposit', dueDate: '', amount: deposit },
      { label: 'Second payment', dueDate: eventDate ? offsetDate(eventDate, -90) : '', amount: 0 },
      { label: 'Final payment', dueDate: eventDate ? offsetDate(eventDate, -60) : '', amount: 0 },
    ];
  }

  const first = {
    ...schedule[0],
    label: schedule[0]?.label || 'Reservation deposit',
    amount: deposit,
  };
  let remainingRows = schedule.slice(1);
  const remaining = Math.max(0, roundMoney(total - deposit));

  if (!remainingRows.length && remaining > 0) {
    remainingRows = [{
      label: 'Final payment',
      dueDate: eventDate ? offsetDate(eventDate, -60) : '',
      amount: remaining,
    }];
  }
  if (!remainingRows.length) return [first];

  const weightTotal = remainingRows.reduce((sum, item) => sum + Math.max(0, finite(item.amount)), 0);
  let allocated = 0;
  const balanced = remainingRows.map((item, index) => {
    const amount = index === remainingRows.length - 1
      ? Math.max(0, roundMoney(remaining - allocated))
      : Math.max(0, roundMoney(
          weightTotal > 0
            ? remaining * (Math.max(0, finite(item.amount)) / weightTotal)
            : remaining / remainingRows.length,
        ));
    allocated = roundMoney(allocated + amount);
    return { ...item, amount };
  });
  return [first, ...balanced];
}

function syncUncommittedBookingPayments(record: SalesRecord, schedule: PaymentItem[]) {
  if (!record.booking?.payments?.length) return;
  const invoices = Array.isArray((record as any)?.accounting?.quickbooks?.invoices)
    ? (record as any).accounting.quickbooks.invoices
    : [];
  const hasIssuedInvoice = invoices.some((entry: any) =>
    entry?.invoiceId && !['void','deleted'].includes(String(entry?.status || '').toLowerCase()),
  );
  const hasPaidPayment = record.booking.payments.some((item) => item.status === 'paid');
  const signedContract = record.booking.contract?.status === 'signed' || Boolean(record.booking.contract?.koaSignature);
  if (hasIssuedInvoice || hasPaidPayment || signedContract) return;

  record.booking.payments = schedule.map((item, index) => {
    const current = record.booking!.payments[index];
    return {
      id: current?.id || 'pay-' + (index + 1),
      label: item.label,
      dueDate: item.dueDate,
      amount: item.amount,
      status: current?.status || 'pending',
      paidAt: current?.paidAt,
      reference: current?.reference,
      paymentUrl: current?.paymentUrl,
    };
  });
}

function updateProposal(record: SalesRecord, payload: any) {
  const current = record.proposal || proposalFromQuote(record.quote || null, record.customer?.eventDate || '', record.packageId || '');
  const lineItems = sanitizeLines(payload.lineItems);
  const subtotal = Math.round(lineItems.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;
  const discountAmount = Math.min(subtotal, finite(payload.discountAmount));
  const taxableGross = lineItems.filter((line) => line.getExempt !== true).reduce((sum, line) => sum + line.amount, 0);
  const taxableAfterDiscount = subtotal > 0
    ? Math.max(0, taxableGross - (discountAmount * taxableGross / subtotal))
    : 0;
  const taxRate = 4.712;
  const taxAmount = Math.round(taxableAfterDiscount * taxRate) / 100;
  const total = Math.round((subtotal - discountAmount + taxAmount) * 100) / 100;
  const depositPercent = Math.min(100, Math.max(0, finite(payload.depositPercent ?? effectiveDepositPercent(current), 0, 100)));
  const depositAmount = roundMoney(total * depositPercent / 100);
  const eventDate = cleanText(payload.customer?.eventDate ?? record.customer?.eventDate, 40);
  const paymentSchedule = rebalancePaymentSchedule(payload.paymentSchedule ?? current.paymentSchedule, total, depositAmount, eventDate);
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
    depositPercent,
    depositAmount,
    paymentSchedule,
    paymentRuleDecision: current.paymentRuleDecision || null,
    notesToClient: cleanText(payload.notesToClient, 6000),
  };
  syncUncommittedBookingPayments(record, paymentSchedule);
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


function chainRootId(record:SalesRecord, byId:Map<string,SalesRecord>) {
  let current=record;
  const seen=new Set<string>();
  while(current?.source && byId.has(current.source) && !seen.has(current.id)){
    seen.add(current.id);
    current=byId.get(current.source)!;
  }
  return current?.id || record.id;
}

function chainKey(record:SalesRecord, byId:Map<string,SalesRecord>) {
  return record.quoteId ? 'quote:'+record.quoteId : 'root:'+chainRootId(record,byId);
}

async function ensureAssignments(context:Context, records:SalesRecord[], staff:OperationalStaff[]) {
  if(!staff.length) return records;
  const valid=new Map(staff.map(member=>[member.id,member]));
  const byId=new Map(records.map(record=>[record.id,record]));
  const groups=new Map<string,SalesRecord[]>();
  for(const record of records){
    const key=chainKey(record,byId);
    groups.set(key,[...(groups.get(key)||[]),record]);
  }
  const counts=new Map(staff.map(member=>[member.id,0]));
  const owners=new Map<string,OperationalStaff>();
  for(const [key,group] of groups){
    const existing=group.map(row=>row.assignment?.userId).find(id=>id&&valid.has(id));
    if(existing){
      const member=valid.get(existing)!;
      owners.set(key,member);
      counts.set(member.id,(counts.get(member.id)||0)+1);
    }
  }
  for(const [key] of groups){
    if(owners.has(key)) continue;
    const member=[...staff].sort((a,b)=>(counts.get(a.id)||0)-(counts.get(b.id)||0)||a.name.localeCompare(b.name))[0];
    if(!member) continue;
    owners.set(key,member);
    counts.set(member.id,(counts.get(member.id)||0)+1);
  }
  const changed:SalesRecord[]=[];
  for(const [key,group] of groups){
    const owner=owners.get(key); if(!owner) continue;
    const existingAssignment=group.find(row=>row.assignment?.userId===owner.id)?.assignment;
    const assignment=existingAssignment || assignmentFor(owner,'automatic-backfill');
    for(const record of group){
      if(record.assignment?.userId===owner.id && record.assignment?.email===owner.email) continue;
      record.assignment={...assignment};
      changed.push(record);
    }
  }
  if(changed.length){
    const store=salesStoreFor(context);
    await Promise.all(changed.map(record=>store.setJSON('records/'+record.id,record)));
    await writeSalesIndex(context,records);
  }
  return records;
}

function staffPerformance(records:SalesRecord[], events:any[], staff:OperationalStaff[], days:number|null) {
  const byId=new Map(records.map(record=>[record.id,record]));
  const groups=new Map<string,SalesRecord[]>();
  for(const record of records){
    const key=chainKey(record,byId);
    groups.set(key,[...(groups.get(key)||[]),record]);
  }
  const cutoff=days?Date.now()-days*86400000:0;
  const responseTypes=new Set(['call','email','meeting','responded','proposal_sent','quickbooks_estimate_sent']);
  const stats=new Map(staff.map(member=>[member.id,{
    userId:member.id,name:member.name,email:member.email,role:member.role,
    opportunities:0,responded:0,responseHoursTotal:0,proposalsSent:0,booked:0,bookedRevenue:0,followUpsOverdue:0,
  }]));

  for(const group of groups.values()){
    const created=Math.min(...group.map(r=>Date.parse(r.createdAt)).filter(Number.isFinite));
    if(days && (!Number.isFinite(created)||created<cutoff)) continue;
    const ownerId=group.map(r=>r.assignment?.userId).find(Boolean);
    const stat=ownerId?stats.get(ownerId):null;
    if(!stat) continue;
    stat.opportunities+=1;
    const ids=new Set(group.map(r=>r.id));
    const quoteIds=new Set(group.map(r=>r.quoteId).filter(Boolean));
    const groupEvents=events.filter((event:any)=>ids.has(String(event.recordId||''))||ids.has(String(event.sourceRecordId||''))||quoteIds.has(String(event.quoteId||'')));
    const firstResponse=groupEvents
      .filter((event:any)=>responseTypes.has(String(event.type||''))&&Date.parse(event.createdAt)>=created)
      .sort((a:any,b:any)=>Date.parse(a.createdAt)-Date.parse(b.createdAt))[0];
    if(firstResponse){
      const hours=Math.max(0,(Date.parse(firstResponse.createdAt)-created)/3600000);
      stat.responded+=1; stat.responseHoursTotal+=hours;
    }
    const proposal=group.filter(r=>r.kind==='proposal').sort((a,b)=>Date.parse(b.updatedAt||b.createdAt)-Date.parse(a.updatedAt||a.createdAt))[0];
    const sent=Boolean(groupEvents.some((event:any)=>String(event.type)==='proposal_sent')) || Boolean(proposal?.proposal && ['sent','viewed','accepted','booked'].includes(proposal.proposal.status));
    if(sent) stat.proposalsSent+=1;
    const booked=group.some(r=>r.stage==='booked'||r.proposal?.status==='booked'||r.booking?.status==='booked');
    if(booked){
      stat.booked+=1;
      const value=Math.max(0,...group.map(r=>Number(r.proposal?.total||0)));
      stat.bookedRevenue+=value;
    }
    const latest=[...group].sort((a,b)=>Date.parse(b.updatedAt||b.createdAt)-Date.parse(a.updatedAt||a.createdAt))[0];
    if(latest && !booked && latest.stage!=='lost' && latest.stage!=='converted'){
      const overdue=remindersForRecord(latest).some(rem=>['follow_up','proposal'].includes(rem.type));
      if(overdue) stat.followUpsOverdue+=1;
    }
  }

  return [...stats.values()].map((row:any)=>({
    userId:row.userId,name:row.name,email:row.email,role:row.role,
    opportunities:row.opportunities,
    averageResponseHours:row.responded?Math.round((row.responseHoursTotal/row.responded)*10)/10:null,
    responseCoverage:row.opportunities?Math.round((row.responded/row.opportunities)*1000)/10:null,
    proposalsSent:row.proposalsSent,
    booked:row.booked,
    conversionRate:row.opportunities?Math.round((row.booked/row.opportunities)*1000)/10:null,
    bookedRevenue:Math.round(row.bookedRevenue*100)/100,
    followUpsOverdue:row.followUpsOverdue,
  })).sort((a,b)=>b.bookedRevenue-a.bookedRevenue||a.name.localeCompare(b.name));
}

export default async (req: Request, context: Context) => {
  const auth = await requireCapability('sales.view', req);
  if (auth.response) return auth.response;

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const q = cleanText(url.searchParams.get('q'), 120).toLowerCase();
    const [allQuotes, rawRecords, events, trashRaw, mobileBarProfitSettings, staff] = await Promise.all([
      listQuotes(context),
      readSalesIndex(context),
      readEvents(context),
      readTrashIndex(context),
      readMobileBarProfitSettings(context),
      listOperationalStaff().catch(()=>[] as OperationalStaff[]),
    ]);
    const records = await ensureAssignments(context, rawRecords, staff);
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
      mobileBarProfitSettings,
      conversions,
      reminders,
      records: enrichedRecords,
      trash,
      staffDirectory: isApprovedManager(auth.user) ? staff : [],
      staffPerformance: isApprovedManager(auth.user) ? {
        '30': staffPerformance(records,events,staff,30),
        '90': staffPerformance(records,events,staff,90),
        all: staffPerformance(records,events,staff,null),
      } : null,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const payload: any = await req.json().catch(() => null);
  if (!payload?.action) return Response.json({ error: 'Missing action.' }, { status: 400 });

  const capabilityByAction:Record<string,any>={
    'delete-record':'crm.destructive',
    'trash-client-chain':'crm.destructive',
    'restore-client-chain':'crm.destructive',
    'permanent-delete-client-chain':'crm.destructive',
    'restore-record':'crm.destructive',
    'permanent-delete-record':'crm.destructive',
    'delete-quote':'crm.destructive',
    'bulk-trash':'crm.destructive',
    'bulk-trash-client-chains':'crm.destructive',
    'update-mobile-bar-profit-settings':'sales.profit_settings',
    'update-profit-model':'sales.profit_settings',
  };
  const requestedCapability=capabilityByAction[String(payload.action)] || 'sales.manage';
  if (!hasCapability(auth.user,requestedCapability)) {
    return Response.json({ error: 'You do not have permission for this sales action.' }, { status: 403 });
  }
  if (payload.action === 'assign-owner' && !isApprovedManager(auth.user)) {
    return Response.json({ error: 'Manager permission required to assign lead ownership.' }, { status: 403 });
  }

  let records = await readSalesIndex(context);

  if (payload.action === 'assign-owner') {
    const recordId=cleanText(payload.recordId,80);
    const userId=cleanText(payload.userId,120);
    const root=records.find(entry=>entry.id===recordId);
    if(!root) return Response.json({error:'CRM record not found.'},{status:404});
    const staff=await listOperationalStaff();
    const member=staff.find(row=>row.id===userId);
    if(!member) return Response.json({error:'Active Sales Rep or Manager not found.'},{status:404});
    const related=relatedRecordIds(root,records);
    const assignment=assignmentFor(member,cleanText(auth.user?.email,240)||'manager');
    const changed=records.filter(entry=>related.has(entry.id));
    changed.forEach(entry=>{entry.assignment={...assignment};entry.updatedAt=new Date().toISOString();});
    const store=salesStoreFor(context);
    await Promise.all(changed.map(entry=>store.setJSON('records/'+entry.id,entry)));
    await writeSalesIndex(context,records);
    await appendEvent(context,{type:'owner_assigned',recordId:root.id,quoteId:root.quoteId||'',packageId:root.packageId||'',detail:'Assigned client opportunity to '+member.name+' ('+member.email+').'});
    await appendStaffAudit(context,{actor:cleanText(auth.user?.email,240)||'manager',action:'lead_owner_changed',recordId:root.id,subjectId:member.id,subjectEmail:member.email,detail:'Assigned '+(root.customer?.name||root.id)+' to '+member.name+'.',metadata:{chainIds:[...related]}});
    return Response.json({ok:true,assignment,recordIds:[...related]},{headers:{'Cache-Control':'private, no-store'}});
  }

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
    await appendCleanupAudit(context,{recordId:record.id,action:'moved_to_trash',actor:cleanText(auth.user?.email,240)||'admin',detail:'Moved CRM record to 30-day Trash.',chainIds:[record.id],dimensions:cleanupDimensionsFromRecord(record),client:cleanupClientSnapshotFromRecord(record)});

    return Response.json({
      ok: true,
      deletedId: record.id,
      kind: record.kind,
      trash: moved.entry,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  if (payload.action === 'trash-client-chain') {
    const recordId = cleanText(payload.recordId, 80);
    const root = records.find((entry) => entry.id === recordId);
    if (!root) return Response.json({ error: 'CRM client record not found.' }, { status: 404 });

    const relatedIds = relatedRecordIds(root, records);
    const related = records.filter((entry) => relatedIds.has(entry.id));
    const protectedRecords = related.filter((entry) =>
      entry.kind === 'proposal' ||
      entry.stage === 'proposal' ||
      entry.stage === 'booked' ||
      Boolean(entry.booking) ||
      Boolean((entry as any)?.accounting?.quickbooks?.invoices?.length)
    );

    if (protectedRecords.length) {
      return Response.json({
        error: 'This client chain contains a proposal, booking, contract, or accounting record and is protected from client-level Trash. Remove only the bogus inquiry/lead records individually or resolve the protected record first.',
        protectedIds: protectedRecords.map((entry) => entry.id),
      }, { status: 409 });
    }

    const movable = related.filter((entry) => ['inquiry', 'lead'].includes(entry.kind));
    if (!movable.length) {
      return Response.json({ error: 'No inquiry or lead records are eligible for Trash.' }, { status: 400 });
    }

    const moved: string[] = [];
    const trashEntries: TrashEntry[] = [];
    for (const target of movable) {
      if (!records.some((entry) => entry.id === target.id)) continue;
      const result = await moveRecordToTrash(context, target, records, cleanText(auth.user?.email, 240));
      records = result.records;
      moved.push(target.id);
      trashEntries.push(result.entry);
    }

    await appendEvent(context, {
      type: 'client_chain_trashed',
      recordId: root.id,
      quoteId: root.quoteId || '',
      packageId: root.packageId || '',
      detail: 'Administrator moved a bogus/test client chain to Trash for 30 days. ' + moved.length + ' CRM record(s) removed from the active pipeline.',
      reference: moved.join(','),
    });
    await appendCleanupAudit(context,{recordId:root.id,action:'moved_to_trash',actor:cleanText(auth.user?.email,240)||'admin',detail:'Moved related client chain to 30-day Trash.',chainIds:moved,dimensions:cleanupDimensionsFromRecord(root),client:cleanupClientSnapshotFromRecord(root)});

    return Response.json({
      ok: true,
      deletedId: root.id,
      moved,
      count: moved.length,
      expiresAt: trashEntries.map((entry) => entry.expiresAt).sort()[0] || '',
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  if (payload.action === 'restore-client-chain') {
    const recordId = cleanText(payload.recordId, 80);
    try {
      const restored = await restoreTrashClientChain(context, recordId, records);
      records = restored.records;
      await appendEvent(context, {
        type: 'client_chain_restored',
        recordId,
        detail: 'Administrator restored an entire related inquiry/lead chain from Trash.',
        reference: restored.restored.map((record) => record.id).join(','),
      });
      await appendCleanupAudit(context,{recordId,action:'restored',actor:cleanText(auth.user?.email,240)||'admin',detail:'Restored entire related inquiry/lead chain from Trash.',chainIds:restored.restored.map((record)=>record.id)});
      return Response.json({ ok: true, restored: restored.restored.map((record) => record.id), count: restored.restored.length }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Unable to restore client chain.' }, { status: 400 });
    }
  }

  if (payload.action === 'permanent-delete-client-chain') {
    const recordId = cleanText(payload.recordId, 80);
    const removed = await permanentlyDeleteTrashClientChain(context, recordId);
    if (!removed.length) return Response.json({ error: 'Trash client chain not found.' }, { status: 404 });
    await appendEvent(context, {
      type: 'client_chain_permanently_deleted',
      recordId,
      detail: 'Administrator permanently deleted an entire related client chain from Trash.',
      reference: removed.join(','),
    });
    await appendCleanupAudit(context,{recordId,action:'permanently_deleted',actor:cleanText(auth.user?.email,240)||'admin',detail:'Permanently deleted entire client chain from Trash.',chainIds:removed});
    return Response.json({ ok: true, deleted: removed, count: removed.length }, { headers: { 'Cache-Control': 'private, no-store' } });
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
      await appendCleanupAudit(context,{recordId:restored.record.id,action:'restored',actor:cleanText(auth.user?.email,240)||'admin',detail:'Restored CRM record from Trash.',chainIds:[restored.record.id]});
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
    await appendCleanupAudit(context,{recordId,action:'permanently_deleted',actor:cleanText(auth.user?.email,240)||'admin',detail:'Permanently deleted CRM record from Trash.',chainIds:[recordId]});
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

  if (payload.action === 'bulk-trash-client-chains') {
    const ids = Array.from(new Set((Array.isArray(payload.recordIds) ? payload.recordIds : [])
      .map((value: unknown) => cleanText(value, 80))
      .filter(Boolean))).slice(0, 100);
    if (!ids.length) return Response.json({ error: 'Select at least one client.' }, { status: 400 });

    const moved = new Set<string>();
    const skipped: Array<{ id: string; reason: string }> = [];

    for (const id of ids) {
      if (moved.has(id)) continue;
      const root = records.find((entry) => entry.id === id);
      if (!root) { skipped.push({ id, reason: 'Record not found.' }); continue; }

      const relatedIds = relatedRecordIds(root, records);
      const related = records.filter((entry) => relatedIds.has(entry.id));
      const protectedRecords = related.filter((entry) =>
        entry.kind === 'proposal' ||
        entry.stage === 'proposal' ||
        entry.stage === 'booked' ||
        Boolean(entry.booking) ||
        Boolean((entry as any)?.accounting?.quickbooks?.invoices?.length)
      );
      if (protectedRecords.length) {
        skipped.push({ id, reason: 'Client chain contains protected proposal, booking, contract, invoice, or payment data.' });
        continue;
      }

      const movable = related.filter((entry) => ['inquiry', 'lead'].includes(entry.kind));
      if (!movable.length) {
        skipped.push({ id, reason: 'No inquiry or lead records are eligible for Trash.' });
        continue;
      }

      for (const target of movable) {
        if (!records.some((entry) => entry.id === target.id)) continue;
        const result = await moveRecordToTrash(context, target, records, cleanText(auth.user?.email, 240));
        records = result.records;
        moved.add(target.id);
      }

      await appendEvent(context, {
        type: 'client_chain_trashed',
        recordId: root.id,
        quoteId: root.quoteId || '',
        packageId: root.packageId || '',
        detail: 'Administrator bulk-moved a client chain to Trash for 30 days.',
      });
      await appendCleanupAudit(context,{recordId:root.id,action:'bulk_moved_to_trash',actor:cleanText(auth.user?.email,240)||'admin',detail:'Bulk cleanup moved related client chain to 30-day Trash.',chainIds:movable.map((entry)=>entry.id),dimensions:cleanupDimensionsFromRecord(root),client:cleanupClientSnapshotFromRecord(root)});
    }

    return Response.json({ ok: true, moved: [...moved], skipped }, { headers: { 'Cache-Control': 'private, no-store' } });
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
    const depositSettings = kind === 'proposal' ? await getQuickBooksDepositSettings(context) : null;
    const eventDate = cleanText(payload.customer?.eventDate, 40);
    const depositPercent = depositSettings ? configuredDepositPercent(depositSettings, packageId, undefined, eventDate, now.slice(0,10)) : 10;
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
        eventDate,
        notes: cleanText(payload.customer?.notes, 4000),
      },
      quote,
      proposal: kind === 'proposal' ? proposalFromQuote(quote, eventDate, packageId, undefined, depositPercent, depositSettings || undefined, now.slice(0,10)) : undefined,
    };
    const matchingOwner=records.find(entry=>entry.quoteId===quoteId&&entry.assignment)?.assignment;
    if(matchingOwner) record.assignment={...matchingOwner};
    else {
      const staff=await listOperationalStaff().catch(()=>[] as OperationalStaff[]);
      const member=[...staff].sort((a,b)=>{
        const ac=records.filter(r=>r.assignment?.userId===a.id).length;
        const bc=records.filter(r=>r.assignment?.userId===b.id).length;
        return ac-bc||a.name.localeCompare(b.name);
      })[0];
      if(member) record.assignment=assignmentFor(member,'automatic-conversion');
    }
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
    const depositSettings = kind === 'proposal' ? await getQuickBooksDepositSettings(context) : null;
    const depositPercent = depositSettings ? configuredDepositPercent(depositSettings, packageId, source.inquiry, source.customer?.eventDate || '', now.slice(0,10)) : 10;
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
      profitModel: source.profitModel ? { ...source.profitModel } : undefined,
      assignment: source.assignment ? { ...source.assignment } : undefined,
      proposal: kind === 'proposal' ? proposalFromQuote(quote, source.customer?.eventDate || '', packageId, source.inquiry, depositPercent, depositSettings || undefined, now.slice(0,10)) : undefined,
    };
    source.stage = 'converted';
    source.status = 'converted';
    source.updatedAt = now;
    records = await saveRecord(context, source, records);
    records = await saveRecord(context, record, records);
    await appendEvent(context, { type: kind, packageId, quoteId: source.quoteId || '', recordId: record.id, sourceRecordId: source.id });
    return Response.json({ ok: true, record, convertedSourceId: source.id });
  }

  if (payload.action === 'update-mobile-bar-profit-settings') {
    const settings = await writeMobileBarProfitSettings(context, payload.settings || {});
    await appendEvent(context, {
      type: 'mobile_bar_profit_settings_updated',
      detail: 'Mobile Bar monthly gross-profit target updated to ' + settings.monthlyGrossProfitTarget.toFixed(2) + '.',
    });
    await appendStaffAudit(context,{actor:cleanText(auth.user?.email,240)||'staff',action:'sales_profit_settings_changed',detail:'Changed Mobile Bar monthly gross-profit target.',metadata:{monthlyGrossProfitTarget:settings.monthlyGrossProfitTarget}});
    return Response.json({ ok: true, settings }, { headers: { 'Cache-Control':'private, no-store' } });
  }
  if (payload.action === 'update-profit-model') {
    const record = records.find((entry) => entry.id === cleanText(payload.recordId, 80));
    if (!record) return Response.json({ error: 'CRM record not found.' }, { status: 404 });
    const packageId = normalizePackage(record.packageId || record.inquiry?.mobileBarPackage);
    if (!packageId.startsWith('mobile-') && record.inquiry?.service !== 'mobile-bar') {
      return Response.json({ error: 'Profit model is available for Mobile Bar records only.' }, { status: 400 });
    }
    record.profitModel = sanitizeProfitModel(payload.profitModel || {}, record.profitModel);
    record.updatedAt = new Date().toISOString();
    records = await saveRecord(context, record, records);
    await appendEvent(context, {
      type: 'profit_model_updated',
      recordId: record.id,
      quoteId: record.quoteId || '',
      packageId: record.packageId || '',
      detail: 'Mobile Bar direct-cost model updated by staff.',
    });
    await appendStaffAudit(context,{actor:cleanText(auth.user?.email,240)||'staff',action:'sales_profit_model_changed',recordId:record.id,detail:'Updated Mobile Bar direct-cost model for '+(record.customer?.name||record.id)+'.'});
    return Response.json({ ok: true, record });
  }

  if (payload.action === 'apply-mobile-bar-margin-target') {
    const record = records.find((entry) => entry.id === cleanText(payload.recordId, 80) && entry.kind === 'proposal');
    if (!record?.proposal) return Response.json({ error: 'Proposal not found.' }, { status: 404 });
    if (['accepted','booked'].includes(record.proposal.status) || record.stage === 'booked') {
      return Response.json({ error: 'Accepted or booked proposals are locked from one-click repricing.' }, { status: 409 });
    }

    const targetMargin = Math.round(finite(payload.targetMargin, 0, 100));
    if (![40,50,60].includes(targetMargin)) {
      return Response.json({ error: 'Target margin must be 40%, 50%, or 60%.' }, { status: 400 });
    }
    const targetTotal = Math.round(finite(payload.targetTotal, 0, 10_000_000) * 100) / 100;
    if (targetTotal <= 0) return Response.json({ error: 'Valid target total required.' }, { status: 400 });

    const current = record.proposal;
    const currentTotal = Math.max(0, finite(current.total));
    if (targetTotal + 0.01 < currentTotal) {
      return Response.json({ error: 'One-click margin pricing cannot reduce the existing proposal total.' }, { status: 400 });
    }

    const preserved = (current.lineItems || []).filter((line) => line.id !== 'margin-target-adjustment');
    const baseSubtotal = preserved.reduce((sum, line) => sum + finite(line.amount), 0);
    const discount = Math.min(baseSubtotal, finite(current.discountAmount));
    const taxRate = 4.712;
    const taxMultiplier = 1 + taxRate / 100;
    const requiredTaxable = taxMultiplier > 0 ? targetTotal / taxMultiplier : targetTotal;
    const requiredSubtotal = Math.max(0, requiredTaxable + discount);
    const adjustment = Math.max(0, Math.round((requiredSubtotal - baseSubtotal) * 100) / 100);
    const lineItems = [...preserved];
    if (adjustment > 0.004) {
      lineItems.push({
        id: 'margin-target-adjustment',
        description: 'Margin target adjustment (' + targetMargin + '% gross margin)',
        quantity: 1,
        unitPrice: adjustment,
        amount: adjustment,
        custom: false,
      });
    }

    const subtotal = Math.round(lineItems.reduce((sum, line) => sum + finite(line.amount), 0) * 100) / 100;
    const discountAmount = Math.min(subtotal, finite(current.discountAmount));
    const taxableGross = lineItems.filter((line) => line.getExempt !== true).reduce((sum, line) => sum + finite(line.amount), 0);
    const taxableAfterDiscount = subtotal > 0
      ? Math.max(0, taxableGross - (discountAmount * taxableGross / subtotal))
      : 0;
    const taxAmount = Math.round(taxableAfterDiscount * taxRate) / 100;
    const total = Math.round((subtotal - discountAmount + taxAmount) * 100) / 100;

    const depositPercent = effectiveDepositPercent(current);
    const depositAmount = roundMoney(total * depositPercent / 100);
    const paymentSchedule = rebalancePaymentSchedule(
      current.paymentSchedule,
      total,
      depositAmount,
      record.customer?.eventDate || '',
    );

    record.proposal = {
      ...current,
      lineItems,
      subtotal,
      discountAmount,
      taxRate,
      taxAmount,
      total,
      depositPercent,
      depositAmount,
      paymentSchedule,
    };
    syncUncommittedBookingPayments(record, paymentSchedule);
    record.updatedAt = new Date().toISOString();
    records = await saveRecord(context, record, records);
    await appendEvent(context, {
      type: 'mobile_bar_margin_price_applied',
      recordId: record.id,
      quoteId: record.quoteId || '',
      packageId: record.packageId || '',
      detail: 'Applied ' + targetMargin + '% Mobile Bar target price: ' + total.toFixed(2) + '.',
    });
    return Response.json({ ok: true, record, targetMargin, targetTotal: total }, { headers: { 'Cache-Control': 'private, no-store' } });
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