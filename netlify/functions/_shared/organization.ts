import type { Context } from '@netlify/functions';
import { tenantProfiles, type TenantProfile } from '../../../src/data/tenants';
import { resolveTenant } from './tenant';
import { tenantStore } from './tenant-storage';

export type OrganizationStatus='trial'|'active'|'past_due'|'suspended'|'canceled';
export type MembershipStatus='invited'|'active'|'disabled';

export type OrganizationRecord={
  id:string;
  slug:string;
  legalName:string;
  displayName:string;
  status:OrganizationStatus;
  locale:string;
  currency:string;
  timezone:string;
  defaultCountry:string;
  branding:any;
  venues:any[];
  taxProfiles:any[];
  catalog:{status:string;lastImportAt:string;notes:string};
  integrations:Record<string,any>;
  templates:Record<string,any>;
  featureFlags:Record<string,boolean>;
  domains:any[];
  subscription:any;
  onboarding:{completedSteps:string[];activatedAt:string;updatedAt:string};
  createdAt:string;
  updatedAt:string;
};

export type MembershipRecord={
  id:string;
  tenant_id:string;
  userId:string;
  email:string;
  role:string;
  status:MembershipStatus;
  invitedAt:string;
  acceptedAt:string;
  createdAt:string;
  updatedAt:string;
};

function clean(v:unknown,max=500){return String(v??'').trim().slice(0,max);}
function now(){return new Date().toISOString();}

export function seedOrganization(profile:TenantProfile):OrganizationRecord{
  const timestamp=now();
  return {
    id:profile.id,
    slug:profile.slug,
    legalName:profile.legalName,
    displayName:profile.displayName,
    status:'active',
    locale:profile.locale,
    currency:profile.currency,
    timezone:profile.timezone,
    defaultCountry:'US',
    branding:{
      tagline:profile.brand.tagline,
      logoPath:profile.brand.logoPath,
      primaryColor:'',
      accentColor:'',
      typography:'',
    },
    venues:[{
      id:'primary',
      name:profile.displayName,
      address:profile.contact.venueAddress,
      timezone:profile.timezone,
      active:true,
    }],
    taxProfiles:[profile.tax],
    catalog:{status:'configured',lastImportAt:'',notes:''},
    integrations:{quickbooks:{enabled:true},signwell:{enabled:true},resend:{enabled:true},microsoft:{enabled:true}},
    templates:{},
    featureFlags:{},
    domains:[
      {hostname:profile.domains.primary,kind:'marketing',primary:true,verificationStatus:'verified'},
      {hostname:profile.domains.admin,kind:'app',primary:true,verificationStatus:'verified'},
    ],
    subscription:{plan:'tenant-1',status:'active',trialEndsAt:'',currentPeriodEnd:'',seatQuantity:0},
    onboarding:{completedSteps:['organization','locale','venue','branding','tax','catalog'],activatedAt:timestamp,updatedAt:timestamp},
    createdAt:timestamp,
    updatedAt:timestamp,
  };
}

function platformStore(context:Context){
  return tenantStore(context,'integrations',resolveTenant());
}

export async function getOrganization(context:Context,tenant:TenantProfile=resolveTenant()):Promise<OrganizationRecord>{
  const store=platformStore(context);
  const key='organizations/'+tenant.id+'/profile';
  const saved=await store.get(key,{type:'json'}) as OrganizationRecord|null;
  if(saved) return {...seedOrganization(tenant),...saved,id:tenant.id,slug:tenant.slug};
  const seeded=seedOrganization(tenant);
  await store.setJSON(key,seeded);
  return seeded;
}

export async function saveOrganization(context:Context,input:any,actor:string,tenant:TenantProfile=resolveTenant()){
  const current=await getOrganization(context,tenant);
  const timestamp=now();
  const next:OrganizationRecord={
    ...current,
    legalName:clean(input?.legalName??current.legalName,240),
    displayName:clean(input?.displayName??current.displayName,240),
    locale:clean(input?.locale??current.locale,40),
    currency:clean(input?.currency??current.currency,12).toUpperCase(),
    timezone:clean(input?.timezone??current.timezone,100),
    defaultCountry:clean(input?.defaultCountry??current.defaultCountry,3).toUpperCase(),
    branding:{...current.branding,...(input?.branding||{})},
    venues:Array.isArray(input?.venues)?input.venues.slice(0,100):current.venues,
    taxProfiles:Array.isArray(input?.taxProfiles)?input.taxProfiles.slice(0,100):current.taxProfiles,
    catalog:{...current.catalog,...(input?.catalog||{})},
    integrations:{...current.integrations,...(input?.integrations||{})},
    templates:{...current.templates,...(input?.templates||{})},
    featureFlags:{...current.featureFlags,...(input?.featureFlags||{})},
    domains:Array.isArray(input?.domains)?input.domains.slice(0,100):current.domains,
    subscription:{...current.subscription,...(input?.subscription||{})},
    onboarding:{...current.onboarding,...(input?.onboarding||{}),updatedAt:timestamp},
    updatedAt:timestamp,
  };
  const store=platformStore(context);
  await store.setJSON('organizations/'+tenant.id+'/profile',next);
  const audit=(await store.get('organizations/'+tenant.id+'/audit',{type:'json'})||[]) as any[];
  await store.setJSON('organizations/'+tenant.id+'/audit',[{
    id:crypto.randomUUID(),tenant_id:tenant.id,actor:clean(actor,240),action:'organization.updated',createdAt:timestamp,
  },...audit].slice(0,1000));
  return next;
}

export async function listMemberships(context:Context,tenant:TenantProfile=resolveTenant()){
  const store=platformStore(context);
  const key='organizations/'+tenant.id+'/memberships';
  const saved=(await store.get(key,{type:'json'})||[]) as MembershipRecord[];
  if(saved.length) return saved.filter((row)=>row.tenant_id===tenant.id);
  const seeded=tenant.bootstrapAdminEmails.map((email,index)=>({
    id:'bootstrap-'+(index+1),
    tenant_id:tenant.id,
    userId:'',
    email,
    role:'admin',
    status:'active' as const,
    invitedAt:'',
    acceptedAt:now(),
    createdAt:now(),
    updatedAt:now(),
  }));
  await store.setJSON(key,seeded);
  return seeded;
}

export async function upsertMembership(context:Context,input:any,actor:string,tenant:TenantProfile=resolveTenant()){
  const rows=await listMemberships(context,tenant);
  const email=clean(input?.email,240).toLowerCase();
  if(!email.includes('@')) throw new Error('A valid member email is required.');
  const id=clean(input?.id,120)||crypto.randomUUID();
  const current=rows.find((row)=>row.id===id||row.email.toLowerCase()===email);
  const timestamp=now();
  const next:MembershipRecord={
    id:current?.id||id,
    tenant_id:tenant.id,
    userId:clean(input?.userId??current?.userId,160),
    email,
    role:clean(input?.role??current?.role??'read_only',80),
    status:['invited','active','disabled'].includes(String(input?.status))?input.status:(current?.status||'invited'),
    invitedAt:current?.invitedAt||timestamp,
    acceptedAt:clean(input?.acceptedAt??current?.acceptedAt,80),
    createdAt:current?.createdAt||timestamp,
    updatedAt:timestamp,
  };
  const out=[next,...rows.filter((row)=>row.id!==next.id&&row.email.toLowerCase()!==email)];
  const store=platformStore(context);
  await store.setJSON('organizations/'+tenant.id+'/memberships',out);
  const audit=(await store.get('organizations/'+tenant.id+'/audit',{type:'json'})||[]) as any[];
  await store.setJSON('organizations/'+tenant.id+'/audit',[{
    id:crypto.randomUUID(),tenant_id:tenant.id,actor:clean(actor,240),action:'membership.upserted',target:email,createdAt:timestamp,
  },...audit].slice(0,1000));
  return next;
}

export function registeredOrganizations(){
  return tenantProfiles.map(seedOrganization);
}
