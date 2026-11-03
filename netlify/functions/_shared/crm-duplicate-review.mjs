// Read-only customer-name audit. This module never assumes that a shared name
// proves identity, that a repeated inquiry is a test, or that a merge is safe.
const clean = (value, max = 240) => String(value ?? '').trim().slice(0, max);
const nameKey = value => clean(value).toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
const emailKey = value => clean(value).toLowerCase();
const eventDate = value => /^\d{4}-\d{2}-\d{2}/.exec(clean(value, 40))?.[0] || '';
const lineKey = row => clean(row.businessLine || (/mobile-bar/.test(clean(row.source)) ? 'mobile-bar' : 'events'), 40).toLowerCase();
const serviceKey = row => clean(row.inquiry?.service || row.inquiry?.formName || row.source || '', 120).toLowerCase();
const idKey = value => /^[a-z\d_-]{1,120}$/i.test(clean(value, 120)) ? clean(value, 120) : '';
function explicitTest(row) {
  const email = emailKey(row.customer?.email);
  return row.isTest === true || row.qa === true || row.testRecord === true ||
    row.kind === 'quickbooks-test' || row.source === 'koa-mobile-bar-qa' ||
    /@example\.(test|com)$/.test(email) && /^(qa\+|test\+|synthetic\+)/.test(email);
}
function protectedLinks(row) {
  const qbo = row.accounting?.quickbooks || {};
  const sw = row.booking?.contract?.signwell || {};
  return {
    booking: Boolean(row.booking && Object.keys(row.booking).length),
    payments: Boolean(row.booking?.payments?.length || qbo.payments?.length),
    contract: Boolean(row.booking?.contract && Object.keys(row.booking.contract).length),
    proposal: Boolean(row.proposal && Object.keys(row.proposal).length),
    quickBooks: Boolean(qbo.customerId || qbo.estimateId || qbo.estimates?.length || qbo.invoices?.length),
    signWell: Boolean(sw.documentId || sw.signedPdfKey),
  };
}
function lifecycleLinked(a, b) {
  if (!a || !b || !a.id || !b.id) return false;
  if (idKey(a.source) === b.id || idKey(b.source) === a.id) return true;
  if (a.quoteId && a.quoteId === b.quoteId) return true;
  if (a.mergedInto === b.id || b.mergedInto === a.id) return true;
  return false;
}
function sameOpportunity(a, b) {
  const email = emailKey(a.customer?.email);
  if (!email || email !== emailKey(b.customer?.email)) return false;
  const date = eventDate(a.customer?.eventDate);
  if (!date || date !== eventDate(b.customer?.eventDate)) return false;
  if (lineKey(a) !== lineKey(b)) return false;
  // Separate service-specific inquiries (e.g. venue vs. photo booth) are not
  // treated as duplicates solely because they share an event and contact.
  const as = serviceKey(a), bs = serviceKey(b);
  return !as || !bs || as === bs;
}

export function reviewCustomerDuplicates(records, { name, archivedRecords = [], trashedRecords = [], maxRecords = 100 } = {}) {
  const target = nameKey(name);
  if (target.length < 2 || target.length > 180) throw new Error('Enter a full customer name to audit.');
  const active = (Array.isArray(records) ? records : []).filter(r => r && !r.mergedInto && nameKey(r.customer?.name) === target).map(r => ({ ...r, auditLocation: 'active' }));
  const archived = (Array.isArray(archivedRecords) ? archivedRecords : []).filter(r => r && nameKey(r.customer?.name) === target).map(r => ({ ...r, auditLocation: 'merged_archive' }));
  const trashed = (Array.isArray(trashedRecords) ? trashedRecords : []).filter(r => r && nameKey(r.customer?.name) === target).map(r => ({ ...r, auditLocation: 'trash' }));
  const rows = [...active, ...archived, ...trashed].filter(r => idKey(r.id));
  const results = rows.slice(0, maxRecords).map(row => {
    const others = active.filter(candidate => candidate.id !== row.id);
    const linked = others.filter(other => lifecycleLinked(row, other));
    const candidates = others.filter(other => !lifecycleLinked(row, other) && sameOpportunity(row, other));
    const sameContactDifferentEvent = others.filter(other =>
      emailKey(row.customer?.email) && emailKey(row.customer?.email) === emailKey(other.customer?.email) &&
      eventDate(row.customer?.eventDate) && eventDate(other.customer?.eventDate) &&
      eventDate(row.customer?.eventDate) !== eventDate(other.customer?.eventDate));
    const protections = protectedLinks(row);
    const confirmedTest = explicitTest(row);
    let classification = 'needs_review';
    if (row.auditLocation === 'merged_archive') classification = 'archived_merge_history';
    else if (row.auditLocation === 'trash') classification = 'trashed_record';
    else if (confirmedTest) classification = 'verified_test';
    else if (row.stage === 'converted') classification = 'conversion_history';
    else if (candidates.length) classification = 'possible_redundant_opportunity';
    else if (sameContactDifferentEvent.length) classification = 'distinct_event_date';
    else if (linked.length) classification = 'linked_lifecycle';
    else if (Object.values(protections).some(Boolean)) classification = 'protected_active_record';
    return {
      id: row.id,
      classification,
      location: row.auditLocation,
      testVerified: confirmedTest,
      name: clean(row.customer?.name, 180),
      email: emailKey(row.customer?.email),
      eventDate: eventDate(row.customer?.eventDate),
      businessLine: lineKey(row),
      service: serviceKey(row),
      packageId: clean(row.packageId || row.inquiry?.venuePackage || row.inquiry?.mobileBarPackage, 100),
      kind: clean(row.kind, 40),
      stage: clean(row.stage, 40),
      source: clean(row.source, 120),
      inquirySource: clean(row.inquiry?.source || row.inquiry?.referralSource || '', 200),
      createdAt: clean(row.createdAt, 80),
      updatedAt: clean(row.updatedAt, 80),
      quoteId: clean(row.quoteId, 80),
      customerId: idKey(row.customerId),
      mergedInto: idKey(row.mergedInto),
      quickBooksCustomerId: clean(row.accounting?.quickbooks?.customerId, 80),
      quickBooksEstimateId: clean(row.accounting?.quickbooks?.estimateId, 80),
      signWellDocumentId: clean(row.booking?.contract?.signwell?.documentId, 120),
      linkedLifecycleIds: linked.map(r => r.id),
      potentialDuplicateIds: candidates.map(r => r.id),
      protectedLinks: protections,
      recommendation: classification === 'verified_test' ? 'Review for archival; never automatically remove financial or signed records.'
        : classification === 'possible_redundant_opportunity' ? 'Request a guarded merge preview; confirm identity, project and external links before approval.'
        : classification === 'conversion_history' ? 'Retain in the activity timeline; hide from active pipeline.'
        : classification === 'distinct_event_date' ? 'Keep as a separate project unless evidence proves otherwise.'
        : 'Preserve this record pending administrator review.',
    };
  });
  const totals = { active: active.length, archived: archived.length, trash: trashed.length, returned: results.length, truncated: rows.length > results.length };
  for (const item of results) totals[item.classification] = (totals[item.classification] || 0) + 1;
  return {
    name: clean(name, 180), generatedAt: new Date().toISOString(), readOnly: true, totals, records: results,
    caveat: 'Classification is based on stored CRM evidence, not name alone. Review is required before changing any record.',
  };
}
