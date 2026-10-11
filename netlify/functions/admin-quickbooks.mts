import type { Context, Config } from '@netlify/functions';
import { hasCapability, requireCapability } from './_shared/admin';
import { sendAccountingTransitionAlerts } from './_shared/accounting-alerts';
import { clientTenantProfile, resolveTenant, tenantTaxDefaults } from './_shared/tenant';
import { tenantStoreFor } from './_shared/tenant-storage';
import { buildQuickBooksEstimateLines, quickBooksEstimateLineFingerprint } from './_shared/quickbooks-estimate-lines.mjs';
import { buildQuickBooksMilestoneInvoiceLine } from './_shared/quickbooks-accounting-invariant.mjs';
import { evaluateInvoiceRepairCandidate, invoicePaymentProtection } from './_shared/quickbooks-accounting-repair-safety.mjs';
import { currentBookingStatus, quickBooksAccountingScope } from './_shared/quickbooks-accounting-scope.mjs';
import {
  continueQuickBooksCrmTwoWaySyncJob,
  getCurrentQuickBooksCrmSyncJob,
  getLastQuickBooksCrmSync,
  getLastQuickBooksCrmSyncFailure,
  startQuickBooksCrmTwoWaySyncJob,
} from './_shared/quickbooks-crm-sync';
import { buildQuickBooksCrmPreviewCsv, buildQuickBooksCrmPreviewPdf } from './_shared/quickbooks-crm-sync-export';
import { buildAccountingRepairBulkPreviewCsv, buildAccountingRepairBulkPreviewPdf } from './_shared/quickbooks-accounting-repair-export';
import {
  buildQuickBooksCrmSyncPreview,
  getLastQuickBooksCrmSyncPreview,
  getQuickBooksCrmSyncHistory,
  getQuickBooksCrmSyncHistoryDetail,
  previewQuickBooksCrmSyncRollback,
  applyQuickBooksCrmSyncRollback,
  saveQuickBooksMatchOverride,
  saveQuickBooksBulkNewOverrides,
  saveQuickBooksBulkExclusionOverrides,
  getQuickBooksSuggestedExclusionRules,
  getQuickBooksSuggestedExclusionDismissalCount,
  saveQuickBooksSuggestedExclusionRules,
  resetQuickBooksSuggestedExclusionRules,
  dismissQuickBooksSuggestedExclusion,
  clearQuickBooksSuggestedExclusionDismissals,
  validateQuickBooksCrmSyncPreview,
} from './_shared/quickbooks-crm-sync-review';
import {
  completeOAuth,
  createOAuthState,
  disconnectQuickBooks,
  getQuickBooksCatalog,
  getQuickBooksConnection,
  getQuickBooksDamageDepositSettings,
  getQuickBooksDepositSettings,
  getQuickBooksGetSettings,
  getQuickBooksSettings,
  qboCreate,
  qboGet,
  qboQuery,
  qboSend,
  qboUpdate,
  qboOperation,
  quickBooksConfiguration,
  saveQuickBooksCatalog,
  saveQuickBooksDamageDepositSettings,
  saveQuickBooksDepositSettings,
  saveQuickBooksGetSettings,
  saveQuickBooksSettings,
} from './_shared/quickbooks';

function salesStoreFor(context: Context) {
  return tenantStoreFor(context, resolveTenant(), 'sales');
}

function integrationStoreFor(context: Context) {
  return tenantStoreFor(context, resolveTenant(), 'integrations');
}

function clean(value: unknown, max = 1200) {
  return String(value || '').trim().slice(0, max);
}

function isoDate(value: unknown) {
  const raw = clean(value, 40);
  if (!raw) return '';
  const parsed = new Date(raw.length === 10 ? raw + 'T12:00:00Z' : raw);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function escapeQbo(value: string) {
  return String(value || '').replace(/'/g, "\\'");
}

function idSuffix() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export async function readQuickBooksSalesRecords(context: Context) {
  return ((await salesStoreFor(context).get('records/index', { type: 'json' })) || []) as any[];
}

export async function saveQuickBooksSalesRecord(context: Context, record: any, records: any[]) {
  const store = salesStoreFor(context);
  const next = records.map((entry) => entry.id === record.id ? record : entry);
  await store.setJSON('records/' + record.id, record);
  await store.setJSON('records/index', next.slice(0, 1500));
  return next;
}

async function appendEvent(context: Context, event: Record<string, unknown>) {
  const store = salesStoreFor(context);
  const current = (await store.get('analytics/events/index', { type: 'json' })) || [];
  await store.setJSON('analytics/events/index', [{
    id: 'EVT-' + idSuffix(),
    createdAt: new Date().toISOString(),
    ...event,
  }, ...current].slice(0, 10000));
}

function quickBooksState(record: any) {
  record.accounting ||= {};
  record.accounting.quickbooks ||= {
    customerId: '',
    customerDisplayName: '',
    estimateId: '',
    estimateDocNumber: '',
    estimateTotal: 0,
    estimateEmailStatus: '',
    estimateLastSyncedAt: '',
    invoices: [],
    lastSyncedAt: '',
  };
  record.accounting.quickbooks.invoices ||= [];
  return record.accounting.quickbooks;
}

function offsetDate(date: unknown, days: number) {
  const raw = isoDate(date);
  if (!raw) return '';
  const parsed = new Date(raw + 'T12:00:00Z');
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function ensureDamageDepositState(record: any, settings: any, tenant: any) {
  record.accounting ||= {};
  const current = record.accounting.damageDeposit || {};
  const defaultRentalType = tenant?.accounting?.damageDeposit?.defaultRentalType === 'weekend' ? 'weekend' : 'one-day';
  const rentalType = ['one-day','weekend'].includes(String(current.rentalType || ''))
    ? String(current.rentalType)
    : defaultRentalType;
  const configuredAmount = rentalType === 'weekend' ? settings.weekendAmount : settings.oneDayAmount;
  const amount = Math.max(0, roundMoney(current.amount ?? configuredAmount));
  const dueDate = clean(current.dueDate, 40)
    || offsetDate(record?.customer?.eventDate, -Math.max(0, Number(settings.dueDaysBefore || 30)));
  const refundDueDate = clean(current.refundDueDate, 40)
    || offsetDate(record?.customer?.eventDate, Math.max(0, Number(settings.refundWithinDays || 14)));
  const deductionAmount = Math.min(amount, Math.max(0, roundMoney(current.deductionAmount || 0)));
  const state = record.accounting.damageDeposit = {
    rentalType,
    amount,
    dueDate,
    refundDueDate,
    status: clean(current.status || 'not_invoiced', 40),
    invoiceId: clean(current.invoiceId, 100),
    invoiceDocNumber: clean(current.invoiceDocNumber, 100),
    invoiceBalance: current.invoiceBalance == null ? amount : Math.max(0, roundMoney(current.invoiceBalance || 0)),
    paidAt: clean(current.paidAt, 80),
    deductionAmount,
    deductionReason: clean(current.deductionReason, 1000),
    deductionJournalEntryId: clean(current.deductionJournalEntryId, 100),
    refundAmount: Math.max(0, roundMoney(current.refundAmount ?? (amount - deductionAmount))),
    refundTransactionId: clean(current.refundTransactionId, 100),
    refundedAt: clean(current.refundedAt, 80),
    lastSyncedAt: clean(current.lastSyncedAt, 80),
  };
  return state;
}

async function syncDamageDepositInvoice(context: Context, record: any, settings: any, tenant: any) {
  const state = ensureDamageDepositState(record, settings, tenant);
  if (!state.invoiceId) return state;
  const data: any = await qboGet(context, 'invoice', state.invoiceId);
  const invoice = data?.Invoice;
  if (invoice) {
    state.invoiceDocNumber = String(invoice.DocNumber || state.invoiceDocNumber || '');
    state.invoiceBalance = Math.max(0, roundMoney(invoice.Balance ?? state.invoiceBalance ?? state.amount));
    state.lastSyncedAt = new Date().toISOString();
    if (state.refundTransactionId) state.status = state.deductionAmount > 0 ? 'refunded_with_deduction' : 'refunded';
    else if (state.invoiceBalance <= 0.005) {
      state.status = state.deductionAmount > 0 ? 'paid_with_pending_resolution' : 'paid';
      state.paidAt ||= new Date().toISOString();
    } else {
      state.status = 'invoiced';
    }
  }
  return state;
}

function proposalLines(record: any, itemId: string) {
  return buildQuickBooksEstimateLines(record, itemId);
}

async function ensureCustomer(context: Context, record: any) {
  const state = quickBooksState(record);
  if (state.customerId) {
    try {
      const data: any = await qboGet(context, 'customer', state.customerId);
      const customer = data?.Customer;
      if (customer?.Id) return customer;
    } catch {}
  }

  const baseName = clean(record.customer?.name, 180) || record.id;
  const eventDate = isoDate(record.customer?.eventDate);
  const displayName = clean(baseName + (eventDate ? ' - ' + eventDate : ''), 100);

  const query: any = await qboQuery(
    context,
    "select * from Customer where DisplayName = '" + escapeQbo(displayName) + "' maxresults 1",
  );
  let customer = query?.QueryResponse?.Customer?.[0];

  if (!customer) {
    const created: any = await qboCreate(context, 'customer', {
      DisplayName: displayName,
      PrimaryEmailAddr: record.customer?.email ? { Address: clean(record.customer.email, 240) } : undefined,
      PrimaryPhone: record.customer?.phone ? { FreeFormNumber: clean(record.customer.phone, 80) } : undefined,
      Notes: 'Koa’s Events CRM record ' + record.id + (eventDate ? ' · Event ' + eventDate : ''),
    });
    customer = created?.Customer;
  }

  if (!customer?.Id) throw new Error('QuickBooks customer could not be created.');
  state.customerId = String(customer.Id);
  state.customerDisplayName = String(customer.DisplayName || displayName);
  return customer;
}

async function findExistingEstimateForRecord(context: Context, record: any, customerId: string) {
  const state = quickBooksState(record);
  if (state.estimateId || !customerId) return null;

  const data: any = await qboQuery(
    context,
    "select * from Estimate where CustomerRef = '" + escapeQbo(customerId) + "' maxresults 1000",
  );
  const estimates = Array.isArray(data?.QueryResponse?.Estimate) ? data.QueryResponse.Estimate : [];
  const recordId = clean(record?.id, 120);
  const quoteId = clean(record?.quoteId, 120);
  const markers = [recordId, quoteId].filter(Boolean).map((value) => value.toLowerCase());
  if (!markers.length) return null;

  const matches = estimates.filter((estimate: any) => {
    const haystack = [
      estimate?.PrivateNote,
      estimate?.CustomerMemo?.value,
    ].map((value) => clean(value, 4000).toLowerCase()).join(' ');
    return markers.some((marker) => haystack.includes(marker));
  });

  if (matches.length !== 1) return null;
  const estimate = matches[0];
  state.estimateId = String(estimate.Id || '');
  state.estimateDocNumber = String(estimate.DocNumber || '');
  state.estimateTotal = Number(estimate.TotalAmt || 0);
  state.estimateEmailStatus = String(estimate.EmailStatus || '');
  state.estimateLastSyncedAt = new Date().toISOString();
  state.lastSyncedAt = state.estimateLastSyncedAt;
  return estimate;
}

async function syncEstimate(context: Context, record: any, itemId: string) {
  if (!record.proposal) throw new Error('Proposal not found.');

  const state = quickBooksState(record);
  const customer = await ensureCustomer(context, record);
  if (!state.estimateId) {
    await findExistingEstimateForRecord(context, record, String(customer.Id || ''));
  }
  const payload: any = {
    CustomerRef: { value: String(customer.Id) },
    TxnDate: today(),
    ExpirationDate: isoDate(record.proposal.expirationDate) || undefined,
    BillEmail: record.customer?.email ? { Address: clean(record.customer.email, 240) } : undefined,
    CustomerMemo: { value: 'Koa’s Events proposal ' + record.id },
    PrivateNote: 'Koa CRM: ' + record.id + (record.quoteId ? ' · Quote ' + record.quoteId : ''),
    Line: proposalLines(record, itemId),
    DiscountAmt: Number(record.proposal.discountAmount || 0) || undefined,
  };

  let estimate: any;
  if (state.estimateId) {
    const current: any = await qboGet(context, 'estimate', state.estimateId);
    const existing = current?.Estimate;
    if (existing?.Id && existing?.SyncToken != null) {
      const updated: any = await qboUpdate(context, 'estimate', {
        Id: existing.Id,
        SyncToken: existing.SyncToken,
        ...payload,
      });
      estimate = updated?.Estimate;
    }
  }

  if (!estimate) {
    const created: any = await qboCreate(context, 'estimate', payload);
    estimate = created?.Estimate;
  }

  if (!estimate?.Id) throw new Error('QuickBooks estimate could not be created.');
  state.estimateId = String(estimate.Id);
  state.estimateDocNumber = String(estimate.DocNumber || '');
  state.estimateTotal = Number(estimate.TotalAmt || record.proposal.total || 0);
  state.estimateEmailStatus = String(estimate.EmailStatus || '');
  state.estimateLastSyncedAt = new Date().toISOString();
  state.lastSyncedAt = state.estimateLastSyncedAt;
  return estimate;
}

function scheduleFor(record: any) {
  if (record.booking?.payments?.length) return record.booking.payments;
  return (record.proposal?.paymentSchedule || []).map((item: any, index: number) => ({
    id: 'pay-' + (index + 1),
    label: item.label,
    dueDate: item.dueDate,
    amount: Number(item.amount || 0),
  }));
}

async function createMilestoneInvoice(context: Context, record: any, itemId: string, paymentId: string) {
  if (!record.proposal || !['accepted','booked'].includes(record.proposal.status)) {
    throw new Error('The proposal must be accepted before creating QuickBooks invoices.');
  }

  const state = quickBooksState(record);
  const existing = state.invoices.find((entry: any) => entry.paymentId === paymentId);
  if (existing?.invoiceId) {
    const data: any = await qboGet(context, 'invoice', existing.invoiceId);
    return data?.Invoice;
  }

  const payment = scheduleFor(record).find((entry: any) => String(entry.id) === paymentId);
  if (!payment) throw new Error('Payment milestone not found.');

  const customer = await ensureCustomer(context, record);
  const amount = Number(payment.amount || 0);
  const proposal = record.proposal || {};
  const activeInvoices = state.invoices.filter((entry: any) =>
    entry?.invoiceId && !['void','deleted'].includes(String(entry?.status || '').toLowerCase()),
  );
  const paymentsReceived = activeInvoices.reduce((sum: number, entry: any) => {
    const total = Number(entry.total ?? entry.amount ?? 0);
    const balance = Number(entry.balance ?? total);
    return sum + Math.max(0, total - balance);
  }, 0);
  const proposalTotal = Number(proposal.total || 0);
  const remainingBalance = Math.max(0, Math.round((proposalTotal - paymentsReceived) * 100) / 100);
  const remainingAfterMilestone = Math.max(0, Math.round((remainingBalance - amount) * 100) / 100);
  const depositPercent = Number.isFinite(Number(proposal.depositPercent))
    ? Number(proposal.depositPercent)
    : proposalTotal > 0 ? (Number(proposal.depositAmount || 0) / proposalTotal) * 100 : 0;
  const financialSnapshot = [
    'Milestone: ' + clean(payment.label, 120),
    'Scheduled milestone amount: $' + amount.toFixed(2),
    'Proposal subtotal: $' + Number(proposal.subtotal || 0).toFixed(2),
    'Discount: $' + Number(proposal.discountAmount || 0).toFixed(2),
    clean(proposal.taxLabel || 'Tax', 80) + (Number(proposal.taxRate || 0) > 0 ? ' ' + Number(proposal.taxRate || 0).toFixed(3).replace(/0+$/,'').replace(/\.$/,'') + '%' : '') + ': $' + Number(proposal.taxAmount || 0).toFixed(2),
    'Proposal total: $' + proposalTotal.toFixed(2),
    'Deposit (' + (Math.round(depositPercent * 1000) / 1000) + '%): $' + Number(proposal.depositAmount || 0).toFixed(2),
    'Payments received: $' + paymentsReceived.toFixed(2),
    'Remaining balance before this invoice: $' + remainingBalance.toFixed(2),
    'Remaining balance after this milestone is paid: $' + remainingAfterMilestone.toFixed(2),
  ].join('\n');
  const created: any = await qboCreate(context, 'invoice', {
    CustomerRef: { value: String(customer.Id) },
    TxnDate: today(),
    DueDate: isoDate(payment.dueDate) || undefined,
    BillEmail: record.customer?.email ? { Address: clean(record.customer.email, 240) } : undefined,
    CustomerMemo: { value: clean('Payment milestone: ' + payment.label + ' · Koa’s Events ' + record.id, 1000) },
    PrivateNote: clean('Koa CRM ' + record.id + ' · ' + payment.label + ' · proposal total $' + proposalTotal.toFixed(2), 4000),
    Line: [buildQuickBooksMilestoneInvoiceLine({
      amount,
      itemId,
      description: financialSnapshot,
    })],
  });
  const invoice = created?.Invoice;
  if (!invoice?.Id) throw new Error('QuickBooks invoice could not be created.');

  state.invoices.push({
    paymentId,
    label: clean(payment.label, 180),
    dueDate: isoDate(payment.dueDate),
    amount,
    invoiceId: String(invoice.Id),
    docNumber: String(invoice.DocNumber || ''),
    total: Number(invoice.TotalAmt || amount),
    balance: Number(invoice.Balance ?? invoice.TotalAmt ?? amount),
    emailStatus: String(invoice.EmailStatus || ''),
    lastSyncedAt: new Date().toISOString(),
  });
  state.lastSyncedAt = new Date().toISOString();
  return invoice;
}

export async function refreshQuickBooksPaymentSnapshot(context: Context, record: any) {
  const state = quickBooksState(record);
  if (!state.customerId) return state;
  try {
    const paymentData: any = await qboQuery(context, "select * from Payment where CustomerRef = '" + escapeQbo(String(state.customerId)) + "' maxresults 1000");
    const payments = Array.isArray(paymentData?.QueryResponse?.Payment) ? paymentData.QueryResponse.Payment : [];
    state.paymentSync = {
      count: payments.length,
      paymentIds: payments.slice(0, 100).map((payment: any) => String(payment?.Id || '')).filter(Boolean),
      lastSyncedAt: new Date().toISOString(),
    };
  } catch (error) {
    state.paymentSync = {
      count: null,
      paymentIds: [],
      lastSyncedAt: new Date().toISOString(),
      warning: clean(error instanceof Error ? error.message : 'QuickBooks payment query was unavailable.', 300),
    };
  }
  return state;
}

export async function syncQuickBooksAccountingStatus(context: Context, record: any) {
  const state = quickBooksState(record);

  if (!state.estimateId && state.customerId) {
    try {
      await findExistingEstimateForRecord(context, record, String(state.customerId));
    } catch {}
  }

  if (state.estimateId) {
    const estimateData: any = await qboGet(context, 'estimate', state.estimateId);
    const estimate = estimateData?.Estimate;
    if (estimate) {
      state.estimateDocNumber = String(estimate.DocNumber || state.estimateDocNumber || '');
      state.estimateTotal = Number(estimate.TotalAmt || state.estimateTotal || 0);
      state.estimateEmailStatus = String(estimate.EmailStatus || '');
      state.estimateLines = (Array.isArray(estimate.Line) ? estimate.Line : [])
        .filter((line: any) => line?.DetailType === 'SalesItemLineDetail')
        .map((line: any, index: number) => ({
          id: String(line?.Id || 'qbo-line-' + (index + 1)),
          description: String(line?.Description || line?.SalesItemLineDetail?.ItemRef?.name || 'QuickBooks line ' + (index + 1)),
          quantity: Number(line?.SalesItemLineDetail?.Qty || 1),
          unitPrice: Number(line?.SalesItemLineDetail?.UnitPrice || line?.Amount || 0),
          amount: Number(line?.Amount || 0),
          itemId: String(line?.SalesItemLineDetail?.ItemRef?.value || ''),
          itemName: String(line?.SalesItemLineDetail?.ItemRef?.name || ''),
          taxCode: String(line?.SalesItemLineDetail?.TaxCodeRef?.value || ''),
        }));
      state.estimateDiscount = Number(estimate.DiscountAmt || 0);
      state.estimateLastSyncedAt = new Date().toISOString();
      state.estimateVerifiedAt = state.estimateLastSyncedAt;
      state.estimateVerificationSource = 'live';
    }
  }

  for (const entry of state.invoices) {
    if (!entry.invoiceId) continue;
    const data: any = await qboGet(context, 'invoice', entry.invoiceId);
    const invoice = data?.Invoice;
    if (!invoice) continue;
    entry.docNumber = String(invoice.DocNumber || entry.docNumber || '');
    entry.total = Number(invoice.TotalAmt || entry.total || entry.amount || 0);
    entry.balance = Number(invoice.Balance ?? entry.balance ?? entry.total);
    entry.paidAmount = Math.max(0, roundMoney(Number(entry.total || 0) - Number(entry.balance || 0)));
    entry.paymentState = entry.paidAmount >= Number(entry.total || 0) - 0.005
      ? 'paid'
      : entry.paidAmount > 0.005
        ? 'partially_paid'
        : 'unpaid';
    entry.syncToken = String(invoice.SyncToken || '');
    entry.emailStatus = String(invoice.EmailStatus || '');
    entry.dueDate = isoDate(invoice.DueDate || entry.dueDate);
    entry.lines = (Array.isArray(invoice.Line) ? invoice.Line : [])
      .filter((line: any) => line?.DetailType === 'SalesItemLineDetail')
      .map((line: any, index: number) => ({
        id: String(line?.Id || 'invoice-line-' + (index + 1)),
        description: String(line?.Description || line?.SalesItemLineDetail?.ItemRef?.name || 'QuickBooks invoice line ' + (index + 1)),
        quantity: Number(line?.SalesItemLineDetail?.Qty || 1),
        unitPrice: Number(line?.SalesItemLineDetail?.UnitPrice || line?.Amount || 0),
        amount: Number(line?.Amount || 0),
        itemId: String(line?.SalesItemLineDetail?.ItemRef?.value || ''),
        itemName: String(line?.SalesItemLineDetail?.ItemRef?.name || ''),
        taxCode: String(line?.SalesItemLineDetail?.TaxCodeRef?.value || ''),
      }));
    entry.lastSyncedAt = new Date().toISOString();
  }

  state.lastSyncedAt = new Date().toISOString();

  const deposit = state.invoices.find((entry: any) => /deposit/i.test(entry.label || '')) || state.invoices[0];
  if (
    deposit &&
    Number(deposit.balance || 0) <= 0 &&
    record.booking?.contract?.status === 'signed' &&
    record.booking?.contract?.koaSignature
  ) {
    record.stage = 'booked';
    record.status = 'booked';
    if (record.proposal) record.proposal.status = 'booked';
    if (record.booking) record.booking.status = 'booked';
  }

  return state;
}

function moneyDelta(a: unknown, b: unknown) {
  return Math.round((Number(a || 0) - Number(b || 0)) * 100) / 100;
}

function reconciliationIssueSnapshot(row: any) {
  return (Array.isArray(row?.issues) ? row.issues : []).map((issue: any) => ({
    code: String(issue?.code || ''),
    label: clean(issue?.label, 220),
    expected: issue?.expected == null ? null : Math.round(Number(issue.expected || 0) * 100) / 100,
    actual: issue?.actual == null ? null : Math.round(Number(issue.actual || 0) * 100) / 100,
    delta: issue?.delta == null ? null : Math.round(Number(issue.delta || 0) * 100) / 100,
  })).sort((a: any, b: any) => (a.code + a.label).localeCompare(b.code + b.label));
}

function reconciliationFingerprint(issues: any[]) {
  return JSON.stringify(issues.map((issue: any) => [issue.code, issue.expected, issue.actual, issue.delta]));
}

export function applyQuickBooksReconciliationHistory(
  records: any[],
  audit: any,
  source = 'manual',
  recordIds?: string[],
) {
  const allowed = recordIds?.length ? new Set(recordIds.map(String)) : null;
  const rows = Array.isArray(audit?.rows) ? audit.rows : [];
  const transitions: any[] = [];
  const changedRecordIds: string[] = [];
  const now = new Date().toISOString();

  for (const row of rows) {
    const recordId = String(row?.recordId || '');
    if (!recordId || (allowed && !allowed.has(recordId))) continue;
    const record = records.find((entry: any) => String(entry?.id || '') === recordId);
    if (!record) continue;

    record.accounting ||= {};
    record.accounting.quickbooks ||= {};
    const qbo = record.accounting.quickbooks;
    const currentIssues = reconciliationIssueSnapshot(row);
    const currentOpen = currentIssues.length > 0;
    const currentFingerprint = reconciliationFingerprint(currentIssues);
    const previous = qbo.reconciliationState || null;
    const previousOpen = Boolean(previous?.open);
    const previousFingerprint = String(previous?.fingerprint || '');
    const previousIssues = Array.isArray(previous?.issues) ? previous.issues : [];

    let type = '';
    if (!previous && currentOpen) type = 'mismatch_detected';
    else if (previousOpen && !currentOpen) type = 'resolved';
    else if (!previousOpen && currentOpen) type = 'mismatch_detected';
    else if (previousOpen && currentOpen && previousFingerprint !== currentFingerprint) type = 'mismatch_changed';

    qbo.reconciliationState = {
      open: currentOpen,
      fingerprint: currentFingerprint,
      issues: currentIssues,
      checkedAt: now,
      source,
      resolvedAt: currentOpen ? '' : (previousOpen ? now : String(previous?.resolvedAt || now)),
    };

    if (!type) continue;

    const entry = {
      id: 'REC-' + crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase(),
      type,
      createdAt: now,
      source,
      before: previousIssues,
      after: currentIssues,
      proposalTotal: Number(row?.proposalTotal || 0),
      paymentsReceived: Number(row?.paymentsReceived || 0),
      remainingBalance: Number(row?.remainingBalance || 0),
    };
    qbo.reconciliationHistory = [entry, ...(Array.isArray(qbo.reconciliationHistory) ? qbo.reconciliationHistory : [])].slice(0, 100);
    transitions.push({
      recordId,
      clientName: clean(row?.clientName || record?.customer?.name || recordId, 180),
      eventDate: isoDate(row?.eventDate || record?.customer?.eventDate),
      type,
      before: previousIssues,
      after: currentIssues,
      proposalTotal: Number(row?.proposalTotal || 0),
      remainingBalance: Number(row?.remainingBalance || 0),
    });
    changedRecordIds.push(recordId);
  }

  return { records, transitions, changedRecordIds };
}

export function buildQuickBooksAccountingAudit(records: any[]) {
  const rows = (Array.isArray(records) ? records : [])
    .filter((record: any) => record?.kind === 'proposal' && record?.proposal)
    .map((record: any) => {
      const proposal = record.proposal || {};
      const qbo = record?.accounting?.quickbooks || {};
      const reconciliationScope = quickBooksAccountingScope(record);
      const schedule = scheduleFor(record);
      const activeInvoices = (Array.isArray(qbo.invoices) ? qbo.invoices : []).filter((entry: any) =>
        entry?.invoiceId && !['void','deleted'].includes(String(entry?.status || '').toLowerCase()),
      );
      const issues: any[] = [];
      const proposalTotal = Math.round(Number(proposal.total || 0) * 100) / 100;
      const scheduledTotal = Math.round(schedule.reduce((sum: number, item: any) => sum + Number(item.amount || 0), 0) * 100) / 100;

      if (Math.abs(moneyDelta(scheduledTotal, proposalTotal)) >= 0.01) {
        issues.push({ code:'schedule_total', label:'CRM payment schedule', expected:proposalTotal, actual:scheduledTotal, delta:moneyDelta(scheduledTotal, proposalTotal) });
      }

      if (qbo.estimateId) {
        const estimateTotal = Math.round(Number(qbo.estimateTotal || 0) * 100) / 100;
        if (Math.abs(moneyDelta(estimateTotal, proposalTotal)) >= 0.01) {
          issues.push({ code:'estimate_total', label:'QuickBooks estimate total', expected:proposalTotal, actual:estimateTotal, delta:moneyDelta(estimateTotal, proposalTotal) });
        }
      } else if (['accepted','booked'].includes(String(proposal.status || ''))) {
        issues.push({ code:'estimate_missing', label:'QuickBooks estimate', expected:proposalTotal, actual:null, delta:null });
      }

      const invoiceByPayment = new Map(activeInvoices.map((entry: any) => [String(entry.paymentId || ''), entry]));
      activeInvoices.forEach((invoice: any) => {
        const milestone = schedule.find((item: any) => String(item.id || '') === String(invoice.paymentId || ''));
        const invoiceTotal = Math.round(Number(invoice.total ?? invoice.amount ?? 0) * 100) / 100;
        if (!milestone) {
          issues.push({ code:'invoice_orphan', label:'QuickBooks invoice ' + (invoice.docNumber || invoice.invoiceId), expected:null, actual:invoiceTotal, delta:null });
          return;
        }
        const milestoneAmount = Math.round(Number(milestone.amount || 0) * 100) / 100;
        if (Math.abs(moneyDelta(invoiceTotal, milestoneAmount)) >= 0.01) {
          issues.push({ code:'invoice_milestone', label:(milestone.label || 'Milestone') + ' invoice', expected:milestoneAmount, actual:invoiceTotal, delta:moneyDelta(invoiceTotal, milestoneAmount) });
        }
      });

      const issuedTotal = Math.round(activeInvoices.reduce((sum: number, entry: any) => sum + Number(entry.total ?? entry.amount ?? 0), 0) * 100) / 100;
      const uninvoicedTotal = Math.round(schedule.reduce((sum: number, item: any) => {
        return sum + (invoiceByPayment.has(String(item.id || '')) ? 0 : Number(item.amount || 0));
      }, 0) * 100) / 100;
      const allocatedTotal = Math.round((issuedTotal + uninvoicedTotal) * 100) / 100;
      if (Math.abs(moneyDelta(allocatedTotal, proposalTotal)) >= 0.01) {
        issues.push({ code:'allocation_total', label:'Issued invoices + uninvoiced milestones', expected:proposalTotal, actual:allocatedTotal, delta:moneyDelta(allocatedTotal, proposalTotal) });
      }

      const paymentsReceived = Math.round(activeInvoices.reduce((sum: number, entry: any) => {
        const total = Number(entry.total ?? entry.amount ?? 0);
        const balance = Number(entry.balance ?? total);
        return sum + Math.max(0, total - balance);
      }, 0) * 100) / 100;
      const openInvoiceBalance = Math.round(activeInvoices.reduce((sum: number, entry: any) => sum + Math.max(0, Number(entry.balance ?? entry.total ?? entry.amount ?? 0)), 0) * 100) / 100;
      const remainingBalance = Math.max(0, Math.round((proposalTotal - paymentsReceived) * 100) / 100);
      const expectedOpenInvoiceBalance = Math.max(0, Math.round((issuedTotal - paymentsReceived) * 100) / 100);
      const accountedRemainingBalance = Math.round((openInvoiceBalance + uninvoicedTotal) * 100) / 100;

      if (Math.abs(moneyDelta(accountedRemainingBalance, remainingBalance)) >= 0.01) {
        issues.push({ code:'remaining_balance', label:'Remaining balance (open invoices + uninvoiced milestones)', expected:remainingBalance, actual:accountedRemainingBalance, delta:moneyDelta(accountedRemainingBalance, remainingBalance) });
      }

      if (Math.abs(moneyDelta(openInvoiceBalance, expectedOpenInvoiceBalance)) >= 0.01) {
        issues.push({ code:'invoice_balance', label:'QuickBooks open invoice balance', expected:expectedOpenInvoiceBalance, actual:openInvoiceBalance, delta:moneyDelta(openInvoiceBalance, expectedOpenInvoiceBalance) });
      }
      if (qbo.balanceDue != null && Math.abs(moneyDelta(qbo.balanceDue, openInvoiceBalance)) >= 0.01) {
        issues.push({ code:'stored_balance', label:'Stored QuickBooks balance', expected:openInvoiceBalance, actual:Math.round(Number(qbo.balanceDue || 0) * 100) / 100, delta:moneyDelta(qbo.balanceDue, openInvoiceBalance) });
      }

      const observedIssues = issues;
      const actionableIssues = reconciliationScope.actionable ? observedIssues : [];

      return {
        recordId: record.id,
        clientName: clean(record.customer?.name || record.id, 180),
        eventDate: isoDate(record.customer?.eventDate),
        proposalStatus: String(proposal.status || record.status || ''),
        proposalTotal,
        scheduledTotal,
        estimateId: String(qbo.estimateId || ''),
        estimateDocNumber: String(qbo.estimateDocNumber || ''),
        estimateTotal: qbo.estimateId ? Math.round(Number(qbo.estimateTotal || 0) * 100) / 100 : null,
        estimateVerifiedAt: String(qbo.estimateVerifiedAt || qbo.estimateLastSyncedAt || qbo.lastSyncedAt || ''),
        verificationSource: 'stored',
        reconciliationOpen: Boolean(qbo.reconciliationState?.open),
        reconciliationCheckedAt: String(qbo.reconciliationState?.checkedAt || ''),
        reconciliationResolvedAt: String(qbo.reconciliationState?.resolvedAt || ''),
        reconciliationMode: reconciliationScope.mode,
        reconciliationActionable: reconciliationScope.actionable,
        reconciliationScopeReason: reconciliationScope.reason,
        observedIssues: reconciliationScope.actionable ? [] : observedIssues,
        invoiceCount: activeInvoices.length,
        issuedTotal,
        uninvoicedTotal,
        paymentsReceived,
        openInvoiceBalance,
        remainingBalance,
        lastSyncedAt: String(qbo.lastSyncedAt || ''),
        issues: actionableIssues,
        reconciled: actionableIssues.length === 0,
      };
    })
    .filter((row: any) => row.estimateId || row.invoiceCount > 0 || ['accepted','booked'].includes(row.proposalStatus))
    .sort((a: any, b: any) => {
      if (a.reconciled !== b.reconciled) return a.reconciled ? 1 : -1;
      return String(a.eventDate || '9999').localeCompare(String(b.eventDate || '9999'));
    });

  const flagged = rows.filter((row: any) => !row.reconciled);
  const historicalRows = rows.filter((row: any) => row?.reconciliationMode === 'quickbooks-history');
  const historicalObservedIssueCount = historicalRows.reduce(
    (sum: number, row: any) => sum + (Array.isArray(row?.observedIssues) ? row.observedIssues.length : 0),
    0,
  );
  return {
    generatedAt: new Date().toISOString(),
    clientCount: rows.length,
    reconciledCount: rows.length - flagged.length,
    flaggedCount: flagged.length,
    currentBookingFlaggedCount: flagged.filter((row: any) => row?.reconciliationMode !== 'quickbooks-history').length,
    historicalCount: historicalRows.length,
    historicalObservedIssueCount,
    historicalRows,
    totalProposalValue: Math.round(rows.reduce((sum: number, row: any) => sum + row.proposalTotal, 0) * 100) / 100,
    totalPaymentsReceived: Math.round(rows.reduce((sum: number, row: any) => sum + row.paymentsReceived, 0) * 100) / 100,
    totalRemainingBalance: Math.round(rows.reduce((sum: number, row: any) => sum + row.remainingBalance, 0) * 100) / 100,
    rows,
  };
}


function roundMoney(value: unknown) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function repairLineView(lines: any[]) {
  return (Array.isArray(lines) ? lines : []).map((line: any) => ({
    description: clean(line?.Description ?? line?.description, 400) || 'Line item',
    quantity: Number(line?.SalesItemLineDetail?.Qty ?? line?.quantity ?? 1),
    unitPrice: roundMoney(line?.SalesItemLineDetail?.UnitPrice ?? line?.unitPrice ?? 0),
    amount: roundMoney(line?.Amount ?? line?.amount ?? 0),
    itemId: clean(line?.SalesItemLineDetail?.ItemRef?.value ?? line?.itemId, 80),
    taxCode: clean(line?.SalesItemLineDetail?.TaxCodeRef?.value ?? line?.taxCode, 40).toUpperCase(),
  }));
}

function invoiceRepairSnapshot(record: any) {
  const qbo = quickBooksState(record);
  return (Array.isArray(qbo.invoices) ? qbo.invoices : [])
    .filter((entry: any) => entry?.invoiceId)
    .map((entry: any) => ({
      invoiceId: String(entry.invoiceId || ''),
      docNumber: String(entry.docNumber || ''),
      paymentId: String(entry.paymentId || ''),
      total: roundMoney(entry.total ?? entry.amount ?? 0),
      balance: roundMoney(entry.balance ?? entry.total ?? entry.amount ?? 0),
      paidAmount: roundMoney(entry.paidAmount ?? Math.max(0, Number(entry.total ?? entry.amount ?? 0) - Number(entry.balance ?? entry.total ?? entry.amount ?? 0))),
      paymentState: String(entry.paymentState || ''),
      dueDate: isoDate(entry.dueDate),
      syncToken: String(entry.syncToken || ''),
      lines: quickBooksEstimateLineFingerprint(entry.lines || []),
    }))
    .sort((a: any, b: any) => a.invoiceId.localeCompare(b.invoiceId));
}

function accountingRepairState(record: any, itemId: string) {
  const qbo = quickBooksState(record);
  const expectedLines = proposalLines(record, itemId);
  const schedule = scheduleFor(record).map((entry: any) => ({
    id: String(entry.id || ''),
    amount: roundMoney(entry.amount || 0),
    dueDate: isoDate(entry.dueDate),
    label: clean(entry.label, 180),
  }));
  const lifecycle=currentBookingStatus(record);
  const scope=quickBooksAccountingScope(record);
  return {
    lifecycle,
    accountingScope:scope.mode,
    accountingActionable:Boolean(scope.actionable),
    proposalTotal: roundMoney(record?.proposal?.total || 0),
    proposalDiscount: roundMoney(record?.proposal?.discountAmount || 0),
    expectedLines: quickBooksEstimateLineFingerprint(expectedLines),
    estimateId: String(qbo.estimateId || ''),
    estimateDocNumber: String(qbo.estimateDocNumber || ''),
    estimateTotal: qbo.estimateId ? roundMoney(qbo.estimateTotal || 0) : null,
    estimateLines: quickBooksEstimateLineFingerprint(qbo.estimateLines || []),
    schedule,
    invoices: invoiceRepairSnapshot(record),
  };
}

function accountingRepairFingerprint(record: any, itemId: string) {
  return JSON.stringify(accountingRepairState(record, itemId));
}

function repairPreviewKey(previewId: string) {
  return 'quickbooks/accounting-repair-previews/' + clean(previewId, 120);
}

function bulkRepairPreviewAuditKey(bulkPreviewId: string) {
  return 'quickbooks/accounting-repair-bulk-previews/' + clean(bulkPreviewId, 140);
}

async function readBulkRepairPreviewAudit(context: Context, bulkPreviewId: string) {
  if (!clean(bulkPreviewId, 140)) return null;
  return await integrationStoreFor(context).get(bulkRepairPreviewAuditKey(bulkPreviewId), { type:'json' }) as any;
}

async function saveBulkRepairPreviewAudit(context: Context, audit: any) {
  if (!audit?.bulkPreviewId) throw new Error('Bulk repair preview id is missing.');
  audit.updatedAt = new Date().toISOString();
  const store = integrationStoreFor(context);
  await store.setJSON(bulkRepairPreviewAuditKey(audit.bulkPreviewId), audit);
  const index = ((await store.get('quickbooks/accounting-repair-bulk-previews/index', { type:'json' })) || []) as any[];
  const summary = {
    bulkPreviewId: clean(audit.bulkPreviewId,140),
    generatedAt: clean(audit.generatedAt,80),
    updatedAt: clean(audit.updatedAt,80),
    actor: clean(audit.actor,240),
    requestedCount: Number(audit.requestedCount||0),
    repairableClientCount: Number(audit.repairableClientCount||0),
    writeCount: Number(audit.writeCount||0),
    blockedClientCount: Number(audit.blockedClientCount||0),
    cleanClientCount: Number(audit.cleanClientCount||0),
    errorClientCount: Number(audit.errorClientCount||0),
    decisionCount: Array.isArray(audit.decisions)?audit.decisions.length:0,
  };
  await store.setJSON(
    'quickbooks/accounting-repair-bulk-previews/index',
    [summary, ...index.filter((row:any)=>clean(row?.bulkPreviewId,140)!==summary.bulkPreviewId)].slice(0,100),
  );
  return audit;
}

async function appendBulkRepairDecision(context: Context, bulkPreviewId: string, decision: any) {
  const audit = await readBulkRepairPreviewAudit(context, bulkPreviewId);
  if (!audit?.bulkPreviewId) throw new Error('Bulk repair preview audit was not found.');
  const row = (Array.isArray(audit.rows)?audit.rows:[]).find((entry:any)=>clean(entry?.recordId,120)===clean(decision?.recordId,120));
  const change = (Array.isArray(row?.changes)?row.changes:[]).find((entry:any)=>clean(entry?.id,180)===clean(decision?.changeId,180));
  if (!row || !change) throw new Error('That client/write is not part of this bulk repair preview.');
  const entry = {
    decisionId:'ARD-'+idSuffix(),
    decision:clean(decision?.decision,40),
    decidedAt:new Date().toISOString(),
    decidedBy:clean(decision?.decidedBy,240)||'staff',
    recordId:clean(row.recordId,120),
    clientName:clean(row.clientName||row.recordId,240),
    changeId:clean(change.id,180),
    previewId:clean(decision?.previewId,140),
    reason:clean(decision?.reason,1200),
    resolved:decision?.resolved==null?null:Boolean(decision.resolved),
    remainingIssues:Array.isArray(decision?.remainingIssues)?decision.remainingIssues:[],
    before:decision?.before??change?.before??null,
    after:decision?.after??change?.after??null,
    documents:Array.isArray(decision?.documents)?decision.documents:[],
  };
  audit.decisions=[entry,...(Array.isArray(audit.decisions)?audit.decisions:[])].slice(0,500);
  await saveBulkRepairPreviewAudit(context,audit);
  return {entry,audit};
}

async function appendClientAccountingActivity(
  context: Context,
  tenant: any,
  recordId: string,
  type: string,
  detail: string,
) {
  const store = tenantStoreFor(context, tenant, 'crm');
  const current = ((await store.get('activity/index', { type:'json' })) || []) as any[];
  const row = {
    id: 'ACT-' + idSuffix(),
    recordId,
    type,
    detail: clean(detail, 800),
    createdAt: new Date().toISOString(),
  };
  await store.setJSON('activity/index', [row, ...current].slice(0, 5000));
  return row;
}

async function updateUnpaidMilestoneInvoice(
  context: Context,
  record: any,
  itemId: string,
  change: any,
) {
  const paymentId = clean(change?.paymentId, 100);
  const milestone = scheduleFor(record).find((entry: any) => String(entry.id || '') === paymentId);
  if (!milestone) throw new Error('The payment milestone for this invoice no longer exists.');

  const invoiceId = clean(change?.invoiceId, 100);
  if (!invoiceId) throw new Error('QuickBooks invoice ID is missing from the approved repair.');
  const data: any = await qboGet(context, 'invoice', invoiceId);
  const invoice = data?.Invoice;
  if (!invoice?.Id || invoice?.SyncToken == null) throw new Error('QuickBooks invoice could not be refreshed for repair.');

  const protection = invoicePaymentProtection(invoice);
  const total = protection.total;
  const balance = protection.balance;
  if (protection.protected) {
    const state = protection.state === 'paid' ? 'paid' : 'partially paid';
    throw new Error('Invoice #' + clean(invoice.DocNumber || invoiceId, 80) + ' is now ' + state + '. Paid and partially paid invoices are protected and cannot be changed by Accounting Repair.');
  }

  if (roundMoney(change?.before?.total) !== total || roundMoney(change?.before?.balance) !== balance) {
    throw new Error('Invoice #' + clean(invoice.DocNumber || invoiceId, 80) + ' changed after approval preview. Run Preview Accounting Repair again.');
  }

  const salesLines = (Array.isArray(invoice.Line) ? invoice.Line : [])
    .filter((line: any) => line?.DetailType === 'SalesItemLineDetail');
  if (salesLines.length !== 1) {
    throw new Error('Invoice #' + clean(invoice.DocNumber || invoiceId, 80) + ' has ' + salesLines.length + ' sales lines. Automatic repair only changes one-line milestone invoices.');
  }

  const currentLine = salesLines[0];
  const repairItemId = clean(currentLine?.SalesItemLineDetail?.ItemRef?.value || change?.itemId || itemId, 80);
  if (!repairItemId) throw new Error('QuickBooks item mapping is missing for invoice #' + clean(invoice.DocNumber || invoiceId, 80) + '.');

  const desiredAmount = roundMoney(milestone.amount || 0);
  const line = buildQuickBooksMilestoneInvoiceLine({
    amount: desiredAmount,
    itemId: repairItemId,
    description: currentLine?.Description || change?.before?.lines?.[0]?.description || ('Payment milestone: ' + clean(milestone.label, 180)),
    lineId: clean(currentLine?.Id, 80),
  });

  const updated: any = await qboUpdate(context, 'invoice', {
    Id: String(invoice.Id),
    SyncToken: String(invoice.SyncToken),
    DueDate: isoDate(milestone.dueDate) || undefined,
    Line: [line],
  });
  if (!updated?.Invoice?.Id) throw new Error('QuickBooks did not return the repaired invoice.');
  return updated.Invoice;
}

async function buildAccountingRepairPreview(
  context: Context,
  tenant: any,
  record: any,
  records: any[],
  itemId: string,
  actor: string,
) {
  // Live reads only: the preview does not write to QuickBooks or save the refreshed mirror.
  await syncQuickBooksAccountingStatus(context, record);
  await refreshQuickBooksPaymentSnapshot(context, record);

  const accountingAudit = buildQuickBooksAccountingAudit(records);
  const auditRow = accountingAudit.rows.find((row: any) => row.recordId === record.id) || {
    recordId: record.id,
    clientName: clean(record?.customer?.name || record.id, 180),
    proposalTotal: roundMoney(record?.proposal?.total || 0),
    issues: [],
    reconciled: true,
  };
  const state = quickBooksState(record);
  const expectedLines = proposalLines(record, itemId);
  const expectedLineView = repairLineView(expectedLines);
  const currentLineView = repairLineView(state.estimateLines || []);
  const expectedFingerprint = quickBooksEstimateLineFingerprint(expectedLines);
  const currentFingerprint = quickBooksEstimateLineFingerprint(state.estimateLines || []);
  const proposalTotal = roundMoney(record?.proposal?.total || 0);
  const estimateTotal = state.estimateId ? roundMoney(state.estimateTotal || 0) : null;
  const estimateNeedsRepair = Boolean(
    !state.estimateId
    || Math.abs(Number(estimateTotal || 0) - proposalTotal) >= 0.01
    || expectedFingerprint !== currentFingerprint
  );

  const changes: any[] = [];
  const blockedIssues: any[] = [];

  if (estimateNeedsRepair) {
    changes.push({
      id: 'estimate',
      writesQuickBooks: true,
      type: state.estimateId ? 'update_estimate' : 'create_estimate',
      documentType: 'estimate',
      target: state.estimateId
        ? 'QuickBooks estimate ' + (state.estimateDocNumber ? '#' + state.estimateDocNumber : state.estimateId)
        : 'QuickBooks estimate',
      before: {
        exists: Boolean(state.estimateId),
        estimateId: String(state.estimateId || ''),
        docNumber: String(state.estimateDocNumber || ''),
        total: estimateTotal,
        lines: currentLineView,
      },
      after: {
        total: proposalTotal,
        discountAmount: roundMoney(record?.proposal?.discountAmount || 0),
        lines: expectedLineView,
        taxHandling: 'CRM-calculated tax stays as an explicit NON-taxable line; QuickBooks adds no tax on top.',
      },
    });
  }

  const schedule = scheduleFor(record);
  const activeInvoices = (Array.isArray(state.invoices) ? state.invoices : []).filter((entry: any) =>
    entry?.invoiceId && !['void','deleted'].includes(String(entry?.status || '').toLowerCase()),
  );

  for (const invoice of activeInvoices) {
    const milestone = schedule.find((entry: any) => String(entry.id || '') === String(invoice.paymentId || ''));
    const evaluation = evaluateInvoiceRepairCandidate(invoice, milestone || null);
    const protection = evaluation.protection;
    const invoiceLabel = 'QuickBooks invoice ' + (invoice.docNumber ? '#' + invoice.docNumber : invoice.invoiceId);

    if (!evaluation.needsRepair) continue;
    if (!evaluation.eligible) {
      blockedIssues.push({
        code: evaluation.code,
        label: invoiceLabel,
        expected: evaluation.expectedAmount ?? null,
        actual: protection.total,
        delta: evaluation.expectedAmount == null ? null : moneyDelta(protection.total, evaluation.expectedAmount),
        protection: evaluation.reason,
      });
      continue;
    }

    const expectedAmount = roundMoney(evaluation.expectedAmount || 0);
    const salesLines = Array.isArray(invoice.lines) ? invoice.lines : [];

    changes.push({
      id: 'invoice:' + invoice.invoiceId,
      writesQuickBooks: true,
      type: 'update_invoice',
      documentType: 'invoice',
      invoiceId: String(invoice.invoiceId || ''),
      docNumber: String(invoice.docNumber || ''),
      paymentId: String(invoice.paymentId || ''),
      itemId: clean(salesLines[0]?.itemId || itemId, 80),
      target: invoiceLabel,
      before: {
        exists: true,
        invoiceId: String(invoice.invoiceId || ''),
        docNumber: String(invoice.docNumber || ''),
        total: protection.total,
        balance: protection.balance,
        paidAmount: protection.paidAmount,
        paymentState: protection.state,
        dueDate: isoDate(invoice.dueDate),
        lines: salesLines,
      },
      after: {
        total: expectedAmount,
        balance: expectedAmount,
        paidAmount: 0,
        paymentState: 'unpaid',
        dueDate: isoDate(milestone.dueDate),
        lines: [buildQuickBooksMilestoneInvoiceLine({
          amount: expectedAmount,
          itemId: clean(salesLines[0]?.itemId || itemId, 80),
          description: salesLines[0]?.description || ('Payment milestone: ' + clean(milestone.label, 180)),
          lineId: clean(salesLines[0]?.id, 80),
        })],
        taxHandling: 'Milestone amount already reflects CRM contract pricing and is forced to QuickBooks NON tax code.',
      },
    });
  }

  for (const issue of (auditRow.issues || [])) {
    const code = String(issue?.code || '');
    if (['estimate_total','estimate_missing','stored_balance','allocation_total','remaining_balance','invoice_balance','invoice_milestone','invoice_orphan'].includes(code)) continue;
    blockedIssues.push(issue);
  }

  const missingServiceItem = changes.some((change: any) => {
    if (!change?.writesQuickBooks) return false;
    if (change?.documentType === 'invoice' && clean(change?.itemId, 80)) return false;
    return !clean(itemId, 80);
  });
  if (missingServiceItem) {
    blockedIssues.push({
      code: 'service_item_missing',
      label: 'QuickBooks service item mapping',
      expected: 'Configured service item',
      actual: 'Not configured',
      delta: null,
      protection: 'A QuickBooks item is required before this approved repair can be applied.',
    });
  }

  const previewId = 'ARP-' + idSuffix() + '-' + Date.now().toString(36).toUpperCase();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const preview = {
    previewId,
    recordId: record.id,
    clientName: clean(record?.customer?.name || record.id, 180),
    actor,
    createdAt,
    expiresAt,
    beforeFingerprint: accountingRepairFingerprint(record, itemId),
    beforeAudit: auditRow,
    changes,
    blockedIssues,
    protectedInvoiceCount: blockedIssues.filter((issue: any) => String(issue?.code || '').includes('protected')).length,
    postRepairSteps: [
      'Validate that CRM, QuickBooks estimates, invoices and payment state are unchanged since this preview.',
      'Apply only approved estimate changes and fully unpaid one-line milestone invoice repairs.',
      'Refuse any invoice that became paid or partially paid before the write.',
      'Refresh the QuickBooks estimate, invoice balances and payment snapshot.',
      'Run the accounting reconciliation again.',
      'Record the approved repair and before/after result in Client Workspace Accounting Repair History and Activity.',
    ],
    canApply: changes.length > 0 && !missingServiceItem,
    noChangesNeeded: changes.length === 0 && (auditRow.issues || []).length === 0,
  };
  await integrationStoreFor(context).setJSON(repairPreviewKey(previewId), preview);
  return { preview, accountingAudit };
}

function compactAccountingRepairPreview(preview: any) {
  const changes = (Array.isArray(preview?.changes) ? preview.changes : []).map((change: any) => ({
    id: clean(change?.id, 180),
    type: clean(change?.type, 80),
    documentType: clean(change?.documentType, 40),
    target: clean(change?.target, 240),
    invoiceId: clean(change?.invoiceId, 120),
    docNumber: clean(change?.docNumber || change?.before?.docNumber, 120),
    before: {
      total: change?.before?.total == null ? null : roundMoney(change.before.total),
      balance: change?.before?.balance == null ? null : roundMoney(change.before.balance),
      paymentState: clean(change?.before?.paymentState, 40),
      lineCount: Array.isArray(change?.before?.lines) ? change.before.lines.length : 0,
    },
    after: {
      total: change?.after?.total == null ? null : roundMoney(change.after.total),
      balance: change?.after?.balance == null ? null : roundMoney(change.after.balance),
      paymentState: clean(change?.after?.paymentState, 40),
      discountAmount: change?.after?.discountAmount == null ? null : roundMoney(change.after.discountAmount),
      lineCount: Array.isArray(change?.after?.lines) ? change.after.lines.length : 0,
      taxHandling: clean(change?.after?.taxHandling, 500),
    },
  }));
  return {
    previewId: clean(preview?.previewId, 140),
    recordId: clean(preview?.recordId, 120),
    clientName: clean(preview?.clientName, 180),
    createdAt: clean(preview?.createdAt, 80),
    expiresAt: clean(preview?.expiresAt, 80),
    canApply: Boolean(preview?.canApply),
    noChangesNeeded: Boolean(preview?.noChangesNeeded),
    changes,
    blockedIssues: Array.isArray(preview?.blockedIssues) ? preview.blockedIssues : [],
  };
}

export async function buildBulkAccountingRepairPreview(
  context: Context,
  tenant: any,
  records: any[],
  itemId: string,
  actor: string,
  requestedRecordIds: unknown[],
) {
  const requestedIds = [...new Set((Array.isArray(requestedRecordIds) ? requestedRecordIds : [])
    .map((value) => clean(value, 120))
    .filter(Boolean))];
  const currentActionableIds = records
    .filter((entry:any)=>entry?.kind==='proposal'&&currentBookingStatus(entry)&&quickBooksAccountingScope(entry).actionable)
    .map((entry:any)=>clean(entry?.id,120))
    .filter(Boolean);
  const recordIds = (requestedIds.length ? requestedIds : currentActionableIds).slice(0, 30);

  const integrationStore = integrationStoreFor(context);
  const previewOne = async (recordId: string) => {
    const source = records.find((entry: any) => String(entry?.id || '') === recordId && entry?.kind === 'proposal');
    if (!source) return { recordId, status:'unavailable', error:'Proposal record not found.' };

    const lifecycle = currentBookingStatus(source);
    if (!lifecycle) {
      return {
        recordId,
        clientName: clean(source?.customer?.name || recordId, 180),
        status:'ineligible',
        error:'The record is no longer accepted/booked, so it is outside the current repair population.',
      };
    }
    const scope = quickBooksAccountingScope(source);
    if (!scope.actionable) {
      return {
        recordId,
        clientName: clean(source?.customer?.name || recordId, 180),
        status:'ineligible',
        error:scope.reason,
      };
    }

    try {
      // Isolate preview-only state mutations to this candidate. No CRM record is saved.
      const record = structuredClone(source);
      const isolatedRecords = records.map((entry: any) => String(entry?.id || '') === recordId ? record : entry);
      const result = await buildAccountingRepairPreview(context, tenant, record, isolatedRecords, itemId, actor);
      const preview = result.preview;
      const compact = compactAccountingRepairPreview(preview);
      // Bulk preview must never leave an approval-capable bulk token behind.
      await integrationStore.delete(repairPreviewKey(preview.previewId));
      return {
        ...compact,
        status: compact.canApply ? 'repairable' : compact.noChangesNeeded ? 'clean' : 'blocked',
        lifecycle,
      };
    } catch (error) {
      return {
        recordId,
        clientName: clean(source?.customer?.name || recordId, 180),
        status:'error',
        error:error instanceof Error ? clean(error.message, 1000) : 'Unable to generate this live repair preview.',
      };
    }
  };

  // QuickBooks previewing is I/O-heavy. Bound concurrency so the current 20-client
  // population completes quickly without launching an unbounded burst at QBO.
  const rows: any[] = new Array(recordIds.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(4, recordIds.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= recordIds.length) return;
      rows[index] = await previewOne(recordIds[index]);
    }
  });
  await Promise.all(workers);

  const repairableRows = rows.filter((row) => row.status === 'repairable');
  const audit = {
    bulkPreviewId:'ARB-'+idSuffix()+'-'+Date.now().toString(36).toUpperCase(),
    generatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    actor:clean(actor,240)||'staff',
    requestedCount: recordIds.length,
    repairableClientCount: repairableRows.length,
    writeCount: repairableRows.reduce((sum, row) => sum + (Array.isArray(row.changes) ? row.changes.length : 0), 0),
    blockedClientCount: rows.filter((row) => row.status === 'blocked').length,
    cleanClientCount: rows.filter((row) => row.status === 'clean').length,
    errorClientCount: rows.filter((row) => ['error','unavailable','ineligible'].includes(String(row.status))).length,
    rows,
    decisions:[],
    approvalMode:'individual-write-only',
  };
  await saveBulkRepairPreviewAudit(context,audit);
  return audit;
}

async function buildAccountingRepairWritePreview(
  context: Context,
  tenant: any,
  record: any,
  records: any[],
  itemId: string,
  actor: string,
  changeId: string,
  bulkPreviewId = '',
) {
  const result = await buildAccountingRepairPreview(context, tenant, record, records, itemId, actor);
  const parent = result.preview;
  if (!parent?.canApply) {
    await integrationStoreFor(context).delete(repairPreviewKey(parent?.previewId || ''));
    throw new Error('The fresh live repair preview is not eligible to apply. Review its blocked protections before trying again.');
  }
  const change = (Array.isArray(parent?.changes) ? parent.changes : [])
    .find((entry: any) => String(entry?.id || '') === changeId);
  if (!change) {
    await integrationStoreFor(context).delete(repairPreviewKey(parent.previewId));
    throw new Error('That QuickBooks write is no longer present in the fresh live preview. Generate the consolidated preview again.');
  }

  const previewId = 'ARPW-' + idSuffix() + '-' + Date.now().toString(36).toUpperCase();
  if (bulkPreviewId) {
    const audit = await readBulkRepairPreviewAudit(context, bulkPreviewId);
    const auditRow = (Array.isArray(audit?.rows)?audit.rows:[]).find((entry:any)=>clean(entry?.recordId,120)===clean(record?.id,120));
    const auditChange = (Array.isArray(auditRow?.changes)?auditRow.changes:[]).find((entry:any)=>clean(entry?.id,180)===clean(change?.id,180));
    if (!audit?.bulkPreviewId || !auditRow || !auditChange) {
      await integrationStoreFor(context).delete(repairPreviewKey(parent.previewId));
      throw new Error('The consolidated preview no longer contains this exact write. Generate Preview all safe repairs again.');
    }
  }
  const writePreview = {
    ...parent,
    previewId,
    parentPreviewId: parent.previewId,
    bulkPreviewId:clean(bulkPreviewId,140),
    bulkChangeId:clean(change?.id,180),
    changes:[change],
    canApply:true,
    approvalMode:'single-write',
  };
  const integrationStore = integrationStoreFor(context);
  await integrationStore.setJSON(repairPreviewKey(previewId), writePreview);
  await integrationStore.delete(repairPreviewKey(parent.previewId));
  return { preview:writePreview, accountingAudit:result.accountingAudit };
}

async function applyAccountingRepair(
  context: Context,
  tenant: any,
  previewId: string,
  approved: boolean,
  actor: string,
) {
  if (!approved) throw new Error('Explicit approval is required before changing QuickBooks.');
  const integrationStore = integrationStoreFor(context);
  const preview: any = await integrationStore.get(repairPreviewKey(previewId), { type:'json' });
  if (!preview?.previewId) throw new Error('Repair preview not found. Preview the repair again.');
  if (Date.parse(String(preview.expiresAt || '')) <= Date.now()) {
    await integrationStore.delete(repairPreviewKey(previewId));
    throw new Error('Repair preview expired. Preview the repair again before approving it.');
  }

  let records = await readQuickBooksSalesRecords(context);
  const record = records.find((entry: any) => entry.id === clean(preview.recordId, 100) && entry.kind === 'proposal');
  if (!record) throw new Error('Proposal record not found.');
  const lifecycle=currentBookingStatus(record);
  const scope=quickBooksAccountingScope(record);
  if(!lifecycle||!scope.actionable){
    throw new Error(!lifecycle
      ? 'This record is no longer accepted/booked. The approved repair is invalid and no QuickBooks write was attempted.'
      : scope.reason+' The approved repair is invalid and no QuickBooks write was attempted.');
  }
  const settings = await getQuickBooksSettings(context);
  const itemId = clean(settings?.serviceItemId, 80);

  await syncQuickBooksAccountingStatus(context, record);
  await refreshQuickBooksPaymentSnapshot(context, record);
  const liveFingerprint = accountingRepairFingerprint(record, itemId);
  if (liveFingerprint !== String(preview.beforeFingerprint || '')) {
    throw new Error('CRM or QuickBooks changed after this preview. Preview the repair again so the approved changes match the current state.');
  }

  const beforeAudit = buildQuickBooksAccountingAudit(records);
  const beforeRow = beforeAudit.rows.find((row: any) => row.recordId === record.id) || preview.beforeAudit || null;
  const documents: any[] = [];

  if ((preview.changes || []).some((change: any) => change?.id === 'estimate' && change?.writesQuickBooks)) {
    if (!itemId) throw new Error('Choose the QuickBooks service item before applying the estimate repair.');
    const estimate = await syncEstimate(context, record, itemId);
    documents.push({
      type: 'estimate',
      id: String(estimate?.Id || ''),
      docNumber: String(estimate?.DocNumber || ''),
      beforeTotal: preview.changes.find((change: any) => change?.id === 'estimate')?.before?.total ?? null,
      afterTotal: roundMoney(estimate?.TotalAmt || record?.proposal?.total || 0),
    });
  }

  for (const change of (preview.changes || []).filter((row: any) => row?.documentType === 'invoice' && row?.writesQuickBooks)) {
    const invoice = await updateUnpaidMilestoneInvoice(context, record, itemId, change);
    documents.push({
      type: 'invoice',
      id: String(invoice?.Id || change.invoiceId || ''),
      docNumber: String(invoice?.DocNumber || change.docNumber || ''),
      paymentId: String(change.paymentId || ''),
      beforeTotal: roundMoney(change?.before?.total || 0),
      afterTotal: roundMoney(invoice?.TotalAmt || change?.after?.total || 0),
      balance: roundMoney(invoice?.Balance ?? change?.after?.balance ?? 0),
    });
  }

  await syncQuickBooksAccountingStatus(context, record);
  await refreshQuickBooksPaymentSnapshot(context, record);
  records = await saveQuickBooksSalesRecord(context, record, records);

  const afterAudit = buildQuickBooksAccountingAudit(records);
  const reconciliation = applyQuickBooksReconciliationHistory(records, afterAudit, 'repair', [record.id]);
  if (reconciliation.changedRecordIds.includes(record.id)) {
    records = await saveQuickBooksSalesRecord(context, record, records);
  }
  const afterRow = afterAudit.rows.find((row: any) => row.recordId === record.id) || null;
  const qbo = quickBooksState(record);
  const resolved = Boolean(afterRow?.reconciled);
  const remainingIssues = afterRow?.issues || [];
  const repairEntry = {
    id: 'REPAIR-' + idSuffix(),
    previewId,
    approvedAt: new Date().toISOString(),
    approvedBy: actor,
    resolved,
    estimateId: String(qbo.estimateId || ''),
    estimateDocNumber: String(qbo.estimateDocNumber || ''),
    documents,
    before: beforeRow,
    after: afterRow,
    remainingIssues,
    changes: preview.changes || [],
  };
  qbo.repairHistory = [repairEntry, ...(Array.isArray(qbo.repairHistory) ? qbo.repairHistory : [])].slice(0, 100);
  records = await saveQuickBooksSalesRecord(context, record, records);

  const beforeTotal = beforeRow?.estimateTotal == null ? 'missing' : '$' + roundMoney(beforeRow.estimateTotal).toFixed(2);
  const afterTotal = afterRow?.estimateTotal == null ? 'missing' : '$' + roundMoney(afterRow.estimateTotal).toFixed(2);
  const beforeIssues = (beforeRow?.issues || []).map((issue: any) => issue.code).filter(Boolean).join(', ') || 'none';
  const afterIssues = remainingIssues.map((issue: any) => issue.code).filter(Boolean).join(', ') || 'none';
  const documentSummary = documents.length
    ? documents.map((doc: any) => (doc.type === 'invoice' ? 'invoice' : 'estimate') + ' #' + (doc.docNumber || doc.id || 'unknown') + ' $' + Number(doc.beforeTotal || 0).toFixed(2) + ' → $' + Number(doc.afterTotal || 0).toFixed(2)).join('; ')
    : 'no QuickBooks document write';
  const activity = await appendClientAccountingActivity(
    context,
    tenant,
    record.id,
    'accounting_repair',
    'Accounting repair ' + previewId + ' approved by ' + actor + '. ' + documentSummary + '. Estimate ' + beforeTotal + ' → ' + afterTotal + '. Issues before: ' + beforeIssues + '. Issues after: ' + afterIssues + '. Reconciled: ' + (resolved ? 'yes' : 'no') + '.',
  );
  await appendEvent(context, {
    type: 'quickbooks_accounting_repair',
    recordId: record.id,
    quoteId: record.quoteId || '',
    detail: 'Approved accounting repair ' + previewId + ' applied. ' + documentSummary + '. Remaining issues: ' + afterIssues + '.',
  });
  await integrationStore.delete(repairPreviewKey(previewId));

  let bulkPreviewAudit:any=null;
  if (clean(preview?.bulkPreviewId,140) && clean(preview?.bulkChangeId,180)) {
    const decision = await appendBulkRepairDecision(context, clean(preview.bulkPreviewId,140), {
      decision:'approved',
      decidedBy:actor,
      recordId:record.id,
      changeId:clean(preview.bulkChangeId,180),
      previewId,
      resolved,
      remainingIssues,
      before:preview?.changes?.[0]?.before||null,
      after:preview?.changes?.[0]?.after||null,
      documents,
    });
    bulkPreviewAudit=decision.audit;
  }
  return {
    repair: repairEntry,
    activity,
    record,
    accountingAudit: afterAudit,
    resolved,
    remainingIssues,
    bulkPreviewAudit,
  };
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const isCallback = url.pathname.endsWith('/callback');

  if (isCallback) {
    try {
      await completeOAuth(context, req.url);
      return Response.redirect(url.origin + '/admin/quickbooks/?connected=1', 302);
    } catch {
      return Response.redirect(url.origin + '/admin/quickbooks/?qbo=error', 302);
    }
  }

  const auth = await requireCapability('quickbooks.view', req);
  if (auth.response) return auth.response;
  const tenant = auth.tenant || resolveTenant(req);
  const taxDefaults = tenantTaxDefaults(tenant);

  if (req.method === 'GET') {
    const view = clean(url.searchParams.get('view'), 40);
    if (view === 'damage-deposit-settings') {
      const [connection, damageDepositSettings] = await Promise.all([
        getQuickBooksConnection(context),
        getQuickBooksDamageDepositSettings(context),
      ]);
      return Response.json({
        connection: connection ? {
          connected:true,
          companyName:connection.companyName || '',
          connectedAt:connection.connectedAt,
        } : { connected:false },
        tenant:clientTenantProfile(tenant),
        damageDepositSettings,
      }, { headers:{'Cache-Control':'private, no-store'} });
    }

    if (view === 'history') {
      const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit') || 100)));
      const history = await getQuickBooksCrmSyncHistory(context, limit);
      return Response.json({ history }, { headers:{ 'Cache-Control':'private, no-store' } });
    }
    if (view === 'history-detail') {
      const syncId = clean(url.searchParams.get('syncId'), 120);
      const detail = await getQuickBooksCrmSyncHistoryDetail(context, syncId);
      if (!detail) return Response.json({ error:'QuickBooks sync history entry not found.' }, { status:404 });
      return Response.json({ detail }, { headers:{ 'Cache-Control':'private, no-store' } });
    }
    if (view === 'rollback-preview') {
      const syncId = clean(url.searchParams.get('syncId'), 120);
      try {
        const rollbackPreview = await previewQuickBooksCrmSyncRollback(context, syncId);
        return Response.json({ rollbackPreview }, { headers:{ 'Cache-Control':'private, no-store' } });
      } catch (error) {
        return Response.json({ error:error instanceof Error ? error.message : 'Unable to preview CRM rollback.' }, { status:409 });
      }
    }
    if (view === 'preview-export') {
      const previewId = clean(url.searchParams.get('previewId'), 120);
      const format = clean(url.searchParams.get('format'), 12).toLowerCase();
      const preview = await getLastQuickBooksCrmSyncPreview(context);
      if (!preview?.previewId || clean(preview.previewId,120) !== previewId) {
        return Response.json({ error:'That Preview Sync is no longer the current audit preview. Run Preview Sync again before exporting.' }, { status:409 });
      }
      const stamp = clean(preview.generatedAt,40).replace(/[^0-9TZ-]/g,'').replace(/[:.]/g,'').slice(0,24) || 'preview';
      const baseName = 'quickbooks-crm-preview-audit-' + stamp;
      if (format === 'csv') {
        return new Response(buildQuickBooksCrmPreviewCsv(preview), {
          headers:{
            'Content-Type':'text/csv; charset=utf-8',
            'Content-Disposition':'attachment; filename="' + baseName + '.csv"',
            'Cache-Control':'private, no-store',
          },
        });
      }
      if (format === 'pdf') {
        return new Response(buildQuickBooksCrmPreviewPdf(preview), {
          headers:{
            'Content-Type':'application/pdf',
            'Content-Disposition':'attachment; filename="' + baseName + '.pdf"',
            'Cache-Control':'private, no-store',
          },
        });
      }
      return Response.json({ error:'Choose CSV or PDF export format.' }, { status:400 });
    }

    if (view === 'accounting-repair-bulk-export') {
      const bulkPreviewId = clean(url.searchParams.get('bulkPreviewId'), 140);
      const format = clean(url.searchParams.get('format'), 12).toLowerCase();
      const audit = await readBulkRepairPreviewAudit(context, bulkPreviewId);
      if (!audit?.bulkPreviewId) return Response.json({ error:'Bulk repair preview audit not found.' }, { status:404 });
      const stamp = clean(audit.generatedAt,40).replace(/[^0-9TZ-]/g,'').replace(/[:.]/g,'').slice(0,24) || 'preview';
      const baseName = 'quickbooks-accounting-repair-preview-' + stamp;
      if (format === 'csv') {
        return new Response(buildAccountingRepairBulkPreviewCsv(audit), {
          headers:{
            'Content-Type':'text/csv; charset=utf-8',
            'Content-Disposition':'attachment; filename="' + baseName + '.csv"',
            'Cache-Control':'private, no-store',
          },
        });
      }
      if (format === 'pdf') {
        return new Response(buildAccountingRepairBulkPreviewPdf(audit), {
          headers:{
            'Content-Type':'application/pdf',
            'Content-Disposition':'attachment; filename="' + baseName + '.pdf"',
            'Cache-Control':'private, no-store',
          },
        });
      }
      return Response.json({ error:'Choose CSV or PDF export format.' }, { status:400 });
    }

    const [connection, settings, catalog, getSettings, depositSettings, damageDepositSettings, webhookReceipt, webhookHistory, webhookProcessed, smokeTest, linkedTest, productionTest, productionLinkedTest, manualSync, manualSyncPreview, manualSyncJob, lastSyncFailure, suggestedExclusionRules, suggestedExclusionDismissalCount] = await Promise.all([
      getQuickBooksConnection(context),
      getQuickBooksSettings(context),
      getQuickBooksCatalog(context),
      getQuickBooksGetSettings(context, taxDefaults),
      getQuickBooksDepositSettings(context),
      getQuickBooksDamageDepositSettings(context),
      integrationStoreFor(context).get('quickbooks/webhook-last-receipt', { type: 'json' }),
      integrationStoreFor(context).get('quickbooks/webhook-receipts/index', { type: 'json' }),
      integrationStoreFor(context).get('quickbooks/webhook-last-processed', { type: 'json' }),
      integrationStoreFor(context).get('quickbooks/sandbox-smoke-test', { type: 'json' }),
      integrationStoreFor(context).get('quickbooks/sandbox-linked-booking-test', { type: 'json' }),
      integrationStoreFor(context).get('quickbooks/production-smoke-test', { type: 'json' }),
      integrationStoreFor(context).get('quickbooks/production-linked-booking-test', { type: 'json' }),
      getLastQuickBooksCrmSync(context),
      getLastQuickBooksCrmSyncPreview(context),
      getCurrentQuickBooksCrmSyncJob(context),
      getLastQuickBooksCrmSyncFailure(context),
      getQuickBooksSuggestedExclusionRules(context),
      getQuickBooksSuggestedExclusionDismissalCount(context),
    ]);
    const records = await readQuickBooksSalesRecords(context);
    const accountingAudit = buildQuickBooksAccountingAudit(records);
    const receipts = Array.isArray(webhookHistory) && webhookHistory.length
      ? webhookHistory
      : (webhookReceipt ? [webhookReceipt] : []);
    const receiptEntities = receipts.flatMap((receipt: any) =>
      (receipt?.notifications || []).flatMap((notification: any) =>
        Array.isArray(notification?.entities) ? notification.entities : [],
      ),
    );
    const smokeWebhookMatch = smokeTest ? {
      invoiceMatched: receiptEntities.some((entity: any) =>
        String(entity?.name || '').toLowerCase() === 'invoice' &&
        String(entity?.id || '') === String(smokeTest.invoiceId || ''),
      ),
      paymentMatched: receiptEntities.some((entity: any) =>
        String(entity?.name || '').toLowerCase() === 'payment' &&
        String(entity?.id || '') === String(smokeTest.paymentId || ''),
      ),
    } : null;

    return Response.json({
      configuration: quickBooksConfiguration(),
      connection: connection ? {
        connected: true,
        realmId: connection.realmId,
        companyName: connection.companyName || '',
        connectedAt: connection.connectedAt,
        refreshExpiresAt: connection.refreshExpiresAt || '',
      } : { connected: false },
      tenant: clientTenantProfile(tenant),
      settings,
      catalog,
      getSettings,
      depositSettings,
      damageDepositSettings,
      webhookReceipt: webhookReceipt || null,
      webhookProcessed: webhookProcessed || null,
      smokeTest: smokeTest || null,
      linkedTest: linkedTest || null,
      productionTest: productionTest || null,
      productionLinkedTest: productionLinkedTest || null,
      manualSync: manualSync || null,
      manualSyncPreview: manualSyncPreview || null,
      manualSyncJob: manualSyncJob ? {
        jobId: clean(manualSyncJob.jobId,140),
        previewId: clean(manualSyncJob.previewId,140),
        status: clean(manualSyncJob.status,40),
        stage: clean(manualSyncJob.stage,40),
        startedAt: clean(manualSyncJob.startedAt,80),
        updatedAt: clean(manualSyncJob.updatedAt,80),
        completedAt: clean(manualSyncJob.completedAt,80),
        inboundCursor: Number(manualSyncJob.inboundCursor || 0),
        inboundTotal: Number(manualSyncJob.inboundTotal || 0),
        outboundCursor: Number(manualSyncJob.outboundCursor || 0),
        outboundTotal: Number(manualSyncJob.outboundTotal || 0),
        processed: Number(manualSyncJob.inboundCursor || 0) + Number(manualSyncJob.outboundCursor || 0),
        total: Number(manualSyncJob.inboundTotal || 0) + Number(manualSyncJob.outboundTotal || 0),
        currentItem: manualSyncJob.currentItem || null,
        lastFailure: manualSyncJob.lastFailure || null,
        canResume: ['running','paused_error'].includes(clean(manualSyncJob.status,40)),
        result: manualSyncJob.status === 'completed' ? (manualSyncJob.result || null) : null,
      } : null,
      lastSyncFailure: lastSyncFailure || null,
      suggestedExclusionRules,
      suggestedExclusionDismissalCount,
      accountingAudit,
      smokeWebhookMatch,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!hasCapability(auth.user,'quickbooks.manage')) return Response.json({ error:'Accounting management permission required.' }, { status:403 });
  const payload: any = await req.json().catch(() => null);
  const action = clean(payload?.action, 60);
  const actor = clean((auth.user as any)?.email || (auth.user as any)?.user_metadata?.email || 'staff', 240) || 'staff';


  if (action === 'preview-all-safe-accounting-repairs') {
    const records = await readQuickBooksSalesRecords(context);
    const settings = await getQuickBooksSettings(context);
    const itemId = clean(settings?.serviceItemId, 80);
    try {
      const bulkPreview = await buildBulkAccountingRepairPreview(
        context,
        tenant,
        records,
        itemId,
        actor,
        Array.isArray(payload?.recordIds) ? payload.recordIds : [],
      );
      return Response.json({ ok:true, bulkPreview }, { headers:{ 'Cache-Control':'private, no-store' } });
    } catch (error) {
      return Response.json({ error:error instanceof Error ? error.message : 'Unable to preview safe accounting repairs.' }, { status:409 });
    }
  }

  if (action === 'reject-accounting-repair-write') {
    try {
      const result = await appendBulkRepairDecision(context, clean(payload?.bulkPreviewId,140), {
        decision:'rejected',
        decidedBy:actor,
        recordId:clean(payload?.recordId,120),
        changeId:clean(payload?.changeId,180),
        reason:clean(payload?.reason,1200)||'Rejected from the consolidated repair preview.',
      });
      return Response.json({ ok:true, decision:result.entry, bulkPreviewAudit:result.audit }, { headers:{ 'Cache-Control':'private, no-store' } });
    } catch (error) {
      return Response.json({ error:error instanceof Error ? error.message : 'Unable to record the repair rejection.' }, { status:409 });
    }
  }

  if (action === 'preview-accounting-repair-write') {
    const recordId = clean(payload?.recordId, 120);
    const changeId = clean(payload?.changeId, 180);
    const records = await readQuickBooksSalesRecords(context);
    const source = records.find((entry: any) => entry.id === recordId && entry.kind === 'proposal');
    if (!source) return Response.json({ error:'Proposal record not found.' }, { status:404 });
    if (!currentBookingStatus(source) || !quickBooksAccountingScope(source).actionable) {
      return Response.json({ error:'This record is no longer eligible for an accounting repair.' }, { status:409 });
    }
    const settings = await getQuickBooksSettings(context);
    const itemId = clean(settings?.serviceItemId, 80);
    try {
      const record = structuredClone(source);
      const isolatedRecords = records.map((entry: any) => entry.id === recordId ? record : entry);
      const result = await buildAccountingRepairWritePreview(
        context,
        tenant,
        record,
        isolatedRecords,
        itemId,
        actor,
        changeId,
        clean(payload?.bulkPreviewId,140),
      );
      return Response.json({ ok:true, ...result }, { headers:{ 'Cache-Control':'private, no-store' } });
    } catch (error) {
      return Response.json({ error:error instanceof Error ? error.message : 'Unable to preview that individual QuickBooks write.' }, { status:409 });
    }
  }

  if (action === 'preview-accounting-repair') {
    const recordId = clean(payload?.recordId, 100);
    const records = await readQuickBooksSalesRecords(context);
    const record = records.find((entry: any) => entry.id === recordId && entry.kind === 'proposal');
    if (!record) return Response.json({ error:'Proposal record not found.' }, { status:404 });
    const lifecycle = currentBookingStatus(record);
    const scope = quickBooksAccountingScope(record);
    if (!lifecycle || !scope.actionable) {
      return Response.json({
        error:!lifecycle
          ? 'This record is no longer accepted/booked and is outside the current repair population.'
          : scope.reason,
      }, { status:409 });
    }
    const settings = await getQuickBooksSettings(context);
    const itemId = clean(settings?.serviceItemId, 80);
    try {
      const result = await buildAccountingRepairPreview(context, tenant, record, records, itemId, actor);
      return Response.json({ ok:true, ...result }, { headers:{ 'Cache-Control':'private, no-store' } });
    } catch (error) {
      return Response.json({ error:error instanceof Error ? error.message : 'Unable to preview the accounting repair.' }, { status:409 });
    }
  }

  if (action === 'apply-accounting-repair') {
    try {
      const result = await applyAccountingRepair(
        context,
        tenant,
        clean(payload?.previewId, 120),
        payload?.approved === true,
        actor,
      );
      return Response.json({ ok:true, ...result }, { headers:{ 'Cache-Control':'private, no-store' } });
    } catch (error) {
      return Response.json({ error:error instanceof Error ? error.message : 'Unable to apply the accounting repair.' }, { status:409 });
    }
  }

  if (action === 'preview-two-way') {
    const actor = clean(auth.user?.email || auth.user?.name || 'admin', 180);
    const preview = await buildQuickBooksCrmSyncPreview(context, actor);
    return Response.json({ ok:true, preview }, { headers:{ 'Cache-Control':'private, no-store' } });
  }
  if (action === 'save-suggested-exclusion-rules') {
    try {
      const rules = await saveQuickBooksSuggestedExclusionRules(
        context,
        Array.isArray(payload?.rules) ? payload.rules : [],
      );
      return Response.json({
        ok:true,
        rules,
        suggestedExclusionDismissalCount:0,
      }, { headers:{ 'Cache-Control':'private, no-store' } });
    } catch (error) {
      return Response.json({ error:error instanceof Error ? error.message : 'Unable to save suggested-exclusion rules.' }, { status:400 });
    }
  }

  if (action === 'reset-suggested-exclusion-rules') {
    const rules = await resetQuickBooksSuggestedExclusionRules(context);
    return Response.json({
      ok:true,
      rules,
      suggestedExclusionDismissalCount:0,
    }, { headers:{ 'Cache-Control':'private, no-store' } });
  }

  if (action === 'dismiss-suggested-exclusion') {
    try {
      const result = await dismissQuickBooksSuggestedExclusion(context, {
        previewId: clean(payload?.previewId,120),
        customerId: clean(payload?.customerId,100),
        ruleSignature: clean(payload?.ruleSignature,500),
      }, actor);
      const suggestedExclusionDismissalCount = await getQuickBooksSuggestedExclusionDismissalCount(context);
      return Response.json({ ok:true, result, suggestedExclusionDismissalCount }, { headers:{ 'Cache-Control':'private, no-store' } });
    } catch (error) {
      return Response.json({ error:error instanceof Error ? error.message : 'Unable to keep this customer in normal review.' }, { status:409 });
    }
  }

  if (action === 'clear-suggested-exclusion-dismissals') {
    await clearQuickBooksSuggestedExclusionDismissals(context);
    return Response.json({ ok:true, suggestedExclusionDismissalCount:0 }, { headers:{ 'Cache-Control':'private, no-store' } });
  }


  if (action === 'save-customer-match') {
    const actor = clean(auth.user?.email || auth.user?.name || 'admin', 180);
    try {
      const result = await saveQuickBooksMatchOverride(context, {
        customerId: clean(payload?.customerId, 100),
        decision: clean(payload?.decision, 20) as 'match'|'new'|'exclude'|'clear',
        recordId: clean(payload?.recordId, 120),
        reasonCode: clean(payload?.reasonCode, 60),
        reason: clean(payload?.reason, 500),
      }, actor);
      return Response.json({ ok:true, result }, { headers:{ 'Cache-Control':'private, no-store' } });
    } catch (error) {
      return Response.json({ error:error instanceof Error ? error.message : 'Unable to save QuickBooks customer match.' }, { status:409 });
    }
  }

  if (action === 'bulk-approve-new-customers') {
    const actor = clean(auth.user?.email || auth.user?.name || 'admin', 180);
    try {
      const result = await saveQuickBooksBulkNewOverrides(context, {
        previewId: clean(payload?.previewId, 120),
        customerIds: Array.isArray(payload?.customerIds) ? payload.customerIds : [],
      }, actor);
      return Response.json({ ok:true, result }, { headers:{ 'Cache-Control':'private, no-store' } });
    } catch (error) {
      return Response.json({ error:error instanceof Error ? error.message : 'Unable to bulk approve QuickBooks customer imports.' }, { status:409 });
    }
  }

  if (action === 'bulk-exclude-customers') {
    const actor = clean(auth.user?.email || auth.user?.name || 'admin', 180);
    try {
      const result = await saveQuickBooksBulkExclusionOverrides(context, {
        previewId: clean(payload?.previewId, 120),
        customerIds: Array.isArray(payload?.customerIds) ? payload.customerIds : [],
        reasonCode: clean(payload?.reasonCode, 60),
        reason: clean(payload?.reason, 500),
      }, actor);
      return Response.json({ ok:true, result }, { headers:{ 'Cache-Control':'private, no-store' } });
    } catch (error) {
      return Response.json({ error:error instanceof Error ? error.message : 'Unable to bulk exclude QuickBooks customers.' }, { status:409 });
    }
  }

  if (action === 'rollback-sync-crm') {
    const actor = clean(auth.user?.email || auth.user?.name || 'admin', 180);
    const syncId = clean(payload?.syncId, 120);
    try {
      const rollback = await applyQuickBooksCrmSyncRollback(context, syncId, actor, clean(payload?.recordId,120));
      const records = await readQuickBooksSalesRecords(context);
      const accountingAudit = buildQuickBooksAccountingAudit(records);
      return Response.json({ ok:true, rollback, accountingAudit }, { headers:{ 'Cache-Control':'private, no-store' } });
    } catch (error) {
      return Response.json({ error:error instanceof Error ? error.message : 'Unable to restore CRM records from this sync.' }, { status:409 });
    }
  }

  if (action === 'sync-two-way') {
    const actor = clean(auth.user?.email || auth.user?.name || 'admin', 180);
    const previewId = clean(payload?.previewId, 120);
    try {
      const existingJob = await getCurrentQuickBooksCrmSyncJob(context);
      const resumingExisting = Boolean(
        existingJob?.jobId &&
        clean(existingJob.previewId,120) === previewId &&
        ['running','paused_error'].includes(clean(existingJob.status,40))
      );
      if (!resumingExisting) await validateQuickBooksCrmSyncPreview(context, previewId);
      const syncJob = await startQuickBooksCrmTwoWaySyncJob(context, actor, previewId);
      return Response.json({ ok:true, syncJob, resumed:resumingExisting }, { headers:{ 'Cache-Control':'private, no-store' } });
    } catch (error) {
      const message = error instanceof Error ? clean(error.message,1000) : 'Unable to start QuickBooks synchronization.';
      return Response.json({ error:message, code:'quickbooks_sync_start_failed', previewId }, { status:409, headers:{ 'Cache-Control':'private, no-store' } });
    }
  }

  if (action === 'sync-two-way-continue') {
    const jobId = clean(payload?.jobId, 140);
    try {
      const syncJob = await continueQuickBooksCrmTwoWaySyncJob(context, jobId);
      const records = syncJob?.status === 'completed' ? await readQuickBooksSalesRecords(context) : null;
      const accountingAudit = records ? buildQuickBooksAccountingAudit(records) : null;
      const lastSyncFailure = await getLastQuickBooksCrmSyncFailure(context);
      return Response.json({
        ok:true,
        syncJob,
        result:syncJob?.result || null,
        accountingAudit,
        lastSyncFailure:lastSyncFailure || null,
      }, { headers:{ 'Cache-Control':'private, no-store' } });
    } catch (error) {
      const detail: any = error || {};
      const message = error instanceof Error ? clean(error.message,1000) : 'QuickBooks synchronization batch failed.';
      console.error('QuickBooks two-way sync batch failed', {
        tenantId:clean(tenant?.id,120),
        jobId,
        actor,
        message,
      });
      return Response.json({
        error:message,
        code:'quickbooks_sync_batch_failed',
        jobId,
        syncJob:detail?.syncJob || null,
        failure:detail?.failure || null,
        canResume:Boolean(detail?.syncJob?.canResume),
      }, { status:502, headers:{ 'Cache-Control':'private, no-store' } });
    }
  }

  if (action === 'test-accounting-alert') {
    const now = new Date().toISOString();
    const result = await sendAccountingTransitionAlerts([{
      recordId: 'TEST-ACCOUNTING',
      clientName: 'Koa’s Accounting Test',
      type: 'mismatch_detected',
      after: [{ code:'test_balance', label:'Test reconciliation balance', expected:100, actual:95, delta:-5 }],
    }], 'test-' + now, { test:true });
    return Response.json({ ok:true, result }, { headers: { 'Cache-Control':'private, no-store' } });
  }

  if (action === 'save-deposit-settings') {
    const depositSettings = await saveQuickBooksDepositSettings(context, {
      defaultPercent: payload?.defaultPercent,
      venueWeddingPercent: payload?.venueWeddingPercent,
      mobileBarPercent: payload?.mobileBarPercent,
      privateEventPercent: payload?.privateEventPercent,
      venueWeddingSecondDueDaysBefore: payload?.venueWeddingSecondDueDaysBefore,
      venueWeddingFinalDueDaysBefore: payload?.venueWeddingFinalDueDaysBefore,
      venueWeddingSecondPercentOfRemaining: payload?.venueWeddingSecondPercentOfRemaining,
      mobileBarFinalDueDaysBefore: payload?.mobileBarFinalDueDaysBefore,
      privateEventFinalDueDaysBefore: payload?.privateEventFinalDueDaysBefore,
      defaultFinalDueDaysBefore: payload?.defaultFinalDueDaysBefore,
      venueWeddingMilestones: payload?.venueWeddingMilestones,
      mobileBarMilestones: payload?.mobileBarMilestones,
      privateEventMilestones: payload?.privateEventMilestones,
      defaultMilestones: payload?.defaultMilestones,
      customPresets: payload?.customPresets,
      autoRules: payload?.autoRules,
    });
    return Response.json({ ok: true, depositSettings }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  if (action === 'list-damage-deposit-accounts') {
    const [accountData,itemData]:any[] = await Promise.all([
      qboQuery(context, 'select * from Account where Active = true maxresults 1000'),
      qboQuery(context, 'select * from Item where Active = true maxresults 1000'),
    ]);
    const rows = Array.isArray(accountData?.QueryResponse?.Account) ? accountData.QueryResponse.Account : [];
    const map = (types: string[]) => rows
      .filter((account: any) => types.includes(String(account.AccountType || '')))
      .map((account: any) => ({
        id:String(account.Id),
        name:String(account.Name || ''),
        type:String(account.AccountType || ''),
        subType:String(account.AccountSubType || ''),
      }))
      .sort((a: any,b: any)=>a.name.localeCompare(b.name));
    const items=(Array.isArray(itemData?.QueryResponse?.Item)?itemData.QueryResponse.Item:[])
      .filter((item:any)=>['Service','NonInventory'].includes(String(item.Type||'')))
      .map((item:any)=>({
        id:String(item.Id),
        name:String(item.Name||''),
        type:String(item.Type||''),
        incomeAccountId:String(item?.IncomeAccountRef?.value||''),
        incomeAccountName:String(item?.IncomeAccountRef?.name||''),
      }))
      .sort((a:any,b:any)=>a.name.localeCompare(b.name));
    return Response.json({
      liabilityAccounts:map(['Other Current Liability','Long Term Liability']),
      bankAccounts:map(['Bank']),
      incomeAccounts:map(['Income','Other Income']),
      items,
    }, { headers:{'Cache-Control':'private, no-store'} });
  }

  if (action === 'save-damage-deposit-settings') {
    let damageDepositSettings = await saveQuickBooksDamageDepositSettings(context, {
      enabled:payload?.enabled !== false,
      oneDayAmount:payload?.oneDayAmount,
      weekendAmount:payload?.weekendAmount,
      dueDaysBefore:payload?.dueDaysBefore,
      refundWithinDays:payload?.refundWithinDays,
      liabilityAccountId:clean(payload?.liabilityAccountId,80),
      liabilityAccountName:clean(payload?.liabilityAccountName,160),
      itemId:clean(payload?.itemId,80),
      itemName:clean(payload?.itemName || 'Refundable Damage Deposit',160),
      refundBankAccountId:clean(payload?.refundBankAccountId,80),
      refundBankAccountName:clean(payload?.refundBankAccountName,160),
      deductionIncomeAccountId:clean(payload?.deductionIncomeAccountId,80),
      deductionIncomeAccountName:clean(payload?.deductionIncomeAccountName,160),
    });

    if (damageDepositSettings.itemId && damageDepositSettings.liabilityAccountId) {
      try {
        const mappedData:any=await qboGet(context,'item',damageDepositSettings.itemId);
        const mapped=mappedData?.Item;
        const mappedAccountId=String(mapped?.IncomeAccountRef?.value||'');
        const mappedAccountName=String(mapped?.IncomeAccountRef?.name||'');
        if(!mapped?.Id) {
          return Response.json({error:'The selected refundable-deposit QuickBooks item could not be loaded.'},{status:409});
        }
        if(mappedAccountId!==damageDepositSettings.liabilityAccountId) {
          return Response.json({
            error:'The selected QuickBooks item is mapped to '+(mappedAccountName||mappedAccountId||'another account')+', not the configured refundable-deposit liability account. Choose or create an item mapped to the liability account before enabling this workflow.',
            damageDepositSettings,
          },{status:409});
        }
        damageDepositSettings=await saveQuickBooksDamageDepositSettings(context,{
          ...damageDepositSettings,
          itemName:String(mapped.Name||damageDepositSettings.itemName||'Refundable Damage Deposit'),
        });
      } catch (error) {
        return Response.json({
          error:'Unable to verify the selected refundable-deposit item mapping in QuickBooks. '+(error instanceof Error?error.message:''),
          damageDepositSettings,
        },{status:409});
      }
    }

    if (!damageDepositSettings.itemId && damageDepositSettings.liabilityAccountId) {
      try {
        const created:any=await qboCreate(context,'item',{
          Name:damageDepositSettings.itemName || 'Refundable Damage Deposit',
          Description:'Refundable security / damage deposit held as a customer liability.',
          Active:true,
          Type:'Service',
          UnitPrice:damageDepositSettings.oneDayAmount,
          IncomeAccountRef:{
            value:damageDepositSettings.liabilityAccountId,
            name:damageDepositSettings.liabilityAccountName || undefined,
          },
        });
        const item=created?.Item;
        if(item?.Id) {
          damageDepositSettings=await saveQuickBooksDamageDepositSettings(context,{
            ...damageDepositSettings,
            itemId:String(item.Id),
            itemName:String(item.Name||damageDepositSettings.itemName),
          });
        }
      } catch (error) {
        return Response.json({
          error:'QuickBooks could not create the dedicated refundable-deposit item against the selected liability account. '+(error instanceof Error?error.message:'Choose a compatible liability account or create the item in QuickBooks and save its mapping.'),
          damageDepositSettings,
        },{status:409});
      }
    }

    return Response.json({ok:true,damageDepositSettings},{headers:{'Cache-Control':'private, no-store'}});
  }

  if (action === 'connect') {
    const authFlow = await createOAuthState(context, req.url);
    return Response.json({ ok: true, ...authFlow });
  }

  if (action === 'disconnect') {
    await disconnectQuickBooks(context);
    return Response.json({ ok: true });
  }

  if (action === 'list-items') {
    const data: any = await qboQuery(context, 'select * from Item where Active = true maxresults 100');
    const items = (data?.QueryResponse?.Item || [])
      .filter((item: any) => ['Service','NonInventory'].includes(String(item.Type || '')))
      .map((item: any) => ({
        id: String(item.Id),
        name: String(item.Name || ''),
        type: String(item.Type || ''),
        incomeAccountId: String(item?.IncomeAccountRef?.value || ''),
        incomeAccountName: String(item?.IncomeAccountRef?.name || ''),
      }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name));
    return Response.json({ items });
  }

  if (action === 'set-service-item') {
    const itemId = clean(payload?.itemId, 80);
    const itemName = clean(payload?.itemName, 240);
    if (!itemId) return Response.json({ error: 'Select a QuickBooks service item.' }, { status: 400 });
    const settings = await saveQuickBooksSettings(context, { serviceItemId: itemId, serviceItemName: itemName });
    return Response.json({ ok: true, settings });
  }

  if (action === 'save-get-settings') {
    const getSettings = await saveQuickBooksGetSettings(context, {
      enabled: payload?.enabled == null ? tenant.tax.enabled : payload.enabled !== false,
      label: clean(payload?.label || tenant.tax.label || 'Tax', 80),
      statutoryRate: Number(payload?.statutoryRate ?? tenant.tax.statutoryRate),
      customerRate: Number(payload?.customerRate ?? tenant.tax.customerRate),
      maxPassOnRate: Number(payload?.maxPassOnRate ?? tenant.tax.maxPassOnRate),
      quickBooksItemId: clean(payload?.quickBooksItemId, 80),
      quickBooksItemName: clean(payload?.quickBooksItemName, 100),
    }, taxDefaults);
    return Response.json({ ok: true, getSettings });
  }

  if (action === 'save-catalog-item') {
    const existingCatalog = await getQuickBooksCatalog(context);
    const requestedId = clean(payload?.item?.id, 80);
    const id = requestedId || ('catalog-' + idSuffix().toLowerCase());
    const name = clean(payload?.item?.name, 100);
    const description = clean(payload?.item?.description, 1000);
    const category = ['service','rental','mileage','fee'].includes(String(payload?.item?.category || ''))
      ? String(payload.item.category)
      : 'service';
    const unitLabel = clean(payload?.item?.unitLabel || (category === 'mileage' ? 'mile' : 'each'), 40);
    const unitPrice = Math.max(0, Math.round(Number(payload?.item?.unitPrice || 0) * 100) / 100);
    const active = payload?.item?.active !== false;
    const getExempt = payload?.item?.getExempt === true;
    if (!name) return Response.json({ error: 'Catalog item name is required.' }, { status: 400 });

    const previous = existingCatalog.find((entry: any) => entry.id === id);
    const defaultSettings = await getQuickBooksSettings(context);
    const fallbackItemId = clean(defaultSettings?.serviceItemId, 80);
    let incomeAccountId = clean(payload?.item?.incomeAccountId || previous?.incomeAccountId, 80);
    let incomeAccountName = clean(payload?.item?.incomeAccountName || previous?.incomeAccountName, 160);
    const requestedType = String(payload?.item?.quickBooksType || previous?.quickBooksType || (category === 'rental' ? 'NonInventory' : 'Service')) === 'NonInventory'
      ? 'NonInventory'
      : 'Service';

    if ((!incomeAccountId || !incomeAccountName) && fallbackItemId) {
      try {
        const fallbackData: any = await qboGet(context, 'item', fallbackItemId);
        const fallback = fallbackData?.Item;
        if (fallback) {
          incomeAccountId ||= String(fallback?.IncomeAccountRef?.value || '');
          incomeAccountName ||= String(fallback?.IncomeAccountRef?.name || '');
        }
      } catch {}
    }
    if (!incomeAccountId) {
      return Response.json({ error: 'Map a default QuickBooks service item first so the CRM knows which income account new catalog items should use.' }, { status: 409 });
    }

    let qboItem: any = null;
    let quickBooksItemId = clean(payload?.item?.quickBooksItemId || previous?.quickBooksItemId, 80);
    if (quickBooksItemId) {
      const currentData: any = await qboGet(context, 'item', quickBooksItemId);
      const current = currentData?.Item;
      if (current?.Id && current?.SyncToken != null && String(current.Type || '') === requestedType) {
        const updated: any = await qboUpdate(context, 'item', {
          Id: String(current.Id),
          SyncToken: String(current.SyncToken),
          Name: name,
          Description: description || undefined,
          Active: active,
          UnitPrice: unitPrice,
          IncomeAccountRef: { value: incomeAccountId, name: incomeAccountName || undefined },
        });
        qboItem = updated?.Item;
      }
    }
    if (!qboItem) {
      const created: any = await qboCreate(context, 'item', {
        Name: name,
        Description: description || undefined,
        Active: active,
        Type: requestedType,
        UnitPrice: unitPrice,
        IncomeAccountRef: { value: incomeAccountId, name: incomeAccountName || undefined },
      });
      qboItem = created?.Item;
      quickBooksItemId = String(qboItem?.Id || '');
    }
    if (!qboItem?.Id) throw new Error('QuickBooks catalog item could not be saved.');

    const item = {
      id,
      name,
      description,
      category,
      group: previous?.group || (category === 'rental' ? 'rentals' : category === 'fee' ? 'fees' : 'add-ons'),
      unitLabel,
      unitPrice,
      internalCost: Math.max(0, Number(previous?.internalCost || 0)),
      targetMargin: Math.min(100, Math.max(0, Number(previous?.targetMargin || 0))),
      active,
      getExempt,
      source: previous?.source || 'catalog-manager',
      sourceRef: previous?.sourceRef || '',
      quickBooksItemId: String(qboItem.Id),
      quickBooksItemName: String(qboItem.Name || name),
      quickBooksType: String(qboItem.Type || requestedType) === 'NonInventory' ? 'NonInventory' : 'Service',
      incomeAccountId: String(qboItem?.IncomeAccountRef?.value || incomeAccountId),
      incomeAccountName: String(qboItem?.IncomeAccountRef?.name || incomeAccountName),
      updatedAt: new Date().toISOString(),
    };
    const catalog = [item, ...existingCatalog.filter((entry: any) => entry.id !== id)]
      .sort((a: any, b: any) => a.name.localeCompare(b.name));
    await saveQuickBooksCatalog(context, catalog as any, {
      actor,
      source:'quickbooks-item-save',
      sourceRef:String(qboItem.Id || ''),
      note:'Saved catalog item and QuickBooks item mapping.',
    });
    return Response.json({ ok: true, item, catalog });
  }

  if (action === 'archive-catalog-item') {
    const id = clean(payload?.id, 80);
    const existingCatalog = await getQuickBooksCatalog(context);
    const item = existingCatalog.find((entry: any) => entry.id === id);
    if (!item) return Response.json({ error: 'Catalog item not found.' }, { status: 404 });
    const catalog = existingCatalog.map((entry: any) => entry.id === id ? { ...entry, active: false, updatedAt: new Date().toISOString() } : entry);
    await saveQuickBooksCatalog(context, catalog as any, {
      actor,
      source:'quickbooks-catalog-archive',
      sourceRef:id,
      note:'Archived catalog item from the QuickBooks workspace.',
    });
    return Response.json({ ok: true, catalog });
  }

  if (action === 'import-qbo-items') {
    const data: any = await qboQuery(context, 'select * from Item where Active = true maxresults 1000');
    const existing = await getQuickBooksCatalog(context);
    const byQboId = new Map(existing.map((entry: any) => [entry.quickBooksItemId, entry]));
    const imported = (data?.QueryResponse?.Item || [])
      .filter((item: any) => ['Service','NonInventory'].includes(String(item.Type || '')))
      .map((item: any) => {
        const prior: any = byQboId.get(String(item.Id));
        return {
          id: prior?.id || ('qbo-' + String(item.Id)),
          name: String(item.Name || ''),
          description: String(item.Description || ''),
          category: prior?.category || (String(item.Type || '') === 'NonInventory' ? 'rental' : 'service'),
          group: prior?.group || (String(item.Type || '') === 'NonInventory' ? 'rentals' : 'add-ons'),
          unitLabel: prior?.unitLabel || 'each',
          unitPrice: Math.max(0, Number(item.UnitPrice || 0)),
          internalCost: Math.max(0, Number(prior?.internalCost || 0)),
          targetMargin: Math.min(100, Math.max(0, Number(prior?.targetMargin || 0))),
          active: item.Active !== false,
          getExempt: prior?.getExempt === true,
          source: prior?.source || 'quickbooks',
          sourceRef: prior?.sourceRef || String(item.Id),
          quickBooksItemId: String(item.Id),
          quickBooksItemName: String(item.Name || ''),
          quickBooksType: String(item.Type || '') === 'NonInventory' ? 'NonInventory' : 'Service',
          incomeAccountId: String(item?.IncomeAccountRef?.value || ''),
          incomeAccountName: String(item?.IncomeAccountRef?.name || ''),
          updatedAt: new Date().toISOString(),
        };
      }).filter((item: any) => item.name);
    const importedIds = new Set(imported.map((entry: any) => entry.quickBooksItemId));
    const catalog = [...imported, ...existing.filter((entry: any) => !importedIds.has(entry.quickBooksItemId))]
      .sort((a: any, b: any) => a.name.localeCompare(b.name));
    await saveQuickBooksCatalog(context, catalog as any, {
      actor,
      source:'quickbooks-import',
      note:'Imported or refreshed catalog items from live QuickBooks Products & Services.',
    });
    return Response.json({ ok: true, catalog, importedCount: imported.length });
  }

  if (action === 'cleanup-production-smoke-test') {
    const configuration = quickBooksConfiguration();
    if (configuration.environment !== 'production') {
      return Response.json({ error: 'Production cleanup is available only in the production QuickBooks environment.' }, { status: 409 });
    }

    const store = integrationStoreFor(context);
    const test: any = await store.get('quickbooks/production-smoke-test', { type: 'json' });
    if (!test?.customerId || !test?.estimateId || !test?.invoiceId) {
      return Response.json({ error: 'No stored production smoke test is available to clean up.' }, { status: 404 });
    }

    const cleaned: any = {
      startedAt: new Date().toISOString(),
      invoice: 'not_checked',
      estimate: 'not_checked',
      customer: 'not_checked',
    };

    const invoiceData: any = await qboGet(context, 'invoice', String(test.invoiceId));
    const invoice = invoiceData?.Invoice;
    const invoiceMarker = String(invoice?.PrivateNote || '').includes('Koa CRM production integration test') ||
      String(invoice?.CustomerMemo?.value || '').includes('CONTROLLED TEST');
    if (!invoice?.Id || !invoiceMarker) {
      throw new Error('Cleanup stopped: stored invoice does not match the controlled production-test marker.');
    }
    if (Number(invoice.Balance || 0) <= 0 && Number(invoice.TotalAmt || 0) > 0) {
      throw new Error('Cleanup stopped: the controlled production invoice has a payment or zero balance. Review it manually before cleanup.');
    }
    if (invoice.SyncToken == null) throw new Error('Cleanup stopped: production test invoice SyncToken is missing.');
    await qboOperation(context, 'invoice', String(invoice.Id), String(invoice.SyncToken), 'void');
    cleaned.invoice = 'voided';

    const estimateData: any = await qboGet(context, 'estimate', String(test.estimateId));
    const estimate = estimateData?.Estimate;
    const estimateMarker = String(estimate?.PrivateNote || '').includes('Koa CRM production integration test') ||
      String(estimate?.CustomerMemo?.value || '').includes('CONTROLLED TEST');
    if (!estimate?.Id || !estimateMarker) {
      throw new Error('Cleanup stopped: stored estimate does not match the controlled production-test marker.');
    }
    if (estimate.SyncToken == null) throw new Error('Cleanup stopped: production test estimate SyncToken is missing.');
    await qboOperation(context, 'estimate', String(estimate.Id), String(estimate.SyncToken), 'delete');
    cleaned.estimate = 'deleted';

    const customerData: any = await qboGet(context, 'customer', String(test.customerId));
    const customer = customerData?.Customer;
    if (!customer?.Id || !String(customer.DisplayName || '').startsWith('Koa CRM Production Test ')) {
      throw new Error('Cleanup stopped: stored customer does not match the controlled production-test marker.');
    }
    if (customer.SyncToken == null) throw new Error('Cleanup stopped: production test customer SyncToken is missing.');
    await qboUpdate(context, 'customer', {
      Id: String(customer.Id),
      SyncToken: String(customer.SyncToken),
      Active: false,
    });
    cleaned.customer = 'made_inactive';

    cleaned.completedAt = new Date().toISOString();
    test.cleanup = cleaned;
    test.status = 'cleaned';
    await store.setJSON('quickbooks/production-smoke-test', test);
    return Response.json({ ok: true, cleanup: cleaned, test });
  }

  if (action === 'production-linked-booking-test') {
    const configuration = quickBooksConfiguration();
    if (configuration.environment !== 'production') {
      return Response.json({ error: 'Production CRM-linked testing is available only in the production QuickBooks environment.' }, { status: 409 });
    }

    const settings = await getQuickBooksSettings(context);
    const itemId = clean(settings?.serviceItemId, 80);
    if (!itemId) {
      return Response.json({ error: 'Save a production QuickBooks Service or Non-Inventory item mapping first.' }, { status: 409 });
    }

    const suffix = idSuffix();
    const recordId = 'QBP-' + suffix;
    const depositAmount = 1;
    const total = 20;
    const now = new Date().toISOString();
    const eventDate = new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10);
    const secondDue = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const finalDue = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10);

    let records = await readQuickBooksSalesRecords(context);
    const record: any = {
      id: recordId,
      kind: 'proposal',
      stage: 'proposal',
      createdAt: now,
      updatedAt: now,
      status: 'accepted',
      source: 'quickbooks-production-linked-test',
      customer: {
        name: 'QBO Production Linked Test ' + suffix,
        email: '',
        phone: '',
        eventDate,
        notes: 'CONTROLLED TEST RECORD. Created to verify Koa’s CRM ↔ QuickBooks production synchronization.',
      },
      proposal: {
        publicToken: '',
        status: 'accepted',
        expirationDate: '',
        lineItems: [{
          id: 'production-linked-service',
          description: 'CONTROLLED TEST - Koa CRM production linked booking',
          quantity: 1,
          unitPrice: total,
          amount: total,
          custom: false,
        }],
        subtotal: total,
        discountAmount: 0,
        taxRate: 0,
        taxAmount: 0,
        total,
        depositAmount,
        paymentSchedule: [
          { label: 'Reservation deposit', dueDate: today(), amount: depositAmount },
          { label: 'Second payment', dueDate: secondDue, amount: 9.50 },
          { label: 'Final payment', dueDate: finalDue, amount: 9.50 },
        ],
        notesToClient: 'CONTROLLED TEST - no client communication.',
        acceptance: { name: 'Production Test Client', acceptedAt: now },
      },
      booking: {
        status: 'deposit_pending',
        createdAt: now,
        updatedAt: now,
        contract: {
          version: 1,
          title: 'Controlled Production Test Agreement',
          generatedAt: now,
          status: 'signed',
          sections: [],
          signature: { name: 'Production Test Client', signedAt: now, acknowledgement: 'Controlled production test signature' },
          koaSignature: { name: 'Koa’s Events Test', signedAt: now },
        },
        payments: [
          { id: 'pay-1', label: 'Reservation deposit', dueDate: today(), amount: depositAmount, status: 'pending' },
          { id: 'pay-2', label: 'Second payment', dueDate: secondDue, amount: 9.50, status: 'pending' },
          { id: 'pay-3', label: 'Final payment', dueDate: finalDue, amount: 9.50, status: 'pending' },
        ],
      },
    };

    records = [record, ...records.filter((entry) => entry.id !== recordId)].slice(0, 1500);
    const sales = salesStoreFor(context);
    await sales.setJSON('records/' + recordId, record);
    await sales.setJSON('records/index', records);

    const customer = await ensureCustomer(context, record);
    const estimate = await syncEstimate(context, record, itemId);
    const invoice = await createMilestoneInvoice(context, record, itemId, 'pay-1');
    await saveQuickBooksSalesRecord(context, record, records);

    const paymentAmount = Number(invoice?.Balance ?? invoice?.TotalAmt ?? depositAmount);
    if (!(paymentAmount > 0 && paymentAmount <= 5)) {
      throw new Error('Production linked test stopped: generated deposit invoice balance was outside the expected $0-$5 safety range.');
    }

    const paymentCreated: any = await qboCreate(context, 'payment', {
      CustomerRef: { value: String(customer.Id) },
      TotalAmt: paymentAmount,
      PrivateNote: 'CONTROLLED TEST - Koa CRM production linked booking ' + recordId,
      Line: [{
        Amount: paymentAmount,
        LinkedTxn: [{ TxnId: String(invoice.Id), TxnType: 'Invoice' }],
      }],
    });
    const payment = paymentCreated?.Payment;
    if (!payment?.Id) throw new Error('Production CRM-linked payment creation failed.');

    const test = {
      status: 'payment_created',
      createdAt: now,
      recordId,
      customerId: String(customer.Id),
      estimateId: String(estimate?.Id || ''),
      estimateDocNumber: String(estimate?.DocNumber || ''),
      invoiceId: String(invoice.Id),
      invoiceDocNumber: String(invoice.DocNumber || ''),
      paymentId: String(payment.Id),
      paymentAmount,
      expectedStage: 'booked',
      expectedDepositPaid: true,
      expectedBalanceDue: 0,
      webhookPending: true,
      emailed: false,
    };
    await integrationStoreFor(context).setJSON('quickbooks/production-linked-booking-test', test);
    await appendEvent(context, {
      type: 'quickbooks_linked_production_test_started',
      recordId,
      detail: 'Controlled production test created QuickBooks estimate ' + (estimate?.DocNumber || estimate?.Id || '') +
        ', deposit invoice ' + (invoice.DocNumber || invoice.Id) + ', and payment ' + payment.Id + '.',
    });

    return Response.json({ ok: true, test });
  }

  if (action === 'production-smoke-test') {
    const configuration = quickBooksConfiguration();
    if (configuration.environment !== 'production') {
      return Response.json({ error: 'Production smoke test is available only in the production QuickBooks environment.' }, { status: 409 });
    }

    const settings = await getQuickBooksSettings(context);
    const itemId = clean(settings?.serviceItemId, 80);
    if (!itemId) {
      return Response.json({ error: 'Save a production QuickBooks Service or Non-Inventory item mapping first.' }, { status: 409 });
    }

    const suffix = idSuffix();
    const amount = 1;
    const startedAt = new Date().toISOString();
    const displayName = 'Koa CRM Production Test ' + suffix;

    const customerCreated: any = await qboCreate(context, 'customer', {
      DisplayName: displayName,
      Notes: 'CONTROLLED TEST RECORD from Koa’s Events CRM. Safe to delete after verification.',
    });
    const customer = customerCreated?.Customer;
    if (!customer?.Id) throw new Error('Production test customer creation failed.');

    const estimateCreated: any = await qboCreate(context, 'estimate', {
      CustomerRef: { value: String(customer.Id) },
      TxnDate: today(),
      CustomerMemo: { value: 'CONTROLLED TEST - DO NOT PAY' },
      PrivateNote: 'Koa CRM production integration test ' + suffix + '. Safe to delete.',
      Line: [{
        Amount: amount,
        DetailType: 'SalesItemLineDetail',
        Description: 'CONTROLLED TEST - Koa CRM production integration',
        SalesItemLineDetail: {
          ItemRef: { value: itemId },
          Qty: 1,
          UnitPrice: amount,
        },
      }],
    });
    const estimate = estimateCreated?.Estimate;
    if (!estimate?.Id) throw new Error('Production test estimate creation failed.');

    const invoiceCreated: any = await qboCreate(context, 'invoice', {
      CustomerRef: { value: String(customer.Id) },
      TxnDate: today(),
      DueDate: today(),
      CustomerMemo: { value: 'CONTROLLED TEST - DO NOT PAY' },
      PrivateNote: 'Koa CRM production integration test ' + suffix + '. Safe to void/delete after verification.',
      Line: [{
        Amount: amount,
        DetailType: 'SalesItemLineDetail',
        Description: 'CONTROLLED TEST - Koa CRM production integration',
        SalesItemLineDetail: {
          ItemRef: { value: itemId },
          Qty: 1,
          UnitPrice: amount,
        },
      }],
    });
    const invoice = invoiceCreated?.Invoice;
    if (!invoice?.Id) throw new Error('Production test invoice creation failed.');

    const result = {
      status: 'passed',
      startedAt,
      completedAt: new Date().toISOString(),
      customerId: String(customer.Id),
      customerName: String(customer.DisplayName || displayName),
      estimateId: String(estimate.Id),
      estimateDocNumber: String(estimate.DocNumber || ''),
      invoiceId: String(invoice.Id),
      invoiceDocNumber: String(invoice.DocNumber || ''),
      amount,
      invoiceBalance: Number(invoice.Balance ?? invoice.TotalAmt ?? amount),
      serviceItemId: itemId,
      serviceItemName: String(settings?.serviceItemName || ''),
      emailed: false,
    };
    await integrationStoreFor(context).setJSON('quickbooks/production-smoke-test', result);
    return Response.json({ ok: true, test: result });
  }

  if (action === 'sandbox-linked-booking-test') {
    const configuration = quickBooksConfiguration();
    if (configuration.environment !== 'sandbox') {
      return Response.json({ error: 'CRM-linked sandbox testing is disabled outside the QuickBooks sandbox environment.' }, { status: 409 });
    }

    const settings = await getQuickBooksSettings(context);
    const itemId = clean(settings?.serviceItemId, 80);
    if (!itemId) {
      return Response.json({ error: 'Save a QuickBooks Service or Non-Inventory item mapping first.' }, { status: 409 });
    }

    const suffix = idSuffix();
    const recordId = 'QBT-' + suffix;
    const depositAmount = 25;
    const total = 250;
    const now = new Date().toISOString();
    const eventDate = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10);
    const secondDue = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const finalDue = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);

    let records = await readQuickBooksSalesRecords(context);
    const record: any = {
      id: recordId,
      kind: 'proposal',
      stage: 'proposal',
      createdAt: now,
      updatedAt: now,
      status: 'accepted',
      source: 'quickbooks-sandbox-linked-test',
      customer: {
        name: 'QBO Sandbox Linked Test ' + suffix,
        email: '',
        phone: '',
        eventDate,
        notes: 'Automated CRM-linked QuickBooks sandbox test. Safe to delete after verification.',
      },
      proposal: {
        publicToken: '',
        status: 'accepted',
        expirationDate: '',
        lineItems: [{
          id: 'sandbox-linked-service',
          description: 'Koa CRM linked sandbox test',
          quantity: 1,
          unitPrice: total,
          amount: total,
          custom: false,
        }],
        subtotal: total,
        discountAmount: 0,
        taxRate: 0,
        taxAmount: 0,
        total,
        depositAmount,
        paymentSchedule: [
          { label: 'Reservation deposit', dueDate: today(), amount: depositAmount },
          { label: 'Second payment', dueDate: secondDue, amount: 112.50 },
          { label: 'Final payment', dueDate: finalDue, amount: 112.50 },
        ],
        notesToClient: 'Automated sandbox integration test.',
        acceptance: { name: 'Sandbox Test Client', acceptedAt: now },
      },
      booking: {
        status: 'deposit_pending',
        createdAt: now,
        updatedAt: now,
        contract: {
          version: 1,
          title: 'Sandbox Test Booking Agreement',
          generatedAt: now,
          status: 'signed',
          sections: [],
          signature: { name: 'Sandbox Test Client', signedAt: now, acknowledgement: 'Sandbox test signature' },
          koaSignature: { name: 'Koa’s Events Test', signedAt: now },
        },
        payments: [
          { id: 'pay-1', label: 'Reservation deposit', dueDate: today(), amount: depositAmount, status: 'pending' },
          { id: 'pay-2', label: 'Second payment', dueDate: secondDue, amount: 112.50, status: 'pending' },
          { id: 'pay-3', label: 'Final payment', dueDate: finalDue, amount: 112.50, status: 'pending' },
        ],
      },
    };

    records = [record, ...records.filter((entry) => entry.id !== recordId)].slice(0, 1500);
    const store = salesStoreFor(context);
    await store.setJSON('records/' + recordId, record);
    await store.setJSON('records/index', records);

    const customer = await ensureCustomer(context, record);
    const invoice = await createMilestoneInvoice(context, record, itemId, 'pay-1');
    await saveQuickBooksSalesRecord(context, record, records);

    const paymentCreated: any = await qboCreate(context, 'payment', {
      CustomerRef: { value: String(customer.Id) },
      TotalAmt: depositAmount,
      Line: [{
        Amount: depositAmount,
        LinkedTxn: [{ TxnId: String(invoice.Id), TxnType: 'Invoice' }],
      }],
    });
    const payment = paymentCreated?.Payment;
    if (!payment?.Id) throw new Error('CRM-linked sandbox payment creation failed.');

    const test = {
      status: 'payment_created',
      createdAt: now,
      recordId,
      customerId: String(customer.Id),
      invoiceId: String(invoice.Id),
      invoiceDocNumber: String(invoice.DocNumber || ''),
      paymentId: String(payment.Id),
      depositAmount,
      expectedStage: 'booked',
      expectedDepositPaid: true,
      expectedBalanceDue: 0,
      webhookPending: true,
    };
    await integrationStoreFor(context).setJSON('quickbooks/sandbox-linked-booking-test', test);
    await appendEvent(context, {
      type: 'quickbooks_linked_sandbox_test_started',
      recordId,
      detail: 'Created CRM-linked QuickBooks sandbox deposit invoice ' + (invoice.DocNumber || invoice.Id) + ' and payment ' + payment.Id + '.',
    });

    return Response.json({ ok: true, test });
  }

  if (action === 'sandbox-smoke-test') {
    const configuration = quickBooksConfiguration();
    if (configuration.environment !== 'sandbox') {
      return Response.json({ error: 'Sandbox smoke test is disabled outside the QuickBooks sandbox environment.' }, { status: 409 });
    }

    const settings = await getQuickBooksSettings(context);
    const itemId = clean(settings?.serviceItemId, 80);
    if (!itemId) {
      return Response.json({ error: 'Save a QuickBooks Service or Non-Inventory item mapping first.' }, { status: 409 });
    }

    const suffix = idSuffix();
    const amount = 25;
    const startedAt = new Date().toISOString();
    const customerCreated: any = await qboCreate(context, 'customer', {
      DisplayName: 'Koa CRM Sandbox Test ' + suffix,
      Notes: 'Automated Koa’s Events CRM sandbox integration test. Safe to delete.',
    });
    const customer = customerCreated?.Customer;
    if (!customer?.Id) throw new Error('Sandbox test customer creation failed.');

    const estimateCreated: any = await qboCreate(context, 'estimate', {
      CustomerRef: { value: String(customer.Id) },
      TxnDate: today(),
      CustomerMemo: { value: 'Koa CRM sandbox integration test' },
      PrivateNote: 'Automated sandbox test ' + suffix,
      Line: [{
        Amount: amount,
        DetailType: 'SalesItemLineDetail',
        Description: 'Koa CRM sandbox test service',
        SalesItemLineDetail: {
          ItemRef: { value: itemId },
          Qty: 1,
          UnitPrice: amount,
        },
      }],
    });
    const estimate = estimateCreated?.Estimate;
    if (!estimate?.Id) throw new Error('Sandbox test estimate creation failed.');

    const invoiceCreated: any = await qboCreate(context, 'invoice', {
      CustomerRef: { value: String(customer.Id) },
      TxnDate: today(),
      DueDate: today(),
      CustomerMemo: { value: 'Koa CRM sandbox integration test' },
      PrivateNote: 'Automated sandbox test ' + suffix,
      Line: [{
        Amount: amount,
        DetailType: 'SalesItemLineDetail',
        Description: 'Koa CRM sandbox test service',
        SalesItemLineDetail: {
          ItemRef: { value: itemId },
          Qty: 1,
          UnitPrice: amount,
        },
      }],
    });
    const invoice = invoiceCreated?.Invoice;
    if (!invoice?.Id) throw new Error('Sandbox test invoice creation failed.');

    const paymentCreated: any = await qboCreate(context, 'payment', {
      CustomerRef: { value: String(customer.Id) },
      TotalAmt: amount,
      Line: [{
        Amount: amount,
        LinkedTxn: [{ TxnId: String(invoice.Id), TxnType: 'Invoice' }],
      }],
    });
    const payment = paymentCreated?.Payment;
    if (!payment?.Id) throw new Error('Sandbox test payment creation failed.');

    const invoiceAfterPaymentData: any = await qboGet(context, 'invoice', String(invoice.Id));
    const invoiceAfterPayment = invoiceAfterPaymentData?.Invoice;
    const result = {
      status: Number(invoiceAfterPayment?.Balance ?? amount) === 0 ? 'passed' : 'partial',
      startedAt,
      completedAt: new Date().toISOString(),
      customerId: String(customer.Id),
      customerName: String(customer.DisplayName || ''),
      estimateId: String(estimate.Id),
      estimateDocNumber: String(estimate.DocNumber || ''),
      invoiceId: String(invoice.Id),
      invoiceDocNumber: String(invoice.DocNumber || ''),
      paymentId: String(payment.Id),
      amount,
      invoiceBalanceAfterPayment: Number(invoiceAfterPayment?.Balance ?? amount),
      webhookPending: true,
    };
    await integrationStoreFor(context).setJSON('quickbooks/sandbox-smoke-test', result);
    return Response.json({ ok: true, test: result });
  }

  let records = await readQuickBooksSalesRecords(context);
  const record = records.find((entry) => entry.id === clean(payload?.recordId, 100) && entry.kind === 'proposal');
  if (!record) return Response.json({ error: 'Proposal record not found.' }, { status: 404 });
  const settings = await getQuickBooksSettings(context);
  const itemId = clean(settings?.serviceItemId, 80);
  if (!itemId && ['sync-estimate','create-invoice'].includes(action)) {
    return Response.json({ error: 'Choose the QuickBooks service item in QuickBooks Setup before syncing financial records.' }, { status: 409 });
  }

  if (action === 'update-damage-deposit') {
    const damageSettings = await getQuickBooksDamageDepositSettings(context);
    const state = ensureDamageDepositState(record, damageSettings, tenant);
    const requestedType = clean(payload?.rentalType,20);
    if (requestedType === 'one-day' || requestedType === 'weekend') {
      if (state.invoiceId && requestedType !== state.rentalType) {
        return Response.json({
          error:'Rental type cannot be changed after the refundable damage-deposit invoice has been created. Void or recreate the deposit invoice in QuickBooks first.',
        },{status:409});
      }
      state.rentalType = requestedType;
      if (!state.invoiceId) {
        state.amount = roundMoney(requestedType === 'weekend' ? damageSettings.weekendAmount : damageSettings.oneDayAmount);
      }
    }
    if (!state.invoiceId) {
      state.dueDate = offsetDate(record?.customer?.eventDate, -Math.max(0, Number(damageSettings.dueDaysBefore || 30)));
      state.refundDueDate = offsetDate(record?.customer?.eventDate, Math.max(0, Number(damageSettings.refundWithinDays || 14)));
    }
    state.deductionAmount = Math.min(state.amount, Math.max(0, roundMoney(payload?.deductionAmount ?? state.deductionAmount ?? 0)));
    state.deductionReason = clean(payload?.deductionReason ?? state.deductionReason,1000);
    state.refundAmount = Math.max(0, roundMoney(state.amount - state.deductionAmount));
    records = await saveQuickBooksSalesRecord(context, record, records);
    return Response.json({ok:true,record,damageDeposit:state},{headers:{'Cache-Control':'private, no-store'}});
  }

  if (action === 'create-damage-deposit-invoice') {
    const damageSettings = await getQuickBooksDamageDepositSettings(context);
    if (!damageSettings.enabled) {
      return Response.json({error:'Refundable damage deposits are disabled for this organization.'},{status:409});
    }
    if (!damageSettings.itemId || !damageSettings.liabilityAccountId) {
      return Response.json({error:'Configure the refundable damage-deposit liability account and QuickBooks item first.'},{status:409});
    }
    const state = ensureDamageDepositState(record, damageSettings, tenant);
    if (state.invoiceId) {
      await syncDamageDepositInvoice(context, record, damageSettings, tenant);
      records = await saveQuickBooksSalesRecord(context, record, records);
      return Response.json({ok:true,record,damageDeposit:state,reused:true},{headers:{'Cache-Control':'private, no-store'}});
    }
    const customer = await ensureCustomer(context, record);
    const created:any = await qboCreate(context,'invoice',{
      CustomerRef:{value:String(customer.Id)},
      TxnDate:today(),
      DueDate:state.dueDate || undefined,
      BillEmail:record.customer?.email ? {Address:clean(record.customer.email,240)} : undefined,
      CustomerMemo:{value:'Refundable security / damage deposit · '+tenant.displayName+' · '+record.id},
      PrivateNote:'VenueLoom '+tenant.id+' · '+record.id+' · refundable damage deposit · held as liability',
      Line:[buildQuickBooksMilestoneInvoiceLine({
        amount:state.amount,
        itemId:damageSettings.itemId,
        description:'Refundable security / damage deposit. Separate from event revenue and refundable after the event less documented deductions.',
      })],
    });
    const invoice=created?.Invoice;
    if(!invoice?.Id) throw new Error('QuickBooks damage-deposit invoice could not be created.');
    state.invoiceId=String(invoice.Id);
    state.invoiceDocNumber=String(invoice.DocNumber||'');
    state.invoiceBalance=Math.max(0,roundMoney(invoice.Balance ?? invoice.TotalAmt ?? state.amount));
    state.status=state.invoiceBalance<=0.005?'paid':'invoiced';
    state.paidAt=state.invoiceBalance<=0.005?new Date().toISOString():'';
    state.lastSyncedAt=new Date().toISOString();
    records=await saveQuickBooksSalesRecord(context,record,records);
    await appendClientAccountingActivity(
      context,
      tenant,
      record.id,
      'damage_deposit_invoice_created',
      'Refundable damage-deposit invoice '+(state.invoiceDocNumber?'#'+state.invoiceDocNumber:state.invoiceId)+' created in QuickBooks for $'+state.amount.toFixed(2)+'. This liability remains separate from event revenue.',
    );
    await appendEvent(context,{
      type:'damage_deposit_invoice_created',
      recordId:record.id,
      quoteId:record.quoteId||'',
      amount:state.amount,
      detail:'QuickBooks refundable damage-deposit invoice '+(state.invoiceDocNumber||state.invoiceId)+' created.',
    });
    return Response.json({ok:true,record,damageDeposit:state},{headers:{'Cache-Control':'private, no-store'}});
  }

  if (action === 'sync-damage-deposit') {
    const damageSettings = await getQuickBooksDamageDepositSettings(context);
    const state = await syncDamageDepositInvoice(context, record, damageSettings, tenant);
    records = await saveQuickBooksSalesRecord(context, record, records);
    return Response.json({ok:true,record,damageDeposit:state},{headers:{'Cache-Control':'private, no-store'}});
  }

  if (action === 'refund-damage-deposit') {
    const damageSettings = await getQuickBooksDamageDepositSettings(context);
    const state = await syncDamageDepositInvoice(context, record, damageSettings, tenant);
    if (!state.invoiceId || state.invoiceBalance > 0.005) {
      return Response.json({
        error:'The refundable damage deposit must be fully paid in QuickBooks before a refund or deduction can be posted.',
      },{status:409});
    }
    if (state.refundTransactionId) {
      return Response.json({ok:true,record,damageDeposit:state,reused:true},{headers:{'Cache-Control':'private, no-store'}});
    }
    if (!damageSettings.liabilityAccountId || !damageSettings.refundBankAccountId) {
      return Response.json({error:'Configure the damage-deposit liability account and refund bank account first.'},{status:409});
    }

    state.deductionAmount=Math.min(state.amount,Math.max(0,roundMoney(payload?.deductionAmount ?? state.deductionAmount ?? 0)));
    state.deductionReason=clean(payload?.deductionReason ?? state.deductionReason,1000);
    if (state.deductionAmount > 0 && !state.deductionReason) {
      return Response.json({error:'Enter a deduction reason before retaining any portion of the refundable damage deposit.'},{status:409});
    }
    state.refundAmount=Math.max(0,roundMoney(state.amount-state.deductionAmount));

    if (state.deductionAmount > 0 && !state.deductionJournalEntryId) {
      if (!damageSettings.deductionIncomeAccountId) {
        return Response.json({error:'Choose a QuickBooks income account for retained damage-deposit deductions.'},{status:409});
      }
      const journalCreated:any=await qboCreate(context,'journalentry',{
        TxnDate:today(),
        PrivateNote:'VenueLoom '+tenant.id+' · '+record.id+' · damage-deposit deduction · '+state.deductionReason,
        Line:[
          {
            Amount:state.deductionAmount,
            DetailType:'JournalEntryLineDetail',
            Description:'Release refundable deposit liability for documented deduction',
            JournalEntryLineDetail:{
              PostingType:'Debit',
              AccountRef:{value:damageSettings.liabilityAccountId},
            },
          },
          {
            Amount:state.deductionAmount,
            DetailType:'JournalEntryLineDetail',
            Description:state.deductionReason||'Damage deposit deduction',
            JournalEntryLineDetail:{
              PostingType:'Credit',
              AccountRef:{value:damageSettings.deductionIncomeAccountId},
            },
          },
        ],
      });
      state.deductionJournalEntryId=String(journalCreated?.JournalEntry?.Id||'');
      if(!state.deductionJournalEntryId) throw new Error('QuickBooks deduction journal entry could not be created.');
    }

    if (state.refundAmount > 0) {
      const customer=await ensureCustomer(context,record);
      const purchaseCreated:any=await qboCreate(context,'purchase',{
        PaymentType:'Check',
        AccountRef:{value:damageSettings.refundBankAccountId},
        TxnDate:today(),
        EntityRef:{type:'Customer',value:String(customer.Id)},
        PrivateNote:'VenueLoom '+tenant.id+' · '+record.id+' · refundable damage-deposit return',
        Line:[{
          Amount:state.refundAmount,
          DetailType:'AccountBasedExpenseLineDetail',
          Description:'Refundable security / damage deposit returned to client'+(state.deductionAmount>0?' after documented deductions':''),
          AccountBasedExpenseLineDetail:{
            AccountRef:{value:damageSettings.liabilityAccountId},
            CustomerRef:{value:String(customer.Id)},
            BillableStatus:'NotBillable',
          },
        }],
      });
      state.refundTransactionId=String(purchaseCreated?.Purchase?.Id||'');
      if(!state.refundTransactionId) throw new Error('QuickBooks refund transaction could not be created.');
    } else {
      state.refundTransactionId='DEDUCTION-FULL';
    }

    state.refundedAt=new Date().toISOString();
    state.status=state.deductionAmount>0?'refunded_with_deduction':'refunded';
    state.lastSyncedAt=state.refundedAt;
    records=await saveQuickBooksSalesRecord(context,record,records);
    await appendClientAccountingActivity(
      context,
      tenant,
      record.id,
      'damage_deposit_refunded',
      'Refundable damage deposit resolved. Returned $'+state.refundAmount.toFixed(2)
        +(state.deductionAmount>0
          ? ' and retained $'+state.deductionAmount.toFixed(2)+' for documented deductions: '+state.deductionReason+'.'
          : '.')
        +' QuickBooks refund transaction '+state.refundTransactionId+'.',
    );
    await appendEvent(context,{
      type:'damage_deposit_refunded',
      recordId:record.id,
      quoteId:record.quoteId||'',
      amount:state.refundAmount,
      detail:'Refunded $'+state.refundAmount.toFixed(2)+' from the refundable damage deposit'
        +(state.deductionAmount>0
          ? ' with $'+state.deductionAmount.toFixed(2)+' retained for documented deductions.'
          : '.'),
    });
    return Response.json({ok:true,record,damageDeposit:state},{headers:{'Cache-Control':'private, no-store'}});
  }

  if (action === 'sync-estimate') {
    const estimate = await syncEstimate(context, record, itemId);
    records = await saveQuickBooksSalesRecord(context, record, records);
    await appendEvent(context, {
      type: 'quickbooks_estimate_synced',
      recordId: record.id,
      quoteId: record.quoteId || '',
      detail: 'QuickBooks estimate ' + (estimate?.DocNumber || estimate?.Id || '') + ' synchronized.',
    });
    return Response.json({ ok: true, record });
  }

  if (action === 'send-estimate') {
    const state = quickBooksState(record);
    if (!state.estimateId) return Response.json({ error: 'Create the QuickBooks estimate first.' }, { status: 409 });
    if (!record.customer?.email) return Response.json({ error: 'Client email is missing.' }, { status: 409 });
    const sent: any = await qboSend(context, 'estimate', state.estimateId, clean(record.customer.email, 240));
    const estimate = sent?.Estimate;
    if (estimate) {
      state.estimateEmailStatus = String(estimate.EmailStatus || 'EmailSent');
      state.estimateLastSyncedAt = new Date().toISOString();
    }
    records = await saveQuickBooksSalesRecord(context, record, records);
    await appendEvent(context, {
      type: 'quickbooks_estimate_sent',
      recordId: record.id,
      quoteId: record.quoteId || '',
      detail: 'QuickBooks estimate emailed to ' + record.customer.email,
    });
    return Response.json({ ok: true, record });
  }

  if (action === 'create-invoice') {
    const paymentId = clean(payload?.paymentId, 80);
    const invoice = await createMilestoneInvoice(context, record, itemId, paymentId);
    records = await saveQuickBooksSalesRecord(context, record, records);
    await appendEvent(context, {
      type: 'quickbooks_invoice_created',
      recordId: record.id,
      quoteId: record.quoteId || '',
      detail: 'QuickBooks invoice ' + (invoice?.DocNumber || invoice?.Id || '') + ' created.',
    });
    return Response.json({ ok: true, record });
  }

  if (action === 'send-invoice') {
    const paymentId = clean(payload?.paymentId, 80);
    const state = quickBooksState(record);
    const entry = state.invoices.find((row: any) => row.paymentId === paymentId);
    if (!entry?.invoiceId) return Response.json({ error: 'Create the QuickBooks invoice first.' }, { status: 409 });
    if (!record.customer?.email) return Response.json({ error: 'Client email is missing.' }, { status: 409 });
    const sent: any = await qboSend(context, 'invoice', entry.invoiceId, clean(record.customer.email, 240));
    const invoice = sent?.Invoice;
    if (invoice) {
      entry.emailStatus = String(invoice.EmailStatus || 'EmailSent');
      entry.balance = Number(invoice.Balance ?? entry.balance ?? entry.amount ?? 0);
      entry.lastSyncedAt = new Date().toISOString();
    }
    records = await saveQuickBooksSalesRecord(context, record, records);
    await appendEvent(context, {
      type: 'quickbooks_invoice_sent',
      recordId: record.id,
      quoteId: record.quoteId || '',
      detail: 'QuickBooks invoice emailed to ' + record.customer.email,
    });
    return Response.json({ ok: true, record });
  }

  if (action === 'sync-and-recheck') {
    const state = await syncQuickBooksAccountingStatus(context, record);
    await refreshQuickBooksPaymentSnapshot(context, record);
    records = await saveQuickBooksSalesRecord(context, record, records);
    const accountingAudit = buildQuickBooksAccountingAudit(records);
    const reconciliation = applyQuickBooksReconciliationHistory(records, accountingAudit, 'manual', [record.id]);
    records = await saveQuickBooksSalesRecord(context, record, records);

    const auditRow = accountingAudit.rows.find((row: any) => row.recordId === record.id);
    if (auditRow) {
      auditRow.verificationSource = 'live';
      auditRow.estimateVerifiedAt = String(state.estimateVerifiedAt || state.estimateLastSyncedAt || state.lastSyncedAt || '');
      auditRow.reconciliationOpen = !auditRow.reconciled;
      auditRow.reconciliationCheckedAt = String(record?.accounting?.quickbooks?.reconciliationState?.checkedAt || '');
      auditRow.reconciliationResolvedAt = String(record?.accounting?.quickbooks?.reconciliationState?.resolvedAt || '');
    }
    let accountingRepairPreview: any = null;
    const hasEstimateMismatch = Boolean((auditRow?.issues || []).some((issue: any) =>
      ['estimate_total','estimate_missing'].includes(String(issue?.code || '')),
    ));
    if (hasEstimateMismatch) {
      try {
        const repair = await buildAccountingRepairPreview(context, tenant, record, records, itemId, actor);
        const hasSafeEstimateChange = Boolean(
          repair.preview?.canApply
          && (repair.preview?.changes || []).some((change: any) =>
            change?.documentType === 'estimate' && change?.writesQuickBooks === true,
          ),
        );
        if (hasSafeEstimateChange) accountingRepairPreview = repair.preview;
      } catch {}
    }

    await appendEvent(context, {
      type: 'quickbooks_accounting_recheck',
      recordId: record.id,
      quoteId: record.quoteId || '',
      detail: accountingRepairPreview
        ? 'QuickBooks refreshed and a safe Accounting Repair preview is ready for review.'
        : auditRow?.reconciled
          ? 'QuickBooks verified live; CRM and QuickBooks reconcile and the accounting review flag was cleared automatically.'
          : 'QuickBooks estimate, invoice balances and payment-derived balances refreshed before accounting reconciliation.',
    });
    return Response.json(
      { ok: true, record, quickbooks: state, accountingAudit, accountingRepairPreview, reconciliationResolved: Boolean(auditRow?.reconciled) },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  }

  if (action === 'sync-status') {
    const beforeStage = record.stage;
    const state = await syncQuickBooksAccountingStatus(context, record);
    records = await saveQuickBooksSalesRecord(context, record, records);
    await appendEvent(context, {
      type: 'quickbooks_status_synced',
      recordId: record.id,
      quoteId: record.quoteId || '',
      detail: 'QuickBooks balances and statuses synchronized.',
    });
    if (beforeStage !== 'booked' && record.stage === 'booked') {
      await appendEvent(context, {
        type: 'booked',
        recordId: record.id,
        quoteId: record.quoteId || '',
        detail: 'Event booked after QuickBooks reservation-deposit invoice reached zero balance and both contract signatures were complete.',
      });
    }
    return Response.json({ ok: true, record, quickbooks: state });
  }

  return Response.json({ error: 'Unknown QuickBooks action.' }, { status: 400 });
};

export const config: Config = {
  path: [
    '/api/admin/quickbooks',
    '/api/admin/quickbooks/callback',
  ],
};
