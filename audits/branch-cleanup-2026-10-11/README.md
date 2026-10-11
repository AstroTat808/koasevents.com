# Exact-SHA branch cleanup audit — 2026-10-11

This audit compares **305 snapshot branch refs** from Koa's Events (299) and VenueLoom (6) against their repository's own fixed main SHA. No branches were deleted. All 305 names and snapshot tip SHAs are recorded in `manifest.csv` and `manifest.json`.

## Baseline main commits
- Koa's Events: `a3fe51249cbff90868351534018ea36d701d2c69`
- VenueLoom: `4e059ca6d7419fd0081669e67ffb79db7e5f54b8`

## Snapshot category counts
- PRESERVE_UNMERGED: 231
- ZERO_UNIQUE_ANCESTRY: 58
- KEEP_OPEN_PR: 14
- KEEP_MAIN: 2

## Certification boundaries
- `ZERO_UNIQUE_ANCESTRY` means exactly zero branch-only commits compared to **snapshot main**; candidate for deletion only after exact tip recheck, open-PR/protection checks, and the project's seven-day grace period.
- `PRESERVE_UNMERGED` has branch-only commit objects; it may contain patch-equivalent work already cherry-picked or squashed, but **do not delete** without patch-level review.
- `KEEP_OPEN_PR` protects live PR branches regardless of ahead count; `KEEP_MAIN` is never deleted.
- `exact_tip_peers` is rigorous duplicate-tip evidence, not proof for other similar changes.
- Branch tip movement observed on refresh: **0**; snapshot is frozen and requires recheck before any deletion.

## Exact-tip duplicates
- `backup/pr-180-pre-rebase-20260929-1537`: `9cd15c994f79aef956001fdc7a4b04cf01a59495`, peer(s): `fix/historical-qbo-import-action-center`
- `feature/payment-rule-conflicts-basis-explanation`: `c39ac59179748ca28648ad22cc9000f2d03928f4`, peer(s): `feature/payment-rule-conflicts-get-explain;feature/payment-rule-conflicts-value-basis-explain;feature/payment-rule-conflicts-value-basis-explain-v2`
- `feature/payment-rule-conflicts-get-explain`: `c39ac59179748ca28648ad22cc9000f2d03928f4`, peer(s): `feature/payment-rule-conflicts-basis-explanation;feature/payment-rule-conflicts-value-basis-explain;feature/payment-rule-conflicts-value-basis-explain-v2`
- `feature/payment-rule-conflicts-value-basis-explain`: `c39ac59179748ca28648ad22cc9000f2d03928f4`, peer(s): `feature/payment-rule-conflicts-basis-explanation;feature/payment-rule-conflicts-get-explain;feature/payment-rule-conflicts-value-basis-explain-v2`
- `feature/payment-rule-conflicts-value-basis-explain-v2`: `c39ac59179748ca28648ad22cc9000f2d03928f4`, peer(s): `feature/payment-rule-conflicts-basis-explanation;feature/payment-rule-conflicts-get-explain;feature/payment-rule-conflicts-value-basis-explain`
- `fix/historical-qbo-import-action-center`: `9cd15c994f79aef956001fdc7a4b04cf01a59495`, peer(s): `backup/pr-180-pre-rebase-20260929-1537`

## Current main refs at last check
- AstroTat808/koasevents.com: `a3fe51249cbff90868351534018ea36d701d2c69`
- AstroTat808/venueloom.com: `4e059ca6d7419fd0081669e67ffb79db7e5f54b8`

Full details: `manifest.csv` or `manifest.json`.
