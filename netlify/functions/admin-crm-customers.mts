import type { Config, Context } from '@netlify/functions';
import { requireCapability } from './_shared/admin';
import { runWithTenant } from './_shared/tenant';
import { readTenantIndex, tenantStoreFor } from './_shared/tenant-storage';
import { buildCustomerDirectory } from './_shared/customer-directory.mjs';

const clean = (value: unknown, max = 240) => String(value ?? '').trim().slice(0, max);
const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const simplePayment = (value: any) => ({
  id: clean(value?.paymentId || value?.id || value?.txnId, 120),
  label: clean(value?.label || value?.description || value?.memo || 'Payment', 160),
  amount: number(value?.total ?? value?.amount),
  dueDate: clean(value?.dueDate, 40),
  date: clean(value?.txnDate || value?.paymentDate || value?.date, 40),
  status: clean(value?.status, 60),
  docNumber: clean(value?.docNumber, 80),
  balance: number(value?.balance),
});
const simpleInvoice = (value: any) => ({
  id: clean(value?.invoiceId || value?.id, 120),
  docNumber: clean(value?.docNumber, 80),
  date: clean(value?.txnDate || value?.date, 40),
  dueDate: clean(value?.dueDate, 40),
  amount: number(value?.total ?? value?.amount),
  balance: number(value?.balance),
  status: clean(value?.status || value?.emailStatus, 80),
});
function customerProject(record: any, notes: any[], tasks: any[]) {
  const booking = record.booking || {};
  const qbo = record.accounting?.quickbooks || {};
  return {
    id: clean(record.id, 120),
    name: clean(record.projectName || record.inquiry?.eventType || record.kind || 'Project', 180),
    createdAt: clean(record.createdAt, 50),
    eventDate: clean(record.customer?.eventDate, 40).slice(0, 10),
    businessLine: clean(record.businessLine || 'events', 80),
    kind: clean(record.kind, 60),
    stage: clean(record.stage || record.kind, 60),
    booking: {
      status: clean(booking.status || record.status, 60),
      contractStatus: clean(booking.contract?.status, 60),
      signWellStatus: clean(booking.contract?.signwell?.status, 60),
      payments: (Array.isArray(booking.payments) ? booking.payments : []).map(simplePayment),
    },
    accounting: {
      source: 'QuickBooks',
      customerLinked: Boolean(qbo.customerId),
      invoices: (Array.isArray(qbo.invoices) ? qbo.invoices : []).map(simpleInvoice),
      payments: (Array.isArray(qbo.payments) ? qbo.payments : []).map(simplePayment),
      estimateCount: Array.isArray(qbo.estimates) ? qbo.estimates.length : Boolean(qbo.estimateId) ? 1 : 0,
    },
    noteCount: notes.filter(note => note.recordId === record.id).length,
    openTaskCount: tasks.filter(task => task.recordId === record.id && task.status !== 'done').length,
  };
}

export default async (request: Request, context: Context) => {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { ...headers, Allow: 'GET' } });
  const auth = await requireCapability('crm.view', request, context);
  if (auth.response) return auth.response;
  if (!auth.tenant) return json({ error: 'Organization access is required.' }, 403);
  return runWithTenant(auth.tenant, async () => {
    const query = new URL(request.url).searchParams;
    const customerId = clean(query.get('customerId'), 120);
    if (!/^CUST-[0-9A-F]{24}$/.test(customerId)) return json({ error: 'Choose a valid customer.', code: 'invalid_customer_id' }, 400);
    const sales = tenantStoreFor(context, auth.tenant!, 'sales');
    const crm = tenantStoreFor(context, auth.tenant!, 'crm');
    const [records, notes, tasks] = await Promise.all([
      readTenantIndex<any>(sales, auth.tenant!, 'records/index').then(value => value.rows),
      crm.get('notes/index', { type: 'json' }).then(value => Array.isArray(value) ? value : []),
      crm.get('tasks/index', { type: 'json' }).then(value => Array.isArray(value) ? value : []),
    ]);
    const directory = buildCustomerDirectory(records, { tenantId: auth.tenant!.id, maxCustomers: Number.MAX_SAFE_INTEGER });
    const customer = directory.customers.find(row => row.id === customerId);
    if (!customer) return json({ error: 'This customer is no longer available.', code: 'customer_not_found' }, 404);
    const memberIds = new Set(customer.recordIds);
    const projects = records.filter(record => memberIds.has(record.id) && record.kind !== 'lead')
      .map(record => customerProject(record, notes, tasks))
      .sort((a, b) => a.eventDate.localeCompare(b.eventDate) || a.id.localeCompare(b.id));
    return json({
      ok: true,
      customer: {
        id: customer.id, name: customer.name, email: customer.email,
        phone: customer.phone, leadIds: customer.leadIds, recordIds: customer.recordIds,
        projectCount: projects.length, needsReview: customer.needsReview,
      },
      projects,
      counts: {
        booked: projects.filter(p => p.stage === 'booked' || p.booking.status === 'booked').length,
        bookingPayments: projects.reduce((sum, p) => sum + p.booking.payments.length, 0),
        quickBooksPayments: projects.reduce((sum, p) => sum + p.accounting.payments.length, 0),
        quickBooksInvoices: projects.reduce((sum, p) => sum + p.accounting.invoices.length, 0),
      },
    });
  });
};

export const config: Config = { path: '/api/admin/crm-customers' };
