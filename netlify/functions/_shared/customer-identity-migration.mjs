import { createHash } from 'node:crypto';
import { buildCustomerDirectory } from './customer-directory.mjs';
import { recordRevision } from './crm-record-editor.mjs';

const clean = value => String(value ?? '').trim();
const hash = value => createHash('sha256').update(value).digest('hex');
const safeId = value => /^[a-zA-Z0-9_-]{1,120}$/.test(clean(value));
const HARD_LIMIT = 75;

export class IdentityMigrationError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function recordIndexRevision(records) {
  return recordRevision(records);
}
// Only customerId is changed. All project, payment, contract, external-link,
// record ID, customer snapshot, notes and activity fields remain untouched.
export function migrateIdentityRows(records, assignments) {
  const byId = new Map(assignments.map(change => [change.recordId, change]));
  return records.map(record => {
    const change = byId.get(record.id);
    if (!change) return record;
    if (recordRevision(record) !== change.beforeRevision) throw new IdentityMigrationError(
      'record_changed', 'A customer record changed after this migration was approved.');
    if (clean(record.customerId) !== clean(change.beforeCustomerId)) throw new IdentityMigrationError(
      'identity_changed', 'A customer identity changed after this migration was approved.');
    return { ...record, customerId: change.afterCustomerId };
  });
}
export function rollbackIdentityRows(records, assignments) {
  const byId = new Map(assignments.map(change => [change.recordId, change]));
  return records.map(record => {
    const change = byId.get(record.id);
    if (!change) return record;
    if (clean(record.customerId) !== change.afterCustomerId) throw new IdentityMigrationError(
      'rollback_conflict', 'A customer ID has changed since migration; rollback requires manual review.');
    const restored = { ...record };
    if (change.beforeCustomerId) restored.customerId = change.beforeCustomerId;
    else delete restored.customerId;
    if (recordRevision(restored) !== change.beforeRevision) throw new IdentityMigrationError(
      'rollback_conflict', 'A customer record has changed since migration; rollback requires manual review.');
    return restored;
  });
}
export function buildIdentityMigrationPlan(records, tenantId, limit = HARD_LIMIT) {
  if (!Array.isArray(records) || records.some(row => !row || !safeId(row.id) || (row.tenantId && row.tenantId !== tenantId))) {
    throw new IdentityMigrationError('invalid_record_index', 'CRM records require reconciliation before customer identity migration.');
  }
  const directory = buildCustomerDirectory(records, { tenantId, maxCustomers: Number.MAX_SAFE_INTEGER, maxReviews: Number.MAX_SAFE_INTEGER });
  const unsafeCategories = new Set([
    'linked_contact_conflict', 'duplicate_customer_lead', 'shared_email', 'shared_phone', 'unverified_name_match',
  ]);
  const blockedIds = new Set(directory.audit.reviewGroups.filter(group => unsafeCategories.has(group.category))
    .flatMap(group => group.customerIds));
  const byRecordId = new Map(records.map(row => [row.id, row]));
  const assignments = [];
  const skipped = { ambiguous: 0, unverified: 0, alreadyLinked: 0, conflictingId: 0 };
  const customers = [];
  for (const customer of directory.customers) {
    if (!customer.verified) { skipped.unverified += customer.recordIds.length; continue; }
    if (blockedIds.has(customer.id)) { skipped.ambiguous += customer.recordIds.length; continue; }
    const changes = [];
    for (const recordId of customer.recordIds) {
      const record = byRecordId.get(recordId);
      if (!record) continue;
      const beforeCustomerId = clean(record.customerId);
      if (beforeCustomerId === customer.id) { skipped.alreadyLinked++; continue; }
      if (beforeCustomerId) { skipped.conflictingId++; continue; }
      changes.push({ recordId, beforeCustomerId: '', afterCustomerId: customer.id, beforeRevision: recordRevision(record) });
    }
    if (changes.length) customers.push({ id: customer.id, name: customer.name, projectCount: customer.projectCount, recordIds: changes.map(change => change.recordId) });
    assignments.push(...changes);
  }
  assignments.sort((a, b) => a.recordId.localeCompare(b.recordId));
  const selected = assignments.slice(0, Math.min(HARD_LIMIT, Math.max(1, Number(limit) || HARD_LIMIT)));
  const sourceRevision = recordIndexRevision(records);
  const planId = 'CIM-' + hash(tenantId + ':' + sourceRevision + ':' + JSON.stringify(selected)).slice(0, 24).toUpperCase();
  return {
    planId, tenantId, sourceRevision,
    totalEligible: assignments.length, remainingAfterBatch: assignments.length - selected.length,
    assignmentCount: selected.length, assignments: selected,
    customers: customers.filter(customer => selected.some(change => change.afterCustomerId === customer.id)),
    skipped, conflicts: directory.audit.reviewGroups.filter(group => unsafeCategories.has(group.category)),
    audit: { records: directory.audit.totals.salesRecords, customers: directory.audit.totals.uniqueCustomers,
      reviewGroups: directory.audit.totals.reviewGroups, affectedRecords: selected.length },
    changeType: 'assign_missing_customer_id_only',
  };
}
