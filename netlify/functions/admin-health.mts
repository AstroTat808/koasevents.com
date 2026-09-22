import type { Config, Context } from '@netlify/functions';
import { hasCapability, requireCapability } from './_shared/admin';
import {
  applyHealthAlertPolicy,
  cachedDeploymentHistory,
  compareProductionReleaseCommits,
  calculateIncidents,
  calculateUptime,
  healthComponents,
  hydrateProductionReleaseMetadata,
  persistHealth,
  readHealthAlertPolicy,
  readHealthHistory,
  readLatestHealth,
  readLatestHourlyHealth,
  readProductionReleases,
  readUptimeHistory,
  releaseTimelineWithIncidents,
  runSystemHealth,
  saveHealthAlertPolicy,
  sendHealthTransitionAlerts,
} from './_shared/system-health';
import { clearCreditSaverPolicy, setCreditSaverAction } from './_shared/credit-saver';
import {
  office365CalendarConfig,
  readOffice365Conflicts,
  readOffice365SyncAudit,
  readOffice365SyncState,
} from './_shared/office365-calendar-sync';

function nextHourlySyncIso(now=new Date()){
  const next=new Date(now);
  next.setUTCMinutes(0,0,0);
  next.setUTCHours(next.getUTCHours()+1);
  return next.toISOString();
}

async function office365HealthSummary(context:Context){
  const cfg=office365CalendarConfig();
  const [state,conflicts,auditRuns]=await Promise.all([
    readOffice365SyncState(context),
    readOffice365Conflicts(context),
    readOffice365SyncAudit(context),
  ]);
  const allRuns=Array.isArray(auditRuns)?auditRuns:[];
  const runsSince=(days:number)=>allRuns.filter((run:any)=>{
    const at=Date.parse(String(run?.completedAt||run?.startedAt||''));
    return Number.isFinite(at)&&at>=Date.now()-days*24*60*60*1000;
  });
  const changedCount=(run:any)=>{
    const t=run?.totals||{};
    return Number(t.created||0)+Number(t.adopted||0)+Number(t.pushed||0)+Number(t.pulled||0);
  };
  const authErrorPattern=/token|unauthori[sz]ed|forbidden|\b401\b|\b403\b|permission|consent|credential|invalid_client|access denied/i;
  const reliabilityFor=(days:number)=>{
    const runs=runsSince(days);
    const totalRuns=runs.length;
    const successfulRuns=runs.filter((run:any)=>run?.status==='success').length;
    const conflictRuns=runs.filter((run:any)=>Number(run?.totals?.conflicted||0)>0).length;
    const authenticationFailures=runs.filter((run:any)=>authErrorPattern.test(String(run?.error||''))).length;
    const totalChanged=runs.reduce((sum:number,run:any)=>sum+changedCount(run),0);
    return {
      days,
      totalRuns,
      successfulRuns,
      successRate:totalRuns?Math.round((successfulRuns/totalRuns)*1000)/10:null,
      averageEventsChangedPerRun:totalRuns?Math.round((totalChanged/totalRuns)*10)/10:null,
      conflictRuns,
      conflictRate:totalRuns?Math.round((conflictRuns/totalRuns)*1000)/10:null,
      authenticationFailures,
      totalEventsChanged:totalChanged,
    };
  };
  const recentRuns=runsSince(1);
  const changedLast24Hours=recentRuns.reduce((total:number,run:any)=>total+changedCount(run),0);
  const lastError=String(state?.lastError||'').trim();
  const authFailure=authErrorPattern.test(lastError);
  const authenticationStatus=!cfg.configured
    ? 'not_configured'
    : lastError
      ? (authFailure?'authentication_error':'sync_error')
      : state?.lastSuccessAt
        ? 'connected'
        : 'configured';
  const policy=await readHealthAlertPolicy(context);
  const thresholds=policy.office365ReliabilityThresholds||{yellowBelow:98,redBelow:90};
  const sevenDay=reliabilityFor(7);
  const thirtyDay=reliabilityFor(30);
  const successForSeverity=sevenDay.successRate;
  const severity=successForSeverity==null
    ? 'unknown'
    : successForSeverity<Number(thresholds.redBelow||90)
      ? 'red'
      : successForSeverity<Number(thresholds.yellowBelow||98)
        ? 'yellow'
        : 'green';

  const hawaiiDate=(value:any)=>{
    const d=new Date(value);
    if(Number.isNaN(d.getTime()))return '';
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Pacific/Honolulu',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
    const by=Object.fromEntries(parts.map((part)=>[part.type,part.value]));
    return by.year+'-'+by.month+'-'+by.day;
  };
  const dailyKeys:string[]=[];
  for(let i=29;i>=0;i--){
    const d=new Date(Date.now()-i*24*60*60*1000);
    dailyKeys.push(hawaiiDate(d));
  }
  const trend=dailyKeys.map((day)=>{
    const runs=allRuns.filter((run:any)=>hawaiiDate(run?.completedAt||run?.startedAt)===day);
    const totalRuns=runs.length;
    const successfulRuns=runs.filter((run:any)=>run?.status==='success').length;
    const conflictRuns=runs.filter((run:any)=>Number(run?.totals?.conflicted||0)>0).length;
    const authenticationFailures=runs.filter((run:any)=>authErrorPattern.test(String(run?.error||''))).length;
    return {
      date:day,
      totalRuns,
      successRate:totalRuns?Math.round((successfulRuns/totalRuns)*1000)/10:null,
      conflictRuns,
      authenticationFailures,
    };
  });

  return {
    configured:Boolean(cfg.configured),
    authenticationStatus,
    lastError,
    lastAttemptAt:String(state?.lastAttemptAt||''),
    lastSuccessAt:String(state?.lastSuccessAt||''),
    nextScheduledSyncAt:nextHourlySyncIso(),
    unresolvedConflicts:Array.isArray(conflicts)?conflicts.length:0,
    changedLast24Hours,
    runsLast24Hours:recentRuns.length,
    reliability:{
      '7d':sevenDay,
      '30d':thirtyDay,
    },
    reliabilityTrend:trend,
    reliabilityThresholds:thresholds,
    severity,
    calendarOwner:String(cfg.calendarOwner||''),
    calendarName:String(cfg.calendarName||''),
  };
}

export default async (req:Request,context:Context) => {
  const auth=await requireCapability('health.view', req);
  if(auth.response) return auth.response;
  const admin=hasCapability(auth.user,'health.manage');

  if(req.method==='POST'){
    if(!admin) return Response.json({error:'System Health management permission required.'},{status:403});
    const body:any=await req.json().catch(()=>({}));
    const actor=String(auth.user?.email||'admin').trim().toLowerCase();

    if(body?.action==='save-policy'){
      const policy=await saveHealthAlertPolicy(context,body.policy||{},actor);
      return Response.json({ok:true,policy},{headers:{'Cache-Control':'private, no-store'}});
    }

    if(body?.action==='save-office365-thresholds'){
      const current=await readHealthAlertPolicy(context);
      const yellowBelow=Math.max(0,Math.min(100,Number(body?.yellowBelow)));
      const redBelow=Math.max(0,Math.min(100,Number(body?.redBelow)));
      if(!Number.isFinite(yellowBelow)||!Number.isFinite(redBelow))return Response.json({error:'Reliability thresholds must be numbers from 0 to 100.'},{status:400});
      if(redBelow>=yellowBelow)return Response.json({error:'Red threshold must be lower than the yellow threshold.'},{status:400});
      const policy=await saveHealthAlertPolicy(context,{
        ...current,
        office365ReliabilityThresholds:{yellowBelow,redBelow},
      },actor);
      return Response.json({ok:true,policy,office365:await office365HealthSummary(context)},{headers:{'Cache-Control':'private, no-store'}});
    }

    if(body?.action==='compare-releases'){
      try{
        const comparison=await compareProductionReleaseCommits(String(body.baseCommit||''),String(body.headCommit||''));
        return Response.json({ok:true,comparison},{headers:{'Cache-Control':'private, no-store'}});
      }catch(error){
        return Response.json({error:error instanceof Error?error.message:'Unable to compare releases.'},{status:400,headers:{'Cache-Control':'private, no-store'}});
      }
    }

    if(body?.action==='set-credit-saver'){
      try{
        const policy=await setCreditSaverAction(
          context,
          String(body.actionId||'') as any,
          Boolean(body.enabled),
          actor,
        );
        return Response.json({ok:true,policy},{headers:{'Cache-Control':'private, no-store'}});
      }catch(error){
        return Response.json({error:error instanceof Error?error.message:'Unable to update credit-saver policy.'},{status:400,headers:{'Cache-Control':'private, no-store'}});
      }
    }

    if(body?.action==='clear-credit-saver'){
      const policy=await clearCreditSaverPolicy(context,actor);
      return Response.json({ok:true,policy},{headers:{'Cache-Control':'private, no-store'}});
    }

    const [previous,previousHourly]=await Promise.all([
      readLatestHealth(context),
      readLatestHourlyHealth(context),
    ]);
    const current=await runSystemHealth(context,'manual');
    await applyHealthAlertPolicy(context,current,previousHourly);
    await persistHealth(context,current);
    await sendHealthTransitionAlerts(previous,current);
    const [uptimeHistory,policy,deployments,releases,office365]=await Promise.all([
      readUptimeHistory(context,2300),
      readHealthAlertPolicy(context),
      cachedDeploymentHistory(context),
      readProductionReleases(context,50),
      office365HealthSummary(context),
    ]);
    const uptime=calculateUptime(uptimeHistory);
    const incidents=calculateIncidents(uptimeHistory);
    const hydratedReleases=await hydrateProductionReleaseMetadata(context,releases,12);
    deployments.releaseTimeline=releaseTimelineWithIncidents(hydratedReleases,deployments.history||[],incidents);
    return Response.json({current,uptime,incidents,policy,components:healthComponents(),deployments,office365},{headers:{'Cache-Control':'private, no-store'}});
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

  const [history,uptimeHistory,deployments,policy,releases,office365]=await Promise.all([
    readHealthHistory(context,120),
    readUptimeHistory(context,2300),
    cachedDeploymentHistory(context),
    readHealthAlertPolicy(context),
    readProductionReleases(context,50),
    office365HealthSummary(context),
  ]);
  const uptime=calculateUptime(uptimeHistory);
  const incidents=calculateIncidents(uptimeHistory);
  const hydratedReleases=await hydrateProductionReleaseMetadata(context,releases,12);
  deployments.releaseTimeline=releaseTimelineWithIncidents(hydratedReleases,deployments.history||[],incidents);
  return Response.json({
    current:latest,
    history,
    uptime,
    incidents,
    policy,
    components:healthComponents(),
    deployments,
    office365,
  },{headers:{'Cache-Control':'private, no-store'}});
};

export const config:Config={path:'/api/admin/health'};
