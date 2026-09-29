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
  estimateVerifiedAt: '2026-09-29T11:30:00.000Z',
});
assert.equal(linkedWithDocNumber.label, 'Estimate #1042');
assert.equal(linkedWithDocNumber.total, 15706.80);
assert.equal(linkedWithDocNumber.liveVerified, true);
assert.equal(linkedWithDocNumber.verificationSource, 'quickbooks_live');
assert.equal(linkedWithDocNumber.verifiedAt, '2026-09-29T11:30:00.000Z');
assert.equal(linkedWithDocNumber.consistent, true);

const linkedMirrorOnly = quickBooksAuditEstimateView({
  estimateId: '76543',
  estimateDocNumber: '1043',
  estimateTotal: 15706.80,
});
assert.equal(linkedMirrorOnly.liveVerified, false);
assert.equal(linkedMirrorOnly.verificationSource, 'crm_mirror');
assert.equal(linkedMirrorOnly.verifiedAt, '');

for (const row of [missing, staleMirrorWithoutLink, linkedWithoutDocNumber, linkedWithDocNumber, linkedMirrorOnly]) {
  assert.ok(
    !(row.label === 'No QBO estimate' && row.total !== null),
    'Regression: the audit must never show “No QBO estimate” with a QuickBooks estimate total.',
  );
}

console.log('QuickBooks audit display regression passed: missing-link rows cannot display an estimate total.');
