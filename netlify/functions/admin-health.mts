import type { Config, Context } from '@netlify/functions';
import { isApprovedAdmin, requireOperations } from './_shared/admin';
import {
  cachedDeploymentHistory,
  persistHealth,
  readHealthHistory,
  readLatestHealth,
  runSystemHealth,
} from './_shared/system-health';

export default async (req:Request,context:Context) => {
  const auth=await requireOperations();
  if(auth.response) return auth.response;
  const admin=isApprovedAdmin(auth.user);

  if(req.method==='POST'){
    if(!admin) return Response.json({error:'Administrator permission required.'},{status:403});
    const current=await runSystemHealth('manual');
    await persistHealth(context,current);
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

  const [history,deployments]=await Promise.all([
    readHealthHistory(context,120),
    cachedDeploymentHistory(context),
  ]);
  return Response.json({current:latest,history,deployments},{headers:{'Cache-Control':'private, no-store'}});
};

export const config:Config={path:'/api/admin/health'};
