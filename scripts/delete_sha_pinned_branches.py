#!/usr/bin/env python3
"""One-time, fail-closed retirement of the frozen, verified 195-ref whitelist."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse

from branch_retirement_safety import (
    RetirementLedger, RetirementStopped, has_active_dependency,
    paginated_list, self_test as test_durable_retirement,
)

REPO = "AstroTat808/koasevents.com"
SNAPSHOT_RUN = 38237894943
SNAPSHOT_ARTIFACT = "branch-hygiene-38237894943-1"
SNAPSHOT_SHA256 = "6dbf4cbcd41b883d7302c9d5189c21681ddb713a722f2d117d304cf0ae856adf"
SNAPSHOT_MAIN = "1b2d17c14beb0b31687f7eb5dae55c831aa872b0"
PRODUCTION_RUN_261 = 38237525321
APPROVED_COUNT = 195
LEDGER_TITLE = "[Audit] Koa exact-SHA branch retirement \u2014 2026-10-12 approved 195"
SHA = re.compile(r"^[0-9a-f]{40}$")
REQUIRED_PRS = (268, 273, 266, 275, 271, 269, 270, 272)
REQUIRED_STATUSES = (
    "System Health production release gate",
    "System Health responsive audit",
    "System Health release history persistence",
)


def run(args, *, input_text=None, check=True, timeout=180):
    p = subprocess.run(args, input=input_text, text=True, capture_output=True, timeout=timeout)
    if check and p.returncode:
        raise RuntimeError(f"Command {args[0]} failed ({p.returncode}); no raw response logged")
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


def remote_tip(branch):
    ref = "refs/heads/" + branch
    rows = git("ls-remote", "--heads", "origin", ref).stdout.strip().splitlines()
    if not rows:
        return ""
    if len(rows) != 1:
        raise RetirementStopped("Remote branch evidence is ambiguous")
    fields = rows[0].split()
    if len(fields) != 2 or fields[1] != ref:
        raise RetirementStopped("Remote branch evidence does not match requested ref")
    return check_sha(fields[0])


def select_approved(snapshot):
    if snapshot.get("main_sha") != SNAPSHOT_MAIN:
        raise RuntimeError("Approved snapshot main does not match pinned baseline")
    approved = [row for row in snapshot.get("rows", [])
                if row.get("group") == "safe-to-delete" and row.get("flag_after_7_days") is True]
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


def require_current_release(expected_sha, workflow):
    if gh(f"/repos/{REPO}/commits/main").get("sha") != expected_sha:
        raise RetirementStopped("Main changed after certification")
    canonical = gh(f"/repos/{REPO}/actions/runs/{workflow['id']}")
    if (canonical.get("status") != "completed" or canonical.get("conclusion") != "success"
            or canonical.get("head_sha") != expected_sha or canonical.get("event") != "push"
            or canonical.get("head_branch") != "main" or canonical.get("name") != "Production visual QA"
            or canonical.get("run_attempt") != workflow.get("run_attempt")
            or (canonical.get("head_repository") or {}).get("full_name") != REPO):
        raise RetirementStopped("Canonical exact-main production workflow is not the certified successful attempt")
    statuses = gh(f"/repos/{REPO}/commits/{expected_sha}/status")
    newest = {}
    for status in statuses.get("statuses", []):
        newest.setdefault(status.get("context"), status.get("state"))
    if any(newest.get(name) != "success" for name in REQUIRED_STATUSES):
        raise RetirementStopped("Current main lacks successful release, responsive, or history status")


def verify_release_trigger():
    if os.environ.get("GITHUB_REPOSITORY") != REPO or os.environ.get("GITHUB_EVENT_NAME") != "workflow_run":
        raise RuntimeError("Deletion requires this repository's successful production workflow_run")
    event_path = Path(os.environ.get("GITHUB_EVENT_PATH", ""))
    if not event_path.is_file():
        raise RuntimeError("Missing authenticated workflow_run event")
    workflow = json.loads(event_path.read_text()).get("workflow_run") or {}
    event_sha = check_sha(workflow.get("head_sha"))
    if (workflow.get("name") != "Production visual QA" or workflow.get("event") != "push"
            or workflow.get("head_branch") != "main" or workflow.get("conclusion") != "success"
            or type(workflow.get("id")) is not int or type(workflow.get("run_attempt")) is not int
            or (workflow.get("head_repository") or {}).get("full_name") != REPO):
        raise RuntimeError("Trigger is not a successful trusted production main workflow")
    if git("rev-parse", "HEAD").stdout.strip() != event_sha:
        raise RuntimeError("Checkout is not the exact certified production SHA")
    require_current_release(event_sha, workflow)
    if git("merge-base", "--is-ancestor", SNAPSHOT_MAIN, "HEAD", check=False).returncode:
        raise RuntimeError("Approved main SHA is not an ancestor of the current release")
    if gh(f"/repos/{REPO}/actions/runs/{PRODUCTION_RUN_261}").get("status") != "completed":
        raise RuntimeError("Original PR #261 production workflow is still unresolved")
    # The original #261 run remains historically failed. A fully successful
    # superseding release must include every authorized prerequisite below.
    for pr_number in REQUIRED_PRS:
        pr = gh(f"/repos/{REPO}/pulls/{pr_number}")
        if pr.get("merged") is not True:
            raise RuntimeError(f"PR #{pr_number} must merge before retirement")
        merged_sha = check_sha(pr.get("merge_commit_sha"))
        if git("merge-base", "--is-ancestor", merged_sha, "HEAD", check=False).returncode:
            raise RuntimeError(f"PR #{pr_number} merge is missing from certified main")
    return event_sha, workflow


def load_approved_report(folder):
    folder.mkdir(parents=True, exist_ok=True)
    run(["gh", "run", "download", str(SNAPSHOT_RUN), "--repo", REPO,
         "--name", SNAPSHOT_ARTIFACT, "--dir", str(folder)], timeout=120)
    raw = (folder / "report.json").read_bytes()
    if hashlib.sha256(raw).hexdigest() != SNAPSHOT_SHA256:
        raise RuntimeError("Approved GitHub Actions artifact digest mismatch")
    return json.loads(raw)


def fresh_classification(folder, expected_main):
    run([sys.executable, "scripts/branch_hygiene.py", "--repo", REPO, "--out", str(folder)], timeout=900)
    report = json.loads((folder / "report.json").read_text())
    if report.get("main_sha") != expected_main:
        raise RuntimeError("Main changed during fresh branch classification")
    return {row["branch"]: row for row in report.get("rows", [])}


def issue_comment(number, body):
    # Serialize content creation and verify durable readback before continuing.
    time.sleep(1.1)
    created = gh(f"/repos/{REPO}/issues/{number}/comments", "POST", {"body": body})
    comment_id = created.get("id")
    if type(comment_id) is not int or created.get("body") != body:
        raise RetirementStopped("Issue comment creation was not confirmed")
    persisted = gh(f"/repos/{REPO}/issues/comments/{comment_id}")
    if persisted.get("id") != comment_id or persisted.get("body") != body:
        raise RetirementStopped("Issue comment durable readback did not match")
    return True


def ensure_ledger(approved, release_sha):
    # Enumerate all issues rather than relying on an eventually consistent search.
    issues = paginated_list(gh, f"/repos/{REPO}/issues?state=all")
    exact = [row for row in issues if row.get("title") == LEDGER_TITLE and not row.get("pull_request")]
    if len(exact) > 1:
        raise RetirementStopped("Duplicate permanent branch-deletion ledger issues")
    if exact:
        issue = gh(f"/repos/{REPO}/issues/{exact[0]['number']}")
        body = issue.get("body") or ""
        if SNAPSHOT_SHA256 not in body or SNAPSHOT_MAIN not in body:
            raise RetirementStopped("Existing issue ledger does not match the pinned authorization")
        return issue["number"]
    lines = ["<!-- koa-branch-retirement-20261012 -->", "# SHA-pinned Koa branch retirement", "",
             "Execution requires merged/reachable PRs " + ", ".join(f"#{number}" for number in REQUIRED_PRS) + ".",
             f"Approved main baseline: `{SNAPSHOT_MAIN}`", f"Exact certified execution main: `{release_sha}`",
             f"Source audit run: https://github.com/{REPO}/actions/runs/{SNAPSHOT_RUN}",
             f"Verified source report SHA256: `{SNAPSHOT_SHA256}`",
             f"Frozen authorized branch count: **{APPROVED_COUNT}**", "",
             "## Immutable approved refs (each guarded by an explicit Git force-with-lease)", ""]
    lines.extend(f"- `{row['branch']}` - `{row['sha']}`" for row in approved)
    lines += ["", "## Execution result", "", "IN PROGRESS - see durable per-ref intent and outcome events."]
    body = "\n".join(lines)
    created = gh(f"/repos/{REPO}/issues", "POST", {"title": LEDGER_TITLE, "body": body})
    number = created.get("number")
    if type(number) is not int or gh(f"/repos/{REPO}/issues/{number}").get("body") != body:
        raise RetirementStopped("Permanent whitelist was not durably verified")
    return number


def retire_candidate(row, current, release_sha, workflow):
    branch, expected = row["branch"], check_sha(row["sha"])
    result = {"branch": branch, "expected_sha": expected, "outcome": "SKIPPED", "detail": ""}
    try:
        tip = remote_tip(branch)
        result["present_before"] = bool(tip)
        reason = gate_current_candidate(row, current.get(branch))
        if reason or tip != expected:
            return {**result, "detail": reason or "Last-moment exact-SHA mismatch or already absent ref"}
        require_current_release(release_sha, workflow)
        open_prs = paginated_list(gh, f"/repos/{REPO}/pulls?state=open")
        if has_active_dependency(open_prs, branch):
            return {**result, "detail": "Active pull request dependency"}
        info = gh(f"/repos/{REPO}/branches/{urllib.parse.quote(branch, safe='')}")
        if info.get("protected") is not False or (info.get("commit") or {}).get("sha") != expected:
            return {**result, "detail": "Protection was not false or exact branch SHA changed"}
        if remote_tip(branch) != expected:
            return {**result, "detail": "Last-moment Git ref lease mismatch"}
        require_current_release(release_sha, workflow)
    except Exception:
        return {**result, "outcome": "REFUSED", "detail": "Fresh release, protection, or complete PR evidence unavailable"}
    ref = "refs/heads/" + branch
    try:
        op = git("push", "--porcelain", f"--force-with-lease={ref}:{expected}", "origin", ":" + ref, check=False)
        after = remote_tip(branch)
    except Exception:
        return {**result, "outcome": "UNKNOWN", "detail": "Git remote acceptance could not be confirmed"}
    if op.returncode == 0 and not after:
        return {**result, "outcome": "DELETED", "detail": "Exact-SHA Git lease accepted and absence confirmed"}
    if op.returncode != 0 and after:
        return {**result, "outcome": "REJECTED", "detail": "Git rejected deletion; remote ref remains present"}
    return {**result, "outcome": "UNKNOWN", "detail": "Git result and observed remote presence are inconsistent"}


def write_json_atomic(path, data):
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def test_git_lease_deletion():
    with tempfile.TemporaryDirectory(prefix="koa-branch-lease-") as root:
        remote, work = str(Path(root) / "remote.git"), str(Path(root) / "client")
        run(["git", "init", "--bare", remote])
        run(["git", "clone", remote, work])
        run(["git", "-C", work, "config", "user.name", "Koa branch lease test"])
        run(["git", "-C", work, "config", "user.email", "lease-test@koasevents.test"])
        (Path(work) / "sample.txt").write_text("one\n")
        run(["git", "-C", work, "add", "sample.txt"])
        run(["git", "-C", work, "commit", "-m", "first"])
        run(["git", "-C", work, "branch", "lease-test"])
        run(["git", "-C", work, "push", "origin", "lease-test"])
        old_tip = run(["git", "-C", work, "rev-parse", "lease-test"]).stdout.strip()
        (Path(work) / "sample.txt").write_text("two\n")
        run(["git", "-C", work, "commit", "-am", "second"])
        run(["git", "-C", work, "branch", "-f", "lease-test", "HEAD"])
        run(["git", "-C", work, "push", "origin", "lease-test"])
        stale = run(["git", "-C", work, "push", f"--force-with-lease=refs/heads/lease-test:{old_tip}",
                     "origin", ":refs/heads/lease-test"], check=False)
        assert stale.returncode != 0, "A moved branch was deleted despite stale expected SHA"
        ref = run(["git", "-C", work, "ls-remote", "--heads", "origin", "refs/heads/lease-test"]).stdout.strip()
        actual = ref.split()[0]
        assert actual != old_tip and SHA.fullmatch(actual)
        run(["git", "-C", work, "push", f"--force-with-lease=refs/heads/lease-test:{actual}", "origin", ":refs/heads/lease-test"])
        assert not run(["git", "-C", work, "ls-remote", "--heads", "origin", "refs/heads/lease-test"]).stdout.strip()


def test_candidate_boundary():
    from types import SimpleNamespace
    from unittest.mock import patch
    row = {"branch": "feature/one", "sha": "a" * 40, "group": "safe-to-delete",
           "flag_after_7_days": True, "evidence": {"contained": True}}
    current = {row["branch"]: row}
    first_page = [{"id": n, "head": {"ref": f"other/{n}"}, "base": {"ref": "main"}} for n in range(1, 101)]

    def evidence(path):
        if "/pulls?" in path:
            return []
        return {"protected": False, "commit": {"sha": row["sha"]}}

    module = sys.modules[__name__]
    for code, tips, expected in [
        (0, [row["sha"], row["sha"], ""], "DELETED"),
        (1, [row["sha"], row["sha"], "b" * 40], "REJECTED"),
        (1, [row["sha"], row["sha"], ""], "UNKNOWN"),
        (0, [row["sha"], row["sha"], "b" * 40], "UNKNOWN"),
    ]:
        with patch.object(module, "require_current_release"), patch.object(module, "gh", side_effect=evidence), \
             patch.object(module, "remote_tip", side_effect=tips), \
             patch.object(module, "git", return_value=SimpleNamespace(returncode=code)) as push:
            result = retire_candidate(row, current, "c" * 40, {"id": 1, "run_attempt": 1})
            assert result["outcome"] == expected
            assert push.call_count == 1
            assert push.call_args.args == ("push", "--porcelain", "--force-with-lease=refs/heads/feature/one:" + row["sha"], "origin", ":refs/heads/feature/one")
    with patch.object(module, "require_current_release", side_effect=RetirementStopped("Main moved")), \
         patch.object(module, "remote_tip", return_value=row["sha"]), patch.object(module, "git") as push:
        assert retire_candidate(row, current, "c" * 40, {})["outcome"] == "REFUSED"
        push.assert_not_called()
    for side in ("head", "base"):
        last = {"id": 101, "head": {"ref": "other/last"}, "base": {"ref": "main"}}
        last[side]["ref"] = row["branch"]
        def all_prs(path):
            return first_page if path.endswith("page=1") else [last]
        with patch.object(module, "require_current_release"), patch.object(module, "gh", side_effect=all_prs), \
             patch.object(module, "remote_tip", return_value=row["sha"]), patch.object(module, "git") as push:
            assert retire_candidate(row, current, "c" * 40, {})["detail"] == "Active pull request dependency"
            push.assert_not_called()
    for protection in (True, None):
        def guarded(path):
            return [] if "/pulls?" in path else {"protected": protection, "commit": {"sha": row["sha"]}}
        with patch.object(module, "require_current_release"), patch.object(module, "gh", side_effect=guarded), \
             patch.object(module, "remote_tip", return_value=row["sha"]), patch.object(module, "git") as push:
            assert retire_candidate(row, current, "c" * 40, {})["outcome"] == "SKIPPED"
            push.assert_not_called()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        sample = {"sha": "a"*40, "group": "safe-to-delete", "flag_after_7_days": True, "evidence": {"contained": True}}
        assert not gate_current_candidate(sample, dict(sample))
        assert gate_current_candidate(sample, {**sample, "sha": "b"*40})
        assert gate_current_candidate(sample, {**sample, "flag_after_7_days": False})
        assert gate_current_candidate(sample, {**sample, "group": "keep"})
        test_git_lease_deletion()
        test_durable_retirement()
        test_candidate_boundary()
        print("Exact-SHA, seven-day, preservation, full pagination, durable resume and atomic lease tests passed")
        return
    if not args.execute:
        raise RuntimeError("Deletion requires explicit --execute in a certified production workflow_run")
    release_sha, workflow = verify_release_trigger()
    folder = Path("/tmp/koa-branch-retirement")
    original = load_approved_report(folder / "approved")
    approved = select_approved(original)
    current = fresh_classification(folder / "fresh", release_sha)
    ledger_num = ensure_ledger(approved, release_sha)
    comments = paginated_list(gh, f"/repos/{REPO}/issues/{ledger_num}/comments")
    ledger = RetirementLedger(approved, SNAPSHOT_SHA256, comments, lambda body: issue_comment(ledger_num, body))
    ledger.preflight(remote_tip)
    outcomes = []

    def checkpoint(result):
        outcomes.append(result)
        write_json_atomic(folder / "outcomes.json", {"release_sha": release_sha, "approved_count": len(approved), "outcomes": outcomes})

    for row in approved:
        ledger.perform(row, release_sha, lambda row=row: retire_candidate(row, current, release_sha, workflow), checkpoint)
    preserved = {row["branch"]: row["sha"] for row in original["rows"]
                 if not (row.get("group") == "safe-to-delete" and row.get("flag_after_7_days") is True)}
    if len(preserved) != 106:
        raise RuntimeError("Unexpected number of preserved branches in approved audit")
    remote_refs = {}
    for line in git("ls-remote", "--heads", "origin").stdout.splitlines():
        tip, ref = line.split(None, 1)
        if ref.startswith("refs/heads/"):
            remote_refs[ref[len("refs/heads/"):]] = check_sha(tip)
    require_current_release(release_sha, workflow)
    if remote_refs.get("main") != release_sha:
        raise RetirementStopped("Production main moved before final reconciliation")
    inconsistent = []
    for result in outcomes:
        branch = result["branch"]
        exists = branch in remote_refs
        result.update(present_after=exists, tip_after=remote_refs.get(branch, ""))
        if result["outcome"] == "DELETED" and exists:
            inconsistent.append(branch + ": reported deleted but present")
        if result["outcome"] != "DELETED" and not exists and result.get("present_before") is not False:
            inconsistent.append(branch + ": preserved outcome but ref unexpectedly absent")
        if result["outcome"] == "UNKNOWN":
            inconsistent.append(branch + ": unresolved deletion outcome")
    for branch in preserved:
        if branch not in remote_refs:
            inconsistent.append(branch + ": excluded preserved branch missing")
    counts = {key.lower(): sum(row["outcome"] == key for row in outcomes)
              for key in ("DELETED", "SKIPPED", "REJECTED", "REFUSED", "UNKNOWN")}
    reconciliation = {
        "schema_version": 2, "snapshot_main_sha": SNAPSHOT_MAIN, "snapshot_sha256": SNAPSHOT_SHA256,
        "certified_release_sha": release_sha, "approved_count": len(approved), **counts,
        "deleted_this_run": sum(row["outcome"] == "DELETED" and not row.get("resumed_from_ledger") for row in outcomes),
        "preserved_expected": len(preserved), "preserved_found": sum(name in remote_refs for name in preserved),
        "consistent": not inconsistent, "discrepancies": inconsistent, "outcomes": outcomes,
        "preserved": [{"branch": name, "source_tip": tip, "still_present": name in remote_refs,
                       "current_tip": remote_refs.get(name, "")} for name, tip in sorted(preserved.items())],
    }
    evidence = folder / "reconciliation.json"
    write_json_atomic(evidence, reconciliation)
    digest = hashlib.sha256(evidence.read_bytes()).hexdigest()
    summary = "## Final exact-SHA reconciliation\n\n" + json.dumps(counts, sort_keys=True)
    summary += f"\n\nPreserved: {reconciliation['preserved_found']}/106. Evidence SHA256: {digest}."
    if inconsistent:
        summary += "\n\nUNVERIFIED: " + "; ".join(inconsistent[:20])
    issue_comment(ledger_num, summary)
    if inconsistent:
        raise RetirementStopped("Final ref preservation or deletion reconciliation failed")
    issue = gh(f"/repos/{REPO}/issues/{ledger_num}")
    body = issue.get("body") or ""
    if "RETIREMENT COMPLETED" not in body:
        body += "\n\nRETIREMENT COMPLETED - all outcomes have durable per-ref events and remote reconciliation.\n"
        body += json.dumps(counts, sort_keys=True)
        gh(f"/repos/{REPO}/issues/{ledger_num}", "PATCH", {"body": body})
        if gh(f"/repos/{REPO}/issues/{ledger_num}").get("body") != body:
            raise RetirementStopped("Final ledger completion readback failed")
    print(json.dumps({"complete": True, "issue": ledger_num, "release_sha": release_sha, **counts}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("Koa branch retirement blocked: " + str(exc), file=sys.stderr)
        sys.exit(1)