// Read-only direct Blob access: no normalization, migration, canonical backfill,
// index mirroring, record writes, or automatic identity assignment.
import { getStore } from '@netlify/blobs';
import { tenantDataPrefix } from './tenant-boundary.mjs';
import { buildReadOnlyCrmProductionAudit } from './crm-readonly-production-audit.mjs';

const canonicalName = 'venueloom-data';
function readOnlyStore(name) { return getStore({ name, consistency: 'strong' }); }

export async function auditLiveCrmReadOnly(context, tenant) {
  if (context?.deploy?.context !== 'production') {
    throw new Error('Read-only audit requires an exact production deployment.');
  }
  if (!tenant?.id || !tenant?.storage) throw new Error('No audited tenant.');
  const canonical = readOnlyStore(canonicalName);
  const legacy = new Map();
  async function read(domain, key) {
    const current = await canonical.get(tenantDataPrefix(tenant, domain) + key, { type: 'json' });
    if (current != null) return { value: current, source: 'canonical' };
    if (!tenant.storage.legacyDataBelongsToTenant) return { value: null, source: 'missing' };
    const legacyName = tenant.storage.compatibilityBlobStores?.[domain];
    if (!legacyName) return { value: null, source: 'missing' };
    if (!legacy.has(legacyName)) legacy.set(legacyName, readOnlyStore(legacyName));
    const prior = await legacy.get(legacyName).get(key, { type: 'json' });
    return { value: prior, source: prior == null ? 'missing' : 'legacy' };
  }
  const [index, notes, tasks] = await Promise.all([
    read('sales', 'records/index'),
    read('crm', 'notes/index'),
    read('crm', 'tasks/index'),
  ]);
  if (!Array.isArray(index.value)) throw new Error('Authoritative CRM records index was unavailable.');
  if (notes.value != null && !Array.isArray(notes.value)) throw new Error('CRM note index format requires review.');
  if (tasks.value != null && !Array.isArray(tasks.value)) throw new Error('CRM task index format requires review.');
  return buildReadOnlyCrmProductionAudit({
    records:index.value, notes:notes.value || [], tasks:tasks.value || [],
    tenantId:tenant.id, indexSource:index.source, notesSource:notes.source, tasksSource:tasks.source,
  });
}
