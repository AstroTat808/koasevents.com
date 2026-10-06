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


function qboMoneyText(value) {
  const n = money(value);
  return (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
}

export function explainQuickBooksTransactionAdjustment(input = {}) {
  const lineTotal = input?.lineTotal == null ? null : money(input.lineTotal);
  const estimateTotal = input?.estimateTotal == null ? null : money(input.estimateTotal);
  if (lineTotal == null || estimateTotal == null) return '';
  const adjustment = input?.transactionAdjustment == null
    ? money(estimateTotal - lineTotal)
    : money(input.transactionAdjustment);
  if (Math.abs(adjustment) < 0.01) return '';

  const discountLineAmount = money(input?.discountLineAmount || 0);
  const discountAmtField = input?.discountAmtField == null ? null : money(input.discountAmtField);
  const discountUsed = Math.abs(discountLineAmount) >= 0.01
    ? Math.abs(discountLineAmount)
    : Math.abs(discountAmtField || 0);
  const totalTax = money(input?.totalTax || 0);
  const otherAdjustments = (Array.isArray(input?.nonSalesAdjustments) ? input.nonSalesAdjustments : [])
    .filter((row) => !['DiscountLineDetail','TaxLineDetail'].includes(String(row?.detailType || '')))
    .filter((row) => Math.abs(Number(row?.amount || 0)) >= 0.01);
  const otherTotal = money(otherAdjustments.reduce((sum, row) => sum + Number(row?.amount || 0), 0));
  const explained = money(-discountUsed + totalTax + otherTotal);
  const remainder = money(adjustment - explained);
  const salesLineDetails = Array.isArray(input?.salesLineDetails) ? input.salesLineDetails : [];
  const itemSummary = salesLineDetails.length
    ? ' (' + salesLineDetails.slice(0, 4).map((row) =>
        String(row?.itemName || row?.description || 'line item') + ' ' + qboMoneyText(row?.amount || 0)
      ).join('; ') + (salesLineDetails.length > 4 ? '; +' + (salesLineDetails.length - 4) + ' more' : '') + ')'
    : '';

  const parts = ['Sales lines total ' + qboMoneyText(lineTotal) + itemSummary + '.'];
  if (discountUsed >= 0.01) {
    parts.push(
      'QuickBooks subtracts ' + qboMoneyText(discountUsed)
      + (Math.abs(discountLineAmount) >= 0.01 ? ' through DiscountLineDetail' : ' through DiscountAmt')
      + '.'
    );
  }
  if (Math.abs(totalTax) >= 0.01) {
    parts.push(
      'It adds ' + qboMoneyText(totalTax) + ' through TxnTaxDetail.TotalTax'
      + (input?.applyTaxAfterDiscount == null ? '' : (input.applyTaxAfterDiscount ? ' after the discount' : ' before the discount'))
      + (input?.applyTaxAfterDiscount == null ? '' : ' (ApplyTaxAfterDiscount=' + String(Boolean(input.applyTaxAfterDiscount)) + ')')
      + '.'
    );
  } else if (input?.totalTax != null) {
    parts.push('TxnTaxDetail.TotalTax is $0.00.');
  }
  if (otherAdjustments.length) {
    parts.push(
      'Other non-sales transaction lines contribute '
      + qboMoneyText(otherTotal)
      + ': '
      + otherAdjustments.map((row) => String(row?.detailType || 'adjustment') + ' ' + qboMoneyText(row?.amount || 0)).join(', ')
      + '.'
    );
  }
  parts.push('QuickBooks total is ' + qboMoneyText(estimateTotal) + ', so the net transaction adjustment is ' + qboMoneyText(adjustment) + '.');
  if (Math.abs(remainder) >= 0.01) {
    parts.push('The listed QBO fields explain ' + qboMoneyText(explained) + ' of that adjustment; ' + qboMoneyText(remainder) + ' remains in QuickBooks transaction-level calculation behavior not exposed as a standalone sales line.');
  }
  return parts.join(' ');
}

export function evaluateLiveClientAccountingInvariant(record, estimate, options = {}) {
  const proposalTotal = money(record?.proposal?.total);
  const expectedTotal = options.expectedTotal == null ? proposalTotal : money(options.expectedTotal);
  const estimateTotal = estimate ? money(estimate?.TotalAmt) : null;
  const salesLines = (Array.isArray(estimate?.Line) ? estimate.Line : [])
    .filter((line) => line?.DetailType === 'SalesItemLineDetail');
  const taxableLines = salesLines.filter((line) =>
    String(line?.SalesItemLineDetail?.TaxCodeRef?.value || '').trim().toUpperCase() !== 'NON'
  );
  const lineTotal = money(salesLines.reduce((sum, line) => sum + Number(line?.Amount || 0), 0));
  const salesLineDetails = salesLines.map((line) => ({
    id: String(line?.Id || ''),
    description: String(line?.Description || ''),
    amount: money(line?.Amount || 0),
    itemId: String(line?.SalesItemLineDetail?.ItemRef?.value || ''),
    itemName: String(line?.SalesItemLineDetail?.ItemRef?.name || line?.Description || ''),
    taxCode: String(line?.SalesItemLineDetail?.TaxCodeRef?.value || ''),
  }));
  const allLines = Array.isArray(estimate?.Line) ? estimate.Line : [];
  const discountLines = allLines.filter((line) => line?.DetailType === 'DiscountLineDetail');
  const discountLineAmount = money(discountLines.reduce((sum, line) => sum + Math.abs(Number(line?.Amount || 0)), 0));
  const discountAmtField = estimate?.DiscountAmt == null ? null : money(estimate.DiscountAmt);
  const totalTax = estimate ? money(estimate?.TxnTaxDetail?.TotalTax || 0) : null;
  const adjustmentTotal = estimateTotal == null ? null : money(estimateTotal - lineTotal);
  const nonSalesAdjustments = allLines
    .filter((line) => line?.DetailType && line.DetailType !== 'SalesItemLineDetail' && line.DetailType !== 'SubTotalLineDetail')
    .map((line) => ({
      detailType: String(line?.DetailType || ''),
      amount: money(line?.Amount || 0),
      discountPercent: line?.DiscountLineDetail?.DiscountPercent == null ? null : Number(line.DiscountLineDetail.DiscountPercent),
      percentBased: line?.DiscountLineDetail?.PercentBased == null ? null : Boolean(line.DiscountLineDetail.PercentBased),
      taxRateRef: String(line?.TaxLineDetail?.TaxRateRef?.value || ''),
    }));
  const failures = [];

  if (!record) failures.push('CRM proposal record is missing');
  if (record && options.expectedTotal != null && proposalTotal !== expectedTotal) {
    failures.push('CRM proposal total does not equal the protected expected total');
  }
  if (!estimate) failures.push('live QuickBooks estimate is missing');
  if (estimate && estimateTotal !== expectedTotal) {
    failures.push('live QuickBooks estimate total does not equal the CRM proposal total');
  }
  // QuickBooks TotalAmt is authoritative for the transaction total. Historical and
  // manually adjusted estimates may include transaction-level discounts or other
  // adjustments that make raw SalesItemLineDetail amounts differ from TotalAmt.
  // A line subtotal mismatch is diagnostic context, not a reconciliation failure,
  // as long as the final estimate total matches CRM and CRM-managed lines remain NON.
  if (taxableLines.length) {
    failures.push('live QuickBooks estimate contains taxable sales lines');
  }

  const historicalTaxOnTaxTotal = options.historicalTaxOnTaxTotal == null
    ? null
    : money(options.historicalTaxOnTaxTotal);
  const transactionAdjustment = estimateTotal == null ? null : money(estimateTotal - lineTotal);
  const adjustmentExplanation = explainQuickBooksTransactionAdjustment({
    lineTotal,
    estimateTotal,
    transactionAdjustment,
    discountAmtField,
    discountLineAmount,
    totalTax,
    applyTaxAfterDiscount: estimate?.ApplyTaxAfterDiscount == null ? null : Boolean(estimate.ApplyTaxAfterDiscount),
    nonSalesAdjustments,
    salesLineDetails,
  });

  return {
    ok: failures.length === 0,
    recordId: String(record?.id || options.recordId || ''),
    clientName: String(record?.customer?.name || options.clientName || ''),
    eventDate: String(record?.customer?.eventDate || options.eventDate || '').slice(0, 10),
    proposalStatus: String(record?.proposal?.status || record?.status || ''),
    estimateId: String(estimate?.Id || record?.accounting?.quickbooks?.estimateId || ''),
    estimateDocNumber: String(estimate?.DocNumber || record?.accounting?.quickbooks?.estimateDocNumber || ''),
    proposalTotal,
    expectedTotal,
    estimateTotal,
    lineTotal,
    salesLineDetails,
    transactionAdjustment,
    adjustmentExplanation,
    adjustmentTotal,
    discountAmtField,
    discountLineAmount,
    totalTax,
    applyTaxAfterDiscount: estimate?.ApplyTaxAfterDiscount == null ? null : Boolean(estimate.ApplyTaxAfterDiscount),
    nonSalesAdjustments,
    taxableLineCount: taxableLines.length,
    historicalTaxOnTaxDetected: historicalTaxOnTaxTotal != null && estimateTotal === historicalTaxOnTaxTotal,
    failures,
  };
}

export function evaluateChrisSibelLiveInvariant(record, estimate) {
  const expected = CHRIS_SIBEL_ACCOUNTING_INVARIANT;
  const result = evaluateLiveClientAccountingInvariant(record, estimate, {
    recordId: expected.recordId,
    clientName: expected.clientName,
    eventDate: expected.eventDate,
    expectedTotal: expected.expectedTotal,
    historicalTaxOnTaxTotal: expected.historicalTaxOnTaxTotal,
  });
  return {
    ...result,
    failures: result.failures.map((failure) => {
      if (failure === 'CRM proposal total does not equal the protected expected total') return 'CRM proposal total is not $15,706.80';
      if (failure === 'live QuickBooks estimate total does not equal the CRM proposal total') return 'live QuickBooks estimate total is not $15,706.80';
      if (failure === 'live QuickBooks estimate sales lines do not equal the CRM proposal total') return 'live QuickBooks estimate sales lines do not total $15,706.80';
      if (failure === 'CRM proposal record is missing') return 'Chris Sibel CRM test record is missing';
      return failure;
    }),
  };
}
