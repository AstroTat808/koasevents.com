import type { Config, Context } from '@netlify/functions';
import { hasCapability, requireCapability } from './_shared/admin';
import {
  applyHealthAlertPolicy,
  beginCreditSaverMeasurement,
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
import { clearCreditSaverPolicy, creditSaverPreset, readCreditSaverPolicy, setCreditSaverAction, setCreditSaverMode, setCreditSaverModes } from './_shared/credit-saver';
import { emailHealthSummary } from './_shared/email-health';
import {
  credentialHealthSummary,
  readCredentialHealthSummary,
  recordCredentialSafeRepairAudit,
  saveCredentialReliabilityPolicy,
} from './_shared/credential-health';
import { weeklySystemHealthExecutiveSummary } from './_shared/weekly-health-summary';
import {
  office365CalendarConfig,
  readOffice365Conflicts,
  readOffice365SyncAudit,
  readOffice365SyncState,
} from './_shared/office365-calendar-sync';

function saverModeCredits(control:any,mode:string){
  if(mode==='paused')return Number(control?.pausedSavingsPerDay||0);
  if(mode==='saver')return Number(control?.saverSavingsPerDay||0);
  return 0;
}

function saverMeasurementInput(baseline:any,targetModes:any,source:string,label:string){
  const creditUsage=baseline?.creditUsage||{};
  const currentModes=creditUsage?.saverPolicy?.modes||{};
  const controls=Array.isArray(creditUsage?.jobControls)?creditUsage.jobControls:[];
  const predictedByJob=controls.map((control:any)=>{
    const fromMode=String(currentModes?.[control.jobId]||'normal');
    const toMode=String(targetModes?.[control.jobId]||fromMode);
    return {
      jobId:String(control?.jobId||''),
      label:String(control?.label||control?.jobId||'Scheduled job'),
      fromMode,
      toMode,
      predictedSavingsPerDay:Math.max(0,saverModeCredits(control,toMode)-saverModeCredits(control,fromMode)),
    };
  }).filter((row:any)=>row.jobId&&row.predictedSavingsPerDay>0);
  const changed=controls.some((control:any)=>String(currentModes?.[control.jobId]||'normal')!==String(targetModes?.[control.jobId]||currentModes?.[control.jobId]||'normal'));
  const predictedSavingsPerDay=predictedByJob.reduce((sum:number,row:any)=>sum+Number(row.predictedSavingsPerDay||0),0);
  return {
    source,
    label,
    changed,
    modes:targetModes,
    baselineCredits:Number(creditUsage?.totalEstimatedCredits||0),
    baselineDailyBurnRate:Number(creditUsage?.projection?.weightedDailyBurnRate||0),
    predictedSavingsPerDay,
    predictedByJob,
    productionDeployCount:Number(creditUsage?.productionDeploys||0),
    cycleStart:String(creditUsage?.cycleStart||''),
  };
}

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

    if(body?.action==='save-credential-reliability-thresholds'){
      try{
        const policy=await saveCredentialReliabilityPolicy(context,body?.providers||{},actor);
        const credentialHealth=await readCredentialHealthSummary(context);
        return Response.json({ok:true,policy,credentialHealth},{headers:{'Cache-Control':'private, no-store'}});
      }catch(error){
        return Response.json({
          error:error instanceof Error?error.message:'Unable to save Credential Health reliability thresholds.',
        },{status:400,headers:{'Cache-Control':'private, no-store'}});
      }
    }

    if(body?.action==='retest-credential'){
      try{
        const credentialId=String(body?.credentialId||'').trim();
        if(!credentialId)return Response.json({error:'Credential id is required.'},{status:400,headers:{'Cache-Control':'private, no-store'}});
        const credentialHealth=await credentialHealthSummary(context,{force:true,credentialId});
        return Response.json({
          ok:true,
          retestedCredentialId:credentialId,
          credentialHealth,
        },{headers:{'Cache-Control':'private, no-store'}});
      }catch(error){
        return Response.json({
          error:error instanceof Error?error.message:'Unable to re-test credential.',
        },{status:400,headers:{'Cache-Control':'private, no-store'}});
      }
    }

    if(body?.action==='fix-all-safe-problems'){
      try{
        const startedAt=new Date().toISOString();
        let before=await readCredentialHealthSummary(context);
        if(!before)before=await credentialHealthSummary(context,{force:true});
        const beforeRows=Array.isArray(before?.rows)?before.rows:[];
        const beforeById=new Map(beforeRows.map((row:any)=>[String(row?.id||''),row]));
        const attemptedIds=beforeRows.filter((row:any)=>!row?.ok).map((row:any)=>String(row?.id||'')).filter(Boolean);
        const latestBefore=await readLatestHealth(context);
        const beforeSystemIssues=(Array.isArray(latestBefore?.checks)?latestBefore.checks:[])
          .filter((row:any)=>!['email-send-access','email-monitoring-access'].includes(String(row?.id||'')))
          .filter((row:any)=>['Configuration Problem','Permission Problem'].includes(String(row?.issueType||''))&&(!row?.ok||String(row?.severity||'')==='yellow'||String(row?.severity||'')==='red'))
          .map((row:any)=>({
            id:String(row?.id||''),
            name:String(row?.name||row?.id||'System Health check'),
            issueType:String(row?.issueType||''),
            severity:String(row?.severity||'yellow'),
            detail:String(row?.detail||''),
          }));

        let credentialHealth=before;
        for(const credentialId of attemptedIds){
          credentialHealth=await credentialHealthSummary(context,{force:true,credentialId});
        }

        const afterRows=Array.isArray(credentialHealth?.rows)?credentialHealth.rows:[];
        const afterById=new Map(afterRows.map((row:any)=>[String(row?.id||''),row]));
        const retested=attemptedIds.map((id:string)=>{
          const beforeRow:any=beforeById.get(id)||{};
          const afterRow:any=afterById.get(id)||{};
          return {
            id,
            provider:String(afterRow?.provider||beforeRow?.provider||'Credential'),
            credential:String(afterRow?.credential||beforeRow?.credential||'Credential'),
            before:{
              ok:Boolean(beforeRow?.ok),
              severity:String(beforeRow?.severity||'yellow'),
              issueType:String(beforeRow?.issueType||'Credential problem'),
              status:Number(beforeRow?.status||0),
              detail:String(beforeRow?.detail||''),
            },
            after:{
              ok:Boolean(afterRow?.ok),
              severity:String(afterRow?.severity||'yellow'),
              issueType:String(afterRow?.issueType||'Credential problem'),
              status:Number(afterRow?.status||0),
              detail:String(afterRow?.detail||''),
            },
            fixed:Boolean(afterRow?.ok),
            changed:Boolean(beforeRow?.ok)!==Boolean(afterRow?.ok)
              || String(beforeRow?.severity||'')!==String(afterRow?.severity||'')
              || String(beforeRow?.issueType||'')!==String(afterRow?.issueType||'')
              || Number(beforeRow?.status||0)!==Number(afterRow?.status||0),
          };
        });
        const fixedItems=retested.filter((row:any)=>row.fixed);
        const unchangedItems=retested.filter((row:any)=>!row.fixed);

        const remainingCredentials=afterRows.filter((row:any)=>!row?.ok).map((row:any)=>({
          id:String(row?.id||''),
          provider:String(row?.provider||'Credential'),
          credential:String(row?.credential||'Credential'),
          issueType:String(row?.issueType||'Credential problem'),
          severity:String(row?.severity||'yellow'),
          detail:String(row?.detail||''),
          recommendedAction:row?.recommendedAction||null,
          requires:'Staff login, secret/configuration update, permission approval, or provider-side action.',
        }));
        const latestAfter=await readLatestHealth(context);
        const remainingSystemIssues=(Array.isArray(latestAfter?.checks)?latestAfter.checks:[])
          .filter((row:any)=>!['email-send-access','email-monitoring-access'].includes(String(row?.id||'')))
          .filter((row:any)=>['Configuration Problem','Permission Problem'].includes(String(row?.issueType||''))&&(!row?.ok||String(row?.severity||'')==='yellow'||String(row?.severity||'')==='red'))
          .map((row:any)=>({
            id:String(row?.id||''),
            name:String(row?.name||row?.id||'System Health check'),
            issueType:String(row?.issueType||''),
            severity:String(row?.severity||'yellow'),
            detail:String(row?.detail||''),
            requires:'Manual configuration or permission decision.',
          }));

        const completedAt=new Date().toISOString();
        const safeRepair={
          startedAt,
          completedAt,
          durationMs:Math.max(0,Date.parse(completedAt)-Date.parse(startedAt)),
          attempted:attemptedIds.length,
          fixed:fixedItems.length,
          fixedIds:fixedItems.map((row:any)=>row.id),
          remaining:remainingCredentials.length+remainingSystemIssues.length,
          before:{
            failedCredentials:beforeRows.filter((row:any)=>!row?.ok).map((row:any)=>({
              id:String(row?.id||''),
              provider:String(row?.provider||'Credential'),
              credential:String(row?.credential||'Credential'),
              issueType:String(row?.issueType||'Credential problem'),
              severity:String(row?.severity||'yellow'),
              detail:String(row?.detail||''),
            })),
            systemIssues:beforeSystemIssues,
          },
          retested,
          fixedItems,
          unchangedItems,
          after:{
            failedCredentials:remainingCredentials,
            systemIssues:remainingSystemIssues,
          },
          stillRequiresMe:[
            ...remainingCredentials.map((row:any)=>({...row,source:'credential'})),
            ...remainingSystemIssues.map((row:any)=>({...row,source:'system'})),
          ],
          detail:attemptedIds.length
            ? 'Safe automatic repair re-tested each failed credential independently, refreshed derived health state, and closed resolved credential alerts without changing secrets or external account permissions.'
            : 'No failed credentials needed a safe automatic re-test. Remaining configuration or permission items require staff action.',
        };
        const audit=await recordCredentialSafeRepairAudit(context,safeRepair,actor);
        const weeklyExecutiveSummary=await weeklySystemHealthExecutiveSummary(context);
        return Response.json({
          ok:true,
          credentialHealth,
          safeRepair:{...safeRepair,auditId:audit.id},
          weeklyExecutiveSummary,
        },{headers:{'Cache-Control':'private, no-store'}});
      }catch(error){
        return Response.json({
          error:error instanceof Error?error.message:'Unable to complete safe automatic repairs.',
        },{status:400,headers:{'Cache-Control':'private, no-store'}});
      }
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
        const baseline=await cachedDeploymentHistory(context);
        const currentModes=baseline?.creditUsage?.saverPolicy?.modes||{};
        const jobId=String(body.jobId||'');
        const mode=String(body.mode||'normal');
        const targetModes={...currentModes,[jobId]:mode};
        const measurement=saverMeasurementInput(baseline,targetModes,'manual','Manual scheduled-job mode change');
        const policy=await setCreditSaverMode(context,jobId as any,mode as any,actor);
        if(measurement.changed)await beginCreditSaverMeasurement(context,{...measurement,modes:policy.modes});
        return Response.json({ok:true,policy},{headers:{'Cache-Control':'private, no-store'}});
      }catch(error){
        return Response.json({error:error instanceof Error?error.message:'Unable to update scheduled-job mode.'},{status:400,headers:{'Cache-Control':'private, no-store'}});
      }
    }

    if(body?.action==='apply-credit-saver-plan'){
      try{
        const baseline=await cachedDeploymentHistory(context);
        const changes=body?.modes&&typeof body.modes==='object'?body.modes:{};
        const currentModes=baseline?.creditUsage?.saverPolicy?.modes||{};
        const targetModes={...currentModes,...changes};
        const measurement=saverMeasurementInput(baseline,targetModes,'automatic-plan','Automatic saver plan');
        const policy=await setCreditSaverModes(context,changes,actor);
        if(measurement.changed)await beginCreditSaverMeasurement(context,{...measurement,modes:policy.modes});
        return Response.json({ok:true,policy},{headers:{'Cache-Control':'private, no-store'}});
      }catch(error){
        return Response.json({error:error instanceof Error?error.message:'Unable to apply credit-saver plan.'},{status:400,headers:{'Cache-Control':'private, no-store'}});
      }
    }

    if(body?.action==='apply-credit-saver-preset'){
      try{
        const preset=creditSaverPreset(body?.presetId);
        if(!preset)return Response.json({error:'Unknown credit-saver preset.'},{status:400,headers:{'Cache-Control':'private, no-store'}});
        const baseline=await cachedDeploymentHistory(context);
        const measurement=saverMeasurementInput(baseline,preset.modes,'preset',preset.name);
        const policy=await setCreditSaverModes(context,preset.modes,actor);
        if(measurement.changed)await beginCreditSaverMeasurement(context,{...measurement,modes:policy.modes});
        return Response.json({ok:true,policy,preset},{headers:{'Cache-Control':'private, no-store'}});
      }catch(error){
        return Response.json({error:error instanceof Error?error.message:'Unable to apply credit-saver preset.'},{status:400,headers:{'Cache-Control':'private, no-store'}});
      }
    }

    if(body?.action==='set-credit-saver'){
      try{
        const baseline=await cachedDeploymentHistory(context);
        const policy=await setCreditSaverAction(
          context,
          String(body.actionId||'') as any,
          Boolean(body.enabled),
          actor,
        );
        const measurement=saverMeasurementInput(baseline,policy.modes,'recommendation','Recommended credit-saver action');
        if(measurement.changed)await beginCreditSaverMeasurement(context,measurement);
        return Response.json({ok:true,policy},{headers:{'Cache-Control':'private, no-store'}});
      }catch(error){
        return Response.json({error:error instanceof Error?error.message:'Unable to update credit-saver policy.'},{status:400,headers:{'Cache-Control':'private, no-store'}});
      }
    }

    if(body?.action==='clear-credit-saver'){
      const baseline=await cachedDeploymentHistory(context);
      const policy=await clearCreditSaverPolicy(context,actor);
      const measurement=saverMeasurementInput(baseline,policy.modes,'restore','Restore normal operations');
      if(measurement.changed)await beginCreditSaverMeasurement(context,measurement);
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
    const [office365,emailHealth]=await Promise.all([
      office365HealthSummary(context,deployments),
      emailHealthSummary(context),
    ]);
    const credentialHealth=await credentialHealthSummary(context,{emailHealth});
    const uptime=calculateUptime(uptimeHistory);
    const incidents=calculateIncidents(uptimeHistory);
    const hydratedReleases=await hydrateProductionReleaseMetadata(context,releases,12);
    deployments.releaseTimeline=releaseTimelineWithIncidents(hydratedReleases,deployments.history||[],incidents);
    const weeklyExecutiveSummary=await weeklySystemHealthExecutiveSummary(context);
    return Response.json({current,uptime,incidents,policy,components:healthComponents(),deployments,office365,emailHealth,credentialHealth,weeklyExecutiveSummary},{headers:{'Cache-Control':'private, no-store'}});
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
        checks:latest.checks.map(row=>({id:row.id,name:row.name,kind:row.kind,ok:row.ok,status:row.status,detail:row.detail,severity:row.severity,issueType:row.issueType||null})),
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
  const [office365,emailHealth]=await Promise.all([
    office365HealthSummary(context,deployments),
    emailHealthSummary(context),
  ]);
  const credentialHealth=await credentialHealthSummary(context,{emailHealth});
  const weeklyExecutiveSummary=await weeklySystemHealthExecutiveSummary(context);
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
    emailHealth,
    credentialHealth,
    weeklyExecutiveSummary,
  },{headers:{'Cache-Control':'private, no-store'}});
};

export const config:Config={path:'/api/admin/health'};
