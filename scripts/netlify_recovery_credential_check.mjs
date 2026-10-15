#!/usr/bin/env node
// Read-only authentication probe for the GitHub-owned Netlify recovery credential.
// It deliberately performs no deploy, build, restore, environment, or site mutation.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const token=String(process.env.NETLIFY_AUTH_TOKEN||'').trim();
const siteId=String(process.env.NETLIFY_SITE_ID||'').trim();
const outputPath=String(process.env.NETLIFY_RECOVERY_CREDENTIAL_REPORT||'visual-results/netlify-recovery-credential.json').trim();

const report={
  checkedAt:new Date().toISOString(),
  status:'failed',
  configured:Boolean(token),
  usable:false,
  siteId,
  siteName:'',
  siteIdMatches:false,
  siteHttpStatus:0,
  deployListHttpStatus:0,
  source:'github-actions-read-only',
};

function safeError(message){
  return String(message||'').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,300);
}

async function writeReport(){
  await mkdir(dirname(outputPath),{recursive:true});
  await writeFile(outputPath,JSON.stringify(report,null,2)+'\n','utf8');
}

async function getJson(url){
  const response=await fetch(url,{
    method:'GET',
    headers:{
      Authorization:'Bearer '+token,
      Accept:'application/json',
      'User-Agent':'koasevents-recovery-credential-check',
    },
    signal:AbortSignal.timeout(20_000),
  });
  let body=null;
  try{body=await response.json();}catch{}
  return {response,body};
}

async function main(){
  if(!token||!siteId){
    await writeReport();
    console.error('[koa recovery credential] BLOCKED: required GitHub Actions Netlify credential or site id is unavailable.');
    process.exitCode=1;
    return;
  }

  try{
    const siteResult=await getJson('https://api.netlify.com/api/v1/sites/'+encodeURIComponent(siteId));
    report.siteHttpStatus=siteResult.response.status;
    report.siteName=String(siteResult.body?.name||'').slice(0,120);
    report.siteIdMatches=String(siteResult.body?.id||'')===siteId;

    const deployResult=await getJson(
      'https://api.netlify.com/api/v1/sites/'+encodeURIComponent(siteId)+'/deploys?per_page=1'
    );
    report.deployListHttpStatus=deployResult.response.status;
    const deployListReadable=deployResult.response.ok&&Array.isArray(deployResult.body);

    report.usable=Boolean(siteResult.response.ok&&report.siteIdMatches&&deployListReadable);
    report.status=report.usable?'passed':'failed';
    await writeReport();

    if(!report.usable){
      console.error(
        '[koa recovery credential] BLOCKED: read-only Netlify authentication/site authorization failed '+
        '(site HTTP '+report.siteHttpStatus+', deploy-list HTTP '+report.deployListHttpStatus+').'
      );
      process.exitCode=1;
      return;
    }

    console.log(
      '[koa recovery credential] PASS: GitHub-owned Netlify credential authenticated read-only access to '+
      (report.siteName||'the configured site')+'; no production mutation was performed.'
    );
  }catch(error){
    await writeReport();
    console.error('[koa recovery credential] BLOCKED: '+safeError(error instanceof Error?error.message:'read-only Netlify authentication failed.'));
    process.exitCode=1;
  }
}

await main();
