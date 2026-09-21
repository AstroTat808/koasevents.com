import type { Config, Context } from '@netlify/functions';
import {
  persistHealth,
  readLatestHealth,
  runSystemHealth,
  sendHealthTransitionAlert,
} from './_shared/system-health';

export default async (_req:Request,context:Context) => {
  if(context.deploy.context!=='production') return;
  const previous=await readLatestHealth(context);
  const current=await runSystemHealth('hourly');
  await persistHealth(context,current);
  await sendHealthTransitionAlert(previous,current);
  return Response.json({ok:true,overall:current.overall,failed:current.failed,checkedAt:current.checkedAt});
};

export const config:Config={schedule:'@hourly'};
