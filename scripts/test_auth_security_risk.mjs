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
    && accountSecurity.includes('currentFingerprint=await requestDeviceFingerprint(req)')
    && !accountSecurity.includes("Set-Cookie','koa_sid="),
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


const layoutAuthGuard = await readFile(new URL('../src/layouts/BaseLayout.astro', import.meta.url), 'utf8');
const accountSessionEndpoint = await readFile(new URL('../netlify/functions/account-security.mts', import.meta.url), 'utf8');
const sessionHealthPage = await readFile(new URL('../src/pages/admin/health/index.astro', import.meta.url), 'utf8');
assert(
  layoutAuthGuard.includes("requestUrl?.pathname === '/api/admin/session' && response.status === 401")
    && !layoutAuthGuard.includes('if (requestUrl && response.status === 401)'),
  'Only the canonical admin session 401 may trigger a global login redirect.',
);
assert(
  accountSessionEndpoint.includes('sessionHealth:{')
    && accountSessionEndpoint.includes("refreshStatus:'client_reported'")
    && !accountSessionEndpoint.includes('sessionHealth:{sessions:managedSessions'),
  'Session Health must return a sanitized current-user summary without raw session objects.',
);
assert(
  sessionHealthPage.includes('id="session-health"')
    && sessionHealthPage.includes("fetch('/api/account/security'")
    && sessionHealthPage.includes("document.createTextNode(String(value))"),
  'System Health must render privacy-safe session diagnostics with text-only DOM operations.',
);
console.log('PASS | endpoint-specific 401 does not globally redirect; session health is redacted');


const adminLoginPage = await readFile(new URL('../src/pages/admin/index.astro', import.meta.url), 'utf8');
assert(
  adminLoginPage.includes("await refreshSession()")
    && adminLoginPage.includes("user = await getUser()")
    && adminLoginPage.includes("event:'refresh_succeeded'"),
  'Expired-session recovery must use the supported Netlify Identity refresh API rather than browser trust as authentication.',
);
assert(
  accountSessionEndpoint.includes("if(action==='revoke-session')")
    && accountSessionEndpoint.includes('await revokeManagedSession(current.id,match.id')
    && accountSessionEndpoint.includes("await trustedDeviceHandle(session.id)===handle"),
  'Self-service session revocation must resolve opaque session handles server-side for the current account.',
);
assert(
  sessionHealthPage.includes("action:'revoke-session'")
    && sessionHealthPage.includes('Expiration reason')
    && sessionHealthPage.includes('revoke.disabled=true'),
  'Session Health must offer bounded one-click revocation and display expiration reasons.',
);
console.log('PASS | supported session refresh, opaque self-revocation and expiration reason');


const adminSessionHelper = await readFile(new URL('../src/lib/admin-session.ts',import.meta.url),'utf8');
const refreshEventEndpoint = await readFile(new URL('../netlify/functions/auth-session-event.mts',import.meta.url),'utf8');
const themeBrowserQa = await readFile(new URL('./theme_visual_qa.py',import.meta.url),'utf8');
const releaseCertification = await readFile(new URL('./release_certification.mjs',import.meta.url),'utf8');
assert(
  adminSessionHelper.includes("failure?.code==='unauthenticated'")
    && adminSessionHelper.includes('await refreshIdentityOnce()')
    && adminSessionHelper.includes('response=await check()')
    && adminSessionHelper.includes('sendToLogin()')
    && !layoutAuthGuard.includes("response.status === 401) {\n            redirectToLogin();"),
  'A canonical unauthenticated 401 must get an Identity refresh/recheck before redirect; unrelated 401s must not redirect.',
);
assert(
  workspaceNav.includes('AUTH_EVENTS.TOKEN_REFRESH')
    && workspaceNav.includes("event:'refresh_succeeded'")
    && refreshEventEndpoint.includes('requireOperations(req,context)')
    && refreshEventEndpoint.includes("row.type==='session_refreshed'"),
  'Actual browser refresh events must be observed, authenticated and rate-limited before storing.',
);
assert(
  authSecurity.includes('expiresAt:expiry||existing.expiresAt')
    && themeBrowserQa.includes('"canonical-session-revoked"')
    && themeBrowserQa.includes('"unrelated-api-401"')
    && themeBrowserQa.includes('"second-tab"')
    && releaseCertification.includes('synthetic session lifecycle'),
  'Session expiry must update on refresh and phone/desktop Chromium/WebKit lifecycles must be a release gate.',
);
console.log('PASS | session refresh before redirect, trusted session metadata and browser lifecycle release contract');


const {ADMIN_BINDING_COOKIE,ADMIN_BINDING_SECONDS,newAdminBinding,validAdminBinding,
  adminBindingCookie,clearAdminBindingCookie,sessionBindingStatus}=await import('../netlify/functions/_shared/session-binding.ts');
const id=newAdminBinding();
assert(ADMIN_BINDING_COOKIE==='__Host-koa_admin_session'&&id.length===43&&validAdminBinding(id),
  'Opaque login binding must contain 256 secure random bits in a __Host- cookie.');
assert(ADMIN_BINDING_SECONDS===30*24*60*60&&
  adminBindingCookie(id,true).includes('HttpOnly; Secure; SameSite=Lax; Max-Age=2592000')&&
  !adminBindingCookie(id).includes('Max-Age=')&&
  clearAdminBindingCookie().includes('Max-Age=0'),
  'Login cookie lifetime must be bounded by 30 days and explicitly cleared on logout.');
assert(!validAdminBinding('')&&!validAdminBinding('client-forged')&&
  !validAdminBinding('A'.repeat(44)),
  'Invalid or deleted binding credentials must never authorize.');
const now=Date.now(),live={id:'hashed-secret',userId:'one',revokedAt:'',boundUntil:new Date(now+30000).toISOString()};
assert(sessionBindingStatus(live,'hashed-secret','one',now)==='active','Known live binding accepted.');
assert(sessionBindingStatus(live,'','one',now)==='missing','Deleted binding rejected.');
assert(sessionBindingStatus(live,'unrecognized','one',now)==='unrecognized','Forged binding rejected.');
assert(sessionBindingStatus(live,'hashed-secret','another',now)==='unrecognized','Cross-account session rejected.');
assert(sessionBindingStatus({...live,revokedAt:new Date(now).toISOString()},'hashed-secret','one',now)==='revoked',
  'Revoked session rejected immediately even if Identity access token remains valid.');
assert(sessionBindingStatus({...live,boundUntil:new Date(now-1).toISOString()},'hashed-secret','one',now)==='expired',
  'Expired binding cannot be refreshed by access-token rotation.');
const authLoginHandler=await readFile(new URL('../netlify/functions/auth-bound-login.mts',import.meta.url),'utf8');
const authLogoutHandler=await readFile(new URL('../netlify/functions/auth-bound-logout.mts',import.meta.url),'utf8');
const authRecordHandler=await readFile(new URL('../netlify/functions/auth-record.mts',import.meta.url),'utf8');
const accessContext=await readFile(new URL('../netlify/functions/_shared/admin.ts',import.meta.url),'utf8');
assert(authLoginHandler.includes('verifyRequestOrigin(req)')&&
  authLoginHandler.includes('await login(email,password)')&&
  authLoginHandler.includes('await createBoundManagedSession(req,user,body.remember===true)')&&
  !authLoginHandler.includes('await getUser()'),
  'Only a fresh, verified password login may issue a new session binding.');
assert(authLogoutHandler.includes('await revokePresentedBoundSession(req,context)')&&
  authSecurity.includes("store().get('session-owners/'+sid")&&
  authLogoutHandler.includes('await logout()')&&
  authLogoutHandler.includes('clearAdminBindingCookie()'),
  'Logout must revoke the server binding, invalidate provider refresh and clear the cookie.');
assert(authSecurity.includes("validAdminBinding(secret)?hash('managed-session:'+secret):''")&&
  authSecurity.includes("const device=cookie(req,'koa_sid')")&&
  authSecurity.includes("if(!status.valid)return null")&&
  authSecurity.includes('sessionRevokedKey(userId,sid)')&&
  authSecurity.includes('allSessionsRevokedKey(userId)')&&
  accessContext.includes('if(!managedSession?.valid) security.sessionRevoked = true;')&&
  accountSessionEndpoint.includes('if(signedInSession.revoked)')&&
  authRecordHandler.includes("code:'session_binding_required'"),
  'Deleted/forged koa_sid must never bootstrap or bypass the server-authoritative binding.');
console.log('PASS | secure 30-day upper bound; missing, forged, expired, revoked and cross-account binding tests');


const liveIdentityQa = await readFile(new URL('./test_identity_live_session.py',import.meta.url),'utf8');
const liveIdentityWorkflow = await readFile(new URL('../.github/workflows/identity-live-session-qa.yml',import.meta.url),'utf8');
const productionVisualWorkflow = await readFile(new URL('../.github/workflows/production-visual-qa.yml',import.meta.url),'utf8');
assert(
  liveIdentityWorkflow.includes('environment: koa-auth-qa') &&
  liveIdentityWorkflow.includes('github.event.pull_request.draft == false') &&
  liveIdentityWorkflow.includes("github.event.pull_request.user.login == 'AstroTat808'") &&
  liveIdentityWorkflow.includes('ref: ${{ github.event.pull_request.head.sha }}') &&
  liveIdentityWorkflow.includes('KOA_AUTH_QA_EMAIL: ${{ secrets.KOA_AUTH_QA_EMAIL }}') &&
  liveIdentityWorkflow.includes('KOA_AUTH_QA_PASSWORD: ${{ secrets.KOA_AUTH_QA_PASSWORD }}') &&
  !liveIdentityWorkflow.includes('actions/upload-artifact') &&
  !liveIdentityWorkflow.split('\n').some(line=>line.trim()==='set -x'),
  'Authenticated provider test secrets must be restricted by environment, exact SHA and a trusted actor, without artifacts.',
);
assert(
  liveIdentityQa.includes('identity_refresh_not_rotated') &&
  liveIdentityQa.includes('restored_browser_state') &&
  liveIdentityQa.includes('deleting_koa_sid_bypassed_revocation') &&
  liveIdentityQa.includes('restored_logout_cookie_accepted') &&
  liveIdentityQa.includes('identity_refresh_cookie_not_30day_persistent') &&
  liveIdentityQa.includes('for browser in ("chromium","webkit")') &&
  !liveIdentityQa.includes('.screenshot(') &&
  !liveIdentityQa.includes('.har(') &&
  releaseCertification.includes("'Identity live session QA'") &&
  releaseCertification.includes('validateIdentityRunJobs(') &&
  productionVisualWorkflow.includes('python -m py_compile scripts/test_identity_live_session.py'),
  'Release certification must reject absent real Identity evidence, and live provider checks must not save credentials or screenshots.',
);
console.log('PASS | protected exact-SHA Netlify Identity credential-rotation/replay evidence required at release');
