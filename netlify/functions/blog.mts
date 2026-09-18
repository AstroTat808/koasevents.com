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
};

function storeFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-blog', consistency: 'strong' })
    : getDeployStore({ name: 'koa-blog' });
}

async function readPosts(context: Context): Promise<BlogPost[]> {
  const store = storeFor(context);
  return (await store.get('posts/index', { type: 'json' })) || [];
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
