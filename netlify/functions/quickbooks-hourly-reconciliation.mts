import type { Config, Context } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import {
  buildQuickBooksAccountingAudit,
  readQuickBooksSalesRecords,
  refreshQuickBooksPaymentSnapshot,
  saveQuickBooksSalesRecord,
  syncQuickBooksAccountingStatus,
} from './admin-quickbooks.mts';

function isReconciliationCandidate(record: any) {
  if (!record || record.kind !== 'proposal' || !record.proposal) return false;
  const qbo = record?.accounting?.quickbooks || {};
  return Boolean(
    qbo.customerId ||
    qbo.estimateId ||
    (Array.isArray(qbo.invoices) && qbo.invoices.some((entry: any) => entry?.invoiceId))
  );
}

export default async (_req: Request, context: Context) => {
  if (context.deploy.context !== 'production') return;

  let records = await readQuickBooksSalesRecords(context);
  const candidates = records.filter(isReconciliationCandidate);
  const errors: Array<{ recordId: string; message: string }> = [];

  for (const record of candidates) {
    try {
      await syncQuickBooksAccountingStatus(context, record);
      await refreshQuickBooksPaymentSnapshot(context, record);
      record.accounting ||= {};
      record.accounting.quickbooks ||= {};
      record.accounting.quickbooks.hourlyReconciledAt = new Date().toISOString();
      record.accounting.quickbooks.hourlyReconciliationError = '';
      records = await saveQuickBooksSalesRecord(context, record, records);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'QuickBooks reconciliation failed.';
      record.accounting ||= {};
      record.accounting.quickbooks ||= {};
      record.accounting.quickbooks.hourlyReconciledAt = new Date().toISOString();
      record.accounting.quickbooks.hourlyReconciliationError = String(message).slice(0, 500);
      errors.push({ recordId: String(record.id || ''), message: String(message).slice(0, 500) });
      records = await saveQuickBooksSalesRecord(context, record, records);
    }
  }

  const audit = buildQuickBooksAccountingAudit(records);
  const store = getStore({ name: 'koa-integrations', consistency: 'strong' });
  await store.setJSON('quickbooks/accounting-hourly-last', {
    ...audit,
    runAt: new Date().toISOString(),
    refreshedClients: candidates.length,
    errorCount: errors.length,
    errors: errors.slice(0, 100),
  });
};

export const config: Config = {
  schedule: '@hourly',
};
