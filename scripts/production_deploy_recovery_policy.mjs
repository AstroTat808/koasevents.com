// Pure policy for recovering an exact-SHA Netlify production release.
// Reuses existing successful-deployment policy: failure is never success.
import { isSuccessfulNetlifyState } from '../netlify/functions/_shared/production-release-policy.mjs';

const SHA=/^[a-f0-9]{40}$/i;
const ACTIVE=new Set(['new','pending','queued','enqueued','building','preparing',
  'prepared','processing','uploading','uploaded','pending_review']);
const FAILED=new Set(['error','failed','cancelled','canceled']);

// Netlify paginates at 100 records. A busy site can have more than 100 preview
// deploys ahead of its latest production build. Read ALL production pages before
// deciding that an exact GitHub SHA has never been deployed. Fail closed if the
// API response is malformed or the bounded scan cannot reach the last page.
export async function getCompleteProductionDeployHistory({siteId,token,getJson,maxPages=20}={}){
  if(!siteId||!token||typeof getJson!=='function'||!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>20){
    throw new Error('Invalid Netlify production deployment-history scan configuration.');
  }
  const perPage=100;
  const deployments=[];
  for(let page=1;page<=maxPages;page++){
    const url='https://api.netlify.com/api/v1/sites/'+encodeURIComponent(siteId)+
      '/deploys?production=true&per_page='+perPage+'&page='+page;
    const batch=await getJson(url,token);
    if(!Array.isArray(batch)||batch.length>perPage){
      throw new Error('Netlify production deployment-history page is malformed.');
    }
    deployments.push(...batch);
    if(batch.length<perPage)return deployments;
  }
  throw new Error('Netlify production deployment-history page limit reached; recovery remains blocked.');
}

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
  const creditFailure=exact.find(row=>
    FAILED.has(String(row?.state||'').trim().toLowerCase())
    &&/credit usage exceeded/i.test(String(row?.error_message||row?.error||''))
  );
  if(creditFailure){
    return {action:'manual-deploy',reason:'Netlify hosted build credits are exhausted',
      deployId:String(creditFailure?.id||'')};
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
  if(rows.length>=100&&!exact.length&&!input.historyComplete)return {action:'block',reason:'Netlify deploy list may be truncated'};
  return {action:'trigger',reason:failed.length===1?'one failed exact-SHA deploy':'no exact-SHA deploy',
    failedDeployCount:failed.length,deployId:String(failed[0]?.id||'')};
}
