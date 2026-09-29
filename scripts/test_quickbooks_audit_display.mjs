import assert from 'node:assert/strict';
import { quickBooksAuditEstimateView } from '../src/lib/quickbooks-accounting-audit-display.mjs';

const missing = quickBooksAuditEstimateView({
  estimateId: '',
  estimateDocNumber: '',
  estimateTotal: null,
});
assert.equal(missing.label, 'No QBO estimate');
assert.equal(missing.total, null);
assert.equal(missing.consistent, true);

const staleMirrorWithoutLink = quickBooksAuditEstimateView({
  estimateId: '',
  estimateDocNumber: '',
  estimateTotal: 16446.90,
});
assert.equal(staleMirrorWithoutLink.label, 'No QBO estimate');
assert.equal(
  staleMirrorWithoutLink.total,
  null,
  'An unlinked QuickBooks estimate must never display a stale estimate total.',
);
assert.equal(staleMirrorWithoutLink.consistent, true);

const linkedWithoutDocNumber = quickBooksAuditEstimateView({
  estimateId: '98765',
  estimateDocNumber: '',
  estimateTotal: 16446.90,
});
assert.equal(linkedWithoutDocNumber.label, 'Estimate linked · QBO ID 98765');
assert.equal(linkedWithoutDocNumber.total, 16446.90);
assert.equal(linkedWithoutDocNumber.consistent, true);

const linkedWithDocNumber = quickBooksAuditEstimateView({
  estimateId: '98765',
  estimateDocNumber: '1042',
  estimateTotal: 15706.80,
});
assert.equal(linkedWithDocNumber.label, 'Estimate #1042');
assert.equal(linkedWithDocNumber.total, 15706.80);
assert.equal(linkedWithDocNumber.consistent, true);

for (const row of [missing, staleMirrorWithoutLink, linkedWithoutDocNumber, linkedWithDocNumber]) {
  assert.ok(
    !(row.label === 'No QBO estimate' && row.total !== null),
    'Regression: the audit must never show “No QBO estimate” with a QuickBooks estimate total.',
  );
}

console.log('QuickBooks audit display regression passed: missing-link rows cannot display an estimate total.');

const liveVerified = quickBooksAuditEstimateView({
  estimateId: '176',
  estimateDocNumber: '1042',
  estimateTotal: 15706.80,
  estimateVerifiedAt: '2026-09-29T12:00:00.000Z',
  verificationSource: 'live',
});
assert.equal(liveVerified.verificationSource, 'live');
assert.equal(liveVerified.verificationLabel, 'QuickBooks verified live');
assert.equal(liveVerified.verifiedAt, '2026-09-29T12:00:00.000Z');

const storedVerified = quickBooksAuditEstimateView({
  estimateId: '176',
  estimateTotal: 15706.80,
  estimateVerifiedAt: '2026-09-29T12:00:00.000Z',
  verificationSource: 'stored',
});
assert.equal(storedVerified.verificationSource, 'stored');
assert.equal(storedVerified.verificationLabel, 'Stored CRM mirror · last live QuickBooks verification');
