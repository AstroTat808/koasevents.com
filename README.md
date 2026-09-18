# Koa's Events website redesign

Astro + TypeScript + Tailwind CSS rebuild for koasevents.com.

## Status

Active work lives on the redesign/homepage-v1 branch. Production should remain on main until redesign QA, policy normalization and migration redirects are complete.

Current build includes:

- Homepage v1
- New brand palette aligned to the supplied Rainforest Monogram identity
- Working business-rules source of truth

## Commands

npm install
npm run dev
npm run build

## Planning docs

- docs/site-audit.md
- docs/information-architecture.md
- docs/brand-direction.md
- docs/business-rules-source-of-truth.md

## Business data

Customer-facing package and policy data should ultimately be read from src/data/businessRules.ts.

Do not hard-code a second version of capacity, package pricing or policy terms in future pages.

## Brand assets

The approved direction is the Rainforest Monogram system supplied by the owner. The global design tokens now use the green / koa / sand palette extracted from the supplied files.

The exact production SVG assets still need to be placed in public/brand/ and substituted into the header/footer brand component. Until that asset handoff is committed, the site intentionally uses a typographic Koa’s Events fallback rather than inventing a second logo.

## Asset note

The redesign preview still references select existing Wix-hosted photography. Before production launch, migrate original image assets into the repository or an approved image pipeline, generate responsive variants, and remove Wix hotlinks.
