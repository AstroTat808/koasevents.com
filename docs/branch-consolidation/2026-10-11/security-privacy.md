# Security activity, trusted devices and CI data privacy

**Status:** review-only; functional changes are not ported. **Baseline:** `5f21f3b3f09328967c62877bfc8055a9e115dac7`.

Current main already includes trusted browser controls and Turnstile security tests. Open PR #253 provides CI privacy hardening; do not bypass it or resurrect logging of customer or accounting data.

## Source branches pinned by exact SHA

| Branch | Pinned head SHA | Ahead / behind baseline main | Origin |
|---|---|---:|---|
| `feat/security-activity-summary` | [`2748c6f38e54183c78fc6985fb247d464f2383b1`](https://github.com/AstroTat808/koasevents.com/commit/2748c6f38e54183c78fc6985fb247d464f2383b1) | 5 / 263 | 2026-10-11 exact-SHA audit |
| `feat/trusted-browser-device-health` | [`b0724da59058b57a371ce95bd111285a38ef7589`](https://github.com/AstroTat808/koasevents.com/commit/b0724da59058b57a371ce95bd111285a38ef7589) | 8 / 238 | 2026-10-11 exact-SHA audit |
| `security/redact-production-ci-data-2026-10-08` | [`25a10d579a6a1223d50b0a1eaf36a62b25f9bd25`](https://github.com/AstroTat808/koasevents.com/commit/25a10d579a6a1223d50b0a1eaf36a62b25f9bd25) | 16 / 79 | 2026-10-11 exact-SHA audit |
| `test/trusted-browser-live-verification` | [`5a0efaaf992a581b4480f388a3690ed19e953a58`](https://github.com/AstroTat808/koasevents.com/commit/5a0efaaf992a581b4480f388a3690ed19e953a58) | 1 / 189 | 2026-10-11 exact-SHA audit |

## Verification before forward-port

1. Diff current security activity summaries and trusted-device expiry/revocation controls against legacy requirements
2. Confirm latest privacy gate blocks prohibited PII fields and sensitive authenticated artifacts; coordinate with open PR #253
3. Retain redacted historical incident evidence without copying raw logs, client names, financial amounts, or credentials
4. Verify all security checks stay fail-closed and every production Turnstile form rejects invalid/missing tokens
5. No change to authentication or customer data without dedicated security regression tests

## Review conclusion

_Not yet determined at this point. A branch being ahead of main is not proof its behavior is absent from main. Revalidate code impact, changes already implemented by later PRs, and applicable release gates first._
