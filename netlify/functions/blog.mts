import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { requireAdmin } from './_shared/admin';

type BlogPost = {
  slug: string;
  title: string;
  excerpt: string;
  body: string;
  status: 'draft' | 'published';
  publishedAt: string;
  updatedAt: string;
  featuredImage?: string;
  author?: string;
  originalUrl?: string;
};

const WIX_BLOG_URL = 'https://sibel122.wixsite.com/koas-events/blog';
const WIX_SITE_ROOT = 'https://sibel122.wixsite.com';
const IMPORT_MARKER = 'migration/wix-blog-complete-v1';

function storeFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-blog', consistency: 'strong' })
    : getDeployStore({ name: 'koa-blog' });
}

function decodeHtml(value = '') {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2019;/gi, '’')
    .replace(/&#x2013;/gi, '–')
    .replace(/&#x2014;/gi, '—')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(value = '') {
  return decodeHtml(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>|<\/div>|<\/li>|<\/h[1-6]>|<\/section>|<\/article>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function meta(html: string, key: string, value: string) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const keyMatch = tag.match(new RegExp('\\b' + key + '=["\\\']([^"\\\']+)["\\\']', 'i'));
    if (!keyMatch || keyMatch[1] !== value) continue;
    const content = tag.match(/\bcontent=["']([^"']*)["']/i);
    if (content) return decodeHtml(content[1]);
  }
  return '';
}

function jsonLdObjects(html: string): any[] {
  const out: any[] = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    try {
      const parsed = JSON.parse(decodeHtml(match[1]));
      const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (stack.length) {
        const item = stack.pop();
        if (!item) continue;
        if (Array.isArray(item)) stack.push(...item);
        else if (typeof item === 'object') {
          out.push(item);
          if (Array.isArray(item['@graph'])) stack.push(...item['@graph']);
        }
      }
    } catch {}
  }
  return out;
}

function articleJsonLd(html: string) {
  return (
    jsonLdObjects(html).find((item) => {
      const type = item?.['@type'];
      const types = Array.isArray(type) ? type : [type];
      return types.some((t) => ['Article', 'BlogPosting', 'NewsArticle'].includes(String(t)));
    }) || {}
  );
}

function normalizeDate(value: string) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function excerptFrom(body: string) {
  const text = body.replace(/\s+/g, ' ').trim();
  if (text.length <= 240) return text;
  const clipped = text.slice(0, 240);
  return clipped.slice(0, Math.max(clipped.lastIndexOf(' '), 180)).trim() + '…';
}

function discoverWixPostUrls(html: string) {
  const urls = new Set<string>();
  const patterns = [
    /href=["']([^"']*\/koas-events\/post\/[^"'?#]+)[^"']*["']/gi,
    /https?:\\?\/\\?\/sibel122\.wixsite\.com\\?\/koas-events\\?\/post\\?\/[^"\\\s<]+/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html))) {
      let href = match[1] || match[0];
      href = href.replace(/\\\//g, '/').replace(/&amp;/g, '&').split('?')[0].split('#')[0];
      try {
        const url = new URL(href, WIX_SITE_ROOT);
        if (url.hostname === 'sibel122.wixsite.com' && url.pathname.includes('/koas-events/post/')) {
          urls.add(url.toString());
        }
      } catch {}
    }
  }
  return [...urls];
}

function extractArticleBody(html: string, title: string, ld: any) {
  const ldBody = ld?.articleBody || ld?.text;
  if (typeof ldBody === 'string' && ldBody.trim().length > 200) return stripTags(ldBody);

  const selectors = [
    /<[^>]+data-hook=["']post-content["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
    /<[^>]+data-hook=["']post-description["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
  ];
  const candidates: string[] = [];
  for (const re of selectors) {
    const match = html.match(re);
    if (match?.[1]) {
      const text = stripTags(match[1]);
      if (text.length > 200) candidates.push(text);
    }
  }

  // Wix stores rich post text in serialized hydration data. Pull long text
  // strings as a fallback and select the most article-like candidate.
  const serialized = html.match(/"(?:text|content|articleBody|plainText)"\s*:\s*"((?:\\.|[^"\\]){250,})"/gi) || [];
  for (const item of serialized) {
    const raw = item.slice(item.indexOf(':') + 1).trim();
    try {
      const decoded = JSON.parse(raw);
      const text = stripTags(String(decoded));
      if (text.length > 300) candidates.push(text);
    } catch {}
  }

  let body = candidates.sort((a, b) => b.length - a.length)[0] || '';
  if (title && body.startsWith(title)) body = body.slice(title.length).trim();
  return body;
}

async function fetchText(url: string) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; KoaEventsBlogMigration/1.0; +https://koasevents.com/)',
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  if (!response.ok) throw new Error(`Wix fetch failed: ${response.status} ${url}`);
  return response.text();
}

async function importWixPosts(context: Context): Promise<BlogPost[]> {
  const store = storeFor(context);
  const current = ((await store.get('posts/index', { type: 'json' })) || []) as BlogPost[];
  const marker = await store.get(IMPORT_MARKER, { type: 'json' });
  if (marker) return current;

  try {
    const indexHtml = await fetchText(WIX_BLOG_URL);
    const urls = discoverWixPostUrls(indexHtml);
    if (!urls.length) return current;

    const imported: BlogPost[] = [];
    for (const url of urls) {
      try {
        const html = await fetchText(url);
        const ld = articleJsonLd(html);
        const title = stripTags(
          String(ld?.headline || meta(html, 'property', 'og:title') || (html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || ''))
        );
        if (!title) continue;

        const slug = new URL(url).pathname.split('/').filter(Boolean).pop() || title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const body = extractArticleBody(html, title, ld);
        if (!body || body.length < 150) continue;

        let author = '';
        if (typeof ld?.author === 'string') author = ld.author;
        else if (Array.isArray(ld?.author)) author = ld.author.map((a: any) => a?.name || a).join(', ');
        else author = ld?.author?.name || '';

        let featuredImage = ld?.image || meta(html, 'property', 'og:image');
        if (Array.isArray(featuredImage)) featuredImage = featuredImage[0] || '';
        if (featuredImage && typeof featuredImage === 'object') featuredImage = featuredImage.url || featuredImage.contentUrl || '';

        const publishedAt = normalizeDate(String(ld?.datePublished || ''));
        imported.push({
          slug,
          title,
          excerpt: stripTags(String(ld?.description || meta(html, 'property', 'og:description') || meta(html, 'name', 'description'))) || excerptFrom(body),
          body,
          status: 'published',
          publishedAt,
          updatedAt: new Date().toISOString(),
          featuredImage: String(featuredImage || ''),
          author: stripTags(String(author || 'Koa’s Events')),
          originalUrl: url,
        });
      } catch (error) {
        console.warn('Skipping Wix post', url, error);
      }
    }

    if (!imported.length) return current;

    // Existing admin-created posts take precedence over a matching imported slug.
    const bySlug = new Map(imported.map((post) => [post.slug, post]));
    for (const post of current) bySlug.set(post.slug, post);
    const merged = [...bySlug.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    await store.setJSON('posts/index', merged);
    await store.setJSON(IMPORT_MARKER, {
      completedAt: new Date().toISOString(),
      source: WIX_BLOG_URL,
      importedCount: imported.length,
    });
    return merged;
  } catch (error) {
    console.warn('Wix blog import deferred', error);
    return current;
  }
}

async function readPosts(context: Context): Promise<BlogPost[]> {
  const store = storeFor(context);
  const posts = ((await store.get('posts/index', { type: 'json' })) || []) as BlogPost[];
  if (context.deploy.context === 'production' && !posts.length) {
    return importWixPosts(context);
  }
  return posts;
}

export default async (req: Request, context: Context) => {
  const store = storeFor(context);

  if (req.method === 'GET') {
    const posts = await readPosts(context);
    const url = new URL(req.url);
    const admin = url.searchParams.get('admin') === '1';
    if (admin) {
      const auth = await requireAdmin();
      if (auth.response) return auth.response;
      return Response.json({ posts });
    }
    return Response.json({
      posts: posts
        .filter((post) => post.status === 'published')
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)),
    });
  }

  const auth = await requireAdmin();
  if (auth.response) return auth.response;

  if (req.method === 'POST') {
    const payload = await req.json();
    const action = payload.action || 'save';
    const posts = await readPosts(context);

    if (action === 'delete') {
      const next = posts.filter((post) => post.slug !== payload.slug);
      await store.setJSON('posts/index', next);
      return Response.json({ ok: true, posts: next });
    }

    if (action === 'import-wix') {
      await store.delete(IMPORT_MARKER);
      const next = await importWixPosts(context);
      return Response.json({ ok: true, posts: next });
    }

    const slug = String(payload.slug || payload.title || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    if (!slug || !payload.title) {
      return Response.json({ error: 'Title and slug are required.' }, { status: 400 });
    }

    const now = new Date().toISOString();
    const existing = posts.find((post) => post.slug === slug);
    const post: BlogPost = {
      slug,
      title: String(payload.title),
      excerpt: String(payload.excerpt || ''),
      body: String(payload.body || ''),
      status: payload.status === 'published' ? 'published' : 'draft',
      publishedAt: existing?.publishedAt || String(payload.publishedAt || now),
      updatedAt: now,
      featuredImage: String(payload.featuredImage || existing?.featuredImage || ''),
      author: String(payload.author || existing?.author || 'Koa’s Events'),
      originalUrl: existing?.originalUrl,
    };
    const next = [post, ...posts.filter((item) => item.slug !== slug)];
    await store.setJSON('posts/index', next);
    return Response.json({ ok: true, post, posts: next });
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config: Config = {
  path: '/api/blog',
};
