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
  candidateCount: value.candidateCount || value.assignments.length,
  reviewDecisions: value.reviewDecisions || {},
  reviewEvents: value.reviewEvents || [],
  initiator: value.initiator, approver: value.approver || '',
  appliedRevision: value.appliedRevision || '', sourceRevision: value.sourceRevision,
  syncPending: Boolean(value.syncPending), syncWarnings: value.syncWarnings || [],
});

async function history(crm, entry) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const snapshot = await crm.readJSON(prefix + 'index');
    const rows = Array.isArray(snapshot.data) ? snapshot.data : [];
    const latest = [{ planId: entry.planId, status: entry.status, createdAt: entry.createdAt,
      updatedAt: entry.rolledBackAt || entry.appliedAt || entry.approvedAt || entry.reviewUpdatedAt || entry.createdAt,
      assignmentCount: entry.assignments.length, candidateCount: entry.candidateCount || entry.assignments.length,
      reviewedCount: Object.keys(entry.reviewDecisions || {}).length,
      reviewMode: entry.approvalMode || 'legacy',
      approvedCount: Object.values(entry.reviewDecisions || {}).filter(row => row?.decision === 'approve').length,
      syncPending: Boolean(entry.syncPending) },
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
  // Production preview is a genuine no-write read, even on legacy-only Blob
  // indexes. In-memory synthetic storage fixtures use readJSON as a fallback.
  const readSales = typeof sales.readOnlyJSON === 'function'
    ? key => sales.readOnlyJSON(key) : key => sales.readJSON(key);
  const readCrm = typeof crm.readOnlyJSON === 'function'
    ? key => crm.readOnlyJSON(key) : key => crm.readJSON(key);
  const snapshot = await readSales('records/index');
  const records = snapshot.data ?? [];
  const plan = buildIdentityMigrationPlan(records, tenantId);
  const ledger = await readCrm(ledgerKey(plan.planId));
  const taskSnapshot = await readCrm('tasks/index');
  if (taskSnapshot.data != null && !Array.isArray(taskSnapshot.data)) throw new IdentityMigrationError(
    'task_index_invalid', 'The task index requires review before orphan associations can be assessed.');
  const ids = new Set(records.map(row => row?.id).filter(Boolean));
  const orphanTasks = (taskSnapshot.data || []).filter(row => row?.id && !ids.has(row.recordId)).map(row => ({
    id: String(row.id), recordId: String(row.recordId || ''), title: String(row.title || '').slice(0, 160),
    dueDate: String(row.dueDate || ''), status: String(row.status || ''),
    actionAllowed: false, reason: 'A verified target project and independent approval are required before task relinking.',
  }));
  const historySnapshot = await readCrm(prefix + 'index');
  const recent = Array.isArray(historySnapshot.data) ? historySnapshot.data : [];
  return { plan, currentApproval: publicLedger(ledger.data), recentMigrations: recent,
    orphanTaskReviews: { count: orphanTasks.length, records: orphanTasks, readOnly: true },
    financialAssociationReviews: { status: 'blocked_pending_authoritative_join', readOnly: true,
      reason: 'Booking, invoice and payment links require original transaction IDs, LinkedTxn evidence and independent approvals. No automatic financial relinking is permitted.' },
  };
}
export async function migrationAction({ action, planId, tenantId, actorId, recordId = '', decision = '', sales, crm, now = new Date().toISOString() }) {
  if (!['propose', 'review-record', 'approve', 'apply', 'rollback', 'reconcile'].includes(action)) {
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
      syncPending: false, syncWarnings: [],
      approvalMode: 'per-record', candidateCount: plan.assignments.length,
      reviewDecisions: {}, reviewEvents: [], reviewUpdatedAt: '' };
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
  if (action === 'review-record') {
    if (entry.status !== 'proposed' || entry.approvalMode !== 'per-record')
      throw new IdentityMigrationError('invalid_migration_state', 'Only pending record-level proposals may be reviewed.');
    if (actor(actorId) === entry.initiator) throw new IdentityMigrationError('second_approver_required',
      'A different administrator must decide each customer identity assignment.');
    const selected = entry.assignments.find(row => row.recordId === recordId);
    if (!selected) throw new IdentityMigrationError('record_not_in_plan', 'The requested record is not in this approved review scope.', 400);
    if (!['approve', 'reject'].includes(decision)) throw new IdentityMigrationError('invalid_decision',
      'Choose approve or reject for this exact record.', 400);
    if (revision(records) !== entry.sourceRevision ||
      buildIdentityMigrationPlan(records, tenantId).planId !== planId ||
      recordRevision(records.find(row => row.id === recordId)) !== selected.beforeRevision)
      throw new IdentityMigrationError('plan_changed', 'CRM records changed; generate a new read-only preview before continuing.');
    const previous = entry.reviewDecisions?.[recordId];
    if (previous?.decision === decision && previous.reviewer === actor(actorId))
      return { approval: publicLedger(entry), saved: false };
    if ((entry.reviewEvents || []).length >= 200) throw new IdentityMigrationError('review_history_full',
      'This plan has reached its protected audit limit. Preserve the ledger and request administrator reconciliation.');
    const nextDecision = { decision, reviewer: actor(actorId), reviewedAt: now };
    const updated = await replaceLedger(crm, entry, current.etag, {
      ...entry, reviewDecisions: { ...(entry.reviewDecisions || {}), [recordId]: nextDecision },
      reviewEvents: [...(entry.reviewEvents || []), { recordId, before: previous?.decision || 'pending',
        after: decision, actor: actor(actorId), at: now }],
      reviewUpdatedAt: now,
    });
    const historySaved = await history(crm, updated);
    return { approval: publicLedger(updated), saved: true, historySyncPending: !historySaved };
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
    let approvedAssignments = entry.assignments;
    if (entry.approvalMode === 'per-record') {
      const reviews = entry.reviewDecisions || {};
      if (entry.assignments.some(row => !reviews[row.recordId]))
        throw new IdentityMigrationError('record_reviews_incomplete', 'Every candidate must be individually approved or rejected before final approval.');
      approvedAssignments = entry.assignments.filter(row => reviews[row.recordId]?.decision === 'approve');
      if (!approvedAssignments.length)
        throw new IdentityMigrationError('no_approved_records', 'No individual identity assignments were approved.');
      if (approvedAssignments.some(row => reviews[row.recordId]?.reviewer === entry.initiator))
        throw new IdentityMigrationError('second_approver_required', 'An independent administrator must review each assignment.');
    }
    const approved = await replaceLedger(crm, entry, current.etag, { ...entry,
      assignments: approvedAssignments, status: 'approved', approver: actor(actorId), approvedAt: now });
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
    if (!['applied', 'rolled_back'].includes(entry.status)) throw new IdentityMigrationError('not_applied', 'Only applied migrations can be rolled back.');
    const isAlreadyRolledBack = revision(records) === entry.sourceRevision;
    if (!isAlreadyRolledBack && entry.syncPending) throw new IdentityMigrationError('sync_pending',
      'Reconcile all record projections before attempting a rollback.');
    if (!isAlreadyRolledBack && revision(records) !== entry.appliedRevision) throw new IdentityMigrationError('rollback_conflict',
      'CRM records have changed since this migration. Automatic rollback is blocked to preserve later changes.');
    if (!isAlreadyRolledBack) {
      await assertRecordCopiesSafe(sales, records, entry.assignments, 'rollback');
    }
    const reverted = isAlreadyRolledBack ? records : rollbackIdentityRows(records, entry.assignments);
    if (revision(reverted) !== entry.sourceRevision) throw new IdentityMigrationError('rollback_conflict',
      'The original CRM revision cannot be reconstructed.');
    if (!isAlreadyRolledBack) {
      const written = await sales.writeJSON('records/index', reverted, index.etag);
      if (!written.modified) throw new IdentityMigrationError('index_changed', 'CRM records changed during rollback.');
    }
    if (!isAlreadyRolledBack || entry.status !== 'rolled_back') {
      await replaceLedger(crm, entry, current.etag, {
        ...entry, status: 'rolled_back', rolledBackAt: entry.rolledBackAt || now,
        syncPending: true, syncWarnings: ['rollback_projection_in_progress'],
      });
    }
    const before = isAlreadyRolledBack ? migrateIdentityRows(records, entry.assignments) : records;
    const warnings = await syncCopies(sales, before, reverted, entry.assignments);
    const latest = await crm.readJSON(ledgerKey(planId));
    const completed = await replaceLedger(crm, latest.data, latest.etag,
      { ...latest.data, syncPending: Boolean(warnings.length), syncWarnings: warnings });
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
