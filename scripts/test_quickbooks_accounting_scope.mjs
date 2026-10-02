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

const crmManaged = quickBooksAccountingScope({
  source: 'website',
  proposal: { source: 'crm' },
  accounting: { quickbooks: { origin: 'crm' } },
});
assert.equal(crmManaged.mode, 'crm-managed');
assert.equal(crmManaged.actionable, true);

assert.equal(currentBookingStatus({ stage:'booked', proposal:{ status:'sent' } }), 'booked');
assert.equal(currentBookingStatus({ stage:'proposal', proposal:{ status:'accepted' } }), 'accepted');
assert.equal(
  currentBookingStatus({ stage:'proposal', status:'booked', proposal:{ status:'sent' } }),
  '',
  'Legacy record.status must not override the authoritative stage/proposal lifecycle.',
);

const systemHealthSource = fs.readFileSync('netlify/functions/_shared/system-health.ts', 'utf8');
assert.match(systemHealthSource, /Boolean\(currentBookingStatus\(record\)\)/, 'System Health must select current clients from authoritative booking lifecycle status.');
assert.doesNotMatch(
  systemHealthSource.slice(systemHealthSource.indexOf('async function acceptedBookedLiveAccountingInvariants'), systemHealthSource.indexOf('async function quickBooksTaxInvariantHealthCheck')),
  /quickBooksAccountingScope\(record\)/,
  'Current accepted/booked invariant population must not be reduced by historical provenance classification.',
);

console.log('QuickBooks accounting selector regression passed: accepted/booked lifecycle is authoritative while historical scope remains available for non-live accounting views.');
