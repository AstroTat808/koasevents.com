import type { Context, Config } from '@netlify/functions';
import { getAccessContext } from './_shared/admin.ts';
import {
  createPlatformSupportSession,
  endPlatformSupportSession,
  listOrganizations,
  listPlatformSupportSessions,
  profileFromOrganization,
  readOrganizationById,
  readPlatformSupportSession,
  readPlatformTenantTestReport,
  readTenantMigrationAuditReport,
  saveTenantMigrationAuditReport,
} from './_shared/organization.ts';
import { tenantMigrationAudit, tenantStoreFor } from './_shared/tenant-storage.ts';
import { runWithTenant } from './_shared/tenant.ts';
import {
  ensureTenant2Sandbox,
  runTenant2IsolationProbe,
  runTenant2OnboardingJourney,
  TENANT2_SANDBOX_ID,
} from './_shared/tenant-sandbox-qa.ts';
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
      sandbox:organization.sandbox||null,
    };
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
      const migrationAudit=await readTenantMigrationAuditReport(context,organization.id);
      return Response.json({
        supportSession:{...session,token:undefined},
        organization:await organizationSummary(context,organization),
        migrationAudit,
        isolationTest:await readPlatformTenantTestReport(context,organization.id,'isolation'),
        onboardingTest:await readPlatformTenantTestReport(context,organization.id,'onboarding'),
        readOnly:true,
      },{headers:{'Cache-Control':'private, no-store'}});
    }

    const tenantId=clean(url.searchParams.get('tenant'),120);
    if(tenantId){
      const organization=await readOrganizationById(context,tenantId);
      if(!organization)return Response.json({error:'Organization not found.'},{status:404});
      const migrationAudit=await readTenantMigrationAuditReport(context,organization.id);
      return Response.json({
        organization:await organizationSummary(context,organization),
        migrationAudit,
        isolationTest:await readPlatformTenantTestReport(context,organization.id,'isolation'),
        onboardingTest:await readPlatformTenantTestReport(context,organization.id,'onboarding'),
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
    const sandbox=await ensureTenant2Sandbox(context,{
      id:clean(auth.access.user?.id,160)||'platform-admin',
      email:email(auth.access.user?.email)||'platform-admin@venueloom.invalid',
    });
    return Response.json({
      ok:true,
      sandbox:true,
      tenantId:sandbox.organization.id,
      organization:await organizationSummary(context,sandbox.organization),
      safety:{
        legacyCompatibility:false,
        integrationsConnected:false,
        syntheticDomain:true,
        syntheticStripe:true,
        koaDataTouched:false,
      },
    },{status:201,headers:{'Cache-Control':'private, no-store'}});
  }

  if(action==='run-tenant-isolation-test'){
    const sandboxOrg=await readOrganizationById(context,clean(body.tenantId,120)||TENANT2_SANDBOX_ID);
    if(!sandboxOrg||!sandboxOrg.sandbox?.enabled){
      return Response.json({error:'Create the safe VenueLoom Tenant #2 sandbox before running the isolation test.'},{status:409});
    }
    const report=await runTenant2IsolationProbe(context,sandboxOrg);
    return Response.json({ok:report.pass,report},{status:report.pass?200:409,headers:{'Cache-Control':'private, no-store'}});
  }

  if(action==='run-tenant-onboarding-test'){
    const report=await runTenant2OnboardingJourney(context,{
      id:clean(auth.access.user?.id,160)||'platform-admin',
      email:email(auth.access.user?.email)||'platform-admin@venueloom.invalid',
    });
    const organization=await readOrganizationById(context,TENANT2_SANDBOX_ID);
    return Response.json({
      ok:report.pass,
      report,
      organization:organization?await organizationSummary(context,organization):null,
    },{status:report.pass?200:409,headers:{'Cache-Control':'private, no-store'}});
  }

  if(action==='run-migration-audit'){
    const tenantId=clean(body.tenantId,120);
    const organization=await readOrganizationById(context,tenantId);
    if(!organization)return Response.json({error:'Organization not found.'},{status:404});
    const profile=profileFromOrganization(organization);
    const rawAudit=await runWithTenant(profile,()=>tenantMigrationAudit(context,profile,undefined,{deep:body.deep!==false}));
    const migrationAudit=await saveTenantMigrationAuditReport(context,tenantId,rawAudit);
    return Response.json({ok:migrationAudit.summary?.safeToRetireLegacy===true,migrationAudit},{
      status:200,
      headers:{'Cache-Control':'private, no-store'},
    });
  }

  return Response.json({error:'Unknown platform action.'},{status:400});
};

export const config:Config={path:'/api/admin/platform'};