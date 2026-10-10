import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFailureRootCause, normalizeBuildFailureDiagnostic } from '../netlify/functions/_shared/build-failure-diagnostic.mjs';

const sha='a'.repeat(40);
const row=normalizeBuildFailureDiagnostic({
  source:'test',stage:'prebuild',check:'release-gate',command:'npm run test:release-gate',
  exitCode:2,message:'token=should-not-leak\nrelease gate failed',
  providerErrorMessage:'Authorization: secret-value',commit:sha,
  deployId:'deploy-123',buildId:'build-123',context:'production',
});
assert.equal(row.stage,'prebuild');
assert.equal(row.command,'npm run test:release-gate');
assert.equal(row.exitCode,2);
assert.equal(row.commit,sha);
assert(!JSON.stringify(row).includes('should-not-leak'),'Diagnostic leaked a token value.');
assert(!JSON.stringify(row).includes('secret-value'),'Diagnostic leaked an authorization value.');
assert.equal(buildFailureRootCause(row),'prebuild · npm run test:release-gate');

const pkg=JSON.parse(readFileSync('package.json','utf8'));
assert.equal(pkg.scripts.prebuild,'node scripts/run_prebuild_checks.mjs','npm prebuild must use the structured command runner.');
const netlify=readFileSync('netlify.toml','utf8');
assert(netlify.includes('command = "node scripts/run_netlify_build.mjs"'),'Netlify must use the structured build runner.');
assert(netlify.includes('package = "/plugins/netlify-plugin-koa-build-diagnostics"'),'Netlify build diagnostics plugin is not configured.');
const plugin=readFileSync('plugins/netlify-plugin-koa-build-diagnostics/index.mjs','utf8');
assert(plugin.includes("getDeployStore('koa-build-diagnostics')")&&plugin.includes("await store.setJSON('failure.json',diagnostic)"),
  'Netlify onError must persist a deploy-scoped structured diagnostic.');
const events=readFileSync('netlify/functions/deployment-events.mts','utf8');
assert(events.includes('deployFailed(event:DeployFailedEvent)')&&events.includes("'by-deploy/'+deployId"),
  'Deploy-failed event handler must promote the sanitized diagnostic to durable site-wide history.');
const health=readFileSync('netlify/functions/_shared/system-health.ts','utf8');
assert(health.includes('failureDiagnostic')&&health.includes('failingCommand'),
  'System Health deployment history must expose the exact failing command.');
console.log('PASS | Netlify failures emit sanitized exact-stage/command diagnostics and System Health consumes them.');
