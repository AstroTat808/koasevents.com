import type { Context, Config } from '@netlify/functions';
import { runOutlookCalendarSync } from './_shared/outlook-calendar-sync';

export default async (_req:Request,context:Context)=>{
  if(context.deploy.context!=='production'){
    return Response.json({ok:true,skipped:true,reason:'Calendar sync only writes in production.'});
  }
  const status=await runOutlookCalendarSync(context);
  return Response.json({ok:status.state!=='error',status});
};

export const config:Config={schedule:'*/15 * * * *'};
