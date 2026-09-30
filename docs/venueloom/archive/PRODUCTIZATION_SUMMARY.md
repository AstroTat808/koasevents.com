# VenueLoom productization — archived design summary

Preserved during the 2026-09-30 branch review from `productization/venueloom-tenant-foundation`.

This is a historical design reference, not an implementation status document. Current production code and System Health are authoritative.

## Durable principles worth retaining

- Koa’s Events remains Tenant #1 while VenueLoom is extracted into a reusable platform.
- Tenant context must fail closed when ambiguous.
- Tenant-owned records and integrations must remain isolated end to end.
- A second venue must be configurable without source-code changes.
- Integration credentials and callbacks must bind to the correct tenant.
- Productization should preserve Koa production behavior while platform abstractions are introduced.
- Onboarding, billing, auditability, backup/restore, incident response, and tenant-isolation testing are launch gates rather than follow-up work.
- The commercial MVP centers on inquiry → proposal → contract → payment → planning → vendors/staff → event day.
- VenueLoom should remain hospitality-aware, operationally credible, and broader than wedding-only software.

The original branch also contained an older implementation plan for tenant configuration and storage. That runtime code is intentionally not restored because current `main` contains the newer tenancy, sandbox, isolation, Super Admin, and health implementations.
