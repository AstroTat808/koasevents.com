#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "media" / "editorial"
OUT.mkdir(parents=True, exist_ok=True)

ASSETS = [
    {"name":"wedding-forest-couple.jpg","photo_id":"27269420","source":"https://www.pexels.com/photo/a-bride-and-groom-standing-in-the-woods-27269420/","photographer":"Anastasia Nagibina"},
    {"name":"garden-wedding-ceremony.jpg","photo_id":"36723067","source":"https://www.pexels.com/photo/outdoor-garden-wedding-ceremony-under-tree-36723067/","photographer":"Alexander Mass"},
    {"name":"garden-wedding-moment.jpg","photo_id":"36723082","source":"https://www.pexels.com/photo/romantic-outdoor-wedding-in-lush-garden-setting-36723082/","photographer":"Alexander Mass"},
    {"name":"garden-wedding-portrait.jpg","photo_id":"32187199","source":"https://www.pexels.com/photo/elegant-outdoor-wedding-portrait-in-lush-garden-32187199/","photographer":"ART MEDIA PHOTO & FILM STUDIO"},
    {"name":"garden-reception-table.jpg","photo_id":"26975888","source":"https://www.pexels.com/photo/wedding-reception-table-set-on-grass-field-26975888/","photographer":"Josh Withers"},
    {"name":"botanical-reception.jpg","photo_id":"37665541","source":"https://www.pexels.com/photo/elegant-outdoor-wedding-reception-setup-with-floral-decor-37665541/","photographer":"Kimy Moto"},
    {"name":"venue-atmosphere.jpg","photo_id":"12954022","source":"https://www.pexels.com/photo/a-wedding-venue-12954022/","photographer":"Amar Preciado"},
    {"name":"garden-table-settings.jpg","photo_id":"17596023","source":"https://www.pexels.com/photo/elegant-table-settings-in-the-garden-17596023/","photographer":"Hamza Uran"},
    {"name":"rustic-table-detail.jpg","photo_id":"35920484","source":"https://www.pexels.com/photo/rustic-outdoor-dining-setup-with-floral-centerpiece-35920484/","photographer":"Gerardo Pantoja"},
    {"name":"evening-reception.jpg","photo_id":"34241958","source":"https://www.pexels.com/photo/elegant-outdoor-evening-wedding-reception-setup-34241958/","photographer":"Andrea Prochilo"},
    {"name":"private-event-detail.jpg","photo_id":"34180404","source":"https://www.pexels.com/photo/elegant-outdoor-wedding-dessert-table-decor-34180404/","photographer":"Jonathan Goncalves"},
    {"name":"bartender-outdoor-event.jpg","photo_id":"32435269","source":"https://www.pexels.com/photo/bartender-mixing-cocktails-at-outdoor-event-32435269/","photographer":"Rafaela Freire"},
    {"name":"bartender-detail.jpg","photo_id":"16654869","source":"https://www.pexels.com/photo/barmaid-preparing-drink-16654869/","photographer":"Takeshi Arai"},
    {"name":"tropical-resort-dining.jpg","photo_id":"6127022","source":"https://www.pexels.com/photo/a-dining-table-set-up-at-a-resort-6127022/","photographer":"Rachel Claire"},
    {"name":"tropical-bedroom.jpg","photo_id":"29000313","source":"https://www.pexels.com/photo/luxurious-tropical-resort-bedroom-with-canopy-bed-29000313/","photographer":"Quang Nguyen Vinh"},
    {"name":"tropical-room-view.jpg","photo_id":"16436921","source":"https://www.pexels.com/photo/room-with-the-view-of-palm-trees-in-a-tropical-resort-16436921/","photographer":"Luis Zambrano"},
]

LICENSE = "https://www.pexels.com/license/"

def download_url(photo_id: str) -> str:
    return f"https://images.pexels.com/photos/{photo_id}/pexels-photo-{photo_id}.jpeg?auto=compress&cs=tinysrgb&w=2400"

def fetch(url: str) -> tuple[bytes, str]:
    req = Request(url, headers={"User-Agent":"Mozilla/5.0 (Koa Events editorial media migration)"})
    with urlopen(req, timeout=45) as response:
        body = response.read()
        content_type = response.headers.get("content-type", "")
        final_url = response.geturl()
    if len(body) < 20_000:
        raise RuntimeError(f"Downloaded file is unexpectedly small: {len(body)} bytes from {url}")
    if "image" not in content_type.lower():
        raise RuntimeError(f"Expected image content from {url}; got {content_type}")
    return body, final_url

def main() -> None:
    manifest = {
        "provider":"Pexels",
        "license":LICENSE,
        "usageNote":"Editorial/design imagery. Koa's own migrated Wix photography is reserved for the Gallery page.",
        "assets":[],
    }

    for asset in ASSETS:
        url = download_url(asset["photo_id"])
        body, final_url = fetch(url)
        dest = OUT / asset["name"]
        dest.write_bytes(body)
        manifest["assets"].append({
            **asset,
            "path":"/media/editorial/" + asset["name"],
            "downloadUrl":final_url,
            "bytes":len(body),
            "sha256":hashlib.sha256(body).hexdigest(),
        })
        print(f"downloaded {asset['name']} ({len(body):,} bytes)")

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT / 'manifest.json'}")

if __name__ == "__main__":
    main()
