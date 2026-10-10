#!/usr/bin/env node
// GitHub-owned production bootstrap. Does not rely on the old deployed Netlify
// function: a failed deploy cannot publish its own fix.
import { planExactProductionRecovery } from './production_deploy_recovery_policy.mjs';

const expected=String(process.env.EXPECTED_COMMIT||'').trim().toLowerCase();
const repo=String(process.env.GITHUB_REPOSITORY||'');
const sha=String(process.env.GITHUB_SHA||'').trim().toLowerCase();
const githubToken=String(process.env.GH_TOKEN||'').trim();
const netlifyToken=String(process.env.NETLIFY_AUTH_TOKEN||'').trim();
const siteId=String(process.env.NETLIFY_SITE_ID||'').trim();

function block(why){
  console.error('[koa production recovery] BLOCKED: '+why);
  process.exitCode=1;
}
async function getJson(url,token,method='GET'){
  const response=await fetch(url,{
    method,
    headers:{
      Authorization:'Bearer '+token,
      Accept:'application/json',
      'User-Agent':'koasevents-exact-sha-release-recovery',
    },
    signal:AbortSignal.timeout(20000),
  });
  if(!response.ok)throw new Error('API request failed with HTTP '+response.status+'.');
  return response.json();
}
async function githubMain(){
  const d=await getJson('https://api.github.com/repos/AstroTat808/koasevents.com/branches/main',githubToken);
  return String(d?.commit?.sha||'').trim().toLowerCase();
}
async function main(){
  if(repo!=='AstroTat808/koasevents.com'||process.env.GITHUB_REF!=='refs/heads/main'||
    process.env.GITHUB_EVENT_NAME!=='push'||sha!==expected||!/^[a-f0-9]{40}$/.test(expected)){
    return block('only an exact-sha main-branch push may request production recovery.');
  }
  if(!githubToken||!netlifyToken||!siteId){
    return block('GitHub token, Netlify Actions secret, or site ID is unavailable.');
  }
  if((await githubMain())!==expected){
    return block('main advanced; stale SHA will not be rebuilt.');
  }
  const deployments=await getJson('https://api.netlify.com/api/v1/sites/'+encodeURIComponent(siteId)+'/deploys?per_page=100',netlifyToken);
  const plan=planExactProductionRecovery({expectedSha:expected,deploys:deployments});
  console.log('[koa production recovery] '+JSON.stringify(plan));
  if(plan.action==='block')return block(plan.reason);
  if(plan.action==='wait')return;
  // Netlify builds branch HEAD. Recheck that HEAD has not moved.
  if((await githubMain())!==expected){
    return block('main advanced during recovery; stale build prevented.');
  }
  const build=await getJson('https://api.netlify.com/api/v1/sites/'+encodeURIComponent(siteId)+'/builds',netlifyToken,'POST');
  if(!build||!build.id)return block('Netlify accepted no build ID.');
  console.log('[koa production recovery] Requested one replacement build for exact SHA '+
    expected+'; build ID '+String(build.id)+'.');
}
main().catch(e=>block(e instanceof Error?e.message:'unexpected release recovery failure'));
