#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const reportPath=String(process.env.NETLIFY_RECOVERY_CREDENTIAL_REPORT||'visual-results/netlify-recovery-credential.json');
const requestUrl=String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL||'').trim();
const requestToken=String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN||'').trim();

function fail(message){
  console.error('[koa recovery credential health] BLOCKED: '+String(message||'verification failed').slice(0,300));
  process.exitCode=1;
}

async function main(){
  if(!requestUrl||!requestToken)return fail('GitHub Actions OIDC is unavailable.');
  let report;
  try{report=JSON.parse(await readFile(reportPath,'utf8'));}catch{return fail('read-only credential report is unavailable.');}
  if(report?.usable!==true||report?.configured!==true)return fail('read-only credential verification did not pass.');

  const oidcResponse=await fetch(requestUrl+'&audience=koasevents-system-health',{
    headers:{Authorization:'Bearer '+requestToken},
    signal:AbortSignal.timeout(15_000),
  });
  if(!oidcResponse.ok)return fail('GitHub OIDC request returned HTTP '+oidcResponse.status+'.');
  const oidc=await oidcResponse.json().catch(()=>({}));
  const token=String(oidc?.value||'').trim();
  if(!token)return fail('GitHub OIDC response did not contain an identity token.');

  const payload={action:'record-netlify-recovery-credential',...report};
  const response=await fetch('https://koasevents.com/api/system-health/github-main-signal',{
    method:'POST',
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify(payload),
    signal:AbortSignal.timeout(60_000),
  });
  const body=await response.json().catch(()=>({}));
  if(!response.ok||body?.ok!==true||body?.recorded!==true)return fail('System Health rejected credential verification with HTTP '+response.status+'.');
  const verification=body?.verification||{};
  if(
    verification?.configured!==true||verification?.usable!==true||verification?.siteIdMatches!==true
    ||Number(verification?.siteHttpStatus)!==200||Number(verification?.deployListHttpStatus)!==200
  )return fail('persisted recovery credential evidence is incomplete.');

  console.log('[koa recovery credential health] PASS: safe verification metadata persisted; secret material was not transmitted.');
}

await main().catch((error)=>fail(error instanceof Error?error.message:'unexpected publication failure'));
