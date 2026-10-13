#!/usr/bin/env python3
"""Prove image-CDN outages cannot leave Koa's public homepage imagery broken.

Run against a built static preview. The test deliberately returns 503 from the
Netlify Image CDN endpoint and requires the real deployed WebP file to render
at the same tablet breakpoint that failed in production.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import re
from playwright.sync_api import sync_playwright

IMAGE = "/media/koa/ceremony-setup-tropical.webp"
SELECTOR = 'img[data-koa-focal-src="' + IMAGE + '"]'


def run_browser(playwright, name: str, base_url: str) -> None:
    browser = getattr(playwright, name).launch()
    page = browser.new_page(viewport={"width": 768, "height": 1024}, device_scale_factor=2)
    transforms = []

    def reject_optimized_transform(route):
        transforms.append(route.request.url)
        route.fulfill(status=503, content_type="text/plain", body="synthetic CDN unavailable")

    try:
        page.route(re.compile(r"/\.netlify/images\?"), reject_optimized_transform)
        response = page.goto(base_url.rstrip("/") + "/", wait_until="domcontentloaded", timeout=20000)
        assert response and response.status == 200, "Built public homepage was not served"
        image = page.locator(SELECTOR).first
        image.scroll_into_view_if_needed(timeout=20000)
        page.wait_for_function(
            """(selector) => {
                const image = document.querySelector(selector);
                return Boolean(image &&
                    image.dataset.koaImageFallback === 'original' &&
                    image.complete && image.naturalWidth > 0 &&
                    !image.hasAttribute('srcset') &&
                    new URL(image.currentSrc).pathname === image.dataset.koaFocalSrc);
            }""",
            arg=SELECTOR,
            timeout=20000,
        )
        assert transforms, "No optimized CDN request was intercepted"
        # A real, correctly decoded image is required; error suppression alone fails.
        actual = image.evaluate(
            "(img) => ({width: img.naturalWidth, height: img.naturalHeight, src: img.currentSrc})"
        )
        assert actual["width"] >= 100 and actual["height"] >= 100, "Original image did not decode"
        assert IMAGE in actual["src"], "Fallback loaded an unexpected file"
        print(f"PASS | {name} 768x1024 | optimized transform failed; original WebP decoded")
    finally:
        page.close()
        browser.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    args = parser.parse_args()
    source = Path("src/components/ResponsiveImage.astro").read_text()
    assert "image.removeAttribute('srcset')" in source, "Fallback must clear failed srcset"
    assert "image.dataset.koaImageFallback = 'original'" in source, "Fallback must guard retry loops"
    assert "document.addEventListener('error'" in source, "Fallback must capture image load errors"
    assert "loading={priority ? 'eager' : 'lazy'}" in source, "Responsive image loading modes were unexpectedly changed"
    with sync_playwright() as playwright:
        for name in ("chromium", "webkit"):
            run_browser(playwright, name, args.base_url)


if __name__ == "__main__":
    main()
