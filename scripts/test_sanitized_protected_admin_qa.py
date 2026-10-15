#!/usr/bin/env python3
"""Privacy-safe QA diagnostics never print or forward underlying error content."""
import importlib.util
import json
from pathlib import Path
from contextlib import redirect_stdout
from io import StringIO

module_path = Path(__file__).with_name("sanitize_protected_admin_qa.py")
spec = importlib.util.spec_from_file_location("koa_safe_admin_qa", module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

routes = module.allowed_routes()
assert routes.get("/admin/health/") == "admin-health"
assert routes.get("/api/admin/health") == "system-health-api"

private = "PRIVATE_CLIENT_MARKER_EMAIL_001"
input_report = {
    "mode": "admin",
    "failures": [
        {"route": "/admin/health/", "detail": "JavaScript page errors: " + private,
         "pageErrors": [private], "consoleErrors": [private]},
        {"route": "/api/admin/health", "detail": "Protected admin API expected 401/403, got HTTP 200",
         "privateBody": private},
        {"route": "/private/" + private, "detail": "Timeout " + private},
    ],
    "routes": [{"path": "/admin/health/", "bodyText": private, "email": private}],
}
safe = module.summarize(input_report)
assert safe["ok"] is False
assert safe["totalFailures"] == 3
assert safe["failures"] == [
    {"route": "admin-health", "code": "ADMIN_QA_CLIENT_EXCEPTION"},
    {"route": "system-health-api", "code": "ADMIN_QA_AUTHORIZATION_GUARD_FAILED"},
    {"route": "unknown", "code": "ADMIN_QA_TIMEOUT"},
]
out = json.dumps(safe)
assert private not in out and "bodyText" not in out and "/private/" not in out
assert module.fixed_category("Page.wait_for_selector: Timeout 8000ms") == "ADMIN_QA_TIMEOUT"
assert module.summarize({"failures": []})["ok"] is True
assert module.summarize({"bad": 1})["code"] == "ADMIN_QA_REPORT_MALFORMED"
print("PASS | Admin browser failure diagnostics are static-route-only, redacted and deterministic.")
