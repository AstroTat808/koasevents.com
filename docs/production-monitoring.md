# Koa’s Events — production reliability monitoring

Scope: Netlify **Koas Admin** project `koasevents-website`, site
`d1f3ab06-be2a-41c4-b770-59e6a6acd1b9`; GitHub
`AstroTat808/koasevents.com`.

## Operator view

The protected [System Health dashboard](https://koasevents.com/admin/health/)
contains a new **Monitoring at a glance** section combining:

- Current System Health snapshot (unknown when stale or unavailable)
- Netlify production deploy ID and verified SHA comparison against GitHub main
- Latest exact-deploy signed production release gate
- Chromium and WebKit theme/responsive evidence, bound to the deployed SHA and deploy ID
- An explicitly external Image CDN tile; **no fake request counts**. Only Netlify edge logs/observability can confirm `/.netlify/images` 5xx assets and thresholds.

All existing release timeline, audit history, signed PDF/JSON evidence, and
health transition controls remain available on the same protected page.

## Monitoring cadence

- ChatGPT task **Koa daily production health**: at 08:00 Pacific/Honolulu,
  compares new actionable problems and verified recoveries without sending all-clear messages.
- ChatGPT task **Koa production failure alerts**: every hour, condition-watch
  using actual Netlify edge/5xx data and GitHub exact-main QA. No nonactionable messages.
- Netlify `health-monitor` scheduled function: hourly protected page/API
  health checks and transition-only email/Slack/SMS (as configured).
- Netlify `post-deploy-verification` scheduled function: every 15 minutes,
  with one persisted verification per production deployment.
- GitHub **Production visual QA**: on every `main` push and daily scheduled
  revalidation. Its full signed final release gate also runs for exact-main
  `workflow_dispatch` events after this change.

## Deploy-driven certification

`production-certification-trigger.mts` receives signed Netlify
`deploySucceeded` platform events (production only), independently reads
`main`, checks exact SHA, deduplicates by Netlify deploy ID, and dispatches
the **full** `production-visual-qa.yml` workflow if and only if the
dedicated `KOA_GITHUB_ACTIONS_TOKEN` is configured with GitHub Actions
workflow dispatch permission for this repository. Never use the existing
`KOA_GITHUB_READ_TOKEN` as a substitute.

To activate this trigger, provision the scoped token as a **Netlify secret,
Functions scope, production context**. Do not commit or print the value.
It must be able to **read the repo and write Actions workflow dispatches**
for this repository only. This may require organization/repository owner
approval. Redeploy after provision.

As a separate fallback, the
`certify-netlify-production-deployment.yml` workflow listens for **GitHub
production deployment status = success** for the exact current `main` SHA
where the evidence URL points to Netlify or the site's production domain.
If the Netlify GitHub integration does not publish `deployment_status`
events, this fallback will not fire. The dedicated Netlify event trigger
above is the deterministic path when provisioned.

### Failure notifications

A **Netlify production deployFailed** event sends a sanitized failure-only
email through the existing `RESEND_API_KEY`. Delivery targets the configured
`KOA_HEALTH_ALERT_EMAILS` / `KOA_LEAD_EMAIL_TO` and otherwise uses the
same legacy fallback as the existing health transition emails. It includes
only deploy ID, commit, timestamp and Netlify project link and is idempotent
per deploy ID. Never include provider error text, tokens, raw request logs,
customer information or IP addresses.

Browser QA and signed release gate failures are currently notified through
existing System Health transitions and the hourly ChatGPT failure watch.
These are **not instantaneous**; an event-native GitHub failure channel
would require a separately approved notification integration. Do not claim
an instant GitHub failure push exists until it is verified.

## Release safeguards

Never certify based solely on a `ready` Netlify deployment. The final gate
requires current `main` SHA = currently published Netlify SHA, passing
Chromium/WebKit and theme tests, passing signed responsive audit, healthy
System Health, durable Release History attestation, and byte-verified signed
PDF/JSON artifacts. Pending, stale, skipped, or mismatched evidence must
fail closed.

All code changes ship through a protected pull request. Do not bypass
required checks or force a merge. Platform activation is complete only after
a subsequent deploy demonstrates a real dispatch, an exact-SHA signed
certification, and the expected failure-only delivery path.
