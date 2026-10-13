// Pure release-history integrity decision. Deliberately independent from deploy readiness.
// A green deploy is not evidence that its durable certification exists.
export const RELEASE_HISTORY_CONTEXT = 'System Health release history persistence';

export function evaluateReleaseHistoryPersistence({
  commit, deployId, release, statuses = [], publishedAt = '', now = Date.now(),
}) {
  const sha = String(commit || '').trim().toLowerCase();
  const id = String(deployId || '').trim();
  const events = Array.isArray(statuses) ? statuses : [];
  const latest = events.find(row => row?.context === RELEASE_HISTORY_CONTEXT) || null;
  const githubStatus = String(latest?.state || 'missing').toLowerCase();
  const attestation = release?.releaseAttestation || null;
  const recorded = Boolean(
    /^[a-f0-9]{40}$/.test(sha) && id
    && release?.commit === sha
    && release?.deployId === id
    && attestation?.status === 'verified'
    && attestation?.expectedSha === sha
    && attestation?.deployId === id
    && attestation?.liveDeployId === id
    && attestation?.matchingDeployId === true
    && attestation?.productionGateState === 'success'
    && attestation?.visualQaConclusion === 'success'
    && attestation?.systemHealth?.overall === 'healthy'
    && attestation?.systemHealth?.failed === 0
  );
  const result = {
    state: 'pending', severity: 'warning', verified: false, sha, deployId: id,
    githubStatus, recordedAt: String(attestation?.verifiedAt || ''),
    runId: String(attestation?.visualQaRunId || ''),
    detail: 'Release certification is still pending. Deployment readiness alone is not certification.',
  };
  if (!/^[a-f0-9]{40}$/.test(sha) || !id) {
    return { ...result, state: 'unavailable', detail: 'The exact live production SHA or deploy ID is unavailable.' };
  }
  if (githubStatus === 'error' || githubStatus === 'failure') {
    return { ...result, state: 'failed', severity: 'critical',
      detail: 'Release-history persistence failed on the exact production commit. A successful deployment does not override this failure.' };
  }
  if (recorded && githubStatus === 'success') {
    return { ...result, state: 'healthy', severity: 'healthy', verified: true,
      detail: 'Durable certification and exact deployed SHA/ID match.' };
  }
  if (githubStatus === 'success') {
    return { ...result, state: 'failed', severity: 'critical',
      detail: 'GitHub reports persistence success, but the exact release certification is missing or mismatched in durable storage.' };
  }
  if (attestation && !recorded) {
    return { ...result, state: 'failed', severity: 'critical',
      detail: 'Stored release certification does not match the current production SHA, deploy ID, or healthy final gate.' };
  }
  const age = now - Date.parse(String(publishedAt || release?.publishedAt || ''));
  if (Number.isFinite(age) && age > 45 * 60 * 1000) {
    return { ...result, state: 'failed', severity: 'critical',
      detail: 'No verified durable release certificate was recorded within 45 minutes of production publication.' };
  }
  return result;
}
