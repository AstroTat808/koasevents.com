import type { Config, Context } from '@netlify/functions';
import { admin } from '@netlify/identity';
import { getDeployStore, getStore } from '@netlify/blobs';
import { requireOperations } from './_shared/admin';

function clean(value:unknown,max=300){return String(value??'').trim().slice(0,max);}
function metadata(user:any){return user?.user_metadata||user?.userMetadata||{};}
function storeFor(context:Context){
  return context.deploy.context==='production'
    ? getStore({name:'koa-staff-files',consistency:'strong'})
    : getDeployStore({name:'koa-staff-files'});
}

export default async(req:Request,context:Context)=>{
  const auth=await requireOperations(req);
  if(auth.response)return auth.response;
  if(req.method!=='GET')return new Response('Method not allowed',{status:405});
  const url=new URL(req.url);
  const parts=url.pathname.split('/').filter(Boolean);
  const userId=clean(parts[parts.length-1],120);
  if(!userId)return Response.json({error:'User ID required.'},{status:400});

  let target:any;
  try{target=await admin.getUser(userId);}catch{return Response.json({error:'Staff profile not found.'},{status:404});}
  const meta=metadata(target);
  if(meta?.has_profile_photo!==true)return Response.json({error:'Profile photo not found.'},{status:404});

  const data=await storeFor(context).get('profile-photos/'+userId,{type:'arrayBuffer'});
  if(!data)return Response.json({error:'Profile photo not found.'},{status:404});
  const type=clean(meta?.profile_photo_type,80)||'image/jpeg';
  return new Response(data,{headers:{'Content-Type':type,'Cache-Control':'private, max-age=300'}});
};

export const config:Config={path:'/api/staff/photo/:userId'};
