# One-time exact-SHA branch retirement (October 12, 2026)

**Scope:** At most 195 branches from GitHub branch-hygiene run #38237894943, frozen by the SHA256 of report.json `6dbf4cbcd41b883d7302c9d5189c21681ddb713a722f2d117d304cf0ae856adf`. Snapshot main: `1b2d17c14beb0b31687f7eb5dae55c831aa872b0`.

## Release preconditions

PR #268 (fixing the release-history Bash heredoc) and PR #266 must both be merged and reachable from current main. The original #261 production run (#38237525321) must have completed; its historical failure cannot be erased by changing a later commit. Instead, the **latest exact-current-main** Production Visual QA (including persistence of certified release history, Catalog Manager, Chromium/WebKit, and signed System Health) must fully succeed. The exact main commit must also have successful `System Health production release gate` and `System Health responsive audit` statuses. If any current check is failed, pending, missing, or stale, no deletion runs.

## Deletion safety

The approved list never expands. The automation downloads the original branch-hygiene report, validates its digest, and selects the original 195 safe-to-delete branches already past their seven-day window. It then runs a new full-history branch classification and rechecks every candidate against its original exact SHA and current classification, grace period, open PR dependencies and GitHub branch protection. Every remote delete uses a Git `--force-with-lease` with the approved 40-character SHA, so a branch that moved cannot be deleted. No branch outside the 195 frozen set may be deleted.

## Permanent audit

Before performing any deletion, the automation creates an issue titled `[Audit] Koa exact-SHA branch retirement — 2026-10-12 approved 195` and includes the entire approved branch/SHA whitelist. It appends a comment after every 15 checks with explicit `DELETED`, `SKIPPED`, or `REJECTED` outcomes; final totals remain in the issue. If a ledger write fails, execution stops. This record remains in GitHub issues independently of transient Actions artifacts.

The workflow is non-destructive on PRs. The write-permission job is invoked only by successful default-branch Production Visual QA completion. New or later-eligible branches require a separately authorized snapshot and workflow.

## Exact post-delete reconciliation

After all 195 approved refs have explicit outcomes, the job checks the actual remote Git refs against every claimed deletion, skip, or rejection. It also proves that the frozen 22 grace-period, 64 needs-review and 20 keep branches remain present. A discrepancy leaves the permanent ledger unfinalized and fails the job. The complete JSON reconciliation is retained as a GitHub Actions artifact for 90 days; its SHA256 is recorded in the durable GitHub issue.
