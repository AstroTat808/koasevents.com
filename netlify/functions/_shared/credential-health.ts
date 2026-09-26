import type { Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { checkResendSendAccess, emailHealthSummary, listResendEmails } from './email-health';
import { verifyQuickBooksCredentials } from './quickbooks';
import { verifyOffice365Credentials } from './office365-calendar-sync';
import { readCredentialWorkspaceAlertTimeline, syncCredentialWorkspaceAlerts } from './workspace-alert-lifecycle';

export type CredentialIssueType =
  | 'Service Failure'
  | 'Authentication Expected'
  | 'Configuration Problem'
  | 'Permission Problem'
  | 'Deployment Problem'
  | 'External Dependency Problem';

export type CredentialHealthRow = {
  id: string;
  provider: string;
  credential: string;
  ok: boolean;
  configured: boolean;
  status: number;
  severity: 'green' | 'yellow' | 'red';
  issueType: CredentialIssueType | null;
  detail: string;
  lastCheckedAt?: string;
  problemSince?: string;
  recommendedAction?: {
    label: string;
    href: string;
    external: boolean;
  } | null;
};

export type CredentialHealthHistoryEvent = {
  id: string;
  credentialId: string;
  provider: string;
  credential: string;
  event: 'became_invalid' | 'changed' | 'recovered';
  occurredAt: string;
  startedAt: string;
  endedAt: string;
  durationMinutes: number | null;
  severity: 'green' | 'yellow' | 'red';
  issueType: CredentialIssueType | null;
  detail: string;
};

type CredentialHealthSample = {
  hour: string;
  at: string;
  rows: Record<string, {
    ok: boolean;
    configured: boolean;
    severity: 'green' | 'yellow' | 'red';
    issueType: CredentialIssueType | null;
  }>;
};

export type CredentialReliabilityThresholds = {
  yellowBelow: number;
  redBelow: number;
};

export type CredentialReliabilityPolicy = {
  evaluationPeriod: '7d';
  minimumSamples: number;
  providers: Record<string, CredentialReliabilityThresholds>;
  updatedAt: string;
  updatedBy: string;
};

type CredentialReliabilityEvent = {
  id: string;
  providerId: string;
  provider: string;
  event: 'reliability_drop' | 'reliability_changed' | 'reliability_recovered';
  occurredAt: string;
  fromSeverity: 'green' | 'yellow' | 'red' | 'insufficient';
  toSeverity: 'green' | 'yellow' | 'red' | 'insufficient';
  percentage: number | null;
  samples: number;
  thresholdYellow: number;
  thresholdRed: number;
  detail: string;
};

export type CredentialSafeRepairAudit = {
  id: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  actor: string;
  attempted: number;
  fixed: number;
  remaining: number;
  fixedIds: string[];
  retested: any[];
  stillRequiresMe: any[];
};

type CredentialHealthOptions = {
  force?: boolean;
  emailHealth?: any;
  credentialId?: string;
};

const CREDENTIAL_IDS = [
  'resend-send',
  'resend-monitoring',
  'quickbooks',
  'microsoft-graph',
  'github',
  'netlify',
] as const;

type CredentialId = (typeof CREDENTIAL_IDS)[number];

const RELIABILITY_PROVIDERS = [
  { id: 'resend', label: 'Resend', credentialIds: ['resend-send', 'resend-monitoring'] },
  { id: 'quickbooks', label: 'QuickBooks', credentialIds: ['quickbooks'] },
  { id: 'microsoft-graph', label: 'Microsoft Graph', credentialIds: ['microsoft-graph'] },
  { id: 'github', label: 'GitHub', credentialIds: ['github'] },
  { id: 'netlify', label: 'Netlify', credentialIds: ['netlify'] },
] as const;

const DEFAULT_RELIABILITY_THRESHOLDS: CredentialReliabilityThresholds = {
  yellowBelow: 99,
  redBelow: 95,
};

const DEFAULT_RELIABILITY_MINIMUM_SAMPLES = 24;
const RELIABILITY_EVENT_LIMIT = 500;

function clean(value: unknown, max=800) {
  return String(value ?? '').trim().slice(0, max);
}

function storeFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-system-health', consistency: 'strong' })
    : getDeployStore({ name: 'koa-system-health' });
}

function classifyCredentialFailure(input: { configured: boolean; status: number; detail: string }): CredentialIssueType {
  const detail = clean(input.detail, 1000).toLowerCase();
  if (!input.configured || /not configured|missing|no company connection|no .* connection/.test(detail)) return 'Configuration Problem';
  if (
    input.status === 401
    || input.status === 403
    || /unauthori[sz]ed|forbidden|permission|consent|invalid_client|invalid grant|invalid_grant|access denied|scope/.test(detail)
  ) return 'Permission Problem';
  if (
    input.status === 408
    || input.status === 429
    || input.status >= 500
    || /timeout|timed out|network|fetch failed|temporarily unavailable|service unavailable|upstream/.test(detail)
  ) return 'External Dependency Problem';
  return 'Configuration Problem';
}

function recommendedAction(id: string, ok: boolean) {
  if (ok) return null;
  const actions: Record<string, { label: string; href: string; external: boolean }> = {
    'resend-send': {
      label: 'Open Resend API keys',
      href: 'https://resend.com/api-keys',
      external: true,
    },
    'resend-monitoring': {
      label: 'Open Resend API keys',
      href: 'https://resend.com/api-keys',
      external: true,
    },
    quickbooks: {
      label: 'Reconnect QuickBooks',
      href: '/admin/quickbooks/',
      external: false,
    },
    'microsoft-graph': {
      label: 'Open Microsoft configuration',
      href: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
      external: true,
    },
    github: {
      label: 'Open GitHub repository settings',
      href: 'https://github.com/AstroTat808/koasevents.com/settings',
      external: true,
    },
    netlify: {
      label: 'View Netlify credential problem',
      href: 'https://app.netlify.com/projects/koasevents-website/configuration/env',
      external: true,
    },
  };
  return actions[id] || null;
}

function normalizeCredentialId(value: unknown): CredentialId | null {
  const id = clean(value, 80) as CredentialId;
  return CREDENTIAL_IDS.includes(id) ? id : null;
}

function resendSendRow(sendAccess: any): CredentialHealthRow {
  const configured = Boolean(sendAccess?.configured);
  const status = Number(sendAccess?.status || 0);
  const detail = clean(sendAccess?.detail || 'Resend send credential verification unavailable.', 800);
  const ok = Boolean(sendAccess?.ok);
  const issueType = ok ? null : classifyCredentialFailure({ configured, status, detail });
  return {
    id: 'resend-send',
    provider: 'Resend',
    credential: 'Sending credential',
    ok,
    configured,
    status,
    severity: ok ? 'green' : issueType === 'External Dependency Problem' ? 'yellow' : 'red',
    issueType,
    detail,
    recommendedAction: recommendedAction('resend-send', ok),
  };
}

function resendMonitoringRow(monitoringAccess: any): CredentialHealthRow {
  const configured = Boolean(monitoringAccess?.configured);
  const status = Number(monitoringAccess?.status || 0);
  const detail = clean(monitoringAccess?.detail || 'Resend monitoring credential verification unavailable.', 800);
  const ok = Boolean(monitoringAccess?.reachable ?? monitoringAccess?.ok);
  const issueType = ok ? null : classifyCredentialFailure({ configured, status, detail });
  return {
    id: 'resend-monitoring',
    provider: 'Resend',
    credential: 'Delivery monitoring credential',
    ok,
    configured,
    status,
    severity: ok ? 'green' : issueType === 'External Dependency Problem' || !configured ? 'yellow' : 'red',
    issueType,
    detail,
    recommendedAction: recommendedAction('resend-monitoring', ok),
  };
}

function quickBooksRow(quickBooks: any): CredentialHealthRow {
  const configured = Boolean(quickBooks?.configured);
  const status = Number(quickBooks?.status || 0);
  const detail = clean(quickBooks?.detail || 'QuickBooks credential verification unavailable.', 800);
  const ok = Boolean(quickBooks?.ok);
  const issueType = ok ? null : classifyCredentialFailure({ configured, status, detail });
  return {
    id: 'quickbooks',
    provider: 'QuickBooks',
    credential: 'OAuth client + company connection',
    ok,
    configured,
    status,
    severity: ok ? 'green' : issueType === 'External Dependency Problem' || !configured || !quickBooks?.connected ? 'yellow' : 'red',
    issueType,
    detail,
    recommendedAction: recommendedAction('quickbooks', ok),
  };
}

function microsoftGraphRow(microsoftGraph: any): CredentialHealthRow {
  const configured = Boolean(microsoftGraph?.configured);
  const status = Number(microsoftGraph?.status || 0);
  const detail = clean(microsoftGraph?.detail || 'Microsoft Graph credential verification unavailable.', 800);
  const ok = Boolean(microsoftGraph?.ok);
  const issueType = ok ? null : classifyCredentialFailure({ configured, status, detail });
  return {
    id: 'microsoft-graph',
    provider: 'Microsoft Graph',
    credential: 'Client credentials + calendar access',
    ok,
    configured,
    status,
    severity: ok ? 'green' : issueType === 'External Dependency Problem' || !configured ? 'yellow' : 'red',
    issueType,
    detail,
    recommendedAction: recommendedAction('microsoft-graph', ok),
  };
}

async function verifyGithubCredential(): Promise<CredentialHealthRow> {
  const token = clean(Netlify.env.get('KOA_GITHUB_READ_TOKEN'), 1000);
  if (!token) {
    const row: CredentialHealthRow = {
      id: 'github',
      provider: 'GitHub',
      credential: 'Repository read token',
      ok: false,
      configured: false,
      status: 0,
      severity: 'yellow',
      issueType: 'Configuration Problem',
      detail: 'KOA_GITHUB_READ_TOKEN is not configured. Public-repository and GitHub Actions OIDC verification may still keep deployment health operational.',
    };
    return { ...row, recommendedAction: recommendedAction(row.id, row.ok) };
  }

  try {
    const response = await fetch('https://api.github.com/repos/AstroTat808/koasevents.com', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'User-Agent': 'KoaEvents-CredentialHealth/1.0',
      },
      signal: AbortSignal.timeout(10000),
    });
    const body: any = await response.json().catch(() => ({}));
    if (response.ok) {
      return {
        id: 'github',
        provider: 'GitHub',
        credential: 'Repository read token',
        ok: true,
        configured: true,
        status: response.status,
        severity: 'green',
        issueType: null,
        detail: 'GitHub repository read credential is valid and can access the production repository.',
        recommendedAction: null,
      };
    }
    const detail = clean(body?.message || 'GitHub credential verification failed.', 800);
    const issueType = classifyCredentialFailure({ configured: true, status: response.status, detail });
    const row: CredentialHealthRow = {
      id: 'github',
      provider: 'GitHub',
      credential: 'Repository read token',
      ok: false,
      configured: true,
      status: response.status,
      severity: issueType === 'External Dependency Problem' ? 'yellow' : 'red',
      issueType,
      detail,
    };
    return { ...row, recommendedAction: recommendedAction(row.id, row.ok) };
  } catch (error) {
    const row: CredentialHealthRow = {
      id: 'github',
      provider: 'GitHub',
      credential: 'Repository read token',
      ok: false,
      configured: true,
      status: 0,
      severity: 'yellow',
      issueType: 'External Dependency Problem',
      detail: error instanceof Error ? clean(error.message, 800) : 'GitHub credential verification failed.',
    };
    return { ...row, recommendedAction: recommendedAction(row.id, row.ok) };
  }
}

async function verifyNetlifyCredential(): Promise<CredentialHealthRow> {
  const token = clean(Netlify.env.get('NETLIFY_AUTH_TOKEN'), 1200);
  if (!token) {
    const row: CredentialHealthRow = {
      id: 'netlify',
      provider: 'Netlify',
      credential: 'API auth token',
      ok: false,
      configured: false,
      status: 0,
      severity: 'yellow',
      issueType: 'Configuration Problem',
      detail: 'NETLIFY_AUTH_TOKEN is not configured for runtime credential checks.',
    };
    return { ...row, recommendedAction: recommendedAction(row.id, row.ok) };
  }

  try {
    const headers = {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
      'User-Agent': 'KoaEvents-CredentialHealth/1.0',
    };
    const userResponse = await fetch('https://api.netlify.com/api/v1/user', {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!userResponse.ok) {
      const body: any = await userResponse.json().catch(() => ({}));
      const detail = clean(body?.message || body?.error || 'Netlify credential verification failed.', 800);
      const issueType = classifyCredentialFailure({ configured: true, status: userResponse.status, detail });
      const row: CredentialHealthRow = {
        id: 'netlify',
        provider: 'Netlify',
        credential: 'API auth token',
        ok: false,
        configured: true,
        status: userResponse.status,
        severity: issueType === 'External Dependency Problem' ? 'yellow' : 'red',
        issueType,
        detail,
      };
      return { ...row, recommendedAction: recommendedAction(row.id, row.ok) };
    }

    const siteId = clean(Netlify.env.get('SITE_ID'), 200);
    if (siteId) {
      const siteResponse = await fetch('https://api.netlify.com/api/v1/sites/' + encodeURIComponent(siteId), {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      if (!siteResponse.ok) {
        const body: any = await siteResponse.json().catch(() => ({}));
        const detail = clean(body?.message || body?.error || 'Netlify token cannot access the current site.', 800);
        const issueType = classifyCredentialFailure({ configured: true, status: siteResponse.status, detail });
        const row: CredentialHealthRow = {
          id: 'netlify',
          provider: 'Netlify',
          credential: 'API auth token',
          ok: false,
          configured: true,
          status: siteResponse.status,
          severity: issueType === 'External Dependency Problem' ? 'yellow' : 'red',
          issueType,
          detail,
        };
        return { ...row, recommendedAction: recommendedAction(row.id, row.ok) };
      }
    }

    return {
      id: 'netlify',
      provider: 'Netlify',
      credential: 'API auth token',
      ok: true,
      configured: true,
      status: 200,
      severity: 'green',
      issueType: null,
      detail: siteId
        ? 'Netlify API credential is valid and can access the current production site.'
        : 'Netlify API credential is valid.',
      recommendedAction: null,
    };
  } catch (error) {
    const row: CredentialHealthRow = {
      id: 'netlify',
      provider: 'Netlify',
      credential: 'API auth token',
      ok: false,
      configured: true,
      status: 0,
      severity: 'yellow',
      issueType: 'External Dependency Problem',
      detail: error instanceof Error ? clean(error.message, 800) : 'Netlify credential verification failed.',
    };
    return { ...row, recommendedAction: recommendedAction(row.id, row.ok) };
  }
}

async function verifyCredentialById(context: Context, id: CredentialId): Promise<CredentialHealthRow> {
  if (id === 'resend-send') return resendSendRow(await checkResendSendAccess());
  if (id === 'resend-monitoring') {
    const monitoring = await listResendEmails();
    return resendMonitoringRow({
      configured: monitoring.configured,
      reachable: monitoring.ok,
      status: monitoring.status,
      detail: monitoring.detail,
    });
  }
  if (id === 'quickbooks') return quickBooksRow(await verifyQuickBooksCredentials(context));
  if (id === 'microsoft-graph') return microsoftGraphRow(await verifyOffice365Credentials());
  if (id === 'github') return verifyGithubCredential();
  return verifyNetlifyCredential();
}

function healthSummaryFromRows(rows: CredentialHealthRow[], generatedAt: string) {
  const red = rows.filter((row) => row.severity === 'red').length;
  const yellow = rows.filter((row) => row.severity === 'yellow').length;
  return {
    generatedAt,
    overall: red ? 'red' : yellow ? 'yellow' : 'green',
    healthy: rows.filter((row) => row.severity === 'green').length,
    attention: yellow,
    critical: red,
    rows,
    note: 'Credential Health validates authentication and permission paths separately from service uptime and operational health.',
  };
}

function stateSignature(row: CredentialHealthRow | null | undefined) {
  if (!row) return '';
  return [
    row.ok ? 'ok' : 'failed',
    row.configured ? 'configured' : 'missing',
    String(row.status || 0),
    String(row.severity || ''),
    String(row.issueType || ''),
  ].join('|');
}

function durationMinutes(startedAt: string, endedAt: string) {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.max(0, Math.round((end - start) / 60000));
}

async function readHistory(context: Context, limit = 200): Promise<CredentialHealthHistoryEvent[]> {
  const rows = ((await storeFor(context).get('credential-health/history', { type: 'json' })) || []) as CredentialHealthHistoryEvent[];
  return rows.slice(0, Math.max(1, Math.min(500, limit)));
}

async function readSamples(context: Context, limit = 2300): Promise<CredentialHealthSample[]> {
  const rows = ((await storeFor(context).get('credential-health/samples', { type: 'json' })) || []) as CredentialHealthSample[];
  return rows.slice(0, Math.max(1, Math.min(2300, limit)));
}

export async function readCredentialSafeRepairHistory(context: Context, limit = 200): Promise<CredentialSafeRepairAudit[]> {
  const rows = ((await storeFor(context).get('credential-health/safe-repair-history', { type: 'json' })) || []) as CredentialSafeRepairAudit[];
  return rows.slice(0, Math.max(1, Math.min(500, limit)));
}

export async function recordCredentialSafeRepairAudit(context: Context, input: any, actor: string) {
  const store = storeFor(context);
  const history = await readCredentialSafeRepairHistory(context, 500);
  const audit: CredentialSafeRepairAudit = {
    id: 'CRF-' + crypto.randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase(),
    startedAt: clean(input?.startedAt, 100) || new Date().toISOString(),
    completedAt: clean(input?.completedAt, 100) || new Date().toISOString(),
    durationMs: Math.max(0, Number(input?.durationMs || 0)),
    actor: clean(actor || 'admin', 180),
    attempted: Math.max(0, Number(input?.attempted || 0)),
    fixed: Math.max(0, Number(input?.fixed || 0)),
    remaining: Math.max(0, Number(input?.remaining || 0)),
    fixedIds: (Array.isArray(input?.fixedIds) ? input.fixedIds : []).map((value: any) => clean(value, 100)).filter(Boolean).slice(0, 30),
    retested: (Array.isArray(input?.retested) ? input.retested : []).map((row: any) => ({
      id: clean(row?.id, 100),
      provider: clean(row?.provider, 100),
      credential: clean(row?.credential, 140),
      fixed: Boolean(row?.fixed),
      changed: Boolean(row?.changed),
      before: {
        ok: Boolean(row?.before?.ok),
        severity: clean(row?.before?.severity, 30),
        issueType: clean(row?.before?.issueType, 100),
        status: Number(row?.before?.status || 0),
      },
      after: {
        ok: Boolean(row?.after?.ok),
        severity: clean(row?.after?.severity, 30),
        issueType: clean(row?.after?.issueType, 100),
        status: Number(row?.after?.status || 0),
      },
    })).slice(0, 30),
    stillRequiresMe: (Array.isArray(input?.stillRequiresMe) ? input.stillRequiresMe : []).map((row: any) => ({
      id: clean(row?.id, 100),
      source: clean(row?.source, 40),
      provider: clean(row?.provider, 100),
      credential: clean(row?.credential, 140),
      name: clean(row?.name, 180),
      issueType: clean(row?.issueType, 100),
      severity: clean(row?.severity, 30),
      requires: clean(row?.requires, 300),
    })).slice(0, 60),
  };
  await store.setJSON('credential-health/safe-repair-history', [audit, ...history].slice(0, 500));
  return audit;
}

export async function credentialReliabilityForRange(context: Context, startAt: string, endAt: string) {
  const samples = await readSamples(context, 2300);
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  const providers = RELIABILITY_PROVIDERS.map((provider) => {
    const observed = samples.filter((sample) => {
      const at = Date.parse(String(sample?.at || sample?.hour || ''));
      return Number.isFinite(at)
        && at >= start
        && at < end
        && provider.credentialIds.every((id) => Boolean(sample?.rows?.[id]));
    });
    const healthy = observed.filter((sample) =>
      provider.credentialIds.every((id) => Boolean(sample.rows[id]?.ok))
    ).length;
    const sampleCount = observed.length;
    return {
      id: provider.id,
      label: provider.label,
      healthySamples: healthy,
      failedSamples: Math.max(0, sampleCount - healthy),
      samples: sampleCount,
      percentage: sampleCount ? Math.round((healthy / sampleCount) * 1000) / 10 : null,
    };
  });
  const values = providers.map((provider) => provider.percentage).filter((value): value is number => typeof value === 'number');
  return {
    startAt,
    endAt,
    providers,
    averagePercentage: values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : null,
  };
}

function defaultReliabilityPolicy(): CredentialReliabilityPolicy {
  return {
    evaluationPeriod: '7d',
    minimumSamples: DEFAULT_RELIABILITY_MINIMUM_SAMPLES,
    providers: Object.fromEntries(
      RELIABILITY_PROVIDERS.map((provider) => [provider.id, { ...DEFAULT_RELIABILITY_THRESHOLDS }]),
    ),
    updatedAt: '',
    updatedBy: '',
  };
}

function normalizedThreshold(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number * 10) / 10)) : fallback;
}

export async function readCredentialReliabilityPolicy(context: Context): Promise<CredentialReliabilityPolicy> {
  const stored: any = await storeFor(context).get('credential-health/reliability-policy', { type: 'json' });
  const defaults = defaultReliabilityPolicy();
  const providers = Object.fromEntries(RELIABILITY_PROVIDERS.map((provider) => {
    const raw = stored?.providers?.[provider.id] || {};
    const yellowBelow = normalizedThreshold(raw?.yellowBelow, defaults.providers[provider.id].yellowBelow);
    const redBelow = normalizedThreshold(raw?.redBelow, defaults.providers[provider.id].redBelow);
    return [provider.id, redBelow < yellowBelow
      ? { yellowBelow, redBelow }
      : { ...defaults.providers[provider.id] }];
  }));
  return {
    evaluationPeriod: '7d',
    minimumSamples: DEFAULT_RELIABILITY_MINIMUM_SAMPLES,
    providers,
    updatedAt: clean(stored?.updatedAt, 100),
    updatedBy: clean(stored?.updatedBy, 180),
  };
}

export async function saveCredentialReliabilityPolicy(
  context: Context,
  input: Record<string, any>,
  actor: string,
): Promise<CredentialReliabilityPolicy> {
  const current = await readCredentialReliabilityPolicy(context);
  const providers: Record<string, CredentialReliabilityThresholds> = {};
  for (const provider of RELIABILITY_PROVIDERS) {
    const raw = input?.[provider.id] || current.providers[provider.id] || DEFAULT_RELIABILITY_THRESHOLDS;
    const yellowBelow = normalizedThreshold(raw?.yellowBelow, current.providers[provider.id].yellowBelow);
    const redBelow = normalizedThreshold(raw?.redBelow, current.providers[provider.id].redBelow);
    if (redBelow >= yellowBelow) {
      throw new Error(provider.label + ': red threshold must be lower than yellow threshold.');
    }
    providers[provider.id] = { yellowBelow, redBelow };
  }
  const policy: CredentialReliabilityPolicy = {
    evaluationPeriod: '7d',
    minimumSamples: DEFAULT_RELIABILITY_MINIMUM_SAMPLES,
    providers,
    updatedAt: new Date().toISOString(),
    updatedBy: clean(actor || 'admin', 180),
  };
  await storeFor(context).setJSON('credential-health/reliability-policy', policy);
  const samples = await readSamples(context, 2300);
  await persistReliabilityEvaluation(context, samples, policy, policy.updatedAt, 'policy-change');
  return policy;
}

async function readReliabilityEvents(context: Context, limit = 300): Promise<CredentialReliabilityEvent[]> {
  const rows = ((await storeFor(context).get('credential-health/reliability-events', { type: 'json' })) || []) as CredentialReliabilityEvent[];
  return rows.slice(0, Math.max(1, Math.min(RELIABILITY_EVENT_LIMIT, limit)));
}

function sampleHour(value: string) {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return '';
  at.setUTCMinutes(0, 0, 0);
  return at.toISOString();
}

function reliabilityPeriod(samples: CredentialHealthSample[], credentialIds: readonly string[], days: number) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const observed = samples.filter((sample) => {
    const at = Date.parse(String(sample?.at || sample?.hour || ''));
    return Number.isFinite(at)
      && at >= cutoff
      && credentialIds.every((id) => Boolean(sample?.rows?.[id]));
  });
  const healthy = observed.filter((sample) =>
    credentialIds.every((id) => Boolean(sample.rows[id]?.ok))
  ).length;
  const sampleCount = observed.length;
  const expectedSamples = days * 24;
  return {
    days,
    percentage: sampleCount ? Math.round((healthy / sampleCount) * 1000) / 10 : null,
    healthySamples: healthy,
    failedSamples: Math.max(0, sampleCount - healthy),
    samples: sampleCount,
    expectedSamples,
    coveragePercent: expectedSamples ? Math.round((sampleCount / expectedSamples) * 1000) / 10 : 0,
  };
}

function reliabilitySeverity(period: any, thresholds: CredentialReliabilityThresholds, minimumSamples: number) {
  const percentage = period?.percentage == null ? null : Number(period.percentage);
  const samples = Number(period?.samples || 0);
  if (percentage == null || samples < minimumSamples) return 'insufficient' as const;
  if (percentage < thresholds.redBelow) return 'red' as const;
  if (percentage < thresholds.yellowBelow) return 'yellow' as const;
  return 'green' as const;
}

function reliabilitySummary(samples: CredentialHealthSample[], policy: CredentialReliabilityPolicy) {
  const providers = RELIABILITY_PROVIDERS.map((provider) => {
    const periods = {
      '7d': reliabilityPeriod(samples, provider.credentialIds, 7),
      '30d': reliabilityPeriod(samples, provider.credentialIds, 30),
      '90d': reliabilityPeriod(samples, provider.credentialIds, 90),
    };
    const thresholds = policy.providers[provider.id] || DEFAULT_RELIABILITY_THRESHOLDS;
    const severity = reliabilitySeverity(periods['7d'], thresholds, policy.minimumSamples);
    return {
      id: provider.id,
      label: provider.label,
      credentialCount: provider.credentialIds.length,
      periods,
      thresholds,
      severity,
      evaluatedPeriod: policy.evaluationPeriod,
      minimumSamples: policy.minimumSamples,
      thresholdActive: severity !== 'insufficient',
    };
  });
  const activeSeverities = providers.map((provider) => provider.severity).filter((severity) => severity !== 'insufficient');
  const overall = activeSeverities.includes('red')
    ? 'red'
    : activeSeverities.includes('yellow')
      ? 'yellow'
      : activeSeverities.length
        ? 'green'
        : 'insufficient';
  return {
    generatedAt: new Date().toISOString(),
    evaluationPeriod: policy.evaluationPeriod,
    minimumSamples: policy.minimumSamples,
    overall,
    providers,
    policy,
    note: 'Reliability thresholds evaluate the rolling 7-day percentage after at least ' + policy.minimumSamples + ' hourly samples. Default warning is below 99% and critical is below 95%; each provider can be configured independently.',
  };
}

async function persistReliabilityEvaluation(
  context: Context,
  samples: CredentialHealthSample[],
  policy: CredentialReliabilityPolicy,
  occurredAt: string,
  source: 'sample' | 'policy-change',
) {
  const store = storeFor(context);
  const summary = reliabilitySummary(samples, policy);
  const stateRaw: any = (await store.get('credential-health/reliability-state', { type: 'json' })) || {};
  const previousState = stateRaw?.providers && typeof stateRaw.providers === 'object' ? stateRaw.providers : {};
  const previousEvents = await readReliabilityEvents(context, RELIABILITY_EVENT_LIMIT);
  const events: CredentialReliabilityEvent[] = [];

  for (const provider of summary.providers) {
    const previous = previousState?.[provider.id] || null;
    const currentSeverity = provider.severity as 'green' | 'yellow' | 'red' | 'insufficient';
    const previousSeverity = (previous?.severity || 'insufficient') as 'green' | 'yellow' | 'red' | 'insufficient';
    if (currentSeverity === previousSeverity) continue;

    const period = provider.periods['7d'];
    const thresholds = provider.thresholds;
    const event = currentSeverity === 'green'
      ? 'reliability_recovered'
      : (previousSeverity === 'green' || previousSeverity === 'insufficient')
        ? 'reliability_drop'
        : 'reliability_changed';

    if (currentSeverity === 'insufficient' && previousSeverity === 'green') continue;
    if (currentSeverity === 'green' && previousSeverity === 'insufficient') continue;

    events.push({
      id: 'CRR-' + crypto.randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase(),
      providerId: provider.id,
      provider: provider.label,
      event,
      occurredAt,
      fromSeverity: previousSeverity,
      toSeverity: currentSeverity,
      percentage: period.percentage == null ? null : Number(period.percentage),
      samples: Number(period.samples || 0),
      thresholdYellow: Number(thresholds.yellowBelow),
      thresholdRed: Number(thresholds.redBelow),
      detail: source === 'policy-change'
        ? 'Reliability state changed after provider thresholds were updated.'
        : 'Rolling 7-day Credential Health reliability crossed a configured threshold.',
    });
  }

  const state = {
    updatedAt: occurredAt,
    providers: Object.fromEntries(summary.providers.map((provider) => [
      provider.id,
      {
        severity: provider.severity,
        percentage: provider.periods['7d'].percentage,
        samples: provider.periods['7d'].samples,
        thresholds: provider.thresholds,
      },
    ])),
  };

  await Promise.all([
    store.setJSON('credential-health/reliability-state', state),
    ...(events.length
      ? [store.setJSON('credential-health/reliability-events', [...events, ...previousEvents].slice(0, RELIABILITY_EVENT_LIMIT))]
      : []),
  ]);
  return summary;
}

async function persistReliabilitySample(context: Context, rows: CredentialHealthRow[], generatedAt: string) {
  const store = storeFor(context);
  const [samples, policy] = await Promise.all([
    readSamples(context, 2300),
    readCredentialReliabilityPolicy(context),
  ]);
  const hour = sampleHour(generatedAt);
  if (!hour) return reliabilitySummary(samples, policy);
  const snapshot: CredentialHealthSample = {
    hour,
    at: generatedAt,
    rows: Object.fromEntries(rows.map((row) => [
      row.id,
      {
        ok: Boolean(row.ok),
        configured: Boolean(row.configured),
        severity: row.severity,
        issueType: row.issueType,
      },
    ])),
  };
  const next = [snapshot, ...samples.filter((sample) => sample.hour !== hour)]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 2300);
  await store.setJSON('credential-health/samples', next);
  return persistReliabilityEvaluation(context, next, policy, generatedAt, 'sample');
}

async function persistRowsWithHistory(
  context: Context,
  previousRows: CredentialHealthRow[],
  incomingRows: CredentialHealthRow[],
  checkedIds: Set<string>,
  generatedAt: string,
) {
  const store = storeFor(context);
  const previousById = new Map(previousRows.map((row) => [row.id, row]));
  const history = await readHistory(context, 500);
  const events: CredentialHealthHistoryEvent[] = [];

  const rows = incomingRows.map((row) => {
    const previous = previousById.get(row.id);
    if (!checkedIds.has(row.id)) return row;

    const previousProblemSince = clean(previous?.problemSince, 100);
    const next: CredentialHealthRow = {
      ...row,
      lastCheckedAt: generatedAt,
      problemSince: row.ok ? '' : previous && !previous.ok ? (previousProblemSince || generatedAt) : generatedAt,
    };

    if (!previous && !row.ok) {
      events.push({
        id: 'CRH-' + crypto.randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase(),
        credentialId: row.id,
        provider: row.provider,
        credential: row.credential,
        event: 'became_invalid',
        occurredAt: generatedAt,
        startedAt: generatedAt,
        endedAt: '',
        durationMinutes: null,
        severity: row.severity,
        issueType: row.issueType,
        detail: row.detail,
      });
    } else if (previous && previous.ok && !row.ok) {
      events.push({
        id: 'CRH-' + crypto.randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase(),
        credentialId: row.id,
        provider: row.provider,
        credential: row.credential,
        event: 'became_invalid',
        occurredAt: generatedAt,
        startedAt: generatedAt,
        endedAt: '',
        durationMinutes: null,
        severity: row.severity,
        issueType: row.issueType,
        detail: row.detail,
      });
    } else if (previous && !previous.ok && row.ok) {
      const startedAt = previousProblemSince || clean(previous.lastCheckedAt, 100) || generatedAt;
      events.push({
        id: 'CRH-' + crypto.randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase(),
        credentialId: row.id,
        provider: row.provider,
        credential: row.credential,
        event: 'recovered',
        occurredAt: generatedAt,
        startedAt,
        endedAt: generatedAt,
        durationMinutes: durationMinutes(startedAt, generatedAt),
        severity: 'green',
        issueType: null,
        detail: 'Credential verification recovered successfully.',
      });
    } else if (previous && !previous.ok && !row.ok && !previousProblemSince) {
      events.push({
        id: 'CRH-' + crypto.randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase(),
        credentialId: row.id,
        provider: row.provider,
        credential: row.credential,
        event: 'became_invalid',
        occurredAt: generatedAt,
        startedAt: generatedAt,
        endedAt: '',
        durationMinutes: null,
        severity: row.severity,
        issueType: row.issueType,
        detail: row.detail,
      });
    } else if (previous && !previous.ok && !row.ok && stateSignature(previous) !== stateSignature(row)) {
      const startedAt = previousProblemSince || clean(previous.lastCheckedAt, 100) || generatedAt;
      events.push({
        id: 'CRH-' + crypto.randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase(),
        credentialId: row.id,
        provider: row.provider,
        credential: row.credential,
        event: 'changed',
        occurredAt: generatedAt,
        startedAt,
        endedAt: '',
        durationMinutes: durationMinutes(startedAt, generatedAt),
        severity: row.severity,
        issueType: row.issueType,
        detail: row.detail,
      });
    }

    return next;
  });

  if (events.length) await store.setJSON('credential-health/history', [...events, ...history].slice(0, 500));
  return rows;
}

function combinedCredentialOverall(currentOverall: unknown, reliabilityOverall: unknown) {
  const current = String(currentOverall || 'green');
  const reliability = String(reliabilityOverall || 'insufficient');
  if (current === 'red' || reliability === 'red') return 'red';
  if (current === 'yellow' || reliability === 'yellow') return 'yellow';
  return 'green';
}

function providerIdForCredential(credentialId: unknown) {
  const id = clean(credentialId, 120);
  if (id.startsWith('resend-')) return 'resend';
  if (id === 'microsoft-graph') return 'microsoft-graph';
  if (id === 'quickbooks') return 'quickbooks';
  if (id === 'github') return 'github';
  if (id === 'netlify') return 'netlify';
  return '';
}

function buildCredentialIncidentTimeline(
  history: CredentialHealthHistoryEvent[],
  reliabilityEvents: CredentialReliabilityEvent[],
  alertRows: any[],
) {
  const rows: any[] = [];

  for (const event of history) {
    const label = event.event === 'recovered'
      ? 'Credential recovered'
      : event.event === 'changed'
        ? 'Credential problem changed'
        : 'Credential became invalid';
    rows.push({
      id: 'credential:' + event.id,
      source: 'credential',
      kind: event.event,
      occurredAt: event.occurredAt,
      providerId: providerIdForCredential(event.credentialId),
      provider: event.provider,
      title: event.provider + ' · ' + event.credential,
      label,
      severity: event.severity,
      detail: event.detail,
      durationMinutes: event.durationMinutes,
    });
  }

  for (const event of reliabilityEvents) {
    const label = event.event === 'reliability_recovered'
      ? 'Reliability recovered'
      : event.event === 'reliability_changed'
        ? 'Reliability severity changed'
        : 'Reliability dropped below threshold';
    rows.push({
      id: 'reliability:' + event.id,
      source: 'reliability',
      kind: event.event,
      occurredAt: event.occurredAt,
      providerId: event.providerId,
      provider: event.provider,
      title: event.provider + ' reliability',
      label,
      severity: event.toSeverity,
      detail: event.detail,
      percentage: event.percentage,
      samples: event.samples,
      thresholdYellow: event.thresholdYellow,
      thresholdRed: event.thresholdRed,
    });
  }

  for (const alert of Array.isArray(alertRows) ? alertRows : []) {
    const alertId = clean(alert?.occurrenceId || alert?.id, 120);
    if (alert?.firstAppearedAt) {
      rows.push({
        id: 'alert-open:' + alertId,
        source: 'alert',
        kind: 'alert_opened',
        occurredAt: String(alert.firstAppearedAt),
        providerId: providerIdForCredential(String(alert?.id || '').replace(/^credential:/, '')),
        provider: clean(alert?.title, 120).replace(/ credential problem$/i, ''),
        title: clean(alert?.title || 'Credential alert', 180),
        label: 'Workspace Alert opened',
        severity: String(alert?.severity || 'upcoming') === 'urgent' ? 'red' : 'yellow',
        detail: clean(alert?.detail || alert?.context || '', 500),
      });
    }
    for (const change of Array.isArray(alert?.severityChanges) ? alert.severityChanges : []) {
      rows.push({
        id: 'alert-change:' + alertId + ':' + clean(change?.at, 80),
        source: 'alert',
        kind: 'alert_severity_changed',
        occurredAt: String(change?.at || ''),
        providerId: providerIdForCredential(String(alert?.id || '').replace(/^credential:/, '')),
        provider: clean(alert?.title, 120).replace(/ credential problem$/i, ''),
        title: clean(alert?.title || 'Credential alert', 180),
        label: 'Workspace Alert severity changed',
        severity: String(change?.to || '') === 'urgent' ? 'red' : 'yellow',
        detail: 'Alert severity changed from ' + clean(change?.from, 40) + ' to ' + clean(change?.to, 40) + '.',
      });
    }
    if (alert?.resolvedAt) {
      rows.push({
        id: 'alert-resolved:' + alertId,
        source: 'alert',
        kind: 'alert_resolved',
        occurredAt: String(alert.resolvedAt),
        providerId: providerIdForCredential(String(alert?.id || '').replace(/^credential:/, '')),
        provider: clean(alert?.title, 120).replace(/ credential problem$/i, ''),
        title: clean(alert?.title || 'Credential alert', 180),
        label: 'Workspace Alert resolved',
        severity: 'green',
        detail: 'The credential alert automatically closed after the underlying problem cleared.',
      });
    }
  }

  const seen = new Set<string>();
  return rows
    .filter((row) => row.occurredAt && Number.isFinite(Date.parse(row.occurredAt)))
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
    .filter((row) => {
      const key = [row.source, row.kind, row.occurredAt, row.title].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 250);
}

async function withHistory(context: Context, summary: any) {
  const [history, samples, policy, reliabilityEvents, alertRows] = await Promise.all([
    readHistory(context, 200),
    readSamples(context, 2300),
    readCredentialReliabilityPolicy(context),
    readReliabilityEvents(context, 300),
    readCredentialWorkspaceAlertTimeline(context),
  ]);
  const reliability = reliabilitySummary(samples, policy);
  return {
    ...summary,
    operationalOverall: String(summary?.overall || 'green'),
    overall: combinedCredentialOverall(summary?.overall, reliability.overall),
    history,
    reliability,
    reliabilityPolicy: policy,
    incidentTimeline: buildCredentialIncidentTimeline(history, reliabilityEvents, alertRows),
  };
}

export async function readCredentialHealthSummary(context: Context) {
  const cached: any = await storeFor(context).get('credential-health/summary', { type: 'json' });
  return cached ? withHistory(context, cached) : null;
}

export async function credentialHealthSummary(context: Context, options: CredentialHealthOptions = {}) {
  const store = storeFor(context);
  const cached: any = await store.get('credential-health/summary', { type: 'json' });
  const cachedAt = Date.parse(String(cached?.generatedAt || ''));
  const requestedId = normalizeCredentialId(options.credentialId);

  if (options.credentialId && !requestedId) {
    throw new Error('Unknown Credential Health check.');
  }

  if (!requestedId && !options.force && Number.isFinite(cachedAt) && Date.now() - cachedAt < 5 * 60 * 1000) {
    return withHistory(context, cached);
  }

  const generatedAt = new Date().toISOString();
  const previousRows = Array.isArray(cached?.rows) ? cached.rows as CredentialHealthRow[] : [];

  if (requestedId && previousRows.length) {
    const checked = await verifyCredentialById(context, requestedId);
    const incoming = previousRows.map((row) => row.id === requestedId ? checked : row);
    const rows = await persistRowsWithHistory(context, previousRows, incoming, new Set([requestedId]), generatedAt);
    const summary = healthSummaryFromRows(rows, generatedAt);
    await Promise.all([
      store.setJSON('credential-health/summary', summary),
      persistReliabilitySample(context, rows, generatedAt),
      syncCredentialWorkspaceAlerts(context, [rows.find((row) => row.id === requestedId)].filter(Boolean)),
    ]);
    return withHistory(context, summary);
  }

  const [emailHealth, quickBooks, microsoftGraph, github, netlify] = await Promise.all([
    options.emailHealth || emailHealthSummary(context, { force: Boolean(options.force) }),
    verifyQuickBooksCredentials(context),
    verifyOffice365Credentials(),
    verifyGithubCredential(),
    verifyNetlifyCredential(),
  ]);

  const incomingRows: CredentialHealthRow[] = [
    resendSendRow(emailHealth?.sendAccess || {}),
    resendMonitoringRow(emailHealth?.monitoringAccess || {}),
    quickBooksRow(quickBooks),
    microsoftGraphRow(microsoftGraph),
    github,
    netlify,
  ];

  const rows = await persistRowsWithHistory(
    context,
    previousRows,
    incomingRows,
    new Set<string>(CREDENTIAL_IDS),
    generatedAt,
  );
  const summary = healthSummaryFromRows(rows, generatedAt);
  await Promise.all([
    store.setJSON('credential-health/summary', summary),
    persistReliabilitySample(context, rows, generatedAt),
    syncCredentialWorkspaceAlerts(context, rows),
  ]);
  return withHistory(context, summary);
}
