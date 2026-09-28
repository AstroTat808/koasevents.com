# VenueLoom tenant-hardcoding audit and refactor plan

## Scope and intent

VenueLoom is the SaaS product. Koa's Events is Tenant 1.

This audit separates three kinds of tenant-specific content:

1. **Valid tenant data** — Koa-specific values that belong in Tenant 1 configuration or Koa's public-site content.
2. **Platform debt** — Koa/Hawaiʻi-specific values embedded in shared CRM/admin/integration code.
3. **Compatibility debt** — old storage names, identifiers or APIs that may remain temporarily to avoid breaking production data, but must sit behind a tenant-aware abstraction.

A repository-wide scanner now exists as the package command **audit:tenant**. It scans source, Netlify Functions, scripts and documentation for tenant-specific brands, domains, geographic assumptions, tax labels/rates, package names, legacy Koa Blob-store names and Koa-specific design tokens.

The strict form, **audit:tenant:strict**, is intentionally not part of production gating yet because the existing application still contains known platform debt. The non-strict audit runs during builds so new work continually exposes remaining tenant coupling.

## Confirmed high-risk findings

The following counts came from direct inspection of current main before this refactor. They are not intended as the permanent baseline; the repository scanner is the continuing source of truth.

| Area | Confirmed coupling |
| --- | --- |
| netlify/functions/admin-crm.mts | Koa brand references, Koa domains, Pacific/Honolulu, Koa Blob-store names |
| netlify/functions/admin-quotes.mts | heavy Koa wording, Hawaiʻi tax assumptions, 4.712 rate, Gardenia/Orchid/Hibiscus names, Koa storage |
| netlify/functions/admin-profitability.mts | package names, 4.712 tax assumption, Koa storage |
| netlify/functions/admin-quickbooks.mts | Koa wording, Hawaiʻi-specific tax defaults, 4.712 rate, Koa storage |
| netlify/functions/admin-calendar.mts | Koa naming and Koa storage |
| netlify/functions/admin-email-routing.mts | Koa branding and Koa storage |
| netlify/functions/admin-email-preview.mts | Koa identity/domain/package examples embedded in email preview logic |
| netlify/functions/admin-health.mts | Hawaiʻi/timezone assumptions |
| netlify/functions/public-proposals.mts | 4.712 fallback and Koa storage |
| netlify/functions/public-planning.mts | Koa copy and Koa storage |
| netlify/functions/signwell-webhook.mts | Koa naming and Koa storage |
| netlify/functions/quickbooks-webhook.mts | Koa naming and multiple Koa storage references |
| netlify/functions/quickbooks-hourly-reconciliation.mts | Koa integration-store reference |
| src/pages/admin/index.astro | Koa product identity and Koa domains |
| src/pages/admin/quotes/index.astro | Koa identity, Hawaiʻi wording, 4.712 assumptions and package names |
| src/pages/admin/profitability/index.astro | Koa identity and Plumeria terminology |
| src/pages/admin/quickbooks/index.astro | Koa identity, Hawaiʻi GET wording and fixed rates |
| src/layouts/BaseLayout.astro | public Koa branding/location/domain content and Koa design-token names |

The public marketing site is expected to contain Koa-specific content while Koa remains Tenant 1. The critical issue is tenant-specific logic inside shared CRM/admin/integration services.

## Immediate refactor completed in this branch

### Tenant profile boundary

Added TenantProfile with Koa's Events represented as Tenant 1.

Tenant configuration now carries organization identity, locale/currency/timezone, domains, contact details, brand metadata, tax profile, catalog bootstrap items, catalog canonical aliases, QuickBooks naming aliases, website placement rules, bootstrap admin emails, and jurisdiction labels.

### Catalog Manager

Removed direct dependencies on Koa package names and Hawaiʻi tax labels from Catalog Manager's shared logic.

Catalog Manager now receives bootstrap catalog rows, canonical package aliases, QuickBooks aliases, website placement rules, tax label/policy, locale, and currency from the resolved tenant profile.

Koa's Gardenia, Orchid, Hibiscus, Signature, Oahu/Maui/Big Island and legacy QBO names remain in src/data/tenants/koa-events.ts, where Tenant 1 data belongs.

### Tax configuration

The shared QuickBooks settings helper no longer supplies Hawaiʻi-specific defaults.

The legacy API names getQuickBooksGetSettings and saveQuickBooksGetSettings are retained for compatibility, but they now accept generic tenant tax defaults and otherwise fall back to neutral Tax / zero-rate values.

The QuickBooks admin endpoint resolves the tenant and passes its tax profile.

The admin UI reads the tax label/rates from the returned tenant profile instead of assuming Hawaiʻi GET.

### QuickBooks mapping

Catalog/QBO matching no longer owns a global hardcoded Koa alias table.

Alias candidates now come from the resolved tenant's catalog.quickBooksAliases.

The target architecture replaces these bootstrap aliases with persisted per-tenant integration_mappings; the aliases are a compatibility bridge for Koa's existing QuickBooks catalog.

## Compatibility debt deliberately not migrated yet

### Blob store names

Current production data uses names such as koa-sales and koa-integrations. Renaming those stores during this refactor would create production-data risk.

The SaaS migration must introduce a tenant-aware storage adapter and migrate data with count/hash verification before removing the legacy names.

### Koa public website

The current repository contains both the Koa public website and CRM/admin application. Public pages naturally contain Koa-specific copy.

Long-term VenueLoom should separate the VenueLoom SaaS application shell, tenant/admin/client portal, and Koa public marketing website.

### Proposal/payment model vocabulary

The current code contains domain labels such as venueWedding, mobileBar, privateEvent, beforeGet, and afterGet.

Recommended target:

- event type IDs are tenant-configurable records
- tax value basis uses beforeTax / afterTax
- package/category display names are tenant data
- payment rules reference generic event-type IDs

The existing values should be supported as migration aliases until all Koa records have been converted.

## Refactor priorities

### P0 — required before Tenant 2 can contain real data

1. Add tenant ID to authenticated session/membership context.
2. Tenant-scope CRM, sales, event, vendor, document and accounting storage.
3. Move integration tokens/connections behind tenant-specific connection records.
4. Replace global Blob access with tenant-aware storage adapter.
5. Add cross-tenant authorization tests.
6. Move public proposal/planning access tokens to records that carry tenant ID.
7. Tenant-scope webhooks using registered remote account/webhook metadata.
8. Ensure every scheduled job iterates explicit tenant IDs rather than assuming Koa.

### P1 — required before self-service onboarding

1. Organization/settings UI.
2. Branding editor.
3. Tax profile/rule editor.
4. Location/venue model.
5. Catalog importer/mapping onboarding.
6. Integration connection wizard.
7. Template manager.
8. Membership/invite/custom-role workflow.
9. Feature flags / plan entitlements.
10. Custom domain verification.

### P2 — commercial SaaS layer

1. Stripe SaaS subscriptions.
2. Plan/seat entitlements.
3. Trial lifecycle.
4. Billing-admin role.
5. Data export/offboarding.
6. Metering/limits if required.
7. Customer-support impersonation with explicit audited authorization.

## Migration rule for future work

No new shared CRM code should introduce Koa's Events as a fallback business identity, koasevents.com as a fallback domain, Hawaiʻi/Hilo/Honolulu as a platform locale assumption, Pacific/Honolulu as a shared timezone default, 4.5 / 4.712 as platform tax defaults, GET as the platform tax model, Gardenia/Orchid/Hibiscus/Plumeria as shared package constants, Oahu/Maui/Big Island as shared product constants, Koa QuickBooks Product/Service names in shared accounting code, new koa-* persistence namespaces, or Koa email addresses as platform notification defaults.

Those values are valid only in Tenant 1 data/configuration or Koa's public website.

## Guardrail for pull requests

For every CRM/admin PR, reviewers should answer:

1. What tenant owns the new data?
2. How is tenant context resolved?
3. Can Tenant A read or mutate Tenant B's data?
4. Are locale/currency/timezone tenant-derived?
5. Are branding strings tenant-derived?
6. Are tax terminology/rates tenant-derived?
7. Are remote integration IDs tenant-scoped?
8. Does the feature work with a second tenant whose country, tax model, package names and integrations differ from Koa?
