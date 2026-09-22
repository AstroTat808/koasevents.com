import type { Context, Config } from '@netlify/functions';
import { syncOffice365Calendar, verifyOffice365Calendar } from './_shared/office365-calendar-sync';

export default async(_req:Request,context:Context)=>{
  const sync=await syncOffice365Calendar(context,'production_verification','Temporary production verification');
  const verification=await verifyOffice365Calendar(context);
  console.log('Office 365 production verification',{sync,verification});
};

export const config:Config={schedule:'* * * * *'};
