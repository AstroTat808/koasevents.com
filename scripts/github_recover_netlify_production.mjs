#!/usr/bin/env node
// Trusted GitHub Actions fallback for the production Netlify control plane.
// This script does not call any function on the live site, so it works when
// Netlify is still serving an older recovery handler.
import { planProductionDeployRecovery } from '../netlify/functions/_shared/production-deploy-recovery.mjs';

const REPO='AstroTat808/koasevents.com';
const SITE_ID='d1f3ab06-be2a-41c4-b770-59e6a6acd1b9';
const SITE_NAME='koasevents-website';
const SHA_PATTERN=/^[a-f0-9]{40}$/i;

function assert(value,message){if(!value)throw new Error(message);}

function normalizeDeploys(rows,expectedSha){
  assert(Array.isArray(rows),'Netlify deployment history must be an array.');
  return rows.filter((row)=>{
    const sha=String(row?.commit_ref||row?.commit||row?.branch_commit||'').toLowerCase();
    return sha===expectedSha && row?.context==='production';
  });
}

function selfTest(){
  const sha='a'.repeat(40);
  const rows=[
    {id:'wrong-commit',commit_ref:'b'.repeat(40),context:'production',state:'ready'},
    {id:'preview',commit_ref:sha,context:'deploy-preview',state:'ready'},
    {id:'failed',commit_ref:sha,context:'production',state:'error'},
  ];
  const matches=normalizeDeploys(rows,sha);
  assert(matches.length===1&&matches[0].id==='failed','Failed to bind deploy history to exact production SHA.');
  assert(planProductionDeployRecovery(matches).action==='rebuild','A failed first build must be retried.');
  assert(planProductionDeployRecovery([...matches,{...matches[0],id:'recovery-failed'}]).action==='block',
    'Automatic recovery may not spin after a second failed build.');
  assert(planProductionDeployRecovery([...matches,{...matches[0],id:'active',state:'building'}]).action==='reuse',
    'An active exact-SHA build must not be duplicated.');
  assert(planProductionDeployRecovery([...matches,{...matches[0],id:'unknown',state:'mystery'}]).action==='block',
    'Unknown exact-SHA state must fail closed.');
  console.log('PASS | trusted GitHub-owned Netlify recovery: exact SHA, production context, bounded retry and active-build reuse.');
}

async function readJson(url,token,method='GET'){
  const headers={'Accept':'application/json','User-Agent':'koa-exact-sha-netlify-recovery'};
  if(token)headers.Authorization='Bearer '+token;
  const result=await fetch(url,{method,headers,signal:AbortSignal.timeout(20_000)});
  // Do not echo raw API bodies: remote services may attach private metadata.
  if(!result.ok)throw new Error(new URL(url).pathname+' returned HTTP '+result.status);
  const body=await result.json();
  assert(body!==null&&typeof body==='object','API returned an invalid JSON payload.');
  return body;
}

async function readMainSha(token){
  const body=await readJson('https://api.github.com/repos/'+REPO+'/branches/main',token);
  const sha=String(body?.commit?.sha||'').toLowerCase();
  assert(SHA_PATTERN.test(sha),'GitHub returned an invalid main SHA.');
  return sha;
}

async function run(){
  assert(process.env.GITHUB_ACTIONS==='true','Recovery is restricted to GitHub Actions.');
  assert(process.env.GITHUB_REPOSITORY===REPO,'Repository does not match the production release.');
  assert(process.env.GITHUB_EVENT_NAME==='push'&&process.env.GITHUB_REF==='refs/heads/main',
    'Recovery is restricted to a trusted push on protected main; no PR code can invoke Netlify recovery.');
  const expectedSha=String(process.env.GITHUB_SHA||'').toLowerCase();
  assert(SHA_PATTERN.test(expectedSha),'A complete expected production SHA is required.');
  const githubToken=String(process.env.GITHUB_TOKEN||'').trim();
  const netlifyToken=String(process.env.NETLIFY_AUTH_TOKEN||'').trim();
  assert(githubToken,'GITHUB_TOKEN unavailable; refusing unauthenticated GitHub main check.');
  assert(netlifyToken,
    'GitHub Actions secret NETLIFY_AUTH_TOKEN (or NETLIFY_API_TOKEN) is required for GitHub-owned recovery; the old production function is not used.');

  assert(await readMainSha(githubToken)===expectedSha,
    'GitHub main advanced before recovery; refusing to deploy a stale SHA.');

  const base='https://api.netlify.com/api/v1';
  const site=await readJson(base+'/sites/'+SITE_ID,netlifyToken);
  assert(site?.id===SITE_ID&&site?.name===SITE_NAME,
    'Netlify credentials resolved to the wrong production site.');
  const siteDomain=String(site?.custom_domain||'').toLowerCase();
  assert(!siteDomain||siteDomain==='koasevents.com','Netlify production domain does not match expected site.');

  const allDeploys=await readJson(base+'/sites/'+SITE_ID+'/deploys?per_page=100',netlifyToken);
  const exact=normalizeDeploys(allDeploys,expectedSha);
  let plan=planProductionDeployRecovery(exact);
  if(plan.action==='block')throw new Error('Recovery blocked: '+plan.reason+'; failed exact-SHA builds '+plan.failedCount+'.');
  if(plan.action==='reuse'){
    console.log(JSON.stringify({ok:true,triggered:false,expectedSha,deployId:plan.deploy?.id||'',
      state:plan.deploy?.state||'',reason:plan.reason}));
    return;
  }

  // Double-check latest main AND Netlify history immediately before mutation:
  // GitHub's /builds endpoint always builds whatever main currently points to.
  assert(await readMainSha(githubToken)===expectedSha,
    'GitHub main advanced during recovery; refusing to trigger a stale build.');
  const recent=await readJson(base+'/sites/'+SITE_ID+'/deploys?per_page=100',netlifyToken);
  plan=planProductionDeployRecovery(normalizeDeploys(recent,expectedSha));
  if(plan.action==='block')throw new Error('Recovery blocked on recheck: '+plan.reason);
  if(plan.action==='reuse'){
    console.log(JSON.stringify({ok:true,triggered:false,expectedSha,deployId:plan.deploy?.id||'',
      state:plan.deploy?.state||'',reason:'in-flight recheck: '+plan.reason}));
    return;
  }

  const build=await readJson(base+'/sites/'+SITE_ID+'/builds',netlifyToken,'POST');
  const buildId=String(build?.id||'');
  assert(buildId,'Netlify did not return a build ID; recovery cannot be attested.');
  console.log(JSON.stringify({ok:true,triggered:true,expectedSha,siteId:SITE_ID,
    failedDeployCount:plan.failedCount,buildId,reason:plan.reason}));
}

if(process.argv.includes('--self-test'))selfTest();
else run().catch(error=>{console.error('[koa GitHub Netlify recovery] '+(error?.message||String(error)));process.exitCode=1;});
