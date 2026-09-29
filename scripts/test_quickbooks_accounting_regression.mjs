import assert from 'node:assert/strict';
import {
  buildQuickBooksEstimateLines,
  summarizeQuickBooksEstimateLines,
} from '../netlify/functions/_shared/quickbooks-estimate-lines.mjs';
import {
  CHRIS_SIBEL_ACCOUNTING_INVARIANT,
  buildQuickBooksMilestoneInvoiceLine,
  evaluateAccountingTaxInvariant,
  evaluateChrisSibelLiveInvariant,
  evaluateLiveAccountingInvariant,
  summarizeLiveAccountingInvariants,
} from '../netlify/functions/_shared/quickbooks-accounting-invariant.mjs';

const record = {
  id: 'REGRESSION-15000-GET',
  proposal: {
    lineItems: [{
      id: 'hibiscus',
      description: 'Representative Event Collection',
      quantity: 1,
      unitPrice: 15000,
      amount: 15000,
    }],
    subtotal: 15000,
    discountAmount: 0,
    taxLabel: 'GET',
    taxAmount: 706.80,
    total: 15706.80,
  },
};

const lines = buildQuickBooksEstimateLines(record, '257');
const summary = summarizeQuickBooksEstimateLines(lines);

assert.equal(lines.length, 2, 'Expected one service line plus one CRM tax line.');
assert.equal(summary.lineTotal, 15706.80, 'QuickBooks payload must total exactly $15,706.80.');
assert.equal(summary.nonTaxableTotal, 15706.80, 'Every CRM-controlled estimate dollar must be non-taxable in QuickBooks.');
assert.equal(summary.taxableTotal, 0, 'QuickBooks must have no taxable amount available for tax-on-tax.');
assert.equal(lines[0].Amount, 15000, 'The representative collection line must remain $15,000.00.');
assert.equal(lines[1].Amount, 706.80, 'The CRM-calculated GET line must remain $706.80.');
assert.ok(lines.every((line) => line.SalesItemLineDetail?.TaxCodeRef?.value === 'NON'), 'All estimate lines must explicitly use QuickBooks NON tax code.');
assert.notEqual(summary.lineTotal, 16446.90, 'Regression guard: the historical tax-on-tax total must never be emitted.');

console.log('Accounting regression passed: $15,000.00 + $706.80 CRM GET = $15,706.80 with $0 taxable payload.');


const milestoneInvoiceLine = buildQuickBooksMilestoneInvoiceLine({
  amount: 15706.80,
  itemId: '257',
  description: 'Representative milestone invoice',
});
assert.equal(milestoneInvoiceLine.Amount, 15706.80, 'Milestone invoice amount must remain exactly $15,706.80.');
assert.equal(milestoneInvoiceLine.SalesItemLineDetail?.TaxCodeRef?.value, 'NON', 'Milestone invoice line must be explicitly non-taxable.');

const invariant = evaluateAccountingTaxInvariant();
assert.equal(invariant.ok, true, 'Runtime accounting invariant must remain healthy.');
assert.deepEqual(invariant.failures, [], 'Runtime accounting invariant must have no failures.');


const liveRecord = {
  id: CHRIS_SIBEL_ACCOUNTING_INVARIANT.recordId,
  customer: {
    name: CHRIS_SIBEL_ACCOUNTING_INVARIANT.clientName,
    eventDate: CHRIS_SIBEL_ACCOUNTING_INVARIANT.eventDate,
  },
  proposal: {
    total: CHRIS_SIBEL_ACCOUNTING_INVARIANT.expectedTotal,
  },
  accounting: {
    quickbooks: {
      estimateId: '176',
    },
  },
};

const healthyLiveEstimate = {
  Id: '176',
  DocNumber: '1042',
  TotalAmt: 15706.80,
  Line: [
    {
      Id: '14',
      Amount: 15000,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { TaxCodeRef: { value: 'NON' } },
    },
    {
      Id: '15',
      Amount: 706.80,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { TaxCodeRef: { value: 'NON' } },
    },
  ],
};
const healthyLiveInvariant = evaluateChrisSibelLiveInvariant(liveRecord, healthyLiveEstimate);
assert.equal(healthyLiveInvariant.ok, true, 'Live Chris Sibel estimate must reconcile at exactly $15,706.80.');
assert.equal(healthyLiveInvariant.taxableLineCount, 0, 'Live Chris Sibel estimate must have zero taxable sales lines.');
assert.equal(healthyLiveInvariant.historicalTaxOnTaxDetected, false);

const historicalTaxOnTaxEstimate = {
  ...healthyLiveEstimate,
  TotalAmt: 16446.90,
  Line: [
    {
      Id: '14',
      Amount: 15000,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { TaxCodeRef: { value: 'TAX' } },
    },
    {
      Id: '15',
      Amount: 706.80,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { TaxCodeRef: { value: 'TAX' } },
    },
  ],
};
const failedLiveInvariant = evaluateChrisSibelLiveInvariant(liveRecord, historicalTaxOnTaxEstimate);
assert.equal(failedLiveInvariant.ok, false, 'Historical $16,446.90 tax-on-tax must fail the live invariant.');
assert.equal(failedLiveInvariant.historicalTaxOnTaxDetected, true, 'The exact historical tax-on-tax total must be identified.');
assert.ok(failedLiveInvariant.failures.some((failure) => failure.includes('estimate total')), 'The failure must identify the live QuickBooks total mismatch.');

console.log('Live accounting invariant regression passed: Chris Sibel $15,706.80 is green and $16,446.90 is red.');


const acceptedRecord = {
  id: 'KEP-DYNAMIC-1',
  customer: { name: 'Dynamic Client', eventDate: '2027-10-10' },
  proposal: { status: 'accepted', total: 2500 },
  accounting: { quickbooks: { estimateId: 'DYN-1' } },
};
const acceptedEstimate = {
  Id: 'DYN-1',
  TotalAmt: 2500,
  Line: [{
    Amount: 2500,
    DetailType: 'SalesItemLineDetail',
    SalesItemLineDetail: { TaxCodeRef: { value: 'NON' } },
  }],
};
const acceptedInvariant = evaluateLiveAccountingInvariant(acceptedRecord, acceptedEstimate);
assert.equal(acceptedInvariant.ok, true, 'Accepted client invariant must pass when totals match and lines are NON-taxable.');

const dynamicSummary = summarizeLiveAccountingInvariants(
  [
    acceptedRecord,
    {
      id: 'KEP-DYNAMIC-2',
      customer: { name: 'Broken Client', eventDate: '2027-11-11' },
      proposal: { status: 'booked', total: 3000 },
      accounting: { quickbooks: { estimateId: 'DYN-2' } },
    },
    {
      id: 'KEP-IMPORT-OLD',
      proposal: { status: 'accepted', total: 1000, source: 'quickbooks-import' },
      accounting: { quickbooks: { estimateId: 'OLD' } },
    },
  ],
  new Map([
    ['DYN-1', acceptedEstimate],
    ['DYN-2', {
      Id: 'DYN-2',
      TotalAmt: 3150,
      Line: [{
        Amount: 3150,
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: { TaxCodeRef: { value: 'TAX' } },
      }],
    }],
  ]),
);
assert.equal(dynamicSummary.eligibleCount, 2, 'Dynamic invariant must cover CRM-managed accepted/booked clients and exclude historical QuickBooks imports.');
assert.equal(dynamicSummary.passedCount, 1);
assert.equal(dynamicSummary.failedCount, 1);
assert.equal(dynamicSummary.ok, false);
assert.equal(dynamicSummary.failures[0].recordId, 'KEP-DYNAMIC-2');
assert.ok(dynamicSummary.failures[0].failures.some((failure) => failure.includes('estimate total')));
assert.ok(dynamicSummary.failures[0].failures.some((failure) => failure.includes('taxable')));

console.log('Dynamic accepted/booked accounting invariant regression passed.');
