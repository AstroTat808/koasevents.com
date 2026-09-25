import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { hasCapability, requireCapability } from './_shared/admin';

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
  vendorIds?: string[];
};

type CuratedEdit = {
  category?: CuratedCategory;
  focalX?: number;
  focalY?: number;
  vendorIds?: string[];
  updatedAt?: string;
};

type PlacementCrop = {
  focalX: number;
  focalY: number;
  updatedAt: string;
};

type GalleryState = {
  uploads: GalleryItem[];
  hiddenCurated: string[];
  hiddenUploads: string[];
  curatedEdits: Record<string, CuratedEdit>;
  categoryOrder: Record<string, string[]>;
  placementCrops: Record<string, Record<string, PlacementCrop>>;
};

function storeFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-gallery', consistency: 'strong' })
    : getDeployStore({ name: 'koa-gallery' });
}
function vendorStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-vendors', consistency: 'strong' })
    : getDeployStore({ name: 'koa-vendors' });
}
function cleanVendorIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 50);
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

function cleanOrder(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '')).filter((item) => item.startsWith('curated:') || item.startsWith('upload:')))].slice(0, 500);
}

async function readState(context: Context): Promise<GalleryState> {
  const store = storeFor(context);
  const saved = (await store.get('gallery/index', { type: 'json' })) as Partial<GalleryState> | null;
  return {
    uploads: Array.isArray(saved?.uploads) ? saved.uploads : [],
    hiddenCurated: Array.isArray(saved?.hiddenCurated) ? saved.hiddenCurated : [],
    hiddenUploads: Array.isArray(saved?.hiddenUploads) ? saved.hiddenUploads : [],
    curatedEdits: saved?.curatedEdits && typeof saved.curatedEdits === 'object' ? saved.curatedEdits : {},
    categoryOrder: saved?.categoryOrder && typeof saved.categoryOrder === 'object' ? saved.categoryOrder : {},
    placementCrops: saved?.placementCrops && typeof saved.placementCrops === 'object' ? saved.placementCrops : {},
  };
}

function curatedKey(src: string) {
  return 'curated:' + src;
}

function uploadKey(id: string) {
  return 'upload:' + id;
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
        hidden: state.hiddenUploads.includes(item.id),
        key: uploadKey(item.id),
        src: '/api/gallery/image/' + item.id,
      })),
      hiddenCurated: state.hiddenCurated,
      hiddenUploads: state.hiddenUploads,
      curatedEdits: state.curatedEdits,
      categoryOrder: state.categoryOrder,
      placementCrops: state.placementCrops,
    }, {
      headers: {
        // Crop/focal-point changes are operational content and should appear across
        // the public site immediately without waiting for a browser/CDN cache.
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  }

  const auth = await requireCapability('gallery.view', req);
  if (auth.response) return auth.response;

  if (req.method === 'POST') {
    if (!hasCapability(auth.user,'gallery.manage')) return Response.json({ error:'Gallery management permission required.' }, { status:403 });
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
        vendorIds: [],
      };
      await store.set('images/' + id, await file.arrayBuffer());
      const next: GalleryState = { ...state, uploads: [item, ...state.uploads] };
      await store.setJSON('gallery/index', next);
      return Response.json({ ok: true, item: { ...item, key: uploadKey(id), src: '/api/gallery/image/' + id } });
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

    if (payload.action === 'upload-visibility') {
      const id = String(payload.id || '');
      const hiddenUploads = new Set(state.hiddenUploads);
      Boolean(payload.hidden) ? hiddenUploads.add(id) : hiddenUploads.delete(id);
      const next: GalleryState = { ...state, hiddenUploads: [...hiddenUploads] };
      await store.setJSON('gallery/index', next);
      return Response.json({ ok: true, hiddenUploads: next.hiddenUploads });
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

    if (payload.action === 'update-placement-crop') {
      const src = String(payload.src || '');
      const placementId = String(payload.placementId || '').trim().slice(0, 220);
      if (!src.startsWith('/')) return Response.json({ error: 'Image source is required.' }, { status: 400 });
      if (!/^[a-z0-9_-]+$/i.test(placementId)) return Response.json({ error: 'Valid placement ID is required.' }, { status: 400 });

      const existingForSource = state.placementCrops[src] && typeof state.placementCrops[src] === 'object'
        ? state.placementCrops[src]
        : {};
      const placementCrops = {
        ...state.placementCrops,
        [src]: {
          ...existingForSource,
          [placementId]: {
            focalX: clampFocal(payload.focalX),
            focalY: clampFocal(payload.focalY),
            updatedAt: new Date().toISOString(),
          },
        },
      };
      const next: GalleryState = { ...state, placementCrops };
      await store.setJSON('gallery/index', next);
      return Response.json({ ok: true, crop: placementCrops[src][placementId] });
    }

    if (payload.action === 'reset-placement-crop') {
      const src = String(payload.src || '');
      const placementId = String(payload.placementId || '').trim().slice(0, 220);
      if (!src.startsWith('/')) return Response.json({ error: 'Image source is required.' }, { status: 400 });
      if (!placementId) return Response.json({ error: 'Placement ID is required.' }, { status: 400 });

      const placementCrops = { ...state.placementCrops };
      const existingForSource = placementCrops[src] && typeof placementCrops[src] === 'object'
        ? { ...placementCrops[src] }
        : {};
      delete existingForSource[placementId];
      if (Object.keys(existingForSource).length) placementCrops[src] = existingForSource;
      else delete placementCrops[src];

      const next: GalleryState = { ...state, placementCrops };
      await store.setJSON('gallery/index', next);
      return Response.json({ ok: true });
    }

    if (payload.action === 'reorder') {
      const category = normalizeCuratedCategory(payload.category);
      const categoryOrder = { ...state.categoryOrder, [category]: cleanOrder(payload.keys) };
      const next: GalleryState = { ...state, categoryOrder };
      await store.setJSON('gallery/index', next);
      return Response.json({ ok: true, category, order: categoryOrder[category] });
    }

    if (payload.action === 'bulk-update') {
      const selected = Array.isArray(payload.items) ? payload.items.slice(0, 250) : [];
      const operation = String(payload.operation || '');
      const uploadIds = new Set(selected.filter((item) => item?.kind === 'upload').map((item) => String(item.id || '')).filter(Boolean));
      const curatedSrcs = new Set(selected.filter((item) => item?.kind === 'curated').map((item) => String(item.src || '')).filter((src) => src.startsWith('/')));

      let uploads = [...state.uploads];
      let hiddenCurated = new Set(state.hiddenCurated);
      let hiddenUploads = new Set(state.hiddenUploads);
      let curatedEdits = { ...state.curatedEdits };
      let categoryOrder = { ...state.categoryOrder };

      if (operation === 'set-category') {
        const category = normalizeGalleryCategory(payload.category);
        uploads = uploads.map((item) => uploadIds.has(item.id) ? { ...item, category } : item);
        curatedSrcs.forEach((src) => {
          const existing = curatedEdits[src] || {};
          curatedEdits[src] = { ...existing, category, updatedAt: new Date().toISOString() };
        });
      } else if (operation === 'hide') {
        uploadIds.forEach((id) => hiddenUploads.add(id));
        curatedSrcs.forEach((src) => hiddenCurated.add(src));
      } else if (operation === 'show') {
        uploadIds.forEach((id) => hiddenUploads.delete(id));
        curatedSrcs.forEach((src) => hiddenCurated.delete(src));
      } else if (operation === 'delete') {
        await Promise.all([...uploadIds].map((id) => store.delete('images/' + id)));
        uploads = uploads.filter((item) => !uploadIds.has(item.id));
        uploadIds.forEach((id) => hiddenUploads.delete(id));
        curatedSrcs.forEach((src) => hiddenCurated.add(src));
        categoryOrder = Object.fromEntries(
          Object.entries(categoryOrder).map(([category, keys]) => [
            category,
            cleanOrder(keys).filter((key) => !uploadIds.has(key.replace(/^upload:/, ''))),
          ]),
        );
      } else {
        return Response.json({ error: 'Unknown bulk operation.' }, { status: 400 });
      }

      const next: GalleryState = {
        ...state,
        uploads,
        hiddenCurated: [...hiddenCurated],
        hiddenUploads: [...hiddenUploads],
        curatedEdits,
        categoryOrder,
      };
      await store.setJSON('gallery/index', next);
      return Response.json({ ok: true });
    }

    if (payload.action === 'assign-vendors') {
      const kind = String(payload.kind || '');
      const vendorIds = cleanVendorIds(payload.vendorIds);
      const vendorStore = vendorStoreFor(context);
      const vendors = ((await vendorStore.get('vendors/index', { type: 'json' })) || []) as any[];
      const validIds = new Set(vendors.map((vendor) => String(vendor.id || '')));
      const cleaned = vendorIds.filter((vendorId) => validIds.has(vendorId));
      let src = '';

      if (kind === 'upload') {
        const id = String(payload.id || '');
        const existing = state.uploads.find((item) => item.id === id);
        if (!existing) return Response.json({ error: 'Uploaded image not found.' }, { status: 404 });
        src = '/api/gallery/image/' + id;
        state.uploads = state.uploads.map((item) => item.id === id ? { ...item, vendorIds: cleaned } : item);
      } else if (kind === 'curated') {
        src = String(payload.src || '');
        if (!src.startsWith('/')) return Response.json({ error: 'Curated image source is required.' }, { status: 400 });
        const existing = state.curatedEdits[src] || {};
        state.curatedEdits = { ...state.curatedEdits, [src]: { ...existing, vendorIds: cleaned, updatedAt: new Date().toISOString() } };
      } else {
        return Response.json({ error: 'Unknown gallery item type.' }, { status: 400 });
      }

      await store.setJSON('gallery/index', state);

      const now = new Date().toISOString();
      const nextVendors = vendors.map((vendor) => {
        const gallery = Array.isArray(vendor.gallery) ? vendor.gallery : [];
        const has = gallery.some((entry: any) => String(entry?.src || '') === src);
        if (cleaned.includes(String(vendor.id || ''))) {
          if (has) return vendor;
          return { ...vendor, gallery: [{ src, caption: '', eventLabel: '' }, ...gallery].slice(0, 80), updatedAt: now };
        }
        if (!has) return vendor;
        return { ...vendor, gallery: gallery.filter((entry: any) => String(entry?.src || '') !== src), updatedAt: now };
      });
      await vendorStore.setJSON('vendors/index', nextVendors.slice(0, 2000));
      return Response.json({ ok: true, vendorIds: cleaned });
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
      const categoryOrder = Object.fromEntries(
        Object.entries(state.categoryOrder).map(([category, keys]) => [
          category,
          cleanOrder(keys).filter((key) => key !== uploadKey(id)),
        ]),
      );
      const next: GalleryState = {
        ...state,
        uploads: state.uploads.filter((item) => item.id !== id),
        hiddenUploads: state.hiddenUploads.filter((item) => item !== id),
        categoryOrder,
      };
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
