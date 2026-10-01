import { readFile } from 'node:fs/promises';

const health = await readFile(new URL('../src/pages/admin/health/index.astro', import.meta.url), 'utf8');
const nav = await readFile(new URL('../src/components/StaffUtilityNav.astro', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/styles/global.css', import.meta.url), 'utf8');
const adminHealth = await readFile(new URL('../netlify/functions/admin-health.mts', import.meta.url), 'utf8');
const healthSignal = await readFile(new URL('../netlify/functions/github-main-health-signal.ts', import.meta.url), 'utf8');
const visualQa = await readFile(new URL('./production_visual_qa.py', import.meta.url), 'utf8');
const visualWorkflow = await readFile(new URL('../.github/workflows/production-visual-qa.yml', import.meta.url), 'utf8');

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
assert(
  css.includes('/* System Health mobile viewport clearance */')
    && css.includes('scroll-padding-bottom: calc(6.4rem + env(safe-area-inset-bottom))')
    && css.includes('padding-bottom: calc(7rem + env(safe-area-inset-bottom)) !important'),
  'System Health must preserve bottom-navigation clearance and anchor/focus scroll padding on mobile.',
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
  visualWorkflow.includes('system-health-mobile-audit:')
    && visualWorkflow.includes('{"action":"run-dashboard-refresh"}')
    && visualWorkflow.includes('--mode health-mobile --browser chromium')
    && visualWorkflow.includes('--mode health-mobile --browser webkit'),
  'Production visual QA must execute the signed System Health refresh and mobile screenshot gate in both browser engines.',
);

console.log('System Health dashboard hydration and mobile-clearance regression checks passed.');
