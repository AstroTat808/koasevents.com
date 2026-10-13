#!/usr/bin/env python3
"""Collect and later package only synthetic System Health accordion QA evidence.

Collection occurs in the authenticated health QA job but writes only fixed
interaction boolean assertions and four explicitly watermarked synthetic images
into an artifact. No raw System Health dashboard JSON or client details leave
the job. Packaging happens in exact-SHA OIDC release certification.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys

CASES = (("chromium", "phone", 390, 844), ("chromium", "desktop", 1440, 900),
         ("webkit", "phone", 390, 844), ("webkit", "desktop", 1440, 900))
TESTS = ("initialClosed", "criticalInitiallyOpen", "manuallyOpened",
         "manuallyClosed", "criticalForcedOpen", "recoveredCollapsed")


def valid_jpeg(image: bytes):
    return 1100 <= len(image) <= 260000 and image.startswith(b"\xff\xd8\xff")


def collect(root: Path):
    staged = root / "accordion-synthetic"
    staged.mkdir(parents=True, exist_ok=True)
    for browser, viewport, width, height in CASES:
        key = browser + "-" + viewport
        browser_root = root / ("health-mobile-" + browser)
        report = json.loads((browser_root / "report.json").read_text())
        if report.get("mode") != "health-mobile" or report.get("browser") != browser or report.get("failures") != []:
            raise ValueError("Synthetic browser QA report incomplete or failed")
        rows = [r for r in report.get("results", []) if r.get("viewport") == viewport]
        if len(rows) != 1 or rows[0].get("width") != width or rows[0].get("height") != height or rows[0].get("failure"):
            raise ValueError("Exact synthetic viewport QA failed")
        checks = (rows[0].get("metrics") or {}).get("sectionCollapse") or {}
        if int(checks.get("sections") or 0) < 1 or any(checks.get(t) is not True for t in TESTS):
            raise ValueError("Six mandatory accordion interactions were not verified")
        image = (browser_root / ("accordion-" + viewport + ".jpg")).read_bytes()
        if not valid_jpeg(image):
            raise ValueError("Synthetic screenshot JPEG missing or exceeds evidence limit")
        (staged / (key + ".jpg")).write_bytes(image)
        metadata = {
            "key": key, "browser": browser, "viewport": viewport,
            "width": width, "height": height, "route": "/admin/health/",
            "synthetic": True, "status": "passed",
            "results": {test: True for test in TESTS},
            "sha256": hashlib.sha256(image).hexdigest(),
        }
        (staged / (key + ".json")).write_text(json.dumps(metadata, separators=(",", ":")))
    print("Collected only four synthetic accordion screenshots and boolean QA evidence; no raw health snapshot staged.")


def package(root: Path, commit: str, deploy_id: str, run_id: str):
    if not re.fullmatch(r"[a-f0-9]{40}", commit) or not re.fullmatch(r"[A-Za-z0-9_-]{8,120}", deploy_id):
        raise ValueError("Exact SHA or deploy ID is invalid")
    if not run_id.isdigit():
        raise ValueError("GitHub run ID missing")
    staged = root / "accordion-synthetic"
    expected = {b + "-" + v for b, v, _, _ in CASES}
    staged_names = {p.name for p in staged.iterdir() if p.is_file()}
    if staged_names != {name + ext for name in expected for ext in (".json", ".jpg")}:
        raise ValueError("Synthetic artifact does not contain exactly the expected four image/metadata pairs")
    results = []
    for browser, viewport, width, height in CASES:
        key = browser + "-" + viewport
        row = json.loads((staged / (key + ".json")).read_text())
        if (row.get("key") != key or row.get("browser") != browser or row.get("viewport") != viewport
            or row.get("width") != width or row.get("height") != height
            or row.get("route") != "/admin/health/"
            or row.get("synthetic") is not True or row.get("status") != "passed"
            or any((row.get("results") or {}).get(t) is not True for t in TESTS)):
            raise ValueError("Synthetic screenshot metadata tampered with or incomplete")
        image = (staged / (key + ".jpg")).read_bytes()
        if not valid_jpeg(image) or hashlib.sha256(image).hexdigest() != row.get("sha256"):
            raise ValueError("Synthetic screenshot digest or JPEG validation failed")
        results.append({**row, "dataBase64": base64.b64encode(image).decode("ascii")})
    return {
        "source": "synthetic-health-qa", "commit": commit,
        "deployId": deploy_id, "runId": run_id, "results": results,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--collect", action="store_true")
    args = parser.parse_args()
    root = Path("visual-results")
    if args.collect:
        collect(root)
        return
    deploy = json.loads(Path("/tmp/koa-production-attestation.json").read_text())
    payload = package(root, os.environ["GITHUB_SHA"], str(deploy.get("deployId") or ""),
                      os.environ["GITHUB_RUN_ID"])
    Path("/tmp/koa-accordion-evidence.json").write_text(json.dumps(payload, separators=(",", ":")))
    print("Validated four synthetic browser screenshot attachments for exact SHA/deploy; private OIDC attestation request ready.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Synthetic accordion evidence blocked: " + str(error), file=sys.stderr)
        sys.exit(1)
