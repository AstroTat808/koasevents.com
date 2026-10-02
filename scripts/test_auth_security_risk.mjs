import { readFile } from 'node:fs/promises';
import {
  LOGIN_ALERT_COOLDOWN_MS,
  classifyLoginRisk,
  loginAlertSuppressionKey,
  successfulAuthEventType,
} from '../netlify/functions/_shared/auth-security-risk.ts';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const first = classifyLoginRisk({ hasHistory:false });
assert(first.riskLevel === 'normal' && !first.shouldAlert, 'First successful login should be normal.');

const networkOnly = classifyLoginRisk({ hasHistory:true, knownNetwork:false, knownDevice:true });
assert(networkOnly.riskLevel === 'notice' && !networkOnly.suspicious && !networkOnly.shouldAlert, 'A new network alone must not alert.');

const deviceOnly = classifyLoginRisk({ hasHistory:true, knownNetwork:true, knownDevice:false });
assert(deviceOnly.riskLevel === 'notice' && !deviceOnly.suspicious && !deviceOnly.shouldAlert, 'A new device label alone must not alert.');

const both = classifyLoginRisk({ hasHistory:true, knownNetwork:false, knownDevice:false });
assert(both.riskLevel === 'review' && both.suspicious && !both.shouldAlert, 'New network plus new device should be review-only without email.');

const failuresPlusContext = classifyLoginRisk({ recentFailureCount:2, hasHistory:true, knownNetwork:false, knownDevice:true });
assert(!failuresPlusContext.shouldAlert && failuresPlusContext.riskLevel === 'review', 'Two failures plus new context should remain review-only.');

const failuresOnly = classifyLoginRisk({ recentFailureCount:3, hasHistory:true, knownNetwork:true, knownDevice:true });
assert(failuresOnly.shouldAlert && failuresOnly.riskLevel === 'high', 'Three recent failures should always alert.');

const trusted = classifyLoginRisk({ recentFailureCount:0, hasHistory:true, knownNetwork:false, knownDevice:false, trustedDevice:true });
assert(!trusted.suspicious && !trusted.shouldAlert, 'Trusted devices should not alert from network/device novelty.');

const trustedUnderAttack = classifyLoginRisk({ recentFailureCount:3, hasHistory:true, knownNetwork:false, knownDevice:false, trustedDevice:true });
assert(trustedUnderAttack.shouldAlert, 'Trusted devices must still alert after repeated failed sign-ins.');

assert(successfulAuthEventType('login_success'), 'login_success should count toward the trusted history baseline.');
assert(successfulAuthEventType('suspicious_login'), 'suspicious_login should count toward the trusted history baseline.');
assert(!successfulAuthEventType('login_failed'), 'login_failed must not count as a successful baseline event.');

assert(LOGIN_ALERT_COOLDOWN_MS === 86400000, 'Duplicate-alert cooldown must remain 24 hours.');
assert(
  loginAlertSuppressionKey({ email:'User@Example.com', deviceFingerprint:'DEVICE-1', device:'Safari on iPhone' })
    === 'user@example.com|device-1',
  'Alert suppression should key by account and stable device fingerprint.',
);

console.log('PASS | first login normal');
console.log('PASS | new network alone is notice-only');
console.log('PASS | new device alone is notice-only');
console.log('PASS | new network + device is review-only');
console.log('PASS | two failures + new context is review-only');
console.log('PASS | three failures always alert');
console.log('PASS | trusted device suppresses novelty alerts');
console.log('PASS | trusted device still alerts after repeated failures');
console.log('PASS | suspicious successes contribute to baseline history');
console.log('PASS | duplicate-alert cooldown is 24 hours');


const accountSecurity = await readFile(new URL('../netlify/functions/account-security.mts', import.meta.url), 'utf8');
const authSecurity = await readFile(new URL('../netlify/functions/_shared/auth-security.ts', import.meta.url), 'utf8');
const workspaceNav = await readFile(new URL('../src/components/StaffUtilityNav.astro', import.meta.url), 'utf8');
const systemHealth = await readFile(new URL('../netlify/functions/_shared/system-health.ts', import.meta.url), 'utf8');
const visualQa = await readFile(new URL('./production_visual_qa.py', import.meta.url), 'utf8');

assert(
  accountSecurity.includes("action==='trust-current-browser'")
    && accountSecurity.includes("action==='rename-trusted-device'")
    && accountSecurity.includes("action==='revoke-trusted-device'")
    && accountSecurity.includes("Set-Cookie','koa_sid="),
  'Account Security must support secure current-browser trust plus rename/revoke device actions.',
);
assert(
  accountSecurity.includes("trustedDeviceHandle")
    && accountSecurity.includes("resolveTrustedDeviceHandle")
    && !accountSecurity.includes("fingerprint:row.fingerprint"),
  'Self-service device management must use opaque device handles instead of returning the raw browser fingerprint.',
);
assert(
  authSecurity.includes("name:clean(friendlyName||existing?.name||source.device||'Trusted device',120)")
    && authSecurity.includes("export async function renameTrustedDevice")
    && authSecurity.includes("export async function authenticationSecurityHealthSummary"),
  'Trusted-device storage must retain friendly names and expose the authentication health probe.',
);
assert(
  workspaceNav.includes('data-workspace-account-toggle')
    && workspaceNav.includes('data-workspace-trust-current')
    && workspaceNav.includes('data-workspace-trusted-devices')
    && workspaceNav.includes("accountSecurityAction('rename-trusted-device'")
    && workspaceNav.includes("accountSecurityAction('revoke-trusted-device'"),
  'The workspace account menu must expose trust-this-browser and the dedicated friendly-name/revoke device panel.',
);
assert(
  systemHealth.includes("id:'login-alert-policy'")
    && systemHealth.includes('authenticationSecurityHealthSummary(context)')
    && systemHealth.includes('trusted-device storage')
    && systemHealth.includes('last high-risk email'),
  'System Health must verify the sign-in threshold, trusted-device storage, cooldown storage, and last high-risk email.',
);
assert(
  authSecurity.includes('export type TrustedDeviceExpiryDays = 0 | 30 | 60 | 90')
    && authSecurity.includes('lastUsedAt:string;')
    && authSecurity.includes('expiresAt:string;')
    && authSecurity.includes('options:{touch?:boolean}={}')
    && authSecurity.includes('{touch:true}')
    && authSecurity.includes('TRUSTED_DEVICE_COOKIE_MAX_AGE_SECONDS=365*24*60*60'),
  'Trusted devices must track last use, support 30/60/90-day inactivity expiry, refresh on successful use, and keep a stable non-auth device cookie long enough for the policy.',
);
assert(
  accountSecurity.includes("action==='save-trusted-device-expiry'")
    && accountSecurity.includes('[0,30,60,90].includes(days)')
    && accountSecurity.includes('trustedDeviceExpiryDays:trustedDeviceSettings.expiryDays'),
  'Account Security must expose and validate self-service trusted-device expiry policy controls.',
);
assert(
  workspaceNav.includes('data-workspace-trusted-expiry')
    && workspaceNav.includes('After 30 days without use')
    && workspaceNav.includes('After 60 days without use')
    && workspaceNav.includes('After 90 days without use')
    && workspaceNav.includes('Last used ')
    && workspaceNav.includes('Auto-revokes '),
  'The account device panel must show last-used/expiry information and 30/60/90-day automatic revocation choices.',
);
assert(
  visualQa.includes('trusted-browser-account-menu')
    && visualQa.includes("[data-workspace-account-toggle]")
    && visualQa.includes("[data-workspace-trust-current]")
    && visualQa.includes("[data-workspace-trusted-expiry]")
    && visualQa.includes("Last used")
    && visualQa.includes("Auto-revokes"),
  'Production admin QA must exercise the deployed Account → Trusted browsers flow with non-destructive API mocks.',
);

console.log('PASS | trusted-device expiry supports Never / 30 / 60 / 90 days');
console.log('PASS | trusted-device last-used timestamps refresh on successful trusted sign-in');
console.log('PASS | account device panel exposes last-used and auto-revoke policy controls');

console.log('PASS | account menu can trust the exact current browser');
console.log('PASS | trusted devices support friendly names and revocation');
console.log('PASS | System Health verifies sign-in alert policy state');
