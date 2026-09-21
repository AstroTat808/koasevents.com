import type { Context, Config } from '@netlify/functions';
import { getDeployStore,getStore } from '@netlify/blobs';
function sales(context:Context){return context.deploy.context==='production'?getStore({name:'koa-sales',consistency:'strong'}):getDeployStore({name:'koa-sales'});}
function files(context:Context){return context.deploy.context==='production'?getStore({name:'koa-event-files',consistency:'strong'}):getDeployStore({name:'koa-event-files'});}
function clean(v:unknown,max=100){return String(v??'').trim().slice(0,max);}
export default async(req:Request,context:Context)=>{
  if(req.method!=='GET')return new Response('Method not allowed',{status:405});
  const token=clean(context.params.token,100);
  const records:any[]=(await sales(context).get('records/index',{type:'json'}))||[];
  const record=records.find(r=>r?.kind==='proposal'&&r?.proposal?.publicToken===token);
  if(!record)return Response.json({error:'Contract not found.'},{status:404});
  const key=String(record?.booking?.contract?.signwell?.signedPdfKey||'');
  if(!key)return Response.json({error:'The completed signed agreement is not available yet.'},{status:404});
  const data=await files(context).get(key,{type:'arrayBuffer'});
  if(!data)return Response.json({error:'The signed agreement file is missing.'},{status:404});
  const safe=String(record.customer?.name||'Client').replace(/[^A-Za-z0-9_-]+/g,'-').replace(/^-|-$/g,'')||'Client';
  return new Response(data,{headers:{'Content-Type':'application/pdf','Content-Disposition':'inline; filename="Koa-Agreement-'+safe+'.pdf"','Cache-Control':'private, no-store'}});
};
export const config:Config={path:'/api/client-portal/contract/:token'};