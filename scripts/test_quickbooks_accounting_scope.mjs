import assert from 'node:assert/strict';
import fs from 'node:fs';
import { quickBooksAccountingScope } from '../netlify/functions/_shared/quickbooks-accounting-scope.mjs';

const imported = quickBooksAccountingScope({
  source: 'quickbooks-import',
  proposal: { source: 'quickbooks-import' },
  accounting: { quickbooks: { origin: 'quickbooks' } },
});
assert.equal(imported.mode, 'quickbooks-history');
assert.equal(imported.actionable, false);
assert.equal(imported.historicalQuickBooksImport, true);

const importedByProposal = quickBooksAccountingScope({
  source: 'crm',
  proposal: { source: 'quickbooks-import' },
  accounting: { quickbooks: { origin: '' } },
});
assert.equal(importedByProposal.actionable, false);

const crmManaged = quickBooksAccountingScope({
  source: 'website',
  proposal: { source: 'crm' },
  accounting: { quickbooks: { origin: 'crm' } },
});
assert.equal(crmManaged.mode, 'crm-managed');
assert.equal(crmManaged.actionable, true);
assert.equal(crmManaged.historicalQuickBooksImport, false);

const systemHealthSource = fs.readFileSync('netlify/functions/_shared/system-health.ts', 'utf8');
assert.match(systemHealthSource, /quickBooksAccountingScope\(record\)\.actionable/, 'System Health must exclude non-actionable historical QuickBooks imports from live accepted\/booked accounting invariants.');

console.log('QuickBooks accounting scope regression passed: historical imports stay informational while CRM-managed bookings remain actionable, including System Health.');
