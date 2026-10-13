#!/usr/bin/env python3
"""Package only synthetic, API-mocked System Health accordion QA evidence.

The output is local to the attestation job and is submitted with GitHub's OIDC
credential. It is not uploaded to a public Actions artifact or echoed to logs.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys

CASES = (("chromium", "phone", 390, 844), ("chromium", "desktop", 1440, 900),
         ("webkit", "phone", 390, 844), ("webkit", "desktop", 1440, 900))
TESTS = ("initialClosed", "criticalInitiallyOpen", "manuallyOpened",
         "manuallyClosed", "criticalForcedOpen", "recoveredCollapsed")


def prepare(root: Path, commit: str, deploy_id: str, run_id: str):
    if not re.fullmatch(r"[a-f0-9]{40}", commit) or not re.fullmatch(r"[A-Za-z0-9_-]{8,120}", deploy_id):
        raise ValueError("Exact SHA / Netlify deploy ID is invalid")
    if not run_id.isdigit():
        raise ValueError("GitHub run ID missing")
    results = []
    for browser, viewport, width, height in CASES:
        folder = root / ("health-mobile-" + browser)
        report = json.loads((folder / "report.json").read_text())
        if report.get("mode") != "health-mobile" or report.get("browser") != browser or report.get("failures") != []:
            raise ValueError("Accordion browser report is incomplete or failed")
        rows = [row for row in report.get("results", []) if row.get("viewport") == viewport]
        if len(rows) != 1 or rows[0].get("width") != width or rows[0].get("height") != height or rows[0].get("failure"):
            raise ValueError("Accordion viewport result was missing, duplicated, or failed")
        metrics = (rows[0].get("metrics") or {}).get("sectionCollapse") or {}
        if int(metrics.get("sections") or 0) < 1 or any(metrics.get(test) is not True for test in TESTS):
            raise ValueError("Required phone/desktop accordion interaction was not verified")
        image = (folder / ("accordion-" + viewport + ".jpg")).read_bytes()
        if len(image) < 1100 or len(image) > 260000 or not image.startswith(b"\xff\xd8\xff"):
            raise ValueError("Synthetic accordion screenshot is missing, invalid, or too large")
        encoded = base64.b64encode(image).decode("ascii")
        results.append({
            "key": browser + "-" + viewport, "browser": browser, "viewport": viewport,
            "width": width, "height": height, "route": "/admin/health/",
            "synthetic": True, "status": "passed",
            "results": {test: True for test in TESTS},
            "sha256": hashlib.sha256(image).hexdigest(), "dataBase64": encoded,
        })
    return {"source": "synthetic-health-qa", "commit": commit,
            "deployId": deploy_id, "runId": run_id, "results": results}


def main():
    root = Path("visual-results")
    att = json.loads(Path("/tmp/koa-production-attestation.json").read_text())
    payload = prepare(root, os.environ["GITHUB_SHA"], str(att.get("deployId") or ""),
                      os.environ["GITHUB_RUN_ID"])
    Path("/tmp/koa-accordion-evidence.json").write_text(json.dumps(payload, separators=(",", ":")))
    print("Validated four synthetic Chromium/WebKit iPhone and desktop accordion screenshots; attached to private attestation request.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Accordion release evidence blocked: " + str(error), file=sys.stderr)
        sys.exit(1)
