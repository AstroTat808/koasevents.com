import type { Context, Config } from '@netlify/functions';
import { hasCapability, requireCapability } from './_shared/admin';
import { clientTenantProfile, resolveTenant } from './_shared/tenant';
import { getOrganization, listMemberships, saveOrganization, upsertMembership } from './_shared/organization';

function clean(value:unknown,max=500){return String(value??'').trim().slice(0,max);}

export default async(req:Request,context:Context)=>{
  const auth=await requireCapability('organization.view',req);
  if(auth.response)return auth.response;
  const tenant=resolveTenant(req);
  const [organization,memberships]=await Promise.all([
    getOrganization(context,tenant),
    listMemberships(context,tenant),
  ]);

  if(req.method==='GET'){
    return Response.json({
      tenant:clientTenantProfile(tenant),
      organization,
      memberships,
    },{headers:{'Cache-Control':'private, no-store'}});
  }

  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  if(!hasCapability(auth.user,'organization.manage')){
    return Response.json({error:'Organization management permission required.'},{status:403});
  }

  const body:any=await req.json().catch(()=>null);
  const action=clean(body?.action,80);
  const actor=clean(auth.user?.email||auth.user?.name||'staff',240);

  if(action==='save-organization'){
    const saved=await saveOrganization(context,body?.organization||{},actor,tenant);
    return Response.json({ok:true,organization:saved});
  }

  if(action==='save-membership'){
    try{
      const membership=await upsertMembership(context,body?.membership||{},actor,tenant);
      return Response.json({ok:true,membership,memberships:await listMemberships(context,tenant)});
    }catch(error){
      return Response.json({error:error instanceof Error?error.message:'Unable to save membership.'},{status:400});
    }
  }

  if(action==='complete-onboarding-step'){
    const step=clean(body?.step,100);
    if(!step)return Response.json({error:'Onboarding step is required.'},{status:400});
    const current=await getOrganization(context,tenant);
    const completed=[...new Set([...(current.onboarding?.completedSteps||[]),step])];
    const saved=await saveOrganization(context,{onboarding:{...current.onboarding,completedSteps:completed}},actor,tenant);
    return Response.json({ok:true,organization:saved});
  }

  return Response.json({error:'Unknown organization action.'},{status:400});
};

export const config:Config={path:'/api/admin/organization'};