import { createHash } from 'node:crypto';

// Read-only identity projection for legacy sales records. Project and booking records
// are never merged or deleted to make the customer directory look unique.
const text = value => String(value ?? '').trim();
const nameKey = value => text(value).toLowerCase().replace(/\s+/g, ' ');
const emailKey = value => text(value).toLowerCase();
const phoneKey = value => {
  const digits = text(value).replace(/\D/g, '');
  return digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits.length >= 7 ? digits : '';
};
const distinct = values => [...new Set(values.filter(Boolean))];
const validId = value => /^[a-zA-Z0-9_-]{1,120}$/.test(text(value)) ? text(value) : '';

function ordered(a, b) {
  const dateA = Date.parse(a.record.createdAt || '') || Number.MAX_SAFE_INTEGER;
  const dateB = Date.parse(b.record.createdAt || '') || Number.MAX_SAFE_INTEGER;
  return dateA - dateB || a.id.localeCompare(b.id);
}
function groupId(rows, tenantId) {
  const persisted = distinct(rows.map(row => row.explicitId));
  if (persisted.length === 1) return persisted[0];
  const oldest = [...rows].sort(ordered)[0];
  const identity = oldest.email && oldest.name
    ? 'email|' + oldest.email + '|name|' + oldest.name
    : oldest.phone && oldest.name
      ? 'phone|' + oldest.phone + '|name|' + oldest.name
      : 'record|' + oldest.id;
  return 'CUST-' + createHash('sha256').update(text(tenantId) + '|' + identity).digest('hex').slice(0, 24).toUpperCase();
}
function makeReview(category, recordIds, message, customerIds = []) {
  return { category, recordIds: distinct(recordIds), customerIds: distinct(customerIds), message };
}

export function buildCustomerDirectory(records, { tenantId = '', maxCustomers = 2000, maxReviews = 150 } = {}) {
  const rows = (Array.isArray(records) ? records : [])
    .filter(record => record && validId(record.id) && !record.mergedInto && record.kind !== 'quickbooks-test')
    .map(record => ({
      record,
      id: record.id,
      name: nameKey(record.customer?.name),
      email: emailKey(record.customer?.email),
      phone: phoneKey(record.customer?.phone),
      explicitId: validId(record.customerId),
      referenceId: validId(record.customerReferenceId),
    }));
  const byId = new Map(rows.map((row, i) => [row.id, i]));
  const parent = rows.map((_, i) => i);
  const explicit = rows.map(row => new Set(row.explicitId ? [row.explicitId] : []));
  const root = index => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (a, b) => {
    a = root(a);
    b = root(b);
    if (a === b) return true;
    if (explicit[a].size && explicit[b].size &&
      [...explicit[a]].some(id => !explicit[b].has(id))) return false;
    parent[b] = a;
    for (const id of explicit[b]) explicit[a].add(id);
    return true;
  };
  const explicitBuckets = new Map();
  rows.forEach((row, i) => {
    if (!row.explicitId) return;
    const prior = explicitBuckets.get(row.explicitId);
    if (prior === undefined) explicitBuckets.set(row.explicitId, i);
    else union(prior, i);
  });
  rows.forEach((row, i) => {
    if (byId.has(row.referenceId)) union(i, byId.get(row.referenceId));
  });
  // Match only exact name plus strong contact identity. A shared household
  // address, a shared phone with conflicting emails, or name alone is not enough.
  const emailBuckets = new Map();
  const phoneBuckets = new Map();
  rows.forEach((row, i) => {
    if (row.name && row.email) {
      const key = row.name + '|' + row.email;
      const matches = emailBuckets.get(key) || [];
      for (const other of matches) union(i, other);
      matches.push(i);
      emailBuckets.set(key, matches);
    }
    if (row.name && row.phone) {
      const key = row.name + '|' + row.phone;
      const matches = phoneBuckets.get(key) || [];
      for (const other of matches) {
        if (!row.email || !rows[other].email || row.email === rows[other].email) union(i, other);
      }
      matches.push(i);
      phoneBuckets.set(key, matches);
    }
  });
  const buckets = new Map();
  rows.forEach((row, i) => {
    const group = root(i);
    if (!buckets.has(group)) buckets.set(group, []);
    buckets.get(group).push(row);
  });
  const reviews = [];
  const customerRows = [];
  const recordToCustomerId = {};
  for (const members of buckets.values()) {
    const sorted = [...members].sort(ordered);
    const primary = sorted.find(row => row.record.kind === 'lead') || sorted[0];
    const contactRows = [primary, ...sorted.filter(row => row !== primary)].sort((a, b) =>
      (b.record.kind === 'lead' ? 1 : 0) - (a.record.kind === 'lead' ? 1 : 0) || ordered(a, b));
    const chosen = field => contactRows.find(row => text(row.record.customer?.[field]))?.record.customer?.[field] || '';
    const customerId = groupId(sorted, tenantId);
    members.forEach(row => { recordToCustomerId[row.id] = customerId; });
    const projects = sorted.filter(row => row.record.kind !== 'lead').map(row => ({
      id: row.id,
      projectName: text(row.record.projectName),
      eventDate: text(row.record.customer?.eventDate).slice(0, 10),
      businessLine: text(row.record.businessLine) || 'events',
      stage: text(row.record.stage || row.record.kind),
      kind: text(row.record.kind),
    }));
    const leadIds = sorted.filter(row => row.record.kind === 'lead').map(row => row.id);
    const names = distinct(members.map(row => row.name));
    const emails = distinct(members.map(row => row.email));
    const phones = distinct(members.map(row => row.phone));
    const qboCustomerIds = distinct(members.map(row => validId(row.record.accounting?.quickbooks?.customerId)));
    const conflicts = [];
    if (names.length > 1) conflicts.push('Customer names differ across linked records');
    if (emails.length > 1) conflicts.push('Email addresses differ across linked records');
    if (phones.length > 1) conflicts.push('Phone numbers differ across linked records');
    if (qboCustomerIds.length > 1) conflicts.push('Different QuickBooks customer IDs require review');
    if (leadIds.length > 1) reviews.push(makeReview('duplicate_customer_lead', leadIds,
      'Multiple customer-only leads share one identity; preserve them pending review.', [customerId]));
    if (conflicts.length) reviews.push(makeReview('linked_contact_conflict', members.map(row => row.id),
      conflicts.join('; ') + '. No booking, invoice or signed agreement was modified.', [customerId]));
    const dateBuckets = new Map();
    for (const project of projects) {
      if (!project.eventDate) continue;
      const key = project.eventDate + '|' + project.businessLine;
      const arr = dateBuckets.get(key) || [];
      arr.push(project.id); dateBuckets.set(key, arr);
    }
    for (const ids of dateBuckets.values()) if (ids.length > 1) reviews.push(makeReview(
      'possible_duplicate_project', ids,
      'Multiple project records share this customer, event date and business line. They may represent legitimate services; compare bookings and proposals before taking action.', [customerId]));
    customerRows.push({
      id: customerId,
      primaryRecordId: primary.id,
      name: text(chosen('name')) || 'Unnamed customer',
      email: emailKey(chosen('email')),
      phone: text(chosen('phone')),
      projectCount: projects.length,
      projects,
      leadIds,
      recordIds: sorted.map(row => row.id),
      needsReview: conflicts.length > 0 || leadIds.length > 1,
      verified: Boolean(sorted.some(row => row.email || row.phone)),
    });
  }

  // Ambiguities remain separate customer entities. Identity reviews never merge
  // rows automatically based only on name, shared email, or shared phone.
  const externalBuckets = new Map();
  const bucket = (kind, key, row) => {
    if (!key) return;
    const lookup = kind + ':' + key;
    const items = externalBuckets.get(lookup) || [];
    items.push(row); externalBuckets.set(lookup, items);
  };
  rows.forEach(row => {
    bucket('email', row.email, row);
    bucket('phone', row.phone, row);
    if (!row.email && !row.phone) bucket('name_only', row.name, row);
  });
  for (const [key, members] of externalBuckets) {
    const ids = distinct(members.map(row => recordToCustomerId[row.id]));
    if (ids.length < 2) continue;
    const category = key.startsWith('email:') ? 'shared_email'
      : key.startsWith('phone:') ? 'shared_phone' : 'unverified_name_match';
    reviews.push(makeReview(category, members.map(row => row.id),
      category === 'shared_email' ? 'Different customer identities share an email; verify they are the same person before linking.'
        : category === 'shared_phone' ? 'Different customer identities share a phone; this may be a household or business number.'
          : 'Name-only records cannot be safely consolidated without another identifier.', ids));
  }
  customerRows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  reviews.sort((a, b) => a.category.localeCompare(b.category) || a.recordIds.join('|').localeCompare(b.recordIds.join('|')));
  const projectRows = rows.filter(row => row.record.kind !== 'lead').length;
  return {
    customers: customerRows.slice(0, maxCustomers),
    recordToCustomerId,
    truncated: customerRows.length > maxCustomers,
    audit: {
      generatedAt: new Date().toISOString(),
      totals: {
        salesRecords: rows.length,
        uniqueCustomers: customerRows.length,
        projects: projectRows,
        customersWithMultipleProjects: customerRows.filter(row => row.projectCount > 1).length,
        multiRecordIdentities: customerRows.filter(row => row.recordIds.length > 1).length,
        explicitCustomerLinks: rows.filter(row => row.explicitId).length,
        recordsWithLegacyIdentity: rows.filter(row => !row.explicitId).length,
        reviewGroups: reviews.length,
      },
      reviewGroups: reviews.slice(0, maxReviews),
      reviewTruncated: reviews.length > maxReviews,
      writeActionsTaken: 0,
    },
  };
}

export function lookupCustomerForRecord(records, recordId, tenantId) {
  const directory = buildCustomerDirectory(records, { tenantId });
  const customerId = directory.recordToCustomerId[recordId];
  return directory.customers.find(row => row.id === customerId) || null;
}
