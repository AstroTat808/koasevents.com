import type { Context } from '@netlify/functions';
import { completeOAuth } from './_shared/quickbooks';
import { profileFromOrganization, readOrganizationById } from './_shared/organization';
import { resolveTenantAsync, runWithTenant } from './_shared/tenant';
import { tenantById } from '../../src/data/tenants';

function clean(value:unknown,max=160){return String(value??'').trim().slice(0,max);}

export default async (req: Request, context: Context) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const url = new URL(req.url);
  const state=clean(url.searchParams.get('state'),500);
  const stateTenantId=clean(state.split('.')[0],120);

  try {
    let tenant=stateTenantId?tenantById(stateTenantId):null;
    if(!tenant&&stateTenantId){
      const organization=await readOrganizationById(context,stateTenantId);
      if(organization)tenant=profileFromOrganization(organization);
    }
    tenant ||= await resolveTenantAsync(req,context);
    await runWithTenant(tenant,()=>completeOAuth(context,req.url));
    const headers=new Headers({Location:url.origin+'/admin/quickbooks/?connected=1&tenant='+encodeURIComponent(tenant.id)});
    return new Response(null,{status:302,headers});
  } catch (error) {
    console.error('QuickBooks OAuth callback failed', error);
    return Response.redirect(url.origin + '/admin/quickbooks/?qbo=error', 302);
  }
};
