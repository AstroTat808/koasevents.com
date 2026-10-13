import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { releaseHistoryStatusEndpoint } from '../netlify/functions/_shared/release-history-integrity.mjs';

// Synthetic metadata only: this suite performs no HTTP or accounting operations.
const sha = 'a'.repeat(40);
for (const name of ['TenantOne/events', 'TenantTwo/events-site']) {
  for (const repository of [name, 'https://github.com/' + name + '.git', 'git@github.com:' + name + '.git']) {
    const endpoint = releaseHistoryStatusEndpoint({
      current: { repository }, connectionHealth: { repository: name },
    }, sha);
    assert.equal(endpoint, 'https://api.github.com/repos/' + name + '/commits/' + sha + '/statuses?per_page=100');
  }
}
for (const repository of [
  'https://evil.test/Owner/events',
  'https://github.com.evil.test/Owner/events',
  'https://user:synthetic@github.com/Owner/events',
  '//github.com/Owner/events',
  'Owner/../events', 'Owner/..', 'Owner/.',
  'Owner/events?secret=synthetic', 'Owner/events#fragment',
  'Owner/events/extra', 'https://github.com:8443/Owner/events',
  {}, [], 42,
]) {
  assert.throws(() => releaseHistoryStatusEndpoint({ current: { repository } }, sha));
}
assert.throws(() => releaseHistoryStatusEndpoint({}, sha));
assert.throws(() => releaseHistoryStatusEndpoint({
  current: { repository: 'TenantOne/events' },
  connectionHealth: { repository: 'TenantTwo/events' },
}, sha));
assert.throws(() => releaseHistoryStatusEndpoint({ current: { repository: 'TenantOne/events' } }, 'bad'));

const api = readFileSync('netlify/functions/admin-health.mts', 'utf8');
assert.ok(api.includes('fetch(releaseHistoryStatusEndpoint(deployments,sha)'));
assert.ok(!/fetch\(['"]https:\/\/api\.github\.com\/repos\/[^'"]+\/commits\//.test(api),
  'The shared health API must not target a tenant-specific hardcoded repository.');
console.log('PASS | release-history evidence follows deployment repository metadata; conflicting, malformed, non-GitHub and cross-repository metadata fail closed.');
