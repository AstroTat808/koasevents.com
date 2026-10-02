import { readFile } from 'node:fs/promises';

const health = await readFile(new URL('../src/pages/admin/health/index.astro', import.meta.url), 'utf8');
const nav = await readFile(new URL('../src/components/StaffUtilityNav.astro', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/styles/global.css', import.meta.url), 'utf8');
const adminHealth = await readFile(new URL('../netlify/functions/admin-health.mts', import.meta.url), 'utf8');
const systemHealth = await readFile(new URL('../netlify/functions/_shared/system-health.ts', import.meta.url), 'utf8');
const healthSignal = await readFile(new URL('../netlify/functions/github-main-health-signal.ts', import.meta.url), 'utf8');
const visualQa = await readFile(new URL('./production_visual_qa.py', import.meta.url), 'utf8');
const visualWorkflow = await readFile(new URL('../.github/workflows/production-visual-qa.yml', import.meta.url), 'utf8');
const netlifyConfig = await readFile(new URL('../netlify.toml', import.meta.url), 'utf8');
const releaseGate = await readFile(new URL('./verify_netlify_release_gate.mjs', import.meta.url), 'utf8');
const releaseAudit = await readFile(new URL('./system_health_release_audit.py', import.meta.url), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  health.includes('function accountingMoney(value)'),
  'System Health must define the accountingMoney formatter used by the permanent accounting timeline.',
);

const renderStart = health.indexOf('function render(data)');
const renderEnd = health.indexOf('\n    async function load', renderStart);
assert(renderStart >= 0 && renderEnd > renderStart, 'System Health render function could not be located.');
const renderBody = health.slice(renderStart, renderEnd);

const passedHydration = renderBody.indexOf("passed.textContent=String(current.passed||0)");
const accountingPanel = renderBody.indexOf("renderDashboardPanel('Accounting Health'");
assert(
  passedHydration >= 0 && accountingPanel > passedHydration,
  'Authoritative Passed/Failed/Last checked hydration must occur before optional Accounting Health rendering.',
);

for (const panel of ['Monitoring coverage', 'Critical Integrations', 'Accounting Health', 'Email Health', 'Credential Health', 'Weekly executive summary']) {
  assert(
    renderBody.includes("renderDashboardPanel('" + panel + "'"),
    panel + ' must be isolated so a secondary rendering failure cannot blank the core summary.',
  );
}

assert(
  health.includes('data-system-health-page'),
  'System Health must expose the page marker used by mobile viewport-clearance rules.',
);
assert(
  health.includes('function prepareMobileHealthTables()') && health.includes("table.classList.add('koa-mobile-card-table')"),
  'Wide System Health tables must be converted into labeled mobile cards after each dashboard render.',
);
assert(
  nav.includes('position: relative !important;') && nav.includes('top: auto !important;'),
  'The mobile workspace utility header must remain in normal flow instead of covering page content.',
);
const workspaceNavClose = nav.indexOf('</nav>');
const bottomNavMarkup = nav.indexOf('data-workspace-bottom-nav');
assert(
  workspaceNavClose >= 0 && bottomNavMarkup > workspaceNavClose,
  'The fixed mobile workspace bottom navigation must live outside the sticky workspace navigation containing block.',
);
assert(
  css.includes('/* System Health mobile viewport clearance */')
    && css.includes('scroll-padding-bottom: calc(6.4rem + env(safe-area-inset-bottom))')
    && css.includes('padding-bottom: calc(7rem + env(safe-area-inset-bottom)) !important'),
  'System Health must preserve bottom-navigation clearance and anchor/focus scroll padding on mobile.',
);

assert(
  health.includes('data-health-summary-grid')
    && health.includes('health-summary-card--overall')
    && health.includes('health-summary-card--checked'),
  'System Health must expose the responsive summary grid and balanced summary-card hooks.',
);
assert(
  css.includes('/* System Health responsive summary layout */')
    && css.includes('grid-template-columns: repeat(4, minmax(0, 1fr))')
    && css.includes('@media (max-width: 1099px)')
    && css.includes('@media (max-width: 639px)'),
  'System Health summary cards must use zero-minimum responsive grid tracks with desktop, tablet, and phone breakpoints.',
);

assert(
  css.includes('width: calc(100% - 2rem) !important;')
    && css.includes('max-width: 84rem !important;')
    && css.includes('body.koa-admin-page main[data-system-health-page] [data-app] {')
    && css.includes('body.koa-admin-page main[data-system-health-page] [data-app] > section {')
    && css.includes('section[data-health-summary-grid]:first-child')
    && css.includes('grid-template-columns: minmax(0, 1fr) !important;'),
  'System Health content and section widths must stay bounded at every breakpoint, with a one-column phone fallback.',
);
assert(
  visualQa.includes('("tablet",768,1024,1)')
    && visualQa.includes('("desktop-small",1280,800,1)')
    && visualQa.includes('("desktop-wide",1920,1080,1)')
    && visualQa.includes('summaryHeightSpread')
    && visualQa.includes('All four summary cards remain inside the viewport'),
  'Authenticated System Health visual QA must cover phone, tablet, and desktop widths and enforce summary-card geometry.',
);

assert(
  adminHealth.includes('export async function runHealthDashboardRefresh(context:Context)')
    && adminHealth.includes('const dashboard=await runHealthDashboardRefresh(context);'),
  'Manual System Health checks must reuse the exported dashboard-refresh implementation used by signed production QA.',
);
assert(
  healthSignal.includes("body?.action==='run-dashboard-refresh'")
    && healthSignal.includes("import { runHealthDashboardRefresh } from './admin-health.mts';"),
  'The signed GitHub OIDC control plane must expose the same full dashboard refresh for production verification.',
);
assert(
  visualQa.includes('def health_mobile_mode(browser_name,health_payload_path):')
    && visualQa.includes("headerPosition")
    && visualQa.includes("bottomPosition")
    && visualQa.includes("system-health-{viewport_name}-top.png")
    && visualQa.includes("system-health-{viewport_name}-bottom.png"),
  'Authenticated mobile System Health QA must capture screenshots and fail on header/bottom-nav geometry regressions.',
);

assert(
  visualQa.includes('documentScrollHeight')
    && visualQa.includes('fullScreenshotMode')
    && visualQa.includes('viewport-fallback')
    && visualQa.includes('15000/max(1,dpr)'),
  'Tall live System Health pages must fall back to bounded viewport screenshots so WebKit image-size limits cannot create false responsive failures.',
);
assert(
  visualWorkflow.includes('system-health-mobile-audit:')
    && visualWorkflow.includes('{"action":"run-dashboard-refresh"}')
    && visualWorkflow.includes('--mode health-mobile --browser chromium')
    && visualWorkflow.includes('--mode health-mobile --browser webkit'),
  'Production visual QA must execute the signed System Health refresh and mobile screenshot gate in both browser engines.',
);

assert(
  visualWorkflow.includes("if: github.event_name != 'pull_request' && always()")
    && visualWorkflow.includes('needs: deployed-smoke'),
  'Live System Health diagnostics must still run after an unrelated deployed-smoke failure so production health values and responsive evidence are captured.',
);

assert(
  visualWorkflow.includes("if: github.event_name == 'pull_request'")
    && visualWorkflow.includes('python -m http.server 4173 --directory dist')
    && visualWorkflow.includes('--base-url http://127.0.0.1:4173')
    && visualWorkflow.includes('koa-system-health-responsive-pr-'),
  'Pull requests that change System Health must run the responsive authenticated dashboard QA against the built branch in Chromium and WebKit.',
);


assert(
  systemHealth.includes('dynamicClientRows:')
    && systemHealth.includes('failureReason:')
    && systemHealth.includes('currentBookingStatus(record)'),
  'Signed production accounting verification must include every normalized client invariant row and select clients from authoritative booking lifecycle status.',
);
assert(
  healthSignal.includes("body?.action==='self-heal-production-deploy'")
    && healthSignal.includes("'/builds'")
    && healthSignal.includes('currentGithubMainSha()'),
  'The signed GitHub OIDC control plane must fail closed on current main SHA and expose Netlify production self-healing.',
);
assert(
  visualWorkflow.includes('--wait-seconds 300')
    && visualWorkflow.includes('self-heal-production-deploy')
    && visualWorkflow.includes('Wait for exact Netlify production SHA after fallback'),
  'Production QA must retrigger a missing exact-SHA deploy after the five-minute grace period and then verify the exact SHA.',
);

assert(
  netlifyConfig.includes('node scripts/verify_netlify_release_gate.mjs')
    && releaseGate.includes("const REQUIRED_WORKFLOW='Production visual QA'")
    && releaseGate.includes('&event=pull_request&per_page=50')
    && releaseGate.includes("String(latest?.conclusion||'')!=='success'"),
  'Netlify production builds must fail closed unless the exact merged PR head passed Production visual QA.',
);
assert(
  visualWorkflow.includes('statuses: write')
    && visualWorkflow.includes('System Health production release gate')
    && visualWorkflow.includes('/statuses/${GITHUB_SHA}')
    && visualWorkflow.includes('scripts/system_health_release_audit.py prepare')
    && visualWorkflow.includes('scripts/system_health_release_audit.py enforce')
    && visualWorkflow.includes('system-health-responsive-release.json')
    && visualWorkflow.includes('record-responsive-release-verification'),
  'Live production System Health QA must persist the exact 14-view responsive audit, publish its commit status, and fail the workflow unless every viewport passes.',
);
assert(
  visualWorkflow.includes("group: koa-production-visual-qa-${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}")
    && visualWorkflow.includes("cancel-in-progress: ${{ github.event_name == 'pull_request' }}")
    && visualWorkflow.includes('id: health-chromium')
    && visualWorkflow.includes('id: health-webkit')
    && visualWorkflow.includes('continue-on-error: true'),
  'Production responsive evidence must not be cancelled by a newer main release, and both browser engines must report before the final gate is enforced.',
);
assert(
  releaseAudit.includes('("phone-small", 320, 568)')
    && releaseAudit.includes('("phone", 390, 844)')
    && releaseAudit.includes('("tablet", 768, 1024)')
    && releaseAudit.includes('("tablet-wide", 1024, 768)')
    && releaseAudit.includes('("desktop-small", 1280, 800)')
    && releaseAudit.includes('("desktop", 1440, 900)')
    && releaseAudit.includes('("desktop-wide", 1920, 1080)')
    && releaseAudit.includes('BROWSERS = ("chromium", "webkit")')
    && releaseAudit.includes('"horizontalOverflowPx"')
    && releaseAudit.includes('"summaryRightOverflowPx"')
    && releaseAudit.includes('"screenshotMode"')
    && releaseAudit.includes('verification.get("passedCount") != 14'),
  'The durable responsive release audit must contain the exact seven breakpoints in Chromium and WebKit, overflow measurements, screenshot mode, and a strict 14/14 enforcement rule.',
);
assert(
  systemHealth.includes('export type ProductionResponsiveVerification')
    && systemHealth.includes('responsiveVerification?:ProductionResponsiveVerification|null')
    && systemHealth.includes('responsiveVerification:input?.responsiveVerification||previous?.responsiveVerification||null')
    && healthSignal.includes("body?.action==='record-responsive-release-verification'")
    && healthSignal.includes('normalizeResponsiveReleaseVerification(body?.verification||{},claims)'),
  'Every production release record must retain normalized responsive verification evidence under its durable per-deploy audit record.',
);
assert(
  health.includes('data-deploy-responsive-status')
    && health.includes('data-deploy-responsive-detail')
    && health.includes('System Health responsive release gate')
    && health.includes('14/14 responsive')
    && health.includes('Horizontal overflow')
    && health.includes('Summary overflow')
    && health.includes('Screenshot'),
  'System Health must surface current and historical exact responsive release results with browser, dimensions, overflow, commit/deploy identity, and screenshot mode.',
);

assert(
  systemHealth.includes("id:'login-alert-policy'")
    && systemHealth.includes("name:'Sign-in alert policy'")
    && systemHealth.includes('authenticationSecurityHealthSummary(context)')
    && systemHealth.includes('authSecurityDetails'),
  'System Health must include the structured sign-in alert policy check and authentication storage probes.',
);


assert(
  health.includes('data-accounting-invariant-table-body')
    && health.includes('data-accounting-filter-status')
    && health.includes('data-accounting-filter-taxable')
    && health.includes('data-accounting-filter-missing-estimate')
    && health.includes('data-accounting-release-select')
    && health.includes('function renderAccountingInvariantTable()'),
  'System Health must expose a filterable full client accounting invariant table with status, taxable-line, missing-estimate, and release filters.',
);
assert(
  adminHealth.includes('function accountingReleaseAudits(releases:any[])')
    && adminHealth.includes('accountingReleaseAudits:accountingReleaseAudits(hydratedReleases)'),
  'Authorized System Health dashboard data must include retained production accounting release audits for historical row inspection.',
);
assert(
  healthSignal.includes("body?.action==='read-production-accounting-audits'")
    && healthSignal.includes("body?.action==='read-production-accounting-audit'")
    && healthSignal.includes("body?.action==='run-sandbox-self-heal-drill'")
    && healthSignal.includes("productionMutationAttempted:false")
    && healthSignal.includes("gracePeriodSeconds:300"),
  'Signed production control plane must expose read-only accounting audit retrieval and an isolated five-minute sandbox self-heal drill.',
);
assert(
  visualWorkflow.includes('--wait-seconds 300')
    && visualWorkflow.includes('self-heal-production-deploy'),
  'Production visual QA must retain the exact-SHA five-minute Netlify self-healing gate.',
);

console.log('System Health dashboard hydration, responsive layout, and viewport-clearance regression checks passed.');
