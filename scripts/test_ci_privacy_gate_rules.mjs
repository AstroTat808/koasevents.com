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
  const safeLegacy = `name: Safe legacy response capture
jobs:
  private-only:
    runs-on: ubuntu-latest
    steps:
      - run: |
          verification_file="$(mktemp)"
          report_file="/tmp/koa-signed-health-response.json"
          test -f "$report_file" || true
`;
  assert(scan(safeLegacy).status===0,'Private legacy response file assignments were incorrectly rejected.');
  const cases = [
    ['raw rollback artifact', safe.replace('critical-integration-real-rollback-summary.json', 'critical-integration-real-rollback-drill.json')],
    ['raw sandbox self-heal', safe.replace('critical-integration-real-rollback-summary.json', 'netlify-sandbox-self-heal-drill.json')],
    ['non-temporary response', safe.replace('raw_file="$(mktemp)"', 'raw_file="visual-results/raw-production.json"')],
    ['hardcoded sensitive QBO identifier', safe + '# QBO-CUST-123456\\n'],
    ['raw console output', safe.replace('curl -sS -o "$raw_file"', 'curl -sS')],
    ['raw temporary response printed', safe.replace('test -s "$raw_file"', 'cat "$raw_file"')],
    ['authenticated verification file echoed', safe.replace('test -s "$raw_file"', 'echo "$verification_file"')],
    ['private response assigned to retained artifacts', safe.replace('raw_file="$(mktemp)"', 'raw_file="visual-results/raw-private-response.json"')],
    ['response file outside temp with no Health endpoint', 'name: Source-private response\nsteps:\n  - run: |\n      report_file="visual-results/response.json"\n      test -f "$report_file"\n'],
    ['dark mode private response outside temp', 'name: Dark-mode raw response\nsteps:\n  - run: |\n      dark_mode_response="visual-results/health.json"\n      test -f "$dark_mode_response"\n'],
    ['raw CRM preview rows emitted to workflow', "name: Unsafe CRM preview\nsteps:\n  - run: |\n      echo '{\"rows\": preview.get(\"rows\")}'\n"],
  ];
  for (const [reason, text] of cases) {
    const result = scan(text);
    assert(result.status !== 0 && result.stderr.includes('CI privacy gate FAILED'), 'CI privacy gate accepted ' + reason);
  }
  console.log('PASS | CI privacy gate blocks five unsafe data-leak patterns while accepting private raw responses and synthetic summaries.');
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
