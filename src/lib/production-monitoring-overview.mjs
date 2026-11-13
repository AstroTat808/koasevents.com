/**
 * Privacy-safe, read-only overview of the authenticated System Health snapshot.
 * Never infer Netlify edge 5xx counts from synthetic page probes.
 */
const short = (value, max = 140) => String(value ?? '').trim().slice(0, max);
const sha = (value) => /^[0-9a-f]{40}$/.test(String(value || '')) ? String(value) : '';
const status = (value) => String(value ?? '').toLowerCase();

export function summarizeProductionMonitoring(data = {}, now = Date.now()) {
  const current = data.current || {};
  const deployments = data.deployments || {};
  const published = deployments.current || {};
  const qa = deployments.latestQaForCurrentDeploy || {};
  const visual = data.visualQuality || {};
  const deployId = short(published.deployId || data.runtime?.deployId, 80);
  const publishedSha = sha(published.commit);
  const mainSha = sha(published.mainCommit);
  const exactMain = Boolean(deployId && publishedSha && mainSha
    && publishedSha === mainSha && published.behindMain === false);
  const lastChecked = short(current.checkedAt, 50);
  const checkedMs = Date.parse(lastChecked);
  const fresh = Number.isFinite(checkedMs) && checkedMs <= now && now - checkedMs < 2 * 60 * 60 * 1000;
  const healthOk = fresh && status(current.overall) === 'healthy' && Number(current.failed) === 0;
  const confirmedIssues = Array.isArray(current.alertFailedIds) ? current.alertFailedIds.length : 0;
  const healthState = !fresh ? 'unknown' : healthOk ? 'healthy' : 'failed';
  const healthLabel = !fresh ? 'Snapshot unavailable or stale' : healthOk
    ? 'Healthy · 0 failed checks' : 'Attention · ' + Number(current.failed || 0) + ' failed checks';
  const qaConclusion = status(qa.conclusion);
  const qaExact = exactMain && sha(qa.commit) === publishedSha
    && (!qa.deployId || short(qa.deployId, 80) === deployId);
  const certified = Boolean(exactMain && deployments.deploymentHealthy === true
    && qaExact && qaConclusion === 'success');
  const releaseState = certified ? 'healthy'
    : qaExact && qaConclusion === 'failure' ? 'failed' : 'unknown';
  const releaseLabel = certified ? 'Certified · exact deployed SHA'
    : releaseState === 'failed' ? 'Production QA failed'
    : 'Awaiting exact-deploy certification';
  const themeExact = Boolean(exactMain
    && sha(visual.commit) === publishedSha
    && short(visual.deployId, 80) === deployId);
  const themeStatus = status(visual.status);
  const themeState = themeExact && themeStatus === 'passed' ? 'healthy'
    : themeExact && themeStatus === 'failed' ? 'failed' : 'unknown';
  const themeLabel = themeState === 'healthy' ? 'Chromium + WebKit passed'
    : themeState === 'failed' ? 'Browser QA failed'
    : 'Current-deploy browser QA unverified';
  const browserFailures = themeExact
    ? [visual.chromium, visual.webkit].reduce((n, b) => n + Math.max(0, Number(b?.failureCount) || 0), 0)
    : null;
  return Object.freeze({
    health: { state: healthState, label: healthLabel, confirmedIssues, lastChecked },
    deployment: {
      state: exactMain && ['ready','current','published'].includes(status(published.deployStatus)) ? 'healthy' : 'unknown',
      label: exactMain && ['ready','current','published'].includes(status(published.deployStatus))
        ? 'Production matches main' : 'Published production/main match unverified',
      deployId, commit: publishedSha, mainSha,
    },
    release: { state: releaseState, label: releaseLabel, runId: short(qa.runId || qa.id, 36) },
    browsers: { state: themeState, label: themeLabel, failures: browserFailures },
    cdn: {
      state: 'external',
      label: '5xx edge telemetry checked separately',
      detail: 'Hourly Image CDN thresholds are evaluated from Netlify edge logs, not inferred from browser probes.',
    },
  });
}
