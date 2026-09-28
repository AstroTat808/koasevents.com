// Pure tenant-boundary primitives shared by production storage and isolation tests.
// Keep this module free of Netlify/runtime dependencies so it can be exercised in CI.

/** @param {unknown} value */
export function cleanTenantKey(value) {
  return String(value ?? '').replace(/^\/+/, '').slice(0, 560);
}

/** @param {{id:string}} tenant @param {string} domain */
export function tenantDataPrefix(tenant, domain) {
  return 'tenants/' + tenant.id + '/' + domain + '/';
}

/** @param {{id:string}} tenant @param {string} domain @param {string} key */
export function tenantDataKey(tenant, domain, key) {
  return tenantDataPrefix(tenant, domain) + cleanTenantKey(key);
}

/** @param {{id:string}} tenant @param {Record<string,any>} value */
export function stampTenantId(tenant, value) {
  if (value?.tenantId && String(value.tenantId) !== tenant.id) {
    throw new Error('Cross-tenant record access was blocked.');
  }
  return { ...value, tenantId: tenant.id };
}

/** @param {{id:string,storage:{legacyDataBelongsToTenant:boolean}}} tenant @param {any} value */
export function tenantOwnsRecord(tenant, value) {
  if (!value || typeof value !== 'object') return false;
  if (value.tenantId) return String(value.tenantId) === tenant.id;
  return tenant.storage.legacyDataBelongsToTenant === true;
}

/** @param {{id:string,storage:{legacyDataBelongsToTenant:boolean}}} tenant @param {Array<Record<string,any>>} rows */
export function normalizeTenantRows(tenant, rows) {
  let changed = false;
  let rejected = 0;
  const normalized = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    if (row.tenantId && String(row.tenantId) !== tenant.id) {
      rejected += 1;
      continue;
    }
    if (!row.tenantId) {
      if (!tenant.storage.legacyDataBelongsToTenant) {
        rejected += 1;
        continue;
      }
      changed = true;
    }
    normalized.push(stampTenantId(tenant, row));
  }

  return { rows: normalized, changed, rejected };
}
