import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { requireAdmin } from './_shared/admin';
import {
  completeOAuth,
  createOAuthState,
  disconnectQuickBooks,
  getQuickBooksConnection,
  getQuickBooksSettings,
  qboCreate,
  qboGet,
  qboQuery,
  qboSend,
  qboUpdate,
  quickBooksConfiguration,
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

async function readRecords(context: Context) {
  return ((await salesStoreFor(context).get('records/index', { type: 'json' })) || []) as any[];
}

async function saveRecord(context: Context, record: any, records: any[]) {
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
  if (!raw.length) {
    return [{
      Amount: Number(proposal.total || 0),
      DetailType: 'SalesItemLineDetail',
      Description: 'Koa’s Events proposal ' + record.id,
      SalesItemLineDetail: {
        ItemRef: { value: itemId },
        Qty: 1,
        UnitPrice: Number(proposal.total || 0),
      },
    }];
  }

  return raw.map((line: any) => {
    const qty = Math.max(1, Number(line.quantity || 1));
    const amount = Number(line.amount || (qty * Number(line.unitPrice || 0)) || 0);
    return {
      Amount: amount,
      DetailType: 'SalesItemLineDetail',
      Description: clean(line.description, 400),
      SalesItemLineDetail: {
        ItemRef: { value: itemId },
        Qty: qty,
        UnitPrice: qty ? Math.round((amount / qty) * 100) / 100 : amount,
      },
    };
  });
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
  if (Number(record.proposal.taxAmount || 0) !== 0) {
    throw new Error('This proposal has CRM-calculated tax. To keep QuickBooks as the tax system of record, remove the CRM tax calculation before syncing the estimate.');
  }

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
  const created: any = await qboCreate(context, 'invoice', {
    CustomerRef: { value: String(customer.Id) },
    TxnDate: today(),
    DueDate: isoDate(payment.dueDate) || undefined,
    BillEmail: record.customer?.email ? { Address: clean(record.customer.email, 240) } : undefined,
    CustomerMemo: { value: clean(payment.label, 180) + ' · Koa’s Events ' + record.id },
    PrivateNote: 'Koa CRM ' + record.id + ' · ' + clean(payment.label, 180),
    Line: [{
      Amount: amount,
      DetailType: 'SalesItemLineDetail',
      Description: clean(payment.label, 300) + ' for Koa’s Events proposal ' + record.id,
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

async function syncAccountingStatus(context: Context, record: any) {
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
    const [connection, settings, webhookReceipt, webhookHistory, webhookProcessed, smokeTest] = await Promise.all([
      getQuickBooksConnection(context),
      getQuickBooksSettings(context),
      integrationStoreFor(context).get('quickbooks/webhook-last-receipt', { type: 'json' }),
      integrationStoreFor(context).get('quickbooks/webhook-receipts/index', { type: 'json' }),
      integrationStoreFor(context).get('quickbooks/webhook-last-processed', { type: 'json' }),
      integrationStoreFor(context).get('quickbooks/sandbox-smoke-test', { type: 'json' }),
    ]);
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
      webhookReceipt: webhookReceipt || null,
      webhookProcessed: webhookProcessed || null,
      smokeTest: smokeTest || null,
      smokeWebhookMatch,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const payload: any = await req.json().catch(() => null);
  const action = clean(payload?.action, 60);

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
      .map((item: any) => ({ id: String(item.Id), name: String(item.Name || ''), type: String(item.Type || '') }))
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

  let records = await readRecords(context);
  const record = records.find((entry) => entry.id === clean(payload?.recordId, 100) && entry.kind === 'proposal');
  if (!record) return Response.json({ error: 'Proposal record not found.' }, { status: 404 });
  const settings = await getQuickBooksSettings(context);
  const itemId = clean(settings?.serviceItemId, 80);
  if (!itemId && ['sync-estimate','create-invoice'].includes(action)) {
    return Response.json({ error: 'Choose the QuickBooks service item in QuickBooks Setup before syncing financial records.' }, { status: 409 });
  }

  if (action === 'sync-estimate') {
    const estimate = await syncEstimate(context, record, itemId);
    records = await saveRecord(context, record, records);
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
    records = await saveRecord(context, record, records);
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
    records = await saveRecord(context, record, records);
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
    records = await saveRecord(context, record, records);
    await appendEvent(context, {
      type: 'quickbooks_invoice_sent',
      recordId: record.id,
      quoteId: record.quoteId || '',
      detail: 'QuickBooks invoice emailed to ' + record.customer.email,
    });
    return Response.json({ ok: true, record });
  }

  if (action === 'sync-status') {
    const beforeStage = record.stage;
    const state = await syncAccountingStatus(context, record);
    records = await saveRecord(context, record, records);
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
