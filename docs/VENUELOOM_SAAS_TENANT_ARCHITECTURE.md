# VenueLoom SaaS tenant architecture

## Product boundary

VenueLoom is the product. Koa's Events is Tenant 1.

No business-specific rule may be required for VenueLoom core code to boot or operate. Business branding, jurisdictional tax terminology, catalog names/prices, accounting mappings, domains, email identities, document wording, locations, payment policies, staff bootstrap data, and external-system identifiers belong to tenant configuration or tenant-owned records.

A useful test for every new feature is:

> Could a second venue in another state or country use this feature without a source-code change?

If not, the tenant-specific portion is in the wrong layer.

## Architecture invariants

1. Every mutable business record has a non-null tenant_id.
2. Every authenticated request resolves exactly one tenant context before business data is read.
3. Every repository/service method requires tenant context or operates only on globally shared platform metadata.
4. Cross-tenant reads and writes are denied by both application checks and database policy.
5. External integration credentials and remote IDs are scoped by tenant.
6. Platform defaults are jurisdiction-neutral.
7. Tenant labels never define business logic. Tax behavior is represented by structured fields, not by strings such as "GET" or "sales tax".
8. Historical financial and proposal records snapshot the values used at transaction time.
9. Tenant configuration changes are audited.
10. Tenant deletion/offboarding is explicit, reversible during retention, and does not leak data to another tenant.

## Tenant resolution

Current compatibility phase:

- VENUELOOM_DEFAULT_TENANT_ID may force a tenant in single-tenant deployments.
- Otherwise the request host is matched against the tenant domain registry.
- Koa's Events remains the only configured tenant until the shared data layer is migrated.

Production SaaS phase:

1. Resolve authenticated user/session.
2. Resolve organization membership.
3. Resolve requested organization from subdomain/custom domain or explicit workspace selector.
4. Validate membership and role.
5. Attach TenantContext to the request:
   - tenantId
   - membershipId
   - userId
   - role/capabilities
   - locale
   - currency
   - timezone
   - enabled features
6. All service calls accept TenantContext.

Custom-domain routing must never be the only authorization check.

## Core data model

### organizations

- id UUID
- slug
- legal_name
- display_name
- status: trial | active | past_due | suspended | canceled
- locale
- currency
- timezone
- default_country
- created_at
- updated_at

### organization_domains

- id
- tenant_id
- hostname
- kind: app | portal | marketing | custom
- verification_status
- verification_token
- tls_status
- primary
- created_at

Unique hostname across the platform.

### users

Global identity only:

- id
- email
- name
- identity_provider_subject
- status

Do not put tenant-specific role fields here.

### memberships

- id
- tenant_id
- user_id
- role_id
- status
- invited_by
- invited_at
- accepted_at

Unique tenant_id + user_id.

### roles / role_capabilities

Tenant-aware RBAC.

Platform ships baseline role templates, but organizations may create custom roles.

Capabilities remain stable machine identifiers such as:

- crm.view
- crm.manage
- sales.view
- sales.manage
- accounting.view
- accounting.manage
- settings.manage
- billing.manage

### tenant_branding

- tenant_id
- logo asset references
- favicon
- primary/accent/background colors
- typography tokens
- email header/footer settings
- client-facing business name
- tagline
- social links

UI components consume semantic tokens, not --koa-* variables. The existing Koa CSS variables are migration debt and should eventually become --vl-* platform tokens plus tenant-provided CSS custom properties.

### locations / venues

A tenant may operate multiple venues.

- id
- tenant_id
- name
- address fields
- timezone override
- capacity
- rooms/spaces
- operating policies
- active

Proposals/events reference venue_id, not a Koa-specific venue assumption.

### tax_profiles

- id
- tenant_id
- name/label
- jurisdiction country/region/locality
- tax_kind: sales_tax | gross_receipts | VAT | GST | other
- enabled
- statutory_rate
- customer_rate
- max_pass_on_rate
- price_inclusive
- default_taxable
- effective_from
- effective_to
- status

### tax_rules

Optional item/category/location rules:

- id
- tenant_id
- tax_profile_id
- scope: catalog_item | catalog_category | event_type | location
- scope_id
- treatment: taxable | exempt | zero_rate | manual_review
- reason
- authority/reference
- approved_by
- approved_at

VenueLoom core never knows what "Hawaiʻi GET" means. Koa's tax profile supplies that label and its rates.

### catalog_items

- id
- tenant_id
- sku
- name
- description
- group/category
- unit
- sell_price
- internal_cost
- target_margin
- active
- default_tax_rule_id
- source
- version

Gardenia, Orchid, Hibiscus, Signature and Koa Mobile Bar packages are rows belonging to Tenant 1.

### catalog_price_history

- id
- tenant_id
- catalog_item_id
- old_price
- new_price
- old/new internal cost
- old/new target margin
- old/new actual margin
- source
- source_ref
- actor_user_id
- actor_display
- affected_record_ids
- created_at

### integration_connections

- id
- tenant_id
- provider: quickbooks | signwell | resend | microsoft | stripe | etc.
- environment
- encrypted credential reference
- remote_account_id
- remote_account_name
- status
- connected_by
- connected_at
- last_verified_at
- metadata

Never store Koa's QuickBooks realm, SignWell IDs, webhook IDs, or Microsoft account assumptions as platform constants.

### integration_mappings

Generic mapping table:

- id
- tenant_id
- provider
- local_entity_type
- local_entity_id
- remote_entity_type
- remote_entity_id
- remote_name
- metadata
- verified_at

This replaces hardcoded aliases as the final state.

During migration, Tenant 1 may keep bootstrap aliases in its tenant profile to safely resolve legacy QuickBooks Products & Services.

### templates

- id
- tenant_id nullable
- template_type
- name
- version
- content
- variables schema
- status
- source_template_id

tenant_id NULL = VenueLoom platform template.
tenant_id set = tenant-owned override.

Contracts, welcome packets, cancellation forms, proposals, emails, SignWell documents, and vendor documents use this system.

### workflows / workflow_versions

Tenant-configurable automation:

- trigger
- conditions
- actions
- enabled
- version

Do not encode Koa-specific timing or event policies directly into shared handlers.

### feature_flags

Two levels:

Platform feature definitions:
- key
- description
- minimum_plan
- lifecycle

Tenant overrides:
- tenant_id
- feature_key
- enabled
- config JSON
- source: plan | override | beta

### subscriptions

Stripe-backed SaaS billing is separate from a tenant's client payments.

- tenant_id
- stripe_customer_id
- stripe_subscription_id
- plan_id
- status
- trial_ends_at
- current_period_end
- seat_quantity

VenueLoom platform billing must never share Koa's event-payment accounting objects.

## Data isolation

### Target database

Use PostgreSQL for SaaS transactional data with Row Level Security.

Every tenant table carries tenant_id.

Example policy concept:

- current tenant ID is injected into the DB session/transaction.
- SELECT/UPDATE/DELETE require tenant_id = current_tenant_id().
- INSERT requires NEW.tenant_id = current_tenant_id().

Application-level filters remain required, but RLS is the second barrier.

### Blob/object storage

Object paths should be tenant-prefixed:

tenants/{tenantId}/...

Examples:

- tenants/{tenantId}/documents/...
- tenants/{tenantId}/imports/...
- tenants/{tenantId}/integration-history/...

Existing Koa-specific Netlify Blob store names remain compatibility storage until migration. They must not become the permanent SaaS namespace.

### Cache and queues

Every cache key, idempotency key, scheduled-job payload, webhook receipt, and queue message includes tenantId.

### Webhooks

External webhook endpoints resolve tenant from registered webhook metadata or remote account ID, never from user-controlled payload fields alone.

## Integrations

Provider adapters are platform code. Connections and mappings are tenant data.

Interface concept:

IntegrationProvider
- connect(tenantContext)
- disconnect(tenantContext)
- health(tenantContext)
- pull(...)
- push(...)
- verifyWebhook(...)
- normalizeRemoteEntity(...)

QuickBooks specifics such as Koa's Product/Service names belong to Koa's integration mapping/bootstrap data.

## Billing architecture

VenueLoom billing:
- Stripe customer per organization
- plan + seats + optional metered usage
- billing owner capability
- trial lifecycle
- grace period
- suspension state
- entitlement calculation

Tenant business payments:
- QuickBooks/Stripe/etc. connection selected by that tenant
- completely separate ledger/domain from VenueLoom SaaS subscription billing

## Domains

Recommended default:
- app.venueloom.com for platform login
- {tenantSlug}.venueloom.com for tenant workspace/client portal
- optional verified custom domains

Koa may continue to use koasevents.com for its public website while staff CRM access migrates to a VenueLoom app domain.

## Templates and branding

Render pipeline:

VenueLoom base template
→ tenant template override
→ tenant branding tokens
→ record data snapshot
→ immutable rendered artifact

A signed agreement or sent proposal must retain the rendered/versioned content used at the time, even if the tenant edits the template later.

## Onboarding

1. Create organization.
2. Create owner membership.
3. Choose locale, currency, timezone and country.
4. Add first venue/location.
5. Configure brand.
6. Configure tax profile or explicitly mark "not configured".
7. Import/create catalog.
8. Connect accounting provider.
9. Review accounting mappings.
10. Configure proposal/payment defaults.
11. Configure document/email templates.
12. Invite team and assign roles.
13. Configure domains/portal.
14. Run test proposal + accounting sync.
15. Activate tenant.

Onboarding state is persisted so the organization can leave and resume.

## Koa's Events as Tenant 1

Tenant ID: koa-events

Koa-specific configuration includes:
- Koa's Events / Koa's Events LLC identity
- koasevents.com domains
- Koa contact details
- Pacific/Honolulu timezone
- Hawaiʻi GET profile and rates
- Gardenia / Orchid / Hibiscus / Signature catalog records
- Oahu / Maui / Big Island Mobile Bar records
- legacy QuickBooks Product/Service aliases
- Koa website placement routes
- current admin bootstrap emails
- Koa legal-jurisdiction labels

These values may exist in Koa's tenant seed/configuration. They must not appear as required defaults in VenueLoom shared services.

## Migration plan

### Phase 0 — guardrail now

- Establish TenantProfile and request tenant resolution.
- Move Catalog Manager tax configuration and QuickBooks aliases into Tenant 1 configuration.
- Make accounting settings functions accept tenant tax defaults.
- Make admin UI render tax label/rates from returned tenant profile.
- Add automated hardcoding audit.
- Do not rename existing Koa Blob stores yet.

### Phase 1 — platform context

- Add TenantContext to admin session.
- Replace host-only fallback with membership-aware organization selection.
- Make all service entrypoints require tenant.
- Introduce generic platform branding tokens.

### Phase 2 — storage isolation

- Introduce PostgreSQL organizations/memberships/roles.
- Migrate CRM/sales/catalog records with tenant_id.
- Add RLS.
- Prefix object/blob keys with tenantId.
- Build migration verification comparing Koa counts and checksums before/after.

### Phase 3 — integration isolation

- Move OAuth credentials/tokens to integration_connections.
- Move QBO IDs and aliases to integration_mappings.
- Register webhooks per tenant.
- Make health/diagnostics tenant-aware.

### Phase 4 — tenant customization

- Tenant branding editor.
- Tax profile/rules editor.
- Template manager.
- Feature flags/plan entitlements.
- Custom domains.
- Per-tenant workflow settings.

### Phase 5 — SaaS commercial layer

- Stripe subscriptions.
- Trials.
- Seat management.
- Usage metering where needed.
- Self-service onboarding.
- Tenant suspension/offboarding/export.

## Definition of done for a VenueLoom-ready module

A module is not SaaS-ready until:

- no Koa-specific value is required by shared logic;
- all reads/writes are tenant-scoped;
- permissions are membership-scoped;
- currency/timezone/locale come from tenant context;
- external IDs are tenant-owned mappings;
- tax terminology/rates come from tax profile;
- templates/branding are tenant-owned;
- tests include at least two materially different tenants;
- cross-tenant access tests fail closed;
- audit logs identify tenant, actor, source and target record.

## Foundation release status

Phase 0 tenant-boundary guardrails are active in the codebase. Koa's Events is the only registered tenant; storage compatibility remains intentionally single-tenant until the P0 data-isolation migration is completed.
