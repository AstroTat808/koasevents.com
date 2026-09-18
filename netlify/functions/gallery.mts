import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { requireAdmin } from './_shared/admin';

type GalleryItem = {
  id: string;
  alt: string;
  category: string;
  contentType: string;
  createdAt: string;
};

type GalleryState = {
  uploads: GalleryItem[];
  hiddenCurated: string[];
};

function storeFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-gallery', consistency: 'strong' })
    : getDeployStore({ name: 'koa-gallery' });
}

async function readState(context: Context): Promise<GalleryState> {
  const store = storeFor(context);
  return (await store.get('gallery/index', { type: 'json' })) || { uploads: [], hiddenCurated: [] };
}

export default async (req: Request, context: Context) => {
  const store = storeFor(context);
  const url = new URL(req.url);
  const imageId = context.params.id;

  if (req.method === 'GET' && imageId) {
    const state = await readState(context);
    const item = state.uploads.find((entry) => entry.id === imageId);
    if (!item) return new Response('Not found', { status: 404 });
    const data = await store.get('images/' + imageId, { type: 'arrayBuffer' });
    if (!data) return new Response('Not found', { status: 404 });
    return new Response(data, {
      headers: {
        'Content-Type': item.contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  }

  if (req.method === 'GET') {
    const state = await readState(context);
    return Response.json({
      uploads: state.uploads.map((item) => ({
        ...item,
        src: '/api/gallery/image/' + item.id,
      })),
      hiddenCurated: state.hiddenCurated,
    });
  }

  const auth = await requireAdmin();
  if (auth.response) return auth.response;

  if (req.method === 'POST') {
    const contentType = req.headers.get('content-type') || '';
    const state = await readState(context);

    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file');
      if (!(file instanceof File)) {
        return Response.json({ error: 'Image file is required.' }, { status: 400 });
      }
      if (!file.type.startsWith('image/')) {
        return Response.json({ error: 'Only image uploads are allowed.' }, { status: 400 });
      }
      if (file.size > 5_500_000) {
        return Response.json({ error: 'Image must be under 5.5 MB after optimization.' }, { status: 400 });
      }

      const id = crypto.randomUUID();
      const item: GalleryItem = {
        id,
        alt: String(form.get('alt') || 'Koa’s Events gallery image'),
        category: String(form.get('category') || 'Venue'),
        contentType: file.type,
        createdAt: new Date().toISOString(),
      };
      await store.set('images/' + id, await file.arrayBuffer());
      const next = { ...state, uploads: [item, ...state.uploads] };
      await store.setJSON('gallery/index', next);
      return Response.json({ ok: true, item: { ...item, src: '/api/gallery/image/' + id } });
    }

    const payload = await req.json();
    if (payload.action === 'visibility') {
      const src = String(payload.src || '');
      const hidden = Boolean(payload.hidden);
      const hiddenCurated = new Set(state.hiddenCurated);
      hidden ? hiddenCurated.add(src) : hiddenCurated.delete(src);
      const next = { ...state, hiddenCurated: [...hiddenCurated] };
      await store.setJSON('gallery/index', next);
      return Response.json({ ok: true, hiddenCurated: next.hiddenCurated });
    }

    if (payload.action === 'delete-upload') {
      const id = String(payload.id || '');
      await store.delete('images/' + id);
      const next = { ...state, uploads: state.uploads.filter((item) => item.id !== id) };
      await store.setJSON('gallery/index', next);
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'Unknown action.' }, { status: 400 });
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config: Config = {
  path: ['/api/gallery', '/api/gallery/image/:id'],
};
