// Pure policy: only a ready or in-progress production deploy may suppress a rebuild.
// A terminal Netlify error is never evidence that the requested SHA is published.
const READY = new Set(['ready', 'current']);
const ACTIVE = new Set(['new', 'pending', 'queued', 'enqueued', 'building',
  'preparing', 'prepared', 'processing', 'uploading', 'uploaded', 'pending_review']);
const FAILED = new Set(['error', 'failed', 'cancelled', 'canceled']);

export function productionDeployDisposition(deploy) {
  if (!deploy) return 'absent';
  const state = String(deploy.state || '').trim().toLowerCase();
  if (READY.has(state)) return 'ready';
  if (ACTIVE.has(state)) return 'in-progress';
  if (FAILED.has(state)) return 'failed';
  return 'unknown';
}

// Input is already filtered to the signed SHA and production deployment context.
// A single existing terminal failure gets one recovery attempt; if it also fails,
// stop and surface a human-actionable diagnostic rather than consuming build credits.
export function planProductionDeployRecovery(deploys) {
  if (!Array.isArray(deploys)) return {action: 'block', reason: 'deployment-history-unavailable', failedCount: 0};
  const ready = deploys.find(row => productionDeployDisposition(row) === 'ready');
  if (ready) return {action: 'reuse', reason: 'ready', deploy: ready, failedCount: 0};
  const active = deploys.find(row => productionDeployDisposition(row) === 'in-progress');
  if (active) return {action: 'reuse', reason: 'in-progress', deploy: active, failedCount: 0};
  if (deploys.some(row => productionDeployDisposition(row) === 'unknown')) {
    return {action: 'block', reason: 'unrecognized-deploy-state', failedCount: 0};
  }
  const failed = deploys.filter(row => productionDeployDisposition(row) === 'failed');
  if (failed.length >= 2) {
    return {action: 'block', reason: 'automatic-retry-limit-reached', deploy: failed[0], failedCount: failed.length};
  }
  return {action: 'rebuild', reason: failed.length ? 'one-failed-deploy' : 'deploy-missing',
    deploy: failed[0] || null, failedCount: failed.length};
}
