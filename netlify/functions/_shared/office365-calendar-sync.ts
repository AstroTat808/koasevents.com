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
function crmHash(shape:any){return JSON.stringify([shape.title,shape.date,shape.startTime,shape.endTime,shape.venue]);}
function outlookHash(event:GraphEvent){
  const p=localParts(event);
  return JSON.stringify([clean(event.subject,180),p.date,p.startTime,p.endTime,clean(event.location?.displayName,180)]);
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

export async function syncOffice365Calendar(context:Context){
  const cfg=office365CalendarConfig();
  const startedAt=new Date().toISOString();
  if(!cfg.configured){
    const state={configured:false,lastAttemptAt:startedAt,lastError:'Microsoft Graph environment variables are incomplete.'};
    await syncStore(context).setJSON('state',state);
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
    for(const event of outlookEvents){
      const rid=recordIdFromEvent(event);
      if(rid)linkedByRecord.set(rid,event); else if(!event.isAllDay||event.subject)external.push(toExternalItem(event));
    }

    let pushed=0,pulled=0,created=0,conflicts=0;
    let recordsChanged=false;
    for(const entry of entries){
      const shape=entry.shape;
      if(!shape.recordId||!shape.date)continue;
      const linkKey='links/'+shape.recordId;
      const link=((await syncStore(context).get(linkKey,{type:'json'}))||{}) as Partial<LinkState>;
      let event=linkedByRecord.get(shape.recordId);
      if(!event&&link.outlookEventId){
        try{event=await graph((await calendarPath(accessToken))+'/events/'+encodeURIComponent(link.outlookEventId),accessToken) as GraphEvent;}catch{}
      }
      if(!event){
        event=await createOutlookEvent(accessToken,shape);
        created++;
        await syncStore(context).setJSON(linkKey,{recordId:shape.recordId,outlookEventId:event.id,lastCrmHash:crmHash(shape),lastOutlookHash:outlookHash(event),lastSyncedAt:new Date().toISOString()});
        continue;
      }

      const currentCrmHash=crmHash(shape);
      const currentOutlookHash=outlookHash(event);
      const crmChanged=Boolean(link.lastCrmHash&&link.lastCrmHash!==currentCrmHash);
      const outlookChanged=Boolean(link.lastOutlookHash&&link.lastOutlookHash!==currentOutlookHash);

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
      }else if(crmChanged&&outlookChanged){
        // Never guess when both systems changed independently. Preserve both values and
        // surface a conflict so staff can choose which side should become authoritative.
        conflicts++;
        continue;
      }else if(crmChanged||!link.lastCrmHash){
        event=await updateOutlookEvent(accessToken,event.id,shape);pushed++;
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
    await syncStore(context).setJSON('external/index',external.filter((item)=>item.date));
    const state={configured:true,lastAttemptAt:startedAt,lastSuccessAt:new Date().toISOString(),lastError:'',created,pushed,pulled,conflicts,externalImported:external.length,calendarOwner:cfg.calendarOwner};
    await syncStore(context).setJSON('state',state);
    return state;
  }catch(error:any){
    const state={configured:true,lastAttemptAt:startedAt,lastError:clean(error?.message||error,1000)};
    await syncStore(context).setJSON('state',state);
    throw error;
  }
}
