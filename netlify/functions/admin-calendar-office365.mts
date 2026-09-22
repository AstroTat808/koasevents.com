import type { Context, Config } from '@netlify/functions';
import { requireAdmin } from './_shared/admin';
import { office365CalendarConfig, readOffice365Conflicts, readOffice365ResolvedConflicts, readOffice365SyncAudit, readOffice365SyncState, resolveOffice365Conflict, syncOffice365Calendar, verifyOffice365Calendar } from './_shared/office365-calendar-sync';

export default async(req:Request,context:Context)=>{
  const auth=await requireAdmin(req);if(auth.response)return auth.response;
  if(req.method==='GET'){
    const config=office365CalendarConfig();
    const state=await readOffice365SyncState(context);
    return Response.json({
      configured:config.configured,
      calendarOwner:config.calendarOwner,
      calendarIdConfigured:Boolean(config.calendarId),
      lastAttemptAt:state.lastAttemptAt||'',
      lastSuccessAt:state.lastSuccessAt||'',
      lastError:state.lastError||'',
      created:Number(state.created||0),
      pushed:Number(state.pushed||0),
      pulled:Number(state.pulled||0),
      conflicts:Number(state.conflicts||0),
      externalImported:Number(state.externalImported||0),
      conflicts:await readOffice365Conflicts(context),
      resolvedConflicts:await readOffice365ResolvedConflicts(context),
      auditRuns:await readOffice365SyncAudit(context),
    },{headers:{'Cache-Control':'private, no-store'}});
  }
  if(req.method==='POST'){
    try{
      const body:any=await req.json().catch(()=>({}));
      if(body?.action==='resolve_conflict'){
        const result=await resolveOffice365Conflict(context,body.recordId,body.resolution,auth.user?.email||'Unknown staff user');
        return Response.json(result,{headers:{'Cache-Control':'private, no-store'}});
      }
      if(body?.action==='sync_verify'){
        const sync=await syncOffice365Calendar(context,'manual_verify',auth.user?.email||'Unknown staff user');
        const verification=await verifyOffice365Calendar(context);
        return Response.json({ok:Boolean(verification.ok),sync,verification},{headers:{'Cache-Control':'private, no-store'}});
      }
      if(body?.action==='verify_only'){
        const verification=await verifyOffice365Calendar(context);
        return Response.json({ok:Boolean(verification.ok),verification},{headers:{'Cache-Control':'private, no-store'}});
      }
      const result=await syncOffice365Calendar(context,'manual',auth.user?.email||'Unknown staff user');
      return Response.json({ok:true,...result},{headers:{'Cache-Control':'private, no-store'}});
    }catch(error:any){
      return Response.json({ok:false,error:String(error?.message||error||'Office 365 calendar operation failed.')},{status:500});
    }
  }
  return new Response('Method not allowed',{status:405});
};
export const config:Config={path:'/api/admin/calendar-office365'};
