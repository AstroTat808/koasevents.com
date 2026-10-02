import assert from 'node:assert/strict';
import fs from 'node:fs';
import { currentBookingStatus, quickBooksAccountingScope } from '../netlify/functions/_shared/quickbooks-accounting-scope.mjs';

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

const crmManagedWithQboOrigin = quickBooksAccountingScope({
  source: 'website',
  stage: 'booked',
  proposal: { source: 'crm', status: 'sent' },
  accounting: { quickbooks: { origin: 'quickbooks' } },
});
assert.equal(crmManagedWithQboOrigin.mode, 'crm-managed');
assert.equal(crmManagedWithQboOrigin.actionable, true);
assert.equal(crmManagedWithQboOrigin.historicalQuickBooksImport, false);
assert.equal(crmManagedWithQboOrigin.qboOrigin, 'quickbooks');

assert.equal(currentBookingStatus({ stage:'booked', proposal:{ status:'sent' } }), 'booked');
assert.equal(currentBookingStatus({ stage:'proposal', proposal:{ status:'accepted' } }), 'accepted');
assert.equal(
  currentBookingStatus({ stage:'proposal', status:'booked', proposal:{ status:'sent' } }),
  '',
  'Legacy record.status must not override the authoritative stage/proposal lifecycle.',
);

const systemHealthSource = fs.readFileSync('netlify/functions/_shared/system-health.ts', 'utf8');
assert.match(systemHealthSource, /currentBookingStatus\(record\)/, 'System Health must select current bookings from the authoritative lifecycle helper.');
assert.match(systemHealthSource, /quickBooksAccountingScope\(record\)\.actionable/, 'System Health must still exclude explicit historical QuickBooks imports.');

console.log('QuickBooks accounting scope regression passed: authoritative accepted/booked lifecycle wins, CRM-managed QBO-linked bookings remain actionable, and explicit historical imports stay informational.');
