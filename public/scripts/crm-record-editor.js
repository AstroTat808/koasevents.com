(() => {
  'use strict';
  const dialog = document.querySelector('[data-crm-record-dialog]');
  const tools = document.querySelector('[data-crm-record-tools]');
  if (!dialog || !tools || dialog.dataset.bound) return;
  dialog.dataset.bound = 'true';
  const form = dialog.querySelector('form');
  const $ = selector => dialog.querySelector(selector);
  const field = name => form.elements.namedItem(name);
  const notice = tools.querySelector('[data-crm-record-notice]');
  const save = $('[data-crm-record-save]');
  const state = { projects: [], customers: [], canManage: false, selectedId: '', action: '', recordId: '', revision: '', dirty: false, busy: false, loading: false, locked: false, pending: null, committed: false, opener: null };
  const contactFields = ['name', 'email', 'phone'];
  const projectFields = ['projectName', 'eventDate', 'eventType', 'guestCount'];
  const labels = { 'create-customer': 'New customer', 'create-project': 'New project', 'update-customer': 'Edit customer', 'update-project': 'Edit project' };
  function message(text) { notice.textContent = text; }
  function clearError() {
    $('[data-crm-record-error]').hidden = true;
    $('[data-crm-record-error-message]').textContent = '';
    $('[data-crm-record-matches]').replaceChildren();
    $('[data-crm-record-duplicate-label]').hidden = true;
    $('[data-crm-record-reload]').hidden = true;
    dialog.querySelectorAll('[aria-invalid]').forEach(input => { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); });
  }
  function error(messageText, response = {}) {
    const box = $('[data-crm-record-error]');
    box.hidden = false;
    $('[data-crm-record-error-message]').textContent = messageText;
    $('[data-crm-record-reload]').hidden = !['stale_record', 'record_sync_required'].includes(response.code);
    $('[data-crm-record-duplicate-label]').hidden = response.code !== 'possible_duplicate';
    const matches = $('[data-crm-record-matches]');
    matches.replaceChildren();
    for (const row of response.matches || []) {
      const link = document.createElement('a');
      link.href = '/admin/crm/?record=' + encodeURIComponent(row.id);
      link.textContent = [row.name, row.projectName, row.eventDate, row.id].filter(Boolean).join(' - ');
      link.addEventListener('click', event => { if (state.dirty && !window.confirm('Leave this unsaved form and open the existing record?')) event.preventDefault(); else state.dirty = false; });
      matches.append(link);
    }
    for (const name of Object.keys(response.fields || {})) {
      const input = field(name);
      if (input instanceof HTMLElement) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', 'crm-record-error'); }
    }
    const invalid = dialog.querySelector('[aria-invalid=true]');
    (invalid && !invalid.disabled ? invalid : box).focus();
  }
  function busy(value) {
    state.busy = value;
    save.disabled = value;
    $('[data-crm-record-fields]').disabled = value || state.locked;
    field('confirmDuplicate').disabled = value || state.locked;
    $('[data-crm-record-reload]').disabled = value;
    save.textContent = value ? 'Saving...' : state.locked ? 'Retry the same save' : state.action.startsWith('create-') ? (state.action.endsWith('customer') ? 'Save customer' : 'Save project') : 'Save changes';
  }
  function close() {
    if (state.busy) return;
    if (state.dirty && !window.confirm(state.locked ? 'The save outcome needs verification. Close this form and check the CRM before creating another record?' : 'Discard your unsaved changes?')) return;
    state.dirty = false;
    dialog.close();
    state.opener?.focus?.();
  }
  function customers() {
    const select = field('existingCustomer');
    const selected = select.value;
    const query = $('[data-crm-record-customer-search]').value.trim().toLowerCase();
    select.replaceChildren(new Option('Enter new customer details', ''));
    for (const customer of state.customers) {
      const searchable = [customer.name, customer.email, customer.phone, customer.id].join(' ').toLowerCase();
      if (query && !searchable.includes(query) && customer.id !== selected) continue;
      const suffix = customer.projectCount + ' project' + (customer.projectCount === 1 ? '' : 's');
      select.add(new Option([customer.name || 'Unnamed customer', customer.email || customer.phone || 'Contact details not provided', suffix].join(' - '), customer.id));
    }
    select.value = [...select.options].some(option => option.value === selected) ? selected : '';
  }
  async function request(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20000), ...options });
    const body = await response.json().catch(() => null);
    if (!body) throw new Error('The save response could not be read. Retry the same save.');
    return { response, body };
  }
  async function open(action, recordId = state.selectedId, opener = document.activeElement) {
    if (!state.canManage || state.loading || state.busy || !labels[action]) return;
    if (dialog.open && state.dirty && !window.confirm('Discard the current unsaved changes?')) return;
    state.loading = true;
    let editor = null;
    try {
      if (action.startsWith('update-')) {
        if (!recordId) { message('Select a customer or project first.'); return; }
        message('Loading the current record...');
        const result = await request('/api/admin/crm-records?recordId=' + encodeURIComponent(recordId));
        if (!result.response.ok) throw new Error(result.body.error || 'Unable to open this record.');
        editor = result.body.editor;
      }
      form.reset(); clearError();
      Object.assign(state, { action, recordId: editor?.id || '', revision: editor?.revision || '', dirty: false, pending: null, committed: false, locked: false, opener });
      const creating = action.startsWith('create-');
      const showContact = creating || action === 'update-customer';
      const showProject = action.endsWith('project');
      document.getElementById('crm-record-title').textContent = labels[action];
      document.getElementById('crm-record-description').textContent = action === 'create-customer'
        ? 'Create a customer lead now. An event date and email address are optional; project details can be added later.'
        : action === 'create-project' ? 'Create an event project for a new or existing customer. Leave the date blank while it is undecided.'
        : 'Changes apply to this selected CRM record. Other projects, signed documents, and external accounting records are not rewritten.';
      $('[data-crm-record-contact]').hidden = !showContact;
      $('[data-crm-record-project]').hidden = !showProject;
      $('[data-crm-record-reuse]').hidden = action !== 'create-project';
      $('[data-crm-record-brand]').hidden = !creating;
      contactFields.forEach(name => { field(name).disabled = !showContact; });
      projectFields.forEach(name => { field(name).disabled = !showProject; });
      field('name').required = showContact;
      field('projectName').required = action === 'create-project';
      field('businessLine').disabled = !creating;
      field('existingCustomer').disabled = action !== 'create-project';
      for (const [key, value] of Object.entries(editor?.values || {})) if (field(key)) field(key).value = value ?? '';
      const lockedDate = Boolean(editor?.eventDateLocked);
      field('eventDate').disabled = !showProject || lockedDate;
      $('[data-crm-record-date-lock]').hidden = !lockedDate || !showProject;
      $('[data-crm-record-customer-search]').value = '';
      customers();
      busy(false);
      if (!dialog.open) dialog.showModal();
      message('');
      field(showContact ? 'name' : 'projectName').focus();
    } catch (failure) { message(failure.message || 'Unable to open this record.'); }
    finally { state.loading = false; }
  }
  window.addEventListener('koa:crm-editor-context', event => {
    const context = event.detail || {};
    state.projects = Array.isArray(context.projects) ? context.projects : [];
    state.customers = Array.isArray(context.customers) ? context.customers : [];
    state.canManage = context.canManage === true;
    state.selectedId = context.selectedId || '';
    tools.hidden = !state.canManage;
    document.querySelectorAll('[data-crm-record-action]').forEach(button => {
      button.hidden = !state.canManage;
      button.disabled = button.dataset.crmRecordAction.startsWith('update-') && !state.projects.some(row => row.id === state.selectedId);
    });
    if (!state.canManage && dialog.open) { state.dirty = false; form.reset(); dialog.close(); }
  });
  window.addEventListener('koa:crm-editor-refresh-failed', () => message('The record was saved, but the pipeline could not be refreshed. Reload the CRM to see it; do not create it again.'));
  document.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('[data-crm-record-action]') : null;
    if (button && !button.disabled) open(button.dataset.crmRecordAction, state.selectedId, button);
  });
  $('[data-crm-record-customer-search]').addEventListener('input', customers);
  field('existingCustomer').addEventListener('change', () => {
    const record = state.projects.find(row => row.id === field('existingCustomer').value);
    if (record) contactFields.forEach(name => { field(name).value = record.customer?.[name] || ''; });
    state.dirty = true;
  });
  form.addEventListener('input', () => { if (!state.locked) { state.pending = null; state.dirty = true; } });
  $('[data-crm-record-close]').addEventListener('click', close);
  $('[data-crm-record-cancel]').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  $('[data-crm-record-reload]').addEventListener('click', () => open(state.action, state.recordId, state.opener));
  window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (state.busy || !state.canManage || (!state.locked && !form.reportValidity())) return;
    if (!state.pending) {
      const fields = {};
      for (const name of [...contactFields, ...projectFields, 'businessLine']) if (!field(name).disabled) fields[name] = field(name).value;
      state.pending = { action: state.action, requestId: crypto.randomUUID(), fields,
        ...(state.recordId ? { recordId: state.recordId, expectedRevision: state.revision } : {}),
        ...(state.action === 'create-project' && field('existingCustomer').value ? { sourceCustomerRecordId: field('existingCustomer').value } : {}),
        allowDuplicate: field('confirmDuplicate').checked };
    }
    clearError(); busy(true);
    try {
      const { response, body } = await request('/api/admin/crm-records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.pending) });
      if (!response.ok) {
        // An unknown/server failure may have committed. Freeze the payload for an idempotent retry.
        state.locked = response.status >= 500;
        if (!state.locked) state.pending = null;
        busy(false);
        error(body.error || 'The record could not be saved.', body);
        return;
      }
      state.committed = true;
      if (body.syncPending) {
        state.locked = true;
        busy(false);
        error('The CRM entry was saved, but synchronization is incomplete. Retry the same save before using proposals or invoices for this record.');
        return;
      }
      state.dirty = false; state.locked = false; state.pending = null;
      busy(false); dialog.close(); state.opener?.focus?.();
      message(state.action.startsWith('create-') ? 'Created successfully. Refreshing the client pipeline...' : 'Changes saved. Refreshing the client pipeline...');
      window.dispatchEvent(new CustomEvent('koa:crm-record-saved', { detail: { recordId: body.recordId } }));
    } catch {
      state.locked = true;
      busy(false);
      error('The save could not be confirmed. Your values are preserved. Retry the same save to avoid creating a duplicate.');
    }
  });
  window.addEventListener('koa:crm-editor-refreshed', () => message('Saved successfully. The updated record is selected in the client pipeline.'));
  window.dispatchEvent(new CustomEvent('koa:crm-editor-ready'));
})();
