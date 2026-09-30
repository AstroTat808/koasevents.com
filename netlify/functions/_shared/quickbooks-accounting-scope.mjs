function clean(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function quickBooksAccountingScope(record) {
  const recordSource = clean(record?.source);
  const proposalSource = clean(record?.proposal?.source);
  const qboOrigin = clean(record?.accounting?.quickbooks?.origin);
  const historicalQuickBooksImport =
    recordSource === 'quickbooks-import'
    || proposalSource === 'quickbooks-import'
    || qboOrigin === 'quickbooks';

  return {
    mode: historicalQuickBooksImport ? 'quickbooks-history' : 'crm-managed',
    actionable: !historicalQuickBooksImport,
    historicalQuickBooksImport,
    reason: historicalQuickBooksImport
      ? 'Imported QuickBooks history is read-only accounting context, not a CRM-managed booking workflow.'
      : 'CRM-managed booking accounting is subject to estimate, milestone, invoice, and balance reconciliation.',
  };
}
