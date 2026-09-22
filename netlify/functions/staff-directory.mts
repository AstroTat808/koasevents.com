import type { Config, Context } from '@netlify/functions';
import { admin } from '@netlify/identity';
import { getDeployStore, getStore } from '@netlify/blobs';
import { capabilitiesFor, operationsRole, requireOperations, ROLE_LABELS } from './_shared/admin';

function clean(value:unknown,max=300){return String(value??'').trim().slice(0,max);}
function metadata(user:any){return user?.user_metadata||user?.userMetadata||{};}
function appMeta(user:any){return user?.app_metadata||user?.appMetadata||{};}
function normalize(value:unknown){return clean(value,300).toLowerCase();}
function storeFor(context:Context,name:string){
  return context.deploy.context==='production'
    ? getStore({name,consistency:'strong'})
    : getDeployStore({name});
}
function areaLabels(user:any){
  const caps=new Set(capabilitiesFor(user));
  const areas:Array<[string,string]>=[
    ['crm.view','Business CRM'],
    ['sales.view','Sales CRM'],
    ['events.view','Event Ops'],
    ['calendar.view','Calendar'],
    ['vendors.view','Vendors'],
    ['insurance.view','Insurance'],
    ['quickbooks.view','QuickBooks'],
    ['blog.view','Blog'],
    ['gallery.view','Gallery'],
    ['seo.view','Local SEO'],
    ['security.view','Security'],
    ['health.view','System Health'],
    ['users.manage','User Management'],
  ];
  return areas.filter(([cap])=>caps.has(cap as any)).map(([,label])=>label);
}

export default async(req:Request,context:Context)=>{
  const auth=await requireOperations(req);
  if(auth.response)return auth.response;
  if(req.method!=='GET')return new Response('Method not allowed',{status:405});

  const [usersRaw,crmProjects,crmTasks,salesRecords]=await Promise.all([
    admin.listUsers({page:1,perPage:200}),
    storeFor(context,'koa-crm').get('projects/index',{type:'json'}).catch(()=>[]) as Promise<any[]>,
    storeFor(context,'koa-crm').get('tasks/index',{type:'json'}).catch(()=>[]) as Promise<any[]>,
    storeFor(context,'koa-sales').get('records/index',{type:'json'}).catch(()=>[]) as Promise<any[]>,
  ]);
  const users:any[]=Array.isArray(usersRaw)?usersRaw:[];
  const projects=Array.isArray(crmProjects)?crmProjects:[];
  const tasks=Array.isArray(crmTasks)?crmTasks:[];
  const records=Array.isArray(salesRecords)?salesRecords:[];
  const recordMap=new Map(records.map((r:any)=>[clean(r?.id,120),r]));
  const opsStore=storeFor(context,'koa-event-ops');

  const activeUsers=users.filter((user:any)=>{
    const role=operationsRole(user);
    return role!=='none'&&role!=='deactivated'&&appMeta(user)?.active!==false;
  });

  const identities=activeUsers.map((user:any)=>{
    const meta=metadata(user);
    const role=operationsRole(user);
    const roleLabel=role&&role!=='custom'&&role in ROLE_LABELS?ROLE_LABELS[role as keyof typeof ROLE_LABELS]:clean(appMeta(user)?.customRoleName,100)||'Staff';
    const email=clean(user?.email,240).toLowerCase();
    const name=clean(meta?.full_name||meta?.name||user?.name||email,180);
    const version=clean(meta?.profile_photo_version,80);
    return {
      user,
      id:clean(user?.id,120),
      email,
      name,
      jobTitle:clean(meta?.job_title||meta?.jobTitle,120),
      role,
      roleLabel,
      areas:areaLabels(user),
      photoUrl:meta?.has_profile_photo===true?('/api/staff/photo/'+encodeURIComponent(clean(user?.id,120))+(version?'?v='+encodeURIComponent(version):'')):'',
      keys:new Set([normalize(email),normalize(name)].filter(Boolean)),
    };
  });

  function matches(person:any,value:unknown){
    const raw=normalize(value);
    if(!raw)return false;
    if(person.keys.has(raw))return true;
    return [...person.keys].some((key:string)=>key&&raw.includes(key));
  }

  const assignmentMap=new Map<string,any[]>();
  identities.forEach((person:any)=>assignmentMap.set(person.id,[]));
  const pushAssignment=(person:any,row:any)=>{
    const list=assignmentMap.get(person.id)||[];
    const key=[row.type,row.recordId,row.label,row.detail].join('|');
    if(!list.some((x:any)=>[x.type,x.recordId,x.label,x.detail].join('|')===key))list.push(row);
    assignmentMap.set(person.id,list);
  };

  for(const project of projects){
    const record=recordMap.get(clean(project?.recordId,120))||{};
    const stage=clean(record?.stage,40);
    if(stage==='lost')continue;
    const label=clean(record?.customer?.name,180)||'CRM project';
    const detail=[clean(record?.customer?.eventDate,40),clean(record?.packageId,100)].filter(Boolean).join(' · ');
    for(const person of identities)if(matches(person,project?.owner))pushAssignment(person,{
      type:'project',
      recordId:clean(project?.recordId,120),
      label,
      detail:detail||'Project owner',
      href:'/admin/crm/?record='+encodeURIComponent(clean(project?.recordId,120)),
      sortDate:clean(record?.customer?.eventDate,40),
    });
  }

  for(const task of tasks){
    if(clean(task?.status,30)==='done')continue;
    const record=recordMap.get(clean(task?.recordId,120))||{};
    const label=clean(task?.title,180)||'CRM task';
    const detail=[clean(record?.customer?.name,180),clean(task?.dueDate,40)].filter(Boolean).join(' · ');
    for(const person of identities)if(matches(person,task?.assignee))pushAssignment(person,{
      type:'task',
      recordId:clean(task?.recordId,120),
      label,
      detail:detail||'Open CRM task',
      href:'/admin/crm/?record='+encodeURIComponent(clean(task?.recordId,120)),
      sortDate:clean(task?.dueDate,40),
    });
  }

  const booked=records.filter((record:any)=>record?.stage==='booked'&&record?.kind==='proposal').slice(0,300);
  await Promise.all(booked.map(async(record:any)=>{
    const ops:any=await opsStore.get('events/'+clean(record?.id,120),{type:'json'}).catch(()=>null);
    if(!ops||clean(ops?.status,30)==='complete')return;
    const eventDate=clean(record?.customer?.eventDate,40);
    const eventLabel=clean(record?.customer?.name,180)||'Booked event';
    const eventHref='/admin/events/?record='+encodeURIComponent(clean(record?.id,120));
    const assignments=[
      ...(Array.isArray(ops?.timeline)?ops.timeline.map((row:any)=>({owner:row?.owner,label:clean(row?.label,180)||'Timeline assignment'})):[]),
      ...(Array.isArray(ops?.checklist)?ops.checklist.filter((row:any)=>!['complete','not_applicable'].includes(clean(row?.status,30))).map((row:any)=>({owner:row?.owner,label:clean(row?.text,180)||'Checklist assignment'})):[]),
      ...(Array.isArray(ops?.tasks)?ops.tasks.filter((row:any)=>clean(row?.status,30)!=='complete').map((row:any)=>({owner:row?.owner,label:clean(row?.task,180)||'Event task'})):[]),
    ];
    for(const assignment of assignments){
      for(const person of identities)if(matches(person,assignment.owner))pushAssignment(person,{
        type:'event',
        recordId:clean(record?.id,120),
        label:eventLabel,
        detail:[eventDate,assignment.label].filter(Boolean).join(' · '),
        href:eventHref,
        sortDate:eventDate,
      });
    }
  }));

  const rows=identities.map((person:any)=>{
    const assignments=(assignmentMap.get(person.id)||[])
      .sort((a:any,b:any)=>String(a.sortDate||'9999').localeCompare(String(b.sortDate||'9999'))||a.label.localeCompare(b.label))
      .slice(0,12);
    return {
      id:person.id,
      email:person.email,
      name:person.name,
      jobTitle:person.jobTitle,
      role:person.role,
      roleLabel:person.roleLabel,
      areas:person.areas,
      photoUrl:person.photoUrl,
      assignments,
      assignmentCount:(assignmentMap.get(person.id)||[]).length,
    };
  }).sort((a:any,b:any)=>a.name.localeCompare(b.name));

  return Response.json({staff:rows},{headers:{'Cache-Control':'private, no-store'}});
};

export const config:Config={path:'/api/staff/directory'};
