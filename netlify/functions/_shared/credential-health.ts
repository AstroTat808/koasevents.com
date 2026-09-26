import type { Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { checkResendSendAccess, emailHealthSummary, listResendEmails } from './email-health';
import { verifyQuickBooksCredentials } from './quickbooks';
import { verifyOffice365Credentials } from './office365-calendar-sync';
import { syncCredentialWorkspaceAlerts } from './workspace-alert-lifecycle';

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

function sampleHour(value: string) {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return '';
  at.setUTCMinutes(0, 0, 0);
  return at.toISOString();
}

async function persistReliabilitySample(context: Context, rows: CredentialHealthRow[], generatedAt: string) {
  const store = storeFor(context);
  const samples = await readSamples(context, 2300);
  const hour = sampleHour(generatedAt);
  if (!hour) return;
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

function reliabilitySummary(samples: CredentialHealthSample[]) {
  return {
    generatedAt: new Date().toISOString(),
    providers: RELIABILITY_PROVIDERS.map((provider) => ({
      id: provider.id,
      label: provider.label,
      credentialCount: provider.credentialIds.length,
      periods: {
        '7d': reliabilityPeriod(samples, provider.credentialIds, 7),
        '30d': reliabilityPeriod(samples, provider.credentialIds, 30),
        '90d': reliabilityPeriod(samples, provider.credentialIds, 90),
      },
    })),
    note: 'Reliability is the percentage of observed hourly Credential Health samples that were healthy. Coverage grows as hourly history accumulates.',
  };
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

async function withHistory(context: Context, summary: any) {
  const [history, samples] = await Promise.all([
    readHistory(context, 200),
    readSamples(context, 2300),
  ]);
  return {
    ...summary,
    history,
    reliability: reliabilitySummary(samples),
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
