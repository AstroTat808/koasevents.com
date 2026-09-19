import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { requireAdmin } from './_shared/admin';

const galleryCategories = ['Venue', 'Ceremony', 'Reception', 'Mobile Bar', 'Enhancements', 'Hospitality', 'Stay'] as const;
const curatedCategories = [...galleryCategories, 'Legacy Archive'] as const;

type GalleryCategory = (typeof galleryCategories)[number];
type CuratedCategory = (typeof curatedCategories)[number];

type GalleryItem = {
  id: string;
  alt: string;
  category: GalleryCategory;
  contentType: string;
  createdAt: string;
  focalX?: number;
  focalY?: number;
};

type CuratedEdit = {
  category?: CuratedCategory;
  focalX?: number;
  focalY?: number;
  updatedAt?: string;
};

type GalleryState = {
  uploads: GalleryItem[];
  hiddenCurated: string[];
  curatedEdits: Record<string, CuratedEdit>;
};

function storeFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-gallery', consistency: 'strong' })
    : getDeployStore({ name: 'koa-gallery' });
}

function clampFocal(value: unknown, fallback = 50) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(100, Math.round(parsed * 10) / 10));
}

function normalizeGalleryCategory(value: unknown, fallback: GalleryCategory = 'Venue'): GalleryCategory {
  const category = String(value || '');
  return galleryCategories.includes(category as GalleryCategory) ? (category as GalleryCategory) : fallback;
}

function normalizeCuratedCategory(value: unknown, fallback: CuratedCategory = 'Venue'): CuratedCategory {
  const category = String(value || '');
  return curatedCategories.includes(category as CuratedCategory) ? (category as CuratedCategory) : fallback;
}

async function readState(context: Context): Promise<GalleryState> {
  const store = storeFor(context);
  const saved = (await store.get('gallery/index', { type: 'json' })) as Partial<GalleryState> | null;
  return {
    uploads: Array.isArray(saved?.uploads) ? saved.uploads : [],
    hiddenCurated: Array.isArray(saved?.hiddenCurated) ? saved.hiddenCurated : [],
    curatedEdits: saved?.curatedEdits && typeof saved.curatedEdits === 'object' ? saved.curatedEdits : {},
  };
}

export default async (req: Request, context: Context) => {
  const store = storeFor(context);
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
        category: normalizeGalleryCategory(item.category),
        focalX: clampFocal(item.focalX),
        focalY: clampFocal(item.focalY),
        src: '/api/gallery/image/' + item.id,
      })),
      hiddenCurated: state.hiddenCurated,
      curatedEdits: state.curatedEdits,
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
        category: normalizeGalleryCategory(form.get('category')),
        contentType: file.type,
        createdAt: new Date().toISOString(),
        focalX: 50,
        focalY: 50,
      };
      await store.set('images/' + id, await file.arrayBuffer());
      const next: GalleryState = { ...state, uploads: [item, ...state.uploads] };
      await store.setJSON('gallery/index', next);
      return Response.json({ ok: true, item: { ...item, src: '/api/gallery/image/' + id } });
    }

    const payload = await req.json();

    if (payload.action === 'visibility') {
      const src = String(payload.src || '');
      const hidden = Boolean(payload.hidden);
      const hiddenCurated = new Set(state.hiddenCurated);
      hidden ? hiddenCurated.add(src) : hiddenCurated.delete(src);
      const next: GalleryState = { ...state, hiddenCurated: [...hiddenCurated] };
      await store.setJSON('gallery/index', next);
      return Response.json({ ok: true, hiddenCurated: next.hiddenCurated });
    }

    if (payload.action === 'update-upload') {
      const id = String(payload.id || '');
      const existing = state.uploads.find((item) => item.id === id);
      if (!existing) return Response.json({ error: 'Uploaded image not found.' }, { status: 404 });

      const uploads = state.uploads.map((item) =>
        item.id === id
          ? {
              ...item,
              category: normalizeGalleryCategory(payload.category, normalizeGalleryCategory(item.category)),
              focalX: clampFocal(payload.focalX, clampFocal(item.focalX)),
              focalY: clampFocal(payload.focalY, clampFocal(item.focalY)),
            }
          : item,
      );
      const next: GalleryState = { ...state, uploads };
      await store.setJSON('gallery/index', next);
      return Response.json({ ok: true });
    }

    if (payload.action === 'update-curated') {
      const src = String(payload.src || '');
      if (!src.startsWith('/')) return Response.json({ error: 'Curated image source is required.' }, { status: 400 });

      const existing = state.curatedEdits[src] || {};
      const nextEdit: CuratedEdit = {
        ...existing,
        category: normalizeCuratedCategory(payload.category, existing.category || 'Venue'),
        focalX: clampFocal(payload.focalX, clampFocal(existing.focalX)),
        focalY: clampFocal(payload.focalY, clampFocal(existing.focalY)),
        updatedAt: new Date().toISOString(),
      };
      const next: GalleryState = {
        ...state,
        curatedEdits: { ...state.curatedEdits, [src]: nextEdit },
      };
      await store.setJSON('gallery/index', next);
      return Response.json({ ok: true, edit: nextEdit });
    }

    if (payload.action === 'reset-curated') {
      const src = String(payload.src || '');
      const curatedEdits = { ...state.curatedEdits };
      delete curatedEdits[src];
      const next: GalleryState = { ...state, curatedEdits };
      await store.setJSON('gallery/index', next);
      return Response.json({ ok: true });
    }

    if (payload.action === 'delete-upload') {
      const id = String(payload.id || '');
      await store.delete('images/' + id);
      const next: GalleryState = { ...state, uploads: state.uploads.filter((item) => item.id !== id) };
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
