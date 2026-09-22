import type { Config, Context } from '@netlify/functions';
import { admin } from '@netlify/identity';
import { requireOperations } from './_shared/admin';
import { appendStaffAudit } from './_shared/staff-audit';

function clean(value:unknown,max=300){
  return String(value??'').trim().slice(0,max);
}

function userMetadataFor(user:any){
  return user?.userMetadata||user?.user_metadata||{};
}

export default async(req:Request,context:Context)=>{
  const auth=await requireOperations(req);
  if(auth.response)return auth.response;
  const user:any=auth.user;

  if(req.method==='GET'){
    const meta=userMetadataFor(user);
    return Response.json({
      displayName:clean(meta?.full_name||meta?.name||user?.name,180),
      jobTitle:clean(meta?.job_title||meta?.jobTitle,120),
      pronouns:clean(meta?.pronouns,80),
      roleDescription:clean(meta?.role_description||meta?.roleDescription,220),
      signature:{
        showTitle:meta?.signature_show_title!==false,
        showTeamTitle:meta?.signature_show_team_title!==false,
        showPronouns:meta?.signature_show_pronouns===true,
        showRoleDescription:meta?.signature_show_role_description===true,
      },
      photoUrl:meta?.has_profile_photo===true?('/api/staff/photo/'+encodeURIComponent(clean(user?.id,120))+(meta?.profile_photo_version?'?v='+encodeURIComponent(clean(meta.profile_photo_version,80)):'')):'',
      email:clean(user?.email,240).toLowerCase(),
    },{headers:{'Cache-Control':'private, no-store'}});
  }

  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  const body:any=await req.json().catch(()=>null);
  if(!body)return Response.json({error:'Invalid JSON.'},{status:400});

  const displayName=clean(body.displayName,180);
  const jobTitle=clean(body.jobTitle,120);
  const pronouns=clean(body.pronouns,80);
  const roleDescription=clean(body.roleDescription,220);
  const signature=body.signature&&typeof body.signature==='object'?body.signature:{};
  if(!displayName)return Response.json({error:'Display name is required.'},{status:400});

  const currentMeta=userMetadataFor(user);
  const previousName=clean(currentMeta?.full_name||currentMeta?.name||user?.name,180);
  const previousTitle=clean(currentMeta?.job_title||currentMeta?.jobTitle,120);
  const previousPronouns=clean(currentMeta?.pronouns,80);
  const previousRoleDescription=clean(currentMeta?.role_description||currentMeta?.roleDescription,220);

  const updated:any=await admin.updateUser(user.id,{
    user_metadata:{
      ...currentMeta,
      full_name:displayName,
      job_title:jobTitle,
      pronouns,
      role_description:roleDescription,
      signature_show_title:signature.showTitle!==false,
      signature_show_team_title:signature.showTeamTitle!==false,
      signature_show_pronouns:signature.showPronouns===true,
      signature_show_role_description:signature.showRoleDescription===true,
    },
  });

  await appendStaffAudit(context,{
    actor:clean(user?.email,240).toLowerCase(),
    action:'self_profile_updated',
    subjectId:clean(user?.id,120),
    subjectEmail:clean(user?.email,240).toLowerCase(),
    detail:'Updated personal Staff Workspace profile.',
    metadata:{
      displayName:{from:previousName,to:displayName},
      jobTitle:{from:previousTitle,to:jobTitle},
      pronouns:{from:previousPronouns,to:pronouns},
      roleDescription:{from:previousRoleDescription,to:roleDescription},
      signature:{
        showTitle:signature.showTitle!==false,
        showTeamTitle:signature.showTeamTitle!==false,
        showPronouns:signature.showPronouns===true,
        showRoleDescription:signature.showRoleDescription===true,
      },
    },
  });

  const meta=userMetadataFor(updated);
  return Response.json({
    ok:true,
    profile:{
      displayName:clean(meta?.full_name||meta?.name||updated?.name,180),
      jobTitle:clean(meta?.job_title||meta?.jobTitle,120),
      pronouns:clean(meta?.pronouns,80),
      roleDescription:clean(meta?.role_description||meta?.roleDescription,220),
      signature:{
        showTitle:meta?.signature_show_title!==false,
        showTeamTitle:meta?.signature_show_team_title!==false,
        showPronouns:meta?.signature_show_pronouns===true,
        showRoleDescription:meta?.signature_show_role_description===true,
      },
      photoUrl:meta?.has_profile_photo===true?('/api/staff/photo/'+encodeURIComponent(clean(updated?.id,120))+(meta?.profile_photo_version?'?v='+encodeURIComponent(clean(meta.profile_photo_version,80)):'')):'',
      email:clean(updated?.email,240).toLowerCase(),
    },
    message:'Profile updated.',
  });
};

export const config:Config={path:'/api/account/profile'};
