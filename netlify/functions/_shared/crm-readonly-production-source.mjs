// Audit snapshots use the same authorized tenant-bound storage abstraction as
// the CRM. readOnlyJSON performs no copy-on-read, normalization writes or mirrors.
import { tenantStoreFor } from './tenant-storage';

import { buildReadOnlyCrmProductionAudit } from './crm-readonly-production-audit.mjs';

export async function auditLiveCrmReadOnly(context, tenant) {
  if (context?.deploy?.context !== 'production') {
    throw new Error('Read-only audit requires an exact production deployment.');
  }
  if (!tenant?.id || !tenant?.storage) throw new Error('No audited tenant.');
  const sales = tenantStoreFor(context, tenant, 'sales');
  const crm = tenantStoreFor(context, tenant, 'crm');
  const [index, notes, tasks] = await Promise.all([
    sales.readOnlyJSON('records/index'),
    crm.readOnlyJSON('notes/index'),
    crm.readOnlyJSON('tasks/index'),
  ]);
  if (!Array.isArray(index.data)) throw new Error('Authoritative CRM records index was unavailable.');
  if (notes.data != null && !Array.isArray(notes.data)) throw new Error('CRM note index requires review.');
  if (tasks.data != null && !Array.isArray(tasks.data)) throw new Error('CRM task index requires review.');
  return buildReadOnlyCrmProductionAudit({
    records:index.data, notes:notes.data || [], tasks:tasks.data || [],
    tenantId:tenant.id, indexSource:index.source, notesSource:notes.source, tasksSource:tasks.source,
  });
}
