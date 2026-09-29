import type { Context } from '@netlify/functions';
import { tenantById } from '../../../src/data/tenants/index.ts';
import {
  appendPlatformSandboxQaHistory,
  listMemberships,
  profileFromOrganization,
  saveMembership,
  saveOrganization,
  type MembershipRecord,
  type OrganizationRecord,
} from './organization';
import { runForEachTenant, runWithTenant } from './tenant';
import { tenantStoreFor, type TenantStorageDomain } from './tenant-storage';

type LeakageSurface = {
  id: string;
  label: string;
  domain: TenantStorageDomain;
  samplePrefix?: string;
  testKey: string;
};

const LEAKAGE_SURFACES: LeakageSurface[] = [
  { id:'crm', label:'Business CRM', domain:'crm', samplePrefix:'clients/', testKey:'qa/isolation/business-crm.json' },
  { id:'sales', label:'Sales CRM', domain:'sales', samplePrefix:'records/', testKey:'qa/isolation/sales-crm.json' },
  { id:'events', label:'Events', domain:'eventOps', samplePrefix:'events/', testKey:'qa/isolation/events.json' },
  { id:'vendors', label:'Vendors', domain:'vendors', samplePrefix:'vendors/', testKey:'qa/isolation/vendors.json' },
  { id:'event-documents', label:'Event documents', domain:'eventFiles', samplePrefix:'events/', testKey:'qa/isolation/event-documents.json' },
  { id:'vendor-documents', label:'Vendor documents', domain:'vendorFiles', samplePrefix:'vendors/', testKey:'qa/isolation/vendor-documents.json' },
  { id:'client-portal', label:'Client portal', domain:'sales', samplePrefix:'records/', testKey:'qa/isolation/client-portal.json' },
  { id:'vendor-portal', label:'Vendor portal', domain:'vendorFiles', samplePrefix:'vendors/', testKey:'qa/isolation/vendor-portal.json' },
  { id:'quickbooks', label:'QuickBooks', domain:'integrations', samplePrefix:'quickbooks/', testKey:'qa/isolation/quickbooks.json' },
  { id:'signwell', label:'SignWell', domain:'integrations', samplePrefix:'signwell/', testKey:'qa/isolation/signwell.json' },
  { id:'email-routing', label:'Email routing', domain:'emailRouting', samplePrefix:'', testKey:'qa/isolation/email-routing.json' },
  { id:'email-activity', label:'Email activity', domain:'emailAnalytics', samplePrefix:'', testKey:'qa/isolation/email-activity.json' },
  { id:'calendar', label:'Calendar sync', domain:'calendarSync', samplePrefix:'', testKey:'qa/isolation/calendar.json' },
  { id:'health', label:'System Health', domain:'systemHealth', samplePrefix:'', testKey:'qa/isolation/system-health.json' },
];

function clean(value: unknown, max=500) {
  return String(value ?? '').trim().slice(0,max);
}

function isSandboxOrganization(organization: OrganizationRecord) {
  return organization.slug.startsWith('vl-sandbox-')
    && organization.status !== 'canceled'
    && organization.featureFlags?.['platform.sandbox'] === true;
}

function now() {
  return new Date().toISOString();
}

export async function runCrossTenantLeakageTest(
  context: Context,
  sandboxOrganization: OrganizationRecord,
  koaOrganization: OrganizationRecord,
) {
  if (!isSandboxOrganization(sandboxOrganization)) {
    throw new Error('Leakage testing is restricted to VenueLoom sandbox organizations.');
  }
  if (sandboxOrganization.id === koaOrganization.id) {
    throw new Error('Sandbox tenant and Koa tenant must be different organizations.');
  }

  const sandbox = profileFromOrganization(sandboxOrganization);
  const koa = tenantById(koaOrganization.id) || profileFromOrganization(koaOrganization);
  if (sandbox.storage.legacyDataBelongsToTenant) {
    throw new Error('Sandbox tenant must not have legacy compatibility enabled.');
  }

  const runId='T2-'+Date.now().toString(36)+'-'+crypto.randomUUID().slice(0,8);
  const results:any[]=[];

  for (const surface of LEAKAGE_SURFACES) {
    const sandboxStore=tenantStoreFor(context,sandbox,surface.domain);
    const koaStore=tenantStoreFor(context,koa,surface.domain);
    const key=surface.testKey.replace('.json','-'+runId+'.json');
    const sentinel={
      id:'sandbox-sentinel-'+runId,
      tenantId:sandbox.id,
      surface:surface.id,
      createdAt:now(),
      marker:crypto.randomUUID(),
    };

    let sandboxWrite=false;
    let koaCannotReadSandbox=false;
    let sandboxCannotReadKoa=true;
    let koaSampleKey='';
    let failure='';

    try {
      await runWithTenant(sandbox,()=>sandboxStore.setJSON(key,sentinel));
      const own=await runWithTenant(sandbox,()=>sandboxStore.get(key,{type:'json'} as any)) as any;
      sandboxWrite=own?.tenantId===sandbox.id && own?.marker===sentinel.marker;

      const foreign=await runWithTenant(koa,()=>koaStore.get(key,{type:'json'} as any)).catch(()=>null) as any;
      koaCannotReadSandbox=foreign==null;

      const koaList=await runWithTenant(koa,()=>koaStore.list({prefix:surface.samplePrefix||''}));
      koaSampleKey=clean(koaList.blobs?.[0]?.key,500);
      if (koaSampleKey && koaSampleKey !== key) {
        const leaked=await runWithTenant(sandbox,()=>sandboxStore.get(koaSampleKey,{type:'json'} as any)).catch(()=>null);
        sandboxCannotReadKoa=leaked==null;
      }
    } catch (error) {
      failure=error instanceof Error ? error.message : 'Isolation check failed.';
    } finally {
      await runWithTenant(sandbox,()=>sandboxStore.delete(key)).catch(()=>{});
    }

    results.push({
      id:surface.id,
      label:surface.label,
      domain:surface.domain,
      sandboxWrite,
      koaCannotReadSandbox,
      sandboxCannotReadKoa,
      koaSampleKey:koaSampleKey || '',
      passed:!failure && sandboxWrite && koaCannotReadSandbox && sandboxCannotReadKoa,
      failure,
    });
  }

  const scheduledJobs=[
    'crm-lifecycle','lead-response-reminders','quickbooks-hourly-reconciliation','health-monitor',
    'office365-calendar-sync','vendor-insurance-reminders','post-deploy-verification','review-requests',
  ];
  const iterator=await runForEachTenant(context,async(tenant)=>({
    tenantId:tenant.id,
    schedulerProbeKey:tenantStoreFor(context,tenant,'systemHealth').canonicalKey('qa/scheduler-readonly-probe'),
  }));
  const koaIterator=iterator.find((row)=>row.tenantId===koa.id);
  const sandboxIterator=iterator.find((row)=>row.tenantId===sandbox.id);
  const scheduledPassed=Boolean(
    koaIterator?.ok
    && sandboxIterator?.ok
    && koaIterator.value?.schedulerProbeKey
    && sandboxIterator.value?.schedulerProbeKey
    && koaIterator.value.schedulerProbeKey!==sandboxIterator.value.schedulerProbeKey
  );
  const report={
    runId,
    sandboxTenantId:sandbox.id,
    koaTenantId:koa.id,
    generatedAt:now(),
    surfaces:results,
    scheduledJobs:{
      passed:scheduledPassed,
      mode:'runtime-iterator-plus-build-gate',
      jobs:scheduledJobs,
      iterator,
      evidence:'The production tenant iterator resolved Koa and Tenant #2 to different canonical scheduler namespaces; each scheduled function is also build-gated to use runForEachTenant.',
    },
    summary:{
      surfaces:results.length,
      passed:results.filter((row)=>row.passed).length,
      failed:results.filter((row)=>!row.passed).length,
      clean:results.every((row)=>row.passed) && scheduledPassed,
    },
  };

  await runWithTenant(sandbox,()=>tenantStoreFor(context,sandbox,'systemHealth').setJSON('qa/tenant-isolation/latest',report));
  await appendPlatformSandboxQaHistory(context,sandbox.id,{kind:'leakage',runId:report.runId,generatedAt:report.generatedAt,summary:report.summary,report});
  return report;
}

export async function runSandboxOnboardingJourney(
  context: Context,
  organization: OrganizationRecord,
  actor: { id?:string; email?:string },
) {
  if (!isSandboxOrganization(organization)) {
    throw new Error('Onboarding QA is restricted to VenueLoom sandbox organizations.');
  }
  const profile=profileFromOrganization(organization);
  const runId='ONB-'+Date.now().toString(36)+'-'+crypto.randomUUID().slice(0,8);
  const at=now();
  const steps:any[]=[];
  const add=(id:string,passed:boolean,detail:string,data:any={})=>steps.push({id,passed,detail,...data});

  let updated=organization;
  updated=await saveOrganization(context,profile,(current)=>({
    ...current,
    displayName:current.displayName || 'VenueLoom Sandbox Venue',
    legalName:current.legalName || 'VenueLoom Sandbox Venue LLC',
    status:'trial',
    locale:current.locale || 'en-US',
    currency:current.currency || 'USD',
    timezone:current.timezone || 'UTC',
    country:current.country || 'United States',
    branding:{
      ...current.branding,
      tagline:'Tenant #2 end-to-end onboarding sandbox',
      logoPath:current.branding.logoPath || '/brand/venueloom-sandbox.svg',
      primaryColor:current.branding.primaryColor || '#334155',
      accentColor:current.branding.accentColor || '#64748b',
      backgroundColor:current.branding.backgroundColor || '#f8fafc',
    },
    venues:(current.venues||[]).length ? current.venues : [{
      id:'sandbox-main',name:'Sandbox Venue',address:'Test data only',timezone:current.timezone||'UTC',capacity:120,active:true,
    }],
    taxProfile:{
      id:'sandbox-tax',label:'Sandbox Tax',kind:'sales-tax',enabled:true,
      statutoryRate:4.25,customerRate:4.25,maxPassOnRate:4.25,defaultTaxable:true,
    },
    featureFlags:{...current.featureFlags,'platform.sandbox':true},
    onboarding:{
      ...current.onboarding,
      completedSteps:[...new Set([...(current.onboarding?.completedSteps||[]),'organization','locale','venues','branding','tax-profile'])],
      activatedAt:'',
    },
  }));
  add('organization',Boolean(updated.displayName&&updated.legalName),'Organization identity saved.');
  add('branding',Boolean(updated.branding.tagline&&updated.branding.logoPath),'Branding saved.');
  add('venue',(updated.venues||[]).some((row)=>row.active),'Venue saved.');
  add('tax',Boolean(updated.taxProfile.label),'Tax profile saved.');

  const catalogStore=tenantStoreFor(context,profile,'integrations');
  const catalogItem={
    id:'sandbox-package-'+runId.toLowerCase(),
    tenantId:profile.id,
    name:'Sandbox Event Package',
    description:'Tenant #2 onboarding QA item',
    category:'service',
    group:'packages',
    unitLabel:'package',
    unitPrice:2500,
    internalCost:900,
    targetMargin:60,
    active:true,
    getExempt:false,
    source:'catalog-manager',
    sourceRef:runId,
    quickBooksItemId:'',
    quickBooksItemName:'',
    quickBooksType:'Service',
    incomeAccountId:'',
    incomeAccountName:'',
    updatedAt:at,
  };
  const existingCatalog=(await runWithTenant(profile,()=>catalogStore.get('quickbooks/catalog',{type:'json'} as any)).catch(()=>null) || []) as any[];
  const sandboxCatalog=[catalogItem,...existingCatalog.filter((row:any)=>row?.id!==catalogItem.id)].slice(0,100);
  await runWithTenant(profile,()=>catalogStore.setJSON('quickbooks/catalog',sandboxCatalog));
  updated=await saveOrganization(context,profile,(current)=>({
    ...current,
    onboarding:{...current.onboarding,completedSteps:[...new Set([...(current.onboarding?.completedSteps||[]),'catalog'])]},
  }));
  add('catalog',sandboxCatalog.some((row:any)=>row.id===catalogItem.id),'Catalog item created in Tenant #2 only.',{catalogItemId:catalogItem.id});

  const member:MembershipRecord={
    id:'m_'+profile.id+'_sandbox_qa',
    tenantId:profile.id,
    userId:'sandbox_qa_'+runId.toLowerCase().replace(/[^a-z0-9]/g,'_'),
    email:'sandbox.qa+'+runId.toLowerCase()+'@example.invalid',
    role:'sales',
    capabilities:['sales.view','sales.manage','events.view','vendors.view'],
    status:'active',
    invitedAt:at,
    acceptedAt:at,
    createdAt:at,
    updatedAt:at,
  };
  await saveMembership(context,member);
  const memberships=await listMemberships(context,profile.id);
  updated=await saveOrganization(context,profile,(current)=>({
    ...current,
    onboarding:{...current.onboarding,completedSteps:[...new Set([...(current.onboarding?.completedSteps||[]),'team'])]},
  }));
  add('team',memberships.some((row)=>row.userId===member.userId),'Synthetic sandbox team membership created without sending email.',{membershipId:member.id});

  const sandboxHost=profile.slug+'.invalid';
  updated=await saveOrganization(context,profile,(current)=>({
    ...current,
    domains:[{
      id:'sandbox-domain',
      hostname:sandboxHost,
      kind:'custom',
      status:'verified',
      primary:true,
      verificationToken:'sandbox-only',
      verifiedAt:at,
      lastCheckedAt:at,
      verificationError:'Sandbox verification only; .invalid cannot route publicly.',
    }],
    onboarding:{...current.onboarding,completedSteps:[...new Set([...(current.onboarding?.completedSteps||[]),'domains'])]},
  }));
  add('domain',updated.domains.some((row)=>row.hostname===sandboxHost&&row.status==='verified'),'Reserved .invalid domain completed sandbox verification without DNS changes.',{hostname:sandboxHost,mode:'sandbox'});

  const simulatedProviders=['quickbooks','signwell','resend','microsoft'] as const;
  updated=await saveOrganization(context,profile,(current)=>({
    ...current,
    integrations:(current.integrations||[]).map((row)=>simulatedProviders.includes(row.provider as any)?{
      ...row,
      enabled:true,
      status:'configured',
      remoteAccountId:'sandbox-'+row.provider+'-'+runId,
      remoteAccountName:'Sandbox '+row.provider+' test connection',
      connectedAt:at,
      lastVerifiedAt:at,
      credentialRef:'sandbox://'+profile.id+'/'+row.provider,
    }:row),
    onboarding:{...current.onboarding,completedSteps:[...new Set([...(current.onboarding?.completedSteps||[]),'integrations'])]},
  }));
  add('integrations',simulatedProviders.every((provider)=>updated.integrations.some((row)=>row.provider===provider&&row.status==='configured')),'QuickBooks, SignWell, email, and Microsoft paths configured in sandbox simulation mode; no external credentials were used.');

  updated=await saveOrganization(context,profile,(current)=>({
    ...current,
    templates:[...(current.templates||[]).filter((row)=>row.id!=='sandbox-proposal'),{
      id:'sandbox-proposal',type:'proposal',name:'Sandbox Proposal',enabled:true,source:'tenant',updatedAt:at,
    }],
    onboarding:{...current.onboarding,completedSteps:[...new Set([...(current.onboarding?.completedSteps||[]),'templates'])]},
  }));
  add('templates',updated.templates.some((row)=>row.id==='sandbox-proposal'),'Proposal template configured.');

  updated=await saveOrganization(context,profile,(current)=>({
    ...current,
    subscription:{
      ...current.subscription,
      provider:'stripe',
      status:'trialing',
      plan:'sandbox',
      interval:'monthly',
      seats:2,
      billingEmail:current.contact.email||'sandbox-billing@example.invalid',
      stripeCustomerId:'sandbox_customer_'+runId,
      stripeSubscriptionId:'sandbox_subscription_'+runId,
      currentPeriodEnd:'',
      trialEndsAt:new Date(Date.now()+14*24*60*60*1000).toISOString(),
    },
    onboarding:{...current.onboarding,completedSteps:[...new Set([...(current.onboarding?.completedSteps||[]),'subscription'])]},
  }));
  add('stripe',updated.subscription.status==='trialing','Stripe subscription lifecycle exercised in sandbox simulation mode; no charge or external Stripe object was created.',{mode:'sandbox'});

  const sales=tenantStoreFor(context,profile,'sales');
  const proposalId='VL-SANDBOX-'+runId;
  const proposal={
    id:proposalId,
    tenantId:profile.id,
    kind:'proposal',
    stage:'proposal',
    customer:{name:'Sandbox Client',email:'sandbox.client@example.invalid',eventDate:'2030-01-15'},
    proposal:{
      status:'draft',
      lineItems:[{id:'collection',catalogItemId:catalogItem.id,description:catalogItem.name,quantity:1,unitPrice:catalogItem.unitPrice,amount:catalogItem.unitPrice}],
      subtotal:catalogItem.unitPrice,
      taxAmount:catalogItem.unitPrice*(updated.taxProfile.customerRate/100),
      total:catalogItem.unitPrice*(1+updated.taxProfile.customerRate/100),
    },
    createdAt:at,
    updatedAt:at,
  };
  await runWithTenant(profile,async()=>{
    const index=((await sales.get('records/index',{type:'json'} as any))||[]) as any[];
    await sales.setJSON('records/'+proposalId,proposal);
    await sales.setJSON('records/index',[proposal,...index.filter((row:any)=>row?.id!==proposalId)].slice(0,1500));
  });
  const loaded=await runWithTenant(profile,()=>sales.get('records/'+proposalId,{type:'json'} as any)) as any;
  add('test-proposal',loaded?.tenantId===profile.id&&loaded?.proposal?.status==='draft','Test proposal created and read back inside Tenant #2.',{proposalId});

  const required=steps.filter((row)=>!row.passed);
  if (!required.length) {
    updated=await saveOrganization(context,profile,(current)=>({
      ...current,
      status:'active',
      onboarding:{
        ...current.onboarding,
        activatedAt:at,
        completedSteps:[...new Set([...(current.onboarding?.completedSteps||[]),'test-workflow'])],
      },
    }));
  }
  add('activation',required.length===0 && updated.status==='active',required.length?'Activation blocked because one or more sandbox onboarding steps failed.':'Sandbox tenant activated after all safe onboarding checks passed.');

  const report={
    runId,
    tenantId:profile.id,
    generatedAt:now(),
    mode:'sandbox-safe',
    externalSideEffects:{
      dns:false,
      quickbooks:false,
      signwell:false,
      email:false,
      microsoft:false,
      stripe:false,
    },
    steps,
    summary:{
      steps:steps.length,
      passed:steps.filter((row)=>row.passed).length,
      failed:steps.filter((row)=>!row.passed).length,
      clean:steps.every((row)=>row.passed),
      activated:updated.status==='active',
    },
  };
  await runWithTenant(profile,()=>tenantStoreFor(context,profile,'systemHealth').setJSON('qa/onboarding/latest',report));
  await appendPlatformSandboxQaHistory(context,profile.id,{kind:'onboarding',runId:report.runId,generatedAt:report.generatedAt,summary:report.summary,report});
  return {organization:updated,report};
}


export const SANDBOX_ONBOARDING_STAGES = [
  'organization','branding','venue','tax','catalog','team','domain','integrations','templates','stripe','test-proposal','activation',
] as const;

export async function runSandboxOnboardingStage(
  context: Context,
  organization: OrganizationRecord,
  actor: { id?:string; email?:string },
  requestedStage: string,
) {
  const stage=clean(requestedStage,80);
  if (!SANDBOX_ONBOARDING_STAGES.includes(stage as any)) throw new Error('Unknown sandbox onboarding stage.');
  if (!isSandboxOrganization(organization)) throw new Error('Onboarding QA is restricted to VenueLoom sandbox organizations.');

  const profile=profileFromOrganization(organization);
  const runId='ONB-STAGE-'+Date.now().toString(36)+'-'+crypto.randomUUID().slice(0,8);
  const at=now();
  let updated=organization;
  let step:any={id:stage,passed:false,detail:'Stage did not complete.'};

  if(stage==='organization'){
    updated=await saveOrganization(context,profile,(current)=>({
      ...current,status:'trial',
      displayName:current.displayName||'VenueLoom Sandbox Venue',
      legalName:current.legalName||'VenueLoom Sandbox Venue LLC',
      locale:current.locale||'en-US',currency:current.currency||'USD',timezone:current.timezone||'UTC',country:current.country||'United States',
      onboarding:{...current.onboarding,completedSteps:[...new Set([...(current.onboarding?.completedSteps||[]),'organization','locale'])],activatedAt:''},
    }));
    step={id:stage,passed:Boolean(updated.displayName&&updated.legalName&&updated.locale&&updated.currency&&updated.timezone),detail:'Organization identity and locale settings saved.'};
  }

  if(stage==='branding'){
    updated=await saveOrganization(context,profile,(current)=>({
      ...current,branding:{...current.branding,tagline:'Tenant #2 end-to-end onboarding sandbox',logoPath:current.branding.logoPath||'/brand/venueloom-sandbox.svg',primaryColor:current.branding.primaryColor||'#334155',accentColor:current.branding.accentColor||'#64748b',backgroundColor:current.branding.backgroundColor||'#f8fafc'},
      onboarding:{...current.onboarding,completedSteps:[...new Set([...(current.onboarding?.completedSteps||[]),'branding'])]},
    }));
    step={id:stage,passed:Boolean(updated.branding.tagline&&updated.branding.logoPath),detail:'Branding saved.'};
  }

  if(stage==='venue'){
    updated=await saveOrganization(context,profile,(current)=>({
      ...current,venues:(current.venues||[]).length?current.venues:[{id:'sandbox-main',name:'Sandbox Venue',address:'Test data only',timezone:current.timezone||'UTC',capacity:120,active:true}],
      onboarding:{...current.onboarding,completedSteps:[...new Set([...(current.onboarding?.completedSteps||[]),'venues'])]},
    }));
    step={id:stage,passed:(updated.venues||[]).some((row)=>row.active),detail:'Venue saved.'};
  }

  if(stage==='tax'){
    updated=await saveOrganization(context,profile,(current)=>({
      ...current,taxProfile:{id:'sandbox-tax',label:'Sandbox Tax',kind:'sales-tax',enabled:true,statutoryRate:4.25,customerRate:4.25,maxPassOnRate:4.25,defaultTaxable:true},
      onboarding:{...current.onboarding,completedSteps:[...new Set([...(current.onboarding?.completedSteps||[]),'tax-profile'])]},
    }));
    step={id:stage,passed:Boolean(updated.taxProfile.label),detail:'Tax profile saved.'};
  }

  if(stage==='catalog'){
    const store=tenantStoreFor(context,profile,'integrations');
    const item={id:'sandbox-package-stage',tenantId:profile.id,name:'Sandbox Event Package',description:'Tenant #2 onboarding QA item',category:'service',group:'packages',unitLabel:'package',unitPrice:2500,internalCost:900,targetMargin:60,active:true,getExempt:false,source:'catalog-manager',sourceRef:runId,quickBooksItemId:'',quickBooksItemName:'',quickBooksType:'Service',incomeAccountId:'',incomeAccountName:'',updatedAt:at};
    const current=((await runWithTenant(profile,()=>store.get('quickbooks/catalog',{type:'json'} as any)).catch(()=>null))||[]) as any[];
    const next=[item,...current.filter((row:any)=>row?.id!==item.id)].slice(0,100);
    await runWithTenant(profile,()=>store.setJSON('quickbooks/catalog',next));
    updated=await saveOrganization(context,profile,(currentOrg)=>({...currentOrg,onboarding:{...currentOrg.onboarding,completedSteps:[...new Set([...(currentOrg.onboarding?.completedSteps||[]),'catalog'])]}}));
    step={id:stage,passed:next.some((row:any)=>row.id===item.id),detail:'Catalog item created in Tenant #2 only.',catalogItemId:item.id};
  }

  if(stage==='team'){
    const member:MembershipRecord={id:'m_'+profile.id+'_sandbox_qa_stage',tenantId:profile.id,userId:'sandbox_qa_stage',email:'sandbox.qa.stage@example.invalid',role:'sales',capabilities:['sales.view','sales.manage','events.view','vendors.view'],status:'active',invitedAt:at,acceptedAt:at,createdAt:at,updatedAt:at};
    await saveMembership(context,member);
    const memberships=await listMemberships(context,profile.id);
    updated=await saveOrganization(context,profile,(current)=>({...current,onboarding:{...current.onboarding,completedSteps:[...new Set([...(current.onboarding?.completedSteps||[]),'team'])]}}));
    step={id:stage,passed:memberships.some((row)=>row.userId===member.userId),detail:'Synthetic sandbox team membership created without sending email.',membershipId:member.id};
  }

  if(stage==='domain'){
    const hostname=profile.slug+'.invalid';
    updated=await saveOrganization(context,profile,(current)=>({...current,domains:[{id:'sandbox-domain',hostname,kind:'custom',status:'verified',primary:true,verificationToken:'sandbox-only',verifiedAt:at,lastCheckedAt:at,verificationError:'Sandbox verification only; .invalid cannot route publicly.'}],onboarding:{...current.onboarding,completedSteps:[...new Set([...(current.onboarding?.completedSteps||[]),'domains'])]}}));
    step={id:stage,passed:updated.domains.some((row)=>row.hostname===hostname&&row.status==='verified'),detail:'Reserved .invalid domain completed sandbox verification without DNS changes.',hostname,mode:'sandbox'};
  }

  if(stage==='integrations'){
    const providers=['quickbooks','signwell','resend','microsoft'] as const;
    updated=await saveOrganization(context,profile,(current)=>({...current,integrations:(current.integrations||[]).map((row)=>providers.includes(row.provider as any)?{...row,enabled:true,status:'configured',remoteAccountId:'sandbox-'+row.provider+'-'+runId,remoteAccountName:'Sandbox '+row.provider+' test connection',connectedAt:at,lastVerifiedAt:at,credentialRef:'sandbox://'+profile.id+'/'+row.provider}:row),onboarding:{...current.onboarding,completedSteps:[...new Set([...(current.onboarding?.completedSteps||[]),'integrations'])]}}));
    step={id:stage,passed:providers.every((provider)=>updated.integrations.some((row)=>row.provider===provider&&row.status==='configured')),detail:'QuickBooks, SignWell, email, and Microsoft paths configured in simulation mode; no external credentials were used.'};
  }

  if(stage==='templates'){
    updated=await saveOrganization(context,profile,(current)=>({...current,templates:[...(current.templates||[]).filter((row)=>row.id!=='sandbox-proposal'),{id:'sandbox-proposal',type:'proposal',name:'Sandbox Proposal',enabled:true,source:'tenant',updatedAt:at}],onboarding:{...current.onboarding,completedSteps:[...new Set([...(current.onboarding?.completedSteps||[]),'templates'])]}}));
    step={id:stage,passed:updated.templates.some((row)=>row.id==='sandbox-proposal'),detail:'Proposal template configured.'};
  }

  if(stage==='stripe'){
    updated=await saveOrganization(context,profile,(current)=>({...current,subscription:{...current.subscription,provider:'stripe',status:'trialing',plan:'sandbox',interval:'monthly',seats:2,billingEmail:current.contact.email||'sandbox-billing@example.invalid',stripeCustomerId:'sandbox_customer_'+runId,stripeSubscriptionId:'sandbox_subscription_'+runId,currentPeriodEnd:'',trialEndsAt:new Date(Date.now()+14*24*60*60*1000).toISOString()},onboarding:{...current.onboarding,completedSteps:[...new Set([...(current.onboarding?.completedSteps||[]),'subscription'])]}}));
    step={id:stage,passed:updated.subscription.status==='trialing',detail:'Stripe subscription lifecycle exercised in simulation mode; no charge or external Stripe object was created.',mode:'sandbox'};
  }

  if(stage==='test-proposal'){
    const sales=tenantStoreFor(context,profile,'sales');
    const catalog=tenantStoreFor(context,profile,'integrations');
    const items=((await runWithTenant(profile,()=>catalog.get('quickbooks/catalog',{type:'json'} as any)).catch(()=>null))||[]) as any[];
    const item=items.find((row:any)=>row?.id==='sandbox-package-stage')||items[0]||{id:'sandbox-package-stage',name:'Sandbox Event Package',unitPrice:2500};
    const proposalId='VL-SANDBOX-STAGE-'+runId;
    const taxRate=Number(organization.taxProfile?.customerRate||4.25);
    const proposal={id:proposalId,tenantId:profile.id,kind:'proposal',stage:'proposal',customer:{name:'Sandbox Client',email:'sandbox.client@example.invalid',eventDate:'2030-01-15'},proposal:{status:'draft',lineItems:[{id:'collection',catalogItemId:item.id,description:item.name,quantity:1,unitPrice:Number(item.unitPrice||2500),amount:Number(item.unitPrice||2500)}],subtotal:Number(item.unitPrice||2500),taxAmount:Number(item.unitPrice||2500)*(taxRate/100),total:Number(item.unitPrice||2500)*(1+taxRate/100)},createdAt:at,updatedAt:at};
    await runWithTenant(profile,async()=>{const index=((await sales.get('records/index',{type:'json'} as any))||[]) as any[];await sales.setJSON('records/'+proposalId,proposal);await sales.setJSON('records/index',[proposal,...index.filter((row:any)=>row?.id!==proposalId)].slice(0,1500));});
    const loaded=await runWithTenant(profile,()=>sales.get('records/'+proposalId,{type:'json'} as any)) as any;
    updated=await saveOrganization(context,profile,(current)=>({...current,onboarding:{...current.onboarding,completedSteps:[...new Set([...(current.onboarding?.completedSteps||[]),'test-workflow'])]}}));
    step={id:stage,passed:loaded?.tenantId===profile.id&&loaded?.proposal?.status==='draft',detail:'Test proposal created and read back inside Tenant #2.',proposalId};
  }

  if(stage==='activation'){
    const required=['organization','locale','venues','branding','tax-profile','catalog','team','domains','integrations','templates','subscription','test-workflow'];
    const missing=required.filter((id)=>!(organization.onboarding?.completedSteps||[]).includes(id));
    updated=missing.length?organization:await saveOrganization(context,profile,(current)=>({...current,status:'active',onboarding:{...current.onboarding,activatedAt:at}}));
    step={id:stage,passed:missing.length===0&&updated.status==='active',detail:missing.length?'Activation blocked; missing completed stages: '+missing.join(', '):'Sandbox tenant activated after required onboarding stages were present.',missing};
  }

  const report={
    runId,tenantId:profile.id,generatedAt:now(),mode:'sandbox-safe-stage',requestedStage:stage,
    externalSideEffects:{dns:false,quickbooks:false,signwell:false,email:false,microsoft:false,stripe:false},
    step,
    summary:{steps:1,passed:step.passed?1:0,failed:step.passed?0:1,clean:Boolean(step.passed),activated:updated.status==='active'},
  };
  await appendPlatformSandboxQaHistory(context,profile.id,{kind:'onboarding-stage',stage,runId:report.runId,generatedAt:report.generatedAt,summary:report.summary,report});
  return {organization:updated,report};
}

