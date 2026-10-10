// Pure, network-free classification used by the authenticated deploy recovery endpoint.
// An errored deploy must never count as proof that production serves the expected SHA.
const READY=new Set(['ready','current']);
const IN_PROGRESS=new Set([
  'new','pending','queued','enqueued','building','preparing','prepared',
  'processing','uploading','uploaded','pending_review',
]);
const FAILED=new Set(['error','failed','cancelled','canceled']);

export function productionDeployDisposition(deploy) {
  if (!deploy) return 'absent';
  const state=String(deploy.state||'').trim().toLowerCase();
  if (READY.has(state)) return 'ready';
  if (IN_PROGRESS.has(state)) return 'in-progress';
  if (FAILED.has(state)) return 'failed';
  return 'unknown';
}
