export const CRITICAL_INTEGRATION_PROBE_IDS = [
  'synthetic-event-documents',
  'synthetic-vendor-insurance-document',
  'synthetic-quickbooks-webhook',
  'synthetic-signwell-webhook',
];

export function criticalIntegrationProbePassed(row) {
  return Boolean(
    row
    && row.ok === true
    && Number(row.status) === 204
    && String(row.source || '') === 'live'
    && String(row.marker || '') === String(row.expectedMarker || '')
  );
}

export function selectRollbackTargetFromReleases(releases, currentDeployId = '') {
  const current = String(currentDeployId || '').trim();
  return [...(Array.isArray(releases) ? releases : [])]
    .filter((row) => row && String(row.deployId || '').trim())
    .filter((row) => String(row.deployId || '') !== current)
    .filter((row) => row.syntheticProbeVerification?.status === 'passed')
    .filter((row) => {
      const probes = Array.isArray(row.syntheticProbeVerification?.probes)
        ? row.syntheticProbeVerification.probes
        : [];
      return probes.length === CRITICAL_INTEGRATION_PROBE_IDS.length
        && probes.every(criticalIntegrationProbePassed);
    })
    .sort((a, b) => Date.parse(String(b.publishedAt || b.recordedAt || '')) - Date.parse(String(a.publishedAt || a.recordedAt || '')))[0] || null;
}

function passingProbes(checkedAt) {
  const markers = {
    'synthetic-event-documents': 'event-documents',
    'synthetic-vendor-insurance-document': 'vendor-insurance-document',
    'synthetic-quickbooks-webhook': 'quickbooks-webhook',
    'synthetic-signwell-webhook': 'signwell-webhook',
  };
  const names = {
    'synthetic-event-documents': 'Event Documents synthetic probe',
    'synthetic-vendor-insurance-document': 'Vendor Insurance document synthetic probe',
    'synthetic-quickbooks-webhook': 'QuickBooks webhook synthetic probe',
    'synthetic-signwell-webhook': 'SignWell webhook HMAC synthetic probe',
  };
  return CRITICAL_INTEGRATION_PROBE_IDS.map((id) => ({
    id,
    name: names[id] || id,
    ok: true,
    status: 204,
    marker: markers[id] || id,
    expectedMarker: markers[id] || id,
    source: 'live',
    lastLiveCheckedAt: checkedAt,
    detail: 'Safe rollback drill probe passed.',
  }));
}

export function runCriticalIntegrationRollbackDrill(input = {}) {
  const environment = String(input.environment || 'ci-non-production');
  if (environment === 'production') {
    throw new Error('Rollback drill is blocked in production.');
  }

  const startedAt = String(input.startedAt || new Date().toISOString());
  const failedProbeId = CRITICAL_INTEGRATION_PROBE_IDS.includes(String(input.failedProbeId || ''))
    ? String(input.failedProbeId)
    : 'synthetic-signwell-webhook';
  const currentDeployId = String(input.currentDeployId || 'drill-candidate-deploy');
  const currentCommit = String(input.currentCommit || 'drill-candidate-commit');

  const seedReleases = Array.isArray(input.releases) && input.releases.length
    ? input.releases
    : [{
        deployId: 'drill-known-good-deploy',
        commit: 'drill-known-good-commit',
        publishedAt: new Date(Date.parse(startedAt) - 60_000).toISOString(),
        syntheticProbeVerification: {
          checkedAt: startedAt,
          status: 'passed',
          healthyCount: 4,
          totalCount: 4,
          source: 'drill-seed',
          probes: passingProbes(startedAt),
        },
      }];

  const target = selectRollbackTargetFromReleases(seedReleases, currentDeployId);
  if (!target) {
    throw new Error('Rollback drill requires at least one last-known-good release.');
  }

  const failedProbes = passingProbes(startedAt).map((probe) => probe.id === failedProbeId
    ? {
        ...probe,
        ok: false,
        status: 503,
        marker: 'rollback-drill-failure',
        detail: 'Deliberate non-production rollback drill failure.',
      }
    : probe
  );
  const healthyCount = failedProbes.filter(criticalIntegrationProbePassed).length;
  const failedVerification = {
    checkedAt: startedAt,
    status: 'failed',
    healthyCount,
    totalCount: CRITICAL_INTEGRATION_PROBE_IDS.length,
    source: 'non-production-rollback-drill',
    probes: failedProbes,
  };
  const failedAudit = {
    deployId: currentDeployId,
    commit: currentCommit,
    syntheticProbeVerification: failedVerification,
    recorded: true,
  };
  const rollback = {
    policy: 'critical-integrations',
    status: 'simulated-rolled-back',
    fromDeployId: currentDeployId,
    fromCommit: currentCommit,
    targetDeployId: String(target.deployId || ''),
    targetCommit: String(target.commit || ''),
    environment,
    productionMutationAttempted: false,
  };
  const recoveryAt = new Date(Date.parse(startedAt) + 1_000).toISOString();
  const recoveryProbes = passingProbes(recoveryAt);
  const recoveryVerification = {
    checkedAt: recoveryAt,
    status: 'passed',
    healthyCount: 4,
    totalCount: 4,
    source: 'non-production-rollback-drill-recovery',
    probes: recoveryProbes,
  };

  const events = [
    {
      phase: 'detection',
      ok: failedVerification.status === 'failed' && healthyCount === 3,
      detail: failedProbeId + ' deliberately failed with HTTP 503.',
    },
    {
      phase: 'failed-audit',
      ok: failedAudit.recorded === true,
      detail: 'Failed candidate verification was captured before rollback selection.',
    },
    {
      phase: 'rollback',
      ok: rollback.status === 'simulated-rolled-back' && Boolean(rollback.targetDeployId),
      detail: 'Drill selected the same last-known-good target algorithm used by production rollback protection.',
    },
    {
      phase: 'recovery',
      ok: recoveryVerification.status === 'passed' && recoveryProbes.every(criticalIntegrationProbePassed),
      detail: 'All four probes passed after simulated restoration of the known-good release.',
    },
  ];

  return {
    ok: events.every((event) => event.ok),
    environment,
    safe: environment !== 'production' && rollback.productionMutationAttempted === false,
    failedProbeId,
    startedAt,
    failedAudit,
    rollback,
    recoveryVerification,
    events,
  };
}
