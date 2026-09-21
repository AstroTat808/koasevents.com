import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { isApprovedManager, requireOperations } from './_shared/admin';
import { wixBlogPosts } from '../../src/data/wixBlogPosts';

type BlogPost = {
  slug: string;
  originalTitle?: string;
  title: string;
  seoTitle?: string;
  excerpt: string;
  metaDescription?: string;
  body: string;
  bodyHtml?: string;
  status: 'draft' | 'published';
  publishedAt: string;
  updatedAt: string;
  featuredImage?: string;
  images?: Array<{ src: string; alt: string; role: 'featured' | 'inline' }>;
  author?: string;
  category?: string;
  tags?: string[];
  featured?: boolean;
  originalUrl?: string;
};

function storeFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-blog', consistency: 'strong' })
    : getDeployStore({ name: 'koa-blog' });
}

function legacySeed(): BlogPost[] {
  return wixBlogPosts.map((post) => ({ ...post })) as BlogPost[];
}

async function readPosts(context: Context): Promise<BlogPost[]> {
  const store = storeFor(context);
  const stored = ((await store.get('posts/index', { type: 'json' })) || []) as BlogPost[];

  if (!stored.length) {
    const seeded = legacySeed();
    if (seeded.length) await store.setJSON('posts/index', seeded);
    return seeded;
  }

  return stored;
}

export default async (req: Request, context: Context) => {
  const store = storeFor(context);

  if (req.method === 'GET') {
    const posts = await readPosts(context);
    const url = new URL(req.url);
    const admin = url.searchParams.get('admin') === '1';

    if (admin) {
      const auth = await requireOperations();
      if (auth.response) return auth.response;
      return Response.json({ posts: posts.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)) });
    }

    return Response.json({
      posts: posts
        .filter((post) => post.status === 'published')
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)),
    });
  }

  const auth = await requireOperations();
  if (auth.response) return auth.response;

  if (req.method === 'POST') {
    const payload = await req.json();
    const action = payload.action || 'save';
    const posts = await readPosts(context);
    const isManager = isApprovedManager(auth.user);

    if (['delete','restore-legacy'].includes(action) && !isManager) {
      return Response.json({ error: 'Manager permission required for this action.' }, { status: 403 });
    }
    if (action === 'save' && payload.status === 'published' && !isManager) {
      return Response.json({ error: 'Only managers can publish blog posts. Save this entry as a draft.' }, { status: 403 });
    }

    if (action === 'delete') {
      const next = posts.filter((post) => post.slug !== payload.slug);
      await store.setJSON('posts/index', next);
      return Response.json({ ok: true, posts: next });
    }

    if (action === 'restore-legacy') {
      const bySlug = new Map(posts.map((post) => [post.slug, post]));
      for (const post of legacySeed()) {
        if (!bySlug.has(post.slug)) bySlug.set(post.slug, post);
      }
      const next = [...bySlug.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
      await store.setJSON('posts/index', next);
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
      originalTitle: existing?.originalTitle,
      title: String(payload.title),
      seoTitle: String(payload.seoTitle || existing?.seoTitle || payload.title),
      excerpt: String(payload.excerpt || ''),
      metaDescription: String(payload.metaDescription || existing?.metaDescription || payload.excerpt || ''),
      body: String(payload.body || ''),
      bodyHtml: existing?.bodyHtml,
      status: payload.status === 'published' ? 'published' : 'draft',
      publishedAt: existing?.publishedAt || String(payload.publishedAt || now),
      updatedAt: now,
      featuredImage: String(payload.featuredImage || existing?.featuredImage || ''),
      images: existing?.images || [],
      author: String(payload.author || existing?.author || 'Koa’s Events'),
      category: String(payload.category || existing?.category || 'Wedding Planning'),
      tags: Array.isArray(payload.tags)
        ? payload.tags.map(String)
        : String(payload.tags || existing?.tags?.join(',') || '')
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
      featured: Boolean(payload.featured ?? existing?.featured ?? false),
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
