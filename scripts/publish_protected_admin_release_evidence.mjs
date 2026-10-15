#!/usr/bin/env node
// Post-deploy GitHub Actions only. Never emit tokens, URLs with query strings,
// customer information, or raw browser responses to stdout/stderr.
import {readFileSync} from 'node:fs';

function block(code){console.error('[koa protected admin QA] '+code);process.exitCode=1;}
try{
  const file=process.argv[2];
  const sha=String(process.env.GITHUB_SHA||'');
  const source=String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL||'');
  const secret=String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN||'');
  if(file!=='/tmp/koa-admin-qa.safe.json'||!/^[a-f0-9]{40}$/.test(sha)||!source||!secret)
    throw Error('ADMIN_QA_SIGNED_IDENTITY_REQUIRED');
  const result=JSON.parse(readFileSync(file,'utf8'));
  // The report was produced by the allowlisted sanitizer; enforce a second,
  // smaller wire contract so even a compromised report cannot serialize PII.
  if(!result||typeof result.ok!=='boolean'
    ||!Number.isSafeInteger(result.totalFailures)
    ||!Array.isArray(result.failures)||result.failures.length>150
    ||Object.keys(result).some(k=>!['ok','totalFailures','failures','code'].includes(k))
    ||result.failures.some(x=>!x||!/^([a-z0-9-]{1,64})$/.test(x.route)
      ||!/^ADMIN_QA_[A-Z0-9_]{4,70}$/.test(x.code)
      ||Object.keys(x).sort().join(',')!=='code,route'))
    throw Error('ADMIN_QA_UNSAFE_SUMMARY');
  const oidc=new URL(source);
  oidc.searchParams.set('audience','koasevents-system-health');
  const issue=await fetch(oidc,{headers:{Authorization:'Bearer '+secret},
    signal:AbortSignal.timeout(15000)});
  if(!issue.ok)throw Error('ADMIN_QA_OIDC_ISSUANCE_FAILED');
  const credential=String((await issue.json())?.value||'');
  if(!credential)throw Error('ADMIN_QA_OIDC_ISSUANCE_FAILED');
  const response=await fetch('https://koasevents.com/api/system-health/github-main-signal',{
    method:'POST',headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json'},
    body:JSON.stringify({action:'record-protected-admin-qa',result}),
    signal:AbortSignal.timeout(45000),
  });
  const status=await response.json().catch(()=>null);
  if(response.status!==200||status?.ok!==true||status?.recorded!==true
    ||status.sha!==sha||!(/^[a-f0-9]{24}$/.test(String(status.deployId||'')))
    ||!(/^[0-9]{4,20}$/.test(String(status.runId||'')))
    ||status.failureCount!==result.totalFailures
    ||status.qaStatus!==(result.ok?'passed':'failed'))
    throw Error('ADMIN_QA_DURABLE_READBACK_FAILED');
  console.log('[koa protected admin QA] signed per-deploy history recorded; status='+
    (result.ok?'passed':'failed')+', failures='+result.totalFailures);
}catch{
  block('ADMIN_QA_EVIDENCE_PERSISTENCE_FAILED');
}
