#!/usr/bin/env python3
"""Offline synthetic-only regressions: no production data or browsers required."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import prepare_accordion_release_evidence as evidence

SHA = "a" * 40
RUN = "123456"
DEPLOY = "0123456789abcdef01234567"
IMAGE = b"\xff\xd8\xff" + b"X" * 1300
POISON = b"SYNTHETIC-TEST-DO-NOT-EXPORT-LIVE-DATA"


def fake_capture(scratch, commit, run_id):
    output = scratch / "browser-output"
    for browser in ("chromium", "webkit"):
        folder = output / ("health-mobile-" + browser)
        folder.mkdir(parents=True)
        rows = []
        for name, viewport, width, height in evidence.CASES:
            if name != browser:
                continue
            rows.append({"viewport": viewport, "width": width, "height": height, "failure": "",
                         "metrics": {"sectionCollapse": {"sections": 5, **{t: True for t in evidence.TESTS}}}})
            (folder / ("accordion-" + viewport + ".jpg")).write_bytes(IMAGE)
        (folder / "report.json").write_text(json.dumps({"mode": "health-mobile", "browser": browser,
                                                       "failures": [], "results": rows}))
    return output


class EvidencePrivacyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "visual-results"
        self.env = patch.dict(os.environ, {"GITHUB_SHA": SHA, "GITHUB_RUN_ID": RUN,
                                           "PRODUCTION_BASE_URL": "https://koasevents.com"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def collect(self, capture=fake_capture):
        with patch.object(evidence, "_capture", capture):
            evidence.collect(self.root)

    def metadata(self):
        return self.root / "accordion-synthetic/chromium-phone.json"

    def mutate(self, callback):
        path = self.metadata()
        row = json.loads(path.read_text())
        callback(row)
        path.write_text(json.dumps(row))

    def test_poisoned_live_reports_and_images_are_not_read_or_staged(self):
        for browser in ("chromium", "webkit"):
            folder = self.root / ("health-mobile-" + browser)
            folder.mkdir(parents=True)
            (folder / "report.json").write_bytes(POISON)  # Invalid JSON must never be read.
            for viewport in ("phone", "desktop"):
                (folder / ("accordion-" + viewport + ".jpg")).write_bytes(b"\xff\xd8\xff" + POISON * 40)
        self.collect()
        staged = self.root / "accordion-synthetic"
        self.assertEqual(len(list(staged.iterdir())), 8)
        self.assertTrue(all(POISON not in file.read_bytes() for file in staged.iterdir()))
        result = evidence.package(self.root, SHA, DEPLOY, RUN)
        self.assertEqual(len(result["results"]), 4)
        self.assertNotIn(POISON.decode(), json.dumps(result))

    def test_no_existing_live_outputs_can_substitute_for_failed_capture(self):
        self.collect()
        with patch.object(evidence, "_capture", side_effect=RuntimeError("synthetic failure")):
            with self.assertRaises(RuntimeError):
                evidence.collect(self.root)
        self.assertFalse((self.root / "accordion-synthetic").exists())

    def test_rejects_extra_sensitive_metadata(self):
        self.collect()
        self.mutate(lambda row: row.update({"clientName": "SYNTHETIC PRIVACY SENTINEL"}))
        with self.assertRaises(ValueError):
            evidence.package(self.root, SHA, DEPLOY, RUN)

    def test_rejects_stale_sha_and_run(self):
        self.collect()
        for sha, run in (("b" * 40, RUN), (SHA, "999999")):
            with self.subTest(sha=sha, run=run), self.assertRaises(ValueError):
                evidence.package(self.root, sha, DEPLOY, run)

    def test_rejects_unknown_fixture_provenance(self):
        self.collect()
        self.mutate(lambda row: row.update({"fixtureSha256": "b" * 64}))
        with self.assertRaises(ValueError):
            evidence.package(self.root, SHA, DEPLOY, RUN)

    def test_rejects_modified_image(self):
        self.collect()
        (self.root / "accordion-synthetic/chromium-phone.jpg").write_bytes(IMAGE + b"changed")
        with self.assertRaises(ValueError):
            evidence.package(self.root, SHA, DEPLOY, RUN)

    def test_rejects_extra_file_and_directory(self):
        self.collect()
        stray = self.root / "accordion-synthetic/raw.json"
        stray.write_bytes(POISON)
        with self.assertRaises(ValueError):
            evidence.package(self.root, SHA, DEPLOY, RUN)
        stray.unlink()
        stray.mkdir()
        with self.assertRaises(ValueError):
            evidence.package(self.root, SHA, DEPLOY, RUN)

    def test_rejects_symlinked_image(self):
        self.collect()
        original = self.root / "outside.jpg"
        original.write_bytes(IMAGE)
        link = self.root / "accordion-synthetic/chromium-phone.jpg"
        link.unlink()
        link.symlink_to(original)
        with self.assertRaises(ValueError):
            evidence.package(self.root, SHA, DEPLOY, RUN)

    def test_rejects_missing_image(self):
        self.collect()
        (self.root / "accordion-synthetic/chromium-phone.jpg").unlink()
        with self.assertRaises(ValueError):
            evidence.package(self.root, SHA, DEPLOY, RUN)

    def test_rejects_failed_interaction_before_staging(self):
        def failed(scratch, sha, run):
            output = fake_capture(scratch, sha, run)
            report = output / "health-mobile-chromium/report.json"
            data = json.loads(report.read_text())
            data["results"][0]["metrics"]["sectionCollapse"]["criticalForcedOpen"] = False
            report.write_text(json.dumps(data))
            return output
        with self.assertRaises(ValueError):
            self.collect(failed)
        self.assertFalse((self.root / "accordion-synthetic").exists())

    def test_rejects_duplicate_viewport_before_staging(self):
        def duplicate(scratch, sha, run):
            output = fake_capture(scratch, sha, run)
            report = output / "health-mobile-chromium/report.json"
            data = json.loads(report.read_text())
            data["results"].append(data["results"][0])
            report.write_text(json.dumps(data))
            return output
        with self.assertRaises(ValueError):
            self.collect(duplicate)

    def test_capture_is_constant_and_does_not_forward_credentials(self):
        captured = []
        def child(args, **kwargs):
            captured.append((args, kwargs))
            fixture = Path(args[args.index("--health-payload") + 1])
            self.assertEqual(fixture.read_bytes(), evidence.FIXTURE_BYTES)
            return SimpleNamespace(returncode=0)
        secrets = {"ACTIONS_ID_TOKEN_REQUEST_TOKEN": "SYNTHETIC TOKEN",
                   "GH_TOKEN": "SYNTHETIC TOKEN", "NETLIFY_AUTH_TOKEN": "SYNTHETIC TOKEN",
                   "HEALTH_PAYLOAD_PATH": "/tmp/never-read-live.json"}
        with patch.dict(os.environ, secrets), patch.object(subprocess, "run", child):
            evidence._capture(Path(self.directory.name), SHA, RUN)
        self.assertEqual(len(captured), 2)
        for args, options in captured:
            self.assertTrue(set(secrets).isdisjoint(options["env"]))
            self.assertEqual(options["stdout"], subprocess.DEVNULL)
            self.assertEqual(options["stderr"], subprocess.DEVNULL)

    def test_rejects_external_capture_origin(self):
        with patch.dict(os.environ, {"PRODUCTION_BASE_URL": "https://unapproved.invalid"}):
            with self.assertRaises(ValueError):
                evidence._capture(Path(self.directory.name), SHA, RUN)


if __name__ == "__main__":
    unittest.main()
