# Legacy branch code consolidation — review staging

This documentation-only, **draft review** prevents unverified legacy code from being merged wholesale. It does not implement or certify the branch-only functionality. Functional ports, if required, must be separate tested commits atop current main.

- Koa Git history baseline: `a3fe51249cbff90868351534018ea36d701d2c69` (branch-hygiene run [38137135249](https://github.com/AstroTat808/koasevents.com/actions/runs/38137135249))
- Updated review branch base: `5f21f3b3f09328967c62877bfc8055a9e115dac7` (PR #258 merge); PR #261 is separately gated.
- Prior 231 ancestry-only preservation set: **159** code-integrated (137 exact merged-PR, 22 patch-equivalent nonmerge commits); **52** exact-SHA reviewed superseded; **11** Koa content-gap reviews; **4** explicit keep by policy; **1** PR #256 open at old snapshot (now closed without merge, added here); **4** VenueLoom branches kept separately.
- Total **12** Koa code-gap review entries now (11 initial plus closed PR #256). Older branch tips retained. This review makes no production changes.
- All 52 reviewed-superseded branch tip SHAs matched `.github/branch-hygiene-policy.json` on 2026-10-11.
- Branch deletion and any inferred code merge are out of scope; the separate [deletion queue](https://github.com/AstroTat808/koasevents.com/tree/ops/exact-sha-branch-cleanup-manifest-20261011/audits/branch-cleanup-2026-10-11) is read-only.

## Scoped review workstreams

1. [Release and QA](release-system-health.md) — seven branches including newly closed #256.
2. [Security and trusted devices](security-privacy.md) — four branches.
3. [Accounting integrity](accounting-invariants.md) — one branch.

**Required reviewer decision for every listed branch:** _current behavior verified as equivalent_; _isolated forward-port approved_; or _preserve until more evidence_. Never mark a branch deletable solely because this draft review PR merges.
