from __future__ import annotations

import re
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CALENDAR = ROOT / "docs" / "google-business-profile-content-calendar-2026-2027.md"
OUTPUT_ROOT = ROOT / "public" / "media" / "gbp"

IMAGE_RE = re.compile(r"/media/koa/[^|\s]+\.webp", re.IGNORECASE)

def main() -> None:
    text = CALENDAR.read_text(encoding="utf-8")
    paths = sorted(set(IMAGE_RE.findall(text)))
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)

    missing = []
    converted = 0

    for public_path in paths:
        source = ROOT / "public" / public_path.lstrip("/")
        if not source.exists():
            missing.append(public_path)
            continue

        target = OUTPUT_ROOT / (source.stem + ".jpg")
        with Image.open(source) as image:
            image = image.convert("RGB")
            width, height = image.size
            max_side = max(width, height)
            if max_side > 1600:
                scale = 1600 / max_side
                image = image.resize((round(width * scale), round(height * scale)), Image.Resampling.LANCZOS)
            image.save(target, "JPEG", quality=90, optimize=True, progressive=True)
        converted += 1

    if missing:
        raise SystemExit("Missing calendar media: " + ", ".join(missing))

    print(f"Generated {converted} GBP JPEG assets in {OUTPUT_ROOT.relative_to(ROOT)}")

if __name__ == "__main__":
    main()
