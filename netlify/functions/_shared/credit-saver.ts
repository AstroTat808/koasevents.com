import type { Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';

export type CreditSaverMode='normal'|'saver'|'paused';
export type CreditSaverJobId=
  | 'post-deploy-verification'
  | 'quickbooks-reconciliation'
  | 'crm-lifecycle'
  | 'office365-calendar-sync'
  | 'review-requests'
  | 'vendor-insurance-reminders';

export type CreditSaverActionId =
  | 'post-deploy-verification-half'
  | 'quickbooks-reconciliation-half'
  | 'crm-lifecycle-half'
  | 'office365-calendar-sync-pause';

export type CreditSaverPolicy = {
  updatedAt:string;
  updatedBy:string;
  expiresAt:string;
  modes:Record<CreditSaverJobId,CreditSaverMode>;
};

export const CREDIT_SAVER_JOBS:CreditSaverJobId[]=[
  'post-deploy-verification',
  'quickbooks-reconciliation',
  'crm-lifecycle',
  'office365-calendar-sync',
  'review-requests',
  'vendor-insurance-reminders',
];

export type CreditSaverPresetId='normal-operations'|'balanced-savings'|'maximum-savings';

export type CreditSaverPreset={
  id:CreditSaverPresetId;
  name:string;
  description:string;
  caution:string;
  modes:Record<CreditSaverJobId,CreditSaverMode>;
};

function presetModes(mode:CreditSaverMode):Record<CreditSaverJobId,CreditSaverMode>{
  return Object.fromEntries(CREDIT_SAVER_JOBS.map(id=>[id,mode])) as Record<CreditSaverJobId,CreditSaverMode>;
}

export function creditSaverPresets():CreditSaverPreset[]{
  return [
    {
      id:'normal-operations',
      name:'Normal Operations',
      description:'Runs all six safe scheduled jobs at their normal cadence.',
      caution:'Use when credit pressure is low or when you want the fastest background maintenance cadence.',
      modes:presetModes('normal'),
    },
    {
      id:'balanced-savings',
      name:'Balanced Savings',
      description:'Runs all six safe scheduled jobs in Saver mode to reduce background work without fully stopping any of them.',
      caution:'Core System Health, lead-response protection, webhooks, payments, security, and manual Office 365 sync remain unchanged.',
      modes:presetModes('saver'),
    },
    {
      id:'maximum-savings',
      name:'Maximum Savings',
      description:'Pauses all six optional scheduled jobs until the billing-cycle reset or until you restore another preset.',
      caution:'Use only during significant credit pressure. Core System Health, lead-response protection, webhooks, payments, security, and client-facing workflows remain active.',
      modes:presetModes('paused'),
    },
  ];
}

export function creditSaverPreset(id:unknown){
  const key=String(id||'') as CreditSaverPresetId;
  return creditSaverPresets().find(preset=>preset.id===key)||null;
}

const LEGACY_ACTIONS:CreditSaverActionId[]=[
  'post-deploy-verification-half',
  'quickbooks-reconciliation-half',
  'crm-lifecycle-half',
  'office365-calendar-sync-pause',
];

function store(context:Context){
  return context.deploy.context==='production'
    ? getStore({name:'koa-system-health',consistency:'strong'})
    : getDeployStore({name:'koa-system-health'});
}

function clean(value:unknown,max=240){
  return String(value||'').trim().slice(0,max);
}

function nextBillingCycleEnd(now=new Date()){
  const configured=Number(Netlify.env.get('KOA_NETLIFY_BILLING_CYCLE_DAY')||22);
  const day=Number.isFinite(configured)?Math.min(28,Math.max(1,Math.floor(configured))):22;
  const year=now.getUTCFullYear();
  const month=now.getUTCMonth();
  const thisMonthReset=new Date(Date.UTC(year,month,day,0,0,0,0));
  return now<thisMonthReset
    ? thisMonthReset.toISOString()
    : new Date(Date.UTC(year,month+1,day,0,0,0,0)).toISOString();
}

function normalizeMode(value:unknown):CreditSaverMode{
  return value==='paused'?'paused':value==='saver'?'saver':'normal';
}

function defaultModes():Record<CreditSaverJobId,CreditSaverMode>{
  return Object.fromEntries(CREDIT_SAVER_JOBS.map(id=>[id,'normal'])) as Record<CreditSaverJobId,CreditSaverMode>;
}

function legacyModes(value:any){
  const modes=defaultModes();
  if(value?.actions?.['post-deploy-verification-half'])modes['post-deploy-verification']='saver';
  if(value?.actions?.['quickbooks-reconciliation-half'])modes['quickbooks-reconciliation']='saver';
  if(value?.actions?.['crm-lifecycle-half'])modes['crm-lifecycle']='saver';
  if(value?.actions?.['office365-calendar-sync-pause'])modes['office365-calendar-sync']='paused';
  return modes;
}

function normalizedPolicy(value:any):CreditSaverPolicy{
  const modes=legacyModes(value);
  if(value?.modes&&typeof value.modes==='object'){
    for(const id of CREDIT_SAVER_JOBS)modes[id]=normalizeMode(value.modes[id]);
  }
  return {
    updatedAt:clean(value?.updatedAt,80),
    updatedBy:clean(value?.updatedBy,180),
    expiresAt:clean(value?.expiresAt,80)||nextBillingCycleEnd(),
    modes,
  };
}

function activeActionsForModes(modes:Record<CreditSaverJobId,CreditSaverMode>){
  const actions:CreditSaverActionId[]=[];
  if(modes['post-deploy-verification']==='saver')actions.push('post-deploy-verification-half');
  if(modes['quickbooks-reconciliation']==='saver')actions.push('quickbooks-reconciliation-half');
  if(modes['crm-lifecycle']==='saver')actions.push('crm-lifecycle-half');
  if(modes['office365-calendar-sync']==='paused')actions.push('office365-calendar-sync-pause');
  return actions;
}

export async function readCreditSaverPolicy(context:Context){
  const saved:any=(await store(context).get('credits/saver-policy',{type:'json'}))||{};
  const policy=normalizedPolicy(saved);
  const expired=Number.isFinite(Date.parse(policy.expiresAt))&&Date.now()>=Date.parse(policy.expiresAt);
  const modes=expired?defaultModes():policy.modes;
  return {
    ...policy,
    modes,
    expired,
    activeActions:expired?[]:activeActionsForModes(modes),
    activeModes:CREDIT_SAVER_JOBS.filter(id=>modes[id]!=='normal').map(id=>({jobId:id,mode:modes[id]})),
  };
}

async function savePolicy(context:Context,policy:CreditSaverPolicy){
  const health=store(context);
  await health.setJSON('credits/saver-policy',policy);
  await health.delete('deployments/cache');
  return readCreditSaverPolicy(context);
}

export async function setCreditSaverMode(
  context:Context,
  jobId:CreditSaverJobId,
  mode:CreditSaverMode,
  actor:string,
){
  if(!CREDIT_SAVER_JOBS.includes(jobId))throw new Error('Unknown scheduled job.');
  const nextMode=normalizeMode(mode);
  const current=await readCreditSaverPolicy(context);
  return savePolicy(context,{
    updatedAt:new Date().toISOString(),
    updatedBy:clean(actor,180)||'admin',
    expiresAt:current.expired?nextBillingCycleEnd():current.expiresAt||nextBillingCycleEnd(),
    modes:{...current.modes,[jobId]:nextMode},
  });
}

export async function setCreditSaverModes(
  context:Context,
  changes:Partial<Record<CreditSaverJobId,CreditSaverMode>>,
  actor:string,
){
  const current=await readCreditSaverPolicy(context);
  const modes={...current.modes};
  for(const [jobId,mode] of Object.entries(changes||{})){
    if(!CREDIT_SAVER_JOBS.includes(jobId as CreditSaverJobId))continue;
    modes[jobId as CreditSaverJobId]=normalizeMode(mode);
  }
  return savePolicy(context,{
    updatedAt:new Date().toISOString(),
    updatedBy:clean(actor,180)||'admin',
    expiresAt:current.expired?nextBillingCycleEnd():current.expiresAt||nextBillingCycleEnd(),
    modes,
  });
}

export async function setCreditSaverAction(
  context:Context,
  actionId:CreditSaverActionId,
  enabled:boolean,
  actor:string,
){
  if(!LEGACY_ACTIONS.includes(actionId))throw new Error('Unknown credit-saver action.');
  const map:Record<CreditSaverActionId,{jobId:CreditSaverJobId,on:CreditSaverMode}>={
    'post-deploy-verification-half':{jobId:'post-deploy-verification',on:'saver'},
    'quickbooks-reconciliation-half':{jobId:'quickbooks-reconciliation',on:'saver'},
    'crm-lifecycle-half':{jobId:'crm-lifecycle',on:'saver'},
    'office365-calendar-sync-pause':{jobId:'office365-calendar-sync',on:'paused'},
  };
  const row=map[actionId];
  return setCreditSaverMode(context,row.jobId,enabled?row.on:'normal',actor);
}

export async function clearCreditSaverPolicy(context:Context,actor:string){
  return savePolicy(context,{
    updatedAt:new Date().toISOString(),
    updatedBy:clean(actor,180)||'admin',
    expiresAt:nextBillingCycleEnd(),
    modes:defaultModes(),
  });
}

function utcDayNumber(now:Date){
  return Math.floor(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())/86400000);
}

export async function shouldRunScheduledJob(context:Context,job:CreditSaverJobId){
  if(context.deploy.context!=='production')return true;
  const policy=await readCreditSaverPolicy(context);
  const mode=policy.modes[job]||'normal';
  if(mode==='normal')return true;
  if(mode==='paused')return false;
  const now=new Date();
  if(job==='post-deploy-verification')return now.getUTCMinutes()%30===0;
  if(job==='quickbooks-reconciliation')return now.getUTCHours()%8===0;
  if(job==='crm-lifecycle')return now.getUTCHours()%12===0;
  if(job==='office365-calendar-sync')return now.getUTCHours()%4===0;
  if(job==='review-requests'||job==='vendor-insurance-reminders')return utcDayNumber(now)%2===0;
  return true;
}
