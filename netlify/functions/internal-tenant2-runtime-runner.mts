import type { Context, Config } from '@netlify/functions';
import { createHash, timingSafeEqual } from 'node:crypto';
import { tenantProfiles } from '../../src/data/tenants/index.ts';
import {
  readOrganizationById,
  saveTenantMigrationAuditReport,
} from './_shared/organization.ts';
import {
  ensureTenant2Sandbox,
  runTenant2IsolationProbe,
  runTenant2OnboardingJourney,
  TENANT2_SANDBOX_ID,
} from './_shared/tenant-sandbox-qa.ts';
import { runWithTenant } from './_shared/tenant.ts';
import { tenantMigrationAudit } from './_shared/tenant-storage.ts';

function clean(value:unknown,max=500){return String(value??'').trim().slice(0,max);}

function authorized(req:Request){
  const auth=clean(req.headers.get('authorization'),800);
  const bearer=auth.toLowerCase().startsWith('bearer ')?auth.slice(7).trim():'';
  const header=clean(req.headers.get('x-venueloom-runner-token'),800);
  const token=bearer||header;
  const expected=clean(Netlify.env.get('VENUELOOM_TENANT2_RUNNER_TOKEN_SHA256'),128).toLowerCase();
  if(!expected||!/^[0-9a-f]{64}$/.test(expected))return false;
  const actual=createHash('sha256').update(token).digest('hex');
  const a=Buffer.from(actual,'hex');
  const b=Buffer.from(expected,'hex');
  return a.length===b.length&&timingSafeEqual(a,b);
}

function legacyTenantOne(){
  const tenant=tenantProfiles.find((row)=>row.storage.legacyDataBelongsToTenant);
  if(!tenant)throw new Error('The legacy-compatible Tenant 1 profile is missing.');
  return tenant;
}

export default async(req:Request,context:Context)=>{
  if(context.deploy.context!=='production'){
    return Response.json({error:'Runtime sandbox verification is production-only.'},{status:404});
  }
  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  if(!authorized(req)){
    return Response.json({error:'Not found.'},{status:404});
  }
  const body:any=await req.json().catch(()=>({}));
  const mode=clean(body?.mode||'status',40);
  const creator={id:'tenant2-runtime-runner',email:'tenant2-runner@venueloom.invalid'};
  const headers={'Cache-Control':'private, no-store'};

  if(mode==='ensure'){
    const sandbox=await ensureTenant2Sandbox(context,creator);
    return Response.json({
      ok:true,
      mode,
      tenantId:sandbox.organization.id,
      status:sandbox.organization.status,
      sandbox:sandbox.organization.sandbox,
    },{headers});
  }

  if(mode==='isolation'){
    const sandbox=await ensureTenant2Sandbox(context,creator);
    const report=await runTenant2IsolationProbe(context,sandbox.organization);
    return Response.json({ok:report.pass,mode,report},{status:report.pass?200:409,headers});
  }

  if(mode==='onboarding'){
    const report=await runTenant2OnboardingJourney(context,creator);
    return Response.json({ok:report.pass,mode,report},{status:report.pass?200:409,headers});
  }

  if(mode==='migration'){
    const tenant=legacyTenantOne();
    const raw=await runWithTenant(tenant,()=>tenantMigrationAudit(context,tenant,undefined,{deep:true}));
    const report=await saveTenantMigrationAuditReport(context,tenant.id,raw);
    return Response.json({ok:true,mode,report},{headers});
  }

  if(mode==='status'){
    const sandbox=await readOrganizationById(context,TENANT2_SANDBOX_ID);
    return Response.json({
      ok:true,
      mode,
      sandbox: sandbox ? {
        id:sandbox.id,
        status:sandbox.status,
        onboarding:sandbox.onboarding,
        subscriptionStatus:sandbox.subscription?.status,
        sandbox:sandbox.sandbox,
      } : null,
    },{headers});
  }

  return Response.json({error:'Unknown runner mode.'},{status:400,headers});
};

export const config:Config={path:'/api/internal/tenant2-runtime-runner'};
