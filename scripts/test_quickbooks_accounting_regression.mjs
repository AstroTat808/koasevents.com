import assert from 'node:assert/strict';
import {
  buildQuickBooksEstimateLines,
  summarizeQuickBooksEstimateLines,
} from '../netlify/functions/_shared/quickbooks-estimate-lines.mjs';
import {
  buildQuickBooksMilestoneInvoiceLine,
  evaluateAccountingTaxInvariant,
  evaluateLiveQuickBooksEstimateInvariant,
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

const liveHealthy = evaluateLiveQuickBooksEstimateInvariant({
  Id: '176',
  DocNumber: '1025',
  TotalAmt: 15706.80,
  TxnTaxDetail: { TotalTax: 0 },
  Line: [
    {
      Id: '14',
      DetailType: 'SalesItemLineDetail',
      Amount: 15000,
      SalesItemLineDetail: { TaxCodeRef: { value: 'NON' } },
    },
    {
      Id: '15',
      DetailType: 'SalesItemLineDetail',
      Amount: 706.80,
      SalesItemLineDetail: { TaxCodeRef: { value: 'NON' } },
    },
  ],
});
assert.equal(liveHealthy.ok, true, 'The live Chris Sibel estimate shape must pass at exactly $15,706.80.');
assert.equal(liveHealthy.taxablePayload, 0, 'The live invariant must require a $0.00 taxable payload.');
assert.equal(liveHealthy.quickBooksCalculatedTax, 0, 'The live invariant must require QuickBooks to add $0.00 extra tax.');

const liveTaxOnTaxRegression = evaluateLiveQuickBooksEstimateInvariant({
  Id: '176',
  TotalAmt: 16446.90,
  TxnTaxDetail: { TotalTax: 740.10 },
  Line: [
    {
      Id: '14',
      DetailType: 'SalesItemLineDetail',
      Amount: 15000,
      SalesItemLineDetail: { TaxCodeRef: { value: 'TAX' } },
    },
    {
      Id: '15',
      DetailType: 'SalesItemLineDetail',
      Amount: 706.80,
      SalesItemLineDetail: { TaxCodeRef: { value: 'TAX' } },
    },
  ],
});
assert.equal(liveTaxOnTaxRegression.ok, false, 'Historical $16,446.90 tax-on-tax must fail the live invariant.');
assert.equal(liveTaxOnTaxRegression.total, 16446.90);
assert.ok(liveTaxOnTaxRegression.taxablePayload > 0, 'Tax-on-tax regression must expose taxable payload.');
assert.equal(liveTaxOnTaxRegression.quickBooksCalculatedTax, 740.10);

console.log('Live QuickBooks invariant regression passed: $15,706.80 is required and $16,446.90 is rejected.');

