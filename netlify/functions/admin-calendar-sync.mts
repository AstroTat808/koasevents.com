import type { Context, Config } from '@netlify/functions';
import { requireCapability } from './_shared/admin';
import { getOutlookCalendarSyncStatus, runOutlookCalendarSync } from './_shared/outlook-calendar-sync';

export default async(req:Request,context:Context)=>{
  const auth=await requireCapability(req.method==='POST'?'events.manage':'calendar.view',req);
  if(auth.response)return auth.response;
  if(req.method==='GET')return Response.json(await getOutlookCalendarSyncStatus(context),{headers:{'Cache-Control':'private, no-store'}});
  if(req.method==='POST'){
    const status=await runOutlookCalendarSync(context);
    return Response.json({ok:status.state!=='error',status},{status:status.state==='error'?502:200});
  }
  return new Response('Method not allowed',{status:405});
};

export const config:Config={path:'/api/admin/calendar-sync'};
