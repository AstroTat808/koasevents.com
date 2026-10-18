#!/usr/bin/env python3
"""System Health live crop mismatch detection: synthetic public-only browser checks.

Tests real System Health DOM wiring and crop comparison logic without logging in
or touching authenticated health records. A failure must never be reported green.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright


def run_browser(playwright, name: str, base_url: str) -> None:
    browser = getattr(playwright, name).launch()
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    try:
        response = page.goto(
            base_url.rstrip("/") + "/admin/health/",
            wait_until="domcontentloaded", timeout=30000,
        )
        assert response and response.status == 200, "System Health built page unavailable"
        page.wait_for_function(
            "typeof window.__koaGalleryCropHealthInspect === 'function'",
            timeout=20000,
        )
        assert page.locator("[data-gallery-crop-health]").count() == 1
        assert page.locator("[data-gallery-crop-status]").count() == 1
        assert page.locator("[data-gallery-crop-run]").count() == 1
        assert page.locator("[data-gallery-crop-full]").count() == 1
        assert page.locator("#koa-gallery-crop-health-placements").count() == 1
        results = page.evaluate(
            r"""() => {
              const src = '/media/koa/ceremony-vows-closeup.webp';
              const placement = 'home__flagship-experience__4-3';
              const entry = {
                href: '/', src, occurrence: 0, placementId: placement,
                section: 'Flagship experience', impact: 'high',
              };
              const el = document.createElement('img');
              el.loading = 'lazy';
              el.setAttribute('data-koa-focal-src', src);
              el.setAttribute('src', src);
              el.style.objectPosition = '80% 12%';
              el.dataset.koaPlacementCropApplied = placement;
              document.body.append(el);
              const gallery = {
                curatedEdits: { [src]: { focalX: 31, focalY: 67 } },
                placementCrops: { [src]: { [placement]: { focalX: 80, focalY: 12 } } },
                uploads: [],
              };
              const check = window.__koaGalleryCropHealthInspect;
              const good = check(window, [entry], gallery);
              el.style.objectPosition = '50% 50%';
              const mismatch = check(window, [entry], gallery);
              el.style.objectPosition = '80% 12%';
              el.dataset.koaPlacementCropApplied = 'wrong';
              const override = check(window, [entry], gallery);
              el.dataset.koaPlacementCropApplied = placement;
              el.setAttribute('srcset',
                '/.netlify/images?url=%2Fmedia%2Fkoa%2Fceremony-vows-closeup.webp&w=800&h=600 800w');
              const preCrop = check(window, [entry], gallery);
              el.remove();
              const missing = check(window, [entry], gallery);
              // A live System Health check reads nodes from an iframe realm.
              const frame = document.createElement('iframe');
              document.body.append(frame);
              const childWindow = frame.contentWindow;
              const childImage = childWindow.document.createElement('img');
              childImage.setAttribute('src', src);
              childImage.style.objectPosition = '80% 12%';
              childImage.dataset.koaPlacementCropApplied = placement;
              childWindow.document.body.append(childImage);
              const crossRealmPass = check(childWindow, [entry], gallery);
              childImage.setAttribute('srcset',
                '/.netlify/images?url=%2Fmedia%2Fkoa%2Fceremony-vows-closeup.webp&w=800&h=600 800w');
              const crossRealmCdn = check(childWindow, [entry], gallery);
              frame.remove();
              return { good, mismatch, override, preCrop, missing, crossRealmPass, crossRealmCdn };
            }"""
        )
        def codes(key: str) -> set[str]:
            return {item["code"] for item in results[key]["failures"]}

        assert results["good"]["checked"] == 1 and not codes("good"), results["good"]
        assert "CROP_POSITION_MISMATCH" in codes("mismatch"), results["mismatch"]
        assert "CROP_OVERRIDE_NOT_APPLIED" in codes("override"), results["override"]
        assert "CROP_CDN_TRUNCATION" in codes("preCrop"), results["preCrop"]
        assert "CROP_PLACEMENT_MISSING" in codes("missing"), results["missing"]
        assert not codes("crossRealmPass"), results["crossRealmPass"]
        assert "CROP_CDN_TRUNCATION" in codes("crossRealmCdn"), results["crossRealmCdn"]
        print(f"PASS | {name} | System Health crop check: healthy + four mismatch regressions")
    finally:
        page.close()
        browser.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    args = parser.parse_args()
    layout = Path("src/pages/admin/health/index.astro").read_text()
    gallery = Path("src/pages/admin/gallery/index.astro").read_text()
    base = Path("src/layouts/BaseLayout.astro").read_text()
    assert "<GalleryCropHealth />" in layout, "System Health must include the crop card"
    assert "koa-gallery-crop-changed" in gallery, "Gallery saves must trigger live refresh"
    assert "__koaGalleryCropHydrated = true" in base, "Live checks must wait for public crop data"
    with sync_playwright() as playwright:
        for browser in ("chromium", "webkit"):
            run_browser(playwright, browser, args.base_url)


if __name__ == "__main__":
    main()
