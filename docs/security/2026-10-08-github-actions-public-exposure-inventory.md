# GitHub Actions public-exposure incident inventory

**Repository:** `AstroTat808/koasevents.com`  
**Inventory date:** 2026-10-08  
**Scope:** GitHub Actions runs and artifacts created while production workflows could emit or retain signed production responses. Customer PII is intentionally not reproduced in this document.

## Executive classification

This inventory is evidence-preserving but PII-free. A run is included only when job-log verification confirmed that a sensitive output path executed, or when an artifact was created from a workflow path known to contain the sensitive response. Pull-request-only runs that did not execute production jobs are excluded.

Exposure codes:

- **SH-RAW** — raw signed System Health response. The payload can include client/accounting detail. Broader client/accounting fields were independently confirmed in many of the affected logs, but this ledger does not reproduce them.
- **QBO-DIAG** — production QuickBooks adjustment diagnostics, including customer/transaction identifiers and financial/accounting fields.
- **REPAIR-PREVIEW** — production accounting repair-preview rows and proposed write detail.
- **ROLLBACK-RAW** — raw real Netlify sandbox rollback/control-plane response, including internal site/deploy identifiers.
- **ACCOUNTING-AUDIT** — raw production accounting audit history.
- **SELF-HEAL-RAW** — raw sandbox self-heal drill response and internal control-plane identifiers.

Required-remediation codes:

- **R1** — delete the affected GitHub Actions workflow run so its public logs are removed.
- **R2** — delete every listed affected artifact immediately; do not wait for automatic expiry.
- **R3** — retain a private incident record of the data categories and evidence, without copying customer PII into GitHub.
- **R4** — assess privacy/contractual notification obligations for client/accounting exposure.
- **R5** — review exposed infrastructure identifiers and retire/replace any identifier or endpoint that does not need to remain stable. These identifiers are not treated as credentials by themselves.
- **R6** — credential rotation is not automatically required by this inventory because no raw credential value was confirmed in these runs; rotate if a separate secret-value review identifies one.

### Retention-date note

GitHub's artifact API supplies an exact `expires_at` timestamp for each artifact; those exact dates are recorded below. GitHub's workflow-run/job-log metadata available through the connector does **not** supply a per-run log-expiry timestamp. For log exposure, the retention field is therefore recorded as **"API does not expose exact expiry — delete run now"** rather than guessing from repository policy.

## Production Visual QA affected runs

| Run | Exposure date (UTC) | Exposed data categories | Affected artifacts and exact artifact expiry | Log retention | Required remediation |
| --- | --- | --- | --- | --- | --- |
