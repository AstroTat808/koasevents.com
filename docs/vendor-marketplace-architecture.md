# Koa's Vendor Marketplace architecture

## Purpose
Create one master vendor directory that serves staff operations and booked-client planning without duplicating vendor records per event.

## Core records
Vendor profiles live in Netlify Blobs store `koa-vendors` under `vendors/index`. Event-specific assignments continue to live in `koa-event-ops` under `events/{recordId}`. Client favorites are stored per booked record and verified reviews are tied to both `recordId` and `vendorId`.

## Vendor profile fields
Identity: display name, legal name, primary category, additional categories, partner tier, publishing status.
Marketing: headline, description, specialties, styles, service areas, starting price, pricing notes, travel fees, usual response time, logo, cover image.
Contact: contact name, email, phone, website, Instagram, Facebook.
Gallery attribution: image source, caption and optional event label. Images remain in the existing gallery/media system; vendor profiles store references rather than duplicate files.
Compliance: insurance status, carrier, policy number, expiration, additional-insured flag, certificate URL and verification timestamp.
Internal performance: staff rating, punctuality, communication, venue compliance, cleanliness, invite-back decision, notes, events worked and last event date.

## Partner tiers
Preferred Partner means Koa's has chosen to actively recommend the vendor based on repeated positive experience. Verified Vendor means required business/insurance information has been reviewed, but no endorsement is implied. Community Vendor is a marketplace listing without Preferred or Verified designation.

A paid placement must never automatically change Preferred or Verified status.

## Verified client review rules
Only a booked client can submit a review, only after the event date, and only for a marketplace vendor attached to that client's Event Ops vendor roster. Reviews collect Overall, Communication, Professionalism, Quality/Execution, Value, Would Hire Again and a written comment. New reviews enter pending moderation and become public only after staff publishes them.

## Insurance lifecycle
not_requested -> requested -> received -> approved. When the expiration date passes, staff should move the record to expired; future automation can perform this transition and notify the vendor. Event Ops receives approved/not_requested status when a vendor is selected but remains the authoritative location for event-specific compliance follow-up.

## Gallery linkage
Vendor records reference existing gallery image URLs. This creates a many-to-many relationship without copying images. A vendor profile can therefore automatically display all images staff has attributed to that vendor, including event labels and captions.

## Client workflow
Booked client -> Vendor Marketplace -> filter/browse -> favorite -> compare mentally or by shortlist -> select vendor -> vendor is inserted into My Event Team/Event Ops -> Koa's staff manages arrival and compliance -> after event client receives review capability -> moderated review contributes to marketplace rating.

## Recommended next enhancements
Vendor self-service portal, availability requests/introduction tracking, automated insurance expiry reminders, explicit image attribution controls inside Gallery Admin, category completion progress, recommendation rules based on guest count/budget/event type, and vendor performance analytics.
