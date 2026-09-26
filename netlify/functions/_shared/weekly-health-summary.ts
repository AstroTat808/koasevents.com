import type { Context } from '@netlify/functions';
import {
  readLatestHealth,
  readUptimeHistory,
} from './system-health';
import {
  credentialReliabilityForRange,
  readCredentialHealthSummary,
  readCredentialSafeRepairHistory,
} from './credential-health';

function round(value: number, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function pctDelta(current: number | null, previous: number | null) {
  if (current == null || previous == null) return null;
  return round(current - previous, 1);
}

function within(at: unknown, start: number, end: number) {
  const value = Date.parse(String(at || ''));
  return Number.isFinite(value) && value >= start && value < end;
}

function uptimeForRange(history: any[], startAt: string, endAt: string) {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  const snapshots = (Array.isArray(history) ? history : []).filter((row) => within(row?.checkedAt, start, end));
  let totalChecks = 0;
  let healthyChecks = 0;
  for (const snapshot of snapshots) {
    for (const check of Array.isArray(snapshot?.checks) ? snapshot.checks : []) {
      totalChecks += 1;
      if (check?.ok) healthyChecks += 1;
    }
  }
  const expectedHours = Math.max(1, Math.round((end - start) / 3600000));
  return {
    startAt,
    endAt,
    percentage: totalChecks ? round((healthyChecks / totalChecks) * 100, 2) : null,
    healthyChecks,
    failedChecks: Math.max(0, totalChecks - healthyChecks),
    totalChecks,
    hourlySamples: snapshots.length,
    expectedHours,
    coveragePercent: round((snapshots.length / expectedHours) * 100, 1),
  };
}

function incidentIntervals(history: any[]) {
  const hourly = (Array.isArray(history) ? history : [])
    .filter((row) => Number.isFinite(Date.parse(String(row?.checkedAt || ''))))
    .sort((a, b) => Date.parse(String(a.checkedAt)) - Date.parse(String(b.checkedAt)));

  const componentIds = new Set<string>();
  const names = new Map<string, string>();
  for (const snapshot of hourly) {
    for (const check of Array.isArray(snapshot?.checks) ? snapshot.checks : []) {
      const id = String(check?.id || '');
      if (!id) continue;
      componentIds.add(id);
      if (!names.has(id)) names.set(id, String(check?.name || id));
    }
  }

  const intervals: any[] = [];
  for (const id of componentIds) {
    let active: any = null;
    for (const snapshot of hourly) {
      const check = (Array.isArray(snapshot?.checks) ? snapshot.checks : []).find((row: any) => String(row?.id || '') === id);
      if (!check) continue;
      const at = Date.parse(String(snapshot.checkedAt));
      if (!check.ok && !active) {
        active = { componentId: id, componentName: names.get(id) || id, startedAt: snapshot.checkedAt, startedMs: at };
      } else if (check.ok && active) {
        intervals.push({ ...active, endedAt: snapshot.checkedAt, endedMs: at, ongoing: false });
        active = null;
      }
    }
    if (active) intervals.push({ ...active, endedAt: '', endedMs: Date.now(), ongoing: true });
  }
  return intervals;
}

function incidentsForRange(intervals: any[], startAt: string, endAt: string) {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  const overlapping = intervals.filter((incident) => {
    const incidentStart = Number(incident?.startedMs || Date.parse(String(incident?.startedAt || '')));
    const incidentEnd = Number(incident?.endedMs || Date.parse(String(incident?.endedAt || '')) || Date.now());
    return Number.isFinite(incidentStart) && Number.isFinite(incidentEnd) && incidentEnd > start && incidentStart < end;
  });
  const rows = overlapping.map((incident) => {
    const incidentStart = Number(incident?.startedMs || Date.parse(String(incident?.startedAt || '')));
    const incidentEnd = Number(incident?.endedMs || Date.parse(String(incident?.endedAt || '')) || Date.now());
    const overlapStart = Math.max(start, incidentStart);
    const overlapEnd = Math.min(end, incidentEnd);
    return {
      componentId: String(incident?.componentId || ''),
      componentName: String(incident?.componentName || ''),
      startedAt: String(incident?.startedAt || ''),
      endedAt: String(incident?.endedAt || ''),
      ongoing: Boolean(incident?.ongoing),
      downtimeMinutes: Math.max(0, Math.round((overlapEnd - overlapStart) / 60000)),
    };
  });
  return {
    incidentCount: rows.length,
    downtimeMinutes: rows.reduce((sum, row) => sum + Number(row.downtimeMinutes || 0), 0),
    rows: rows.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, 40),
  };
}

function repairsForRange(history: any[], startAt: string, endAt: string) {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  const rows = (Array.isArray(history) ? history : []).filter((row) => within(row?.completedAt || row?.startedAt, start, end));
  return {
    runs: rows.length,
    attempted: rows.reduce((sum, row) => sum + Number(row?.attempted || 0), 0),
    fixed: rows.reduce((sum, row) => sum + Number(row?.fixed || 0), 0),
    remainingAfterRuns: rows.reduce((sum, row) => sum + Number(row?.remaining || 0), 0),
    rows: rows.slice(0, 25),
  };
}

function unresolvedProblems(latest: any, credentialHealth: any) {
  const credentialIds = new Set(['email-send-access', 'email-monitoring-access']);
  const system = (Array.isArray(latest?.checks) ? latest.checks : [])
    .filter((row: any) => !credentialIds.has(String(row?.id || '')))
    .filter((row: any) => String(row?.issueType || '') !== 'Authentication Expected')
    .filter((row: any) => !row?.ok || ['yellow', 'red'].includes(String(row?.severity || '')))
    .map((row: any) => ({
      source: 'system',
      id: String(row?.id || ''),
      name: String(row?.name || row?.id || 'System Health check'),
      severity: String(row?.severity || (!row?.ok ? 'red' : 'yellow')),
      issueType: String(row?.issueType || 'Service Failure'),
      detail: String(row?.detail || ''),
    }));

  const credentials = (Array.isArray(credentialHealth?.rows) ? credentialHealth.rows : [])
    .filter((row: any) => !row?.ok)
    .map((row: any) => ({
      source: 'credential',
      id: String(row?.id || ''),
      name: String(row?.provider || 'Credential') + ' · ' + String(row?.credential || 'Credential'),
      severity: String(row?.severity || 'yellow'),
      issueType: String(row?.issueType || 'Credential problem'),
      detail: String(row?.detail || ''),
    }));

  const rows = [...credentials, ...system].sort((a, b) => {
    const rank = (value: string) => value === 'red' ? 0 : value === 'yellow' ? 1 : 2;
    return rank(a.severity) - rank(b.severity) || a.name.localeCompare(b.name);
  });
  return {
    count: rows.length,
    critical: rows.filter((row) => row.severity === 'red').length,
    attention: rows.filter((row) => row.severity !== 'red').length,
    rows,
  };
}

function comparisonItem(
  metric: string,
  current: number | null,
  previous: number | null,
  betterWhenHigher: boolean,
  unit: string,
  threshold = 0.05,
) {
  if (current == null || previous == null) return null;
  const delta = round(current - previous, unit === '%' ? 1 : 0);
  if (Math.abs(delta) < threshold) return null;
  const improved = betterWhenHigher ? delta > 0 : delta < 0;
  return {
    metric,
    direction: improved ? 'improved' : 'worsened',
    current,
    previous,
    delta,
    unit,
  };
}

export async function weeklySystemHealthExecutiveSummary(context: Context) {
  const now = new Date();
  const currentEnd = now.toISOString();
  const currentStart = new Date(now.getTime() - 7 * 86400000).toISOString();
  const previousEnd = currentStart;
  const previousStart = new Date(now.getTime() - 14 * 86400000).toISOString();

  const [uptimeHistory, latest, credentialHealth, repairHistory, currentCredential, previousCredential] = await Promise.all([
    readUptimeHistory(context, 2300),
    readLatestHealth(context),
    readCredentialHealthSummary(context),
    readCredentialSafeRepairHistory(context, 500),
    credentialReliabilityForRange(context, currentStart, currentEnd),
    credentialReliabilityForRange(context, previousStart, previousEnd),
  ]);

  const currentUptime = uptimeForRange(uptimeHistory, currentStart, currentEnd);
  const previousUptime = uptimeForRange(uptimeHistory, previousStart, previousEnd);
  const allIncidents = incidentIntervals(uptimeHistory);
  const currentIncidents = incidentsForRange(allIncidents, currentStart, currentEnd);
  const previousIncidents = incidentsForRange(allIncidents, previousStart, previousEnd);
  const currentRepairs = repairsForRange(repairHistory, currentStart, currentEnd);
  const previousRepairs = repairsForRange(repairHistory, previousStart, previousEnd);
  const unresolved = unresolvedProblems(latest, credentialHealth);

  const providerPrevious = new Map((previousCredential.providers || []).map((row: any) => [String(row.id), row]));
  const credentialProviders = (currentCredential.providers || []).map((row: any) => {
    const previous: any = providerPrevious.get(String(row.id));
    const delta = pctDelta(row.percentage, previous?.percentage ?? null);
    return {
      ...row,
      previousPercentage: previous?.percentage ?? null,
      deltaPercentagePoints: delta,
      trend: delta == null || Math.abs(delta) < 0.05 ? 'stable' : delta > 0 ? 'improved' : 'worsened',
    };
  });

  const comparisons = [
    comparisonItem('Observed system uptime', currentUptime.percentage, previousUptime.percentage, true, '%', 0.01),
    comparisonItem('System incident count', currentIncidents.incidentCount, previousIncidents.incidentCount, false, ' incidents', 1),
    comparisonItem('System downtime', currentIncidents.downtimeMinutes, previousIncidents.downtimeMinutes, false, ' minutes', 1),
    comparisonItem('Average credential reliability', currentCredential.averagePercentage, previousCredential.averagePercentage, true, '%', 0.05),
    ...credentialProviders.map((row: any) =>
      comparisonItem(row.label + ' credential reliability', row.percentage, row.previousPercentage, true, '%', 0.05)
    ),
  ].filter(Boolean) as any[];

  const improved = comparisons.filter((row) => row.direction === 'improved');
  const worsened = comparisons.filter((row) => row.direction === 'worsened');

  return {
    generatedAt: currentEnd,
    basis: 'Rolling 7 days compared with the immediately preceding 7 days.',
    periods: {
      current: { startAt: currentStart, endAt: currentEnd },
      previous: { startAt: previousStart, endAt: previousEnd },
    },
    uptime: {
      current: currentUptime,
      previous: previousUptime,
      deltaPercentagePoints: pctDelta(currentUptime.percentage, previousUptime.percentage),
    },
    credentialReliability: {
      currentAverage: currentCredential.averagePercentage,
      previousAverage: previousCredential.averagePercentage,
      deltaPercentagePoints: pctDelta(currentCredential.averagePercentage, previousCredential.averagePercentage),
      providers: credentialProviders,
    },
    incidents: {
      current: currentIncidents,
      previous: previousIncidents,
      incidentDelta: currentIncidents.incidentCount - previousIncidents.incidentCount,
      downtimeDeltaMinutes: currentIncidents.downtimeMinutes - previousIncidents.downtimeMinutes,
    },
    automaticRepairs: {
      current: currentRepairs,
      previous: previousRepairs,
      fixedDelta: currentRepairs.fixed - previousRepairs.fixed,
    },
    unresolved,
    improved,
    worsened,
    stable: comparisons.length === 0,
    coverage: {
      systemHourlyCurrent: currentUptime.hourlySamples,
      systemHourlyPrevious: previousUptime.hourlySamples,
      expectedHoursPerPeriod: currentUptime.expectedHours,
      repairAuditRows: repairHistory.length,
      note: 'Metrics use observed hourly System Health and Credential Health samples. Repair history begins when automatic repair auditing was deployed.',
    },
  };
}
