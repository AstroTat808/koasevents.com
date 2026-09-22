import type { Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';

const HAWAII_TZ = 'Hawaiian Standard Time';
const MARKER_PREFIX = 'KOA_RECORD_ID:';

function clean(value: unknown, max=1000){return String(value||'').trim().slice(0,max);}
function isoDate(value:unknown){const raw=clean(value,40);return /^\d{4}-\d{2}-\d{2}$/.test(raw)?raw:'';}
function timeValue(value:unknown){const raw=clean(value,10);return /^\d{2}:\d{2}$/.test(raw)?raw:'';}
function addDays(date:string,days:number){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
function storeFor(context:Context,name:string){return context.deploy.context==='production'?getStore({name,consistency:'strong'}):getDeployStore({name});}
function salesStore(context:Context){return storeFor(context,'koa-sales');}
function opsStore(context:Context){return storeFor(context,'koa-event-ops');}
function syncStore(context:Context){return storeFor(context,'koa-calendar-sync');}

type GraphEvent={
  id:string;
  subject?:string;
  body?:{content?:string;contentType?:string};
  bodyPreview?:string;
  start?:{dateTime?:string;timeZone?:string};
  end?:{dateTime?:string;timeZone?:string};
  isAllDay?:boolean;
  lastModifiedDateTime?:string;
  location?:{displayName?:string};
  organizer?:{emailAddress?:{address?:string;name?:string}};
  webLink?:string;
};

type LinkState={
  recordId:string;
  outlookEventId:string;
  lastCrmHash:string;
  lastOutlookHash:string;
  lastSyncedAt:string;
};

type ConflictSide={
  title:string;
  date:string;
  startTime:string;
  endTime:string;
  venue:string;
  lastModifiedAt?:string;
  webLink?:string;
};

export type Office365SyncConflict={
  recordId:string;
  outlookEventId:string;
  detectedAt:string;
  updatedAt:string;
  differingFields:string[];
  koa:ConflictSide;
  office365:ConflictSide;
};

type SyncAuditAction='created'|'adopted'|'pushed'|'pulled'|'conflicted'|'skipped';
type SyncAuditEntry={
  action:SyncAuditAction;
  recordId:string;
  title:string;
  date:string;
  outlookEventId:string;
  detail:string;
};
type SyncAuditRun={
  id:string;
  startedAt:string;
  completedAt:string;
  status:'success'|'error'|'not_configured';
  trigger:string;
  triggeredBy:string;
  calendarOwner:string;
  calendarName:string;
  totals:Record<SyncAuditAction,number>;
  entries:SyncAuditEntry[];
  error?:string;
};

function env(){
  return {
    tenantId:clean(Netlify.env.get('MICROSOFT_GRAPH_TENANT_ID'),200),
    clientId:clean(Netlify.env.get('MICROSOFT_GRAPH_CLIENT_ID'),200),
    clientSecret:clean(Netlify.env.get('MICROSOFT_GRAPH_CLIENT_SECRET'),500),
    calendarOwner:clean(Netlify.env.get('MICROSOFT_GRAPH_CALENDAR_OWNER')||'chris@koas.us',240),
    calendarId:clean(Netlify.env.get('MICROSOFT_GRAPH_CALENDAR_ID'),500),
    calendarName:clean(Netlify.env.get('MICROSOFT_GRAPH_CALENDAR_NAME')||"Koa's Events",180),
  };
}
export function office365CalendarConfig(){
  const cfg=env();
  return {...cfg,clientSecret:cfg.clientSecret?'configured':'',configured:Boolean(cfg.tenantId&&cfg.clientId&&cfg.clientSecret&&cfg.calendarOwner)};
}

async function token(){
  const cfg=env();
  if(!cfg.tenantId||!cfg.clientId||!cfg.clientSecret)throw new Error('Microsoft Graph credentials are not configured.');
  const body=new URLSearchParams({
    client_id:cfg.clientId,
    client_secret:cfg.clientSecret,
    scope:'https://graph.microsoft.com/.default',
    grant_type:'client_credentials',
  });
  const res=await fetch('https://login.microsoftonline.com/'+encodeURIComponent(cfg.tenantId)+'/oauth2/v2.0/token',{
    method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,
  });
  const payload:any=await res.json().catch(()=>({}));
  if(!res.ok||!payload.access_token)throw new Error('Microsoft token request failed: '+clean(payload.error_description||payload.error||res.statusText,600));
  return payload.access_token as string;
}

async function graph(path:string,accessToken:string,init:RequestInit={}){
  const headers=new Headers(init.headers||{});
  headers.set('Authorization','Bearer '+accessToken);
  headers.set('Accept','application/json');
  headers.set('Prefer','outlook.timezone="'+HAWAII_TZ+'"');
  if(init.body&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
  const res=await fetch('https://graph.microsoft.com/v1.0'+path,{...init,headers});
  if(res.status===204)return null;
  const payload:any=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error('Microsoft Graph '+res.status+': '+clean(payload?.error?.message||res.statusText,800));
  return payload;
}
let cachedCalendarPath='';
async function calendarPath(accessToken:string){
  if(cachedCalendarPath)return cachedCalendarPath;
  const cfg=env();
  if(!cfg.calendarOwner)throw new Error('Microsoft calendar owner is not configured.');
  let calendarId=cfg.calendarId;
  if(!calendarId){
    const payload:any=await graph('/users/'+encodeURIComponent(cfg.calendarOwner)+'/calendars?$select=id,name&$top=200',accessToken);
    const target=(payload?.value||[]).find((row:any)=>clean(row?.name,180).toLowerCase()===cfg.calendarName.toLowerCase());
    if(!target?.id)throw new Error('Microsoft calendar "'+cfg.calendarName+'" was not found for '+cfg.calendarOwner+'.');
    calendarId=clean(target.id,500);
  }
  cachedCalendarPath='/users/'+encodeURIComponent(cfg.calendarOwner)+'/calendars/'+encodeURIComponent(calendarId);
  return cachedCalendarPath;
}
async function listEvents(accessToken:string,start:string,end:string){
  let next=(await calendarPath(accessToken))+'/calendarView?startDateTime='+encodeURIComponent(start+'T00:00:00-10:00')+'&endDateTime='+encodeURIComponent(end+'T23:59:59-10:00')+'&$top=999';
  const rows:GraphEvent[]=[];
  while(next){
    const payload:any=await graph(next,accessToken);
    rows.push(...(Array.isArray(payload?.value)?payload.value:[]));
    const link=clean(payload?.['@odata.nextLink'],2000);
    next=link.startsWith('https://graph.microsoft.com/v1.0')?link.slice('https://graph.microsoft.com/v1.0'.length):'';
  }
  return rows;
}
function marker(recordId:string){return MARKER_PREFIX+recordId;}
function recordIdFromEvent(event:GraphEvent){
  const haystack=clean(event.body?.content||event.bodyPreview,10000);
  const match=haystack.match(/KOA_RECORD_ID:([A-Za-z0-9._:-]+)/);
  return clean(match?.[1],200);
}
function eventHasRecordMarker(event:GraphEvent,recordId:string){
  return recordIdFromEvent(event)===clean(recordId,200);
}
function eventBodyWithMarker(event:GraphEvent,recordId:string){
  const existing=String(event.body?.content||'').trim();
  if(eventHasRecordMarker(event,recordId))return {contentType:event.body?.contentType||'HTML',content:existing};
  const markerText=marker(recordId);
  if(String(event.body?.contentType||'').toLowerCase()==='text'){
    return {contentType:'Text',content:[existing,markerText].filter(Boolean).join('\n')};
  }
  return {contentType:'HTML',content:existing+(existing?'':'<p>Synced with Koa’s Master Calendar.</p>')+'<p>'+markerText+'</p>'};
}
function localParts(event:GraphEvent){
  const start=clean(event.start?.dateTime,40);
  const end=clean(event.end?.dateTime,40);
  return {
    date:start.slice(0,10),
    startTime:event.isAllDay?'':start.slice(11,16),
    endTime:event.isAllDay?'':end.slice(11,16),
  };
}
function crmShape(record:any,ops:any){
  const eventDate=isoDate(record?.customer?.eventDate);
  const start=timeValue(ops?.eventStart||ops?.setupStart);
  const end=timeValue(ops?.eventEnd||ops?.teardownEnd);
  return {
    recordId:clean(record?.id,200),
    title:clean(record?.customer?.name,180)||clean(record?.id,180),
    date:eventDate,
    startTime:start,
    endTime:end,
    venue:clean(ops?.venueArea,180)||'Koa’s Events',
    recordUpdatedAt:clean(record?.updatedAt,80),
    opsUpdatedAt:clean(ops?.updatedAt,80),
  };
}
function crmHash(shape:any){return JSON.stringify([shape.date,shape.startTime,shape.endTime,shape.venue]);}
function outlookHash(event:GraphEvent){
  const p=localParts(event);
  return JSON.stringify([p.date,p.startTime,p.endTime,clean(event.location?.displayName,180)]);
}
function conflictSides(shape:any,event:GraphEvent){
  const p=localParts(event);
  const koa:ConflictSide={
    title:clean(shape.title,180),date:shape.date||'',startTime:shape.startTime||'',endTime:shape.endTime||'',venue:clean(shape.venue,180),
  };
  const office365:ConflictSide={
    title:clean(event.subject,180),date:p.date,startTime:p.startTime,endTime:p.endTime,venue:clean(event.location?.displayName,180),
    lastModifiedAt:clean(event.lastModifiedDateTime,80),webLink:clean(event.webLink,2000),
  };
  const differingFields=['date','startTime','endTime','venue'].filter((field)=>String((koa as any)[field]||'')!==String((office365 as any)[field]||''));
  return {koa,office365,differingFields};
}
function eventBody(shape:any){
  return '<p>Synced with Koa’s Master Calendar.</p><p>'+marker(shape.recordId)+'</p>';
}
function graphPayload(shape:any){
  const allDay=!shape.startTime;
  const start=allDay?shape.date+'T00:00:00':shape.date+'T'+shape.startTime+':00';
  const end=allDay?addDays(shape.date,1)+'T00:00:00':shape.date+'T'+(shape.endTime||shape.startTime)+':00';
  return {
    subject:shape.title,
    body:{contentType:'HTML',content:eventBody(shape)},
    start:{dateTime:start,timeZone:HAWAII_TZ},
    end:{dateTime:end,timeZone:HAWAII_TZ},
    isAllDay:allDay,
    location:{displayName:shape.venue},
    showAs:'busy',
    isReminderOn:false,
  };
}
async function createOutlookEvent(accessToken:string,shape:any){
  return await graph((await calendarPath(accessToken))+'/events',accessToken,{method:'POST',body:JSON.stringify(graphPayload(shape))}) as GraphEvent;
}
async function updateOutlookEvent(accessToken:string,eventId:string,shape:any){
  return await graph((await calendarPath(accessToken))+'/events/'+encodeURIComponent(eventId),accessToken,{method:'PATCH',body:JSON.stringify(graphPayload(shape))}) as GraphEvent;
}
async function loadBooked(context:Context){
  const records=((await salesStore(context).get('records/index',{type:'json'}))||[]) as any[];
  const booked=records.filter((record)=>record?.kind==='proposal'&&record?.stage==='booked'&&record?.proposal?.status==='booked');
  const entries=await Promise.all(booked.map(async(record)=>{
    const ops:any=(await opsStore(context).get('events/'+record.id,{type:'json'}))||{};
    return {record,ops,shape:crmShape(record,ops)};
  }));
  return {records,entries};
}
async function saveRecords(context:Context,records:any[]){await salesStore(context).setJSON('records/index',records);}
async function saveOps(context:Context,recordId:string,ops:any){await opsStore(context).setJSON('events/'+recordId,ops);}

function toExternalItem(event:GraphEvent){
  const p=localParts(event);
  return {
    id:'office365-'+event.id,
    date:p.date,
    time:p.startTime,
    endTime:p.endTime,
    type:'external',
    subtype:'office365',
    title:clean(event.subject,180)||'Office 365 event',
    detail:['Office 365',clean(event.location?.displayName,180)].filter(Boolean).join(' · '),
    status:'scheduled',
    recordId:'',
    customerName:clean(event.subject,180)||'Office 365 event',
    owner:clean(event.organizer?.emailAddress?.name||event.organizer?.emailAddress?.address,180),
    venueArea:clean(event.location?.displayName,180),
    externalUrl:clean(event.webLink,2000),
    outlookEventId:event.id,
  };
}

export async function readOffice365ExternalItems(context:Context){
  return ((await syncStore(context).get('external/index',{type:'json'}))||[]) as any[];
}
export async function readOffice365SyncState(context:Context){
  return ((await syncStore(context).get('state',{type:'json'}))||{}) as any;
}
export async function readOffice365Conflicts(context:Context){
  return (((await syncStore(context).get('conflicts/index',{type:'json'}))||[]) as Office365SyncConflict[])
    .sort((a,b)=>String(a.detectedAt).localeCompare(String(b.detectedAt)));
}
export async function readOffice365ResolvedConflicts(context:Context){
  return (((await syncStore(context).get('conflicts/resolved/index',{type:'json'}))||[]) as any[])
    .sort((a,b)=>String(b.resolvedAt||'').localeCompare(String(a.resolvedAt||'')));
}
export async function readOffice365SyncAudit(context:Context){
  return (((await syncStore(context).get('audit/runs/index',{type:'json'}))||[]) as SyncAuditRun[])
    .sort((a,b)=>String(b.startedAt||'').localeCompare(String(a.startedAt||'')));
}
async function saveOffice365SyncAudit(context:Context,run:SyncAuditRun){
  const rows=await readOffice365SyncAudit(context);
  const next=[run,...rows.filter((row)=>row.id!==run.id)].slice(0,1000);
  await syncStore(context).setJSON('audit/runs/index',next);
}
function auditTotals(entries:SyncAuditEntry[]){
  const totals={created:0,adopted:0,pushed:0,pulled:0,conflicted:0,skipped:0};
  entries.forEach((entry)=>{totals[entry.action]=(totals[entry.action]||0)+1;});
  return totals;
}
async function saveOffice365Conflicts(context:Context,rows:Office365SyncConflict[]){
  await syncStore(context).setJSON('conflicts/index',rows);
}
function buildConflict(existing:Office365SyncConflict|undefined,recordId:string,event:GraphEvent,shape:any):Office365SyncConflict{
  const now=new Date().toISOString();
  const sides=conflictSides(shape,event);
  return {
    recordId,outlookEventId:event.id,detectedAt:existing?.detectedAt||now,updatedAt:now,
    differingFields:sides.differingFields,koa:sides.koa,office365:sides.office365,
  };
}


function normalizedSubject(value:unknown){
  return clean(value,180).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}
function normalizedLocation(value:unknown){
  return clean(value,180).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}
function subjectMatches(shape:any,event:GraphEvent){
  const a=normalizedSubject(shape?.title);
  const b=normalizedSubject(event?.subject);
  return Boolean(a&&b&&(a===b||a.includes(b)||b.includes(a)));
}
function safeAdoptionCandidate(shape:any,event:GraphEvent){
  const p=localParts(event);
  const titleMatch=normalizedSubject(shape?.title)===normalizedSubject(event?.subject);
  const startMatch=!shape?.startTime||p.startTime===shape.startTime;
  const endMatch=!shape?.endTime||p.endTime===shape.endTime;
  const shapeLocation=normalizedLocation(shape?.venue);
  const eventLocation=normalizedLocation(event?.location?.displayName);
  const locationMatch=!shapeLocation||shapeLocation==="koa s events"||shapeLocation===eventLocation;
  return Boolean(titleMatch&&p.date===shape?.date&&startMatch&&endMatch&&locationMatch);
}
function exactDuplicate(shape:any,linked:GraphEvent,candidate:GraphEvent){
  const lp=localParts(linked),cp=localParts(candidate);
  return normalizedSubject(linked.subject)===normalizedSubject(candidate.subject)
    && lp.date===cp.date
    && lp.startTime===cp.startTime
    && lp.endTime===cp.endTime
    && normalizedLocation(linked.location?.displayName)===normalizedLocation(candidate.location?.displayName)
    && cp.date===shape.date;
}

function verificationIssue(type:string,severity:'warning'|'error',shape:any,event:GraphEvent|null,detail:string,extra:any={}){
  return {
    type,
    severity,
    recordId:clean(shape?.recordId,200),
    title:clean(shape?.title,180)||clean(event?.subject,180)||'Calendar event',
    date:clean(shape?.date,20)||localParts(event||{}).date,
    outlookEventId:clean(event?.id,500),
    detail:clean(detail,700),
    ...extra,
  };
}

export async function verifyOffice365Calendar(context:Context){
  const cfg=office365CalendarConfig();
  const checkedAt=new Date().toISOString();
  if(!cfg.configured){
    return {
      ok:false,
      status:'not_configured',
      checkedAt,
      summary:{booked:0,linked:0,missing:0,duplicates:0,mismatches:0,orphans:0,conflicts:0},
      issues:[{type:'configuration',severity:'error',recordId:'',title:'Office 365 calendar',date:'',outlookEventId:'',detail:'Microsoft Graph environment variables are incomplete.'}],
    };
  }

  const accessToken=await token();
  const {entries}=await loadBooked(context);
  const dates=entries.map((entry)=>entry.shape.date).filter(Boolean).sort();
  const today=new Date().toISOString().slice(0,10);
  const start=dates[0]&&dates[0]<addDays(today,-90)?dates[0]:addDays(today,-90);
  const end=dates.at(-1)&&dates.at(-1)>addDays(today,730)?dates.at(-1):addDays(today,730);
  const outlookEvents=await listEvents(accessToken,start,end);
  const conflicts=await readOffice365Conflicts(context);
  const issues:any[]=[];
  const activeIds=new Set(entries.map((entry)=>clean(entry.shape.recordId,200)).filter(Boolean));
  const markerEvents=new Map<string,GraphEvent[]>();

  for(const event of outlookEvents){
    const rid=recordIdFromEvent(event);
    if(!rid)continue;
    const rows=markerEvents.get(rid)||[];
    rows.push(event);
    markerEvents.set(rid,rows);
  }

  let linked=0;
  for(const entry of entries){
    const shape=entry.shape;
    if(!shape.recordId||!shape.date){
      issues.push(verificationIssue('invalid_booking','error',shape,null,!shape.recordId?'Booked CRM record is missing an ID.':'Booked CRM record is missing an event date.'));
      continue;
    }

    const linkedEvents=[...(markerEvents.get(shape.recordId)||[])];
    const link=((await syncStore(context).get('links/'+shape.recordId,{type:'json'}))||{}) as Partial<LinkState>;
    if(link.outlookEventId&&!linkedEvents.some((event)=>event.id===link.outlookEventId)){
      try{
        const byId=await graph((await calendarPath(accessToken))+'/events/'+encodeURIComponent(link.outlookEventId),accessToken) as GraphEvent;
        if(byId?.id)linkedEvents.push(byId);
      }catch{}
    }

    if(!linkedEvents.length){
      const candidates=outlookEvents.filter((candidate)=>{
        if(recordIdFromEvent(candidate))return false;
        const parts=localParts(candidate);
        return parts.date===shape.date&&safeAdoptionCandidate(shape,candidate);
      });
      const repairs=candidates.length===1?[{
        type:'adopt_existing',
        label:'Relink existing Outlook event',
        recordId:shape.recordId,
        eventId:candidates[0].id,
        requiresConfirmation:false,
      }]:[];
      issues.push(verificationIssue('missing_link','error',shape,candidates[0]||null,
        candidates.length===1?'No linked Office 365 event was found, but one safe existing match can be relinked.':
        candidates.length>1?'No linked Office 365 event was found and multiple possible matches need review.':
        'No linked Office 365 event was found for this booked Koa event.',
        {candidateEventIds:candidates.map((row)=>row.id),repairs}
      ));
      continue;
    }

    const uniqueLinked=[...new Map(linkedEvents.map((event)=>[event.id,event])).values()];
    linked+=1;
    if(uniqueLinked.length>1){
      issues.push(verificationIssue('duplicate_linked','error',shape,uniqueLinked[0],'More than one Office 365 event contains the same KOA_RECORD_ID marker.',{duplicateEventIds:uniqueLinked.map((event)=>event.id)}));
    }

    const event=uniqueLinked.find((row)=>row.id===link.outlookEventId)||uniqueLinked[0];
    if(!eventHasRecordMarker(event,shape.recordId)){
      issues.push(verificationIssue('missing_marker','warning',shape,event,'The stored Office 365 link exists, but its KOA_RECORD_ID marker is missing.',{
        repairs:[{type:'restore_marker',label:'Restore Koa link marker',recordId:shape.recordId,eventId:event.id,requiresConfirmation:false}],
      }));
    }
    const parts=localParts(event);
    const mismatchedFields:string[]=[];
    if(clean(event.subject,180)!==clean(shape.title,180))mismatchedFields.push('title');
    if(parts.date!==shape.date)mismatchedFields.push('date');
    if(parts.startTime!==(shape.startTime||''))mismatchedFields.push('startTime');
    if(parts.endTime!==(shape.endTime||''))mismatchedFields.push('endTime');
    if(clean(event.location?.displayName,180)!==clean(shape.venue,180))mismatchedFields.push('venue');
    if(mismatchedFields.length){
      issues.push(verificationIssue('field_mismatch','warning',shape,event,'Linked Office 365 values do not match Koa’s current booking fields.',{fields:mismatchedFields}));
    }

    const sameDateLookalikes=outlookEvents.filter((candidate)=>{
      if(candidate.id===event.id||recordIdFromEvent(candidate))return false;
      const p=localParts(candidate);
      if(p.date!==shape.date)return false;
      const a=normalizedSubject(candidate.subject);
      const b=normalizedSubject(shape.title);
      return Boolean(a&&b&&(a===b||a.includes(b)||b.includes(a)));
    });
    if(sameDateLookalikes.length){
      const deletable=sameDateLookalikes.filter((candidate)=>exactDuplicate(shape,event,candidate));
      issues.push(verificationIssue('possible_duplicate','warning',shape,event,'An unlinked Office 365 event on the same date has a matching or very similar title.',{
        duplicateEventIds:sameDateLookalikes.map((row)=>row.id),
        repairs:deletable.map((candidate)=>({
          type:'delete_duplicate',
          label:'Delete confirmed duplicate',
          recordId:shape.recordId,
          eventId:candidate.id,
          requiresConfirmation:true,
        })),
      }));
    }
  }

  for(const [recordId,events] of markerEvents){
    if(activeIds.has(recordId))continue;
    events.forEach((event)=>issues.push(verificationIssue('orphan_link','warning',{recordId,title:event.subject,date:localParts(event).date},event,'This Office 365 event is linked to a KOA_RECORD_ID that is not an active booked CRM event.')));
  }

  const summary={
    booked:entries.length,
    linked,
    missing:issues.filter((issue)=>issue.type==='missing_link').length,
    duplicates:issues.filter((issue)=>issue.type==='duplicate_linked'||issue.type==='possible_duplicate').length,
    mismatches:issues.filter((issue)=>issue.type==='field_mismatch').length,
    orphans:issues.filter((issue)=>issue.type==='orphan_link').length,
    conflicts:conflicts.length,
  };
  return {
    ok:issues.every((issue)=>issue.severity!=='error')&&conflicts.length===0,
    status:issues.length||conflicts.length?'attention':'passed',
    checkedAt,
    range:{start,end},
    summary,
    issues,
    unresolvedConflicts:conflicts,
  };
}

export async function syncOffice365Calendar(context:Context,trigger='manual',triggeredBy=''){
  const cfg=office365CalendarConfig();
  const startedAt=new Date().toISOString();
  const runId='sync-'+startedAt.replace(/\D/g,'').slice(0,14)+'-'+crypto.randomUUID().slice(0,8);
  const auditEntries:SyncAuditEntry[]=[];
  const addAudit=(action:SyncAuditAction,shape:any,event:any,detail:string)=>{
    auditEntries.push({
      action,
      recordId:clean(shape?.recordId,200),
      title:clean(shape?.title,180)||clean(event?.subject,180)||'Calendar event',
      date:clean(shape?.date,20)||localParts(event||{}).date,
      outlookEventId:clean(event?.id,500),
      detail:clean(detail,500),
    });
  };
  if(!cfg.configured){
    const state={configured:false,lastAttemptAt:startedAt,lastError:'Microsoft Graph environment variables are incomplete.'};
    await syncStore(context).setJSON('state',state);
    await saveOffice365SyncAudit(context,{id:runId,startedAt,completedAt:new Date().toISOString(),status:'not_configured',trigger,triggeredBy:clean(triggeredBy,240),calendarOwner:cfg.calendarOwner,calendarName:cfg.calendarName,totals:auditTotals(auditEntries),entries:auditEntries,error:state.lastError});
    return state;
  }
  try{
    const accessToken=await token();
    const {records,entries}=await loadBooked(context);
    const dates=entries.map((entry)=>entry.shape.date).filter(Boolean).sort();
    const today=new Date().toISOString().slice(0,10);
    const start=dates[0]&&dates[0]<addDays(today,-90)?dates[0]:addDays(today,-90);
    const end=dates.at(-1)&&dates.at(-1)>addDays(today,730)?dates.at(-1):addDays(today,730);
    const outlookEvents=await listEvents(accessToken,start,end);
    const linkedByRecord=new Map<string,GraphEvent>();
    const external:any[]=[];
    const existingConflicts=await readOffice365Conflicts(context);
    const conflictMap=new Map(existingConflicts.map((row)=>[row.recordId,row]));
    for(const event of outlookEvents){
      const rid=recordIdFromEvent(event);
      if(rid)linkedByRecord.set(rid,event); else if(!event.isAllDay||event.subject)external.push(toExternalItem(event));
    }

    let pushed=0,pulled=0,created=0,conflicts=0,adopted=0;
    let recordsChanged=false;
    const normalizedSubject=(value:unknown)=>clean(value,180).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
    const unlinkedEvents=outlookEvents.filter((event)=>!recordIdFromEvent(event));
    for(const entry of entries){
      const shape=entry.shape;
      if(!shape.recordId||!shape.date){
        addAudit('skipped',shape,null,!shape.recordId?'CRM record ID is missing.':'Event date is missing.');
        continue;
      }
      const linkKey='links/'+shape.recordId;
      const link=((await syncStore(context).get(linkKey,{type:'json'}))||{}) as Partial<LinkState>;
      let event=linkedByRecord.get(shape.recordId);
      if(!event&&link.outlookEventId){
        try{event=await graph((await calendarPath(accessToken))+'/events/'+encodeURIComponent(link.outlookEventId),accessToken) as GraphEvent;}catch{}
      }
      if(!event){
        const subjectNeedle=normalizedSubject(shape.title);
        const candidates=unlinkedEvents.filter((candidate)=>{
          const parts=localParts(candidate);
          if(parts.date!==shape.date)return false;
          const subject=normalizedSubject(candidate.subject);
          if(!subjectNeedle||!subject)return false;
          return subject===subjectNeedle||subject.includes(subjectNeedle)||subjectNeedle.includes(subject);
        });
        if(candidates.length===1){
          event=candidates[0];
          adopted++;
          const index=unlinkedEvents.findIndex((row)=>row.id===event?.id);
          if(index>=0)unlinkedEvents.splice(index,1);
          await syncStore(context).setJSON(linkKey,{recordId:shape.recordId,outlookEventId:event.id,lastCrmHash:crmHash(shape),lastOutlookHash:outlookHash(event),lastSyncedAt:new Date().toISOString()});
          addAudit('adopted',shape,event,'Matched one existing Office 365 event on the same date and reused it instead of creating a duplicate.');
          continue;
        }
        if(candidates.length>1){
          conflictMap.set(shape.recordId,buildConflict(undefined,shape.recordId,candidates[0],shape));
          conflicts++;
          addAudit('conflicted',shape,candidates[0],'Multiple existing Office 365 events could match this booking; no event was created or adopted.');
          continue;
        }
        event=await createOutlookEvent(accessToken,shape);
        created++;
        await syncStore(context).setJSON(linkKey,{recordId:shape.recordId,outlookEventId:event.id,lastCrmHash:crmHash(shape),lastOutlookHash:outlookHash(event),lastSyncedAt:new Date().toISOString()});
        addAudit('created',shape,event,'Created a new linked Office 365 event because no safe existing match was found.');
        continue;
      }

      const currentCrmHash=crmHash(shape);
      const currentOutlookHash=outlookHash(event);
      const crmChanged=Boolean(link.lastCrmHash&&link.lastCrmHash!==currentCrmHash);
      const outlookChanged=Boolean(link.lastOutlookHash&&link.lastOutlookHash!==currentOutlookHash);
      const pendingConflict=conflictMap.get(shape.recordId);
      if(pendingConflict){
        conflictMap.set(shape.recordId,buildConflict(pendingConflict,shape.recordId,event,shape));
        conflicts++;
        addAudit('conflicted',shape,event,'A previously detected Koa’s / Office 365 conflict is still awaiting staff resolution.');
        continue;
      }

      if(outlookChanged&&!crmChanged){
        const parts=localParts(event);
        const recordIndex=records.findIndex((row)=>row?.id===shape.recordId);
        if(recordIndex>=0&&parts.date){
          records[recordIndex]={...records[recordIndex],customer:{...(records[recordIndex].customer||{}),eventDate:parts.date},updatedAt:new Date().toISOString()};
          recordsChanged=true;
        }
        const nextOps={...(entry.ops||{})};
        if(parts.startTime)nextOps.eventStart=parts.startTime;
        if(parts.endTime)nextOps.eventEnd=parts.endTime;
        const location=clean(event.location?.displayName,180);if(location)nextOps.venueArea=location;
        nextOps.updatedAt=new Date().toISOString();
        await saveOps(context,shape.recordId,nextOps);
        entry.ops=nextOps;
        entry.shape=crmShape(records.find((row)=>row?.id===shape.recordId)||entry.record,nextOps);
        pulled++;
        addAudit('pulled',entry.shape,event,'Pulled Office 365 date, time, or location changes into Koa’s CRM/Event Ops.');
      }else if(crmChanged&&outlookChanged){
        // Never guess when both systems changed independently. Preserve both values and
        // surface a conflict so staff can explicitly choose which side wins.
        conflictMap.set(shape.recordId,buildConflict(undefined,shape.recordId,event,shape));
        conflicts++;
        addAudit('conflicted',shape,event,'Both Koa’s and Office 365 changed since the previous sync; neither side was overwritten.');
        continue;
      }else if(crmChanged||!link.lastCrmHash){
        event=await updateOutlookEvent(accessToken,event.id,shape);pushed++;
        addAudit('pushed',shape,event,'Pushed Koa’s date, time, or location changes to the linked Office 365 event.');
      }else{
        addAudit('skipped',shape,event,'No synchronized date, time, or location fields changed.');
      }

      const finalShape=entry.shape||shape;
      await syncStore(context).setJSON(linkKey,{
        recordId:shape.recordId,
        outlookEventId:event.id,
        lastCrmHash:crmHash(finalShape),
        lastOutlookHash:outlookHash(event),
        lastSyncedAt:new Date().toISOString(),
      });
    }
    if(recordsChanged)await saveRecords(context,records);
    const activeRecordIds=new Set(entries.map((entry)=>entry.shape.recordId).filter(Boolean));
    const conflictRows=[...conflictMap.values()].filter((row)=>activeRecordIds.has(row.recordId));
    await saveOffice365Conflicts(context,conflictRows);
    await syncStore(context).setJSON('external/index',external.filter((item)=>item.date));
    const completedAt=new Date().toISOString();
    const state={configured:true,lastAttemptAt:startedAt,lastSuccessAt:completedAt,lastError:'',created,adopted,pushed,pulled,conflicts:conflictRows.length,externalImported:external.length,calendarOwner:cfg.calendarOwner,runId};
    await syncStore(context).setJSON('state',state);
    await saveOffice365SyncAudit(context,{id:runId,startedAt,completedAt,status:'success',trigger,triggeredBy:clean(triggeredBy,240),calendarOwner:cfg.calendarOwner,calendarName:cfg.calendarName,totals:auditTotals(auditEntries),entries:auditEntries});
    return state;
  }catch(error:any){
    const message=clean(error?.message||error,1000);
    const state={configured:true,lastAttemptAt:startedAt,lastError:message,runId};
    await syncStore(context).setJSON('state',state);
    await saveOffice365SyncAudit(context,{id:runId,startedAt,completedAt:new Date().toISOString(),status:'error',trigger,triggeredBy:clean(triggeredBy,240),calendarOwner:cfg.calendarOwner,calendarName:cfg.calendarName,totals:auditTotals(auditEntries),entries:auditEntries,error:message});
    throw error;
  }
}

export async function resolveOffice365Conflict(context:Context,recordIdInput:string,resolutionInput:string,resolvedByInput=''){
  const recordId=clean(recordIdInput,200);
  const resolution=clean(resolutionInput,40);
  if(!recordId)throw new Error('A CRM record ID is required.');
  if(!['keep_koa','keep_office365'].includes(resolution))throw new Error('Resolution must be keep_koa or keep_office365.');

  const conflicts=await readOffice365Conflicts(context);
  const conflict=conflicts.find((row)=>row.recordId===recordId);
  if(!conflict)throw new Error('This calendar conflict is no longer pending.');

  const accessToken=await token();
  const records=((await salesStore(context).get('records/index',{type:'json'}))||[]) as any[];
  const recordIndex=records.findIndex((row)=>row?.id===recordId);
  if(recordIndex<0)throw new Error('The CRM booking linked to this conflict no longer exists.');
  const record=records[recordIndex];
  const ops:any=(await opsStore(context).get('events/'+recordId,{type:'json'}))||{};
  const linkKey='links/'+recordId;
  const link=((await syncStore(context).get(linkKey,{type:'json'}))||{}) as Partial<LinkState>;
  const outlookEventId=clean(link.outlookEventId||conflict.outlookEventId,500);
  if(!outlookEventId)throw new Error('The linked Office 365 event ID is missing.');

  let event=await graph((await calendarPath(accessToken))+'/events/'+encodeURIComponent(outlookEventId),accessToken) as GraphEvent;
  let finalShape=crmShape(record,ops);

  if(resolution==='keep_koa'){
    event=await updateOutlookEvent(accessToken,outlookEventId,finalShape);
  }else{
    const parts=localParts(event);
    if(parts.date){
      records[recordIndex]={...record,customer:{...(record.customer||{}),eventDate:parts.date},updatedAt:new Date().toISOString()};
      await saveRecords(context,records);
    }
    const nextOps={...ops};
    if(parts.startTime)nextOps.eventStart=parts.startTime;
    else delete nextOps.eventStart;
    if(parts.endTime)nextOps.eventEnd=parts.endTime;
    else delete nextOps.eventEnd;
    const location=clean(event.location?.displayName,180);
    if(location)nextOps.venueArea=location;
    nextOps.updatedAt=new Date().toISOString();
    await saveOps(context,recordId,nextOps);
    finalShape=crmShape(records[recordIndex],nextOps);
  }

  await syncStore(context).setJSON(linkKey,{
    recordId,outlookEventId:event.id,lastCrmHash:crmHash(finalShape),lastOutlookHash:outlookHash(event),lastSyncedAt:new Date().toISOString(),
  });
  const remaining=conflicts.filter((row)=>row.recordId!==recordId);
  await saveOffice365Conflicts(context,remaining);
  const resolved=((await syncStore(context).get('conflicts/resolved/index',{type:'json'}))||[]) as any[];
  await syncStore(context).setJSON('conflicts/resolved/index',[{
    ...conflict,resolution,resolvedAt:new Date().toISOString(),resolvedBy:clean(resolvedByInput,240)||'Unknown staff user',
    finalKoa:conflictSides(finalShape,event).koa,finalOffice365:conflictSides(finalShape,event).office365,
  },...resolved].slice(0,500));
  return {ok:true,recordId,resolution,remaining:remaining.length};
}


export async function repairOffice365VerificationIssue(context:Context,input:any,actor=''){
  const type=clean(input?.type,60);
  const recordId=clean(input?.recordId,200);
  const eventId=clean(input?.eventId,500);
  const confirmed=Boolean(input?.confirmed);
  if(!recordId||!eventId)throw new Error('Repair requires a CRM record ID and Office 365 event ID.');

  const accessToken=await token();
  const {entries}=await loadBooked(context);
  const entry=entries.find((row)=>clean(row?.shape?.recordId,200)===recordId);
  if(!entry)throw new Error('The linked CRM booking is no longer active or booked.');
  const shape=entry.shape;
  const event=await graph((await calendarPath(accessToken))+'/events/'+encodeURIComponent(eventId),accessToken) as GraphEvent;
  if(!event?.id)throw new Error('The Office 365 event no longer exists.');

  if(type==='restore_marker'){
    const existingMarker=recordIdFromEvent(event);
    if(existingMarker&&existingMarker!==recordId)throw new Error('This Outlook event is already linked to a different CRM booking.');
    const updated=eventHasRecordMarker(event,recordId)?event:await graph(
      (await calendarPath(accessToken))+'/events/'+encodeURIComponent(eventId),
      accessToken,
      {method:'PATCH',body:JSON.stringify({body:eventBodyWithMarker(event,recordId)})}
    ) as GraphEvent;
    await syncStore(context).setJSON('links/'+recordId,{
      recordId,outlookEventId:eventId,lastCrmHash:crmHash(shape),lastOutlookHash:outlookHash(updated),lastSyncedAt:new Date().toISOString(),
    });
    return {ok:true,repair:type,message:'Koa link marker restored.',verification:await verifyOffice365Calendar(context)};
  }

  if(type==='adopt_existing'){
    if(recordIdFromEvent(event))throw new Error('This Outlook event is already linked to a CRM booking.');
    const parts=localParts(event);
    if(!safeAdoptionCandidate(shape,event))throw new Error('This Outlook event is no longer an exact enough match for safe automatic adoption.');
    const updated=await graph(
      (await calendarPath(accessToken))+'/events/'+encodeURIComponent(eventId),
      accessToken,
      {method:'PATCH',body:JSON.stringify({body:eventBodyWithMarker(event,recordId)})}
    ) as GraphEvent;
    await syncStore(context).setJSON('links/'+recordId,{
      recordId,outlookEventId:eventId,lastCrmHash:crmHash(shape),lastOutlookHash:outlookHash(updated),lastSyncedAt:new Date().toISOString(),
    });
    return {ok:true,repair:type,message:'Existing Office 365 event adopted and linked to Koa’s.',verification:await verifyOffice365Calendar(context)};
  }

  if(type==='delete_duplicate'){
    if(!confirmed)throw new Error('Duplicate deletion requires explicit confirmation.');
    if(recordIdFromEvent(event))throw new Error('Linked Office 365 events cannot be deleted by duplicate repair.');
    const link=((await syncStore(context).get('links/'+recordId,{type:'json'}))||{}) as Partial<LinkState>;
    const linkedId=clean(link.outlookEventId,500);
    if(!linkedId||linkedId===eventId)throw new Error('A separate linked Office 365 event is required before deleting a duplicate.');
    const linked=await graph((await calendarPath(accessToken))+'/events/'+encodeURIComponent(linkedId),accessToken) as GraphEvent;
    if(!eventHasRecordMarker(linked,recordId))throw new Error('The retained Office 365 event is not securely linked to this CRM booking.');
    if(!exactDuplicate(shape,linked,event))throw new Error('The event no longer meets the strict duplicate safety check.');
    await graph((await calendarPath(accessToken))+'/events/'+encodeURIComponent(eventId),accessToken,{method:'DELETE'});
    return {ok:true,repair:type,message:'Confirmed duplicate Office 365 event deleted.',verification:await verifyOffice365Calendar(context)};
  }

  throw new Error('Unknown Office 365 verification repair action.');
}
