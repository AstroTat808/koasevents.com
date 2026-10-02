import type { Config, Context } from '@netlify/functions';
import { hasCapability, requireCapability } from './_shared/admin';
import { resolveTenant } from './_shared/tenant';
import {
  applyHealthAlertPolicy,
  beginCreditSaverMeasurement,
  cachedDeploymentHistory,
  compareProductionReleaseCommits,
  criticalIntegrationsSummary,
  calculateIncidents,
  calculateUptime,
  healthComponents,
  healthCoverageSummary,
  hydrateProductionReleaseMetadata,
  persistHealth,
  readHealthAlertPolicy,
  readHealthHistory,
  readAccountingInvariantIncidents,
  readLatestHealth,
  readLatestHourlyHealth,
  readProductionReleases,
  readAllProductionReleaseAudits,
  rollbackReadySummary,
  runSafeCriticalIntegrationRollbackDrill,
  readUptimeHistory,
  releaseTimelineWithIncidents,
  runSystemHealth,
  saveHealthAlertPolicy,
  sendHealthTransitionAlerts,
} from './_shared/system-health';
import { clearCreditSaverPolicy, creditSaverPreset, readCreditSaverPolicy, setCreditSaverAction, setCreditSaverMode, setCreditSaverModes } from './_shared/credit-saver';
import { emailHealthSummary, testResendWebhookDelivery } from './_shared/email-health';
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
import {
  criticalIntegrationAuditFilterSummary,
  criticalIntegrationAuditFilters,
  filterCriticalIntegrationAudits,
} from './_shared/critical-integration-audit.mjs';

function csvCell(value:any){
  const text=String(value??'');
  return /[",\n\r]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text;
}

function criticalIntegrationAuditCsv(releases:any[]){
  const headers=[
    'deploy_id','commit','commit_title','published_at','recorded_at',
    'release_verification_status','healthy_count','total_count','verification_checked_at',
    'accounting_status','accounting_checked_at','accounting_dynamic_client_count','accounting_dynamic_failed_count','accounting_dynamic_unverified_count',
    'probe_id','probe_name','probe_ok','probe_http_status','probe_source','probe_marker','probe_expected_marker','probe_last_live_checked_at','probe_detail',
    'rollback_status','rollback_checked_at','rollback_from_deploy_id','rollback_from_commit','rollback_target_deploy_id','rollback_target_commit','rollback_reason','rollback_http_status','rollback_error'
  ];
  const rows=[headers];
  for(const release of releases||[]){
    const verification=release?.syntheticProbeVerification||null;
    const accounting=release?.accountingVerification||null;
    const invariant=accounting?.invariant||null;
    const probes=Array.isArray(verification?.probes)&&verification.probes.length?verification.probes:[null];
    for(const probe of probes){
      const rollback=release?.rollbackProtection||null;
      rows.push([
        release?.deployId||'',release?.commit||'',release?.commitTitle||'',release?.publishedAt||'',release?.recordedAt||'',
        verification?.status||'unrecorded',verification?.healthyCount??'',verification?.totalCount??'',verification?.checkedAt||'',
        accounting?.status||'unverified',accounting?.checkedAt||'',invariant?.dynamicClientCount??'',invariant?.dynamicClientFailedCount??'',invariant?.dynamicClientUnverifiedCount??'',
        probe?.id||'',probe?.name||'',probe==null?'':Boolean(probe?.ok),probe?.status??'',probe?.source||'',probe?.marker||'',probe?.expectedMarker||'',probe?.lastLiveCheckedAt||'',probe?.detail||'',
        rollback?.status||'',rollback?.checkedAt||'',rollback?.fromDeployId||'',rollback?.fromCommit||'',rollback?.targetDeployId||'',rollback?.targetCommit||'',rollback?.reason||'',rollback?.httpStatus??'',rollback?.error||''
      ]);
    }
  }
  return rows.map((row)=>row.map(csvCell).join(',')).join('\n');
}

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

async function safeHealthSection<T>(
  warnings:Array<{section:string;error:string}>,
  section:string,
  task:()=>Promise<T>,
  fallback:T,
):Promise<T>{
  try{
    return await task();
  }catch(error){
    const message=error instanceof Error?error.message:String(error||'Unknown error');
    warnings.push({section,error:message});
    console.error('[admin-health] '+section+' enrichment failed:',error);
    return fallback;
  }
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

  const tenantDate=(value:any)=>{
    const d=new Date(value);
    if(Number.isNaN(d.getTime()))return '';
    const parts=new Intl.DateTimeFormat(resolveTenant().locale,{timeZone:resolveTenant().timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
    const by=Object.fromEntries(parts.map((part)=>[part.type,part.value]));
    return by.year+'-'+by.month+'-'+by.day;
  };
  const dailyKeys:string[]=[];
  for(let i=29;i>=0;i--){
    const d=new Date(Date.now()-i*24*60*60*1000);
    dailyKeys.push(tenantDate(d));
  }
  const trend=dailyKeys.map((day)=>{
    const runs=allRuns.filter((run:any)=>tenantDate(run?.completedAt||run?.startedAt)===day);
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

function accountingHealthSummary(latest:any,history:any[],persistentIncidents:any[]=[]){
  const rows=[latest,...(Array.isArray(history)?history:[])].filter(Boolean);
  const seen=new Set<string>();
  const samples=rows
    .filter((snapshot:any)=>{
      const key=String(snapshot?.id||snapshot?.checkedAt||'');
      if(!key||seen.has(key))return false;
      seen.add(key);
      return true;
    })
    .map((snapshot:any)=>{
      const check=(Array.isArray(snapshot?.checks)?snapshot.checks:[]).find((row:any)=>row?.id==='quickbooks-tax-invariant');
      return check?{
        checkedAt:String(snapshot.checkedAt||''),
        source:String(snapshot.source||''),
        alerted:(snapshot.alertFailedIds||[]).includes('quickbooks-tax-invariant'),
        ok:Boolean(check.ok),
        severity:String(check.severity||''),
        status:Number(check.status||0),
        detail:String(check.detail||''),
        accountingDetails:check.accountingDetails||null,
      }:null;
    })
    .filter(Boolean)
    .sort((a:any,b:any)=>Date.parse(b.checkedAt)-Date.parse(a.checkedAt));

  const latestSample:any=samples[0]||null;
  const lastSuccessful:any=samples.find((sample:any)=>sample.ok)||null;
  const failures=samples.filter((sample:any)=>!sample.ok).slice(0,12);
  const chronological=[...samples].reverse();
  const alertHistory:any[]=[];
  let prior:any=null;
  for(const sample of chronological){
    if(!prior){
      if(!sample.ok||sample.alerted){
        alertHistory.push({
          checkedAt:sample.checkedAt,
          type:sample.alerted?'alerted':'failed',
          severity:sample.severity,
          detail:sample.detail,
        });
      }
      prior=sample;
      continue;
    }
    const becameFailed=prior.ok&&!sample.ok;
    const recovered=!prior.ok&&sample.ok;
    const becameAlerted=!prior.alerted&&sample.alerted;
    const liveStatusChanged=String(prior?.accountingDetails?.liveNonTaxStatus||'')!==String(sample?.accountingDetails?.liveNonTaxStatus||'');
    const liveClientStatusChanged=String(prior?.accountingDetails?.liveClientInvariant?.status||'')!==String(sample?.accountingDetails?.liveClientInvariant?.status||'');
    if(becameAlerted||becameFailed||recovered||liveStatusChanged||liveClientStatusChanged){
      alertHistory.push({
        checkedAt:sample.checkedAt,
        type:recovered?'recovered':becameAlerted?'alerted':becameFailed?'failed':'configuration_changed',
        severity:sample.severity,
        detail:sample.detail,
        liveNonTaxStatus:String(sample?.accountingDetails?.liveNonTaxStatus||'unverified'),
      });
    }
    prior=sample;
  }

  return {
    latest:latestSample,
    expectedTotal:Number(latestSample?.accountingDetails?.expectedTotal||15706.80),
    actualTotal:Number(latestSample?.accountingDetails?.actualTotal||0),
    taxablePayload:Number(latestSample?.accountingDetails?.taxablePayload||0),
    liveNonTaxStatus:String(latestSample?.accountingDetails?.liveNonTaxStatus||'unverified'),
    liveNonTaxVerified:Boolean(latestSample?.accountingDetails?.liveNonTaxVerified),
    liveNonTaxId:String(latestSample?.accountingDetails?.liveNonTaxId||''),
    liveNonTaxName:String(latestSample?.accountingDetails?.liveNonTaxName||''),
    liveClientInvariant:latestSample?.accountingDetails?.liveClientInvariant||null,
    liveClientInvariants:latestSample?.accountingDetails?.liveClientInvariants||null,
    lastSuccessfulAt:String(lastSuccessful?.checkedAt||''),
    failures,
    alertHistory:alertHistory.reverse().slice(0,20),
    incidentTimeline:Array.isArray(persistentIncidents)?persistentIncidents:[],
    sampleCount:samples.length,
  };
}


function accountingRepairCategory(row:any){
  const status=String(row?.status||'unverified');
  const reason=String(row?.failureReason||row?.detail||'').toLowerCase();
  if(status==='unverified')return 'unverified';
  if(!String(row?.estimateId||'')||reason.includes('no linked quickbooks estimate')||reason.includes('estimate is missing'))return 'missing-estimate';
  if(Number(row?.taxableLines??row?.taxableLineCount??0)>0||reason.includes('taxable sales lines'))return 'taxable-lines';
  if(reason.includes('sales lines do not equal'))return 'sales-line-mismatch';
  return status==='failed'?'other-failure':'passed';
}

function accountingReleaseAudits(releases:any[]){
  return (Array.isArray(releases)?releases:[])
    .map((release:any)=>{
      const verification=release?.accountingVerification||null;
      const invariant=verification?.invariant||null;
      if(!verification||!invariant)return null;
      const rows=Array.isArray(invariant?.dynamicClientRows)?invariant.dynamicClientRows:[];
      return {
        deployId:String(release?.deployId||''),
        commit:String(release?.commit||''),
        checkedAt:String(verification?.checkedAt||release?.recordedAt||''),
        status:String(verification?.status||'unverified'),
        accountingVerified:Boolean(verification?.accountingVerified),
        clientCount:Number(invariant?.dynamicClientCount||rows.length||0),
        passedCount:Number(invariant?.dynamicClientPassedCount||0),
        failedCount:Number(invariant?.dynamicClientFailedCount||0),
        unverifiedCount:Number(invariant?.dynamicClientUnverifiedCount||0),
        rows:rows.map((row:any)=>({
          recordId:String(row?.recordId||''),
          client:String(row?.client||row?.clientName||row?.recordId||''),
          crmTotal:Number(row?.crmTotal??row?.proposalTotal??0),
          qboEstimate:row?.qboEstimate==null?(row?.estimateTotal==null?null:Number(row.estimateTotal)):Number(row.qboEstimate),
          lineTotal:row?.lineTotal==null?null:Number(row.lineTotal),
          estimateId:String(row?.estimateId||''),
          estimateDocNumber:String(row?.estimateDocNumber||''),
          taxableLines:row?.taxableLines==null?(row?.taxableLineCount==null?null:Number(row.taxableLineCount)):Number(row.taxableLines),
          status:String(row?.status||'unverified'),
          failureReason:String(
            row?.failureReason
            || (Array.isArray(row?.failures)&&row.failures.length?row.failures.join('; '):'')
            || row?.detail
            || ''
          ),
          repairCategory:accountingRepairCategory(row),
        })),
      };
    })
    .filter(Boolean)
    .slice(0,20);
}

export async function runHealthDashboardRefresh(context:Context){
  const runWarnings:Array<{section:string;error:string}>=[];
  const [previous,previousHourly]=await Promise.all([
    safeHealthSection(runWarnings,'Previous health snapshot',()=>readLatestHealth(context),null as any),
    safeHealthSection(runWarnings,'Previous hourly snapshot',()=>readLatestHourlyHealth(context),null as any),
  ]);

  const current=await runSystemHealth(context,'manual');

  await safeHealthSection(runWarnings,'Alert policy application',()=>applyHealthAlertPolicy(context,current,previousHourly),null as any);
  await safeHealthSection(runWarnings,'Health snapshot persistence',()=>persistHealth(context,current),null as any);
  await safeHealthSection(runWarnings,'Transition alerts',()=>sendHealthTransitionAlerts(previous,current),null as any);

  const [uptimeHistory,healthHistory,accountingInvariantIncidents,policy,deployments,releases]=await Promise.all([
    safeHealthSection(runWarnings,'Uptime history',()=>readUptimeHistory(context,2300),[] as any),
    safeHealthSection(runWarnings,'Health history',()=>readHealthHistory(context,120),[] as any),
    safeHealthSection(runWarnings,'Accounting invariant timeline',()=>readAccountingInvariantIncidents(context,500),[] as any),
    safeHealthSection(runWarnings,'Health alert policy',()=>readHealthAlertPolicy(context),{} as any),
    safeHealthSection(runWarnings,'Deployment history',()=>cachedDeploymentHistory(context),{history:[],current:{},connectionHealth:{}} as any),
    safeHealthSection(runWarnings,'Production releases',()=>readProductionReleases(context,50),[] as any),
  ]);
  const enrichmentWarnings=runWarnings;
  const [office365,emailHealth]=await Promise.all([
    safeHealthSection(enrichmentWarnings,'Office 365',()=>office365HealthSummary(context,deployments),{} as any),
    safeHealthSection(enrichmentWarnings,'Email Health',()=>emailHealthSummary(context),{} as any),
  ]);
  const cachedCredentialHealth=await safeHealthSection(enrichmentWarnings,'Credential Health cache',()=>readCredentialHealthSummary(context),null as any);
  const credentialHealth=await safeHealthSection(
    enrichmentWarnings,
    'Credential Health',
    ()=>credentialHealthSummary(context,{emailHealth}),
    cachedCredentialHealth||{},
  );
  const uptime=calculateUptime(uptimeHistory);
  const incidents=calculateIncidents(uptimeHistory);
  const hydratedReleases=await safeHealthSection(
    enrichmentWarnings,
    'Release metadata',
    ()=>hydrateProductionReleaseMetadata(context,releases,12),
    releases,
  );
  deployments.releaseTimeline=releaseTimelineWithIncidents(hydratedReleases,deployments.history||[],incidents);
  const weeklyExecutiveSummary=await safeHealthSection(
    enrichmentWarnings,
    'Weekly executive summary',
    ()=>weeklySystemHealthExecutiveSummary(context),
    {} as any,
  );
  return {
    ok:true,
    current,uptime,incidents,policy,components:healthComponents(),coverage:healthCoverageSummary(current),criticalIntegrations:criticalIntegrationsSummary(current),rollbackReady:await rollbackReadySummary(context,String(current?.deployId||'')),runtime:{deployContext:String(context.deploy?.context||''),deployId:String(context.deploy?.id||'')},deployments,office365,emailHealth,credentialHealth,weeklyExecutiveSummary,
    accountingHealth:accountingHealthSummary(current,healthHistory,accountingInvariantIncidents),
    accountingReleaseAudits:accountingReleaseAudits(hydratedReleases),
    enrichmentWarnings,
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

    if(body?.action==='run-critical-integrations-rollback-drill'){
      try{
        const drill=await runSafeCriticalIntegrationRollbackDrill(context,{
          failedProbeId:String(body?.failedProbeId||'synthetic-signwell-webhook'),
        });
        return Response.json({ok:Boolean(drill?.ok),drill},{headers:{'Cache-Control':'private, no-store'}});
      }catch(error){
        const message=error instanceof Error?error.message:'Unable to run Critical Integrations rollback drill.';
        const blocked=/blocked in production/i.test(message);
        return Response.json({error:message},{status:blocked?409:400,headers:{'Cache-Control':'private, no-store'}});
      }
    }

    if(body?.action==='test-resend-webhook'){
      try{
        const webhookTest=await testResendWebhookDelivery();
        const emailHealth=await emailHealthSummary(context,{force:true});
        return Response.json({
          ok:Boolean(webhookTest?.ok),
          webhookTest,
          emailHealth,
        },{
          status:webhookTest?.completed&&webhookTest?.ok===false?502:200,
          headers:{'Cache-Control':'private, no-store'},
        });
      }catch(error){
        return Response.json({
          error:error instanceof Error?error.message:'Unable to test Resend webhook delivery.',
        },{status:400,headers:{'Cache-Control':'private, no-store'}});
      }
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

    const dashboard=await runHealthDashboardRefresh(context);
    return Response.json(dashboard,{headers:{'Cache-Control':'private, no-store'}});
  }

  if(req.method!=='GET') return new Response('Method not allowed',{status:405});

  const url=new URL(req.url);
  if(url.searchParams.get('export')==='critical-integrations'){
    if(!admin)return Response.json({error:'System Health management permission required.'},{status:403,headers:{'Cache-Control':'private, no-store'}});
    try{
      const allReleases=await readAllProductionReleaseAudits(context);
      const filters=criticalIntegrationAuditFilters(url.searchParams);
      const releases=filterCriticalIntegrationAudits(allReleases,filters);
      const filterSummary=criticalIntegrationAuditFilterSummary(filters,releases.length);
      const format=String(url.searchParams.get('format')||'csv').toLowerCase();
      if(!['csv','json'].includes(format)){
        return Response.json({error:'Critical Integrations export format must be csv or json.'},{status:400,headers:{'Cache-Control':'private, no-store'}});
      }
      const date=new Date().toISOString().slice(0,10);
      if(format==='json'){
        return new Response(JSON.stringify({
          generatedAt:new Date().toISOString(),
          releaseCount:releases.length,
          filters:filterSummary,
          releases,
        },null,2),{
          status:200,
          headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="koa-critical-integrations-audit-'+date+'.json"','Cache-Control':'private, no-store'},
        });
      }
      return new Response(criticalIntegrationAuditCsv(releases),{
        status:200,
        headers:{
          'Content-Type':'text/csv; charset=utf-8',
          'Content-Disposition':'attachment; filename="koa-critical-integrations-audit-'+date+'.csv"',
          'X-Koa-Audit-Release-Count':String(releases.length),
          'Cache-Control':'private, no-store',
        },
      });
    }catch(error){
      return Response.json({
        error:error instanceof Error?error.message:'Unable to export Critical Integrations audit.',
      },{status:400,headers:{'Cache-Control':'private, no-store'}});
    }
  }

  const latest=await readLatestHealth(context);
  if(!admin){
    return Response.json({
      current:latest?{
        checkedAt:latest.checkedAt,
        overall:latest.overall,
        passed:latest.passed,
        failed:latest.failed,
        failedIds:latest.failedIds,
        checks:latest.checks.map(row=>({id:row.id,name:row.name,kind:row.kind,ok:row.ok,status:row.status,detail:row.detail,severity:row.severity,issueType:row.issueType||null,accountingDetails:row.accountingDetails||null})),
      }:null,
    },{headers:{'Cache-Control':'private, no-store'}});
  }

  const [history,uptimeHistory,accountingInvariantIncidents,deployments,policy,releases]=await Promise.all([
    readHealthHistory(context,120),
    readUptimeHistory(context,2300),
    readAccountingInvariantIncidents(context,500),
    cachedDeploymentHistory(context),
    readHealthAlertPolicy(context),
    readProductionReleases(context,50),
  ]);
  const enrichmentWarnings:Array<{section:string;error:string}>=[];
  const [office365,emailHealth]=await Promise.all([
    safeHealthSection(enrichmentWarnings,'Office 365',()=>office365HealthSummary(context,deployments),{} as any),
    safeHealthSection(enrichmentWarnings,'Email Health',()=>emailHealthSummary(context),{} as any),
  ]);
  const cachedCredentialHealth=await safeHealthSection(enrichmentWarnings,'Credential Health cache',()=>readCredentialHealthSummary(context),null as any);
  const credentialHealth=await safeHealthSection(
    enrichmentWarnings,
    'Credential Health',
    ()=>credentialHealthSummary(context,{emailHealth}),
    cachedCredentialHealth||{},
  );
  const weeklyExecutiveSummary=await safeHealthSection(
    enrichmentWarnings,
    'Weekly executive summary',
    ()=>weeklySystemHealthExecutiveSummary(context),
    {} as any,
  );
  const uptime=calculateUptime(uptimeHistory);
  const incidents=calculateIncidents(uptimeHistory);
  const hydratedReleases=await safeHealthSection(
    enrichmentWarnings,
    'Release metadata',
    ()=>hydrateProductionReleaseMetadata(context,releases,12),
    releases,
  );
  deployments.releaseTimeline=releaseTimelineWithIncidents(hydratedReleases,deployments.history||[],incidents);
  return Response.json({
    current:latest,
    history,
    uptime,
    incidents,
    policy,
    components:healthComponents(),
    coverage:healthCoverageSummary(latest),
    criticalIntegrations:criticalIntegrationsSummary(latest),
    rollbackReady:await rollbackReadySummary(context,String(latest?.deployId||'')),
    runtime:{deployContext:String(context.deploy?.context||''),deployId:String(context.deploy?.id||'')},
    deployments,
    office365,
    emailHealth,
    credentialHealth,
    weeklyExecutiveSummary,
    accountingHealth:accountingHealthSummary(latest,history,accountingInvariantIncidents),
    enrichmentWarnings,
  },{headers:{'Cache-Control':'private, no-store'}});
};

export const config:Config={path:'/api/admin/health'};
