import { emailButton, emailGreeting, emailGreetingText, emailHeader, assertEmailInlineAssets, emailLogoAttachment, emailSignature, emailSignatureText } from './email-brand';
import type { Context } from '@netlify/functions';
import { tenantStoreFor } from './tenant-storage';
import { resolveTenant } from './tenant';
import { createHmac } from 'node:crypto';
import { creditSaverPreset, creditSaverPresets, readCreditSaverPolicy, setCreditSaverModes } from './credit-saver';
import { emailHealthSummary, emailRenderingFiles } from './email-health';
import { credentialHealthSummary } from './credential-health';
import { qboQuery, quickBooksWebhookVerifierToken } from './quickbooks';
import { evaluateAccountingTaxInvariant, evaluateLiveQuickBooksEstimateInvariant, inspectQuickBooksNonTaxCode } from './quickbooks-accounting-invariant.mjs';
import { syntheticHealthToken } from './synthetic-health';
import { tenantEnv } from './tenant-env';

export type HealthIssueType =
  | 'Service Failure'
  | 'Authentication Expected'
  | 'Configuration Problem'
  | 'Permission Problem'
  | 'Deployment Problem'
  | 'External Dependency Problem';

export type HealthCheck = {
  id: string;
  name: string;
  kind: 'page' | 'api';
  path: string;
  ok: boolean;
  status: number;
  ms: number;
  detail: string;
  severity?: 'green' | 'yellow' | 'red' | 'info';
  issueType?: HealthIssueType | null;
  accountingDetails?: {
    expectedSubtotal: number;
    expectedTax: number;
    expectedTotal: number;
    actualTotal: number;
    taxablePayload: number;
    codeInvariantOk: boolean;
    liveNonTaxStatus: 'available' | 'missing-or-inactive' | 'unverified';
    liveNonTaxVerified: boolean;
    liveNonTaxId?: string;
    liveNonTaxName?: string;
    invariantLabel?: string;
    crmRecordId?: string;
    crmProposalTotal?: number;
    liveEstimateStatus?: 'healthy' | 'mismatch' | 'missing' | 'ambiguous' | 'unverified' | 'not-configured';
    liveEstimateVerified?: boolean;
    liveEstimateCheckedAt?: string;
    liveEstimateId?: string;
    liveEstimateDocNumber?: string;
    liveEstimateTotal?: number;
    liveEstimateLineTotal?: number;
    liveEstimateTaxablePayload?: number;
    liveEstimateQuickBooksTax?: number;
  };
  deploymentState?: 'synced' | 'deploying' | 'waiting' | 'release-policy-skipped' | 'auto-deploy-broken' | 'deploy-failed' | 'unknown';
  deploymentDetails?: {
    githubCommit: string;
    netlifyCommit: string;
    netlifyDeployId: string;
    deployStatus: string;
    deployTime: string;
    deployDurationSeconds: number | null;
    repositoryPrivate: boolean | null;
    verificationSource: string;
    verificationSourceKey: 'github-netlify' | 'netlify-fallback' | 'netlify-runtime' | 'unverified';
    verificationSourceLabel: string;
    githubMetadataSource: string;
    fallbackUsed: boolean;
    commitsBehind?: number | null;
    mainCommitMessage?: string;
    emailRenderingBehind?: boolean;
    emailRenderingChangedFiles?: string[];
  };
};

export type HealthSnapshot = {
  id: string;
  checkedAt: string;
  durationMs?: number;
  overall: 'healthy' | 'unhealthy';
  passed: number;
  failed: number;
  failedIds: string[];
  alertFailedIds?: string[];
  deployId?: string;
  commit?: string;
  checks: HealthCheck[];
  source: 'hourly' | 'manual' | 'post-deploy';
};

export type HealthAlertRule = {
  id: string;
  alertAfter: 1 | 2;
  publicVisible: boolean;
  publicName: string;
};

export type HealthAlertPolicy = {
  updatedAt: string;
  updatedBy: string;
  publicStatusEnabled: boolean;
  office365ReliabilityThresholds: {
    yellowBelow: number;
    redBelow: number;
  };
  rules: HealthAlertRule[];
};

export type CrmStartupSignal = {
  status: 'healthy' | 'failed';
  phase: string;
  detail: string;
  reportedAt: string;
  deployId: string;
  commit: string;
};

export type GithubMainSignal = {
  sha: string;
  repository: string;
  ref: string;
  workflow: string;
  actor: string;
  runId: string;
  issuedAt: number;
  expiresAt: number;
  reportedAt: string;
  source: 'github-actions-oidc';
};

const PAGE_CHECKS = [
  ['admin-home','Content Admin','/admin/','data-auth-panel'],
  ['action-center','Action Center','/admin/actions/','data-app'],
  ['business-crm','Business CRM','/admin/crm/','data-crm-watchdog'],
  ['sales-crm','Sales CRM','/admin/quotes/','data-admin-ui'],
  ['wedding-profitability','Wedding Profitability','/admin/profitability/','data-app'],
  ['event-ops','Event Ops','/admin/events/','data-app'],
  ['master-calendar','Master Calendar','/admin/calendar/','data-app'],
  ['email-admin','Email Admin','/admin/email/','data-email-routing-app'],
  ['email-preview','Email Preview','/admin/email-preview/','data-email-preview-app'],
  ['blog-admin','Blog Admin','/admin/blog/','data-admin-ui'],
  ['staff-management','Staff Management','/admin/staff/','data-app'],
  ['quickbooks','QuickBooks','/admin/quickbooks/','data-app'],
  ['gallery','Gallery','/admin/gallery/','data-admin-ui'],
  ['security','Security + Spam','/admin/security/','data-app'],
  ['local-seo','Local SEO','/admin/seo/','data-admin-ui'],
  ['system-health','System Health','/admin/health/','data-app'],
  ['vendor-crm','Vendor CRM','/admin/vendors/','data-app'],
  ['insurance','Vendor Insurance','/admin/insurance/','data-app'],
  ['mobile-bar-workforce','Mobile Bar Workforce','/admin/mobile-bar-workforce/','data-app'],
  ['payroll','Payroll','/admin/payroll/','data-app'],
  ['staff-home','Staff Home','/staff/','data-staff-ui'],
] as const;

const API_CHECKS = [
  ['admin-session','Admin session API','/api/admin/session'],
  ['account-profile-api','Account Profile API','/api/account/profile'],
  ['workspace-alerts-api','Action Center API','/api/admin/workspace-alerts'],
  ['business-crm-api','Business CRM API','/api/admin/crm'],
  ['sales-crm-api','Sales CRM API','/api/admin/quotes'],
  ['wedding-profitability-api','Wedding Profitability API','/api/admin/profitability'],
  ['event-ops-api','Event Ops API','/api/admin/events'],
  ['calendar-api','Master Calendar API','/api/admin/calendar'],
  ['calendar-office365-api','Office 365 Calendar API','/api/admin/calendar-office365'],
  ['staff-availability-api','Staff Availability API','/api/admin/staff-availability'],
  ['staff-directory-api','Staff Directory API','/api/staff/directory'],
  ['email-routing-api','Email Routing API','/api/admin/email-routing'],
  ['email-activity-api','Email Activity API','/api/admin/email-activity'],
  ['email-preview-api','Email Preview API','/api/admin/email-preview'],
  ['blog-api','Blog API','/api/blog?admin=1'],
  ['staff-api','Staff Management API','/api/admin/staff'],
  ['custom-roles-api','Custom Roles API','/api/admin/custom-roles'],
  ['auth-security-api','Authentication Security API','/api/admin/auth-security'],
  ['quickbooks-api','QuickBooks API','/api/admin/quickbooks'],
  ['gallery-api','Gallery API','/api/gallery'],
  ['security-api','Security API','/api/admin/security?days=7'],
  ['seo-api','Local SEO API','/api/admin/local-seo'],
  ['vendor-crm-api','Vendor CRM API','/api/admin/vendors'],
  ['vendor-insurance-api','Vendor Insurance API','/api/admin/vendor-insurance-compliance'],
  ['mobile-bar-workforce-api','Mobile Bar Workforce API','/api/admin/mobile-bar-workforce'],
  ['payroll-api','Payroll API','/api/admin/payroll'],
  ['system-health-api','System Health API','/api/admin/health'],
] as const;

const SYNTHETIC_INTEGRATION_COMPONENTS = [
  {id:'synthetic-event-documents',name:'Event Documents synthetic probe',path:'/api/admin/events/documents/__health__',kind:'api' as const},
  {id:'synthetic-vendor-insurance-document',name:'Vendor Insurance document synthetic probe',path:'/api/admin/vendors/insurance/__health__',kind:'api' as const},
  {id:'synthetic-quickbooks-webhook',name:'QuickBooks webhook synthetic probe',path:'/.netlify/functions/quickbooks-webhook',kind:'api' as const},
  {id:'synthetic-signwell-webhook',name:'SignWell webhook synthetic probe',path:'/api/webhooks/signwell',kind:'api' as const},
] as const;

export function healthComponents() {
  return [
    ...PAGE_CHECKS.map(([id,name,path])=>({id,name,path,kind:'page' as const})),
    {id:'business-crm-startup',name:'Business CRM startup',path:'/admin/crm/',kind:'page' as const},
    {id:'netlify-github-sync',name:'Netlify ↔ GitHub deployment',path:'main → production',kind:'api' as const},
    {id:'quickbooks-tax-invariant',name:'QuickBooks tax-on-tax invariant',path:'$15,000.00 + $706.80 tax = $15,706.80',kind:'api' as const},
    {id:'credential-quickbooks',name:'QuickBooks credential',path:'Credential Health · QuickBooks',kind:'api' as const},
    {id:'credential-microsoft-graph',name:'Microsoft Graph credential',path:'Credential Health · Microsoft Graph',kind:'api' as const},
    {id:'credential-github',name:'GitHub credential',path:'Credential Health · GitHub',kind:'api' as const},
    {id:'credential-netlify',name:'Netlify credential',path:'Credential Health · Netlify',kind:'api' as const},
    {id:'credential-signwell',name:'SignWell API access',path:'Credential Health · SignWell',kind:'api' as const},
    {id:'credential-turnstile',name:'Cloudflare Turnstile credential',path:'Credential Health · Cloudflare Turnstile',kind:'api' as const},
    {id:'turnstile-site-key',name:'Turnstile site key',path:'PUBLIC_TURNSTILE_SITE_KEY',kind:'api' as const},
    {id:'turnstile-secret',name:'Turnstile server secret',path:'TURNSTILE_SECRET_KEY / TURNSTILE_SECRET',kind:'api' as const},
    {id:'turnstile-widgets',name:'Turnstile widget rendering',path:'4 protected public forms',kind:'api' as const},
    {id:'turnstile-siteverify',name:'Turnstile Siteverify',path:'Cloudflare /siteverify',kind:'api' as const},
    {id:'turnstile-validation-history',name:'Turnstile validation history',path:'Recent successful + failed validations',kind:'api' as const},
    {id:'turnstile-hostname-action',name:'Turnstile hostname + action matching',path:'Recent validation mismatches',kind:'api' as const},
    {id:'signwell-webhook-registration',name:'SignWell webhook registration',path:'SignWell GET /hooks',kind:'api' as const},
    {id:'signwell-webhook-delivery',name:'SignWell webhook delivery',path:'/api/webhooks/signwell',kind:'api' as const},
    {id:'signwell-signed-pdf',name:'SignWell signed PDF retrieval',path:'SignWell completed PDF',kind:'api' as const},
    {id:'email-logo',name:'Email logo availability',path:'/brand/koa-mark.png',kind:'api' as const},
    {id:'email-send-access',name:'Email sending access',path:'Resend send credential',kind:'api' as const},
    {id:'email-monitoring-access',name:'Email monitoring access',path:'Resend delivery-read credential',kind:'api' as const},
    {id:'email-delivery',name:'Email delivery health',path:'Resend delivery lifecycle',kind:'api' as const},
    {id:'resend-webhook',name:'Resend webhook delivery',path:'/api/webhooks/resend',kind:'api' as const},
    {id:'email-template-compatibility',name:'Email template compatibility',path:'build-safety email gate',kind:'api' as const},
    {id:'email-release-sync',name:'Email rendering release sync',path:'email rendering main → production',kind:'api' as const},
    ...SYNTHETIC_INTEGRATION_COMPONENTS,
    ...API_CHECKS.map(([id,name,path])=>({id,name,path,kind:'api' as const})),
  ];
}

export function healthCoverageSummary(snapshot:HealthSnapshot|null|undefined=null) {
  const components=healthComponents();
  const pageIds=new Set(PAGE_CHECKS.map(([id])=>id));
  const apiIds=new Set(API_CHECKS.map(([id])=>id));
  const pages=components.filter((row)=>pageIds.has(row.id as any)).length;
  const apis=components.filter((row)=>apiIds.has(row.id as any)).length;
  const integrations=components.length-pages-apis;
  const checkedIds=new Set((snapshot?.checks||[]).map((row)=>row.id));
  const monitored=snapshot?components.filter((row)=>checkedIds.has(row.id)).length:components.length;
  const total=components.length;
  return {
    pages,
    apis,
    integrations,
    total,
    monitored,
    percent:total?Math.round((monitored/total)*1000)/10:100,
    complete:monitored===total,
  };
}

function defaultAlertAfter(id:string):1|2 {
  const immediate=new Set([
    'action-center','business-crm','business-crm-startup','netlify-github-sync','sales-crm','wedding-profitability','event-ops','master-calendar','email-admin','staff-home',
    'admin-session','workspace-alerts-api','business-crm-api','sales-crm-api','wedding-profitability-api','event-ops-api','calendar-api','email-routing-api',
    'credential-quickbooks','credential-microsoft-graph','credential-github','credential-netlify','credential-signwell','credential-turnstile',
    'turnstile-site-key','turnstile-secret','turnstile-widgets','turnstile-siteverify','turnstile-hostname-action',
    'signwell-webhook-registration','signwell-webhook-delivery','signwell-signed-pdf',
    'quickbooks-tax-invariant',
    'email-logo','email-send-access','email-delivery','resend-webhook','email-template-compatibility','email-release-sync',
    'synthetic-event-documents','synthetic-vendor-insurance-document','synthetic-quickbooks-webhook','synthetic-signwell-webhook',
  ]);
  return immediate.has(id)?1:2;
}

function defaultPublicName(id:string,name:string) {
  if(id==='staff-home'||id==='admin-session') return 'Account access';
  if(id.includes('sales-crm')||id.includes('business-crm')) return 'Booking and inquiry operations';
  if(id.includes('calendar')||id.includes('event-ops')) return 'Event planning operations';
  if(id.includes('blog')) return 'Website content';
  if(id.includes('gallery')) return 'Website media';
  return name.replace(/ API$/,'');
}

export function defaultHealthAlertPolicy():HealthAlertPolicy {
  return {
    updatedAt:'',
    updatedBy:'',
    publicStatusEnabled:false,
    office365ReliabilityThresholds:{yellowBelow:98,redBelow:90},
    rules:healthComponents().map(component=>({
      id:component.id,
      alertAfter:defaultAlertAfter(component.id),
      publicVisible:false,
      publicName:defaultPublicName(component.id,component.name),
    })),
  };
}

export async function readHealthAlertPolicy(context:Context):Promise<HealthAlertPolicy> {
  const stored:any=await healthStore(context).get('settings/alert-policy',{type:'json'});
  const defaults=defaultHealthAlertPolicy();
  if(!stored||!Array.isArray(stored.rules)) return defaults;
  const byId=new Map(stored.rules.map((rule:any)=>[String(rule?.id||''),rule]));
  return {
    updatedAt:clean(stored.updatedAt,80),
    updatedBy:clean(stored.updatedBy,240),
    publicStatusEnabled:Boolean(stored.publicStatusEnabled),
    office365ReliabilityThresholds:{
      yellowBelow:Number.isFinite(Number(stored?.office365ReliabilityThresholds?.yellowBelow))?Math.max(0,Math.min(100,Number(stored.office365ReliabilityThresholds.yellowBelow))):defaults.office365ReliabilityThresholds.yellowBelow,
      redBelow:Number.isFinite(Number(stored?.office365ReliabilityThresholds?.redBelow))?Math.max(0,Math.min(100,Number(stored.office365ReliabilityThresholds.redBelow))):defaults.office365ReliabilityThresholds.redBelow,
    },
    rules:defaults.rules.map(rule=>{
      const saved:any=byId.get(rule.id);
      return {
        id:rule.id,
        alertAfter:saved ? (saved?.alertAfter===1?1:2) : rule.alertAfter,
        publicVisible:Boolean(saved?.publicVisible),
        publicName:clean(saved?.publicName,120)||rule.publicName,
      };
    }),
  };
}

export async function saveHealthAlertPolicy(context:Context,input:any,actor:string):Promise<HealthAlertPolicy> {
  const defaults=defaultHealthAlertPolicy();
  const existing:any=await healthStore(context).get('settings/alert-policy',{type:'json'});
  const incoming=Array.isArray(input?.rules)?input.rules:[];
  const byId=new Map(incoming.map((rule:any)=>[String(rule?.id||''),rule]));
  const inputThresholds=input?.office365ReliabilityThresholds;
  const existingThresholds=existing?.office365ReliabilityThresholds;
  const thresholdSource=inputThresholds&&typeof inputThresholds==='object'?inputThresholds:(existingThresholds&&typeof existingThresholds==='object'?existingThresholds:defaults.office365ReliabilityThresholds);
  const policy:HealthAlertPolicy={
    updatedAt:new Date().toISOString(),
    updatedBy:clean(actor,240)||'admin',
    publicStatusEnabled:Boolean(input?.publicStatusEnabled),
    office365ReliabilityThresholds:{
      yellowBelow:Number.isFinite(Number(thresholdSource?.yellowBelow))?Math.max(0,Math.min(100,Number(thresholdSource.yellowBelow))):defaults.office365ReliabilityThresholds.yellowBelow,
      redBelow:Number.isFinite(Number(thresholdSource?.redBelow))?Math.max(0,Math.min(100,Number(thresholdSource.redBelow))):defaults.office365ReliabilityThresholds.redBelow,
    },
    rules:defaults.rules.map(rule=>{
      const saved:any=byId.get(rule.id);
      return {
        id:rule.id,
        alertAfter:saved ? (saved?.alertAfter===1?1:2) : rule.alertAfter,
        publicVisible:Boolean(saved?.publicVisible),
        publicName:clean(saved?.publicName,120)||rule.publicName,
      };
    }),
  };
  await healthStore(context).setJSON('settings/alert-policy',policy);
  return policy;
}

function healthStore(context: Context) {
  return tenantStoreFor(context, resolveTenant(), 'systemHealth');
}

function clean(value: unknown, max=500) {
  return String(value || '').trim().slice(0,max);
}

export function classifyHealthIssue(row: HealthCheck): HealthIssueType | null {
  const status=Number(row?.status||0);
  const detail=clean(row?.detail,1400).toLowerCase();
  const id=clean(row?.id,120);
  const deploymentState=clean(row?.deploymentState,80);

  if((status===401||status===403)&&row?.ok) return 'Authentication Expected';

  if(
    /not configured|is not configured|missing configuration|environment variable|configuration problem|credential.*missing|startup marker missing|expected startup marker missing/.test(detail)
  ) return 'Configuration Problem';

  if(
    status===401
    || status===403
    || /permission|forbidden|consent|access denied|insufficient scope|restricted to only send|authorization denied|github.*http 404|private repositories return 404/.test(detail)
  ) return 'Permission Problem';

  if(
    status===408
    || status===429
    || status>=500
    || /timeout|timed out|network|fetch failed|temporarily unavailable|service unavailable|upstream|direct github main metadata is unavailable|github main lookup failed/.test(detail)
  ) return 'External Dependency Problem';

  if(
    id==='netlify-github-sync'
    || id==='email-release-sync'
    || ['deploying','waiting','release-policy-skipped','auto-deploy-broken','deploy-failed'].includes(deploymentState)
  ) return row?.severity==='green'&&row?.ok?null:'Deployment Problem';

  if(row?.severity==='yellow'||row?.severity==='red'||!row?.ok) return 'Service Failure';
  return null;
}

export async function recordCrmStartupSignal(context:Context,input:Partial<CrmStartupSignal>) {
  const status:CrmStartupSignal['status']=input.status==='failed'?'failed':'healthy';
  const signal:CrmStartupSignal={
    status,
    phase:clean(input.phase,80)||'unknown',
    detail:clean(input.detail,500),
    reportedAt:new Date().toISOString(),
    deployId:clean(input.deployId,120),
    commit:clean(input.commit,120),
  };
  const store=healthStore(context);
  const history=((await store.get('client/business-crm-startup/history',{type:'json'}))||[]) as CrmStartupSignal[];
  await Promise.all([
    store.setJSON('client/business-crm-startup/latest',signal),
    store.setJSON('client/business-crm-startup/history',[signal,...history].slice(0,100)),
  ]);
  return signal;
}

export async function readCrmStartupSignal(context:Context):Promise<CrmStartupSignal|null> {
  return ((await healthStore(context).get('client/business-crm-startup/latest',{type:'json'}))||null) as CrmStartupSignal|null;
}

function githubWorkflowSignalKey(value:string) {
  return clean(value,240).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,120);
}

export async function readGithubMainSignal(context:Context):Promise<GithubMainSignal|null> {
  return ((await healthStore(context).get('github/main/latest',{type:'json'}))||null) as GithubMainSignal|null;
}

export async function readGithubMainWorkflowSignal(context:Context,workflow:string):Promise<GithubMainSignal|null> {
  const key=githubWorkflowSignalKey(workflow);
  if(!key)return null;
  return ((await healthStore(context).get('github/main/workflows/'+key+'/latest',{type:'json'}))||null) as GithubMainSignal|null;
}

export async function recordGithubMainSignal(context:Context,input:GithubMainSignal) {
  const store=healthStore(context);
  const incomingIssuedAt=Math.max(0,Number(input?.issuedAt||0));
  const signal:GithubMainSignal={
    sha:clean(input?.sha,80),
    repository:clean(input?.repository,240),
    ref:clean(input?.ref,240),
    workflow:clean(input?.workflow,240),
    actor:clean(input?.actor,160),
    runId:clean(input?.runId,80),
    issuedAt:incomingIssuedAt,
    expiresAt:Math.max(0,Number(input?.expiresAt||0)),
    reportedAt:new Date().toISOString(),
    source:'github-actions-oidc',
  };

  const workflowKey=githubWorkflowSignalKey(signal.workflow);
  const workflowPath=workflowKey?'github/main/workflows/'+workflowKey+'/latest':'';
  const [existing,existingWorkflow]=await Promise.all([
    store.get('github/main/latest',{type:'json'}) as Promise<GithubMainSignal|null>,
    workflowPath ? store.get(workflowPath,{type:'json'}) as Promise<GithubMainSignal|null> : Promise.resolve(null),
  ]);
  const genericIssuedAt=Math.max(0,Number(existing?.issuedAt||0));
  const workflowIssuedAt=Math.max(0,Number(existingWorkflow?.issuedAt||0));

  if(workflowPath && (!existingWorkflow || incomingIssuedAt>=workflowIssuedAt)) {
    await store.setJSON(workflowPath,signal);
  }
  if(!existing || incomingIssuedAt>=genericIssuedAt) {
    await store.setJSON('github/main/latest',signal);
  }

  const accepted=!workflowPath || !existingWorkflow || incomingIssuedAt>=workflowIssuedAt;
  return {accepted,signal:accepted?signal:(existingWorkflow||existing||signal),reason:accepted?'stored':'older-workflow-oidc-identity'};
}

function baseUrl() {
  return clean(Netlify.env.get('URL'),500) || 'https://koasevents.com';
}

async function timedFetch(url:string, init:RequestInit={}) {
  const started=Date.now();
  try {
    const response=await fetch(url,{
      ...init,
      headers:{'Cache-Control':'no-cache','User-Agent':'KoaEvents-Health/1.0',...(init.headers||{})},
      signal:AbortSignal.timeout(12_000),
    });
    return {response,ms:Date.now()-started,error:''};
  } catch (error) {
    return {response:null,ms:Date.now()-started,error:error instanceof Error?error.message:'Request failed'};
  }
}

function syntheticResult(
  id:string,
  name:string,
  path:string,
  result:{response:Response|null;ms:number;error:string},
  expectedHeader:string,
):HealthCheck {
  const status=result.response?.status||0;
  const marker=result.response?.headers.get('x-koa-synthetic-check')||'';
  const ok=Boolean(result.response&&status===204&&marker===expectedHeader);
  return {
    id,
    name,
    kind:'api',
    path,
    ok,
    status,
    ms:result.ms,
    severity:ok?'green':'red',
    detail:result.error || (ok
      ? 'Non-destructive synthetic request completed with HTTP 204 and the expected health marker.'
      : 'Synthetic request did not return the expected HTTP 204 health marker.'),
  };
}

async function runLiveSyntheticIntegrationChecks(origin:string):Promise<HealthCheck[]> {
  const internalSyntheticToken=syntheticHealthToken();
  const internalHeaders=internalSyntheticToken?{'X-Koa-Synthetic-Token':internalSyntheticToken}:{};
  const eventDocumentsPromise=internalSyntheticToken
    ? timedFetch(origin+'/api/admin/events/documents/__health__',{method:'HEAD',headers:internalHeaders})
    : Promise.resolve({response:null,ms:0,error:'Internal synthetic health token is unavailable because NETLIFY_AUTH_TOKEN is not configured.'});
  const vendorInsurancePromise=internalSyntheticToken
    ? timedFetch(origin+'/api/admin/vendors/insurance/__health__',{method:'HEAD',headers:internalHeaders})
    : Promise.resolve({response:null,ms:0,error:'Internal synthetic health token is unavailable because NETLIFY_AUTH_TOKEN is not configured.'});

  const quickBooksToken=clean(quickBooksWebhookVerifierToken(),1000);
  const quickBooksBody=JSON.stringify({koaHealthCheck:true,eventNotifications:[]});
  const quickBooksPromise=quickBooksToken
    ? timedFetch(origin+'/.netlify/functions/quickbooks-webhook',{
        method:'POST',
        headers:{
          'Content-Type':'application/json',
          'Intuit-Signature':createHmac('sha256',quickBooksToken).update(quickBooksBody,'utf8').digest('base64'),
          'X-Koa-Health-Check':'1',
        },
        body:quickBooksBody,
      })
    : Promise.resolve({response:null,ms:0,error:'QuickBooks webhook verifier token is not configured.'});

  const signWellWebhookId=clean(tenantEnv(resolveTenant(),'SIGNWELL_WEBHOOK_ID'),1000);
  const signWellEventType='koa_health_check';
  const signWellEventTime=Math.floor(Date.now()/1000);
  const signWellHash=signWellWebhookId
    ? createHmac('sha256',signWellWebhookId).update(signWellEventType+'@'+String(signWellEventTime),'utf8').digest('hex')
    : '';
  const signWellBody=JSON.stringify({
    koaHealthCheck:true,
    event:{type:signWellEventType,time:signWellEventTime,hash:signWellHash},
  });
  const signWellPromise=signWellWebhookId
    ? timedFetch(origin+'/api/webhooks/signwell',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:signWellBody,
      })
    : Promise.resolve({response:null,ms:0,error:'SIGNWELL_WEBHOOK_ID is not configured.'});

  const [eventDocuments,vendorInsurance,quickBooks,signWell]=await Promise.all([
    eventDocumentsPromise,
    vendorInsurancePromise,
    quickBooksPromise,
    signWellPromise,
  ]);

  const signWellCheck=signWellWebhookId
    ? syntheticResult('synthetic-signwell-webhook','SignWell webhook HMAC synthetic probe','/api/webhooks/signwell',signWell,'signwell-webhook')
    : {
        id:'synthetic-signwell-webhook',
        name:'SignWell webhook HMAC synthetic probe',
        kind:'api' as const,
        path:'/api/webhooks/signwell',
        ok:true,
        status:0,
        ms:0,
        severity:'yellow' as const,
        detail:'SIGNWELL_WEBHOOK_ID is not configured, so the zero-write HMAC webhook probe is skipped. This is attention-only until SignWell is enabled.',
      };

  return [
    syntheticResult('synthetic-event-documents','Event Documents synthetic probe','/api/admin/events/documents/:recordId',eventDocuments,'event-documents'),
    syntheticResult('synthetic-vendor-insurance-document','Vendor Insurance document synthetic probe','/api/admin/vendors/insurance/:vendorId',vendorInsurance,'vendor-insurance-document'),
    syntheticResult('synthetic-quickbooks-webhook','QuickBooks webhook synthetic probe','/.netlify/functions/quickbooks-webhook',quickBooks,'quickbooks-webhook'),
    signWellCheck,
  ];
}

async function syntheticIntegrationChecks(context:Context,origin:string,force:boolean):Promise<HealthCheck[]> {
  const store=healthStore(context);
  const cacheKey='synthetic/integrations/latest';
  if(!force){
    try{
      const cached:any=await store.get(cacheKey,{type:'json'});
      const checkedAt=Date.parse(String(cached?.checkedAt||''));
      const rows=Array.isArray(cached?.checks)?cached.checks:[];
      if(rows.length===SYNTHETIC_INTEGRATION_COMPONENTS.length&&Number.isFinite(checkedAt)&&Date.now()-checkedAt<6*60*60*1000){
        return rows.map((row:any)=>({
          ...row,
          detail:clean(String(row?.detail||'')+' · Cached live synthetic verification from '+new Date(checkedAt).toISOString()+'; hourly probes run at most every 6 hours to limit Netlify credit usage.',1200),
        }));
      }
    }catch{}
  }

  const checks=await runLiveSyntheticIntegrationChecks(origin);
  try{
    await store.setJSON(cacheKey,{checkedAt:new Date().toISOString(),checks});
  }catch{}
  return checks;
}

export async function inspectDeploymentSync(context:Context,seed:any={}) {
  const started=Date.now();
  const origin=baseUrl().replace(/\/$/,'');
  const runtimeCommit=clean(Netlify.env.get('COMMIT_REF'),80);
  const runtimeDeployId=clean(Netlify.env.get('DEPLOY_ID'),120);
  let liveCommit=clean(seed?.liveCommit,80)||runtimeCommit;
  let mainCommit=clean(seed?.mainCommit,80);
  let commitsBehind=Number.isFinite(Number(seed?.commitsBehind))?Math.max(0,Number(seed.commitsBehind)):null;
  let compareStatus=clean(seed?.compareStatus,40);
  let deployId=clean(seed?.deployId,120)||runtimeDeployId;
  let githubLinked:boolean|null=null;
  let repository='';
  let productionBranch='';
  let connectionDetail='';
  let mainCommitAt=clean(seed?.mainCommitAt,80);
  let activeDeployId='';
  let activeDeployCommit='';
  let activeDeployState='';
  let targetDeployId='';
  let targetDeployCommit='';
  let targetDeployState='';
  let targetDeployError='';
  let targetDeployCreatedAt='';
  let deployStatus='';
  let deployTime='';
  let deployDurationSeconds:number|null=null;
  let repositoryPrivate:boolean|null=null;
  let metadataSource=liveCommit
    ? (clean(seed?.liveCommit,80)?'seed':runtimeCommit?'netlify-runtime':'')
    : '';
  let fallbackUsed=false;
  let githubMainLookupStatus=0;
  let githubMainLookupDetail='';
  let githubMetadataSource='';
  let mainCommitMessage='';
  let mainCommitParentCount:number|null=null;
  let releasePolicyApproved:boolean|null=null;
  let releasePolicyReason='';
  let publishedDeployId='';
  let productionRows:any[]=[];
  let changedFilesBetween:string[]=[];

  if(!liveCommit||!deployId){
    const home=await timedFetch(origin+'/');
    const html=home.response?await home.response.text().catch(()=>''):'';
    const meta=(name:string)=>html.match(new RegExp('<meta\\s+name=["\\\']'+name+'["\\\']\\s+content=["\\\']([^"\\\']+)["\\\']','i'))?.[1]||'';
    const metaCommit=clean(meta('koa-build-commit'),80);
    const metaDeployId=clean(meta('koa-deploy-id'),120);
    if(!liveCommit&&metaCommit){
      liveCommit=metaCommit;
      metadataSource='homepage-meta';
    }
    if(!deployId&&metaDeployId) deployId=metaDeployId;
  }

  const githubToken=clean(Netlify.env.get('KOA_GITHUB_READ_TOKEN'),500);
  const githubHeaders:Record<string,string>={
    'Accept':'application/vnd.github+json',
    'User-Agent':'KoaEvents-Health/1.0',
    ...(githubToken?{Authorization:'Bearer '+githubToken}:{}),
  };

  if(!mainCommit){
    try{
      const githubSignal=await readGithubMainSignal(context);
      if(githubSignal?.sha && /^[a-f0-9]{40}$/i.test(githubSignal.sha) && githubSignal.repository==='AstroTat808/koasevents.com' && githubSignal.ref==='refs/heads/main'){
        mainCommit=clean(githubSignal.sha,80);
        mainCommitAt=clean(githubSignal.reportedAt,80);
        githubMainLookupStatus=200;
        githubMainLookupDetail='GitHub main verified by a signed GitHub Actions OIDC identity.';
        githubMetadataSource='GitHub Actions OIDC';
      }
    }catch{}
  }

  if(!mainCommit){
    try{
      const response=await fetch('https://api.github.com/repos/AstroTat808/koasevents.com/commits/main',{
        headers:githubHeaders,
        signal:AbortSignal.timeout(12_000),
      });
      githubMainLookupStatus=response.status;
      if(response.ok){
        const body:any=await response.json();
        mainCommit=clean(body?.sha,80);
        mainCommitAt=clean(body?.commit?.committer?.date||body?.commit?.author?.date,80);
        mainCommitMessage=clean(body?.commit?.message,500);
        mainCommitParentCount=Array.isArray(body?.parents)?body.parents.length:null;
        githubMetadataSource='GitHub commits/main';
      }else{
        githubMainLookupDetail='GitHub main lookup returned HTTP '+response.status+'.'+(!githubToken&&response.status===404?' KOA_GITHUB_READ_TOKEN is not configured; private repositories return 404 to unauthenticated GitHub API requests.':'');
      }
    }catch(error){
      githubMainLookupDetail='GitHub main lookup failed: '+(error instanceof Error?clean(error.message,180):'request failed');
    }

    // Secondary GitHub path: private repositories can occasionally fail one commit endpoint
    // while the branch endpoint still returns the branch head with the same read token.
    if(!mainCommit){
      try{
        const branchResponse=await fetch('https://api.github.com/repos/AstroTat808/koasevents.com/branches/main',{
          headers:githubHeaders,
          signal:AbortSignal.timeout(12_000),
        });
        if(branchResponse.ok){
          const branchBody:any=await branchResponse.json();
          mainCommit=clean(branchBody?.commit?.sha,80);
          mainCommitAt=clean(branchBody?.commit?.commit?.committer?.date||branchBody?.commit?.commit?.author?.date,80);
          mainCommitMessage=clean(branchBody?.commit?.commit?.message,500);
          githubMetadataSource='GitHub branches/main';
          githubMainLookupDetail='GitHub main recovered from the branch endpoint.';
        }else if(!githubMainLookupDetail){
          githubMainLookupDetail='GitHub main branch lookup returned HTTP '+branchResponse.status+'.';
        }
      }catch(error){
        if(!githubMainLookupDetail) githubMainLookupDetail='GitHub main branch lookup failed: '+(error instanceof Error?clean(error.message,180):'request failed');
      }
    }
  }

  if(mainCommit && (!mainCommitMessage || mainCommitParentCount==null)){
    try{
      const commitResponse=await fetch(
        'https://api.github.com/repos/AstroTat808/koasevents.com/commits/'+encodeURIComponent(mainCommit),
        {headers:githubHeaders,signal:AbortSignal.timeout(12_000)},
      );
      if(commitResponse.ok){
        const commitBody:any=await commitResponse.json();
        mainCommitMessage=mainCommitMessage||clean(commitBody?.commit?.message,500);
        mainCommitParentCount=Array.isArray(commitBody?.parents)?commitBody.parents.length:mainCommitParentCount;
      }
    }catch{}
  }

  if(mainCommit && (mainCommitMessage || (mainCommitParentCount!=null&&mainCommitParentCount>=2))){
    const explicitRelease=/^(?:\[release\]|release:)/i.test(mainCommitMessage);
    const mergeCommit=(mainCommitParentCount!=null&&mainCommitParentCount>=2)||/^Merge pull request #\d+/m.test(mainCommitMessage);
    const squashPullRequest=/\(#\d+\)\s*$/m.test(mainCommitMessage);
    releasePolicyApproved=Boolean(explicitRelease||mergeCommit||squashPullRequest);
    releasePolicyReason=explicitRelease
      ? 'explicit-release-prefix'
      : mergeCommit
        ? 'merge-commit'
        : squashPullRequest
          ? 'squash-pull-request'
          : 'release-prefix-required';
  }

  const netlifyToken=clean(Netlify.env.get('NETLIFY_AUTH_TOKEN'),500);
  const siteId=clean((context as any)?.site?.id || Netlify.env.get('SITE_ID') || 'd1f3ab06-be2a-41c4-b770-59e6a6acd1b9',120);
  if(!netlifyToken){
    connectionDetail='NETLIFY_AUTH_TOKEN is unavailable, so the Git repository connection cannot be verified.';
  }else{
    try{
      const response=await fetch('https://api.netlify.com/api/v1/sites/'+encodeURIComponent(siteId),{
        headers:{Authorization:'Bearer '+netlifyToken,'User-Agent':'KoaEvents-Health/1.0'},
        signal:AbortSignal.timeout(12_000),
      });
      if(response.ok){
        const site:any=await response.json();
        const build=site?.build_settings||{};
        const repoUrl=clean(build?.repo_url||site?.repo_url,500);
        const repoPath=clean(build?.repo_path||site?.repo_path,300);
        const repoType=clean(build?.repo_type||build?.provider||site?.repo_type,80).toLowerCase();
        const installationId=clean(build?.installation_id||site?.installation_id,120);
        productionBranch=clean(build?.repo_branch||site?.repo_branch,100);
        repository=repoPath||repoUrl;
        const repoText=[repoPath,repoUrl].filter(Boolean).join(' ').replace(/\\/g,'/');
        const expectedRepo=/AstroTat808\/koasevents\.com/i.test(repoText)
          || /github\.com[:/]AstroTat808\/koasevents\.com(?:\.git)?/i.test(repoText);
        const githubProvider=repoType.includes('github')||/github\.com/i.test(repoUrl)||Boolean(installationId);
        const buildsStopped=build?.stop_builds===true;
        githubLinked=Boolean(expectedRepo&&githubProvider&&!buildsStopped);
        connectionDetail=githubLinked
          ? 'Netlify is linked to AstroTat808/koasevents.com'+(productionBranch?' on '+productionBranch:'')+'.'
          : buildsStopped
            ? 'Netlify Git builds are disabled for this project.'
            : repository
              ? 'Netlify repository linkage does not match AstroTat808/koasevents.com.'
              : 'No active Git repository linkage is reported by Netlify.';

        const published:any=site?.published_deploy||site?.deploy||null;
        if(published){
          publishedDeployId=clean(published?.id,120);
          const publishedCommit=clean(published?.commit_ref,80);
          if(!liveCommit&&publishedCommit){
            liveCommit=publishedCommit;
            metadataSource='netlify-published-deploy';
            fallbackUsed=true;
          }
          if(!deployId&&publishedDeployId) deployId=publishedDeployId;
          deployStatus=clean(published?.state,40).toLowerCase()||deployStatus;
          deployTime=clean(published?.published_at||published?.updated_at||published?.created_at,80)||deployTime;
          const seconds=Number(published?.deploy_time);
          if(Number.isFinite(seconds)) deployDurationSeconds=seconds;
          if(typeof published?.public_repo==='boolean') repositoryPrivate=!published.public_repo;
        }
      }else{
        connectionDetail='Netlify site configuration lookup failed with HTTP '+response.status+'.';
      }
    }catch(error){
      connectionDetail='Netlify site configuration lookup failed: '+(error instanceof Error?clean(error.message,220):'request failed');
    }
  }

  if(netlifyToken){
    try{
      const response=await fetch(
        'https://api.netlify.com/api/v1/sites/'+encodeURIComponent(siteId)+'/deploys?per_page=30',
        {
          headers:{Authorization:'Bearer '+netlifyToken,'User-Agent':'KoaEvents-Health/1.0'},
          signal:AbortSignal.timeout(12_000),
        },
      );
      if(response.ok){
        const rows:any[]=await response.json();
        const activeStates=new Set(['new','pending_review','accepted','enqueued','building','uploading','processing','preparing']);
        productionRows=rows.filter((row:any)=>{
          const deployContext=clean(row?.context,40);
          const branch=clean(row?.branch,100);
          return deployContext==='production' && (!productionBranch||!branch||branch===productionBranch);
        });
        const currentProduction=
          (deployId?productionRows.find((row:any)=>clean(row?.id,120)===deployId):null)
          || (publishedDeployId?productionRows.find((row:any)=>clean(row?.id,120)===publishedDeployId):null)
          || productionRows.find((row:any)=>clean(row?.state,40).toLowerCase()==='ready'&&Boolean(row?.published_at))
          || productionRows.find((row:any)=>clean(row?.state,40).toLowerCase()==='ready')
          || null;

        if(currentProduction){
          const currentId=clean(currentProduction?.id,120);
          const currentCommit=clean(currentProduction?.commit_ref,80);
          if(currentCommit&&(!liveCommit||(deployId&&currentId===deployId&&currentCommit!==liveCommit))){
            liveCommit=currentCommit;
            metadataSource='netlify-current-deploy';
            fallbackUsed=true;
          }
          if(!deployId&&currentId) deployId=currentId;
          deployStatus=clean(currentProduction?.state,40).toLowerCase()||deployStatus;
          deployTime=clean(currentProduction?.published_at||currentProduction?.updated_at||currentProduction?.created_at,80)||deployTime;
          const seconds=Number(currentProduction?.deploy_time);
          if(Number.isFinite(seconds)) deployDurationSeconds=seconds;
          if(typeof currentProduction?.public_repo==='boolean') repositoryPrivate=!currentProduction.public_repo;
        }

        const candidateDifferent=liveCommit
          ? productionRows.find((row:any)=>clean(row?.commit_ref,80)&&clean(row?.commit_ref,80)!==liveCommit)
          : null;
        const target=mainCommit
          ? productionRows.find((row:any)=>clean(row?.commit_ref,80)===mainCommit)
          : candidateDifferent;
        const active=productionRows.find((row:any)=>activeStates.has(clean(row?.state,40).toLowerCase()));

        if(target){
          targetDeployId=clean(target?.id,120);
          targetDeployCommit=clean(target?.commit_ref,80);
          targetDeployState=clean(target?.state,40).toLowerCase();
          targetDeployError=clean(target?.error_message,240);
          targetDeployCreatedAt=clean(target?.created_at,80);
        }
        if(active){
          activeDeployId=clean(active?.id,120);
          activeDeployCommit=clean(active?.commit_ref,80);
          activeDeployState=clean(active?.state,40).toLowerCase();
        }
      }
    }catch{}
  }

  if(netlifyToken&&deployId){
    try{
      const response=await fetch('https://api.netlify.com/api/v1/deploys/'+encodeURIComponent(deployId),{
        headers:{Authorization:'Bearer '+netlifyToken,'User-Agent':'KoaEvents-Health/1.0'},
        signal:AbortSignal.timeout(12_000),
      });
      if(response.ok){
        const deploy:any=await response.json();
        const deployCommit=clean(deploy?.commit_ref,80);
        if(deployCommit&&deployCommit!==liveCommit){
          liveCommit=deployCommit;
          metadataSource='netlify-deploy-detail';
          fallbackUsed=true;
        }else if(deployCommit&&!metadataSource){
          metadataSource='netlify-deploy-detail';
        }
        deployStatus=clean(deploy?.state,40).toLowerCase()||deployStatus;
        deployTime=clean(deploy?.published_at||deploy?.updated_at||deploy?.created_at,80)||deployTime;
        const seconds=Number(deploy?.deploy_time);
        if(Number.isFinite(seconds)) deployDurationSeconds=seconds;
        if(typeof deploy?.public_repo==='boolean') repositoryPrivate=!deploy.public_repo;
      }
    }catch{}
  }

  if(commitsBehind==null&&liveCommit&&mainCommit){
    if(liveCommit===mainCommit){
      commitsBehind=0;
      compareStatus='identical';
    }else{
      try{
        const response=await fetch(
          'https://api.github.com/repos/AstroTat808/koasevents.com/compare/'+encodeURIComponent(liveCommit)+'...'+encodeURIComponent(mainCommit),
          {headers:githubHeaders,signal:AbortSignal.timeout(12_000)},
        );
        if(response.ok){
          const body:any=await response.json();
          compareStatus=clean(body?.status,40);
          const ahead=Math.max(0,Number(body?.ahead_by||0));
          commitsBehind=Number.isFinite(ahead)?ahead:null;
          changedFilesBetween=Array.isArray(body?.files)
            ? body.files.map((file:any)=>clean(file?.filename,300)).filter(Boolean)
            : [];
        }
      }catch{}
    }
  }

  const activeStates=new Set(['new','pending_review','accepted','enqueued','building','uploading','processing','preparing']);
  const failedStates=new Set(['error','failed','canceled','cancelled']);
  const targetDeployActive=Boolean(targetDeployState&&activeStates.has(targetDeployState));
  const targetDeployFailed=Boolean(targetDeployState&&failedStates.has(targetDeployState));
  const anyDeployActive=Boolean(activeDeployState&&activeStates.has(activeDeployState));

  if(!mainCommit&&liveCommit&&githubLinked===true){
    if((targetDeployActive||targetDeployFailed)&&targetDeployCommit&&targetDeployCommit!==liveCommit){
      commitsBehind=commitsBehind==null?1:commitsBehind;
      compareStatus=targetDeployActive?'netlify-observed-newer-deploy':'netlify-observed-failed-deploy';
      fallbackUsed=true;
    }else if(deployStatus==='ready'||deployStatus==='current'||Boolean(deployTime)){
      commitsBehind=0;
      compareStatus='netlify-commit-ref';
      fallbackUsed=true;
    }
  }

  const emailRenderingChangedFiles=emailRenderingFiles(changedFilesBetween);
  const emailRenderingMessage=/\b(email|resend|mail|logo|template)\b/i.test(mainCommitMessage);
  const emailRenderingBehind=Boolean(
    commitsBehind!=null&&commitsBehind>0&&
    (emailRenderingChangedFiles.length>0||(!changedFilesBetween.length&&emailRenderingMessage))
  );

  const lagTooHigh=commitsBehind!=null&&commitsBehind>1;
  const lagUnknown=commitsBehind==null;
  const linked=githubLinked===true;
  const metadataReady=Boolean(liveCommit&&(mainCommit||fallbackUsed));
  const mainCommitMs=Date.parse(mainCommitAt);
  const mainAgeMs=Number.isFinite(mainCommitMs)?Math.max(0,Date.now()-mainCommitMs):null;
  const triggerGraceMs=5*60*1000;

  let deploymentState:'synced'|'deploying'|'waiting'|'release-policy-skipped'|'auto-deploy-broken'|'deploy-failed'|'unknown'='unknown';
  let severity:'green'|'yellow'|'red'='red';

  const releasePolicySkipped=Boolean(
    commitsBehind!=null&&commitsBehind>0&&
    linked&&
    releasePolicyApproved===false&&
    !targetDeployActive&&!anyDeployActive&&!targetDeployFailed
  );

  if(!metadataReady||lagUnknown){
    deploymentState='unknown';
    severity='red';
  }else if(commitsBehind===0){
    deploymentState=linked?'synced':'auto-deploy-broken';
    severity=linked?(mainCommit?'green':'yellow'):'red';
  }else if(!linked){
    deploymentState='auto-deploy-broken';
    severity='red';
  }else if(targetDeployActive||anyDeployActive){
    deploymentState='deploying';
    severity=commitsBehind===1?'yellow':'red';
  }else if(targetDeployFailed){
    deploymentState='deploy-failed';
    severity='red';
  }else if(releasePolicySkipped){
    deploymentState='release-policy-skipped';
    severity='yellow';
  }else if(mainAgeMs!=null&&mainAgeMs<triggerGraceMs){
    deploymentState='waiting';
    severity=commitsBehind===1?'yellow':'red';
  }else{
    deploymentState='auto-deploy-broken';
    severity='red';
  }

  const ok=severity!=='red';
  let detail=connectionDetail;
  if(liveCommit&&mainCommit){
    detail+=(detail?' ':'')+(commitsBehind==null
      ? 'Production/main commit lag could not be determined.'
      : commitsBehind===0
        ? 'Production matches main at '+liveCommit.slice(0,12)+'.'
        : 'Production is '+commitsBehind+' commit'+(commitsBehind===1?'':'s')+' behind main.');
  }else if(liveCommit&&fallbackUsed){
    detail+=(detail?' ':'')+'Current production exposes Git commit '+liveCommit.slice(0,12)+' through Netlify commit_ref.';
    if(!mainCommit){
      detail+=' Direct GitHub main metadata is unavailable';
      if(githubMainLookupStatus) detail+=' (HTTP '+githubMainLookupStatus+')';
      detail+='; the monitor used the current Netlify production deploy as its fallback source before deciding health.';
    }
  }else{
    detail+=(detail?' ':'')+'Production or main commit metadata is unavailable.';
    if(githubMainLookupDetail) detail+=' '+githubMainLookupDetail;
  }

  if(deploymentState==='deploying'){
    const runningId=targetDeployId||activeDeployId;
    const runningState=targetDeployActive?targetDeployState:activeDeployState;
    const runningCommit=targetDeployActive?(targetDeployCommit||mainCommit):activeDeployCommit;
    detail+=(detail?' ':'')+'Netlify is currently '+(runningState||'processing')+
      (runningId?' deploy '+runningId.slice(0,12):' a production deploy')+
      (runningCommit?' for commit '+runningCommit.slice(0,12):'')+
      '; the lag is expected while this deploy finishes.';
  }else if(deploymentState==='waiting'){
    const ageMinutes=mainAgeMs==null?null:Math.max(0,Math.floor(mainAgeMs/60000));
    detail+=(detail?' ':'')+'The main commit is recent'+
      (ageMinutes==null?'':' ('+ageMinutes+' minute'+(ageMinutes===1?'':'s')+' old)')+
      '; allowing up to 5 minutes for Netlify Git auto-deploy to start.';
  }else if(deploymentState==='deploy-failed'){
    detail+=(detail?' ':'')+'The production deploy for the newest observed commit ended in '+targetDeployState+
      (targetDeployId?' · deploy '+targetDeployId.slice(0,12):'')+
      (targetDeployError?' · '+targetDeployError:'')+'.';
  }else if(deploymentState==='release-policy-skipped'){
    detail+=(detail?' ':'')+'Commit skipped because it needs a [release] prefix (or must be merged through a pull request). This is an intentional production-release policy decision, not a broken Netlify Git connection.';
  }else if(deploymentState==='auto-deploy-broken'&&linked&&commitsBehind!=null&&commitsBehind>0){
    detail+=(detail?' ':'')+'No active production deploy for main is visible after the Git trigger grace period; Git auto-deploy appears stalled.';
  }

  const effectiveFallbackUsed=Boolean(fallbackUsed&&!mainCommit);
  const verificationSourceKey:'github-netlify'|'netlify-fallback'|'netlify-runtime'|'unverified'=
    mainCommit&&liveCommit
      ? 'github-netlify'
      : effectiveFallbackUsed&&liveCommit
        ? 'netlify-fallback'
        : liveCommit
          ? 'netlify-runtime'
          : 'unverified';
  const verificationSourceLabel=
    verificationSourceKey==='github-netlify'
      ? (githubMetadataSource==='GitHub Actions OIDC'?'GitHub Actions + Netlify':'GitHub + Netlify')
      : verificationSourceKey==='netlify-fallback'
        ? 'Netlify fallback'
        : verificationSourceKey==='netlify-runtime'
          ? 'Netlify runtime'
          : 'Unverified';
  const verificationSource=
    verificationSourceKey==='github-netlify'
      ? 'github-main + netlify-production'
      : verificationSourceKey==='netlify-fallback'
        ? 'netlify-commit-ref fallback'
        : verificationSourceKey==='netlify-runtime'
          ? 'netlify-runtime'
          : 'unverified';

  return {
    ok,
    githubLinked,
    repository,
    productionBranch,
    liveCommit,
    mainCommit,
    mainCommitAt,
    githubCommit:mainCommit,
    deployId,
    deployStatus,
    deployTime,
    deployDurationSeconds,
    repositoryPrivate,
    metadataSource,
    verificationSource,
    verificationSourceKey,
    verificationSourceLabel,
    githubMetadataSource,
    fallbackUsed:effectiveFallbackUsed,
    githubMainLookupStatus,
    githubMainLookupDetail,
    commitsBehind,
    compareStatus,
    lagTooHigh,
    severity,
    deploymentState,
    activeDeployId,
    activeDeployCommit,
    activeDeployState,
    targetDeployId,
    targetDeployCommit,
    targetDeployState,
    mainCommitMessage,
    mainCommitParentCount,
    releasePolicyApproved,
    releasePolicyReason,
    releasePolicySkipped,
    targetDeployCreatedAt,
    changedFilesBetween,
    emailRenderingBehind,
    emailRenderingChangedFiles,
    detail:clean(detail,1200),
    ms:Date.now()-started,
  };
}
async function configuredLiveAccountingInvariant(context:Context){
  const tenant=resolveTenant();
  const config=tenant?.accounting?.healthInvariant;
  if(!config?.enabled){
    return {
      configured:false,
      verified:false,
      ok:true,
      status:'not-configured' as const,
      checkedAt:'',
      label:'',
      recordId:'',
      crmProposalTotal:0,
      estimateId:'',
      docNumber:'',
      total:0,
      lineTotal:0,
      taxablePayload:0,
      quickBooksCalculatedTax:0,
      failures:[] as string[],
    };
  }

  const checkedAt=new Date().toISOString();
  const expectedTotal=Math.round(Number(config.expectedTotal||0)*100)/100;
  const salesStore=tenantStoreFor(context,tenant,'sales');
  const records=((await salesStore.get('records/index',{type:'json'}))||[]) as any[];
  const record=records.find((row:any)=>String(row?.id||'')===String(config.recordId||''));
  if(!record){
    return {
      configured:true,
      verified:true,
      ok:false,
      status:'missing' as const,
      checkedAt,
      label:String(config.label||'Live accounting invariant'),
      recordId:String(config.recordId||''),
      crmProposalTotal:0,
      estimateId:'',
      docNumber:'',
      total:0,
      lineTotal:0,
      taxablePayload:0,
      quickBooksCalculatedTax:0,
      failures:['configured CRM invariant record was not found in the tenant sales store'],
    };
  }

  const crmProposalTotal=Math.round(Number(record?.proposal?.total||0)*100)/100;
  const state=record?.accounting?.quickbooks||{};
  let customerId=String(state?.customerId||'').trim();
  if(!customerId&&config.customerDisplayName){
    const displayName=String(config.customerDisplayName||'').replace(/'/g,"\\'");
    const customerData:any=await qboQuery(
      context,
      "select * from Customer where DisplayName = '"+displayName+"' maxresults 10",
    );
    const customers=Array.isArray(customerData?.QueryResponse?.Customer)?customerData.QueryResponse.Customer:[];
    if(customers.length===1)customerId=String(customers[0]?.Id||'');
  }
  if(!customerId){
    return {
      configured:true,
      verified:true,
      ok:false,
      status:'missing' as const,
      checkedAt,
      label:String(config.label||'Live accounting invariant'),
      recordId:String(config.recordId||''),
      crmProposalTotal,
      estimateId:'',
      docNumber:'',
      total:0,
      lineTotal:0,
      taxablePayload:0,
      quickBooksCalculatedTax:0,
      failures:['QuickBooks customer could not be resolved for the configured accounting invariant'],
    };
  }

  const safeCustomerId=customerId.replace(/'/g,"\\'");
  const estimateData:any=await qboQuery(
    context,
    "select * from Estimate where CustomerRef = '"+safeCustomerId+"' maxresults 1000",
  );
  const estimates=Array.isArray(estimateData?.QueryResponse?.Estimate)?estimateData.QueryResponse.Estimate:[];
  const storedEstimateId=String(state?.estimateId||'').trim();
  let matches=storedEstimateId
    ? estimates.filter((estimate:any)=>String(estimate?.Id||'')===storedEstimateId)
    : [];
  if(!matches.length){
    const marker=String(config.recordId||'').trim().toLowerCase();
    matches=marker?estimates.filter((estimate:any)=>{
      const haystack=[
        estimate?.PrivateNote,
        estimate?.CustomerMemo?.value,
      ].map((value)=>String(value||'').toLowerCase()).join(' ');
      return haystack.includes(marker);
    }):[];
  }
  if(!matches.length&&estimates.length===1)matches=estimates;

  if(matches.length!==1){
    const status:'ambiguous'|'missing'=matches.length>1?'ambiguous':'missing';
    return {
      configured:true,
      verified:true,
      ok:false,
      status,
      checkedAt,
      label:String(config.label||'Live accounting invariant'),
      recordId:String(config.recordId||''),
      crmProposalTotal,
      estimateId:'',
      docNumber:'',
      total:0,
      lineTotal:0,
      taxablePayload:0,
      quickBooksCalculatedTax:0,
      failures:[
        matches.length>1
          ? 'multiple QuickBooks estimates matched the configured accounting invariant'
          : 'no QuickBooks estimate matched the configured accounting invariant',
      ],
    };
  }

  const live=evaluateLiveQuickBooksEstimateInvariant(matches[0],{
    expectedSubtotal:Number(config.expectedSubtotal||0),
    expectedTax:Number(config.expectedTax||0),
    expectedTotal,
  });
  const failures=[...(live.failures||[])];
  if(crmProposalTotal!==expectedTotal){
    failures.unshift('CRM proposal total is not $'+expectedTotal.toFixed(2));
  }

  return {
    configured:true,
    verified:true,
    ok:failures.length===0,
    status:(failures.length?'mismatch':'healthy') as 'mismatch'|'healthy',
    checkedAt,
    label:String(config.label||'Live accounting invariant'),
    recordId:String(config.recordId||''),
    crmProposalTotal,
    estimateId:String(live.estimateId||''),
    docNumber:String(live.docNumber||''),
    total:Number(live.total||0),
    lineTotal:Number(live.lineTotal||0),
    taxablePayload:Number(live.taxablePayload||0),
    quickBooksCalculatedTax:Number(live.quickBooksCalculatedTax||0),
    failures,
  };
}

async function quickBooksTaxInvariantHealthCheck(context:Context):Promise<HealthCheck> {
  const started=Date.now();
  const invariant=evaluateAccountingTaxInvariant();
  const tenant=resolveTenant();
  const configuredInvariant=tenant?.accounting?.healthInvariant;
  const baseDetails={
    expectedSubtotal:Number(configuredInvariant?.expectedSubtotal??invariant.expectedSubtotal??15000),
    expectedTax:Number(configuredInvariant?.expectedTax??invariant.expectedTax??706.80),
    expectedTotal:Number(configuredInvariant?.expectedTotal??invariant.expectedTotal??15706.80),
    actualTotal:Number(invariant?.estimateSummary?.lineTotal||0),
    taxablePayload:Number(invariant?.estimateSummary?.taxableTotal||0),
    codeInvariantOk:Boolean(invariant.ok),
    invariantLabel:String(configuredInvariant?.label||''),
    crmRecordId:String(configuredInvariant?.recordId||''),
  };
  if(!invariant.ok){
    return {
      id:'quickbooks-tax-invariant',
      name:'QuickBooks tax-on-tax invariant',
      kind:'api',
      path:'$15,000.00 + $706.80 tax = $15,706.80',
      ok:false,
      status:503,
      ms:Date.now()-started,
      severity:'red',
      accountingDetails:{
        ...baseDetails,
        liveNonTaxStatus:'unverified',
        liveNonTaxVerified:false,
        liveEstimateStatus:configuredInvariant?.enabled?'unverified':'not-configured',
        liveEstimateVerified:false,
      },
      detail:clean(
        'Accounting configuration problem: the CRM-to-QuickBooks payload invariant failed. '
        +'Expected $15,000.00 + $706.80 tax = $15,706.80 with $0.00 taxable payload. '
        +'Failures: '+(invariant.failures||[]).join('; '),
        1200,
      ),
    };
  }

  try{
    const [taxCodeData,liveEstimate]=await Promise.all([
      qboQuery(context,'select * from TaxCode maxresults 100'),
      configuredLiveAccountingInvariant(context),
    ]);
    const live=inspectQuickBooksNonTaxCode(taxCodeData);
    const accountingDetails:HealthCheck['accountingDetails']={
      ...baseDetails,
      crmProposalTotal:Number(liveEstimate.crmProposalTotal||0),
      liveNonTaxStatus:live.verified?(live.ok?'available':'missing-or-inactive'):'unverified',
      liveNonTaxVerified:Boolean(live.verified),
      liveNonTaxId:String(live?.id||''),
      liveNonTaxName:String(live?.name||''),
      liveEstimateStatus:liveEstimate.status,
      liveEstimateVerified:Boolean(liveEstimate.verified),
      liveEstimateCheckedAt:String(liveEstimate.checkedAt||''),
      liveEstimateId:String(liveEstimate.estimateId||''),
      liveEstimateDocNumber:String(liveEstimate.docNumber||''),
      liveEstimateTotal:Number(liveEstimate.total||0),
      liveEstimateLineTotal:Number(liveEstimate.lineTotal||0),
      liveEstimateTaxablePayload:Number(liveEstimate.taxablePayload||0),
      liveEstimateQuickBooksTax:Number(liveEstimate.quickBooksCalculatedTax||0),
    };

    const liveFailures=Array.isArray(liveEstimate.failures)?liveEstimate.failures:[];
    if(live.verified&&!live.ok){
      return {
        id:'quickbooks-tax-invariant',
        name:'QuickBooks tax-on-tax invariant',
        kind:'api',
        path:'$15,000.00 + $706.80 tax = $15,706.80',
        ok:false,
        status:503,
        ms:Date.now()-started,
        severity:'red',
        accountingDetails,
        detail:clean(
          'Accounting configuration problem: code payload math still passes at exactly $15,706.80 with $0.00 taxable payload, '
          +'but live QuickBooks tax configuration is no longer compatible. '+live.detail,
          1200,
        ),
      };
    }
    if(liveEstimate.configured&&liveEstimate.verified&&!liveEstimate.ok){
      return {
        id:'quickbooks-tax-invariant',
        name:'QuickBooks tax-on-tax invariant',
        kind:'api',
        path:'$15,000.00 + $706.80 tax = $15,706.80',
        ok:false,
        status:503,
        ms:Date.now()-started,
        severity:'red',
        accountingDetails,
        detail:clean(
          (liveEstimate.label?liveEstimate.label+': ':'Live QuickBooks accounting invariant: ')
          +'the production CRM ↔ QuickBooks test failed. '
          +liveFailures.join('; ')
          +'. Expected live total $'+Number(baseDetails.expectedTotal).toFixed(2)
          +', observed $'+Number(liveEstimate.total||0).toFixed(2)
          +', taxable payload $'+Number(liveEstimate.taxablePayload||0).toFixed(2)
          +', QuickBooks-added tax $'+Number(liveEstimate.quickBooksCalculatedTax||0).toFixed(2)+'.',
          1200,
        ),
      };
    }

    const liveDetail=liveEstimate.configured
      ? ' '+liveEstimate.label+' passed against live QuickBooks'
        +(liveEstimate.docNumber?' estimate #'+liveEstimate.docNumber:liveEstimate.estimateId?' estimate '+liveEstimate.estimateId:'')
        +' at $'+Number(liveEstimate.total||0).toFixed(2)
        +' with $'+Number(liveEstimate.taxablePayload||0).toFixed(2)+' taxable payload and $'
        +Number(liveEstimate.quickBooksCalculatedTax||0).toFixed(2)+' QuickBooks-added tax.'
      : '';
    return {
      id:'quickbooks-tax-invariant',
      name:'QuickBooks tax-on-tax invariant',
      kind:'api',
      path:'$15,000.00 + $706.80 tax = $15,706.80',
      ok:true,
      status:200,
      ms:Date.now()-started,
      severity:live.verified?'green':'yellow',
      accountingDetails,
      detail:clean(
        'Invariant passed: $15,000.00 + $706.80 CRM tax = exactly $15,706.80; estimate taxable payload = $0.00; '
        +'milestone invoice line is NON-taxable. '+live.detail+liveDetail,
        1200,
      ),
    };
  }catch(error){
    return {
      id:'quickbooks-tax-invariant',
      name:'QuickBooks tax-on-tax invariant',
      kind:'api',
      path:'$15,000.00 + $706.80 tax = $15,706.80',
      ok:true,
      status:200,
      ms:Date.now()-started,
      severity:'yellow',
      accountingDetails:{
        ...baseDetails,
        liveNonTaxStatus:'unverified',
        liveNonTaxVerified:false,
        liveEstimateStatus:configuredInvariant?.enabled?'unverified':'not-configured',
        liveEstimateVerified:false,
      },
      detail:clean(
        'Code invariant passed at exactly $15,706.80 with $0.00 taxable payload. '
        +'Live QuickBooks verification could not be completed during this run: '
        +(error instanceof Error?error.message:'QuickBooks query unavailable')+'. '
        +'QuickBooks Credential Health reports connection problems separately.',
        1200,
      ),
    };
  }
}

export async function runSystemHealth(context:Context,source:'hourly'|'manual'|'post-deploy'='hourly'):Promise<HealthSnapshot> {
  const healthRunStarted=Date.now();
  const origin=baseUrl().replace(/\/$/,'');
  const pageChecks=PAGE_CHECKS.map(async ([id,name,path,marker]):Promise<HealthCheck>=>{
    const result=await timedFetch(origin+path);
    let body='';
    if(result.response) body=await result.response.text().catch(()=>'');
    const ok=Boolean(result.response?.ok && body.includes(marker));
    return {
      id,name,kind:'page',path,ok,status:result.response?.status||0,ms:result.ms,
      detail:result.error || (ok?'Page shell + startup marker present':result.response?.ok?'Expected startup marker missing':'Page request failed'),
      severity:ok?'green':(defaultAlertAfter(id)===1?'red':'yellow'),
    };
  });
  const apiChecks=API_CHECKS.map(async ([id,name,path]):Promise<HealthCheck>=>{
    const result=await timedFetch(origin+path);
    const status=result.response?.status||0;
    const ok=Boolean(result.response && [200,401,403].includes(status));
    return {
      id,name,kind:'api',path,ok,status,ms:result.ms,
      detail:result.error || (ok?(status===200?'Endpoint reachable':'Endpoint reachable and authorization enforced'):'Unexpected API response'),
      severity:ok?'green':(defaultAlertAfter(id)===1?'red':'yellow'),
    };
  });
  const emailHealthPromise=emailHealthSummary(context,{force:source!=='hourly'});
  const credentialHealthPromise=emailHealthPromise.then((emailHealth)=>
    credentialHealthSummary(context,{force:source==='manual',emailHealth})
  );
  const syntheticChecksPromise=syntheticIntegrationChecks(context,origin,source!=='hourly');
  const accountingInvariantPromise=quickBooksTaxInvariantHealthCheck(context);
  const [baseChecks,startupSignal,deploymentSync,emailHealth,credentialHealth,syntheticChecks,accountingInvariantCheck]=await Promise.all([
    Promise.all([...pageChecks,...apiChecks]),
    readCrmStartupSignal(context),
    inspectDeploymentSync(context),
    emailHealthPromise,
    credentialHealthPromise,
    syntheticChecksPromise,
    accountingInvariantPromise,
  ]);
  const deployId=clean(Netlify.env.get('DEPLOY_ID'),120);
  const commit=clean(Netlify.env.get('COMMIT_REF'),120);
  const sameRelease=Boolean(startupSignal && (
    (deployId && startupSignal.deployId && startupSignal.deployId===deployId)
    || (!startupSignal.deployId && commit && startupSignal.commit && startupSignal.commit===commit)
  ));
  const startupFailed=Boolean(sameRelease && startupSignal?.status==='failed');
  const startupCheck:HealthCheck={
    id:'business-crm-startup',
    name:'Business CRM startup',
    kind:'page',
    path:'/admin/crm/',
    ok:!startupFailed,
    status:startupFailed?500:200,
    ms:0,
    severity:startupFailed?'red':'green',
    detail:startupFailed
      ? 'A logged-in staff browser reported CRM startup failure · '+clean(startupSignal?.phase,80)+(startupSignal?.detail?' · '+clean(startupSignal.detail,300):'')
      : sameRelease && startupSignal?.status==='healthy'
        ? 'Logged-in staff browser confirmed the CRM interface initialized successfully'
        : 'No logged-in browser startup failure has been reported for the current deploy',
  };
  const deploymentSyncCheck:HealthCheck={
    id:'netlify-github-sync',
    name:'Netlify ↔ GitHub deployment',
    kind:'api',
    path:'main → production',
    ok:Boolean(deploymentSync.ok),
    status:deploymentSync.ok?200:503,
    ms:Number(deploymentSync.ms||0),
    detail:clean(deploymentSync.detail,1200),
    severity:deploymentSync.severity,
    deploymentState:deploymentSync.deploymentState,
    deploymentDetails:{
      githubCommit:clean(deploymentSync.githubCommit||deploymentSync.mainCommit,80),
      netlifyCommit:clean(deploymentSync.liveCommit,80),
      netlifyDeployId:clean(deploymentSync.deployId,120),
      deployStatus:clean(deploymentSync.deployStatus,40),
      deployTime:clean(deploymentSync.deployTime,80),
      deployDurationSeconds:Number.isFinite(Number(deploymentSync.deployDurationSeconds))?Number(deploymentSync.deployDurationSeconds):null,
      repositoryPrivate:typeof deploymentSync.repositoryPrivate==='boolean'?deploymentSync.repositoryPrivate:null,
      verificationSource:clean(deploymentSync.verificationSource,120),
      verificationSourceKey:deploymentSync.verificationSourceKey,
      verificationSourceLabel:clean(deploymentSync.verificationSourceLabel,120),
      githubMetadataSource:clean(deploymentSync.githubMetadataSource,120),
      fallbackUsed:Boolean(deploymentSync.fallbackUsed),
      commitsBehind:Number.isFinite(Number(deploymentSync.commitsBehind))?Number(deploymentSync.commitsBehind):null,
      mainCommitMessage:clean(deploymentSync.mainCommitMessage,500),
      emailRenderingBehind:Boolean(deploymentSync.emailRenderingBehind),
      emailRenderingChangedFiles:Array.isArray(deploymentSync.emailRenderingChangedFiles)?deploymentSync.emailRenderingChangedFiles.slice(0,20):[],
    },
  };
  const emailReleaseBehind=Boolean(deploymentSync.emailRenderingBehind);
  const emailReleaseState=String(deploymentSync.deploymentState||'unknown');
  const emailReleaseSeverity:HealthCheck['severity']=emailReleaseBehind
    ? (emailReleaseState==='deploying'||emailReleaseState==='waiting'?'yellow':'red')
    : (deploymentSync.commitsBehind==null?'yellow':'green');
  const emailReleaseChangedFiles=Array.isArray(deploymentSync.emailRenderingChangedFiles)?deploymentSync.emailRenderingChangedFiles:[];
  const emailReleaseDetail=emailReleaseBehind
    ? 'Production is '+Number(deploymentSync.commitsBehind||1)+' commit'+(Number(deploymentSync.commitsBehind||1)===1?'':'s')+' behind GitHub main and the pending release includes email-rendering changes'
      +(emailReleaseChangedFiles.length?' · '+emailReleaseChangedFiles.slice(0,6).join(', '):'')
      +(emailReleaseState==='deploying'||emailReleaseState==='waiting'?' · Netlify is '+emailReleaseState+'.':' · Production is still serving the older email renderer.')
    : deploymentSync.commitsBehind==null
      ? 'Email rendering release sync could not be verified because production/main commit lag is unknown.'
      : 'Production is not behind any email-rendering changes on GitHub main.';
  const emailReleaseCheck:HealthCheck={
    id:'email-release-sync',
    name:'Email rendering release sync',
    kind:'api',
    path:'email rendering main → production',
    ok:emailReleaseSeverity!=='red',
    status:emailReleaseSeverity==='red'?503:200,
    ms:Number(deploymentSync.ms||0),
    severity:emailReleaseSeverity,
    deploymentState:deploymentSync.deploymentState,
    detail:clean(emailReleaseDetail,1200),
    deploymentDetails:{
      githubCommit:clean(deploymentSync.githubCommit||deploymentSync.mainCommit,80),
      netlifyCommit:clean(deploymentSync.liveCommit,80),
      netlifyDeployId:clean(deploymentSync.deployId,120),
      deployStatus:clean(deploymentSync.deployStatus,40),
      deployTime:clean(deploymentSync.deployTime,80),
      deployDurationSeconds:Number.isFinite(Number(deploymentSync.deployDurationSeconds))?Number(deploymentSync.deployDurationSeconds):null,
      repositoryPrivate:typeof deploymentSync.repositoryPrivate==='boolean'?deploymentSync.repositoryPrivate:null,
      verificationSource:clean(deploymentSync.verificationSource,120),
      verificationSourceKey:deploymentSync.verificationSourceKey,
      verificationSourceLabel:clean(deploymentSync.verificationSourceLabel,120),
      githubMetadataSource:clean(deploymentSync.githubMetadataSource,120),
      fallbackUsed:Boolean(deploymentSync.fallbackUsed),
      commitsBehind:Number.isFinite(Number(deploymentSync.commitsBehind))?Number(deploymentSync.commitsBehind):null,
      mainCommitMessage:clean(deploymentSync.mainCommitMessage,500),
      emailRenderingBehind:emailReleaseBehind,
      emailRenderingChangedFiles:emailReleaseChangedFiles.slice(0,20),
    },
  };

  const emailLogoCheck:HealthCheck={
    id:'email-logo',
    name:'Email logo availability',
    kind:'api',
    path:'/brand/koa-mark.png',
    ok:Boolean(emailHealth?.logo?.ok),
    status:Number(emailHealth?.logo?.status||0),
    ms:Number(emailHealth?.logo?.ms||0),
    severity:emailHealth?.logo?.ok?'green':'red',
    detail:clean(emailHealth?.logo?.detail||'Email logo health unavailable.',1200),
  };
  const inlineLogo=emailHealth?.inlineLogo||{};
  const productionEmailVerification=inlineLogo?.productionVerification||{};
  const productionVerificationRequired=Boolean(productionEmailVerification?.required);
  const productionVerificationStatus=String(productionEmailVerification?.status||'');
  const productionVerificationOk=Boolean(
    inlineLogo?.staticAudit?.ok
    && (!productionVerificationRequired||productionVerificationStatus==='success')
  );
  const emailInlineLogoCheck:HealthCheck={
    id:'email-inline-logo-verification',
    name:'Email inline logo verification',
    kind:'api',
    path:'controlled production email → Resend attachment audit',
    ok:productionVerificationOk,
    status:productionVerificationOk?200:503,
    ms:0,
    severity:productionVerificationOk?'green':'red',
    detail:clean(
      String(inlineLogo?.detail||'Inline logo production verification is unavailable.')
      +(inlineLogo?.lastSuccessfulAt?' · Last successful production verification: '+String(inlineLogo.lastSuccessfulAt):'')
      +(productionEmailVerification?.messageId?' · Resend ID: '+String(productionEmailVerification.messageId):''),
      1200,
    ),
  };
  const emailSendAccess=emailHealth?.sendAccess||{};
  const emailSendAccessCheck:HealthCheck={
    id:'email-send-access',
    name:'Email sending access',
    kind:'api',
    path:'Resend send credential',
    ok:Boolean(emailSendAccess?.ok),
    status:Number(emailSendAccess?.status||0) || (emailSendAccess?.ok?200:503),
    ms:0,
    severity:emailSendAccess?.ok?'green':'red',
    detail:clean(emailSendAccess?.detail||'Email sending credential verification is unavailable.',1200),
  };
  const emailMonitoringAccess=emailHealth?.monitoringAccess||{};
  const emailMonitoringAccessCheck:HealthCheck={
    id:'email-monitoring-access',
    name:'Email monitoring access',
    kind:'api',
    path:'Resend delivery-read credential',
    ok:true,
    status:Number(emailMonitoringAccess?.status||0) || (emailMonitoringAccess?.reachable?200:503),
    ms:0,
    severity:emailMonitoringAccess?.reachable?'green':'yellow',
    detail:clean(
      emailMonitoringAccess?.detail
      || (emailMonitoringAccess?.configured
        ? 'The dedicated Resend monitoring credential is configured but delivery history could not be read.'
        : 'RESEND_MONITORING_API_KEY is not configured. Sending is evaluated separately and signed webhook history remains available when configured.'),
      1200,
    ),
  };
  const emailDelivery= emailHealth?.delivery || {};
  const delivery24h=emailDelivery?.period24h||{};
  const emailDeliveryCheck:HealthCheck={
    id:'email-delivery',
    name:'Email delivery health',
    kind:'api',
    path:'Resend delivery lifecycle',
    ok:String(emailDelivery?.severity||'yellow')!=='red',
    status:Number(emailDelivery?.apiStatus||0) || (emailDelivery?.webhookConfigured?200:503),
    ms:0,
    severity:String(emailDelivery?.severity||'yellow')==='red'?'red':String(emailDelivery?.severity||'yellow')==='yellow'?'yellow':'green',
    detail:clean(
      '24h: '+Number(delivery24h.total||0)+' lifecycle events · '
      +Number(delivery24h.bounced||0)+' bounced · '
      +Number(delivery24h.complained||0)+' complaints · '
      +Number(delivery24h.failed||0)+' failed · '
      +Number(delivery24h.suppressed||0)+' suppressed'
      +(emailDelivery?.apiDetail?' · '+String(emailDelivery.apiDetail):''),
      1200,
    ),
  };
  const credentialChecks:HealthCheck[]=(Array.isArray(credentialHealth?.rows)?credentialHealth.rows:[])
    .filter((row:any)=>!['resend-send','resend-monitoring'].includes(String(row?.id||'')))
    .map((row:any)=>{
      const rowSeverity:HealthCheck['severity']=String(row?.severity||'yellow')==='red'
        ? 'red'
        : String(row?.severity||'yellow')==='green'
          ? 'green'
          : 'yellow';
      return {
        id:'credential-'+clean(row?.id,100),
        name:clean(row?.provider,120)+' credential',
        kind:'api' as const,
        path:'Credential Health · '+clean(row?.provider,120),
        ok:rowSeverity!=='red',
        status:Number(row?.status||0),
        ms:0,
        severity:rowSeverity,
        detail:clean(
          clean(row?.credential,180)
          +' · '+clean(row?.detail||'Credential verification result unavailable.',900),
          1200,
        ),
      };
    })
    .filter((row:any)=>row.id!=='credential-');
  const turnstileCredential=(Array.isArray(credentialHealth?.rows)?credentialHealth.rows:[])
    .find((row:any)=>String(row?.id||'')==='turnstile')||{};
  const turnstileDiag=turnstileCredential?.diagnostics||{};
  const turnstileWidgets=turnstileDiag?.widgetRendering||{};
  const turnstileSiteverify=turnstileDiag?.siteverify||{};
  const turnstileTotals=turnstileDiag?.totals||{};
  const turnstileMismatches=turnstileDiag?.mismatches||{};
  const turnstileLastSuccess=turnstileDiag?.lastSuccess||null;
  const turnstileLastFailure=turnstileDiag?.lastFailure||null;

  const turnstileSiteKeyCheck:HealthCheck={
    id:'turnstile-site-key',
    name:'Turnstile site key',
    kind:'api',
    path:'PUBLIC_TURNSTILE_SITE_KEY',
    ok:Boolean(turnstileDiag?.siteKeyConfigured),
    status:turnstileDiag?.siteKeyConfigured?200:0,
    ms:0,
    severity:turnstileDiag?.siteKeyConfigured?'green':'yellow',
    detail:turnstileDiag?.siteKeyConfigured
      ? 'Public Turnstile site key is configured in the production runtime.'
      : 'PUBLIC_TURNSTILE_SITE_KEY / TURNSTILE_SITEKEY / TURNSTILE_SITE_KEY is missing.',
  };

  const turnstileSecretCheck:HealthCheck={
    id:'turnstile-secret',
    name:'Turnstile server secret',
    kind:'api',
    path:'TURNSTILE_SECRET_KEY / TURNSTILE_SECRET',
    ok:Boolean(turnstileDiag?.secretConfigured),
    status:turnstileDiag?.secretConfigured?200:0,
    ms:0,
    severity:turnstileDiag?.secretConfigured?'green':'red',
    detail:turnstileDiag?.secretConfigured
      ? 'Server-side Turnstile secret is configured. Secret value is never exposed by System Health.'
      : 'TURNSTILE_SECRET_KEY / TURNSTILE_SECRET is missing from the production runtime.',
  };

  const turnstileWidgetCheck:HealthCheck={
    id:'turnstile-widgets',
    name:'Turnstile widget rendering',
    kind:'api',
    path:'4 protected public forms',
    ok:Boolean(turnstileWidgets?.ok),
    status:turnstileWidgets?.ok?200:503,
    ms:0,
    severity:turnstileWidgets?.ok?'green':'red',
    detail:clean(
      String(Number(turnstileWidgets?.healthy||0))+'/'+String(Number(turnstileWidgets?.total||0))
      +' protected forms render the configured site key, Turnstile script, and expected action'
      +(Array.isArray(turnstileWidgets?.widgets)
        ? ' · '+turnstileWidgets.widgets.map((row:any)=>String(row?.path||'')+': '+(row?.ok?'OK':String(row?.detail||'failed'))).join(' · ')
        : ''),
      1200,
    ),
  };

  const turnstileSiteverifyCheck:HealthCheck={
    id:'turnstile-siteverify',
    name:'Turnstile Siteverify',
    kind:'api',
    path:'Cloudflare /siteverify',
    ok:Boolean(turnstileSiteverify?.ok),
    status:Number(turnstileSiteverify?.status||0),
    ms:0,
    severity:turnstileSiteverify?.ok
      ? 'green'
      : turnstileSiteverify?.reachable===false||Number(turnstileSiteverify?.status||0)>=500||Number(turnstileSiteverify?.status||0)===429
        ? 'yellow'
        : 'red',
    detail:clean(turnstileSiteverify?.detail||'Cloudflare Siteverify status is unavailable.',1200),
  };

  const turnstileValidationHistoryCheck:HealthCheck={
    id:'turnstile-validation-history',
    name:'Turnstile validation history',
    kind:'api',
    path:'Recent successful + failed validations',
    ok:true,
    status:turnstileLastSuccess?200:0,
    ms:0,
    severity:turnstileLastSuccess?'green':'yellow',
    detail:clean(
      String(Number(turnstileTotals?.successful||0))+' successful · '
      +String(Number(turnstileTotals?.failed||0))+' failed · '
      +String(Number(turnstileTotals?.validations||0))+' total in '
      +String(Number(turnstileDiag?.windowDays||30))+'d'
      +(turnstileLastSuccess?.createdAt?' · Last success '+String(turnstileLastSuccess.createdAt):' · No successful validation recorded yet')
      +(turnstileLastFailure?.createdAt?' · Last failure '+String(turnstileLastFailure.createdAt):' · No failed validation recorded'),
      1200,
    ),
  };

  const turnstileMismatchCount=Number(turnstileMismatches?.total||0);
  const turnstileMismatchCheck:HealthCheck={
    id:'turnstile-hostname-action',
    name:'Turnstile hostname + action matching',
    kind:'api',
    path:'Recent validation mismatches',
    ok:turnstileMismatchCount===0,
    status:turnstileMismatchCount===0?200:409,
    ms:0,
    severity:turnstileMismatchCount===0?'green':'red',
    detail:clean(
      turnstileMismatchCount===0
        ? 'No hostname or action mismatches recorded in the current validation window.'
        : String(turnstileMismatchCount)+' mismatches · hostname '+String(Number(turnstileMismatches?.hostname||0))
          +' · action '+String(Number(turnstileMismatches?.action||0))
          +(turnstileMismatches?.lastSeenAt?' · last seen '+String(turnstileMismatches.lastSeenAt):''),
      1200,
    ),
  };

  const signWellCredential=(Array.isArray(credentialHealth?.rows)?credentialHealth.rows:[])
    .find((row:any)=>String(row?.id||'')==='signwell')||{};
  const signWellDiag=signWellCredential?.diagnostics||{};
  const signWellApi=signWellDiag?.api||{};
  const signWellHook=signWellDiag?.webhook||{};
  const signWellDelivery=signWellDiag?.delivery||{};
  const signWellPdf=signWellDiag?.signedPdf||{};
  const signWellConfig=signWellDiag?.configuration||{};
  const signWellApiConfigured=Boolean(signWellConfig?.apiKeyConfigured);
  const signWellIdConfigured=Boolean(signWellHook?.idConfigured||signWellConfig?.webhookIdConfigured);

  const signWellRegistrationCheck:HealthCheck={
    id:'signwell-webhook-registration',
    name:'SignWell webhook registration',
    kind:'api',
    path:'SignWell GET /hooks',
    ok:!signWellApiConfigured||!signWellIdConfigured||Boolean(signWellHook?.registered&&signWellHook?.endpointMatch),
    status:Number(signWellHook?.status||0),
    ms:0,
    severity:!signWellApiConfigured||!signWellIdConfigured
      ? 'yellow'
      : signWellHook?.registered&&signWellHook?.endpointMatch
        ? 'green'
        : Number(signWellHook?.status||0)>=500||Number(signWellHook?.status||0)===429
          ? 'yellow'
          : 'red',
    detail:clean(signWellHook?.detail||(
      !signWellApiConfigured
        ? 'SIGNWELL_API_KEY is not configured.'
        : !signWellIdConfigured
          ? 'SIGNWELL_WEBHOOK_ID is not configured.'
          : 'SignWell webhook registration verification is unavailable.'
    ),1200),
  };

  const signWellDeliveryCheck:HealthCheck={
    id:'signwell-webhook-delivery',
    name:'SignWell webhook delivery',
    kind:'api',
    path:'/api/webhooks/signwell',
    ok:true,
    status:signWellDelivery?.verified?200:0,
    ms:0,
    severity:signWellDelivery?.verified?'green':'yellow',
    detail:clean(signWellDelivery?.verified
      ? 'Most recent verified SignWell webhook: '+String(signWellDelivery?.eventType||'event')+' · '+String(signWellDelivery?.lastWebhookAt||'')
      : (signWellDelivery?.detail||'No verified production SignWell webhook delivery has been recorded yet.'),1200),
  };

  const signWellPdfCheck:HealthCheck={
    id:'signwell-signed-pdf',
    name:'SignWell signed PDF retrieval',
    kind:'api',
    path:'SignWell completed PDF',
    ok:!signWellPdf?.available||Boolean(signWellPdf?.ok),
    status:Number(signWellPdf?.status||0),
    ms:0,
    severity:!signWellApiConfigured||!signWellPdf?.available
      ? 'yellow'
      : signWellPdf?.ok
        ? 'green'
        : Number(signWellPdf?.status||0)>=500||Number(signWellPdf?.status||0)===429
          ? 'yellow'
          : 'red',
    detail:clean(signWellPdf?.detail||'Completed SignWell PDF retrieval has not been verified yet.',1200),
  };

  const webhook=emailDelivery?.webhook||{};
  const webhookDelivery=emailDelivery?.webhookDelivery||{};
  const webhookExists=webhook?.existsInResend;
  const webhookEnabled=webhook?.enabled;
  const webhookSecretConfigured=Boolean(webhook?.signingSecretConfigured||emailDelivery?.webhookConfigured);
  const webhookDeliveryStatus=String(webhookDelivery?.status||'unknown').toLowerCase();
  const webhookHttpStatus=Number(webhookDelivery?.attempt?.httpStatus||0);
  const webhookConfigurationFailed=webhookExists===false||webhookEnabled===false||!webhookSecretConfigured;
  const webhookDeliveryFailed=webhookDeliveryStatus==='failed';
  const webhookVerificationIncomplete=webhookExists==null||!webhookDelivery?.available||['unknown','none','pending','attempting'].includes(webhookDeliveryStatus);
  const resendWebhookSeverity:HealthCheck['severity']=webhookConfigurationFailed||webhookDeliveryFailed
    ? 'red'
    : webhookVerificationIncomplete
      ? 'yellow'
      : 'green';
  const resendWebhookCheck:HealthCheck={
    id:'resend-webhook',
    name:'Resend webhook delivery',
    kind:'api',
    path:'/api/webhooks/resend',
    ok:!webhookConfigurationFailed&&!webhookDeliveryFailed,
    status:webhookHttpStatus || (webhookConfigurationFailed?503:200),
    ms:0,
    severity:resendWebhookSeverity,
    detail:clean(
      (webhookExists===true?'Resend webhook exists':webhookExists===false?'Resend webhook not found':'Resend webhook existence not verified')
      +' · '+(webhookEnabled===true?'enabled':webhookEnabled===false?'disabled':'enablement not verified')
      +' · '+(webhookSecretConfigured?'Netlify signing secret configured':'Netlify signing secret missing')
      +' · '+(
        webhookDeliveryStatus==='success'
          ? 'latest delivery succeeded'+(webhookHttpStatus?' with HTTP '+webhookHttpStatus:'')
          : webhookDeliveryStatus==='failed'
            ? 'latest delivery failed'+(webhookHttpStatus?' with HTTP '+webhookHttpStatus:'')
            : webhookDeliveryStatus==='none'
              ? 'no webhook delivery events recorded yet'
              : 'latest delivery status '+webhookDeliveryStatus
      )
      +(webhookDelivery?.eventType?' · '+String(webhookDelivery.eventType):'')
      +(webhookDelivery?.detail?' · '+String(webhookDelivery.detail):''),
      1200,
    ),
  };
  const templateCompatibility=emailHealth?.templateCompatibility||{};
  const emailTemplateCheck:HealthCheck={
    id:'email-template-compatibility',
    name:'Email template compatibility',
    kind:'api',
    path:'build-safety email gate',
    ok:Boolean(templateCompatibility?.passed),
    status:templateCompatibility?.passed?200:503,
    ms:0,
    severity:templateCompatibility?.passed?'green':'red',
    detail:clean(
      (templateCompatibility?.detail||'Email compatibility gate unavailable.')
      +' · '+Number(templateCompatibility?.templateCount||0)+' automated templates covered',
      1200,
    ),
  };
  const checks=[...baseChecks,startupCheck,deploymentSyncCheck,accountingInvariantCheck,...credentialChecks,turnstileSiteKeyCheck,turnstileSecretCheck,turnstileWidgetCheck,turnstileSiteverifyCheck,turnstileValidationHistoryCheck,turnstileMismatchCheck,signWellRegistrationCheck,signWellDeliveryCheck,signWellPdfCheck,emailReleaseCheck,emailLogoCheck,emailInlineLogoCheck,emailSendAccessCheck,emailMonitoringAccessCheck,emailDeliveryCheck,resendWebhookCheck,emailTemplateCheck,...syntheticChecks]
    .map((row)=>({...row,issueType:classifyHealthIssue(row)}));
  const failedIds=checks.filter(row=>!row.ok).map(row=>row.id).sort();
  return {
    id:'HLT-'+crypto.randomUUID().replaceAll('-','').slice(0,14).toUpperCase(),
    checkedAt:new Date().toISOString(),
    durationMs:Math.max(0,Date.now()-healthRunStarted),
    overall:failedIds.length?'unhealthy':'healthy',
    passed:checks.length-failedIds.length,
    failed:failedIds.length,
    failedIds,
    deployId,
    commit,
    checks,
    source,
  };
}

function hydrateIssueTypes(snapshot:HealthSnapshot|null):HealthSnapshot|null {
  if(!snapshot)return null;
  return {
    ...snapshot,
    checks:(Array.isArray(snapshot.checks)?snapshot.checks:[]).map((row)=>({
      ...row,
      issueType:row.issueType??classifyHealthIssue(row),
    })),
  };
}

export async function readLatestHealth(context:Context):Promise<HealthSnapshot|null> {
  const snapshot=((await healthStore(context).get('latest',{type:'json'})) || null) as HealthSnapshot|null;
  return hydrateIssueTypes(snapshot);
}

export async function readLatestHourlyHealth(context:Context):Promise<HealthSnapshot|null> {
  const rows=((await healthStore(context).get('history',{type:'json'})) || []) as HealthSnapshot[];
  const snapshot=rows.find(row=>row?.source==='hourly') || null;
  return hydrateIssueTypes(snapshot);
}

export async function readHealthHistory(context:Context,limit=100):Promise<HealthSnapshot[]> {
  const rows=((await healthStore(context).get('history',{type:'json'})) || []) as HealthSnapshot[];
  return rows.slice(0,Math.max(1,Math.min(500,limit))).map((row)=>hydrateIssueTypes(row) as HealthSnapshot);
}

export async function applyHealthAlertPolicy(context:Context,current:HealthSnapshot,previousHourly:HealthSnapshot|null) {
  const policy=await readHealthAlertPolicy(context);
  const ruleById=new Map(policy.rules.map(rule=>[rule.id,rule]));
  const previousFailed=new Set(previousHourly?.failedIds||[]);
  const previousConfirmed=new Set(previousHourly?.alertFailedIds||[]);
  current.alertFailedIds=current.failedIds.filter(id=>{
    const rule=ruleById.get(id);
    if(!rule||rule.alertAfter===1) return true;
    if(current.source==='hourly') return previousFailed.has(id);
    return previousConfirmed.has(id);
  }).sort();
  return {snapshot:current,policy};
}

export async function persistHealth(context:Context,snapshot:HealthSnapshot) {
  const store=healthStore(context);
  const history=((await store.get('history',{type:'json'})) || []) as HealthSnapshot[];
  await store.setJSON('latest',snapshot);
  await store.setJSON('history',[snapshot,...history].slice(0,500));

  if(snapshot.source==='hourly'){
    const uptimeRows=((await store.get('uptime/hourly',{type:'json'})) || []) as any[];
    const compact={
      checkedAt:snapshot.checkedAt,
      checks:(snapshot.checks||[]).map(check=>({id:check.id,name:check.name,kind:check.kind,path:check.path,ok:check.ok})),
    };
    await store.setJSON('uptime/hourly',[compact,...uptimeRows].slice(0,2300));
  }
}

export async function readUptimeHistory(context:Context,limit=2300) {
  const rows=((await healthStore(context).get('uptime/hourly',{type:'json'})) || []) as any[];
  return rows.slice(0,Math.max(1,Math.min(2300,limit)));
}

export function calculateUptime(history:any[]) {
  const hourly=(history||[]).filter(row=>Number.isFinite(Date.parse(String(row.checkedAt||''))));
  const windows=[
    {id:'24h',label:'24 hours',hours:24,expected:24},
    {id:'7d',label:'7 days',hours:24*7,expected:24*7},
    {id:'30d',label:'30 days',hours:24*30,expected:24*30},
    {id:'90d',label:'90 days',hours:24*90,expected:24*90},
  ];
  const componentMap=new Map<string,{id:string;name:string;kind:string;path:string}>();
  for(const snapshot of hourly){
    for(const check of snapshot.checks||[]){
      if(!componentMap.has(check.id)) componentMap.set(check.id,{id:check.id,name:check.name,kind:check.kind,path:check.path});
    }
  }
  const now=Date.now();
  const rows=[...componentMap.values()].map(component=>{
    const periods:Record<string,{uptime:number|null;samples:number;expected:number}>={};
    for(const window of windows){
      const cutoff=now-window.hours*60*60*1000;
      const samples=hourly.filter(snapshot=>Date.parse(snapshot.checkedAt)>=cutoff)
        .map(snapshot=>snapshot.checks?.find(check=>check.id===component.id))
        .filter(Boolean) as HealthCheck[];
      const healthy=samples.filter(check=>check.ok).length;
      periods[window.id]={
        uptime:samples.length?Math.round((healthy/samples.length)*10000)/100:null,
        samples:samples.length,
        expected:window.expected,
      };
    }
    return {...component,periods};
  }).sort((a,b)=>a.kind.localeCompare(b.kind)||a.name.localeCompare(b.name));
  return {generatedAt:new Date().toISOString(),windows,rows,hourlySamples:hourly.length};
}

export function calculateIncidents(history:any[]) {
  const hourly=(history||[])
    .filter(row=>Number.isFinite(Date.parse(String(row.checkedAt||''))))
    .sort((a,b)=>Date.parse(a.checkedAt)-Date.parse(b.checkedAt));
  const components=new Map<string,{id:string;name:string;kind:string;path:string}>();
  for(const snapshot of hourly){
    for(const check of snapshot.checks||[]){
      if(!components.has(check.id)) components.set(check.id,{id:check.id,name:check.name,kind:check.kind,path:check.path});
    }
  }
  const now=Date.now();
  const windows=[
    {id:'7d',days:7},
    {id:'30d',days:30},
    {id:'90d',days:90},
  ];
  const rows=[...components.values()].map(component=>{
    const incidents:any[]=[];
    let active:any=null;
    for(const snapshot of hourly){
      const check=(snapshot.checks||[]).find((row:any)=>row.id===component.id);
      if(!check) continue;
      const at=Date.parse(snapshot.checkedAt);
      if(!check.ok && !active){
        active={startedAt:snapshot.checkedAt,startedMs:at,endedAt:null,endedMs:null,ongoing:true};
      } else if(check.ok && active){
        active.endedAt=snapshot.checkedAt;
        active.endedMs=at;
        active.ongoing=false;
        active.durationMinutes=Math.max(0,Math.round((at-active.startedMs)/60000));
        incidents.push(active);
        active=null;
      }
    }
    if(active){
      active.durationMinutes=Math.max(0,Math.round((now-active.startedMs)/60000));
      incidents.push(active);
    }
    const totals:Record<string,{downtimeMinutes:number;incidentCount:number}>={};
    for(const window of windows){
      const cutoff=now-window.days*86400000;
      let downtime=0, count=0;
      for(const incident of incidents){
        const start=Math.max(incident.startedMs,cutoff);
        const end=Math.min(incident.endedMs||now,now);
        if(end>start){
          downtime+=end-start;
          count+=1;
        }
      }
      totals[window.id]={downtimeMinutes:Math.round(downtime/60000),incidentCount:count};
    }
    return {
      ...component,
      currentIncident:incidents.find(row=>row.ongoing)||null,
      recentIncidents:[...incidents].reverse().slice(0,20).map(({startedMs,endedMs,...row})=>row),
      totals,
    };
  }).sort((a,b)=>a.kind.localeCompare(b.kind)||a.name.localeCompare(b.name));
  const allIncidents=rows.flatMap(row=>row.recentIncidents.map(incident=>({componentId:row.id,componentName:row.name,...incident})))
    .sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt));
  return {generatedAt:new Date().toISOString(),rows,recentIncidents:allIncidents.slice(0,50)};
}

export function buildPublicStatus(
  latest:HealthSnapshot|null,
  incidents:any,
  uptime:any,
  policy:HealthAlertPolicy,
) {
  if(!policy.publicStatusEnabled){
    return {
      enabled:false,
      overall:'not-published',
      checkedAt:latest?.checkedAt||'',
      services:[],
      incidents:[],
    };
  }

  const ruleById=new Map(policy.rules.map(rule=>[rule.id,rule]));
  const latestById=new Map((latest?.checks||[]).map(check=>[check.id,check]));
  const uptimeById=new Map((uptime?.rows||[]).map((row:any)=>[row.id,row]));
  const incidentById=new Map((incidents?.rows||[]).map((row:any)=>[row.id,row]));
  const groups=new Map<string,any[]>();

  for(const rule of policy.rules){
    if(!rule.publicVisible) continue;
    const name=clean(rule.publicName,120)||'Koa’s Events service';
    const item={
      id:rule.id,
      check:latestById.get(rule.id),
      uptime:uptimeById.get(rule.id),
      incidents:incidentById.get(rule.id),
    };
    groups.set(name,[...(groups.get(name)||[]),item]);
  }

  const services=[...groups.entries()].map(([name,items])=>{
    const degraded=items.some(item=>item.check && !item.check.ok);
    const uptime90=items
      .map(item=>item.uptime?.periods?.['90d']?.uptime)
      .filter((value:any)=>typeof value==='number');
    const uptime90d=uptime90.length
      ? Math.round((Math.min(...uptime90))*100)/100
      : null;
    return {name,status:degraded?'degraded':'operational',uptime90d};
  }).sort((a,b)=>a.name.localeCompare(b.name));

  const publicIncidents:any[]=[];
  for(const [name,items] of groups){
    for(const item of items){
      for(const incident of item.incidents?.recentIncidents||[]){
        publicIncidents.push({
          service:name,
          startedAt:incident.startedAt,
          endedAt:incident.endedAt||null,
          ongoing:Boolean(incident.ongoing),
          durationMinutes:Number(incident.durationMinutes||0),
        });
      }
    }
  }

  const dedup=new Map<string,any>();
  for(const incident of publicIncidents){
    const key=[incident.service,incident.startedAt,incident.endedAt||'ongoing'].join('|');
    if(!dedup.has(key)) dedup.set(key,incident);
  }
  const recent=[...dedup.values()]
    .sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt))
    .slice(0,20);

  return {
    enabled:true,
    overall:services.some(service=>service.status==='degraded')?'degraded':'operational',
    checkedAt:latest?.checkedAt||'',
    services,
    incidents:recent,
  };
}

export function healthTransition(previous:HealthSnapshot|null,current:HealthSnapshot) {
  const prev=new Set(previous?.alertFailedIds||[]);
  const curr=new Set(current.alertFailedIds||[]);
  const broken=[...curr].filter(id=>!prev.has(id));
  const recovered=[...prev].filter(id=>!curr.has(id));
  if(!broken.length&&!recovered.length) return {changed:false,type:'none' as const,broken,recovered};
  return {
    changed:true,
    type:curr.size===0?'recovered' as const:broken.length?'broken' as const:'partial-recovery' as const,
    broken,recovered,
  };
}

function esc(value:unknown){
  return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

async function sendHealthEmail(current:HealthSnapshot,transition:any,failedNames:string[],recoveredNames:string[],brokenNames:string[]) {
  const apiKey=clean(tenantEnv(resolveTenant(),'RESEND_API_KEY'),500);
  if(!apiKey) return {channel:'email',sent:false,reason:'resend-not-configured'};

  const configured=clean(tenantEnv(resolveTenant(),'HEALTH_ALERT_EMAILS','KOA_HEALTH_ALERT_EMAILS'),500)
    || clean(tenantEnv(resolveTenant(),'LEAD_EMAIL_TO','KOA_LEAD_EMAIL_TO'),500)
    || 'chris@sibel.org';
  const recipients=configured.split(',').map(v=>v.trim()).filter(v=>v.includes('@'));
  if(!recipients.length) return {channel:'email',sent:false,reason:'no-recipient'};

  const from=clean(tenantEnv(resolveTenant(),'HEALTH_ALERT_FROM','KOA_HEALTH_ALERT_FROM'),240)
    || clean(tenantEnv(resolveTenant(),'LEAD_EMAIL_FROM','KOA_LEAD_EMAIL_FROM'),240)
    || 'Koa’s Events <leads@koasevents.com>';
  const fullyRecovered=(current.alertFailedIds||[]).length===0;
  const subject=fullyRecovered
    ? 'Koa’s System Health recovered'
    : 'Koa’s System Health alert — '+failedNames.length+' confirmed check'+(failedNames.length===1?'':'s')+' failing';
  const summary=fullyRecovered
    ? 'All monitored Koa’s admin/staff services are healthy again.'
    : 'The health monitor detected a change in system health.';
  const html='<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="IE=edge"><meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no"><title>Koa’s System Health alert</title></head><body style="margin:0;padding:0;background:#f5f0e7;font-family:Arial,Helvetica,sans-serif;color:#173d30">'
    +'<table role="presentation" lang="en" dir="ltr" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding-top:20px;padding-right:10px;padding-bottom:20px;padding-left:10px">'
    +'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:680px;background:#fff;border:1px solid #e7dfd0;border-radius:20px">'
    +emailHeader({brand:'events',eyebrow:'System Health',title:fullyRecovered?'System recovered':'Health change detected'})
    +'<tr><td style="padding-top:24px;padding-right:22px;padding-bottom:24px;padding-left:22px">'
    +emailGreeting('Team')
    +'<p style="line-height:1.6;color:#52635b">'+esc(summary)+'</p>'
    +(brokenNames.length?'<p><strong>Newly failing:</strong> '+brokenNames.map(esc).join(', ')+'</p>':'')
    +(recoveredNames.length?'<p><strong>Recovered:</strong> '+recoveredNames.map(esc).join(', ')+'</p>':'')
    +(failedNames.length?'<p><strong>Still failing:</strong> '+failedNames.map(esc).join(', ')+'</p>':'')
    +'<p style="font-size:12px;color:#66736d">Checked '+esc(current.checkedAt)+' · '+failedNames.length+' confirmed alert condition'+(failedNames.length===1?'':'s')+'</p>'
    +emailButton({href:'https://koasevents.com/admin/health/',label:'Open System Health',marginTop:20})
    +emailSignature()
    +'</td></tr></table></td></tr></table></body></html>';
  const text=[
    emailGreetingText('Team'),'',
    'Koa’s Events System Health',summary,
    brokenNames.length?'Newly failing: '+brokenNames.join(', '):'',
    recoveredNames.length?'Recovered: '+recoveredNames.join(', '):'',
    failedNames.length?'Still failing: '+failedNames.join(', '):'',
    'Checked: '+current.checkedAt,
    'System Health: https://koasevents.com/admin/health/','',
    emailSignatureText(),
  ].filter(Boolean).join('\n');
  const attachments=[emailLogoAttachment()];
  assertEmailInlineAssets(html,attachments);
  try{
    const response=await fetch('https://api.resend.com/emails',{
      method:'POST',
      headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json','Idempotency-Key':('koa-health-email-'+current.id).slice(0,256)},
      body:JSON.stringify({from,to:recipients,subject,html,text,attachments}),
      signal:AbortSignal.timeout(12_000),
    });
    const body:any=await response.json().catch(()=>({}));
    if(!response.ok) return {channel:'email',sent:false,reason:'resend-error',status:response.status,error:clean(body?.message,240)};
    return {channel:'email',sent:true,id:clean(body?.id,120)};
  }catch(error){
    return {channel:'email',sent:false,reason:'request-error',error:error instanceof Error?clean(error.message,240):'request-error'};
  }
}

async function sendHealthSlack(current:HealthSnapshot,failedNames:string[],recoveredNames:string[],brokenNames:string[]) {
  const webhook=clean(Netlify.env.get('KOA_HEALTH_SLACK_WEBHOOK_URL'),1000);
  if(!webhook) return {channel:'slack',sent:false,reason:'not-configured'};
  const recovered=(current.alertFailedIds||[]).length===0;
  const lines=[
    recovered?'✅ *Koa’s System Health recovered*':'🚨 *Koa’s System Health changed*',
    brokenNames.length?'*Newly failing:* '+brokenNames.join(', '):'',
    recoveredNames.length?'*Recovered:* '+recoveredNames.join(', '):'',
    failedNames.length?'*Still failing:* '+failedNames.join(', '):'',
    failedNames.length+' confirmed alert condition'+(failedNames.length===1?'':'s'),
    '<https://koasevents.com/admin/health/|Open System Health>',
  ].filter(Boolean);
  try{
    const response=await fetch(webhook,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({text:lines.join('\n')}),
      signal:AbortSignal.timeout(12_000),
    });
    return response.ok?{channel:'slack',sent:true}:{channel:'slack',sent:false,reason:'slack-error',status:response.status};
  }catch(error){
    return {channel:'slack',sent:false,reason:'request-error',error:error instanceof Error?clean(error.message,240):'request-error'};
  }
}

async function sendHealthSms(current:HealthSnapshot,failedNames:string[],recoveredNames:string[],brokenNames:string[]) {
  const sid=clean(Netlify.env.get('TWILIO_ACCOUNT_SID'),200);
  const token=clean(Netlify.env.get('TWILIO_AUTH_TOKEN'),300);
  const from=clean(Netlify.env.get('TWILIO_FROM_NUMBER'),80);
  const recipients=clean(Netlify.env.get('KOA_HEALTH_SMS_TO'),500).split(',').map(v=>v.trim()).filter(Boolean);
  if(!sid||!token||!from||!recipients.length) return {channel:'sms',sent:false,reason:'not-configured'};
  const recovered=(current.alertFailedIds||[]).length===0;
  const parts=[
    recovered?'Koa’s System Health recovered.':'Koa’s System Health alert.',
    brokenNames.length?'New failing: '+brokenNames.join(', ')+'.':'',
    recoveredNames.length?'Recovered: '+recoveredNames.join(', ')+'.':'',
    failedNames.length?'Still failing: '+failedNames.join(', ')+'.':'',
    'https://koasevents.com/admin/health/',
  ].filter(Boolean);
  const body=parts.join(' ').slice(0,1200);
  const auth='Basic '+btoa(sid+':'+token);
  const results:any[]=[];
  for(const to of recipients){
    try{
      const form=new URLSearchParams({From:from,To:to,Body:body});
      const response=await fetch('https://api.twilio.com/2010-04-01/Accounts/'+encodeURIComponent(sid)+'/Messages.json',{
        method:'POST',
        headers:{Authorization:auth,'Content-Type':'application/x-www-form-urlencoded'},
        body:form.toString(),
        signal:AbortSignal.timeout(12_000),
      });
      const data:any=await response.json().catch(()=>({}));
      results.push({to,sent:response.ok,status:response.status,id:clean(data?.sid,120),error:response.ok?'':clean(data?.message,240)});
    }catch(error){
      results.push({to,sent:false,status:0,error:error instanceof Error?clean(error.message,240):'request-error'});
    }
  }
  return {channel:'sms',sent:results.some(row=>row.sent),results};
}

export async function sendHealthTransitionAlerts(previous:HealthSnapshot|null,current:HealthSnapshot) {
  const transition=healthTransition(previous,current);
  if(!transition.changed) return {changed:false,transition,channels:[]};
  const confirmed=new Set(current.alertFailedIds||[]);
  const failedNames=current.checks.filter(row=>confirmed.has(row.id)).map(row=>row.name);
  const recoveredNames=(previous?.checks||[]).filter(row=>transition.recovered.includes(row.id)).map(row=>row.name);
  const brokenNames=current.checks.filter(row=>transition.broken.includes(row.id)).map(row=>row.name);
  const channels=await Promise.all([
    sendHealthEmail(current,transition,failedNames,recoveredNames,brokenNames),
    sendHealthSlack(current,failedNames,recoveredNames,brokenNames),
    sendHealthSms(current,failedNames,recoveredNames,brokenNames),
  ]);
  return {changed:true,transition,channels};
}


export async function readPostDeployVerification(context:Context) {
  return ((await healthStore(context).get('deployments/post-deploy-verification',{type:'json'})) || null) as any;
}

export type ProductionRelease = {
  deployId:string;
  commit:string;
  commitTitle:string;
  commitMessage:string;
  publishedAt:string;
  deployDurationSeconds:number|null;
  features:string[];
  changedFiles:string[];
  verification:any;
  authorName:string;
  authorLogin:string;
  pullRequestNumber:number|null;
  pullRequestUrl:string;
  summary:string;
  recordedAt:string;
};

export async function readProductionReleases(context:Context,limit=50):Promise<ProductionRelease[]> {
  const rows=((await healthStore(context).get('deployments/releases',{type:'json'})) || []) as ProductionRelease[];
  return rows.slice(0,Math.max(1,Math.min(100,limit)));
}

export function featureLabelsForFiles(files:string[]) {
  const labels=new Set<string>();
  for(const path of files){
    if(path.includes('/admin/staff')||path.includes('admin-staff')||path.includes('custom-roles')) labels.add('User Management');
    if(path.includes('identity')||path.includes('account-security')||path.includes('auth-security')||path.includes('/staff/')) labels.add('Authentication & Security');
    if(path.includes('/admin/crm')||path.includes('admin-crm')||path.includes('crm-')) labels.add('Business CRM');
    if(path.includes('/admin/quotes')||path.includes('admin-quotes')||path.includes('quotes.')) labels.add('Sales CRM & Proposals');
    if(path.includes('/admin/events')||path.includes('admin-events')||path.includes('event-')) labels.add('Event Ops');
    if(path.includes('/admin/calendar')||path.includes('admin-calendar')) labels.add('Master Calendar');
    if(path.includes('quickbooks')) labels.add('QuickBooks');
    if(path.includes('/admin/vendors')||path.includes('admin-vendors')||path.includes('vendor-marketplace')||path.includes('vendor-portal')) labels.add('Vendor CRM');
    if(path.includes('/admin/insurance')||path.includes('insurance')) labels.add('Insurance Compliance');
    if(path.includes('/admin/blog')||path.includes('blog.')) labels.add('Blog');
    if(path.includes('/admin/gallery')||path.includes('gallery.')) labels.add('Gallery');
    if(path.includes('/admin/seo')||path.includes('local-seo')) labels.add('Local SEO');
    if(path.includes('/admin/health')||path.includes('system-health')||path.includes('health-monitor')||path.includes('post-deploy')) labels.add('System Health');
    if(path.startsWith('src/pages/')&&!path.includes('/admin/')&&!path.includes('/staff/')) labels.add('Public Website');
    if(path.startsWith('.github/')||path==='netlify.toml'||path.startsWith('scripts/')) labels.add('Deployment & QA');
  }
  return [...labels];
}

function plainEnglishReleaseSummary(title:string,features:string[]) {
  const staffAreas=features.filter((feature)=>[
    'User Management','Authentication & Security','Business CRM','Sales CRM & Proposals',
    'Event Ops','Master Calendar','QuickBooks','Vendor CRM','Insurance Compliance','System Health',
    'Deployment & QA'
  ].includes(feature));
  const clientAreas=features.filter((feature)=>[
    'Public Website','Blog','Gallery','Local SEO'
  ].includes(feature));
  const parts:string[]=[];
  if(staffAreas.length) parts.push('Staff systems changed: '+staffAreas.join(', ')+'.');
  if(clientAreas.length) parts.push('Client-facing website changed: '+clientAreas.join(', ')+'.');
  if(!parts.length) parts.push('Technical release with no categorized staff/client feature area.');
  if(title) parts.push('Release focus: '+clean(title,220)+'.');
  return parts.join(' ');
}

function releaseRiskFlags(files:any[],commits:any[]) {
  const definitions=[
    {id:'authentication',label:'Authentication / access',severity:'high',path:/identity|auth-|account-security|admin-staff|custom-roles|staff-directory|admin-session/i,content:/password|session|role|permission|login|logout|token|identity|auth/i},
    {id:'payments',label:'Payments / accounting',severity:'high',path:/quickbooks|payment|invoice|billing|price|estimate|deposit/i,content:/payment|invoice|quickbooks|billing|refund|deposit|balance|amount/i},
    {id:'crm-deletion',label:'CRM deletion / cleanup',severity:'high',path:/crm|quotes|sales|security/i,content:/delete|trash|restore|cleanup|purge|remove.*record|auto.?trash|confirmed.?spam/i,requireBoth:true},
    {id:'forms',label:'Public forms / lead capture',severity:'medium',path:/inquire|contact|wedding-inquiry|thank-you|stay|crm-inquiries|forms?/i,content:/form|submit|inquiry|turnstile|honeypot|lead/i},
    {id:'security',label:'Security controls',severity:'high',path:/security|turnstile|rate.?limit|edge-functions|headers|admin\.ts/i,content:/block|security|turnstile|siteverify|rate.?limit|permission|csrf|origin/i},
    {id:'storage',label:'Database / storage',severity:'high',path:/store|storage|blobs?|database|postgres|neon|schema|migration/i,content:/getStore|getDeployStore|database|storage|blob|migration|schema/i},
    {id:'environment',label:'Environment / deployment variables',severity:'high',path:/netlify\.toml|(^|\/)\.env|env\.d|config/i,content:/Netlify\.env|process\.env|\$\{\{\s*secrets\.|environment variable|site.?id|secret key|api key/i},
  ];
  const flags:any[]=[];
  for(const definition of definitions){
    const matchingFiles=files.filter((file:any)=>{
      const filename=String(file?.filename||'');
      const patch=String(file?.patch||'');
      const pathMatch=definition.path.test(filename);
      const contentMatch=definition.content.test(patch);
      return definition.requireBoth ? (pathMatch&&contentMatch) : (pathMatch||contentMatch);
    }).map((file:any)=>file.filename);
    const matchingCommits=commits.filter((commit:any)=>definition.content.test(String(commit?.message||commit?.title||''))).map((commit:any)=>commit.title);
    if(matchingFiles.length||matchingCommits.length){
      flags.push({
        id:definition.id,
        label:definition.label,
        severity:definition.severity,
        files:[...new Set(matchingFiles)].slice(0,25),
        commits:[...new Set(matchingCommits)].slice(0,12),
      });
    }
  }
  return flags;
}

export async function compareProductionReleaseCommits(baseCommit:string,headCommit:string) {
  const base=clean(baseCommit,120);
  const head=clean(headCommit,120);
  if(!base||!head) throw new Error('Both release commits are required.');
  if(base===head) return {
    baseCommit:base,
    headCommit:head,
    status:'identical',
    aheadBy:0,
    behindBy:0,
    totalCommits:0,
    features:[],
    commits:[],
    files:[],
    behaviorChanges:[],
  };

  const githubToken=clean(Netlify.env.get('KOA_GITHUB_READ_TOKEN'),500);
  const headers:Record<string,string>={
    'Accept':'application/vnd.github+json',
    'User-Agent':'KoaEvents-Health/1.0',
    ...(githubToken?{Authorization:'Bearer '+githubToken}:{}),
  };
  const response=await fetch(
    'https://api.github.com/repos/AstroTat808/koasevents.com/compare/'+encodeURIComponent(base)+'...'+encodeURIComponent(head),
    {headers,signal:AbortSignal.timeout(15_000)},
  );
  if(!response.ok) throw new Error('GitHub release comparison failed with HTTP '+response.status+'.');
  const body:any=await response.json();
  const rawFiles=Array.isArray(body?.files)?body.files:[];
  const files=rawFiles.map((file:any)=>({
    filename:clean(file?.filename,400),
    status:clean(file?.status,40),
    additions:Number(file?.additions||0),
    deletions:Number(file?.deletions||0),
    changes:Number(file?.changes||0),
    previousFilename:clean(file?.previous_filename,400),
  })).filter((file:any)=>file.filename);
  const commits=(Array.isArray(body?.commits)?body.commits:[]).map((commit:any)=>{
    const message=clean(commit?.commit?.message,3000);
    return {
      sha:clean(commit?.sha,80),
      title:clean(message.split('\n')[0],300),
      message,
      authoredAt:clean(commit?.commit?.author?.date,80),
      committedAt:clean(commit?.commit?.committer?.date,80),
    };
  });
  const features=featureLabelsForFiles(files.map((file:any)=>file.filename));
  const behaviorChanges=commits.map((commit:any)=>commit.title).filter(Boolean);
  const riskFlags=releaseRiskFlags(rawFiles,commits);
  return {
    baseCommit:clean(body?.base_commit?.sha,80)||base,
    headCommit:clean(body?.merge_base_commit?.sha,80)===head?head:(clean(body?.commits?.at?.(-1)?.sha,80)||head),
    status:clean(body?.status,40),
    aheadBy:Number(body?.ahead_by||0),
    behindBy:Number(body?.behind_by||0),
    totalCommits:Number(body?.total_commits||commits.length),
    features,
    commits,
    files,
    behaviorChanges,
    riskFlags,
    riskLevel:riskFlags.some((flag:any)=>flag.severity==='high')?'high':riskFlags.length?'medium':'low',
  };
}

export async function recordProductionRelease(context:Context,input:any) {
  const deployId=clean(input?.deployId,120);
  const commit=clean(input?.commit,120);
  if(!deployId) return null;
  const store=healthStore(context);
  const existing=await readProductionReleases(context,100);
  const previous=existing.find(row=>row.deployId===deployId);

  const githubToken=clean(Netlify.env.get('KOA_GITHUB_READ_TOKEN'),500);
  const githubHeaders:Record<string,string>={
    'Accept':'application/vnd.github+json',
    'User-Agent':'KoaEvents-Health/1.0',
    ...(githubToken?{Authorization:'Bearer '+githubToken}:{}),
  };

  let commitTitle=previous?.commitTitle||'';
  let commitMessage=previous?.commitMessage||'';
  let changedFiles=previous?.changedFiles||[];
  let authorName=previous?.authorName||'';
  let authorLogin=previous?.authorLogin||'';
  let pullRequestNumber=previous?.pullRequestNumber??null;
  let pullRequestUrl=previous?.pullRequestUrl||'';
  let displayCommit=commit;
  let parentCommit='';
  if(commit){
    try{
      const response=await fetch('https://api.github.com/repos/AstroTat808/koasevents.com/commits/'+encodeURIComponent(commit),{
        headers:githubHeaders,signal:AbortSignal.timeout(12_000),
      });
      if(response.ok){
        const body:any=await response.json();
        commitMessage=clean(body?.commit?.message,2000);
        commitTitle=clean(commitMessage.split('\n')[0],300);
        parentCommit=clean(body?.parents?.[0]?.sha,80);
        changedFiles=Array.isArray(body?.files)
          ? body.files.map((file:any)=>clean(file?.filename,300)).filter(Boolean).slice(0,300)
          : changedFiles;
        authorName=clean(body?.commit?.author?.name,180)||authorName;
        authorLogin=clean(body?.author?.login,120)||authorLogin;

        if(/^Trigger .*production deploy/i.test(commitTitle)&&parentCommit){
          try{
            const parentResponse=await fetch('https://api.github.com/repos/AstroTat808/koasevents.com/commits/'+encodeURIComponent(parentCommit),{
              headers:githubHeaders,signal:AbortSignal.timeout(12_000),
            });
            if(parentResponse.ok){
              const parentBody:any=await parentResponse.json();
              const parentMessage=clean(parentBody?.commit?.message,2000);
              if(parentMessage){
                displayCommit=parentCommit;
                commitMessage=parentMessage;
                commitTitle=clean(parentMessage.split('\n')[0],300);
                authorName=clean(parentBody?.commit?.author?.name,180)||authorName;
                authorLogin=clean(parentBody?.author?.login,120)||authorLogin;
              }
            }
          }catch{}
        }

        const titlePr=commitTitle.match(/\(#(\d+)\)\s*$/);
        if(titlePr){
          pullRequestNumber=Number(titlePr[1]);
          pullRequestUrl='https://github.com/AstroTat808/koasevents.com/pull/'+pullRequestNumber;
        }
      }
    }catch{}
    if(!pullRequestNumber){
      try{
        const response=await fetch('https://api.github.com/repos/AstroTat808/koasevents.com/commits/'+encodeURIComponent(displayCommit||commit)+'/pulls',{
          headers:{...githubHeaders,'Accept':'application/vnd.github+json'},
          signal:AbortSignal.timeout(12_000),
        });
        if(response.ok){
          const pulls:any[]=await response.json();
          const merged=pulls.find((pull:any)=>pull?.merged_at)||pulls[0];
          if(merged){
            pullRequestNumber=Number(merged?.number||0)||null;
            pullRequestUrl=clean(merged?.html_url,500);
            authorLogin=authorLogin||clean(merged?.user?.login,120);
          }
        }
      }catch{}
    }
  }

  const previousRelease=existing
    .filter(row=>row.deployId!==deployId&&row.commit&&row.commit!==commit)
    .sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))[0];
  if(previousRelease?.commit&&commit){
    try{
      const response=await fetch(
        'https://api.github.com/repos/AstroTat808/koasevents.com/compare/'+encodeURIComponent(previousRelease.commit)+'...'+encodeURIComponent(commit),
        {headers:githubHeaders,signal:AbortSignal.timeout(15_000)},
      );
      if(response.ok){
        const body:any=await response.json();
        const releaseFiles=(Array.isArray(body?.files)?body.files:[])
          .map((file:any)=>clean(file?.filename,300))
          .filter(Boolean)
          .slice(0,500);
        if(releaseFiles.length) changedFiles=releaseFiles;
      }
    }catch{}
  }

  let publishedAt=clean(input?.publishedAt,80)||previous?.publishedAt||clean(input?.checkedAt,80);
  let deployDurationSeconds=Number.isFinite(Number(input?.deployDurationSeconds))
    ? Number(input.deployDurationSeconds)
    : previous?.deployDurationSeconds??null;
  const netlifyToken=clean(Netlify.env.get('NETLIFY_AUTH_TOKEN'),500);
  if(netlifyToken){
    try{
      const response=await fetch('https://api.netlify.com/api/v1/deploys/'+encodeURIComponent(deployId),{
        headers:{Authorization:'Bearer '+netlifyToken,'User-Agent':'KoaEvents-Health/1.0'},
        signal:AbortSignal.timeout(12_000),
      });
      if(response.ok){
        const deploy:any=await response.json();
        publishedAt=clean(deploy?.published_at||deploy?.updated_at||deploy?.created_at,80)||publishedAt;
        const seconds=Number(deploy?.deploy_time);
        if(Number.isFinite(seconds)) deployDurationSeconds=seconds;
      }
    }catch{}
  }

  const record:ProductionRelease={
    deployId,
    commit,
    commitTitle:commitTitle||('Production deploy '+deployId.slice(0,8)),
    commitMessage,
    publishedAt:publishedAt||new Date().toISOString(),
    deployDurationSeconds,
    features:featureLabelsForFiles(changedFiles),
    changedFiles,
    verification:input?.verification||previous?.verification||null,
    authorName,
    authorLogin,
    pullRequestNumber,
    pullRequestUrl,
    summary:plainEnglishReleaseSummary(commitTitle,featureLabelsForFiles(changedFiles)),
    recordedAt:new Date().toISOString(),
  };
  const next=[record,...existing.filter(row=>row.deployId!==deployId)]
    .sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))
    .slice(0,100);
  await store.setJSON('deployments/releases',next);
  return record;
}

export async function hydrateProductionReleaseMetadata(context:Context,releases:ProductionRelease[],limit=20) {
  const hydrated:ProductionRelease[]=[];
  let refreshed=0;
  for(const release of releases){
    const missing=!release.summary||!release.authorName||!release.pullRequestUrl;
    if(missing&&refreshed<Math.max(1,Math.min(25,limit))){
      try{
        const row=await recordProductionRelease(context,release);
        hydrated.push((row||release) as ProductionRelease);
        refreshed+=1;
        continue;
      }catch{}
    }
    hydrated.push(release);
  }
  return hydrated;
}

export function releaseTimelineWithIncidents(releases:ProductionRelease[],qaHistory:any[],incidents:any) {
  const sorted=[...(releases||[])].sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt));
  return sorted.map((release,index)=>{
    const newer=sorted[index-1];
    const start=Date.parse(release.publishedAt);
    const end=newer?Date.parse(newer.publishedAt):Date.now();
    const releaseIncidents=(incidents?.recentIncidents||[]).filter((incident:any)=>{
      const at=Date.parse(String(incident?.startedAt||''));
      return Number.isFinite(at)&&at>=start&&at<end;
    });
    const qa=qaHistory.find((row:any)=>
      row.commit===release.commit && row.event==='push' && row.branch==='main'
    )||null;
    return {...release,qa,incidents:releaseIncidents};
  });
}

export async function savePostDeployVerification(context:Context,record:any) {
  await healthStore(context).setJSON('deployments/post-deploy-verification',record);
  return record;
}

function normalizedDeployRootCause(value: unknown) {
  const raw=clean(value,1000).replace(/\s+/g,' ').trim();
  if(!raw) return 'Unknown deployment failure';
  if(/build script returned non-zero exit code:\s*2/i.test(raw)) return 'Build script exited with code 2';
  if(/build script returned non-zero exit code/i.test(raw)) return raw.replace(/^.*?(Build script returned non-zero exit code[^.]*).*$/i,'$1');
  if(/build command failed|command failed/i.test(raw)) return 'Build command failed';
  if(/dependency|npm|package/i.test(raw) && /fail|error/i.test(raw)) return 'Dependency / package installation failure';
  if(/timeout|timed out/i.test(raw)) return 'Build timed out';
  return raw.slice(0,220);
}

function groupConsecutiveDeployFailures(rows:any[]) {
  const sorted=[...(rows||[])].sort((a,b)=>Date.parse(String(b.createdAt||''))-Date.parse(String(a.createdAt||'')));
  const groups:any[]=[];
  let active:any=null;
  for(const row of sorted){
    if(row.state!=='error'&&row.state!=='failed'){
      active=null;
      continue;
    }
    const rootCause=normalizedDeployRootCause(row.errorMessage||row.title||'Unknown deployment failure');
    if(active&&active.rootCause===rootCause){
      active.count+=1;
      active.firstAt=row.createdAt||active.firstAt;
      active.commits.push(row.commit);
      active.deployIds.push(row.deployId);
      active.titles.push(row.title);
      continue;
    }
    active={
      rootCause,
      count:1,
      firstAt:row.createdAt||'',
      lastAt:row.createdAt||'',
      commits:[row.commit].filter(Boolean),
      deployIds:[row.deployId].filter(Boolean),
      titles:[row.title].filter(Boolean),
    };
    groups.push(active);
  }
  return groups.slice(0,12);
}

function billingCycleWindow(now=new Date()) {
  const configured=Number(Netlify.env.get('KOA_NETLIFY_BILLING_CYCLE_DAY') || 22);
  const cycleDay=Number.isFinite(configured)?Math.min(28,Math.max(1,Math.floor(configured))):22;
  const year=now.getUTCFullYear();
  const month=now.getUTCMonth();
  const thisMonthStart=new Date(Date.UTC(year,month,cycleDay,0,0,0,0));
  const start=now>=thisMonthStart
    ? thisMonthStart
    : new Date(Date.UTC(year,month-1,cycleDay,0,0,0,0));
  const end=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,cycleDay,0,0,0,0));
  return {cycleDay,start:start.toISOString(),end:end.toISOString()};
}

function positiveNumber(value:unknown,fallback:number) {
  const parsed=Number(value);
  return Number.isFinite(parsed)&&parsed>=0?parsed:fallback;
}

function netlifyCreditRates() {
  return {
    productionDeploy:positiveNumber(Netlify.env.get('KOA_NETLIFY_PRODUCTION_DEPLOY_CREDITS'),15),
    computeGbHour:positiveNumber(Netlify.env.get('KOA_NETLIFY_COMPUTE_CREDITS_PER_GB_HOUR'),10),
    bandwidthGb:positiveNumber(Netlify.env.get('KOA_NETLIFY_BANDWIDTH_CREDITS_PER_GB'),20),
    webRequests10k:positiveNumber(Netlify.env.get('KOA_NETLIFY_WEB_REQUEST_CREDITS_PER_10K'),2),
  };
}

function creditSeverity(percent:number|null) {
  if(percent==null||!Number.isFinite(percent)) return 'unknown';
  if(percent>=90) return 'red';
  if(percent>=80) return 'orange';
  if(percent>=60) return 'yellow';
  return 'green';
}

function scheduledRunsPerDay(schedules:any[]) {
  let total=0;
  for(const item of schedules||[]){
    const cron=clean(item?.cron,80);
    if(!cron) continue;
    if(cron==='@hourly'){total+=24;continue;}
    let match=cron.match(/^\*\/(\d+) \* \* \* \*$/);
    if(match){total+=1440/Math.max(1,Number(match[1]));continue;}
    match=cron.match(/^0 \*\/(\d+) \* \* \*$/);
    if(match){total+=24/Math.max(1,Number(match[1]));continue;}
    if(/^0 \d{1,2} \* \* \*$/.test(cron)){total+=1;continue;}
  }
  return Math.round(total*100)/100;
}

async function fetchNetlifyBandwidthUsage(token:string) {
  if(!token) return null;
  const teamSlug=clean(Netlify.env.get('KOA_NETLIFY_TEAM_SLUG') || 'koasadmin',120);
  try{
    const response=await fetch('https://api.netlify.com/api/v1/accounts/'+encodeURIComponent(teamSlug)+'/bandwidth',{
      headers:{Authorization:'Bearer '+token,'User-Agent':'KoaEvents-Health/1.0'},
      signal:AbortSignal.timeout(12_000),
    });
    if(!response.ok) return null;
    const body:any=await response.json();
    const used=Number(body?.used);
    if(!Number.isFinite(used)||used<0) return null;
    return {
      usedBytes:used,
      includedBytes:Number.isFinite(Number(body?.included))?Number(body.included):null,
      additionalBytes:Number.isFinite(Number(body?.additional))?Number(body.additional):null,
      periodStart:clean(body?.period_start_date,80),
      periodEnd:clean(body?.period_end_date,80),
      lastUpdatedAt:clean(body?.last_updated_at,80),
      source:'Netlify account bandwidth meter',
    };
  }catch{
    return null;
  }
}

function estimateNetlifyCredits(rows:any[], previews:any[], bandwidth:any, schedules:any[], creditSnapshots:any[]=[], saverLearning:any=null) {
  const fallbackWindow=billingCycleWindow();
  const cycleStart=bandwidth?.periodStart && Number.isFinite(Date.parse(bandwidth.periodStart))
    ? bandwidth.periodStart
    : fallbackWindow.start;
  const cycleEnd=bandwidth?.periodEnd && Number.isFinite(Date.parse(bandwidth.periodEnd))
    ? bandwidth.periodEnd
    : fallbackWindow.end;
  const startMs=Date.parse(cycleStart);
  const endMs=Date.parse(cycleEnd);
  const nowMs=Date.now();
  const rates=netlifyCreditRates();
  const monthlyAllowance=positiveNumber(Netlify.env.get('KOA_NETLIFY_MONTHLY_CREDIT_ALLOWANCE'),1000);

  const successful=(rows||[]).filter((row:any)=>{
    const published=Date.parse(String(row?.publishedAt||row?.createdAt||''));
    return row?.state==='ready' && Number.isFinite(published) && published>=startMs && published<endMs;
  });
  const deployCredits=successful.length*rates.productionDeploy;

  const bandwidthBytes=bandwidth?.usedBytes==null?null:Number(bandwidth.usedBytes);
  const bandwidthGb=bandwidthBytes==null?null:bandwidthBytes/1073741824;
  const bandwidthCredits=bandwidthGb==null?null:bandwidthGb*rates.bandwidthGb;

  const configuredRequests=Number(Netlify.env.get('KOA_NETLIFY_WEB_REQUESTS_ESTIMATE'));
  const averageBytesPerRequest=Math.max(1024,positiveNumber(Netlify.env.get('KOA_NETLIFY_AVG_BYTES_PER_REQUEST'),180*1024));
  const webRequests=Number.isFinite(configuredRequests)&&configuredRequests>=0
    ? configuredRequests
    : bandwidthBytes==null?null:Math.round(bandwidthBytes/averageBytesPerRequest);
  const webRequestCredits=webRequests==null?null:(webRequests/10000)*rates.webRequests10k;

  const configuredCompute=Number(Netlify.env.get('KOA_NETLIFY_FUNCTION_GB_HOURS_ESTIMATE'));
  const scheduleRunsDay=scheduledRunsPerDay(schedules);
  const elapsedDays=Math.max(0,(Math.min(nowMs,endMs)-startMs)/86400000);
  const scheduledInvocations=Math.max(0,Math.round(scheduleRunsDay*elapsedDays));
  const scheduledAverageMs=Math.max(1,positiveNumber(Netlify.env.get('KOA_NETLIFY_SCHEDULED_FUNCTION_AVG_MS'),1000));
  const functionRequestShare=Math.min(1,Math.max(0,positiveNumber(Netlify.env.get('KOA_NETLIFY_FUNCTION_REQUEST_SHARE'),0.05)));
  const functionAverageMs=Math.max(1,positiveNumber(Netlify.env.get('KOA_NETLIFY_FUNCTION_AVG_MS'),250));
  const memoryGb=Math.max(0.125,positiveNumber(Netlify.env.get('KOA_NETLIFY_FUNCTION_MEMORY_GB'),1));
  const estimatedOnDemandInvocations=webRequests==null?0:Math.round(webRequests*functionRequestShare);
  const estimatedRuntimeMs=scheduledInvocations*scheduledAverageMs+estimatedOnDemandInvocations*functionAverageMs;
  const computeGbHours=Number.isFinite(configuredCompute)&&configuredCompute>=0
    ? configuredCompute
    : (estimatedRuntimeMs/3600000)*memoryGb;
  const computeCredits=computeGbHours*rates.computeGbHour;

  const components=[
    {id:'deploys',label:'Production deploys',usage:successful.length,unit:'deploys',credits:deployCredits,mode:'measured'},
    {id:'compute',label:'Functions compute',usage:computeGbHours,unit:'GB-hour',credits:computeCredits,mode:Number.isFinite(configuredCompute)&&configuredCompute>=0?'configured':'estimated'},
    {id:'bandwidth',label:'Bandwidth',usage:bandwidthGb,unit:'GB',credits:bandwidthCredits,mode:bandwidthGb==null?'unavailable':'measured'},
    {id:'requests',label:'Web requests',usage:webRequests,unit:'requests',credits:webRequestCredits,mode:Number.isFinite(configuredRequests)&&configuredRequests>=0?'configured':webRequests==null?'unavailable':'estimated'},
  ];
  const knownCredits=components.reduce((sum,item)=>sum+(Number.isFinite(Number(item.credits))?Number(item.credits):0),0);
  const totalCredits=Math.round(knownCredits*100)/100;
  const percent=monthlyAllowance?Math.round((totalCredits/monthlyAllowance)*1000)/10:null;
  const remaining=monthlyAllowance?Math.max(0,Math.round((monthlyAllowance-totalCredits)*100)/100):null;

  const rawElapsedDays=Math.max(0,(Math.min(nowMs,endMs)-startMs)/86400000);
  const projectionElapsedDays=Math.max(1,rawElapsedDays);
  const cycleDays=Math.max(1,(endMs-startMs)/86400000);
  const remainingDays=Math.max(0,(endMs-Math.min(nowMs,endMs))/86400000);
  const fullCycleDailyBurnRate=totalCredits/projectionElapsedDays;

  const recentCutoff=Math.max(startMs,nowMs-7*86400000);
  const recentSuccessful=successful.filter((row:any)=>{
    const published=Date.parse(String(row?.publishedAt||row?.createdAt||''));
    return Number.isFinite(published)&&published>=recentCutoff&&published<=nowMs;
  });
  const recentWindowDays=Math.max(1,(Math.min(nowMs,endMs)-recentCutoff)/86400000);
  const snapshotRows=(creditSnapshots||[])
    .filter((row:any)=>
      String(row?.cycleStart||'')===String(cycleStart)
      && Number.isFinite(Date.parse(String(row?.at||'')))
      && Date.parse(String(row.at))>=recentCutoff
      && Date.parse(String(row.at))<=nowMs
      && Number.isFinite(Number(row?.totalEstimatedCredits))
    )
    .sort((a:any,b:any)=>Date.parse(String(a.at))-Date.parse(String(b.at)));
  snapshotRows.push({at:new Date(nowMs).toISOString(),totalEstimatedCredits:totalCredits,cycleStart});

  let recentDailyBurnRate:number;
  let recentRateSource='deploy timestamps + cycle average';
  const firstRecent=snapshotRows[0];
  const lastRecent=snapshotRows[snapshotRows.length-1];
  const snapshotSpanDays=firstRecent&&lastRecent
    ? Math.max(0,(Date.parse(String(lastRecent.at))-Date.parse(String(firstRecent.at)))/86400000)
    : 0;

  if(snapshotRows.length>=2 && snapshotSpanDays>=0.25){
    const delta=Math.max(0,Number(lastRecent.totalEstimatedCredits)-Number(firstRecent.totalEstimatedCredits));
    recentDailyBurnRate=delta/Math.max(0.25,snapshotSpanDays);
    recentRateSource='stored credit snapshots';
  }else{
    const recentDeployRate=(recentSuccessful.length*rates.productionDeploy)/recentWindowDays;
    const nonDeployRate=Math.max(0,totalCredits-deployCredits)/projectionElapsedDays;
    recentDailyBurnRate=recentDeployRate+nonDeployRate;
  }

  const recentWeight=Math.min(0.95,Math.max(0.5,positiveNumber(Netlify.env.get('KOA_NETLIFY_RECENT_BURN_WEIGHT'),0.7)));
  const baselineWeight=1-recentWeight;
  const weightedDailyBurnRate=(recentDailyBurnRate*recentWeight)+(fullCycleDailyBurnRate*baselineWeight);
  const projectedEndOfCycleCredits=Math.round((totalCredits+weightedDailyBurnRate*remainingDays)*100)/100;
  const projectedAllowancePercent=monthlyAllowance
    ? Math.round((projectedEndOfCycleCredits/monthlyAllowance)*1000)/10
    : null;
  const projectedSeverity=creditSeverity(projectedAllowancePercent);
  const projectionConfidence=snapshotSpanDays>=7?'high':snapshotSpanDays>=2?'medium':rawElapsedDays>=7?'medium':'low';

  const remainingCreditsRaw=Math.max(0,monthlyAllowance-totalCredits);
  const daysUntilExhausted=projectedEndOfCycleCredits>monthlyAllowance && weightedDailyBurnRate>0
    ? Math.max(0,remainingCreditsRaw/weightedDailyBurnRate)
    : null;
  const exhaustionAt=daysUntilExhausted==null
    ? null
    : new Date(nowMs+daysUntilExhausted*86400000).toISOString();

  const chartWindowStart=Math.max(startMs,nowMs-29*86400000);
  const actualByDay=new Map<string,any>();
  for(const row of creditSnapshots||[]){
    const atMs=Date.parse(String(row?.at||''));
    const credits=Number(row?.totalEstimatedCredits);
    if(!Number.isFinite(atMs)||!Number.isFinite(credits)||atMs<chartWindowStart||atMs>nowMs) continue;
    const day=new Date(atMs).toISOString().slice(0,10);
    const previous=actualByDay.get(day);
    if(!previous||Date.parse(String(previous.at))<atMs){
      actualByDay.set(day,{at:new Date(atMs).toISOString(),credits:Math.round(credits*100)/100});
    }
  }
  const currentDay=new Date(nowMs).toISOString().slice(0,10);
  actualByDay.set(currentDay,{at:new Date(nowMs).toISOString(),credits:totalCredits});
  const actualPoints=[...actualByDay.values()].sort((a:any,b:any)=>Date.parse(a.at)-Date.parse(b.at));

  const projectionPoints:any[]=[{at:new Date(nowMs).toISOString(),credits:totalCredits}];
  const projectionDays=Math.max(0,Math.min(30,Math.ceil(remainingDays)));
  for(let day=1;day<=projectionDays;day+=1){
    const atMs=Math.min(endMs,nowMs+day*86400000);
    const credits=Math.round((totalCredits+weightedDailyBurnRate*((atMs-nowMs)/86400000))*100)/100;
    projectionPoints.push({at:new Date(atMs).toISOString(),credits});
    if(atMs>=endMs) break;
  }

  const projectedOverAllowance=projectedEndOfCycleCredits>monthlyAllowance;
  const excessCredits=Math.max(0,projectedEndOfCycleCredits-monthlyAllowance);
  const requiredDailyReduction=projectedOverAllowance&&remainingDays>0
    ? excessCredits/remainingDays
    : 0;
  const recentDeploysPerDay=recentSuccessful.length/recentWindowDays;
  const recommendations:any[]=[];

  const scheduleRows=(schedules||[]).map((item:any)=>{
    const cron=clean(item?.cron,80);
    let runs=0;
    if(cron==='@hourly') runs=24;
    else {
      let match=cron.match(/^\*\/(\d+) \* \* \* \*$/);
      if(match) runs=1440/Math.max(1,Number(match[1]));
      else {
        match=cron.match(/^0 \*\/(\d+) \* \* \*$/);
        if(match) runs=24/Math.max(1,Number(match[1]));
        else if(/^0 \d{1,2} \* \* \*$/.test(cron)) runs=1;
      }
    }
    return {name:clean(item?.name,120),cron,runsPerDay:runs};
  }).sort((a:any,b:any)=>b.runsPerDay-a.runsPerDay);

  const saverCalibrationFactor=Math.min(2,Math.max(.25,Number(saverLearning?.calibrationFactor||1)));
  const scheduledCreditPerRun=((scheduledAverageMs/3600000)*memoryGb*rates.computeGbHour)*saverCalibrationFactor;
  const jobDefinitions=[
    {jobId:'post-deploy-verification',functionName:'post-deploy-verification',label:'Post-deploy verification',saverLabel:'Every 30 minutes',normalLabel:'Every 15 minutes',normalRuns:96,saverRuns:48,saverRisk:1,pausedRisk:6,protects:'Hourly System Health continues to monitor production.'},
    {jobId:'quickbooks-reconciliation',functionName:'quickbooks-hourly-reconciliation',label:'QuickBooks fallback reconciliation',saverLabel:'Every 8 hours',normalLabel:'Every 4 hours',normalRuns:6,saverRuns:3,saverRisk:1,pausedRisk:5,protects:'QuickBooks webhooks remain immediate.'},
    {jobId:'crm-lifecycle',functionName:'crm-lifecycle',label:'CRM lifecycle maintenance',saverLabel:'Every 12 hours',normalLabel:'Every 6 hours',normalRuns:4,saverRuns:2,saverRisk:2,pausedRisk:5,protects:'Interactive CRM, lead capture, proposals, and bookings stay available.'},
    {jobId:'office365-calendar-sync',functionName:'office365-calendar-sync',label:'Office 365 automatic sync',saverLabel:'Every 4 hours',normalLabel:'Hourly',normalRuns:24,saverRuns:6,saverRisk:2,pausedRisk:4,protects:'Manual Sync now + verify remains available.'},
    {jobId:'review-requests',functionName:'review-requests',label:'Review requests',saverLabel:'Every other day',normalLabel:'Daily',normalRuns:1,saverRuns:.5,saverRisk:1,pausedRisk:2,protects:'No client, CRM, payment, or security workflow is affected.'},
    {jobId:'vendor-insurance-reminders',functionName:'vendor-insurance-reminders',label:'Vendor insurance reminders',saverLabel:'Every other day',normalLabel:'Daily',normalRuns:1,saverRuns:.5,saverRisk:2,pausedRisk:3,protects:'Insurance records and manual compliance review remain available.'},
  ];
  const deployedScheduleNames=new Set(scheduleRows.map((row:any)=>row.name));
  const jobControls=jobDefinitions
    .filter((row:any)=>deployedScheduleNames.has(row.functionName))
    .map((row:any)=>{
      const normalRunsPerDay=row.normalRuns;
      const saverRunsPerDay=row.saverRuns;
      const saverSavingsPerDay=Math.max(0,(normalRunsPerDay-saverRunsPerDay)*scheduledCreditPerRun);
      const pausedSavingsPerDay=Math.max(0,normalRunsPerDay*scheduledCreditPerRun);
      return {
        ...row,
        modes:['normal','saver','paused'],
        normalRunsPerDay,
        saverRunsPerDay,
        saverSavingsPerDay:Math.round(saverSavingsPerDay*100000)/100000,
        pausedSavingsPerDay:Math.round(pausedSavingsPerDay*100000)/100000,
        saverSavingsThisCycle:Math.round(saverSavingsPerDay*remainingDays*100)/100,
        pausedSavingsThisCycle:Math.round(pausedSavingsPerDay*remainingDays*100)/100,
      };
    });

  const office365=scheduleRows.find((item:any)=>item.name==='office365-calendar-sync');
  if(office365){
    const savingsPerDay=24*scheduledCreditPerRun;
    recommendations.push({
      id:'office365-calendar-sync',
      priority:5,
      title:'Temporarily pause automatic Office 365 calendar sync',
      detail:'Stops only the hourly automatic sync until the billing cycle resets. Staff can still use Sync now + verify from the Master Calendar whenever they need an immediate sync.',
      impact:'Avoids up to 24 scheduled sync invocations/day while paused (~'+Math.round(savingsPerDay*1000)/1000+' estimated compute credits/day under current runtime assumptions).',
      estimatedSavingsPerDay:Math.round(savingsPerDay*1000)/1000,
      estimatedSavingsThisCycle:Math.round(savingsPerDay*remainingDays*100)/100,
      safeActionId:'office365-calendar-sync-pause',
      proactive:true,
      protects:'Manual Office 365 Sync now + verify remains available; no CRM, QuickBooks, Turnstile, Resend, or health-monitor behavior is disabled.',
    });
  }

  if(!projectedOverAllowance){
    const verifier=scheduleRows.find((item:any)=>item.name==='post-deploy-verification');
    if(verifier&&verifier.runsPerDay>48){
      const savedRunsPerDay=verifier.runsPerDay/2;
      const savingsPerDay=savedRunsPerDay*scheduledCreditPerRun;
      recommendations.push({
        id:'post-deploy-verification',
        priority:6,
        title:'Optional: reduce post-deploy verification to every 30 minutes',
        detail:'Use this during development-heavy periods to cut verification work in half. New releases are still verified automatically.',
        impact:'About '+Math.round(savedRunsPerDay)+' fewer scheduled invocations/day.',
        estimatedSavingsPerDay:Math.round(savingsPerDay*1000)/1000,
        estimatedSavingsThisCycle:Math.round(savingsPerDay*remainingDays*100)/100,
        safeActionId:'post-deploy-verification-half',
        proactive:true,
        protects:'Hourly System Health remains active.',
      });
    }
    if(scheduleRows.some((item:any)=>item.name==='quickbooks-hourly-reconciliation')){
      const savingsPerDay=3*scheduledCreditPerRun;
      recommendations.push({
        id:'quickbooks-reconciliation',
        priority:7,
        title:'Optional: reduce QuickBooks fallback reconciliation to every 8 hours',
        detail:'QuickBooks webhooks remain immediate; only the scheduled safety-net reconciliation is slowed.',
        impact:'About 3 fewer reconciliation runs/day.',
        estimatedSavingsPerDay:Math.round(savingsPerDay*1000)/1000,
        estimatedSavingsThisCycle:Math.round(savingsPerDay*remainingDays*100)/100,
        safeActionId:'quickbooks-reconciliation-half',
        proactive:true,
        protects:'Payment and invoice webhooks remain immediate.',
      });
    }
    if(scheduleRows.some((item:any)=>item.name==='crm-lifecycle')){
      const savingsPerDay=2*scheduledCreditPerRun;
      recommendations.push({
        id:'crm-lifecycle',
        priority:8,
        title:'Optional: reduce CRM lifecycle sweep to every 12 hours',
        detail:'Interactive CRM operations remain unchanged; only the maintenance sweep is slowed.',
        impact:'About 2 fewer lifecycle sweeps/day.',
        estimatedSavingsPerDay:Math.round(savingsPerDay*1000)/1000,
        estimatedSavingsThisCycle:Math.round(savingsPerDay*remainingDays*100)/100,
        safeActionId:'crm-lifecycle-half',
        proactive:true,
        protects:'Lead capture, proposals, bookings, and manual CRM work remain available.',
      });
    }
  }

  if(projectedOverAllowance){
    const deploySavingsPerDay=Math.max(0,(recentDeploysPerDay-1)*rates.productionDeploy);
    recommendations.push({
      id:'production-deploys',
      priority:1,
      title:'Pause nonessential production deploys and batch releases',
      detail:'Keep development in Deploy Previews and consolidate approved changes into at most one production release per day until the forecast returns below the allowance.',
      impact:deploySavingsPerDay>0
        ? 'At the recent release pace, limiting production to one release/day could avoid about '+Math.round(deploySavingsPerDay*100)/100+' credits/day.'
        : 'Every avoided production release saves '+rates.productionDeploy+' credits.',
      estimatedSavingsPerDay:Math.round(deploySavingsPerDay*100)/100,
      estimatedSavingsThisCycle:Math.round(deploySavingsPerDay*remainingDays*100)/100,
      protects:'Deploy Previews, CRM, QuickBooks webhooks, Turnstile, Resend, and System Health remain available.',
    });

    const verifier=scheduleRows.find((item:any)=>item.name==='post-deploy-verification');
    if(verifier&&verifier.runsPerDay>48){
      const savedRunsPerDay=verifier.runsPerDay/2;
      const computeSavingsPerDay=savedRunsPerDay*scheduledCreditPerRun;
      const verifierCycleSavings=computeSavingsPerDay*remainingDays;
      recommendations.push({
        id:'post-deploy-verification',
        priority:2,
        title:'Temporarily reduce post-deploy verification to every 30 minutes',
        detail:'The verifier is the highest-frequency scheduled job. During a credit-risk period, moving it from every 15 minutes to every 30 minutes cuts its scheduled invocations in half without disabling verification.',
        impact:'About '+Math.round(savedRunsPerDay)+' fewer scheduled invocations/day'+(computeSavingsPerDay>0?' (~'+Math.round(computeSavingsPerDay*1000)/1000+' estimated compute credits/day).':'.'),
        estimatedSavingsPerDay:Math.round(computeSavingsPerDay*1000)/1000,
        estimatedSavingsThisCycle:Math.round(verifierCycleSavings*100)/100,
        safeActionId:'post-deploy-verification-half',
        protects:'Keep hourly System Health, lead-response reminders, QuickBooks webhooks, and the four-hour reconciliation fallback unchanged.',
      });
    }

    const qbRuns=(schedules||[]).find((item:any)=>clean(item?.name,120)==='quickbooks-hourly-reconciliation');
    if(qbRuns){
      const savedRunsPerDay=3;
      const savingsPerDay=savedRunsPerDay*scheduledCreditPerRun;
      recommendations.push({
        id:'quickbooks-reconciliation',
        priority:3,
        title:'Temporarily run the QuickBooks reconciliation fallback every 8 hours',
        detail:'QuickBooks webhooks remain immediate. This only halves the scheduled fallback reconciliation from every 4 hours to every 8 hours until the billing cycle resets.',
        impact:'About 3 fewer reconciliation runs/day (~'+Math.round(savingsPerDay*1000)/1000+' estimated compute credits/day).',
        estimatedSavingsPerDay:Math.round(savingsPerDay*1000)/1000,
        estimatedSavingsThisCycle:Math.round(savingsPerDay*remainingDays*100)/100,
        safeActionId:'quickbooks-reconciliation-half',
        protects:'QuickBooks payment/invoice webhooks remain unchanged and immediate.',
      });
    }

    const lifecycleRuns=(schedules||[]).find((item:any)=>clean(item?.name,120)==='crm-lifecycle');
    if(lifecycleRuns){
      const savedRunsPerDay=2;
      const savingsPerDay=savedRunsPerDay*scheduledCreditPerRun;
      recommendations.push({
        id:'crm-lifecycle',
        priority:4,
        title:'Temporarily run the full CRM lifecycle sweep every 12 hours',
        detail:'This halves the background CRM maintenance sweep from every 6 hours to every 12 hours. Interactive CRM operations remain available.',
        impact:'About 2 fewer lifecycle sweeps/day (~'+Math.round(savingsPerDay*1000)/1000+' estimated compute credits/day).',
        estimatedSavingsPerDay:Math.round(savingsPerDay*1000)/1000,
        estimatedSavingsThisCycle:Math.round(savingsPerDay*remainingDays*100)/100,
        safeActionId:'crm-lifecycle-half',
        protects:'CRM pages, lead capture, proposals, bookings, and manual operations remain available.',
      });
    }

    const componentById=new Map(components.map((item:any)=>[item.id,item]));
    const bandwidthComponent:any=componentById.get('bandwidth');
    const requestComponent:any=componentById.get('requests');
    const computeComponent:any=componentById.get('compute');
    if(Number(bandwidthComponent?.credits||0)>=Math.max(5,totalCredits*0.2)){
      recommendations.push({
        id:'bandwidth',
        priority:3,
        title:'Reduce high-bandwidth page loads before lowering business automation',
        detail:'Keep the responsive Image CDN path enabled, lazy-load gallery/blog media, and investigate the highest-transfer public paths before changing CRM or payment workflows.',
        impact:'Bandwidth is currently a material share of estimated credit use.',
        protects:'No effect on CRM, QuickBooks, Turnstile, Resend, or client data.',
      });
    }else if(Number(computeComponent?.credits||0)>=Math.max(5,totalCredits*0.2)){
      recommendations.push({
        id:'compute',
        priority:3,
        title:'Review nonessential scheduled compute before core integrations',
        detail:'Start with high-frequency verification/maintenance jobs. Do not disable QuickBooks webhooks, Turnstile validation, Resend webhooks, or the core hourly health monitor.',
        impact:'Functions compute is currently a material share of estimated credit use.',
        protects:'Payment, security, email, and core health event processing stay intact.',
      });
    }else if(Number(requestComponent?.credits||0)>=Math.max(5,totalCredits*0.2)){
      recommendations.push({
        id:'requests',
        priority:3,
        title:'Reduce repeat requests with caching and on-demand refresh',
        detail:'Prefer cached dashboard data and user-triggered refreshes over background polling. Keep webhook endpoints event-driven.',
        impact:'Web requests are currently a material share of estimated credit use.',
        protects:'Webhook-based CRM, QuickBooks, Resend, and security events remain immediate.',
      });
    }

    recommendations.push({
      id:'reduction-target',
      priority:4,
      title:'Hit the daily reduction target',
      detail:'The current forecast needs roughly '+Math.round(requiredDailyReduction*100)/100+' fewer credits/day for the remainder of this billing cycle to finish at or below the '+monthlyAllowance+'-credit allowance.',
      impact:'Projected overage: '+Math.round(excessCredits*100)/100+' credits if the weighted burn rate continues.',
      protects:'Use this as the target when deciding which optional releases or jobs to defer.',
    });
  }

  const previewFirstEnabledAt=clean(
    Netlify.env.get('KOA_NETLIFY_PREVIEW_FIRST_ENABLED_AT') || '2026-09-22T11:20:44Z',
    80,
  );
  const previewFirstEnabledMs=Date.parse(previewFirstEnabledAt);
  const successfulPreviews=(previews||[]).filter((row:any)=>{
    const published=Date.parse(String(row?.publishedAt||row?.createdAt||''));
    return row?.state==='ready'
      && Number.isFinite(published)
      && Number.isFinite(previewFirstEnabledMs)
      && published>=previewFirstEnabledMs;
  });
  const estimatedCreditsSaved=Math.round(successfulPreviews.length*rates.productionDeploy*100)/100;

  const severityRank:Record<string,number>={unknown:0,green:1,yellow:2,orange:3,red:4};
  const actualSeverity=creditSeverity(percent);
  const warningSeverity=(severityRank[projectedSeverity]||0)>(severityRank[actualSeverity]||0)
    ? projectedSeverity
    : actualSeverity;

  return {
    version:9,
    basis:'Measured deploys + measured bandwidth + modeled compute and request usage',
    cycleStart,
    cycleEnd,
    productionDeploys:successful.length,
    monthlyAllowance,
    totalEstimatedCredits:totalCredits,
    estimatedAllowancePercent:percent,
    estimatedRemainingCredits:remaining,
    severity:actualSeverity,
    warningSeverity,
    chart:{
      windowDays:30,
      windowStart:new Date(chartWindowStart).toISOString(),
      windowEnd:new Date(Math.min(endMs,nowMs+30*86400000)).toISOString(),
      allowance:monthlyAllowance,
      actual:actualPoints,
      projected:projectionPoints,
      note:'Actual line uses stored estimated-credit snapshots; projected line uses the current recent-weighted daily burn rate.',
    },
    recommendations,
    jobControls,
    reductionTarget:{
      requiredDailyReduction:Math.round(requiredDailyReduction*100)/100,
      excessCredits:Math.round(excessCredits*100)/100,
    },
    projection:{
      dailyBurnRate:Math.round(weightedDailyBurnRate*100)/100,
      weightedDailyBurnRate:Math.round(weightedDailyBurnRate*100)/100,
      recent7DayBurnRate:Math.round(recentDailyBurnRate*100)/100,
      fullCycleDailyBurnRate:Math.round(fullCycleDailyBurnRate*100)/100,
      recentWeight:Math.round(recentWeight*1000)/10,
      baselineWeight:Math.round(baselineWeight*1000)/10,
      recentRateSource,
      snapshotSpanDays:Math.round(snapshotSpanDays*100)/100,
      cycleDays:Math.round(cycleDays*100)/100,
      elapsedDays:Math.round(rawElapsedDays*100)/100,
      remainingDays:Math.round(remainingDays*100)/100,
      projectedEndOfCycleCredits,
      projectedAllowancePercent,
      severity:projectedSeverity,
      confidence:projectionConfidence,
      daysUntilExhausted:daysUntilExhausted==null?null:Math.round(daysUntilExhausted*10)/10,
      exhaustionAt,
    },
    savings:{
      enabledAt:previewFirstEnabledAt,
      successfulDeployPreviews:successfulPreviews.length,
      estimatedCreditsSaved,
      methodology:'Successful Deploy Previews since preview-first enforcement × current production-deploy credit rate.',
    },
    rates,
    components:components.map(item=>({
      ...item,
      usage:item.usage==null?null:Math.round(Number(item.usage)*1000)/1000,
      credits:item.credits==null?null:Math.round(Number(item.credits)*100)/100,
    })),
    assumptions:{
      averageBytesPerRequest:Math.round(averageBytesPerRequest),
      functionRequestShare:Math.round(functionRequestShare*1000)/10,
      functionAverageMs:Math.round(functionAverageMs),
      scheduledFunctionAverageMs:Math.round(scheduledAverageMs),
      saverCalibrationFactor:Math.round(saverCalibrationFactor*1000)/1000,
      saverCalibrationMeasurements:Number(saverLearning?.validMeasurementCount||0),
      functionMemoryGb:Math.round(memoryGb*1000)/1000,
      scheduledRunsPerDay:scheduleRunsDay,
      scheduledInvocations,
      bandwidthLastUpdatedAt:bandwidth?.lastUpdatedAt||'',
    },
    thresholds:{yellow:60,orange:80,red:90},
    note:'Deploys and bandwidth use Netlify data. Compute and web requests are estimates unless configured overrides are supplied; compare against Netlify Usage & billing for the invoice-grade total.',
  };
}


function creditSaverModeSavings(control:any,mode:string){
  if(mode==='paused')return Number(control?.pausedSavingsPerDay||0);
  if(mode==='saver')return Number(control?.saverSavingsPerDay||0);
  return 0;
}

function optimizeCreditSaverPlan(creditUsage:any,policy:any){
  const controls=Array.isArray(creditUsage?.jobControls)?creditUsage.jobControls:[];
  const currentModes=policy?.modes&&typeof policy.modes==='object'?policy.modes:{};
  const remainingDays=Math.max(0,Number(creditUsage?.projection?.remainingDays||0));
  const allowance=Math.max(0,Number(creditUsage?.monthlyAllowance||0));
  const rawProjected=Math.max(0,Number(creditUsage?.projection?.projectedEndOfCycleCredits||0));
  const currentSavingsPerDay=controls.reduce((sum:number,row:any)=>sum+creditSaverModeSavings(row,currentModes[row.jobId]||'normal'),0);
  const currentCycleSavings=currentSavingsPerDay*remainingDays;
  const projectedWithCurrent=Math.max(Number(creditUsage?.totalEstimatedCredits||0),rawProjected-currentCycleSavings);
  const neededCycleSavings=Math.max(0,projectedWithCurrent-allowance);
  const modes=['normal','saver','paused'];
  let best:any=null;
  let bestFallback:any=null;
  const total=Math.pow(3,controls.length);

  for(let mask=0;mask<total;mask+=1){
    let value=mask;
    const changes:any[]=[];
    let additionalPerDay=0;
    let disruption=0;
    let valid=true;
    for(const row of controls){
      const current=String(currentModes[row.jobId]||'normal');
      const currentRank=modes.indexOf(current);
      const next=modes[value%3]||'normal';
      value=Math.floor(value/3);
      const nextRank=modes.indexOf(next);
      if(nextRank<currentRank){valid=false;break;}
      const currentSaving=creditSaverModeSavings(row,current);
      const nextSaving=creditSaverModeSavings(row,next);
      additionalPerDay+=Math.max(0,nextSaving-currentSaving);
      if(next!==current){
        disruption+=next==='paused'?Number(row.pausedRisk||5):Number(row.saverRisk||1);
        changes.push({
          jobId:row.jobId,
          label:row.label,
          fromMode:current,
          toMode:next,
          estimatedSavingsPerDay:Math.round(Math.max(0,nextSaving-currentSaving)*100000)/100000,
          estimatedSavingsThisCycle:Math.round(Math.max(0,nextSaving-currentSaving)*remainingDays*100)/100,
        });
      }
    }
    if(!valid)continue;
    const cycleSavings=additionalPerDay*remainingDays;
    const candidate={
      changes,
      additionalSavingsPerDay:additionalPerDay,
      additionalSavingsThisCycle:cycleSavings,
      disruption,
      projectedAfter:Math.max(Number(creditUsage?.totalEstimatedCredits||0),projectedWithCurrent-cycleSavings),
    };
    const meets=cycleSavings+1e-9>=neededCycleSavings;
    if(meets){
      if(!best
        || candidate.disruption<best.disruption
        || (candidate.disruption===best.disruption&&candidate.changes.length<best.changes.length)
        || (candidate.disruption===best.disruption&&candidate.changes.length===best.changes.length&&candidate.additionalSavingsThisCycle<best.additionalSavingsThisCycle)
      )best=candidate;
    }
    if(!bestFallback
      || candidate.additionalSavingsThisCycle>bestFallback.additionalSavingsThisCycle
      || (candidate.additionalSavingsThisCycle===bestFallback.additionalSavingsThisCycle&&candidate.disruption<bestFallback.disruption)
    )bestFallback=candidate;
  }

  const selected=best||bestFallback||{changes:[],additionalSavingsPerDay:0,additionalSavingsThisCycle:0,projectedAfter:projectedWithCurrent,disruption:0};
  return {
    status:neededCycleSavings<=0?'within_allowance':best?'recommended':'insufficient',
    currentProjectedEndOfCycle:Math.round(projectedWithCurrent*100)/100,
    currentEstimatedSavingsPerDay:Math.round(currentSavingsPerDay*100000)/100000,
    currentEstimatedSavingsThisCycle:Math.round(currentCycleSavings*100)/100,
    neededAdditionalSavingsThisCycle:Math.round(neededCycleSavings*100)/100,
    neededAdditionalSavingsPerDay:remainingDays?Math.round((neededCycleSavings/remainingDays)*100000)/100000:0,
    recommendedChanges:selected.changes,
    estimatedAdditionalSavingsPerDay:Math.round(selected.additionalSavingsPerDay*100000)/100000,
    estimatedAdditionalSavingsThisCycle:Math.round(selected.additionalSavingsThisCycle*100)/100,
    projectedAfterPlan:Math.round(selected.projectedAfter*100)/100,
    estimatedShortfallAfterPlan:Math.round(Math.max(0,selected.projectedAfter-allowance)*100)/100,
    canApply:Boolean(selected.changes.length),
  };
}


type CreditSaverMeasurementInput={
  source:string;
  label:string;
  modes:Record<string,string>;
  baselineCredits:number;
  baselineDailyBurnRate:number;
  predictedSavingsPerDay:number;
  predictedByJob?:Array<{
    jobId:string;
    label:string;
    fromMode:string;
    toMode:string;
    predictedSavingsPerDay:number;
  }>;
  productionDeployCount:number;
  cycleStart:string;
};

function normalizedSaverLearning(value:any){
  return {
    calibrationFactor:Math.min(2,Math.max(.25,Number(value?.calibrationFactor||1))),
    validMeasurementCount:Math.max(0,Number(value?.validMeasurementCount||0)),
    updatedAt:clean(value?.updatedAt,80),
    active:value?.active&&typeof value.active==='object'?value.active:null,
    history:Array.isArray(value?.history)?value.history.slice(0,30):[],
  };
}

async function readCreditSaverLearning(context:Context){
  const saved:any=await healthStore(context).get('credits/saver-learning',{type:'json'});
  return normalizedSaverLearning(saved||{});
}

async function writeCreditSaverLearning(context:Context,value:any){
  const normalized=normalizedSaverLearning(value);
  await healthStore(context).setJSON('credits/saver-learning',normalized);
  return normalized;
}

export async function beginCreditSaverMeasurement(context:Context,input:CreditSaverMeasurementInput){
  const learning=await readCreditSaverLearning(context);
  const now=new Date().toISOString();
  const history=[...learning.history];
  if(learning.active){
    history.unshift({
      ...learning.active,
      status:'superseded',
      endedAt:now,
      invalidReason:'Saver settings changed before the measurement window completed.',
    });
  }
  const predicted=Math.max(0,Number(input.predictedSavingsPerDay||0));
  const active=predicted>0?{
    id:'CSM-'+crypto.randomUUID().replaceAll('-','').slice(0,12).toUpperCase(),
    source:clean(input.source,80)||'manual',
    label:clean(input.label,160)||'Credit saver plan',
    startedAt:now,
    cycleStart:clean(input.cycleStart,80),
    modes:input.modes||{},
    baselineCredits:Math.max(0,Number(input.baselineCredits||0)),
    baselineDailyBurnRate:Math.max(0,Number(input.baselineDailyBurnRate||0)),
    predictedSavingsPerDay:predicted,
    predictedByJob:Array.isArray(input.predictedByJob)
      ? input.predictedByJob
          .filter(row=>Number(row?.predictedSavingsPerDay)>0)
          .map(row=>({
            jobId:clean(row.jobId,100),
            label:clean(row.label,160),
            fromMode:clean(row.fromMode,30),
            toMode:clean(row.toMode,30),
            predictedSavingsPerDay:Math.max(0,Number(row.predictedSavingsPerDay||0)),
          }))
      : [],
    productionDeployCountAtStart:Math.max(0,Number(input.productionDeployCount||0)),
    minimumObservationHours:12,
    targetObservationHours:24,
    status:'measuring',
  }:null;
  return writeCreditSaverLearning(context,{
    ...learning,
    active,
    history:history.slice(0,30),
    updatedAt:now,
  });
}

async function updateCreditSaverLearning(context:Context,creditUsage:any,deployHistory:any[]){
  const learning=await readCreditSaverLearning(context);
  const active:any=learning.active;
  if(!active)return {
    ...learning,
    liveMeasurement:null,
  };

  const startedMs=Date.parse(String(active.startedAt||''));
  if(!Number.isFinite(startedMs)){
    return writeCreditSaverLearning(context,{...learning,active:null,updatedAt:new Date().toISOString()});
  }
  const nowMs=Date.now();
  const elapsedHours=Math.max(0,(nowMs-startedMs)/3600000);
  const productionDeploysSince=(deployHistory||[]).filter((row:any)=>{
    const published=Date.parse(String(row?.publishedAt||row?.createdAt||''));
    return row?.state==='ready'&&Number.isFinite(published)&&published>startedMs;
  });
  const baselineCredits=Math.max(0,Number(active.baselineCredits||0));
  const currentCredits=Math.max(0,Number(creditUsage?.totalEstimatedCredits||0));
  const observedCredits=Math.max(0,currentCredits-baselineCredits);
  const elapsedDays=Math.max(1/24,elapsedHours/24);
  const observedDailyBurnRate=observedCredits/elapsedDays;
  const baselineDailyBurnRate=Math.max(0,Number(active.baselineDailyBurnRate||0));
  const realizedSavingsPerDay=Math.max(0,baselineDailyBurnRate-observedDailyBurnRate);
  const predictedSavingsPerDay=Math.max(0,Number(active.predictedSavingsPerDay||0));
  const accuracyRatio=predictedSavingsPerDay>0?realizedSavingsPerDay/predictedSavingsPerDay:null;
  const attributionRows=Array.isArray(active.predictedByJob)?active.predictedByJob:[];
  const attributionPredictedTotal=attributionRows.reduce((sum:number,row:any)=>sum+Math.max(0,Number(row?.predictedSavingsPerDay||0)),0);
  const savingsAttribution=attributionRows.map((row:any)=>{
    const predictedPerDay=Math.max(0,Number(row?.predictedSavingsPerDay||0));
    const share=attributionPredictedTotal>0?predictedPerDay/attributionPredictedTotal:0;
    const realizedPerDay=realizedSavingsPerDay*share;
    return {
      jobId:clean(row?.jobId,100),
      label:clean(row?.label,160),
      fromMode:clean(row?.fromMode,30),
      toMode:clean(row?.toMode,30),
      predictedSavingsPerDay:Math.round(predictedPerDay*1000)/1000,
      predictedCreditsDuringWindow:Math.round(predictedPerDay*elapsedDays*1000)/1000,
      realizedSavingsPerDay:Math.round(realizedPerDay*1000)/1000,
      realizedCreditsDuringWindow:Math.round(realizedPerDay*elapsedDays*1000)/1000,
      attributionSharePercent:Math.round(share*1000)/10,
    };
  });
  const liveMeasurement={
    ...active,
    elapsedHours:Math.round(elapsedHours*10)/10,
    observedCredits:Math.round(observedCredits*100)/100,
    observedDailyBurnRate:Math.round(observedDailyBurnRate*100)/100,
    realizedSavingsPerDay:Math.round(realizedSavingsPerDay*1000)/1000,
    realizedCreditsDuringWindow:Math.round(realizedSavingsPerDay*elapsedDays*1000)/1000,
    predictedSavingsPerDay:Math.round(predictedSavingsPerDay*1000)/1000,
    accuracyPercent:accuracyRatio==null?null:Math.round(accuracyRatio*1000)/10,
    productionDeploysSinceStart:productionDeploysSince.length,
    cleanWindow:productionDeploysSince.length===0,
    savingsAttribution,
    attributionMethod:'Observed aggregate burn reduction apportioned across changed jobs by each job’s predicted share of scheduled-job savings.',
  };

  if(productionDeploysSince.length){
    const history=[{
      ...liveMeasurement,
      status:'invalid',
      endedAt:new Date().toISOString(),
      invalidReason:'A production deploy occurred during the measurement window, so deploy credits would distort scheduled-job savings.',
    },...learning.history].slice(0,30);
    const next=await writeCreditSaverLearning(context,{...learning,active:null,history,updatedAt:new Date().toISOString()});
    return {...next,liveMeasurement:history[0]};
  }

  if(elapsedHours<24){
    return {...learning,liveMeasurement};
  }

  const boundedRatio=accuracyRatio==null?1:Math.min(2,Math.max(.25,accuracyRatio));
  const completed={
    ...liveMeasurement,
    status:'completed',
    endedAt:new Date().toISOString(),
    calibrationRatio:Math.round(boundedRatio*1000)/1000,
  };
  const history=[completed,...learning.history].slice(0,30);
  const valid=history.filter((row:any)=>row?.status==='completed'&&Number.isFinite(Number(row?.calibrationRatio))).slice(0,8);
  const weighted=valid.reduce((acc:any,row:any,index:number)=>{
    const weight=Math.max(1,8-index);
    acc.sum+=Number(row.calibrationRatio)*weight;
    acc.weight+=weight;
    return acc;
  },{sum:0,weight:0});
  const calibrationFactor=weighted.weight?Math.min(2,Math.max(.25,weighted.sum/weighted.weight)):1;
  const next=await writeCreditSaverLearning(context,{
    ...learning,
    active:null,
    history,
    calibrationFactor,
    validMeasurementCount:valid.length,
    updatedAt:new Date().toISOString(),
  });
  return {...next,liveMeasurement:completed};
}


function creditSaverPredictedByJob(creditUsage:any,currentModes:any,targetModes:any){
  const controls=Array.isArray(creditUsage?.jobControls)?creditUsage.jobControls:[];
  return controls.map((control:any)=>{
    const fromMode=String(currentModes?.[control.jobId]||'normal');
    const toMode=String(targetModes?.[control.jobId]||fromMode);
    const savingsFor=(mode:string)=>mode==='paused'
      ? Number(control?.pausedSavingsPerDay||0)
      : mode==='saver'
        ? Number(control?.saverSavingsPerDay||0)
        : 0;
    return {
      jobId:String(control?.jobId||''),
      label:String(control?.label||control?.jobId||'Scheduled job'),
      fromMode,
      toMode,
      predictedSavingsPerDay:Math.max(0,savingsFor(toMode)-savingsFor(fromMode)),
    };
  }).filter((row:any)=>row.jobId&&row.predictedSavingsPerDay>0);
}

async function evaluateCreditSaverAutomation(context:Context,creditUsage:any,currentPolicy:any){
  const health=healthStore(context);
  const threshold=80;
  const maximumSuggestionThreshold=90;
  const projectedPercent=Number(creditUsage?.projection?.projectedAllowancePercent);
  const cycleStart=String(creditUsage?.cycleStart||'');
  const now=new Date().toISOString();
  const saved:any=(await health.get('credits/automation-state',{type:'json'}))||{};
  const sameCycle=cycleStart&&String(saved?.cycleStart||'')===cycleStart;
  const wasAbove=Boolean(sameCycle&&saved?.aboveBalancedThreshold);
  const isAbove=Number.isFinite(projectedPercent)&&projectedPercent>=threshold;
  const crossedUp=isAbove&&!wasAbove;
  const modes=currentPolicy?.modes||{};
  const allNormal=Object.values(modes).every(mode=>mode==='normal');
  let policy=currentPolicy;
  let autoApplied=false;
  let autoAppliedAt='';
  let skippedReason='';

  if(context.deploy.context==='production'&&crossedUp&&allNormal){
    const balanced=creditSaverPreset('balanced-savings');
    if(balanced){
      const predictedByJob=creditSaverPredictedByJob(creditUsage,modes,balanced.modes);
      const predictedSavingsPerDay=predictedByJob.reduce((sum:number,row:any)=>sum+Number(row.predictedSavingsPerDay||0),0);
      policy=await setCreditSaverModes(context,balanced.modes,'system-health:auto-80');
      await beginCreditSaverMeasurement(context,{
        source:'automatic-threshold',
        label:'Automatic Balanced Savings at 80% projected usage',
        modes:policy.modes,
        baselineCredits:Number(creditUsage?.totalEstimatedCredits||0),
        baselineDailyBurnRate:Number(creditUsage?.projection?.weightedDailyBurnRate||0),
        predictedSavingsPerDay,
        predictedByJob,
        productionDeployCount:Number(creditUsage?.productionDeploys||0),
        cycleStart,
      });
      autoApplied=true;
      autoAppliedAt=now;
    }
  }else if(crossedUp&&!allNormal){
    skippedReason='Projected usage crossed 80%, but at least one safe scheduled job was already outside Normal mode, so Balanced Savings was not forced over the existing manual policy.';
  }

  const controls=Array.isArray(creditUsage?.jobControls)?creditUsage.jobControls:[];
  const currentSavingsPerDay=controls.reduce((sum:number,control:any)=>{
    const mode=String(policy?.modes?.[control.jobId]||'normal');
    return sum+creditSaverModeSavings(control,mode);
  },0);
  const remainingDays=Math.max(0,Number(creditUsage?.projection?.remainingDays||0));
  const rawProjected=Math.max(0,Number(creditUsage?.projection?.projectedEndOfCycleCredits||0));
  const adjustedProjected=Math.max(Number(creditUsage?.totalEstimatedCredits||0),rawProjected-currentSavingsPerDay*remainingDays);
  const allowance=Math.max(0,Number(creditUsage?.monthlyAllowance||0));
  const adjustedPercent=allowance?adjustedProjected/allowance*100:null;
  const maximumSuggested=adjustedPercent!=null&&adjustedPercent>=maximumSuggestionThreshold;

  const state={
    cycleStart,
    lastProjectedPercent:Number.isFinite(projectedPercent)?Math.round(projectedPercent*10)/10:null,
    aboveBalancedThreshold:isAbove,
    lastEvaluatedAt:now,
    lastBalancedAt:autoApplied?autoAppliedAt:(sameCycle?clean(saved?.lastBalancedAt,80):''),
    lastBalancedProjectedPercent:autoApplied&&Number.isFinite(projectedPercent)
      ? Math.round(projectedPercent*10)/10
      : sameCycle&&Number.isFinite(Number(saved?.lastBalancedProjectedPercent))
        ? Number(saved.lastBalancedProjectedPercent)
        : null,
    maximumSuggested,
    maximumSuggestedAt:maximumSuggested
      ? (sameCycle&&saved?.maximumSuggested?clean(saved?.maximumSuggestedAt,80)||now:now)
      : '',
  };
  if(context.deploy.context==='production')await health.setJSON('credits/automation-state',state);

  return {
    policy,
    automation:{
      enabled:true,
      balancedThresholdPercent:threshold,
      maximumSuggestionThresholdPercent:maximumSuggestionThreshold,
      projectedPercent:Number.isFinite(projectedPercent)?Math.round(projectedPercent*10)/10:null,
      crossedBalancedThreshold:crossedUp,
      autoAppliedBalanced:autoApplied,
      autoAppliedAt:autoAppliedAt||state.lastBalancedAt,
      skippedReason,
      adjustedProjectedCredits:Math.round(adjustedProjected*100)/100,
      adjustedProjectedPercent:adjustedPercent==null?null:Math.round(adjustedPercent*10)/10,
      maximumSavingsSuggested:maximumSuggested,
      maximumSavingsAutomatic:false,
      note:'Balanced Savings can be applied automatically only on an upward crossing of 80% while all six safe jobs are in Normal mode. Maximum Savings is suggestion-only and is never applied automatically.',
    },
  };
}

export async function cachedDeploymentHistory(context:Context) {
  const store=healthStore(context);
  const cached:any=await store.get('deployments/cache',{type:'json'});
  const cachedAgeMs=Date.now()-Date.parse(String(cached?.generatedAt||''));
  const cachedSourceKey=String(cached?.connectionHealth?.verificationSourceKey||'');
  const cachedTtlMs=(cachedSourceKey==='netlify-fallback'||cachedSourceKey==='netlify-runtime'||cachedSourceKey==='unverified')
    ? 60*1000
    : 10*60*1000;
  if(cached?.deploymentCacheVersion===3 && cached?.creditUsage?.version===9 && Number.isFinite(cachedAgeMs) && cachedAgeMs<cachedTtlMs) return cached;

  const origin=baseUrl().replace(/\/$/,'');
  const home=await timedFetch(origin+'/');
  const html=home.response?await home.response.text().catch(()=>''):'';
  const match=(name:string)=>html.match(new RegExp('<meta\\s+name=["\\\']'+name+'["\\\']\\s+content=["\\\']([^"\\\']+)["\\\']','i'))?.[1]||'';
  const current:any={
    commit:match('koa-build-commit'),
    deployId:match('koa-deploy-id'),
    builtAt:match('koa-build-time'),
    deployTime:match('koa-build-time'),
    functionCount:null,
    mainCommit:'',
    mainCommitAt:'',
    behindMain:null,
    commitsBehind:null,
    compareStatus:'',
    functionSchedules:[],
  };

  const netlifyToken=clean(Netlify.env.get('NETLIFY_AUTH_TOKEN'),500);
  let netlifyDeployHistory:any[]=[];
  let netlifyPreviewHistory:any[]=[];
  if(netlifyToken){
    try{
      const siteId=clean((context as any)?.site?.id || Netlify.env.get('SITE_ID') || 'd1f3ab06-be2a-41c4-b770-59e6a6acd1b9',120);
      const collected:any[]=[];
      for(let page=1;page<=5;page+=1){
        const response=await fetch('https://api.netlify.com/api/v1/sites/'+encodeURIComponent(siteId)+'/deploys?per_page=100&page='+page,{
          headers:{Authorization:'Bearer '+netlifyToken,'User-Agent':'KoaEvents-Health/1.0'},
          signal:AbortSignal.timeout(12_000),
        });
        if(!response.ok) break;
        const rows:any[]=await response.json();
        collected.push(...rows);
        if(rows.length<100) break;
      }
      const normalizeDeploy=(row:any)=>({
        deployId:clean(row?.id,120),
        commit:clean(row?.commit_ref,80),
        state:clean(row?.state,40),
        context:clean(row?.context,40),
        reviewId:row?.review_id==null?null:Number(row.review_id),
        title:clean(row?.title,300),
        createdAt:clean(row?.created_at,80),
        publishedAt:clean(row?.published_at,80),
        deployTime:Number.isFinite(Number(row?.deploy_time))?Number(row.deploy_time):null,
        errorMessage:clean(row?.error_message || row?.summary?.messages?.find?.((message:any)=>message?.type==='error')?.description,1000),
      });
      netlifyDeployHistory=collected
        .filter((row:any)=>clean(row?.context,40)==='production')
        .map(normalizeDeploy);
      netlifyPreviewHistory=collected
        .filter((row:any)=>clean(row?.context,40)==='deploy-preview')
        .map(normalizeDeploy);
    }catch{}
  }
  if(current.deployId && netlifyToken){
    try{
      const response=await fetch('https://api.netlify.com/api/v1/deploys/'+encodeURIComponent(current.deployId),{
        headers:{Authorization:'Bearer '+netlifyToken,'User-Agent':'KoaEvents-Health/1.0'},
        signal:AbortSignal.timeout(12_000),
      });
      if(response.ok){
        const deploy:any=await response.json();
        current.deployTime=clean(deploy?.published_at||deploy?.updated_at||deploy?.created_at,80)||current.deployTime;
        const availableFunctions=Array.isArray(deploy?.available_functions)?deploy.available_functions:[];
        if(availableFunctions.length) current.functionCount=availableFunctions.length;
        current.functionSchedules=Array.isArray(deploy?.function_schedules)?deploy.function_schedules:[];
      }
    }catch{}
  }

  const githubToken=clean(Netlify.env.get('KOA_GITHUB_READ_TOKEN'),500);
  const headers:Record<string,string>={
    'Accept':'application/vnd.github+json',
    'User-Agent':'KoaEvents-Health/1.0',
    ...(githubToken?{Authorization:'Bearer '+githubToken}:{}),
  };

  try{
    const response=await fetch('https://api.github.com/repos/AstroTat808/koasevents.com/commits/main',{headers,signal:AbortSignal.timeout(12_000)});
    if(response.ok){
      const body:any=await response.json();
      current.mainCommit=clean(body?.sha,80);
      current.mainCommitAt=clean(body?.commit?.committer?.date||body?.commit?.author?.date,80);
    }
  }catch{}

  if(current.commit){
    try{
      const response=await fetch('https://api.github.com/repos/AstroTat808/koasevents.com/contents/netlify/functions?ref='+encodeURIComponent(current.commit),{headers,signal:AbortSignal.timeout(12_000)});
      if(response.ok){
        const rows:any[]=await response.json();
        current.functionCount=rows.filter((row:any)=>
          row?.type==='file' && /\.(?:mts|ts|mjs|js|cjs)$/i.test(String(row?.name||''))
        ).length;
      }
    }catch{}
  }

  if(current.commit && current.mainCommit){
    if(current.commit===current.mainCommit){
      current.behindMain=false;
      current.commitsBehind=0;
      current.compareStatus='identical';
    }else{
      try{
        const response=await fetch(
          'https://api.github.com/repos/AstroTat808/koasevents.com/compare/'+encodeURIComponent(current.commit)+'...'+encodeURIComponent(current.mainCommit),
          {headers,signal:AbortSignal.timeout(12_000)},
        );
        if(response.ok){
          const body:any=await response.json();
          current.compareStatus=clean(body?.status,40);
          const mainAhead=Math.max(0,Number(body?.ahead_by||0));
          current.commitsBehind=Number.isFinite(mainAhead)?mainAhead:null;
          current.behindMain=mainAhead>0;
        }else{
          current.behindMain=current.commit!==current.mainCommit;
        }
      }catch{
        current.behindMain=current.commit!==current.mainCommit;
      }
    }
  }

  const connectionHealth=await inspectDeploymentSync(context,{
    liveCommit:current.commit,
    mainCommit:current.mainCommit,
    mainCommitAt:current.mainCommitAt,
    commitsBehind:current.commitsBehind,
    compareStatus:current.compareStatus,
    deployId:current.deployId,
  });
  current.commit=current.commit||connectionHealth.liveCommit||'';
  current.deployId=current.deployId||connectionHealth.deployId||'';
  current.mainCommit=current.mainCommit||connectionHealth.mainCommit||'';
  if(current.commitsBehind==null&&connectionHealth.commitsBehind!=null){
    current.commitsBehind=Number(connectionHealth.commitsBehind);
    current.behindMain=Number(connectionHealth.commitsBehind)>0;
    current.compareStatus=current.compareStatus||connectionHealth.compareStatus||'';
  }
  current.deployStatus=connectionHealth.deployStatus||'';
  current.deployTime=connectionHealth.deployTime||current.deployTime;
  current.deployDurationSeconds=connectionHealth.deployDurationSeconds??null;
  current.repositoryPrivate=typeof connectionHealth.repositoryPrivate==='boolean'?connectionHealth.repositoryPrivate:null;
  current.githubCommit=connectionHealth.githubCommit||'';
  current.githubMetadataSource=connectionHealth.githubMetadataSource||'';
  current.verificationSource=connectionHealth.verificationSource||'';
  current.verificationSourceKey=connectionHealth.verificationSourceKey||'unverified';
  current.verificationSourceLabel=connectionHealth.verificationSourceLabel||'Unverified';
  current.fallbackUsed=Boolean(connectionHealth.fallbackUsed);
  current.githubLinked=connectionHealth.githubLinked;
  current.repository=connectionHealth.repository;
  current.productionBranch=connectionHealth.productionBranch;

  let runs:any[]=[];
  try{
    const response=await fetch('https://api.github.com/repos/AstroTat808/koasevents.com/actions/workflows/production-visual-qa.yml/runs?per_page=20',{headers,signal:AbortSignal.timeout(12_000)});
    if(response.ok) runs=(await response.json()).workflow_runs||[];
  }catch{}

  const history:any[]=[];
  for(const run of runs.slice(0,15)){
    let failedJobs:string[]=[];
    if(run.conclusion==='failure'){
      try{
        const response=await fetch('https://api.github.com/repos/AstroTat808/koasevents.com/actions/runs/'+run.id+'/jobs?per_page=50',{headers,signal:AbortSignal.timeout(12_000)});
        if(response.ok){
          const jobs=(await response.json()).jobs||[];
          failedJobs=jobs.filter((job:any)=>job.conclusion==='failure').map((job:any)=>clean(job.name,180));
        }
      }catch{}
    }
    history.push({
      runId:String(run.id||''),
      commit:clean(run.head_sha,80),
      branch:clean(run.head_branch,100),
      status:clean(run.status,40),
      conclusion:clean(run.conclusion,40),
      event:clean(run.event,40),
      createdAt:clean(run.created_at,80),
      updatedAt:clean(run.updated_at,80),
      url:clean(run.html_url,500),
      failedJobs,
    });
  }

  const lastSuccessfulQa=history.find(row=>
    row.conclusion==='success' && row.event==='push' && row.branch==='main'
  )||null;
  const latestQaForCurrentDeploy=history.find(row=>
    row.commit===current.commit && row.event==='push' && row.branch==='main'
  )||null;
  const failedBuilds=history.filter(row=>row.conclusion==='failure');
  const failedDeployGroups=groupConsecutiveDeployFailures(netlifyDeployHistory);
  const deploymentHealthy=Boolean(
    current.commit &&
    current.deployId &&
    current.behindMain===false &&
    lastSuccessfulQa &&
    lastSuccessfulQa.commit===current.commit
  );
  const postDeployVerification=await readPostDeployVerification(context);
  const bandwidthUsage=await fetchNetlifyBandwidthUsage(netlifyToken);
  const creditSnapshots=((await store.get('credits/history',{type:'json'})) || []) as any[];
  const saverLearningBefore=await readCreditSaverLearning(context);
  const creditUsage=estimateNetlifyCredits(
    netlifyDeployHistory,
    netlifyPreviewHistory,
    bandwidthUsage,
    current.functionSchedules||[],
    creditSnapshots,
    saverLearningBefore,
  );
  let creditSaverPolicy=await readCreditSaverPolicy(context);
  const automationResult=await evaluateCreditSaverAutomation(context,creditUsage,creditSaverPolicy);
  creditSaverPolicy=automationResult.policy;
  creditUsage.creditAutomation=automationResult.automation;
  creditUsage.saverPolicy=creditSaverPolicy;
  creditUsage.jobControls=(creditUsage.jobControls||[]).map((item:any)=>({
    ...item,
    currentMode:String(creditSaverPolicy?.modes?.[item.jobId]||'normal'),
  }));
  const controlById=new Map((creditUsage.jobControls||[]).map((item:any)=>[String(item.jobId),item]));
  creditUsage.presets=creditSaverPresets().map(preset=>({
    ...preset,
    changes:Object.entries(preset.modes).map(([jobId,toMode])=>{
      const control:any=controlById.get(jobId);
      const fromMode=String(creditSaverPolicy?.modes?.[jobId]||'normal');
      const savingsFor=(mode:string)=>mode==='paused'?Number(control?.pausedSavingsPerDay||0):mode==='saver'?Number(control?.saverSavingsPerDay||0):0;
      return {
        jobId,
        label:String(control?.label||jobId),
        normalLabel:String(control?.normalLabel||'Normal'),
        saverLabel:String(control?.saverLabel||'Saver'),
        fromMode,
        toMode,
        changed:fromMode!==toMode,
        estimatedSavingsPerDay:Math.round((savingsFor(String(toMode))-savingsFor(fromMode))*100000)/100000,
      };
    }),
  }));

  const activePreset=creditUsage.presets.find((preset:any)=>
    Array.isArray(preset?.changes)&&preset.changes.length>0&&preset.changes.every((change:any)=>!change.changed)
  )||null;
  const modeCounts=(creditUsage.jobControls||[]).reduce((acc:any,item:any)=>{
    const mode=String(item?.currentMode||'normal');
    if(mode==='paused')acc.paused+=1;
    else if(mode==='saver')acc.saver+=1;
    else acc.normal+=1;
    return acc;
  },{normal:0,saver:0,paused:0});
  creditUsage.activeProfile={
    id:activePreset?.id||'custom',
    name:activePreset?.name||'Custom Mix',
    isPreset:Boolean(activePreset),
    modeCounts,
    updatedAt:String(creditSaverPolicy?.updatedAt||''),
    updatedBy:String(creditSaverPolicy?.updatedBy||''),
    expiresAt:String(creditSaverPolicy?.expiresAt||''),
    expired:Boolean(creditSaverPolicy?.expired),
  };
  creditUsage.autoSaverPlan=optimizeCreditSaverPlan(creditUsage,creditSaverPolicy);
  creditUsage.recommendations=(creditUsage.recommendations||[]).map((item:any)=>({
    ...item,
    active:Boolean(item.safeActionId && creditSaverPolicy.activeActions?.includes(item.safeActionId)),
    canApply:Boolean(item.safeActionId),
  }));
  const generatedAt=new Date().toISOString();
  const compactCreditSnapshot={
    at:generatedAt,
    cycleStart:creditUsage.cycleStart,
    totalEstimatedCredits:creditUsage.totalEstimatedCredits,
  };
  const sameCycleSnapshots=creditSnapshots
    .filter((row:any)=>String(row?.cycleStart||'')===String(creditUsage.cycleStart))
    .sort((a:any,b:any)=>Date.parse(String(b?.at||''))-Date.parse(String(a?.at||'')));
  const latestCreditSnapshot=sameCycleSnapshots[0]||null;
  const latestAgeMs=latestCreditSnapshot?Date.now()-Date.parse(String(latestCreditSnapshot.at||'')):Infinity;
  const nextCreditSnapshots=latestAgeMs<60*60*1000
    ? [compactCreditSnapshot,...creditSnapshots.filter((row:any)=>row!==latestCreditSnapshot)]
    : [compactCreditSnapshot,...creditSnapshots];
  await store.setJSON('credits/history',nextCreditSnapshots.slice(0,800));
  creditUsage.saverLearning=await updateCreditSaverLearning(context,creditUsage,netlifyDeployHistory);

  const result={
    deploymentCacheVersion:3,
    generatedAt,
    current,
    connectionHealth,
    deploymentHealthy,
    postDeployVerification,
    lastSuccessfulDeployment:current,
    lastSuccessfulQa,
    latestQaForCurrentDeploy,
    failedBuilds,
    failedDeployGroups,
    netlifyDeployHistory,
    creditUsage,
    history,
  };
  await store.setJSON('deployments/cache',result);
  return result;
}
