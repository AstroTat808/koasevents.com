import type { Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';

export type StaffAuditEntry = {
  id: string;
  createdAt: string;
  actor: string;
  action: string;
  subjectId?: string;
  subjectEmail?: string;
  recordId?: string;
  detail: string;
  metadata?: Record<string, unknown>;
};

function storeFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-staff-audit', consistency: 'strong' })
    : getDeployStore({ name: 'koa-staff-audit' });
}

function clean(value: unknown, max = 1200) {
  return String(value || '').trim().slice(0, max);
}

function auditId() {
  return 'AUD-' + crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase();
}

export async function appendStaffAudit(
  context: Context,
  input: Omit<StaffAuditEntry, 'id' | 'createdAt'>,
) {
  const store = storeFor(context);
  const current = ((await store.get('events/index', { type: 'json' })) || []) as StaffAuditEntry[];
  const entry: StaffAuditEntry = {
    id: auditId(),
    createdAt: new Date().toISOString(),
    actor: clean(input.actor, 240) || 'system',
    action: clean(input.action, 80),
    subjectId: clean(input.subjectId, 160) || undefined,
    subjectEmail: clean(input.subjectEmail, 240) || undefined,
    recordId: clean(input.recordId, 160) || undefined,
    detail: clean(input.detail, 1200),
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : undefined,
  };
  await store.setJSON('events/index', [entry, ...current].slice(0, 5000));
  return entry;
}

export async function readStaffAudit(context: Context, limit = 300) {
  const store = storeFor(context);
  const current = ((await store.get('events/index', { type: 'json' })) || []) as StaffAuditEntry[];
  return current.slice(0, Math.max(1, Math.min(1000, limit)));
}
