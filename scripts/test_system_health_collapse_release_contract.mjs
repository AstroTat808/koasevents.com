#!/usr/bin/env node
// Preserve PR #266's release-contract assertions while privacy-specific dashboard
// regression tests are reconciled. The separate runtime and browser tests remain mandatory.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const [health, baseLayout, healthCollapse, visualQa, visualWorkflow] = await Promise.all([
  read('src/pages/admin/health/index.astro'),
  read('src/layouts/BaseLayout.astro'),
  read('public/system-health-collapse.js'),
  read('scripts/production_visual_qa.py'),
  read('.github/workflows/production-visual-qa.yml'),
]);

assert(
  baseLayout.includes("healthCollapseScript.src = '/system-health-collapse.js';"),
  'The shared layout must load the System Health collapse controller without an extra script block.',
);
assert(
  visualQa.includes('collapse_state=page.evaluate(')
    && visualQa.includes('if width in (390,1440):')
    && visualQa.includes('criticalForcedOpen')
    && visualQa.includes('recoveredCollapsed')
    && visualWorkflow.includes("if name in ('phone','desktop'):")
    && visualWorkflow.includes("'initialClosed','criticalInitiallyOpen','manuallyOpened'")
    && visualWorkflow.includes("'manuallyClosed','criticalForcedOpen','recoveredCollapsed'")
    && visualWorkflow.includes("'accordionGate':'pass' if reports_complete else 'failed-or-incomplete'")
    && visualWorkflow.includes('python scripts/production_visual_qa.py --mode health-mobile --browser chromium')
    && visualWorkflow.includes('python scripts/production_visual_qa.py --mode health-mobile --browser webkit'),
  'Both browser suites must fail closed on iPhone and desktop Health accordion interactions in PR and production release gates.',
);
assert(
  healthCollapse.includes("section.dataset.healthSectionStatus === 'red'")
    && healthCollapse.includes('const nextCollapsed = critical ? false : Boolean(collapsed);')
    && healthCollapse.includes('syncAll({ initial: true })')
    && healthCollapse.includes('.koa-mobile-collapsed-content'),
  'System Health sections must default collapsed across viewports while critical sections remain forced open.',
);
assert(
  !healthCollapse.includes("toggle.addEventListener('click'")
    && health.includes("button.addEventListener('click',(event)=>{"),
  'Accordion button must have exactly one toggle listener; duplicate desktop listeners reverse an open or close click.',
);
console.log('PASS | all four original accordion source/release contract assertions preserved.');
