import type { Context } from '@netlify/functions';
import { controlPlaneStore } from './tenant-storage';
import { failedProductionQaJobs,validProductionQaFailureRun } from './production-qa-failure-policy.mjs';

const REPO='AstroTat808/koasevents.com';
const GH='https://api.github.com/repos/'+REPO;
const STORE='koa-production-qa-failure-alerts';
const RESEND='https://api.resend.com/emails';
const text=(x:unknown,max=240)=>String(x??'').trim().slice(0,max);
function headers(token:string){return {Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};}
async function ghGet(token:string,path:string){
  const response=await fetch(GH+path,{headers:headers(token),signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw new Error('GitHub API verification failed');
  return response.json();
}
export async function sendVerifiedProductionQaFailure(claims:any,runIdInput:unknown,context:Context){
  if(String(claims?.event_name||'')!=='workflow_run'
     || !String(claims?.workflow_ref||'').includes('/.github/workflows/notify-production-qa-failures.yml@refs/heads/main')){
    return {ok:false,code:'INVALID_NOTIFICATION_WORKFLOW',status:403};
  }
  const runId=text(runIdInput,20);
  if(!/^[0-9]{6,18}$/.test(runId))return {ok:false,code:'INVALID_RUN_ID',status:400};
  const expectedSha=text(claims?.sha,50);
  const githubToken=text(Netlify.env.get('KOA_GITHUB_READ_TOKEN'),500);
  if(!githubToken)return {ok:false,code:'GITHUB_VERIFICATION_UNAVAILABLE',status:503};
  try{
    const [main,run,jobsResponse]=await Promise.all([
      ghGet(githubToken,'/branches/main'),
      ghGet(githubToken,'/actions/runs/'+runId),
      ghGet(githubToken,'/actions/runs/'+runId+'/jobs?per_page=100'),
    ]);
    const mainSha=text(main?.commit?.sha,50);
    if(expectedSha!==mainSha || !validProductionQaFailureRun(run,runId,expectedSha)){
      return {ok:false,code:'STALE_OR_NONPRODUCTION_RUN',status:409};
    }
    const failures=failedProductionQaJobs(run,jobsResponse?.jobs);
    if(!failures.length)return {ok:true,alerted:false,code:'NO_DECISIVE_PRODUCTION_JOB_FAILURE'};
    const store=controlPlaneStore(STORE);
    const key='sent/'+runId;
    const prior:any=await store.get(key,{type:'json'});
    if(prior?.status==='sent')return {ok:true,alerted:false,code:'ALREADY_SENT'};
    const resendKey=text(Netlify.env.get('RESEND_API_KEY'),500);
    const recipients=(text(Netlify.env.get('KOA_HEALTH_ALERT_EMAILS')||Netlify.env.get('KOA_LEAD_EMAIL_TO')||'chris@sibel.org',500))
      .split(',').map(v=>v.trim()).filter(v=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
    if(!resendKey||!recipients.length)return {ok:false,code:'EMAIL_CHANNEL_UNAVAILABLE',status:503};
    const runUrl='https://github.com/'+REPO+'/actions/runs/'+runId;
    const lines=[
      'Koa’s Events production QA failure confirmed.',
      'Run ID: '+runId,'Exact main SHA: '+expectedSha,
      'Completed at: '+text(run.updated_at,80),
      'Failing jobs: '+failures.map(x=>x.name).join('; '),
      'Run evidence: '+runUrl,
      'Netlify project: https://app.netlify.com/projects/koasevents-website',
    ];
    const response=await fetch(RESEND,{
      method:'POST',
      headers:{
        Authorization:'Bearer '+resendKey,
        'Content-Type':'application/json',
        'Idempotency-Key':'koa-production-qa-failure-'+runId,
      },
      body:JSON.stringify({
        from:text(Netlify.env.get('KOA_HEALTH_ALERT_FROM')||Netlify.env.get('KOA_LEAD_EMAIL_FROM')||'Koa’s Events <leads@koasevents.com>',240),
        to:recipients,
        subject:'Koa’s Events: production QA failure — run #'+runId,
        text:lines.join('\n'),
      }),
      signal:AbortSignal.timeout(12000),
    });
    if(!response.ok)return {ok:false,code:'NOTIFICATION_DELIVERY_FAILED',status:502};
    await store.setJSON(key,{
      status:'sent',runId,sha:expectedSha,at:new Date().toISOString(),
      failedJobNames:failures.map(x=>x.name),
    });
    return {ok:true,alerted:true,runId,sha:expectedSha,failedJobNames:failures.map(x=>x.name)};
  }catch(error){
    console.error('[production QA notifier] failed to verify or deliver sanitized alert');
    return {ok:false,code:'NOTIFICATION_VERIFICATION_FAILED',status:503};
  }
}
