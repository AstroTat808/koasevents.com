# Manual customer and project entry

The existing CRM stores customer contact information on each sales/project record. This feature preserves that model instead of creating a competing contact database.

## Staff workflows

- **New customer** creates an undated customer lead. A name is required; email and phone are optional.
- **New project** creates an inquiry/project with a required project name and customer name. Staff can copy an existing customer's details, including a record reference, without modifying the original project. Event date, event type, and guest count are optional.
- Select a pipeline record, then **Edit customer** to change its name, email or phone, or **Edit project** to change its title, date, type or guest count. These changes apply to the selected record only. Existing ownership, company, address, partner, source, tags and notes remain in the existing project workspace.
- A proposal/booking-linked event date is read-only in this general editor. Contact changes do not rewrite signed agreements or synchronize external accounting.

The editor uses the authenticated organization's `crm.manage` capability. Creating or editing does not send email, run workflows, reserve a date, issue invoices, create contracts, or alter payment status. The existing public inquiry anti-bot path is untouched.

## Validation and integrity

The server allowlists editable fields, validates inputs and actual calendar dates, rejects cross-origin requests and requires a fresh record revision for edits. Likely duplicate additions require explicit review and confirmation. Save requests retain a UUID through uncertain network outcomes, so a retry can recover the same record instead of creating another one. Staff-created entries can still be flagged for review, but are not automatically trashed by suspicious-name/date heuristics.

New writes use conditional ETag commits for the canonical sales index. Individual record copies, legacy compatibility copies and timeline entries are recoverable projections. Incomplete synchronization is explicitly reported; the editor retains the same request and does not claim a fully synchronized save. Record history retains actor, timestamp and changed field names. It does not copy contact field values into timeline messages.

This is not a global database transaction upgrade. Existing unrelated endpoints still use their existing unconditional storage writes, and Blob storage does not provide a multi-key transaction across sales and CRM. The manual editor checks known index/record divergence and does not overwrite an independently changed record copy. Migrating all legacy writers to a transactional store is separate work.

## Verification and release

Run `node --test scripts/test_crm_record_editor.mjs` after `npm ci`. The suite exercises pure validation, preservation of financial data, duplication, concurrent manual writes, stale revisions, idempotent retries, partial projection recovery, and the HTTP wrapper with isolated authentication/storage adapters. It does not use real customer records or production credentials.

Local browser testing covered the isolated component and real client script in Chromium at 1440x900, 390x844 and 360x780, Light and Dark, with mocked HTTP. This is not production authentication or real Safari certification. Before merging, require the exact-head Astro build, existing release gates, preview deployment match, and authenticated preview end-to-end checks. No production records should be created merely to test the UI.
