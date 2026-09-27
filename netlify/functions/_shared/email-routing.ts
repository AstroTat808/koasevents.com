import { getStore } from '@netlify/blobs';

export type EmailRouteId =
  | 'lead-notification'
  | 'lead-response-reminder'
  | 'client-confirmation'
  | 'client-follow-up'
  | 'review-request'
  | 'vendor-event-brief'
  | 'vendor-insurance-reminder'
  | 'email-preview';

export type EmailRoute = {
  id: EmailRouteId;
  label: string;
  category: string;
  description: string;
  mode: 'configurable' | 'dynamic';
  dynamicSource?: 'client' | 'vendor' | 'signed-in-user';
  to: string[];
  cc: string[];
  bcc: string[];
  defaultTo: string[];
};

type StoredRouting = {
  updatedAt: string;
  updatedBy: string;
  routes: Partial<Record<EmailRouteId,{to:string[];cc:string[];bcc:string[]}>>;
};

const CATALOG: Omit<EmailRoute,'to'|'cc'|'bcc'|'defaultTo'>[] = [
  { id:'lead-notification', label:'New lead notification', category:'Sales CRM', description:'Internal notification when a new website inquiry or lead reaches Koa’s.', mode:'configurable' },
  { id:'lead-response-reminder', label:'Lead response reminder', category:'Sales CRM', description:'Internal reminder when a lead is still waiting for a staff response.', mode:'configurable' },
  { id:'client-confirmation', label:'Client inquiry confirmation', category:'Client automation', description:'Automatic confirmation sent to the email address entered by the client.', mode:'dynamic', dynamicSource:'client' },
  { id:'client-follow-up', label:'24-hour client follow-up', category:'Client automation', description:'Automatic follow-up sent to the lead/client email address.', mode:'dynamic', dynamicSource:'client' },
  { id:'review-request', label:'Review request', category:'Client automation', description:'Post-event review request sent to the booked client email address.', mode:'dynamic', dynamicSource:'client' },
  { id:'vendor-event-brief', label:'Vendor event brief', category:'Vendor automation', description:'Operational brief sent to the vendor assigned to the event.', mode:'dynamic', dynamicSource:'vendor' },
  { id:'vendor-insurance-reminder', label:'Vendor insurance reminder', category:'Vendor automation', description:'Insurance/compliance reminder sent to the vendor email address.', mode:'dynamic', dynamicSource:'vendor' },
  { id:'email-preview', label:'Admin test / email preview', category:'Administration', description:'Preview/test email sent to the currently signed-in staff member.', mode:'dynamic', dynamicSource:'signed-in-user' },
];

function clean(value: unknown, max=240) {
  return String(value ?? '').trim().slice(0,max);
}

function normalizeEmails(value: unknown) {
  const rows = Array.isArray(value) ? value : String(value || '').split(/[\n,;]+/);
  const seen = new Set<string>();
  return rows
    .map((row)=>clean(row,240).toLowerCase())
    .filter((row)=>row.includes('@') && !seen.has(row) && seen.add(row))
    .slice(0,20);
}

function defaultsFor(id: EmailRouteId) {
  if (id === 'lead-notification' || id === 'lead-response-reminder') {
    const env = clean(Netlify.env.get('KOA_LEAD_EMAIL_TO'),240).toLowerCase();
    return normalizeEmails(env || 'aloha@koasevents.com');
  }
  return [];
}

function store() {
  return getStore({ name:'koa-email-routing', consistency:'strong' });
}

async function readStored(): Promise<StoredRouting> {
  return ((await store().get('settings',{type:'json'})) || {updatedAt:'',updatedBy:'',routes:{}}) as StoredRouting;
}

export async function emailRoutingSummary() {
  const stored = await readStored();
  const routes: EmailRoute[] = CATALOG.map((route)=>{
    const defaultTo = defaultsFor(route.id);
    const saved = stored.routes?.[route.id] || {to:[],cc:[],bcc:[]};
    return {
      ...route,
      defaultTo,
      to: route.mode === 'configurable'
        ? (normalizeEmails(saved.to).length ? normalizeEmails(saved.to) : defaultTo)
        : [],
      cc: route.mode === 'configurable' ? normalizeEmails(saved.cc) : [],
      bcc: route.mode === 'configurable' ? normalizeEmails(saved.bcc) : [],
    };
  });
  return { updatedAt:stored.updatedAt||'', updatedBy:stored.updatedBy||'', routes };
}

export async function saveEmailRouting(input:any, actor:string) {
  const current = await readStored();
  const nextRoutes = { ...(current.routes || {}) };
  for (const route of CATALOG) {
    if (route.mode !== 'configurable') continue;
    const incoming = input?.routes?.[route.id];
    if (!incoming) continue;
    const to = normalizeEmails(incoming.to);
    if (!to.length) throw new Error(route.label+' needs at least one To recipient.');
    nextRoutes[route.id] = {
      to,
      cc: normalizeEmails(incoming.cc),
      bcc: normalizeEmails(incoming.bcc),
    };
  }
  const next:StoredRouting = {
    updatedAt:new Date().toISOString(),
    updatedBy:clean(actor,240),
    routes:nextRoutes,
  };
  await store().setJSON('settings',next);
  return emailRoutingSummary();
}

export async function resolveEmailRoute(id:EmailRouteId) {
  const summary = await emailRoutingSummary();
  const route = summary.routes.find((row)=>row.id===id);
  if (!route || route.mode !== 'configurable') return {to:[],cc:[],bcc:[]};
  return {to:route.to,cc:route.cc,bcc:route.bcc};
}
