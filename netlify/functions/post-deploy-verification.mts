import type { Config, Context } from '@netlify/functions';
import { runForEachTenant } from './_shared/tenant';
import {
  applyHealthAlertPolicy,
  persistHealth,
  readLatestHealth,
  readLatestHourlyHealth,
  readPostDeployVerification,
  recordProductionRelease,
  runSystemHealth,
  savePostDeployVerification,
  sendHealthTransitionAlerts,
  syntheticProbeReleaseVerification,
} from './_shared/system-health';
import { shouldRunScheduledJob } from './_shared/credit-saver';
import { runBrandedEmailProductionVerification } from './_shared/email-health';

function clean(value:unknown,max=300){
  return String(value||'').trim().slice(0,max);
}

async function runTenantJob(_req:Request,context:Context){
  if(!(await shouldRunScheduledJob(context,'post-deploy-verification'))) return;
  const deployId=clean(Netlify.env.get('DEPLOY_ID'),120);
  const commit=clean(Netlify.env.get('COMMIT_REF'),120);
  if(!deployId) return;

  const previousVerification=await readPostDeployVerification(context);
  if(previousVerification?.deployId===deployId && previousVerification?.status==='success') return;

  const [previous,previousHourly]=await Promise.all([
    readLatestHealth(context),
    readLatestHourlyHealth(context),
  ]);

  await runBrandedEmailProductionVerification(context,{deployId,commit});
  const current=await runSystemHealth(context,'post-deploy');
  await applyHealthAlertPolicy(context,current,previousHourly);
  await persistHealth(context,current);
  await sendHealthTransitionAlerts(previous,current);

  const syntheticProbeVerification=syntheticProbeReleaseVerification(current,'post-deploy-scheduled');
  const verification={
    deployId,
    commit,
    checkedAt:current.checkedAt,
    status:current.overall==='healthy'?'success':'failure',
    passed:current.passed,
    failed:current.failed,
    failedIds:current.failedIds,
    checkCount:current.checks.length,
    syntheticProbeVerification,
  };
  await savePostDeployVerification(context,verification);
  await recordProductionRelease(context,{
    deployId,
    commit,
    checkedAt:current.checkedAt,
    verification,
    syntheticProbeVerification,
  });
}
export default async (req:Request, context:Context) => {
  if (context.deploy.context !== 'production') return;
  return runForEachTenant(context, () => runTenantJob(req, context));
};

export const config:Config={
  schedule:'*/15 * * * *',
};