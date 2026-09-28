import type { Context, Config } from '@netlify/functions';
import { hasCapability, requireOperations } from './_shared/admin';
import { isSyntheticHealthRequest } from './_shared/synthetic-health';
import { resolveTenant } from './_shared/tenant';
import { readTenantIndex, tenantStoreFor } from './_shared/tenant-storage';

function salesStoreFor(context: Context, tenant: any) {
  return tenantStoreFor(context, tenant, 'sales');
}

function opsStoreFor(context: Context, tenant: any) {
  return tenantStoreFor(context, tenant, 'eventOps');
}

function filesStoreFor(context: Context, tenant: any) {
  return tenantStoreFor(context, tenant, 'eventFiles');
}

function clean(value: unknown, max = 1000) {
  return String(value || '').trim().slice(0, max);
}

function id(prefix = 'DOC') {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return prefix + '-' + Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}

const ALLOWED = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const CATEGORY = new Set(['insurance','floor_plan','vendor','questionnaire','other']);
const MAX_BYTES = 20 * 1024 * 1024;

async function bookedRecord(context: Context, tenant: any, recordId: string) {
  const list = (await readTenantIndex<any>(salesStoreFor(context,tenant),tenant,'records/index')).rows;
  return list.find((entry) => entry?.id === recordId && entry?.stage === 'booked' && entry?.kind === 'proposal') || null;
}

export default async (req: Request, context: Context) => {
  const syntheticRecordId = clean(context.params.recordId, 100);
  if (req.method === 'HEAD' && syntheticRecordId === '__health__' && isSyntheticHealthRequest(req)) {
    try {
      const tenant=resolveTenant(req);
      await Promise.all([
        salesStoreFor(context,tenant).get('records/index', { type: 'json' }),
        opsStoreFor(context,tenant).get('events/__health__', { type: 'json' }),
        filesStoreFor(context,tenant).get('documents/__health__/__health__', { type: 'arrayBuffer' }),
      ]);
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', 'X-VenueLoom-Synthetic-Check': 'event-documents' } });
    } catch {
      return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store', 'X-VenueLoom-Synthetic-Check': 'event-documents' } });
    }
  }

  const auth = await requireOperations(req,context);
  if (auth.response) return auth.response;
  if (req.method !== 'GET' && !hasCapability(auth.user, 'event_ops.manage')) {
    return Response.json({ error: 'Manager permission required to change event documents.' }, { status: 403 });
  }

  const tenant=auth.tenant||resolveTenant(req);
  const recordId = clean(context.params.recordId, 100);
  const documentId = clean(context.params.documentId, 100);
  if (!recordId) return Response.json({ error: 'Booked-event record ID required.' }, { status: 400 });

  const record = await bookedRecord(context, tenant, recordId);
  if (!record) return Response.json({ error: 'Booked event not found.' }, { status: 404 });

  const opsStore = opsStoreFor(context,tenant);
  const filesStore = filesStoreFor(context,tenant);
  const ops: any = await opsStore.get('events/' + recordId, { type: 'json' });
  if (!ops) return Response.json({ error: 'Open the event in Event Ops before uploading documents.' }, { status: 409 });
  ops.documents ||= [];

  if (req.method === 'POST' && !documentId) {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return Response.json({ error: 'Choose a file to upload.' }, { status: 400 });
    if (!ALLOWED.has(file.type)) return Response.json({ error: 'Use PDF, JPG, PNG, WEBP, DOCX, or XLSX files.' }, { status: 400 });
    if (file.size < 1 || file.size > MAX_BYTES) return Response.json({ error: 'File must be between 1 byte and 20 MB.' }, { status: 413 });

    const categoryRaw = clean(form.get('category'), 40);
    const category = CATEGORY.has(categoryRaw) ? categoryRaw : 'other';
    const docId = id();
    const meta = {
      id: docId,
      name: clean(file.name, 240) || 'document',
      label: clean(form.get('label'), 240) || clean(file.name, 240) || 'Document',
      category,
      type: file.type,
      size: file.size,
      uploadedAt: new Date().toISOString(),
      uploadedBy: 'admin',
    };

    await filesStore.set('documents/' + recordId + '/' + docId, await file.arrayBuffer());
    ops.documents = [meta, ...ops.documents.filter((entry: any) => entry.id !== docId)].slice(0, 200);
    ops.updatedAt = new Date().toISOString();
    await opsStore.setJSON('events/' + recordId, ops);

    return Response.json({ ok: true, document: meta, documents: ops.documents }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  const meta = ops.documents.find((entry: any) => entry.id === documentId);
  if (!meta) return Response.json({ error: 'Document not found.' }, { status: 404 });
  const key = 'documents/' + recordId + '/' + documentId;

  if (req.method === 'GET' && documentId) {
    const data = await filesStore.get(key, { type: 'arrayBuffer' });
    if (!data) return Response.json({ error: 'Document file is missing.' }, { status: 404 });
    return new Response(data, {
      headers: {
        'Content-Type': meta.type || 'application/octet-stream',
        'Content-Disposition': 'inline; filename="' + String(meta.name || 'document').replace(/["\\]/g, '') + '"',
        'Cache-Control': 'private, no-store',
      },
    });
  }

  if (req.method === 'DELETE' && documentId) {
    await filesStore.delete(key);
    ops.documents = ops.documents.filter((entry: any) => entry.id !== documentId);
    ops.updatedAt = new Date().toISOString();
    await opsStore.setJSON('events/' + recordId, ops);
    return Response.json({ ok: true, documents: ops.documents }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config: Config = {
  path: [
    '/api/admin/events/documents/:recordId',
    '/api/admin/events/documents/:recordId/:documentId',
  ],
};
