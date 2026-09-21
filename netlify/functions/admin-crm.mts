import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { requireAdmin } from './_shared/admin';

type Task = { id:string; recordId:string; title:string; dueDate:string; assignee:string; status:'open'|'done'; priority:'low'|'normal'|'high'; createdAt:string; completedAt?:string; };
type Appointment = { id:string; recordId:string; title:string; startsAt:string; durationMinutes:number; location:string; notes:string; status:'scheduled'|'completed'|'cancelled'; createdAt:string; };
type Note = { id:string; recordId:string; body:string; createdAt:string; createdBy:string; };
type WorkflowStep = { id:string; label:string; offsetDays:number; taskTitle:string; };
type Workflow = { id:string; name:string; description:string; trigger:'manual'|'new-inquiry'|'proposal-sent'|'booked'; steps:WorkflowStep[]; active:boolean; createdAt:string; updatedAt:string; };
type Enrollment = { id:string; workflowId:string; recordId:string; startedAt:string; createdTaskIds:string[]; };
type Template = { id:string; type:'email'|'form'|'questionnaire'|'proposal-note'; name:string; subject:string; body:string; active:boolean; updatedAt:string; };
type ProjectMeta = { recordId:string; projectStatus:string; tags:string[]; owner:string; company:string; address:string; partnerName:string; sourceDetail:string; customFields:Record<string,string>; updatedAt:string; };
type Activity = { id:string; recordId:string; type:string; detail:string; createdAt:string; };

function crmStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-crm', consistency: 'strong' })
    : getDeployStore({ name: 'koa-crm' });
}
function salesStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-sales', consistency: 'strong' })
    : getDeployStore({ name: 'koa-sales' });
}
function clean(v: unknown, max = 4000) { return String(v ?? '').trim().slice(0, max); }
function id(prefix='CRM') {
  const bytes = new Uint8Array(6); crypto.getRandomValues(bytes);
  return prefix + '-' + Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('').toUpperCase();
}
function strArray(v: unknown, max=30) {
  return Array.isArray(v) ? v.map(x => clean(x,80)).filter(Boolean).slice(0,max) : [];
}
async function readIndex<T>(store:any, key:string):Promise<T[]> {
  return ((await store.get(key,{type:'json'})) || []) as T[];
}
async function appendActivity(store:any, recordId:string, type:string, detail:string) {
  const row:Activity = { id:id('ACT'), recordId, type, detail:clean(detail,800), createdAt:new Date().toISOString() };
  const current = await readIndex<Activity>(store,'activity/index');
  await store.setJSON('activity/index',[row,...current].slice(0,5000));
  return row;
}
function normalizeProject(record:any, meta:ProjectMeta|null) {
  const p = record?.proposal || {};
  const b = record?.booking || {};
  return {
    id: record.id,
    kind: record.kind || 'inquiry',
    stage: record.stage || record.kind || 'inquiry',
    status: record.status || '',
    createdAt: record.createdAt || '',
    updatedAt: record.updatedAt || record.createdAt || '',
    packageId: record.packageId || record?.quote?.state?.startingPoint || record?.inquiry?.venuePackage || record?.inquiry?.mobileBarPackage || '',
    customer: record.customer || {},
    inquiry: record.inquiry || {},
    proposal: p ? {
      status:p.status || '', total:Number(p.total || 0), depositAmount:Number(p.depositAmount || 0),
      expirationDate:p.expirationDate || '', publicToken:p.publicToken || ''
    } : null,
    booking: b ? { status:b.status || '', payments:Array.isArray(b.payments)?b.payments:[], contract:b.contract || null } : null,
    accounting: record.accounting || null,
    communications: record.communications || {},
    meta: meta || { recordId:record.id, projectStatus:'', tags:[], owner:'', company:'', address:'', partnerName:'', sourceDetail:'', customFields:{}, updatedAt:'' }
  };
}

export default async (req:Request, context:Context) => {
  const auth = await requireAdmin();
  if (auth.response) return auth.response;

  const crm = crmStoreFor(context);
  const sales = salesStoreFor(context);

  if (req.method === 'GET') {
    const salesRecords = await readIndex<any>(sales,'records/index');
    const [tasks, appointments, notes, workflows, enrollments, templates, metas, activity] = await Promise.all([
      readIndex<Task>(crm,'tasks/index'),
      readIndex<Appointment>(crm,'appointments/index'),
      readIndex<Note>(crm,'notes/index'),
      readIndex<Workflow>(crm,'workflows/index'),
      readIndex<Enrollment>(crm,'enrollments/index'),
      readIndex<Template>(crm,'templates/index'),
      readIndex<ProjectMeta>(crm,'projects/index'),
      readIndex<Activity>(crm,'activity/index'),
    ]);
    const metaMap = new Map(metas.map(m => [m.recordId,m]));
    const projects = salesRecords.filter((r:any) => Boolean(r) && r.kind !== 'quickbooks-test').slice(0,1500).map(r => normalizeProject(r, metaMap.get(r.id) || null));
    return Response.json({projects,tasks,appointments,notes,workflows,enrollments,templates,activity},{
      headers:{'Cache-Control':'private, no-store'}
    });
  }

  if (req.method !== 'POST') return new Response('Method not allowed',{status:405});
  const body:any = await req.json().catch(()=>null);
  if (!body) return Response.json({error:'Invalid JSON.'},{status:400});
  const action = clean(body.action,60);
  const actor = clean(auth.user?.email,240) || 'admin';

  if (action === 'save-project') {
    const recordId = clean(body.recordId,100);
    if (!recordId) return Response.json({error:'recordId required'},{status:400});
    const current = await readIndex<ProjectMeta>(crm,'projects/index');
    const existing = current.find(x=>x.recordId===recordId);
    const row:ProjectMeta = {
      recordId,
      projectStatus:clean(body.projectStatus,80),
      tags:strArray(body.tags),
      owner:clean(body.owner,160),
      company:clean(body.company,180),
      address:clean(body.address,400),
      partnerName:clean(body.partnerName,180),
      sourceDetail:clean(body.sourceDetail,300),
      customFields:body.customFields && typeof body.customFields==='object'
        ? Object.fromEntries(Object.entries(body.customFields).slice(0,50).map(([k,v])=>[clean(k,80),clean(v,500)]).filter(([k])=>k))
        : (existing?.customFields || {}),
      updatedAt:new Date().toISOString(),
    };
    const next = existing ? current.map(x=>x.recordId===recordId?row:x) : [row,...current];
    await crm.setJSON('projects/index',next.slice(0,1500));
    await crm.setJSON('projects/'+recordId,row);
    await appendActivity(crm,recordId,'project_updated','Project details updated by '+actor);
    return Response.json({ok:true,project:row});
  }

  if (action === 'add-note') {
    const recordId=clean(body.recordId,100), noteBody=clean(body.body,12000);
    if (!recordId || !noteBody) return Response.json({error:'recordId and body required'},{status:400});
    const row:Note={id:id('NOTE'),recordId,body:noteBody,createdAt:new Date().toISOString(),createdBy:actor};
    const current=await readIndex<Note>(crm,'notes/index');
    await crm.setJSON('notes/index',[row,...current].slice(0,5000));
    await appendActivity(crm,recordId,'note_added','Internal note added');
    return Response.json({ok:true,note:row});
  }

  if (action === 'add-task') {
    const recordId=clean(body.recordId,100), title=clean(body.title,500);
    if (!title) return Response.json({error:'Task title required'},{status:400});
    const priority = ['low','normal','high'].includes(body.priority) ? body.priority : 'normal';
    const row:Task={id:id('TASK'),recordId,title,dueDate:clean(body.dueDate,40),assignee:clean(body.assignee,160),status:'open',priority,createdAt:new Date().toISOString()};
    const current=await readIndex<Task>(crm,'tasks/index');
    await crm.setJSON('tasks/index',[row,...current].slice(0,5000));
    await appendActivity(crm,recordId,'task_created',title);
    return Response.json({ok:true,task:row});
  }

  if (action === 'toggle-task') {
    const taskId=clean(body.taskId,100);
    const current=await readIndex<Task>(crm,'tasks/index');
    const target=current.find(x=>x.id===taskId);
    if (!target) return Response.json({error:'Task not found'},{status:404});
    target.status = target.status === 'done' ? 'open' : 'done';
    target.completedAt = target.status === 'done' ? new Date().toISOString() : undefined;
    await crm.setJSON('tasks/index',current);
    await appendActivity(crm,target.recordId,'task_'+target.status,target.title);
    return Response.json({ok:true,task:target});
  }

  if (action === 'schedule-appointment') {
    const recordId=clean(body.recordId,100), title=clean(body.title,300), startsAt=clean(body.startsAt,80);
    if (!title || !startsAt) return Response.json({error:'Title and start time required'},{status:400});
    const row:Appointment={id:id('APT'),recordId,title,startsAt,durationMinutes:Math.max(15,Math.min(480,Number(body.durationMinutes)||60)),location:clean(body.location,300),notes:clean(body.notes,3000),status:'scheduled',createdAt:new Date().toISOString()};
    const current=await readIndex<Appointment>(crm,'appointments/index');
    await crm.setJSON('appointments/index',[row,...current].slice(0,3000));
    await appendActivity(crm,recordId,'appointment_scheduled',title+' · '+startsAt);
    return Response.json({ok:true,appointment:row});
  }

  if (action === 'update-appointment') {
    const appointmentId=clean(body.appointmentId,100);
    const current=await readIndex<Appointment>(crm,'appointments/index');
    const target=current.find(x=>x.id===appointmentId);
    if (!target) return Response.json({error:'Appointment not found'},{status:404});
    if (['scheduled','completed','cancelled'].includes(body.status)) target.status=body.status;
    await crm.setJSON('appointments/index',current);
    await appendActivity(crm,target.recordId,'appointment_'+target.status,target.title);
    return Response.json({ok:true,appointment:target});
  }

  if (action === 'save-workflow') {
    const current=await readIndex<Workflow>(crm,'workflows/index');
    const workflowId=clean(body.id,100) || id('WF');
    const trigger=['manual','new-inquiry','proposal-sent','booked'].includes(body.trigger)?body.trigger:'manual';
    const steps:Array<WorkflowStep> = Array.isArray(body.steps) ? body.steps.slice(0,30).map((s:any)=>({
      id:clean(s.id,100)||id('STEP'), label:clean(s.label,220), offsetDays:Math.max(0,Math.min(365,Number(s.offsetDays)||0)), taskTitle:clean(s.taskTitle,500)
    })).filter(s=>s.taskTitle) : [];
    const row:Workflow={id:workflowId,name:clean(body.name,180)||'Untitled workflow',description:clean(body.description,1000),trigger,steps,active:body.active!==false,createdAt:current.find(x=>x.id===workflowId)?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
    const next=current.some(x=>x.id===workflowId)?current.map(x=>x.id===workflowId?row:x):[row,...current];
    await crm.setJSON('workflows/index',next.slice(0,500));
    return Response.json({ok:true,workflow:row});
  }

  if (action === 'enroll-workflow') {
    const workflowId=clean(body.workflowId,100), recordId=clean(body.recordId,100);
    const workflows=await readIndex<Workflow>(crm,'workflows/index');
    const workflow=workflows.find(x=>x.id===workflowId && x.active);
    if (!workflow || !recordId) return Response.json({error:'Active workflow and recordId required'},{status:400});
    const tasks=await readIndex<Task>(crm,'tasks/index');
    const created:Task[]=[];
    const now=new Date();
    for (const step of workflow.steps) {
      const due=new Date(now); due.setUTCDate(due.getUTCDate()+step.offsetDays);
      created.push({id:id('TASK'),recordId,title:step.taskTitle,dueDate:due.toISOString().slice(0,10),assignee:'',status:'open',priority:'normal',createdAt:new Date().toISOString()});
    }
    if (created.length) await crm.setJSON('tasks/index',[...created,...tasks].slice(0,5000));
    const enrollment:Enrollment={id:id('ENR'),workflowId,recordId,startedAt:new Date().toISOString(),createdTaskIds:created.map(x=>x.id)};
    const enrollments=await readIndex<Enrollment>(crm,'enrollments/index');
    await crm.setJSON('enrollments/index',[enrollment,...enrollments].slice(0,3000));
    await appendActivity(crm,recordId,'workflow_enrolled',workflow.name+' · '+created.length+' tasks created');
    return Response.json({ok:true,enrollment,tasks:created});
  }

  if (action === 'save-template') {
    const current=await readIndex<Template>(crm,'templates/index');
    const templateId=clean(body.id,100)||id('TPL');
    const type=['email','form','questionnaire','proposal-note'].includes(body.type)?body.type:'email';
    const row:Template={id:templateId,type,name:clean(body.name,180)||'Untitled template',subject:clean(body.subject,300),body:clean(body.body,16000),active:body.active!==false,updatedAt:new Date().toISOString()};
    const next=current.some(x=>x.id===templateId)?current.map(x=>x.id===templateId?row:x):[row,...current];
    await crm.setJSON('templates/index',next.slice(0,1000));
    return Response.json({ok:true,template:row});
  }

  return Response.json({error:'Unknown CRM action.'},{status:400});
};

export const config:Config = { path:'/api/admin/crm' };
