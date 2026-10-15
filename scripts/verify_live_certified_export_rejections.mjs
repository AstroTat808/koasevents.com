#!/usr/bin/env node
// GitHub main Production Visual QA only. Never log OIDC tokens or response bodies.
const fail=(reason)=>{console.error('BLOCKED | production export rejection verification: '+reason);process.exitCode=1;};
const url=process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const secret=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
const sha=process.env.GITHUB_SHA;
if(!url||!secret||!/^[a-f0-9]{40}$/i.test(sha||'')){
  fail('signed main release identity unavailable');
}else{
  try{
    const tokenRequest=await fetch(url+'&audience=koasevents-system-health',{
      headers:{Authorization:'Bearer '+secret},signal:AbortSignal.timeout(12000),
    });
    if(!tokenRequest.ok)throw Error('OIDC issuance failed');
    const credential=(await tokenRequest.json()).value;
    if(!credential)throw Error('OIDC credential unavailable');
    const response=await fetch('https://koasevents.com/api/system-health/github-main-signal',{
      method:'POST',
      headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json'},
      body:JSON.stringify({action:'verify-certified-export-rejections'}),
      signal:AbortSignal.timeout(25000),
    });
    const result=await response.json().catch(()=>null);
    if(response.status!==200||result?.ok!==true||result.sha!==sha||
      !/^[a-f0-9]{24}$/i.test(String(result?.deployId||''))||
      result.readbackVerified!==true||!/^\d+$/.test(String(result.runId||''))||
      result.denied!==36||result.expected!==36||
      JSON.stringify(result.formats)!==JSON.stringify(['json','pdf'])){
      throw Error('production identity or 36/36 negative tests did not match');
    }
    // Exercise both real public-facing export routes without a session.
    // No bearer token, cookie, response payload or customer identifier is used.
    for(const format of ['pdf','json']){
      const denied=await fetch(
        'https://koasevents.com/api/admin/health?export=certified-release&format='+format,
        {redirect:'manual',signal:AbortSignal.timeout(15000)},
      );
      if(![401,403].includes(denied.status)
        ||denied.headers.get('content-disposition')?.includes('attachment')
        ||!String(denied.headers.get('cache-control')||'').includes('no-store')){
        throw Error('Anonymous '+format+' export was not blocked at the production HTTP boundary');
      }
    }
    console.log('PASS | exact-SHA production PDF/JSON security: 36/36 synthetic uncertified exports rejected; anonymous PDF/JSON HTTP access denied.');
  }catch{
    fail('signed exact-release verification failed; private details withheld');
  }
}
