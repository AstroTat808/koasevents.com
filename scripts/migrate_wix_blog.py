#!/usr/bin/env python3
"""Migrate every legacy Koa's Events Wix blog post and its images into GitHub.

The generated src/data/wixBlogPosts.ts is the build-time source of truth for
legacy posts. Every featured and inline article image is downloaded beneath
public/media/blog/<slug>/ and all rendered image src values are rewritten to
local /media/blog/... paths so the new site has no runtime Wix image dependency.
"""
from __future__ import annotations

import hashlib
import html
import json
import mimetypes
import re
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup, Tag

BLOG_URL = "https://sibel122.wixsite.com/koas-events/blog"
SITE_ROOT = "https://sibel122.wixsite.com"
OUT_TS = Path("src/data/wixBlogPosts.ts")
IMAGE_ROOT = Path("public/media/blog")
UA = "Mozilla/5.0 (compatible; KoaEventsBlogMigration/2.0; +https://www.koasevents.com/)"

# The Wix blog listing lazy-loads older posts, so discovery alone is not reliable.
# Keep the complete known legacy inventory here and merge it with discovered URLs.
KNOWN_POSTS = [
    "https://sibel122.wixsite.com/koas-events/post/big-island-rainforest-wedding-venue-guide-how-to-plan-an-intimate-celebration-in-mountain-view-haw",
    "https://sibel122.wixsite.com/koas-events/post/koa-s-mobile-bar-frequently-asked-questions",
    "https://sibel122.wixsite.com/koas-events/post/the-comprehensive-a-z-wedding-glossary-for-brides-koa-s-events-edition",
    "https://sibel122.wixsite.com/koas-events/post/5-biggest-bachelorette-party-mistakes-and-how-to-avoid-them",
    "https://sibel122.wixsite.com/koas-events/post/real-brides-share-their-wedding-bachelorette-pain-points-and-how-koa-s-events-can-help-you-avoid",
    "https://sibel122.wixsite.com/koas-events/post/impact-of-tariffs-on-your-wedding-what-every-couple-should-know",
    "https://sibel122.wixsite.com/koas-events/post/micro-weddings-vs-traditional-weddings-choosing-the-perfect-style-for-your-special-day-at-koa-s-ev",
    "https://sibel122.wixsite.com/koas-events/post/how-to-have-a-beautiful-5-000-wedding-at-koa-s-events",
    "https://sibel122.wixsite.com/koas-events/post/micro-wedding-or-traditional-wedding",
    "https://sibel122.wixsite.com/koas-events/post/the-art-of-aloha-infusing-hawaiian-culture-into-modern-wedding",
    "https://sibel122.wixsite.com/koas-events/post/i-m-engaged-now-what",
]

FALLBACK_DATES = {
    "big-island-rainforest-wedding-venue-guide-how-to-plan-an-intimate-celebration-in-mountain-view-haw": "2026-02-04T12:00:00Z",
    "koa-s-mobile-bar-frequently-asked-questions": "2026-02-03T12:00:00Z",
    "the-comprehensive-a-z-wedding-glossary-for-brides-koa-s-events-edition": "2026-02-03T12:00:00Z",
    "5-biggest-bachelorette-party-mistakes-and-how-to-avoid-them": "2025-11-15T12:00:00Z",
    "real-brides-share-their-wedding-bachelorette-pain-points-and-how-koa-s-events-can-help-you-avoid": "2025-10-10T12:00:00Z",
    "impact-of-tariffs-on-your-wedding-what-every-couple-should-know": "2025-03-11T12:00:00Z",
    "micro-weddings-vs-traditional-weddings-choosing-the-perfect-style-for-your-special-day-at-koa-s-ev": "2025-02-24T12:00:00Z",
    "how-to-have-a-beautiful-5-000-wedding-at-koa-s-events": "2025-02-24T12:00:00Z",
    "micro-wedding-or-traditional-wedding": "2024-08-18T12:00:00Z",
    "the-art-of-aloha-infusing-hawaiian-culture-into-modern-wedding": "2024-08-18T12:00:00Z",
    "i-m-engaged-now-what": "2024-06-17T12:00:00Z",
}

SEO = {
    "big-island-rainforest-wedding-venue-guide-how-to-plan-an-intimate-celebration-in-mountain-view-haw": {
        "title": "Big Island Rainforest Wedding Venue Guide: Plan an Intimate Celebration in Mountain View, Hawaiʻi",
        "seoTitle": "Big Island Rainforest Wedding Venue Guide | Koa’s Events",
        "metaDescription": "Plan an intimate Big Island rainforest wedding in Mountain View, Hawaiʻi, with practical guidance on guest count, weather, timelines, vendors, and venue flow.",
        "category": "Hawaiʻi Weddings",
        "tags": ["Big Island wedding", "rainforest wedding", "Mountain View Hawaii", "intimate wedding", "wedding venue"],
        "featured": True,
    },
    "koa-s-mobile-bar-frequently-asked-questions": {
        "title": "Koa’s Mobile Bar FAQ: Wedding & Event Bar Service on Hawaiʻi Island",
        "seoTitle": "Koa’s Mobile Bar FAQ | Hawaiʻi Island Event Bar Service",
        "metaDescription": "Get answers about Koa’s Mobile Bar, including staffing, alcohol, service styles, setup, outdoor events, signature cocktails, and Hawaiʻi Island event logistics.",
        "category": "Mobile Bar",
        "tags": ["mobile bar", "wedding bar", "Hawaii bartending", "signature cocktails", "event bar service"],
        "featured": True,
    },
    "the-comprehensive-a-z-wedding-glossary-for-brides-koa-s-events-edition": {
        "title": "A–Z Wedding Glossary: Essential Terms Couples Should Know",
        "seoTitle": "A–Z Wedding Glossary: Essential Planning Terms | Koa’s Events",
        "metaDescription": "Decode wedding planning language with an A–Z glossary covering venues, catering, bar service, rentals, timelines, weather plans, photography, and guest experience.",
        "category": "Wedding Planning",
        "tags": ["wedding glossary", "wedding planning", "wedding terms", "destination wedding", "Hawaii wedding"],
        "featured": False,
    },
    "5-biggest-bachelorette-party-mistakes-and-how-to-avoid-them": {
        "title": "5 Bachelorette Party Mistakes to Avoid for a Stress-Free Celebration",
        "seoTitle": "5 Bachelorette Party Mistakes to Avoid | Koa’s Events",
        "metaDescription": "Avoid five common bachelorette party planning mistakes involving budget, timing, expectations, itineraries, and destination logistics for a smoother celebration.",
        "category": "Bachelorette Parties",
        "tags": ["bachelorette party", "party planning", "Hawaii bachelorette", "group travel", "celebration planning"],
        "featured": True,
    },
    "real-brides-share-their-wedding-bachelorette-pain-points-and-how-koa-s-events-can-help-you-avoid": {
        "title": "Real Brides Share Wedding & Bachelorette Party Pain Points—and How to Avoid Them",
        "seoTitle": "Wedding & Bachelorette Party Pain Points to Avoid | Koa’s Events",
        "metaDescription": "Learn from common wedding and bachelorette party pain points, including budget stress, group dynamics, planning overload, and ways to create a calmer celebration.",
        "category": "Bachelorette Parties",
        "tags": ["bride advice", "bachelorette planning", "wedding planning", "party stress", "Hawaii events"],
        "featured": False,
    },
    "impact-of-tariffs-on-your-wedding-what-every-couple-should-know": {
        "title": "Impact of Tariffs on Your Wedding: What Every Couple Should Know",
        "seoTitle": "How Tariffs Can Affect Wedding Costs | Koa’s Events",
        "metaDescription": "Understand how tariffs and imported-goods pricing can affect wedding décor, attire, rentals, flowers, and other planning costs, plus practical budgeting considerations.",
        "category": "Wedding Planning",
        "tags": ["wedding budget", "wedding costs", "tariffs", "wedding planning", "event rentals"],
        "featured": False,
    },
    "micro-weddings-vs-traditional-weddings-choosing-the-perfect-style-for-your-special-day-at-koa-s-ev": {
        "title": "Micro Weddings vs. Traditional Weddings: How to Choose the Right Celebration",
        "seoTitle": "Micro Wedding vs. Traditional Wedding | Koa’s Events",
        "metaDescription": "Compare micro weddings and traditional weddings by guest experience, budget, atmosphere, planning complexity, and priorities to decide which style fits you.",
        "category": "Wedding Planning",
        "tags": ["micro wedding", "traditional wedding", "intimate wedding", "wedding planning", "guest count"],
        "featured": False,
    },
    "how-to-have-a-beautiful-5-000-wedding-at-koa-s-events": {
        "title": "How to Plan a Beautiful $5,000 Wedding at Koa’s Events",
        "seoTitle": "How to Plan a Beautiful $5,000 Wedding | Koa’s Events",
        "metaDescription": "Explore a practical framework for planning a beautiful wedding around a $5,000 budget, with ideas for venue choices, food, décor, attire, photography, and priorities.",
        "category": "Budget Weddings",
        "tags": ["5000 wedding", "budget wedding", "affordable wedding", "Hawaii wedding", "wedding budget"],
        "featured": False,
    },
    "micro-wedding-or-traditional-wedding": {
        "title": "Micro Wedding or Traditional Wedding? A Quick Comparison",
        "seoTitle": "Micro Wedding or Traditional Wedding? Quick Comparison",
        "metaDescription": "Compare the feel of a micro wedding and a traditional wedding with a quick overview of guest count, atmosphere, priorities, and the kind of experience each creates.",
        "category": "Wedding Planning",
        "tags": ["micro wedding", "traditional wedding", "wedding comparison", "intimate wedding", "wedding planning"],
        "featured": False,
    },
    "the-art-of-aloha-infusing-hawaiian-culture-into-modern-wedding": {
        "title": "The Art of Aloha: Thoughtfully Bringing Hawaiian Culture Into a Modern Wedding",
        "seoTitle": "Hawaiian Wedding Inspiration: The Art of Aloha | Koa’s Events",
        "metaDescription": "Explore thoughtful ways to incorporate Hawaiʻi-inspired setting, hospitality, food, music, florals, and traditions into a modern wedding with care and intention.",
        "category": "Hawaiʻi Weddings",
        "tags": ["Hawaiian wedding", "aloha", "Hawaii wedding ideas", "wedding traditions", "destination wedding"],
        "featured": False,
    },
    "i-m-engaged-now-what": {
        "title": "Just Engaged? What to Do Next: A Wedding Planning Checklist",
        "seoTitle": "Just Engaged? What to Do Next | Wedding Planning Checklist",
        "metaDescription": "Newly engaged? Start with the right next steps for announcements, budget, guest count, priorities, venue research, and building a wedding plan that feels manageable.",
        "category": "Wedding Planning",
        "tags": ["just engaged", "wedding checklist", "wedding planning", "engagement", "wedding venue"],
        "featured": True,
    },
}

session = requests.Session()
session.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})


def get(url: str) -> requests.Response:
    last = None
    for attempt in range(4):
        try:
            response = session.get(url, timeout=45)
            response.raise_for_status()
            return response
        except Exception as exc:
            last = exc
            time.sleep(2**attempt)
    raise RuntimeError(f"Failed to fetch {url}: {last}")


def clean_text(value: str) -> str:
    value = html.unescape(value or "").replace("\u00a0", " ")
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n[ \t]+", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def meta(soup: BeautifulSoup, *, prop: str | None = None, name: str | None = None) -> str:
    attrs = {"property": prop} if prop else {"name": name}
    tag = soup.find("meta", attrs=attrs)
    return (tag.get("content") or "").strip() if tag else ""


def jsonld_objects(soup: BeautifulSoup):
    for node in soup.find_all("script", attrs={"type": "application/ld+json"}):
        raw = node.string or node.get_text() or ""
        if not raw.strip():
            continue
        try:
            data = json.loads(raw)
        except Exception:
            continue
        stack = data if isinstance(data, list) else [data]
        while stack:
            item = stack.pop()
            if isinstance(item, dict):
                yield item
                graph = item.get("@graph")
                if isinstance(graph, list):
                    stack.extend(graph)
            elif isinstance(item, list):
                stack.extend(item)


def first_article_jsonld(soup: BeautifulSoup) -> dict:
    for obj in jsonld_objects(soup):
        typ = obj.get("@type")
        types = typ if isinstance(typ, list) else [typ]
        if any(t in {"Article", "BlogPosting", "NewsArticle"} for t in types):
            return obj
    return {}


def discover_posts() -> list[str]:
    urls = list(KNOWN_POSTS)
    try:
        soup = BeautifulSoup(get(BLOG_URL).text, "html.parser")
        for anchor in soup.find_all("a", href=True):
            href = anchor["href"]
            if "/koas-events/post/" not in href:
                continue
            full = urljoin(SITE_ROOT, href).split("?")[0].split("#")[0]
            if full not in urls:
                urls.append(full)
    except Exception as exc:
        print(f"warning: listing discovery failed; using known inventory: {exc}", file=sys.stderr)
    return urls


def slug_from_url(url: str) -> str:
    return urlparse(url).path.rstrip("/").split("/")[-1]


def parse_date(value: str, fallback: str) -> str:
    value = (value or "").strip()
    if value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        except Exception:
            pass
        for fmt in ("%b %d, %Y", "%B %d, %Y", "%b %d %Y", "%b %d"):
            try:
                parsed = datetime.strptime(value, fmt)
                if "%Y" not in fmt:
                    parsed = parsed.replace(year=datetime.fromisoformat(fallback.replace("Z", "+00:00")).year)
                return parsed.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
            except Exception:
                pass
    return fallback


def choose_content_node(soup: BeautifulSoup) -> Tag | None:
    preferred = [
        '[data-hook="post-content"]',
        '[data-testid="post-content"]',
        '[data-hook="blog-post-description"]',
        '[data-hook="post-description"]',
    ]
    for selector in preferred:
        nodes = soup.select(selector)
        candidates = [n for n in nodes if len(clean_text(n.get_text("\n", strip=True))) >= 20]
        if candidates:
            return max(candidates, key=lambda n: len(clean_text(n.get_text("\n", strip=True))))

    articles = soup.find_all("article")
    if articles:
        return max(articles, key=lambda n: len(clean_text(n.get_text("\n", strip=True))))

    candidates = []
    for node in soup.find_all(["main", "section", "div"]):
        text = clean_text(node.get_text("\n", strip=True))
        if 100 <= len(text) <= 60000:
            candidates.append(node)
    return max(candidates, key=lambda n: len(clean_text(n.get_text("\n", strip=True)))) if candidates else None


def image_candidate(tag: Tag) -> str:
    for attr in ("src", "data-src", "data-original", "data-pin-media"):
        value = str(tag.get(attr) or "").strip()
        if value and not value.startswith("data:"):
            return value
    srcset = str(tag.get("srcset") or "").strip()
    if srcset:
        choices = [part.strip().split(" ")[0] for part in srcset.split(",") if part.strip()]
        if choices:
            return choices[-1]
    return ""


def normalize_remote_url(value: str) -> str:
    value = html.unescape(value or "").replace("\\/", "/").strip()
    if value.startswith("//"):
        return "https:" + value
    return value


def extension_for(response: requests.Response, remote_url: str) -> str:
    content_type = (response.headers.get("content-type") or "").split(";")[0].strip().lower()
    known = {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/avif": ".avif",
    }
    if content_type in known:
        return known[content_type]
    suffix = Path(urlparse(remote_url).path).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"}:
        return ".jpg" if suffix == ".jpeg" else suffix
    guessed = mimetypes.guess_extension(content_type) if content_type else None
    return guessed or ".jpg"


def download_image(remote_url: str, slug: str, label: str, cache: dict[str, str]) -> str:
    remote_url = normalize_remote_url(remote_url)
    if not remote_url:
        return ""
    if remote_url.startswith("/"):
        return remote_url
    if remote_url in cache:
        return cache[remote_url]

    candidates = [remote_url]
    if "static.wixstatic.com" in remote_url and "/v1/" in remote_url:
        # Wix occasionally emits an invalid zero-dimension transform URL
        # (for example /v1/fit/w_0,h_0,...). The original media object before
        # /v1/ remains fetchable and is the highest-quality source.
        original_media = remote_url.split("/v1/", 1)[0]
        if original_media not in candidates:
            candidates.append(original_media)

    response = None
    last_error = None
    resolved_url = remote_url
    for candidate in candidates:
        try:
            response = get(candidate)
            resolved_url = candidate
            break
        except Exception as exc:
            last_error = exc

    if response is None:
        raise RuntimeError(f"failed to download image {remote_url}: {last_error}")

    folder = IMAGE_ROOT / slug
    folder.mkdir(parents=True, exist_ok=True)
    ext = extension_for(response, resolved_url)
    digest = hashlib.sha1(remote_url.encode("utf-8")).hexdigest()[:10]
    safe_label = re.sub(r"[^a-z0-9-]+", "-", label.lower()).strip("-") or "image"
    path = folder / f"{safe_label}-{digest}{ext}"
    path.write_bytes(response.content)
    local = "/" + path.as_posix().replace("public/", "", 1)
    cache[remote_url] = local
    return local


def sanitize_and_localize(node: Tag | None, slug: str, title: str, cache: dict[str, str]) -> tuple[str, str, list[dict]]:
    if node is None:
        return "", "", []

    fragment = BeautifulSoup(str(node), "html.parser")
    root = fragment.find() or fragment

    for bad in root.select("script, style, svg, button, form, input, textarea, select, noscript, iframe"):
        bad.decompose()

    images: list[dict] = []
    for source in root.find_all("source"):
        source.decompose()

    for index, img in enumerate(root.find_all("img"), 1):
        remote = image_candidate(img)
        if not remote:
            img.decompose()
            continue
        try:
            local = download_image(remote, slug, f"inline-{index:02d}", cache)
        except Exception as exc:
            raise RuntimeError(f"inline image download failed for {slug}: {remote}: {exc}") from exc
        alt = clean_text(str(img.get("alt") or "")) or f"{title} — image {index}"
        img.attrs = {
            "src": local,
            "alt": alt,
            "loading": "lazy",
            "decoding": "async",
        }
        images.append({"src": local, "alt": alt})

    # Remove title/metadata duplicates when the fallback is a whole <article>.
    for heading in list(root.find_all("h1")):
        if clean_text(heading.get_text(" ", strip=True)).casefold() == clean_text(title).casefold():
            heading.decompose()

    metadata_re = re.compile(r"^(\d+\s+min\s+read|updated:|comments?|write a comment)$", re.I)
    for tag in list(root.find_all(["p", "span", "div"])):
        text = clean_text(tag.get_text(" ", strip=True))
        if text and len(text) < 80 and metadata_re.match(text):
            tag.decompose()

    # Strip Wix-specific presentation attributes and keep only semantic attributes.
    for tag in root.find_all(True):
        if tag.name == "a":
            href = str(tag.get("href") or "")
            tag.attrs = {"href": href} if href else {}
        elif tag.name == "img":
            pass
        else:
            tag.attrs = {}

    body_html = str(root)
    if root.name in {"article", "div", "section", "main"}:
        body_html = "".join(str(child) for child in root.contents)

    body_html = re.sub(r"\s+(class|style|id|data-[\w-]+)=(['\"]).*?\2", "", body_html, flags=re.I | re.S)
    body_html = body_html.strip()
    body_text = clean_text(BeautifulSoup(body_html, "html.parser").get_text("\n", strip=True))

    if "wixstatic.com" in body_html.lower() or "wixsite.com" in re.sub(r'href=["\'][^"\']+["\']', "", body_html, flags=re.I).lower():
        raise RuntimeError(f"unmigrated Wix media reference remains in article HTML for {slug}")

    return body_html, body_text, images


def extract_author(ld: dict, fallback: str) -> str:
    author = ld.get("author") or ""
    if isinstance(author, dict):
        author = author.get("name") or ""
    elif isinstance(author, list):
        author = ", ".join(str(x.get("name") if isinstance(x, dict) else x) for x in author)
    return clean_text(str(author)) or fallback


def extract_feature_url(ld: dict, soup: BeautifulSoup) -> str:
    image = ld.get("image") or meta(soup, prop="og:image")
    if isinstance(image, list):
        image = image[0] if image else ""
    if isinstance(image, dict):
        image = image.get("url") or image.get("contentUrl") or ""
    return normalize_remote_url(str(image or ""))


def parse_post(url: str) -> dict:
    slug = slug_from_url(url)
    fallback_date = FALLBACK_DATES.get(slug, "2024-01-01T12:00:00Z")
    response = get(url)
    soup = BeautifulSoup(response.text, "html.parser")
    ld = first_article_jsonld(soup)

    original_title = clean_text(
        str(ld.get("headline") or "")
        or meta(soup, prop="og:title")
        or (soup.find("h1").get_text(" ", strip=True) if soup.find("h1") else "")
    )
    if not original_title:
        raise RuntimeError("missing title")

    seo = SEO.get(slug, {})
    title = str(seo.get("title") or original_title)

    # Rebuild this post's image directory on every run so no stale Wix-era assets remain.
    folder = IMAGE_ROOT / slug
    if folder.exists():
        shutil.rmtree(folder)

    cache: dict[str, str] = {}
    feature_url = extract_feature_url(ld, soup)
    if not feature_url:
        raise RuntimeError("missing featured image URL")
    featured_image = download_image(feature_url, slug, "featured", cache)

    node = choose_content_node(soup)
    body_html, body, inline_images = sanitize_and_localize(node, slug, original_title, cache)

    # If a Wix page exposes only plain serialized article text, preserve it rather than
    # dropping the post. The page template will turn paragraphs into readable blocks.
    if len(body) < 20:
        for key in ("articleBody", "text", "description"):
            raw = ld.get(key)
            if raw:
                body = clean_text(BeautifulSoup(str(raw), "html.parser").get_text("\n", strip=True))
                if len(body) >= 20:
                    break

    if not body:
        body = clean_text(meta(soup, prop="og:description") or meta(soup, name="description"))
    if not body:
        raise RuntimeError("missing article body")

    description = str(seo.get("metaDescription") or "").strip()
    if not description:
        description = clean_text(str(ld.get("description") or "") or meta(soup, prop="og:description") or meta(soup, name="description"))
    if not description:
        clip = re.sub(r"\s+", " ", body)[:260]
        description = clip.rsplit(" ", 1)[0] + "…"

    published_at = parse_date(str(ld.get("datePublished") or ""), fallback_date)
    updated_at = parse_date(str(ld.get("dateModified") or ""), published_at)
    fallback_author = "Chris Sibel" if slug == "i-m-engaged-now-what" else "Shaun Sibel"

    all_images = [{"src": featured_image, "alt": original_title, "role": "featured"}]
    seen = {featured_image}
    for image in inline_images:
        if image["src"] not in seen:
            all_images.append({**image, "role": "inline"})
            seen.add(image["src"])

    return {
        "slug": slug,
        "originalTitle": original_title,
        "title": title,
        "seoTitle": str(seo.get("seoTitle") or title),
        "excerpt": description,
        "metaDescription": description,
        "body": body,
        "bodyHtml": body_html,
        "status": "published",
        "publishedAt": published_at,
        "updatedAt": updated_at,
        "featuredImage": featured_image,
        "images": all_images,
        "author": extract_author(ld, fallback_author),
        "category": str(seo.get("category") or "Wedding Planning"),
        "tags": list(seo.get("tags") or []),
        "featured": bool(seo.get("featured")),
        "originalUrl": url,
    }


def ts(value) -> str:
    return json.dumps(value, ensure_ascii=False)


def write_ts(posts: list[dict]):
    posts.sort(key=lambda item: item["publishedAt"], reverse=True)
    lines = [
        "export type ImportedBlogImage = {",
        "  src: string;",
        "  alt: string;",
        "  role: 'featured' | 'inline';",
        "};",
        "",
        "export type ImportedBlogPost = {",
        "  slug: string;",
        "  originalTitle: string;",
        "  title: string;",
        "  seoTitle: string;",
        "  excerpt: string;",
        "  metaDescription: string;",
        "  body: string;",
        "  bodyHtml: string;",
        "  status: 'published';",
        "  publishedAt: string;",
        "  updatedAt: string;",
        "  featuredImage: string;",
        "  images: ImportedBlogImage[];",
        "  author: string;",
        "  category: string;",
        "  tags: string[];",
        "  featured: boolean;",
        "  originalUrl: string;",
        "};",
        "",
        "// Generated by scripts/migrate_wix_blog.py. Do not hand-edit.",
        "export const wixBlogPosts: ImportedBlogPost[] = [",
    ]

    keys = [
        "slug", "originalTitle", "title", "seoTitle", "excerpt", "metaDescription",
        "body", "bodyHtml", "status", "publishedAt", "updatedAt", "featuredImage",
        "images", "author", "category", "tags", "featured", "originalUrl",
    ]
    for post in posts:
        lines.append("  {")
        for key in keys:
            lines.append(f"    {key}: {ts(post[key])},")
        lines.append("  },")
    lines += ["];",""]
    OUT_TS.parent.mkdir(parents=True, exist_ok=True)
    OUT_TS.write_text("\n".join(lines), encoding="utf-8")


def verify(posts: list[dict]):
    if len(posts) != 11:
        raise RuntimeError(f"expected exactly 11 legacy Wix posts; imported {len(posts)}")

    failures = []
    for post in posts:
        if not post["featuredImage"].startswith("/media/blog/"):
            failures.append(f"{post['slug']}: featured image is not local")
        local_feature = Path("public") / post["featuredImage"].lstrip("/")
        if not local_feature.exists():
            failures.append(f"{post['slug']}: featured image file missing: {local_feature}")
        if "wixstatic.com" in post["bodyHtml"].lower():
            failures.append(f"{post['slug']}: bodyHtml still references wixstatic.com")
        for image in post["images"]:
            if not image["src"].startswith("/media/blog/"):
                failures.append(f"{post['slug']}: non-local image src {image['src']}")
            image_file = Path("public") / image["src"].lstrip("/")
            if not image_file.exists():
                failures.append(f"{post['slug']}: missing image file {image_file}")

    if failures:
        raise RuntimeError("Wix-independence verification failed:\n- " + "\n- ".join(failures))


def main():
    urls = discover_posts()
    print(f"Legacy inventory: {len(urls)} post URLs")
    posts = []
    errors = []
    for index, url in enumerate(urls, 1):
        print(f"[{index}/{len(urls)}] {url}", flush=True)
        try:
            posts.append(parse_post(url))
        except Exception as exc:
            errors.append(f"{url}: {exc}")
            print(f"ERROR: {url}: {exc}", file=sys.stderr, flush=True)

    known_slugs = {slug_from_url(url) for url in KNOWN_POSTS}
    posts = [post for post in posts if post["slug"] in known_slugs]

    if errors:
        raise SystemExit("Migration stopped because one or more known posts failed:\n- " + "\n- ".join(errors))

    verify(posts)
    write_ts(posts)
    total_images = sum(len(post["images"]) for post in posts)
    print(f"Wrote {len(posts)} posts and {total_images} local image references to {OUT_TS}")
    print("Verified: no rendered legacy blog image depends on Wix.")


if __name__ == "__main__":
    main()
