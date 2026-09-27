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

export type RecipientGroup = {
  id: string;
  name: string;
  emails: string[];
};

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
  directTo: string[];
  directCc: string[];
  directBcc: string[];
  toGroups: string[];
  ccGroups: string[];
  bccGroups: string[];
  defaultTo: string[];
  from: string;
  replyTo: string;
};

type StoredRoute = {
  to:string[];
  cc:string[];
  bcc:string[];
  toGroups:string[];
  ccGroups:string[];
  bccGroups:string[];
};

type StoredRouting = {
  updatedAt: string;
  updatedBy: string;
  groups: RecipientGroup[];
  routes: Partial<Record<EmailRouteId,Partial<StoredRoute>>>;
};

const CATALOG: Omit<EmailRoute,'to'|'cc'|'bcc'|'directTo'|'directCc'|'directBcc'|'toGroups'|'ccGroups'|'bccGroups'|'defaultTo'|'from'|'replyTo'>[] = [
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
    .slice(0,50);
}

function normalizeGroupIds(value:unknown, validIds:Set<string>) {
  const rows=Array.isArray(value)?value:[];
  return [...new Set(rows.map((row)=>clean(row,80)).filter((row)=>validIds.has(row)))].slice(0,25);
}

function slug(value:unknown){
  const base=clean(value,80).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
  return base||('group-'+crypto.randomUUID().slice(0,8));
}

function defaultsFor(id: EmailRouteId) {
  if (id === 'lead-notification' || id === 'lead-response-reminder') {
    const env = clean(Netlify.env.get('KOA_LEAD_EMAIL_TO'),240).toLowerCase();
    return normalizeEmails(env || 'aloha@koasevents.com');
  }
  return [];
}

function senderFor(id:EmailRouteId){
  if(id==='lead-notification'||id==='lead-response-reminder'){
    return clean(Netlify.env.get('KOA_LEAD_EMAIL_FROM'),240)||'Koa’s Events <leads@koasevents.com>';
  }
  if(id==='vendor-event-brief'||id==='vendor-insurance-reminder'){
    return clean(Netlify.env.get('KOA_VENDOR_EMAIL_FROM'),240)||clean(Netlify.env.get('KOA_CLIENT_EMAIL_FROM'),240)||'Koa’s Events <aloha@koasevents.com>';
  }
  return clean(Netlify.env.get('KOA_CLIENT_EMAIL_FROM'),240)||'Koa’s Events <aloha@koasevents.com>';
}

function replyToFor(id:EmailRouteId){
  if(id==='lead-notification') return 'Client email from inquiry record';
  return clean(Netlify.env.get('KOA_CLIENT_REPLY_TO'),240)||'aloha@koasevents.com';
}

function store() {
  return getStore({ name:'koa-email-routing', consistency:'strong' });
}

async function readStored(): Promise<StoredRouting> {
  const raw:any=(await store().get('settings',{type:'json'}))||{};
  return {
    updatedAt:clean(raw?.updatedAt,100),
    updatedBy:clean(raw?.updatedBy,240),
    groups:Array.isArray(raw?.groups)?raw.groups:[],
    routes:raw?.routes&&typeof raw.routes==='object'?raw.routes:{},
  };
}

function normalizeGroups(value:unknown):RecipientGroup[]{
  const rows=Array.isArray(value)?value:[];
  const used=new Set<string>();
  return rows.map((row:any)=>{
    let id=slug(row?.id||row?.name);
    while(used.has(id))id=id+'-'+used.size;
    used.add(id);
    return {id,name:clean(row?.name,80)||id,emails:normalizeEmails(row?.emails)};
  }).filter((row)=>row.name&&row.emails.length).slice(0,40);
}

function expand(direct:string[],groupIds:string[],groups:RecipientGroup[]){
  const byId=new Map(groups.map((group)=>[group.id,group]));
  return normalizeEmails([
    ...direct,
    ...groupIds.flatMap((id)=>byId.get(id)?.emails||[]),
  ]);
}

export async function emailRoutingSummary() {
  const stored = await readStored();
  const groups=normalizeGroups(stored.groups);
  const validIds=new Set(groups.map((group)=>group.id));
  const routes: EmailRoute[] = CATALOG.map((route)=>{
    const defaultTo = defaultsFor(route.id);
    const saved:any = stored.routes?.[route.id] || {};
    const directTo=route.mode==='configurable'
      ? (normalizeEmails(saved.to).length?normalizeEmails(saved.to):defaultTo)
      : [];
    const directCc=normalizeEmails(saved.cc);
    const directBcc=normalizeEmails(saved.bcc);
    const toGroups=route.mode==='configurable'?normalizeGroupIds(saved.toGroups,validIds):[];
    const ccGroups=normalizeGroupIds(saved.ccGroups,validIds);
    const bccGroups=normalizeGroupIds(saved.bccGroups,validIds);
    return {
      ...route,
      defaultTo,
      directTo,
      directCc,
      directBcc,
      toGroups,
      ccGroups,
      bccGroups,
      to:route.mode==='configurable'?expand(directTo,toGroups,groups):[],
      cc:expand(directCc,ccGroups,groups),
      bcc:expand(directBcc,bccGroups,groups),
      from:senderFor(route.id),
      replyTo:replyToFor(route.id),
    };
  });
  return {
    updatedAt:stored.updatedAt||'',
    updatedBy:stored.updatedBy||'',
    groups,
    senders:{
      leadFrom:clean(Netlify.env.get('KOA_LEAD_EMAIL_FROM'),240)||'Koa’s Events <leads@koasevents.com>',
      clientFrom:clean(Netlify.env.get('KOA_CLIENT_EMAIL_FROM'),240)||'Koa’s Events <aloha@koasevents.com>',
      clientReplyTo:clean(Netlify.env.get('KOA_CLIENT_REPLY_TO'),240)||'aloha@koasevents.com',
      vendorFrom:clean(Netlify.env.get('KOA_VENDOR_EMAIL_FROM'),240)||clean(Netlify.env.get('KOA_CLIENT_EMAIL_FROM'),240)||'Koa’s Events <aloha@koasevents.com>',
    },
    routes,
  };
}

export async function saveEmailRouting(input:any, actor:string) {
  const current = await readStored();
  const groups=normalizeGroups(input?.groups??current.groups);
  const validIds=new Set(groups.map((group)=>group.id));
  const nextRoutes:any = { ...(current.routes || {}) };
  for (const route of CATALOG) {
    const incoming = input?.routes?.[route.id];
    if (!incoming) continue;
    const directTo = route.mode==='configurable'?normalizeEmails(incoming.to):[];
    const toGroups=route.mode==='configurable'?normalizeGroupIds(incoming.toGroups,validIds):[];
    if(route.mode==='configurable'&&!directTo.length&&!toGroups.length&&!defaultsFor(route.id).length){
      throw new Error(route.label+' needs at least one To recipient or recipient group.');
    }
    nextRoutes[route.id] = {
      to: directTo,
      cc: normalizeEmails(incoming.cc),
      bcc: normalizeEmails(incoming.bcc),
      toGroups,
      ccGroups:normalizeGroupIds(incoming.ccGroups,validIds),
      bccGroups:normalizeGroupIds(incoming.bccGroups,validIds),
    };
  }
  const next:StoredRouting = {
    updatedAt:new Date().toISOString(),
    updatedBy:clean(actor,240),
    groups,
    routes:nextRoutes,
  };
  await store().setJSON('settings',next);
  return emailRoutingSummary();
}

export async function resolveEmailRoute(id:EmailRouteId) {
  const summary = await emailRoutingSummary();
  const route = summary.routes.find((row)=>row.id===id);
  if (!route) return {to:[],cc:[],bcc:[]};
  return {to:route.to,cc:route.cc,bcc:route.bcc};
}

export function emailRouteCatalog(){
  return CATALOG.map((row)=>({...row}));
}
