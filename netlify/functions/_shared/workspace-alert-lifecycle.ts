import type { Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';

type WorkspaceSeverity = 'urgent' | 'upcoming' | 'info';
type WorkspaceAlertDetail = {
  id: string;
  category: 'healthWarnings';
  severity: WorkspaceSeverity;
  title: string;
  context: string;
  detail: string;
  href: string;
};
type SeverityChange = { at: string; from: WorkspaceSeverity; to: WorkspaceSeverity };
type LifecycleRecord = WorkspaceAlertDetail & {
  occurrenceId: string;
  firstAppearedAt: string;
  lastSeenAt: string;
  severityChanges: SeverityChange[];
  resolvedAt?: string;
};

function clean(value: unknown, max = 220) {
  return String(value ?? '').trim().slice(0, max);
}

function storeFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-workspace-alerts', consistency: 'strong' })
    : getDeployStore({ name: 'koa-workspace-alerts' });
}

function occurrenceId() {
  return 'ALT-' + crypto.randomUUID().replaceAll('-', '').slice(0, 18).toUpperCase();
}

export function credentialWorkspaceAlert(row: any): WorkspaceAlertDetail {
  const severity: WorkspaceSeverity = String(row?.severity || '') === 'red' ? 'urgent' : 'upcoming';
  const provider = clean(row?.provider || row?.id || 'Credential', 100);
  const credential = clean(row?.credential || 'Credential', 120);
  const issueType = clean(row?.issueType || 'Credential problem', 100);
  return {
    id: 'credential:' + clean(row?.id || provider, 100),
    category: 'healthWarnings',
    severity,
    title: provider + ' credential problem',
    context: credential + ' · ' + issueType,
    detail: clean(row?.detail || 'Credential verification failed.', 220),
    href: '/admin/health/#credential-health',
  };
}

export async function syncCredentialWorkspaceAlerts(context: Context, rows: any[]) {
  const input = Array.isArray(rows) ? rows.filter((row) => clean(row?.id, 100)) : [];
  if (!input.length) return;

  const alerts = storeFor(context);
  const now = new Date().toISOString();
  const state: any = (await alerts.get('lifecycle/state', { type: 'json' })) || { active: {} };
  const active: Record<string, LifecycleRecord> = state?.active && typeof state.active === 'object' ? state.active : {};
  const historyRaw: any = await alerts.get('lifecycle/history', { type: 'json' });
  const history: LifecycleRecord[] = Array.isArray(historyRaw) ? historyRaw : [];

  for (const row of input) {
    const credentialId = clean(row?.id, 100);
    const baseId = 'credential:' + credentialId;
    const previous = active[baseId];

    if (row?.ok) {
      if (previous) {
        history.unshift({ ...previous, lastSeenAt: now, resolvedAt: now });
        delete active[baseId];
      }
      continue;
    }

    const alert = credentialWorkspaceAlert(row);
    if (!previous) {
      active[baseId] = {
        ...alert,
        occurrenceId: occurrenceId(),
        firstAppearedAt: now,
        lastSeenAt: now,
        severityChanges: [],
      };
      continue;
    }

    const severityChanges = [...(Array.isArray(previous.severityChanges) ? previous.severityChanges : [])];
    if (previous.severity !== alert.severity) {
      severityChanges.unshift({ at: now, from: previous.severity, to: alert.severity });
    }
    active[baseId] = {
      ...previous,
      ...alert,
      lastSeenAt: now,
      severityChanges: severityChanges.slice(0, 30),
    };
  }

  await Promise.all([
    alerts.setJSON('lifecycle/state', { active, updatedAt: now }),
    alerts.setJSON('lifecycle/history', history.slice(0, 1000)),
  ]);
}

export async function readCredentialWorkspaceAlertTimeline(context: Context) {
  const alerts = storeFor(context);
  const state: any = (await alerts.get('lifecycle/state', { type: 'json' })) || { active: {} };
  const active: Record<string, LifecycleRecord> = state?.active && typeof state.active === 'object' ? state.active : {};
  const historyRaw: any = await alerts.get('lifecycle/history', { type: 'json' });
  const history: LifecycleRecord[] = Array.isArray(historyRaw) ? historyRaw : [];
  const credentialActive = Object.values(active)
    .filter((row) => String(row?.id || '').startsWith('credential:'))
    .map((row) => ({ ...row, status: 'active' as const }));
  const credentialHistory = history
    .filter((row) => String(row?.id || '').startsWith('credential:'))
    .map((row) => ({ ...row, status: 'resolved' as const }));
  return [...credentialActive, ...credentialHistory]
    .sort((a, b) => Date.parse(String(b.resolvedAt || b.lastSeenAt || b.firstAppearedAt || '')) - Date.parse(String(a.resolvedAt || a.lastSeenAt || a.firstAppearedAt || '')))
    .slice(0, 300);
}

export async function syncCredentialWorkspaceAlert(context: Context, row: any) {
  await syncCredentialWorkspaceAlerts(context, [row]);
}
