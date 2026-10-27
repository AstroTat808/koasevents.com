#!/usr/bin/env node
// GitHub-owned production bootstrap. Does not rely on the old deployed Netlify
// function: a failed deploy cannot publish its own fix.
import { spawnSync } from 'node:child_process';
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
function runCommand(command,args,env){
  const result=spawnSync(command,args,{stdio:'inherit',env});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(command+' exited with '+String(result.status)+'.');
}
async function manualCreditDeploy(){
  if((await githubMain())!==expected){
    return block('main advanced before external-CI deploy; stale SHA prevented.');
  }
  const env={
    ...process.env,
    CONTEXT:'production',
    COMMIT_REF:expected,
    BRANCH:'main',
    GITHUB_TOKEN:githubToken,
    GITHUB_RELEASE_GATE_TOKEN:githubToken,
    NETLIFY_AUTH_TOKEN:netlifyToken,
    NETLIFY_SITE_ID:siteId,
  };
  console.log('[koa production recovery] Netlify hosted build credits are exhausted; building the exact main SHA in GitHub Actions and uploading a manual production deploy.');
  runCommand('npm',['install','--no-audit','--no-fund'],env);
  if((await githubMain())!==expected){
    return block('main advanced after dependency installation; stale manual deploy prevented.');
  }
  runCommand('npx',[
    '--yes','netlify-cli@27.14.2','deploy',
    '--prod',
    '--context','production',
    '--site',siteId,
    '--message','GitHub exact-SHA credit fallback '+expected,
    '--created-via','github-actions-credit-recovery',
    '--skip-functions-cache',
    '--timeout','900',
    '--json',
  ],env);
  const deployments=await getJson(
    'https://api.netlify.com/api/v1/sites/'+encodeURIComponent(siteId)+'/deploys?per_page=100',
    netlifyToken,
  );
  const exactReady=(Array.isArray(deployments)?deployments:[]).find((row)=>
    String(row?.context||'').trim()==='production'
    &&String(row?.commit_ref||row?.commit||row?.branch_commit||'').trim().toLowerCase()===expected
    &&['ready','current'].includes(String(row?.state||'').trim().toLowerCase())
  );
  if(!exactReady){
    return block('external-CI deploy completed without a ready exact-SHA Netlify production record.');
  }
  console.log('[koa production recovery] External-CI deploy verified for exact SHA '+expected+
    '; deploy ID '+String(exactReady.id||'')+'.');
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
  if(plan.action==='manual-deploy')return manualCreditDeploy();
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
