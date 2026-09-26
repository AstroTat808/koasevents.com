import type { Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { emailHealthSummary } from './email-health';
import { verifyQuickBooksCredentials } from './quickbooks';
import { verifyOffice365Credentials } from './office365-calendar-sync';

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
};

type CredentialHealthOptions = {
  force?: boolean;
  emailHealth?: any;
};

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

async function verifyGithubCredential(): Promise<CredentialHealthRow> {
  const token = clean(Netlify.env.get('KOA_GITHUB_READ_TOKEN'), 1000);
  if (!token) {
    return {
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
      };
    }
    const detail = clean(body?.message || 'GitHub credential verification failed.', 800);
    const issueType = classifyCredentialFailure({ configured: true, status: response.status, detail });
    return {
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
  } catch (error) {
    const detail = error instanceof Error ? clean(error.message, 800) : 'GitHub credential verification failed.';
    return {
      id: 'github',
      provider: 'GitHub',
      credential: 'Repository read token',
      ok: false,
      configured: true,
      status: 0,
      severity: 'yellow',
      issueType: 'External Dependency Problem',
      detail,
    };
  }
}

async function verifyNetlifyCredential(): Promise<CredentialHealthRow> {
  const token = clean(Netlify.env.get('NETLIFY_AUTH_TOKEN'), 1200);
  if (!token) {
    return {
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
      return {
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
        return {
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
    };
  } catch (error) {
    const detail = error instanceof Error ? clean(error.message, 800) : 'Netlify credential verification failed.';
    return {
      id: 'netlify',
      provider: 'Netlify',
      credential: 'API auth token',
      ok: false,
      configured: true,
      status: 0,
      severity: 'yellow',
      issueType: 'External Dependency Problem',
      detail,
    };
  }
}

export async function credentialHealthSummary(context: Context, options: CredentialHealthOptions = {}) {
  const store = storeFor(context);
  const cached: any = await store.get('credential-health/summary', { type: 'json' });
  const cachedAt = Date.parse(String(cached?.generatedAt || ''));
  if (!options.force && Number.isFinite(cachedAt) && Date.now() - cachedAt < 5 * 60 * 1000) return cached;

  const [emailHealth, quickBooks, microsoftGraph, github, netlify] = await Promise.all([
    options.emailHealth || emailHealthSummary(context, { force: Boolean(options.force) }),
    verifyQuickBooksCredentials(context),
    verifyOffice365Credentials(),
    verifyGithubCredential(),
    verifyNetlifyCredential(),
  ]);

  const sendAccess = emailHealth?.sendAccess || {};
  const monitoringAccess = emailHealth?.monitoringAccess || {};

  const resendSendConfigured = Boolean(sendAccess?.configured);
  const resendSendStatus = Number(sendAccess?.status || 0);
  const resendSendDetail = clean(sendAccess?.detail || 'Resend send credential verification unavailable.', 800);
  const resendSendIssue = sendAccess?.ok
    ? null
    : classifyCredentialFailure({ configured: resendSendConfigured, status: resendSendStatus, detail: resendSendDetail });

  const resendMonitoringConfigured = Boolean(monitoringAccess?.configured);
  const resendMonitoringStatus = Number(monitoringAccess?.status || 0);
  const resendMonitoringDetail = clean(monitoringAccess?.detail || 'Resend monitoring credential verification unavailable.', 800);
  const resendMonitoringOk = Boolean(monitoringAccess?.reachable);
  const resendMonitoringIssue = resendMonitoringOk
    ? null
    : classifyCredentialFailure({ configured: resendMonitoringConfigured, status: resendMonitoringStatus, detail: resendMonitoringDetail });

  const quickBooksConfigured = Boolean(quickBooks?.configured);
  const quickBooksStatus = Number(quickBooks?.status || 0);
  const quickBooksDetail = clean(quickBooks?.detail || 'QuickBooks credential verification unavailable.', 800);
  const quickBooksIssue = quickBooks?.ok
    ? null
    : classifyCredentialFailure({ configured: quickBooksConfigured, status: quickBooksStatus, detail: quickBooksDetail });

  const microsoftConfigured = Boolean(microsoftGraph?.configured);
  const microsoftStatus = Number(microsoftGraph?.status || 0);
  const microsoftDetail = clean(microsoftGraph?.detail || 'Microsoft Graph credential verification unavailable.', 800);
  const microsoftIssue = microsoftGraph?.ok
    ? null
    : classifyCredentialFailure({ configured: microsoftConfigured, status: microsoftStatus, detail: microsoftDetail });

  const rows: CredentialHealthRow[] = [
    {
      id: 'resend-send',
      provider: 'Resend',
      credential: 'Sending credential',
      ok: Boolean(sendAccess?.ok),
      configured: resendSendConfigured,
      status: resendSendStatus,
      severity: sendAccess?.ok ? 'green' : resendSendIssue === 'External Dependency Problem' ? 'yellow' : 'red',
      issueType: resendSendIssue,
      detail: resendSendDetail,
    },
    {
      id: 'resend-monitoring',
      provider: 'Resend',
      credential: 'Delivery monitoring credential',
      ok: resendMonitoringOk,
      configured: resendMonitoringConfigured,
      status: resendMonitoringStatus,
      severity: resendMonitoringOk ? 'green' : resendMonitoringIssue === 'External Dependency Problem' || !resendMonitoringConfigured ? 'yellow' : 'red',
      issueType: resendMonitoringIssue,
      detail: resendMonitoringDetail,
    },
    {
      id: 'quickbooks',
      provider: 'QuickBooks',
      credential: 'OAuth client + company connection',
      ok: Boolean(quickBooks?.ok),
      configured: quickBooksConfigured,
      status: quickBooksStatus,
      severity: quickBooks?.ok ? 'green' : quickBooksIssue === 'External Dependency Problem' || !quickBooksConfigured || !quickBooks?.connected ? 'yellow' : 'red',
      issueType: quickBooksIssue,
      detail: quickBooksDetail,
    },
    {
      id: 'microsoft-graph',
      provider: 'Microsoft Graph',
      credential: 'Client credentials + calendar access',
      ok: Boolean(microsoftGraph?.ok),
      configured: microsoftConfigured,
      status: microsoftStatus,
      severity: microsoftGraph?.ok ? 'green' : microsoftIssue === 'External Dependency Problem' || !microsoftConfigured ? 'yellow' : 'red',
      issueType: microsoftIssue,
      detail: microsoftDetail,
    },
    github,
    netlify,
  ];

  const red = rows.filter((row) => row.severity === 'red').length;
  const yellow = rows.filter((row) => row.severity === 'yellow').length;
  const summary = {
    generatedAt: new Date().toISOString(),
    overall: red ? 'red' : yellow ? 'yellow' : 'green',
    healthy: rows.filter((row) => row.severity === 'green').length,
    attention: yellow,
    critical: red,
    rows,
    note: 'Credential Health validates authentication and permission paths separately from service uptime and operational health.',
  };
  await store.setJSON('credential-health/summary', summary);
  return summary;
}
