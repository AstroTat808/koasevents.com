# Koa legacy branch consolidation — 64 pinned reviews

**Baseline:** `a93ea45264a9bc0ee0d00b72940e8a50466a6317` · **Prepared:** 2026-10-13 · **Source:** [branch hygiene run 38237894943](https://github.com/AstroTat808/koasevents.com/actions/runs/38237894943).

**Non-destructive.** This inventory covers exactly 64 branches previously classified `needs-review`. None is authorized for deletion here. The separate 195-branch retirement queue is not part of these 64. All tip SHAs below were checked against current remote branches; earlier `reviewedSafe` decisions are not equivalent to a fresh patch-by-patch proof.

## Summary and sequencing

- **P0 (3 branches):** CI data privacy, Netlify exact-release recovery, and QuickBooks sandbox-only accounting correctness. Port only functionality proven absent from current main into focused PRs with security/regression checks.
- **P1 (5 branches):** Authentication activity/trusted-device health and System Health release/invariant evidence. Existing production features overlap these branches; compare tests and behaviors before coding.
- **P2 (4 branches):** WebKit contrast, responsive polish, synthetic trusted-device QA, and documentation-only consolidation.
- **Previously superseded (52 branches):** Prior exact-SHA assessments describe implemented replacements already on main. Revalidate against the latest code but avoid wholesale merges; preserve refs until that confirmation.

**Execution order:** (1) certify #268/#266/#269/#270 release stack, (2) separately verify the exact-SHA deletion ledger for the 195 *other* branches, (3) prioritize P0 comparison against current main and open PRs #253/#252/#255, (4) port minimal P0 deltas with non-destructive test evidence, (5) evaluate P1/P2, (6) re-run branch hygiene and independently approve any new deletion list.

## Twelve outstanding functional comparisons (manual-review queue)

| Priority | Branch | Exact tip | Ahead/behind main | Current evidence | Decision / next verification |
|---|---|---|---|---|---|
| P0 | `fix/accounting-invariants-netlify-selfheal` | `3036aca1aec9aa87f285a756fc3e67f8132422f9` | 9 / 267 | Current QuickBooks scope/repair functionality exists; distinct sandbox self-heal behavior unverified | Diff invariant and sandbox simulations; retain individual write approval, financial privacy and exact release gates; only port unique read-only diagnostics |
| P0 | `fix/netlify-prod-recovery-health-gates-20261009` | `0f33e7ead4729a747fa55bf06152beb24d12f1ea` | 8 / 83 | Recovery classification and health-status scripts absent by path; newer #261 recovery exists | Compare helper decisions and timeout/failure semantics with shipped GitHub-owned recovery and draft #255; port uncovered fail-closed cases only |
| P0 | `security/redact-production-ci-data-2026-10-08` | `25a10d579a6a1223d50b0a1eaf36a62b25f9bd25` | 16 / 88 | Missing dedicated CI-privacy enforcement source on main; PR #253 offers successor | Review #253 and #252; port only missing no-PII workflow gate/tests and redacted incident history; never publish production payloads |
| P1 | `chore/system-health-release-gate-20261001` | `beb190e861326dee14f6cb60611b6d97572e8dd4` | 5 / 247 | Exact-SHA release validation is already on main | Review branch-only edge cases in Netlify gate; keep active gate strict and reject stale QA artifacts |
| P1 | `feat/security-activity-summary` | `2748c6f38e54183c78fc6985fb247d464f2383b1` | 5 / 272 | Security Activity UI and auth-security APIs already present on main | Diff distinct event grouping, retention and permissions; add only missing tests or accessible UI elements |
| P1 | `feat/system-health-invariant-table-sandbox-selfheal` | `c456b8dd71182600ee71a6c7f8567b6d4a6c230e` | 6 / 227 | Current System Health, sandbox and release guard overlap this feature | Compare invariant table and failure diagnostics; preserve fail-closed behavior and never perform live self-heal |
| P1 | `feat/system-health-responsive-release-audit-20261001` | `a44466dd46d9f12161e3f859df9c7716311ddf2c` | 9 / 194 | Original audit helper script absent; current release QA already enforces 14 viewports | Compare source-only audit diagnostics with #266/#269/#270 gates; port only missing named-viewport evidence and diagnostic detail |
| P1 | `feat/trusted-browser-device-health` | `b0724da59058b57a371ce95bd111285a38ef7589` | 8 / 247 | Main already has trusted browsers, device expiration and last-used UI | Verify missing health probes and edge-case alerts before any surgical port |
| P2 | `audit/legacy-branch-consolidation-20261011` | `6f59b87855635c2a1327d82b75aef399d9cc97dd` | 1 / 2 | Four review-only documents are absent on main; no runtime functionality | Preserve useful exact-SHA analyses in this consolidated review without merging stale runtime code |
| P2 | `fix/system-health-responsive-layout-v2-20261001` | `254b0ceeb4bde2cb6971638edf0cf643a4f7488e` | 3 / 267 | Responsive System Health fixes and seven-browser widths already on main | Review only CSS visual diffs in current Chromium/WebKit screenshots; port small regressions if reproduced |
| P2 | `fix/webkit-admin-dark-contrast` | `e534f4ba8b956c2ce41dd81ae587dbb4f7e3923d` | 2 / 103 | Current Dark Mode QA and contrast testing cover overlapping routes | Compare WebKit-specific contrast rules and retain only measurable contrast improvements |
| P2 | `test/trusted-browser-live-verification` | `5a0efaaf992a581b4480f388a3690ed19e953a58` | 1 / 198 | Authenticated trusted-browser QA already runs in production | Compare assertions for untested trust/expiry edge cases; port only missing synthetic tests |

### Changed files for unresolved branches

**fix/accounting-invariants-netlify-selfheal** (`3036aca1aec9aa87f285a756fc3e67f8132422f9`)
- `.github/workflows/production-visual-qa.yml`
- `netlify/functions/_shared/quickbooks-accounting-scope.mjs`
- `netlify/functions/_shared/system-health.ts`
- `netlify/functions/github-main-health-signal.ts`
- `scripts/test_quickbooks_accounting_scope.mjs`
- `scripts/test_system_health_dashboard.mjs`

**fix/netlify-prod-recovery-health-gates-20261009** (`0f33e7ead4729a747fa55bf06152beb24d12f1ea`)
- `.github/workflows/production-visual-qa.yml`
- `netlify/functions/_shared/production-deploy-recovery.mjs`
- `netlify/functions/github-main-health-signal.ts`
- `package.json`
- `scripts/production_release_health_status.py`
- `scripts/test_production_deploy_recovery.mjs`
- `scripts/verify_netlify_release_gate.mjs`

**security/redact-production-ci-data-2026-10-08** (`25a10d579a6a1223d50b0a1eaf36a62b25f9bd25`)
- `.github/workflows/critical-integrations-rollback-drill.yml`
- `.github/workflows/production-visual-qa.yml`
- `docs/security/2026-10-08-github-actions-public-exposure-inventory.md`
- `scripts/test_ci_sensitive_data_guard.mjs`

**chore/system-health-release-gate-20261001** (`beb190e861326dee14f6cb60611b6d97572e8dd4`)
- `.github/workflows/production-visual-qa.yml`
- `netlify.toml`
- `scripts/test_system_health_dashboard.mjs`
- `scripts/verify_netlify_release_gate.mjs`

**feat/security-activity-summary** (`2748c6f38e54183c78fc6985fb247d464f2383b1`)
- `netlify/functions/_shared/auth-security.ts`
- `netlify/functions/admin-auth-security.mts`
- `netlify/functions/auth-record.mts`
- `src/pages/admin/staff/index.astro`

**feat/system-health-invariant-table-sandbox-selfheal** (`c456b8dd71182600ee71a6c7f8567b6d4a6c230e`)
- `.github/workflows/critical-integrations-rollback-drill.yml`
- `netlify/functions/admin-health.mts`
- `netlify/functions/github-main-health-signal.ts`
- `scripts/test_system_health_dashboard.mjs`
- `src/pages/admin/health/index.astro`

**feat/system-health-responsive-release-audit-20261001** (`a44466dd46d9f12161e3f859df9c7716311ddf2c`)
- `.github/workflows/production-visual-qa.yml`
- `netlify/functions/_shared/system-health.ts`
- `netlify/functions/github-main-health-signal.ts`
- `scripts/system_health_release_audit.py`
- `scripts/test_system_health_dashboard.mjs`
- `src/pages/admin/health/index.astro`

**feat/trusted-browser-device-health** (`b0724da59058b57a371ce95bd111285a38ef7589`)
- `netlify/functions/_shared/auth-security.ts`
- `netlify/functions/_shared/system-health.ts`
- `netlify/functions/account-security.mts`
- `scripts/test_auth_security_risk.mjs`
- `scripts/test_system_health_dashboard.mjs`
- `src/components/StaffUtilityNav.astro`
- `src/pages/admin/staff/index.astro`

**audit/legacy-branch-consolidation-20261011** (`6f59b87855635c2a1327d82b75aef399d9cc97dd`)
- `docs/branch-consolidation/2026-10-11/README.md`
- `docs/branch-consolidation/2026-10-11/accounting-invariants.md`
- `docs/branch-consolidation/2026-10-11/release-system-health.md`
- `docs/branch-consolidation/2026-10-11/security-privacy.md`

**fix/system-health-responsive-layout-v2-20261001** (`254b0ceeb4bde2cb6971638edf0cf643a4f7488e`)
- `scripts/production_visual_qa.py`
- `src/pages/admin/health/index.astro`
- `src/styles/global.css`

**fix/webkit-admin-dark-contrast** (`e534f4ba8b956c2ce41dd81ae587dbb4f7e3923d`)
- `scripts/test_theme_system.mjs`
- `src/styles/global.css`

**test/trusted-browser-live-verification** (`5a0efaaf992a581b4480f388a3690ed19e953a58`)
- `.github/workflows/production-visual-qa.yml`

## Fifty previously reviewed branch tips — supersession comparison queue

These 52 assessments are **source-derived from the repo's September 30 policy**. Their tips are unchanged as of this audit, but `ahead` commits may still exist; prior 'superseded' conclusions must be checked before any action. All remain preserved.

| Branch | Exact tip (unchanged) | Earlier preservation/supersession finding | Fresh action |
|---|---|---|---|
| `admin-wedding-profitability-and-package-sales-2026-09-23` | `c3267c3e64ab86d026e3ec4b6a9b6d9af6447a54` | Superseded by the current Wedding Profitability, central catalog/package rules, and current public-site presentation on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `codex/p0-tenant-sales-ingest` | `48e13b8700597c6a0f3e60dbb70e75f38fc2b484` | Superseded by the current tenant context/storage, Tenant #2 isolation QA, Super Admin lifecycle controls, and signed tenant-isolation readiness already on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `codex/venueloom-super-admin-ops` | `c895011681b1b62d9611a45d88fc43b8dd44399e` | Superseded by the current tenant context/storage, Tenant #2 isolation QA, Super Admin lifecycle controls, and signed tenant-isolation readiness already on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `deploy-pipeline-audit` | `6d94d14f07f57bc0c784cafd55c387854e978746` | Temporary deployment/debug trigger work has no remaining production value; current Netlify release guards and production QA replace it. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `deploy-pipeline-verification` | `eb466160a8f4b1f329e53a6647351f5ebb62dbb6` | Temporary deployment/debug trigger work has no remaining production value; current Netlify release guards and production QA replace it. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feat/credential-health-thresholds-report-timeline` | `54f2e8fdf1125d10733b242b8e7ebb35af3a0f33` | Superseded by current System Health: credential thresholds/timeline, Rollback Ready, live integration guards, active filters, and production verification are already on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feat/critical-integrations-rollback-readiness-audit-drill` | `64ec7b2e48193fbb7f7d43afe72a3c4684e2860a` | Superseded by current System Health: credential thresholds/timeline, Rollback Ready, live integration guards, active filters, and production verification are already on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feat/system-health-filter-context` | `9a29dd0326d699e16c8f20f80968bb4d25610931` | Superseded by current System Health: credential thresholds/timeline, Rollback Ready, live integration guards, active filters, and production verification are already on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/accounting-history-filters-alert-test-flex-schedules` | `450197a4574acdf757698f6370f3254c06524efd` | Superseded by current QuickBooks/accounting scope, reconciliation, payment-rule, invariant, repair, damage-deposit, and production release-guard implementations on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/accounting-invariant-v2` | `d558d309da17de9c7d5ec1786b3584e3f92d2ab6` | Superseded by current QuickBooks/accounting scope, reconciliation, payment-rule, invariant, repair, damage-deposit, and production release-guard implementations on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/crm-audit-alert-sync-deposit-defaults` | `2ab6fbf12411fcdd78d2c601680c8f7a59f210bd` | Superseded by current QuickBooks/accounting scope, reconciliation, payment-rule, invariant, repair, damage-deposit, and production release-guard implementations on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/crm-audit-alert-sync-deposit-defaults-final` | `ab14de92ecaa5fb99d897d4f26f99611cc49c936` | Superseded by current QuickBooks/accounting scope, reconciliation, payment-rule, invariant, repair, damage-deposit, and production release-guard implementations on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/crm-catalog-get-20260920` | `c8feb3084995adeb0f9e6c91318174cc43ca989e` | Reviewed against current main and later successor work; unique commits are obsolete implementation history rather than missing production capability. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/crm-catalog-get-current` | `89bafdbf85f0f60cf447ab18c0381b8de896cadc` | Reviewed against current main and later successor work; unique commits are obsolete implementation history rather than missing production capability. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/custom-payment-presets-comparison-rules` | `8f269359358c9fb8b77c93b70de0231e923a906e` | Superseded by current QuickBooks/accounting scope, reconciliation, payment-rule, invariant, repair, damage-deposit, and production release-guard implementations on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/custom-payment-presets-comparison-rules-final` | `b9a33a503090e3bf87206b2354afe858455cdbac` | Superseded by current QuickBooks/accounting scope, reconciliation, payment-rule, invariant, repair, damage-deposit, and production release-guard implementations on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/dynamic-accounting-invariants` | `793fbbed4631802ae3572b0b70529ba2aabd077a` | Superseded by current QuickBooks/accounting scope, reconciliation, payment-rule, invariant, repair, damage-deposit, and production release-guard implementations on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/inline-audit-hourly-payment-schedules` | `32251ee22306b8bdce3874f5ce9f54c109c2ab9d` | Superseded by current QuickBooks/accounting scope, reconciliation, payment-rule, invariant, repair, damage-deposit, and production release-guard implementations on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/locked-get-exempt-financial-summary` | `409a2413c4f4e8380f8867f51eb4bbfeb8ad33c2` | Reviewed against current main and later successor work; unique commits are obsolete implementation history rather than missing production capability. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/mobile-bar-staffing-operations` | `b93d248b3056f2758ae0059d0aa36f01eb602447` | Superseded by the current Mobile Bar profitability dashboard, pricing controls, staffing/workforce, payroll, and bartender-portal implementation on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/mobile-bar-workforce-portal` | `2e3e0d4e74fb0c1d4a6d67a5ef666b30d953b620` | Superseded by the current Mobile Bar profitability dashboard, pricing controls, staffing/workforce, payroll, and bartender-portal implementation on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/mobile-profit-goals-simulator-scenarios` | `cccbff94af3021720dcaa427efe42dc9fe8f388b` | Superseded by the current Mobile Bar profitability dashboard, pricing controls, staffing/workforce, payroll, and bartender-portal implementation on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/mobile-profit-planning-controls` | `50a19759dc308a13059fd885c0794ab67a01a71c` | Superseded by the current Mobile Bar profitability dashboard, pricing controls, staffing/workforce, payroll, and bartender-portal implementation on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/mobile-profit-planning-controls-v2` | `9a3fc02515f08eb12dce9932db39913bde14c0fe` | Superseded by the current Mobile Bar profitability dashboard, pricing controls, staffing/workforce, payroll, and bartender-portal implementation on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/mobile-profit-planning-intelligence` | `214c7ba72fcd5bebb77428c6a95f66f0aaa17b61` | Superseded by the current Mobile Bar profitability dashboard, pricing controls, staffing/workforce, payroll, and bartender-portal implementation on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/mobile-profit-seasonality-scoring-staffing` | `d715093e0287ea8ec71c0a287ac4bd30b96287ee` | Superseded by the current Mobile Bar profitability dashboard, pricing controls, staffing/workforce, payroll, and bartender-portal implementation on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/mobile-profit-seasonality-scoring-staffing-v2` | `a219f3b402423170f7d1f98904a19beca91ac3c7` | Superseded by the current Mobile Bar profitability dashboard, pricing controls, staffing/workforce, payroll, and bartender-portal implementation on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/payment-rule-simulator-drag-value` | `b6bea05dd0230aeb441e0ede022702e695d25a3c` | Superseded by current QuickBooks/accounting scope, reconciliation, payment-rule, invariant, repair, damage-deposit, and production release-guard implementations on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/payment-rule-simulator-drag-value-final` | `1bbe9c9884359bcce1b44d1c8a83c0cfb5c76535` | Superseded by current QuickBooks/accounting scope, reconciliation, payment-rule, invariant, repair, damage-deposit, and production release-guard implementations on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/payment-rule-simulator-drag-value-live` | `0657891766fc0df9ae43ce2c547be46223a2545e` | Superseded by current QuickBooks/accounting scope, reconciliation, payment-rule, invariant, repair, damage-deposit, and production release-guard implementations on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/refundable-damage-deposit` | `d19df1f8bd84cd2d8f247072dedc1f734972a7b1` | Superseded by current QuickBooks/accounting scope, reconciliation, payment-rule, invariant, repair, damage-deposit, and production release-guard implementations on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/security-abuse-controls` | `a6cce8718e0abc0eb025952bc855565da9e06a6e` | Superseded by current fail-closed Turnstile, security telemetry, blocklist, and production QA controls on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/tenant2-sandbox-migration-e2e` | `b9b0b8a6910b9d9391d07eab6feb5230d2aadce7` | Superseded by the current tenant context/storage, Tenant #2 isolation QA, Super Admin lifecycle controls, and signed tenant-isolation readiness already on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/venueloom-p0-multitenant` | `3a4c36454aa504eb886909476e027ecf4d7259f4` | Superseded by the current tenant context/storage, Tenant #2 isolation QA, Super Admin lifecycle controls, and signed tenant-isolation readiness already on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/venueloom-p0-tenancy-onboarding` | `cdf357cda4c4beb9fe8fac6e8292a440f045f527` | Superseded by the current tenant context/storage, Tenant #2 isolation QA, Super Admin lifecycle controls, and signed tenant-isolation readiness already on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/venueloom-saas-boundary` | `c96a476ea02d51e0cd2b9f2eaccaa5620916999f` | Superseded by the current tenant context/storage, Tenant #2 isolation QA, Super Admin lifecycle controls, and signed tenant-isolation readiness already on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `feature/venueloom-tenant-foundation` | `fd9c956b8b86a63e3a8d9ce49216ec305fbe1b1e` | Superseded by the current tenant context/storage, Tenant #2 isolation QA, Super Admin lifecycle controls, and signed tenant-isolation readiness already on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `fix/crm-duplicate-booking-merge` | `49b11322e2d4033960949e24842a545a82870056` | Reviewed replacement is already on main through the consolidated duplicate-booking/historical-accounting implementation and follow-up System Health scope fix. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `fix/crm-duplicate-bookings` | `bc74482cc62bf342e5f5e8bf734a14c27ba36a98` | Reviewed replacement is already on main through the consolidated duplicate-booking/historical-accounting implementation and follow-up System Health scope fix. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `fix/historical-qbo-import-action-center` | `9cd15c994f79aef956001fdc7a4b04cf01a59495` | Superseded by current QuickBooks/accounting scope, reconciliation, payment-rule, invariant, repair, damage-deposit, and production release-guard implementations on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `fix/qbo-audit-live-verification-health` | `97fc3863bc56a1f9d64eb48936105ba0bb4c0158` | Superseded by current QuickBooks/accounting scope, reconciliation, payment-rule, invariant, repair, damage-deposit, and production release-guard implementations on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `fix/qbo-audit-live-verification-health-v2` | `0aa96953f10c393e33bece9610b873208840f8a9` | Superseded by current QuickBooks/accounting scope, reconciliation, payment-rule, invariant, repair, damage-deposit, and production release-guard implementations on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `fix/qbo-audit-live-verification-health-v3` | `75d50ea45a47f51769d265b1a72657138efbcd63` | Superseded by current QuickBooks/accounting scope, reconciliation, payment-rule, invariant, repair, damage-deposit, and production release-guard implementations on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `fix/qbo-crm-reconciliation-grand-total` | `6eef522a9eb604209b97790db38b95fd2aa2c8a2` | Superseded by current QuickBooks/accounting scope, reconciliation, payment-rule, invariant, repair, damage-deposit, and production release-guard implementations on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `fix/role-aware-workspace-nav` | `d1526ef1dbe9c629befe053ee9115d71eccb9c88` | Superseded by current StaffUtilityNav capability-aware navigation, alert center, and responsive workspace controls on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `fix/workspace-collapse-toggle` | `d287423cc266b4b3d88dc987d35d6169f0cb9866` | Superseded by current StaffUtilityNav capability-aware navigation, alert center, and responsive workspace controls on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `gallery-export-2026-09-18` | `e98a6ee023e11cfd21f98ce86ef206f5551cbd59` | Preserved the useful gallery-export capability as a safer manual, read-only workflow on current main; the old PR-triggered implementation is superseded. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `photo-refresh` | `7b403266d2f644c9e2872044ee34120c99eb950e` | Superseded by the current Wedding Profitability, central catalog/package rules, and current public-site presentation on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `productization/venueloom-tenant-foundation` | `99b711076304c852a50005dacb2e004a7af0421e` | Preserved the durable VenueLoom brand and launch-roadmap material under docs/venueloom/archive; its older runtime tenant implementation is superseded by current main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `profitability-crm-pricing-performance-2026-09-23` | `e4854d7b5f5ab23b4142aef7906c1a56bcaab102` | Superseded by the current Wedding Profitability, central catalog/package rules, and current public-site presentation on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `revise-wedding-package-value-2026-09-23` | `d788b1254b4b4486a507a9c183462eb90e414776` | Superseded by the current Wedding Profitability, central catalog/package rules, and current public-site presentation on main. | Compare exact tip with latest main; keep until explicit reviewed closure |
| `source-bundle-trigger` | `d2666725f0983d54d39378a0ba798d46b3c3ecdb` | Temporary deployment/debug trigger work has no remaining production value; current Netlify release guards and production QA replace it. | Compare exact tip with latest main; keep until explicit reviewed closure |

## Mandatory acceptance and preservation rules

1. **No deletion of any of these 64** as a side effect of the separate 195 queue; exact SHA and full-history evidence are mandatory.
2. **Security/PII:** no authenticated screenshots or raw customer/accounting values in public CI artifacts, logs, or issue comments. Prefer synthetic QA.
3. **QuickBooks:** no new automatic writes or broad self-heal; individual approval for every financial write remains mandatory.
4. **Production:** exact GitHub SHA equals Netlify published SHA and live deploy ID; current System Health zero failures, full Chromium/WebKit QA, and durable history persistence must all pass.
5. **Patch equivalence:** branch-ahead counts and identical filenames are not proof of distinct user-facing behavior; compare code paths and tests before port.
6. **Single-purpose PRs:** every port documents the original branch tip, missing behavioral gap, changed files, before/after tests, and explicit rollback strategy.

**Status:** planning artifact only. No legacy branch is merged, retired, or automatically ported by this document.
