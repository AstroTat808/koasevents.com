# Koa’s Events Wix Content Audit

Audit date: 2026-09-17 (Hawaiʻi time)

This audit covers the public core pages in the current navigation plus all posts shown on the public blog index. Wix-generated account/search/comment surfaces are platform UI and should not be migrated as customer-facing pages.

## Executive findings

- The current site has valuable photography, service details, packages, team story and SEO content, but the architecture mixes venue, wedding, private event, corporate and mobile-bar intents on the same pages.
- The full inquiry form is repeated across several pages. Replace with one conditional /inquire/ flow.
- Pricing and capacity information is inconsistent across pages and internal client documents; establish one source of truth before launch.
- The “Birthday Packages” page is substantially duplicated wedding content and should not be migrated as-is.
- Several blog posts are worth preserving for SEO but need factual/pricing freshness edits.

## Core pages

| Current URL | Action | New destination | Recommendation |
|---|---|---|---|
| / | REWRITE | / | Keep URL. Rebuild around Venue + Mobile Bar + clear event-type journeys. Current homepage is too sparse for the breadth of the business. |
| /events | MERGE | /venue/, /weddings/, /private-events/, /corporate-events/ | Break the omnibus page into intent-specific landing pages. 301 /events to /venue/ or a new /events/ hub only if analytics justify it. |
| /wedding-packages | REWRITE | /venue/packages/ | Preserve package equity but simplify comparison, verify every inclusion and capacity, and add decision guidance. 301 old URL if route changes. |
| /copy-of-wedding-packages | DELETE / REDIRECT | /private-events/ | The page is titled Birthday Packages but contains wedding-specific duplicated copy. Do not migrate. Redirect to private events or a future private-event packages page. |
| /koas-mobile-bar | REWRITE | /mobile-bar/ | Strong service content. Rewrite for clearer dry-bar explanation, logistics, service styles, travel/staffing and conversion path. 301 old URL. |
| /booking | MERGE | /inquire/ | Replace Wix booking-service cards with unified qualification + scheduling/consultation flow. |
| /a-la-carte | MERGE / REWRITE | /venue/packages/ | Price catalog concept is useful but should become structured, accessible web content rather than an isolated catalog experience. |
| /guest-suites | REWRITE | /venue/guest-suites/ | Keep as a differentiator. Shorten generic copy and clarify exactly what spaces/accommodations are actually available with each package. |
| /gallery | KEEP / REBUILD | /gallery/ | Keep URL. Curate by weddings, venue, mobile bar and private/corporate events; optimize originals and add meaningful alt text. |
| /blog | KEEP / REBUILD | /blog/ | Retain URL for SEO. Rebrand visually as Planning Journal/Resources while preserving canonical URL structure. |
| /contact | MERGE | /inquire/ | 301 to unified inquiry page. Keep direct email/phone in footer and contact modules. |
| /custom-event-package-questionnaire | MERGE | /inquire/?type=custom | Good qualification fields, but too long and non-conditional. Preserve questions in a progressive form. |
| /about | REWRITE | /about/ | Keep team credibility and venue story; tighten generic language and connect Shaun/Chris expertise to client outcomes. |

## Blog posts

| Current post | Action | Recommendation |
|---|---|---|
| Big Island Rainforest Wedding Venue Guide | KEEP + UPDATE | Strong high-intent local/venue SEO topic. Verify guest-capacity language and strengthen Mountain View / Hilo-side planning details. |
| Koa’s Mobile Bar – Frequently Asked Questions | KEEP + LIGHT REWRITE | Excellent support content. Use it to feed /mobile-bar/faq/ while retaining the post URL and internal links. |
| Comprehensive A–Z Wedding Glossary | KEEP + EDIT | Broad evergreen search utility. Clean formatting, fact-check Hawaiʻi-specific legal/cultural references, and add contextual links to Koa’s services. |
| 5 Biggest Bachelorette Party Mistakes | KEEP + UPDATE | Useful adjacent private-event content. Add a clearer Big Island/Koa’s angle and stronger inquiry path. |
| Real Brides Share Wedding & Bachelorette Pain Points | MERGE | Overlaps heavily with the bachelorette planning article. Consolidate into one stronger planning resource and 301 the weaker URL after traffic/backlink review. |
| Impact of Tariffs on Your Wedding | REPURPOSE | Time-sensitive and likely to age poorly. Rewrite as an evergreen Hawaiʻi wedding-cost / local-sourcing guide; preserve URL only if it has meaningful traffic/backlinks. |
| Micro Weddings vs. Traditional Weddings: Choosing the Perfect Style… | KEEP + REWRITE | Strong core positioning topic but too long/repetitive and includes estimates that can age. Tighten and align with Koa’s actual current capacity/offer. |
| How to Have a Beautiful $5,000 Wedding at Koa’s Events | REWRITE | Good budget-intent query, but package/pricing and self-serve bar guidance must be reconciled with current policies before migration. |
| Micro Wedding or Traditional Wedding | MERGE | Short duplicate topic. 301 to the stronger long-form micro-vs-traditional article. |
| The Art of Aloha: Infusing Hawaiian Culture into Modern Wedding | REWRITE | Keep the intent but replace generic/touristic cultural framing with specific, respectful, locally grounded guidance. |
| I’m Engaged: Now What? | KEEP + REWRITE | Evergreen top-of-funnel checklist. Modernize, shorten and add Hawaiʻi-specific next steps where supported. |

## Content conflicts to resolve before production

1. Maximum occupancy: the venue rental agreement says 50; the Client Welcome Summary says 100; current public package pages generally say up to 50, while a newer blog guide references celebrations under 100. Pick one approved capacity per event configuration.
2. Birthday packages: wedding-only benefits/copy appear under the Birthday Packages page.
3. Hibiscus package: some public copy says it is for up to 50 guests while listed tables/chairs describe 10 guests. Clarify included quantities vs maximum allowed attendance.
4. Bar tipping: current mobile bar page shows a 25% bartender fee; the custom questionnaire also offers a 10% + tip jar option. Confirm current policy.
5. Bar/legal language: current content alternates among “licensed bartenders,” “dry bar,” and client-provided alcohol. Final copy should use one approved, precise description.
6. Outdated/time-sensitive blog pricing: package prices and cost guides need a single current pricing source.

## Redirect strategy

Create a migration map before DNS/production cutover. Every indexed Wix URL should either retain the same path, 301 to the closest new intent-equivalent page, or be retired only when it has no search/backlink/customer value.

Never send unrelated retired pages to the homepage by default; use the closest relevant destination.
