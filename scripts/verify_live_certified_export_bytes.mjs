#!/usr/bin/env node
// Runs AFTER the final certified release attestation has been persisted.
// Uses GitHub main workflow OIDC, never admin cookies or raw customer payloads.
const fail=()=>{console.error('BLOCKED | production certified PDF/JSON serialized-byte verification failed; private content withheld.');process.exitCode=1;};
try{
  const sha=String(process.env.GITHUB_SHA||'');
  if(!/^[a-f0-9]{40}$/.test(sha)||!process.env.ACTIONS_ID_TOKEN_REQUEST_URL
    ||!process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)throw Error('OIDC identity missing');
  const uri=new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  uri.searchParams.set('audience','koasevents-system-health');
  const tokenResponse=await fetch(uri,{headers:{
    Authorization:'Bearer '+process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  },signal:AbortSignal.timeout(15000)});
  if(!tokenResponse.ok)throw Error('OIDC issuance failed');
  const credential=String((await tokenResponse.json())?.value||'');
  if(!credential)throw Error('OIDC credential unavailable');
  const response=await fetch('https://koasevents.com/api/system-health/github-main-signal',{
    method:'POST',headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json'},
    body:JSON.stringify({action:'verify-certified-export-artifact-bytes'}),
    signal:AbortSignal.timeout(30000),
  });
  const result=await response.json().catch(()=>null);
  if(response.status!==200||result?.ok!==true||result.sha!==sha
    ||result.pdfValidated!==true||result.jsonValidated!==true
    ||result.caseCount!==36||!(/^[a-f0-9]{24}$/.test(String(result.deployId||'')))
    ||!(/^[0-9]{4,20}$/.test(String(result.runId||'')))
    ||result.code!=='EXPORT_ATTESTATION_PDF_JSON_VERIFIED')
    throw Error('Exact release serialized bytes not verified');
  console.log('PASS | deployed certified JSON and PDF serializers contain 36 identical signed case IDs; SHA and deploy identity verified.');
}catch{fail();}
