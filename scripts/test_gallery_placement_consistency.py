#!/usr/bin/env python3
"""Fail closed when any declared public Gallery Admin placement ignores its crop.

Uses only synthetic gallery settings on the locally built public site. Every
rendered, mapped placement is checked at desktop width in Chromium and WebKit;
high-impact placements are also checked on iPhone. The same-origin iframe
preview is exercised on Home, Weddings, Venue and Stay. No production user
records, authenticated pages or real gallery settings are downloaded.
"""
from __future__ import annotations

import argparse
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
from urllib.parse import urljoin

from playwright.sync_api import sync_playwright

DIST = Path("dist")
OUTPUT = Path("visual-results/gallery-crop")
FOCUS_PAGES = ("/", "/weddings/", "/venue/", "/stay/")
GLOBAL = (23, 77)


class PlacementScriptParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_script = False
        self.raw = []

    def handle_starttag(self, tag, attrs):
        if tag == "script" and dict(attrs).get("id") == "koa-media-placement-data":
            self.in_script = True

    def handle_data(self, data):
        if self.in_script:
            self.raw.append(data)

    def handle_endtag(self, tag):
        if tag == "script":
            self.in_script = False

    def placements(self):
        if not self.raw:
            return []
        value = json.loads("".join(self.raw))
        assert isinstance(value, list), "Public placement manifest is not an array"
        return value


def discover() -> dict[str, list[dict]]:
    assert DIST.is_dir(), "Run npm build before Gallery placement regression"
    routes = {}
    for html_file in sorted(DIST.rglob("index.html")):
        relative = html_file.relative_to(DIST)
        route = "/" if len(relative.parts) == 1 else "/" + "/".join(relative.parts[:-1]) + "/"
        if route.startswith(("/admin/", "/portal/", "/staff/", "/booking/")):
            continue
        parser = PlacementScriptParser()
        parser.feed(html_file.read_text(encoding="utf-8"))
        placements = parser.placements()
        if not placements:
            continue
        slots = set()
        for entry in placements:
            assert isinstance(entry, dict) and entry.get("src", "").startswith("/"), (
                f"Invalid placement metadata on {route}"
            )
            assert entry.get("placementId"), f"Missing placement ID on {route}"
            key = (entry["src"], int(entry.get("occurrence", 0)))
            assert key not in slots, f"Conflicting placement occurrence on {route}: {key}"
            slots.add(key)
        routes[route] = placements
    assert routes and all(route in routes for route in FOCUS_PAGES), (
        "Missing public placement manifests for required venue pages"
    )
    return routes


def build_fixture(routes: dict[str, list[dict]]) -> dict:
    sources = sorted({entry["src"] for entries in routes.values() for entry in entries})
    edits = {src: {"focalX": GLOBAL[0], "focalY": GLOBAL[1]} for src in sources}
    overrides = {}
    for route, entries in routes.items():
        for entry in entries:
            src, placement = entry["src"], entry["placementId"]
            digest = hashlib.sha256(f"{src}|{placement}".encode()).digest()
            should_override = entry.get("impact") == "high" or digest[2] % 4 == 0
            if not should_override:
                continue
            overrides.setdefault(src, {})[placement] = {
                "focalX": 12 + digest[0] % 77,
                "focalY": 11 + digest[1] % 78,
            }
    assert overrides and len(edits) > 5, "Fixture lacks global and placement crop coverage"
    return {
        "curatedEdits": edits,
        "placementCrops": overrides,
        "uploads": [],
        "hiddenCurated": [],
        "hiddenUploads": [],
        "categoryOrder": {},
    }


# Mirror BaseLayout's source/occurrence matching, then independently compare
# the computed CSS against the synthetic saved global/placement records.
INSPECT_PAGE = r"""(payload) => {
    const normalize = (raw) => {
        if (!raw) return '';
        try {
            const url = new URL(raw, location.href);
            if (url.pathname === '/.netlify/images') {
                const original = url.searchParams.get('url');
                if (original) return new URL(original, location.href).pathname;
            }
            return url.pathname;
        } catch { return String(raw).split('?')[0]; }
    };
    const sourceFor = (el) => {
        if (el instanceof HTMLImageElement) {
            return normalize(el.getAttribute('data-koa-focal-src') ||
                el.getAttribute('src') || el.currentSrc);
        }
        return normalize(el.getAttribute('data-koa-focal-src'));
    };
    const candidates = [...document.querySelectorAll(
        'img[src],img[data-koa-focal-src],[data-koa-focal-src]:not(img)'
    )];
    const failures = [];
    let checked = 0;
    for (const entry of payload.placements) {
        const src = normalize(entry.src);
        const elements = candidates.filter((el) => sourceFor(el) === src);
        const el = elements[Number(entry.occurrence || 0)];
        if (!el) {
            failures.push({kind:'missing-placement',src,placement:entry.placementId});
            continue;
        }
        const override = payload.fixture.placementCrops[src]?.[entry.placementId];
        const global = payload.fixture.curatedEdits[src];
        const expected = override || global;
        if (!expected) {
            failures.push({kind:'missing-fixture',src,placement:entry.placementId});
            continue;
        }
        const rendered = el instanceof HTMLImageElement
            ? getComputedStyle(el).objectPosition
            : getComputedStyle(el).backgroundPosition;
        const wanted = expected.focalX + '% ' + expected.focalY + '%';
        if (rendered !== wanted) {
            failures.push({kind:'crop-mismatch',src,placement:entry.placementId,
                expected:wanted,rendered});
        }
        if (override && el.dataset.koaPlacementCropApplied !== entry.placementId) {
            failures.push({kind:'override-not-applied',src,placement:entry.placementId});
        }
        if (!override && el.dataset.koaFocalApplied !== 'true') {
            failures.push({kind:'global-not-applied',src,placement:entry.placementId});
        }
        if (el instanceof HTMLImageElement && el.srcset) {
            for (const item of el.srcset.split(',')) {
                const cdn = new URL(item.trim().split(/\s+/)[0], location.href);
                if (cdn.pathname === '/.netlify/images' &&
                    (cdn.searchParams.has('h') || !cdn.searchParams.has('w'))) {
                    failures.push({kind:'destructive-cdn-crop',src,
                        placement:entry.placementId});
                    break;
                }
            }
        }
        checked++;
    }
    return {checked, failures};
}"""


def inspect_route(page, base_url: str, route: str, entries: list[dict], fixture: dict) -> dict:
    url = urljoin(base_url.rstrip("/") + "/", route.lstrip("/"))
    response = page.goto(url, wait_until="domcontentloaded", timeout=30000)
    assert response and response.status == 200, f"Public route unavailable: {route}"
    page.wait_for_function(
        "() => Boolean(window.__koaGalleryFocalPoints instanceof Map)",
        timeout=20000,
    )
    runtime_entries = page.evaluate(
        "() => JSON.parse(document.querySelector('#koa-media-placement-data')?.textContent || '[]')"
    )
    assert len(runtime_entries) == len(entries), f"Manifest changed at runtime on {route}"
    # Gallery and article cards may be appended after the initial response.
    if route.startswith(("/gallery/", "/blog/")):
        page.wait_for_timeout(250)
    result = page.evaluate(INSPECT_PAGE, {"placements": entries, "fixture": fixture})
    result["route"] = route
    return result


def screenshot_target(page, route: str, entries: list[dict], browser_name: str, width: int) -> str | None:
    if route not in FOCUS_PAGES:
        return None
    target = next((entry for entry in entries if entry.get("impact") == "high"), None)
    if not target:
        return None
    src = target["src"]
    selector = 'img[data-koa-focal-src="' + src + '"]'
    candidates = page.locator(selector)
    index = int(target.get("occurrence", 0))
    if candidates.count() <= index:
        return None
    image = candidates.nth(index)
    image.scroll_into_view_if_needed(timeout=15000)
    page.wait_for_function(
        """selector => {
          const img = document.querySelector(selector);
          return img && img.complete && img.naturalWidth > 0;
        }""",
        arg=selector,
        timeout=20000,
    )
    path = OUTPUT / f"placement-{route.strip('/').replace('/', '-') or 'home'}-{browser_name}-{width}.png"
    page.screenshot(path=str(path), animations="disabled")
    return str(path)


def iframe_crop_test(page, base_url: str, route: str, entries: list[dict], width: int, browser_name: str) -> str:
    target = next((entry for entry in entries if entry.get("impact") == "high"), None)
    assert target, f"Missing high-impact placement for live preview: {route}"
    page.goto(base_url.rstrip("/") + "/", wait_until="domcontentloaded", timeout=30000)
    page.evaluate(
        """({route, width}) => {
          const frame = document.createElement('iframe');
          frame.id = 'koa-placement-qa-frame';
          frame.src = route + '?koa-gallery-preview=1';
          frame.style.width = width + 'px';
          frame.style.height = (width === 390 ? 844 : 900) + 'px';
          document.body.append(frame);
          window.__cropAck = null;
          window.addEventListener('message', event => {
            if (event.origin === location.origin && event.data?.type === 'koa:gallery-preview-applied')
              window.__cropAck = event.data;
          });
        }""",
        {"route": route, "width": width},
    )
    page.wait_for_function(
        """() => {
          const frame = document.querySelector('#koa-placement-qa-frame');
          return Boolean(frame?.contentWindow?.__koaGalleryFocalPoints instanceof Map);
        }""",
        timeout=25000,
    )
    # Distinct from the generated saved crop, proving unsaved edits are previewed.
    wanted_x, wanted_y = 7, 91
    page.evaluate(
        """({entry, x, y}) => {
          document.querySelector('#koa-placement-qa-frame').contentWindow.postMessage({
            type: 'koa:gallery-crop-preview',
            mode: 'placement',
            src: entry.src,
            placementId: entry.placementId,
            focalX: x,
            focalY: y,
          }, location.origin);
        }""",
        {"entry": target, "x": wanted_x, "y": wanted_y},
    )
    page.wait_for_function(
        """placementId => window.__cropAck?.applied === true &&
           window.__cropAck?.placementId === placementId""",
        arg=target["placementId"],
        timeout=20000,
    )
    page.wait_for_function(
        """({entry, x, y}) => {
          const frame = document.querySelector('#koa-placement-qa-frame');
          const doc = frame?.contentDocument;
          if (!doc) return false;
          const matches = [...doc.querySelectorAll('img[data-koa-focal-src]')]
            .filter(img => img.getAttribute('data-koa-focal-src') === entry.src);
          const el = matches[Number(entry.occurrence || 0)];
          return el?.dataset.koaCropPreview === 'unsaved' &&
            getComputedStyle(el).objectPosition === x + '% ' + y + '%';
        }""",
        arg={"entry": target, "x": wanted_x, "y": wanted_y},
        timeout=20000,
    )
    assert page.evaluate(
        "() => document.querySelector('#koa-placement-qa-frame').contentWindow.location.pathname"
    ) == route, "Live preview loaded the wrong public page"
    safe_name = route.strip("/").replace("/", "-") or "home"
    screenshot = OUTPUT / f"live-{safe_name}-{browser_name}-{width}.png"
    page.locator("#koa-placement-qa-frame").screenshot(path=str(screenshot), animations="disabled")
    return str(screenshot)


def run() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    args = parser.parse_args()
    routes = discover()
    fixture = build_fixture(routes)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    report = {
        "fixture": "synthetic-public-gallery",
        "route_count": len(routes),
        "placement_count": sum(len(entries) for entries in routes.values()),
        "source_count": len(fixture["curatedEdits"]),
        "cases": [],
        "screenshots": [],
        "failures": [],
    }
    with sync_playwright() as playwright:
        for browser_name in ("chromium", "webkit"):
            browser = getattr(playwright, browser_name).launch()
            try:
                for width, height in ((1440, 900), (390, 844)):
                    viewport_routes = routes if width == 1440 else {
                        key: value for key, value in routes.items()
                        if any(entry.get("impact") == "high" for entry in value)
                    }
                    context = browser.new_context(viewport={"width": width, "height": height})
                    context.route(
                        "**/api/gallery",
                        lambda route: route.fulfill(
                            status=200, content_type="application/json",
                            body=json.dumps(fixture),
                        ),
                    )
                    page = context.new_page()
                    try:
                        for route, entries in viewport_routes.items():
                            try:
                                result = inspect_route(page, args.base_url, route, entries, fixture)
                                report["cases"].append({
                                    "browser": browser_name,
                                    "viewport": width,
                                    "route": route,
                                    "checked": result["checked"],
                                })
                                for failure in result["failures"]:
                                    report["failures"].append({
                                        "browser": browser_name, "viewport": width,
                                        "route": route, **failure,
                                    })
                                if not result["failures"]:
                                    screenshot = screenshot_target(page, route, entries, browser_name, width)
                                    if screenshot:
                                        report["screenshots"].append(screenshot)
                            except Exception as exc:
                                report["failures"].append({
                                    "browser": browser_name, "viewport": width,
                                    "route": route, "kind": "page-audit-error",
                                    "reason": str(exc)[:250],
                                })
                        for route in FOCUS_PAGES:
                            try:
                                screenshot = iframe_crop_test(
                                    page, args.base_url, route, routes[route], width, browser_name
                                )
                                report["screenshots"].append(screenshot)
                            except Exception as exc:
                                report["failures"].append({
                                    "browser": browser_name, "viewport": width,
                                    "route": route, "kind": "live-preview-error",
                                    "reason": str(exc)[:250],
                                })
                    finally:
                        context.close()
            finally:
                browser.close()

    file_path = OUTPUT / "placement-consistency.json"
    file_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(
        "Gallery crop QA | public routes:", report["route_count"],
        "| mapped slots:", report["placement_count"],
        "| browser/viewport cases:", len(report["cases"]),
        "| screenshots:", len(report["screenshots"]),
        "| failures:", len(report["failures"]),
    )
    for failure in report["failures"][:20]:
        print("FAIL", json.dumps(failure, ensure_ascii=False))
    assert not report["failures"], "Gallery Admin crop vs. actual site placement mismatch"


if __name__ == "__main__":
    run()
