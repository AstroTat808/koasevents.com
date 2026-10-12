#!/usr/bin/env python3
"""One-time, fail-closed branch retirement from a verified GitHub Actions snapshot.

Destructive execution requires the certified production workflow_run, an exact
195-branch whitelist, fresh current-main branch hygiene, and per-ref Git leases.
No delete-by-name without comparing the expected 40-character tip is allowed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.parse

REPO = "AstroTat808/koasevents.com"
SNAPSHOT_RUN = 38237894943
SNAPSHOT_ARTIFACT = "branch-hygiene-38237894943-1"
SNAPSHOT_SHA256 = "6dbf4cbcd41b883d7302c9d5189c21681ddb713a722f2d117d304cf0ae856adf"
SNAPSHOT_MAIN = "1b2d17c14beb0b31687f7eb5dae55c831aa872b0"
PRODUCTION_RUN_261 = 38237525321
APPROVED_COUNT = 195
LEDGER_TITLE = "[Audit] Koa exact-SHA branch retirement — 2026-10-12 approved 195"
SHA = re.compile(r"^[0-9a-f]{40}$")
REQUIRED_STATUSES = ("System Health production release gate", "System Health responsive audit")


def run(args, *, input_text=None, check=True, timeout=180):
    p = subprocess.run(
        args, input=input_text, text=True, capture_output=True, timeout=timeout
    )
    if check and p.returncode:
        raise RuntimeError(f"Command {args[0]} failed ({p.returncode}): {p.stderr[:450]}")
    return p


def gh(path, method="GET", data=None):
    cmd = ["gh", "api", "-X", method, path]
    if data is not None:
        cmd += ["--input", "-"]
    raw = run(cmd, input_text=None if data is None else json.dumps(data), timeout=90).stdout
    return json.loads(raw) if raw.strip() else {}


def git(*args, check=True):
    return run(["git", *args], check=check, timeout=180)


def check_sha(sha):
    if not isinstance(sha, str) or not SHA.fullmatch(sha):
        raise RuntimeError("Invalid full-length branch SHA")
    return sha


def select_approved(snapshot):
    if snapshot.get("main_sha") != SNAPSHOT_MAIN:
        raise RuntimeError("Approved snapshot main does not match pinned baseline")
    approved = [
        row for row in snapshot.get("rows", [])
        if row.get("group") == "safe-to-delete"
        and row.get("flag_after_7_days") is True
    ]
    if len(approved) != APPROVED_COUNT:
        raise RuntimeError(f"Expected exactly {APPROVED_COUNT} approved refs; found {len(approved)}")
    names = set()
    for row in approved:
        name = row.get("branch", "")
        if not name or name in names or name == "main" or name.startswith(("ops/", "backup/", "archive/", "release/")):
            raise RuntimeError("Duplicate or prohibited cleanup branch in whitelist")
        names.add(name)
        check_sha(row.get("sha"))
        git("check-ref-format", "--branch", name)
        if not row.get("evidence", {}).get("contained") and not row.get("evidence", {}).get("patch_equivalent"):
            if not ("exact current tip" in str(row.get("reason", "")).lower()
                    and "merged by PR" in str(row.get("reason", ""))):
                raise RuntimeError("Approved deletion lacks code-preservation evidence")
    return sorted(approved, key=lambda row: row["branch"])


def gate_current_candidate(approved, live):
    if not isinstance(live, dict):
        return "branch missing from fresh classification"
    if live.get("sha") != approved["sha"]:
        return "branch tip changed since the pinned snapshot"
    if live.get("group") != "safe-to-delete" or live.get("flag_after_7_days") is not True:
        return "current preservation or seven-day gate not satisfied"
    if not (live.get("evidence") or {}).get("contained") and not (live.get("evidence") or {}).get("patch_equivalent"):
        if "merged by PR" not in str(live.get("reason", "")):
            return "current merged-PR evidence is missing"
    return ""


def verify_release_trigger():
    if os.environ.get("GITHUB_REPOSITORY") != REPO:
        raise RuntimeError("Unexpected repository")
    if os.environ.get("GITHUB_EVENT_NAME") != "workflow_run":
        raise RuntimeError("Deletion is only authorized by a successful production workflow_run")
    event_path = Path(os.environ.get("GITHUB_EVENT_PATH", ""))
    if not event_path.is_file():
        raise RuntimeError("Missing authenticated workflow_run event")
    event = json.loads(event_path.read_text())
    w = event.get("workflow_run") or {}
    event_sha = check_sha(w.get("head_sha"))
    if (w.get("name") != "Production visual QA"
        or w.get("event") != "push"
        or w.get("head_branch") != "main"
        or w.get("conclusion") != "success"
        or (w.get("head_repository") or {}).get("full_name") != REPO):
        raise RuntimeError("Trigger is not a successful trusted production main workflow")
    remote_main = (gh(f"/repos/{REPO}/commits/main") or {}).get("sha")
    if remote_main != event_sha or git("rev-parse", "HEAD").stdout.strip() != event_sha:
        raise RuntimeError("Main moved after production certification; do not delete")
    if git("merge-base", "--is-ancestor", SNAPSHOT_MAIN, "HEAD", check=False).returncode:
        raise RuntimeError("Approved main SHA is not an ancestor of the current release")
    prod261 = gh(f"/repos/{REPO}/actions/runs/{PRODUCTION_RUN_261}")
    if prod261.get("status") != "completed":
        raise RuntimeError("Original PR #261 production workflow is still unresolved")
    # The original #261 run failed in an indented Bash heredoc despite green
    # functional QA. Its immutable SHA cannot be retroactively patched. A later
    # fully certified production release must contain both the #268 repair and #266.
    for pr_number in (268, 266):
        pr = gh(f"/repos/{REPO}/pulls/{pr_number}")
        if pr.get("merged") is not True:
            raise RuntimeError(f"PR #{pr_number} must merge before retirement")
        merged_sha = check_sha(pr.get("merge_commit_sha"))
        if git("merge-base", "--is-ancestor", merged_sha, "HEAD", check=False).returncode:
            raise RuntimeError(f"PR #{pr_number} merge is missing from certified main")
    commit_status = gh(f"/repos/{REPO}/commits/{event_sha}/status")
    newest = {}
    for status in commit_status.get("statuses", []):
        newest.setdefault(status.get("context"), status.get("state"))
    if any(newest.get(name) != "success" for name in REQUIRED_STATUSES):
        raise RuntimeError("Current main lacks green production and responsive System Health statuses")
    return event_sha


def load_approved_report(folder):
    folder.mkdir(parents=True, exist_ok=True)
    run(
        ["gh", "run", "download", str(SNAPSHOT_RUN), "--repo", REPO,
         "--name", SNAPSHOT_ARTIFACT, "--dir", str(folder)],
        timeout=120,
    )
    target = folder / "report.json"
    raw = target.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SNAPSHOT_SHA256:
        raise RuntimeError("Approved GitHub Actions artifact digest mismatch")
    return json.loads(raw)


def fresh_classification(folder, expected_main):
    run(
        [sys.executable, "scripts/branch_hygiene.py", "--repo", REPO,
         "--out", str(folder)],
        timeout=900,
    )
    report = json.loads((folder / "report.json").read_text())
    if report.get("main_sha") != expected_main:
        raise RuntimeError("Main changed during fresh branch classification")
    return {row["branch"]: row for row in report.get("rows", [])}


def existing_issue():
    query = urllib.parse.quote(f'repo:{REPO} is:issue in:title "{LEDGER_TITLE}"')
    result = gh(f"/search/issues?q={query}&per_page=100")
    exact = [x for x in result.get("items", []) if x.get("title") == LEDGER_TITLE]
    if len(exact) > 1:
        raise RuntimeError("Duplicate permanent branch-deletion ledger issues")
    return exact[0] if exact else None


def issue_comment(number, body):
    gh(f"/repos/{REPO}/issues/{number}/comments", "POST", {"body": body})


def ensure_ledger(approved, release_sha):
    issue = existing_issue()
    if issue:
        if "RETIREMENT COMPLETED" in (issue.get("body") or ""):
            return issue["number"], True
        issue_comment(issue["number"], f"Resuming fail-closed cleanup on {release_sha}; tips and branch protections will be rechecked.")
        return issue["number"], False
    lines = [
        "<!-- koa-branch-retirement-20261012 -->",
        "# SHA-pinned Koa branch retirement",
        "",
        "Execution is authorized only after PR #261 and #266 production certifications are green.",
        f"Approved main baseline: `{SNAPSHOT_MAIN}`",
        f"Exact certified execution main: `{release_sha}`",
        f"Source audit run: https://github.com/{REPO}/actions/runs/{SNAPSHOT_RUN}",
        f"Verified source report SHA256: `{SNAPSHOT_SHA256}`",
        f"Frozen authorized branch count: **{APPROVED_COUNT}**",
        "",
        "## Immutable approved refs (each guarded by an explicit Git force-with-lease)",
        "",
    ]
    lines.extend(f"- `{row['branch']}` — `{row['sha']}`" for row in approved)
    lines.extend(["", "## Execution result", "", "IN PROGRESS — see chronological issue comments for batch outcomes."])
    issue = gh(f"/repos/{REPO}/issues", "POST", {"title": LEDGER_TITLE, "body": "\n".join(lines)})
    return issue["number"], False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true", help="Only in certified production workflow_run")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        sample = {"sha": "a"*40, "group": "safe-to-delete", "flag_after_7_days": True,
                  "evidence": {"contained": True}}
        assert not gate_current_candidate(sample, dict(sample))
        assert gate_current_candidate(sample, {**sample, "sha": "b"*40})
        assert gate_current_candidate(sample, {**sample, "flag_after_7_days": False})
        assert gate_current_candidate(sample, {**sample, "group": "keep"})
        print("Exact-SHA, seven-day, and preservation-gate unit tests passed")
        return

    if not args.execute:
        raise RuntimeError("This workflow is fail-closed; explicitly pass --execute from the certified production job")
    release_sha = verify_release_trigger()
    folder = Path("/tmp/koa-branch-retirement")
    approved = select_approved(load_approved_report(folder / "approved"))
    current = fresh_classification(folder / "fresh", release_sha)
    ledger_num, completed = ensure_ledger(approved, release_sha)
    if completed:
        print(f"Previously completed ledger #{ledger_num}; no branch deletion performed.")
        return

    outcomes = []
    for index, row in enumerate(approved, 1):
        if (index - 1) % 15 == 0:
            planned = approved[index - 1:index + 14]
            intent = "\n".join(
                f"- `{candidate['branch']}` at `{candidate['sha']}`"
                for candidate in planned
            )
            issue_comment(
                ledger_num,
                f"## Pre-deletion intent (batch {index}–{index + len(planned) - 1})\n\n"
                "Only refs that still satisfy every current gate and exact Git lease may be deleted.\n\n"
                + intent,
            )
        branch, expected = row["branch"], check_sha(row["sha"])
        result = {"branch": branch, "expected_sha": expected, "outcome": "", "detail": ""}
        reason = gate_current_candidate(row, current.get(branch))
        if reason:
            result.update(outcome="SKIPPED", detail=reason)
        else:
            # Check main and open-PR dependencies again immediately before each irreversible change.
            main_tip = gh(f"/repos/{REPO}/commits/main").get("sha")
            if main_tip != release_sha:
                raise RuntimeError("Main changed during cleanup; stopping immediately")
            open_prs = gh(f"/repos/{REPO}/pulls?state=open&per_page=100")
            if any(p.get("head", {}).get("ref") == branch or p.get("base", {}).get("ref") == branch for p in open_prs):
                result.update(outcome="SKIPPED", detail="Active pull request dependency")
            else:
                info = gh(f"/repos/{REPO}/branches/{urllib.parse.quote(branch, safe='')}")
                sha = (info.get("commit") or {}).get("sha")
                if info.get("protected") is True or sha != expected:
                    result.update(outcome="SKIPPED", detail="Ref protected or exact SHA changed")
                else:
                    ref = "refs/heads/" + branch
                    remote = git("ls-remote", "--heads", "origin", ref).stdout.strip().splitlines()
                    if len(remote) != 1 or remote[0].split()[0] != expected:
                        result.update(outcome="SKIPPED", detail="Last-moment git ref lease mismatch")
                    else:
                        # This is a remote compare-and-swap deletion. Any concurrent push rejects the lease.
                        op = git("push", "--porcelain", f"--force-with-lease={ref}:{expected}",
                                 "origin", ":" + ref, check=False)
                        if op.returncode:
                            result.update(outcome="REJECTED", detail="Git remote rejected exact-SHA deletion")
                        else:
                            result.update(outcome="DELETED", detail="Git remote accepted exact-SHA lease")
        outcomes.append(result)
        if index % 15 == 0 or index == len(approved):
            batch = outcomes[-(index % 15 or 15):]
            text = "\n".join(
                f"- **{x['outcome']}** `{x['branch']}` at `{x['expected_sha']}`: {x['detail']}"
                for x in batch
            )
            issue_comment(ledger_num, f"## Audited batch ending at {index}/{APPROVED_COUNT}\n\n{text}")
            print(json.dumps({"batch_end": index, "deleted": sum(x["outcome"] == "DELETED" for x in outcomes),
                              "skipped": sum(x["outcome"] != "DELETED" for x in outcomes)}))

    out = folder / "outcomes.json"
    out.write_text(json.dumps({"release_sha": release_sha, "approved_count": len(approved),
                               "outcomes": outcomes}, indent=2) + "\n")
    issues = gh(f"/repos/{REPO}/issues/{ledger_num}")
    body = issues.get("body") or ""
    if "RETIREMENT COMPLETED" not in body:
        body = body.replace("IN PROGRESS — see chronological issue comments for batch outcomes.",
                            "RETIREMENT COMPLETED — see chronological issue comments for per-branch results.")
    deleted = sum(x["outcome"] == "DELETED" for x in outcomes)
    gh(f"/repos/{REPO}/issues/{ledger_num}", "PATCH",
       {"body": body + f"\n\n**Final run outcome:** {deleted} deleted; {len(outcomes)-deleted} skipped or rejected.\n"})
    print(json.dumps({"complete": True, "issue": ledger_num, "deleted": deleted,
                      "not_deleted": len(outcomes) - deleted, "release_sha": release_sha}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("Koa branch retirement blocked: " + str(exc), file=sys.stderr)
        sys.exit(1)
