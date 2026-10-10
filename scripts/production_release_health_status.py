#!/usr/bin/env python3
"""Fail-closed, PII-free production System Health release attestation."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path

WIDTHS = {320, 390, 768, 1024, 1280, 1440, 1920}

def assess(dashboard, chromium, webkit, expected_sha, smoke_result, theme_result):
    reasons = []
    current = dashboard.get("current") or {}
    expected_sha = str(expected_sha or "").lower()
    sha = str(dashboard.get("sha") or "").lower()
    deploy_id = str(dashboard.get("deployId") or "").strip()
    published_deploy_id = str(dashboard.get("publishedDeployId") or "").strip()
    warnings = dashboard.get("enrichmentWarnings")
    checked_at = str(current.get("checkedAt") or "").strip()

    if smoke_result != "success":
        reasons.append("deploy route and asset smoke did not pass")
    if theme_result != "success":
        reasons.append("live Chromium/WebKit theme QA did not pass")
    if dashboard.get("ok") is not True or dashboard.get("source") != "github-actions-oidc":
        reasons.append("signed dashboard refresh missing or unsuccessful")
    if len(expected_sha) != 40 or sha != expected_sha:
        reasons.append("signed dashboard SHA does not match exact workflow head")
    if not deploy_id or not published_deploy_id or deploy_id != published_deploy_id or dashboard.get("publicationMatchesPublished") is not True:
        reasons.append("published Netlify deploy ID does not match signed dashboard deploy")
    if current.get("overall") != "healthy" or type(current.get("failed")) is not int or current.get("failed") != 0 or type(current.get("passed")) is not int or current.get("passed") < 1:
        reasons.append("System Health is not healthy with zero failures")
    if not isinstance(warnings, list) or warnings:
        reasons.append("System Health dashboard refresh warnings present or unverified")
    try:
        stamp = datetime.fromisoformat(checked_at.replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - stamp.astimezone(timezone.utc)).total_seconds()
        if age < -120 or age > 20*60:
            reasons.append("System Health checkedAt is stale or in the future")
    except (ValueError, TypeError, OverflowError):
        reasons.append("System Health checkedAt is missing or invalid")

    viewport_results = {}
    for browser, report in (("chromium", chromium), ("webkit", webkit)):
        rows = report.get("results") or []
        widths = [row.get("width") for row in rows if isinstance(row, dict)]
        viewport_results[browser] = {"count": len(rows), "widths": widths, "failures": len(report.get("failures") or [])}
        if report.get("browser") != browser or len(rows) != 7 or set(widths) != WIDTHS or len(set(widths)) != 7 or report.get("failures"):
            reasons.append(browser + " responsive coverage missing, incomplete, or failed")
            continue
        if report.get("checkedAt") != checked_at or report.get("overall") != current.get("overall"):
            reasons.append(browser + " responsive evidence does not match signed System Health refresh")
        for row in rows:
            after = (row.get("metrics") or {}).get("afterRunChecksNow") or {}
            if (row.get("failure") or row.get("pageErrors") or
                after.get("passed") != str(current.get("passed")) or
                after.get("failed") != str(current.get("failed")) or
                not after.get("checked") or after.get("dashboardRefresh") != "Current"):
                reasons.append(browser + " viewport refresh/visual metrics failed")
                break

    result = {
        "ok": not reasons, "reasons": reasons,
        "sha": sha, "deployId": deploy_id, "publishedDeployId": published_deploy_id,
        "checkedAt": checked_at, "overall": current.get("overall"),
        "passed": current.get("passed"), "failed": current.get("failed"),
        "viewportResults": viewport_results,
    }
    status = {
        "state": "success" if result["ok"] else "failure",
        "context": "System Health production release gate",
        "description": (
            f"{str(current.get('overall') or 'unknown').title()} · "
            f"{current.get('passed', '?')} passed · {current.get('failed', '?')} failed · "
            + ("Exact SHA/deploy/QA verified" if result["ok"] else "Release blocked: " + (reasons[0] if reasons else "unknown"))
        )[:140]
    }
    return result, status

def self_test():
    now = datetime.now(timezone.utc).isoformat()
    sha = "a" * 40
    signed = {"ok": True, "source": "github-actions-oidc", "sha": sha,
              "deployId": "deploy-1", "publishedDeployId": "deploy-1",
              "publicationMatchesPublished": True,
              "current": {"overall": "healthy", "passed": 81, "failed": 0, "checkedAt": now},
              "enrichmentWarnings": []}
    def report(browser):
        return {"browser": browser, "checkedAt": now, "overall": "healthy", "failures": [],
                "results": [
                    {"width": width, "failure": "", "pageErrors": [], "metrics": {
                        "afterRunChecksNow": {"passed": "81", "failed": "0", "checked": "now", "dashboardRefresh": "Current"}}}
                    for width in sorted(WIDTHS)]}
    import copy
    chromium, webkit = report("chromium"), report("webkit")
    def run(d=signed, c=chromium, w=webkit, smoke="success", theme="success"):
        return assess(d, c, w, sha, smoke, theme)
    assert run()[0]["ok"] is True
    bad_deploy = copy.deepcopy(signed)
    bad_deploy["publicationMatchesPublished"] = False
    assert run(d=bad_deploy)[0]["ok"] is False  # errored or unverified published deploy
    assert run(theme="cancelled")[0]["ok"] is False  # cancelled visual QA
    bad_health = copy.deepcopy(signed)
    bad_health["current"]["overall"] = "unhealthy"
    bad_health["current"]["failed"] = 2
    assert run(d=bad_health)[0]["ok"] is False  # unhealthy System Health
    mismatch = copy.deepcopy(signed)
    mismatch["publishedDeployId"] = "other-deploy"
    assert run(d=mismatch)[0]["ok"] is False  # Netlify published deploy ID drift
    stale_sha = copy.deepcopy(signed)
    stale_sha["sha"] = "b" * 40
    assert run(d=stale_sha)[0]["ok"] is False
    failed_webkit = copy.deepcopy(webkit)
    failed_webkit["failures"] = [{"viewport": "phone"}]
    assert run(w=failed_webkit)[0]["ok"] is False
    print("PASS | verified healthy case; rejected errored deploy, cancelled theme QA, unhealthy snapshot, mismatched published ID, stale SHA, and WebKit failure")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--dashboard", default="visual-results/system-health-dashboard.json")
    parser.add_argument("--chromium", default="visual-results/health-mobile-chromium/report.json")
    parser.add_argument("--webkit", default="visual-results/health-mobile-webkit/report.json")
    parser.add_argument("--expected-sha", default=os.getenv("GITHUB_SHA", ""))
    parser.add_argument("--smoke-result", default=os.getenv("DEPLOY_SMOKE_RESULT", ""))
    parser.add_argument("--theme-result", default=os.getenv("THEME_AUDIT_RESULT", ""))
    parser.add_argument("--output", default="/tmp/system-health-commit-status.json")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    def load(path):
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}
    result, status = assess(load(args.dashboard), load(args.chromium), load(args.webkit),
                            args.expected_sha, args.smoke_result, args.theme_result)
    Path(args.output).write_text(json.dumps(status, separators=(",", ":")), encoding="utf-8")
    # Metadata-only attestation: never print raw health payloads or client details.
    print(json.dumps(result, separators=(",", ":")))

if __name__ == "__main__":
    main()
