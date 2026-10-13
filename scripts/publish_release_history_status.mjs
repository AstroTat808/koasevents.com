// Public commit-status publisher for the independent durable release-history check.
// Does not read or emit production health JSON, secrets, customer data, or artifacts.
import { RELEASE_HISTORY_CONTEXT } from '../netlify/functions/_shared/release-history-integrity.mjs';

export function persistenceStatusForOutcome(outcome) {
  return outcome === 'success'
    ? { state: 'success', description: 'Durable release certificate verified by a read-after-write check.' }
    : { state: 'failure', description: 'Durable release certificate missing, skipped, or failed; deployment is not certified.' };
}

if (import.meta.url === new URL(process.argv[1] || '', 'file:').href) {
  const repo = process.env.GITHUB_REPOSITORY || '';
  const sha = process.env.GITHUB_SHA || '';
  const token = process.env.GH_TOKEN || '';
  if (repo !== 'AstroTat808/koasevents.com' || !/^[a-f0-9]{40}$/.test(sha) || !token) {
    throw new Error('Release-history status cannot publish without trusted repository, SHA, and credentials.');
  }
  const status = persistenceStatusForOutcome(process.env.PERSIST_OUTCOME);
  const payload = {
    ...status,
    context: RELEASE_HISTORY_CONTEXT,
    target_url: `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID || ''}`,
  };
  const response = await fetch(`https://api.github.com/repos/${repo}/statuses/${sha}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Unable to publish independent release-history check (HTTP ' + response.status + ').');
  process.stdout.write('Independent release-history persistence: ' + status.state + '\n');
}
