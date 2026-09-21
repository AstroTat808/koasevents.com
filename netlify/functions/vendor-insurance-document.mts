import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { requireAdmin } from './_shared/admin';

function vendorStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-vendors', consistency: 'strong' })
    : getDeployStore({ name: 'koa-vendors' });
}
function filesStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-vendor-files', consistency: 'strong' })
    : getDeployStore({ name: 'koa-vendor-files' });
}
function clean(value: unknown, max = 1000) {
  return String(value || '').trim().slice(0, max);
}
function id(prefix = 'COI') {
  return prefix + '-' + crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
}
async function vendors(context: Context) {
  return (((await vendorStoreFor(context).get('vendors/index', { type: 'json' })) || []) as any[]);
}
const ALLOWED = new Set(['application/pdf','image/jpeg','image/png','image/webp']);
const MAX_BYTES = 15 * 1024 * 1024;

export default async (req: Request, context: Context) => {
  const pathname = new URL(req.url).pathname;
  const isAdmin = pathname.startsWith('/api/admin/vendors/insurance/');
  const store = vendorStoreFor(context);
  const files = filesStoreFor(context);
  const rows = await vendors(context);
  let vendor: any = null;

  if (isAdmin) {
    const auth = await requireAdmin();
    if (auth.response) return auth.response;
    vendor = rows.find((entry) => entry.id === clean(context.params.vendorId, 100));
  } else {
    const token = clean(context.params.token, 120);
    if (!/^vnd_[A-Za-z0-9]{24,100}$/.test(token)) return Response.json({ error: 'Invalid vendor portal link.' }, { status: 400 });
    vendor = rows.find((entry) => entry.portalToken === token);
  }

  if (!vendor) return Response.json({ error: 'Vendor not found.' }, { status: 404 });
  vendor.insurance ||= {};
  const current = vendor.insurance.document || null;

  if (req.method === 'POST' && !isAdmin) {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return Response.json({ error: 'Choose a PDF or image certificate to upload.' }, { status: 400 });
    if (!ALLOWED.has(file.type)) return Response.json({ error: 'Insurance certificate must be a PDF, JPG, PNG, or WEBP file.' }, { status: 400 });
    if (file.size < 1 || file.size > MAX_BYTES) return Response.json({ error: 'Insurance certificate must be 15 MB or smaller.' }, { status: 413 });

    if (current?.id) await files.delete('insurance/' + vendor.id + '/' + current.id);

    const document = {
      id: id(),
      name: clean(file.name, 240) || 'insurance-certificate',
      type: file.type,
      size: file.size,
      uploadedAt: new Date().toISOString(),
    };
    await files.set('insurance/' + vendor.id + '/' + document.id, await file.arrayBuffer());

    vendor.insurance = {
      ...vendor.insurance,
      status: 'received',
      carrier: clean(form.get('carrier'), 180),
      policyNumber: clean(form.get('policyNumber'), 180),
      expiresAt: clean(form.get('expiresAt'), 40),
      additionalInsured: String(form.get('additionalInsured') || '') === 'true',
      document,
      submittedAt: document.uploadedAt,
      reviewedAt: '',
      verifiedAt: '',
      rejectionReason: '',
    };
    vendor.updatedAt = new Date().toISOString();
    await store.setJSON('vendors/index', rows.slice(0, 2000));
    return Response.json({ ok: true, insurance: vendor.insurance }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  if (req.method === 'GET') {
    if (!current?.id) return Response.json({ error: 'No insurance certificate has been uploaded.' }, { status: 404 });
    const data = await files.get('insurance/' + vendor.id + '/' + current.id, { type: 'arrayBuffer' });
    if (!data) return Response.json({ error: 'Insurance certificate file is missing.' }, { status: 404 });
    return new Response(data, {
      headers: {
        'Content-Type': current.type || 'application/octet-stream',
        'Content-Disposition': 'inline; filename="' + String(current.name || 'insurance-certificate').replace(/["\\]/g, '') + '"',
        'Cache-Control': 'private, no-store',
      },
    });
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config: Config = {
  path: [
    '/api/vendor-portal/insurance/:token',
    '/api/admin/vendors/insurance/:vendorId',
  ],
};