import type { DeploySucceededEvent, DeployFailedEvent } from '@netlify/functions';
import { controlPlaneStore } from './_shared/tenant-storage';
import { eligibleProductionDeploy, sanitizedDeployFailure, KoaRepo } from './_shared/production-certification-trigger.mjs';

const storeName='koa-production-certification-dispatch';
const ghApi='https://api.github.com/repos/'+KoaRepo;
function env(key:string){return String(Netlify.env.get(key)||'').trim();}
function safeId(value:unknown){return String(value||'').trim().slice(0,100);}
function headers(token:string){return {
  Authorization:'Bearer '+token,
  Accept:'application/vnd.github+json',
  'X-GitHub-Api-Version':'2022-11-28',
};}
async function sendDeployFailureAlert(event:DeployFailedEvent){
  const payload=sanitizedDeployFailure({
    context:String(event.deploy.context||''),
    deployId:safeId(event.deploy.id),
    commitRef:safeId(event.deploy.commitRef),
    at:new Date().toISOString(),
  });
  if(!payload)return;
  const token=env('RESEND_API_KEY');
  const recipients=(env('KOA_HEALTH_ALERT_EMAILS')||env('KOA_LEAD_EMAIL_TO')||'chris@sibel.org')
    .split(',').map(v=>v.trim()).filter(v=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
  if(!token||!recipients.length){
    console.error('[production cert] production deployment failure alert cannot send: recipient or sender not configured');
    return;
  }
  const subject='Koa’s Events — production Netlify deploy failed';
  const body=[
    'A Koa’s Events production deployment failed. This is a new deployment failure event, not a routine health report.',
    'UTC: '+payload.at,
    'Deploy ID: '+payload.deployId,
    'Commit: '+payload.commit,
    'Project: '+payload.projectUrl,
    'The previous published deployment may still be serving traffic. Inspect Netlify deployment details.',
  ].join('\n');
  try{
    const res=await fetch('https://api.resend.com/emails',{
      method:'POST',
      headers:{
        Authorization:'Bearer '+token,
        'Content-Type':'application/json',
        'Idempotency-Key':'koa-prod-deploy-failed-'+payload.deployId,
      },
      body:JSON.stringify({
        from:env('KOA_HEALTH_ALERT_FROM')||env('KOA_LEAD_EMAIL_FROM')||'Koa’s Events <leads@koasevents.com>',
        to:recipients,
        subject,
        text:body,
      }),
      signal:AbortSignal.timeout(12000),
    });
    if(!res.ok)console.error('[production cert] deploy failure alert rejected, HTTP '+res.status);
  }catch{
    console.error('[production cert] deploy failure alert request did not complete');
  }
}

async function dispatchCertifiedQa(event:DeploySucceededEvent){
  if(String(event.deploy.context||'')!=='production')return;
  const token=env('KOA_GITHUB_ACTIONS_TOKEN');
  if(!token){
    // Never repurpose a read-only GitHub credential for Actions dispatch.
    console.warn('[production cert] GitHub Actions dispatch unavailable: dedicated credential not provisioned');
    return;
  }
  const deployId=safeId(event.deploy.id);
  const commitRef=safeId(event.deploy.commitRef);
  if(!/^[a-z0-9]{12,80}$/i.test(deployId)||!/^[0-9a-f]{40}$/.test(commitRef))return;
  const store=controlPlaneStore(storeName);
  const key='triggered/'+deployId;
  try{
    const prior:any=await store.get(key,{type:'json'});
    if(prior?.status==='dispatched')return;
    const mainRes=await fetch(ghApi+'/branches/main',{
      headers:headers(token),signal:AbortSignal.timeout(12000),
    });
    if(!mainRes.ok)throw new Error('main verification failed with HTTP '+mainRes.status);
    const main:any=await mainRes.json();
    if(!eligibleProductionDeploy({
      context:String(event.deploy.context||''),deployId,commitRef,
      mainSha:String(main?.commit?.sha||''),
    })){
      // Stale deploys must never dispatch a certification for an unrelated main SHA.
      console.warn('[production cert] deploy SHA does not match exact current main; certification not dispatched');
      return;
    }
    const dispatched=await fetch(ghApi+'/actions/workflows/production-visual-qa.yml/dispatches',{
      method:'POST',headers:{...headers(token),'Content-Type':'application/json'},
      body:JSON.stringify({ref:'main'}),
      signal:AbortSignal.timeout(12000),
    });
    if(dispatched.status!==204)throw new Error('workflow dispatch failed with HTTP '+dispatched.status);
    await store.setJSON(key,{status:'dispatched',deployId,commit:commitRef,triggeredAt:new Date().toISOString()});
    console.log('[production cert] exact-main QA dispatch accepted for deploy '+deployId);
  }catch(error){
    const message=error instanceof Error?error.message:'unavailable';
    console.error('[production cert] production QA dispatch unavailable: '+message);
  }
}
export default {
  async deploySucceeded(event:DeploySucceededEvent){await dispatchCertifiedQa(event);},
  async deployFailed(event:DeployFailedEvent){await sendDeployFailureAlert(event);},
};
