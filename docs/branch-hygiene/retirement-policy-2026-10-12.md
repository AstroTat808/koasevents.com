# One-time exact-SHA branch retirement (October 12, 2026)

**Scope:** At most 195 branches from GitHub branch-hygiene run #38237894943, frozen by the SHA256 of report.json `6dbf4cbcd41b883d7302c9d5189c21681ddb713a722f2d117d304cf0ae856adf`. Snapshot main: `1b2d17c14beb0b31687f7eb5dae55c831aa872b0`.

## Release preconditions

PR #266 must be merged to main. PR #261's original production run (#38237525321) and the latest main Production Visual QA must both be successful. The exact main commit must have successful `System Health production release gate` and `System Health responsive audit` statuses. If any check is failed, pending, missing, or stale, no deletion runs.

## Deletion safety

The approved list never expands. The automation downloads the original branch-hygiene report, validates its digest, and selects the original 195 safe-to-delete branches already past their seven-day window. It then runs a new full-history branch classification and rechecks every candidate against its original exact SHA and current classification, grace period, open PR dependencies and GitHub branch protection. Every remote delete uses a Git `--force-with-lease` with the approved 40-character SHA, so a branch that moved cannot be deleted. No branch outside the 195 frozen set may be deleted.

## Permanent audit

Before performing any deletion, the automation creates an issue titled `[Audit] Koa exact-SHA branch retirement — 2026-10-12 approved 195` and includes the entire approved branch/SHA whitelist. It appends a comment after every 15 checks with explicit `DELETED`, `SKIPPED`, or `REJECTED` outcomes; final totals remain in the issue. If a ledger write fails, execution stops. This record remains in GitHub issues independently of transient Actions artifacts.

The workflow is non-destructive on PRs. The write-permission job is invoked only by successful default-branch Production Visual QA completion. New or later-eligible branches require a separately authorized snapshot and workflow.
