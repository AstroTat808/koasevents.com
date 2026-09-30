import { CRITICAL_INTEGRATION_PROBE_IDS, criticalIntegrationProbePassed } from './critical-integration-release-guard.mjs';

function boolParam(value) {
  return ['1','true','yes','on'].includes(String(value || '').trim().toLowerCase());
}

function parseBoundary(value, endOfDay = false) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? raw + (endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z')
    : raw;
  const time = Date.parse(isoDate);
  if (!Number.isFinite(time)) throw new Error('Invalid audit date: ' + raw);
  return time;
}

export function criticalIntegrationAuditFilters(searchParams) {
  const from = String(searchParams?.get?.('from') || '').trim();
  const to = String(searchParams?.get?.('to') || '').trim();
  const integrationRaw = String(searchParams?.get?.('integration') || '').trim();
  const integration = integrationRaw && integrationRaw !== 'all' ? integrationRaw : '';
  if (integration && !CRITICAL_INTEGRATION_PROBE_IDS.includes(integration)) {
    throw new Error('Unknown Critical Integrations filter: ' + integration);
  }
  const fromMs = parseBoundary(from, false);
  const toMs = parseBoundary(to, true);
  if (fromMs != null && toMs != null && fromMs > toMs) {
    throw new Error('Audit start date must be on or before the end date.');
  }
  return {
    from,
    to,
    fromMs,
    toMs,
    integration,
    failedOnly: boolParam(searchParams?.get?.('failedOnly')),
    rollbackOnly: boolParam(searchParams?.get?.('rollbackOnly')),
  };
}

export function filterCriticalIntegrationAudits(releases, filters = {}) {
  const integration = String(filters.integration || '').trim();
  const fromMs = filters.fromMs == null ? null : Number(filters.fromMs);
  const toMs = filters.toMs == null ? null : Number(filters.toMs);
  const failedOnly = Boolean(filters.failedOnly);
  const rollbackOnly = Boolean(filters.rollbackOnly);

  return (Array.isArray(releases) ? releases : []).flatMap((release) => {
    const releaseAt = Date.parse(String(release?.publishedAt || release?.recordedAt || ''));
    if (fromMs != null && (!Number.isFinite(releaseAt) || releaseAt < fromMs)) return [];
    if (toMs != null && (!Number.isFinite(releaseAt) || releaseAt > toMs)) return [];
    if (rollbackOnly && !release?.rollbackProtection) return [];

    const verification = release?.syntheticProbeVerification || null;
    const probes = Array.isArray(verification?.probes) ? verification.probes : [];
    const selectedProbes = integration
      ? probes.filter((probe) => String(probe?.id || '') === integration)
      : probes;
    if (integration && selectedProbes.length === 0) return [];

    if (failedOnly) {
      const failed = integration
        ? selectedProbes.some((probe) => !criticalIntegrationProbePassed(probe))
        : verification?.status === 'failed' || probes.some((probe) => !criticalIntegrationProbePassed(probe));
      if (!failed) return [];
    }

    return [{
      ...release,
      syntheticProbeVerification: verification
        ? { ...verification, probes: selectedProbes }
        : verification,
    }];
  });
}

export function criticalIntegrationAuditFilterSummary(filters = {}, releaseCount = 0) {
  return {
    from: String(filters.from || ''),
    to: String(filters.to || ''),
    integration: String(filters.integration || ''),
    failedOnly: Boolean(filters.failedOnly),
    rollbackOnly: Boolean(filters.rollbackOnly),
    releaseCount: Number(releaseCount || 0),
  };
}
