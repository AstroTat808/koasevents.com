import { randomUUID } from 'node:crypto';

const clean = (value, max = 200) => String(value ?? '').trim().slice(0, max);
const validId = value => /^[a-zA-Z0-9_-]{1,120}$/.test(String(value || ''));
const safeUtm = value => clean(value, 120).replace(/[^\p{L}\p{N} _.-]/gu, '');
const fields = ['utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm'];

export function normalizeLeadAttribution(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = Object.fromEntries(fields.map(key => [key, safeUtm(raw[key])]));
  const pagePath = clean(raw.pagePath, 180);
  result.pagePath = /^\/[a-z0-9/_-]*\/?$/i.test(pagePath) ? pagePath : '';
  const host = clean(raw.referringHost, 180).toLowerCase();
  result.referringHost = /^[a-z0-9.-]+$/.test(host) && !host.includes('..') ? host : '';
  return result;
}

// Captured once at intake. Later customer/project edits must not rewrite this snapshot.
// Referrer and UTM are explicitly browser-reported, not independently verified.
export function buildLeadOriginSnapshot(record, { mode = 'website', actor = '', attribution = {} } = {}) {
  const inquiry = record?.inquiry || {};
  return {
    schemaVersion: 1,
    capturedAt: clean(record?.createdAt, 60),
    intakeMode: mode === 'manual' ? 'manual' : 'website',
    channel: clean(record?.source, 120),
    formName: clean(inquiry.formName || record?.source, 120),
    capturedBy: mode === 'manual' ? clean(actor, 180) : '',
    discoverySource: clean(inquiry.source, 200),
    referralSource: clean(inquiry.referralSource, 120),
    attribution: normalizeLeadAttribution(attribution),
    initialInquiry: {
      service: clean(inquiry.service, 80),
      eventType: clean(inquiry.eventType, 120),
      eventDate: clean(record?.customer?.eventDate, 40),
      guestCount: inquiry.guestCount ?? '',
      budget: clean(inquiry.budget, 120),
      packageId: clean(record?.packageId, 120),
      priorities: clean(inquiry.priorities || record?.customer?.notes, 4000),
    },
  };
}

export function leadOriginEvidence(record) {
  if (record?.leadProvenance?.schemaVersion === 1) {
    return { ...record.leadProvenance, reliability: 'saved_at_intake' };
  }
  return { ...buildLeadOriginSnapshot(record, {
    mode: record?.source === 'crm-manual-entry' ? 'manual' : 'website',
    actor: record?.createdBy || '',
  }), reliability: 'legacy_record_fields', attribution: normalizeLeadAttribution({}) };
}

export function makeLeadSourceCorrection({ recordId, before = '', after = '', actor = '', at = new Date().toISOString() }) {
  if (!validId(recordId)) throw new Error('Invalid record identifier');
  return {
    id: 'SOURCE-' + randomUUID(),
    recordId,
    type: 'reported_source_corrected',
    at: clean(at, 60),
    actor: clean(actor, 180),
    before: clean(before, 300),
    after: clean(after, 300),
  };
}

// The per-record ledger never rotates. Each event is stored under an independent
// only-if-new key and its ID is indexed through ETag conditional writes.
export async function appendLeadSourceCorrection(store, entry) {
  const sameEntry = (a, b) => {
    const { tenantId: _tenantA, ...left } = a || {};
    const { tenantId: _tenantB, ...right } = b || {};
    return JSON.stringify(left) === JSON.stringify(right);
  };

  if (!validId(entry?.recordId) || !validId(entry?.id)) throw new Error('Invalid provenance event');
  const prefix = 'lead-provenance/' + entry.recordId + '/';
  const key = prefix + 'events/' + entry.id;
  const original = await store.readJSON(key);
  if (original.data && !sameEntry(original.data, entry)) throw new Error('Provenance event conflict');
  if (!original.data) {
    const created = await store.writeJSON(key, entry, null);
    if (!created.modified) {
      const check = await store.readJSON(key);
      if (!sameEntry(check.data, entry)) throw new Error('Provenance event collision');
    }
  }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const snapshot = await store.readJSON(prefix + 'index');
    const ids = Array.isArray(snapshot.data) ? snapshot.data.filter(validId) : [];
    if (ids.includes(entry.id)) return true;
    const written = await store.writeJSON(prefix + 'index', [...ids, entry.id], snapshot.etag);
    if (written.modified) return true;
  }
  throw new Error('Provenance ledger index concurrency conflict');
}

export async function readLeadSourceCorrections(store, recordId) {
  if (!validId(recordId)) throw new Error('Invalid record identifier');
  const prefix = 'lead-provenance/' + recordId + '/';
  const snapshot = await store.readOnlyJSON(prefix + 'index');
  const ids = Array.isArray(snapshot.data) ? snapshot.data.filter(validId) : [];
  const rows = await Promise.all(ids.map(id => store.readOnlyJSON(prefix + 'events/' + id)));
  return rows.map(row => row.data).filter(row => row && row.recordId === recordId).map(({ tenantId: _tenantId, ...event }) => event);
}
