import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function assert(condition, message) { if (!condition) throw new Error(message); }

const scanner = resolve('scripts/ci_privacy_gate.mjs');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'koa-ci-privacy-'));
const workflowDir = join(fixtureRoot, '.github', 'workflows');
mkdirSync(workflowDir, { recursive: true });

function scan(text) {
  writeFileSync(join(workflowDir, 'privacy-fixture.yml'), text);
  const p = spawnSync(process.execPath, [scanner], { cwd: fixtureRoot, encoding: 'utf8', timeout: 15000 });
  return { status: p.status, stderr: String(p.stderr || ''), stdout: String(p.stdout || '') };
}

try {
  const safe = `name: Synthetic fixtures only
jobs:
  synthetic:
    runs-on: ubuntu-latest
    steps:
      - run: |
          raw_file="$(mktemp)"
          curl -sS -o "$raw_file" -X POST https://koasevents.com/api/system-health/github-main-signal
          test -s "$raw_file"
          rm -f "$raw_file"
      - uses: actions/upload-artifact@v4
        with:
          path: visual-results/critical-integration-real-rollback-summary.json
`;
  assert(scan(safe).status === 0, 'Safe private response + redacted summary was falsely rejected.');
  const cases = [
    ['raw rollback artifact', safe.replace('critical-integration-real-rollback-summary.json', 'critical-integration-real-rollback-drill.json')],
    ['raw sandbox self-heal', safe.replace('critical-integration-real-rollback-summary.json', 'netlify-sandbox-self-heal-drill.json')],
    ['non-temporary response', safe.replace('raw_file="$(mktemp)"', 'raw_file="visual-results/raw-production.json"')],
    ['hardcoded sensitive QBO identifier', safe + '# QBO-CUST-123456\\n'],
    ['raw console output', safe.replace('curl -sS -o "$raw_file"', 'curl -sS')],
  ];
  for (const [reason, text] of cases) {
    const result = scan(text);
    assert(result.status !== 0 && result.stderr.includes('CI privacy gate FAILED'), 'CI privacy gate accepted ' + reason);
  }
  console.log('PASS | CI privacy gate blocks five unsafe data-leak patterns while accepting private raw responses and synthetic summaries.');
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
