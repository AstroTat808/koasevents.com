import type { Context, Config } from '@netlify/functions';
import { syncOffice365Calendar } from './_shared/office365-calendar-sync';

export default async(_req:Request,context:Context)=>{
  try{
    const result=await syncOffice365Calendar(context);
    console.log('Office 365 calendar sync complete',result);
  }catch(error){
    console.error('Office 365 calendar sync failed',error);
  }
};
export const config:Config={schedule:'@hourly'};
