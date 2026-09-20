import type { Config, Context } from '@netlify/functions';
import { getStore } from '@netlify/blobs';

type RecordEntry = {
  id: string;
  source?: string;
  quoteId?: string;
  createdAt?: string;
  kind?: string;
  stage?: string;
  customer?: { name?: string; email?: string; eventDate?: string };
};

function store() {
  return getStore({ name: 'koa-sales', consistency: 'strong' });
}

export default async (req: Request, context: Context) => {
  if (context.deploy.context !== 'production') {
    return Response.json({ error: 'Production only.' }, { status: 403 });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get('action') || 'inspect';
  if (!['inspect', 'cleanup'].includes(action)) {
    return Response.json({ error: 'Invalid action.' }, { status: 400 });
  }

  const sales = store();
  const records = ((await sales.get('records/index', { type: 'json' })) || []) as RecordEntry[];
  const candidates = records
    .filter((record) =>
      record.source === 'koa-wedding-inquiry' &&
      String(record.customer?.email || '').trim().toLowerCase() === 'chris@sibel.org' &&
      String(record.customer?.eventDate || '') === '2026-12-23' &&
      String(record.quoteId || '') === '6GHP9HA4YF9UWZ9B'
    )
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  const summary = candidates.map((record) => ({
    id: record.id,
    createdAt: record.createdAt || '',
    kind: record.kind || '',
    stage: record.stage || '',
    name: record.customer?.name || '',
    downstream: records.filter((entry: any) => entry?.source === record.id).map((entry: any) => entry.id),
  }));

  if (action !== 'cleanup') {
    return Response.json({ count: candidates.length, candidates: summary }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  if (candidates.length <= 1) {
    return Response.json({ ok: true, kept: candidates[0]?.id || '', moved: [], candidates: summary });
  }

  const keep = candidates[0];
  const duplicates = candidates.slice(1).filter((record) => !records.some((entry: any) => entry?.source === record.id));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const existingTrash = ((await sales.get('trash/index', { type: 'json' })) || []) as any[];
  const activeTrash = existingTrash.filter((entry) => Date.parse(String(entry?.expiresAt || '')) > now.getTime());

  for (const duplicate of duplicates) {
    await sales.setJSON('trash/records/' + duplicate.id, duplicate);
    await sales.delete('records/' + duplicate.id);
  }

  const movedEntries = duplicates.map((duplicate) => ({
    id: duplicate.id,
    kind: duplicate.kind || 'inquiry',
    customerName: duplicate.customer?.name || '',
    customerEmail: duplicate.customer?.email || '',
    eventDate: duplicate.customer?.eventDate || '',
    packageId: duplicate.quoteId || '',
    deletedAt: now.toISOString(),
    expiresAt,
    deletedBy: 'dedupe-maintenance',
  }));

  const duplicateIds = new Set(duplicates.map((record) => record.id));
  await sales.setJSON('records/index', records.filter((record) => !duplicateIds.has(record.id)).slice(0, 1500));
  await sales.setJSON('trash/index', [...movedEntries, ...activeTrash.filter((entry) => !duplicateIds.has(entry.id))].slice(0, 1000));

  return Response.json({
    ok: true,
    kept: keep.id,
    moved: duplicates.map((record) => record.id),
    skippedWithDownstream: candidates.slice(1)
      .filter((record) => records.some((entry: any) => entry?.source === record.id))
      .map((record) => record.id),
    candidates: summary,
  }, { headers: { 'Cache-Control': 'no-store' } });
};

export const config: Config = {
  path: '/api/maintenance/crm-dedupe',
};
