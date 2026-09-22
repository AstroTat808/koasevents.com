import type { Config, Context } from '@netlify/functions';
import { admin } from '@netlify/identity';
import { getDeployStore, getStore } from '@netlify/blobs';
import { hasCapability, requireCapability } from './_shared/admin';

type AvailabilityStatus='available'|'tentative'|'unavailable'|'pto';
type AvailabilityRow={
  email:string;
  date:string;
  status:AvailabilityStatus;
  note:string;
  updatedAt:string;
  updatedBy:string;
};

function clean(value:unknown,max=300){return String(value??'').trim().slice(0,max);}
function normalizeEmail(value:unknown){return clean(value,240).toLowerCase();}
function dateKey(value:unknown){
  const raw=clean(value,20);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw)?raw:'';
}
function storeFor(context:Context){
  return context.deploy.context==='production'
    ? getStore({name:'koa-staff-availability',consistency:'strong'})
    : getDeployStore({name:'koa-staff-availability'});
}
async function readRows(context:Context){
  const rows=await storeFor(context).get('availability/index',{type:'json'}).catch(()=>[]);
  return Array.isArray(rows)?rows as AvailabilityRow[]:[];
}
async function writeRows(context:Context,rows:AvailabilityRow[]){
  await storeFor(context).setJSON('availability/index',rows.slice(0,12000));
}
function allowedStatus(value:unknown):AvailabilityStatus|null{
  const status=clean(value,30).toLowerCase();
  return ['available','tentative','unavailable','pto'].includes(status)?status as AvailabilityStatus:null;
}

export default async(req:Request,context:Context)=>{
  const auth=await requireCapability('calendar.view',req);
  if(auth.response)return auth.response;
  const actorEmail=normalizeEmail(auth.user?.email);

  if(req.method==='GET'){
    const url=new URL(req.url);
    const start=dateKey(url.searchParams.get('start'));
    const end=dateKey(url.searchParams.get('end'));
    const email=normalizeEmail(url.searchParams.get('email'));
    const rows=(await readRows(context))
      .filter((row)=>!email||row.email===email)
      .filter((row)=>!start||row.date>=start)
      .filter((row)=>!end||row.date<=end)
      .sort((a,b)=>a.date.localeCompare(b.date)||a.email.localeCompare(b.email));
    return Response.json({availability:rows},{headers:{'Cache-Control':'private, no-store'}});
  }

  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  const body:any=await req.json().catch(()=>null);
  if(!body)return Response.json({error:'Invalid JSON.'},{status:400});
  const email=normalizeEmail(body.email||actorEmail);
  const date=dateKey(body.date);
  const status=allowedStatus(body.status);
  const note=clean(body.note,240);
  if(!email||!date||!status)return Response.json({error:'Email, date and availability status are required.'},{status:400});

  const editingSelf=email===actorEmail;
  if(!editingSelf&&!hasCapability(auth.user,'event_ops.manage')){
    return Response.json({error:'You can update only your own availability.'},{status:403});
  }

  const users:any[]=await admin.listUsers({page:1,perPage:200});
  const target=users.find((user:any)=>normalizeEmail(user?.email)===email);
  if(!target)return Response.json({error:'Staff account not found.'},{status:404});

  const rows=await readRows(context);
  const now=new Date().toISOString();
  const next=rows.filter((row)=>!(row.email===email&&row.date===date));
  next.push({email,date,status,note,updatedAt:now,updatedBy:actorEmail});
  next.sort((a,b)=>a.date.localeCompare(b.date)||a.email.localeCompare(b.email));
  await writeRows(context,next);

  return Response.json({
    ok:true,
    availability:{email,date,status,note,updatedAt:now,updatedBy:actorEmail},
  },{headers:{'Cache-Control':'private, no-store'}});
};

export const config:Config={path:'/api/admin/staff-availability'};
