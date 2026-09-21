import type { Config, Context } from '@netlify/functions';
import { isApprovedAdmin, requireOperations } from './_shared/admin';
import {
  applyHealthAlertPolicy,
  cachedDeploymentHistory,
  calculateIncidents,
  calculateUptime,
  healthComponents,
  persistHealth,
  readHealthAlertPolicy,
  readHealthHistory,
  readLatestHealth,
  readLatestHourlyHealth,
  readUptimeHistory,
  runSystemHealth,
  saveHealthAlertPolicy,
  sendHealthTransitionAlerts,
} from './_shared/system-health';

export default async (req:Request,context:Context) => {
  const auth=await requireOperations();
  if(auth.response) return auth.response;
  const admin=isApprovedAdmin(auth.user);

  if(req.method==='POST'){
    if(!admin) return Response.json({error:'Administrator permission required.'},{status:403});
    const body:any=await req.json().catch(()=>({}));
    const actor=String(auth.user?.email||'admin').trim().toLowerCase();

    if(body?.action==='save-policy'){
      const policy=await saveHealthAlertPolicy(context,body.policy||{},actor);
      return Response.json({ok:true,policy},{headers:{'Cache-Control':'private, no-store'}});
    }

    const [previous,previousHourly]=await Promise.all([
      readLatestHealth(context),
      readLatestHourlyHealth(context),
    ]);
    const current=await runSystemHealth('manual');
    await applyHealthAlertPolicy(context,current,previousHourly);
    await persistHealth(context,current);
    await sendHealthTransitionAlerts(previous,current);
    const [uptimeHistory,policy,deployments]=await Promise.all([
      readUptimeHistory(context,2300),
      readHealthAlertPolicy(context),
      cachedDeploymentHistory(context),
    ]);
    const uptime=calculateUptime(uptimeHistory);
    const incidents=calculateIncidents(uptimeHistory);
    return Response.json({current,uptime,incidents,policy,components:healthComponents(),deployments},{headers:{'Cache-Control':'private, no-store'}});
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

  const [history,uptimeHistory,deployments,policy]=await Promise.all([
    readHealthHistory(context,120),
    readUptimeHistory(context,2300),
    cachedDeploymentHistory(context),
    readHealthAlertPolicy(context),
  ]);
  const uptime=calculateUptime(uptimeHistory);
  const incidents=calculateIncidents(uptimeHistory);
  return Response.json({
    current:latest,
    history,
    uptime,
    incidents,
    policy,
    components:healthComponents(),
    deployments,
  },{headers:{'Cache-Control':'private, no-store'}});
};

export const config:Config={path:'/api/admin/health'};
