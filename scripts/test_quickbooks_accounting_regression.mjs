import assert from 'node:assert/strict';
import {
  buildQuickBooksEstimateLines,
  summarizeQuickBooksEstimateLines,
} from '../netlify/functions/_shared/quickbooks-estimate-lines.mjs';

const record = {
  id: 'REGRESSION-15000-GET',
  proposal: {
    lineItems: [{
      id: 'hibiscus',
      description: 'Hibiscus Wedding Collection',
      quantity: 1,
      unitPrice: 15000,
      amount: 15000,
    }],
    subtotal: 15000,
    discountAmount: 0,
    taxLabel: 'Hawaiʻi GET',
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
