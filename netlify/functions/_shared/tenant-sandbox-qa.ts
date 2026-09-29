import type { Context } from '@netlify/functions';
import { tenantById, type TenantProfile } from '../../../src/data/tenants/index.ts';
import {
  createOrganization,
  listMemberships,
  profileFromOrganization,
  readOrganizationById,
  saveMembership,
  saveOrganization,
  savePlatformTenantTestReport,
  type MembershipRecord,
  type OrganizationRecord,
} from './organization.ts';
import {
  listActiveTenantProfiles,
  resolveTenant,
  resolveTenantAsync,
  runForEachTenant,
  runWithTenant,
} from './tenant.ts';
import { tenantEnv } from './tenant-env.ts';
import { tenantMigrationAudit, tenantStoreFor, type TenantStorageDomain } from './tenant-storage.ts';
import {
  getQuickBooksConnection,
  quickBooksConfiguration,
  saveQuickBooksCatalog,
  type QuickBooksCatalogItem,
} from './quickbooks.ts';
import { signWellConfiguration } from './signwell.ts';

const SANDBOX_ID='vl-sandbox-tenant-2';
const SANDBOX_DOMAIN='tenant2-sandbox.venueloom.invalid';

function clean(value:unknown,max=500){return String(value??'').trim().slice(0,max);}
function now(){return new Date().toISOString();}

export type SandboxCreator={id:string;email:string};

export async function ensureTenant2Sandbox(context:Context,creator:SandboxCreator) {
  let organization=await readOrganizationById(context,SANDBOX_ID);
  if(!organization){
    const created=await createOrganization(context,{
      slug:SANDBOX_ID,
      displayName:'VenueLoom Tenant #2 Sandbox',
      legalName:'VenueLoom Tenant #2 Sandbox LLC',
      email:'tenant2-owner@venueloom.invalid',
      locale:'en-US',
      currency:'USD',
      timezone:'America/Chicago',
      country:'United States',
    },{
      id:clean(creator.id,160)||'venueloom-sandbox-runner',
      email:clean(creator.email,240)||'sandbox-runner@venueloom.invalid',
    });
    organization=created.organization;
  }
  const profile=profileFromOrganization(organization);
  organization=await saveOrganization(context,profile,(current)=>({
    ...current,
    displayName:'VenueLoom Tenant #2 Sandbox',
    legalName:'VenueLoom Tenant #2 Sandbox LLC',
    status:current.status==='canceled'?'trial':current.status,
    locale:'en-US',
    currency:'USD',
    timezone:'America/Chicago',
    country:'United States',
    contact:{
      ...current.contact,
      email:'tenant2-owner@venueloom.invalid',
      phone:'+1 555 010 0202',
      venueAddress:'200 Sandbox Avenue, Austin, TX 78701',
      mailingAddress:'200 Sandbox Avenue, Austin, TX 78701',
    },
    branding:{
      ...current.branding,
      tagline:'Synthetic VenueLoom tenant used only for isolation testing',
      primaryColor:'#243c5a',
      accentColor:'#c48b52',
      backgroundColor:'#f7f4ee',
    },
    taxProfile:{
      id:'sandbox-sales-tax',
      label:'Sandbox Sales Tax',
      kind:'sales-tax',
      enabled:true,
      statutoryRate:7.65,
      customerRate:7.65,
      maxPassOnRate:7.65,
      defaultTaxable:true,
    },
    venues:[{
      id:'sandbox-main',
      name:'VenueLoom Sandbox Hall',
      address:'200 Sandbox Avenue, Austin, TX 78701',
      timezone:'America/Chicago',
      capacity:120,
      active:true,
    }],
    templates:[
      {id:'sandbox-proposal',type:'proposal',name:'Sandbox Proposal',enabled:true,source:'tenant',updatedAt:now()},
      {id:'sandbox-contract',type:'contract',name:'Sandbox Contract',enabled:true,source:'tenant',updatedAt:now()},
      {id:'sandbox-email',type:'email',name:'Sandbox Email',enabled:true,source:'tenant',updatedAt:now()},
    ],
    featureFlags:{
      ...current.featureFlags,
      crm:true,
      sales:true,
      events:true,
      vendors:true,
      profitability:true,
      client_portal:true,
      vendor_portal:true,
      sandbox_mode:true,
      quickbooks:false,
      signwell:false,
      email:false,
      calendar:false,
    },
    domains:[{
      id:'sandbox-domain',
      hostname:SANDBOX_DOMAIN,
      kind:'app',
      status:'verified',
      primary:true,
      verificationToken:'sandbox-reserved-domain',
      verifiedAt:current.domains?.find((row:any)=>row.hostname===SANDBOX_DOMAIN)?.verifiedAt||now(),
      lastCheckedAt:now(),
      verificationError:'',
    }],
    subscription:{
      ...current.subscription,
      provider:'stripe',
      status:current.subscription?.status==='active'?'active':'trialing',
      plan:'sandbox',
      interval:'monthly',
      seats:2,
      billingEmail:'tenant2-billing@venueloom.invalid',
      stripeCustomerId:current.subscription?.stripeCustomerId||('sandbox_customer_'+SANDBOX_ID),
      stripeSubscriptionId:current.subscription?.stripeSubscriptionId||('sandbox_subscription_'+SANDBOX_ID),
      trialEndsAt:current.subscription?.trialEndsAt||new Date(Date.now()+14*86400_000).toISOString(),
    },
    integrations:(current.integrations||[]).map((row:any)=>({
      ...row,
      enabled:false,
      status:'configured',
      remoteAccountId:'sandbox-'+row.provider,
      remoteAccountName:'Synthetic '+row.provider+' connection',
      credentialRef:'sandbox:'+row.provider,
      connectedAt:row.connectedAt||now(),
      lastVerifiedAt:now(),
    })),
    sandbox:{
      enabled:true,
      syntheticDomainVerification:true,
      syntheticBilling:true,
      createdBy:clean(creator.email,240)||'sandbox-runner@venueloom.invalid',
      lastIsolationTestAt:current.sandbox?.lastIsolationTestAt||'',
      lastOnboardingTestAt:current.sandbox?.lastOnboardingTestAt||'',
    },
  }));
  return {organization,profile:profileFromOrganization(organization)};
}

function inventoryState(audit:any){
  return Object.fromEntries((audit?.domains||[]).map((row:any)=>[
    row.domain,
    {
      legacyCount:row.legacyCount,
      canonicalCount:row.canonicalCount,
      legacyInventoryHash:row.legacyInventoryHash,
      canonicalInventoryHash:row.canonicalInventoryHash,
    },
  ]));
}

function compareInventory(before:any,after:any){
  const domains=[...new Set([...Object.keys(before||{}),...Object.keys(after||{})])];
  return domains.map((domain)=>({
    domain,
    before:before?.[domain]||null,
    after:after?.[domain]||null,
    unchanged:JSON.stringify(before?.[domain]||null)===JSON.stringify(after?.[domain]||null),
  }));
}

const SURFACE_PROBES:Array<{surface:string;domain:TenantStorageDomain}>=[
  {surface:'CRM',domain:'crm'},
  {surface:'Sales CRM',domain:'sales'},
  {surface:'Events',domain:'eventOps'},
  {surface:'Vendors',domain:'vendors'},
  {surface:'Event documents',domain:'eventFiles'},
  {surface:'Vendor documents',domain:'vendorFiles'},
  {surface:'Client portals',domain:'sales'},
  {surface:'Vendor portals',domain:'vendors'},
  {surface:'QuickBooks storage',domain:'integrations'},
  {surface:'SignWell storage',domain:'integrations'},
  {surface:'Email routing',domain:'emailRouting'},
  {surface:'Email activity',domain:'emailAnalytics'},
];

async function storageSurfaceProbe(
  context:Context,
  koa:TenantProfile,
  sandbox:TenantProfile,
  surface:string,
  domain:TenantStorageDomain,
  runId:string,
){
  const sandboxStore=tenantStoreFor(context,sandbox,domain);
  const koaStore=tenantStoreFor(context,koa,domain);
  const key='__tenant2_probe__/'+runId+'/'+surface.toLowerCase().replace(/[^a-z0-9]+/g,'-');
  let crossTenantWriteBlocked=false;
  let foreignRead:any=null;
  try{
    await sandboxStore.setJSON(key,{tenantId:sandbox.id,runId,surface,sentinel:'TENANT2_ONLY'});
    const own=await sandboxStore.get(key,{type:'json'}) as any;
    foreignRead=await koaStore.get(key,{type:'json'});
    try{
      await sandboxStore.setJSON(key+'-forbidden',{tenantId:koa.id,runId,surface,sentinel:'SHOULD_NOT_WRITE'});
    }catch{
      crossTenantWriteBlocked=true;
    }
    return {
      surface,
      domain,
      ownReadTenantId:clean(own?.tenantId,120),
      koaReadWasNull:foreignRead==null,
      crossTenantWriteBlocked,
      pass:clean(own?.tenantId,120)===sandbox.id && foreignRead==null && crossTenantWriteBlocked,
    };
  }finally{
    await sandboxStore.delete(key).catch(()=>{});
    await sandboxStore.delete(key+'-forbidden').catch(()=>{});
  }
}

export async function runTenant2IsolationProbe(
  context:Context,
  sandboxOrganization:OrganizationRecord,
){
  const startedAt=now();
  const runId='iso_'+crypto.randomUUID().replaceAll('-').slice(0,20);
  const koa=tenantById('koa-events');
  if(!koa)throw new Error('Koa Tenant 1 profile is missing.');
  const sandbox=profileFromOrganization(sandboxOrganization);

  const before=await tenantMigrationAudit(context,koa,undefined,{deep:false});
  const beforeInventory=inventoryState(before);

  const surfaces=[];
  for(const probe of SURFACE_PROBES){
    surfaces.push(await storageSurfaceProbe(context,koa,sandbox,probe.surface,probe.domain,runId));
  }

  const [quickBooks,signWell,email,portalRouting,scheduler] = await Promise.all([
    runWithTenant(sandbox,async()=>{
      const connection=await getQuickBooksConnection(context);
      const configuration=quickBooksConfiguration();
      return {
        connectionFound:Boolean(connection),
        configured:configuration.configured,
        environment:configuration.environment,
        pass:!connection && !configuration.configured,
      };
    }),
    runWithTenant(sandbox,async()=>{
      const configuration=signWellConfiguration();
      return {
        apiKeyConfigured:configuration.apiKeyConfigured,
        webhookIdConfigured:configuration.webhookIdConfigured,
        pass:!configuration.apiKeyConfigured && !configuration.webhookIdConfigured,
      };
    }),
    Promise.resolve().then(()=>({
      resendApiKeyInherited:Boolean(tenantEnv(sandbox,'RESEND_API_KEY')),
      resendWebhookInherited:Boolean(tenantEnv(sandbox,'RESEND_WEBHOOK_SECRET')),
    })).then((row)=>({...row,pass:!row.resendApiKeyInherited&&!row.resendWebhookInherited})),
    Promise.all([
      resolveTenantAsync(new Request('https://'+SANDBOX_DOMAIN+'/api/proposals/sandbox-token'),context),
      resolveTenantAsync(new Request('https://'+koa.domains.primary+'/api/proposals/koa-token'),context),
    ]).then(([tenant2,tenant1])=>({
      tenant2Resolved:tenant2.id,
      tenant1Resolved:tenant1.id,
      pass:tenant2.id===sandbox.id&&tenant1.id===koa.id,
    })),
    runForEachTenant(context,async(tenant)=>({resolvedTenant:resolveTenant().id,expectedTenant:tenant.id}))
      .then((rows)=>({
        rows,
        pass:rows.some((row)=>row.tenantId===koa.id&&row.ok&&row.value?.resolvedTenant===koa.id)
          && rows.some((row)=>row.tenantId===sandbox.id&&row.ok&&row.value?.resolvedTenant===sandbox.id)
          && rows.every((row)=>!row.ok||row.value?.resolvedTenant===row.tenantId),
      })),
  ]);

  const after=await tenantMigrationAudit(context,koa,undefined,{deep:false});
  const koaInventory=compareInventory(beforeInventory,inventoryState(after));
  const koaUnchanged=koaInventory.every((row)=>row.unchanged);
  const pass=surfaces.every((row)=>row.pass)
    && quickBooks.pass
    && signWell.pass
    && email.pass
    && portalRouting.pass
    && scheduler.pass
    && koaUnchanged;

  const report={
    id:runId,
    startedAt,
    completedAt:now(),
    sandboxTenantId:sandbox.id,
    koaTenantId:koa.id,
    pass,
    surfaces,
    integrationIsolation:{quickBooks,signWell,email},
    portalRouting,
    scheduledTenantIteration:scheduler,
    koaInventoryUnchanged:koaUnchanged,
    koaInventory,
  };
  await savePlatformTenantTestReport(context,sandbox.id,'isolation',report);
  await saveOrganization(context,sandbox,(current)=>({
    ...current,
    sandbox:{
      ...(current.sandbox||{
        enabled:true,syntheticDomainVerification:true,syntheticBilling:true,createdBy:'',lastIsolationTestAt:'',lastOnboardingTestAt:'',
      }),
      lastIsolationTestAt:report.completedAt,
    },
  }));
  return report;
}

function sandboxCatalog():QuickBooksCatalogItem[]{
  return [{
    id:'sandbox-venue-package',
    name:'Tenant #2 Sandbox Venue Package',
    description:'Synthetic package used only for VenueLoom tenant-onboarding tests.',
    category:'service',
    group:'packages',
    unitLabel:'package',
    unitPrice:2500,
    internalCost:900,
    targetMargin:60,
    active:true,
    getExempt:false,
    source:'catalog-manager',
    sourceRef:'sandbox-onboarding',
    quickBooksItemId:'',
    quickBooksItemName:'',
    quickBooksType:'Service',
    incomeAccountId:'',
    incomeAccountName:'',
    updatedAt:now(),
  }];
}

async function seedSandboxProposal(context:Context,sandbox:TenantProfile){
  const store=tenantStoreFor(context,sandbox,'sales');
  const id='VL-SANDBOX-PROPOSAL-001';
  const publicToken='sandbox_'+crypto.randomUUID().replaceAll('-');
  const subtotal=2500;
  const tax=Math.round(subtotal*0.0765*100)/100;
  const record={
    id,
    tenantId:sandbox.id,
    kind:'proposal',
    stage:'proposal',
    status:'proposal',
    customer:{
      name:'Tenant Two Test Client',
      email:'tenant2-client@venueloom.invalid',
      eventDate:'2030-06-15',
    },
    packageId:'sandbox-venue-package',
    proposal:{
      status:'draft',
      publicToken,
      lineItems:[{
        id:'sandbox-venue-package',
        catalogItemId:'sandbox-venue-package',
        description:'Tenant #2 Sandbox Venue Package',
        quantity:1,
        unitPrice:subtotal,
        amount:subtotal,
        custom:false,
      }],
      subtotal,
      taxRate:7.65,
      taxLabel:'Sandbox Sales Tax',
      taxAmount:tax,
      total:Math.round((subtotal+tax)*100)/100,
    },
    updatedAt:now(),
  };
  await store.setJSON('records/'+id,record);
  const index=((await store.get('records/index',{type:'json'}))||[]) as any[];
  await store.setJSON('records/index',[record,...index.filter((row:any)=>row?.id!==id)].slice(0,1500));
  return record;
}

export async function runTenant2OnboardingJourney(
  context:Context,
  creator:SandboxCreator,
){
  const startedAt=now();
  const {organization:initial,profile:initialProfile}=await ensureTenant2Sandbox(context,creator);
  const koa=tenantById('koa-events');
  if(!koa)throw new Error('Koa Tenant 1 profile is missing.');
  const koaBefore=inventoryState(await tenantMigrationAudit(context,koa,undefined,{deep:false}));
  const steps:any[]=[];
  let organization=initial;
  let sandbox=initialProfile;

  steps.push({id:'organization',pass:Boolean(organization.id&&organization.displayName),detail:organization.id});

  organization=await saveOrganization(context,sandbox,(current)=>({
    ...current,
    locale:'en-US',
    currency:'USD',
    timezone:'America/Chicago',
    country:'United States',
  }));
  sandbox=profileFromOrganization(organization);
  steps.push({id:'locale',pass:organization.timezone==='America/Chicago',detail:organization.locale+' / '+organization.currency+' / '+organization.timezone});

  steps.push({id:'branding',pass:Boolean(organization.branding.tagline),detail:organization.branding.tagline});
  steps.push({id:'venue',pass:(organization.venues||[]).some((row)=>row.active),detail:organization.venues?.[0]?.name||''});
  steps.push({id:'tax',pass:organization.taxProfile?.label==='Sandbox Sales Tax'&&organization.taxProfile.customerRate===7.65,detail:organization.taxProfile?.label});

  const catalog=await runWithTenant(sandbox,()=>saveQuickBooksCatalog(
    context,
    sandboxCatalog(),
    {actor:creator.email,source:'sandbox-onboarding',note:'Synthetic Tenant #2 onboarding catalog.'},
  ));
  organization=await saveOrganization(context,sandbox,(current)=>({
    ...current,
    onboarding:{
      ...current.onboarding,
      completedSteps:[...new Set([...(current.onboarding?.completedSteps||[]),'catalog'])],
    },
  }));
  sandbox=profileFromOrganization(organization);
  steps.push({id:'catalog',pass:catalog.some((row)=>row.id==='sandbox-venue-package'&&row.unitPrice===2500),detail:String(catalog.length)+' catalog item(s)'});

  const inviteTime=now();
  const membership:MembershipRecord={
    id:'m_'+sandbox.id+'_sandbox_team_user',
    tenantId:sandbox.id,
    userId:'sandbox_team_user',
    email:'tenant2-team@venueloom.invalid',
    role:'sales',
    capabilities:['crm.view','sales.view','sales.manage'],
    status:'invited',
    invitedAt:inviteTime,
    acceptedAt:'',
    createdAt:inviteTime,
    updatedAt:inviteTime,
  };
  await saveMembership(context,membership);
  await saveMembership(context,{...membership,status:'active',acceptedAt:now()});
  const memberships=await listMemberships(context,sandbox.id);
  steps.push({id:'team-invite',pass:memberships.some((row)=>row.userId==='sandbox_team_user'&&row.status==='active'),detail:'sandbox team invitation accepted synthetically'});

  const domain=(organization.domains||[]).find((row)=>row.hostname===SANDBOX_DOMAIN);
  steps.push({
    id:'domain-verification',
    pass:domain?.status==='verified',
    detail:'Reserved .invalid sandbox domain verified synthetically; no public DNS was changed.',
    synthetic:true,
  });

  const integrationPass=(organization.integrations||[]).every((row)=>row.credentialRef==='sandbox:'+row.provider&&row.enabled===false);
  steps.push({
    id:'integrations',
    pass:integrationPass,
    detail:'QuickBooks, SignWell, Resend, Microsoft and Stripe use non-network sandbox stubs; Koa credentials are not inherited.',
    synthetic:true,
  });

  steps.push({
    id:'stripe-subscription',
    pass:organization.subscription?.status==='trialing'&&organization.subscription?.stripeSubscriptionId.startsWith('sandbox_subscription_'),
    detail:organization.subscription?.stripeSubscriptionId||'',
    synthetic:true,
  });

  const proposal=await runWithTenant(sandbox,()=>seedSandboxProposal(context,sandbox));
  steps.push({
    id:'test-proposal',
    pass:proposal.tenantId===sandbox.id&&proposal.proposal.total===2691.25,
    detail:proposal.id+' · '+proposal.proposal.total,
  });

  organization=await saveOrganization(context,sandbox,(current)=>({
    ...current,
    status:'active',
    onboarding:{
      ...current.onboarding,
      completedSteps:[
        'organization','locale','venues','branding','tax-profile','catalog','integrations','team','templates','domains','subscription','test-workflow',
      ],
      activatedAt:current.onboarding?.activatedAt||now(),
    },
    sandbox:{
      ...(current.sandbox||{
        enabled:true,syntheticDomainVerification:true,syntheticBilling:true,createdBy:creator.email,lastIsolationTestAt:'',lastOnboardingTestAt:'',
      }),
      lastOnboardingTestAt:now(),
    },
  }));
  sandbox=profileFromOrganization(organization);
  steps.push({id:'activation',pass:organization.status==='active'&&Boolean(organization.onboarding.activatedAt),detail:organization.onboarding.activatedAt});

  const isolation=await runTenant2IsolationProbe(context,organization);
  steps.push({id:'post-onboarding-isolation',pass:isolation.pass,detail:isolation.id});

  const koaAfter=inventoryState(await tenantMigrationAudit(context,koa,undefined,{deep:false}));
  const koaInventory=compareInventory(koaBefore,koaAfter);
  const koaUnchanged=koaInventory.every((row)=>row.unchanged);
  const pass=steps.every((row)=>row.pass)&&koaUnchanged;
  const report={
    id:'onboard_'+crypto.randomUUID().replaceAll('-').slice(0,20),
    startedAt,
    completedAt:now(),
    tenantId:sandbox.id,
    pass,
    steps,
    syntheticExternalSteps:['domain-verification','integrations','stripe-subscription'],
    koaInventoryUnchanged:koaUnchanged,
    koaInventory,
    organization:{
      id:organization.id,
      slug:organization.slug,
      displayName:organization.displayName,
      status:organization.status,
      onboarding:organization.onboarding,
      subscription:organization.subscription,
      domains:organization.domains,
    },
  };
  await savePlatformTenantTestReport(context,sandbox.id,'onboarding',report);
  return report;
}

export async function sandboxFleetCheck(context:Context) {
  const tenants=await listActiveTenantProfiles(context);
  return {
    tenantIds:tenants.map((row)=>row.id),
    hasKoa:tenants.some((row)=>row.id==='koa-events'),
    hasSandbox:tenants.some((row)=>row.id===SANDBOX_ID),
  };
}

export const TENANT2_SANDBOX_ID=SANDBOX_ID;
export const TENANT2_SANDBOX_DOMAIN=SANDBOX_DOMAIN;
