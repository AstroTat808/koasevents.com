import type { Config, Context } from '@netlify/functions';
import { createHash } from 'node:crypto';
import {
  applyHealthAlertPolicy,
  persistHealth,
  productionAccountingVerification,
  readLatestHealth,
  readLatestHourlyHealth,
  recordGithubMainSignal,
  recordProductionRelease,
  rollbackFailedProductionRelease,
  runSystemHealth,
  sendHealthTransitionAlerts,
  syntheticProbeReleaseVerification,
} from './_shared/system-health';

const ISSUER='https://token.actions.githubusercontent.com';
const AUDIENCE='koasevents-system-health';
const REPOSITORY='AstroTat808/koasevents.com';
const MAIN_REF='refs/heads/main';
const ROLLBACK_DRILL_SANDBOX_SITE_ID='fcc8fc59-68fb-46f3-bbd2-082a67718730';
const ROLLBACK_DRILL_SANDBOX_SITE_NAME='koasevents-rollback-drill-sandbox';

function base64UrlBytes(value:string){
  const normalized=value.replace(/-/g,'+').replace(/_/g,'/');
  const padded=normalized+'='.repeat((4-normalized.length%4)%4);
  const binary=atob(padded);
  return Uint8Array.from(binary,(char)=>char.charCodeAt(0));
}

function decodePart(value:string){
  return JSON.parse(new TextDecoder().decode(base64UrlBytes(value)));
}

function cleanText(value:unknown,max=500){
  return String(value||'').trim().slice(0,max);
}

async function netlifyJson(token:string,path:string,options:RequestInit={}){
  const response=await fetch('https://api.netlify.com/api/v1'+path,{
    ...options,
    headers:{
      Authorization:'Bearer '+token,
      Accept:'application/json',
      ...(options.headers||{}),
    },
    signal:options.signal||AbortSignal.timeout(15_000),
  });
  const text=await response.text();
  let body:any={};
  try{body=text?JSON.parse(text):{};}catch{body={message:text};}
  if(!response.ok){
    throw new Error('Netlify API '+path+' returned HTTP '+response.status+(body?.message?' · '+cleanText(body.message,300):''));
  }
  return {response,body};
}

async function waitForSandboxDeploy(token:string,deployId:string,timeoutMs=20_000){
  const started=Date.now();
  let lastState='';
  while(Date.now()-started<timeoutMs){
    const {body}=await netlifyJson(token,'/deploys/'+encodeURIComponent(deployId));
    lastState=String(body?.state||'');
    if(lastState==='ready'||lastState==='current')return body;
    if(lastState==='error')throw new Error('Sandbox deploy '+deployId+' entered the error state.');
    await new Promise((resolve)=>setTimeout(resolve,500));
  }
  throw new Error('Sandbox deploy '+deployId+' did not become ready within '+Math.ceil(timeoutMs/1000)+' seconds. Last state: '+(lastState||'unknown')+'.');
}

async function createSandboxStaticDeploy(token:string,siteId:string,html:string,label:string){
  const sha=createHash('sha1').update(html).digest('hex');
  const {body}=await netlifyJson(token,'/sites/'+encodeURIComponent(siteId)+'/deploys',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({files:{'/index.html':sha}}),
  });
  const deployId=cleanText(body?.id,120);
  if(!deployId)throw new Error('Netlify did not return a deploy id for '+label+'.');
  const required=Array.isArray(body?.required)?body.required.map((value:any)=>String(value)):[];
  if(required.includes(sha)){
    const response=await fetch('https://api.netlify.com/api/v1/deploys/'+encodeURIComponent(deployId)+'/files/index.html',{
      method:'PUT',
      headers:{
        Authorization:'Bearer '+token,
        'Content-Type':'application/octet-stream',
      },
      body:html,
      signal:AbortSignal.timeout(15_000),
    });
    if(!response.ok){
      const detail=await response.text().catch(()=>'');
      throw new Error('Unable to upload '+label+' index.html · HTTP '+response.status+(detail?' · '+cleanText(detail,300):''));
    }
  }
  const ready=await waitForSandboxDeploy(token,deployId);
  return {deployId,sha,state:String(ready?.state||''),label};
}

async function latestPublishedSandboxDeploy(token:string,siteId:string){
  const {body}=await netlifyJson(token,'/sites/'+encodeURIComponent(siteId)+'/deploys?latest-published=true&per_page=1');
  const row=Array.isArray(body)?body[0]:null;
  return {
    deployId:cleanText(row?.id,120),
    state:cleanText(row?.state,40),
    publishedAt:cleanText(row?.published_at,80),
  };
}

async function waitForPublishedSandboxDeploy(token:string,siteId:string,expectedDeployId:string,timeoutMs=12_000){
  const started=Date.now();
  let latest={deployId:'',state:'',publishedAt:''};
  while(Date.now()-started<timeoutMs){
    latest=await latestPublishedSandboxDeploy(token,siteId);
    if(latest.deployId===expectedDeployId)return latest;
    await new Promise((resolve)=>setTimeout(resolve,500));
  }
  throw new Error('Sandbox site did not publish expected deploy '+expectedDeployId+' within '+Math.ceil(timeoutMs/1000)+' seconds. Latest: '+(latest.deployId||'none')+'.');
}

async function runRealSandboxRollbackDrill(context:Context,claims:any){
  const token=cleanText(Netlify.env.get('NETLIFY_AUTH_TOKEN'),500);
  const sandboxSiteId=ROLLBACK_DRILL_SANDBOX_SITE_ID;
  const expectedName=ROLLBACK_DRILL_SANDBOX_SITE_NAME;
  const productionSiteId=cleanText(context.site?.id||Netlify.env.get('SITE_ID'),120);
  if(!token)throw new Error('NETLIFY_AUTH_TOKEN is unavailable to the sandbox rollback drill.');
  if(sandboxSiteId===productionSiteId)throw new Error('Rollback drill sandbox site id matches production; drill blocked.');

  const {body:site}=await netlifyJson(token,'/sites/'+encodeURIComponent(sandboxSiteId));
  if(String(site?.id||'')!==sandboxSiteId)throw new Error('Netlify returned an unexpected sandbox site id.');
  if(String(site?.name||'')!==expectedName)throw new Error('Rollback drill site name mismatch; expected '+expectedName+'.');
  if(String(site?.custom_domain||'').trim())throw new Error('Rollback drill sandbox must not have a custom production domain.');

  const runMarker=cleanText(String(claims?.run_id||Date.now())+'-'+String(claims?.sha||'').slice(0,12),80);
  const knownGoodHtml='<!doctype html><html><body><main data-rollback-drill="known-good" data-run="'+runMarker+'">Known good rollback drill release</main></body></html>';
  const candidateHtml='<!doctype html><html><body><main data-rollback-drill="candidate-failure" data-run="'+runMarker+'">Deliberate rollback drill candidate</main></body></html>';

  const knownGood=await createSandboxStaticDeploy(token,sandboxSiteId,knownGoodHtml,'known-good sandbox release');
  const afterKnownGood=await waitForPublishedSandboxDeploy(token,sandboxSiteId,knownGood.deployId);

  const candidate=await createSandboxStaticDeploy(token,sandboxSiteId,candidateHtml,'candidate sandbox release');
  const beforeRestore=await waitForPublishedSandboxDeploy(token,sandboxSiteId,candidate.deployId);

  const {response:restoreResponse,body:restoreBody}=await netlifyJson(
    token,
    '/sites/'+encodeURIComponent(sandboxSiteId)+'/deploys/'+encodeURIComponent(knownGood.deployId)+'/restore',
    {method:'POST'},
  );
  const restored=await waitForPublishedSandboxDeploy(token,sandboxSiteId,knownGood.deployId);

  return {
    ok:true,
    mode:'real-netlify-sandbox-restore',
    isolationVerified:true,
    sandboxSiteId,
    sandboxSiteName:String(site?.name||''),
    sandboxUrl:String(site?.ssl_url||site?.url||''),
    productionSiteId,
    productionMutationAttempted:false,
    sandboxMutationAttempted:true,
    runMarker,
    knownGood,
    candidate,
    beforeRestore,
    restore:{
      httpStatus:restoreResponse.status,
      restoredDeployId:cleanText(restoreBody?.id,120)||knownGood.deployId,
      state:cleanText(restoreBody?.state,40),
    },
    afterRestore:restored,
    phases:[
      {phase:'known-good-deploy',ok:afterKnownGood.deployId===knownGood.deployId},
      {phase:'candidate-deploy',ok:beforeRestore.deployId===candidate.deployId},
      {phase:'real-restore',ok:restoreResponse.status===201||restoreResponse.status===200},
      {phase:'recovery',ok:restored.deployId===knownGood.deployId},
    ],
  };
}

async function verifyGithubOidc(token:string){
  const parts=token.split('.');
  if(parts.length!==3)throw new Error('Malformed OIDC token.');
  const [encodedHeader,encodedPayload,encodedSignature]=parts;
  const header:any=decodePart(encodedHeader);
  const payload:any=decodePart(encodedPayload);
  if(header?.alg!=='RS256'||!header?.kid)throw new Error('Unsupported OIDC signing key.');
  if(payload?.iss!==ISSUER)throw new Error('Unexpected OIDC issuer.');
  const audience=Array.isArray(payload?.aud)?payload.aud:[payload?.aud];
  if(!audience.includes(AUDIENCE))throw new Error('Unexpected OIDC audience.');
  const now=Math.floor(Date.now()/1000);
  if(!Number.isFinite(Number(payload?.iat))||!Number.isFinite(Number(payload?.exp)))throw new Error('OIDC token timestamps are missing.');
  if(Number(payload.iat)>now+60||Number(payload.exp)<now-30)throw new Error('OIDC token is not currently valid.');
  if(payload?.repository!==REPOSITORY)throw new Error('Unexpected GitHub repository.');
  if(payload?.ref!==MAIN_REF)throw new Error('Only the main branch can update production GitHub health.');
  if(!/^[a-f0-9]{40}$/i.test(String(payload?.sha||'')))throw new Error('GitHub SHA claim is invalid.');

  const jwksResponse=await fetch(ISSUER+'/.well-known/jwks',{signal:AbortSignal.timeout(8_000)});
  if(!jwksResponse.ok)throw new Error('Unable to load GitHub OIDC signing keys.');
  const jwks:any=await jwksResponse.json();
  const jwk=(jwks?.keys||[]).find((item:any)=>item?.kid===header.kid&&item?.kty==='RSA');
  if(!jwk)throw new Error('GitHub OIDC signing key was not found.');

  const key=await crypto.subtle.importKey(
    'jwk',
    jwk,
    {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},
    false,
    ['verify'],
  );
  const verified=await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlBytes(encodedSignature),
    new TextEncoder().encode(encodedHeader+'.'+encodedPayload),
  );
  if(!verified)throw new Error('GitHub OIDC signature verification failed.');
  return payload;
}

export default async (req:Request,context:Context) => {
  if(req.method!=='POST')return new Response('Method not allowed',{status:405,headers:{Allow:'POST','Cache-Control':'no-store'}});
  const authorization=String(req.headers.get('authorization')||'');
  const token=authorization.startsWith('Bearer ')?authorization.slice(7).trim():'';
  if(!token)return Response.json({error:'GitHub OIDC bearer token required.'},{status:401,headers:{'Cache-Control':'no-store'}});

  try{
    const claims:any=await verifyGithubOidc(token);
    const result=await recordGithubMainSignal(context,{
      sha:String(claims.sha||''),
      repository:String(claims.repository||''),
      ref:String(claims.ref||''),
      workflow:String(claims.workflow||claims.job_workflow_ref||''),
      actor:String(claims.actor||''),
      runId:String(claims.run_id||claims.run_number||''),
      issuedAt:Number(claims.iat||0),
      expiresAt:Number(claims.exp||0),
      reportedAt:new Date().toISOString(),
      source:'github-actions-oidc',
    });

    const body:any=await req.json().catch(()=>({}));

    if(body?.action==='run-real-sandbox-rollback-drill'){
      const deployedCommit=String(Netlify.env.get('COMMIT_REF')||'').trim();
      if(deployedCommit&&deployedCommit!==String(claims.sha||'')){
        return Response.json({
          error:'Production control plane is not serving the requesting GitHub commit.',
          expected:String(claims.sha||''),
          deployed:deployedCommit,
        },{status:409,headers:{'Cache-Control':'no-store'}});
      }
      try{
        const sandboxRollbackDrill=await runRealSandboxRollbackDrill(context,claims);
        return Response.json({
          ok:Boolean(sandboxRollbackDrill?.ok),
          accepted:result.accepted,
          sha:result.signal.sha,
          source:'github-actions-oidc',
          sandboxRollbackDrill,
        },{status:sandboxRollbackDrill?.ok?200:503,headers:{'Cache-Control':'no-store'}});
      }catch(error){
        return Response.json({
          error:error instanceof Error?error.message:'Real sandbox rollback drill failed.',
          accepted:result.accepted,
          sha:result.signal.sha,
          source:'github-actions-oidc',
        },{status:502,headers:{'Cache-Control':'no-store'}});
      }
    }

    if(body?.action==='verify-synthetic-probes'||body?.action==='verify-production-health'){
      const deployedCommit=String(Netlify.env.get('COMMIT_REF')||'').trim();
      if(deployedCommit&&deployedCommit!==String(claims.sha||'')){
        return Response.json({
          error:'Production is not serving the requesting GitHub commit.',
          expected:String(claims.sha||''),
          deployed:deployedCommit,
        },{status:409,headers:{'Cache-Control':'no-store'}});
      }

      const [previous,previousHourly]=await Promise.all([
        readLatestHealth(context),
        readLatestHourlyHealth(context),
      ]);
      const health=await runSystemHealth(context,'post-deploy');
      await applyHealthAlertPolicy(context,health,previousHourly);
      await persistHealth(context,health);
      await sendHealthTransitionAlerts(previous,health);

      const deploymentSyncCheck:any=health.checks.find((row:any)=>String(row?.id||'')==='netlify-github-sync')||null;
      const deployId=String(
        deploymentSyncCheck?.deploymentDetails?.netlifyDeployId
        || Netlify.env.get('DEPLOY_ID')
        || ''
      ).trim();
      const syntheticProbeVerification=syntheticProbeReleaseVerification(health,'github-actions-oidc');
      const probes=syntheticProbeVerification.probes;
      const probesVerified=syntheticProbeVerification.status==='passed'
        && probes.length===4
        && probes.every((row:any)=>row.ok&&row.status===204&&row.source==='live'&&row.marker===row.expectedMarker);

      const accountingVerification=productionAccountingVerification(health);
      const accountingInvariant=accountingVerification.invariant;
      const accountingVerified=Boolean(accountingVerification.accountingVerified);

      let auditRecorded=false;
      let auditError='';
      try{
        const releaseRecord=await recordProductionRelease(context,{
          deployId,
          commit:String(claims.sha||''),
          checkedAt:health.checkedAt,
          syntheticProbeVerification,
          accountingVerification,
        });
        auditRecorded=Boolean(
          releaseRecord?.deployId
          && releaseRecord?.syntheticProbeVerification?.checkedAt===health.checkedAt
          && releaseRecord?.accountingVerification?.checkedAt===health.checkedAt
        );
        if(!auditRecorded)auditError='Production deploy id or same-run probe/accounting verification could not be persisted.';
      }catch(error){
        auditError=error instanceof Error?error.message:'Unable to persist production release verification audit.';
      }

      const rollbackProtection=!probesVerified
        ? await rollbackFailedProductionRelease(context,{
            deployId,
            commit:String(claims.sha||''),
            syntheticProbeVerification,
          })
        : null;

      const requireAccounting=body?.action==='verify-production-health';
      const verified=probesVerified&&(!requireAccounting||accountingVerified);
      const ok=verified&&auditRecorded;
      return Response.json({
        ok,
        verified,
        auditRecorded,
        auditError,
        accepted:result.accepted,
        sha:result.signal.sha,
        deployId,
        source:'github-actions-oidc',
        checkedAt:health.checkedAt,
        probes,
        accountingInvariant,
        accountingVerification,
        rollbackProtection,
      },{
        status:ok?200:503,
        headers:{'Cache-Control':'no-store'},
      });
    }

    return Response.json({ok:true,accepted:result.accepted,sha:result.signal.sha,source:'github-actions-oidc'},{headers:{'Cache-Control':'no-store'}});
  }catch(error){
    return Response.json({error:error instanceof Error?error.message:'GitHub OIDC verification failed.'},{status:403,headers:{'Cache-Control':'no-store'}});
  }
};

export const config:Config={
  path:'/api/system-health/github-main-signal',
};
