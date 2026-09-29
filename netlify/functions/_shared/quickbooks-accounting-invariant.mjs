import {
  buildQuickBooksEstimateLines,
  summarizeQuickBooksEstimateLines,
} from './quickbooks-estimate-lines.mjs';

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function clean(value, max = 400) {
  return String(value ?? '').trim().slice(0, max);
}

export function buildQuickBooksMilestoneInvoiceLine({
  amount,
  itemId,
  description = '',
  lineId = '',
}) {
  const total = money(amount);
  return {
    ...(lineId ? { Id: String(lineId) } : {}),
    Amount: total,
    DetailType: 'SalesItemLineDetail',
    Description: clean(description, 4000),
    SalesItemLineDetail: {
      ItemRef: { value: clean(itemId, 80) },
      Qty: 1,
      UnitPrice: total,
      TaxCodeRef: { value: 'NON' },
    },
  };
}

export function evaluateAccountingTaxInvariant() {
  const expectedSubtotal = 15000;
  const expectedTax = 706.80;
  const expectedTotal = 15706.80;
  const record = {
    id: 'SYSTEM-HEALTH-ACCOUNTING-INVARIANT',
    proposal: {
      lineItems: [{
        id: 'representative-event',
        description: 'Representative Event Collection',
        quantity: 1,
        unitPrice: expectedSubtotal,
        amount: expectedSubtotal,
      }],
      subtotal: expectedSubtotal,
      discountAmount: 0,
      taxLabel: 'Tax',
      taxAmount: expectedTax,
      total: expectedTotal,
    },
  };
  const estimateLines = buildQuickBooksEstimateLines(record, 'ACCOUNTING-INVARIANT-ITEM');
  const estimateSummary = summarizeQuickBooksEstimateLines(estimateLines);
  const invoiceLine = buildQuickBooksMilestoneInvoiceLine({
    amount: expectedTotal,
    itemId: 'ACCOUNTING-INVARIANT-ITEM',
    description: 'Representative milestone invoice',
  });

  const failures = [];
  if (estimateLines.length !== 2) failures.push('estimate line count is not 2');
  if (money(estimateSummary.lineTotal) !== expectedTotal) failures.push('estimate total is not $15,706.80');
  if (money(estimateSummary.taxableTotal) !== 0) failures.push('estimate exposes a taxable amount');
  if (money(estimateSummary.nonTaxableTotal) !== expectedTotal) failures.push('estimate NON total is not $15,706.80');
  if (estimateLines.some((line) => String(line?.SalesItemLineDetail?.TaxCodeRef?.value || '').toUpperCase() !== 'NON')) {
    failures.push('an estimate line is not explicitly NON-taxable');
  }
  if (money(invoiceLine.Amount) !== expectedTotal) failures.push('milestone invoice total is not $15,706.80');
  if (String(invoiceLine?.SalesItemLineDetail?.TaxCodeRef?.value || '').toUpperCase() !== 'NON') {
    failures.push('milestone invoice line is not explicitly NON-taxable');
  }

  return {
    ok: failures.length === 0,
    expectedSubtotal,
    expectedTax,
    expectedTotal,
    estimateLines,
    estimateSummary,
    invoiceLine,
    failures,
  };
}

export function inspectQuickBooksNonTaxCode(queryResponse) {
  const rows = Array.isArray(queryResponse?.QueryResponse?.TaxCode)
    ? queryResponse.QueryResponse.TaxCode
    : [];
  if (!rows.length) {
    return {
      verified: false,
      ok: true,
      detail: 'QuickBooks returned no TaxCode rows, so live NON tax-code availability could not be verified.',
    };
  }

  const non = rows.find((row) => {
    const id = String(row?.Id || '').trim().toUpperCase();
    const name = String(row?.Name || '').trim().toUpperCase();
    return id === 'NON' || name === 'NON' || name === 'NON-TAXABLE' || name === 'NONTAXABLE';
  });
  if (!non) {
    return {
      verified: true,
      ok: false,
      detail: 'QuickBooks tax codes were readable, but the NON/non-taxable code used by CRM-controlled accounting payloads was not present.',
    };
  }

  if (non?.Active === false) {
    return {
      verified: true,
      ok: false,
      detail: 'QuickBooks NON/non-taxable tax code exists but is inactive.',
    };
  }

  return {
    verified: true,
    ok: true,
    detail: 'QuickBooks NON/non-taxable tax code is available for CRM-controlled estimate and invoice lines.',
    id: String(non?.Id || ''),
    name: String(non?.Name || ''),
  };
}


export const CHRIS_SIBEL_ACCOUNTING_INVARIANT = Object.freeze({
  recordId: 'KEP-2026-7980A44276',
  clientName: 'Chris Sibel',
  eventDate: '2027-09-18',
  expectedSubtotal: 15000,
  expectedTax: 706.80,
  expectedTotal: 15706.80,
  historicalTaxOnTaxTotal: 16446.90,
});

export function evaluateChrisSibelLiveInvariant(record, estimate) {
  const expected = CHRIS_SIBEL_ACCOUNTING_INVARIANT;
  const proposalTotal = money(record?.proposal?.total);
  const estimateTotal = estimate ? money(estimate?.TotalAmt) : null;
  const salesLines = (Array.isArray(estimate?.Line) ? estimate.Line : [])
    .filter((line) => line?.DetailType === 'SalesItemLineDetail');
  const taxableLines = salesLines.filter((line) =>
    String(line?.SalesItemLineDetail?.TaxCodeRef?.value || '').trim().toUpperCase() !== 'NON'
  );
  const lineTotal = money(salesLines.reduce((sum, line) => sum + Number(line?.Amount || 0), 0));
  const failures = [];

  if (!record) failures.push('Chris Sibel CRM test record is missing');
  if (record && proposalTotal !== expected.expectedTotal) {
    failures.push('CRM proposal total is not $15,706.80');
  }
  if (!estimate) failures.push('live QuickBooks estimate is missing');
  if (estimate && estimateTotal !== expected.expectedTotal) {
    failures.push('live QuickBooks estimate total is not $15,706.80');
  }
  if (estimate && lineTotal !== expected.expectedTotal) {
    failures.push('live QuickBooks estimate sales lines do not total $15,706.80');
  }
  if (taxableLines.length) {
    failures.push('live QuickBooks estimate contains taxable sales lines');
  }

  return {
    ok: failures.length === 0,
    recordId: String(record?.id || expected.recordId),
    clientName: String(record?.customer?.name || expected.clientName),
    eventDate: String(record?.customer?.eventDate || expected.eventDate).slice(0, 10),
    estimateId: String(estimate?.Id || record?.accounting?.quickbooks?.estimateId || ''),
    estimateDocNumber: String(estimate?.DocNumber || record?.accounting?.quickbooks?.estimateDocNumber || ''),
    proposalTotal,
    estimateTotal,
    lineTotal,
    taxableLineCount: taxableLines.length,
    historicalTaxOnTaxDetected: estimateTotal === expected.historicalTaxOnTaxTotal,
    failures,
  };
}
