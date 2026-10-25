import { createHash } from 'node:crypto';
import { buildCustomerDirectory } from './customer-directory.mjs';

export class CrmRecordError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'CrmRecordError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
const CONTACT = ['name', 'email', 'phone'];
const PROJECT = ['projectName', 'eventDate', 'eventType', 'guestCount'];
const ACTIONS = new Set(['create-customer', 'create-project', 'update-customer', 'update-project']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
  : object(value) ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'
  : JSON.stringify(value);
export const recordRevision = record => createHash('sha256').update(stable(record)).digest('hex');
const fail = (field, message) => { throw new CrmRecordError(422, 'validation_failed', message, { fields: { [field]: message } }); };
function text(value, field, max, required = false) {
  if (typeof value !== 'string') fail(field, 'Enter a text value for ' + field + '.');
  const result = value.trim();
  if (required && !result) fail(field, field === 'name' ? 'Enter the customer name.' : 'Enter a project name.');
  if (result.length > max) fail(field, field + ' must be ' + max + ' characters or fewer.');
  if (/[\x00-\x1f\x7f<>]/.test(result)) fail(field, 'Remove markup or control characters from ' + field + '.');
  return result;
}
export function eventDateLocked(record) {
  return record?.kind === 'proposal' || ['proposal', 'booked'].includes(record?.stage)
    || Boolean(record?.proposal?.publicToken || record?.booking?.contract || record?.booking?.payments?.length);
}
export function editorSnapshot(record) {
  return {
    id: record.id,
    revision: recordRevision(record),
    eventDateLocked: eventDateLocked(record),
    values: {
      name: record.customer?.name || '', email: record.customer?.email || '', phone: record.customer?.phone || '',
      projectName: record.projectName || '', eventDate: record.customer?.eventDate || '',
      eventType: record.inquiry?.eventType || '', guestCount: record.inquiry?.guestCount ?? '',
      businessLine: record.businessLine || (String(record.source || '').includes('mobile-bar') ? 'mobile-bar'
        : String(record.source || '').includes('wild-ones') ? 'wild-ones' : 'events'),
    },
  };
}
function validatedFields(action, values) {
  if (!object(values)) fail('form', 'The form data is invalid.');
  const creating = action.startsWith('create-');
  const allowed = new Set(creating ? [...CONTACT, ...(action === 'create-project' ? PROJECT : []), 'businessLine']
    : action === 'update-customer' ? CONTACT : PROJECT);
  for (const key of Object.keys(values)) if (!allowed.has(key)) fail(key, 'This field cannot be changed with this form.');
  if (!Object.keys(values).length) fail('form', 'Enter at least one field to save.');
  const fields = {};
  for (const key of Object.keys(values)) {
    if (key === 'guestCount') {
      const raw = values[key];
      if (raw === '' || raw === null) { fields[key] = ''; continue; }
      if (!['string', 'number'].includes(typeof raw) || (typeof raw === 'string' && !/^\d+$/.test(raw))) fail(key, 'Enter a whole-number guest count.');
      const count = Number(raw);
      if (!Number.isSafeInteger(count) || count < 1 || count > 100000) fail(key, 'Guest count must be between 1 and 100,000, or left blank.');
      fields[key] = count;
      continue;
    }
    const max = { name: 180, email: 254, phone: 60, projectName: 180, eventDate: 10, eventType: 120, businessLine: 20 }[key];
    fields[key] = text(values[key], key, max, key === 'name' || (key === 'projectName' && action === 'create-project'));
    if (key === 'email') {
      fields[key] = fields[key].toLowerCase();
      if (fields[key] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields[key])) fail(key, 'Enter a valid email address, or leave it blank.');
    }
    if (key === 'phone' && fields[key]) {
      const digits = fields[key].replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 20 || !/^[\d+() .\-xext#]+$/i.test(fields[key])) fail(key, 'Enter a valid phone number, including area code.');
    }
    if (key === 'eventDate' && fields[key]) {
      const parsed = new Date(fields[key] + 'T12:00:00Z');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fields[key]) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== fields[key]) fail(key, 'Enter a valid calendar date.');
    }
    if (key === 'businessLine' && !['events', 'mobile-bar', 'wild-ones'].includes(fields[key])) fail(key, 'Select a business line.');
  }
  if (creating && !fields.name) fail('name', 'Enter the customer name.');
  if (action === 'create-project' && !fields.projectName) fail('projectName', 'Enter a project name.');
  return fields;
}
function sameIdentity(a, b) {
  const email = value => String(value || '').trim().toLowerCase();
  const phone = value => { const n = String(value || '').replace(/\D/g, ''); return n.length === 11 && n.startsWith('1') ? n.slice(1) : n; };
  const name = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return Boolean((email(a.email) && email(a.email) === email(b.email))
    || (phone(a.phone) && phone(a.phone) === phone(b.phone))
    || (!email(a.email) && !phone(a.phone) && name(a.name) && name(a.name) === name(b.name)));
}
export function prepareRecordMutation(records, input, { actor, tenantId, now = new Date().toISOString() }) {
  if (!Array.isArray(records) || records.some(row => !object(row) || (row.tenantId && row.tenantId !== tenantId))) {
    throw new CrmRecordError(409, 'invalid_record_index', 'The CRM index needs review before it can be edited.');
  }
  if (!object(input) || !ACTIONS.has(input.action)) throw new CrmRecordError(400, 'invalid_action', 'Choose a supported CRM action.');
  const allowed = new Set(['action', 'requestId', 'recordId', 'expectedRevision', 'fields', 'allowDuplicate', 'sourceCustomerRecordId']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new CrmRecordError(400, 'invalid_request', 'The request contains unsupported fields.');
  if (!UUID.test(String(input.requestId || ''))) throw new CrmRecordError(400, 'invalid_request_id', 'Refresh the form before saving.');
  if (input.allowDuplicate !== undefined && typeof input.allowDuplicate !== 'boolean') fail('form', 'Duplicate confirmation must be explicit.');
  if (!actor || !tenantId) throw new Error('An authenticated actor and tenant are required.');
  const fields = validatedFields(input.action, input.fields);
  const creating = input.action.startsWith('create-');
  const requestHash = recordRevision({ action: input.action, fields, recordId: input.recordId || '', sourceCustomerRecordId: input.sourceCustomerRecordId || '', actor });
  // A retry after a lost response returns the existing result, never a second customer/project.
  const prior = records.find(row => row.crmManualHistory?.some(entry => entry.requestId === input.requestId));
  if (prior) {
    const entry = prior.crmManualHistory.find(row => row.requestId === input.requestId);
    if (entry.requestHash !== requestHash) throw new CrmRecordError(409, 'request_reused', 'This save request was already used for different changes. Reopen the form.');
    return { record: prior, records, changed: false, replay: true, changedFields: entry.fields };
  }
  let record;
  if (creating) {
    if (input.recordId || input.expectedRevision) fail('form', 'New records cannot overwrite an existing record.');
    const directory = buildCustomerDirectory(records, { tenantId });
    const selectedCustomer = input.sourceCustomerRecordId ? directory.customers.find(customer => customer.recordIds.includes(input.sourceCustomerRecordId) || customer.id === input.sourceCustomerRecordId) : null;
    if (input.sourceCustomerRecordId && !selectedCustomer) throw new CrmRecordError(404, 'customer_not_found', 'The selected customer is no longer available.');
    if (selectedCustomer && input.action !== 'create-project') fail('sourceCustomerRecordId', 'Select an existing customer only when creating a project.');
    if (selectedCustomer && !sameIdentity(fields, selectedCustomer)) throw new CrmRecordError(409, 'customer_identity_mismatch', 'The selected customer details changed or do not match. Re-select the customer before saving.');
    const matches = records.filter(row => sameIdentity(fields, row.customer || {}) && (input.action === 'create-customer'
      || (row.kind !== 'lead' && (row.customer?.eventDate || '') === (fields.eventDate || '')
        && editorSnapshot(row).values.businessLine === (fields.businessLine || 'events'))));
    if (matches.length && input.allowDuplicate !== true) {
      throw new CrmRecordError(409, 'possible_duplicate', 'A matching CRM record already exists. Review it before creating another.', {
        matches: matches.slice(0, 10).map(row => ({ id: row.id, name: row.customer?.name || '', eventDate: row.customer?.eventDate || '', projectName: row.projectName || '' })),
      });
    }
    const customerOnly = input.action === 'create-customer';
    record = {
      id: (customerOnly ? 'LEAD-' : 'INQ-') + createHash('sha256').update(tenantId + ':' + input.requestId).digest('hex').slice(0, 24).toUpperCase(),
      tenantId, kind: customerOnly ? 'lead' : 'inquiry', stage: customerOnly ? 'lead' : 'inquiry', status: 'new',
      source: 'crm-manual-entry', businessLine: fields.businessLine || 'events',
      customer: { name: fields.name, email: fields.email || '', phone: fields.phone || '', eventDate: fields.eventDate || '' },
      inquiry: { formName: 'crm-manual-entry', eventType: fields.eventType || '', guestCount: fields.guestCount ?? '' },
      projectName: fields.projectName || '', createdAt: now, createdBy: actor,
      customerId: selectedCustomer?.id || ('CUST-' + createHash('sha256').update(tenantId + ':customer:' + input.requestId).digest('hex').slice(0, 24).toUpperCase()),
      ...(selectedCustomer ? { customerReferenceId: selectedCustomer.primaryRecordId } : {}),
    };
  } else {
    record = records.find(row => row.id === input.recordId);
    if (!record) throw new CrmRecordError(404, 'record_not_found', 'This CRM record was removed or moved to Trash.');
    if (typeof input.expectedRevision !== 'string' || input.expectedRevision !== recordRevision(record)) throw new CrmRecordError(409, 'stale_record', 'This record changed after you opened the form. Reload it before saving; your edits have not been applied.');
    if ('eventDate' in fields && fields.eventDate !== (record.customer?.eventDate || '') && eventDateLocked(record)) throw new CrmRecordError(409, 'date_change_requires_booking_review', 'This date is tied to a proposal or booking. Change it through the booking review process, not this contact editor.', { fields: { eventDate: 'Proposal/booking date changes require review.' } });
    record = structuredClone(record);
    if (input.action === 'update-customer') record.customer = { ...record.customer, ...fields };
    else {
      if ('projectName' in fields) record.projectName = fields.projectName;
      if ('eventDate' in fields) record.customer = { ...record.customer, eventDate: fields.eventDate };
      record.inquiry = { ...record.inquiry,
        ...('eventType' in fields ? { eventType: fields.eventType } : {}),
        ...('guestCount' in fields ? { guestCount: fields.guestCount } : {}),
      };
    }
  }
  record.updatedAt = now;
  record.updatedBy = actor;
  record.crmManualHistory = [...(record.crmManualHistory || []), { requestId: input.requestId, requestHash,
    action: input.action, actor, at: now, fields: Object.keys(fields), duplicateConfirmed: input.allowDuplicate === true }];
  return { record, records: creating ? [record, ...records] : records.map(row => row.id === record.id ? record : row),
    changed: true, replay: false, changedFields: Object.keys(fields) };
}

// Index commits use ETags. Record copies and timeline entries are recoverable,
// idempotent projections; a partial projection never gets reported as fully synced.
export async function persistRecordMutation(input, { sales, crm, actor, tenantId, now = new Date().toISOString() }) {
  let result;
  const warnings = new Set();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const snapshot = await sales.readJSON('records/index');
    const rows = snapshot.data ?? [];
    result = prepareRecordMutation(rows, input, { actor, tenantId, now });
    if (result.replay) break;
    const previous = rows.find(row => row.id === result.record.id);
    const copy = await sales.readJSON('records/' + result.record.id);
    if (copy.data && recordRevision(copy.data) !== recordRevision(previous ?? result.record)) {
      throw new CrmRecordError(409, 'record_sync_required', 'The CRM record copies differ. This edit was not saved; reconcile the record before editing.');
    }
    const entry = result.record.crmManualHistory.at(-1);
    entry.previousRevision = previous ? recordRevision(previous) : '';
    const committed = await sales.writeJSON('records/index', result.records, snapshot.etag);
    if (committed.modified) {
      break;
    }
    result = null;
  }
  if (!result) throw new CrmRecordError(409, 'busy_record_index', 'Other CRM changes were saved at the same time. Retry this save.');
  const recordId = result.record.id;
  let synced = false;
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const latest = await sales.readJSON('records/index');
      const record = latest.data?.find(row => row.id === recordId);
      if (!record) break; // Do not recreate a concurrently deleted record.
      const copy = await sales.readJSON('records/' + recordId);
      const copyRevision = copy.data ? recordRevision(copy.data) : '';
      const targetRevision = recordRevision(record);
      if (copyRevision === targetRevision) { result.record = record; synced = true; break; }
      const knownPrior = !copy.data || record.crmManualHistory?.some(row => row.previousRevision === copyRevision);
      if (!knownPrior) break; // Never overwrite a newer/independent writer's record copy.
      const written = await sales.writeJSON('records/' + recordId, record, copy.etag);
      if (!written.modified) continue;
      const verified = await sales.readJSON('records/index');
      const current = verified.data?.find(row => row.id === recordId);
      if (current && recordRevision(current) === targetRevision) { result.record = current; synced = true; break; }
    }
  } catch { /* The committed audit record supports a safe retry. */ }
  if (!synced) warnings.add('record_sync_pending');
  try {
    let recorded = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const snapshot = await crm.readJSON('activity/index');
      const entries = snapshot.data ?? [];
      if (!Array.isArray(entries)) break;
      const id = 'MANUAL-' + input.requestId;
      if (entries.some(row => row.id === id)) { recorded = true; break; }
      const entry = result.record.crmManualHistory.find(row => row.requestId === input.requestId);
      const activity = { id, recordId, type: input.action.replaceAll('-', '_'), createdAt: entry?.at || now,
        detail: input.action.replaceAll('-', ' ') + ' by ' + actor + '. Fields: ' + result.changedFields.join(', ') + '.' };
      const saved = await crm.writeJSON('activity/index', [activity, ...entries], snapshot.etag);
      if (saved.modified) { recorded = true; break; }
    }
    if (!recorded) warnings.add('activity_sync_pending');
  } catch { warnings.add('activity_sync_pending'); }
  // Retry compatibility projections even when the canonical operation already exists.
  for (const [store, key] of [[sales, 'records/index'], [sales, 'records/' + recordId], [crm, 'activity/index']]) {
    try { if (!await store.mirrorJSON(key)) warnings.add('compatibility_sync_pending'); }
    catch { warnings.add('compatibility_sync_pending'); }
  }
  return { ok: true, recordId, replay: result.replay, editor: editorSnapshot(result.record), warnings: [...warnings], syncPending: warnings.size > 0 };
}
