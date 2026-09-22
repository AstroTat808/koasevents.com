import { execFileSync } from 'node:child_process';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

const context = String(process.env.CONTEXT || '').trim().toLowerCase();

// Deploy Previews, branch deploys, and local/unknown contexts should build normally.
if (context !== 'production') {
  console.log('[koa deploy policy] Non-production context: build allowed.');
  process.exit(1);
}

const commit = String(process.env.COMMIT_REF || 'HEAD').trim() || 'HEAD';

try {
  const message = git('log', '-1', '--pretty=%B', commit);
  const parentLine = git('rev-list', '--parents', '-n', '1', commit);
  const parentCount = Math.max(0, parentLine.split(/\s+/).filter(Boolean).length - 1);

  const explicitRelease = /^(?:\[release\]|release:)/i.test(message);
  const mergeCommit = parentCount >= 2 || /^Merge pull request #\d+/m.test(message);
  const squashPullRequest = /\(#\d+\)\s*$/m.test(message);

  if (explicitRelease || mergeCommit || squashPullRequest) {
    console.log('[koa deploy policy] Approved production release commit: build allowed.');
    process.exit(1);
  }

  console.log('[koa deploy policy] Production build skipped.');
  console.log('[koa deploy policy] Develop through a pull request / Deploy Preview, then merge to main.');
  console.log('[koa deploy policy] For an intentional emergency direct release, prefix the commit message with [release].');
  process.exit(0);
} catch (error) {
  // Fail open so a Git metadata edge case never blocks an intentional production release.
  console.log('[koa deploy policy] Unable to inspect commit metadata; build allowed.');
  process.exit(1);
}
