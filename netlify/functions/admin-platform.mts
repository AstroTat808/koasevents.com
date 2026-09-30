import type { Context, Config } from '@netlify/functions';
import { getAccessContext } from './_shared/admin.ts';
import {
  appendPlatformAuditEvent,
  appendPlatformSandboxQaHistory,
  cancelOrganizationDeletionRequest,
  clearSandboxMemberships,
  createOrganization,
  createOrganizationDeletionRequest,
  createPlatformSupportSession,
  deleteOrganizationControlPlane,
  deleteSandboxOrganizationControlPlane,
  endPlatformSupportSession,
  listMemberships,
  listOrganizations,
  listPlatformAuditEvents,
  listPlatformSandboxQaHistory,
  listPlatformSupportSessions,
  markOrganizationDeletionCompleted,
  profileFromOrganization,
  readOrganizationById,
  readOrganizationDeletionRequest,
  readPlatformSupportSession,
  saveOrganization,
} from './_shared/organization.ts';
import { purgeTenantData, TENANT_STORAGE_DOMAINS, tenantMigrationAudit, tenantStoreFor } from './_shared/tenant-storage.ts';
import { runWithTenant } from './_shared/tenant.ts';
import { runCrossTenantLeakageTest, runSandboxOnboardingJourney, runSandboxOnboardingStage, SANDBOX_ONBOARDING_STAGES } from './_shared/tenant-sandbox-qa.ts';
import { tenantEnvConfigured } from './_shared/tenant-env.ts';
import { readGithubMainWorkflowSignal } from './_shared/system-health.ts';

function clean(value:unknown,max=500){return String(value??'').trim().slice(0,max);}
function email(value:unknown){return clean(value,240).toLowerCase();}
function actor(access:any){return {userId:clean(access.user?.id,160),email:email(access.user?.email)};}

const ENTITLEMENTS=[
  'crm','sales','events','vendors','quickbooks','signwell','email','calendar','profitability',
  'client_portal','vendor_portal','bartender','blog','gallery','local_seo','workspace_alerts',
];

function configuredSuperAdmins(tenant:any){
  const env=clean(Netlify.env.get('VENUELOOM_SUPER_ADMIN_EMAILS'),4000)
    .split(',').map((value)=>email(value)).filter(Boolean);
  if(env.length)return new Set(env);
  return new Set(
    tenant?.storage?.legacyDataBelongsToTenant
      ? (tenant.bootstrapAdminEmails||[]).map((value:any)=>email(value)).filter(Boolean)
      : []
  );
}

async function requirePlatformSuperAdmin(req:Request,context:Context){
  const access=await getAccessContext(req,context);
  if(!access.user||access.role!=='admin'){
    return {access,response:Response.json({error:'VenueLoom Super Admin access required.'},{status:403,headers:{'Cache-Control':'private, no-store'}})};
  }
  const allowed=configuredSuperAdmins(access.tenant);
  const userEmail=email(access.user?.email);
  if(!userEmail||!allowed.has(userEmail)){
    return {access,response:Response.json({error:'This administrator is not in the VenueLoom Super Admin allowlist.'},{status:403,headers:{'Cache-Control':'private, no-store'}})};
  }
  return {access,response:null};
}

function providerCredentialState(profile:any,provider:string){
  if(provider==='quickbooks')return tenantEnvConfigured(profile,'QUICKBOOKS_PRODUCTION_CLIENT_ID','QUICKBOOKS_CLIENT_ID','INTUIT_CLIENT_ID');
  if(provider==='signwell')return tenantEnvConfigured(profile,'SIGNWELL_API_KEY');
  if(provider==='resend')return tenantEnvConfigured(profile,'RESEND_API_KEY');
  if(provider==='microsoft')return tenantEnvConfigured(profile,'MICROSOFT_GRAPH_CLIENT_ID','MICROSOFT_CLIENT_ID');
  if(provider==='stripe')return Boolean(clean(Netlify.env.get('VENUELOOM_STRIPE_RESTRICTED_KEY'),3000));
  return false;
}

function stripePriceId(plan:string,interval:'monthly'|'annual'){
  const raw=clean(Netlify.env.get('VENUELOOM_STRIPE_PRICE_MAP'),20000);
  if(!raw)return '';
  try{
    const parsed=JSON.parse(raw);
    return clean(parsed?.[plan]?.[interval]||parsed?.[plan+':'+interval]||parsed?.[plan+'_'+interval]||'',200);
  }catch{return '';}
}

async function stripeRequest(path:string,method:'GET'|'POST'='GET',body?:URLSearchParams){
  const key=clean(Netlify.env.get('VENUELOOM_STRIPE_RESTRICTED_KEY'),4000);
  if(!key)throw new Error('VenueLoom Stripe restricted key is not configured.');
  const response=await fetch('https://api.stripe.com/v1/'+path.replace(/^\/+/,''),{
    method,
    headers:{
      Authorization:'Bearer '+key,
      ...(method==='POST'?{'Content-Type':'application/x-www-form-urlencoded'}:{}),
    },
    body:method==='POST'?body:undefined,
    signal:AbortSignal.timeout(15000),
  });
  const data:any=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(clean(data?.error?.message||'Stripe request failed.',500));
  return data;
}

async function organizationSummary(context:Context,organization:any){
  const profile=profileFromOrganization(organization);
  return runWithTenant(profile,async()=>{
    const latest:any=await tenantStoreFor(context,profile,'systemHealth').get('latest',{type:'json'}).catch(()=>null);
    const checks=Array.isArray(latest?.checks)?latest.checks:[];
    const failed=checks.filter((row:any)=>row?.ok===false).length;
    const activeDomains=(organization.domains||[]).filter((row:any)=>row.status==='verified').length;
    const integrations=(organization.integrations||[]).map((row:any)=>({
      provider:row.provider,
      enabled:row.enabled!==false,
      status:row.status,
      configured:providerCredentialState(profile,row.provider),
      remoteAccountName:row.remoteAccountName||'',
      lastVerifiedAt:row.lastVerifiedAt||'',
    }));
    const deletionRequest=await readOrganizationDeletionRequest(context,organization.id).catch(()=>null);
    return {
      id:organization.id,
      slug:organization.slug,
      displayName:organization.displayName,
      status:organization.status,
      createdAt:organization.createdAt,
      updatedAt:organization.updatedAt,
      legacyCompatibility:profile.storage.legacyDataBelongsToTenant,
      onboarding:{
        completedSteps:organization.onboarding?.completedSteps||[],
        activatedAt:organization.onboarding?.activatedAt||'',
      },
      subscription:organization.subscription,
      domains:organization.domains||[],
      domainSummary:{verified:activeDomains,total:(organization.domains||[]).length},
      integrations,
      featureFlags:organization.featureFlags||{},
      health:{
        checkedAt:latest?.checkedAt||'',
        source:latest?.source||'',
        total:checks.length,
        failed,
        healthy:checks.length?failed===0:null,
      },
      migrationStatus:profile.storage.legacyDataBelongsToTenant?'audit-required':'tenant-native',
      deletionRequest,
      isSandbox:organization.slug.startsWith('vl-sandbox-'),
    };
  });
}


const SANDBOX_DATA_DOMAINS = [
  'sales','quotes','integrations','crm','eventOps','vendors','eventFiles','vendorFiles',
  'emailAnalytics','emailRouting','authSecurity','staffDirectory','staffFiles','staffAudit',
  'staffAvailability','security','systemHealth','calendarSync','userPreferences','blog','gallery',
  'localSeo','workspaceAlerts',
] as const;

async function purgeSandboxTenantData(context:Context,organization:any){
  const profile=profileFromOrganization(organization);
  if(!String(organization?.slug||'').startsWith('vl-sandbox-') || organization?.featureFlags?.['platform.sandbox']!==true){
    throw new Error('Only VenueLoom sandbox organizations can be purged.');
  }
  const removed:any[]=[];
  await runWithTenant(profile,async()=>{
    for(const domain of SANDBOX_DATA_DOMAINS){
      const store=tenantStoreFor(context,profile,domain as any);
      const rows=await store.list({});
      let count=0;
      for(const blob of rows.blobs||[]){
        const key=String(blob?.key||'');
        if(!key)continue;
        await store.delete(key);
        count++;
      }
      removed.push({domain,count});
    }
  });
  return removed;
}

async function sandboxQaSnapshot(context:Context,organization:any){
  const profile=profileFromOrganization(organization);
  if(!organization?.featureFlags?.['platform.sandbox'])return null;
  return runWithTenant(profile,async()=>{
    const store=tenantStoreFor(context,profile,'systemHealth');
    const [leakage,onboarding]=await Promise.all([
      store.get('qa/tenant-isolation/latest',{type:'json'} as any).catch(()=>null),
      store.get('qa/onboarding/latest',{type:'json'} as any).catch(()=>null),
    ]);
    const history=await listPlatformSandboxQaHistory(context,organization.id,100);
    return {leakage,onboarding,history};
  });
}


function readinessCriterion(id:string,label:string,status:'green'|'yellow'|'red',detail:string){
  return {id,label,status,ok:status==='green',detail};
}

async function sandboxReadinessSnapshot(context:Context,organization:any,migrationAudit:any,sandboxQa:any){
  if(!organization?.featureFlags?.['platform.sandbox'])return null;
  const profile=profileFromOrganization(organization);
  const liveCommit=clean(Netlify.env.get('COMMIT_REF'),80);
  const ciSignal=await readGithubMainWorkflowSignal(context,'VenueLoom tenant isolation CI').catch(()=>null);
  const ciStatus=!ciSignal
    ? 'yellow'
    : liveCommit && ciSignal.sha===liveCommit
      ? 'green'
      : 'yellow';

  const leakage=sandboxQa?.leakage;
  const leakageStatus=!leakage ? 'yellow' : (leakage.summary?.clean&&leakage.scheduledJobs?.passed ? 'green' : 'red');

  const onboarding=sandboxQa?.onboarding;
  const onboardingStatus=!onboarding ? 'yellow' : (onboarding.summary?.clean&&onboarding.summary?.activated ? 'green' : 'red');

  const koa=await readOrganizationById(context,'koa-events');
  const koaIntegrations=new Map((koa?.integrations||[]).map((row:any)=>[row.provider,row]));
  const requiredProviders=['quickbooks','signwell','resend','microsoft'];
  const sandboxProviderRows=requiredProviders.map((provider)=>organization.integrations?.find((row:any)=>row.provider===provider)).filter(Boolean);
  const sharedCredential=sandboxProviderRows.find((row:any)=>{
    const other:any=koaIntegrations.get(row.provider);
    return Boolean(row.credentialRef && other?.credentialRef && row.credentialRef===other.credentialRef);
  });
  const sharedRemote=sandboxProviderRows.find((row:any)=>{
    const other:any=koaIntegrations.get(row.provider);
    return Boolean(row.remoteAccountId && other?.remoteAccountId && row.remoteAccountId===other.remoteAccountId);
  });
  const sandboxCredentialsReady=requiredProviders.every((provider)=>{
    const row=organization.integrations?.find((item:any)=>item.provider===provider);
    return row?.status==='configured' && row?.credentialRef==='sandbox://'+organization.id+'/'+provider;
  });
  const credentialStatus=sharedCredential||sharedRemote ? 'red' : (sandboxCredentialsReady?'green':'yellow');

  const organizationIndex=await listOrganizations(context);
  const otherOrganizations=[];
  for(const row of organizationIndex){
    if(row.id===organization.id)continue;
    const other=await readOrganizationById(context,row.id);
    if(other)otherOrganizations.push(other);
  }
  const otherHosts=new Set(otherOrganizations.flatMap((row:any)=>(row.domains||[]).map((domain:any)=>String(domain.hostname||'').toLowerCase()).filter(Boolean)));
  const sandboxHosts=(organization.domains||[]).map((domain:any)=>String(domain.hostname||'').toLowerCase()).filter(Boolean);
  const duplicateHost=sandboxHosts.find((host:string)=>otherHosts.has(host));
  const sandboxDomainsReady=(organization.domains||[]).length>0 && (organization.domains||[]).every((domain:any)=>domain.status==='verified'&&String(domain.hostname||'').endsWith('.invalid'));
  const domainStatus=duplicateHost?'red':(sandboxDomainsReady?'green':'yellow');

  const legacyObjects=Number(migrationAudit?.summary?.legacyObjects||0);
  const storageStatus=profile.storage.legacyDataBelongsToTenant
    ? 'red'
    : (leakage?.summary?.clean&&leakage?.scheduledJobs?.passed&&legacyObjects===0 ? 'green' : 'yellow');

  const sub=organization.subscription||{};
  const otherCustomerIds=new Set(otherOrganizations.map((row:any)=>row.subscription?.stripeCustomerId).filter(Boolean));
  const otherSubscriptionIds=new Set(otherOrganizations.map((row:any)=>row.subscription?.stripeSubscriptionId).filter(Boolean));
  const sharedBillingId=Boolean(
    (sub.stripeCustomerId&&otherCustomerIds.has(sub.stripeCustomerId))
    || (sub.stripeSubscriptionId&&otherSubscriptionIds.has(sub.stripeSubscriptionId))
  );
  const sandboxBillingIds=String(sub.stripeCustomerId||'').startsWith('sandbox_customer_')
    && String(sub.stripeSubscriptionId||'').startsWith('sandbox_subscription_');
  const billingStatus=sharedBillingId
    ? 'red'
    : (sub.status==='trialing'&&sandboxBillingIds ? 'green'
      : ((sub.stripeCustomerId||sub.stripeSubscriptionId)&&!sandboxBillingIds ? 'red' : 'yellow'));

  const criteria=[
    readinessCriterion('isolation-ci','Isolation CI',ciStatus,ciStatus==='green'
      ? 'Signed VenueLoom tenant-isolation CI passed for the exact production commit '+liveCommit.slice(0,12)+'.'
      : ciSignal
        ? 'Latest signed isolation CI is '+ciSignal.sha.slice(0,12)+' while production is '+(liveCommit?liveCommit.slice(0,12):'unknown')+'.'
        : 'No signed production isolation-CI result has been recorded yet.'),
    readinessCriterion('leakage','Leakage testing',leakageStatus,leakageStatus==='green'
      ? 'All '+Number(leakage?.summary?.surfaces||0)+' leakage surfaces and scheduled-job namespace checks are clean.'
      : leakage ? Number(leakage?.summary?.failed||0)+' leakage surfaces failed or scheduled-job isolation is not clean.' : 'Leakage testing has not run.'),
    readinessCriterion('onboarding','Onboarding QA',onboardingStatus,onboardingStatus==='green'
      ? 'All onboarding QA steps passed and the sandbox activated.'
      : onboarding ? Number(onboarding?.summary?.failed||0)+' onboarding steps failed or activation is incomplete.' : 'Onboarding QA has not run.'),
    readinessCriterion('credentials','Credential separation',credentialStatus,credentialStatus==='green'
      ? 'QuickBooks, SignWell, Resend, and Microsoft use sandbox-only credential references with no Koa remote-ID overlap.'
      : credentialStatus==='red' ? 'A sandbox integration shares a credential reference or remote account ID with Koa.' : 'Sandbox-only credential simulation is incomplete.'),
    readinessCriterion('domains','Domain isolation',domainStatus,domainStatus==='green'
      ? 'Sandbox domains are unique reserved .invalid hosts and are verified only in simulation.'
      : domainStatus==='red' ? 'A sandbox hostname overlaps another tenant.' : 'Sandbox domain verification is incomplete.'),
    readinessCriterion('storage','Storage isolation',storageStatus,storageStatus==='green'
      ? 'Tenant-native storage is active, legacy compatibility is off, no legacy objects are attached, and runtime namespace isolation is clean.'
      : profile.storage.legacyDataBelongsToTenant ? 'Sandbox is incorrectly using legacy compatibility storage.' : 'Tenant-native storage exists, but runtime isolation or legacy-object proof is incomplete.'),
    readinessCriterion('billing','Billing isolation',billingStatus,billingStatus==='green'
      ? 'Stripe lifecycle uses sandbox-only identifiers with no customer/subscription overlap with another tenant.'
      : billingStatus==='red' ? 'Sandbox billing identifiers are real-looking or overlap another tenant.' : 'Sandbox billing lifecycle has not completed.'),
  ];
  return {
    ready:criteria.every((row)=>row.status==='green'),
    locked:criteria.some((row)=>row.status!=='green'),
    checkedAt:new Date().toISOString(),
    liveCommit,
    ciSignal,
    criteria,
    summary:{
      green:criteria.filter((row)=>row.status==='green').length,
      yellow:criteria.filter((row)=>row.status==='yellow').length,
      red:criteria.filter((row)=>row.status==='red').length,
      total:criteria.length,
    },
  };
}

async function platformSnapshot(context:Context){
  const index=await listOrganizations(context);
  const organizations=[];
  for(const row of index){
    const organization=await readOrganizationById(context,row.id);
    if(organization)organizations.push(await organizationSummary(context,organization));
  }
  const sessions=await listPlatformSupportSessions(context,50);
  const now=Date.now();
  return {
    generatedAt:new Date().toISOString(),
    organizations,
    supportSessions:sessions.map((row)=>({
      ...row,
      token:undefined,
      active:!row.endedAt && Date.parse(row.expiresAt)>now,
    })),
    entitlements:ENTITLEMENTS,
    summary:{
      organizations:organizations.length,
      active:organizations.filter((row:any)=>row.status==='active').length,
      trial:organizations.filter((row:any)=>row.status==='trial').length,
      suspended:organizations.filter((row:any)=>row.status==='suspended').length,
      attention:organizations.filter((row:any)=>row.health.failed>0 || ['past_due','suspended'].includes(row.status)).length,
      subscriptionsActive:organizations.filter((row:any)=>['active','trialing'].includes(row.subscription?.status)).length,
    },
  };
}

function csvCell(value:unknown){
  const text=String(value??'');
  return '"'+text.replaceAll('"','""')+'"';
}

async function supportAuditCsv(context:Context){
  const sessions=await listPlatformSupportSessions(context,500);
  const audit=await listPlatformAuditEvents(context,1000);
  const rows=[
    ['record_type','id','tenant_id','actor_email','event_type','reason_or_detail','created_at','expires_at','ended_at'],
    ...sessions.map((row)=>['support_session',row.id,row.tenantId,row.adminEmail,'read_only_support',row.reason,row.createdAt,row.expiresAt,row.endedAt]),
    ...audit.map((row)=>['platform_audit',row.id,row.tenantId,row.actorEmail,row.type,row.detail,row.createdAt,'','']),
  ];
  return rows.map((row)=>row.map(csvCell).join(',')).join('\n')+'\n';
}

async function platformUsage(context:Context){
  const index=await listOrganizations(context);
  const sessions=await listPlatformSupportSessions(context,1000);
  const organizations:any[]=[];
  const domainTotals=Object.fromEntries(TENANT_STORAGE_DOMAINS.map((domain)=>[domain,0]));
  let totalObjects=0,totalMemberships=0,totalSeats=0,totalVerifiedDomains=0,totalConnectedIntegrations=0;
  for(const row of index){
    const organization=await readOrganizationById(context,row.id);
    if(!organization)continue;
    const profile=profileFromOrganization(organization);
    const migration=await runWithTenant(profile,()=>tenantMigrationAudit(context,profile));
    const memberships=await listMemberships(context,organization.id);
    const domains=Object.fromEntries((migration.domains||[]).map((entry:any)=>[entry.domain,entry.canonicalCount]));
    for(const [domain,count] of Object.entries(domains))domainTotals[domain]=(domainTotals[domain]||0)+Number(count||0);
    const objects=Number(migration.summary?.canonicalObjects||0);
    const verifiedDomains=(organization.domains||[]).filter((d:any)=>d.status==='verified').length;
    const connectedIntegrations=(organization.integrations||[]).filter((i:any)=>i.status==='connected').length;
    const supportSessions=sessions.filter((s)=>s.tenantId===organization.id).length;
    totalObjects+=objects;
    totalMemberships+=memberships.length;
    totalSeats+=Number(organization.subscription?.seats||0);
    totalVerifiedDomains+=verifiedDomains;
    totalConnectedIntegrations+=connectedIntegrations;
    organizations.push({
      tenantId:organization.id,
      displayName:organization.displayName,
      status:organization.status,
      canonicalObjects:objects,
      memberships:memberships.length,
      seats:Number(organization.subscription?.seats||0),
      verifiedDomains,
      connectedIntegrations,
      supportSessions,
      storageByDomain:domains,
    });
  }
  return {
    generatedAt:new Date().toISOString(),
    organizations,
    totals:{
      organizations:organizations.length,
      canonicalObjects:totalObjects,
      memberships:totalMemberships,
      seats:totalSeats,
      verifiedDomains:totalVerifiedDomains,
      connectedIntegrations:totalConnectedIntegrations,
      supportSessions:sessions.length,
      storageByDomain:domainTotals,
    },
  };
}

function deletionBlockers(organization:any){
  const blockers:string[]=[];
  if(organization.id==='koa-events')blockers.push('Koa Tenant #1 cannot be deleted from Super Admin.');
  if(!['suspended','canceled'].includes(organization.status))blockers.push('Organization must be suspended or canceled.');
  if(['active','trialing','past_due'].includes(organization.subscription?.status))blockers.push('Stripe subscription must be canceled or not configured.');
  if((organization.domains||[]).some((row:any)=>row.status==='verified'))blockers.push('Verified domains must be removed first.');
  if((organization.integrations||[]).some((row:any)=>row.status==='connected'))blockers.push('Connected integrations must be disconnected first.');
  return blockers;
}

async function updateStripePlanIfNeeded(organization:any,plan:string,interval:'monthly'|'annual',seats:number){
  const subscriptionId=clean(organization.subscription?.stripeSubscriptionId,180);
  if(!subscriptionId)return {stripeUpdated:false,mode:'local-only'};
  const priceId=stripePriceId(plan,interval);
  if(!priceId)throw new Error('No Stripe price is configured for this plan and interval.');
  const subscription=await stripeRequest('subscriptions/'+encodeURIComponent(subscriptionId));
  const itemId=clean(subscription?.items?.data?.[0]?.id,180);
  if(!itemId)throw new Error('Stripe subscription item could not be resolved.');
  await stripeRequest('subscription_items/'+encodeURIComponent(itemId),'POST',new URLSearchParams({
    price:priceId,
    quantity:String(seats),
    proration_behavior:'create_prorations',
  }));
  await stripeRequest('subscriptions/'+encodeURIComponent(subscriptionId),'POST',new URLSearchParams({
    'metadata[tenant_id]':organization.id,
    'metadata[venueloom_plan]':plan,
  }));
  return {stripeUpdated:true,mode:'stripe',priceId};
}

export default async(req:Request,context:Context)=>{
  const auth=await requirePlatformSuperAdmin(req,context);
  if(auth.response)return auth.response;
  const who=actor(auth.access);

  const url=new URL(req.url);
  if(req.method==='GET'){
    const view=clean(url.searchParams.get('view'),80);
    if(view==='support-audit.csv'){
      return new Response(await supportAuditCsv(context),{
        headers:{
          'Content-Type':'text/csv; charset=utf-8',
          'Content-Disposition':'attachment; filename="venueloom-support-audit.csv"',
          'Cache-Control':'private, no-store',
        },
      });
    }
    if(view==='usage'){
      return Response.json(await platformUsage(context),{headers:{'Cache-Control':'private, no-store'}});
    }

    const supportToken=clean(url.searchParams.get('support'),220);
    if(supportToken){
      const session=await readPlatformSupportSession(context,supportToken);
      if(!session)return Response.json({error:'Support session not found.'},{status:404});
      if(session.adminUserId!==clean(auth.access.user?.id,160))return Response.json({error:'Support session belongs to another administrator.'},{status:403});
      if(session.endedAt||Date.parse(session.expiresAt)<=Date.now())return Response.json({error:'Support session has ended or expired.'},{status:410});
      const organization=await readOrganizationById(context,session.tenantId);
      if(!organization)return Response.json({error:'Organization not found.'},{status:404});
      const profile=profileFromOrganization(organization);
      const migrationAudit=await runWithTenant(profile,()=>tenantMigrationAudit(context,profile));
      const sandboxQa=await sandboxQaSnapshot(context,organization);
      return Response.json({
        supportSession:{...session,token:undefined},
        organization:await organizationSummary(context,organization),
        migrationAudit,
        sandboxQa,
        readiness:await sandboxReadinessSnapshot(context,organization,migrationAudit,sandboxQa),
        deletionBlockers:deletionBlockers(organization),
        readOnly:true,
      },{headers:{'Cache-Control':'private, no-store'}});
    }

    const tenantId=clean(url.searchParams.get('tenant'),120);
    if(tenantId){
      const organization=await readOrganizationById(context,tenantId);
      if(!organization)return Response.json({error:'Organization not found.'},{status:404});
      const profile=profileFromOrganization(organization);
      const migrationAudit=await runWithTenant(profile,()=>tenantMigrationAudit(context,profile));
      const sandboxQa=await sandboxQaSnapshot(context,organization);
      return Response.json({
        organization:await organizationSummary(context,organization),
        migrationAudit,
        sandboxQa,
        readiness:await sandboxReadinessSnapshot(context,organization,migrationAudit,sandboxQa),
        deletionBlockers:deletionBlockers(organization),
        readOnly:true,
      },{headers:{'Cache-Control':'private, no-store'}});
    }

    return Response.json(await platformSnapshot(context),{headers:{'Cache-Control':'private, no-store'}});
  }

  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  const body:any=await req.json().catch(()=>null);
  if(!body)return Response.json({error:'Invalid JSON.'},{status:400});
  const action=clean(body.action,80);

  if(action==='create-support-session'){
    const session=await createPlatformSupportSession(context,{
      tenantId:clean(body.tenantId,120),
      adminUserId:who.userId,
      adminEmail:who.email,
      reason:clean(body.reason,500),
      ttlMinutes:Number(body.ttlMinutes||15),
    });
    await appendPlatformAuditEvent(context,{type:'support_session_started',tenantId:session.tenantId,actorUserId:who.userId,actorEmail:who.email,detail:session.reason});
    return Response.json({ok:true,supportToken:session.token,session:{...session,token:undefined}},{headers:{'Cache-Control':'private, no-store'}});
  }

  if(action==='end-support-session'){
    const ended=await endPlatformSupportSession(context,clean(body.supportToken,220),who.userId);
    if(ended)await appendPlatformAuditEvent(context,{type:'support_session_ended',tenantId:ended.tenantId,actorUserId:who.userId,actorEmail:who.email,detail:'Read-only support session ended.'});
    return Response.json({ok:true,session:ended?{...ended,token:undefined}:null},{headers:{'Cache-Control':'private, no-store'}});
  }

  if(action==='create-sandbox-tenant'){
    const stamp=new Date().toISOString().slice(0,10).replaceAll('-','');
    const suffix=clean(body.suffix,30).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')||crypto.randomUUID().slice(0,6);
    const slug='vl-sandbox-'+stamp+'-'+suffix;
    const created=await createOrganization(context,{
      slug,
      displayName:clean(body.displayName,180)||'VenueLoom Sandbox Venue',
      legalName:clean(body.legalName,220)||'VenueLoom Sandbox Venue LLC',
      email:email(body.email)||email(auth.access.user?.email),
      locale:clean(body.locale,60)||'en-US',
      currency:clean(body.currency,8)||'USD',
      timezone:clean(body.timezone,100)||'UTC',
      country:clean(body.country,100)||'United States',
    },{id:auth.access.user?.id,email:auth.access.user?.email});

    const profile=created.profile;
    const organization=await saveOrganization(context,profile,(current)=>({
      ...current,
      branding:{...current.branding,tagline:'Sandbox organization for tenant-isolation verification',primaryColor:'#2f4f46',accentColor:'#b98b5e',backgroundColor:'#f5f1e8'},
      venues:[{id:'sandbox-main',name:'Sandbox Venue',address:'Test data only',timezone:current.timezone,capacity:120,active:true}],
      taxProfile:{id:'sandbox-tax',label:'Sandbox Tax',kind:'sales-tax',enabled:true,statutoryRate:4.25,customerRate:4.25,maxPassOnRate:4.25,defaultTaxable:true},
      templates:[{id:'sandbox-proposal',type:'proposal',name:'Sandbox Proposal',enabled:true,source:'tenant',updatedAt:new Date().toISOString()}],
      featureFlags:{'platform.sandbox':true,crm:true,sales:true,events:true,vendors:true,quickbooks:false,signwell:false,email:false,calendar:false,profitability:true,client_portal:true,vendor_portal:true},
      domains:[{id:'sandbox-domain',hostname:slug+'.invalid',kind:'custom',status:'pending',primary:true}],
      subscription:{...current.subscription,plan:'sandbox',billingEmail:current.contact.email},
      onboarding:{...current.onboarding,completedSteps:[...new Set([...(current.onboarding?.completedSteps||[]),'venues','branding','tax-profile','templates'])]},
    }));
    let leakageTest:any=null;
    let onboardingTest:any=null;
    if(body.runChecks===true){
      const koaOrganization=await readOrganizationById(context,'koa-events');
      if(!koaOrganization)throw new Error('Koa Tenant #1 control-plane record was not found.');
      leakageTest=await runCrossTenantLeakageTest(context,organization,koaOrganization);
      onboardingTest=(await runSandboxOnboardingJourney(context,organization,{
        id:auth.access.user?.id,
        email:auth.access.user?.email,
      })).report;
    }
    const latestOrganization=await readOrganizationById(context,organization.id) || organization;
    await appendPlatformAuditEvent(context,{type:'sandbox_created',tenantId:latestOrganization.id,actorUserId:who.userId,actorEmail:who.email,detail:'Created isolated VenueLoom sandbox tenant.'});
    return Response.json({ok:true,sandbox:true,organization:await organizationSummary(context,latestOrganization),safety:{
      legacyCompatibility:false,
      integrationsConnected:false,
      domainVerified:false,
      stripeCheckoutStarted:false,
      koaDataTouched:false,
    },leakageTest,onboardingTest},{status:201,headers:{'Cache-Control':'private, no-store'}});
  }

  if(action==='run-sandbox-leakage-test'){
    const tenantId=clean(body.tenantId,120);
    const sandbox=await readOrganizationById(context,tenantId);
    const koa=await readOrganizationById(context,'koa-events');
    if(!sandbox)return Response.json({error:'Sandbox organization not found.'},{status:404});
    if(!koa)return Response.json({error:'Koa Tenant #1 control-plane record was not found.'},{status:404});
    const leakageTest=await runCrossTenantLeakageTest(context,sandbox,koa);
    return Response.json({ok:true,leakageTest},{headers:{'Cache-Control':'private, no-store'}});
  }

  if(action==='run-sandbox-onboarding-test'){
    const tenantId=clean(body.tenantId,120);
    const sandbox=await readOrganizationById(context,tenantId);
    if(!sandbox)return Response.json({error:'Sandbox organization not found.'},{status:404});
    const result=await runSandboxOnboardingJourney(context,sandbox,{
      id:auth.access.user?.id,
      email:auth.access.user?.email,
    });
    return Response.json({ok:true,organization:await organizationSummary(context,result.organization),onboardingTest:result.report},{headers:{'Cache-Control':'private, no-store'}});
  }


  if(action==='run-sandbox-onboarding-stage'){
    const tenantId=clean(body.tenantId,120);
    const stage=clean(body.stage,80);
    if(!SANDBOX_ONBOARDING_STAGES.includes(stage as any))return Response.json({error:'Unknown onboarding stage.'},{status:400});
    const sandbox=await readOrganizationById(context,tenantId);
    if(!sandbox)return Response.json({error:'Sandbox organization not found.'},{status:404});
    const result=await runSandboxOnboardingStage(context,sandbox,{
      id:auth.access.user?.id,
      email:auth.access.user?.email,
    },stage);
    return Response.json({ok:true,organization:await organizationSummary(context,result.organization),onboardingStageTest:result.report},{headers:{'Cache-Control':'private, no-store'}});
  }

  if(action==='reset-sandbox-tenant'){
    const tenantId=clean(body.tenantId,120);
    const sandbox=await readOrganizationById(context,tenantId);
    if(!sandbox)return Response.json({error:'Sandbox organization not found.'},{status:404});
    const profile=profileFromOrganization(sandbox);
    const removedData=await purgeSandboxTenantData(context,sandbox);
    const membershipsRemoved=await clearSandboxMemberships(context,tenantId);
    const resetAt=new Date().toISOString();
    const reset=await saveOrganization(context,profile,(current)=>({
      ...current,
      status:'trial',
      branding:{...current.branding,tagline:'Sandbox organization for tenant-isolation verification'},
      venues:[{id:'sandbox-main',name:'Sandbox Venue',address:'Test data only',timezone:current.timezone||'UTC',capacity:120,active:true}],
      taxProfile:{id:'sandbox-tax',label:'Sandbox Tax',kind:'sales-tax',enabled:true,statutoryRate:4.25,customerRate:4.25,maxPassOnRate:4.25,defaultTaxable:true},
      domains:[{id:'sandbox-domain',hostname:current.slug+'.invalid',kind:'custom',status:'pending',primary:true}],
      integrations:(current.integrations||[]).map((row:any)=>({...row,status:'not_configured',remoteAccountId:'',remoteAccountName:'',connectedAt:'',lastVerifiedAt:'',credentialRef:''})),
      templates:[{id:'sandbox-proposal',type:'proposal',name:'Sandbox Proposal',enabled:true,source:'tenant',updatedAt:resetAt}],
      subscription:{...current.subscription,status:'not_configured',plan:'sandbox',stripeCustomerId:'',stripeSubscriptionId:'',currentPeriodEnd:'',trialEndsAt:''},
      onboarding:{completedSteps:['organization','locale','venues','branding','tax-profile','templates'],activatedAt:''},
      updatedAt:resetAt,
    }));
    await appendPlatformSandboxQaHistory(context,tenantId,{kind:'reset',runId:'RESET-'+Date.now().toString(36),generatedAt:resetAt,summary:{clean:true},report:{removedData,membershipsRemoved}});
    return Response.json({ok:true,organization:await organizationSummary(context,reset),removedData,membershipsRemoved},{headers:{'Cache-Control':'private, no-store'}});
  }

  if(action==='delete-sandbox-tenant'){
    const tenantId=clean(body.tenantId,120);
    const sandbox=await readOrganizationById(context,tenantId);
    if(!sandbox)return Response.json({error:'Sandbox organization not found.'},{status:404});
    const removedData=await purgeSandboxTenantData(context,sandbox);
    const deletedAt=new Date().toISOString();
    await appendPlatformSandboxQaHistory(context,tenantId,{kind:'delete',runId:'DELETE-'+Date.now().toString(36),generatedAt:deletedAt,summary:{clean:true},report:{removedData}});
    const controlPlane=await deleteSandboxOrganizationControlPlane(context,tenantId);
    return Response.json({ok:true,deletedTenantId:tenantId,removedData,controlPlane},{headers:{'Cache-Control':'private, no-store'}});
  }


  const tenantId=clean(body.tenantId,120);
  const organization=tenantId?await readOrganizationById(context,tenantId):null;
  if(['set-tenant-status','update-plan','save-entitlements','request-deletion','cancel-deletion','finalize-deletion'].includes(action)&&!organization){
    return Response.json({error:'Organization not found.'},{status:404});
  }

  if(action==='set-tenant-status'){
    if(tenantId==='koa-events')return Response.json({error:'Koa Tenant #1 suspension/reactivation is blocked from Super Admin.'},{status:409});
    const nextStatus=clean(body.status,40);
    if(!['suspended','active'].includes(nextStatus))return Response.json({error:'Status must be suspended or active.'},{status:400});
    if(clean(body.confirmSlug,120)!==organization.slug)return Response.json({error:'Organization slug confirmation did not match.'},{status:409});
    const reason=clean(body.reason,1000);
    if(!reason)return Response.json({error:'Reason is required.'},{status:400});
    if(nextStatus==='active'&&['past_due','canceled'].includes(organization.subscription?.status)){
      return Response.json({error:'Resolve the subscription state before reactivating this organization.'},{status:409});
    }
    const previous=organization.status;
    const updated=await saveOrganization(context,profileFromOrganization(organization),(current)=>({...current,status:nextStatus as any}));
    await appendPlatformAuditEvent(context,{type:nextStatus==='suspended'?'tenant_suspended':'tenant_reactivated',tenantId,actorUserId:who.userId,actorEmail:who.email,detail:reason,metadata:{previous,next:nextStatus}});
    return Response.json({ok:true,organization:await organizationSummary(context,updated)},{headers:{'Cache-Control':'private, no-store'}});
  }

  if(action==='update-plan'){
    if(clean(body.confirmSlug,120)!==organization.slug)return Response.json({error:'Organization slug confirmation did not match.'},{status:409});
    const plan=clean(body.plan,100);
    const interval=body.interval==='annual'?'annual':'monthly';
    const seats=Math.max(1,Math.min(10000,Math.round(Number(body.seats||organization.subscription?.seats||1))));
    if(!plan)return Response.json({error:'Plan key is required.'},{status:400});
    const stripe=await updateStripePlanIfNeeded(organization,plan,interval,seats);
    const updated=await saveOrganization(context,profileFromOrganization(organization),(current)=>({...current,subscription:{...current.subscription,plan,interval,seats}}));
    await appendPlatformAuditEvent(context,{type:'subscription_plan_changed',tenantId,actorUserId:who.userId,actorEmail:who.email,detail:'Plan changed to '+plan+' / '+interval+' with '+seats+' seat(s).',metadata:{stripeUpdated:stripe.stripeUpdated}});
    return Response.json({ok:true,stripe,organization:await organizationSummary(context,updated)},{headers:{'Cache-Control':'private, no-store'}});
  }

  if(action==='save-entitlements'){
    const incoming=body.featureFlags&&typeof body.featureFlags==='object'?body.featureFlags:{};
    const flags=Object.fromEntries(ENTITLEMENTS.map((key)=>[key,incoming[key]===true]));
    const updated=await saveOrganization(context,profileFromOrganization(organization),(current)=>({...current,featureFlags:{...current.featureFlags,...flags}}));
    await appendPlatformAuditEvent(context,{type:'feature_entitlements_changed',tenantId,actorUserId:who.userId,actorEmail:who.email,detail:'Updated organization feature entitlements.',metadata:{featureFlags:flags}});
    return Response.json({ok:true,organization:await organizationSummary(context,updated)},{headers:{'Cache-Control':'private, no-store'}});
  }

  if(action==='request-deletion'){
    const blockers=deletionBlockers(organization);
    if(blockers.length)return Response.json({error:'Organization is not eligible for deletion.',blockers},{status:409});
    const request=await createOrganizationDeletionRequest(context,{tenantId,slug:clean(body.confirmSlug,120),requestedByUserId:who.userId,requestedByEmail:who.email,reason:clean(body.reason,1000),holdHours:24});
    await appendPlatformAuditEvent(context,{type:'organization_deletion_requested',tenantId,actorUserId:who.userId,actorEmail:who.email,detail:request.reason,metadata:{eligibleAt:request.eligibleAt}});
    return Response.json({ok:true,request},{headers:{'Cache-Control':'private, no-store'}});
  }

  if(action==='cancel-deletion'){
    const request=await cancelOrganizationDeletionRequest(context,tenantId);
    if(request)await appendPlatformAuditEvent(context,{type:'organization_deletion_canceled',tenantId,actorUserId:who.userId,actorEmail:who.email,detail:'Organization deletion request canceled.'});
    return Response.json({ok:true,request},{headers:{'Cache-Control':'private, no-store'}});
  }

  if(action==='finalize-deletion'){
    const blockers=deletionBlockers(organization);
    if(blockers.length)return Response.json({error:'Organization is not eligible for deletion.',blockers},{status:409});
    const request=await readOrganizationDeletionRequest(context,tenantId);
    if(!request||request.canceledAt||request.completedAt)return Response.json({error:'An active deletion request is required.'},{status:409});
    if(Date.parse(request.eligibleAt)>Date.now())return Response.json({error:'Deletion cooling-off period has not ended.',eligibleAt:request.eligibleAt},{status:409});
    if(clean(body.confirmSlug,120)!==organization.slug||clean(body.confirmText,220)!=='DELETE '+organization.slug)return Response.json({error:'Final deletion confirmation did not match.'},{status:409});
    const profile=profileFromOrganization(organization);
    if(profile.storage.legacyDataBelongsToTenant)return Response.json({error:'Legacy-compatible tenants cannot be deleted from Super Admin.'},{status:409});
    const purge=await runWithTenant(profile,()=>purgeTenantData(context,profile));
    await deleteOrganizationControlPlane(context,tenantId);
    await markOrganizationDeletionCompleted(context,tenantId);
    await appendPlatformAuditEvent(context,{type:'organization_deleted',tenantId,actorUserId:who.userId,actorEmail:who.email,detail:'Organization deleted after cooling-off and safety checks.',metadata:{deletedObjects:purge.deletedObjects}});
    return Response.json({ok:true,deleted:true,tenantId,purge},{headers:{'Cache-Control':'private, no-store'}});
  }

  return Response.json({error:'Unknown platform action.'},{status:400});
};

export const config:Config={path:'/api/admin/platform'};