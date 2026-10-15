#!/usr/bin/env python3
"""Print only fixed, privacy-safe codes from the local protected-admin QA report.

Never print the raw report, response body, screenshots, JavaScript messages,
headers, URLs with query strings, or an unrecognized failing route.
"""
from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path

SOURCE = Path(__file__).with_name("production_visual_qa.py")
DEFAULT_REPORT = Path("visual-results/admin-chromium/report.json")

def allowed_routes() -> dict[str, str]:
    """Derive exact static route labels from source, not from untrusted reports."""
    source = ast.parse(SOURCE.read_text(encoding="utf-8"))
    allowed = {}
    for statement in source.body:
        if not isinstance(statement, ast.Assign):
            continue
        if not any(
            isinstance(target, ast.Name)
            and target.id in {"ADMIN_ROUTES", "PROTECTED_ADMIN_APIS", "HYBRID_PUBLIC_READ_APIS", "ROUTES"}
            for target in statement.targets
        ):
            continue
        try:
            rows = ast.literal_eval(statement.value)
        except (ValueError, TypeError):
            continue
        for row in rows:
            if isinstance(row, (tuple, list)) and len(row) >= 2:
                label, route = row[:2]
                if isinstance(label, str) and isinstance(route, str) and label.replace("-", "").isalnum():
                    allowed[route] = label
    return allowed

def fixed_category(detail: object) -> str:
    # The message is used for classification only; NEVER copy it to output.
    if not isinstance(detail, str):
        return "ADMIN_QA_ASSERTION_FAILED"
    lower = detail.lower()
    if "protected admin api expected 401/403" in lower or "mutation expected 401/403" in lower:
        return "ADMIN_QA_AUTHORIZATION_GUARD_FAILED"
    if "hybrid public-read api expected" in lower:
        return "ADMIN_QA_PUBLIC_READ_FAILED"
    if "document returned http" in lower:
        return "ADMIN_QA_DOCUMENT_HTTP_FAILED"
    if "javascript page errors" in lower or "javascript errors" in lower:
        return "ADMIN_QA_CLIENT_EXCEPTION"
    if "timeout" in lower or "timed out" in lower or "page.wait_for" in lower:
        return "ADMIN_QA_TIMEOUT"
    if "no visible admin ui" in lower or "initialized state" in lower or "startup regression" in lower:
        return "ADMIN_QA_STARTUP_STATE_FAILED"
    if "trusted-browser" in lower or "trusted-device" in lower:
        return "ADMIN_QA_TRUSTED_SESSION_UI_FAILED"
    if "gallery" in lower:
        return "ADMIN_QA_GALLERY_UI_FAILED"
    if "homepage placement crop" in lower:
        return "ADMIN_QA_HOMEPAGE_CROP_FAILED"
    return "ADMIN_QA_ASSERTION_FAILED"

def summarize(report: object) -> dict:
    if not isinstance(report, dict) or not isinstance(report.get("failures"), list):
        return {"ok": False, "code": "ADMIN_QA_REPORT_MALFORMED", "failures": []}
    safe = allowed_routes()
    failures = []
    for entry in report["failures"][:150]:
        if not isinstance(entry, dict):
            failures.append({"route": "unknown", "code": "ADMIN_QA_ASSERTION_FAILED"})
            continue
        # For multiple named browser scenarios on one static route, only the
        # predefined route's public label is exported; no raw identifiers.
        route = entry.get("route")
        label = safe.get(route) if isinstance(route, str) else None
        failures.append({
            "route": label or "unknown",
            "code": fixed_category(entry.get("detail")),
        })
    return {
        "ok": not bool(report["failures"]),
        "totalFailures": len(report["failures"]),
        "failures": failures,
    }

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--qa-exit", type=int, default=0)
    parser.add_argument("--safe-output", type=Path)
    args = parser.parse_args()
    try:
        result = summarize(json.loads(args.report.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        result = {"ok": False, "code": "ADMIN_QA_REPORT_MISSING", "failures": []}
    # Only the JSON produced from hard-coded allowlists is ever printed.
    if args.qa_exit != 0 and result.get("ok") is True:
        result = {"ok": False, "code": "ADMIN_QA_UNEXPECTED_PROCESS_FAILURE", "failures": []}
    serialized=json.dumps(result, sort_keys=True, separators=(",", ":"))
    if args.safe_output:
        # The output never contains raw URLs, response bodies or browser diagnostics.
        # Only use the designated temporary location, never a retained artifact.
        output=args.safe_output.resolve()
        if output.parent != Path("/tmp"):
            raise SystemExit("ADMIN_QA_UNSAFE_OUTPUT_PATH")
        output.write_text(serialized+"\n",encoding="utf-8")
    print("[koa protected admin QA] " + serialized)
    return 0 if result.get("ok") and args.qa_exit == 0 else 1

if __name__ == "__main__":
    raise SystemExit(main())
