#!/usr/bin/env python3
"""Import Koa's Events Wix blog into a static TypeScript seed file.

The script discovers every Wix post from the public blog index, extracts
metadata and readable article content, downloads featured images, and writes
src/data/wixBlogPosts.ts. It is safe to run repeatedly.
"""
from __future__ import annotations

import html
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

BLOG_URL = "https://sibel122.wixsite.com/koas-events/blog"
SITE_ROOT = "https://sibel122.wixsite.com"
OUT_TS = Path("src/data/wixBlogPosts.ts")
IMAGE_DIR = Path("public/media/blog")
UA = "Mozilla/5.0 (compatible; KoaEventsBlogMigration/1.0; +https://koasevents.com/)"

session = requests.Session()
session.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})


def get(url: str) -> requests.Response:
    last = None
    for attempt in range(4):
        try:
            r = session.get(url, timeout=45)
            r.raise_for_status()
            return r
        except Exception as exc:
            last = exc
            time.sleep(2 ** attempt)
    raise RuntimeError(f"Failed to fetch {url}: {last}")


def slugify(value: str) -> str:
    value = html.unescape(value).lower().replace("’", "").replace("'", "")
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")


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
    soup = BeautifulSoup(get(BLOG_URL).text, "html.parser")
    urls = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if "/koas-events/post/" in href:
            full = urljoin(SITE_ROOT, href)
            full = full.split("?")[0].split("#")[0]
            if full not in urls:
                urls.append(full)

    # Wix occasionally emits post URLs only inside serialized page state.
    if not urls:
        for match in re.findall(r'https?:\\/\\/sibel122\\.wixsite\\.com\\/koas-events\\/post\\/[^"\\\\]+', str(soup)):
            full = match.replace("\\/", "/")
            if full not in urls:
                urls.append(full)
    return urls


def clean_text(value: str) -> str:
    value = html.unescape(value or "")
    value = value.replace("\u00a0", " ")
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n[ \t]+", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def extract_body(soup: BeautifulSoup, title: str) -> str:
    # Prefer explicit Wix post-content hooks when present.
    selectors = [
        '[data-hook="post-content"]',
        '[data-hook="post-description"]',
        '[data-hook="blog-post-description"]',
        '[data-testid="post-content"]',
        'article',
    ]
    candidates = []
    for selector in selectors:
        for node in soup.select(selector):
            text = clean_text(node.get_text("\n", strip=True))
            if text:
                candidates.append(text)

    # Wix SSR markup changes over time. As a fallback, locate the largest
    # content-like container that includes substantial prose but not the whole page.
    if not candidates:
        for node in soup.find_all(["div", "section"]):
            text = clean_text(node.get_text("\n", strip=True))
            if 500 <= len(text) <= 50000:
                candidates.append(text)

    if not candidates:
        ld = first_article_jsonld(soup)
        for key in ("articleBody", "text", "description"):
            if ld.get(key):
                return clean_text(str(ld[key]))
        return ""

    body = max(candidates, key=len)
    # Remove duplicated title if it leads the extracted article container.
    if title and body.startswith(title):
        body = body[len(title):].lstrip(" \n-–—")
    # Remove common Wix interaction/footer labels that can leak into article text.
    lines = []
    stop_phrases = {"recent posts", "see all", "comments", "write a comment"}
    for line in body.splitlines():
        t = line.strip()
        if not t:
            if lines and lines[-1] != "":
                lines.append("")
            continue
        if t.lower() in stop_phrases:
            continue
        lines.append(t)
    return clean_text("\n".join(lines))


def parse_date(value: str) -> str:
    value = (value or "").strip()
    if not value:
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    # Preserve ISO dates directly.
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        pass
    for fmt in ("%b %d, %Y", "%B %d, %Y", "%b %d %Y"):
        try:
            return datetime.strptime(value, fmt).replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
        except Exception:
            pass
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def download_image(url: str, slug: str) -> str:
    if not url:
        return ""
    try:
        r = get(url)
    except Exception as exc:
        print(f"warning: featured image fetch failed for {slug}: {exc}", file=sys.stderr)
        return url

    ctype = (r.headers.get("content-type") or "").lower()
    ext = ".webp" if "webp" in ctype else ".png" if "png" in ctype else ".jpg"
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    path = IMAGE_DIR / f"{slug}{ext}"
    path.write_bytes(r.content)
    return "/" + path.as_posix().replace("public/", "", 1)


def parse_post(url: str) -> dict:
    soup = BeautifulSoup(get(url).text, "html.parser")
    ld = first_article_jsonld(soup)

    title = clean_text(
        str(ld.get("headline") or "")
        or meta(soup, prop="og:title")
        or (soup.find("h1").get_text(" ", strip=True) if soup.find("h1") else "")
    )
    slug = urlparse(url).path.rstrip("/").split("/")[-1] or slugify(title)

    desc = clean_text(
        str(ld.get("description") or "")
        or meta(soup, prop="og:description")
        or meta(soup, name="description")
    )
    body = extract_body(soup, title)

    author = ld.get("author") or ""
    if isinstance(author, dict):
        author = author.get("name") or ""
    elif isinstance(author, list):
        author = ", ".join(str(x.get("name") if isinstance(x, dict) else x) for x in author)
    author = clean_text(str(author))

    date = str(ld.get("datePublished") or "")
    if not date:
        time_node = soup.find("time")
        date = time_node.get("datetime") if time_node and time_node.get("datetime") else (time_node.get_text(" ", strip=True) if time_node else "")

    image = ld.get("image") or meta(soup, prop="og:image")
    if isinstance(image, list):
        image = image[0] if image else ""
    if isinstance(image, dict):
        image = image.get("url") or image.get("contentUrl") or ""
    featured = download_image(str(image or ""), slug)

    if not desc and body:
        desc = clean_text(body[:260]).rsplit(" ", 1)[0] + "…"

    return {
        "slug": slug,
        "title": title,
        "excerpt": desc,
        "body": body,
        "status": "published",
        "publishedAt": parse_date(date),
        "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "featuredImage": featured,
        "author": author,
        "originalUrl": url,
    }


def ts_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def write_ts(posts: list[dict]):
    posts.sort(key=lambda x: x["publishedAt"], reverse=True)
    lines = [
        "export type ImportedBlogPost = {",
        "  slug: string;",
        "  title: string;",
        "  excerpt: string;",
        "  body: string;",
        "  status: 'published';",
        "  publishedAt: string;",
        "  updatedAt: string;",
        "  featuredImage?: string;",
        "  author?: string;",
        "  originalUrl?: string;",
        "};",
        "",
        "// Generated by scripts/migrate_wix_blog.py. Do not hand-edit.",
        "export const wixBlogPosts: ImportedBlogPost[] = [",
    ]
    for p in posts:
        lines += [
            "  {",
            f"    slug: {ts_string(p['slug'])},",
            f"    title: {ts_string(p['title'])},",
            f"    excerpt: {ts_string(p['excerpt'])},",
            f"    body: {ts_string(p['body'])},",
            "    status: 'published',",
            f"    publishedAt: {ts_string(p['publishedAt'])},",
            f"    updatedAt: {ts_string(p['updatedAt'])},",
            f"    featuredImage: {ts_string(p['featuredImage'])},",
            f"    author: {ts_string(p['author'])},",
            f"    originalUrl: {ts_string(p['originalUrl'])},",
            "  },",
        ]
    lines += ["];\n"]
    OUT_TS.write_text("\n".join(lines), encoding="utf-8")


def main():
    urls = discover_posts()
    if not urls:
        raise SystemExit("No Wix blog post URLs discovered.")
    print(f"Discovered {len(urls)} Wix blog posts.")
    posts = []
    for i, url in enumerate(urls, 1):
        print(f"[{i}/{len(urls)}] {url}")
        try:
            post = parse_post(url)
        except Exception as exc:
            print(f"ERROR importing {url}: {exc}", file=sys.stderr)
            continue
        if post["title"] and post["body"]:
            posts.append(post)
        else:
            print(f"warning: skipped incomplete post {url}", file=sys.stderr)

    if not posts:
        raise SystemExit("No complete Wix posts were imported.")
    OUT_TS.parent.mkdir(parents=True, exist_ok=True)
    write_ts(posts)
    print(f"Wrote {len(posts)} posts to {OUT_TS}")


if __name__ == "__main__":
    main()
