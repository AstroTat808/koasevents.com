#!/usr/bin/env python3
"""PR-only privacy-safe Safari/iPhone + desktop browser regression.

Uses synthetic non-customer session data, never captures authenticated
production screens or raw cookies. Backend auth/health is mocked solely
for DOM, redirect and responsive QA; a real identity refresh integration
requires an authenticated non-production account.
"""
import argparse
import json
import pathlib
from playwright.sync_api import sync_playwright

FIXTURE_SESSION = {
    "email": "fixture@example.invalid",
    "displayName": "Fixture staff",
    "role": "admin",
    "isAdmin": True,
    "accessBlocked": False,
    "permissions": ["health.view", "health.manage"],
    "capabilities": ["health.view", "health.manage"],
}
FIXTURE_DEVICES = {
    "ok": True,
    "checkedAt": "2026-10-01T00:00:00Z",
    "trustedCount": 2,
    "activeTokenCount": 1,
    "current": {"name": "QA iPhone", "current": True,
                "status": "access_token_active"},
    "sessions": [
        {
            "name": "QA iPhone", "device": "Safari on iPhone",
            "current": True, "trusted": True, "status": "access_token_active",
            "reason": "Access token valid",
            "createdAt": "2026-10-01T00:00:00Z",
            "lastSeenAt": "2026-10-01T00:00:00Z",
            "accessExpiresAt": "2026-10-01T01:00:00Z",
            "rememberedUntil": "2026-10-31T00:00:00Z",
            "lastRefreshedAt": "2026-10-01T00:00:00Z", "refreshCount": 1,
        },
        {
            "name": "QA desktop", "device": "Chrome on Mac",
            "current": False, "trusted": True, "status": "refresh_required",
            "reason": "Access token expired; remembered login can renew",
            "lastSeenAt": "2026-10-01T00:00:00Z",
            "accessExpiresAt": "2026-10-01T00:00:00Z",
            "rememberedUntil": "2026-10-31T00:00:00Z",
            "lastRefreshedAt": "",
            "refreshCount": 0,
        },
    ],
}

def fulfill_json(route, data, status=200):
    route.fulfill(status=status, content_type="application/json",
                  body=json.dumps(data), headers={"Cache-Control": "private, no-store"})

def run_case(browser_type, label, viewport, base, output, mobile=False):
    browser = browser_type.launch()
    context = browser.new_context(
        viewport=viewport, is_mobile=mobile,
        device_scale_factor=2 if mobile else 1,
        reduced_motion="reduce"
    )
    context.route("**/api/admin/session", lambda r: fulfill_json(r, FIXTURE_SESSION))
    context.route("**/api/admin/session-health", lambda r: fulfill_json(r, FIXTURE_DEVICES))
    # Other health subsystems are out of scope; the test reveals its Session
    # Health section even if a completely unrelated dashboard query fails.
    context.route("**/api/admin/health", lambda r: fulfill_json(r, {"error": "synthetic fixture only"}, 503))
    context.route("**/api/admin/calendar", lambda r: fulfill_json(r, {"code": "endpoint_specific"}, 401))
    page = context.new_page()
    page.goto(base + "/admin/", wait_until="domcontentloaded")
    checkbox = page.locator('form[data-login-form] input[name="remember"]')
    checkbox.wait_for(state="visible")
    assert checkbox.is_checked(), f"{label}: remember checkbox is not enabled by default"
    assert page.get_by_text("Keep me signed in for up to 30 days").count() >= 1
    page.screenshot(path=str(output / f"{label}-login.png"))
    page.goto(base + "/admin/health/", wait_until="domcontentloaded")
    details = page.locator("[data-session-health-details]")
    details.wait_for(state="attached")
    page.evaluate("""() => document.querySelector('[data-app]')?.classList.remove('hidden')""")
    details.locator("summary").click()
    page.get_by_text("QA iPhone").first.wait_for(state="visible", timeout=15000)
    page.get_by_text("QA desktop").first.wait_for(state="visible", timeout=15000)
    assert "Current session active" in page.locator("[data-session-health-summary]").inner_text()
    assert "Access token expired; remembered login can renew" in page.locator("[data-session-health-devices]").inner_text()
    overflow = page.evaluate("""() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        sectionWidth: document.querySelector('[data-session-health-section]').getBoundingClientRect().width
    })""")
    assert overflow["sectionWidth"] <= overflow["innerWidth"] + 2, f"{label}: Session Health card horizontal clipping: {overflow}"
    response_status = page.evaluate("""async () => {
        const response = await fetch('/api/admin/calendar');
        return response.status;
    }""")
    assert response_status == 401
    assert "/admin/health/" in page.url, f"{label}: unrelated API 401 forced redirect"
    page.screenshot(path=str(output / f"{label}-session-health.png"))
    print(f"PASS {label}: login persistence option, Session Health layout, and non-auth 401", flush=True)
    context.close()
    browser.close()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:4178")
    args = parser.parse_args()
    output = pathlib.Path("visual-results/session-persistence-qa")
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        run_case(playwright.webkit, "iphone-safari-webkit-390x844",
                 {"width": 390, "height": 844}, args.base_url, output, mobile=True)
        run_case(playwright.chromium, "desktop-chromium-1440x900",
                 {"width": 1440, "height": 900}, args.base_url, output)
        run_case(playwright.webkit, "desktop-safari-webkit-1440x900",
                 {"width": 1440, "height": 900}, args.base_url, output)
    print("PASS 3 Safari/desktop emulation cases; all screenshots synthetic and uncredentialed")

if __name__ == "__main__":
    main()
