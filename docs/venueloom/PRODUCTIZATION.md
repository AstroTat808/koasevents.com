# VenueLoom Productization Plan

## Non-negotiable rule

Koa's Events production behavior remains unchanged while the platform is extracted.

The current Koa implementation becomes **VenueLoom Tenant #1**. Productization changes are introduced behind compatibility defaults before any data or authentication migration.

## Current branch

`productization/venueloom-tenant-foundation`

Created from production head `d2eec5209c41b766d7809a806d35662c14efb9b5`.

## Phase 1 — Compatibility tenant layer

Status: **started**

- [x] Add shared tenant configuration.
- [x] Encode Koa as Tenant #1.
- [x] Preserve current Koa Blob store names.
- [x] Preserve Koa Microsoft calendar owner/name defaults.
- [x] Preserve existing `KOA_RECORD_ID:` calendar marker for compatibility.
- [x] Preserve Hawaiʻi/Microsoft timezone behavior.
- [x] Encode Koa business units in tenant configuration.
- [x] Refactor Office 365 defaults to read from tenant configuration.
- [ ] Refactor auth-security storage name to tenant configuration.
- [ ] Refactor email brand/business-unit selection to tenant configuration.
- [ ] Refactor CRM business-unit labels and accepted source mappings.
- [ ] Refactor QuickBooks tenant-wide settings.
- [ ] Refactor GET/tax configuration without changing Koa's 4.712% behavior.
- [ ] Add compatibility tests proving serialized outputs remain unchanged.

## Phase 2 — Tenant-aware identity and authorization

- Create `tenants`, `users`, `memberships`, `roles`, and `role_permissions`.
- Resolve tenant from authenticated membership rather than hostname alone.
- Preserve Koa admins during migration.
- Eliminate global email allowlists after membership migration.
- Add platform-owner role separate from tenant-owner.
- Add immutable audit events for permission changes.
- Test cross-tenant denial at API and database layers.

## Phase 3 — PostgreSQL data plane

Move transactional data from global Blob namespaces to PostgreSQL.

Recommended migration order:
1. Tenants and memberships
2. CRM records and activities
3. Clients/contacts
4. Events/Event Ops
5. Proposals/contracts
6. Payment schedules/rules
7. Vendors/insurance
8. Staff/tasks/assignments
9. Calendar sync state/conflicts
10. Integrations/audit history

Every tenant-owned row gets `tenant_id UUID NOT NULL`.

Enable PostgreSQL Row Level Security before Tenant #2 contains real data.

## Phase 4 — Tenant configuration

Move these out of source code:
- business name/legal name;
- branding;
- domains;
- time zone/currency;
- taxes;
- business units;
- event types;
- packages;
- venue spaces/capacities;
- payment presets/rules;
- contract templates;
- vendor requirements;
- email identity/templates;
- calendar/accounting connections.

## Phase 5 — Integration isolation

Convert site-wide integration credentials to encrypted tenant connections:
- QuickBooks
- Microsoft 365
- Google Workspace
- Resend/email
- SMS
- payment provider

OAuth callbacks must cryptographically bind state to a tenant and initiating user.

## Phase 6 — Tenant #2 proof

Create a fictitious demo tenant with:
- a different business name/logo;
- non-Hawaiʻi time zone;
- different tax policy;
- different event types;
- separate staff;
- separate vendor records;
- separate Microsoft/Google calendar;
- no Koa labels.

**Success criterion:** Tenant #2 can be configured without a source-code change, and automated tests prove it cannot read or mutate Koa records.

## Production safety

- Never point a productization preview build at production integration callbacks without explicit environment separation.
- No destructive data migration before verified dual-read/backfill tooling exists.
- No global renaming of Koa Blob stores.
- Keep legacy calendar marker parsing until every linked production event has been migrated safely.
- New tenant functionality must fail closed when tenant context is ambiguous.
