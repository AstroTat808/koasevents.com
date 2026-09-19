import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';

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
function id(prefix='DOC') {
  const bytes=new Uint8Array(6);crypto.getRandomValues(bytes);
  return prefix+'-'+Array.from(bytes,(v)=>v.toString(16).padStart(2,'0')).join('').toUpperCase();
}
const ALLOWED=new Set([
  'application/pdf','image/jpeg','image/png','image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const CATEGORIES=new Set(['insurance','floor_plan','vendor','questionnaire']);
const MAX_BYTES=20*1024*1024;

async function lookup(context:Context,token:string){
  const sales=salesStoreFor(context);
  const records=((await sales.get('records/index',{type:'json'})) || []) as any[];
  const record=records.find((entry:any)=>entry?.kind==='proposal' && entry?.proposal?.publicToken===token);
  if(!record) return {record:null,ops:null};
  if(record.stage!=='booked' || record.proposal?.status!=='booked') return {record:null,ops:null};
  const ops=await opsStoreFor(context).get('events/'+record.id,{type:'json'}) as any;
  return {record,ops};
}
async function appendEvent(context:Context,event:Record<string,unknown>){
  const store=salesStoreFor(context);
  const current=(await store.get('analytics/events/index',{type:'json'})) || [];
  await store.setJSON('analytics/events/index',[{id:id('EVT'),createdAt:new Date().toISOString(),...event},...current].slice(0,10000));
}

export default async(req:Request,context:Context)=>{
  const token=clean(context.params.token,100);
  const documentId=clean(context.params.documentId,100);
  if(!/^[A-Za-z0-9_-]{24,100}$/.test(token)) return Response.json({error:'Invalid planning link.'},{status:400});

  const {record,ops}=await lookup(context,token);
  if(!record) return Response.json({error:'Planning portal not found or not yet available.'},{status:404});
  if(!ops) return Response.json({error:'Open the planning portal before uploading documents.'},{status:409});
  ops.documents ||= [];

  const store=filesStoreFor(context);

  if(req.method==='POST' && !documentId){
    const form=await req.formData();
    const file=form.get('file');
    if(!(file instanceof File)) return Response.json({error:'Choose a file to upload.'},{status:400});
    if(!ALLOWED.has(file.type)) return Response.json({error:'Use PDF, JPG, PNG, WEBP, DOCX, or XLSX files.'},{status:400});
    if(file.size<1 || file.size>MAX_BYTES) return Response.json({error:'File must be between 1 byte and 20 MB.'},{status:413});
    const rawCategory=clean(form.get('category'),40);
    const category=CATEGORIES.has(rawCategory)?rawCategory:'other';
    if(category==='other') return Response.json({error:'Choose Insurance, Floor plan, Vendor, or Questionnaire.'},{status:400});

    const docId=id();
    const meta={
      id:docId,
      name:clean(file.name,240)||'document',
      label:clean(form.get('label'),240)||clean(file.name,240)||'Document',
      category,
      type:file.type,
      size:file.size,
      uploadedAt:new Date().toISOString(),
      uploadedBy:'client',
    };

    await store.set('documents/'+record.id+'/'+docId,await file.arrayBuffer());
    ops.documents=[meta,...ops.documents.filter((entry:any)=>entry.id!==docId)].slice(0,200);
    ops.updatedAt=new Date().toISOString();
    await opsStoreFor(context).setJSON('events/'+record.id,ops);
    await appendEvent(context,{
      type:'client_document_uploaded',
      recordId:record.id,quoteId:record.quoteId||'',packageId:record.packageId||'',
      detail:meta.label+' uploaded by client in planning portal.'
    });
    return Response.json({ok:true,document:meta,documents:ops.documents.filter((d:any)=>d.uploadedBy==='client')},{headers:{'Cache-Control':'private, no-store'}});
  }

  const meta=ops.documents.find((entry:any)=>entry.id===documentId && entry.uploadedBy==='client');
  if(!meta) return Response.json({error:'Client document not found.'},{status:404});
  const key='documents/'+record.id+'/'+documentId;

  if(req.method==='GET' && documentId){
    const data=await store.get(key,{type:'arrayBuffer'});
    if(!data) return Response.json({error:'Document file is missing.'},{status:404});
    return new Response(data,{headers:{
      'Content-Type':meta.type||'application/octet-stream',
      'Content-Disposition':'inline; filename="'+String(meta.name||'document').replace(/["\\]/g,'')+'"',
      'Cache-Control':'private, no-store'
    }});
  }

  if(req.method==='DELETE' && documentId){
    await store.delete(key);
    ops.documents=ops.documents.filter((entry:any)=>entry.id!==documentId);
    ops.updatedAt=new Date().toISOString();
    await opsStoreFor(context).setJSON('events/'+record.id,ops);
    await appendEvent(context,{
      type:'client_document_removed',
      recordId:record.id,quoteId:record.quoteId||'',packageId:record.packageId||'',
      detail:meta.label+' removed by client from planning portal.'
    });
    return Response.json({ok:true,documents:ops.documents.filter((d:any)=>d.uploadedBy==='client')},{headers:{'Cache-Control':'private, no-store'}});
  }

  return new Response('Method not allowed',{status:405});
};

export const config:Config={
  path:[
    '/api/planning/documents/:token',
    '/api/planning/documents/:token/:documentId'
  ]
};
