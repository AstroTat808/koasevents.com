import type { Context, Config } from '@netlify/functions';
import { resolveTenant, resolveTenantAsync, runWithTenant } from './_shared/tenant';
import { tenantStoreFor } from './_shared/tenant-storage';
function sales(context:Context,req:Request){return tenantStoreFor(context,resolveTenant(req),'sales');}
function files(context:Context,req:Request){return tenantStoreFor(context,resolveTenant(req),'eventFiles');}
function clean(v:unknown,max=100){return String(v??'').trim().slice(0,max);}
async function handleTenantRequest(req:Request,context:Context){
  if(req.method!=='GET')return new Response('Method not allowed',{status:405});
  const token=clean(context.params.token,100);
  const records:any[]=(await sales(context,req).get('records/index',{type:'json'}))||[];
  const record=records.find(r=>r?.kind==='proposal'&&r?.proposal?.publicToken===token);
  if(!record)return Response.json({error:'Contract not found.'},{status:404});
  const key=String(record?.booking?.contract?.signwell?.signedPdfKey||'');
  if(!key)return Response.json({error:'The completed signed agreement is not available yet.'},{status:404});
  const data=await files(context,req).get(key,{type:'arrayBuffer'});
  if(!data)return Response.json({error:'The signed agreement file is missing.'},{status:404});
  const safe=String(record.customer?.name||'Client').replace(/[^A-Za-z0-9_-]+/g,'-').replace(/^-|-$/g,'')||'Client';
  return new Response(data,{headers:{'Content-Type':'application/pdf','Content-Disposition':'inline; filename="Koa-Agreement-'+safe+'.pdf"','Cache-Control':'private, no-store'}});
}

export default async (req:Request, context:Context) => {
  const tenant = await resolveTenantAsync(req, context);
  return runWithTenant(tenant, () => handleTenantRequest(req, context));
};

export const config:Config={path:'/api/client-portal/contract/:token'};