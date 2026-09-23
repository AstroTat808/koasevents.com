# VenueLoom Launch Roadmap

Goal: reach the first paying independent venue while Koa's Events continues operating safely as VenueLoom Tenant #1.

## Gate 0 — Brand ownership and company foundation

### Brand
- [x] Select VenueLoom.
- [x] Purchase primary .com domain.
- [x] Establish initial brand identity and design tokens.
- [ ] Register defensive domains judged worth holding.
- [ ] Reserve primary social handles.
- [ ] Complete formal federal/common-law trademark clearance.
- [ ] Decide trademark owner (company/LLC).
- [ ] File VenueLoom word-mark application when clearance is acceptable.
- [ ] Prepare logo-mark filing later after identity stabilizes.

### Company/legal
- [ ] Form/confirm operating entity for VenueLoom.
- [ ] Assign software IP to that entity.
- [ ] Inventory third-party/open-source licenses.
- [ ] Terms of Service.
- [ ] Privacy Policy.
- [ ] Data Processing Addendum.
- [ ] Acceptable Use Policy.
- [ ] Subprocessor list.
- [ ] Beta agreement.
- [ ] SaaS subscription/order form.
- [ ] Support/SLA policy appropriate to plan.
- [ ] Data-retention/deletion policy.
- [ ] Incident-response policy.
- [ ] Cyber/E&O insurance evaluation.

**Exit:** brand ownership is defensible and commercial contracts can be signed.

## Gate 1 — Productization foundation

- [x] Create productization branch.
- [x] Add Koa Tenant #1 compatibility config.
- [ ] Remove hard-coded tenant assumptions module by module.
- [ ] Add tenant-aware data access layer.
- [ ] Add PostgreSQL schema.
- [ ] Add RLS policies.
- [ ] Add tenant memberships and roles.
- [ ] Add audit log.
- [ ] Add tenant-scoped object/file storage.
- [ ] Add encrypted tenant integration secrets.
- [ ] Add idempotent data migrations.
- [ ] Add backup/restore procedure.
- [ ] Add Tenant #2 isolation test suite.

**Exit:** a second venue can exist without source changes and cannot access Koa data.

## Gate 2 — Commercial MVP

### Sales
- [ ] Inquiry capture/embed/forms.
- [ ] CRM pipeline.
- [ ] tasks and ownership.
- [ ] proposal builder.
- [ ] contract/e-sign workflow.
- [ ] payment schedules and rule engine.
- [ ] reusable templates.

### Event operations
- [ ] master calendar.
- [ ] event workspace.
- [ ] planning questionnaires.
- [ ] tasks/timelines.
- [ ] staff assignment.
- [ ] event-day checklist.

### Vendors
- [ ] directory.
- [ ] event assignment.
- [ ] insurance/document tracking.
- [ ] expiration/compliance alerts.

### Finance
- [ ] payment milestones.
- [ ] tax configuration.
- [ ] QuickBooks tenant OAuth.
- [ ] reconciliation view.

### Platform
- [ ] tenant branding/settings.
- [ ] roles/permissions.
- [ ] audit log.
- [ ] notification preferences.
- [ ] health/status checks.

Defer payroll, deep SEO tooling, gallery CMS, website builder, Wild Ones-specific production logic, and advanced Netlify-credit management from first-customer scope.

**Exit:** one venue can run inquiry → booked event → event day without Koa-specific setup.

## Gate 3 — Security and reliability

- [ ] Threat model tenant boundaries and OAuth callbacks.
- [ ] RLS positive/negative automated tests.
- [ ] Authorization matrix tests for every protected endpoint.
- [ ] CSRF/state validation for integrations.
- [ ] Rate limiting and abuse controls.
- [ ] Secret rotation procedure.
- [ ] Encryption in transit/at rest.
- [ ] Sensitive-field handling rules.
- [ ] Dependency/SAST scans in CI.
- [ ] Build-safety tests before merge.
- [ ] Preview-before-production workflow.
- [ ] Production backup validation.
- [ ] Restore drill.
- [ ] Centralized security/audit logging.
- [ ] Incident severity/runbook.
- [ ] External penetration test before broad launch.
- [ ] Security page/trust center.
- [ ] Status page strategy.
- [ ] Uptime/error monitoring.

**Exit:** tenant-isolation and recovery controls have been tested, not merely designed.

## Gate 4 — Billing and packaging

Initial pricing hypothesis:
- Launch: $129/month
- Growth: $249/month
- Pro: $399/month
- Multi-Venue: from $699/month

- [ ] Validate tier boundaries with beta venues.
- [ ] Define staff/location/storage/automation entitlements.
- [ ] Build Stripe customer/subscription mapping.
- [ ] Monthly and annual prices.
- [ ] Trial/beta entitlement.
- [ ] upgrade/downgrade logic.
- [ ] payment-failure/dunning behavior.
- [ ] cancellation/export flow.
- [ ] invoice/tax handling for VenueLoom itself.
- [ ] usage metering where needed.
- [ ] one-time onboarding/migration SKUs.
- [ ] coupon/referral policy.

**Exit:** a customer can pay, change plan, fail payment safely, cancel, and export required data.

## Gate 5 — Onboarding

Self-service wizard:
1. Organization
2. Venue/location
3. Branding
4. Users
5. Event types
6. Packages/services
7. Taxes
8. Payment schedules
9. Contract template
10. Vendor requirements
11. Calendar
12. Accounting
13. Email
14. Existing-data import
15. Readiness check

- [ ] sample/demo data.
- [ ] CSV import templates.
- [ ] validation/dry-run import.
- [ ] onboarding progress.
- [ ] setup health score.
- [ ] guided checklist.
- [ ] admin help center.
- [ ] role-based staff training.
- [ ] onboarding email sequence.

**Exit:** a new venue can reach first usable booking configuration without developer intervention.

## Gate 6 — Marketing website

Domain architecture:
- marketing site on the purchased VenueLoom domain;
- application on `app.<domain>`;
- help/docs on `help.<domain>` or integrated docs;
- status endpoint/site separated operationally where practical.

Core pages:
- [ ] Home
- [ ] Product overview
- [ ] Sales CRM
- [ ] Event Ops
- [ ] Vendor management
- [ ] Staff/team
- [ ] Finance/integrations
- [ ] Pricing
- [ ] Security
- [ ] Integrations
- [ ] Migration/Onboarding
- [ ] Demo
- [ ] About
- [ ] Contact
- [ ] Terms/Privacy

Homepage proof flow:
Problem → lifecycle → product screenshots → differentiators → security → pricing → demo CTA.

- [ ] analytics with privacy-aware configuration.
- [ ] lead attribution.
- [ ] demo request flow into VenueLoom CRM.
- [ ] transactional follow-up.
- [ ] SEO metadata/schema/sitemap.
- [ ] accessibility/performance QA.

**Exit:** prospects can understand the product, trust it, and book a demo.

## Gate 7 — Beta

Recruit 3–5 independent venues with meaningfully different operating models.

Ideal mix:
- wedding venue;
- barn/estate;
- restaurant/private dining;
- corporate/private-event venue;
- multipurpose venue.

Beta requirements:
- [ ] signed beta terms/DPA.
- [ ] migration checklist.
- [ ] named owner at customer.
- [ ] baseline workflow interview.
- [ ] weekly feedback cadence.
- [ ] issue severity system.
- [ ] feature-request discipline.
- [ ] onboarding completion measure.
- [ ] first inquiry/proposal/contract/event milestones.
- [ ] tenant-isolation monitoring.
- [ ] usage analytics.
- [ ] support response tracking.

Do not promise every beta request. Classify requests as platform-core, configuration, integration, or venue-specific.

**Exit:** at least two beta venues actively use the system for real bookings and would be willing to pay.

## Gate 8 — First paying customer sales motion

ICP:
- independent event venues;
- 1–5 locations;
- small operational teams;
- outgrowing spreadsheets/generic CRM;
- meaningful inquiry volume;
- contracts/payments/vendor coordination.

Sales assets:
- [ ] 15-minute demo script.
- [ ] 45-minute discovery/demo.
- [ ] one-page PDF.
- [ ] comparison page vs generic CRMs/spreadsheets.
- [ ] ROI worksheet.
- [ ] migration promise/process.
- [ ] security FAQ.
- [ ] objection library.
- [ ] sample implementation timeline without unsupported guarantees.
- [ ] customer-success handoff.
- [ ] referral program.

Pipeline:
Lead → Discovery → Demo → Technical/operational fit → Proposal → Agreement → Onboarding → First live booking → 30-day review.

**First-customer offer:** favor a founder/beta package with explicit scope and feedback access rather than permanently underpricing the product.

## Metrics before scaling

Activation:
- onboarding completion;
- time to first imported/created client;
- time to first proposal;
- time to first booked event.

Engagement:
- weekly active staff;
- active CRM records;
- events managed;
- vendor documents tracked;
- automated tasks completed.

Reliability:
- API/function success;
- integration success;
- sync conflicts;
- auth failures;
- incident duration.

Business:
- demo-to-trial;
- trial-to-paid;
- ARR/MRR;
- onboarding revenue;
- gross margin;
- churn;
- support load per tenant.

## Definition of first commercial launch

VenueLoom has its first paying customer only after:
1. Koa remains operational as Tenant #1.
2. Tenant #2 isolation is proven.
3. Subscription/payment works.
4. Terms/privacy/DPA exist.
5. Backup/restore has been tested.
6. Core inquiry-to-event workflow works.
7. Onboarding does not require code changes.
8. Support and incident ownership are defined.
