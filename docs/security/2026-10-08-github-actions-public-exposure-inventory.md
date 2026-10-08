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
| [37737692279](https://github.com/AstroTat808/koasevents.com/actions/runs/37737692279) | `2026-10-08T06:27:21Z` | SH-RAW, QBO-DIAG, REPAIR-PREVIEW | `11533081540` `koa-system-health-mobile-37737692279` — expires `2026-11-07T06:40:35Z`<br>`11532532177` `koa-production-smoke-37737692279` — expires `2026-10-22T06:28:35Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [37731223133](https://github.com/AstroTat808/koasevents.com/actions/runs/37731223133) | `2026-10-08T05:12:35Z` | SH-RAW, QBO-DIAG, REPAIR-PREVIEW | `11529673847` `koa-production-smoke-37731223133` — expires `2026-10-22T05:16:36Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [37729989470](https://github.com/AstroTat808/koasevents.com/actions/runs/37729989470) | `2026-10-08T04:57:41Z` | SH-RAW, QBO-DIAG, REPAIR-PREVIEW | `11528864008` `koa-production-smoke-37729989470` — expires `2026-10-22T05:04:01Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [37683874476](https://github.com/AstroTat808/koasevents.com/actions/runs/37683874476) | `2026-10-07T20:40:58Z` | SH-RAW | `11529347043` `koa-system-health-mobile-37683874476` — expires `2026-11-07T04:51:55Z`<br>`11510574442` `koa-system-health-mobile-37683874476` — expires `2026-11-06T20:56:08Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [37526348216](https://github.com/AstroTat808/koasevents.com/actions/runs/37526348216) | `2026-10-06T20:25:36Z` | SH-RAW | `11443055603` `koa-system-health-mobile-37526348216` — expires `2026-11-05T20:29:50Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [37482589357](https://github.com/AstroTat808/koasevents.com/actions/runs/37482589357) | `2026-10-06T14:52:18Z` | SH-RAW, QBO-DIAG, REPAIR-PREVIEW | `11529512918` `koa-system-health-mobile-37482589357` — expires `2026-11-07T05:02:41Z`<br>`11528519981` `koa-system-health-mobile-37482589357` — expires `2026-11-07T04:49:37Z`<br>`11423035511` `koa-system-health-mobile-37482589357` — expires `2026-11-05T15:05:37Z`<br>`11421547988` `koa-production-smoke-37482589357` — expires `2026-10-20T14:54:38Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [37477896564](https://github.com/AstroTat808/koasevents.com/actions/runs/37477896564) | `2026-10-06T14:18:46Z` | SH-RAW, QBO-DIAG, REPAIR-PREVIEW | `11420034061` `koa-system-health-mobile-37477896564` — expires `2026-11-05T14:32:30Z`<br>`11419434462` `koa-production-smoke-37477896564` — expires `2026-10-20T14:20:15Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [37405620101](https://github.com/AstroTat808/koasevents.com/actions/runs/37405620101) | `2026-10-06T02:44:40Z` | SH-RAW, QBO-DIAG, REPAIR-PREVIEW | `11387741893` `koa-system-health-mobile-37405620101` — expires `2026-11-05T02:55:44Z`<br>`11387725503` `koa-production-smoke-37405620101` — expires `2026-10-20T02:46:04Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [37402269741](https://github.com/AstroTat808/koasevents.com/actions/runs/37402269741) | `2026-10-06T02:03:32Z` | SH-RAW, QBO-DIAG, REPAIR-PREVIEW | `11387235119` `koa-system-health-mobile-37402269741` — expires `2026-11-05T02:34:58Z`<br>`11386135363` `koa-production-smoke-37402269741` — expires `2026-10-20T02:04:57Z`<br>`11385972180` `koa-system-health-mobile-37402269741` — expires `2026-11-05T02:14:51Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [37400462137](https://github.com/AstroTat808/koasevents.com/actions/runs/37400462137) | `2026-10-06T01:41:46Z` | SH-RAW, QBO-DIAG, REPAIR-PREVIEW | `11384832217` `koa-production-smoke-37400462137` — expires `2026-10-20T01:43:10Z`<br>`11384209953` `koa-system-health-mobile-37400462137` — expires `2026-11-05T01:45:32Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [37399102644](https://github.com/AstroTat808/koasevents.com/actions/runs/37399102644) | `2026-10-06T01:25:41Z` | SH-RAW, QBO-DIAG | `11384004793` `koa-system-health-mobile-37399102644` — expires `2026-11-05T01:29:25Z`<br>`11383628200` `koa-production-smoke-37399102644` — expires `2026-10-20T01:27:08Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [37380176319](https://github.com/AstroTat808/koasevents.com/actions/runs/37380176319) | `2026-10-05T22:05:18Z` | SH-RAW | `11373273920` `koa-system-health-mobile-37380176319` — expires `2026-11-04T22:09:00Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
