function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function emailKey(value) {
  return clean(value, 240).toLowerCase();
}

function dateKey(value) {
  const raw = clean(value, 40);
  const match = raw.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

function nameKey(value) {
  return clean(value, 180).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function packageKey(record) {
  return clean(
    record?.packageId
      || record?.quote?.state?.startingPoint
      || record?.inquiry?.venuePackage
      || record?.inquiry?.mobileBarPackage,
    120,
  ).toLowerCase();
}

function proposalStrength(record) {
  const proposal = record?.proposal || {};
  const status = clean(proposal?.status, 40).toLowerCase();
  const rank = { booked: 6, accepted: 5, viewed: 4, sent: 3, draft: 2, declined: 1, expired: 1 };
  return Number(rank[status] || 0) * 100000 + Math.round(Number(proposal?.total || 0) * 100);
}

function qboStrength(record) {
  const qbo = record?.accounting?.quickbooks || {};
  let score = 0;
  if (clean(qbo.customerId, 100)) score += 500000;
  if (clean(qbo.estimateId, 100) || (Array.isArray(qbo.estimates) && qbo.estimates.length)) score += 300000;
  if (Array.isArray(qbo.invoices) && qbo.invoices.length) score += 200000;
  if (Array.isArray(qbo.payments) && qbo.payments.length) score += 100000;
  return score;
}

function signWellStrength(record) {
  const sw = record?.booking?.contract?.signwell || {};
  let score = 0;
  if (clean(sw.documentId, 180)) score += 250000;
  if (clean(sw.signedPdfKey, 500) || sw.signedPdfStored) score += 125000;
  if (clean(sw.status, 80) === 'completed') score += 50000;
  return score;
}

function bookingStrength(record) {
  const booking = record?.booking || {};
  const payments = Array.isArray(booking?.payments) ? booking.payments : [];
  let score = 0;
  if (booking && Object.keys(booking).length) score += 100000;
  if (clean(booking?.status, 40) === 'booked') score += 100000;
  if (payments.length) score += 50000 + payments.length * 1000;
  if (booking?.contract && Object.keys(booking.contract).length) score += 75000;
  return score;
}

function createdAtScore(record) {
  const time = Date.parse(clean(record?.createdAt, 80));
  return Number.isFinite(time) ? -Math.floor(time / 1000) : 0;
}

export function bookingIdentity(record) {
  const customer = record?.customer || {};
  const eventDate = dateKey(customer.eventDate);
  const email = emailKey(customer.email);
  const name = nameKey(customer.name);
  const pkg = packageKey(record);
  return {
    eventDate,
    email,
    name,
    packageId: pkg,
    strongKey: eventDate && email ? 'email|' + email + '|date|' + eventDate : '',
    fallbackKey: eventDate && name ? 'name|' + name + '|date|' + eventDate + (pkg ? '|pkg|' + pkg : '') : '',
  };
}

export function duplicateBookingKey(record) {
  const identity = bookingIdentity(record);
  return identity.strongKey || identity.fallbackKey;
}

export function recordAuthorityScore(record) {
  return qboStrength(record)
    + signWellStrength(record)
    + bookingStrength(record)
    + proposalStrength(record)
    + (clean(record?.quoteId, 120) ? 25000 : 0)
    + createdAtScore(record);
}

export function describeRecordOrigin(record) {
  const source = clean(record?.source, 120);
  const qbo = record?.accounting?.quickbooks || {};
  const proposal = record?.proposal || null;
  const booking = record?.booking || null;
  const signals = [];
  if (source) signals.push('source=' + source);
  if (clean(qbo?.origin, 80)) signals.push('qbo-origin=' + clean(qbo.origin, 80));
  if (clean(qbo?.customerId, 100)) signals.push('qbo-customer=' + clean(qbo.customerId, 100));
  if (proposal) signals.push('proposal=' + clean(proposal.status || 'present', 40));
  if (booking) signals.push('booking=' + clean(booking.status || 'present', 40));
  return {
    source: source || 'unknown',
    createdAt: clean(record?.createdAt, 80),
    updatedAt: clean(record?.updatedAt, 80),
    signals,
  };
}

function uniqueIds(rows) {
  return [...new Set((rows || []).map((row) => clean(row?.id, 120)).filter(Boolean))];
}

function conflictValue(records, getter) {
  const values = [...new Set(records.map(getter).map((value) => clean(value, 500)).filter(Boolean))];
  return values.length > 1 ? values : [];
}

export function duplicateBookingGroups(records) {
  const groups = new Map();
  for (const record of (records || []).filter(Boolean)) {
    if (record?.mergedInto) continue;
    const key = duplicateBookingKey(record);
    if (!key) continue;
    const rows = groups.get(key) || [];
    rows.push(record);
    groups.set(key, rows);
  }
  return [...groups.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => {
      const sorted = [...rows].sort((a, b) => recordAuthorityScore(b) - recordAuthorityScore(a));
      const recommended = sorted[0];
      const qboCustomerConflicts = conflictValue(rows, (r) => r?.accounting?.quickbooks?.customerId);
      const signWellConflicts = conflictValue(rows, (r) => r?.booking?.contract?.signwell?.documentId);
      const eventDates = [...new Set(rows.map((r) => dateKey(r?.customer?.eventDate)).filter(Boolean))];
      return {
        key,
        count: rows.length,
        recommendedSurvivorId: clean(recommended?.id, 120),
        blocked: qboCustomerConflicts.length > 1 || signWellConflicts.length > 1 || eventDates.length > 1,
        conflicts: {
          quickBooksCustomerIds: qboCustomerConflicts,
          signWellDocumentIds: signWellConflicts,
          eventDates: eventDates.length > 1 ? eventDates : [],
        },
        records: sorted.map((record) => ({
          id: clean(record?.id, 120),
          authorityScore: recordAuthorityScore(record),
          customer: {
            name: clean(record?.customer?.name, 180),
            email: clean(record?.customer?.email, 240),
            eventDate: dateKey(record?.customer?.eventDate),
          },
          packageId: packageKey(record),
          kind: clean(record?.kind, 40),
          stage: clean(record?.stage, 40),
          proposalStatus: clean(record?.proposal?.status, 40),
          proposalTotal: Number(record?.proposal?.total || 0),
          quickBooksCustomerId: clean(record?.accounting?.quickbooks?.customerId, 100),
          quickBooksEstimateId: clean(record?.accounting?.quickbooks?.estimateId, 100),
          signWellDocumentId: clean(record?.booking?.contract?.signwell?.documentId, 180),
          origin: describeRecordOrigin(record),
        })),
      };
    })
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function mergeMissingObject(target, source) {
  const next = { ...(target || {}) };
  for (const [key, value] of Object.entries(source || {})) {
    if (next[key] === undefined || next[key] === null || next[key] === '') next[key] = value;
  }
  return next;
}

function timelineRows(record) {
  return Array.isArray(record?.timeline) ? record.timeline : [];
}

function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = clean(row?.id, 140) || JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function buildDuplicateMergePreview(records, survivorId, sourceIds) {
  const byId = new Map((records || []).filter(Boolean).map((row) => [clean(row?.id, 120), row]));
  const survivor = byId.get(clean(survivorId, 120));
  const sources = uniqueIds((sourceIds || []).map((id) => ({ id })))
    .filter((id) => id !== clean(survivorId, 120))
    .map((id) => byId.get(id))
    .filter(Boolean);
  if (!survivor) throw new Error('The selected surviving CRM record does not exist.');
  if (!sources.length) throw new Error('Select at least one duplicate record to merge.');

  const group = duplicateBookingGroups([survivor, ...sources])[0];
  if (!group || group.count !== sources.length + 1) {
    throw new Error('The selected records do not share the same booking identity.');
  }

  const qboIds = [...new Set([survivor, ...sources].map((r) => clean(r?.accounting?.quickbooks?.customerId, 100)).filter(Boolean))];
  const signwellIds = [...new Set([survivor, ...sources].map((r) => clean(r?.booking?.contract?.signwell?.documentId, 180)).filter(Boolean))];
  const blockingReasons = [];
  if (qboIds.length > 1) blockingReasons.push('Conflicting QuickBooks customer links: ' + qboIds.join(', '));
  if (signwellIds.length > 1) blockingReasons.push('Conflicting SignWell document links: ' + signwellIds.join(', '));

  const sourceSnapshots = sources.map((record) => ({
    id: clean(record?.id, 120),
    origin: describeRecordOrigin(record),
    proposal: record?.proposal || null,
    booking: record?.booking || null,
    accounting: record?.accounting || null,
  }));

  return {
    canApply: blockingReasons.length === 0,
    blockingReasons,
    survivorId: clean(survivor?.id, 120),
    sourceIds: sources.map((r) => clean(r?.id, 120)),
    recommendedSurvivorId: group.recommendedSurvivorId,
    survivorAuthorityScore: recordAuthorityScore(survivor),
    sourceAuthorityScores: sources.map((r) => ({ id: clean(r?.id, 120), score: recordAuthorityScore(r) })),
    sourceSnapshots,
    preserved: [
      'Original duplicate sales records archived under merged/records/<recordId>',
      'CRM tasks, notes, appointments, workflow enrollments, activity, messages, and project metadata relinked to survivor',
      'Survivor keeps populated QuickBooks and SignWell links; missing fields may be filled from duplicates',
      'Sales timeline entries are combined and deduplicated',
      'Merge alias map retains old record IDs for future lookup and document compatibility',
    ],
  };
}

export function mergeDuplicateSalesRecord(survivor, sources, actor) {
  const now = new Date().toISOString();
  const merged = { ...survivor };
  for (const source of sources) {
    merged.customer = mergeMissingObject(merged.customer, source?.customer);
    merged.inquiry = mergeMissingObject(merged.inquiry, source?.inquiry);
    merged.quote = merged.quote || source?.quote || null;
    merged.proposal = merged.proposal || source?.proposal || null;
    merged.booking = merged.booking || source?.booking || null;
    merged.accounting = mergeMissingObject(merged.accounting, source?.accounting);
    merged.communications = mergeMissingObject(merged.communications, source?.communications);
    merged.assignment = mergeMissingObject(merged.assignment, source?.assignment);
    merged.security = mergeMissingObject(merged.security, source?.security);
  }
  merged.timeline = dedupeRows([
    ...timelineRows(survivor),
    ...sources.flatMap((source) => timelineRows(source)),
    {
      id: 'MERGE-' + Date.now().toString(36).toUpperCase(),
      type: 'duplicate_booking_merged',
      detail: sources.length + ' duplicate booking record(s) merged into this canonical CRM record by ' + clean(actor, 180) + '.',
      createdAt: now,
    },
  ]).sort((a, b) => String(b?.createdAt || '').localeCompare(String(a?.createdAt || '')));
  merged.mergedRecordIds = [...new Set([...(Array.isArray(merged.mergedRecordIds) ? merged.mergedRecordIds : []), ...sources.map((r) => clean(r?.id, 120))])].filter(Boolean);
  merged.updatedAt = now;
  return merged;
}

export function relinkRecordIdRows(rows, sourceIds, survivorId) {
  const sourceSet = new Set((sourceIds || []).map((id) => clean(id, 120)));
  return dedupeRows((rows || []).map((row) => {
    if (!sourceSet.has(clean(row?.recordId, 120))) return row;
    return { ...row, recordId: clean(survivorId, 120) };
  }));
}

export function findExistingBookingCandidate(records, candidate) {
  const key = duplicateBookingKey(candidate);
  if (!key) return null;
  const matches = (records || []).filter((record) => !record?.mergedInto && duplicateBookingKey(record) === key);
  if (!matches.length) return null;
  return [...matches].sort((a, b) => recordAuthorityScore(b) - recordAuthorityScore(a))[0] || null;
}
