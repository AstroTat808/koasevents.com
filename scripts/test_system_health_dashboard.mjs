import { readFile } from 'node:fs/promises';

const health = await readFile(new URL('../src/pages/admin/health/index.astro', import.meta.url), 'utf8');
const nav = await readFile(new URL('../src/components/StaffUtilityNav.astro', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/styles/global.css', import.meta.url), 'utf8');
const adminHealth = await readFile(new URL('../netlify/functions/admin-health.mts', import.meta.url), 'utf8');
const systemHealth = await readFile(new URL('../netlify/functions/_shared/system-health.ts', import.meta.url), 'utf8');
const adminQuickBooks = await readFile(new URL('../netlify/functions/admin-quickbooks.mts', import.meta.url), 'utf8');
const githubHealthSignal = await readFile(new URL('../netlify/functions/github-main-health-signal.ts', import.meta.url), 'utf8');
const healthSignal = await readFile(new URL('../netlify/functions/github-main-health-signal.ts', import.meta.url), 'utf8');
const visualQa = await readFile(new URL('./production_visual_qa.py', import.meta.url), 'utf8');
const visualWorkflow = await readFile(new URL('../.github/workflows/production-visual-qa.yml', import.meta.url), 'utf8');
const netlifyConfig = await readFile(new URL('../netlify.toml', import.meta.url), 'utf8');
const releaseGate = await readFile(new URL('./verify_netlify_release_gate.mjs', import.meta.url), 'utf8');

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
  nav.includes("const bottomNav = document.querySelector('[data-workspace-bottom-nav]');")
    && nav.includes("bottomNav?.querySelectorAll('[data-workspace-bottom-slot]')")
    && nav.includes("bottomNav?.querySelector('[data-workspace-more-toggle]')"),
  'Mobile bottom-nav hydration and More interactions must query the bottom-nav root instead of the separate workspace nav.',
);
assert(
  !nav.includes("nav?.querySelectorAll('[data-workspace-bottom-slot]')")
    && !nav.includes("nav?.querySelector('[data-workspace-more-toggle]')"),
  'Mobile bottom-nav controls must not be queried through the workspace nav because the fixed bar intentionally lives outside it.',
);
assert(
  nav.includes("const defaultMobileNav = ['home','crm','calendar','health'];")
    && nav.includes("let currentMobileNav = [...defaultMobileNav];")
    && nav.includes("...requested,...defaultMobileNav"),
  'Mobile navigation must default to Home, CRM, Calendar, and Health while preserving saved per-user overrides.',
);
assert(
  visualQa.includes('def admin_mobile_nav_mode(browser_name):')
    && visualQa.includes('custom_nav=["events","quickbooks","gallery","staff"]')
    && visualQa.includes('ADMIN_ROUTES')
    && visualQa.includes('"iphone-390",390,844,3')
    && visualQa.includes('"iphone-430",430,932,3'),
  'Visual QA must exercise default and customized mobile navigation across every major admin route at iPhone sizes.',
);
assert(
  visualWorkflow.includes('Verify iPhone admin bottom navigation in built PR')
    && visualWorkflow.includes('--mode admin-mobile --browser chromium')
    && visualWorkflow.includes('--mode admin-mobile --browser webkit')
    && visualWorkflow.includes('http://127.0.0.1:4175'),
  'Pull requests must verify the built mobile admin bottom navigation in Chromium and WebKit without weakening Netlify preview SSO.',
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
    && visualWorkflow.includes("len(report.get('results'))==7")
    && visualWorkflow.includes('len(refresh_checks)==14'),
  'Live production System Health QA must publish a commit status only after seven Chromium and seven WebKit viewport checks and Run checks now hydration pass.',
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


assert(
  systemHealth.includes('lineTotal:row?.lineTotal')
    && adminHealth.includes('function accountingRepairCategory(row:any)')
    && adminHealth.includes("return 'missing-estimate'")
    && adminHealth.includes("return 'taxable-lines'")
    && adminHealth.includes("return 'sales-line-mismatch'")
    && adminHealth.includes("return 'unverified'"),
  'Accounting release audits must retain sales-line totals and classify every repair-queue failure without changing QuickBooks.',
);
assert(
  health.includes('data-accounting-repair-queue')
    && health.includes('data-accounting-queue-filter="missing-estimate"')
    && health.includes('data-accounting-queue-filter="taxable-lines"')
    && health.includes('data-accounting-queue-filter="adjustment"')
    && health.includes('data-accounting-queue-filter="unverified"')
    && health.includes('Preview repair')
    && health.includes("action:'preview-accounting-repair'")
    && health.includes("action:'apply-accounting-repair'")
    && health.includes('Approve exact preview'),
  'System Health must provide grouped one-click accounting repair filters plus transaction-adjustment diagnostics and enforce preview-before-approval for row repairs.',
);
assert(
  health.includes("if(statusValue==='unverified'){action.textContent='Recheck'")
    && health.includes("if(statusValue==='passed'){action.textContent='Clean'"),
  'Unverified accounting rows must recheck instead of attempting a write, while passing rows remain non-actionable.',
);


assert(
  systemHealth.includes('discountAmtField')
    && systemHealth.includes('discountLineAmount')
    && systemHealth.includes('totalTax')
    && systemHealth.includes('nonSalesAdjustments')
    && adminHealth.includes('discountAmtField:row?.discountAmtField')
    && adminHealth.includes('totalTax:row?.totalTax'),
  'Signed accounting audits must retain raw QuickBooks discount, tax, and non-sales adjustment diagnostics.',
);
assert(
  adminQuickBooks.includes("action === 'preview-all-safe-accounting-repairs'")
    && adminQuickBooks.includes("action === 'preview-accounting-repair-write'")
    && adminQuickBooks.includes("approvalMode:'individual-write-only'")
    && adminQuickBooks.includes("approvalMode:'single-write'")
    && !adminQuickBooks.includes("action === 'apply-all-safe-accounting-repairs'"),
  'Bulk accounting repair must remain preview-only and require a fresh single-write preview before each QuickBooks mutation.',
);
assert(
  adminQuickBooks.includes('await integrationStore.delete(repairPreviewKey(preview.previewId))')
    && adminQuickBooks.includes('changes:[change]'),
  'The consolidated bulk preview must discard bulk approval tokens and narrow individual approvals to one exact write.',
);
assert(
  health.includes('data-accounting-preview-all-safe')
    && health.includes('data-accounting-bulk-preview-dialog')
    && health.includes('Preview exact write')
    && health.includes("action:'preview-all-safe-accounting-repairs'")
    && health.includes("action:'preview-accounting-repair-write'"),
  'System Health must expose a consolidated read-only repair report with per-write preview actions and no bulk approval control.',
);


assert(
  adminQuickBooks.includes("const scope = quickBooksAccountingScope(record)")
    && adminQuickBooks.includes("if (!lifecycle || !scope.actionable)")
    && adminQuickBooks.includes("if (!parent?.canApply)"),
  'Both row and bulk accounting repair previews must fail closed when the record is outside the current CRM-managed repair scope or the live preview is blocked.',
);


assert(
  adminQuickBooks.includes("Math.min(4, recordIds.length)")
    && adminQuickBooks.includes("await Promise.all(workers)"),
  'Bulk QuickBooks repair previews must use bounded concurrency rather than serial or unbounded live QBO requests.',
);
assert(
  health.includes('QBO adjustments')
    && health.includes("accountingQueueFilter==='adjustment'")
    && health.includes("rawCategory==='passed'&&hasAdjustment?'adjustment':rawCategory"),
  'System Health must treat transaction-level QBO adjustments as diagnostic context rather than an automatic repair failure.',
);


assert(
  systemHealth.includes('export async function accountingAdjustmentDiagnostics')
    && systemHealth.includes("discountAmtPresent")
    && systemHealth.includes("applyTaxAfterDiscountPresent")
    && systemHealth.includes("txnTaxDetailPresent")
    && githubHealthSignal.includes("read-accounting-adjustment-diagnostics")
    && githubHealthSignal.includes("accountingAdjustmentDiagnostics(context,recordIds)"),
  'Historical QuickBooks adjustments must be inspectable through a signed read-only exact-field diagnostic without entering the repair scope.',
);
assert(
  visualWorkflow.includes('Capture Jesse and Dion QBO adjustment diagnostics')
    && visualWorkflow.includes('QBO-CUST-29')
    && visualWorkflow.includes('QBO-CUST-44')
    && visualWorkflow.includes('accounting-adjustment-diagnostics.json')
    && visualWorkflow.includes("historicalQuickBooksImport")
    && visualWorkflow.includes("quickbooks-history"),
  'The production release must archive signed raw-field evidence for Jesse Gibson and Dion Pohaku after the exact SHA is live.',
);


assert(
  adminQuickBooks.includes('accountingScope:scope.mode')
    && adminQuickBooks.includes('accountingActionable:Boolean(scope.actionable)')
    && adminQuickBooks.includes('const lifecycle=currentBookingStatus(record);')
    && adminQuickBooks.includes('const scope=quickBooksAccountingScope(record);')
    && adminQuickBooks.includes('no QuickBooks write was attempted.'),
  'Accounting repair fingerprints and final apply must both revalidate lifecycle and writable accounting scope before any QuickBooks mutation.',
);

console.log('System Health dashboard hydration, responsive layout, and viewport-clearance regression checks passed.');
