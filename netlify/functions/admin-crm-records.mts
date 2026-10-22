import type { Config, Context } from '@netlify/functions';
import { requireCapability } from './_shared/admin';
import { runWithTenant } from './_shared/tenant';
import { conditionalTenantStoreFor } from './_shared/tenant-storage';
import { CrmRecordError, editorSnapshot, persistRecordMutation } from './_shared/crm-record-editor.mjs';

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
export default async (req: Request, context: Context) => {
  if (!['GET', 'POST'].includes(req.method)) return new Response('Method not allowed', { status: 405, headers: { ...headers, Allow: 'GET, POST' } });
  const auth = await requireCapability(req.method === 'GET' ? 'crm.view' : 'crm.manage', req, context);
  if (auth.response) return auth.response;
  const tenant = auth.tenant;
  if (!tenant) return json({ error: 'Organization access is required.', code: 'tenant_required' }, 403);
  return runWithTenant(tenant, async () => {
    try {
      const sales = conditionalTenantStoreFor(context, tenant, 'sales');
      if (req.method === 'GET') {
        const recordId = new URL(req.url).searchParams.get('recordId') || '';
        if (!/^[a-zA-Z0-9_-]{1,120}$/.test(recordId)) return json({ error: 'Select a CRM record.', code: 'invalid_record_id' }, 400);
        const snapshot = await sales.readJSON('records/index');
        const record = (snapshot.data || []).find((row: any) => row.id === recordId);
        if (!record) return json({ error: 'This record is no longer available.', code: 'record_not_found' }, 404);
        return json({ ok: true, editor: editorSnapshot(record) });
      }
      if (req.headers.get('origin') !== new URL(req.url).origin || req.headers.get('sec-fetch-site') === 'cross-site') {
        return json({ error: 'Submit this form from the CRM.', code: 'invalid_origin' }, 403);
      }
      if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: 'JSON is required.', code: 'invalid_content_type' }, 415);
      if (Number(req.headers.get('content-length') || 0) > 16384) return json({ error: 'The form is too large.', code: 'payload_too_large' }, 413);
      const raw = await req.text();
      if (new TextEncoder().encode(raw).byteLength > 16384) return json({ error: 'The form is too large.', code: 'payload_too_large' }, 413);
      let input: unknown;
      try { input = JSON.parse(raw); } catch { return json({ error: 'The form could not be read.', code: 'invalid_json' }, 400); }
      const result = await persistRecordMutation(input, {
        sales, crm: conditionalTenantStoreFor(context, tenant, 'crm'),
        actor: String(auth.user?.email || auth.user?.id || 'staff'), tenantId: tenant.id,
      });
      return json(result);
    } catch (error) {
      if (error instanceof CrmRecordError) return json({ error: error.message, code: error.code, ...error.details }, error.status);
      return json({ error: 'The save could not be confirmed. Retry the same save before creating another record.', code: 'save_unconfirmed' }, 503);
    }
  });
};
export const config: Config = { path: '/api/admin/crm-records' };
