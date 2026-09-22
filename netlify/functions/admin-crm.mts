import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { capabilitiesFor, hasCapability, operationsRole, requireCapability } from './_shared/admin';
import { assessCrmRecord, normalizeCleanupMode } from './_shared/crm-cleanup';
import { appendCleanupAudit, cleanupClientSnapshotFromRecord, cleanupDimensionsFromRecord, readCleanupAudit } from './_shared/crm-cleanup-audit';
import { appendStaffAudit } from './_shared/staff-audit';

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
  const auth = await requireCapability('crm.view', req);
  if (auth.response) return auth.response;

  const crm = crmStoreFor(context);
  const sales = salesStoreFor(context);

  if (req.method === 'GET') {
    const salesRecords = await readIndex<any>(sales,'records/index');
    const [tasks, appointments, notes, workflows, enrollments, templates, metas, activity, messages, trash, cleanupAudit] = await Promise.all([
      readIndex<Task>(crm,'tasks/index'),
      readIndex<Appointment>(crm,'appointments/index'),
      readIndex<Note>(crm,'notes/index'),
      readIndex<Workflow>(crm,'workflows/index'),
      readIndex<Enrollment>(crm,'enrollments/index'),
      readIndex<Template>(crm,'templates/index'),
      readIndex<ProjectMeta>(crm,'projects/index'),
      readIndex<Activity>(crm,'activity/index'),
      readIndex<any>(crm,'client-messages/index'),
      readIndex<any>(sales,'trash/index'),
      readCleanupAudit(context,1500),
    ]);
    const metaMap = new Map(metas.map(m => [m.recordId,m]));
    const cleanupSettings:any = (await sales.get('settings/crm-cleanup',{type:'json'})) || { mode:'auto_trash', updatedAt:'', updatedBy:'' };
    const projects = salesRecords
      .filter((r:any) => Boolean(r) && r.kind !== 'quickbooks-test')
      .slice(0,1500)
      .map(r => ({...normalizeProject(r, metaMap.get(r.id) || null), cleanup: assessCrmRecord(r)}));

    const trashRows = await Promise.all((trash || []).map(async (entry:any) => ({
      entry,
      record: await sales.get('trash/records/' + entry.id,{type:'json'}),
    })));
    const groups:any[] = [];
    const seen = new Set<string>();
    for (const row of trashRows) {
      const record:any = row.record;
      if (!record || seen.has(row.entry.id)) continue;
      const ids = new Set<string>([row.entry.id]);
      if (record.quoteId) trashRows.filter((x:any)=>x.record?.quoteId===record.quoteId).forEach((x:any)=>ids.add(x.entry.id));
      let changed = true;
      while (changed) {
        changed = false;
        for (const candidate of trashRows) {
          const r:any = candidate.record;
          if (!r) continue;
          if ((r.source && ids.has(r.source)) || (record.source && r.id === record.source)) {
            if (!ids.has(r.id)) { ids.add(r.id); changed = true; }
            if (r.source && !ids.has(r.source)) { ids.add(r.source); changed = true; }
          }
        }
      }
      ids.forEach((id)=>seen.add(id));
      const members = trashRows.filter((x:any)=>ids.has(x.entry.id)).map((x:any)=>x.entry);
      groups.push({
        rootId: row.entry.id,
        ids:[...ids],
        count:members.length,
        customerName: row.entry.customerName || members[0]?.customerName || '',
        customerEmail: row.entry.customerEmail || members[0]?.customerEmail || '',
        eventDate: row.entry.eventDate || members[0]?.eventDate || '',
        deletedAt: members.map((m:any)=>m.deletedAt).sort().slice(-1)[0] || '',
        expiresAt: members.map((m:any)=>m.expiresAt).sort()[0] || '',
        members,
      });
    }

    const recordDimensions=new Map<string,any>();
    const recordClients=new Map<string,any>();
    for(const record of salesRecords){
      recordDimensions.set(record.id,cleanupDimensionsFromRecord(record));
      recordClients.set(record.id,{...cleanupClientSnapshotFromRecord(record),recordId:record.id,location:'active'});
    }
    for(const row of trashRows){
      if(!row.record) continue;
      recordDimensions.set(row.entry.id,cleanupDimensionsFromRecord(row.record));
      recordClients.set(row.entry.id,{...cleanupClientSnapshotFromRecord(row.record),recordId:row.entry.id,location:'trash'});
    }

    const effectiveDimensions=(entry:any)=>{
      const stored=entry?.dimensions;
      if(stored?.websiteForm||stored?.referralSource||stored?.emailDomain||stored?.brand||stored?.securityReasons?.length) return stored;
      return recordDimensions.get(entry?.recordId)||{
        websiteForm:'Unknown',
        referralSource:'Unknown',
        emailDomain:'Unknown',
        brand:'Unknown',
        securityReasons:[],
      };
    };
    const effectiveClient=(entry:any)=>{
      const recordId=clean(entry?.recordId,100);
      const stored=entry?.client||{};
      const fallback=recordClients.get(recordId)||{};
      return {
        recordId,
        name:clean(stored.name||fallback.name||'Unnamed client',180)||'Unnamed client',
        email:clean(stored.email||fallback.email,240),
        eventDate:clean(stored.eventDate||fallback.eventDate,40),
        kind:clean(stored.kind||fallback.kind||'record',40),
        location:clean(fallback.location||'audit',20),
        score:Math.max(0,Math.min(100,Number(entry?.score)||0)),
        createdAt:clean(entry?.createdAt,80),
        reasons:Array.isArray(entry?.reasons)?entry.reasons.map((x:any)=>clean(x,220)).filter(Boolean).slice(0,8):[],
      };
    };
    const uniqueClients=(entries:any[])=>{
      const seenIds=new Set<string>();
      const result:any[]=[];
      for(const entry of entries){
        const client=effectiveClient(entry);
        if(!client.recordId||seenIds.has(client.recordId)) continue;
        seenIds.add(client.recordId);
        result.push(client);
      }
      return result;
    };
    const localDateKey=(iso:string)=>{
      const d=new Date(iso);
      if(Number.isNaN(d.getTime())) return '';
      const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Pacific/Honolulu',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
      const year=parts.find((p)=>p.type==='year')?.value||'';
      const month=parts.find((p)=>p.type==='month')?.value||'';
      const day=parts.find((p)=>p.type==='day')?.value||'';
      return year&&month&&day?year+'-'+month+'-'+day:'';
    };
    const weekStartKey=(dateKey:string)=>{
      if(!dateKey) return '';
      const d=new Date(dateKey+'T12:00:00-10:00');
      const day=d.getDay();
      const offset=day===0?-6:1-day;
      d.setDate(d.getDate()+offset);
      return localDateKey(d.toISOString());
    };
    const labelDate=(key:string)=>{
      const d=new Date(key+'T12:00:00-10:00');
      return new Intl.DateTimeFormat('en-US',{timeZone:'Pacific/Honolulu',month:'short',day:'numeric'}).format(d);
    };
    const roundPct=(n:number,d:number)=>d>0?Math.round((n/d)*1000)/10:null;
    const allAudit=[...(cleanupAudit||[])].sort((a:any,b:any)=>Date.parse(a.createdAt)-Date.parse(b.createdAt));
    const caughtActions=new Set(['auto_flagged','manual_flagged','auto_trashed','moved_to_trash','bulk_moved_to_trash']);
    const laterAction=(recordId:string,after:string,actions:Set<string>)=>allAudit.some((entry:any)=>entry.recordId===recordId&&Date.parse(entry.createdAt)>Date.parse(after)&&actions.has(entry.action));

    const analytics:any={};
    for(const days of [7,30,90]){
      const cutoff=Date.now()-days*24*60*60*1000;
      const rows=allAudit.filter((entry:any)=>Date.parse(entry.createdAt)>=cutoff);
      const caughtRows=rows.filter((entry:any)=>caughtActions.has(entry.action)&&entry.recordId);
      const detectorRows=rows.filter((entry:any)=>['auto_flagged','auto_trashed'].includes(entry.action)&&entry.recordId);
      const falsePositiveRows=rows.filter((entry:any)=>entry.action==='approved_legitimate'&&entry.recordId);
      const autoTrashRows=rows.filter((entry:any)=>entry.action==='auto_trashed'&&entry.recordId);
      const restoreRows=rows.filter((entry:any)=>entry.action==='restored'&&entry.recordId);

      const firstCaughtById=new Map<string,any>();
      for(const entry of caughtRows){
        if(!firstCaughtById.has(entry.recordId)) firstCaughtById.set(entry.recordId,entry);
      }
      const firstDetectorById=new Map<string,any>();
      for(const entry of detectorRows){
        if(!firstDetectorById.has(entry.recordId)) firstDetectorById.set(entry.recordId,entry);
      }
      const firstApprovalById=new Map<string,any>();
      for(const entry of falsePositiveRows){
        if(!firstApprovalById.has(entry.recordId)) firstApprovalById.set(entry.recordId,entry);
      }
      const firstAutoTrashById=new Map<string,any>();
      for(const entry of autoTrashRows){
        if(!firstAutoTrashById.has(entry.recordId)) firstAutoTrashById.set(entry.recordId,entry);
      }
      const firstRestoreById=new Map<string,any>();
      for(const entry of restoreRows){
        if(!firstRestoreById.has(entry.recordId)) firstRestoreById.set(entry.recordId,entry);
      }

      const caughtEntries=[...firstCaughtById.values()];
      const detectorEntries=[...firstDetectorById.values()];
      const approvedEntries=[...firstApprovalById.values()];
      const autoTrashEntries=[...firstAutoTrashById.values()];
      const restoredEntries=[...firstRestoreById.values()];
      const caughtIds=new Set(firstCaughtById.keys());
      const falsePositiveCaughtEntries=detectorEntries.filter((entry:any)=>laterAction(entry.recordId,entry.createdAt,new Set(['approved_legitimate'])));
      const autoTrashReversedEntries=autoTrashEntries.filter((entry:any)=>laterAction(entry.recordId,entry.createdAt,new Set(['restored','approved_legitimate'])));
      const autoTrashRetainedEntries=autoTrashEntries.filter((entry:any)=>!laterAction(entry.recordId,entry.createdAt,new Set(['restored','approved_legitimate'])));

      const falsePositiveRate=roundPct(falsePositiveCaughtEntries.length,detectorEntries.length);
      const autoTrashAccuracy=roundPct(autoTrashRetainedEntries.length,autoTrashEntries.length);

      const breakdownMaps:any={
        websiteForm:new Map<string,any[]>(),
        referralSource:new Map<string,any[]>(),
        emailDomain:new Map<string,any[]>(),
        securityReason:new Map<string,any[]>(),
        brand:new Map<string,any[]>(),
      };
      const addBreakdown=(key:string,label:unknown,entry:any)=>{
        const cleanLabel=clean(label||'Unknown',180)||'Unknown';
        const map=breakdownMaps[key] as Map<string,any[]>;
        map.set(cleanLabel,[...(map.get(cleanLabel)||[]),entry]);
      };
      for(const entry of caughtEntries){
        const dims=effectiveDimensions(entry);
        addBreakdown('websiteForm',dims.websiteForm,entry);
        addBreakdown('referralSource',dims.referralSource,entry);
        addBreakdown('emailDomain',dims.emailDomain,entry);
        addBreakdown('brand',dims.brand,entry);
        const reasons=Array.isArray(dims.securityReasons)&&dims.securityReasons.length?dims.securityReasons:['No security reason'];
        for(const reason of new Set(reasons)) addBreakdown('securityReason',reason,entry);
      }
      const makeBreakdown=(map:Map<string,any[]>)=>[...map.entries()]
        .map(([label,entries])=>({label,count:uniqueClients(entries).length,clients:uniqueClients(entries)}))
        .sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label))
        .slice(0,15);

      const buildTrend=(granularity:'day'|'week')=>{
        const bucket=new Map<string,{period:string;caught:any[];detected:any[];approved:any[];autoTrash:any[]}>();
        const ensure=(iso:string)=>{
          const day=localDateKey(iso); if(!day) return null;
          const period=granularity==='day'?day:weekStartKey(day);
          const row=bucket.get(period)||{period,caught:[],detected:[],approved:[],autoTrash:[]};
          bucket.set(period,row); return row;
        };
        for(const entry of caughtEntries){const row=ensure(entry.createdAt);if(row)row.caught.push(entry);}
        for(const entry of detectorEntries){const row=ensure(entry.createdAt);if(row)row.detected.push(entry);}
        for(const entry of approvedEntries){const row=ensure(entry.createdAt);if(row)row.approved.push(entry);}
        for(const entry of autoTrashEntries){const row=ensure(entry.createdAt);if(row)row.autoTrash.push(entry);}

        const start=new Date(Date.now()-(days-1)*24*60*60*1000);
        const startKey=localDateKey(start.toISOString());
        const finalStart=granularity==='day'?startKey:weekStartKey(startKey);
        const endKey=localDateKey(new Date().toISOString());
        const finalEnd=granularity==='day'?endKey:weekStartKey(endKey);
        const cursor=new Date(finalStart+'T12:00:00-10:00');
        const endDate=new Date(finalEnd+'T12:00:00-10:00');
        const result:any[]=[];
        while(cursor<=endDate){
          const key=localDateKey(cursor.toISOString());
          const stored=bucket.get(key)||{period:key,caught:[],detected:[],approved:[],autoTrash:[]};
          const caughtClients=uniqueClients(stored.caught);
          const detectorClients=uniqueClients(stored.detected);
          const approvedClients=uniqueClients(stored.approved);
          const autoTrashClients=uniqueClients(stored.autoTrash);
          const falsePositives=stored.detected.filter((entry:any)=>laterAction(entry.recordId,entry.createdAt,new Set(['approved_legitimate'])));
          const retainedAutoTrash=stored.autoTrash.filter((entry:any)=>!laterAction(entry.recordId,entry.createdAt,new Set(['restored','approved_legitimate'])));
          result.push({
            period:key,
            label:granularity==='day'?labelDate(key):'Week of '+labelDate(key),
            bogusCaught:caughtClients.length,
            falsePositivesApproved:approvedClients.length,
            falsePositiveRate:roundPct(uniqueClients(falsePositives).length,detectorClients.length),
            autoTrashAccuracy:roundPct(uniqueClients(retainedAutoTrash).length,autoTrashClients.length),
            clients:{
              bogusCaught:caughtClients,
              falsePositivesApproved:approvedClients,
              autoTrashed:autoTrashClients,
              falsePositive:uniqueClients(falsePositives),
              autoTrashRetained:uniqueClients(retainedAutoTrash),
            },
          });
          cursor.setDate(cursor.getDate()+(granularity==='day'?1:7));
        }
        return result;
      };

      analytics[String(days)]={
        days,
        bogusCaught:caughtEntries.length,
        falsePositivesApproved:approvedEntries.length,
        autoTrashed:autoTrashEntries.length,
        restores:restoredEntries.length,
        falsePositiveRate,
        autoTrashAccuracy,
        kpiClients:{
          bogusCaught:uniqueClients(caughtEntries),
          falsePositivesApproved:uniqueClients(approvedEntries),
          autoTrashed:uniqueClients(autoTrashEntries),
          restores:uniqueClients(restoredEntries),
          falsePositive:uniqueClients(falsePositiveCaughtEntries),
          autoTrashRetained:uniqueClients(autoTrashRetainedEntries),
          autoTrashReversed:uniqueClients(autoTrashReversedEntries),
        },
        trends:{day:buildTrend('day'),week:buildTrend('week')},
        breakdowns:{
          websiteForm:makeBreakdown(breakdownMaps.websiteForm),
          referralSource:makeBreakdown(breakdownMaps.referralSource),
          emailDomain:makeBreakdown(breakdownMaps.emailDomain),
          securityReason:makeBreakdown(breakdownMaps.securityReason),
          brand:makeBreakdown(breakdownMaps.brand),
        },
      };
    }

    return Response.json({
      access:{
        role:operationsRole(auth.user),
        capabilities:capabilitiesFor(auth.user),
        email:clean(auth.user?.email,240).toLowerCase(),
      },
      projects,tasks,appointments,notes,workflows,enrollments,templates,activity,messages,trash,trashGroups:groups,cleanupAudit,cleanupAnalytics:analytics,cleanupSettings:{
        mode: normalizeCleanupMode(cleanupSettings.mode),
        updatedAt: cleanupSettings.updatedAt || '',
        updatedBy: cleanupSettings.updatedBy || '',
      }
    },{
      headers:{'Cache-Control':'private, no-store'}
    });
  }

  if (req.method !== 'POST') return new Response('Method not allowed',{status:405});
  const body:any = await req.json().catch(()=>null);
  if (!body) return Response.json({error:'Invalid JSON.'},{status:400});
  const action = clean(body.action,60);
  const actor = clean(auth.user?.email,240) || 'staff';
  const capabilityByAction:Record<string,any>={
    'save-cleanup-settings':'crm.cleanup_policy',
    'clear-cleanup-review':'crm.cleanup_policy',
    'trash-client-chain':'crm.destructive',
    'bulk-trash-client-chains':'crm.destructive',
    'restore-client-chain':'crm.destructive',
    'permanent-delete-client-chain':'crm.destructive',
    'save-workflow':'crm.workflows',
    'save-template':'crm.templates',
  };
  const requiredCapability=capabilityByAction[action] || 'crm.manage';
  if (!hasCapability(auth.user, requiredCapability)) {
    return Response.json({error:'You do not have permission for this CRM action.'},{status:403});
  }

  if (action === 'bulk-approve-cleanup-review') {
    const ids=Array.from(new Set((Array.isArray(body.recordIds)?body.recordIds:[]).map((value:any)=>clean(value,100)).filter(Boolean))).slice(0,100);
    if(!ids.length) return Response.json({error:'Select at least one client to approve.'},{status:400});
    const records=await readIndex<any>(sales,'records/index');
    const approved:string[]=[];
    const skipped:Array<{id:string;reason:string}>=[];
    const now=new Date().toISOString();

    for(const recordId of ids){
      const record=records.find((x:any)=>x.id===recordId);
      if(!record){skipped.push({id:recordId,reason:'CRM record not found.'});continue;}
      const before=assessCrmRecord(record);
      if(before.approvedLegitimate){skipped.push({id:recordId,reason:'Already approved legitimate.'});continue;}
      if(!['review','auto_trash'].includes(before.disposition)){
        skipped.push({id:recordId,reason:'Record no longer needs cleanup review.'});continue;
      }
      record.cleanupReview={verdict:'legitimate',reviewedAt:now,reviewedBy:actor};
      delete record.cleanupManualFlag;
      record.updatedAt=now;
      approved.push(record.id);
      await sales.setJSON('records/'+record.id,record);
      await appendActivity(crm,record.id,'cleanup_approved','Marked legitimate by '+actor+' through bulk review.');
      await appendCleanupAudit(context,{recordId:record.id,action:'approved_legitimate',actor,detail:'Client approved as legitimate through bulk Needs Review action.',score:before.score,reasons:before.reasons,dimensions:cleanupDimensionsFromRecord(record),client:cleanupClientSnapshotFromRecord(record)});
    }

    if(approved.length){
      await sales.setJSON('records/index',records.slice(0,1500));
    }
    return Response.json({ok:true,approved,skipped,count:approved.length},{headers:{'Cache-Control':'private, no-store'}});
  }

  if (action === 'approve-cleanup-review') {
    const recordId=clean(body.recordId,100);
    if(!recordId) return Response.json({error:'recordId required'},{status:400});
    const records=await readIndex<any>(sales,'records/index');
    const record=records.find((x:any)=>x.id===recordId);
    if(!record) return Response.json({error:'CRM record not found'},{status:404});
    const before=assessCrmRecord(record);
    const now=new Date().toISOString();
    record.cleanupReview={verdict:'legitimate',reviewedAt:now,reviewedBy:actor};
    delete record.cleanupManualFlag;
    record.updatedAt=now;
    await sales.setJSON('records/'+record.id,record);
    await sales.setJSON('records/index',records.map((x:any)=>x.id===record.id?record:x).slice(0,1500));
    await appendActivity(crm,record.id,'cleanup_approved','Marked legitimate by '+actor);
    await appendCleanupAudit(context,{recordId:record.id,action:'approved_legitimate',actor,detail:'Client approved as legitimate.',score:before.score,reasons:before.reasons,dimensions:cleanupDimensionsFromRecord(record),client:cleanupClientSnapshotFromRecord(record)});
    return Response.json({ok:true,recordId:record.id,cleanup:assessCrmRecord(record)});
  }

  if (action === 'clear-cleanup-review') {
    const recordId=clean(body.recordId,100);
    if(!recordId) return Response.json({error:'recordId required'},{status:400});
    const records=await readIndex<any>(sales,'records/index');
    const record=records.find((x:any)=>x.id===recordId);
    if(!record) return Response.json({error:'CRM record not found'},{status:404});
    delete record.cleanupReview;
    delete record.cleanupManualFlag;
    record.updatedAt=new Date().toISOString();
    await sales.setJSON('records/'+record.id,record);
    await sales.setJSON('records/index',records.map((x:any)=>x.id===record.id?record:x).slice(0,1500));
    await appendActivity(crm,record.id,'cleanup_review_reset','Cleanup review reset by '+actor);
    await appendCleanupAudit(context,{recordId:record.id,action:'review_reset',actor,detail:'Cleanup review override and manual flag cleared.'});
    return Response.json({ok:true,recordId:record.id,cleanup:assessCrmRecord(record)});
  }

  if (action === 'save-cleanup-settings') {
    const mode=normalizeCleanupMode(body.mode);
    const settings={mode,updatedAt:new Date().toISOString(),updatedBy:actor};
    await sales.setJSON('settings/crm-cleanup',settings);
    await appendCleanupAudit(context,{action:'policy_changed',actor,detail:'Cleanup policy changed to '+mode+'.'});
    await appendStaffAudit(context,{actor,action:'crm_cleanup_policy_changed',detail:'Changed CRM cleanup policy to '+mode+'.',metadata:{mode}});
    return Response.json({ok:true,settings});
  }

  if (action === 'flag-cleanup-review') {
    const recordId=clean(body.recordId,100);
    if(!recordId) return Response.json({error:'recordId required'},{status:400});
    const records=await readIndex<any>(sales,'records/index');
    const record=records.find((x:any)=>x.id===recordId);
    if(!record) return Response.json({error:'CRM record not found'},{status:404});
    delete record.cleanupReview;
    record.cleanupManualFlag={flaggedAt:new Date().toISOString(),flaggedBy:actor,note:clean(body.note,500)};
    record.updatedAt=new Date().toISOString();
    await sales.setJSON('records/'+record.id,record);
    await sales.setJSON('records/index',records.map((x:any)=>x.id===record.id?record:x).slice(0,1500));
    const assessment=assessCrmRecord(record);
    await appendActivity(crm,record.id,'cleanup_flagged','Manually flagged for review by '+actor);
    await appendCleanupAudit(context,{recordId:record.id,action:'manual_flagged',actor,detail:record.cleanupManualFlag.note||'Client manually flagged for review.',score:assessment.score,reasons:assessment.reasons,dimensions:cleanupDimensionsFromRecord(record),client:cleanupClientSnapshotFromRecord(record)});
    return Response.json({ok:true,recordId:record.id,cleanup:assessment});
  }

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
