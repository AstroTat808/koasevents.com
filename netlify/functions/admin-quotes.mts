import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { requireAdmin } from './_shared/admin';

type SavedQuote = {
  id: string;
  createdAt: string;
  expiresAt: string;
  state: {
    version?: number;
    startingPoint?: string;
    guestCount?: number;
    selected?: Array<{
      id: string;
      name: string;
      quantity: number;
      auto?: boolean;
      overridden?: boolean;
      estimatedLineTotal?: number;
    }>;
    estimatedFurnitureTotal?: number;
    publishedAddOnTotal?: number;
    basePackagePrice?: number;
    estimatedStartingTotal?: number;
    packageIncludes?: string[];
    packageIncludedInventory?: string;
    updatedAt?: string;
  };
};

type SalesRecord = {
  id: string;
  kind: 'lead' | 'proposal';
  quoteId: string;
  createdAt: string;
  status: 'new' | 'draft';
  customer: {
    name: string;
    email: string;
    phone: string;
    eventDate: string;
    notes: string;
  };
  quote: SavedQuote;
};

function quoteStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-quotes', consistency: 'strong' })
    : getDeployStore({ name: 'koa-quotes' });
}

function salesStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-sales', consistency: 'strong' })
    : getDeployStore({ name: 'koa-sales' });
}

function cleanText(value: unknown, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

function idSuffix() {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function readSalesIndex(context: Context): Promise<SalesRecord[]> {
  const store = salesStoreFor(context);
  return (await store.get('records/index', { type: 'json' })) || [];
}

async function listQuotes(context: Context): Promise<SavedQuote[]> {
  const store = quoteStoreFor(context);
  const result = await store.list({ prefix: 'quotes/' });
  const keys = (result.blobs || [])
    .map((entry: any) => String(entry.key || ''))
    .filter((key: string) => /^quotes\/[2-9A-HJ-NP-Z]{16}$/.test(key))
    .slice(0, 500);

  const quotes = await Promise.all(
    keys.map((key: string) => store.get(key, { type: 'json' }) as Promise<SavedQuote | null>)
  );

  return quotes
    .filter((quote): quote is SavedQuote => Boolean(quote?.id))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function analytics(quotes: SavedQuote[]) {
  const packageCounts = new Map<string, number>();
  const addOnCounts = new Map<string, { name: string; count: number; quantity: number }>();
  let totalGuestCount = 0;
  let estimatedValue = 0;

  quotes.forEach((quote) => {
    const start = quote.state?.startingPoint || 'unspecified';
    packageCounts.set(start, (packageCounts.get(start) || 0) + 1);
    totalGuestCount += Number(quote.state?.guestCount || 0);
    estimatedValue += Number(quote.state?.estimatedStartingTotal || 0);

    (quote.state?.selected || []).forEach((item) => {
      if (item.auto) return;
      const current = addOnCounts.get(item.id) || { name: item.name || item.id, count: 0, quantity: 0 };
      current.count += 1;
      current.quantity += Number(item.quantity || 0);
      addOnCounts.set(item.id, current);
    });
  });

  return {
    quoteCount: quotes.length,
    averageGuestCount: quotes.length ? Math.round(totalGuestCount / quotes.length) : 0,
    estimatedPipelineValue: estimatedValue,
    packages: [...packageCounts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count),
    addOns: [...addOnCounts.entries()]
      .map(([id, value]) => ({ id, ...value }))
      .sort((a, b) => b.count - a.count || b.quantity - a.quantity)
      .slice(0, 20),
  };
}

export default async (req: Request, context: Context) => {
  const auth = await requireAdmin();
  if (auth.response) return auth.response;

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const q = cleanText(url.searchParams.get('q'), 120).toLowerCase();
    const [allQuotes, records] = await Promise.all([
      listQuotes(context),
      readSalesIndex(context),
    ]);

    const filtered = q
      ? allQuotes.filter((quote) => {
          const haystack = [
            quote.id,
            quote.state?.startingPoint,
            quote.state?.guestCount,
            ...(quote.state?.selected || []).flatMap((item) => [item.id, item.name]),
          ].join(' ').toLowerCase();
          return haystack.includes(q);
        })
      : allQuotes;

    const conversions = records.reduce<Record<string, SalesRecord[]>>((acc, record) => {
      (acc[record.quoteId] ||= []).push(record);
      return acc;
    }, {});

    return Response.json({
      quotes: filtered.slice(0, 250),
      analytics: analytics(allQuotes),
      conversions,
      records: records.slice(0, 250),
    }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }

  if (req.method === 'POST') {
    const payload = await req.json().catch(() => null) as any;
    if (!payload || payload.action !== 'convert') {
      return Response.json({ error: 'Unknown action.' }, { status: 400 });
    }

    const quoteId = cleanText(payload.quoteId, 20).toUpperCase();
    const kind = payload.kind === 'proposal' ? 'proposal' : payload.kind === 'lead' ? 'lead' : '';
    if (!/^[2-9A-HJ-NP-Z]{16}$/.test(quoteId) || !kind) {
      return Response.json({ error: 'Valid quote ID and conversion type are required.' }, { status: 400 });
    }

    const quoteStore = quoteStoreFor(context);
    const saved = await quoteStore.get('quotes/' + quoteId, { type: 'json' }) as SavedQuote | null;
    if (!saved) return Response.json({ error: 'Quote not found.' }, { status: 404 });

    const now = new Date();
    const prefix = kind === 'proposal' ? 'KEP' : 'KEL';
    const record: SalesRecord = {
      id: prefix + '-' + now.getUTCFullYear() + '-' + idSuffix(),
      kind,
      quoteId,
      createdAt: now.toISOString(),
      status: kind === 'proposal' ? 'draft' : 'new',
      customer: {
        name: cleanText(payload.customer?.name, 160),
        email: cleanText(payload.customer?.email, 200),
        phone: cleanText(payload.customer?.phone, 80),
        eventDate: cleanText(payload.customer?.eventDate, 40),
        notes: cleanText(payload.customer?.notes, 4000),
      },
      quote: saved,
    };

    const salesStore = salesStoreFor(context);
    const current = await readSalesIndex(context);
    const next = [record, ...current].slice(0, 1000);
    await salesStore.setJSON('records/' + record.id, record);
    await salesStore.setJSON('records/index', next);

    return Response.json({ ok: true, record }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config: Config = {
  path: '/api/admin/quotes',
};
