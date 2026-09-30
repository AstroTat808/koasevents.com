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
