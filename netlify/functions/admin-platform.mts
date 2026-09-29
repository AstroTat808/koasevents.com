import type { Context, Config } from '@netlify/functions';
import { getAccessContext } from './_shared/admin.ts';
import {
  createOrganization,
  createPlatformSupportSession,
  endPlatformSupportSession,
  listOrganizations,
  listPlatformSupportSessions,
  profileFromOrganization,
  readOrganizationById,
  readPlatformSupportSession,
  saveOrganization,
} from './_shared/organization.ts';
import { tenantMigrationAudit, tenantStoreFor } from './_shared/tenant-storage.ts';
import { runWithTenant } from './_shared/tenant.ts';
import { runCrossTenantLeakageTest, runSandboxOnboardingJourney } from './_shared/tenant-sandbox-qa.ts';
import { tenantEnvConfigured } from './_shared/tenant-env.ts';

function clean(value:unknown,max=500){return String(value??'').trim().slice(0,max);}
function email(value:unknown){return clean(value,240).toLowerCase();}

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
      health:{
        checkedAt:latest?.checkedAt||'',
        source:latest?.source||'',
        total:checks.length,
        failed,
        healthy:checks.length?failed===0:null,
      },
      migrationStatus:profile.storage.legacyDataBelongsToTenant?'audit-required':'tenant-native',
    };
  });
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
    return {leakage,onboarding};
  });
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
    summary:{
      organizations:organizations.length,
      active:organizations.filter((row:any)=>row.status==='active').length,
      trial:organizations.filter((row:any)=>row.status==='trial').length,
      attention:organizations.filter((row:any)=>row.health.failed>0 || ['past_due','suspended'].includes(row.status)).length,
      subscriptionsActive:organizations.filter((row:any)=>['active','trialing'].includes(row.subscription?.status)).length,
    },
  };
}

export default async(req:Request,context:Context)=>{
  const auth=await requirePlatformSuperAdmin(req,context);
  if(auth.response)return auth.response;

  const url=new URL(req.url);
  if(req.method==='GET'){
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
      return Response.json({
        supportSession:{...session,token:undefined},
        organization:await organizationSummary(context,organization),
        migrationAudit,
        sandboxQa:await sandboxQaSnapshot(context,organization),
        readOnly:true,
      },{headers:{'Cache-Control':'private, no-store'}});
    }

    const tenantId=clean(url.searchParams.get('tenant'),120);
    if(tenantId){
      const organization=await readOrganizationById(context,tenantId);
      if(!organization)return Response.json({error:'Organization not found.'},{status:404});
      const profile=profileFromOrganization(organization);
      const migrationAudit=await runWithTenant(profile,()=>tenantMigrationAudit(context,profile));
      return Response.json({
        organization:await organizationSummary(context,organization),
        migrationAudit,
        sandboxQa:await sandboxQaSnapshot(context,organization),
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
      adminUserId:clean(auth.access.user?.id,160),
      adminEmail:email(auth.access.user?.email),
      reason:clean(body.reason,500),
      ttlMinutes:Number(body.ttlMinutes||15),
    });
    return Response.json({ok:true,supportToken:session.token,session:{...session,token:undefined}},{headers:{'Cache-Control':'private, no-store'}});
  }

  if(action==='end-support-session'){
    const ended=await endPlatformSupportSession(context,clean(body.supportToken,220),clean(auth.access.user?.id,160));
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

  return Response.json({error:'Unknown platform action.'},{status:400});
};

export const config:Config={path:'/api/admin/platform'};