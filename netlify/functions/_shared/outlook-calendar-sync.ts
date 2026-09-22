import { getDeployStore, getStore } from '@netlify/blobs';
import type { Context } from '@netlify/functions';

type Mapping = {
  recordId:string;
  outlookEventId:string;
  crmHash:string;
  outlookHash:string;
  lastSyncedAt:string;
  conflict?:boolean;
  conflictDetail?:string;
};

function clean(value:unknown,max=1000){return String(value??'').trim().slice(0,max);}
function salesStoreFor(context:Context){
  return context.deploy.context==='production'
    ? getStore({name:'koa-sales',consistency:'strong'})
    : getDeployStore({name:'koa-sales'});
}
function opsStoreFor(context:Context){
  return context.deploy.context==='production'
    ? getStore({name:'koa-event-ops',consistency:'strong'})
    : getDeployStore({name:'koa-event-ops'});
}
function syncStoreFor(context:Context){
  return context.deploy.context==='production'
    ? getStore({name:'koa-calendar-sync',consistency:'strong'})
    : getDeployStore({name:'koa-calendar-sync'});
}
function simpleHash(value:unknown){
  const input=JSON.stringify(value);
  let hash=2166136261;
  for(let i=0;i<input.length;i++){hash^=input.charCodeAt(i);hash=Math.imul(hash,16777619);}
  return (hash>>>0).toString(16).padStart(8,'0');
}
function pad(n:number){return String(n).padStart(2,'0');}
function nextDate(date:string){
  const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10);
}
function normalizeTime(value:unknown){
  const raw=clean(value,20);
  const match=raw.match(/^(\d{1,2}):(\d{2})/);
  if(!match)return '';
  return pad(Math.min(23,Number(match[1])))+':'+pad(Math.min(59,Number(match[2])));
}
function crmSnapshot(record:any,ops:any){
  return {
    name:clean(record?.customer?.name,180),
    eventDate:clean(record?.customer?.eventDate,10),
    eventType:clean(record?.inquiry?.eventType,120),
    start:normalizeTime(ops?.eventStart||ops?.setupStart),
    end:normalizeTime(ops?.eventEnd||ops?.teardownEnd),
    location:clean(ops?.venueArea,180)||'Koa’s Events',
  };
}
function graphSnapshot(event:any){
  return {
    subject:clean(event?.subject,250),
    start:clean(event?.start?.dateTime,40),
    end:clean(event?.end?.dateTime,40),
    location:clean(event?.location?.displayName,180),
    isAllDay:Boolean(event?.isAllDay),
    changeKey:clean(event?.changeKey,200),
    lastModifiedDateTime:clean(event?.lastModifiedDateTime,50),
  };
}
function eventPayload(record:any,ops:any){
  const snap=crmSnapshot(record,ops);
  const date=snap.eventDate;
  const hasTimes=Boolean(snap.start&&snap.end);
  let startDate=date,endDate=date,startTime=snap.start,endTime=snap.end;
  if(hasTimes&&endTime<=startTime)endDate=nextDate(date);
  if(!hasTimes){startTime='00:00';endTime='00:00';endDate=nextDate(date);}
  const marker='KOA_RECORD_ID:'+record.id;
  const body=[
    'Synced from Koa’s Master Calendar.',
    marker,
    snap.eventType?'Event type: '+snap.eventType:'',
  ].filter(Boolean).join('\n');
  return {
    subject:(snap.eventType&&snap.eventType.toLowerCase().includes('wedding')?'Wedding · ':'Koa’s Event · ')+(snap.name||record.id),
    body:{contentType:'text',content:body},
    location:{displayName:snap.location},
    isAllDay:!hasTimes,
    start:{dateTime:startDate+'T'+startTime+':00',timeZone:'Hawaiian Standard Time'},
    end:{dateTime:endDate+'T'+endTime+':00',timeZone:'Hawaiian Standard Time'},
    showAs:'busy',
    isReminderOn:false,
  };
}
async function graphToken(){
  const tenant=Netlify.env.get('MICROSOFT_GRAPH_TENANT_ID');
  const clientId=Netlify.env.get('MICROSOFT_GRAPH_CLIENT_ID');
  const clientSecret=Netlify.env.get('MICROSOFT_GRAPH_CLIENT_SECRET');
  if(!tenant||!clientId||!clientSecret)return '';
  const body=new URLSearchParams({
    client_id:clientId,
    client_secret:clientSecret,
    scope:'https://graph.microsoft.com/.default',
    grant_type:'client_credentials',
  });
  const response=await fetch('https://login.microsoftonline.com/'+encodeURIComponent(tenant)+'/oauth2/v2.0/token',{
    method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,
  });
  if(!response.ok)throw new Error('Microsoft token request failed ('+response.status+').');
  const json:any=await response.json();
  return clean(json.access_token,8000);
}
async function graphRequest(token:string,path:string,init:RequestInit={}){
  const response=await fetch('https://graph.microsoft.com/v1.0'+path,{
    ...init,
    headers:{
      Authorization:'Bearer '+token,
      Accept:'application/json',
      Prefer:'outlook.timezone="Hawaiian Standard Time"',
      ...(init.body?{'Content-Type':'application/json'}:{}),
      ...(init.headers||{}),
    },
  });
  if(response.status===204)return null;
  const text=await response.text();
  const json=text?JSON.parse(text):null;
  if(!response.ok){
    const detail=clean(json?.error?.message||text,500);
    const err:any=new Error('Microsoft Graph '+response.status+(detail?': '+detail:''));
    err.status=response.status;throw err;
  }
  return json;
}
async function resolveCalendar(token:string){
  const owner=Netlify.env.get('MICROSOFT_GRAPH_CALENDAR_OWNER')||'chris@koas.us';
  const configuredId=Netlify.env.get('MICROSOFT_GRAPH_CALENDAR_ID');
  if(configuredId)return {owner,id:configuredId,name:"Koa's Events"};
  const name=Netlify.env.get('MICROSOFT_GRAPH_CALENDAR_NAME')||"Koa's Events";
  const json:any=await graphRequest(token,'/users/'+encodeURIComponent(owner)+'/calendars?$select=id,name&$top=200');
  const calendar=(json?.value||[]).find((row:any)=>clean(row?.name,180).toLowerCase()===name.toLowerCase());
  if(!calendar)throw new Error('Outlook calendar "'+name+'" was not found for '+owner+'.');
  return {owner,id:calendar.id,name:calendar.name};
}
async function getEvent(token:string,owner:string,calendarId:string,eventId:string){
  try{
    return await graphRequest(token,'/users/'+encodeURIComponent(owner)+'/calendars/'+encodeURIComponent(calendarId)+'/events/'+encodeURIComponent(eventId));
  }catch(error:any){if(error?.status===404)return null;throw error;}
}
async function createEvent(token:string,owner:string,calendarId:string,payload:any){
  return await graphRequest(token,'/users/'+encodeURIComponent(owner)+'/calendars/'+encodeURIComponent(calendarId)+'/events',{
    method:'POST',body:JSON.stringify(payload),
  });
}
async function updateEvent(token:string,owner:string,calendarId:string,eventId:string,payload:any){
  return await graphRequest(token,'/users/'+encodeURIComponent(owner)+'/calendars/'+encodeURIComponent(calendarId)+'/events/'+encodeURIComponent(eventId),{
    method:'PATCH',body:JSON.stringify(payload),
  });
}
function applyOutlookToCrm(record:any,ops:any,event:any){
  const start=clean(event?.start?.dateTime,40);
  const end=clean(event?.end?.dateTime,40);
  const eventDate=start.slice(0,10);
  if(eventDate)record.customer={...(record.customer||{}),eventDate};
  if(!event?.isAllDay){
    ops.eventStart=start.slice(11,16);
    ops.eventEnd=end.slice(11,16);
  }
  const location=clean(event?.location?.displayName,180);
  if(location)ops.venueArea=location;
  record.updatedAt=new Date().toISOString();
}
async function listCalendarEvents(token:string,owner:string,calendarId:string,start:string,end:string){
  let url='/users/'+encodeURIComponent(owner)+'/calendars/'+encodeURIComponent(calendarId)+'/calendarView?startDateTime='+encodeURIComponent(start)+'&endDateTime='+encodeURIComponent(end)+'&$top=200';
  const rows:any[]=[];
  while(url&&rows.length<1000){
    const json:any=await graphRequest(token,url);
    rows.push(...(json?.value||[]));
    const next=clean(json?.['@odata.nextLink'],4000);
    url=next?next.replace('https://graph.microsoft.com/v1.0',''):'';
  }
  return rows;
}
function markerRecordId(event:any){
  const body=clean(event?.body?.content,10000);
  const match=body.match(/KOA_RECORD_ID:([A-Za-z0-9_-]+)/);
  return match?.[1]||'';
}
export function outlookSyncConfigured(){
  return Boolean(Netlify.env.get('MICROSOFT_GRAPH_TENANT_ID')&&Netlify.env.get('MICROSOFT_GRAPH_CLIENT_ID')&&Netlify.env.get('MICROSOFT_GRAPH_CLIENT_SECRET'));
}
export async function runOutlookCalendarSync(context:Context){
  const store=syncStoreFor(context);
  const now=new Date().toISOString();
  if(!outlookSyncConfigured()){
    const status={configured:false,lastRunAt:now,state:'not_configured',message:'Microsoft Graph credentials are not configured.'};
    await store.setJSON('status',status);return status;
  }
  try{
    const token=await graphToken();
    const calendar=await resolveCalendar(token);
    const sales=salesStoreFor(context),opsStore=opsStoreFor(context);
    const records:any[]=((await sales.get('records/index',{type:'json'}))||[]) as any[];
    const booked=records.filter((record:any)=>record?.kind==='proposal'&&record?.stage==='booked'&&record?.proposal?.status==='booked'&&clean(record?.customer?.eventDate,10));
    const mappings:Mapping[]=((await store.get('mappings/index',{type:'json'}))||[]) as Mapping[];
    const mappingMap=new Map(mappings.map((row)=>[row.recordId,row]));
    let created=0,updatedOutlook=0,updatedMaster=0,conflicts=0,missing=0;
    let recordsChanged=false;

    for(const record of booked){
      const ops:any=(await opsStore.get('events/'+record.id,{type:'json'}))||{};
      const crm=crmSnapshot(record,ops);
      const crmHash=simpleHash(crm);
      let mapping=mappingMap.get(record.id);
      if(!mapping){
        const createdEvent=await createEvent(token,calendar.owner,calendar.id,eventPayload(record,ops));
        mapping={recordId:record.id,outlookEventId:createdEvent.id,crmHash,outlookHash:simpleHash(graphSnapshot(createdEvent)),lastSyncedAt:now};
        mappingMap.set(record.id,mapping);created++;
        continue;
      }
      const event=await getEvent(token,calendar.owner,calendar.id,mapping.outlookEventId);
      if(!event){
        mapping.conflict=true;mapping.conflictDetail='Mapped Outlook event is missing. CRM event was not deleted or recreated automatically.';mapping.lastSyncedAt=now;
        conflicts++;missing++;continue;
      }
      const outlookHash=simpleHash(graphSnapshot(event));
      const crmChanged=Boolean(mapping.crmHash&&mapping.crmHash!==crmHash);
      const outlookChanged=Boolean(mapping.outlookHash&&mapping.outlookHash!==outlookHash);
      mapping.conflict=false;mapping.conflictDetail='';
      if(crmChanged&&outlookChanged){
        mapping.conflict=true;mapping.conflictDetail='Both Master Calendar and Outlook changed since the last sync. No overwrite was performed.';conflicts++;
      }else if(crmChanged){
        const updated=await updateEvent(token,calendar.owner,calendar.id,mapping.outlookEventId,eventPayload(record,ops));
        mapping.crmHash=crmHash;mapping.outlookHash=simpleHash(graphSnapshot(updated));updatedOutlook++;
      }else if(outlookChanged){
        applyOutlookToCrm(record,ops,event);
        await opsStore.setJSON('events/'+record.id,ops);
        mapping.crmHash=simpleHash(crmSnapshot(record,ops));mapping.outlookHash=outlookHash;updatedMaster++;recordsChanged=true;
      }else{
        mapping.crmHash=crmHash;mapping.outlookHash=outlookHash;
      }
      mapping.lastSyncedAt=now;
    }
    if(recordsChanged)await sales.setJSON('records/index',records);

    const rangeStart=new Date();rangeStart.setUTCDate(rangeStart.getUTCDate()-90);
    const rangeEnd=new Date();rangeEnd.setUTCDate(rangeEnd.getUTCDate()+730);
    const outlookEvents=await listCalendarEvents(token,calendar.owner,calendar.id,rangeStart.toISOString(),rangeEnd.toISOString());
    const mappedIds=new Set([...mappingMap.values()].map((row)=>row.outlookEventId));
    const external=outlookEvents.filter((event:any)=>!mappedIds.has(event.id)&&!markerRecordId(event)).map((event:any)=>({
      id:event.id,
      subject:clean(event.subject,250)||'Outlook event',
      start:clean(event.start?.dateTime,40),
      end:clean(event.end?.dateTime,40),
      isAllDay:Boolean(event.isAllDay),
      location:clean(event.location?.displayName,180),
      webLink:clean(event.webLink,2000),
      lastModifiedDateTime:clean(event.lastModifiedDateTime,50),
    }));
    await store.setJSON('external/index',external);
    await store.setJSON('mappings/index',[...mappingMap.values()]);
    const status={
      configured:true,state:conflicts?'conflict':'healthy',lastRunAt:now,
      calendar:{owner:calendar.owner,name:calendar.name},
      totals:{booked:booked.length,created,updatedOutlook,updatedMaster,conflicts,missing,external:external.length},
      message:conflicts?conflicts+' sync conflict(s) require review.':'Outlook calendar sync completed successfully.',
    };
    await store.setJSON('status',status);return status;
  }catch(error:any){
    const status={configured:true,state:'error',lastRunAt:now,message:clean(error?.message||error,1000)};
    await store.setJSON('status',status);return status;
  }
}
export async function getOutlookCalendarSyncStatus(context:Context){
  const store=syncStoreFor(context);
  return (await store.get('status',{type:'json'}))||{configured:outlookSyncConfigured(),state:'never_run',lastRunAt:'',message:'Calendar sync has not run yet.'};
}
export async function getExternalOutlookCalendarItems(context:Context,start:string,end:string){
  const store=syncStoreFor(context);
  const rows:any[]=((await store.get('external/index',{type:'json'}))||[]) as any[];
  return rows.filter((row)=>clean(row.start,40).slice(0,10)>=start&&clean(row.start,40).slice(0,10)<=end).map((row)=>({
    id:'outlook-'+row.id,date:clean(row.start,40).slice(0,10),time:row.isAllDay?'':clean(row.start,40).slice(11,16),endTime:row.isAllDay?'':clean(row.end,40).slice(11,16),
    type:'external',subtype:'outlook',title:row.subject,detail:['Outlook shared calendar',row.location].filter(Boolean).join(' · '),status:'scheduled',
    recordId:'',customerName:row.subject,owner:'',venueArea:row.location||'',outlookEventId:row.id,outlookWebLink:row.webLink||'',
  }));
}
