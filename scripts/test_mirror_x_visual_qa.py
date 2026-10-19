#!/usr/bin/env python3
"""Public-only Mirror X browser gate: iPhone/desktop, Light/Dark, Chromium/WebKit.

Captures no customer data and does not submit inquiries or invoke private APIs.
Designed to run against an exact-head locally built Astro site on GitHub Actions.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

CASES = (("iphone", 390, 844, 2), ("desktop", 1440, 900, 1))
THEMES = ("light", "dark")
BROWSERS = ("chromium", "webkit")
PACKAGES = (("moment", "The Moment", "$795"), ("signature", "The Signature", "$1,095"),
            ("celebration", "The Celebration", "$1,395"))
ROUTES = (("landing", "/photo-booth/"), ("inquiry", "/photo-booth/inquire/?package=signature"))


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def layout(page, expected: str, route: str) -> None:
    page.wait_for_function(
        "(t) => document.documentElement.dataset.theme === t", arg=expected, timeout=8000
    )
    dimensions = page.evaluate("""() => ({
      width: innerWidth, scroll: document.documentElement.scrollWidth,
      theme: document.documentElement.dataset.theme,
      title: document.querySelector('main h1')?.textContent?.trim() || '',
      bodyBg: getComputedStyle(document.body).backgroundColor,
      imgSrc: document.querySelector('header .brand-medallion img')?.getAttribute('src') || ''
    })""")
    require(dimensions["scroll"] <= dimensions["width"] + 1,
            route + " has horizontal overflow: " + str(dimensions))
    require(dimensions["theme"] == expected, route + " theme did not resolve")
    require(bool(dimensions["title"]), route + " lacks a page title")
    require(dimensions["imgSrc"] == "/brand/koa-mark.png",
            route + " navbar is not using the shared emblem")
    require(page.locator("main h1").is_visible(), route + " headline not visible")
    require(page.locator("footer").count() == 1, route + " footer missing")


def landing(page, viewport: str) -> None:
    require("A mirror. A moment." in page.locator("main h1").inner_text(),
            "Mirror X headline is missing")
    require(page.locator('a[href="/photo-booth/inquire/"]').count() >= 1,
            "Check availability CTA is missing")
    hero_img = page.locator("main figure img").first
    require(hero_img.count() == 1, "Hero equipment image is missing")
    hero_img.scroll_into_view_if_needed()
    page.wait_for_function(
        "() => {const x=document.querySelector('main figure img');"
        "return !!x && x.complete && x.naturalWidth > 0;}", timeout=9000
    )
    cards = page.locator("#packages article")
    require(cards.count() == 3, "Three Mirror X pricing cards were not rendered")
    for package_id, label, price in PACKAGES:
        card = cards.filter(has=page.get_by_role("heading", name=label, exact=True))
        require(card.count() == 1, "Package card missing: " + label)
        require(price in card.inner_text(), "Package price mismatch: " + label)
        link = card.locator("a[href]").first.get_attribute("href")
        require(link == "/photo-booth/inquire/?package=" + package_id,
                "Package CTA preselection URL mismatch: " + label)
        require(card.locator("a[href]").first.is_visible(), "Package CTA hidden: " + label)
    faq = page.locator(".mirror-faq").first
    require(faq.count() == 1, "FAQ accordion is missing")
    faq.locator("summary").click()
    require(faq.evaluate("(el) => el.open") is True, "FAQ accordion did not expand")
    faq.locator("summary").click()
    if viewport == "iphone":
        menu = page.locator(".site-menu-trigger")
        require(menu.is_visible(), "iPhone navigation trigger missing")
        menu.click()
        require(page.locator('header .site-menu-panel a[href="/photo-booth/"]:visible').count() >= 1,
                "Mirror X link is not visible in iPhone navigation")
    else:
        more = page.locator('nav[aria-label="Primary navigation"] details')
        require(more.is_visible(), "Desktop More navigation missing")
        more.locator("summary").click()
        require(page.locator('nav[aria-label="Primary navigation"] a[href="/photo-booth/"]').is_visible(),
                "Mirror X link is not visible in desktop navigation")


def inquiry(page) -> None:
    form = page.locator("form[data-mirror-inquiry]")
    require(form.count() == 1, "Dedicated Mirror X inquiry form missing")
    require(form.locator('input[name="service"]').input_value() == "photo-booth",
            "Inquiry was not categorized as a photo booth rental")
    require(form.locator('select[name="photoBoothPackage"]').input_value() == "signature",
            "Signature package was not preselected from the CTA")
    require(form.locator('input[name="photoBoothEventLocation"]').get_attribute("required") is not None,
            "Off-site event location is not required")
    guest = form.locator('input[name="guestCount"]')
    require(int(guest.get_attribute("max") or "0") >= 1000,
            "Off-site rentals incorrectly use the Koa venue's 100-guest limit")
    require(form.locator('input[name="eventDate"]').is_visible(), "Event date field missing")
    require(form.locator('input[name="email"]').is_visible(), "Contact email field missing")
    require(form.locator('input[name="photoBoothExtra"]').count() >= 3,
            "Photo booth enhancements missing")
    require(form.locator('button[type="submit"]').is_visible(), "Booking request CTA missing")
    # Never submit: a real CRM record or Turnstile proof must not be created by visual QA.


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--base-url", default="http://127.0.0.1:4175")
    p.add_argument("--out", default="visual-results/mirror-x")
    args = p.parse_args()
    base = args.base_url.rstrip("/")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    cases = []
    failures = []
    with sync_playwright() as pw:
        for engine in BROWSERS:
            browser = getattr(pw, engine).launch()
            try:
                for theme in THEMES:
                    for viewport, width, height, scale in CASES:
                        context = browser.new_context(
                            viewport={"width": width, "height": height},
                            device_scale_factor=scale,
                            is_mobile=viewport == "iphone",
                            has_touch=viewport == "iphone",
                            color_scheme=theme, reduced_motion="reduce",
                        )
                        context.add_init_script(
                            "localStorage.setItem('koa-theme-preference', " + json.dumps(theme) + ");"
                        )
                        # Only read public pages; prevent requests to tenant/private API.
                        context.route("**/api/**", lambda req: req.fulfill(
                            status=200, content_type="application/json", body="{}"
                        ))
                        for route_name, route in ROUTES:
                            page = context.new_page()
                            label = engine + "-" + theme + "-" + viewport + "-" + route_name
                            issue = ""
                            screenshot = str(out / (label + ".jpg"))
                            try:
                                response = page.goto(base + route, wait_until="domcontentloaded",
                                                     timeout=30000)
                                require(response is not None and response.status < 400,
                                        "Page HTTP status was not successful")
                                layout(page, theme, route_name)
                                # Capture the unmodified page before interaction or test clicks.
                                page.screenshot(path=screenshot, type="jpeg", quality=74,
                                                full_page=True, animations="disabled",
                                                caret="hide", timeout=30000)
                                if route_name == "landing":
                                    landing(page, viewport)
                                else:
                                    inquiry(page)
                            except Exception as exc:
                                issue = str(exc)[:500]
                                failures.append({"case": label, "reason": issue})
                            cases.append({"case": label, "passed": not issue,
                                          "screenshot": screenshot if Path(screenshot).exists() else ""})
                            page.close()
                        context.close()
            finally:
                browser.close()
    report = {
        "schemaVersion": 1,
        "source": "koa-mirror-x-visual-qa",
        "headSha": os.environ.get("KOA_PR_HEAD_SHA", ""),
        "browsers": list(BROWSERS),
        "viewports": [{"name": n, "width": w, "height": h} for n, w, h, _ in CASES],
        "themes": list(THEMES),
        "routeCount": len(ROUTES),
        "caseCount": len(cases),
        "passCount": len(cases) - len(failures),
        "failureCount": len(failures),
        "failures": failures,
        "cases": cases,
    }
    (out / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"headSha": report["headSha"], "cases": len(cases),
                      "passed": report["passCount"], "failed": failures,
                      "report": str(out / "report.json")}, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
