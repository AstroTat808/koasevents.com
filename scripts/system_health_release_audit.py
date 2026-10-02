#!/usr/bin/env python3
import argparse
import json
import math
import os
from pathlib import Path

VIEWPORTS = [
    ("phone-small", 320, 568),
    ("phone", 390, 844),
    ("tablet", 768, 1024),
    ("tablet-wide", 1024, 768),
    ("desktop-small", 1280, 800),
    ("desktop", 1440, 900),
    ("desktop-wide", 1920, 1080),
]
BROWSERS = ("chromium", "webkit")


def load_json(path):
    target = Path(path)
    if not target.is_file():
        return {}
    try:
        value = json.loads(target.read_text())
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def finite_number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    if number.is_integer():
        return int(number)
    return number


def compact_failure(*parts):
    return "; ".join(str(part).strip() for part in parts if str(part or "").strip())[:1200]


def normalized_row(browser, viewport_name, width, height, report, current, expected_refresh):
    results = report.get("results") if isinstance(report.get("results"), list) else []
    source = next(
        (row for row in results if str(row.get("viewport") or "") == viewport_name),
        None,
    )
    metrics = source.get("metrics") if isinstance(source, dict) and isinstance(source.get("metrics"), dict) else {}
    after = metrics.get("afterRunChecksNow") if isinstance(metrics.get("afterRunChecksNow"), dict) else {}

    viewport_width = finite_number(metrics.get("viewportWidth"))
    if viewport_width is None:
        viewport_width = width
    document_scroll_width = finite_number(metrics.get("documentScrollWidth"))
    summary_grid_left = finite_number(metrics.get("summaryGridLeft"))
    summary_grid_right = finite_number(metrics.get("summaryGridRight"))
    document_scroll_height = finite_number(metrics.get("documentScrollHeight"))

    horizontal_overflow = (
        max(0, document_scroll_width - viewport_width)
        if document_scroll_width is not None and viewport_width is not None
        else None
    )
    summary_left_overflow = max(0, -summary_grid_left) if summary_grid_left is not None else None
    summary_right_overflow = (
        max(0, summary_grid_right - viewport_width)
        if summary_grid_right is not None and viewport_width is not None
        else None
    )

    source_failure = str(source.get("failure") or "").strip() if isinstance(source, dict) else ""
    geometry_ok = bool(
        source
        and document_scroll_width is not None
        and horizontal_overflow is not None
        and horizontal_overflow <= 1
        and (summary_left_overflow is None or summary_left_overflow <= 1)
        and (summary_right_overflow is None or summary_right_overflow <= 1)
    )
    hydration_ok = bool(
        source
        and after.get("passed") == str(current.get("passed"))
        and after.get("failed") == str(current.get("failed"))
        and bool(after.get("checked"))
        and after.get("dashboardRefresh") == expected_refresh
    )
    ok = bool(source and not source_failure and geometry_ok and hydration_ok)

    derived_failure = ""
    if not source:
        derived_failure = "QA result was not recorded."
    elif source_failure:
        derived_failure = source_failure
    elif not geometry_ok:
        derived_failure = "Responsive overflow geometry did not pass."
    elif not hydration_ok:
        derived_failure = "Run checks now did not preserve the live dashboard summary."

    return {
        "browser": browser,
        "viewport": viewport_name,
        "width": width,
        "height": height,
        "ok": ok,
        "documentScrollWidth": document_scroll_width,
        "viewportWidth": viewport_width,
        "horizontalOverflowPx": horizontal_overflow,
        "summaryGridLeft": summary_grid_left,
        "summaryGridRight": summary_grid_right,
        "summaryLeftOverflowPx": summary_left_overflow,
        "summaryRightOverflowPx": summary_right_overflow,
        "documentScrollHeight": document_scroll_height,
        "screenshotMode": str(metrics.get("fullScreenshotMode") or "unavailable"),
        "dashboardRefresh": str(after.get("dashboardRefresh") or metrics.get("dashboardRefresh") or ""),
        "failure": compact_failure(derived_failure),
    }


def prepare(args):
    dashboard = load_json(args.dashboard)
    current = dashboard.get("current") if isinstance(dashboard.get("current"), dict) else {}
    warnings = dashboard.get("enrichmentWarnings") if isinstance(dashboard.get("enrichmentWarnings"), list) else []
    expected_refresh = "Partial" if warnings else "Current"

    reports = {
        "chromium": load_json(args.chromium),
        "webkit": load_json(args.webkit),
    }
    rows = []
    for browser in BROWSERS:
        for viewport_name, width, height in VIEWPORTS:
            rows.append(
                normalized_row(
                    browser,
                    viewport_name,
                    width,
                    height,
                    reports[browser],
                    current,
                    expected_refresh,
                )
            )

    passed_count = sum(1 for row in rows if row["ok"])
    verification = {
        "checkedAt": str(current.get("checkedAt") or ""),
        "status": "passed" if passed_count == len(rows) else "failed",
        "totalCount": len(rows),
        "passedCount": passed_count,
        "failedCount": len(rows) - passed_count,
        "dashboardOverall": str(current.get("overall") or ""),
        "dashboardPassed": current.get("passed") if isinstance(current.get("passed"), int) else None,
        "dashboardFailed": current.get("failed") if isinstance(current.get("failed"), int) else None,
        "dashboardRefresh": expected_refresh,
        "rows": rows,
    }

    dashboard_valid = bool(
        dashboard.get("ok") is True
        and current.get("checkedAt")
        and isinstance(current.get("passed"), int)
        and isinstance(current.get("failed"), int)
        and current.get("overall") in {"healthy", "unhealthy"}
    )
    ok = dashboard_valid and verification["status"] == "passed" and len(rows) == 14

    overall = str(current.get("overall") or "unknown").title()
    passed = current.get("passed", "?")
    failed = current.get("failed", "?")
    description = (
        f"{overall} · {passed} passed · {failed} failed · "
        f"Refresh {expected_refresh} · {passed_count}/14 responsive"
    )[:140]

    run_id = str(os.environ.get("GITHUB_RUN_ID") or "")
    repository = str(os.environ.get("GITHUB_REPOSITORY") or "AstroTat808/koasevents.com")
    target_url = f"https://github.com/{repository}/actions/runs/{run_id}" if run_id else ""
    commit_status = {
        "state": "success" if ok else "failure",
        "context": "System Health production release gate",
        "description": description,
        "target_url": target_url,
    }

    record_payload = {
        "action": "record-responsive-release-verification",
        "deployId": str(dashboard.get("deployId") or ""),
        "verification": verification,
    }
    audit = {
        "ok": ok,
        "commit": str(os.environ.get("GITHUB_SHA") or ""),
        "deployId": str(dashboard.get("deployId") or ""),
        "workflowRunId": run_id,
        "workflowUrl": target_url,
        "dashboardValid": dashboard_valid,
        "enrichmentWarnings": warnings,
        "verification": verification,
    }

    Path(args.audit_output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.audit_output).write_text(json.dumps(audit, separators=(",", ":")))
    Path(args.status_output).write_text(json.dumps(commit_status, separators=(",", ":")))
    Path(args.record_output).write_text(json.dumps(record_payload, separators=(",", ":")))

    print(
        json.dumps(
            {
                "ok": ok,
                "overall": current.get("overall"),
                "passed": current.get("passed"),
                "failed": current.get("failed"),
                "checkedAt": current.get("checkedAt"),
                "dashboardRefresh": expected_refresh,
                "responsivePassed": passed_count,
                "responsiveFailed": len(rows) - passed_count,
                "chromiumViewports": 7,
                "webkitViewports": 7,
                "viewportResults": rows,
            },
            separators=(",", ":"),
        )
    )


def enforce(args):
    audit = load_json(args.audit_output)
    verification = audit.get("verification") if isinstance(audit.get("verification"), dict) else {}
    rows = verification.get("rows") if isinstance(verification.get("rows"), list) else []
    if (
        audit.get("ok") is not True
        or verification.get("status") != "passed"
        or verification.get("totalCount") != 14
        or verification.get("passedCount") != 14
        or len(rows) != 14
        or any(row.get("ok") is not True for row in rows)
    ):
        failed = [
            f"{row.get('browser')}:{row.get('viewport')}={row.get('failure') or 'failed'}"
            for row in rows
            if row.get("ok") is not True
        ]
        raise SystemExit(
            "System Health responsive production release gate failed"
            + (": " + " | ".join(failed) if failed else ".")
        )
    print("System Health responsive production release gate passed: 14/14 viewport results.")


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    prepare_parser = sub.add_parser("prepare")
    prepare_parser.add_argument("--dashboard", required=True)
    prepare_parser.add_argument("--chromium", required=True)
    prepare_parser.add_argument("--webkit", required=True)
    prepare_parser.add_argument("--audit-output", required=True)
    prepare_parser.add_argument("--status-output", required=True)
    prepare_parser.add_argument("--record-output", required=True)

    enforce_parser = sub.add_parser("enforce")
    enforce_parser.add_argument("--audit-output", required=True)

    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args)
    else:
        enforce(args)


if __name__ == "__main__":
    main()
