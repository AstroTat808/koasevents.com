import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';

type SelectedQuoteItem = {
  id: string;
  name: string;
  quantity: number;
  auto: boolean;
  overridden?: boolean;
  reason?: string;
  estimatedLineTotal?: number;
};

type QuoteState = {
  version: number;
  startingPoint: string;
  guestCount: number;
  selected: SelectedQuoteItem[];
  estimatedFurnitureTotal: number;
  basePackagePrice?: number;
  estimatedStartingTotal?: number;
  packageIncludes?: string[];
  packageIncludedInventory?: string;
  autoDismissed?: string[];
  autoOverrides?: Record<string, number>;
  updatedAt?: string;
};

type SavedQuote = {
  id: string;
  createdAt: string;
  expiresAt: string;
  state: QuoteState;
};

const ALLOWED_STARTING_POINTS = new Set([
  '',
  'gardenia',
  'orchid',
  'hibiscus',
  'signature-wedding',
  'ala-carte',
]);

const ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const QUOTE_TTL_DAYS = 180;

function storeFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-quotes', consistency: 'strong' })
    : getDeployStore({ name: 'koa-quotes' });
}

function quoteId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => ID_ALPHABET[value % ID_ALPHABET.length]).join('');
}

function finiteNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanText(value: unknown, max = 240) {
  return String(value || '').trim().slice(0, max);
}

function cleanState(input: unknown): QuoteState | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const startingPoint = cleanText(raw.startingPoint, 40);
  if (!ALLOWED_STARTING_POINTS.has(startingPoint)) return null;

  const guestCount = Math.round(finiteNumber(raw.guestCount, 0));
  if (guestCount < 1 || guestCount > 100) return null;

  const selectedRaw = Array.isArray(raw.selected) ? raw.selected.slice(0, 60) : [];
  const selected: SelectedQuoteItem[] = selectedRaw
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const item = entry as Record<string, unknown>;
      const id = cleanText(item.id, 80);
      const name = cleanText(item.name, 160);
      const quantity = Math.round(finiteNumber(item.quantity, 0));
      if (!id || !name || quantity < 0 || quantity > 500) return null;
      return {
        id,
        name,
        quantity,
        auto: Boolean(item.auto),
        overridden: Boolean(item.overridden),
        reason: cleanText(item.reason, 1200),
        estimatedLineTotal: Math.max(0, finiteNumber(item.estimatedLineTotal, 0)),
      };
    })
    .filter((entry): entry is SelectedQuoteItem => Boolean(entry));

  const dismissed = Array.isArray(raw.autoDismissed)
    ? raw.autoDismissed.map((value) => cleanText(value, 80)).filter(Boolean).slice(0, 12)
    : [];

  const overridesRaw = raw.autoOverrides && typeof raw.autoOverrides === 'object'
    ? raw.autoOverrides as Record<string, unknown>
    : {};
  const autoOverrides: Record<string, number> = {};
  Object.entries(overridesRaw).slice(0, 12).forEach(([key, value]) => {
    const cleanKey = cleanText(key, 80);
    const quantity = Math.round(finiteNumber(value, 0));
    if (cleanKey && quantity >= 0 && quantity <= 500) autoOverrides[cleanKey] = quantity;
  });

  const packageIncludes = Array.isArray(raw.packageIncludes)
    ? raw.packageIncludes.map((value) => cleanText(value, 220)).filter(Boolean).slice(0, 30)
    : [];

  return {
    version: Math.max(1, Math.round(finiteNumber(raw.version, 2))),
    startingPoint,
    guestCount,
    selected,
    estimatedFurnitureTotal: Math.max(0, finiteNumber(raw.estimatedFurnitureTotal, 0)),
    basePackagePrice: Math.max(0, finiteNumber(raw.basePackagePrice, 0)),
    estimatedStartingTotal: Math.max(0, finiteNumber(raw.estimatedStartingTotal, 0)),
    packageIncludes,
    packageIncludedInventory: cleanText(raw.packageIncludedInventory, 800),
    autoDismissed: dismissed,
    autoOverrides,
    updatedAt: new Date().toISOString(),
  };
}

export default async (req: Request, context: Context) => {
  const store = storeFor(context);
  const id = cleanText(context.params.id, 20).toUpperCase();

  if (req.method === 'GET' && id) {
    if (!/^[2-9A-HJ-NP-Z]{12}$/.test(id)) {
      return Response.json({ error: 'Invalid quote ID.' }, { status: 400 });
    }
    const saved = await store.get('quotes/' + id, { type: 'json' }) as SavedQuote | null;
    if (!saved) return Response.json({ error: 'Quote not found.' }, { status: 404 });

    if (new Date(saved.expiresAt).getTime() < Date.now()) {
      return Response.json({ error: 'This saved quote has expired.' }, { status: 410 });
    }

    return Response.json(saved, {
      headers: {
        'Cache-Control': 'private, no-store',
      },
    });
  }

  if (req.method === 'POST' && !id) {
    const rawBody = await req.text();
    if (rawBody.length > 60_000) {
      return Response.json({ error: 'Quote data is too large.' }, { status: 413 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return Response.json({ error: 'Invalid JSON.' }, { status: 400 });
    }

    const state = cleanState((payload as Record<string, unknown>)?.state);
    if (!state) {
      return Response.json({ error: 'Quote data is incomplete or invalid.' }, { status: 400 });
    }

    let newId = '';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = quoteId();
      const exists = await store.get('quotes/' + candidate, { type: 'json' });
      if (!exists) {
        newId = candidate;
        break;
      }
    }
    if (!newId) {
      return Response.json({ error: 'Unable to generate a quote ID.' }, { status: 503 });
    }

    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + QUOTE_TTL_DAYS * 24 * 60 * 60 * 1000);
    const saved: SavedQuote = {
      id: newId,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      state,
    };

    await store.setJSON('quotes/' + newId, saved);

    return Response.json({
      ok: true,
      id: newId,
      recoveryUrl: '/catalog/?quote=' + newId,
      expiresAt: saved.expiresAt,
    }, {
      headers: {
        'Cache-Control': 'private, no-store',
      },
    });
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config: Config = {
  path: ['/api/quotes', '/api/quotes/:id'],
};
