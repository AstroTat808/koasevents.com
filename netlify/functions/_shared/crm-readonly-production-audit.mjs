// Strictly aggregate-only production CRM identity review. No names, emails, phones,
// record IDs, project IDs or raw customer/financial fields may leave this module.
import { buildCustomerDirectory } from './customer-directory.mjs';
import { buildIdentityMigrationPlan } from './customer-identity-migration.mjs';

const count = value => Array.isArray(value) ? value.length : 0;
const allowedReview = new Set([
  'linked_contact_conflict', 'duplicate_customer_lead', 'shared_email',
  'shared_phone', 'unverified_name_match', 'possible_duplicate_project',
]);
const int = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function buildReadOnlyCrmProductionAudit({ records, notes = [], tasks = [], tenantId, indexSource = 'canonical', notesSource = 'canonical', tasksSource = 'canonical' }) {
  if (!Array.isArray(records) || !Array.isArray(notes) || !Array.isArray(tasks) || !/^[a-z0-9-]{1,80}$/.test(String(tenantId || ''))) {
    throw new Error('Invalid aggregate-only CRM audit input.');
  }
  const ids = records.map(row => String(row?.id || ''));
  const seen = new Set();
  const duplicateRecordIds = ids.filter(id => {
    if (!id || seen.has(id)) return true;
    seen.add(id); return false;
  }).length;
  const tenantConflicts = records.filter(row => row?.tenantId && String(row.tenantId) !== tenantId).length;
  const malformedRecords = records.filter(row => !row || typeof row !== 'object' || Array.isArray(row)).length;
  const sourceErrors = duplicateRecordIds + tenantConflicts + malformedRecords;
  const rawRecordCount = records.length;
  const active = records.filter(row => row && row.id && !row.mergedInto && row.kind !== 'quickbooks-test');
  const activeIds = new Set(active.map(row => String(row.id)));
  const noteOrphans = notes.filter(row => row?.recordId && !activeIds.has(String(row.recordId))).length;
  const taskOrphans = tasks.filter(row => row?.recordId && !activeIds.has(String(row.recordId))).length;
  const liveBookable = active.filter(row => row.kind !== 'lead');
  const financeCounts = {
    bookingPayments: liveBookable.reduce((s, r) => s + count(r.booking?.payments), 0),
    quickBooksInvoices: liveBookable.reduce((s, r) => s + count(r.accounting?.quickbooks?.invoices), 0),
    quickBooksPayments: liveBookable.reduce((s, r) => s + count(r.accounting?.quickbooks?.payments), 0),
    projectsWithBookings: liveBookable.filter(r => r.booking && typeof r.booking === 'object').length,
    projectsWithContracts: liveBookable.filter(r => r.booking?.contract && typeof r.booking.contract === 'object').length,
  };
  // Refuse any migration claim when the source index is compromised.
  if (sourceErrors) return {
    schemaVersion: 1, readOnly: true, customerDataMutations: 0, status: 'blocked',
    source: { index: indexSource, notes: notesSource, tasks: tasksSource },
    totals: { rawRecordCount, duplicateRecordIds, malformedRecords, foreignTenantRecords: tenantConflicts, noteOrphans, taskOrphans },
    preview: { status: 'blocked', reasonCode: 'INVALID_RECORD_INDEX', assignmentCount: 0, maxBatchSize: 12 },
    financeCounts,
  };
  const directory = buildCustomerDirectory(records, { tenantId, maxCustomers: Number.MAX_SAFE_INTEGER, maxReviews: Number.MAX_SAFE_INTEGER });
  const customers = directory.customers;
  const reviewGroups = directory.audit.reviewGroups;
  const knownCustomerIds = new Set(customers.map(x => x.id));
  const unknownProjectLinks = liveBookable.filter(r => !knownCustomerIds.has(directory.recordToCustomerId[r.id])).length;
  const projectCountMismatch = liveBookable.length !== customers.reduce((sum, x) => sum + x.projectCount, 0);
  const membershipsMissing = active.filter(row => !directory.recordToCustomerId[row.id]).length;
  const integrityProblems = int(unknownProjectLinks) + int(membershipsMissing) + (projectCountMismatch ? 1 : 0);
  const categories = {};
  for (const row of reviewGroups) {
    const category = allowedReview.has(row.category) ? row.category : 'other';
    categories[category] = (categories[category] || 0) + 1;
  }
  let migration = null, reasonCode = '';
  try {
    migration = buildIdentityMigrationPlan(records, tenantId);
  } catch (error) {
    reasonCode = typeof error?.code === 'string' && /^[a-z_]{1,48}$/.test(error.code)
      ? error.code : 'MIGRATION_PLAN_UNAVAILABLE';
  }
  const blocked = integrityProblems > 0 || !migration;
  const preview = {
    status: blocked ? 'blocked' : migration.assignmentCount > 0 ? 'review_ready' : 'no_eligible_assignments',
    reasonCode: blocked ? (reasonCode || 'PROFILE_PROJECT_INTEGRITY') : '',
    maxBatchSize: 12,
    assignmentCount: blocked ? 0 : migration.assignmentCount,
    totalEligible: blocked ? 0 : migration.totalEligible,
    remainingAfterBatch: blocked ? 0 : migration.remainingAfterBatch,
    eligibleCustomerGroups: blocked ? 0 : migration.customers.length,
    skipped: blocked ? {} : migration.skipped,
    changeType: 'assign_missing_customer_id_only',
    independentApprovalRequired: true,
    automaticallyApplied: false,
    // Candidate names and specific record identifiers stay only in the authenticated CRM.
  };
  return {
    schemaVersion: 1, readOnly: true, customerDataMutations: 0,
    status: blocked ? 'blocked' : reviewGroups.length || noteOrphans || taskOrphans ? 'review_required' : 'ready',
    source: { index: indexSource, notes: notesSource, tasks: tasksSource },
    totals: {
      rawRecordCount, activeRecords: active.length, uniqueCustomers: customers.length,
      projects: liveBookable.length, customerOnlyLeads: active.filter(r => r.kind === 'lead').length,
      customerGroupsWithMultipleProjects: customers.filter(x => x.projectCount > 1).length,
      explicitCustomerLinks: active.filter(r => r.customerId).length,
      recordsMissingCustomerId: active.filter(r => !r.customerId).length,
      noteCount: notes.length, taskCount: tasks.length, noteOrphans, taskOrphans,
      duplicateRecordIds, malformedRecords, foreignTenantRecords: tenantConflicts,
      unassignedProjectGroupLinks: unknownProjectLinks, missingDirectoryMemberships: membershipsMissing,
      projectCountMismatch: Boolean(projectCountMismatch), identityReviewGroups: reviewGroups.length,
    },
    reviewCategories: categories,
    financeCounts,
    preview,
  };
}
