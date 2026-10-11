# Release certification, System Health and responsive QA

**Status:** review-only; functional changes are not ported. **Baseline:** `5f21f3b3f09328967c62877bfc8055a9e115dac7`.

Current main already enforces exact deployed SHA and deploy-ID equality, fail-closed signed System Health, and 14 Chromium/WebKit responsive checks. PR #261 is the active release-attestation successor.

## Source branches pinned by exact SHA

| Branch | Pinned head SHA | Ahead / behind baseline main | Origin |
|---|---|---:|---|
| `chore/system-health-release-gate-20261001` | [`beb190e861326dee14f6cb60611b6d97572e8dd4`](https://github.com/AstroTat808/koasevents.com/commit/beb190e861326dee14f6cb60611b6d97572e8dd4) | 5 / 238 | 2026-10-11 exact-SHA audit |
| `feat/system-health-invariant-table-sandbox-selfheal` | [`c456b8dd71182600ee71a6c7f8567b6d4a6c230e`](https://github.com/AstroTat808/koasevents.com/commit/c456b8dd71182600ee71a6c7f8567b6d4a6c230e) | 6 / 218 | 2026-10-11 exact-SHA audit |
| `feat/system-health-responsive-release-audit-20261001` | [`a44466dd46d9f12161e3f859df9c7716311ddf2c`](https://github.com/AstroTat808/koasevents.com/commit/a44466dd46d9f12161e3f859df9c7716311ddf2c) | 9 / 185 | 2026-10-11 exact-SHA audit |
| `fix/netlify-prod-recovery-health-gates-20261009` | [`0f33e7ead4729a747fa55bf06152beb24d12f1ea`](https://github.com/AstroTat808/koasevents.com/commit/0f33e7ead4729a747fa55bf06152beb24d12f1ea) | 8 / 74 | 2026-10-11 exact-SHA audit |
| `fix/system-health-responsive-layout-v2-20261001` | [`254b0ceeb4bde2cb6971638edf0cf643a4f7488e`](https://github.com/AstroTat808/koasevents.com/commit/254b0ceeb4bde2cb6971638edf0cf643a4f7488e) | 3 / 258 | 2026-10-11 exact-SHA audit |
| `fix/webkit-admin-dark-contrast` | [`e534f4ba8b956c2ce41dd81ae587dbb4f7e3923d`](https://github.com/AstroTat808/koasevents.com/commit/e534f4ba8b956c2ce41dd81ae587dbb4f7e3923d) | 2 / 94 | 2026-10-11 exact-SHA audit |
| `fix/production-main-sha-propagation-20261010` | [`578d05128017d80a0910458d156eb036c0c22f66`](https://github.com/AstroTat808/koasevents.com/commit/578d05128017d80a0910458d156eb036c0c22f66) | 1 / 62 | PR #256 closed unmerged after snapshot |

## Verification before forward-port

1. Verify signed production health and full 14 named viewport/browser results without changing thresholds
2. Compare old invariant-table and responsive evidence schemas with current System Health fields; preserve only genuinely absent fields
3. Check native dialog centering, WebKit dark contrast and 390x844/1440x900 screenshots; do not reuse stale CSS wholesale
4. Do not merge older recovery scripts that weaken 503, deploy recovery, OIDC or exact-SHA release gates
5. If no functional gap remains, record explicit supersession and close the review item

## Review conclusion

_Not yet determined at this point. A branch being ahead of main is not proof its behavior is absent from main. Revalidate code impact, changes already implemented by later PRs, and applicable release gates first._
