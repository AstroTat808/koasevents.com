#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const browser=String(process.env.RESPONSIVE_BROWSER||'').trim().toLowerCase();
const requestUrl=String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL||'').trim();
const requestToken=String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN||'').trim();

function fail(message){
  console.error('[koa responsive release evidence] BLOCKED: '+String(message||'verification failed').slice(0,300));
  process.exitCode=1;
}

async function main(){
  if(!['chromium','webkit'].includes(browser))return fail('browser must be chromium or webkit.');
  if(!requestUrl||!requestToken)return fail('GitHub Actions OIDC is unavailable.');

  const path='visual-results/browser-'+browser+'/report.json';
  let report;
  try{report=JSON.parse(await readFile(path,'utf8'));}catch{return fail('responsive browser report is unavailable.');}
  const results=Array.isArray(report?.results)?report.results:[];
  const viewportNames=[...new Set(results.map((row)=>String(row?.viewport||'').trim()).filter(Boolean))].sort();
  const payload={
    action:'record-responsive-visual-quality',
    checkedAt:new Date().toISOString(),
    browser,
    cases:Math.max(0,Number(report?.cases||results.length)||0),
    viewportNames,
    criticalCount:Math.max(0,Number(report?.criticalCount||0)||0),
    designCount:Math.max(0,Number(report?.designCount||0)||0),
    reportMissing:results.length===0||viewportNames.length===0,
  };
  if(payload.reportMissing||payload.criticalCount>0)return fail('responsive report is missing or contains release-blocking critical findings.');

  const oidcResponse=await fetch(requestUrl+'&audience=koasevents-system-health',{
    headers:{Authorization:'Bearer '+requestToken},
    signal:AbortSignal.timeout(15_000),
  });
  if(!oidcResponse.ok)return fail('GitHub OIDC request returned HTTP '+oidcResponse.status+'.');
  const oidc=await oidcResponse.json().catch(()=>({}));
  const token=String(oidc?.value||'').trim();
  if(!token)return fail('GitHub OIDC response did not contain an identity token.');

  const response=await fetch('https://koasevents.com/api/system-health/github-main-signal',{
    method:'POST',
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify(payload),
    signal:AbortSignal.timeout(60_000),
  });
  const body=await response.json().catch(()=>({}));
  if(!response.ok||body?.ok!==true||body?.recorded!==true)return fail('System Health rejected responsive evidence with HTTP '+response.status+'.');
  const stored=body?.responsiveQuality?.[browser]||{};
  if(stored?.browser!==browser||stored?.reportMissing!==false||Number(stored?.criticalCount||0)!==0){
    return fail('persisted responsive evidence is incomplete.');
  }
  console.log(
    '[koa responsive release evidence] PASS: '+browser+' · '+payload.cases+' cases · '+
    viewportNames.length+' viewports · 0 critical findings.'
  );
}

await main().catch((error)=>fail(error instanceof Error?error.message:'unexpected publication failure'));
