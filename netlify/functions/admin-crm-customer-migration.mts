import type { Context, Config } from '@netlify/functions';
import { requireAdmin, requireCapability } from './_shared/admin';
import { runWithTenant } from './_shared/tenant';
import { conditionalTenantStoreFor } from './_shared/tenant-storage';
import { IdentityMigrationError } from './_shared/customer-identity-migration.mjs';
import { migrationPreview, migrationAction } from './_shared/customer-identity-workflow.mjs';

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
const allowedActions = new Set(['propose', 'approve', 'apply', 'rollback', 'reconcile']);
export default async (request: Request, context: Context) => {
  if (!['GET', 'POST'].includes(request.method)) return new Response('Method not allowed', {
    status: 405, headers: { ...headers, Allow: 'GET, POST' },
  });
  const auth = request.method === 'GET' ? await requireCapability('crm.view', request, context)
    : await requireAdmin(request, context);
  if (auth.response) return auth.response;
  const tenant = auth.tenant;
  if (!tenant) return json({ error: 'Organization access is required.', code: 'tenant_required' }, 403);
  return runWithTenant(tenant, async () => {
    try {
      const sales = conditionalTenantStoreFor(context, tenant, 'sales');
      const crm = conditionalTenantStoreFor(context, tenant, 'crm');
      if (request.method === 'GET') return json({ ok: true, ...await migrationPreview({ tenantId: tenant.id, sales, crm }) });
      const origin = new URL(request.url).origin;
      if (request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') {
        return json({ error: 'Submit migration changes from the authenticated CRM.', code: 'invalid_origin' }, 403);
      }
      if (!request.headers.get('content-type')?.startsWith('application/json')) {
        return json({ error: 'JSON request required.', code: 'invalid_content_type' }, 415);
      }
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > 2048) return json({ error: 'Request is too large.', code: 'payload_too_large' }, 413);
      let input: any;
      try { input = JSON.parse(raw); } catch { return json({ error: 'Invalid migration request.', code: 'invalid_json' }, 400); }
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['action', 'planId', 'confirmation'].includes(key))) {
        return json({ error: 'Only migration action, plan ID and confirmation are accepted.', code: 'invalid_request' }, 400);
      }
      const action = String(input.action || '');
      if (!allowedActions.has(action)) return json({ error: 'Unknown migration action.', code: 'invalid_action' }, 400);
      const requiredConfirmation = ({ propose: 'PROPOSE', approve: 'APPROVE', apply: 'APPLY', rollback: 'ROLLBACK', reconcile: 'RECONCILE' } as Record<string,string>)[action];
      if (input.confirmation !== requiredConfirmation) return json({ error: 'Explicit migration confirmation is required.', code: 'confirmation_required' }, 422);
      const actorId = String(auth.user?.id || auth.user?.email || '');
      const result = await migrationAction({ action, planId: String(input.planId || ''), tenantId: tenant.id, actorId, sales, crm });
      return json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof IdentityMigrationError) return json({ error: error.message, code: error.code }, error.status);
      return json({ error: 'The migration outcome could not be confirmed. Refresh migration history before trying again.', code: 'migration_unconfirmed' }, 503);
    }
  });
};
export const config: Config = { path: '/api/admin/crm-customer-migration' };
