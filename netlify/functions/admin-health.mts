import type { Config, Context } from '@netlify/functions';
import { isApprovedAdmin, requireOperations } from './_shared/admin';
import {
  cachedDeploymentHistory,
  calculateUptime,
  persistHealth,
  readHealthHistory,
  readLatestHealth,
  runSystemHealth,
  sendHealthTransitionAlerts,
} from './_shared/system-health';

export default async (req:Request,context:Context) => {
  const auth=await requireOperations();
  if(auth.response) return auth.response;
  const admin=isApprovedAdmin(auth.user);

  if(req.method==='POST'){
    if(!admin) return Response.json({error:'Administrator permission required.'},{status:403});
    const previous=await readLatestHealth(context);
    const current=await runSystemHealth('manual');
    await persistHealth(context,current);
    await sendHealthTransitionAlerts(previous,current);
    const deployments=await cachedDeploymentHistory(context);
    return Response.json({current,deployments},{headers:{'Cache-Control':'private, no-store'}});
  }

  if(req.method!=='GET') return new Response('Method not allowed',{status:405});

  const latest=await readLatestHealth(context);
  if(!admin){
    return Response.json({
      current:latest?{
        checkedAt:latest.checkedAt,
        overall:latest.overall,
        passed:latest.passed,
        failed:latest.failed,
        failedIds:latest.failedIds,
        checks:latest.checks.map(row=>({id:row.id,name:row.name,kind:row.kind,ok:row.ok,status:row.status,detail:row.detail})),
      }:null,
    },{headers:{'Cache-Control':'private, no-store'}});
  }

  const [history,uptimeHistory,deployments]=await Promise.all([
    readHealthHistory(context,120),
    readHealthHistory(context,5000),
    cachedDeploymentHistory(context),
  ]);
  const uptime=calculateUptime(uptimeHistory);
  return Response.json({current:latest,history,uptime,deployments},{headers:{'Cache-Control':'private, no-store'}});
};

export const config:Config={path:'/api/admin/health'};
