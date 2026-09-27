import type { Config, Context } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { admin } from '@netlify/identity';
import { hasCapability, requireOperations } from './_shared/admin';
import { appendStaffAudit } from './_shared/staff-audit';

function clean(value:unknown,max=300){
  return String(value??'').trim().slice(0,max);
}

function userMetadataFor(user:any){
  return user?.userMetadata||user?.user_metadata||{};
}

function cleanMobileNav(value:unknown){
  const allowed=new Set([
    'home','actions','crm','sales','email','events','calendar','quickbooks','health','staff','vendors','insurance','profitability','gallery',
  ]);
  const raw=Array.isArray(value)?value:[];
  return [...new Set(raw.map(item=>clean(item,40)).filter(item=>allowed.has(item)))].slice(0,4);
}

const ADMIN_HOME_SECTIONS=['sales','operations','accounting','content','administration'] as const;
const ADMIN_HOME_MODULES={
  sales:['business-crm','sales-crm','email','wedding-profitability','mobile-bar-crm'],
  operations:['event-ops','calendar','vendor-crm','insurance'],
  accounting:['quickbooks'],
  content:['email-preview','seo','blog','gallery'],
  administration:['user-management','system-health','security'],
} as const;

function normalizedOrder(value:unknown,allowed:readonly string[]){
  const allowedSet=new Set(allowed);
  const requested=Array.isArray(value)?value.map(item=>clean(item,80)).filter(item=>allowedSet.has(item)):[];
  return [...new Set([...requested,...allowed])];
}

function cleanAdminHomeLayout(value:any){
  const sectionOrder=normalizedOrder(value?.sectionOrder,ADMIN_HOME_SECTIONS);
  const moduleOrder:Record<string,string[]>={};
  for(const section of ADMIN_HOME_SECTIONS){
    moduleOrder[section]=normalizedOrder(value?.moduleOrder?.[section],ADMIN_HOME_MODULES[section]);
  }
  return {sectionOrder,moduleOrder};
}

function adminHomeStore(){
  return getStore({name:'koa-admin-home-layout',consistency:'strong'});
}

async function readCompanyAdminHomeLayout(){
  try{
    const saved:any=await adminHomeStore().get('company-default',{type:'json'});
    if(!saved?.layout)return null;
    return {
      layout:cleanAdminHomeLayout(saved.layout),
      updatedAt:clean(saved.updatedAt,80),
      updatedBy:clean(saved.updatedBy,240).toLowerCase(),
    };
  }catch{
    return null;
  }
}

async function saveCompanyAdminHomeLayout(layout:any,actor:string){
  const record={
    layout:cleanAdminHomeLayout(layout),
    updatedAt:new Date().toISOString(),
    updatedBy:clean(actor,240).toLowerCase(),
  };
  await adminHomeStore().setJSON('company-default',record);
  return record;
}

function cleanActionCenterPreferences(value:any){
  const allowedFilters=new Set(['all','urgent','overdueTasks','unansweredLeads','accountingMismatches','healthWarnings','vendorInsurance','securityWarnings']);
  const allowedSorts=new Set(['priority','oldest','newest']);
  const allowedScopes=new Set(['everyone','mine']);
  const filter=clean(value?.filter,60);
  const sort=clean(value?.sort,40);
  const scope=clean(value?.scope,40);
  return {
    filter:allowedFilters.has(filter)?filter:'all',
    sort:allowedSorts.has(sort)?sort:'priority',
    scope:allowedScopes.has(scope)?scope:'everyone',
  };
}

export default async(req:Request,context:Context)=>{
  const auth=await requireOperations(req);
  if(auth.response)return auth.response;
  const user:any=auth.user;

  if(req.method==='GET'){
    const meta=userMetadataFor(user);
    const personalAdminHomeLayout=meta?.admin_home_layout?cleanAdminHomeLayout(meta.admin_home_layout):null;
    const companyDefault=await readCompanyAdminHomeLayout();
    const companyAdminHomeLayout=companyDefault?.layout||cleanAdminHomeLayout({});
    const adminHomeLayout=personalAdminHomeLayout||companyAdminHomeLayout;
    const adminHomeLayoutSource=personalAdminHomeLayout?'personal':companyDefault?'company':'built-in';
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
      mobileNav:cleanMobileNav(meta?.mobile_nav_items),
      actionCenterPreferences:cleanActionCenterPreferences(meta?.action_center_preferences),
      adminHomeLayout,
      adminHomeLayoutSource,
      personalAdminHomeLayout,
      companyAdminHomeLayout,
      companyAdminHomeLayoutMeta:companyDefault?{updatedAt:companyDefault.updatedAt,updatedBy:companyDefault.updatedBy}:null,
      canManageCompanyAdminHomeLayout:hasCapability(user,'users.manage'),
    },{headers:{'Cache-Control':'private, no-store'}});
  }

  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  const body:any=await req.json().catch(()=>null);
  if(!body)return Response.json({error:'Invalid JSON.'},{status:400});

  if(clean(body.action,60)==='save-admin-home-layout'){
    const adminHomeLayout=cleanAdminHomeLayout(body.layout||{});
    const scope=clean(body.scope,30)==='company'?'company':'personal';
    const actor=clean(user?.email,240).toLowerCase();

    if(scope==='company'){
      if(!hasCapability(user,'users.manage')){
        return Response.json({error:'User Management permission is required to change the company Admin Home default.'},{status:403});
      }
      const companyDefault=await saveCompanyAdminHomeLayout(adminHomeLayout,actor);
      await appendStaffAudit(context,{
        actor,
        action:'company_admin_home_layout_updated',
        subjectId:'company-admin-home',
        subjectEmail:'',
        detail:'Updated the company Admin Home default for staff without a personal layout.',
        metadata:{adminHomeLayout,updatedAt:companyDefault.updatedAt},
      });
      return Response.json({
        ok:true,
        scope:'company',
        adminHomeLayout,
        companyAdminHomeLayout:adminHomeLayout,
        companyAdminHomeLayoutMeta:{updatedAt:companyDefault.updatedAt,updatedBy:companyDefault.updatedBy},
        message:'Company Admin Home default saved for new staff and anyone using the company layout.',
      },{headers:{'Cache-Control':'private, no-store'}});
    }

    const currentMeta=userMetadataFor(user);
    await admin.updateUser(user.id,{
      user_metadata:{
        ...currentMeta,
        admin_home_layout:adminHomeLayout,
      },
    });
    await appendStaffAudit(context,{
      actor,
      action:'self_admin_home_layout_updated',
      subjectId:clean(user?.id,120),
      subjectEmail:actor,
      detail:'Updated personal Admin Home section and module order.',
      metadata:{adminHomeLayout},
    });
    return Response.json({
      ok:true,
      scope:'personal',
      adminHomeLayout,
      personalAdminHomeLayout:adminHomeLayout,
      message:'My Layout saved for this account.',
    },{headers:{'Cache-Control':'private, no-store'}});
  }

  if(clean(body.action,60)==='save-action-center-preferences'){
    const preferences=cleanActionCenterPreferences(body.preferences||{});
    const currentMeta=userMetadataFor(user);
    await admin.updateUser(user.id,{
      user_metadata:{
        ...currentMeta,
        action_center_preferences:preferences,
      },
    });
    return Response.json({
      ok:true,
      preferences,
      message:'Action Center preferences saved.',
    },{headers:{'Cache-Control':'private, no-store'}});
  }

  if(clean(body.action,60)==='save-mobile-nav'){
    const mobileNav=cleanMobileNav(body.mobileNav);
    if(mobileNav.length!==4)return Response.json({error:'Choose four different bottom-navigation modules.'},{status:400});
    const currentMeta=userMetadataFor(user);
    const updated:any=await admin.updateUser(user.id,{
      user_metadata:{
        ...currentMeta,
        mobile_nav_items:mobileNav,
      },
    });
    await appendStaffAudit(context,{
      actor:clean(user?.email,240).toLowerCase(),
      action:'self_mobile_nav_updated',
      subjectId:clean(user?.id,120),
      subjectEmail:clean(user?.email,240).toLowerCase(),
      detail:'Updated personal mobile admin bottom navigation.',
      metadata:{mobileNav},
    });
    const meta=userMetadataFor(updated);
    return Response.json({
      ok:true,
      mobileNav:cleanMobileNav(meta?.mobile_nav_items),
      message:'Mobile navigation saved.',
    },{headers:{'Cache-Control':'private, no-store'}});
  }

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
