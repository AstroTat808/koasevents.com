import type { Config, Context } from '@netlify/functions';
import {
  persistHealth,
  readLatestHealth,
  runSystemHealth,
  sendHealthTransitionAlerts,
} from './_shared/system-health';

export default async (_req:Request,context:Context) => {
  if(context.deploy.context!=='production') return;
  const previous=await readLatestHealth(context);
  const current=await runSystemHealth('hourly');
  await persistHealth(context,current);
  await sendHealthTransitionAlerts(previous,current);
};

export const config:Config={schedule:'@hourly'};
