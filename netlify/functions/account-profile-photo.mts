import type { Config, Context } from '@netlify/functions';
import { admin } from '@netlify/identity';
import { getDeployStore, getStore } from '@netlify/blobs';
import { requireOperations } from './_shared/admin';
import { appendStaffAudit } from './_shared/staff-audit';

const ALLOWED=new Set(['image/jpeg','image/png','image/webp']);
const MAX_BYTES=2*1024*1024;

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
  const user:any=auth.user;
  const store=storeFor(context);
  const key='profile-photos/'+clean(user.id,120);

  if(req.method==='POST'){
    const form=await req.formData();
    const file=form.get('file');
    if(!(file instanceof File))return Response.json({error:'Choose a profile photo to upload.'},{status:400});
    if(!ALLOWED.has(file.type))return Response.json({error:'Use a JPG, PNG, or WEBP image.'},{status:400});
    if(file.size<1||file.size>MAX_BYTES)return Response.json({error:'Profile photo must be 2 MB or smaller.'},{status:413});
    const version=new Date().toISOString();
    await store.set(key,await file.arrayBuffer(),{metadata:{contentType:file.type}});
    const current=metadata(user);
    await admin.updateUser(user.id,{user_metadata:{...current,has_profile_photo:true,profile_photo_type:file.type,profile_photo_version:version}});
    await appendStaffAudit(context,{
      actor:clean(user.email,240).toLowerCase(),
      action:'self_profile_photo_updated',
      subjectId:clean(user.id,120),
      subjectEmail:clean(user.email,240).toLowerCase(),
      detail:'Updated Staff Workspace profile photo.',
      metadata:{type:file.type,size:file.size},
    });
    return Response.json({ok:true,photoUrl:'/api/staff/photo/'+encodeURIComponent(clean(user.id,120))+'?v='+encodeURIComponent(version)});
  }

  if(req.method==='DELETE'){
    await store.delete(key);
    const current=metadata(user);
    await admin.updateUser(user.id,{user_metadata:{...current,has_profile_photo:false,profile_photo_type:'',profile_photo_version:new Date().toISOString()}});
    await appendStaffAudit(context,{
      actor:clean(user.email,240).toLowerCase(),
      action:'self_profile_photo_removed',
      subjectId:clean(user.id,120),
      subjectEmail:clean(user.email,240).toLowerCase(),
      detail:'Removed Staff Workspace profile photo.',
    });
    return Response.json({ok:true});
  }

  return new Response('Method not allowed',{status:405});
};

export const config:Config={path:'/api/account/profile/photo'};
