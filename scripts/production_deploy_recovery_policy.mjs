// Pure policy for recovering an exact-SHA Netlify production release.
// Reuses existing successful-deployment policy: failure is never success.
import { isSuccessfulNetlifyState } from '../netlify/functions/_shared/production-release-policy.mjs';

const SHA=/^[a-f0-9]{40}$/i;
const ACTIVE=new Set(['new','pending','queued','enqueued','building','preparing',
  'prepared','processing','uploading','uploaded','pending_review']);
const FAILED=new Set(['error','failed','cancelled','canceled']);

export function planExactProductionRecovery(input={}){
  const sha=String(input.expectedSha||'').trim().toLowerCase();
  const rows=input.deploys;
  if(!SHA.test(sha))return {action:'block',reason:'invalid exact SHA'};
  if(!Array.isArray(rows))return {action:'block',reason:'Netlify deploy list missing'};
  const exact=rows.filter(row=>
    String(row?.context||'').trim()==='production' &&
    String(row?.commit_ref||row?.commit||row?.branch_commit||'').trim().toLowerCase()===sha
  );
  if(exact.some(row=>isSuccessfulNetlifyState(row?.state))){
    return {action:'wait',reason:'ready exact-SHA deploy exists',
      deployId:String(exact.find(row=>isSuccessfulNetlifyState(row?.state))?.id||'')};
  }
  if(exact.some(row=>ACTIVE.has(String(row?.state||'').trim().toLowerCase()))){
    return {action:'wait',reason:'exact-SHA build already in progress',
      deployId:String(exact.find(row=>ACTIVE.has(String(row?.state||'').trim().toLowerCase()))?.id||'')};
  }
  const unknown=exact.find(row=>!FAILED.has(String(row?.state||'').trim().toLowerCase()));
  if(unknown)return {action:'block',reason:'unrecognized exact-SHA deploy state',
    deployId:String(unknown?.id||'')};
  const failed=exact.filter(row=>FAILED.has(String(row?.state||'').trim().toLowerCase()));
  if(failed.length>=2)return {action:'block',
    reason:'exact-SHA production build already failed after one retry',
    failedDeployCount:failed.length,deployId:String(failed[0]?.id||'')};
  if(rows.length>=100&&!exact.length)return {action:'block',reason:'Netlify deploy list is truncated'};
  return {action:'trigger',reason:failed.length===1?'one failed exact-SHA deploy':'no exact-SHA deploy',
    failedDeployCount:failed.length,deployId:String(failed[0]?.id||'')};
}
