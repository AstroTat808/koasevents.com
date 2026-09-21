import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { hasCapability, requireOperations } from './_shared/admin';
import { baseVendorRequirements, isBaselineVendorRequirements, suggestVendorRequirements } from './_shared/vendor-requirements.ts';
import { applyMasterInsuranceToAssignments } from './_shared/vendor-insurance-sync.ts';

type Vendor = {
  id: string;
  company: string;
  contact: string;
  role: string;
  email: string;
  phone: string;
  arrivalTime: string;
  insuranceStatus: 'not_requested' | 'requested' | 'received' | 'approved';
  notes: string;
};

type VendorRequirement = {
  category: string;
  importance: 'required' | 'recommended' | 'optional' | 'not_needed';
  note: string;
};

type QuestionAnswer = {
  id: string;
  category: string;
  question: string;
  answer: string;
  status: 'open' | 'answered' | 'confirmed';
};

type TimelineItem = {
  id: string;
  time: string;
  label: string;
  owner: string;
  location: string;
  notes: string;
};

type ChecklistItem = {
  id: string;
  text: string;
  dueDate: string;
  owner: string;
  status: 'not_started' | 'in_progress' | 'complete' | 'not_applicable';
  phase: 'before' | 'event_day' | 'after';
};

type EventTask = {
  id: string;
  time: string;
  task: string;
  owner: string;
  status: 'not_started' | 'in_progress' | 'complete' | 'blocked';
  notes: string;
};

type EventDocument = {
  id: string;
  name: string;
  label: string;
  category: 'insurance' | 'floor_plan' | 'vendor' | 'questionnaire' | 'other';
  type: string;
  size: number;
  uploadedAt: string;
};

type EventOps = {
  recordId: string;
  createdAt: string;
  updatedAt: string;
  status: 'planning' | 'ready' | 'event_day' | 'complete';
  finalGuestCount: number;
  setupStart: string;
  guestArrival: string;
  eventStart: string;
  eventEnd: string;
  teardownEnd: string;
  venueArea: string;
  notes: string;
  vendors: Vendor[];
  vendorRequirements: VendorRequirement[];
  vendorRequirementsMode: 'auto' | 'manual';
  questionnaire: QuestionAnswer[];
  timeline: TimelineItem[];
  checklist: ChecklistItem[];
  tasks: EventTask[];
  documents: EventDocument[];
};

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
function vendorStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-vendors', consistency: 'strong' })
    : getDeployStore({ name: 'koa-vendors' });
}

function clean(value: unknown, max = 1200) {
  return String(value || '').trim().slice(0, max);
}

function num(value: unknown, min = 0, max = 10000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : 0;
}

function id(prefix = 'OPS') {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return prefix + '-' + Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function offsetDate(date: string, days: number) {
  const parsed = new Date(date + 'T12:00:00Z');
  if (Number.isNaN(parsed.getTime())) return '';
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function seedVendorRequirements(): VendorRequirement[] {
  return baseVendorRequirements() as VendorRequirement[];
}

function seedQuestionnaire(): QuestionAnswer[] {
  const rows = [
    ['event', 'Confirm the final guest count.'],
    ['event', 'What time should guests begin arriving?'],
    ['event', 'What are the ceremony and reception start times?'],
    ['event', 'Are there accessibility, mobility, or special accommodation needs?'],
    ['vendors', 'Are all vendors finalized? List any vendors still pending.'],
    ['vendors', 'Are there vendor power, water, staging, loading, or parking requirements?'],
    ['layout', 'What layout or floor-plan decisions are still open?'],
    ['rentals', 'Which Koa’s rental inventory or outside rental items are confirmed?'],
    ['bar', 'What bar package/menu and alcohol-service details are confirmed?'],
    ['decor', 'What decor, floral, signage, cake, or specialty installation details need coordination?'],
    ['timeline', 'Are there any special entrances, announcements, dances, speeches, ceremonies, or surprise moments?'],
    ['logistics', 'Who are the day-of decision makers and emergency contacts?'],
  ];
  return rows.map(([category, question]) => ({
    id: id('Q'),
    category,
    question,
    answer: '',
    status: 'open',
  }));
}

function seedChecklist(eventDate: string): ChecklistItem[] {
  const due60 = eventDate ? offsetDate(eventDate, -60) : '';
  const due30 = eventDate ? offsetDate(eventDate, -30) : '';
  const rows: Array<[ChecklistItem['phase'], string, string]> = [
    ['before', 'Final payment completed', due60],
    ['before', 'Event insurance certificate submitted', due60],
    ['before', 'Vendor list submitted', due30],
    ['before', 'Damage deposit submitted', due30],
    ['before', 'All vendor arrival times confirmed', ''],
    ['before', 'Bartender confirmed from approved list', ''],
    ['event_day', 'Setup starts no earlier than 12:00 PM unless approved', eventDate || ''],
    ['event_day', 'DJ / music volume remains under 75 dB', eventDate || ''],
    ['event_day', 'Shot drinks end by 8:00 PM', eventDate || ''],
    ['event_day', 'Guests follow conduct, occupancy, and smoking policies', eventDate || ''],
    ['event_day', 'Music off by 10:00 PM', eventDate || ''],
    ['after', 'All decorations and personal items removed', eventDate || ''],
    ['after', 'Vendors cleared out by 9:00 AM next day', eventDate ? offsetDate(eventDate, 1) : ''],
    ['after', 'No trash, spills, or extra mess left behind', eventDate || ''],
    ['after', 'No vehicles left overnight', eventDate || ''],
  ];
  return rows.map(([phase, text, dueDate]) => ({
    id: id('C'),
    phase,
    text,
    dueDate,
    owner: '',
    status: 'not_started',
  }));
}

function seedTasks(): EventTask[] {
  return [
    { id: id('T'), time: '', task: 'Venue opening / access check', owner: '', status: 'not_started', notes: '' },
    { id: id('T'), time: '', task: 'Vendor arrival and load-in coordination', owner: '', status: 'not_started', notes: '' },
    { id: id('T'), time: '', task: 'Floor plan / furniture placement verification', owner: '', status: 'not_started', notes: '' },
    { id: id('T'), time: '', task: 'Bar setup and bartender check-in', owner: '', status: 'not_started', notes: '' },
    { id: id('T'), time: '', task: 'Sound / music level check', owner: '', status: 'not_started', notes: '' },
    { id: id('T'), time: '', task: 'Guest arrival readiness check', owner: '', status: 'not_started', notes: '' },
    { id: id('T'), time: '', task: '8:00 PM alcohol-service cutoff check', owner: '', status: 'not_started', notes: '' },
    { id: id('T'), time: '', task: '10:00 PM music-off check', owner: '', status: 'not_started', notes: '' },
    { id: id('T'), time: '', task: 'Post-event cleanup / property walk-through', owner: '', status: 'not_started', notes: '' },
  ];
}

function defaultOps(record: any): EventOps {
  const eventDate = clean(record?.customer?.eventDate, 40);
  const guestCount = Math.round(num(record?.quote?.state?.guestCount || record?.inquiry?.guestCount, 0, 1000));
  const now = new Date().toISOString();
  const seeded:any = {
    recordId: record.id,
    createdAt: now,
    updatedAt: now,
    status: 'planning',
    finalGuestCount: guestCount,
    setupStart: '',
    guestArrival: '',
    eventStart: '',
    eventEnd: '',
    teardownEnd: '',
    venueArea: 'Koa’s Events',
    notes: '',
    vendors: [],
    vendorRequirements: seedVendorRequirements(),
    vendorRequirementsMode: 'auto',
    questionnaire: seedQuestionnaire(),
    timeline: [],
    checklist: seedChecklist(eventDate),
    tasks: seedTasks(),
    documents: [],
  };
  seeded.vendorRequirements = suggestVendorRequirements(record, seeded).map((row) => ({ category: row.category, importance: row.importance, note: row.note }));
  return seeded as EventOps;
}

function sanitizeVendors(input: unknown): Vendor[] {
  if (!Array.isArray(input)) return [];
  const statuses = new Set(['not_requested','requested','received','approved']);
  return input.slice(0, 100).map((row: any) => ({
    id: clean(row?.id, 80) || id('V'),
    marketplaceVendorId: clean(row?.marketplaceVendorId, 100),
    company: clean(row?.company, 180),
    contact: clean(row?.contact, 180),
    role: clean(row?.role, 120),
    email: clean(row?.email, 240),
    phone: clean(row?.phone, 80),
    arrivalTime: clean(row?.arrivalTime, 40),
    insuranceStatus: statuses.has(row?.insuranceStatus) ? row.insuranceStatus : 'not_requested',
    notes: clean(row?.notes, 1600),
  }));
}

function sanitizeVendorRequirements(input: unknown): VendorRequirement[] {
  if (!Array.isArray(input)) return seedVendorRequirements();
  const importance = new Set(['required','recommended','optional','not_needed']);
  return input.slice(0, 40).map((row: any) => ({
    category: clean(row?.category, 120),
    importance: importance.has(row?.importance) ? row.importance : 'optional',
    note: clean(row?.note, 600),
  })).filter((row) => row.category);
}

function sanitizeQuestionnaire(input: unknown): QuestionAnswer[] {
  if (!Array.isArray(input)) return [];
  const statuses = new Set(['open','answered','confirmed']);
  return input.slice(0, 120).map((row: any) => ({
    id: clean(row?.id, 80) || id('Q'),
    category: clean(row?.category, 80) || 'general',
    question: clean(row?.question, 600),
    answer: clean(row?.answer, 4000),
    status: statuses.has(row?.status) ? row.status : 'open',
  })).filter((row) => row.question);
}

function sanitizeTimeline(input: unknown): TimelineItem[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 160).map((row: any) => ({
    id: clean(row?.id, 80) || id('R'),
    time: clean(row?.time, 40),
    label: clean(row?.label, 300),
    owner: clean(row?.owner, 180),
    location: clean(row?.location, 180),
    notes: clean(row?.notes, 1600),
  })).filter((row) => row.label);
}

function sanitizeChecklist(input: unknown): ChecklistItem[] {
  if (!Array.isArray(input)) return [];
  const statuses = new Set(['not_started','in_progress','complete','not_applicable']);
  const phases = new Set(['before','event_day','after']);
  return input.slice(0, 180).map((row: any) => ({
    id: clean(row?.id, 80) || id('C'),
    text: clean(row?.text, 500),
    dueDate: clean(row?.dueDate, 40),
    owner: clean(row?.owner, 180),
    status: statuses.has(row?.status) ? row.status : 'not_started',
    phase: phases.has(row?.phase) ? row.phase : 'before',
  })).filter((row) => row.text);
}

function sanitizeTasks(input: unknown): EventTask[] {
  if (!Array.isArray(input)) return [];
  const statuses = new Set(['not_started','in_progress','complete','blocked']);
  return input.slice(0, 180).map((row: any) => ({
    id: clean(row?.id, 80) || id('T'),
    time: clean(row?.time, 40),
    task: clean(row?.task, 500),
    owner: clean(row?.owner, 180),
    status: statuses.has(row?.status) ? row.status : 'not_started',
    notes: clean(row?.notes, 1600),
  })).filter((row) => row.task);
}

async function appendEvent(context: Context, event: Record<string, unknown>) {
  const store = salesStoreFor(context);
  const current = (await store.get('analytics/events/index', { type: 'json' })) || [];
  await store.setJSON('analytics/events/index', [{
    id: id('EVT'),
    createdAt: new Date().toISOString(),
    ...event,
  }, ...current].slice(0, 10000));
}

export default async (req: Request, context: Context) => {
  const auth = await requireOperations();
  if (auth.response) return auth.response;

  const salesStore = salesStoreFor(context);
  const opsStore = opsStoreFor(context);
  const records = ((await salesStore.get('records/index', { type: 'json' })) || []) as any[];

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const q = clean(url.searchParams.get('q'), 160).toLowerCase();
    const recordId = clean(url.searchParams.get('recordId'), 100);

    let booked = records.filter((record) => record?.stage === 'booked' && record?.kind === 'proposal');
    if (recordId) booked = booked.filter((record) => record.id === recordId);
    if (q) booked = booked.filter((record) => [
      record.id,
      record.customer?.name,
      record.customer?.email,
      record.customer?.phone,
      record.customer?.eventDate,
      record.packageId,
    ].join(' ').toLowerCase().includes(q));

    const events = await Promise.all(booked.slice(0, 300).map(async (record) => {
      let ops = await opsStore.get('events/' + record.id, { type: 'json' }) as EventOps | null;
      if (!ops) {
        ops = defaultOps(record);
        await opsStore.setJSON('events/' + record.id, ops);
      }
      if (!Array.isArray((ops as any).vendorRequirements)) {
        (ops as any).vendorRequirements = suggestVendorRequirements(record, ops).map((row) => ({ category: row.category, importance: row.importance, note: row.note }));
        (ops as any).vendorRequirementsMode = 'auto';
        await opsStore.setJSON('events/' + record.id, ops);
      } else if (!['auto','manual'].includes(String((ops as any).vendorRequirementsMode || ''))) {
        if (isBaselineVendorRequirements((ops as any).vendorRequirements)) {
          (ops as any).vendorRequirements = suggestVendorRequirements(record, ops).map((row) => ({ category: row.category, importance: row.importance, note: row.note }));
          (ops as any).vendorRequirementsMode = 'auto';
        } else {
          (ops as any).vendorRequirementsMode = 'manual';
        }
        await opsStore.setJSON('events/' + record.id, ops);
      }
      return {
        record: {
          id: record.id,
          quoteId: record.quoteId || '',
          packageId: record.packageId || '',
          customer: record.customer || {},
          proposal: record.proposal || {},
          booking: record.booking || null,
          accounting: record.accounting || null,
          communications: record.communications || {},
        },
        ops,
        vendorSuggestions: suggestVendorRequirements(record, ops),
      };
    }));

    return Response.json({ events }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!hasCapability(auth.user, 'event_ops.manage')) {
    return Response.json({ error: 'Manager permission required to change Event Ops.' }, { status: 403 });
  }

  const payload: any = await req.json().catch(() => null);
  const action = clean(payload?.action, 40);
  const recordId = clean(payload?.recordId, 100);
  const record = records.find((entry) => entry.id === recordId && entry.stage === 'booked' && entry.kind === 'proposal');
  if (!record) return Response.json({ error: 'Booked event not found.' }, { status: 404 });

  let ops = await opsStore.get('events/' + recordId, { type: 'json' }) as EventOps | null;
  if (!ops) ops = defaultOps(record);

  if (action === 'save-overview') {
    const statusValues = new Set(['planning','ready','event_day','complete']);
    ops.status = statusValues.has(payload?.status) ? payload.status : ops.status;
    ops.finalGuestCount = Math.round(num(payload?.finalGuestCount, 0, 1000));
    ops.setupStart = clean(payload?.setupStart, 20);
    ops.guestArrival = clean(payload?.guestArrival, 20);
    ops.eventStart = clean(payload?.eventStart, 20);
    ops.eventEnd = clean(payload?.eventEnd, 20);
    ops.teardownEnd = clean(payload?.teardownEnd, 20);
    ops.venueArea = clean(payload?.venueArea, 180) || 'Koa’s Events';
    ops.notes = clean(payload?.notes, 12000);
    if ((ops as any).vendorRequirementsMode !== 'manual') {
      ops.vendorRequirements = suggestVendorRequirements(record, ops).map((row) => ({ category: row.category, importance: row.importance, note: row.note }));
      (ops as any).vendorRequirementsMode = 'auto';
    }
  } else if (action === 'save-vendors') {
    const masterVendors:any[]=(await vendorStoreFor(context).get('vendors/index',{type:'json'}))||[];
    ops.vendors = applyMasterInsuranceToAssignments(sanitizeVendors(payload?.vendors), masterVendors, record.customer?.eventDate);
  } else if (action === 'save-vendor-requirements') {
    ops.vendorRequirements = sanitizeVendorRequirements(payload?.vendorRequirements);
    (ops as any).vendorRequirementsMode = 'manual';
  } else if (action === 'apply-vendor-suggestions') {
    ops.vendorRequirements = suggestVendorRequirements(record, ops).map((row) => ({ category: row.category, importance: row.importance, note: row.note }));
    (ops as any).vendorRequirementsMode = 'auto';
  } else if (action === 'save-questionnaire') {
    ops.questionnaire = sanitizeQuestionnaire(payload?.questionnaire);
    if ((ops as any).vendorRequirementsMode !== 'manual') {
      ops.vendorRequirements = suggestVendorRequirements(record, ops).map((row) => ({ category: row.category, importance: row.importance, note: row.note }));
      (ops as any).vendorRequirementsMode = 'auto';
    }
  } else if (action === 'save-timeline') {
    ops.timeline = sanitizeTimeline(payload?.timeline);
  } else if (action === 'save-checklist') {
    ops.checklist = sanitizeChecklist(payload?.checklist);
  } else if (action === 'save-tasks') {
    ops.tasks = sanitizeTasks(payload?.tasks);
  } else {
    return Response.json({ error: 'Unknown event-operations action.' }, { status: 400 });
  }

  ops.updatedAt = new Date().toISOString();
  await opsStore.setJSON('events/' + recordId, ops);
  await appendEvent(context, {
    type: 'event_ops_updated',
    recordId,
    quoteId: record.quoteId || '',
    packageId: record.packageId || '',
    detail: action.replace('save-', '') + ' updated in Event Ops.',
  });

  return Response.json({ ok: true, ops, vendorSuggestions: suggestVendorRequirements(record, ops) }, { headers: { 'Cache-Control': 'private, no-store' } });
};

export const config: Config = { path: '/api/admin/events' };
