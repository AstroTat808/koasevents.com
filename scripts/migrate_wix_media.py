#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
DEST = ROOT / "public" / "media" / "wix"
MANIFEST = DEST / "manifest.json"

ASSET_RE = re.compile(r"02b2df_[0-9a-f]+~mv2\.jpg")
FULL_WIX_RE = re.compile(
    r"https://static\.wixstatic\.com/media/(02b2df_[0-9a-f]+~mv2\.jpg)"
    r"(?:/v1/[^'\"\)\s]+)?"
)

SOURCE_SUFFIXES = {".astro", ".ts", ".js", ".css"}


def source_files() -> list[Path]:
    return [
        path
        for path in SRC.rglob("*")
        if path.is_file() and path.suffix in SOURCE_SUFFIXES
    ]


def discover_assets(files: list[Path]) -> list[str]:
    ids: set[str] = set()
    for path in files:
        text = path.read_text(encoding="utf-8", errors="ignore")
        ids.update(ASSET_RE.findall(text))
    return sorted(ids)


def download(asset_id: str) -> dict:
    url = f"https://static.wixstatic.com/media/{asset_id}"
    req = Request(
        url,
        headers={
            "User-Agent": "KoaEvents-Wix-Migration/1.0",
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
    )
    try:
        with urlopen(req, timeout=90) as response:
            payload = response.read()
            content_type = response.headers.get("content-type", "")
    except (HTTPError, URLError, TimeoutError) as exc:
        raise RuntimeError(f"Failed to download {url}: {exc}") from exc

    if len(payload) < 1024:
        raise RuntimeError(f"Downloaded asset is unexpectedly small: {asset_id} ({len(payload)} bytes)")
    if content_type and not content_type.lower().startswith("image/"):
        raise RuntimeError(f"Unexpected content type for {asset_id}: {content_type}")

    target = DEST / asset_id
    target.write_bytes(payload)
    return {
        "id": asset_id,
        "source": url,
        "local": f"/media/wix/{asset_id}",
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "contentType": content_type,
    }


def rewrite_sources(files: list[Path]) -> list[str]:
    changed: list[str] = []
    for path in files:
        text = path.read_text(encoding="utf-8")
        original = text

        text = FULL_WIX_RE.sub(lambda m: f"/media/wix/{m.group(1)}", text)
        text = text.replace(
            "'https://static.wixstatic.com/media/' + id",
            "'/media/wix/' + id",
        )
        text = text.replace(
            '"https://static.wixstatic.com/media/" + id',
            '"/media/wix/" + id',
        )

        if text != original:
            path.write_text(text, encoding="utf-8")
            changed.append(str(path.relative_to(ROOT)))

    return changed


def main() -> int:
    DEST.mkdir(parents=True, exist_ok=True)
    files = source_files()
    assets = discover_assets(files)

    if not assets:
        print("No Wix media asset IDs found. Nothing to migrate.")
        return 0

    print(f"Discovered {len(assets)} unique Wix image assets.")
    manifest = []
    failures = []

    for index, asset_id in enumerate(assets, start=1):
        try:
            record = download(asset_id)
            manifest.append(record)
            print(f"[{index:02d}/{len(assets):02d}] {asset_id}: {record['bytes']:,} bytes")
        except Exception as exc:
            failures.append(str(exc))
            print(f"ERROR: {exc}", file=sys.stderr)

    if failures:
        print("\nMigration stopped because one or more images failed:", file=sys.stderr)
        for failure in failures:
            print(f" - {failure}", file=sys.stderr)
        return 1

    changed = rewrite_sources(files)

    MANIFEST.write_text(
        json.dumps(
            {
                "assetCount": len(manifest),
                "assets": manifest,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    remaining = []
    for path in source_files():
        text = path.read_text(encoding="utf-8", errors="ignore")
        if "static.wixstatic.com" in text:
            remaining.append(str(path.relative_to(ROOT)))

    if remaining:
        print("Wix dependencies remain in source files:", file=sys.stderr)
        for path in remaining:
            print(f" - {path}", file=sys.stderr)
        return 1

    print(f"Downloaded {len(manifest)} images into {DEST.relative_to(ROOT)}")
    print(f"Rewrote {len(changed)} source files:")
    for path in changed:
        print(f" - {path}")
    print("Verified: no static.wixstatic.com dependencies remain in src/.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
