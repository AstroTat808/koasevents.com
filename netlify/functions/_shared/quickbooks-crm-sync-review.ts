import type { Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import {
  configuredServiceItemId,
  getQuickBooksSettings,
  qboGet,
  qboQuery,
} from './quickbooks';

const QUERY_PAGE_SIZE = 1000;
const QUERY_MAX_PAGES = 10;
const PREVIEW_MAX_AGE_MS = 30 * 60 * 1000;
const MATCH_OVERRIDES_KEY = 'quickbooks/customer-match-overrides';
const PREVIEW_LAST_KEY = 'quickbooks/sync-preview-last';
const HISTORY_INDEX_KEY = 'quickbooks/manual-sync-history/index';

function salesStore(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-sales', consistency: 'strong' })
    : getDeployStore({ name: 'koa-sales' });
}

function integrationStore(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-integrations', consistency: 'strong' })
    : getDeployStore({ name: 'koa-integrations' });
}

function clean(value: unknown, max = 1200) {
  return String(value ?? '').trim().slice(0, max);
}

function isoDate(value: unknown) {
  const raw = clean(value, 80);
  if (!raw) return '';
  const parsed = new Date(raw.length === 10 ? raw + 'T12:00:00Z' : raw);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function money(value: unknown) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
}

export function normalizeQuickBooksMatchEmail(value: unknown) {
  return clean(value, 240).toLowerCase();
}

export function normalizeQuickBooksMatchName(value: unknown) {
  return clean(value, 240)
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+-\s+\d{4}-\d{2}-\d{2}\s*$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeDisplayName(value: unknown) {
  return clean(value, 240).toLowerCase().replace(/\s+/g, ' ');
}

function qboCustomerEmail(customer: any) {
  return clean(customer?.PrimaryEmailAddr?.Address, 240);
}

function qboCustomerPhone(customer: any) {
  return clean(customer?.PrimaryPhone?.FreeFormNumber || customer?.Mobile?.FreeFormNumber, 80);
}

function eventDateFromDisplayName(value: unknown) {
  const match = clean(value, 240).match(/\s+-\s+(\d{4}-\d{2}-\d{2})\s*$/);
  return match?.[1] || '';
}

function baseNameFromDisplayName(value: unknown) {
  return clean(value, 240).replace(/\s+-\s+\d{4}-\d{2}-\d{2}\s*$/, '').trim();
}

function expectedDisplayName(record: any) {
  const name = clean(record?.customer?.name, 180);
  const eventDate = isoDate(record?.customer?.eventDate);
  return clean(name + (eventDate ? ' - ' + eventDate : ''), 100);
}

function qboRecordIdHint(customer: any) {
  const notes = clean(customer?.Notes, 4000);
  const match = notes.match(/(?:Koa(?:’|')s Events CRM record|Koa CRM[:\s]+)\s*([A-Za-z0-9_.:-]{3,120})/i);
  return clean(match?.[1], 120);
}

function mapUnique<T>(items: T[], key: (item: T) => string) {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    if (!value) continue;
    const list = map.get(value) || [];
    list.push(item);
    map.set(value, list);
  }
  return map;
}

export type QuickBooksMatchOverride = {
  customerId: string;
  decision: 'match' | 'new';
  recordId: string;
  approvedAt: string;
  approvedBy: string;
  customerName?: string;
};

export type QuickBooksMatchIndexes = {
  recordsById: Map<string, any>;
  byQboCustomerId: Map<string, any>;
  exactDisplay: Map<string, any[]>;
  emailMap: Map<string, any[]>;
  normalizedNameMap: Map<string, any[]>;
};

export function buildQuickBooksMatchIndexes(records: any[]): QuickBooksMatchIndexes {
  const recordsById = new Map(records.map((record) => [String(record.id), record]));
  const byQboCustomerId = new Map<string, any>();
  for (const record of records) {
    const customerId = clean(record?.accounting?.quickbooks?.customerId, 100);
    if (customerId && !byQboCustomerId.has(customerId)) byQboCustomerId.set(customerId, record);
  }
  return {
    recordsById,
    byQboCustomerId,
    exactDisplay: mapUnique(records, (record) => normalizeDisplayName(expectedDisplayName(record))),
    emailMap: mapUnique(records, (record) => normalizeQuickBooksMatchEmail(record?.customer?.email)),
    normalizedNameMap: mapUnique(records, (record) => normalizeQuickBooksMatchName(record?.customer?.name)),
  };
}

export function addRecordToQuickBooksMatchIndexes(indexes: QuickBooksMatchIndexes, record: any) {
  const recordId = clean(record?.id, 120);
  if (recordId) indexes.recordsById.set(recordId, record);
  const customerId = clean(record?.accounting?.quickbooks?.customerId, 100);
  if (customerId && !indexes.byQboCustomerId.has(customerId)) indexes.byQboCustomerId.set(customerId, record);

  const add = (map: Map<string, any[]>, key: string) => {
    if (!key) return;
    const rows = map.get(key) || [];
    if (!rows.some((entry) => String(entry?.id) === recordId)) rows.push(record);
    map.set(key, rows);
  };
  add(indexes.exactDisplay, normalizeDisplayName(expectedDisplayName(record)));
  add(indexes.emailMap, normalizeQuickBooksMatchEmail(record?.customer?.email));
  add(indexes.normalizedNameMap, normalizeQuickBooksMatchName(record?.customer?.name));
}

function candidateView(record: any, reason = '') {
  return {
    recordId: clean(record?.id, 120),
    name: clean(record?.customer?.name, 180),
    email: clean(record?.customer?.email, 240),
    phone: clean(record?.customer?.phone, 80),
    eventDate: clean(record?.customer?.eventDate, 40),
    stage: clean(record?.stage || record?.kind, 80),
    currentQuickBooksCustomerId: clean(record?.accounting?.quickbooks?.customerId, 100),
    reason,
  };
}

export function resolveQuickBooksCustomerMatch(
  customer: any,
  indexes: QuickBooksMatchIndexes,
  overrides: Record<string, QuickBooksMatchOverride> = {},
) {
  const customerId = clean(customer?.Id, 100);
  const linked = indexes.byQboCustomerId.get(customerId);
  if (linked) {
    return {
      status: 'linked',
      reason: 'existing-qbo-link',
      record: linked,
      candidates: [candidateView(linked, 'Already linked to this QuickBooks customer')],
    };
  }

  const override = overrides[customerId];
  if (override?.decision === 'new') {
    return { status: 'approved_new', reason: 'staff-approved-new', record: null, candidates: [] };
  }
  if (override?.decision === 'match') {
    const approved = indexes.recordsById.get(clean(override.recordId, 120));
    if (approved) {
      return {
        status: 'approved_match',
        reason: 'staff-approved-match',
        record: approved,
        candidates: [candidateView(approved, 'Staff-approved match')],
      };
    }
  }

  const hintedId = qboRecordIdHint(customer);
  if (hintedId && indexes.recordsById.has(hintedId)) {
    const hinted = indexes.recordsById.get(hintedId);
    const hintedQboId = clean(hinted?.accounting?.quickbooks?.customerId, 100);
    if (hintedQboId && hintedQboId !== customerId) {
      return {
        status: 'ambiguous',
        reason: 'hinted-record-linked-elsewhere',
        record: null,
        candidates: [candidateView(hinted, 'QuickBooks notes point to this CRM record, but it is linked to another QuickBooks customer')],
      };
    }
    return {
      status: 'linked',
      reason: 'qbo-crm-id-hint',
      record: hinted,
      candidates: [candidateView(hinted, 'QuickBooks notes contain this CRM record ID')],
    };
  }

  const candidateMap = new Map<string, { record: any; reasons: string[] }>();
  const addCandidates = (rows: any[], reason: string) => {
    for (const record of rows) {
      const id = clean(record?.id, 120);
      if (!id) continue;
      const existing = candidateMap.get(id) || { record, reasons: [] };
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      candidateMap.set(id, existing);
    }
  };

  addCandidates(indexes.exactDisplay.get(normalizeDisplayName(customer?.DisplayName)) || [], 'Exact display name + event date');
  const email = normalizeQuickBooksMatchEmail(qboCustomerEmail(customer));
  if (email) addCandidates(indexes.emailMap.get(email) || [], 'Same email address');
  const normalizedName = normalizeQuickBooksMatchName(customer?.DisplayName);
  if (normalizedName) addCandidates(indexes.normalizedNameMap.get(normalizedName) || [], 'Same normalized customer name');

  const candidates = [...candidateMap.values()].map(({ record, reasons }) => candidateView(record, reasons.join(' · ')));
  if (candidates.length === 1) {
    const candidate = candidates[0];
    if (candidate.currentQuickBooksCustomerId && candidate.currentQuickBooksCustomerId !== customerId) {
      return { status:'ambiguous', reason:'candidate-linked-elsewhere', record:null, candidates };
    }
    const record = indexes.recordsById.get(candidate.recordId);
    return { status: 'auto_match', reason: candidate.reason, record, candidates };
  }
  if (candidates.length > 1) {
    return { status: 'ambiguous', reason: 'multiple-crm-candidates', record: null, candidates };
  }
  return { status: 'new', reason: 'no-crm-candidate', record: null, candidates: [] };
}

async function qboRows(context: Context, entity: 'Customer'|'Estimate'|'Invoice'|'Payment') {
  const rows: any[] = [];
  for (let page = 0; page < QUERY_MAX_PAGES; page += 1) {
    const start = page * QUERY_PAGE_SIZE + 1;
    const data: any = await qboQuery(context, `select * from ${entity} startposition ${start} maxresults ${QUERY_PAGE_SIZE}`);
    const batch = Array.isArray(data?.QueryResponse?.[entity]) ? data.QueryResponse[entity] : [];
    rows.push(...batch);
    if (batch.length < QUERY_PAGE_SIZE) break;
  }
  return rows;
}

function groupByCustomer(rows: any[]) {
  const map = new Map<string, any[]>();
  for (const row of rows) {
    const customerId = clean(row?.CustomerRef?.value, 100);
    if (!customerId) continue;
    const list = map.get(customerId) || [];
    list.push(row);
    map.set(customerId, list);
  }
  return map;
}

export async function getQuickBooksMatchOverrides(context: Context) {
  return ((await integrationStore(context).get(MATCH_OVERRIDES_KEY, { type: 'json' })) || {}) as Record<string, QuickBooksMatchOverride>;
}

export async function saveQuickBooksMatchOverride(
  context: Context,
  input: { customerId: string; decision: 'match'|'new'|'clear'; recordId?: string },
  actor = '',
) {
  const customerId = clean(input.customerId, 100);
  const decision = clean(input.decision, 20) as 'match'|'new'|'clear';
  if (!customerId) throw new Error('QuickBooks customer ID is required.');
  if (!['match','new','clear'].includes(decision)) throw new Error('Invalid matching decision.');

  const integrations = integrationStore(context);
  const overrides = await getQuickBooksMatchOverrides(context);
  if (decision === 'clear') {
    delete overrides[customerId];
    await integrations.setJSON(MATCH_OVERRIDES_KEY, overrides);
    return { customerId, cleared: true, override: null };
  }

  let qboCustomer: any = null;
  try {
    const data: any = await qboGet(context, 'customer', customerId);
    qboCustomer = data?.Customer || null;
  } catch {}
  if (!qboCustomer?.Id) throw new Error('QuickBooks customer could not be found.');

  let recordId = '';
  if (decision === 'match') {
    recordId = clean(input.recordId, 120);
    if (!recordId) throw new Error('Choose a CRM client to match.');
    const records = ((await salesStore(context).get('records/index', { type: 'json' })) || []) as any[];
    const record = records.find((entry) => String(entry?.id || '') === recordId);
    if (!record) throw new Error('The selected CRM client could not be found.');
    const linkedCustomerId = clean(record?.accounting?.quickbooks?.customerId, 100);
    if (linkedCustomerId && linkedCustomerId !== customerId) {
      throw new Error('That CRM client is already linked to QuickBooks customer #' + linkedCustomerId + '.');
    }
    const alreadyLinkedElsewhere = records.find((entry) =>
      String(entry?.id || '') !== recordId &&
      clean(entry?.accounting?.quickbooks?.customerId, 100) === customerId
    );
    if (alreadyLinkedElsewhere) {
      throw new Error('This QuickBooks customer is already linked to CRM record ' + clean(alreadyLinkedElsewhere.id, 120) + '.');
    }
  }

  const override: QuickBooksMatchOverride = {
    customerId,
    decision,
    recordId,
    approvedAt: new Date().toISOString(),
    approvedBy: clean(actor, 180),
    customerName: clean(qboCustomer.DisplayName, 240),
  };
  overrides[customerId] = override;
  await integrations.setJSON(MATCH_OVERRIDES_KEY, overrides);
  return { customerId, cleared: false, override };
}

function customerFinancialSummary(customerId: string, estimateGroups: Map<string, any[]>, invoiceGroups: Map<string, any[]>, paymentGroups: Map<string, any[]>) {
  const estimates = estimateGroups.get(customerId) || [];
  const invoices = invoiceGroups.get(customerId) || [];
  const payments = paymentGroups.get(customerId) || [];
  return {
    estimates: estimates.length,
    invoices: invoices.length,
    payments: payments.length,
    estimateTotal: money(estimates.reduce((sum, row) => sum + Number(row?.TotalAmt || 0), 0)),
    invoiceTotal: money(invoices.reduce((sum, row) => sum + Number(row?.TotalAmt || 0), 0)),
    openBalance: money(invoices.reduce((sum, row) => sum + Math.max(0, Number(row?.Balance || 0)), 0)),
    paymentTotal: money(payments.reduce((sum, row) => sum + Number(row?.TotalAmt || 0), 0)),
    estimateDocs: estimates.map((row) => ({
      id: clean(row?.Id, 100),
      docNumber: clean(row?.DocNumber, 100),
      txnDate: isoDate(row?.TxnDate),
      total: money(row?.TotalAmt),
      emailStatus: clean(row?.EmailStatus, 80),
    })),
    invoiceDocs: invoices.map((row) => ({
      id: clean(row?.Id, 100),
      docNumber: clean(row?.DocNumber, 100),
      txnDate: isoDate(row?.TxnDate),
      dueDate: isoDate(row?.DueDate),
      total: money(row?.TotalAmt),
      balance: money(row?.Balance),
      emailStatus: clean(row?.EmailStatus, 80),
    })),
    paymentDocs: payments.map((row) => ({
      id: clean(row?.Id, 100),
      txnDate: isoDate(row?.TxnDate),
      total: money(row?.TotalAmt),
    })),
  };
}

function previewRecordSnapshot(record: any) {
  if (!record) return null;
  const qbo = record?.accounting?.quickbooks || {};
  return {
    recordId: clean(record?.id, 120),
    stage: clean(record?.stage || record?.kind, 80),
    status: clean(record?.status, 80),
    customer: {
      name: clean(record?.customer?.name, 180),
      email: clean(record?.customer?.email, 240),
      phone: clean(record?.customer?.phone, 80),
      eventDate: clean(record?.customer?.eventDate, 40),
    },
    proposal: record?.proposal ? {
      status: clean(record.proposal.status, 80),
      total: money(record.proposal.total),
    } : null,
    quickbooks: {
      customerId: clean(qbo.customerId, 100),
      estimateId: clean(qbo.estimateId, 100),
      invoiceCount: Array.isArray(qbo.invoices) ? qbo.invoices.length : 0,
      paymentCount: Array.isArray(qbo.payments) ? qbo.payments.length : 0,
      totalInvoiced: money(qbo.totalInvoiced),
      totalPaid: money(qbo.totalPaid),
      balanceDue: money(qbo.balanceDue),
    },
  };
}

function projectedRecordSnapshot(record: any, customer: any, financial: any) {
  const origin = clean(record?.accounting?.quickbooks?.origin, 40) === 'quickbooks' || clean(record?.source, 80) === 'quickbooks-import';
  const hasFinancial = Number(financial.estimates || 0) + Number(financial.invoices || 0) + Number(financial.payments || 0) > 0;
  const base = previewRecordSnapshot(record) || {
    recordId: '',
    stage: hasFinancial ? 'proposal' : 'lead',
    status: hasFinancial ? 'proposal' : 'lead',
    customer: { name:'', email:'', phone:'', eventDate:'' },
    proposal: null,
    quickbooks: {},
  };
  const estimateDocs = Array.isArray(financial.estimateDocs) ? financial.estimateDocs : [];
  const primaryEstimate = estimateDocs[0] || null;
  const totalPaid = money(Number(financial.invoiceTotal || 0) - Number(financial.openBalance || 0));
  return {
    ...base,
    stage: origin ? (hasFinancial ? 'proposal' : 'lead') : base.stage,
    status: origin ? (hasFinancial ? 'proposal' : 'lead') : base.status,
    customer: origin ? {
      name: baseNameFromDisplayName(customer?.DisplayName) || clean(customer?.DisplayName, 180),
      email: qboCustomerEmail(customer),
      phone: qboCustomerPhone(customer),
      eventDate: eventDateFromDisplayName(customer?.DisplayName),
    } : base.customer,
    proposal: origin && hasFinancial ? {
      status: Number(financial.invoices || 0) + Number(financial.payments || 0) > 0 ? 'accepted' : 'sent',
      total: money(primaryEstimate?.total || financial.invoiceTotal || 0),
    } : base.proposal,
    quickbooks: {
      customerId: clean(customer?.Id, 100),
      estimateId: clean(primaryEstimate?.id, 100),
      invoiceCount: Number(financial.invoices || 0),
      paymentCount: Number(financial.payments || 0),
      totalInvoiced: money(financial.invoiceTotal),
      totalPaid,
      balanceDue: money(financial.openBalance),
    },
  };
}

function outboundCustomerChanges(record: any, customer: any) {
  const changes: any[] = [];
  const desiredDisplay = expectedDisplayName(record) || clean(record?.id, 100);
  const desiredEmail = clean(record?.customer?.email, 240);
  const desiredPhone = clean(record?.customer?.phone, 80);
  if (!customer) {
    changes.push({ field:'customer', before:'Not in QuickBooks', after:desiredDisplay, action:'create' });
    return changes;
  }
  const compare = (field: string, before: unknown, after: unknown) => {
    const a = clean(before, 500), b = clean(after, 500);
    if (b && a !== b) changes.push({ field, before:a || '—', after:b, action:'update' });
  };
  compare('Display name', customer?.DisplayName, desiredDisplay);
  compare('Email', customer?.PrimaryEmailAddr?.Address, desiredEmail);
  compare('Phone', customer?.PrimaryPhone?.FreeFormNumber, desiredPhone);
  return changes;
}

function outboundEstimatePlan(record: any, estimate: any, serviceItemId: string) {
  const proposal = record?.proposal;
  if (!proposal || money(proposal.total) <= 0) return null;
  const status = clean(proposal.status, 80).toLowerCase();
  const estimateId = clean(record?.accounting?.quickbooks?.estimateId, 100);
  if (!estimateId && !['sent','accepted','booked'].includes(status)) return null;
  if (!serviceItemId) {
    return { action:'blocked', reason:'QuickBooks service item is not configured.', before:null, after:null };
  }
  const after = {
    total: money(proposal.total),
    expirationDate: isoDate(proposal.expirationDate),
    email: clean(record?.customer?.email, 240),
  };
  if (!estimate) return { action:'create', reason:'Issued CRM proposal has no QuickBooks estimate.', before:null, after };
  const before = {
    total: money(estimate?.TotalAmt),
    expirationDate: isoDate(estimate?.ExpirationDate),
    email: clean(estimate?.BillEmail?.Address, 240),
  };
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  return { action: changed ? 'update' : 'no_change', reason: changed ? 'CRM proposal differs from QuickBooks estimate.' : 'Estimate already matches core CRM fields.', before, after };
}

export async function buildQuickBooksCrmSyncPreview(context: Context, actor = '') {
  const generatedAt = new Date().toISOString();
  const store = salesStore(context);
  const records = (((await store.get('records/index', { type: 'json' })) || []) as any[]).filter(Boolean).slice(0, 1500);
  const [customers, estimates, invoices, payments, overrides, settings] = await Promise.all([
    qboRows(context, 'Customer'),
    qboRows(context, 'Estimate'),
    qboRows(context, 'Invoice'),
    qboRows(context, 'Payment'),
    getQuickBooksMatchOverrides(context),
    getQuickBooksSettings(context),
  ]);

  const indexes = buildQuickBooksMatchIndexes(records);
  const estimateGroups = groupByCustomer(estimates);
  const invoiceGroups = groupByCustomer(invoices);
  const paymentGroups = groupByCustomer(payments);
  const customerById = new Map(customers.filter((row) => row?.Id).map((row) => [String(row.Id), row]));
  const estimateById = new Map(estimates.filter((row) => row?.Id).map((row) => [String(row.Id), row]));

  const customerPlans = customers.map((customer) => {
    const customerId = clean(customer?.Id, 100);
    const match = resolveQuickBooksCustomerMatch(customer, indexes, overrides);
    const financial = customerFinancialSummary(customerId, estimateGroups, invoiceGroups, paymentGroups);
    const action = match.status === 'ambiguous'
      ? 'needs_decision'
      : ['new','approved_new'].includes(match.status)
        ? 'import_new'
        : 'refresh_match';
    const before = match.record ? previewRecordSnapshot(match.record) : null;
    const after = match.status === 'ambiguous' ? null : projectedRecordSnapshot(match.record, customer, financial);
    return {
      customerId,
      qbo: {
        name: clean(customer?.DisplayName, 240),
        email: qboCustomerEmail(customer),
        phone: qboCustomerPhone(customer),
        eventDate: eventDateFromDisplayName(customer?.DisplayName),
      },
      decision: match.status,
      reason: match.reason,
      matchedRecordId: clean(match.record?.id, 120),
      candidates: match.candidates,
      financial,
      before,
      after,
      action,
    };
  });

  const serviceItemId = clean(settings?.serviceItemId || configuredServiceItemId(), 100);
  const outbound = records
    .filter((record) => clean(record?.accounting?.quickbooks?.origin, 40) !== 'quickbooks' && clean(record?.source, 80) !== 'quickbooks-import')
    .filter((record) => Boolean(record?.proposal) || Boolean(record?.accounting?.quickbooks?.customerId))
    .map((record) => {
      const customerId = clean(record?.accounting?.quickbooks?.customerId, 100);
      const customer = customerId ? customerById.get(customerId) : null;
      const estimateId = clean(record?.accounting?.quickbooks?.estimateId, 100);
      const estimate = estimateId ? estimateById.get(estimateId) : null;
      const customerChanges = outboundCustomerChanges(record, customer);
      const estimatePlan = outboundEstimatePlan(record, estimate, serviceItemId);
      const actions = [
        ...customerChanges.map((change) => ({ type:'customer', ...change })),
        ...(estimatePlan && estimatePlan.action !== 'no_change' ? [{ type:'estimate', ...estimatePlan }] : []),
      ];
      return {
        recordId: clean(record?.id, 120),
        name: clean(record?.customer?.name, 180),
        customerId,
        estimateId,
        actions,
      };
    })
    .filter((row) => row.actions.length > 0);

  const summary = {
    qboCustomers: customers.length,
    qboEstimates: estimates.length,
    qboInvoices: invoices.length,
    qboPayments: payments.length,
    linked: customerPlans.filter((row) => row.decision === 'linked').length,
    matched: customerPlans.filter((row) => ['auto_match','approved_match'].includes(row.decision)).length,
    newImports: customerPlans.filter((row) => ['new','approved_new'].includes(row.decision)).length,
    needsDecision: customerPlans.filter((row) => row.decision === 'ambiguous').length,
    crmOutboundRecords: outbound.length,
    crmOutboundActions: outbound.reduce((sum, row) => sum + row.actions.length, 0),
  };

  const previewId = 'QBPREVIEW-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const preview = {
    previewId,
    generatedAt,
    actor: clean(actor, 180),
    expiresAt: new Date(Date.now() + PREVIEW_MAX_AGE_MS).toISOString(),
    summary,
    customerPlans,
    outbound,
  };
  await integrationStore(context).setJSON(PREVIEW_LAST_KEY, preview);
  return preview;
}

export async function getLastQuickBooksCrmSyncPreview(context: Context) {
  return await integrationStore(context).get(PREVIEW_LAST_KEY, { type:'json' }) as any;
}

export async function validateQuickBooksCrmSyncPreview(context: Context, previewId: string) {
  const preview = await getLastQuickBooksCrmSyncPreview(context);
  if (!preview?.previewId || clean(preview.previewId, 120) !== clean(previewId, 120)) {
    throw new Error('Run a fresh QuickBooks sync preview before applying changes.');
  }
  const generatedAt = Date.parse(String(preview.generatedAt || ''));
  if (!generatedAt || Date.now() - generatedAt > PREVIEW_MAX_AGE_MS) {
    throw new Error('The QuickBooks sync preview is older than 30 minutes. Run Preview Sync again.');
  }
  if (Number(preview?.summary?.needsDecision || 0) > 0) {
    throw new Error('Resolve all ambiguous customer matches and run Preview Sync again before applying changes.');
  }
  return preview;
}

export async function recordQuickBooksCrmSyncHistory(context: Context, result: any) {
  const store = integrationStore(context);
  const syncId = clean(result?.syncId, 120) || ('QBSYNC-' + Date.now().toString(36).toUpperCase());
  const detail = { ...result, syncId };
  await store.setJSON('quickbooks/manual-sync-history/' + syncId, detail);

  let current = ((await store.get(HISTORY_INDEX_KEY, { type:'json' })) || []) as any[];
  if (!current.length) {
    const legacy = ((await store.get('quickbooks/manual-sync-history', { type:'json' })) || []) as any[];
    current = legacy.map((row: any, index: number) => ({
      syncId: clean(row?.syncId, 120) || ('LEGACY-' + index + '-' + clean(row?.completedAt, 40).replace(/[^0-9]/g, '')),
      status: clean(row?.status, 40),
      startedAt: clean(row?.startedAt, 80),
      completedAt: clean(row?.completedAt, 80),
      actor: clean(row?.actor, 180),
      previewId: clean(row?.previewId, 120),
      qbo: row?.qbo || {},
      crm: row?.crm || {},
      pushed: row?.pushed || {},
      conflictCount: Array.isArray(row?.conflicts) ? row.conflicts.length : 0,
      warningCount: Array.isArray(row?.warnings) ? row.warnings.length : 0,
      changeCount: Array.isArray(row?.changes) ? row.changes.length : 0,
      legacy: true,
      legacyIndex: index,
    }));
  }
  const summary = {
    syncId,
    status: clean(detail.status, 40),
    startedAt: clean(detail.startedAt, 80),
    completedAt: clean(detail.completedAt, 80),
    actor: clean(detail.actor, 180),
    previewId: clean(detail.previewId, 120),
    qbo: detail.qbo || {},
    crm: detail.crm || {},
    pushed: detail.pushed || {},
    conflictCount: Array.isArray(detail.conflicts) ? detail.conflicts.length : 0,
    warningCount: Array.isArray(detail.warnings) ? detail.warnings.length : 0,
    changeCount: Array.isArray(detail.changes) ? detail.changes.length : 0,
    clients: [...new Set((Array.isArray(detail.changes) ? detail.changes : []).map((change: any) => clean(change?.clientName, 180)).filter(Boolean))].slice(0, 250),
  };
  await store.setJSON(HISTORY_INDEX_KEY, [summary, ...current.filter((row) => row?.syncId !== syncId)].slice(0, 5000));
  return detail;
}

export async function getQuickBooksCrmSyncHistory(context: Context, limit = 100) {
  const store = integrationStore(context);
  const index = ((await store.get(HISTORY_INDEX_KEY, { type:'json' })) || []) as any[];
  if (index.length) return index.slice(0, Math.max(1, Math.min(5000, Number(limit) || 100)));

  // Backward compatibility for runs created before the dedicated history index.
  const legacy = ((await store.get('quickbooks/manual-sync-history', { type:'json' })) || []) as any[];
  return legacy.slice(0, Math.max(1, Math.min(5000, Number(limit) || 100))).map((row, index) => ({
    syncId: clean(row?.syncId, 120) || 'LEGACY-' + index,
    status: clean(row?.status, 40),
    startedAt: clean(row?.startedAt, 80),
    completedAt: clean(row?.completedAt, 80),
    actor: clean(row?.actor, 180),
    qbo: row?.qbo || {},
    crm: row?.crm || {},
    pushed: row?.pushed || {},
    conflictCount: Array.isArray(row?.conflicts) ? row.conflicts.length : 0,
    warningCount: Array.isArray(row?.warnings) ? row.warnings.length : 0,
    changeCount: Array.isArray(row?.changes) ? row.changes.length : 0,
    legacy: true,
  }));
}

export async function getQuickBooksCrmSyncHistoryDetail(context: Context, syncId: string) {
  const id = clean(syncId, 120);
  if (!id) return null;
  const store = integrationStore(context);
  const detail = await store.get('quickbooks/manual-sync-history/' + id, { type:'json' }) as any;
  if (detail) return detail;

  const index = ((await store.get(HISTORY_INDEX_KEY, { type:'json' })) || []) as any[];
  const summary = index.find((row) => clean(row?.syncId, 120) === id);
  if (summary?.legacy) {
    const legacy = ((await store.get('quickbooks/manual-sync-history', { type:'json' })) || []) as any[];
    const legacyRow = legacy[Number(summary.legacyIndex)];
    if (legacyRow) {
      return {
        ...legacyRow,
        syncId: id,
        legacy: true,
        changes: Array.isArray(legacyRow?.changes) ? legacyRow.changes : [],
        legacyNote: 'This sync predates before/after audit capture. Only metadata that was recorded at the time is available.',
      };
    }
  }
  return null;
}
