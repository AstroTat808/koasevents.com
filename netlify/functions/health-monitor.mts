import type { Config, Context } from '@netlify/functions';
import { runForEachTenant } from './_shared/tenant';
import {
  applyHealthAlertPolicy,
  cachedDeploymentHistory,
  persistHealth,
  readLatestHealth,
  readLatestHourlyHealth,
  runSystemHealth,
  sendHealthTransitionAlerts,
} from './_shared/system-health';

async function runTenantJob(_req:Request,context:Context){
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
}
export default async (req:Request, context:Context) => {
  if (context.deploy.context !== 'production') return;
  return runForEachTenant(context, () => runTenantJob(req, context));
};

export const config:Config={schedule:'@hourly'};
