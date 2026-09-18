#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path

from PIL import Image, ImageOps
import imagehash

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "public" / "media" / "wix"
SRC = ROOT / "src"
OUT = ROOT / "visual-results" / "media-dedupe"
OUT.mkdir(parents=True, exist_ok=True)

ID_RE = re.compile(r"02b2df_[0-9a-f]+~mv2\.jpg")

def cosine(a, b):
    dot = sum(x*y for x, y in zip(a,b))
    na = math.sqrt(sum(x*x for x in a))
    nb = math.sqrt(sum(y*y for y in b))
    return dot / (na*nb) if na and nb else 0.0

def histogram_signature(img):
    thumb = ImageOps.fit(img.convert("RGB"), (96, 96), method=Image.Resampling.LANCZOS)
    hist = thumb.histogram()
    bins = []
    for channel in range(3):
        values = hist[channel*256:(channel+1)*256]
        for start in range(0,256,16):
            bins.append(sum(values[start:start+16]))
    total = sum(bins) or 1
    return [v/total for v in bins]

def usage_map():
    usage = {}
    for path in SRC.rglob("*"):
        if not path.is_file() or path.suffix not in {".astro",".ts",".js",".css"}:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for asset_id in ID_RE.findall(text):
            usage.setdefault(asset_id, set()).add(str(path.relative_to(ROOT)))
    return {k: sorted(v) for k,v in usage.items()}

def analyze(path):
    raw = path.read_bytes()
    with Image.open(path) as image:
        image = ImageOps.exif_transpose(image)
        rgb = image.convert("RGB")
        return {
            "id": path.name,
            "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "width": rgb.width,
            "height": rgb.height,
            "phash": str(imagehash.phash(rgb, hash_size=16)),
            "dhash": str(imagehash.dhash(rgb, hash_size=16)),
            "whash": str(imagehash.whash(rgb, hash_size=16)),
            "hist": histogram_signature(rgb),
        }

def classify(a,b):
    p = imagehash.hex_to_hash(a["phash"]) - imagehash.hex_to_hash(b["phash"])
    d = imagehash.hex_to_hash(a["dhash"]) - imagehash.hex_to_hash(b["dhash"])
    w = imagehash.hex_to_hash(a["whash"]) - imagehash.hex_to_hash(b["whash"])
    h = cosine(a["hist"], b["hist"])
    if a["sha256"] == b["sha256"]:
        label = "exact"
    elif p <= 5 and d <= 7 and w <= 7 and h >= .985:
        label = "high-confidence-near-duplicate"
    elif p <= 14 and d <= 18 and w <= 18 and h >= .94:
        label = "probable-near-duplicate"
    elif p <= 22 and d <= 28 and h >= .89:
        label = "visually-similar"
    else:
        return None
    return {"classification":label,"phashDistance":p,"dhashDistance":d,"whashDistance":w,"histogramCosine":round(h,5)}

def main():
    usage = usage_map()
    assets = [analyze(p) for p in sorted(MEDIA.glob("*.jpg"))]
    pairs = []
    for i,a in enumerate(assets):
        for b in assets[i+1:]:
            result = classify(a,b)
            if result:
                pair = {
                    "a": a["id"],
                    "b": b["id"],
                    **result,
                    "aUsage": usage.get(a["id"],[]),
                    "bUsage": usage.get(b["id"],[]),
                    "aPixels": a["width"]*a["height"],
                    "bPixels": b["width"]*b["height"],
                    "suggestedCanonical": a["id"] if (len(usage.get(a["id"],[])), a["width"]*a["height"]) >= (len(usage.get(b["id"],[])), b["width"]*b["height"]) else b["id"],
                }
                pairs.append(pair)

    rank={"exact":0,"high-confidence-near-duplicate":1,"probable-near-duplicate":2,"visually-similar":3}
    pairs.sort(key=lambda x:(rank[x["classification"]],x["phashDistance"],x["dhashDistance"]))

    report={
        "assetCount":len(assets),
        "exactCount":sum(p["classification"]=="exact" for p in pairs),
        "highConfidenceCount":sum(p["classification"]=="high-confidence-near-duplicate" for p in pairs),
        "probableCount":sum(p["classification"]=="probable-near-duplicate" for p in pairs),
        "similarCount":sum(p["classification"]=="visually-similar" for p in pairs),
        "pairs":pairs,
    }
    (OUT/"report.json").write_text(json.dumps(report,indent=2),encoding="utf-8")

    print(json.dumps({
        "assetCount":report["assetCount"],
        "exactCount":report["exactCount"],
        "highConfidenceCount":report["highConfidenceCount"],
        "probableCount":report["probableCount"],
        "similarCount":report["similarCount"],
        "pairs":pairs[:40],
    },indent=2))

if __name__=="__main__":
    main()
