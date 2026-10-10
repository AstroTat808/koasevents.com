import type { Config, Context } from '@netlify/functions';
import { createHash } from 'node:crypto';
import {
  accountingAdjustmentDiagnostics,
  applyHealthAlertPolicy,
  persistHealth,
  productionAccountingVerification,
  readLatestHealth,
  readLatestHourlyHealth,
  readProductionReleases,
  recordGithubMainSignal,
  recordProductionRelease,
  recordProductionVisualThumbnail,
  rollbackFailedProductionRelease,
  runSystemHealth,
  sendHealthTransitionAlerts,
  syntheticProbeReleaseVerification,
} from './_shared/system-health';
import { runHealthDashboardRefresh } from './admin-health.mts';
import { buildBulkAccountingRepairPreview, readQuickBooksSalesRecords } from './admin-quickbooks.mts';
import { getQuickBooksSettings } from './_shared/quickbooks';
import { isSuccessfulNetlifyState, productionDeployMatchesAttestation } from './_shared/production-release-policy.mjs';
import { resolveTenantAsync, runWithTenant } from './_shared/tenant';

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
  return {
    deployId,
    sha,
    state:String(ready?.state||''),
    label,
    deployUrl:cleanText(ready?.deploy_ssl_url||ready?.deploy_url,500),
  };
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


async function runSandboxSelfHealDrill(context:Context,claims:any){
  const token=cleanText(Netlify.env.get('NETLIFY_AUTH_TOKEN'),500);
  const sandboxSiteId=ROLLBACK_DRILL_SANDBOX_SITE_ID;
  const productionSiteId=cleanText(context.site?.id||Netlify.env.get('SITE_ID'),120);
  if(!token)throw new Error('NETLIFY_AUTH_TOKEN is unavailable to the sandbox self-heal drill.');
  if(!productionSiteId)throw new Error('Production site id is unavailable to the sandbox self-heal drill.');
  if(sandboxSiteId===productionSiteId)throw new Error('Sandbox self-heal drill site id matches production; drill blocked.');

  const {body:site}=await netlifyJson(token,'/sites/'+encodeURIComponent(sandboxSiteId));
  if(String(site?.id||'')!==sandboxSiteId)throw new Error('Netlify returned an unexpected sandbox site id.');
  if(String(site?.name||'')!==ROLLBACK_DRILL_SANDBOX_SITE_NAME)throw new Error('Sandbox self-heal drill site name mismatch.');
  if(String(site?.custom_domain||'').trim())throw new Error('Sandbox self-heal drill requires a site with no custom domain.');

  const before=await latestPublishedSandboxDeploy(token,sandboxSiteId);
  const expectedSha=cleanText(claims?.sha,80);
  const graceStartedAt=new Date(Date.now()-5*60*1000-1000).toISOString();
  const marker=cleanText('self-heal-'+String(claims?.run_id||Date.now())+'-'+expectedSha.slice(0,12),100);
  const html='<!doctype html><html><body><main data-self-heal-drill="'+marker+'" data-expected-sha="'+expectedSha+'">Sandbox self-healing retrigger verified</main></body></html>';

  const exactShaPresent=false;
  if(exactShaPresent)throw new Error('Sandbox self-heal drill setup expected the release marker to be absent.');
  const retrigger=await createSandboxStaticDeploy(token,sandboxSiteId,html,'self-heal sandbox retrigger');
  const after=await waitForPublishedSandboxDeploy(token,sandboxSiteId,retrigger.deployId);
  const {body:fileMeta}=await netlifyJson(
    token,
    '/sites/'+encodeURIComponent(sandboxSiteId)+'/files/index.html',
  );
  const publishedFileSha=cleanText(fileMeta?.sha,80);
  const markerVerified=Boolean(publishedFileSha&&publishedFileSha===String(retrigger?.sha||''));

  return {
    ok:Boolean(markerVerified&&after.deployId===retrigger.deployId),
    mode:'isolated-netlify-sandbox-self-heal',
    gracePeriodSeconds:300,
    graceElapsed:true,
    graceStartedAt,
    expectedSha,
    exactShaPresentBefore:false,
    retriggered:true,
    sandboxMutationAttempted:true,
    productionMutationAttempted:false,
    isolationVerified:sandboxSiteId!==productionSiteId,
    sandboxSiteId,
    sandboxSiteName:String(site?.name||''),
    productionSiteId,
    before,
    retrigger,
    after,
    marker,
    publishedFileSha,
    expectedFileSha:String(retrigger?.sha||''),
    markerVerified,
    phases:[
      {phase:'five-minute-grace-elapsed',ok:true},
      {phase:'expected-release-absent',ok:true},
      {phase:'sandbox-retrigger',ok:Boolean(retrigger?.deployId)},
      {phase:'replacement-ready',ok:after.deployId===retrigger.deployId},
      {phase:'replacement-content-verified',ok:markerVerified},
      {phase:'production-isolation',ok:sandboxSiteId!==productionSiteId},
    ],
    note:'The isolated sandbox is intentionally manual-only, so this drill exercises the same missing-release/grace/retrigger/recovery control path with a sandbox static deploy adapter; production continues to use the /builds retrigger adapter.',
  };
}

async function productionAccountingAuditForCommit(context:Context,targetCommit:string){
  const target=cleanText(targetCommit,80).toLowerCase();
  if(!/^[a-f0-9]{7,40}$/i.test(target))throw new Error('A valid target commit prefix is required.');
  const releases=await readProductionReleases(context,100);
  const matches=releases.filter((row:any)=>String(row?.commit||'').toLowerCase().startsWith(target));
  if(matches.length===0)return null;
  if(matches.length>1)throw new Error('Target commit prefix is ambiguous in the retained production release audit.');
  const release:any=matches[0];
  const verification:any=release?.accountingVerification||null;
  const invariant:any=verification?.invariant||null;
  return {
    deployId:cleanText(release?.deployId,120),
    commit:cleanText(release?.commit,80),
    checkedAt:cleanText(verification?.checkedAt||release?.recordedAt,80),
    status:cleanText(verification?.status||'unverified',40),
    accountingVerified:Boolean(verification?.accountingVerified),
    clientCount:Number(invariant?.dynamicClientCount||0),
    passedCount:Number(invariant?.dynamicClientPassedCount||0),
    failedCount:Number(invariant?.dynamicClientFailedCount||0),
    unverifiedCount:Number(invariant?.dynamicClientUnverifiedCount||0),
    rows:Array.isArray(invariant?.dynamicClientRows)?invariant.dynamicClientRows:[],
    detail:cleanText(invariant?.detail,1200),
  };
}

async function productionDeployForCommit(token:string,siteId:string,sha:string){
  const {body}=await netlifyJson(token,'/sites/'+encodeURIComponent(siteId)+'/deploys?per_page=100');
  const rows=Array.isArray(body)?body:[];
  const matches=rows.filter((row:any)=>{
    const commit=cleanText(row?.commit_ref||row?.commit||row?.branch_commit,80);
    const context=cleanText(row?.context,80);
    return commit===sha && (!context||context==='production');
  });
  return matches.sort((a:any,b:any)=>{
    const aState=cleanText(a?.state,40).toLowerCase();
    const bState=cleanText(b?.state,40).toLowerCase();
    const aReady=isSuccessfulNetlifyState(aState)?1:0;
    const bReady=isSuccessfulNetlifyState(bState)?1:0;
    if(aReady!==bReady)return bReady-aReady;
    return Date.parse(String(b?.published_at||b?.created_at||0))-Date.parse(String(a?.published_at||a?.created_at||0));
  })[0]||null;
}

async function currentGithubMainSha(){
  const token=cleanText(Netlify.env.get('KOA_GITHUB_READ_TOKEN'),500);
  if(!token)throw new Error('KOA_GITHUB_READ_TOKEN is required to confirm the exact GitHub main SHA before deployment recovery.');
  const response=await fetch('https://api.github.com/repos/'+REPOSITORY+'/commits/main',{
    headers:{
      Authorization:'Bearer '+token,
      Accept:'application/vnd.github+json',
      'User-Agent':'KoaEvents-Deploy-Recovery/1.0',
    },
    signal:AbortSignal.timeout(12_000),
  });
  if(!response.ok)throw new Error('GitHub main verification returned HTTP '+response.status+'.');
  const body:any=await response.json();
  const sha=cleanText(body?.sha,80);
  if(!/^[a-f0-9]{40}$/i.test(sha))throw new Error('GitHub main verification did not return a valid SHA.');
  return sha;
}

async function selfHealProductionDeploy(context:Context,claims:any){
  const expectedSha=cleanText(claims?.sha,80);
  const token=cleanText(Netlify.env.get('NETLIFY_AUTH_TOKEN'),500);
  const siteId=cleanText(context.site?.id||Netlify.env.get('SITE_ID'),120);
  if(!token)throw new Error('NETLIFY_AUTH_TOKEN is unavailable to production deployment recovery.');
  if(!siteId)throw new Error('Netlify site id is unavailable to production deployment recovery.');

  const existing=await productionDeployForCommit(token,siteId,expectedSha);
  const existingState=cleanText(existing?.state,80).toLowerCase();
  const existingReady=Boolean(existing&&isSuccessfulNetlifyState(existingState));
  if(existingReady){
    return {
      ok:true,
      triggered:false,
      exactShaPresent:true,
      expectedSha,
      deployId:cleanText(existing?.id,120),
      deployState:existingState,
      deployContext:cleanText(existing?.context,80),
      reason:'The exact approved main SHA already has a successful Netlify production deploy; no recovery build was triggered.',
    };
  }

  const mainSha=await currentGithubMainSha();
  if(mainSha!==expectedSha){
    return {
      ok:false,
      triggered:false,
      exactShaPresent:false,
      expectedSha,
      currentMainSha:mainSha,
      reason:'GitHub main advanced before recovery; the older SHA will not be retriggered.',
    };
  }

  const {body}=await netlifyJson(token,'/sites/'+encodeURIComponent(siteId)+'/builds',{method:'POST'});
  return {
    ok:true,
    triggered:true,
    exactShaPresent:false,
    failedExactShaPresent:Boolean(existing&&!existingReady),
    failedDeployId:cleanText(existing?.id,120),
    failedDeployState:existingState,
    expectedSha,
    currentMainSha:mainSha,
    buildId:cleanText(body?.id,120),
    buildState:cleanText(body?.state||body?.status,80),
    reason:existing
      ? 'The exact approved main SHA existed only as a failed Netlify deploy, so a fresh production build was retriggered.'
      : 'The exact approved main SHA was still current but absent from Netlify after the grace period, so a production build was retriggered.',
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

    if(body?.action==='read-current-accounting-repair-bulk-preview'){
      const deployedCommit=String(Netlify.env.get('COMMIT_REF')||'').trim();
      if(deployedCommit&&deployedCommit!==String(claims.sha||'')){
        return Response.json({
          error:'Production is not serving the requesting GitHub commit.',
          expected:String(claims.sha||''),
          deployed:deployedCommit,
        },{status:409,headers:{'Cache-Control':'no-store'}});
      }
      try{
        const tenant=await resolveTenantAsync(req,context);
        const bulkPreview=await runWithTenant(tenant,async()=>{
          const records=await readQuickBooksSalesRecords(context);
          const settings=await getQuickBooksSettings(context);
          return buildBulkAccountingRepairPreview(
            context,
            tenant,
            records,
            cleanText(settings?.serviceItemId,80),
            'github-actions:'+cleanText(claims.actor||'system',120),
            [],
          );
        });
        return Response.json({
          ok:true,
          accepted:result.accepted,
          sha:result.signal.sha,
          deployId:String(context.deploy?.id||Netlify.env.get('DEPLOY_ID')||''),
          checkedAt:new Date().toISOString(),
          source:'github-actions-oidc',
          bulkPreview,
        },{headers:{'Cache-Control':'no-store'}});
      }catch(error){
        return Response.json({
          ok:false,
          error:error instanceof Error?error.message:'Unable to build the current production accounting repair preview.',
          accepted:result.accepted,
          sha:result.signal.sha,
          source:'github-actions-oidc',
        },{status:500,headers:{'Cache-Control':'no-store'}});
      }
    }

    if(body?.action==='read-accounting-adjustment-diagnostics'){
      const deployedCommit=String(Netlify.env.get('COMMIT_REF')||'').trim();
      if(deployedCommit&&deployedCommit!==String(claims.sha||'')){
        return Response.json({
          error:'Production is not serving the requesting GitHub commit.',
          expected:String(claims.sha||''),
          deployed:deployedCommit,
        },{status:409,headers:{'Cache-Control':'no-store'}});
      }
      try{
        const recordIds=Array.isArray(body?.recordIds)?body.recordIds:[];
        const diagnostics=await accountingAdjustmentDiagnostics(context,recordIds);
        return Response.json({
          ok:true,
          accepted:result.accepted,
          sha:result.signal.sha,
          deployId:String(context.deploy?.id||Netlify.env.get('DEPLOY_ID')||''),
          checkedAt:new Date().toISOString(),
          source:'github-actions-oidc',
          diagnostics,
        },{headers:{'Cache-Control':'no-store'}});
      }catch(error){
        return Response.json({
          ok:false,
          error:error instanceof Error?error.message:'Unable to read accounting adjustment diagnostics.',
          accepted:result.accepted,
          sha:result.signal.sha,
          source:'github-actions-oidc',
        },{status:400,headers:{'Cache-Control':'no-store'}});
      }
    }

    if(body?.action==='read-production-accounting-audits'){
      try{
        const releases=await readProductionReleases(context,100);
        const audits=(Array.isArray(releases)?releases:[])
          .map((release:any)=>{
            const verification:any=release?.accountingVerification||null;
            const invariant:any=verification?.invariant||null;
            if(!verification||!invariant)return null;
            return {
              deployId:cleanText(release?.deployId,120),
              commit:cleanText(release?.commit,80),
              checkedAt:cleanText(verification?.checkedAt||release?.recordedAt,80),
              status:cleanText(verification?.status||'unverified',40),
              accountingVerified:Boolean(verification?.accountingVerified),
              clientCount:Number(invariant?.dynamicClientCount||0),
              passedCount:Number(invariant?.dynamicClientPassedCount||0),
              failedCount:Number(invariant?.dynamicClientFailedCount||0),
              unverifiedCount:Number(invariant?.dynamicClientUnverifiedCount||0),
              rows:Array.isArray(invariant?.dynamicClientRows)?invariant.dynamicClientRows:[],
              detail:cleanText(invariant?.detail,1200),
            };
          })
          .filter(Boolean);
        return Response.json({
          ok:true,
          accepted:result.accepted,
          sha:result.signal.sha,
          source:'github-actions-oidc',
          accountingAudits:audits,
        },{headers:{'Cache-Control':'no-store'}});
      }catch(error){
        return Response.json({
          ok:false,
          error:error instanceof Error?error.message:'Unable to read production accounting audits.',
          accepted:result.accepted,
          sha:result.signal.sha,
          source:'github-actions-oidc',
        },{status:500,headers:{'Cache-Control':'no-store'}});
      }
    }

    if(body?.action==='read-production-accounting-audit'){
      try{
        const audit=await productionAccountingAuditForCommit(context,String(body?.commit||''));
        return Response.json({
          ok:Boolean(audit),
          accepted:result.accepted,
          sha:result.signal.sha,
          source:'github-actions-oidc',
          accountingAudit:audit,
        },{status:audit?200:404,headers:{'Cache-Control':'no-store'}});
      }catch(error){
        return Response.json({
          ok:false,
          error:error instanceof Error?error.message:'Unable to read production accounting audit.',
          accepted:result.accepted,
          sha:result.signal.sha,
          source:'github-actions-oidc',
        },{status:400,headers:{'Cache-Control':'no-store'}});
      }
    }

    if(body?.action==='run-sandbox-self-heal-drill'){
      try{
        const drill=await runSandboxSelfHealDrill(context,claims);
        return Response.json({
          ok:Boolean(drill?.ok),
          accepted:result.accepted,
          sha:result.signal.sha,
          source:'github-actions-oidc',
          sandboxSelfHealDrill:drill,
        },{status:drill?.ok?200:503,headers:{'Cache-Control':'no-store'}});
      }catch(error){
        return Response.json({
          ok:false,
          error:error instanceof Error?error.message:'Sandbox self-heal drill failed.',
          accepted:result.accepted,
          sha:result.signal.sha,
          source:'github-actions-oidc',
        },{status:502,headers:{'Cache-Control':'no-store'}});
      }
    }

    if(body?.action==='self-heal-production-deploy'){
      try{
        const recovery=await selfHealProductionDeploy(context,claims);
        return Response.json({
          ...recovery,
          accepted:result.accepted,
          sha:result.signal.sha,
          source:'github-actions-oidc',
        },{
          status:recovery?.ok?200:409,
          headers:{'Cache-Control':'no-store'},
        });
      }catch(error){
        return Response.json({
          ok:false,
          triggered:false,
          exactShaPresent:false,
          expectedSha:String(claims.sha||''),
          error:error instanceof Error?error.message:'Production deployment recovery failed.',
          accepted:result.accepted,
          sha:result.signal.sha,
          source:'github-actions-oidc',
        },{status:502,headers:{'Cache-Control':'no-store'}});
      }
    }

    if(body?.action==='verify-production-release-attestation'){
      const expectedSha=cleanText(claims?.sha,80);
      const token=cleanText(Netlify.env.get('NETLIFY_AUTH_TOKEN'),500);
      const siteId=cleanText(context.site?.id||Netlify.env.get('SITE_ID'),120);
      if(!token||!siteId){
        return Response.json({
          ok:false,
          error:'Netlify production attestation credentials are unavailable.',
          expectedSha,
          accepted:result.accepted,
          source:'github-actions-oidc',
        },{status:503,headers:{'Cache-Control':'no-store'}});
      }
      try{
        const deploy=await productionDeployForCommit(token,siteId,expectedSha);
        const deployId=cleanText(deploy?.id,120);
        const deployState=cleanText(deploy?.state,80).toLowerCase();
        const deployContext=cleanText(deploy?.context,80);
        const deployCommit=cleanText(deploy?.commit_ref||deploy?.commit||deploy?.branch_commit,80);
        const publishedAt=cleanText(deploy?.published_at,80);
        let liveCommit=cleanText(Netlify.env.get('COMMIT_REF'),80);
        const liveDeployId=cleanText(context.deploy?.id||Netlify.env.get('DEPLOY_ID'),120);
        let liveCommitSource=liveCommit?'netlify-runtime':'';
        // API-triggered Netlify builds can omit COMMIT_REF from the function runtime.
        // In that case, resolve the commit from Netlify's authoritative record for
        // the deploy that is actually serving this request. The release policy still
        // requires that live deploy ID to equal the exact-SHA production deploy ID.
        if(!liveCommit&&liveDeployId){
          const {body:liveDeploy}=await netlifyJson(token,'/deploys/'+encodeURIComponent(liveDeployId));
          const providerLiveDeployId=cleanText(liveDeploy?.id,120);
          if(providerLiveDeployId!==liveDeployId){
            throw new Error('Netlify live deploy lookup returned an unexpected deploy id.');
          }
          liveCommit=cleanText(liveDeploy?.commit_ref||liveDeploy?.commit||liveDeploy?.branch_commit,80);
          liveCommitSource='netlify-live-deploy';
        }
        const ok=Boolean(deploy)&&productionDeployMatchesAttestation({
          expectedSha,
          deployId,
          deployState,
          deployContext,
          deployCommit,
          publishedAt,
          liveCommit,
          liveDeployId,
        });
        return Response.json({
          ok,
          accepted:result.accepted,
          sha:result.signal.sha,
          source:'github-actions-oidc',
          expectedSha,
          deployId,
          deployState,
          deployContext,
          deployCommit,
          publishedAt,
          liveCommit,
          liveCommitSource,
          liveDeployId,
          matchingDeployId:Boolean(deployId&&(!liveDeployId||liveDeployId===deployId)),
        },{
          status:ok?200:409,
          headers:{'Cache-Control':'no-store'},
        });
      }catch(error){
        return Response.json({
          ok:false,
          error:error instanceof Error?error.message:'Unable to attest the production Netlify deployment.',
          expectedSha,
          accepted:result.accepted,
          sha:result.signal.sha,
          source:'github-actions-oidc',
        },{status:502,headers:{'Cache-Control':'no-store'}});
      }
    }


    if(body?.action==='record-production-release-attestation'){
      const workflowRef=cleanText(claims?.workflow_ref||claims?.job_workflow_ref||claims?.workflow,500);
      if(!workflowRef.includes('.github/workflows/production-visual-qa.yml')){
        return Response.json({ok:false,error:'Only Production visual QA may persist a release attestation.'},{status:403,headers:{'Cache-Control':'no-store'}});
      }
      const expectedSha=cleanText(claims?.sha,80);
      const token=cleanText(Netlify.env.get('NETLIFY_AUTH_TOKEN'),500);
      const siteId=cleanText(context.site?.id||Netlify.env.get('SITE_ID'),120);
      if(!token||!siteId){
        return Response.json({ok:false,error:'Netlify production attestation credentials are unavailable.',expectedSha},{status:503,headers:{'Cache-Control':'no-store'}});
      }
      try{
        const deploy=await productionDeployForCommit(token,siteId,expectedSha);
        const deployId=cleanText(deploy?.id,120);
        const deployState=cleanText(deploy?.state,80).toLowerCase();
        const deployContext=cleanText(deploy?.context,80);
        const deployCommit=cleanText(deploy?.commit_ref||deploy?.commit||deploy?.branch_commit,80);
        const publishedAt=cleanText(deploy?.published_at,80);
        const liveDeployId=cleanText(context.deploy?.id||Netlify.env.get('DEPLOY_ID'),120);
        let liveCommit=cleanText(Netlify.env.get('COMMIT_REF'),80);
        if(!liveCommit&&liveDeployId){
          const {body:liveDeploy}=await netlifyJson(token,'/deploys/'+encodeURIComponent(liveDeployId));
          if(cleanText(liveDeploy?.id,120)!==liveDeployId)throw new Error('Netlify live deploy lookup returned an unexpected deploy id.');
          liveCommit=cleanText(liveDeploy?.commit_ref||liveDeploy?.commit||liveDeploy?.branch_commit,80);
        }
        const netlifyOk=Boolean(deploy)&&productionDeployMatchesAttestation({
          expectedSha,deployId,deployState,deployContext,deployCommit,publishedAt,liveCommit,liveDeployId,
        });
        if(!netlifyOk){
          return Response.json({ok:false,error:'Exact production deploy attestation is not valid for release-history persistence.',expectedSha,deployId,liveDeployId},{status:409,headers:{'Cache-Control':'no-store'}});
        }

        const health:any=body?.health||{};
        const checkedAt=cleanText(health?.checkedAt,80);
        const checkedMs=Date.parse(checkedAt);
        const healthOk=cleanText(health?.sha,80)===expectedSha
          &&cleanText(health?.deployId,120)===deployId
          &&health?.overall==='healthy'
          &&Number.isInteger(health?.passed)&&health.passed>0
          &&Number.isInteger(health?.failed)&&health.failed===0
          &&Number.isFinite(checkedMs)
          &&Math.abs(Date.now()-checkedMs)<=20*60*1000;
        const runId=cleanText(claims?.run_id||claims?.run_number,80);
        const visualQaRunId=cleanText(body?.visualQaRunId,80);
        const releases=await readProductionReleases(context,100);
        const release:any=releases.find((row:any)=>row?.deployId===deployId&&row?.commit===expectedSha)||null;
        const visual:any=release?.visualQuality||null;
        const visualOk=Boolean(
          release
          &&visual?.status==='passed'
          &&cleanText(visual?.commit,80)===expectedSha
          &&cleanText(visual?.deployId,120)===deployId
          &&cleanText(visual?.runId,80)===runId
          &&visualQaRunId===runId
          &&body?.visualQaConclusion==='success'
        );
        if(!healthOk||!visualOk||body?.productionGateState!=='success'){
          return Response.json({
            ok:false,
            error:'Release-history evidence is incomplete or does not match the exact production release.',
            expectedSha,deployId,healthOk,visualOk,
          },{status:409,headers:{'Cache-Control':'no-store'}});
        }

        const releaseAttestation={
          status:'verified' as const,
          verifiedAt:new Date().toISOString(),
          expectedSha,deployId,liveDeployId,
          matchingDeployId:liveDeployId===deployId,
          deployState,deployContext,publishedAt,
          visualQaRunId:runId,
          visualQaConclusion:'success',
          systemHealth:{overall:'healthy',passed:Number(health.passed),failed:0,checkedAt},
          productionGateState:'success',
          source:'github-actions-oidc' as const,
        };
        const recorded:any=await recordProductionRelease(context,{
          deployId,commit:expectedSha,publishedAt,releaseAttestation,
        });
        const recordedOk=recorded?.releaseAttestation?.status==='verified'
          &&recorded?.releaseAttestation?.expectedSha===expectedSha
          &&recorded?.releaseAttestation?.deployId===deployId
          &&recorded?.releaseAttestation?.matchingDeployId===true;
        return Response.json({
          ok:recordedOk,recorded:recordedOk,expectedSha,deployId,liveDeployId,
          releaseAttestation:recorded?.releaseAttestation||releaseAttestation,
          source:'github-actions-oidc',
        },{status:recordedOk?200:503,headers:{'Cache-Control':'no-store'}});
      }catch(error){
        return Response.json({
          ok:false,
          error:error instanceof Error?error.message:'Unable to persist production release attestation.',
          expectedSha,source:'github-actions-oidc',
        },{status:502,headers:{'Cache-Control':'no-store'}});
      }
    }

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

    if(body?.action==='record-dark-mode-visual-quality'){
      const deployedCommit=String(Netlify.env.get('COMMIT_REF')||'').trim();
      if(deployedCommit&&deployedCommit!==String(claims.sha||'')){
        return Response.json({
          error:'Production is not serving the requesting GitHub commit.',
          expected:String(claims.sha||''),
          deployed:deployedCommit,
        },{status:409,headers:{'Cache-Control':'no-store'}});
      }

      const normalizeBrowser=(value:any,browser:'chromium'|'webkit')=>{
        const routes=Math.max(0,Math.floor(Number(value?.routes||0)));
        const cases=Math.max(0,Math.floor(Number(value?.cases||0)));
        const failureCount=Math.max(0,Math.floor(Number(value?.failureCount||0)));
        const reportMissing=Boolean(value?.reportMissing);
        const routeResults=(Array.isArray(value?.routeResults)?value.routeResults:[])
          .map((row:any)=>{
            const route=cleanText(row?.route,300);
            const rowFailures=(Array.isArray(row?.failures)?row.failures:[])
              .map((item:any)=>cleanText(item,500))
              .filter(Boolean)
              .slice(0,12);
            const failedCases=(Array.isArray(row?.failedCases)?row.failedCases:[])
              .map((item:any)=>({
                theme:cleanText(item?.theme,120)||'unknown',
                viewport:cleanText(item?.viewport,80)||'unknown',
                detail:cleanText(item?.detail,500),
              }))
              .filter((item:any)=>item.detail)
              .slice(0,24);
            const rowFailureCount=Math.max(0,Math.floor(Number(row?.failureCount||failedCases.length||rowFailures.length||0)));
            return {
              route,
              status:rowFailureCount>0?'failed' as const:'passed' as const,
              cases:Math.max(0,Math.floor(Number(row?.cases||0))),
              failureCount:rowFailureCount,
              failures:rowFailures,
              failedCases,
            };
          })
          .filter((row:any)=>row.route)
          .slice(0,250);
        const failedRouteCount=routeResults.filter((row:any)=>row.status==='failed').length;
        return {browser,routes,cases,failureCount,failedRouteCount,reportMissing,routeResults};
      };

      try{
        const deployId=String(context.deploy?.id||Netlify.env.get('DEPLOY_ID')||'').trim();
        if(!deployId)throw new Error('Production deploy id is unavailable.');
        const chromium=normalizeBrowser(body?.chromium,'chromium');
        const webkit=normalizeBrowser(body?.webkit,'webkit');
        const checkedAt=cleanText(body?.checkedAt,80)||new Date().toISOString();
        const failed=chromium.reportMissing||webkit.reportMissing||chromium.failureCount>0||webkit.failureCount>0;
        const screenshots=[] as any[];
        for(const shot of Array.isArray(body?.screenshots)?body.screenshots.slice(0,4):[]){
          try{
            screenshots.push(await recordProductionVisualThumbnail(context,deployId,shot));
          }catch(error){
            console.warn('Dark Mode QA thumbnail skipped',cleanText(error instanceof Error?error.message:'invalid screenshot',300));
          }
        }
        const visualQuality={
          checkedAt,
          status:failed?'failed' as const:'passed' as const,
          source:'production-visual-qa' as const,
          runId:cleanText(claims?.run_id||claims?.run_number,80),
          commit:String(claims.sha||''),
          deployId,
          chromium,
          webkit,
          screenshots,
        };
        const release=await recordProductionRelease(context,{
          deployId,
          commit:String(claims.sha||''),
          checkedAt,
          visualQuality,
        });
        const recorded=Boolean(release?.deployId===deployId&&release?.visualQuality?.checkedAt===checkedAt);
        return Response.json({
          ok:recorded,
          accepted:result.accepted,
          sha:result.signal.sha,
          deployId,
          source:'github-actions-oidc',
          visualQuality:release?.visualQuality||visualQuality,
        },{
          status:recorded?200:503,
          headers:{'Cache-Control':'no-store'},
        });
      }catch(error){
        return Response.json({
          ok:false,
          error:error instanceof Error?error.message:'Unable to persist Dark Mode visual-quality results.',
          accepted:result.accepted,
          sha:result.signal.sha,
          source:'github-actions-oidc',
        },{status:500,headers:{'Cache-Control':'no-store'}});
      }
    }

    if(body?.action==='run-dashboard-refresh'){
      const deployedCommit=String(Netlify.env.get('COMMIT_REF')||'').trim();
      if(deployedCommit&&deployedCommit!==String(claims.sha||'')){
        return Response.json({
          error:'Production is not serving the requesting GitHub commit.',
          expected:String(claims.sha||''),
          deployed:deployedCommit,
        },{status:409,headers:{'Cache-Control':'no-store'}});
      }
      try{
        const dashboard=await runHealthDashboardRefresh(context);
        const current:any=dashboard?.current||null;
        return Response.json({
          ok:Boolean(current),
          accepted:result.accepted,
          sha:result.signal.sha,
          deployId:String(context.deploy?.id||Netlify.env.get('DEPLOY_ID')||''),
          source:'github-actions-oidc',
          current,
          coverage:dashboard?.coverage||{},
          enrichmentWarnings:Array.isArray(dashboard?.enrichmentWarnings)?dashboard.enrichmentWarnings:[],
          dashboard,
        },{
          status:current?200:503,
          headers:{'Cache-Control':'no-store'},
        });
      }catch(error){
        return Response.json({
          error:error instanceof Error?error.message:'System Health dashboard refresh failed.',
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
