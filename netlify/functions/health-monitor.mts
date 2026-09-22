import type { Config, Context } from '@netlify/functions';
import {
  applyHealthAlertPolicy,
  cachedDeploymentHistory,
  persistHealth,
  readLatestHealth,
  readLatestHourlyHealth,
  runSystemHealth,
  sendHealthTransitionAlerts,
} from './_shared/system-health';

export default async (_req:Request,context:Context) => {
  if(context.deploy.context!=='production') return;
  const [previous,previousHourly]=await Promise.all([
    readLatestHealth(context),
    readLatestHourlyHealth(context),
  ]);
  const current=await runSystemHealth(context,'hourly');
  await applyHealthAlertPolicy(context,current,previousHourly);
  await persistHealth(context,current);
  await sendHealthTransitionAlerts(previous,current);
  await cachedDeploymentHistory(context);
};

export const config:Config={schedule:'@hourly'};
