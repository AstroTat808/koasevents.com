import type { Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  getQuickBooksConnection,
  qboGet,
  quickBooksConfiguration,
  quickBooksWebhookVerifierToken,
} from './_shared/quickbooks';

function integrationStore(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-integrations', consistency: 'strong' })
    : getDeployStore({ name: 'koa-integrations' });
}

function salesStore(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-sales', consistency: 'strong' })
    : getDeployStore({ name: 'koa-sales' });
}

function verifySignature(rawBody: string, signature: string, verifierToken: string) {
  if (!rawBody || !signature || !verifierToken) return false;
  const expected = createHmac('sha256', verifierToken).update(rawBody, 'utf8').digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

function isoDate(value: unknown) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parsed = new Date(raw.length === 10 ? raw + 'T12:00:00Z' : raw);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function idSuffix() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function flattenReceipt(receipt: any) {
  return (receipt?.notifications || []).flatMap((notification: any) =>
    Array.isArray(notification?.entities) ? notification.entities : [],
  );
}

function invoiceRows(record: any) {
  record.accounting ||= {};
  record.accounting.quickbooks ||= {};
  record.accounting.quickbooks.invoices ||= [];
  record.accounting.quickbooks.payments ||= [];
  return record.accounting.quickbooks;
}

function updateBookingAndTotals(record: any) {
  const state = invoiceRows(record);
  const activeInvoices = state.invoices.filter((row: any) => row.status !== 'void' && row.status !== 'deleted' && row.invoiceId);
  state.totalInvoiced = activeInvoices.reduce((sum: number, row: any) => sum + Number(row.total || row.amount || 0), 0);
  state.balanceDue = activeInvoices.reduce((sum: number, row: any) => sum + Math.max(0, Number(row.balance || 0)), 0);
  state.totalPaid = activeInvoices.reduce((sum: number, row: any) => {
    const total = Number(row.total || row.amount || 0);
    const balance = Math.max(0, Number(row.balance || 0));
    return sum + Math.max(0, total - balance);
  }, 0);

  const schedule = record.booking?.payments?.length
    ? record.booking.payments
    : (record.proposal?.paymentSchedule || []).map((item: any, index: number) => ({
        id: 'pay-' + (index + 1),
        ...item,
      }));

  const depositPayment = schedule[0];
  const depositInvoice = state.invoices.find((row: any) =>
    row.paymentId === depositPayment?.id || /deposit/i.test(String(row.label || '')),
  );
  state.depositPaid = Boolean(
    depositInvoice?.invoiceId &&
    depositInvoice.status !== 'void' &&
    depositInvoice.status !== 'deleted' &&
    Number(depositInvoice.balance || 0) <= 0,
  );
  state.depositPaidAt = state.depositPaid
    ? String(depositInvoice?.paidAt || state.depositPaidAt || new Date().toISOString())
    : '';

  if (record.booking?.payments?.length) {
    record.booking.payments = record.booking.payments.map((payment: any, index: number) => {
      const row = state.invoices.find((invoice: any) => invoice.paymentId === payment.id);
      const validInvoice = row?.invoiceId && row.status !== 'void' && row.status !== 'deleted';
      const paid = Boolean(validInvoice && Number(row.balance || 0) <= 0);
      return {
        ...payment,
        status: paid ? 'paid' : 'pending',
        paidAt: paid ? String(row.paidAt || payment.paidAt || new Date().toISOString()) : undefined,
        reference: validInvoice ? String(row.docNumber || row.invoiceId || '') : '',
      };
    });
  }

  if (
    state.depositPaid &&
    record.booking?.contract?.status === 'signed' &&
    record.booking?.contract?.koaSignature
  ) {
    record.stage = 'booked';
    record.status = 'booked';
    if (record.proposal) record.proposal.status = 'booked';
    if (record.booking) record.booking.status = 'booked';
  }

  state.lastSyncedAt = new Date().toISOString();
  record.updatedAt = state.lastSyncedAt;
  return state;
}

function applyInvoiceToRecord(record: any, invoiceId: string, invoice: any, operation: string) {
  const state = invoiceRows(record);
  const row = state.invoices.find((entry: any) => String(entry.invoiceId || entry.previousInvoiceId || '') === invoiceId);
  if (!row) return false;

  const op = operation.toLowerCase();
  if (op === 'delete') {
    row.previousInvoiceId = invoiceId;
    row.invoiceId = '';
    row.status = 'deleted';
    row.deletedAt = new Date().toISOString();
    row.balance = Number(row.amount || row.total || 0);
    row.lastSyncedAt = new Date().toISOString();
    return true;
  }

  if (op === 'void') {
    row.status = 'void';
    row.voidedAt = new Date().toISOString();
    row.balance = Number(row.amount || row.total || 0);
    row.lastSyncedAt = new Date().toISOString();
    return true;
  }

  if (!invoice?.Id) return false;
  row.docNumber = String(invoice.DocNumber || row.docNumber || '');
  row.total = Number(invoice.TotalAmt ?? row.total ?? row.amount ?? 0);
  row.balance = Number(invoice.Balance ?? row.balance ?? row.total ?? row.amount ?? 0);
  row.emailStatus = String(invoice.EmailStatus || row.emailStatus || '');
  row.dueDate = isoDate(invoice.DueDate || row.dueDate);
  row.status = row.balance <= 0 ? 'paid' : 'open';
  if (row.balance <= 0) row.paidAt = String(row.paidAt || new Date().toISOString());
  else row.paidAt = '';
  row.lastSyncedAt = new Date().toISOString();
  return true;
}

async function appendSalesEvent(context: Context, event: Record<string, unknown>) {
  const store = salesStore(context);
  const current = (await store.get('analytics/events/index', { type: 'json' })) || [];
  await store.setJSON('analytics/events/index', [{
    id: 'EVT-' + idSuffix(),
    createdAt: new Date().toISOString(),
    ...event,
  }, ...current].slice(0, 10000));
}

async function processWebhook(context: Context, receipt: any) {
  const connection = await getQuickBooksConnection(context);
  if (!connection) {
    return { status: 'skipped', reason: 'QuickBooks is not connected.', processedAt: new Date().toISOString(), affectedRecords: [] };
  }

  const store = salesStore(context);
  let records = ((await store.get('records/index', { type: 'json' })) || []) as any[];
  const originalDepositState = new Map<string, boolean>();
  records.forEach((record) => {
    originalDepositState.set(record.id, Boolean(record?.accounting?.quickbooks?.depositPaid));
  });

  const relevant = (receipt.notifications || [])
    .filter((notification: any) => String(notification.realmId || '') === String(connection.realmId))
    .flatMap((notification: any) => notification.entities || [])
    .filter((entity: any) => ['invoice', 'payment'].includes(String(entity.name || '').toLowerCase()));

  const affected = new Set<string>();
  const refreshedInvoices = new Map<string, any>();

  const loadInvoice = async (invoiceId: string) => {
    if (refreshedInvoices.has(invoiceId)) return refreshedInvoices.get(invoiceId);
    try {
      const data: any = await qboGet(context, 'invoice', invoiceId);
      const invoice = data?.Invoice || null;
      refreshedInvoices.set(invoiceId, invoice);
      return invoice;
    } catch {
      refreshedInvoices.set(invoiceId, null);
      return null;
    }
  };

  for (const entity of relevant) {
    const name = String(entity.name || '').toLowerCase();
    const entityId = String(entity.id || '');
    const operation = String(entity.operation || 'Update');
    if (!entityId) continue;

    if (name === 'invoice') {
      const invoice = ['delete','void'].includes(operation.toLowerCase()) ? null : await loadInvoice(entityId);
      records.forEach((record) => {
        if (applyInvoiceToRecord(record, entityId, invoice, operation)) affected.add(record.id);
      });
      continue;
    }

    if (name === 'payment') {
      let payment: any = null;
      let linkedInvoiceIds: string[] = [];

      if (operation.toLowerCase() !== 'delete') {
        try {
          const data: any = await qboGet(context, 'payment', entityId);
          payment = data?.Payment || null;
          linkedInvoiceIds = (payment?.Line || [])
            .flatMap((line: any) => Array.isArray(line?.LinkedTxn) ? line.LinkedTxn : [])
            .filter((link: any) => String(link?.TxnType || '').toLowerCase() === 'invoice')
            .map((link: any) => String(link?.TxnId || ''))
            .filter(Boolean);
        } catch {}
      }

      if (!linkedInvoiceIds.length) {
        records.forEach((record) => {
          const savedPayment = record?.accounting?.quickbooks?.payments?.find((row: any) => String(row.paymentId || '') === entityId);
          if (savedPayment?.invoiceIds?.length) linkedInvoiceIds.push(...savedPayment.invoiceIds.map(String));
        });
        linkedInvoiceIds = [...new Set(linkedInvoiceIds)];
      }

      for (const record of records) {
        const state = invoiceRows(record);
        const matchingInvoices = state.invoices.filter((row: any) => linkedInvoiceIds.includes(String(row.invoiceId || row.previousInvoiceId || '')));
        if (!matchingInvoices.length) continue;

        const existingPaymentIndex = state.payments.findIndex((row: any) => String(row.paymentId || '') === entityId);
        if (operation.toLowerCase() === 'delete') {
          if (existingPaymentIndex >= 0) state.payments.splice(existingPaymentIndex, 1);
        } else {
          const paymentRow = {
            paymentId: entityId,
            amount: Number(payment?.TotalAmt || 0),
            txnDate: String(payment?.TxnDate || ''),
            invoiceIds: linkedInvoiceIds,
            operation,
            lastUpdatedAt: String(payment?.MetaData?.LastUpdatedTime || new Date().toISOString()),
          };
          if (existingPaymentIndex >= 0) state.payments[existingPaymentIndex] = paymentRow;
          else state.payments.push(paymentRow);
        }

        affected.add(record.id);
      }

      for (const invoiceId of linkedInvoiceIds) {
        const invoice = await loadInvoice(invoiceId);
        records.forEach((record) => {
          if (applyInvoiceToRecord(record, invoiceId, invoice, 'Update')) affected.add(record.id);
        });
      }
    }
  }

  for (const record of records) {
    if (!affected.has(record.id)) continue;
    const beforeDepositPaid = originalDepositState.get(record.id) || false;
    const state = updateBookingAndTotals(record);
    await store.setJSON('records/' + record.id, record);
    await appendSalesEvent(context, {
      type: 'quickbooks_webhook_synced',
      recordId: record.id,
      quoteId: record.quoteId || '',
      detail: 'QuickBooks webhook synchronized invoice/payment balances. Paid $' + Number(state.totalPaid || 0).toFixed(2) + ' · Balance $' + Number(state.balanceDue || 0).toFixed(2) + '.',
    });
    if (!beforeDepositPaid && state.depositPaid) {
      await appendSalesEvent(context, {
        type: 'quickbooks_deposit_paid',
        recordId: record.id,
        quoteId: record.quoteId || '',
        detail: 'QuickBooks reservation-deposit invoice is paid in full.',
      });
    }
  }

  if (affected.size) {
    await store.setJSON('records/index', records.slice(0, 1500));
  }

  return {
    status: 'processed',
    processedAt: new Date().toISOString(),
    entityCount: relevant.length,
    affectedRecords: [...affected],
  };
}

async function updateSmokeTestWebhookStatus(context: Context, receipt: any) {
  const store = integrationStore(context);
  const smoke: any = await store.get('quickbooks/sandbox-smoke-test', { type: 'json' });
  if (!smoke) return null;

  const entities = flattenReceipt(receipt);
  const previous = smoke.webhook || {};
  const invoiceMatched = Boolean(previous.invoiceMatched) || entities.some((entity: any) =>
    String(entity.name || '').toLowerCase() === 'invoice' && String(entity.id || '') === String(smoke.invoiceId || ''),
  );
  const paymentMatched = Boolean(previous.paymentMatched) || entities.some((entity: any) =>
    String(entity.name || '').toLowerCase() === 'payment' && String(entity.id || '') === String(smoke.paymentId || ''),
  );

  smoke.webhook = {
    invoiceMatched,
    paymentMatched,
    verified: invoiceMatched && paymentMatched,
    lastMatchedAt: (invoiceMatched || paymentMatched) ? receipt.receivedAt : String(previous.lastMatchedAt || ''),
  };
  smoke.webhookPending = !smoke.webhook.verified;
  await store.setJSON('quickbooks/sandbox-smoke-test', smoke);
  return smoke.webhook;
}

async function diagnostics(context: Context) {
  const store = integrationStore(context);
  const [receipt, processed, smoke] = await Promise.all([
    store.get('quickbooks/webhook-last-receipt', { type: 'json' }) as Promise<any>,
    store.get('quickbooks/webhook-last-processed', { type: 'json' }) as Promise<any>,
    store.get('quickbooks/sandbox-smoke-test', { type: 'json' }) as Promise<any>,
  ]);
  const entities = flattenReceipt(receipt);
  const directInvoiceMatch = Boolean(smoke?.invoiceId) && entities.some((entity: any) =>
    String(entity.name || '').toLowerCase() === 'invoice' && String(entity.id || '') === String(smoke.invoiceId),
  );
  const directPaymentMatch = Boolean(smoke?.paymentId) && entities.some((entity: any) =>
    String(entity.name || '').toLowerCase() === 'payment' && String(entity.id || '') === String(smoke.paymentId),
  );
  return {
    ok: true,
    environment: quickBooksConfiguration().environment,
    lastWebhookAt: receipt?.receivedAt || '',
    lastProcessedAt: processed?.processedAt || '',
    processingStatus: processed?.status || '',
    affectedRecordCount: Array.isArray(processed?.affectedRecords) ? processed.affectedRecords.length : 0,
    lastEntityTypes: [...new Set(entities.map((entity: any) => String(entity.name || '')).filter(Boolean))],
    smokeTest: smoke ? {
      status: smoke.status || '',
      completedAt: smoke.completedAt || '',
      invoiceWebhookMatched: Boolean(smoke?.webhook?.invoiceMatched || directInvoiceMatch),
      paymentWebhookMatched: Boolean(smoke?.webhook?.paymentMatched || directPaymentMatch),
      webhookVerified: Boolean(
        (smoke?.webhook?.invoiceMatched || directInvoiceMatch) &&
        (smoke?.webhook?.paymentMatched || directPaymentMatch)
      ),
    } : null,
  };
}

export default async (req: Request, context: Context) => {
  if (req.method === 'GET') {
    return Response.json(await diagnostics(context), {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const verifierToken = quickBooksWebhookVerifierToken();
  if (!verifierToken) {
    console.error('QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN is not configured');
    return new Response('Webhook verifier is not configured', { status: 503 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get('intuit-signature') || '';

  if (!verifySignature(rawBody, signature, verifierToken)) {
    console.warn('Rejected QuickBooks webhook with invalid signature');
    return new Response('Invalid signature', { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody || '{}');
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const notifications = Array.isArray(payload?.eventNotifications) ? payload.eventNotifications : [];
  const receipt = {
    receivedAt: new Date().toISOString(),
    notifications: notifications.map((notification: any) => ({
      realmId: String(notification?.realmId || ''),
      entities: Array.isArray(notification?.dataChangeEvent?.entities)
        ? notification.dataChangeEvent.entities.map((entity: any) => ({
            name: String(entity?.name || ''),
            id: String(entity?.id || ''),
            operation: String(entity?.operation || ''),
            lastUpdated: String(entity?.lastUpdated || ''),
          }))
        : [],
    })),
  };

  const store = integrationStore(context);
  await store.setJSON('quickbooks/webhook-last-receipt', receipt);
  const history: any[] = (await store.get('quickbooks/webhook-receipts/index', { type: 'json' })) || [];
  await store.setJSON('quickbooks/webhook-receipts/index', [receipt, ...history].slice(0, 100));

  await updateSmokeTestWebhookStatus(context, receipt);

  let processed: any;
  try {
    processed = await processWebhook(context, receipt);
  } catch (error) {
    processed = {
      status: 'error',
      processedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'QuickBooks webhook processing failed.',
      affectedRecords: [],
    };
    console.error('QuickBooks webhook processing failed', error);
  }
  await store.setJSON('quickbooks/webhook-last-processed', processed);

  return new Response(null, { status: 200 });
};
