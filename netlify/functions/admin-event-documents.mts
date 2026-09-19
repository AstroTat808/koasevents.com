import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { requireAdmin } from './_shared/admin';

function salesStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-sales', consistency: 'strong' })
    : getDeployStore({ name: 'koa-sales' });
}

function opsStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-event-ops', consistency: 'strong' })
    : getDeployStore({ name: 'koa-event-ops' });
}

function filesStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-event-files', consistency: 'strong' })
    : getDeployStore({ name: 'koa-event-files' });
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

async function bookedRecord(context: Context, recordId: string) {
  const list = ((await salesStoreFor(context).get('records/index', { type: 'json' })) || []) as any[];
  return list.find((entry) => entry?.id === recordId && entry?.stage === 'booked' && entry?.kind === 'proposal') || null;
}

export default async (req: Request, context: Context) => {
  const auth = await requireAdmin();
  if (auth.response) return auth.response;

  const recordId = clean(context.params.recordId, 100);
  const documentId = clean(context.params.documentId, 100);
  if (!recordId) return Response.json({ error: 'Booked-event record ID required.' }, { status: 400 });

  const record = await bookedRecord(context, recordId);
  if (!record) return Response.json({ error: 'Booked event not found.' }, { status: 404 });

  const opsStore = opsStoreFor(context);
  const filesStore = filesStoreFor(context);
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
