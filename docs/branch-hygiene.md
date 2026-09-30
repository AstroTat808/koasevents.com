# Branch hygiene

The scheduled Branch hygiene workflow classifies every non-main branch using commit reachability, exact merged-PR evidence, patch equivalence, open-PR dependencies, branch protection, and explicit keep patterns.

It is intentionally non-destructive. It never deletes a branch. A branch can be marked safe-to-delete only when current-main preservation is proven; otherwise it is kept or sent to needs-review. The seven-day flag starts from the latest known branch/PR activity and verified integration time.

The workflow runs daily, on relevant main changes, and on pull-request lifecycle events. Pull-request jobs are read-only. Only trusted default-branch runs may update one maintenance tracking issue. Complete JSON and Markdown inventories are retained as workflow artifacts for 90 days.

Manual deletion should re-check the exact branch tip immediately before deleting it.
