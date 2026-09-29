type RecordLike = Record<string, any>;

function clean(value: unknown, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function norm(value: unknown) {
  return clean(value, 500).toLowerCase().replace(/\s+/g, ' ');
}

function normPhone(value: unknown) {
  return clean(value, 100).replace(/\D+/g, '');
}

function packageId(record: RecordLike) {
  return clean(
    record?.packageId
      || record?.quote?.state?.startingPoint
      || record?.inquiry?.venuePackage
      || record?.inquiry?.mobileBarPackage,
    100,
  ).toLowerCase();
}

function businessLine(record: RecordLike) {
  const explicit = clean(record?.businessLine, 60).toLowerCase();
  if (explicit) return explicit;
  const source = clean(record?.source, 120).toLowerCase();
  if (source.includes('mobile-bar')) return 'mobile-bar';
  if (source.includes('wild-ones')) return 'wild-ones';
  return 'events';
}

export function duplicateFingerprint(record: RecordLike) {
  const email = norm(record?.customer?.email);
  const eventDate = clean(record?.customer?.eventDate, 40);
  const pkg = packageId(record);
  const line = businessLine(record);
  if (!email || !eventDate) return '';
  return [email, eventDate, line, pkg || '*'].join('|');
}

export function traceCrmRecordCreation(record: RecordLike) {
  const source = clean(record?.source, 160);
  const qbo = record?.accounting?.quickbooks || {};
  const id = clean(record?.id, 120);
  let mechanism = 'crm-record';
  if (source === 'quickbooks-import' || clean(qbo?.origin, 40) === 'quickbooks') mechanism = 'quickbooks-import';
  else if (source && /^KE[ILP]-/i.test(source)) mechanism = 'crm-promotion';
  else if (/^KEP-/i.test(id)) mechanism = 'proposal-conversion';
  else if (/^KEL-/i.test(id)) mechanism = 'lead-conversion';
  else if (/^KEI-/i.test(id)) mechanism = 'website-inquiry';
  return {
    recordId: id,
    mechanism,
    source: source || '',
    quoteId: clean(record?.quoteId, 100),
    kind: clean(record?.kind, 40),
    stage: clean(record?.stage, 40),
    createdAt: clean(record?.createdAt, 80),
    updatedAt: clean(record?.updatedAt, 80),
    customerName: clean(record?.customer?.name, 180),
    customerEmail: clean(record?.customer?.email, 240),
    customerPhone: clean(record?.customer?.phone, 80),
    eventDate: clean(record?.customer?.eventDate, 40),
    packageId: packageId(record),
    businessLine: businessLine(record),
    proposalTotal: Number(record?.proposal?.total || 0),
    proposalStatus: clean(record?.proposal?.status, 60),
    quickBooksCustomerId: clean(qbo?.customerId, 100),
    quickBooksEstimateId: clean(qbo?.estimateId || qbo?.estimates?.[0]?.estimateId, 100),
    signWellDocumentId: clean(record?.booking?.contract?.signwell?.documentId, 180),
    hasBooking: Boolean(record?.booking),
    hasAccounting: Boolean(record?.accounting),
  };
}

function protectedScore(record: RecordLike) {
  const qbo = record?.accounting?.quickbooks || {};
  const proposal = record?.proposal || {};
  const sw = record?.booking?.contract?.signwell || {};
  let score = 0;
  if (record?.booking) score += 80;
  if (clean(sw?.documentId, 180)) score += 70;
  if (clean(qbo?.customerId, 100)) score += 60;
  if (clean(qbo?.estimateId, 100) || Array.isArray(qbo?.estimates) && qbo.estimates.length) score += 50;
  if (Array.isArray(qbo?.invoices) && qbo.invoices.length) score += 80;
  if (Array.isArray(qbo?.payments) && qbo.payments.length) score += 80;
  if (Number(proposal?.total || 0) > 0) score += 40;
  if (['sent','viewed','accepted','booked'].includes(clean(proposal?.status, 40).toLowerCase())) score += 30;
  if (clean(record?.stage, 40).toLowerCase() === 'booked') score += 40;
  score += Math.min(20, Math.max(0, Date.parse(clean(record?.updatedAt || record?.createdAt, 80)) || 0) / 1e13);
  return Math.round(score * 100) / 100;
}

function relatedComponent(startId: string, records: RecordLike[]) {
  const byId = new Map(records.map((record) => [clean(record?.id, 120), record]));
  const ids = new Set<string>([startId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      const id = clean(record?.id, 120);
      const source = clean(record?.source, 120);
      const quoteId = clean(record?.quoteId, 100);
      if (!id) continue;
      const related = (source && (ids.has(source) || ids.has(id) && byId.has(source)))
        || (quoteId && records.some((candidate) => ids.has(clean(candidate?.id, 120)) && clean(candidate?.quoteId, 100) === quoteId));
      if (related && !ids.has(id)) {
        ids.add(id);
        changed = true;
      }
      if (ids.has(id) && source && byId.has(source) && !ids.has(source)) {
        ids.add(source);
        changed = true;
      }
    }
  }
  return ids;
}

function sameLifecycleChain(a: RecordLike, b: RecordLike, records: RecordLike[]) {
  const aId = clean(a?.id, 120);
  const bId = clean(b?.id, 120);
  if (!aId || !bId) return false;
  if (clean(a?.quoteId, 100) && clean(a?.quoteId, 100) === clean(b?.quoteId, 100)) return true;
  return relatedComponent(aId, records).has(bId);
}

export function buildCrmDuplicateAudit(records: RecordLike[]) {
  const rows = records.filter(Boolean);
  const trace = rows.map(traceCrmRecordCreation);
  const seenLifecycle = new Set<string>();
  const lifecycleChains: any[] = [];

  for (const record of rows) {
    const id = clean(record?.id, 120);
    if (!id || seenLifecycle.has(id)) continue;
    const ids = relatedComponent(id, rows);
    if (ids.size < 2) continue;
    ids.forEach((value) => seenLifecycle.add(value));
    const members = rows.filter((candidate) => ids.has(clean(candidate?.id, 120)));
    const active = members.filter((candidate) => !['converted','lost'].includes(clean(candidate?.stage, 40).toLowerCase()));
    const representative = [...(active.length ? active : members)]
      .sort((a, b) => protectedScore(b) - protectedScore(a) || String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')))[0];
    lifecycleChains.push({
      ids: members.map((member) => clean(member?.id, 120)),
      representativeId: clean(representative?.id, 120),
      quoteIds: [...new Set(members.map((member) => clean(member?.quoteId, 100)).filter(Boolean))],
      convertedIds: members.filter((member) => clean(member?.stage, 40).toLowerCase() === 'converted').map((member) => clean(member?.id, 120)),
      members: members.map(traceCrmRecordCreation),
    });
  }

  const buckets = new Map<string, RecordLike[]>();
  for (const record of rows) {
    const key = duplicateFingerprint(record);
    if (!key) continue;
    buckets.set(key, [...(buckets.get(key) || []), record]);
  }

  const duplicateGroups: any[] = [];
  for (const [fingerprint, group] of buckets.entries()) {
    if (group.length < 2) continue;
    const independent: RecordLike[] = [];
    for (const record of group) {
      if (!independent.some((existing) => sameLifecycleChain(existing, record, rows))) independent.push(record);
    }
    if (independent.length < 2) continue;

    const scored = [...group].sort((a, b) => protectedScore(b) - protectedScore(a) || String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')));
    const survivor = scored[0];
    duplicateGroups.push({
      fingerprint,
      customerEmail: clean(survivor?.customer?.email, 240),
      customerName: clean(survivor?.customer?.name, 180),
      eventDate: clean(survivor?.customer?.eventDate, 40),
      packageId: packageId(survivor),
      businessLine: businessLine(survivor),
      recommendedSurvivorId: clean(survivor?.id, 120),
      records: scored.map((record) => ({
        ...traceCrmRecordCreation(record),
        protectionScore: protectedScore(record),
      })),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    totalRecords: rows.length,
    lifecycleChains,
    duplicateGroups,
    trace,
    summary: {
      lifecycleChains: lifecycleChains.length,
      convertedRecordsHiddenByDefault: lifecycleChains.reduce((sum, chain) => sum + chain.convertedIds.length, 0),
      duplicateGroups: duplicateGroups.length,
      duplicateRecords: duplicateGroups.reduce((sum, group) => sum + group.records.length, 0),
    },
  };
}

function conflictId(a: any, b: any, path: string[]) {
  let av = a, bv = b;
  for (const key of path) { av = av?.[key]; bv = bv?.[key]; }
  const left = clean(av, 500);
  const right = clean(bv, 500);
  return left && right && left !== right ? { path: path.join('.'), survivor: left, duplicate: right } : null;
}

export function buildDuplicateMergePreview(records: RecordLike[], survivorId: string, duplicateIds: string[]) {
  const survivor = records.find((record) => clean(record?.id, 120) === survivorId);
  const duplicates = duplicateIds.map((id) => records.find((record) => clean(record?.id, 120) === id)).filter(Boolean) as RecordLike[];
  if (!survivor) throw new Error('Surviving CRM record was not found.');
  if (!duplicates.length) throw new Error('Select at least one duplicate record.');

  const fingerprint = duplicateFingerprint(survivor);
  const blockers: any[] = [];
  const warnings: string[] = [];

  for (const duplicate of duplicates) {
    if (!duplicateFingerprint(duplicate) || duplicateFingerprint(duplicate) !== fingerprint) {
      blockers.push({ recordId: duplicate.id, reason: 'The records do not share the same client email, event date, business line, and package fingerprint.' });
    }
    for (const path of [
      ['accounting','quickbooks','customerId'],
      ['booking','contract','signwell','documentId'],
      ['proposal','publicToken'],
    ]) {
      const conflict = conflictId(survivor, duplicate, path);
      if (conflict) blockers.push({ recordId: duplicate.id, reason: 'Conflicting external identity', ...conflict });
    }
    const survivorTotal = Number(survivor?.proposal?.total || 0);
    const duplicateTotal = Number(duplicate?.proposal?.total || 0);
    if (survivorTotal > 0 && duplicateTotal > 0 && Math.abs(survivorTotal - duplicateTotal) > 0.009) {
      blockers.push({ recordId: duplicate.id, reason: 'Both records contain different non-zero proposal totals.', survivorTotal, duplicateTotal });
    }
    if (sameLifecycleChain(survivor, duplicate, records)) {
      warnings.push(clean(duplicate.id, 120) + ' is already part of the same lifecycle chain; collapsing the pipeline is safer than merging this record.');
    }
  }

  return {
    survivorId,
    duplicateIds: duplicates.map((record) => clean(record?.id, 120)),
    fingerprint,
    blockers,
    warnings,
    canApply: blockers.length === 0 && warnings.length === 0,
    survivor: traceCrmRecordCreation(survivor),
    duplicates: duplicates.map(traceCrmRecordCreation),
    archiveRequired: true,
  };
}

export function coalesceRecord(survivor: RecordLike, duplicate: RecordLike) {
  const pick = (a: any, b: any) => {
    if (a == null || a === '' || Array.isArray(a) && !a.length) return b;
    return a;
  };
  const merged: RecordLike = structuredClone(survivor);
  merged.customer = { ...(duplicate.customer || {}), ...(survivor.customer || {}) };
  merged.inquiry = { ...(duplicate.inquiry || {}), ...(survivor.inquiry || {}) };
  merged.communications = { ...(duplicate.communications || {}), ...(survivor.communications || {}) };
  merged.security = pick(survivor.security, duplicate.security);
  merged.assignment = pick(survivor.assignment, duplicate.assignment);
  merged.quote = pick(survivor.quote, duplicate.quote);
  merged.quoteId = pick(survivor.quoteId, duplicate.quoteId);
  merged.packageId = pick(survivor.packageId, duplicate.packageId);
  merged.businessLine = pick(survivor.businessLine, duplicate.businessLine);
  merged.projectType = pick(survivor.projectType, duplicate.projectType);
  const survivorProposal = survivor?.proposal || null;
  const duplicateProposal = duplicate?.proposal || null;
  merged.proposal = survivorProposal && Number(survivorProposal?.total || 0) > 0
    ? structuredClone(survivorProposal)
    : duplicateProposal
      ? structuredClone(duplicateProposal)
      : survivorProposal;

  if (survivor?.booking || duplicate?.booking) {
    const sb = structuredClone(survivor?.booking || {});
    const db = structuredClone(duplicate?.booking || {});
    const sContract = sb?.contract || {};
    const dContract = db?.contract || {};
    const sSignWell = sContract?.signwell || {};
    const dSignWell = dContract?.signwell || {};
    const paymentRows = [...(Array.isArray(db?.payments) ? db.payments : []), ...(Array.isArray(sb?.payments) ? sb.payments : [])];
    const paymentMap = new Map<string, any>();
    for (const row of paymentRows) {
      const key = clean(row?.id || row?.paymentId || row?.txnId || JSON.stringify(row), 300);
      if (!paymentMap.has(key)) paymentMap.set(key, row);
    }
    merged.booking = {
      ...db,
      ...sb,
      payments: [...paymentMap.values()],
      contract: {
        ...dContract,
        ...sContract,
        signwell: {
          ...dSignWell,
          ...sSignWell,
          documentId: pick(sSignWell?.documentId, dSignWell?.documentId),
          signedPdfKey: pick(sSignWell?.signedPdfKey, dSignWell?.signedPdfKey),
          clientSigningUrl: pick(sSignWell?.clientSigningUrl, dSignWell?.clientSigningUrl),
          completedAt: pick(sSignWell?.completedAt, dSignWell?.completedAt),
          sentAt: pick(sSignWell?.sentAt, dSignWell?.sentAt),
          lastWebhookAt: pick(sSignWell?.lastWebhookAt, dSignWell?.lastWebhookAt),
        },
      },
    };
  }

  if (survivor?.accounting || duplicate?.accounting) {
    const sa = structuredClone(survivor?.accounting || {});
    const da = structuredClone(duplicate?.accounting || {});
    const sq = sa?.quickbooks || {};
    const dq = da?.quickbooks || {};
    const mergeRows = (left: any, right: any) => {
      const rows = [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])];
      const map = new Map<string, any>();
      for (const row of rows) {
        const key = clean(row?.id || row?.estimateId || row?.invoiceId || row?.paymentId || row?.docNumber || JSON.stringify(row), 300);
        if (!map.has(key)) map.set(key, row);
      }
      return [...map.values()];
    };
    merged.accounting = {
      ...da,
      ...sa,
      quickbooks: {
        ...dq,
        ...sq,
        customerId: pick(sq?.customerId, dq?.customerId),
        customerDisplayName: pick(sq?.customerDisplayName, dq?.customerDisplayName),
        estimateId: pick(sq?.estimateId, dq?.estimateId),
        estimateDocNumber: pick(sq?.estimateDocNumber, dq?.estimateDocNumber),
        estimates: mergeRows(sq?.estimates, dq?.estimates),
        invoices: mergeRows(sq?.invoices, dq?.invoices),
        payments: mergeRows(sq?.payments, dq?.payments),
      },
    };
  }

  merged.profitModel = pick(survivor.profitModel, duplicate.profitModel);
  merged.updatedAt = new Date().toISOString();
  merged.mergeHistory = [
    ...(Array.isArray(survivor?.mergeHistory) ? survivor.mergeHistory : []),
    ...(Array.isArray(duplicate?.mergeHistory) ? duplicate.mergeHistory : []),
    { fromRecordId: clean(duplicate?.id, 120), mergedAt: merged.updatedAt },
  ].slice(-100);
  return merged;
}
