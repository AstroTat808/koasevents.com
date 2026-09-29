import type { Config, Context } from '@netlify/functions';
import {
  applyHealthAlertPolicy,
  persistHealth,
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

function base64UrlBytes(value:string){
  const normalized=value.replace(/-/g,'+').replace(/_/g,'/');
  const padded=normalized+'='.repeat((4-normalized.length%4)%4);
  const binary=atob(padded);
  return Uint8Array.from(binary,(char)=>char.charCodeAt(0));
}

function decodePart(value:string){
  return JSON.parse(new TextDecoder().decode(base64UrlBytes(value)));
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

      const deployId=String(Netlify.env.get('DEPLOY_ID')||'').trim();
      const syntheticProbeVerification=syntheticProbeReleaseVerification(health,'github-actions-oidc');
      const probes=syntheticProbeVerification.probes;
      const probesVerified=syntheticProbeVerification.status==='passed'
        && probes.length===4
        && probes.every((row:any)=>row.ok&&row.status===204&&row.source==='live'&&row.marker===row.expectedMarker);

      let auditRecorded=false;
      let auditError='';
      try{
        await recordProductionRelease(context,{
          deployId,
          commit:String(claims.sha||''),
          checkedAt:health.checkedAt,
          syntheticProbeVerification,
        });
        auditRecorded=true;
      }catch(error){
        auditError=error instanceof Error?error.message:'Unable to persist production synthetic-probe audit.';
      }

      const rollbackProtection=!probesVerified
        ? await rollbackFailedProductionRelease(context,{
            deployId,
            commit:String(claims.sha||''),
            syntheticProbeVerification,
          })
        : null;

      const accountingCheck:any=health.checks.find((row:any)=>String(row?.id||'')==='quickbooks-tax-invariant')||null;
      const liveClient=accountingCheck?.accountingDetails?.liveClientInvariant||null;
      const accountingInvariant={
        id:String(accountingCheck?.id||'quickbooks-tax-invariant'),
        ok:Boolean(accountingCheck?.ok),
        severity:String(accountingCheck?.severity||''),
        status:Number(accountingCheck?.status||0),
        expectedTotal:Number(accountingCheck?.accountingDetails?.expectedTotal||15706.80),
        actualTotal:Number(accountingCheck?.accountingDetails?.actualTotal||0),
        taxablePayload:Number(accountingCheck?.accountingDetails?.taxablePayload||0),
        liveClientStatus:String(liveClient?.status||'unverified'),
        liveClientEstimateTotal:liveClient?.estimateTotal==null?null:Number(liveClient.estimateTotal),
        liveClientTaxableLineCount:liveClient?.taxableLineCount==null?null:Number(liveClient.taxableLineCount),
        historicalTaxOnTaxDetected:Boolean(liveClient?.historicalTaxOnTaxDetected),
        estimateId:String(liveClient?.estimateId||''),
        estimateDocNumber:String(liveClient?.estimateDocNumber||''),
        verifiedAt:String(liveClient?.verifiedAt||health.checkedAt||''),
        detail:String(accountingCheck?.detail||''),
      };
      const accountingVerified=Boolean(
        accountingInvariant.ok
        && accountingInvariant.status===200
        && accountingInvariant.expectedTotal===15706.80
        && accountingInvariant.actualTotal===15706.80
        && accountingInvariant.taxablePayload===0
        && accountingInvariant.liveClientStatus==='passed'
        && accountingInvariant.liveClientEstimateTotal===15706.80
        && accountingInvariant.liveClientTaxableLineCount===0
        && !accountingInvariant.historicalTaxOnTaxDetected
      );
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
