#!/usr/bin/env node
// Privacy and UI regressions: no production payloads or credentials required.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sanitizeFailedHealthChecks } from './safe_health_diagnostic_codes.mjs';

const ui=readFileSync(new URL('../src/pages/admin/health/index.astro',import.meta.url),'utf8');
for(const required of [
  'data-health-severity-filter', 'value="critical"', 'value="warning"',
  'value="info"', 'value="healthy"',
  'healthSeverityFilter?.addEventListener(\'change\'',
  "if(activeSeverity&&severity!==activeSeverity)return false",
  "healthSeverityFilter.value=activeSeverity",
  'data-health-safe-diagnostics', 'data-health-safe-copy-code',
  'data-health-safe-copy-status', 'role="status"', 'aria-live="polite"',
  'healthSafeCopyCode?.addEventListener(\'click\'',
  'navigator.clipboard?.writeText(code)', "document.execCommand('copy')",
  'healthSafeCopyCode.dataset.diagnosticCode=safe?.errorCode',
  "healthSafeCopyStatus.textContent=copied",
]){
  assert(ui.includes(required),'Missing privacy-safe diagnostic UI contract: '+required);
}
assert(ui.includes('healthDetailDialog.showModal()'),'User must be able to open existing diagnostic panel.');
assert(!ui.includes('healthSafeCopyCode.dataset.diagnosticCode=row.detail'),
  'Never copy raw provider diagnostics.');

const failed=[
 {id:'netlify-recovery-credential',ok:false,detail:'PRIVATE_CLIENT_PROFILE'},
 {id:'dark-mode-qa',severity:'red',detail:'PRIVATE_CLIENT_PROFILE'},
 {id:'email-delivery',ok:false,detail:'PRIVATE_CLIENT_PROFILE'},
 {id:'customer-jane-private',ok:false,detail:'PRIVATE_CLIENT_PROFILE'},
 {id:'netlify-customer-jane-private',ok:false,detail:'PRIVATE_CLIENT_PROFILE'},
 {id:'admin-session',ok:true,detail:'PRIVATE_CLIENT_PROFILE'},
];
const safe=sanitizeFailedHealthChecks(failed,5);
assert.deepEqual(safe,[
 {id:'netlify-recovery-credential',category:'deployment',errorCode:'HEALTH_DEPLOYMENT_FAILED'},
 {id:'dark-mode-qa',category:'visual-qa',errorCode:'HEALTH_VISUAL_QA_FAILED'},
 {id:'email-delivery',category:'integration',errorCode:'HEALTH_INTEGRATION_FAILED'},
]);
assert(!JSON.stringify(safe).includes('PRIVATE_CLIENT_PROFILE'));
assert(!JSON.stringify(safe).includes('jane'));
assert.deepEqual(sanitizeFailedHealthChecks(null,1),[]);
assert.deepEqual(sanitizeFailedHealthChecks(failed,0),[]);
assert.deepEqual(sanitizeFailedHealthChecks(failed,2),safe.slice(0,2));
console.log('PASS | severity filter, accessible copy action, stable known-code allowlist, and zero raw customer data.');
