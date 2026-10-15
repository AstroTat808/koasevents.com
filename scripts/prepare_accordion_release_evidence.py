#!/usr/bin/env python3
"""Capture fixed-fixture accordion evidence separately from private live Health QA.

Never copy health-mobile images from the caller's live audit directory. A fresh
credential-free child run receives only the constant fixture below. Only eight
allowlisted image/metadata files may be staged for durable release evidence.
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
import subprocess
import sys
import tempfile
from urllib.parse import urlparse

CASES = (("chromium", "phone", 390, 844), ("chromium", "desktop", 1440, 900),
         ("webkit", "phone", 390, 844), ("webkit", "desktop", 1440, 900))
TESTS = ("initialClosed", "criticalInitiallyOpen", "manuallyOpened",
         "manuallyClosed", "criticalForcedOpen", "recoveredCollapsed")
CAPTURE_SOURCE = "fixed-synthetic-fixture-v1"
# No input parameter, live response, account record, or environment value may
# contribute to this dashboard. This fixture is intentionally not production.
FIXTURE = {"current": {"overall": "healthy", "passed": 0, "failed": 0,
                       "checkedAt": "2026-01-01T00:00:00Z", "checks": []},
           "coverage": {}, "criticalIntegrations": {}, "rollbackReady": {},
           "runtime": {}, "deployments": {}, "office365": {}, "emailHealth": {},
           "credentialHealth": {}, "weeklyExecutiveSummary": {},
           "accountingHealth": {}, "visualQuality": {}, "enrichmentWarnings": []}
FIXTURE_BYTES = json.dumps(FIXTURE, sort_keys=True, separators=(",", ":")).encode("utf-8")
FIXTURE_DIGEST = hashlib.sha256(FIXTURE_BYTES).hexdigest()
METADATA_FIELDS = {"key", "browser", "viewport", "width", "height", "route",
                   "synthetic", "status", "results", "sha256", "captureSource",
                   "fixtureSha256", "commit", "runId"}


def valid_jpeg(image: bytes) -> bool:
    return 1100 <= len(image) <= 260000 and image.startswith(b"\xff\xd8\xff")


def identity(commit: str, run_id: str) -> None:
    if not re.fullmatch(r"[a-f0-9]{40}", commit) or not re.fullmatch(r"[0-9]{1,30}", run_id):
        raise ValueError("Exact capture SHA and numeric workflow run ID are required")


def read_regular(path: Path, limit: int) -> bytes:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        raise ValueError("Evidence file missing, nonregular, or oversized")
    return path.read_bytes()


def _capture(scratch: Path, commit: str, run_id: str) -> Path:
    fixture = scratch / "fixed-dashboard.json"
    fixture.write_bytes(FIXTURE_BYTES)
    output = scratch / "browser-output"
    base = os.environ.get("PRODUCTION_BASE_URL", "https://koasevents.com").rstrip("/")
    url = urlparse(base)
    local = url.hostname in {"localhost", "127.0.0.1"} and url.scheme == "http"
    production = base == "https://koasevents.com"
    if not (production or local) or url.username or url.password or url.query or url.fragment or url.path:
        raise ValueError("Unapproved synthetic capture origin")
    # Do not forward OIDC tokens, GitHub/Netlify secrets, cookies, or live payload paths.
    allowed = ("PATH", "HOME", "LANG", "LC_ALL", "TZ", "LD_LIBRARY_PATH", "PLAYWRIGHT_BROWSERS_PATH")
    env = {key: os.environ[key] for key in allowed if key in os.environ}
    env.update(PRODUCTION_BASE_URL=base, EXPECTED_COMMIT=commit,
               GITHUB_SHA=commit, GITHUB_RUN_ID=run_id, VISUAL_RESULTS=str(output))
    script = Path(__file__).resolve().with_name("production_visual_qa.py")
    for browser in ("chromium", "webkit"):
        try:
            result = subprocess.run(
                [sys.executable, str(script), "--mode", "health-mobile", "--browser", browser,
                 "--base-url", base, "--health-payload", str(fixture)],
                env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=600, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            raise RuntimeError("Isolated synthetic browser capture could not complete") from None
        if result.returncode:
            raise RuntimeError("Isolated synthetic browser assertions failed")
    return output


def collect(root: Path) -> None:
    commit, run_id = os.environ.get("GITHUB_SHA", ""), os.environ.get("GITHUB_RUN_ID", "")
    identity(commit, run_id)
    root.mkdir(parents=True, exist_ok=True)
    if root.is_symlink():
        raise ValueError("Evidence root may not be a symlink")
    staged = root / "accordion-synthetic"
    if staged.is_symlink():
        raise ValueError("Evidence staging directory may not be a symlink")
    if staged.exists():
        shutil.rmtree(staged)  # Failed runs must never leave stale success evidence.
    with tempfile.TemporaryDirectory(prefix="koa-fixed-accordion-") as directory:
        scratch = Path(directory)
        browser_output = _capture(scratch, commit, run_id)
        clean = scratch / "allowlisted"
        clean.mkdir()
        for browser, viewport, width, height in CASES:
            key = browser + "-" + viewport
            folder = browser_output / ("health-mobile-" + browser)
            report = json.loads(read_regular(folder / "report.json", 2000000))
            if (report.get("mode") != "health-mobile" or report.get("browser") != browser
                    or report.get("failures") != []):
                raise ValueError("Fresh synthetic report missing or failed")
            rows = [row for row in report.get("results", []) if row.get("viewport") == viewport]
            if (len(rows) != 1 or rows[0].get("width") != width or rows[0].get("height") != height
                    or rows[0].get("failure")):
                raise ValueError("Fresh synthetic viewport missing or failed")
            checks = (rows[0].get("metrics") or {}).get("sectionCollapse") or {}
            if int(checks.get("sections") or 0) < 1 or any(checks.get(test) is not True for test in TESTS):
                raise ValueError("Six required synthetic accordion assertions did not pass")
            image = read_regular(folder / ("accordion-" + viewport + ".jpg"), 260000)
            if not valid_jpeg(image):
                raise ValueError("Fresh synthetic JPEG invalid")
            row = {"key": key, "browser": browser, "viewport": viewport,
                   "width": width, "height": height, "route": "/admin/health/",
                   "synthetic": True, "status": "passed", "results": {test: True for test in TESTS},
                   "sha256": hashlib.sha256(image).hexdigest(), "captureSource": CAPTURE_SOURCE,
                   "fixtureSha256": FIXTURE_DIGEST, "commit": commit, "runId": run_id}
            (clean / (key + ".jpg")).write_bytes(image)
            (clean / (key + ".json")).write_text(json.dumps(row, separators=(",", ":")))
        try:
            shutil.copytree(clean, staged)
        except Exception:
            if staged.exists() and not staged.is_symlink():
                shutil.rmtree(staged)
            raise
    print("Collected fixed-fixture screenshots only; no raw health snapshot staged.")


def package(root: Path, commit: str, deploy_id: str, run_id: str) -> dict:
    identity(commit, run_id)
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,120}", deploy_id):
        raise ValueError("Exact deploy ID is invalid")
    staged = root / "accordion-synthetic"
    if staged.is_symlink() or not staged.is_dir():
        raise ValueError("Synthetic staging is missing or unsafe")
    expected = {browser + "-" + viewport + ext for browser, viewport, _, _ in CASES
                for ext in (".json", ".jpg")}
    staged_names = {path.name for path in staged.iterdir()}
    if staged_names != expected:
        raise ValueError("Only the eight fixed synthetic evidence files are allowed")
    results = []
    for browser, viewport, width, height in CASES:
        key = browser + "-" + viewport
        row = json.loads(read_regular(staged / (key + ".json"), 5000))
        if (not isinstance(row, dict) or set(row) != METADATA_FIELDS
                or row.get("key") != key or row.get("browser") != browser
                or row.get("viewport") != viewport or row.get("width") != width or row.get("height") != height
                or row.get("route") != "/admin/health/" or row.get("synthetic") is not True
                or row.get("status") != "passed" or row.get("captureSource") != CAPTURE_SOURCE
                or row.get("fixtureSha256") != FIXTURE_DIGEST or row.get("commit") != commit
                or row.get("runId") != run_id or set(row.get("results") or {}) != set(TESTS)
                or any(row["results"].get(test) is not True for test in TESTS)):
            raise ValueError("Synthetic evidence identity, schema, or provenance mismatch")
        image = read_regular(staged / (key + ".jpg"), 260000)
        if not valid_jpeg(image) or hashlib.sha256(image).hexdigest() != row.get("sha256"):
            raise ValueError("Synthetic JPEG checksum mismatch")
        results.append({name: row[name] for name in sorted(METADATA_FIELDS)})
        results[-1]["dataBase64"] = base64.b64encode(image).decode("ascii")
    return {"source": "synthetic-health-qa", "commit": commit, "deployId": deploy_id,
            "runId": run_id, "results": results}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--collect", action="store_true")
    args = parser.parse_args()
    root = Path("visual-results")
    if args.collect:
        collect(root)
    else:
        deploy = json.loads(Path("/tmp/koa-production-attestation.json").read_text())
        payload = package(root, os.environ["GITHUB_SHA"], str(deploy.get("deployId") or ""),
                          os.environ["GITHUB_RUN_ID"])
        Path("/tmp/koa-accordion-evidence.json").write_text(json.dumps(payload, separators=(",", ":")))
        print("Validated four isolated synthetic attachments for exact SHA/deploy.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never print exception values from input files or child processes.
        print("Synthetic accordion evidence blocked; no capture content logged.", file=sys.stderr)
        sys.exit(1)
