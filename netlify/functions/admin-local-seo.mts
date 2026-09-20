import type { Context, Config } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { requireAdmin } from './_shared/admin';

type CitationStatus = 'verified' | 'needs-update' | 'unverified' | 'not-applicable';

type CitationRecord = {
  id: string;
  platform: string;
  url?: string;
  status: CitationStatus;
  addressFound?: string;
  notes?: string;
  lastChecked?: string;
  verifiedBy?: string;
};

const DEFAULT_CITATIONS: CitationRecord[] = [
  {
    id: 'google-business-profile',
    platform: 'Google Business Profile',
    status: 'verified',
    addressFound: '11-3330 Hibiscus St, Mountain View, HI 96771',
    notes: 'Connected profile updated to the canonical Koa’s address and website.',
    lastChecked: '2026-09-20',
  },
  {
    id: 'weddingwire',
    platform: 'WeddingWire',
    url: 'https://www.weddingwire.com/biz/koas-events/2ca2beefbadb7bb8.html',
    status: 'needs-update',
    notes: 'Public WeddingWire results checked 2026-09-20 still show 60 guests and a $1,500 starting price. Update capacity and current pricing/service copy in the WeddingWire business account.',
    lastChecked: '2026-09-20',
  },
  {
    id: 'corporateevents-at',
    platform: 'corporateevents.at',
    url: 'https://corporateevents.at/aquariums-hilo-hawaii/',
    status: 'needs-update',
    addressFound: '11-3334 Hibiscus St',
    notes: 'Stale public citation. Request correction or removal.',
    lastChecked: '2026-09-20',
  },
  {
    id: 'facebook',
    platform: 'Facebook',
    status: 'unverified',
    notes: 'Verify business name, address, phone and website from the business owner surface.',
  },
  {
    id: 'yelp',
    platform: 'Yelp',
    status: 'unverified',
    notes: 'Public crawl did not expose a reliable current Koa’s address.',
  },
  {
    id: 'apple-maps',
    platform: 'Apple Maps',
    status: 'unverified',
    notes: 'Verify through Apple Business Connect / Maps business listing.',
  },
  {
    id: 'bing-maps',
    platform: 'Bing Maps',
    status: 'unverified',
    notes: 'Verify address, phone and website from the Bing business listing.',
  },
  {
    id: 'mapquest',
    platform: 'MapQuest',
    status: 'unverified',
    notes: 'No reliable crawlable Koa’s address result was exposed during the audit.',
  },
  {
    id: 'the-knot',
    platform: 'The Knot',
    status: 'unverified',
    notes: 'Verify listing facts, capacity, address and website.',
  },
  {
    id: 'yellow-pages',
    platform: 'Yellow Pages',
    status: 'unverified',
    notes: 'Verify listing if one exists and standardize NAP data.',
  },
  {
    id: 'bbb',
    platform: 'Better Business Bureau',
    status: 'verified',
    addressFound: 'PO Box 169, Mountain View, HI 96771-0169',
    notes: 'Uses a mailing address rather than the venue street address; no 3334/3336 conflict found.',
    lastChecked: '2026-09-20',
  },
];

function store() {
  return getStore({ name: 'koa-local-seo', consistency: 'strong' });
}

async function readCitations() {
  const saved = await store().get('citations', { type: 'json' }) as CitationRecord[] | null;
  if (Array.isArray(saved) && saved.length) return saved;
  await store().setJSON('citations', DEFAULT_CITATIONS);
  return DEFAULT_CITATIONS;
}

async function writeCitations(records: CitationRecord[]) {
  await store().setJSON('citations', records);
}

export default async (req: Request) => {
  const auth = await requireAdmin();
  if (auth.response) return auth.response;

  if (req.method === 'GET') {
    const citations = await readCitations();
    return Response.json({
      citations,
      totals: {
        verified: citations.filter((item) => item.status === 'verified').length,
        needsUpdate: citations.filter((item) => item.status === 'needs-update').length,
        unverified: citations.filter((item) => item.status === 'unverified').length,
        notApplicable: citations.filter((item) => item.status === 'not-applicable').length,
      },
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const body: any = await req.json().catch(() => null);
  if (!body?.action) return Response.json({ error: 'Missing action.' }, { status: 400 });

  if (body.action === 'update-citation') {
    const id = String(body.id || '').trim();
    const status = String(body.status || '').trim() as CitationStatus;
    if (!id) return Response.json({ error: 'Citation id required.' }, { status: 400 });
    if (!['verified', 'needs-update', 'unverified', 'not-applicable'].includes(status)) {
      return Response.json({ error: 'Valid citation status required.' }, { status: 400 });
    }

    const citations = await readCitations();
    const index = citations.findIndex((item) => item.id === id);
    if (index < 0) return Response.json({ error: 'Citation not found.' }, { status: 404 });

    const next: CitationRecord = {
      ...citations[index],
      status,
      url: String(body.url || citations[index].url || '').trim() || undefined,
      addressFound: String(body.addressFound || '').trim() || undefined,
      notes: String(body.notes || '').trim().slice(0, 2000) || undefined,
      lastChecked: new Date().toISOString().slice(0, 10),
      verifiedBy: String(auth.user?.email || '').trim(),
    };
    const updated = citations.map((item, i) => i === index ? next : item);
    await writeCitations(updated);
    return Response.json({ ok: true, citation: next }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  if (body.action === 'add-citation') {
    const platform = String(body.platform || '').trim().slice(0, 160);
    if (!platform) return Response.json({ error: 'Platform name required.' }, { status: 400 });
    const citations = await readCitations();
    const id = String(body.id || platform.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).slice(0, 80);
    if (citations.some((item) => item.id === id)) return Response.json({ error: 'Citation already exists.' }, { status: 409 });
    const record: CitationRecord = {
      id,
      platform,
      url: String(body.url || '').trim() || undefined,
      status: 'unverified',
      notes: String(body.notes || '').trim().slice(0, 2000) || undefined,
    };
    const updated = [...citations, record];
    await writeCitations(updated);
    return Response.json({ ok: true, citation: record }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  return Response.json({ error: 'Unsupported action.' }, { status: 400 });
};

export const config: Config = { path: '/api/admin/local-seo' };
