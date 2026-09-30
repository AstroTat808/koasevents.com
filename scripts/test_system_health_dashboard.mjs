import { readFile } from 'node:fs/promises';

const health = await readFile(new URL('../src/pages/admin/health/index.astro', import.meta.url), 'utf8');
const nav = await readFile(new URL('../src/components/StaffUtilityNav.astro', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/styles/global.css', import.meta.url), 'utf8');

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
  nav.includes('position: relative !important;') && nav.includes('top: auto !important;'),
  'The mobile workspace utility header must remain in normal flow instead of covering page content.',
);
assert(
  css.includes('/* System Health mobile viewport clearance */')
    && css.includes('scroll-padding-bottom: calc(6.4rem + env(safe-area-inset-bottom))')
    && css.includes('padding-bottom: calc(7rem + env(safe-area-inset-bottom)) !important'),
  'System Health must preserve bottom-navigation clearance and anchor/focus scroll padding on mobile.',
);

console.log('System Health dashboard hydration and mobile-clearance regression checks passed.');
