import type { Config, Context } from '@netlify/functions';
import {
  applyHealthAlertPolicy,
  persistHealth,
  readLatestHealth,
  readLatestHourlyHealth,
  readPostDeployVerification,
  runSystemHealth,
  savePostDeployVerification,
  sendHealthTransitionAlerts,
} from './_shared/system-health';

function clean(value:unknown,max=300){
  return String(value||'').trim().slice(0,max);
}

export default async (_req:Request,context:Context) => {
  const deployId=clean(Netlify.env.get('DEPLOY_ID'),120);
  const commit=clean(Netlify.env.get('COMMIT_REF'),120);
  if(!deployId) return;

  const previousVerification=await readPostDeployVerification(context);
  if(previousVerification?.deployId===deployId && previousVerification?.status==='success') return;

  const [previous,previousHourly]=await Promise.all([
    readLatestHealth(context),
    readLatestHourlyHealth(context),
  ]);

  const current=await runSystemHealth('post-deploy');
  await applyHealthAlertPolicy(context,current,previousHourly);
  await persistHealth(context,current);
  await sendHealthTransitionAlerts(previous,current);

  await savePostDeployVerification(context,{
    deployId,
    commit,
    checkedAt:current.checkedAt,
    status:current.overall==='healthy'?'success':'failure',
    passed:current.passed,
    failed:current.failed,
    failedIds:current.failedIds,
    checkCount:current.checks.length,
  });
};

export const config:Config={
  schedule:'*/5 * * * *',
};
