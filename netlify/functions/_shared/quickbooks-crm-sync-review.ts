// Release marker: Configurable QuickBooks suggested exclusions and guided review.
import type { Context } from '@netlify/functions';
import { resolveTenant } from './tenant';
import { tenantStoreFor } from './tenant-storage';
import {
  configuredServiceItemId,
  getQuickBooksSettings,
  qboGet,
  qboQuery,
} from './quickbooks';

const QUERY_PAGE_SIZE = 1000;
const QUERY_MAX_PAGES = 10;
const CRM_RECORD_LIMIT = 1500;
const PREVIEW_MAX_AGE_MS = 30 * 60 * 1000;
const MATCH_OVERRIDES_KEY = 'quickbooks/customer-match-overrides';
const PREVIEW_LAST_KEY = 'quickbooks/sync-preview-last';
const HISTORY_INDEX_KEY = 'quickbooks/manual-sync-history/index';
const SUGGESTED_EXCLUSION_RULES_KEY = 'quickbooks/suggested-exclusion-rules';
const SUGGESTED_EXCLUSION_DISMISSALS_KEY = 'quickbooks/suggested-exclusion-dismissals';

function salesStore(context: Context) {
  return tenantStoreFor(context, resolveTenant(), 'sales');
}

function integrationStore(context: Context) {
  return tenantStoreFor(context, resolveTenant(), 'integrations');
}

function clean(value: unknown, max = 1200) {
  return String(value ?? '').trim().slice(0, max);
}

export const QUICKBOOKS_EXCLUSION_REASONS = [
  { code:'quickbooks_test_customer', label:'QuickBooks test customer' },
  { code:'square_system_customer', label:'Square system customer' },
  { code:'system_customer', label:'System / integration customer' },
  { code:'vendor_non_client', label:'Vendor / non-client' },
  { code:'duplicate', label:'Duplicate' },
  { code:'other', label:'Other' },
] as const;

export type QuickBooksExclusionReasonCode = typeof QUICKBOOKS_EXCLUSION_REASONS[number]['code'];

function normalizeQuickBooksExclusionReasonCode(value: unknown): QuickBooksExclusionReasonCode | '' {
  const code = clean(value, 60) as QuickBooksExclusionReasonCode;
  return QUICKBOOKS_EXCLUSION_REASONS.some((row) => row.code === code) ? code : '';
}

function quickBooksExclusionReasonLabel(value: unknown) {
  const code = normalizeQuickBooksExclusionReasonCode(value);
  return QUICKBOOKS_EXCLUSION_REASONS.find((row) => row.code === code)?.label || 'Other';
}

function inferredStoredExclusionReasonCode(override: any): QuickBooksExclusionReasonCode {
  const explicit = normalizeQuickBooksExclusionReasonCode(override?.exclusionReasonCode);
  if (explicit) return explicit;
  const name = normalizeQuickBooksMatchName(override?.customerName);
  if (name === 'square customer') return 'square_system_customer';
  if (
    ['sample customer','test customer','quickbooks test customer','qbo test customer'].includes(name) ||
    /(?:^|\s)(?:qbo|quickbooks|sandbox|smoke)\s+test(?:\s|$)/.test(name) ||
    /(?:^|\s)test\s+customer(?:\s|$)/.test(name)
  ) return 'quickbooks_test_customer';
  const reason = clean(override?.exclusionReason, 500).toLowerCase();
  if (reason.includes('vendor') || reason.includes('non-client') || reason.includes('non client')) return 'vendor_non_client';
  if (reason.includes('system') || reason.includes('integration')) return 'system_customer';
  if (reason.includes('duplicate')) return 'duplicate';
  return 'other';
}

export type QuickBooksSuggestedExclusionRule = {
  id: string;
  enabled: boolean;
  field: 'name' | 'notes';
  operator: 'exact' | 'contains';
  value: string;
  reasonCode: QuickBooksExclusionReasonCode;
};

const DEFAULT_QUICKBOOKS_SUGGESTED_EXCLUSION_RULES: QuickBooksSuggestedExclusionRule[] = [
  { id:'default-square-customer', enabled:true, field:'name', operator:'exact', value:'Square Customer', reasonCode:'square_system_customer' },
  { id:'default-sample-customer', enabled:true, field:'name', operator:'exact', value:'Sample Customer', reasonCode:'quickbooks_test_customer' },
  { id:'default-test-customer', enabled:true, field:'name', operator:'exact', value:'Test Customer', reasonCode:'quickbooks_test_customer' },
  { id:'default-quickbooks-test-customer', enabled:true, field:'name', operator:'exact', value:'QuickBooks Test Customer', reasonCode:'quickbooks_test_customer' },
  { id:'default-qbo-test-customer', enabled:true, field:'name', operator:'exact', value:'QBO Test Customer', reasonCode:'quickbooks_test_customer' },
  { id:'default-quickbooks-sample-customer', enabled:true, field:'name', operator:'exact', value:'QuickBooks Sample Customer', reasonCode:'quickbooks_test_customer' },
  { id:'default-name-test-customer', enabled:true, field:'name', operator:'contains', value:'Test Customer', reasonCode:'quickbooks_test_customer' },
  { id:'default-name-sample-customer', enabled:true, field:'name', operator:'contains', value:'Sample Customer', reasonCode:'quickbooks_test_customer' },
  { id:'default-name-quickbooks-test', enabled:true, field:'name', operator:'contains', value:'QuickBooks Test', reasonCode:'quickbooks_test_customer' },
  { id:'default-name-qbo-test', enabled:true, field:'name', operator:'contains', value:'QBO Test', reasonCode:'quickbooks_test_customer' },
  { id:'default-name-sandbox-test', enabled:true, field:'name', operator:'contains', value:'Sandbox Test', reasonCode:'quickbooks_test_customer' },
  { id:'default-name-smoke-test', enabled:true, field:'name', operator:'contains', value:'Smoke Test', reasonCode:'quickbooks_test_customer' },
  { id:'default-notes-quickbooks-test', enabled:true, field:'notes', operator:'contains', value:'QuickBooks Test', reasonCode:'quickbooks_test_customer' },
  { id:'default-notes-qbo-test', enabled:true, field:'notes', operator:'contains', value:'QBO Test', reasonCode:'quickbooks_test_customer' },
  { id:'default-notes-sandbox-test', enabled:true, field:'notes', operator:'contains', value:'Sandbox Test', reasonCode:'quickbooks_test_customer' },
  { id:'default-notes-smoke-test', enabled:true, field:'notes', operator:'contains', value:'Smoke Test', reasonCode:'quickbooks_test_customer' },
];

function normalizeSuggestedRuleValue(value: unknown) {
  return normalizeQuickBooksMatchName(clean(value, 160));
}

function normalizeSuggestedExclusionRule(input: any, index = 0): QuickBooksSuggestedExclusionRule | null {
  const field = clean(input?.field, 20) as 'name'|'notes';
  const operator = clean(input?.operator, 20) as 'exact'|'contains';
  const value = clean(input?.value, 160);
  const reasonCode = normalizeQuickBooksExclusionReasonCode(input?.reasonCode);
  if (!['name','notes'].includes(field) || !['exact','contains'].includes(operator) || !value || !reasonCode) return null;
  const rawId = clean(input?.id, 100).replace(/[^A-Za-z0-9_.:-]/g,'-').replace(/-+/g,'-');
  return {
    id:rawId || ('custom-' + Date.now().toString(36) + '-' + String(index + 1)),
    enabled:input?.enabled !== false,
    field,
    operator,
    value,
    reasonCode,
  };
}

function suggestedExclusionRuleSignature(rule: QuickBooksSuggestedExclusionRule) {
  return [
    clean(rule.id,100),
    rule.field,
    rule.operator,
    normalizeSuggestedRuleValue(rule.value),
    rule.reasonCode,
  ].join('|');
}

function defaultSuggestedExclusionRules() {
  return DEFAULT_QUICKBOOKS_SUGGESTED_EXCLUSION_RULES.map((rule) => ({ ...rule }));
}

export async function getQuickBooksSuggestedExclusionRules(context: Context) {
  const stored = await integrationStore(context).get(SUGGESTED_EXCLUSION_RULES_KEY, { type:'json' }) as any;
  if (!Array.isArray(stored)) return defaultSuggestedExclusionRules();
  return stored
    .slice(0,100)
    .map((rule: any, index: number) => normalizeSuggestedExclusionRule(rule,index))
    .filter(Boolean) as QuickBooksSuggestedExclusionRule[];
}

export async function saveQuickBooksSuggestedExclusionRules(context: Context, input: any[]) {
  const source = Array.isArray(input) ? input.slice(0,100) : [];
  const rules = source
    .map((rule,index) => normalizeSuggestedExclusionRule(rule,index))
    .filter(Boolean) as QuickBooksSuggestedExclusionRule[];
  if (rules.length !== source.length) throw new Error('Every suggested-exclusion rule needs a match field, condition, value and exclusion classification.');

  const seenIds = new Set<string>();
  for (const rule of rules) {
    if (seenIds.has(rule.id)) throw new Error('Suggested-exclusion rule IDs must be unique.');
    seenIds.add(rule.id);
  }

  const store = integrationStore(context);
  await store.setJSON(SUGGESTED_EXCLUSION_RULES_KEY, rules);
  // A rule edit changes classification intent. Re-review previously dismissed suggestions against the new rule set.
  await store.setJSON(SUGGESTED_EXCLUSION_DISMISSALS_KEY, {});
  return rules;
}

export async function resetQuickBooksSuggestedExclusionRules(context: Context) {
  const store = integrationStore(context);
  await store.delete(SUGGESTED_EXCLUSION_RULES_KEY);
  await store.setJSON(SUGGESTED_EXCLUSION_DISMISSALS_KEY, {});
  return defaultSuggestedExclusionRules();
}

export async function getQuickBooksSuggestedExclusionDismissals(context: Context) {
  return ((await integrationStore(context).get(SUGGESTED_EXCLUSION_DISMISSALS_KEY, { type:'json' })) || {}) as Record<string, Record<string, any>>;
}

export async function getQuickBooksSuggestedExclusionDismissalCount(context: Context) {
  const dismissals = await getQuickBooksSuggestedExclusionDismissals(context);
  return Object.values(dismissals).reduce((sum, rows) => sum + Object.keys(rows || {}).length, 0);
}

export async function clearQuickBooksSuggestedExclusionDismissals(context: Context) {
  await integrationStore(context).setJSON(SUGGESTED_EXCLUSION_DISMISSALS_KEY, {});
  return { cleared:true };
}

function ruleMatchesQuickBooksCustomer(customer: any, rule: QuickBooksSuggestedExclusionRule) {
  if (!rule.enabled) return false;
  const raw = rule.field === 'name'
    ? (baseNameFromDisplayName(customer?.DisplayName) || clean(customer?.DisplayName,240))
    : clean(customer?.Notes,4000);
  const source = normalizeSuggestedRuleValue(raw);
  const target = normalizeSuggestedRuleValue(rule.value);
  if (!source || !target) return false;
  if (rule.operator === 'exact') return source === target;
  return (' ' + source + ' ').includes(' ' + target + ' ');
}

function suggestedQuickBooksExclusion(
  customer: any,
  rules: QuickBooksSuggestedExclusionRule[],
  dismissals: Record<string, Record<string, any>> = {},
) {
  const customerId = clean(customer?.Id,100);
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!ruleMatchesQuickBooksCustomer(customer,rule)) continue;
    const signature = suggestedExclusionRuleSignature(rule);
    if (customerId && dismissals?.[customerId]?.[signature]) continue;
    const fieldLabel = rule.field === 'name' ? 'customer name' : 'QuickBooks notes';
    const operatorLabel = rule.operator === 'exact' ? 'exactly matched' : 'contained';
    return {
      code:rule.reasonCode,
      label:quickBooksExclusionReasonLabel(rule.reasonCode),
      confidence:'high',
      reason:'Configured rule "' + clean(rule.value,160) + '" ' + operatorLabel + ' the ' + fieldLabel + '.',
      evidence:[
        'configured_rule:' + clean(rule.id,100),
        rule.field + ':' + rule.operator + ':' + normalizeSuggestedRuleValue(rule.value),
      ],
      ruleId:clean(rule.id,100),
      ruleField:rule.field,
      ruleOperator:rule.operator,
      ruleValue:clean(rule.value,160),
      ruleSignature:signature,
      configurable:true,
      requiresApproval:true,
      autoApplied:false,
    };
  }
  return null;
}

export async function dismissQuickBooksSuggestedExclusion(
  context: Context,
  input: { previewId:string; customerId:string; ruleSignature?:string },
  actor = '',
) {
  const previewId = clean(input.previewId,120);
  const customerId = clean(input.customerId,100);
  if (!previewId || !customerId) throw new Error('Preview Sync and QuickBooks customer are required.');

  const preview = await getLastQuickBooksCrmSyncPreview(context);
  if (!preview?.previewId || clean(preview.previewId,120) !== previewId) {
    throw new Error('That Preview Sync is no longer current. Run Preview Sync again.');
  }
  const generatedAt = Date.parse(String(preview.generatedAt || ''));
  if (!generatedAt || Date.now() - generatedAt > PREVIEW_MAX_AGE_MS) {
    throw new Error('The Preview Sync is older than 30 minutes. Run Preview Sync again.');
  }
  const plan = (Array.isArray(preview.customerPlans) ? preview.customerPlans : []).find((row: any) => clean(row?.customerId,100) === customerId);
  const suggestion = plan?.suggestedExclusion;
  if (!suggestion?.ruleSignature) throw new Error('That customer no longer has a suggested exclusion.');
  const requestedSignature = clean(input.ruleSignature,500);
  if (requestedSignature && requestedSignature !== clean(suggestion.ruleSignature,500)) {
    throw new Error('The suggested-exclusion rule changed. Run Preview Sync again before reviewing it.');
  }

  const store = integrationStore(context);
  const dismissals = await getQuickBooksSuggestedExclusionDismissals(context);
  dismissals[customerId] ||= {};
  dismissals[customerId][clean(suggestion.ruleSignature,500)] = {
    customerId,
    customerName:clean(plan?.qbo?.name,240),
    ruleId:clean(suggestion.ruleId,100),
    ruleSignature:clean(suggestion.ruleSignature,500),
    ruleValue:clean(suggestion.ruleValue,160),
    reasonCode:normalizeQuickBooksExclusionReasonCode(suggestion.code) || 'other',
    dismissedAt:new Date().toISOString(),
    dismissedBy:clean(actor,180),
  };
  await store.setJSON(SUGGESTED_EXCLUSION_DISMISSALS_KEY,dismissals);
  return { customerId, dismissed:true, dismissal:dismissals[customerId][clean(suggestion.ruleSignature,500)] };
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

function jsonClone<T = any>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function sameJson(a: unknown, b: unknown) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
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

export function normalizeQuickBooksMatchPhone(value: unknown) {
  const digits = clean(value, 100).replace(/\D/g, '');
  if (digits.length < 7) return '';
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function normalizedNameTokens(value: unknown) {
  const stop = new Set(['and','the','event','events','wedding','weddings']);
  return normalizeQuickBooksMatchName(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !stop.has(token));
}

function normalizedNameSignature(value: unknown) {
  return [...new Set(normalizedNameTokens(value))].sort().join(' ');
}

function normalizedNameSimilarity(a: unknown, b: unknown) {
  const left = new Set(normalizedNameTokens(a));
  const right = new Set(normalizedNameTokens(b));
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
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
  decision: 'match' | 'new' | 'exclude';
  recordId: string;
  approvedAt: string;
  approvedBy: string;
  customerName?: string;
  approvalMode?: 'single' | 'bulk';
  exclusionReasonCode?: QuickBooksExclusionReasonCode;
  exclusionReasonLabel?: string;
  exclusionReason?: string;
};

export type QuickBooksCustomerMatchEvidence = {
  estimateIds: string[];
  invoiceIds: string[];
  paymentIds: string[];
  transactionTotals: number[];
  estimates: Array<{ id:string; docNumber:string; txnDate:string; total:number }>;
  invoices: Array<{ id:string; docNumber:string; txnDate:string; dueDate:string; total:number; balance:number }>;
  payments: Array<{ id:string; txnDate:string; total:number }>;
};

export type QuickBooksMatchIndexes = {
  records: any[];
  recordsById: Map<string, any>;
  byQboCustomerId: Map<string, any>;
  exactDisplay: Map<string, any[]>;
  emailMap: Map<string, any[]>;
  phoneMap: Map<string, any[]>;
  eventDateMap: Map<string, any[]>;
  normalizedNameMap: Map<string, any[]>;
  normalizedNameSignatureMap: Map<string, any[]>;
  transactionMap: Map<string, any[]>;
};

function quickBooksTransactionKeysFromRecord(record: any) {
  const qbo = record?.accounting?.quickbooks || {};
  const keys: string[] = [];
  const add = (kind: string, value: unknown) => {
    const id = clean(value, 120);
    if (id) keys.push(kind + ':' + id);
  };
  add('estimate', qbo.estimateId);
  for (const row of Array.isArray(qbo.estimates) ? qbo.estimates : []) {
    add('estimate', row?.estimateId || row?.id);
    add('estimate-doc', row?.docNumber);
  }
  for (const row of Array.isArray(qbo.invoices) ? qbo.invoices : []) {
    add('invoice', row?.invoiceId || row?.id);
    add('invoice-doc', row?.docNumber);
  }
  for (const row of Array.isArray(qbo.payments) ? qbo.payments : []) add('payment', row?.paymentId || row?.id);
  return [...new Set(keys)];
}

export function buildQuickBooksCustomerMatchEvidence(
  estimates: any[] = [],
  invoices: any[] = [],
  payments: any[] = [],
): QuickBooksCustomerMatchEvidence {
  const ids = (rows: any[], key: string) => [...new Set(rows.map((row) => clean(row?.[key] ?? row?.id ?? row?.Id, 120)).filter(Boolean))];
  const totals = [
    ...estimates.map((row) => money(row?.total ?? row?.TotalAmt)),
    ...invoices.map((row) => money(row?.total ?? row?.TotalAmt)),
    ...payments.map((row) => money(row?.total ?? row?.TotalAmt)),
  ].filter((value) => value > 0);
  return {
    estimateIds: ids(estimates, 'estimateId'),
    invoiceIds: ids(invoices, 'invoiceId'),
    paymentIds: ids(payments, 'paymentId'),
    transactionTotals: [...new Set(totals)],
    estimates: estimates.slice(0, 50).map((row) => ({
      id: clean(row?.estimateId ?? row?.id ?? row?.Id, 120),
      docNumber: clean(row?.docNumber ?? row?.DocNumber, 120),
      txnDate: isoDate(row?.txnDate ?? row?.TxnDate),
      total: money(row?.total ?? row?.TotalAmt),
    })),
    invoices: invoices.slice(0, 50).map((row) => ({
      id: clean(row?.invoiceId ?? row?.id ?? row?.Id, 120),
      docNumber: clean(row?.docNumber ?? row?.DocNumber, 120),
      txnDate: isoDate(row?.txnDate ?? row?.TxnDate),
      dueDate: isoDate(row?.dueDate ?? row?.DueDate),
      total: money(row?.total ?? row?.TotalAmt),
      balance: money(row?.balance ?? row?.Balance),
    })),
    payments: payments.slice(0, 50).map((row) => ({
      id: clean(row?.paymentId ?? row?.id ?? row?.Id, 120),
      txnDate: isoDate(row?.txnDate ?? row?.TxnDate),
      total: money(row?.total ?? row?.TotalAmt),
    })),
  };
}

export function buildQuickBooksMatchIndexes(records: any[]): QuickBooksMatchIndexes {
  const recordsById = new Map(records.map((record) => [String(record.id), record]));
  const byQboCustomerId = new Map<string, any>();
  const transactionMap = new Map<string, any[]>();
  for (const record of records) {
    const customerId = clean(record?.accounting?.quickbooks?.customerId, 100);
    if (customerId && !byQboCustomerId.has(customerId)) byQboCustomerId.set(customerId, record);
    for (const key of quickBooksTransactionKeysFromRecord(record)) {
      const rows = transactionMap.get(key) || [];
      if (!rows.some((entry) => String(entry?.id) === String(record?.id))) rows.push(record);
      transactionMap.set(key, rows);
    }
  }
  return {
    records,
    recordsById,
    byQboCustomerId,
    exactDisplay: mapUnique(records, (record) => normalizeDisplayName(expectedDisplayName(record))),
    emailMap: mapUnique(records, (record) => normalizeQuickBooksMatchEmail(record?.customer?.email)),
    phoneMap: mapUnique(records, (record) => normalizeQuickBooksMatchPhone(record?.customer?.phone)),
    eventDateMap: mapUnique(records, (record) => isoDate(record?.customer?.eventDate)),
    normalizedNameMap: mapUnique(records, (record) => normalizeQuickBooksMatchName(record?.customer?.name)),
    normalizedNameSignatureMap: mapUnique(records, (record) => normalizedNameSignature(record?.customer?.name)),
    transactionMap,
  };
}

export function addRecordToQuickBooksMatchIndexes(indexes: QuickBooksMatchIndexes, record: any) {
  const recordId = clean(record?.id, 120);
  if (recordId) indexes.recordsById.set(recordId, record);
  if (recordId && !indexes.records.some((entry) => String(entry?.id) === recordId)) indexes.records.push(record);
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
  add(indexes.phoneMap, normalizeQuickBooksMatchPhone(record?.customer?.phone));
  add(indexes.eventDateMap, isoDate(record?.customer?.eventDate));
  add(indexes.normalizedNameMap, normalizeQuickBooksMatchName(record?.customer?.name));
  add(indexes.normalizedNameSignatureMap, normalizedNameSignature(record?.customer?.name));
  for (const key of quickBooksTransactionKeysFromRecord(record)) add(indexes.transactionMap, key);
}

function crmTransactionEvidence(record: any) {
  const qbo = record?.accounting?.quickbooks || {};
  const estimates = (Array.isArray(qbo.estimates) ? qbo.estimates : []).slice(0, 50).map((row: any) => ({
    id: clean(row?.estimateId ?? row?.id, 120),
    docNumber: clean(row?.docNumber, 120),
    txnDate: isoDate(row?.txnDate),
    total: money(row?.total),
  }));
  const invoices = (Array.isArray(qbo.invoices) ? qbo.invoices : []).slice(0, 50).map((row: any) => ({
    id: clean(row?.invoiceId ?? row?.id, 120),
    docNumber: clean(row?.docNumber, 120),
    txnDate: isoDate(row?.txnDate),
    dueDate: isoDate(row?.dueDate),
    total: money(row?.total ?? row?.amount),
    balance: money(row?.balance),
  }));
  const payments = (Array.isArray(qbo.payments) ? qbo.payments : []).slice(0, 50).map((row: any) => ({
    id: clean(row?.paymentId ?? row?.id, 120),
    txnDate: isoDate(row?.txnDate),
    total: money(row?.total),
  }));
  return {
    estimates,
    invoices,
    payments,
    estimateIds: [...new Set([clean(qbo.estimateId,120), ...estimates.map((row: any) => row.id)].filter(Boolean))],
    invoiceIds: [...new Set(invoices.map((row: any) => row.id).filter(Boolean))],
    paymentIds: [...new Set(payments.map((row: any) => row.id).filter(Boolean))],
    proposalTotal: money(record?.proposal?.total),
  };
}

function sharedIds(left: string[] = [], right: string[] = []) {
  const rightSet = new Set(right.map(String));
  return [...new Set(left.map(String).filter((value) => value && rightSet.has(value)))];
}

function candidateComparison(
  record: any,
  customer: any,
  evidence: QuickBooksCustomerMatchEvidence,
  signals: string[] = [],
) {
  const qboName = baseNameFromDisplayName(customer?.DisplayName) || clean(customer?.DisplayName, 240);
  const crmName = clean(record?.customer?.name, 180);
  const qboEmail = qboCustomerEmail(customer);
  const crmEmail = clean(record?.customer?.email, 240);
  const qboPhone = qboCustomerPhone(customer);
  const crmPhone = clean(record?.customer?.phone, 80);
  const qboDate = eventDateFromDisplayName(customer?.DisplayName);
  const crmDate = isoDate(record?.customer?.eventDate);
  const crmTx = crmTransactionEvidence(record);
  const qboTotals = Array.isArray(evidence?.transactionTotals) ? evidence.transactionTotals.map(money) : [];
  const proposalTotal = money(crmTx.proposalTotal);
  return {
    fields: {
      name: {
        qbo: qboName,
        crm: crmName,
        normalizedQbo: normalizeQuickBooksMatchName(qboName),
        normalizedCrm: normalizeQuickBooksMatchName(crmName),
        similarity: Math.round(normalizedNameSimilarity(qboName, crmName) * 100),
        matched: normalizeQuickBooksMatchName(qboName) !== '' && normalizeQuickBooksMatchName(qboName) === normalizeQuickBooksMatchName(crmName),
      },
      email: {
        qbo: qboEmail,
        crm: crmEmail,
        normalizedQbo: normalizeQuickBooksMatchEmail(qboEmail),
        normalizedCrm: normalizeQuickBooksMatchEmail(crmEmail),
        matched: Boolean(normalizeQuickBooksMatchEmail(qboEmail)) && normalizeQuickBooksMatchEmail(qboEmail) === normalizeQuickBooksMatchEmail(crmEmail),
      },
      phone: {
        qbo: qboPhone,
        crm: crmPhone,
        normalizedQbo: normalizeQuickBooksMatchPhone(qboPhone),
        normalizedCrm: normalizeQuickBooksMatchPhone(crmPhone),
        matched: Boolean(normalizeQuickBooksMatchPhone(qboPhone)) && normalizeQuickBooksMatchPhone(qboPhone) === normalizeQuickBooksMatchPhone(crmPhone),
      },
      eventDate: {
        qbo: qboDate,
        crm: crmDate,
        normalizedQbo: qboDate,
        normalizedCrm: crmDate,
        matched: Boolean(qboDate) && qboDate === crmDate,
      },
    },
    transactions: {
      qbo: {
        estimates: evidence?.estimates || [],
        invoices: evidence?.invoices || [],
        payments: evidence?.payments || [],
        totals: qboTotals,
      },
      crm: crmTx,
      sharedEstimateIds: sharedIds(evidence?.estimateIds || [], crmTx.estimateIds || []),
      sharedInvoiceIds: sharedIds(evidence?.invoiceIds || [], crmTx.invoiceIds || []),
      sharedPaymentIds: sharedIds(evidence?.paymentIds || [], crmTx.paymentIds || []),
      proposalTotalMatch: proposalTotal > 0 && qboTotals.some((value) => Math.abs(value - proposalTotal) < 0.01),
    },
    signals,
  };
}

function candidateView(
  record: any,
  reason = '',
  score = 0,
  signals: string[] = [],
  customer: any = null,
  evidence: QuickBooksCustomerMatchEvidence = { estimateIds:[], invoiceIds:[], paymentIds:[], transactionTotals:[], estimates:[], invoices:[], payments:[] },
) {
  return {
    recordId: clean(record?.id, 120),
    name: clean(record?.customer?.name, 180),
    email: clean(record?.customer?.email, 240),
    phone: clean(record?.customer?.phone, 80),
    eventDate: clean(record?.customer?.eventDate, 40),
    stage: clean(record?.stage || record?.kind, 80),
    currentQuickBooksCustomerId: clean(record?.accounting?.quickbooks?.customerId, 100),
    reason,
    score,
    signals,
    riskLevel: score >= 90 ? 'high' : score >= 55 ? 'medium' : score >= 20 ? 'review' : 'low',
    comparison: customer ? candidateComparison(record, customer, evidence, signals) : null,
  };
}

export function resolveQuickBooksCustomerMatch(
  customer: any,
  indexes: QuickBooksMatchIndexes,
  overrides: Record<string, QuickBooksMatchOverride> = {},
  evidence: QuickBooksCustomerMatchEvidence = { estimateIds:[], invoiceIds:[], paymentIds:[], transactionTotals:[], estimates:[], invoices:[], payments:[] },
) {
  const customerId = clean(customer?.Id, 100);
  const linked = indexes.byQboCustomerId.get(customerId);
  if (linked) {
    return {
      status: 'linked',
      reason: 'existing-qbo-link',
      record: linked,
      candidates: [candidateView(linked, 'Already linked to this QuickBooks customer', 100, ['existing_qbo_link'], customer, evidence)],
      duplicateRisk: { level:'none', score:0, candidateCount:0, signals:[] },
      bulkEligible:false,
    };
  }

  const override = overrides[customerId];
  if (override?.decision === 'exclude') {
    return {
      status: 'excluded',
      reason: 'staff-excluded',
      record: null,
      candidates: [],
      duplicateRisk: { level:'none', score:0, candidateCount:0, signals:['staff_excluded'] },
      bulkEligible:false,
      exclusion: {
        excludedAt: clean(override.approvedAt, 80),
        excludedBy: clean(override.approvedBy, 180),
        reasonCode: inferredStoredExclusionReasonCode(override),
        reasonLabel: quickBooksExclusionReasonLabel(inferredStoredExclusionReasonCode(override)),
        reason: clean(override.exclusionReason || quickBooksExclusionReasonLabel(inferredStoredExclusionReasonCode(override)), 500),
      },
    };
  }
  if (override?.decision === 'new') {
    return {
      status: 'approved_new',
      reason: override.approvalMode === 'bulk' ? 'staff-bulk-approved-new' : 'staff-approved-new',
      record: null,
      candidates: [],
      duplicateRisk: { level:'approved', score:0, candidateCount:0, signals:[] },
      bulkEligible:false,
    };
  }
  if (override?.decision === 'match') {
    const approved = indexes.recordsById.get(clean(override.recordId, 120));
    if (approved) {
      return {
        status: 'approved_match',
        reason: 'staff-approved-match',
        record: approved,
        candidates: [candidateView(approved, 'Staff-approved match', 100, ['staff_approved_match'], customer, evidence)],
        duplicateRisk: { level:'approved', score:100, candidateCount:1, signals:['staff_approved_match'] },
        bulkEligible:false,
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
        candidates: [candidateView(hinted, 'QuickBooks notes point to this CRM record, but it is linked to another QuickBooks customer', 100, ['crm_id_hint','linked_elsewhere'], customer, evidence)],
        duplicateRisk: { level:'high', score:100, candidateCount:1, signals:['crm_id_hint','linked_elsewhere'] },
        bulkEligible:false,
      };
    }
    return {
      status: 'linked',
      reason: 'qbo-crm-id-hint',
      record: hinted,
      candidates: [candidateView(hinted, 'QuickBooks notes contain this CRM record ID', 100, ['crm_id_hint'], customer, evidence)],
      duplicateRisk: { level:'none', score:0, candidateCount:0, signals:[] },
      bulkEligible:false,
    };
  }

  const candidateMap = new Map<string, { record: any; reasons: string[]; signals: string[]; score: number }>();
  const addCandidates = (rows: any[], reason: string, score: number, signal: string) => {
    for (const record of rows) {
      const id = clean(record?.id, 120);
      if (!id) continue;
      const existing = candidateMap.get(id) || { record, reasons: [], signals: [], score:0 };
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      if (!existing.signals.includes(signal)) {
        existing.signals.push(signal);
        existing.score += score;
      }
      candidateMap.set(id, existing);
    }
  };

  addCandidates(indexes.exactDisplay.get(normalizeDisplayName(customer?.DisplayName)) || [], 'Exact display name and event date', 90, 'exact_display');
  const email = normalizeQuickBooksMatchEmail(qboCustomerEmail(customer));
  if (email) addCandidates(indexes.emailMap.get(email) || [], 'Same email address', 70, 'email');
  const phone = normalizeQuickBooksMatchPhone(qboCustomerPhone(customer));
  if (phone) addCandidates(indexes.phoneMap.get(phone) || [], 'Same phone number', 60, 'phone');
  const eventDate = eventDateFromDisplayName(customer?.DisplayName);
  if (eventDate) addCandidates(indexes.eventDateMap.get(eventDate) || [], 'Same event date', 30, 'event_date');
  const normalizedName = normalizeQuickBooksMatchName(customer?.DisplayName);
  if (normalizedName) addCandidates(indexes.normalizedNameMap.get(normalizedName) || [], 'Same normalized customer name', 35, 'normalized_name');
  const nameSignature = normalizedNameSignature(customer?.DisplayName);
  if (nameSignature) addCandidates(indexes.normalizedNameSignatureMap.get(nameSignature) || [], 'Same name tokens in a different order or format', 30, 'name_tokens');

  for (const id of evidence.estimateIds || []) addCandidates(indexes.transactionMap.get('estimate:' + clean(id,120)) || [], 'QuickBooks estimate already appears in this CRM client history', 100, 'estimate_history');
  for (const id of evidence.invoiceIds || []) addCandidates(indexes.transactionMap.get('invoice:' + clean(id,120)) || [], 'QuickBooks invoice already appears in this CRM client history', 100, 'invoice_history');
  for (const id of evidence.paymentIds || []) addCandidates(indexes.transactionMap.get('payment:' + clean(id,120)) || [], 'QuickBooks payment already appears in this CRM client history', 100, 'payment_history');

  // Fuzzy normalized-name evidence is intentionally review-only. It can flag
  // a possible duplicate but never auto-link a customer by itself.
  for (const record of indexes.records) {
    const similarity = normalizedNameSimilarity(customer?.DisplayName, record?.customer?.name);
    if (similarity < 0.66) continue;
    const id = clean(record?.id,120);
    const existing = candidateMap.get(id);
    if (existing?.signals.includes('normalized_name') || existing?.signals.includes('name_tokens')) continue;
    const pct = Math.round(similarity * 100);
    addCandidates([record], 'Similar normalized customer name (' + pct + '% token overlap)', Math.min(28, 14 + Math.round(similarity * 18)), 'similar_name');
  }

  // A matching proposal total is supporting evidence only; it can strengthen
  // an already-plausible candidate but never creates a candidate on its own.
  for (const candidate of candidateMap.values()) {
    const proposalTotal = money(candidate.record?.proposal?.total);
    if (!proposalTotal || !(evidence.transactionTotals || []).some((value) => Math.abs(money(value) - proposalTotal) < 0.01)) continue;
    if (!candidate.signals.includes('transaction_amount')) {
      candidate.signals.push('transaction_amount');
      candidate.reasons.push('QuickBooks transaction total matches this CRM proposal total');
      candidate.score += 12;
    }
  }

  const candidates = [...candidateMap.values()]
    .filter((entry) => entry.score >= 20)
    .sort((a,b) => b.score - a.score)
    .map(({ record, reasons, score, signals }) => candidateView(record, reasons.join(' · '), score, signals, customer, evidence));

  const topScore = Number(candidates[0]?.score || 0);
  const uniqueSignals = [...new Set(candidates.flatMap((candidate: any) => candidate.signals || []))];
  const duplicateRisk = {
    level: topScore >= 90 ? 'high' : topScore >= 55 ? 'medium' : topScore >= 20 ? 'review' : 'low',
    score: topScore,
    candidateCount: candidates.length,
    signals: uniqueSignals,
  };

  if (candidates.length === 1) {
    const candidate = candidates[0];
    if (candidate.currentQuickBooksCustomerId && candidate.currentQuickBooksCustomerId !== customerId) {
      return { status:'ambiguous', reason:'candidate-linked-elsewhere', record:null, candidates, duplicateRisk:{...duplicateRisk,level:'high'}, bulkEligible:false };
    }
    const autoMatchSignals = new Set(candidate.signals || []);
    const hasStrongTransaction = ['estimate_history','invoice_history','payment_history'].some((signal) => autoMatchSignals.has(signal));
    const hasContactPlusIdentity =
      (autoMatchSignals.has('email') || autoMatchSignals.has('phone')) &&
      (autoMatchSignals.has('normalized_name') || autoMatchSignals.has('name_tokens') || autoMatchSignals.has('event_date'));
    const exactDisplay = autoMatchSignals.has('exact_display');
    if (hasStrongTransaction || hasContactPlusIdentity || exactDisplay || Number(candidate.score || 0) >= 90) {
      const record = indexes.recordsById.get(candidate.recordId);
      return { status:'auto_match', reason:candidate.reason, record, candidates, duplicateRisk, bulkEligible:false };
    }
    return { status:'ambiguous', reason:'possible-crm-duplicate', record:null, candidates, duplicateRisk, bulkEligible:false };
  }
  if (candidates.length > 1) {
    return { status:'ambiguous', reason:'multiple-crm-candidates', record:null, candidates, duplicateRisk, bulkEligible:false };
  }

  const reliableIdentity = Boolean(email || phone);
  return {
    status:'new',
    reason: reliableIdentity ? 'no-crm-candidate' : 'no-crm-candidate-missing-contact',
    record:null,
    candidates:[],
    duplicateRisk: {
      level: reliableIdentity ? 'low' : 'review',
      score:0,
      candidateCount:0,
      signals: reliableIdentity ? [] : ['missing_reliable_contact'],
    },
    bulkEligible: reliableIdentity,
  };
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
  input: { customerId: string; decision: 'match'|'new'|'exclude'|'clear'; recordId?: string; reasonCode?: string; reason?: string },
  actor = '',
) {
  const customerId = clean(input.customerId, 100);
  const decision = clean(input.decision, 20) as 'match'|'new'|'exclude'|'clear';
  if (!customerId) throw new Error('QuickBooks customer ID is required.');
  if (!['match','new','exclude','clear'].includes(decision)) throw new Error('Invalid matching decision.');

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

  const requestedReasonCode = normalizeQuickBooksExclusionReasonCode(input.reasonCode);
  if (decision === 'exclude' && clean(input.reasonCode,60) && !requestedReasonCode) {
    throw new Error('Choose a valid exclusion reason.');
  }
  const exclusionReasonCode = decision === 'exclude' ? (requestedReasonCode || 'other') : undefined;
  const exclusionReasonLabel = exclusionReasonCode ? quickBooksExclusionReasonLabel(exclusionReasonCode) : undefined;

  const override: QuickBooksMatchOverride = {
    customerId,
    decision,
    recordId,
    approvedAt: new Date().toISOString(),
    approvedBy: clean(actor, 180),
    customerName: clean(qboCustomer.DisplayName, 240),
    approvalMode: 'single',
    exclusionReasonCode,
    exclusionReasonLabel,
    exclusionReason: decision === 'exclude'
      ? clean(input.reason || exclusionReasonLabel || 'Other', 500)
      : undefined,
  };
  overrides[customerId] = override;
  await integrations.setJSON(MATCH_OVERRIDES_KEY, overrides);
  return { customerId, cleared: false, override };
}

export async function saveQuickBooksBulkNewOverrides(
  context: Context,
  input: { previewId: string; customerIds: string[] },
  actor = '',
) {
  const previewId = clean(input.previewId, 120);
  const ids = [...new Set((Array.isArray(input.customerIds) ? input.customerIds : []).map((id) => clean(id,100)).filter(Boolean))].slice(0, 200);
  if (!previewId) throw new Error('Preview Sync ID is required.');
  if (!ids.length) throw new Error('Select at least one low-risk new QuickBooks customer.');

  const preview = await getLastQuickBooksCrmSyncPreview(context);
  if (!preview?.previewId || clean(preview.previewId,120) !== previewId) {
    throw new Error('That Preview Sync is no longer current. Run Preview Sync again before bulk approval.');
  }
  const generatedAt = Date.parse(String(preview.generatedAt || ''));
  if (!generatedAt || Date.now() - generatedAt > PREVIEW_MAX_AGE_MS) {
    throw new Error('The Preview Sync is older than 30 minutes. Run Preview Sync again before bulk approval.');
  }

  const plans = new Map((Array.isArray(preview.customerPlans) ? preview.customerPlans : []).map((plan: any) => [clean(plan?.customerId,100), plan]));
  const invalid = ids
    .map((id) => ({ id, plan:plans.get(id) }))
    .filter(({ plan }: any) => !plan || clean(plan?.decision,40) !== 'new' || !Boolean(plan?.bulkEligible));

  if (invalid.length) {
    const names = invalid.slice(0,5).map(({ id, plan }: any) => clean(plan?.qbo?.name || id,180)).join(', ');
    throw new Error('Bulk approval is limited to low-risk new customers with no duplicate evidence. Review individually: ' + names + (invalid.length > 5 ? ' and ' + (invalid.length - 5) + ' more' : '') + '.');
  }

  const integrations = integrationStore(context);
  const overrides = await getQuickBooksMatchOverrides(context);
  const approvedAt = new Date().toISOString();
  const approvedBy = clean(actor,180);
  const approved: any[] = [];

  for (const id of ids) {
    const plan: any = plans.get(id);
    const override: QuickBooksMatchOverride = {
      customerId:id,
      decision:'new',
      recordId:'',
      approvedAt,
      approvedBy,
      customerName:clean(plan?.qbo?.name,240),
      approvalMode:'bulk',
    };
    overrides[id] = override;
    approved.push({ customerId:id, customerName:override.customerName });
  }

  await integrations.setJSON(MATCH_OVERRIDES_KEY, overrides);
  return { previewId, approvedAt, approvedBy, approved };
}

export async function saveQuickBooksBulkExclusionOverrides(
  context: Context,
  input: { previewId: string; customerIds: string[]; reasonCode: string; reason?: string },
  actor = '',
) {
  const previewId = clean(input.previewId, 120);
  const ids = [...new Set((Array.isArray(input.customerIds) ? input.customerIds : []).map((id) => clean(id,100)).filter(Boolean))].slice(0, 200);
  const rawReasonCode = clean(input.reasonCode, 60);
  const useSuggestedReasons = rawReasonCode === 'suggested';
  const fixedReasonCode = useSuggestedReasons ? '' : normalizeQuickBooksExclusionReasonCode(rawReasonCode);
  if (!previewId) throw new Error('Preview Sync ID is required.');
  if (!ids.length) throw new Error('Select at least one unresolved QuickBooks customer to exclude.');
  if (!useSuggestedReasons && !fixedReasonCode) throw new Error('Choose an exclusion reason before bulk exclusion.');

  const preview = await getLastQuickBooksCrmSyncPreview(context);
  if (!preview?.previewId || clean(preview.previewId,120) !== previewId) {
    throw new Error('That Preview Sync is no longer current. Run Preview Sync again before bulk exclusion.');
  }
  const generatedAt = Date.parse(String(preview.generatedAt || ''));
  if (!generatedAt || Date.now() - generatedAt > PREVIEW_MAX_AGE_MS) {
    throw new Error('The Preview Sync is older than 30 minutes. Run Preview Sync again before bulk exclusion.');
  }

  const plans = new Map((Array.isArray(preview.customerPlans) ? preview.customerPlans : []).map((plan: any) => [clean(plan?.customerId,100), plan]));
  const invalid = ids
    .map((id) => ({ id, plan:plans.get(id) }))
    .filter(({ plan }: any) => {
      if (!plan || !['new','ambiguous'].includes(clean(plan?.decision,40))) return true;
      if (useSuggestedReasons && !normalizeQuickBooksExclusionReasonCode(plan?.suggestedExclusion?.code)) return true;
      return false;
    });

  if (invalid.length) {
    const names = invalid.slice(0,5).map(({ id, plan }: any) => clean(plan?.qbo?.name || id,180)).join(', ');
    const qualifier = useSuggestedReasons
      ? 'Bulk suggested-reason exclusion is limited to unresolved customers with a high-confidence suggested exclusion.'
      : 'Bulk exclusion is limited to unresolved new/import or duplicate-review customers.';
    throw new Error(qualifier + ' Review individually: ' + names + (invalid.length > 5 ? ' and ' + (invalid.length - 5) + ' more' : '') + '.');
  }

  const integrations = integrationStore(context);
  const overrides = await getQuickBooksMatchOverrides(context);
  const approvedAt = new Date().toISOString();
  const approvedBy = clean(actor,180);
  const excluded: any[] = [];

  for (const id of ids) {
    const plan: any = plans.get(id);
    const reasonCode = useSuggestedReasons
      ? normalizeQuickBooksExclusionReasonCode(plan?.suggestedExclusion?.code)
      : fixedReasonCode;
    if (!reasonCode) continue;
    const reasonLabel = quickBooksExclusionReasonLabel(reasonCode);
    const reason = clean(
      input.reason ||
      (useSuggestedReasons ? plan?.suggestedExclusion?.reason : '') ||
      reasonLabel,
      500,
    );
    const override: QuickBooksMatchOverride = {
      customerId:id,
      decision:'exclude',
      recordId:'',
      approvedAt,
      approvedBy,
      customerName:clean(plan?.qbo?.name,240),
      approvalMode:'bulk',
      exclusionReasonCode:reasonCode,
      exclusionReasonLabel:reasonLabel,
      exclusionReason:reason,
    };
    overrides[id] = override;
    excluded.push({
      customerId:id,
      customerName:override.customerName,
      reasonCode,
      reasonLabel,
      reason,
    });
  }

  await integrations.setJSON(MATCH_OVERRIDES_KEY, overrides);
  return {
    previewId,
    approvedAt,
    approvedBy,
    reasonMode:useSuggestedReasons ? 'suggested' : 'fixed',
    reasonCode:fixedReasonCode || '',
    reasonLabel:fixedReasonCode ? quickBooksExclusionReasonLabel(fixedReasonCode) : 'Suggested reason per customer',
    excluded,
  };
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

function projectedRecordSnapshot(record: any, customer: any, financial: any, predictedRecordId = '') {
  const origin = !record || clean(record?.accounting?.quickbooks?.origin, 40) === 'quickbooks' || clean(record?.source, 80) === 'quickbooks-import';
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
    recordId: clean(base.recordId || predictedRecordId, 120),
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
    changes.push({
      field:'Customer',
      before:null,
      after:{
        displayName:desiredDisplay,
        email:desiredEmail || '',
        phone:desiredPhone || '',
      },
      action:'create',
    });
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


function snapshotFieldChanges(before: any, after: any) {
  const paths = [
    ['recordId','CRM record ID'],
    ['stage','Stage'],
    ['status','Status'],
    ['customer.name','Customer name'],
    ['customer.email','Customer email'],
    ['customer.phone','Customer phone'],
    ['customer.eventDate','Event date'],
    ['proposal.status','Proposal status'],
    ['proposal.total','Proposal total'],
    ['quickbooks.customerId','QuickBooks customer ID'],
    ['quickbooks.estimateId','QuickBooks estimate ID'],
    ['quickbooks.invoiceCount','Invoice count'],
    ['quickbooks.paymentCount','Payment count'],
    ['quickbooks.totalInvoiced','Total invoiced'],
    ['quickbooks.totalPaid','Total paid'],
    ['quickbooks.balanceDue','Balance due'],
  ] as const;
  const get = (value: any, path: string) =>
    path.split('.').reduce((current: any, key) => current == null ? undefined : current[key], value);
  const changes: any[] = [];
  for (const [path, label] of paths) {
    const oldValue = get(before, path);
    const newValue = get(after, path);
    if (before == null) {
      if (newValue === undefined || newValue === null || newValue === '') continue;
      changes.push({ field:path, label, before:null, after:newValue, action:'create' });
      continue;
    }
    if (!sameJson(oldValue, newValue)) {
      changes.push({ field:path, label, before:oldValue ?? null, after:newValue ?? null, action:'update' });
    }
  }
  return changes;
}

function executionCustomerDetail(plan: any) {
  return {
    customerId: clean(plan?.customerId, 100),
    name: clean(plan?.qbo?.name, 240),
    recordId: clean(plan?.matchedRecordId || plan?.predictedRecordId, 120),
    decision: clean(plan?.decision, 40),
    disposition: clean(plan?.executionDisposition, 40),
    reason: clean(plan?.reason, 500),
    exclusion: plan?.exclusion || null,
    changes: snapshotFieldChanges(plan?.before || null, plan?.after || null),
  };
}

export function buildQuickBooksCrmSyncReconciliation(preview: any, result: any) {
  const predicted = preview?.executionSummary || {};
  const actualSkipped = Number(result?.skipped?.capacity || 0) +
    Number(result?.skipped?.unapprovedNew || 0) +
    Number(result?.skipped?.excluded || 0);
  const actualQboActions = Number(result?.pushed?.customersCreated || 0) +
    Number(result?.pushed?.customersUpdated || 0) +
    Number(result?.pushed?.estimatesCreated || 0) +
    Number(result?.pushed?.estimatesUpdated || 0);
  const actualQboRecords = new Set(
    (Array.isArray(result?.outboundOutcomes) ? result.outboundOutcomes : [])
      .filter((row: any) => ['create','update'].includes(clean(row?.action, 30)))
      .map((row: any) => clean(row?.recordId, 120))
      .filter(Boolean),
  ).size;

  const actualCustomerOutcomes = Array.isArray(result?.customerOutcomes) ? result.customerOutcomes : [];
  const actualCreated = actualCustomerOutcomes.filter((row: any) => clean(row?.outcome,40) === 'create').length;
  const actualMatched = actualCustomerOutcomes.filter((row: any) => clean(row?.outcome,40) === 'match_refresh').length;
  const countComparisons = [
    { key:'crm_created', label:'CRM customers created', predicted:Number(predicted.crmCustomersCreated || 0), actual:actualCreated },
    { key:'crm_matched', label:'CRM customers matched/refreshed', predicted:Number(predicted.crmCustomersMatched || 0), actual:actualMatched },
    { key:'crm_skipped', label:'Customers skipped/excluded', predicted:Number(predicted.crmCustomersSkipped || 0), actual:actualSkipped },
    { key:'duplicates', label:'Duplicate matches blocked', predicted:Number(predicted.crmCustomersBlockedDuplicates || 0), actual:Number(result?.skipped?.ambiguous || 0) },
    { key:'qbo_records', label:'CRM records written back to QuickBooks', predicted:Number(predicted.quickBooksRecordsWritten || 0), actual:actualQboRecords },
    { key:'qbo_actions', label:'QuickBooks write actions', predicted:Number(predicted.quickBooksActionsWritten || 0), actual:actualQboActions },
    { key:'qbo_customer_create', label:'QuickBooks customer creates', predicted:Number(predicted.quickBooksCustomerCreates || 0), actual:Number(result?.pushed?.customersCreated || 0) },
    { key:'qbo_customer_update', label:'QuickBooks customer updates', predicted:Number(predicted.quickBooksCustomerUpdates || 0), actual:Number(result?.pushed?.customersUpdated || 0) },
    { key:'qbo_estimate_create', label:'QuickBooks estimate creates', predicted:Number(predicted.quickBooksEstimateCreates || 0), actual:Number(result?.pushed?.estimatesCreated || 0) },
    { key:'qbo_estimate_update', label:'QuickBooks estimate updates', predicted:Number(predicted.quickBooksEstimateUpdates || 0), actual:Number(result?.pushed?.estimatesUpdated || 0) },
  ].map((row) => ({ ...row, matched: row.predicted === row.actual }));

  const predictedCustomerMap = new Map(
    (Array.isArray(preview?.customerPlans) ? preview.customerPlans : [])
      .map((plan: any) => [clean(plan?.customerId,100), {
        customerId:clean(plan?.customerId,100),
        name:clean(plan?.qbo?.name,240),
        expected:clean(plan?.executionDisposition,40),
      }])
      .filter(([id]: any) => Boolean(id)),
  );
  const actualCustomerMap = new Map(
    (Array.isArray(result?.customerOutcomes) ? result.customerOutcomes : [])
      .map((row: any) => [clean(row?.customerId,100), row])
      .filter(([id]: any) => Boolean(id)),
  );
  const customerComparisons: any[] = [];
  const deviations: any[] = [];

  for (const [customerId, expectedRow] of predictedCustomerMap.entries()) {
    const actualRow: any = actualCustomerMap.get(customerId);
    const actualOutcome = clean(actualRow?.outcome, 40);
    const matched = Boolean(actualRow) && actualOutcome === clean((expectedRow as any).expected,40);
    const comparison = {
      customerId,
      name: clean((expectedRow as any).name,240),
      predicted: clean((expectedRow as any).expected,40),
      actual: actualOutcome || 'not_observed',
      recordId: clean(actualRow?.recordId,120),
      matched,
    };
    customerComparisons.push(comparison);
    if (!matched) deviations.push({ type:'customer-outcome', ...comparison });
  }
  for (const [customerId, actualRow] of actualCustomerMap.entries()) {
    if (predictedCustomerMap.has(customerId)) continue;
    deviations.push({
      type:'unexpected-customer-outcome',
      customerId,
      name:clean((actualRow as any)?.name,240),
      predicted:'not_in_preview',
      actual:clean((actualRow as any)?.outcome,40),
      recordId:clean((actualRow as any)?.recordId,120),
    });
  }

  const expectedOutbound = new Map<string, any>();
  for (const row of Array.isArray(preview?.outbound) ? preview.outbound : []) {
    for (const action of Array.isArray(row?.actions) ? row.actions : []) {
      if (!['create','update'].includes(clean(action?.action,30))) continue;
      const key = [clean(row?.recordId,120),clean(action?.type,30),clean(action?.action,30)].join(':');
      if (!expectedOutbound.has(key)) expectedOutbound.set(key, {
        recordId:clean(row?.recordId,120),
        name:clean(row?.name,180),
        type:clean(action?.type,30),
        action:clean(action?.action,30),
      });
    }
  }
  const actualOutbound = new Map<string, any>();
  for (const row of Array.isArray(result?.outboundOutcomes) ? result.outboundOutcomes : []) {
    if (!['create','update'].includes(clean(row?.action,30))) continue;
    const key = [clean(row?.recordId,120),clean(row?.type,30),clean(row?.action,30)].join(':');
    actualOutbound.set(key,row);
  }
  const outboundComparisons: any[] = [];
  for (const [key, expectedRow] of expectedOutbound.entries()) {
    const actualRow = actualOutbound.get(key);
    const comparison = { ...expectedRow, matched:Boolean(actualRow), actual:actualRow ? clean(actualRow.action,30) : 'not_observed' };
    outboundComparisons.push(comparison);
    if (!actualRow) deviations.push({ type:'quickbooks-write-missing', ...comparison });
  }
  for (const [key, actualRow] of actualOutbound.entries()) {
    if (expectedOutbound.has(key)) continue;
    deviations.push({
      type:'quickbooks-write-unexpected',
      recordId:clean(actualRow?.recordId,120),
      name:clean(actualRow?.name,180),
      action:clean(actualRow?.action,30),
      entityType:clean(actualRow?.type,30),
    });
  }

  for (const row of countComparisons) {
    if (!row.matched) deviations.push({
      type:'count-mismatch',
      key:row.key,
      label:row.label,
      predicted:row.predicted,
      actual:row.actual,
    });
  }
  for (const warning of Array.isArray(result?.warnings) ? result.warnings : []) {
    deviations.push({ type:'sync-warning', detail:clean(warning,700) });
  }
  for (const conflict of Array.isArray(result?.conflicts) ? result.conflicts : []) {
    deviations.push({ type:'sync-conflict', detail:clean(conflict?.detail || conflict?.type,700), recordId:clean(conflict?.recordId,120) });
  }

  return {
    previewId: clean(preview?.previewId,120),
    predictedAt: clean(preview?.generatedAt,80),
    completedAt: clean(result?.completedAt,80),
    status: deviations.length ? 'attention' : 'matched',
    deviationCount: deviations.length,
    countComparisons,
    customerComparisons,
    outboundComparisons,
    deviations,
  };
}

export async function buildQuickBooksCrmSyncPreview(context: Context, actor = '') {
  const generatedAt = new Date().toISOString();
  const store = salesStore(context);
  const records = (((await store.get('records/index', { type: 'json' })) || []) as any[]).filter(Boolean).slice(0, CRM_RECORD_LIMIT);
  const [customers, estimates, invoices, payments, overrides, settings, suggestedExclusionRules, suggestedExclusionDismissals] = await Promise.all([
    qboRows(context, 'Customer'),
    qboRows(context, 'Estimate'),
    qboRows(context, 'Invoice'),
    qboRows(context, 'Payment'),
    getQuickBooksMatchOverrides(context),
    getQuickBooksSettings(context),
    getQuickBooksSuggestedExclusionRules(context),
    getQuickBooksSuggestedExclusionDismissals(context),
  ]);

  const indexes = buildQuickBooksMatchIndexes(records);
  const estimateGroups = groupByCustomer(estimates);
  const invoiceGroups = groupByCustomer(invoices);
  const paymentGroups = groupByCustomer(payments);
  const customerById = new Map(customers.filter((row) => row?.Id).map((row) => [String(row.Id), row]));
  const estimateById = new Map(estimates.filter((row) => row?.Id).map((row) => [String(row.Id), row]));

  const customerPlans: any[] = customers.map((customer) => {
    const customerId = clean(customer?.Id, 100);
    const financial = customerFinancialSummary(customerId, estimateGroups, invoiceGroups, paymentGroups);
    const evidence = buildQuickBooksCustomerMatchEvidence(
      financial.estimateDocs || [],
      financial.invoiceDocs || [],
      financial.paymentDocs || [],
    );
    const match = resolveQuickBooksCustomerMatch(customer, indexes, overrides, evidence);
    const suggestedExclusion = ['new','ambiguous'].includes(match.status)
      ? suggestedQuickBooksExclusion(customer, suggestedExclusionRules, suggestedExclusionDismissals)
      : null;
    let predictedRecordId = '';
    if (['new','approved_new'].includes(match.status)) {
      const safe = clean(customerId, 100).replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-') || 'UNKNOWN';
      const baseId = 'QBO-CUST-' + safe;
      predictedRecordId = baseId;
      let counter = 2;
      while (indexes.recordsById.has(predictedRecordId)) {
        predictedRecordId = baseId + '-' + counter;
        counter += 1;
      }
    }
    const action = match.status === 'excluded'
      ? 'excluded'
      : ['ambiguous','new'].includes(match.status)
        ? 'needs_decision'
        : match.status === 'approved_new'
          ? 'import_new'
          : 'refresh_match';
    const before = match.record ? previewRecordSnapshot(match.record) : null;
    const after = ['ambiguous','excluded'].includes(match.status)
      ? null
      : projectedRecordSnapshot(match.record, customer, financial, predictedRecordId);
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
      predictedRecordId,
      candidates: match.candidates,
      duplicateRisk: match.duplicateRisk,
      bulkEligible: Boolean(match.bulkEligible),
      exclusion: match.exclusion || null,
      suggestedExclusion,
      financial,
      before,
      after,
      action,
    };
  });

  let remainingImportCapacity = Math.max(0, CRM_RECORD_LIMIT - records.length);
  for (const plan of customerPlans) {
    if (plan.decision === 'approved_new') {
      if (remainingImportCapacity > 0) {
        plan.executionDisposition = 'create';
        remainingImportCapacity -= 1;
      } else {
        plan.executionDisposition = 'skip_capacity';
      }
    } else if (plan.decision === 'new') {
      plan.executionDisposition = 'skip_unapproved';
    } else if (plan.decision === 'ambiguous') {
      plan.executionDisposition = 'blocked_duplicate';
    } else if (plan.decision === 'excluded') {
      plan.executionDisposition = 'excluded';
    } else {
      plan.executionDisposition = 'match_refresh';
    }
  }

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
    activeSyncCustomers: customerPlans.filter((row) => row.decision !== 'excluded').length,
    excludedCustomers: customerPlans.filter((row) => row.decision === 'excluded').length,
    suggestedExclusions: customerPlans.filter((row) => Boolean(row.suggestedExclusion)).length,
    suggestedExclusionRuleCount: suggestedExclusionRules.filter((rule) => rule.enabled).length,
    suggestedExclusionDismissalCount: Object.values(suggestedExclusionDismissals).reduce((sum, rows) => sum + Object.keys(rows || {}).length, 0),
    linked: customerPlans.filter((row) => row.decision === 'linked').length,
    matched: customerPlans.filter((row) => ['auto_match','approved_match'].includes(row.decision)).length,
    newImports: customerPlans.filter((row) => ['new','approved_new'].includes(row.decision)).length,
    unapprovedNewImports: customerPlans.filter((row) => row.decision === 'new').length,
    ambiguousMatches: customerPlans.filter((row) => row.decision === 'ambiguous').length,
    duplicateFlags: customerPlans.filter((row) => row.decision === 'ambiguous' || ['high','medium','review'].includes(String(row?.duplicateRisk?.level || ''))).length,
    bulkEligibleNewImports: customerPlans.filter((row) => row.decision === 'new' && row.bulkEligible).length,
    needsIndividualReview: customerPlans.filter((row) => row.decision === 'ambiguous' || (row.decision === 'new' && !row.bulkEligible)).length,
    needsDecision: customerPlans.filter((row) => ['new','ambiguous'].includes(row.decision)).length,
    crmOutboundRecords: outbound.length,
    crmOutboundActions: outbound.reduce((sum, row) => sum + row.actions.length, 0),
  };

  const quickBooksWritableActions = outbound.flatMap((row) =>
    (Array.isArray(row.actions) ? row.actions : []).map((action: any) => ({ ...action, recordId:row.recordId, name:row.name })),
  );
  const uniqueWritableOperationKeys = new Set(
    quickBooksWritableActions
      .filter((action: any) => ['create','update'].includes(String(action?.action || '')))
      .map((action: any) => [String(action.recordId || ''),String(action.type || '')].join(':')),
  );
  const uniqueWriteCount = (type: string, actionName: string) => new Set(
    quickBooksWritableActions
      .filter((action: any) => action.type === type && action.action === actionName)
      .map((action: any) => String(action.recordId || ''))
      .filter(Boolean),
  ).size;
  const executionSummary = {
    crmCustomersCreated: customerPlans.filter((row) => row.executionDisposition === 'create').length,
    crmCustomersMatched: customerPlans.filter((row) => row.executionDisposition === 'match_refresh').length,
    crmCustomersSkipped: customerPlans.filter((row) => ['skip_unapproved','skip_capacity','excluded'].includes(String(row.executionDisposition || ''))).length,
    crmCustomersSkippedUnapproved: customerPlans.filter((row) => row.executionDisposition === 'skip_unapproved').length,
    crmCustomersSkippedCapacity: customerPlans.filter((row) => row.executionDisposition === 'skip_capacity').length,
    crmCustomersExcluded: customerPlans.filter((row) => row.executionDisposition === 'excluded').length,
    crmCustomersBlockedDuplicates: customerPlans.filter((row) => row.executionDisposition === 'blocked_duplicate').length,
    crmCustomersRefreshed: customerPlans.filter((row) => row.executionDisposition === 'match_refresh').length,
    quickBooksRecordsWritten: new Set(quickBooksWritableActions.filter((action: any) => ['create','update'].includes(String(action?.action || ''))).map((action: any) => String(action.recordId || ''))).size,
    quickBooksActionsWritten: uniqueWritableOperationKeys.size,
    quickBooksCustomerCreates: uniqueWriteCount('customer','create'),
    quickBooksCustomerUpdates: uniqueWriteCount('customer','update'),
    quickBooksEstimateCreates: uniqueWriteCount('estimate','create'),
    quickBooksEstimateUpdates: uniqueWriteCount('estimate','update'),
    quickBooksBlockedActions: quickBooksWritableActions.filter((action: any) => action.action === 'blocked').length,
    ready: Number(summary.needsDecision || 0) === 0,
  };

  const exclusionReport = QUICKBOOKS_EXCLUSION_REASONS.map((reason) => {
    const customersForReason = customerPlans
      .filter((row) => row.decision === 'excluded' && clean(row?.exclusion?.reasonCode,60) === reason.code)
      .map((row) => ({
        customerId:clean(row?.customerId,100),
        customerName:clean(row?.qbo?.name,240),
        excludedAt:clean(row?.exclusion?.excludedAt,80),
        excludedBy:clean(row?.exclusion?.excludedBy,180),
        reason:clean(row?.exclusion?.reason,500),
      }));
    return {
      code:reason.code,
      label:reason.label,
      count:customersForReason.length,
      customers:customersForReason,
    };
  }).filter((row) => row.count > 0);

  const executionDetails = {
    create: customerPlans.filter((row) => row.executionDisposition === 'create').map(executionCustomerDetail),
    matchRefresh: customerPlans.filter((row) => row.executionDisposition === 'match_refresh').map(executionCustomerDetail),
    skip: customerPlans.filter((row) => ['skip_unapproved','skip_capacity','excluded'].includes(String(row.executionDisposition || ''))).map(executionCustomerDetail),
    blockedDuplicates: customerPlans.filter((row) => row.executionDisposition === 'blocked_duplicate').map(executionCustomerDetail),
    quickBooksWrites: outbound.map((row) => ({
      recordId:clean(row.recordId,120),
      name:clean(row.name,180),
      customerId:clean(row.customerId,100),
      estimateId:clean(row.estimateId,100),
      actions:(Array.isArray(row.actions) ? row.actions : []).map((action: any) => ({
        type:clean(action?.type,30),
        field:clean(action?.field,120),
        action:clean(action?.action,30),
        reason:clean(action?.reason,500),
        before:action?.before ?? null,
        after:action?.after ?? null,
      })),
    })),
  };

  const previewId = 'QBPREVIEW-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const preview = {
    previewId,
    generatedAt,
    actor: clean(actor, 180),
    expiresAt: new Date(Date.now() + PREVIEW_MAX_AGE_MS).toISOString(),
    summary,
    executionSummary,
    executionDetails,
    exclusionReasons: QUICKBOOKS_EXCLUSION_REASONS,
    suggestedExclusionRuleCount: suggestedExclusionRules.length,
    suggestedExclusionDismissalCount: Object.values(suggestedExclusionDismissals).reduce((sum, rows) => sum + Object.keys(rows || {}).length, 0),
    exclusionReport,
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
    throw new Error('Resolve every customer decision, including explicitly approving each new CRM import, then run Preview Sync again before applying changes.');
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
    reconciliationStatus: clean(detail?.reconciliation?.status, 40),
    reconciliationDeviationCount: Number(detail?.reconciliation?.deviationCount || 0),
    rollbackStatus: clean(detail?.rollback?.status, 40),
    rolledBackAt: clean(detail?.rollback?.completedAt, 80),
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
    legacyIndex: index,
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
  const legacyIndex = summary?.legacy
    ? Number(summary.legacyIndex)
    : (/^LEGACY-(\d+)/.test(id) ? Number(id.match(/^LEGACY-(\d+)/)?.[1]) : NaN);
  if (Number.isFinite(legacyIndex)) {
    const legacy = ((await store.get('quickbooks/manual-sync-history', { type:'json' })) || []) as any[];
    const legacyRow = legacy[legacyIndex];
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


function completedRollbackRecordIds(detail: any) {
  const ids = new Set<string>();
  const rollback = detail?.rollback || {};
  const collect = (rows: any[]) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = clean(row?.recordId, 120);
      if (id) ids.add(id);
    }
  };
  collect(rollback.restored);
  collect(rollback.deleted);
  for (const attempt of Array.isArray(rollback.attempts) ? rollback.attempts : []) {
    collect(attempt?.restored);
    collect(attempt?.deleted);
  }
  return ids;
}

function mergeRollbackEntries(...groups: any[][]) {
  const map = new Map<string, any>();
  for (const group of groups) {
    for (const row of Array.isArray(group) ? group : []) {
      const id = clean(row?.recordId, 120);
      if (id) map.set(id, { recordId:id, clientName:clean(row?.clientName,180) });
    }
  }
  return [...map.values()];
}

export async function previewQuickBooksCrmSyncRollback(context: Context, syncId: string) {
  const detail = await getQuickBooksCrmSyncHistoryDetail(context, syncId);
  if (!detail) throw new Error('QuickBooks sync history entry not found.');
  const recoveryRows = Array.isArray(detail?.recovery?.records) ? detail.recovery.records : [];
  if (!recoveryRows.length) {
    throw new Error('This sync does not contain CRM recovery snapshots. Only syncs created after rollback protection was enabled can be restored.');
  }

  const completedIds = completedRollbackRecordIds(detail);
  const store = salesStore(context);
  const records = (((await store.get('records/index', { type:'json' })) || []) as any[]).filter(Boolean);
  const currentById = new Map(records.map((record) => [String(record.id), record]));
  const rows = recoveryRows.map((row: any) => {
    const recordId = clean(row?.recordId, 120);
    const current = currentById.get(recordId) || null;
    const before = row?.before ?? null;
    const after = row?.after ?? null;
    const createdBySync = Boolean(row?.createdBySync || before == null);

    if (completedIds.has(recordId)) {
      return {
        recordId,
        clientName:clean(row?.clientName,180),
        action:'already_restored',
        safe:false,
        restored:true,
        reason:'This CRM record has already been rolled back from this sync.',
        before,
        after,
        current:jsonClone(current),
      };
    }

    if (createdBySync) {
      if (!current) {
        return { recordId, clientName:clean(row?.clientName,180), action:'already_absent', safe:false, restored:false, reason:'The sync-created CRM record is already absent and cannot be verified for automatic rollback.', before, after, current:null };
      }
      if (!sameJson(current, after)) {
        return { recordId, clientName:clean(row?.clientName,180), action:'delete_created', safe:false, restored:false, reason:'The CRM record changed after the sync and will not be deleted automatically.', before, after, current:jsonClone(current) };
      }
      return { recordId, clientName:clean(row?.clientName,180), action:'delete_created', safe:true, restored:false, reason:'CRM record still matches the post-sync snapshot.', before, after, current:jsonClone(current) };
    }

    if (!current) {
      return { recordId, clientName:clean(row?.clientName,180), action:'restore_updated', safe:false, restored:false, reason:'The CRM record no longer exists.', before, after, current:null };
    }
    if (!sameJson(current, after)) {
      return { recordId, clientName:clean(row?.clientName,180), action:'restore_updated', safe:false, restored:false, reason:'The CRM record changed after the sync and will not be overwritten automatically.', before, after, current:jsonClone(current) };
    }
    return { recordId, clientName:clean(row?.clientName,180), action:'restore_updated', safe:true, restored:false, reason:'CRM record still matches the post-sync snapshot.', before, after, current:jsonClone(current) };
  });

  const pendingRows = rows.filter((row: any) => !row.restored);
  return {
    syncId: clean(detail.syncId || syncId, 120),
    completedAt: clean(detail.completedAt, 80),
    actor: clean(detail.actor, 180),
    crmOnly: true,
    alreadyRolledBack: pendingRows.length === 0,
    safeCount: rows.filter((row: any) => row.safe).length,
    conflictCount: rows.filter((row: any) => !row.safe && !row.restored).length,
    restoredCount: rows.filter((row: any) => row.restored).length,
    totalCount: rows.length,
    rows,
  };
}

export async function applyQuickBooksCrmSyncRollback(context: Context, syncId: string, actor = '', recordId = '') {
  const preview = await previewQuickBooksCrmSyncRollback(context, syncId);
  const requestedRecordId = clean(recordId, 120);
  if (preview.alreadyRolledBack) throw new Error('This sync has already been fully rolled back.');

  let safeRows = preview.rows.filter((row: any) => row.safe);
  if (requestedRecordId) {
    const target = preview.rows.find((row: any) => clean(row?.recordId,120) === requestedRecordId);
    if (!target) throw new Error('That CRM record is not part of this QuickBooks sync recovery snapshot.');
    if (target.restored) throw new Error('That CRM record has already been rolled back from this sync.');
    if (!target.safe) throw new Error(target.reason || 'That CRM record is not safe to restore automatically.');
    safeRows = [target];
  }
  if (!safeRows.length) throw new Error('No CRM records are currently safe to restore.');

  const sales = salesStore(context);
  const records = (((await sales.get('records/index', { type:'json' })) || []) as any[]).filter(Boolean);
  const byId = new Map(records.map((record) => [String(record.id), record]));
  const restored: any[] = [];
  const deleted: any[] = [];

  for (const row of safeRows) {
    if (row.action === 'delete_created') {
      byId.delete(String(row.recordId));
      await sales.delete('records/' + row.recordId);
      deleted.push({ recordId:row.recordId, clientName:row.clientName });
      continue;
    }
    if (row.before) {
      const restoredRecord = jsonClone(row.before);
      byId.set(String(row.recordId), restoredRecord);
      await sales.setJSON('records/' + row.recordId, restoredRecord);
      restored.push({ recordId:row.recordId, clientName:row.clientName });
    }
  }

  const nextRecords = [...byId.values()].slice(0, 1500);
  await sales.setJSON('records/index', nextRecords);

  const integrations = integrationStore(context);
  const detail = await getQuickBooksCrmSyncHistoryDetail(context, syncId);
  const previousRollback = detail?.rollback || {};
  const completedAt = new Date().toISOString();
  const attempt = {
    id:'QBROLLBACK-' + Date.now().toString(36).toUpperCase(),
    completedAt,
    actor:clean(actor,180),
    scope:requestedRecordId ? 'single_client' : 'all_safe',
    recordId:requestedRecordId,
    restored,
    deleted,
  };
  const cumulativeRestored = mergeRollbackEntries(previousRollback?.restored || [], restored);
  const cumulativeDeleted = mergeRollbackEntries(previousRollback?.deleted || [], deleted);
  const completedIds = new Set([
    ...cumulativeRestored.map((row: any) => String(row.recordId)),
    ...cumulativeDeleted.map((row: any) => String(row.recordId)),
  ]);
  const recoveryIds = (Array.isArray(detail?.recovery?.records) ? detail.recovery.records : [])
    .map((row: any) => clean(row?.recordId,120))
    .filter(Boolean);
  const remainingCount = recoveryIds.filter((id: string) => !completedIds.has(id)).length;
  const conflicts = preview.rows
    .filter((row: any) => !row.safe && !row.restored)
    .map((row: any) => ({
      recordId:row.recordId,
      clientName:row.clientName,
      reason:row.reason,
    }));

  const rollback = {
    status: remainingCount === 0 ? 'completed' : 'partial',
    completedAt,
    actor:clean(actor,180),
    restored:cumulativeRestored,
    deleted:cumulativeDeleted,
    conflicts,
    remainingCount,
    attempts:[...(Array.isArray(previousRollback?.attempts) ? previousRollback.attempts : []), attempt].slice(-250),
  };
  const nextDetail = { ...detail, rollback };
  await integrations.setJSON('quickbooks/manual-sync-history/' + clean(syncId,120), nextDetail);

  const index = ((await integrations.get(HISTORY_INDEX_KEY, { type:'json' })) || []) as any[];
  if (index.length) {
    await integrations.setJSON(HISTORY_INDEX_KEY, index.map((row: any) =>
      clean(row?.syncId,120) === clean(syncId,120)
        ? { ...row, rollbackStatus:rollback.status, rolledBackAt:completedAt }
        : row
    ));
  }

  return {
    ...attempt,
    status:rollback.status,
    remainingCount,
    conflicts,
    syncId:clean(syncId,120),
    crmOnly:true,
  };
}
