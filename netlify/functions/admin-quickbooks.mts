import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { requireAdmin } from './_shared/admin';
import { sendAccountingTransitionAlerts } from './_shared/accounting-alerts';
import {
  completeOAuth,
  createOAuthState,
  disconnectQuickBooks,
  getQuickBooksCatalog,
  getQuickBooksConnection,
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
  saveQuickBooksDepositSettings,
  saveQuickBooksGetSettings,
  saveQuickBooksSettings,
} from './_shared/quickbooks';

function salesStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-sales', consistency: 'strong' })
    : getDeployStore({ name: 'koa-sales' });
}

function integrationStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-integrations', consistency: 'strong' })
    : getDeployStore({ name: 'koa-integrations' });
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

function proposalLines(record: any, itemId: string) {
  const proposal = record.proposal || {};
  const raw = Array.isArray(proposal.lineItems) ? proposal.lineItems : [];
  const lines = raw.length ? raw.map((line: any) => {
    const qty = Math.max(1, Number(line.quantity || 1));
    const amount = Number(line.amount || (qty * Number(line.unitPrice || 0)) || 0);
    const mappedItemId = clean(line.quickBooksItemId, 80) || itemId;
    return {
      Amount: amount,
      DetailType: 'SalesItemLineDetail',
      Description: clean(line.description, 400),
      SalesItemLineDetail: {
        ItemRef: { value: mappedItemId },
        Qty: qty,
        UnitPrice: qty ? Math.round((amount / qty) * 100) / 100 : amount,
      },
    };
  }) : [{
    Amount: Number(proposal.subtotal || proposal.total || 0),
    DetailType: 'SalesItemLineDetail',
    Description: 'Koa’s Events proposal ' + record.id,
    SalesItemLineDetail: {
      ItemRef: { value: itemId },
      Qty: 1,
      UnitPrice: Number(proposal.subtotal || proposal.total || 0),
    },
  }];

  const getAmount = Math.max(0, Number(proposal.taxAmount || 0));
  if (getAmount > 0) {
    lines.push({
      Amount: getAmount,
      DetailType: 'SalesItemLineDetail',
      Description: clean(proposal.taxLabel || 'Hawaiʻi GET', 400),
      SalesItemLineDetail: {
        ItemRef: { value: itemId },
        Qty: 1,
        UnitPrice: getAmount,
      },
    });
  }
  return lines;
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

async function syncEstimate(context: Context, record: any, itemId: string) {
  if (!record.proposal) throw new Error('Proposal not found.');

  const state = quickBooksState(record);
  const customer = await ensureCustomer(context, record);
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
    'Hawaiʻi GET 4.712%: $' + Number(proposal.taxAmount || 0).toFixed(2),
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
    Line: [{
      Amount: amount,
      DetailType: 'SalesItemLineDetail',
      Description: clean(financialSnapshot, 4000),
      SalesItemLineDetail: {
        ItemRef: { value: itemId },
        Qty: 1,
        UnitPrice: amount,
      },
    }],
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

  if (state.estimateId) {
    const estimateData: any = await qboGet(context, 'estimate', state.estimateId);
    const estimate = estimateData?.Estimate;
    if (estimate) {
      state.estimateDocNumber = String(estimate.DocNumber || state.estimateDocNumber || '');
      state.estimateTotal = Number(estimate.TotalAmt || state.estimateTotal || 0);
      state.estimateEmailStatus = String(estimate.EmailStatus || '');
      state.estimateLastSyncedAt = new Date().toISOString();
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
    entry.emailStatus = String(invoice.EmailStatus || '');
    entry.dueDate = isoDate(invoice.DueDate || entry.dueDate);
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
        invoiceCount: activeInvoices.length,
        issuedTotal,
        uninvoicedTotal,
        paymentsReceived,
        openInvoiceBalance,
        remainingBalance,
        lastSyncedAt: String(qbo.lastSyncedAt || ''),
        issues,
        reconciled: issues.length === 0,
      };
    })
    .filter((row: any) => row.estimateId || row.invoiceCount > 0 || ['accepted','booked'].includes(row.proposalStatus))
    .sort((a: any, b: any) => {
      if (a.reconciled !== b.reconciled) return a.reconciled ? 1 : -1;
      return String(a.eventDate || '9999').localeCompare(String(b.eventDate || '9999'));
    });

  const flagged = rows.filter((row: any) => !row.reconciled);
  return {
    generatedAt: new Date().toISOString(),
    clientCount: rows.length,
    reconciledCount: rows.length - flagged.length,
    flaggedCount: flagged.length,
    totalProposalValue: Math.round(rows.reduce((sum: number, row: any) => sum + row.proposalTotal, 0) * 100) / 100,
    totalPaymentsReceived: Math.round(rows.reduce((sum: number, row: any) => sum + row.paymentsReceived, 0) * 100) / 100,
    totalRemainingBalance: Math.round(rows.reduce((sum: number, row: any) => sum + row.remainingBalance, 0) * 100) / 100,
    rows,
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

  const auth = await requireAdmin();
  if (auth.response) return auth.response;

  if (req.method === 'GET') {
    const [connection, settings, catalog, getSettings, depositSettings, webhookReceipt, webhookHistory, webhookProcessed, smokeTest, linkedTest, productionTest, productionLinkedTest] = await Promise.all([
      getQuickBooksConnection(context),
      getQuickBooksSettings(context),
      getQuickBooksCatalog(context),
      getQuickBooksGetSettings(context),
      getQuickBooksDepositSettings(context),
      integrationStoreFor(context).get('quickbooks/webhook-last-receipt', { type: 'json' }),
      integrationStoreFor(context).get('quickbooks/webhook-receipts/index', { type: 'json' }),
      integrationStoreFor(context).get('quickbooks/webhook-last-processed', { type: 'json' }),
      integrationStoreFor(context).get('quickbooks/sandbox-smoke-test', { type: 'json' }),
      integrationStoreFor(context).get('quickbooks/sandbox-linked-booking-test', { type: 'json' }),
      integrationStoreFor(context).get('quickbooks/production-smoke-test', { type: 'json' }),
      integrationStoreFor(context).get('quickbooks/production-linked-booking-test', { type: 'json' }),
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
      settings,
      catalog,
      getSettings,
      depositSettings,
      webhookReceipt: webhookReceipt || null,
      webhookProcessed: webhookProcessed || null,
      smokeTest: smokeTest || null,
      linkedTest: linkedTest || null,
      productionTest: productionTest || null,
      productionLinkedTest: productionLinkedTest || null,
      accountingAudit,
      smokeWebhookMatch,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const payload: any = await req.json().catch(() => null);
  const action = clean(payload?.action, 60);

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
    });
    return Response.json({ ok: true, depositSettings }, { headers: { 'Cache-Control': 'private, no-store' } });
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
      enabled: true,
      label: clean(payload?.label || 'Hawaiʻi GET', 80),
      customerRate: 4.712,
      quickBooksItemId: clean(payload?.quickBooksItemId, 80),
      quickBooksItemName: clean(payload?.quickBooksItemName, 100),
    });
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
      unitLabel,
      unitPrice,
      active,
      getExempt,
      quickBooksItemId: String(qboItem.Id),
      quickBooksItemName: String(qboItem.Name || name),
      quickBooksType: String(qboItem.Type || requestedType) === 'NonInventory' ? 'NonInventory' : 'Service',
      incomeAccountId: String(qboItem?.IncomeAccountRef?.value || incomeAccountId),
      incomeAccountName: String(qboItem?.IncomeAccountRef?.name || incomeAccountName),
      updatedAt: new Date().toISOString(),
    };
    const catalog = [item, ...existingCatalog.filter((entry: any) => entry.id !== id)]
      .sort((a: any, b: any) => a.name.localeCompare(b.name));
    await saveQuickBooksCatalog(context, catalog as any);
    return Response.json({ ok: true, item, catalog });
  }

  if (action === 'archive-catalog-item') {
    const id = clean(payload?.id, 80);
    const existingCatalog = await getQuickBooksCatalog(context);
    const item = existingCatalog.find((entry: any) => entry.id === id);
    if (!item) return Response.json({ error: 'Catalog item not found.' }, { status: 404 });
    const catalog = existingCatalog.map((entry: any) => entry.id === id ? { ...entry, active: false, updatedAt: new Date().toISOString() } : entry);
    await saveQuickBooksCatalog(context, catalog as any);
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
          unitLabel: prior?.unitLabel || 'each',
          unitPrice: Math.max(0, Number(item.UnitPrice || 0)),
          active: item.Active !== false,
          getExempt: prior?.getExempt === true,
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
    await saveQuickBooksCatalog(context, catalog as any);
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
    if (reconciliation.changedRecordIds.includes(record.id)) {
      records = await saveQuickBooksSalesRecord(context, record, records);
    }
    await appendEvent(context, {
      type: 'quickbooks_accounting_recheck',
      recordId: record.id,
      quoteId: record.quoteId || '',
      detail: 'QuickBooks estimate, invoice balances and payment-derived balances refreshed before accounting reconciliation.',
    });
    return Response.json({ ok: true, record, quickbooks: state, accountingAudit }, { headers: { 'Cache-Control': 'private, no-store' } });
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
