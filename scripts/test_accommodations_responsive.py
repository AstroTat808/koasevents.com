#!/usr/bin/env python3
"""PR browser regression: public home, venue, and stay accommodation details.

Run against the built, unauthenticated static site. No customer data, admin pages,
or authenticated screenshots are accessed or saved.
"""
import argparse
import json
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

ROUTES = (("/", "home"), ("/venue/", "venue"), ("/stay/", "stay"))
VIEWPORTS = (
    ("iphone", 390, 844, 2, True),
    ("desktop", 1440, 900, 1, False),
)
HOMES = (("Three-bedroom home", 3, 2), ("Two-bedroom home", 2, 1))
OUTPUT = Path("visual-results/accommodations")


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def check_comparison(page, route, viewport, browser_name):
    section = page.locator("section#accommodations")
    require(section.count() == 1 and section.is_visible(), f"{route}: accommodations section missing")
    require(section.get_by_role("heading", name="Two homes. Room to stay together.").count() == 1,
            f"{route}: comparison heading missing")
    cards = section.locator("article")
    require(cards.count() == 2, f"{route}: expected two comparison cards, found {cards.count()}")

    for index, (title, bedrooms, bathrooms) in enumerate(HOMES):
        card = cards.nth(index)
        require(card.get_by_role("heading", name=title).count() == 1,
                f"{route}: incorrect home card {index + 1}")
        content = card.inner_text()
        require(re.search(rf"\b{bedrooms}\s+Bedrooms\b", content, re.I),
                f"{route}: {title} bedroom count missing")
        require(re.search(rf"\b{bathrooms}\s+Bathrooms\b", content, re.I),
                f"{route}: {title} bathroom count missing")

    text = section.inner_text()
    require("up to 10 overnight guests combined" in text.lower(),
            f"{route}: combined overnight capacity is missing")
    require("not to event attendance" in text.lower(),
            f"{route}: event vs overnight capacity distinction is missing")
    link = section.get_by_role("link", name="Request stay availability")
    require(link.count() == 1 and link.get_attribute("href") == "/stay/#stay-request",
            f"{route}: lodging inquiry link is incorrect")

    first, second = (cards.nth(index).bounding_box() for index in range(2))
    require(first is not None and second is not None, f"{route}: missing layout boxes")
    if viewport == "iphone":
        require(abs(first["x"] - second["x"]) <= 2 and
                second["y"] >= first["y"] + first["height"] + 8,
                f"{route}: home cards do not stack on iPhone")
    else:
        require(abs(first["y"] - second["y"]) <= 2 and
                second["x"] >= first["x"] + first["width"] + 8,
                f"{route}: home cards are not side-by-side on desktop")

    section.scroll_into_view_if_needed()
    section.screenshot(path=str(OUTPUT / f"{browser_name}-{viewport}-{route.strip('/')}-comparison.png"),
                       animations="disabled", caret="hide")


def check_home(page, viewport, browser_name):
    summary = page.locator(f'[data-home-property-details="{("mobile" if viewport == "iphone" else "desktop")}"]')
    require(summary.count() == 1 and summary.is_visible(),
            f"home: visible {viewport} property details card missing")
    copy = summary.inner_text()
    for snippet in ("Events for up to 100 guests", "3 bedrooms / 2 bathrooms",
                    "2 bedrooms / 1 bathroom", "Sleeps up to 10 guests combined"):
        require(snippet in copy, f"home: missing {snippet!r} on {viewport}")
    if viewport == "iphone":
        require(not page.locator('[data-home-property-details="desktop"]').is_visible(),
                "home: desktop overlay must be hidden on iPhone")
        action = page.locator('main a[href="/signature-wedding/"]').first.bounding_box()
        box = summary.bounding_box()
        require(action is not None and box is not None and
                box["y"] >= action["y"] + action["height"] - 2,
                "home: mobile property card overlaps the hero call to action")
    else:
        require(not page.locator('[data-home-property-details="mobile"]').is_visible(),
                "home: mobile card must be hidden on desktop")
    summary.scroll_into_view_if_needed()
    summary.screenshot(path=str(OUTPUT / f"{browser_name}-{viewport}-home-details.png"),
                       animations="disabled", caret="hide")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True, help="URL of the local static Astro build")
    args = parser.parse_args()
    base = args.base_url.rstrip("/")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    rows = []
    failures = []
    with sync_playwright() as pw:
        for browser_name in ("chromium", "webkit"):
            browser = getattr(pw, browser_name).launch(headless=True)
            for viewport, width, height, dpr, mobile in VIEWPORTS:
                ctx = browser.new_context(
                    viewport={"width": width, "height": height},
                    device_scale_factor=dpr,
                    is_mobile=mobile,
                    has_touch=mobile,
                    reduced_motion="reduce",
                )
                for path, label in ROUTES:
                    page = ctx.new_page()
                    row = {"browser": browser_name, "viewport": viewport, "route": path}
                    try:
                        response = page.goto(base + path, wait_until="domcontentloaded", timeout=30000)
                        require(response is not None and response.status < 400,
                                f"{path}: invalid HTTP response")
                        page.locator("main").wait_for(timeout=10000)
                        overflow = page.evaluate(
                            "() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth"
                        )
                        row["horizontalOverflowPx"] = round(overflow, 2)
                        require(overflow <= 2, f"{path}: horizontal overflow {overflow:.1f}px")
                        if path == "/":
                            check_home(page, viewport, browser_name)
                        else:
                            check_comparison(page, path, viewport, browser_name)
                        page.screenshot(
                            path=str(OUTPUT / f"{browser_name}-{viewport}-{label}-viewport.png"),
                            animations="disabled", caret="hide",
                        )
                        row["result"] = "passed"
                    except Exception as exc:
                        row["result"] = "failed"
                        row["reason"] = str(exc)
                        failures.append(row)
                        try:
                            page.screenshot(path=str(OUTPUT / f"{browser_name}-{viewport}-{label}-failure.png"),
                                            animations="disabled", caret="hide")
                        except Exception:
                            pass
                    finally:
                        rows.append(row)
                        page.close()
                ctx.close()
            browser.close()
    result = {"checks": len(rows), "passed": len(rows) - len(failures),
              "failed": len(failures), "results": rows}
    (OUTPUT / "public-accommodations-qa.json").write_text(json.dumps(result, indent=2))
    print(json.dumps({"checks": result["checks"], "passed": result["passed"],
                      "failed": result["failed"], "failures": failures}, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
