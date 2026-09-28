import type { Context } from '@netlify/functions';
import { resolveTenant } from './tenant';
import { tenantStoreFor } from './tenant-storage';
import {
  configuredServiceItemId,
  getQuickBooksSettings,
  qboCreate,
  qboGet,
  qboQuery,
  qboUpdate,
} from './quickbooks';
import {
  addRecordToQuickBooksMatchIndexes,
  buildQuickBooksCustomerMatchEvidence,
  buildQuickBooksCrmSyncReconciliation,
  buildQuickBooksMatchIndexes,
  getLastQuickBooksCrmSyncPreview,
  getQuickBooksMatchOverrides,
  recordQuickBooksCrmSyncHistory,
  resolveQuickBooksCustomerMatch,
} from './quickbooks-crm-sync-review';

const CRM_RECORD_LIMIT = 1500;
const QUERY_PAGE_SIZE = 1000;
const QUERY_MAX_PAGES = 10;

function salesStore(context: Context) {
  return tenantStoreFor(context, resolveTenant(), 'sales');
}

function integrationStore(context: Context) {
  return tenantStoreFor(context, resolveTenant(), 'integrations');
}

function clean(value: unknown, max = 1200) {
  return String(value ?? '').trim().slice(0, max);
}

function isoDate(value: unknown) {
  const raw = clean(value, 80);
  if (!raw) return '';
  const parsed = new Date(raw.length === 10 ? raw + 'T12:00:00Z' : raw);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function money(value: unknown) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
}

function jsonClone<T = any>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeEmail(value: unknown) {
  return clean(value, 240).toLowerCase();
}

function normalizeName(value: unknown) {
  return clean(value, 240)
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+-\s+\d{4}-\d{2}-\d{2}\s*$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeDisplayName(value: unknown) {
  return clean(value, 240).toLowerCase().replace(/\s+/g, ' ');
}

function qboCustomerEmail(customer: any) {
  return clean(customer?.PrimaryEmailAddr?.Address, 240);
}

function qboCustomerPhone(customer: any) {
  return clean(customer?.PrimaryPhone?.FreeFormNumber || customer?.Mobile?.FreeFormNumber, 80);
}

function eventDateFromDisplayName(value: unknown) {
  const match = clean(value, 240).match(/\s+-\s+(\d{4}-\d{2}-\d{2})\s*$/);
  return match?.[1] || '';
}

function baseNameFromDisplayName(value: unknown) {
  return clean(value, 240).replace(/\s+-\s+\d{4}-\d{2}-\d{2}\s*$/, '').trim();
}

function expectedDisplayName(record: any) {
  const name = clean(record?.customer?.name, 180);
  const eventDate = isoDate(record?.customer?.eventDate);
  return clean(name + (eventDate ? ' - ' + eventDate : ''), 100);
}

function qboRecordIdHint(customer: any) {
  const notes = clean(customer?.Notes, 4000);
  const match = notes.match(/(?:Koa(?:’|')s Events CRM record|Koa CRM[:\s]+)\s*([A-Za-z0-9_.:-]{3,120})/i);
  return clean(match?.[1], 120);
}

function sanitizeQboRecordId(customerId: string) {
  const safe = clean(customerId, 100).replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-');
  return 'QBO-CUST-' + (safe || 'UNKNOWN');
}

function quickBooksState(record: any) {
  record.accounting ||= {};
  record.accounting.quickbooks ||= {};
  const state = record.accounting.quickbooks;
  state.customerId = clean(state.customerId, 100);
  state.customerDisplayName = clean(state.customerDisplayName, 240);
  state.estimates = Array.isArray(state.estimates) ? state.estimates : [];
  state.invoices = Array.isArray(state.invoices) ? state.invoices : [];
  state.payments = Array.isArray(state.payments) ? state.payments : [];
  return state;
}

function qboOrigin(record: any) {
  return clean(record?.accounting?.quickbooks?.origin, 40) === 'quickbooks' || clean(record?.source, 80) === 'quickbooks-import';
}

function transactionCustomerId(row: any) {
  return clean(row?.CustomerRef?.value, 100);
}

function transactionSortValue(row: any) {
  return Date.parse(clean(row?.MetaData?.LastUpdatedTime || row?.TxnDate || row?.MetaData?.CreateTime, 80)) || 0;
}

function newest<T = any>(rows: T[]) {
  return [...rows].sort((a: any, b: any) => transactionSortValue(b) - transactionSortValue(a))[0] as T | undefined;
}

function qboLines(row: any) {
  return (Array.isArray(row?.Line) ? row.Line : [])
    .filter((line: any) => clean(line?.DetailType, 80) === 'SalesItemLineDetail')
    .map((line: any) => ({
      id: clean(line?.Id, 100),
      description: clean(line?.Description, 600),
      amount: money(line?.Amount),
      quantity: Number(line?.SalesItemLineDetail?.Qty || 1),
      unitPrice: money(line?.SalesItemLineDetail?.UnitPrice ?? line?.Amount),
      itemId: clean(line?.SalesItemLineDetail?.ItemRef?.value, 100),
      itemName: clean(line?.SalesItemLineDetail?.ItemRef?.name, 240),
    }));
}

function normalizeEstimate(row: any) {
  return {
    estimateId: clean(row?.Id, 100),
    docNumber: clean(row?.DocNumber, 100),
    txnDate: isoDate(row?.TxnDate),
    expirationDate: isoDate(row?.ExpirationDate),
    total: money(row?.TotalAmt),
    status: clean(row?.TxnStatus || row?.EmailStatus || '', 80).toLowerCase(),
    emailStatus: clean(row?.EmailStatus, 80),
    privateNote: clean(row?.PrivateNote, 1000),
    lines: qboLines(row),
    lastUpdatedAt: clean(row?.MetaData?.LastUpdatedTime, 80),
  };
}

function normalizeInvoice(row: any, existing: any = null) {
  const total = money(row?.TotalAmt);
  const balance = money(row?.Balance ?? total);
  return {
    paymentId: clean(existing?.paymentId, 100) || ('qbo-invoice-' + clean(row?.Id, 100)),
    label: clean(existing?.label, 180) || ('QuickBooks invoice ' + clean(row?.DocNumber || row?.Id, 100)),
    invoiceId: clean(row?.Id, 100),
    docNumber: clean(row?.DocNumber, 100),
    txnDate: isoDate(row?.TxnDate),
    dueDate: isoDate(row?.DueDate),
    amount: total,
    total,
    balance,
    status: balance <= 0 ? 'paid' : 'open',
    paidAt: balance <= 0 ? clean(existing?.paidAt || row?.MetaData?.LastUpdatedTime, 80) : '',
    emailStatus: clean(row?.EmailStatus, 80),
    privateNote: clean(row?.PrivateNote, 1000),
    lines: qboLines(row),
    lastSyncedAt: new Date().toISOString(),
    lastUpdatedAt: clean(row?.MetaData?.LastUpdatedTime, 80),
  };
}

function normalizePayment(row: any) {
  const invoiceIds = (Array.isArray(row?.Line) ? row.Line : [])
    .flatMap((line: any) => Array.isArray(line?.LinkedTxn) ? line.LinkedTxn : [])
    .filter((linked: any) => clean(linked?.TxnType, 80).toLowerCase() === 'invoice')
    .map((linked: any) => clean(linked?.TxnId, 100))
    .filter(Boolean);
  return {
    paymentId: clean(row?.Id, 100),
    txnDate: isoDate(row?.TxnDate),
    total: money(row?.TotalAmt),
    invoiceIds: [...new Set(invoiceIds)],
    privateNote: clean(row?.PrivateNote, 1000),
    lastUpdatedAt: clean(row?.MetaData?.LastUpdatedTime, 80),
  };
}

function selectPrimaryEstimate(state: any, estimates: any[]) {
  if (state.estimateId) {
    const saved = estimates.find((row) => row.estimateId === String(state.estimateId));
    if (saved) return saved;
  }
  return estimates[0] || null;
}

function applyFinancialMirror(record: any, customer: any, estimateRows: any[], invoiceRows: any[], paymentRows: any[]) {
  const now = new Date().toISOString();
  const state = quickBooksState(record);
  const previousInvoices = new Map(
    (Array.isArray(state.invoices) ? state.invoices : [])
      .filter((row: any) => row?.invoiceId)
      .map((row: any) => [String(row.invoiceId), row]),
  );

  const estimates = estimateRows.map(normalizeEstimate).sort((a, b) =>
    String(b.txnDate || b.lastUpdatedAt || '').localeCompare(String(a.txnDate || a.lastUpdatedAt || '')),
  );
  const invoices = invoiceRows.map((row) => normalizeInvoice(row, previousInvoices.get(String(row?.Id || '')))).sort((a, b) =>
    String(b.txnDate || b.lastUpdatedAt || '').localeCompare(String(a.txnDate || a.lastUpdatedAt || '')),
  );
  const payments = paymentRows.map(normalizePayment).sort((a, b) =>
    String(b.txnDate || b.lastUpdatedAt || '').localeCompare(String(a.txnDate || a.lastUpdatedAt || '')),
  );

  state.customerId = clean(customer?.Id, 100);
  state.customerDisplayName = clean(customer?.DisplayName, 240);
  state.origin ||= qboOrigin(record) ? 'quickbooks' : 'crm';
  state.estimates = estimates;
  state.invoices = invoices;
  state.payments = payments;
  state.totalInvoiced = money(invoices.filter((row) => !['void','deleted'].includes(row.status)).reduce((sum, row) => sum + Number(row.total || 0), 0));
  state.balanceDue = money(invoices.filter((row) => !['void','deleted'].includes(row.status)).reduce((sum, row) => sum + Math.max(0, Number(row.balance || 0)), 0));
  state.totalPaid = money(invoices.filter((row) => !['void','deleted'].includes(row.status)).reduce((sum, row) => sum + Math.max(0, Number(row.total || 0) - Number(row.balance || 0)), 0));
  state.paymentTotal = money(payments.reduce((sum, row) => sum + Number(row.total || 0), 0));
  state.paymentSync = {
    count: payments.length,
    paymentIds: payments.map((row) => row.paymentId).filter(Boolean),
    lastSyncedAt: now,
  };

  const primaryEstimate = selectPrimaryEstimate(state, estimates);
  if (primaryEstimate) {
    state.estimateId = primaryEstimate.estimateId;
    state.estimateDocNumber = primaryEstimate.docNumber;
    state.estimateTotal = primaryEstimate.total;
    state.estimateEmailStatus = primaryEstimate.emailStatus;
    state.estimateLastSyncedAt = now;
  } else {
    state.estimateId = '';
    state.estimateDocNumber = '';
    state.estimateTotal = 0;
    state.estimateEmailStatus = '';
    state.estimateLastSyncedAt = now;
  }

  const firstInvoice = invoices[0];
  state.depositPaid = Boolean(firstInvoice && Number(firstInvoice.balance || 0) <= 0);
  state.depositPaidAt = state.depositPaid ? clean(firstInvoice?.paidAt || state.depositPaidAt || now, 80) : '';
  state.lastSyncedAt = now;

  if (!qboOrigin(record)) {
    record.updatedAt = now;
    return;
  }

  const displayName = clean(customer?.DisplayName, 240);
  const customerName = baseNameFromDisplayName(displayName) || displayName || record.id;
  record.customer ||= {};
  record.customer.name = customerName;
  record.customer.email = qboCustomerEmail(customer) || clean(record.customer.email, 240);
  record.customer.phone = qboCustomerPhone(customer) || clean(record.customer.phone, 80);
  record.customer.eventDate = eventDateFromDisplayName(displayName) || clean(record.customer.eventDate, 40);

  const hasPayment = payments.length > 0 || state.totalPaid > 0;
  const hasInvoice = invoices.length > 0;
  const hasEstimate = estimates.length > 0;
  record.kind = hasEstimate || hasInvoice || hasPayment ? 'proposal' : 'inquiry';
  // Financial history alone must never create an operational booking. The
  // existing CRM booking flow still requires the signed contract + deposit
  // rules before the project can move to Booked.
  record.stage = hasEstimate || hasInvoice || hasPayment ? 'proposal' : 'lead';
  record.status = hasEstimate || hasInvoice || hasPayment ? 'proposal' : 'lead';

  const proposalTotal = money(primaryEstimate?.total || invoices.reduce((sum, row) => sum + Number(row.total || 0), 0));
  if (hasEstimate || hasInvoice || hasPayment) {
    const schedule = invoices.map((row) => ({
      id: row.paymentId,
      label: row.label,
      dueDate: row.dueDate || row.txnDate || '',
      amount: Number(row.total || 0),
    }));
    const issuedTotal = money(schedule.reduce((sum, row) => sum + Number(row.amount || 0), 0));
    if (proposalTotal > issuedTotal + 0.009) {
      schedule.push({
        id: 'qbo-uninvoiced-balance',
        label: 'Uninvoiced balance',
        dueDate: '',
        amount: money(proposalTotal - issuedTotal),
      });
    }

    record.proposal = {
      ...(record.proposal || {}),
      status: hasInvoice || hasPayment ? 'accepted' : 'sent',
      subtotal: proposalTotal,
      discountAmount: 0,
      taxAmount: 0,
      total: proposalTotal,
      paymentSchedule: schedule,
      lineItems: primaryEstimate?.lines?.map((line: any) => ({
        description: line.description || line.itemName || 'QuickBooks item',
        quantity: Number(line.quantity || 1),
        unitPrice: Number(line.unitPrice || 0),
        amount: Number(line.amount || 0),
        quickBooksItemId: line.itemId || '',
      })) || [],
      source: 'quickbooks-import',
    };

    // Keep imported invoice/payment milestones in the accounting mirror and
    // proposal schedule. Do not synthesize a booking object from accounting
    // history because Event Ops is gated by the real contract workflow.
  }

  record.updatedAt = now;
}

async function qboRows(context: Context, entity: 'Customer'|'Estimate'|'Invoice'|'Payment') {
  const rows: any[] = [];
  for (let page = 0; page < QUERY_MAX_PAGES; page += 1) {
    const start = page * QUERY_PAGE_SIZE + 1;
    const data: any = await qboQuery(context, `select * from ${entity} startposition ${start} maxresults ${QUERY_PAGE_SIZE}`);
    const batch = Array.isArray(data?.QueryResponse?.[entity]) ? data.QueryResponse[entity] : [];
    rows.push(...batch);
    if (batch.length < QUERY_PAGE_SIZE) break;
  }
  return rows;
}

function proposalLines(record: any, fallbackItemId: string) {
  const proposal = record?.proposal || {};
  const raw = Array.isArray(proposal.lineItems) ? proposal.lineItems : [];
  const lines = raw.length ? raw.map((line: any) => {
    const quantity = Math.max(1, Number(line.quantity || 1));
    const amount = money(line.amount || quantity * Number(line.unitPrice || 0));
    const itemId = clean(line.quickBooksItemId, 100) || fallbackItemId;
    return {
      Amount: amount,
      DetailType: 'SalesItemLineDetail',
      Description: clean(line.description, 400),
      SalesItemLineDetail: {
        ItemRef: { value: itemId },
        Qty: quantity,
        UnitPrice: quantity ? money(amount / quantity) : amount,
      },
    };
  }) : [{
    Amount: money(proposal.subtotal || proposal.total || 0),
    DetailType: 'SalesItemLineDetail',
    Description: 'Koa’s Events CRM ' + clean(record.id, 100),
    SalesItemLineDetail: {
      ItemRef: { value: fallbackItemId },
      Qty: 1,
      UnitPrice: money(proposal.subtotal || proposal.total || 0),
    },
  }];

  const getAmount = Math.max(0, money(proposal.taxAmount || 0));
  if (getAmount > 0) {
    lines.push({
      Amount: getAmount,
      DetailType: 'SalesItemLineDetail',
      Description: clean(proposal.taxLabel || 'Hawaiʻi GET', 400),
      SalesItemLineDetail: {
        ItemRef: { value: fallbackItemId },
        Qty: 1,
        UnitPrice: getAmount,
      },
    });
  }
  return lines;
}

async function syncCustomerOutbound(context: Context, record: any, customerById: Map<string, any>) {
  const state = quickBooksState(record);
  const desiredDisplayName = expectedDisplayName(record) || clean(record.id, 100);
  const email = clean(record?.customer?.email, 240);
  const phone = clean(record?.customer?.phone, 80);
  let customer = state.customerId ? customerById.get(String(state.customerId)) : null;

  if (!customer && state.customerId) {
    try {
      const data: any = await qboGet(context, 'customer', String(state.customerId));
      customer = data?.Customer || null;
    } catch {}
  }

  if (!customer) {
    const created: any = await qboCreate(context, 'customer', {
      DisplayName: desiredDisplayName,
      PrimaryEmailAddr: email ? { Address: email } : undefined,
      PrimaryPhone: phone ? { FreeFormNumber: phone } : undefined,
      Notes: 'Koa’s Events CRM record ' + clean(record.id, 100) + (isoDate(record?.customer?.eventDate) ? ' · Event ' + isoDate(record.customer.eventDate) : ''),
    });
    customer = created?.Customer;
    if (!customer?.Id) throw new Error('QuickBooks customer could not be created.');
    customerById.set(String(customer.Id), customer);
    state.customerId = String(customer.Id);
    state.customerDisplayName = String(customer.DisplayName || desiredDisplayName);
    state.origin = 'crm';
    return { customer, created: true, updated: false };
  }

  const patch: any = {
    Id: String(customer.Id),
    SyncToken: String(customer.SyncToken ?? ''),
  };
  let changed = false;

  if (desiredDisplayName && clean(customer.DisplayName, 100) !== desiredDisplayName) {
    patch.DisplayName = desiredDisplayName;
    changed = true;
  }
  if (email && normalizeEmail(customer?.PrimaryEmailAddr?.Address) !== normalizeEmail(email)) {
    patch.PrimaryEmailAddr = { Address: email };
    changed = true;
  }
  if (phone && clean(customer?.PrimaryPhone?.FreeFormNumber, 80) !== phone) {
    patch.PrimaryPhone = { FreeFormNumber: phone };
    changed = true;
  }

  if (changed && customer.SyncToken != null) {
    const updated: any = await qboUpdate(context, 'customer', patch);
    customer = updated?.Customer || customer;
    customerById.set(String(customer.Id), customer);
  }

  state.customerId = String(customer.Id);
  state.customerDisplayName = String(customer.DisplayName || desiredDisplayName);
  state.origin = 'crm';
  return { customer, created: false, updated: changed };
}

async function syncEstimateOutbound(
  context: Context,
  record: any,
  customer: any,
  serviceItemId: string,
  estimateById: Map<string, any>,
) {
  const state = quickBooksState(record);
  const proposal = record?.proposal;
  if (!proposal || money(proposal.total) <= 0) return { skipped: true, reason: 'no-proposal' };
  const status = clean(proposal.status, 80).toLowerCase();
  if (!state.estimateId && !['sent','accepted','booked'].includes(status)) {
    return { skipped: true, reason: 'proposal-not-issued' };
  }
  if (!serviceItemId) return { skipped: true, reason: 'service-item-not-configured' };

  const payload: any = {
    CustomerRef: { value: String(customer.Id) },
    TxnDate: isoDate(proposal.txnDate) || new Date().toISOString().slice(0, 10),
    ExpirationDate: isoDate(proposal.expirationDate) || undefined,
    BillEmail: record.customer?.email ? { Address: clean(record.customer.email, 240) } : undefined,
    CustomerMemo: { value: 'Koa’s Events proposal ' + clean(record.id, 100) },
    PrivateNote: 'Koa CRM: ' + clean(record.id, 100) + (record.quoteId ? ' · Quote ' + clean(record.quoteId, 100) : ''),
    Line: proposalLines(record, serviceItemId),
    DiscountAmt: money(proposal.discountAmount) || undefined,
  };

  let estimate = state.estimateId ? estimateById.get(String(state.estimateId)) : null;
  if (!estimate && state.estimateId) {
    try {
      const data: any = await qboGet(context, 'estimate', String(state.estimateId));
      estimate = data?.Estimate || null;
    } catch {}
  }

  let created = false;
  if (estimate?.Id && estimate?.SyncToken != null) {
    const updated: any = await qboUpdate(context, 'estimate', {
      Id: String(estimate.Id),
      SyncToken: String(estimate.SyncToken),
      ...payload,
    });
    estimate = updated?.Estimate || estimate;
  } else {
    const result: any = await qboCreate(context, 'estimate', payload);
    estimate = result?.Estimate;
    created = true;
  }

  if (!estimate?.Id) throw new Error('QuickBooks estimate could not be synchronized.');
  estimateById.set(String(estimate.Id), estimate);

  const normalized = normalizeEstimate(estimate);
  const estimates = Array.isArray(state.estimates) ? state.estimates.filter((row: any) => row.estimateId !== normalized.estimateId) : [];
  state.estimates = [normalized, ...estimates];
  state.estimateId = normalized.estimateId;
  state.estimateDocNumber = normalized.docNumber;
  state.estimateTotal = normalized.total;
  state.estimateEmailStatus = normalized.emailStatus;
  state.estimateLastSyncedAt = new Date().toISOString();
  state.lastSyncedAt = state.estimateLastSyncedAt;
  return { skipped: false, created, estimate };
}

function mapUnique<T>(items: T[], key: (item: T) => string) {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    if (!value) continue;
    const list = map.get(value) || [];
    list.push(item);
    map.set(value, list);
  }
  return map;
}

function groupByCustomer(rows: any[]) {
  const map = new Map<string, any[]>();
  for (const row of rows) {
    const customerId = transactionCustomerId(row);
    if (!customerId) continue;
    const list = map.get(customerId) || [];
    list.push(row);
    map.set(customerId, list);
  }
  return map;
}

async function writeRecords(context: Context, records: any[], changedRecordIds: Set<string>) {
  const store = salesStore(context);
  const changed = records.filter((record) => changedRecordIds.has(String(record.id)));
  for (let offset = 0; offset < changed.length; offset += 25) {
    await Promise.all(changed.slice(offset, offset + 25).map((record) =>
      store.setJSON('records/' + record.id, record),
    ));
  }
  await store.setJSON('records/index', records.slice(0, CRM_RECORD_LIMIT));
}

function crmSyncSnapshot(record: any) {
  const qbo = record?.accounting?.quickbooks || {};
  return {
    recordId: clean(record?.id, 120),
    stage: clean(record?.stage || record?.kind, 80),
    status: clean(record?.status, 80),
    customer: {
      name: clean(record?.customer?.name, 180),
      email: clean(record?.customer?.email, 240),
      phone: clean(record?.customer?.phone, 80),
      eventDate: clean(record?.customer?.eventDate, 40),
    },
    proposal: record?.proposal ? {
      status: clean(record.proposal.status, 80),
      total: money(record.proposal.total),
    } : null,
    quickbooks: {
      customerId: clean(qbo.customerId, 100),
      estimateId: clean(qbo.estimateId, 100),
      estimateDocNumber: clean(qbo.estimateDocNumber, 100),
      estimateTotal: money(qbo.estimateTotal),
      invoiceCount: Array.isArray(qbo.invoices) ? qbo.invoices.length : 0,
      paymentCount: Array.isArray(qbo.payments) ? qbo.payments.length : 0,
      totalInvoiced: money(qbo.totalInvoiced),
      totalPaid: money(qbo.totalPaid),
      balanceDue: money(qbo.balanceDue),
    },
  };
}

function qboCustomerSnapshot(customer: any) {
  if (!customer) return null;
  return {
    id: clean(customer?.Id, 100),
    displayName: clean(customer?.DisplayName, 240),
    email: clean(customer?.PrimaryEmailAddr?.Address, 240),
    phone: clean(customer?.PrimaryPhone?.FreeFormNumber, 80),
  };
}

function qboEstimateSnapshot(estimate: any) {
  if (!estimate) return null;
  return {
    id: clean(estimate?.Id, 100),
    docNumber: clean(estimate?.DocNumber, 100),
    total: money(estimate?.TotalAmt),
    expirationDate: isoDate(estimate?.ExpirationDate),
    email: clean(estimate?.BillEmail?.Address, 240),
    emailStatus: clean(estimate?.EmailStatus, 80),
  };
}

async function appendSyncEvent(context: Context, result: any) {
  const store = salesStore(context);
  const current = ((await store.get('analytics/events/index', { type: 'json' })) || []) as any[];
  const id = 'EVT-QBO-SYNC-' + Date.now().toString(36).toUpperCase();
  await store.setJSON('analytics/events/index', [{
    id,
    type: 'quickbooks_two_way_sync',
    recordId: '',
    quoteId: '',
    createdAt: result.completedAt,
    detail: 'QuickBooks two-way sync completed. ' +
      result.crm.created + ' CRM customer(s) imported, ' +
      result.crm.matched + ' customer(s) matched, ' +
      result.qbo.estimates + ' estimate(s), ' +
      result.qbo.invoices + ' invoice(s), and ' +
      result.qbo.payments + ' payment(s) mirrored.',
  }, ...current].slice(0, 10000));
}

export async function getLastQuickBooksCrmSync(context: Context) {
  return await integrationStore(context).get('quickbooks/manual-sync-last', { type: 'json' }) as any;
}

export async function runQuickBooksCrmTwoWaySync(context: Context, actor = '', previewId = '') {
  const startedAt = new Date().toISOString();
  const store = salesStore(context);
  const existingRecords = ((await store.get('records/index', { type: 'json' })) || []) as any[];
  const records = existingRecords.filter(Boolean).slice(0, CRM_RECORD_LIMIT);
  const recordsBefore = records.length;
  const recordsBeforeById = new Map(records.map((record) => [String(record.id), jsonClone(record)]));

  // Pull all supported accounting entities first. This gives the sync a stable
  // financial snapshot while CRM-origin writes happen later in the same run.
  const customers = await qboRows(context, 'Customer');
  const estimates = await qboRows(context, 'Estimate');
  const invoices = await qboRows(context, 'Invoice');
  const payments = await qboRows(context, 'Payment');

  const estimateGroups = groupByCustomer(estimates);
  const invoiceGroups = groupByCustomer(invoices);
  const paymentGroups = groupByCustomer(payments);
  const customerById = new Map(customers.filter((row) => row?.Id).map((row) => [String(row.Id), row]));
  const estimateById = new Map(estimates.filter((row) => row?.Id).map((row) => [String(row.Id), row]));

  const matchOverrides = await getQuickBooksMatchOverrides(context);
  const matchIndexes = buildQuickBooksMatchIndexes(records);

  const changedRecordIds = new Set<string>();
  const importedRecordIds: string[] = [];
  const matchedRecordIds = new Set<string>();
  const conflicts: any[] = [];
  const warnings: string[] = [];
  const changes: any[] = [];
  let skippedCapacity = 0;
  let skippedAmbiguous = 0;
  let skippedUnapprovedNew = 0;
  let skippedExcluded = 0;
  const customerOutcomes: any[] = [];
  const outboundOutcomes: any[] = [];

  for (const customer of customers) {
    const customerId = clean(customer?.Id, 100);
    if (!customerId) continue;

    const estimateRows = estimateGroups.get(customerId) || [];
    const invoiceRows = invoiceGroups.get(customerId) || [];
    const paymentRows = paymentGroups.get(customerId) || [];
    const matchEvidence = buildQuickBooksCustomerMatchEvidence(estimateRows, invoiceRows, paymentRows);
    const match = resolveQuickBooksCustomerMatch(customer, matchIndexes, matchOverrides, matchEvidence);
    if (match.status === 'excluded') {
      skippedExcluded += 1;
      customerOutcomes.push({
        customerId,
        name: clean(customer?.DisplayName, 240),
        outcome: 'excluded',
        recordId: '',
        detail: clean(match?.exclusion?.reason || 'Excluded from CRM synchronization by staff.', 500),
      });
      continue;
    }
    if (match.status === 'ambiguous') {
      skippedAmbiguous += 1;
      customerOutcomes.push({
        customerId,
        name: clean(customer?.DisplayName, 240),
        outcome: 'blocked_duplicate',
        recordId: '',
      });
      conflicts.push({
        type: 'ambiguous-customer-match',
        quickBooksCustomerId: customerId,
        quickBooksCustomerName: clean(customer?.DisplayName, 240),
        quickBooksEmail: qboCustomerEmail(customer),
        duplicateRisk: match.duplicateRisk,
        candidates: match.candidates,
        detail: 'CRM duplicate evidence requires staff review before this QuickBooks customer can be imported or linked.',
      });
      continue;
    }
    if (match.status === 'new') {
      skippedUnapprovedNew += 1;
      customerOutcomes.push({
        customerId,
        name: clean(customer?.DisplayName, 240),
        outcome: 'skip_unapproved',
        recordId: '',
      });
      conflicts.push({
        type: 'unapproved-new-customer',
        quickBooksCustomerId: customerId,
        quickBooksCustomerName: clean(customer?.DisplayName, 240),
        quickBooksEmail: qboCustomerEmail(customer),
        duplicateRisk: match.duplicateRisk,
        detail: 'This QuickBooks customer was not explicitly approved as a new CRM import. It was not imported.',
      });
      continue;
    }

    let record = match.record || null;
    const beforeRecord = record ? crmSyncSnapshot(record) : null;

    if (!record) {
      if (records.length >= CRM_RECORD_LIMIT) {
        skippedCapacity += 1;
        customerOutcomes.push({
          customerId,
          name: clean(customer?.DisplayName, 240),
          outcome: 'skip_capacity',
          recordId: '',
        });
        continue;
      }
      let recordId = sanitizeQboRecordId(customerId);
      let counter = 2;
      while (matchIndexes.recordsById.has(recordId)) {
        recordId = sanitizeQboRecordId(customerId) + '-' + counter;
        counter += 1;
      }
      const now = new Date().toISOString();
      record = {
        id: recordId,
        quoteId: '',
        kind: 'inquiry',
        stage: 'lead',
        status: 'lead',
        source: 'quickbooks-import',
        businessLine: 'events',
        createdAt: clean(customer?.MetaData?.CreateTime, 80) || now,
        updatedAt: now,
        customer: {
          name: baseNameFromDisplayName(customer?.DisplayName) || clean(customer?.DisplayName, 180) || recordId,
          email: qboCustomerEmail(customer),
          phone: qboCustomerPhone(customer),
          eventDate: eventDateFromDisplayName(customer?.DisplayName),
        },
        inquiry: {
          eventType: '',
          details: 'Imported from QuickBooks Online.',
        },
        cleanupReview: {
          verdict: 'legitimate',
          reviewedAt: now,
          reviewedBy: clean(actor, 180) || 'QuickBooks sync',
        },
        accounting: {
          quickbooks: {
            origin: 'quickbooks',
            customerId,
            customerDisplayName: clean(customer?.DisplayName, 240),
            estimates: [],
            invoices: [],
            payments: [],
          },
        },
      };
      records.push(record);
      importedRecordIds.push(recordId);
      addRecordToQuickBooksMatchIndexes(matchIndexes, record);
    } else {
      matchedRecordIds.add(String(record.id));
      const existingCustomerId = clean(record?.accounting?.quickbooks?.customerId, 100);
      if (existingCustomerId && existingCustomerId !== customerId) {
        customerOutcomes.push({
          customerId,
          name: clean(customer?.DisplayName, 240),
          outcome: 'blocked_link_conflict',
          recordId: String(record.id),
        });
        conflicts.push({
          type: 'customer-link',
          recordId: String(record.id),
          crmQuickBooksCustomerId: existingCustomerId,
          incomingQuickBooksCustomerId: customerId,
          detail: 'The CRM record is already linked to a different QuickBooks customer. The existing link was preserved.',
        });
        continue;
      }
    }

    applyFinancialMirror(
      record,
      customer,
      estimateRows,
      invoiceRows,
      paymentRows,
    );
    addRecordToQuickBooksMatchIndexes(matchIndexes, record);
    changedRecordIds.add(String(record.id));
    customerOutcomes.push({
      customerId,
      name: clean(customer?.DisplayName, 240),
      outcome: beforeRecord ? 'match_refresh' : 'create',
      recordId: clean(record.id, 120),
    });

    const afterRecord = crmSyncSnapshot(record);
    if (!beforeRecord || JSON.stringify(beforeRecord) !== JSON.stringify(afterRecord)) {
      changes.push({
        direction: 'QuickBooks → CRM',
        system: 'CRM',
        action: beforeRecord ? 'updated' : 'created',
        recordId: clean(record.id, 120),
        clientName: clean(record?.customer?.name, 180),
        quickBooksCustomerId: customerId,
        matchDecision: match.status,
        matchReason: match.reason,
        before: beforeRecord,
        after: afterRecord,
      });
    }
  }

  const settings = await getQuickBooksSettings(context);
  const serviceItemId = clean(settings?.serviceItemId || configuredServiceItemId(), 100);
  const pushed = {
    customersCreated: 0,
    customersUpdated: 0,
    estimatesCreated: 0,
    estimatesUpdated: 0,
    estimatesSkippedNoServiceItem: 0,
  };

  // Operational CRM data can update customer contact details and issued
  // proposals in QuickBooks. Invoices and payments stay QuickBooks-owned so
  // a bulk button can never manufacture an invoice or cash receipt.
  for (const record of records) {
    if (qboOrigin(record)) continue;
    const hasProposal = Boolean(record?.proposal);
    const hasQboLink = Boolean(record?.accounting?.quickbooks?.customerId);
    if (!hasProposal && !hasQboLink) continue;

    try {
      const stateBefore = quickBooksState(record);
      const existingCustomer = stateBefore.customerId ? customerById.get(String(stateBefore.customerId)) : null;
      const beforeCustomer = qboCustomerSnapshot(existingCustomer);
      const beforeEstimateId = clean(stateBefore.estimateId, 100);
      const beforeEstimate = beforeEstimateId ? qboEstimateSnapshot(estimateById.get(beforeEstimateId)) : null;

      const customerSync = await syncCustomerOutbound(context, record, customerById);
      if (customerSync.created) pushed.customersCreated += 1;
      if (customerSync.updated) pushed.customersUpdated += 1;
      outboundOutcomes.push({
        recordId:clean(record.id,120),
        name:clean(record?.customer?.name,180),
        type:'customer',
        action:customerSync.created ? 'create' : customerSync.updated ? 'update' : 'no_change',
      });
      changedRecordIds.add(String(record.id));

      const afterCustomer = qboCustomerSnapshot(customerSync.customer);
      if (JSON.stringify(beforeCustomer) !== JSON.stringify(afterCustomer)) {
        changes.push({
          direction: 'CRM → QuickBooks',
          system: 'QuickBooks',
          action: beforeCustomer ? 'customer_updated' : 'customer_created',
          recordId: clean(record.id, 120),
          clientName: clean(record?.customer?.name, 180),
          before: beforeCustomer,
          after: afterCustomer,
        });
      }

      if (hasProposal) {
        const estimateSync = await syncEstimateOutbound(
          context,
          record,
          customerSync.customer,
          serviceItemId,
          estimateById,
        );
        if (estimateSync.reason === 'service-item-not-configured') {
          pushed.estimatesSkippedNoServiceItem += 1;
          outboundOutcomes.push({
            recordId:clean(record.id,120),
            name:clean(record?.customer?.name,180),
            type:'estimate',
            action:'blocked',
            reason:'service-item-not-configured',
          });
        } else if (!estimateSync.skipped) {
          if (estimateSync.created) pushed.estimatesCreated += 1;
          else pushed.estimatesUpdated += 1;
          outboundOutcomes.push({
            recordId:clean(record.id,120),
            name:clean(record?.customer?.name,180),
            type:'estimate',
            action:estimateSync.created ? 'create' : 'update',
          });

          const afterEstimate = qboEstimateSnapshot(estimateSync.estimate);
          if (JSON.stringify(beforeEstimate) !== JSON.stringify(afterEstimate)) {
            changes.push({
              direction: 'CRM → QuickBooks',
              system: 'QuickBooks',
              action: beforeEstimate ? 'estimate_updated' : 'estimate_created',
              recordId: clean(record.id, 120),
              clientName: clean(record?.customer?.name, 180),
              before: beforeEstimate,
              after: afterEstimate,
            });
          }
        } else {
          outboundOutcomes.push({
            recordId:clean(record.id,120),
            name:clean(record?.customer?.name,180),
            type:'estimate',
            action:'no_change',
            reason:clean(estimateSync.reason,120),
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? clean(error.message, 600) : 'QuickBooks outbound sync failed.';
      outboundOutcomes.push({
        recordId:clean(record?.id,120),
        name:clean(record?.customer?.name,180),
        type:'outbound',
        action:'error',
        reason:message,
      });
      warnings.push(
        clean(record?.customer?.name || record?.id, 180) + ': ' + message,
      );
    }
  }

  const completedAt = new Date().toISOString();
  const recoveryRecords = records
    .filter((record) => changedRecordIds.has(String(record.id)))
    .map((record) => ({
      recordId: clean(record?.id, 120),
      clientName: clean(record?.customer?.name, 180),
      before: recordsBeforeById.has(String(record.id)) ? recordsBeforeById.get(String(record.id)) : null,
      after: jsonClone(record),
      createdBySync: !recordsBeforeById.has(String(record.id)),
    }));

  const syncId = 'QBSYNC-' + Date.now().toString(36).toUpperCase() + '-' + idSuffix();
  const result = {
    syncId,
    previewId: clean(previewId, 120),
    status: 'completed',
    startedAt,
    completedAt,
    actor: clean(actor, 180),
    qbo: {
      customers: customers.length,
      estimates: estimates.length,
      invoices: invoices.length,
      payments: payments.length,
    },
    crm: {
      recordsBefore,
      recordsAfter: records.length,
      created: importedRecordIds.length,
      matched: matchedRecordIds.size,
      updated: changedRecordIds.size,
    },
    pushed,
    skipped: {
      capacity: skippedCapacity,
      ambiguous: skippedAmbiguous,
      unapprovedNew: skippedUnapprovedNew,
      excluded: skippedExcluded,
    },
    customerOutcomes,
    outboundOutcomes,
    conflicts,
    warnings,
    changes,
    recovery: {
      version: 1,
      crmOnly: true,
      capturedAt: completedAt,
      records: recoveryRecords,
    },
  };

  const preview = await getLastQuickBooksCrmSyncPreview(context);
  if (preview?.previewId && clean(preview.previewId,120) === clean(previewId,120)) {
    (result as any).reconciliation = buildQuickBooksCrmSyncReconciliation(preview, result);
  } else {
    (result as any).reconciliation = {
      previewId:clean(previewId,120),
      status:'attention',
      deviationCount:1,
      countComparisons:[],
      customerComparisons:[],
      outboundComparisons:[],
      deviations:[{ type:'preview-unavailable', detail:'The exact Preview Sync snapshot was unavailable when post-sync reconciliation ran.' }],
    };
  }

  await writeRecords(context, records, changedRecordIds);
  const integrations = integrationStore(context);

  // Full recovery snapshots belong only in the per-sync detail record. Keeping
  // them out of the lightweight last/history blobs avoids duplicating entire
  // CRM records in frequently-read integration state.
  await recordQuickBooksCrmSyncHistory(context, result);
  const recoverySummary = {
    version: result.recovery.version,
    crmOnly: true,
    capturedAt: result.recovery.capturedAt,
    recordCount: result.recovery.records.length,
  };
  const lightweightResult = { ...result, recovery: recoverySummary };
  await integrations.setJSON('quickbooks/manual-sync-last', lightweightResult);
  const history = ((await integrations.get('quickbooks/manual-sync-history', { type: 'json' })) || []) as any[];
  await integrations.setJSON('quickbooks/manual-sync-history', [lightweightResult, ...history].slice(0, 100));
  await appendSyncEvent(context, lightweightResult);
  return lightweightResult;
}
