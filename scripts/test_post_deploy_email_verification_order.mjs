import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = await readFile(new URL('../netlify/functions/post-deploy-verification.mts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const sha = 'a'.repeat(40), deployId = 'b'.repeat(24);
function harness({ runtimeMetadata = true, existingVerified = false } = {}) {
  const events = [], stored = [];
  let emailVerified = false;
  const snapshot = {
    deployId, commit: sha,
    checks: [{ id: 'netlify-github-sync',
      deploymentDetails: { netlifyDeployId: deployId, netlifyCommit: sha } }],
  };
  const modules = {
    './_shared/tenant': { runForEachTenant: async (_context, task) => task() },
    './_shared/credit-saver': { shouldRunScheduledJob: async () => true },
    './_shared/email-health': {
      runBrandedEmailProductionVerification: async (_context, identity) => {
        events.push('verify-email');
        assert.deepEqual(identity, { deployId, commit: sha });
        emailVerified = true;
        return { status: 'success' };
      },
    },
    './_shared/system-health': {
      readPostDeployVerification: async () => existingVerified
        ? { deployId, status: 'success' } : null,
      readLatestHealth: async () => null,
      readLatestHourlyHealth: async () => null,
      runSystemHealth: async () => {
        events.push('run-health');
        return { ...snapshot, checkedAt: '2026-10-25T00:00:00Z',
          overall: emailVerified ? 'healthy' : 'unhealthy',
          passed: emailVerified ? 83 : 82, failed: emailVerified ? 0 : 1,
          failedIds: emailVerified ? [] : ['email-inline-logo-verification'] };
      },
      applyHealthAlertPolicy: async () => { events.push('alert-policy'); },
      persistHealth: async (_context, current) => {
        events.push('persist-health'); stored.push(structuredClone(current));
      },
      sendHealthTransitionAlerts: async () => { events.push('transition-alert'); },
      syntheticProbeReleaseVerification: () => ({ status: 'passed' }),
      productionAccountingVerification: () => ({ accountingVerified: true }),
      savePostDeployVerification: async (_context, data) => {
        events.push('save-postdeploy'); stored.push(structuredClone(data));
      },
      recordProductionRelease: async (_context, data) => {
        events.push('record-release'); stored.push(structuredClone(data));
      },
    },
  };
  const module = { exports: {} };
  const netlify = { env: { get: key => {
    if (!runtimeMetadata) return '';
    return key === 'DEPLOY_ID' ? deployId : key === 'COMMIT_REF' ? sha : '';
  } } };
  new Function('require', 'module', 'exports', 'Netlify', compiled)(
    name => { assert.ok(modules[name], 'Unexpected dependency: ' + name); return modules[name]; },
    module, module.exports, netlify,
  );
  const run = () => module.exports.default(
    new Request('https://synthetic.example.test/.netlify/functions/post-deploy-verification'),
    { deploy: { context: 'production' } },
  );
  return { run, events, stored };
}
test('post-deploy snapshot follows successful branded email verification', async () => {
  const h = harness();
  await h.run();
  assert.equal(h.events[0], 'verify-email');
  assert.equal(h.events[1], 'run-health');
  assert.equal(h.events[2], 'alert-policy');
  assert.equal(h.events[3], 'persist-health');
  assert.equal(h.stored[0].overall, 'healthy');
  assert.equal(h.stored[0].failed, 0);
  const verification = h.stored.find(x => x?.status === 'success');
  assert.ok(verification, 'A successful post-deploy attestation must be durable');
  assert.equal(verification.failed, 0);
});
test('missing runtime metadata preserves deployment identity fallback without stale final snapshot', async () => {
  const h = harness({ runtimeMetadata: false });
  await h.run();
  assert.deepEqual(h.events.slice(0,3), ['run-health','verify-email','run-health']);
  assert.equal(h.stored[0].failed, 0);
  assert.equal(h.stored[0].overall, 'healthy');
});
test('previous successful verification never resends a controlled email', async () => {
  const h = harness({ existingVerified: true });
  await h.run();
  assert.deepEqual(h.events, []);
});
