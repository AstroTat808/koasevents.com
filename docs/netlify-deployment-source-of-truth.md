# Netlify deployment source of truth

Updated: 2026-09-22

## Production

- Netlify project: `koasevents-website`
- Site ID: `d1f3ab06-be2a-41c4-b770-59e6a6acd1b9`
- Production domain: `https://koasevents.com`
- Production branch: `main`
- Pull-request preview host: `https://deploy-preview-<PR>--koasevents-website.netlify.app`

This is the project that must be used for production verification and deploy-preview QA.

## Legacy duplicate

- Netlify project: `koasevents`
- Site ID: `a27d5e15-a2fd-4617-87f8-7b45f062fdab`
- Netlify subdomain: `https://koasevents.netlify.app`

This project is not the production source of truth. Its recent preview builds have been skipped with
`Skipped due to account builds usage exceeded`. Those failures must not be interpreted as failures
of the live `koasevents.com` deployment.

The legacy project's Git integration should be disconnected or builds stopped in Netlify when access
to that project configuration is available, so duplicate failed preview notifications no longer appear.

## QA rules

- Production tests target `https://koasevents.com`.
- Pull-request tests target `koasevents-website` deploy previews.
- A release is considered deployed only when the `koasevents-website` production deploy reports
  the expected `main` commit as ready.
- The legacy `koasevents` project is informational only and must not gate merges or releases.
