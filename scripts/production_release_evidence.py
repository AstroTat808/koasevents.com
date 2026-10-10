#!/usr/bin/env python3
"""Produce a PII-free production release evidence artifact from a signed refresh.
The authenticated response is read locally but never copied into public CI artifacts.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path


def read_json(path: str) -> tuple[dict, bytes]:
    try:
        raw = Path(path).read_bytes()
        parsed = json.loads(raw)
        return (parsed if isinstance(parsed, dict) else {}), raw
    except (OSError, ValueError, UnicodeDecodeError):
        return {}, b""


def sanitize(dashboard: dict, reports: dict[str, dict], digest: str = "") -> dict:
    current = dashboard.get("current")
    current = current if isinstance(current, dict) else {}
    warning_list = dashboard.get("enrichmentWarnings")
    result = {
        "evidenceSchema": 1,
        "requestAuthenticated": dashboard.get("source") == "github-actions-oidc" and dashboard.get("ok") is True,
        "sha": str(dashboard.get("sha") or "")[:40],
        "deployId": str(dashboard.get("deployId") or "")[:120],
        "signedResponseSha256": digest,
        "checkedAt": str(current.get("checkedAt") or "")[:80],
        "overall": str(current.get("overall") or "unknown")[:16],
        "passed": current.get("passed") if type(current.get("passed")) is int else None,
        "failed": current.get("failed") if type(current.get("failed")) is int else None,
        "enrichmentWarningCount": len(warning_list) if isinstance(warning_list, list) else None,
        "responsiveBrowsers": {},
    }
    for name in ("chromium", "webkit"):
        source = reports.get(name)
        source = source if isinstance(source, dict) else {}
        results = source.get("results")
        results = results if isinstance(results, list) else []
        widths = sorted({int(row["width"]) for row in results if isinstance(row, dict)
                         and type(row.get("width")) is int and row["width"] in (320,390,768,1024,1280,1440,1920)})
        failures = source.get("failures")
        result["responsiveBrowsers"][name] = {
            "viewportCount": len(results),
            "widths": widths,
            "failureCount": len(failures) if isinstance(failures, list) else None,
        }
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dashboard", default="visual-results/system-health-dashboard.json")
    parser.add_argument("--chromium", default="visual-results/health-mobile-chromium/report.json")
    parser.add_argument("--webkit", default="visual-results/health-mobile-webkit/report.json")
    parser.add_argument("--output", default="visual-results/production-release-evidence.json")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        private = "qa-client-secret-do-not-publish"
        dashboard = {
            "ok": True, "source": "github-actions-oidc", "sha": "a"*40, "deployId": "depl",
            "current": {"checkedAt": "2026-10-10T00:00:00Z", "overall": "healthy", "passed": 81, "failed": 0,
                        "checks": [{"clientName": private, "email": private, "invoiceTotal": 1000.50}]},
            "enrichmentWarnings": [{"client": private}],
            "dashboard": {"customerEmails": [private]},
        }
        reports = {"chromium": {"results": [{"width": 390, "clientName": private}], "failures": []},
                   "webkit": {"results": [{"width": 390, "financial": 1000.50}], "failures": []}}
        sanitized = sanitize(dashboard, reports, "x"*64)
        output = json.dumps(sanitized)
        assert private not in output and "1000.50" not in output and "clientName" not in output
        assert sanitized["passed"] == 81 and sanitized["enrichmentWarningCount"] == 1
        assert sanitized["responsiveBrowsers"]["chromium"]["widths"] == [390]
        print("PASS | public release evidence excludes customer information and preserves SHA, deploy, health and browser counts.")
        return
    data, raw = read_json(args.dashboard)
    browser_reports = {browser: read_json(getattr(args, browser))[0]
                       for browser in ("chromium", "webkit")}
    digest = hashlib.sha256(raw).hexdigest() if raw else ""
    evidence = sanitize(data, browser_reports, digest)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(evidence, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    print(json.dumps(evidence, separators=(",", ":")))


if __name__ == "__main__":
    main()
