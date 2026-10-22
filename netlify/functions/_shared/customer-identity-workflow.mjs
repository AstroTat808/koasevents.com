import { buildIdentityMigrationPlan, migrateIdentityRows, rollbackIdentityRows,
  recordIndexRevision, IdentityMigrationError } from './customer-identity-migration.mjs';
import { recordRevision } from './crm-record-editor.mjs';

const prefix = 'identity-migrations/';
const ledgerKey = id => prefix + id;
const actor = value => String(value ?? '').trim().slice(0, 140);
const revision = rows => recordIndexRevision(rows);
const confirmed = (rows, assignments, target) => assignments.every(change => {
  const row = rows.find(record => record.id === change.recordId);
  if (!row) return false;
  if (target === 'applied') return String(row.customerId || '') === change.afterCustomerId;
  return String(row.customerId || '') === change.beforeCustomerId;
});
const publicLedger = value => value && ({
  planId: value.planId, status: value.status, createdAt: value.createdAt,
  approvedAt: value.approvedAt || '', appliedAt: value.appliedAt || '',
  rolledBackAt: value.rolledBackAt || '', assignmentCount: value.assignments.length,
  initiator: value.initiator, approver: value.approver || '',
  appliedRevision: value.appliedRevision || '', sourceRevision: value.sourceRevision,
  syncPending: Boolean(value.syncPending), syncWarnings: value.syncWarnings || [],
});

async function history(crm, entry) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const snapshot = await crm.readJSON(prefix + 'index');
    const rows = Array.isArray(snapshot.data) ? snapshot.data : [];
    const latest = [{ planId: entry.planId, status: entry.status, createdAt: entry.createdAt,
      updatedAt: entry.rolledBackAt || entry.appliedAt || entry.approvedAt || entry.createdAt,
      assignmentCount: entry.assignments.length },
      ...rows.filter(row => row.planId !== entry.planId)].slice(0, 75);
    const result = await crm.writeJSON(prefix + 'index', latest, snapshot.etag);
    if (result.modified) return true;
  }
  return false;
}
async function replaceLedger(crm, old, etag, next) {
  const saved = await crm.writeJSON(ledgerKey(old.planId), next, etag);
  if (!saved.modified) throw new IdentityMigrationError('approval_race',
    'Customer migration state changed. Reload the migration plan.');
  return next;
}
async function assertRecordCopiesSafe(sales, records, assignments, target) {
  for (const change of assignments) {
    const record = records.find(row => row.id === change.recordId);
    const copy = await sales.readJSON('records/' + change.recordId);
    if (!record || !copy.data) throw new IdentityMigrationError('record_copy_missing',
      'A CRM record projection is missing. Resolve storage synchronization before migration.');
    if (revision([copy.data]) !== revision([record])) throw new IdentityMigrationError('record_copy_diverged',
      'CRM index and record copies differ; no migration was performed.');
    if (target === 'apply' && recordRevision(record) !== change.beforeRevision) throw new IdentityMigrationError(
      'record_changed', 'A record changed since the migration plan was approved.');
  }
}
async function syncCopies(sales, before, after, assignments) {
  const warnings = [];
  for (const change of assignments) {
    const previous = before.find(row => row.id === change.recordId);
    const target = after.find(row => row.id === change.recordId);
    if (!previous || !target) { warnings.push('record_missing:' + change.recordId); continue; }
    let saved = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const copy = await sales.readJSON('records/' + change.recordId);
        const current = copy.data && recordRevision(copy.data);
        if (current === recordRevision(target)) { saved = true; break; }
        if (current !== recordRevision(previous)) break;
        const result = await sales.writeJSON('records/' + change.recordId, target, copy.etag);
        if (result.modified) { saved = true; break; }
      } catch { break; }
    }
    if (!saved) { warnings.push('record_sync_pending:' + change.recordId); continue; }
    try { if (!await sales.mirrorJSON('records/' + change.recordId)) warnings.push('mirror_pending:' + change.recordId); }
    catch { warnings.push('mirror_pending:' + change.recordId); }
  }
  try { if (!await sales.mirrorJSON('records/index')) warnings.push('index_mirror_pending'); }
  catch { warnings.push('index_mirror_pending'); }
  return warnings;
}

export async function migrationPreview({ tenantId, sales, crm }) {
  const snapshot = await sales.readJSON('records/index');
  const records = snapshot.data ?? [];
  const plan = buildIdentityMigrationPlan(records, tenantId);
  const ledger = await crm.readJSON(ledgerKey(plan.planId));
  const historySnapshot = await crm.readJSON(prefix + 'index');
  const recent = Array.isArray(historySnapshot.data) ? historySnapshot.data : [];
  return { plan, currentApproval: publicLedger(ledger.data), recentMigrations: recent };
}
export async function migrationAction({ action, planId, tenantId, actorId, sales, crm, now = new Date().toISOString() }) {
  if (!['propose', 'approve', 'apply', 'rollback', 'reconcile'].includes(action)) {
    throw new IdentityMigrationError('invalid_action', 'Choose a supported customer migration action.', 400);
  }
  if (!/^CIM-[0-9A-F]{24}$/.test(planId)) throw new IdentityMigrationError('invalid_plan',
    'Choose a valid migration plan.', 400);
  if (!actor(actorId)) throw new IdentityMigrationError('actor_required', 'An authenticated staff identity is required.', 403);
  const index = await sales.readJSON('records/index');
  const records = index.data ?? [];
  const current = await crm.readJSON(ledgerKey(planId));
  const entry = current.data;
  if (action === 'propose') {
    const plan = buildIdentityMigrationPlan(records, tenantId);
    if (plan.planId !== planId) throw new IdentityMigrationError('plan_changed',
      'The customer directory changed. Generate a new preview.');
    if (!plan.assignmentCount) throw new IdentityMigrationError('no_changes',
      'No safe, unlinked customer identities are eligible for migration.');
    if (entry) return { approval: publicLedger(entry), saved: false };
    const proposed = { ...plan, status: 'proposed', initiator: actor(actorId), createdAt: now,
      approver: '', approvedAt: '', appliedAt: '', rolledBackAt: '', appliedRevision: '',
      syncPending: false, syncWarnings: [] };
    const saved = await crm.writeJSON(ledgerKey(planId), proposed, null);
    if (!saved.modified) throw new IdentityMigrationError('approval_race', 'The plan was already proposed. Reload the preview.');
    const historySaved = await history(crm, proposed);
    return { approval: publicLedger(proposed), saved: true, historySyncPending: !historySaved };
  }
  if (!entry || entry.tenantId !== tenantId) throw new IdentityMigrationError('plan_not_found',
    'The approved migration plan could not be located.', 404);
  if (entry.planId !== planId || !Array.isArray(entry.assignments)) {
    throw new IdentityMigrationError('invalid_ledger', 'Migration audit metadata requires review.');
  }
  if (action === 'approve') {
    if (entry.status !== 'proposed') throw new IdentityMigrationError('invalid_migration_state',
      'Only proposed migrations can be approved.');
    if (actor(actorId) === entry.initiator) throw new IdentityMigrationError('second_approver_required',
      'Another administrator must approve this migration.');
    if (revision(records) !== entry.sourceRevision) throw new IdentityMigrationError('plan_changed',
      'Records changed after proposal. Preview and propose a new plan.');
    const check = buildIdentityMigrationPlan(records, tenantId);
    if (check.planId !== planId) throw new IdentityMigrationError('plan_changed', 'The current plan no longer matches this proposal.');
    const approved = await replaceLedger(crm, entry, current.etag, { ...entry, status: 'approved', approver: actor(actorId), approvedAt: now });
    const historySaved = await history(crm, approved);
    return { approval: publicLedger(approved), historySyncPending: !historySaved };
  }
  if (action === 'apply') {
    if (!['approved', 'applied'].includes(entry.status)) throw new IdentityMigrationError('approval_required',
      'A second administrator must approve this plan before any records change.');
    let applied = entry;
    let before = records;
    let after = records;
    const currentRevision = revision(records);
    if (currentRevision === entry.sourceRevision) {
      if (entry.status !== 'approved') throw new IdentityMigrationError('inconsistent_migration_state',
        'An applied migration unexpectedly has its original records.');
      await assertRecordCopiesSafe(sales, records, entry.assignments, 'apply');
      after = migrateIdentityRows(records, entry.assignments);
      const written = await sales.writeJSON('records/index', after, index.etag);
      if (!written.modified) throw new IdentityMigrationError('index_changed', 'The CRM changed during the migration; retry with a fresh preview.');
      applied = await replaceLedger(crm, entry, current.etag, {
        ...entry, status: 'applied', appliedAt: now, appliedRevision: revision(after),
        syncPending: true, syncWarnings: ['record_projection_in_progress'],
      });
    } else {
      if (!confirmed(records, entry.assignments, 'applied')) throw new IdentityMigrationError('index_changed',
        'The CRM index no longer matches the approved migration.');
      const reverted = rollbackIdentityRows(records, entry.assignments);
      if (revision(reverted) !== entry.sourceRevision) throw new IdentityMigrationError('index_changed',
        'Other CRM edits occurred during or after this migration; manual reconciliation is required.');
      before = reverted;
      if (entry.status === 'approved') {
        applied = await replaceLedger(crm, entry, current.etag, {
          ...entry, status: 'applied', appliedAt: now, appliedRevision: currentRevision,
          syncPending: true, syncWarnings: ['recovered_index_commit'],
        });
      } else if (entry.appliedRevision !== currentRevision) {
        throw new IdentityMigrationError('index_changed', 'The applied CRM record revision changed; recheck migration history.');
      }
    }
    const warnings = await syncCopies(sales, before, after, entry.assignments);
    const latest = await crm.readJSON(ledgerKey(planId));
    const completed = await replaceLedger(crm, latest.data, latest.etag, {
      ...latest.data, syncPending: Boolean(warnings.length), syncWarnings: warnings,
    });
    const historySaved = await history(crm, completed);
    return { approval: publicLedger(completed), syncPending: Boolean(warnings.length), historySyncPending: !historySaved };
  }
  if (action === 'rollback') {
    if (entry.status !== 'applied') throw new IdentityMigrationError('not_applied', 'Only applied migrations can be rolled back.');
    if (entry.syncPending) throw new IdentityMigrationError('sync_pending',
      'Reconcile all record projections before attempting a rollback.');
    if (revision(records) !== entry.appliedRevision) throw new IdentityMigrationError('rollback_conflict',
      'CRM records have changed since this migration. Automatic rollback is blocked to preserve later changes.');
    await assertRecordCopiesSafe(sales, records, entry.assignments, 'rollback');
    const reverted = rollbackIdentityRows(records, entry.assignments);
    if (revision(reverted) !== entry.sourceRevision) throw new IdentityMigrationError('rollback_conflict',
      'The original CRM revision cannot be reconstructed.');
    const written = await sales.writeJSON('records/index', reverted, index.etag);
    if (!written.modified) throw new IdentityMigrationError('index_changed', 'CRM records changed during rollback.');
    const rolledBack = await replaceLedger(crm, entry, current.etag, {
      ...entry, status: 'rolled_back', rolledBackAt: now, syncPending: true, syncWarnings: ['rollback_projection_in_progress'],
    });
    const warnings = await syncCopies(sales, records, reverted, entry.assignments);
    const latest = await crm.readJSON(ledgerKey(planId));
    const completed = await replaceLedger(crm, latest.data, latest.etag, { ...latest.data, syncPending: Boolean(warnings.length), syncWarnings: warnings });
    const historySaved = await history(crm, completed);
    return { approval: publicLedger(completed), syncPending: Boolean(warnings.length), historySyncPending: !historySaved };
  }
  if (!['applied', 'rolled_back'].includes(entry.status)) throw new IdentityMigrationError('invalid_migration_state',
    'There are no committed customer projections to reconcile.');
  const targetRevision = entry.status === 'applied' ? entry.appliedRevision : entry.sourceRevision;
  if (revision(records) !== targetRevision) throw new IdentityMigrationError('index_changed',
    'CRM records have changed; reconcile this migration manually.');
  const previous = entry.status === 'applied' ? rollbackIdentityRows(records, entry.assignments) : migrateIdentityRows(records, entry.assignments);
  const warnings = await syncCopies(sales, previous, records, entry.assignments);
  const fixed = await replaceLedger(crm, entry, current.etag, { ...entry, syncPending: Boolean(warnings.length), syncWarnings: warnings });
  const historySaved = await history(crm, fixed);
  return { approval: publicLedger(fixed), syncPending: Boolean(warnings.length), historySyncPending: !historySaved };
}
