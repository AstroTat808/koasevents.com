#!/usr/bin/env python3
"""Browser regression for site-wide gallery focal points and live crop preview.

Runs only against the locally built public site, with synthetic gallery data.
No authenticated production pages or customer information are captured.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import sync_playwright

PHOTO = "/media/koa/ceremony-vows-closeup.webp"
PLACEMENT = "home__flagship-experience__4-3"
SELECTOR = 'img[data-koa-focal-src="' + PHOTO + '"]'
GALLERY = {
    "curatedEdits": {PHOTO: {"focalX": 31, "focalY": 67}},
    "placementCrops": {PHOTO: {PLACEMENT: {"focalX": 80, "focalY": 12}}},
    "uploads": [],
    "hiddenCurated": [],
    "hiddenUploads": [],
    "categoryOrder": {},
}


def assert_full_source_srcset(image) -> None:
    srcset = image.get_attribute("srcset") or ""
    assert srcset, "Responsive photo must offer an optimized srcset"
    for candidate in srcset.split(","):
        url = candidate.strip().split(" ")[0]
        query = parse_qs(urlsplit(url).query)
        assert query.get("url", [""])[0] == PHOTO, "Unexpected source in image CDN request"
        assert "w" in query, "Missing CDN responsive width"
        assert "h" not in query, "Server-side crop discards pixels before the saved focal point can work"


def assert_position(image, x: int, y: int) -> None:
    expected = f"{x}% {y}%"
    image.page.wait_for_function(
        """([selector, position]) => {
          const image = document.querySelector(selector);
          return image && getComputedStyle(image).objectPosition === position;
        }""",
        arg=[SELECTOR, expected],
        timeout=20000,
    )
    assert image.evaluate("(img) => getComputedStyle(img).objectFit") == "cover"


def exercise_browser(playwright, browser_name: str, base_url: str, width: int, height: int) -> None:
    browser = getattr(playwright, browser_name).launch()
    context = browser.new_context(viewport={"width": width, "height": height})
    context.route("**/api/gallery", lambda route: route.fulfill(
        status=200,
        content_type="application/json",
        body=json.dumps(GALLERY),
    ))
    page = context.new_page()
    try:
        response = page.goto(base_url.rstrip("/") + "/", wait_until="domcontentloaded", timeout=30000)
        assert response and response.status == 200, "Homepage build unavailable"
        image = page.locator(SELECTOR).first
        image.wait_for(timeout=15000)
        assert_full_source_srcset(image)
        assert_position(image, 80, 12)  # Placement override wins over global 31 / 67.
        image.scroll_into_view_if_needed(timeout=15000)
        assert image.evaluate("(el) => el.dataset.koaPlacementCropApplied") == PLACEMENT

        out = Path("visual-results/gallery-crop")
        out.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(out / f"home-{browser_name}-{width}.png"), animations="disabled")

        # The same photo used elsewhere must use the global crop if no override exists.
        response = page.goto(base_url.rstrip("/") + "/weddings/", wait_until="domcontentloaded")
        assert response and response.status == 200, "Weddings page build unavailable"
        elsewhere = page.locator(SELECTOR).first
        elsewhere.wait_for(timeout=15000)
        assert_full_source_srcset(elsewhere)
        assert_position(elsewhere, 31, 67)

        # A real, isolated homepage iframe accepts only same-origin unpublished previews.
        page.goto(base_url.rstrip("/") + "/", wait_until="domcontentloaded")
        page.evaluate("""() => {
          const iframe = document.createElement('iframe');
          iframe.id = 'koa-crop-browser-fixture';
          iframe.src = '/?koa-gallery-preview=1';
          iframe.style.cssText = 'width:390px;height:844px;border:0';
          document.body.appendChild(iframe);
          window.__koaPreviewAck = null;
          window.addEventListener('message', (event) => {
            if (event.origin === location.origin && event.data?.type === 'koa:gallery-preview-applied') {
              window.__koaPreviewAck = event.data;
            }
          });
        }""")
        in_frame = page.frame_locator("#koa-crop-browser-fixture").locator(SELECTOR).first
        in_frame.wait_for(timeout=25000)
        # Changing the global crop cannot overwrite an independently saved placement crop.
        page.evaluate("""([photo, placement]) => {
          document.querySelector('#koa-crop-browser-fixture').contentWindow.postMessage({
            type: 'koa:gallery-crop-preview', mode: 'global',
            src: photo, placementId: placement, focalX: 95, focalY: 95,
          }, location.origin);
        }""", [PHOTO, PLACEMENT])
        page.wait_for_function("window.__koaPreviewAck?.applied === true", timeout=15000)
        assert in_frame.evaluate("(el) => getComputedStyle(el).objectPosition") == "80% 12%"

        page.evaluate("window.__koaPreviewAck = null")
        page.evaluate("""([photo, placement]) => {
          document.querySelector('#koa-crop-browser-fixture').contentWindow.postMessage({
            type: 'koa:gallery-crop-preview', mode: 'placement',
            src: photo, placementId: placement, focalX: 24, focalY: 79,
          }, location.origin);
        }""", [PHOTO, PLACEMENT])
        page.wait_for_function("window.__koaPreviewAck?.applied === true", timeout=15000)
        assert in_frame.evaluate("(el) => getComputedStyle(el).objectPosition") == "24% 79%"
        assert in_frame.evaluate("(el) => el.dataset.koaCropPreview") == "unsaved"

        # The editor itself must expose the same two viewport presets and an iframe.
        response = page.goto(base_url.rstrip("/") + "/admin/gallery/", wait_until="domcontentloaded")
        assert response and response.status == 200, "Gallery Admin build unavailable"
        assert page.locator("[data-home-crop-preview]").count() == 1
        assert page.locator('[data-home-preview-mode="desktop"]').count() == 1
        assert page.locator('[data-home-preview-mode="mobile"]').count() == 1
        assert page.locator("[data-home-preview-frame]").count() == 1
        print(f"PASS | {browser_name} {width}x{height} | global + placement + live iframe + editor markup")
    finally:
        context.close()
        browser.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    args = parser.parse_args()
    component = Path("src/components/ResponsiveImage.astro").read_text()
    assert "preserveSourceCrop = true" in component, "Uncropped CDN default must cover all responsive images"
    with sync_playwright() as playwright:
        for name in ("chromium", "webkit"):
            for width, height in ((1440, 900), (390, 844)):
                exercise_browser(playwright, name, args.base_url, width, height)


if __name__ == "__main__":
    main()
