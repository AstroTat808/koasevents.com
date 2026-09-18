# Koa’s Events Wix Content Audit

Audit date: 2026-09-17 (Hawaiʻi time)

## Executive findings

- The current site has valuable photography, service details, packages, team story and SEO content, but the architecture mixes venue, wedding, private event, corporate and mobile-bar intents.
- The repeated Wix inquiry forms are being replaced by one conditional /inquire/ flow.
- Venue maximum occupancy is now approved at **100 persons** for launch and client-facing documents have been updated to match.
- The old “Birthday Packages” page substantially duplicates wedding content and should not be migrated as-is.
- Several blog posts are worth preserving for SEO but need factual/pricing freshness edits.

## Core pages

| Current URL | Action | New destination |
|---|---|---|
| / | REWRITE | / |
| /events | MERGE | /venue/, /weddings/, /private-events/, /corporate-events/ |
| /wedding-packages | REWRITE / REDIRECT | /venue/packages/ |
| /copy-of-wedding-packages | DELETE / REDIRECT | /private-events/ |
| /koas-mobile-bar | REWRITE / REDIRECT | /mobile-bar/ |
| /booking | MERGE / REDIRECT | /inquire/ |
| /a-la-carte | MERGE | /venue/packages/ |
| /guest-suites | REWRITE | /venue/guest-suites/ |
| /gallery | KEEP / REBUILD | /gallery/ |
| /blog | KEEP / REBUILD | /blog/ |
| /contact | MERGE / REDIRECT | /inquire/ |
| /custom-event-package-questionnaire | MERGE / REDIRECT | /inquire/ |
| /about | REWRITE | /about/ |

## Resolved content conflicts

1. **Venue capacity:** resolved at 100 persons for launch. Contract, checklist and Welcome Summary updated.
2. **Mobile Bar bartender/tipping model:** percentage bartender-fee language retired from redesigned site. Standard bartender labor included; gratuity optional; no default tip jar; custom staffing quoted when needed.

## Remaining content cleanup

1. Distinguish package-included furniture from the 100-person venue maximum.
2. Confirm final Plumeria inclusions and any third-party/vendor-dependent items.
3. Confirm travel mileage origin/calculation.
4. Confirm whether legacy $8/additional-guest Mobile Bar consumables pricing remains.
5. Confirm fixed vs. quote-only add-on pricing.
6. Decide whether the Event Day Checklist’s 75 dB rule belongs in the controlling venue agreement.

## Redirect principle

Every indexed Wix URL should retain its path or receive a 301 to the closest intent-equivalent page. Do not send unrelated retired pages to the homepage by default.
