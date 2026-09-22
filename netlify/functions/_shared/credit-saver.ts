import type { Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';

export type CreditSaverActionId =
  | 'post-deploy-verification-half'
  | 'quickbooks-reconciliation-half'
  | 'crm-lifecycle-half'
  | 'office365-calendar-sync-pause';

export type CreditSaverPolicy = {
  updatedAt: string;
  updatedBy: string;
  expiresAt: string;
  actions: Partial<Record<CreditSaverActionId, boolean>>;
};

const ACTION_IDS:CreditSaverActionId[]=[
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

function normalizedPolicy(value:any):CreditSaverPolicy{
  const actions:Partial<Record<CreditSaverActionId,boolean>>={};
  for(const id of ACTION_IDS) actions[id]=Boolean(value?.actions?.[id]);
  return {
    updatedAt:clean(value?.updatedAt,80),
    updatedBy:clean(value?.updatedBy,180),
    expiresAt:clean(value?.expiresAt,80)||nextBillingCycleEnd(),
    actions,
  };
}

export async function readCreditSaverPolicy(context:Context){
  const saved:any=(await store(context).get('credits/saver-policy',{type:'json'}))||{};
  const policy=normalizedPolicy(saved);
  const expired=Number.isFinite(Date.parse(policy.expiresAt)) && Date.now()>=Date.parse(policy.expiresAt);
  return {
    ...policy,
    expired,
    activeActions:ACTION_IDS.filter(id=>Boolean(policy.actions[id])&&!expired),
  };
}

export async function setCreditSaverAction(
  context:Context,
  actionId:CreditSaverActionId,
  enabled:boolean,
  actor:string,
){
  if(!ACTION_IDS.includes(actionId)) throw new Error('Unknown credit-saver action.');
  const current=await readCreditSaverPolicy(context);
  const policy:CreditSaverPolicy={
    updatedAt:new Date().toISOString(),
    updatedBy:clean(actor,180)||'admin',
    expiresAt:current.expired?nextBillingCycleEnd():current.expiresAt||nextBillingCycleEnd(),
    actions:{
      ...current.actions,
      [actionId]:Boolean(enabled),
    },
  };
  const health=store(context);
  await health.setJSON('credits/saver-policy',policy);
  await health.delete('deployments/cache');
  return readCreditSaverPolicy(context);
}

export async function clearCreditSaverPolicy(context:Context,actor:string){
  const policy:CreditSaverPolicy={
    updatedAt:new Date().toISOString(),
    updatedBy:clean(actor,180)||'admin',
    expiresAt:nextBillingCycleEnd(),
    actions:{},
  };
  const health=store(context);
  await health.setJSON('credits/saver-policy',policy);
  await health.delete('deployments/cache');
  return readCreditSaverPolicy(context);
}

export async function shouldRunScheduledJob(context:Context,job:
  'post-deploy-verification'|'quickbooks-reconciliation'|'crm-lifecycle'|'office365-calendar-sync'
){
  if(context.deploy.context!=='production') return true;
  const policy=await readCreditSaverPolicy(context);
  if(policy.expired) return true;
  const now=new Date();
  if(job==='post-deploy-verification' && policy.actions['post-deploy-verification-half']){
    return now.getUTCMinutes()%30===0;
  }
  if(job==='quickbooks-reconciliation' && policy.actions['quickbooks-reconciliation-half']){
    return now.getUTCHours()%8===0;
  }
  if(job==='crm-lifecycle' && policy.actions['crm-lifecycle-half']){
    return now.getUTCHours()%12===0;
  }
  if(job==='office365-calendar-sync' && policy.actions['office365-calendar-sync-pause']){
    return false;
  }
  return true;
}
