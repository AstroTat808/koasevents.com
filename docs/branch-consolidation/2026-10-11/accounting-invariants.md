# QuickBooks accounting invariants and sandbox repair safety

**Status:** review-only; functional changes are not ported. **Baseline:** `5f21f3b3f09328967c62877bfc8055a9e115dac7`.

Current accounting scope, reconciliation and safe-repair preview already operate under release QA; legacy repair and self-heal code predates later safeguards.

## Source branches pinned by exact SHA

| Branch | Pinned head SHA | Ahead / behind baseline main | Origin |
|---|---|---:|---|
| `fix/accounting-invariants-netlify-selfheal` | [`3036aca1aec9aa87f285a756fc3e67f8132422f9`](https://github.com/AstroTat808/koasevents.com/commit/3036aca1aec9aa87f285a756fc3e67f8132422f9) | 9 / 258 | 2026-10-11 exact-SHA audit |

## Verification before forward-port

1. Trace the legacy QuickBooks scope/invariant logic and find requirements absent from main
2. Require only read-only preview and sandbox tests; no QuickBooks production writes or automatic mutations
3. Preserve current tenant scoping, tax calculations, duplicate handling, and individually approved repair policy
4. Test signed System Health, rollback and accounting invariant checks before proposing production changes
5. If duplicate of newer repaired implementation, record exact supersession evidence

## Review conclusion

_Not yet determined at this point. A branch being ahead of main is not proof its behavior is absent from main. Revalidate code impact, changes already implemented by later PRs, and applicable release gates first._
