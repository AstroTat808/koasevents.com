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
| [37225406196](https://github.com/AstroTat808/koasevents.com/actions/runs/37225406196) | `2026-10-04T18:41:32Z` | SH-RAW | `11311483260` `koa-system-health-mobile-37225406196` — expires `2026-11-03T18:44:56Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [37145353248](https://github.com/AstroTat808/koasevents.com/actions/runs/37145353248) | `2026-10-03T18:44:45Z` | SH-RAW | `11281783964` `koa-system-health-mobile-37145353248` — expires `2026-11-02T18:47:53Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [37057744038](https://github.com/AstroTat808/koasevents.com/actions/runs/37057744038) | `2026-10-02T20:00:09Z` | SH-RAW | `11249531062` `koa-system-health-mobile-37057744038` — expires `2026-11-01T20:03:42Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [37009873995](https://github.com/AstroTat808/koasevents.com/actions/runs/37009873995) | `2026-10-02T12:57:40Z` | SH-RAW, QBO-DIAG | `11227526528` `koa-production-smoke-37009873995` — expires `2026-10-16T12:58:54Z`<br>`11227432853` `koa-system-health-mobile-37009873995` — expires `2026-11-01T13:01:28Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [36985643469](https://github.com/AstroTat808/koasevents.com/actions/runs/36985643469) | `2026-10-02T08:43:12Z` | SH-RAW, QBO-DIAG | `11218010808` `koa-system-health-mobile-36985643469` — expires `2026-11-01T09:47:19Z`<br>`11217590924` `koa-production-smoke-36985643469` — expires `2026-10-16T08:44:19Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [36984357825](https://github.com/AstroTat808/koasevents.com/actions/runs/36984357825) | `2026-10-02T08:29:55Z` | SH-RAW, QBO-DIAG | `11216842758` `koa-system-health-mobile-36984357825` — expires `2026-11-01T09:35:22Z`<br>`11216733433` `koa-production-smoke-36984357825` — expires `2026-10-16T08:32:38Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [36983841385](https://github.com/AstroTat808/koasevents.com/actions/runs/36983841385) | `2026-10-02T08:24:23Z` | SH-RAW, QBO-DIAG | `11216713144` `koa-system-health-mobile-36983841385` — expires `2026-11-01T09:28:44Z`<br>`11216454189` `koa-production-smoke-36983841385` — expires `2026-10-16T08:25:46Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [36978870481](https://github.com/AstroTat808/koasevents.com/actions/runs/36978870481) | `2026-10-02T07:29:59Z` | SH-RAW | `11214184411` `koa-system-health-mobile-36978870481` — expires `2026-11-01T07:35:14Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [36978557718](https://github.com/AstroTat808/koasevents.com/actions/runs/36978557718) | `2026-10-02T07:26:23Z` | SH-RAW | `11214481927` `koa-system-health-mobile-36978557718` — expires `2026-11-01T07:29:52Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [36976807848](https://github.com/AstroTat808/koasevents.com/actions/runs/36976807848) | `2026-10-02T07:06:01Z` | SH-RAW | `11212934617` `koa-system-health-mobile-36976807848` — expires `2026-11-01T07:09:56Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [36975346773](https://github.com/AstroTat808/koasevents.com/actions/runs/36975346773) | `2026-10-02T06:48:34Z` | SH-RAW | `11212707915` `koa-system-health-mobile-36975346773` — expires `2026-11-01T06:52:07Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [36974288795](https://github.com/AstroTat808/koasevents.com/actions/runs/36974288795) | `2026-10-02T06:35:31Z` | SH-RAW | `11212688023` `koa-system-health-mobile-36974288795` — expires `2026-11-01T06:41:16Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [36973919933](https://github.com/AstroTat808/koasevents.com/actions/runs/36973919933) | `2026-10-02T06:30:59Z` | SH-RAW | `11212916211` `koa-system-health-mobile-36973919933` — expires `2026-11-01T06:37:57Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [36973794038](https://github.com/AstroTat808/koasevents.com/actions/runs/36973794038) | `2026-10-02T06:29:30Z` | SH-RAW | `11212681191` `koa-system-health-mobile-36973794038` — expires `2026-11-01T06:34:19Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [36973477763](https://github.com/AstroTat808/koasevents.com/actions/runs/36973477763) | `2026-10-02T06:25:29Z` | SH-RAW | `11212299207` `koa-system-health-mobile-36973477763` — expires `2026-11-01T06:30:20Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [36973093841](https://github.com/AstroTat808/koasevents.com/actions/runs/36973093841) | `2026-10-02T06:20:41Z` | SH-RAW | `11212660920` `koa-system-health-mobile-36973093841` — expires `2026-11-01T06:25:42Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [36972444710](https://github.com/AstroTat808/koasevents.com/actions/runs/36972444710) | `2026-10-02T06:12:26Z` | SH-RAW | `11211489577` `koa-system-health-mobile-36972444710` — expires `2026-11-01T06:21:26Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
| [36970137725](https://github.com/AstroTat808/koasevents.com/actions/runs/36970137725) | `2026-10-02T05:42:23Z` | SH-RAW | `11211227390` `koa-system-health-mobile-36970137725` — expires `2026-11-01T05:46:39Z` | API does not expose exact expiry — delete run now | R1 + R2 + R3 + R4 + R6 |
