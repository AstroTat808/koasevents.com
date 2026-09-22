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
import { clearCreditSaverPolicy, readCreditSaverPolicy, setCreditSaverAction, setCreditSaverMode, setCreditSaverModes } from './_shared/credit-saver';
import {
  office365CalendarConfig,
  readOffice365Conflicts,
  readOffice365SyncAudit,
  readOffice365SyncState,
} from './_shared/office365-calendar-sync';

function nextOfficeSyncIso(mode:string,now=new Date()){
  const next=new Date(now);
  next.setUTCMinutes(0,0,0);
  next.setUTCHours(next.getUTCHours()+1);
  if(mode==='saver'){
    while(next.getUTCHours()%4!==0)next.setUTCHours(next.getUTCHours()+1);
  }
  return next.toISOString();
}

async function office365HealthSummary(context:Context,deployments:any=null){
  const cfg=office365CalendarConfig();
  const [state,conflicts,auditRuns,creditSaverPolicy]=await Promise.all([
    readOffice365SyncState(context),
    readOffice365Conflicts(context),
    readOffice365SyncAudit(context),
    readCreditSaverPolicy(context),
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

  const functionSchedules=Array.isArray(deployments?.current?.functionSchedules)
    ? deployments.current.functionSchedules
    : [];
  const scheduledFunction=functionSchedules.find((row:any)=>String(row?.name||'')==='office365-calendar-sync')||null;
  const scheduledFunctionDeployed=Boolean(scheduledFunction);
  const scheduledFunctionCron=String(scheduledFunction?.cron||'');
  const office365Mode=String(creditSaverPolicy?.modes?.['office365-calendar-sync']||'normal');
  const syncPaused=office365Mode==='paused';
  const syncSaver=office365Mode==='saver';
  const rawCommitsBehind=Number(deployments?.current?.commitsBehind);
  const commitsBehind=Number.isFinite(rawCommitsBehind)?Math.max(0,rawCommitsBehind):null;
  const deploymentState=String(deployments?.connectionHealth?.deploymentState||'unknown');
  const deploymentLagTooHigh=Boolean(
    deployments?.connectionHealth?.lagTooHigh===true
    || (commitsBehind!=null&&commitsBehind>1)
  );
  const verificationStatus=deploymentLagTooHigh
    ? 'blocked'
    : commitsBehind===0
      ? 'ready'
      : commitsBehind===1
        ? (deploymentState==='deploying'||deploymentState==='waiting'?'catching_up':'caution')
        : 'unknown';
  const latestRun=allRuns[0]||null;
  const latestRunError=String(latestRun?.error||'').trim();
  const graphAuthFailed=Boolean(authErrorPattern.test(latestRunError||lastError));
  const graphAuthenticationStatus=!cfg.configured
    ? 'not_configured'
    : graphAuthFailed
      ? 'failed'
      : latestRun?.status==='success'||Boolean(state?.lastSuccessAt)
        ? 'succeeded'
        : 'awaiting';

  const operationalStatus=deploymentLagTooHigh
    ? 'production_behind'
    : graphAuthenticationStatus==='failed'
      ? 'authentication_failed'
      : !cfg.configured
        ? 'not_configured'
        : !scheduledFunctionDeployed
          ? 'schedule_missing'
          : syncPaused
            ? 'paused'
            : syncSaver
              ? 'saver'
              : verificationStatus==='caution'||verificationStatus==='catching_up'
              ? 'deployment_catching_up'
              : 'scheduled';
  const operationalSeverity=['production_behind','authentication_failed','not_configured','schedule_missing'].includes(operationalStatus)
    ? 'red'
    : ['paused','saver','deployment_catching_up'].includes(operationalStatus)
      ? 'yellow'
      : 'green';
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
    nextScheduledSyncAt:syncPaused?'':nextOfficeSyncIso(office365Mode),
    operationalStatus,
    operationalSeverity,
    signals:{
      scheduledFunction:{
        status:scheduledFunctionDeployed?'deployed':'missing',
        deployed:scheduledFunctionDeployed,
        cron:scheduledFunctionCron,
        name:'office365-calendar-sync',
      },
      creditSaver:{
        status:syncPaused?'paused':syncSaver?'saver':'active',
        mode:office365Mode,
        paused:syncPaused,
        saver:syncSaver,
        expiresAt:String(creditSaverPolicy?.expiresAt||''),
      },
      authentication:{
        status:graphAuthenticationStatus,
        failed:graphAuthenticationStatus==='failed',
        error:graphAuthenticationStatus==='failed'?(latestRunError||lastError):'',
      },
      verification:{
        status:verificationStatus,
        blocked:verificationStatus==='blocked',
        commitsBehind,
        deploymentState,
        productionCommit:String(deployments?.current?.commit||''),
        mainCommit:String(deployments?.current?.mainCommit||''),
      },
    },
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
      const deployments=await cachedDeploymentHistory(context);
      return Response.json({ok:true,policy,office365:await office365HealthSummary(context,deployments)},{headers:{'Cache-Control':'private, no-store'}});
    }

    if(body?.action==='compare-releases'){
      try{
        const comparison=await compareProductionReleaseCommits(String(body.baseCommit||''),String(body.headCommit||''));
        return Response.json({ok:true,comparison},{headers:{'Cache-Control':'private, no-store'}});
      }catch(error){
        return Response.json({error:error instanceof Error?error.message:'Unable to compare releases.'},{status:400,headers:{'Cache-Control':'private, no-store'}});
      }
    }

    if(body?.action==='set-credit-saver-mode'){
      try{
        const policy=await setCreditSaverMode(
          context,
          String(body.jobId||'') as any,
          String(body.mode||'normal') as any,
          actor,
        );
        return Response.json({ok:true,policy},{headers:{'Cache-Control':'private, no-store'}});
      }catch(error){
        return Response.json({error:error instanceof Error?error.message:'Unable to update scheduled-job mode.'},{status:400,headers:{'Cache-Control':'private, no-store'}});
      }
    }

    if(body?.action==='apply-credit-saver-plan'){
      try{
        const changes=body?.modes&&typeof body.modes==='object'?body.modes:{};
        const policy=await setCreditSaverModes(context,changes,actor);
        return Response.json({ok:true,policy},{headers:{'Cache-Control':'private, no-store'}});
      }catch(error){
        return Response.json({error:error instanceof Error?error.message:'Unable to apply credit-saver plan.'},{status:400,headers:{'Cache-Control':'private, no-store'}});
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
    const [uptimeHistory,policy,deployments,releases]=await Promise.all([
      readUptimeHistory(context,2300),
      readHealthAlertPolicy(context),
      cachedDeploymentHistory(context),
      readProductionReleases(context,50),
    ]);
    const office365=await office365HealthSummary(context,deployments);
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

  const [history,uptimeHistory,deployments,policy,releases]=await Promise.all([
    readHealthHistory(context,120),
    readUptimeHistory(context,2300),
    cachedDeploymentHistory(context),
    readHealthAlertPolicy(context),
    readProductionReleases(context,50),
  ]);
  const office365=await office365HealthSummary(context,deployments);
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
