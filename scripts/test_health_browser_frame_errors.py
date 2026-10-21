#!/usr/bin/env python3
"""Synthetic negative regressions for Cloudflare's cross-origin frame warning.

No network access, credentials, customer records, or protected screenshots.
"""
from production_visual_qa import actionable_page_errors, findings

base="https://koasevents.com"
known=('SecurityError: Blocked a frame with origin "https://challenges.cloudflare.com" '
       'from accessing a frame with origin "https://koasevents.com". '
       'Protocols, domains, and ports must match.')
app_error="TypeError: Koa Health client failed to render a response"
fake_cloudflare="TypeError: challenges.cloudflare.com widget failed, but no frame-access restriction"
preview_error="[Cloudflare Turnstile] Error: 110200."

assert actionable_page_errors([known],base)==[], "Known browser restriction must not fail app"
assert actionable_page_errors([known,app_error],base)==[app_error], "App errors remain blocking"
assert actionable_page_errors([fake_cloudflare],base)==[fake_cloudflare], "Unrelated widget errors remain blocking"
assert actionable_page_errors([preview_error],base)==[preview_error], "Production Turnstile errors remain blocking"
assert actionable_page_errors([preview_error],"https://deploy-preview-17--koasevents-website.netlify.app")==[], "Only the known preview test-site error is nonblocking"
assert actionable_page_errors(["SecurityError: blocked cross-origin access"],base)==["SecurityError: blocked cross-origin access"], "Other cross-origin errors remain blocking"

dom={"h1s":["System Health"]}
cases=[
 ([known],False),
 ([app_error],True),
 ([known,app_error],True),
]
for errors,expected in cases:
 results=findings(dom,[],errors,[],[])
 actual=any(row.code=="page-error" and row.severity=="critical" for row in results)
 assert actual is expected,(errors,actual,expected)
requests=findings(dom,[],[known],["https://koasevents.com/api/system-health"],[])
assert any(row.code=="request-failed" and row.severity=="critical" for row in requests), "Same-origin request failures remain blocking"
print("PASS | approved third-party frame warning excluded; application, production Turnstile, and request errors fail closed")
