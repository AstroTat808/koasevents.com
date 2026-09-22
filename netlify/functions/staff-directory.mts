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
function hawaiiDateKey(now=new Date()){
  const parts=new Intl.DateTimeFormat('en-US',{
    timeZone:'Pacific/Honolulu',year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(now);
  const part=(type:string)=>parts.find((row)=>row.type===type)?.value||'';
  return part('year')+'-'+part('month')+'-'+part('day');
}
function offsetDateKey(value:string,days:number){
  const parsed=new Date(value+'T12:00:00Z');
  if(Number.isNaN(parsed.getTime()))return value;
  parsed.setUTCDate(parsed.getUTCDate()+days);
  return parsed.toISOString().slice(0,10);
}
function isBetween(value:string,start:string,end:string){
  return Boolean(value&&value>=start&&value<=end);
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
  const today=hawaiiDateKey();
  const weekEnd=offsetDateKey(today,7);

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
  const dateLoadMap=new Map<string,Map<string,{eventIds:Set<string>;responsibilities:number;labels:string[]}>>();
  identities.forEach((person:any)=>{
    assignmentMap.set(person.id,[]);
    dateLoadMap.set(person.id,new Map());
  });

  const pushAssignment=(person:any,row:any)=>{
    const list=assignmentMap.get(person.id)||[];
    const key=[row.type,row.recordId,row.label,row.detail,row.dueDate,row.eventDate].join('|');
    if(!list.some((x:any)=>[x.type,x.recordId,x.label,x.detail,x.dueDate,x.eventDate].join('|')===key))list.push(row);
    assignmentMap.set(person.id,list);
  };
  const addDateLoad=(person:any,eventDate:string,recordId:string,label:string)=>{
    if(!eventDate)return;
    const byDate=dateLoadMap.get(person.id)||new Map();
    const current=byDate.get(eventDate)||{eventIds:new Set<string>(),responsibilities:0,labels:[]};
    if(recordId)current.eventIds.add(recordId);
    current.responsibilities+=1;
    if(label&&!current.labels.includes(label)&&current.labels.length<6)current.labels.push(label);
    byDate.set(eventDate,current);
    dateLoadMap.set(person.id,byDate);
  };

  for(const project of projects){
    const recordId=clean(project?.recordId,120);
    const record=recordMap.get(recordId)||{};
    const stage=clean(record?.stage,40);
    if(stage==='lost')continue;
    const eventDate=clean(record?.customer?.eventDate,40).slice(0,10);
    const label=clean(record?.customer?.name,180)||'CRM project';
    const detail=[eventDate,clean(record?.packageId,100)].filter(Boolean).join(' · ');
    for(const person of identities)if(matches(person,project?.owner)){
      pushAssignment(person,{
        type:'project',
        recordId,
        label,
        detail:detail||'Project owner',
        href:'/admin/crm/?record='+encodeURIComponent(recordId),
        sortDate:eventDate,
        eventDate:stage==='booked'?eventDate:'',
        dueDate:'',
        eventRelated:stage==='booked',
      });
      if(stage==='booked')addDateLoad(person,eventDate,recordId,'Project owner · '+label);
    }
  }

  for(const task of tasks){
    if(clean(task?.status,30)==='done')continue;
    const recordId=clean(task?.recordId,120);
    const record=recordMap.get(recordId)||{};
    const eventDate=clean(record?.customer?.eventDate,40).slice(0,10);
    const dueDate=clean(task?.dueDate,40).slice(0,10);
    const label=clean(task?.title,180)||'CRM task';
    const detail=[clean(record?.customer?.name,180),dueDate].filter(Boolean).join(' · ');
    for(const person of identities)if(matches(person,task?.assignee))pushAssignment(person,{
      type:'task',
      recordId,
      label,
      detail:detail||'Open CRM task',
      href:'/admin/crm/?record='+encodeURIComponent(recordId),
      sortDate:dueDate||eventDate,
      dueDate,
      eventDate:'',
      eventRelated:false,
    });
  }

  const booked=records.filter((record:any)=>record?.stage==='booked'&&record?.kind==='proposal').slice(0,300);
  await Promise.all(booked.map(async(record:any)=>{
    const recordId=clean(record?.id,120);
    const ops:any=await opsStore.get('events/'+recordId,{type:'json'}).catch(()=>null);
    if(!ops||clean(ops?.status,30)==='complete')return;
    const eventDate=clean(record?.customer?.eventDate,40).slice(0,10);
    const eventLabel=clean(record?.customer?.name,180)||'Booked event';
    const eventHref='/admin/events/?record='+encodeURIComponent(recordId);
    const assignments=[
      ...(Array.isArray(ops?.timeline)?ops.timeline.map((row:any)=>({
        owner:row?.owner,
        label:clean(row?.label,180)||'Timeline assignment',
        dueDate:eventDate,
      })):[]),
      ...(Array.isArray(ops?.checklist)?ops.checklist.filter((row:any)=>!['complete','not_applicable'].includes(clean(row?.status,30))).map((row:any)=>({
        owner:row?.owner,
        label:clean(row?.text,180)||'Checklist assignment',
        dueDate:clean(row?.dueDate,40).slice(0,10)||eventDate,
      })):[]),
      ...(Array.isArray(ops?.tasks)?ops.tasks.filter((row:any)=>clean(row?.status,30)!=='complete').map((row:any)=>({
        owner:row?.owner,
        label:clean(row?.task,180)||'Event task',
        dueDate:eventDate,
      })):[]),
    ];
    for(const assignment of assignments){
      for(const person of identities)if(matches(person,assignment.owner)){
        pushAssignment(person,{
          type:'event',
          recordId,
          label:eventLabel,
          detail:[eventDate,assignment.label].filter(Boolean).join(' · '),
          href:eventHref,
          sortDate:assignment.dueDate||eventDate,
          dueDate:assignment.dueDate||eventDate,
          eventDate,
          eventRelated:true,
          responsibilityLabel:assignment.label,
        });
        addDateLoad(person,eventDate,recordId,assignment.label+' · '+eventLabel);
      }
    }
  }));

  const rows=identities.map((person:any)=>{
    const allAssignments=assignmentMap.get(person.id)||[];
    const assignments=[...allAssignments]
      .sort((a:any,b:any)=>String(a.sortDate||'9999').localeCompare(String(b.sortDate||'9999'))||a.label.localeCompare(b.label))
      .slice(0,12);

    const openCrmTasks=allAssignments.filter((row:any)=>row.type==='task').length;
    const upcomingEventIds=new Set(
      allAssignments
        .filter((row:any)=>row.eventRelated&&row.eventDate&&row.eventDate>=today)
        .map((row:any)=>row.recordId)
        .filter(Boolean)
    );
    const overdueAssignments=allAssignments.filter((row:any)=>row.dueDate&&row.dueDate<today).length;
    const dueThisWeek=allAssignments.filter((row:any)=>{
      const due=row.dueDate||row.eventDate||'';
      return isBetween(due,today,weekEnd);
    }).length;
    const score=openCrmTasks+(upcomingEventIds.size*2)+(overdueAssignments*2)+dueThisWeek;
    const workloadLevel=overdueAssignments>=3||score>=12?'high':overdueAssignments>0||score>=6?'moderate':'normal';

    const dateLoad=[...(dateLoadMap.get(person.id)||new Map()).entries()]
      .map(([date,load])=>({
        date,
        eventCount:load.eventIds.size,
        responsibilityCount:load.responsibilities,
        heavy:load.eventIds.size>=2||load.responsibilities>=5,
        labels:load.labels,
      }))
      .sort((a,b)=>a.date.localeCompare(b.date));

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
      assignmentCount:allAssignments.length,
      workload:{
        openCrmTasks,
        upcomingEvents:upcomingEventIds.size,
        overdueAssignments,
        dueThisWeek,
        totalOpenAssignments:allAssignments.length,
        level:workloadLevel,
      },
      dateLoad,
    };
  }).sort((a:any,b:any)=>a.name.localeCompare(b.name));

  return Response.json({
    staff:rows,
    workloadWindow:{today,weekEnd,heavyResponsibilityThreshold:5,heavyEventThreshold:2},
  },{headers:{'Cache-Control':'private, no-store'}});
};

export const config:Config={path:'/api/staff/directory'};
