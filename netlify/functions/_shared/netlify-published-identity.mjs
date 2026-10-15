// Metadata-only proof. The Netlify API credential stays in GitHub Actions,
// never in the production function; only OIDC-authenticated scalar evidence is stored.
const SHA=/^[a-f0-9]{40}$/i;
const clean=(v)=>typeof v==='string'?v.trim():'';
const ready=(v)=>['ready','current'].includes(clean(v).toLowerCase());
const invalid=()=>({verified:false,deployId:'',commit:'',state:'',context:''});

export function verifyPublishedRecoveryProof({site,deploy,siteId='',expectedSha=''}={}){
  siteId=clean(siteId);
  expectedSha=clean(expectedSha);
  const published=site?.published_deploy;
  const deployId=clean(published?.id);
  const commit=clean(deploy?.commit_ref);
  if(
    !siteId||!SHA.test(expectedSha)||!deployId
    ||clean(site?.id)!==siteId
    ||clean(deploy?.id)!==deployId
    ||clean(deploy?.site_id)!==siteId
    ||clean(deploy?.context)!=='production'
    ||!ready(deploy?.state)
    ||(published?.state&&!ready(published.state))
    ||!SHA.test(commit)||commit!==expectedSha
    ||(published?.commit_ref&&clean(published.commit_ref)!==commit)
    ||(published?.context&&clean(published.context)!=='production')
  )return invalid();
  return {verified:true,deployId,commit,state:clean(deploy.state).toLowerCase(),context:'production'};
}

// Only the server may create a publishedDeployVerified record, after GitHub
// workflow OIDC claims and this deployed function's real context.deploy.id match.
export function signedPublishedCredentialMatches({verification,servingDeployId=''}={}){
  const v=verification||{};
  servingDeployId=clean(servingDeployId);
  return Boolean(
    servingDeployId
    &&v.source==='github-actions-read-only'
    &&v.publishedDeployVerified===true
    &&SHA.test(clean(v.commit))
    &&clean(v.publishedDeployCommit)===clean(v.commit)
    &&clean(v.publishedDeployId)===servingDeployId
    &&clean(v.publishedDeployContext)==='production'
    &&ready(v.publishedDeployState)
    &&Number(v.deployDetailHttpStatus)===200
  );
}

// Stable, non-sensitive component codes for production System Health.
// The code is derived exclusively from signed scalar evidence, not raw responses.
export function recoveryCredentialDiagnostic({
  verification,productionCommit='',servingDeployId='',expectedSiteId='',now=Date.now(),
}={}){
  const v=verification||null;
  const src=clean(productionCommit)?'netlify-runtime':'oidc-published-deploy';
  const info=(code,authenticated=false,commitMatches=false,fresh=false)=>({
    ok:code==='KOA_RECOVERY_OK',code,authenticated,commitMatches,fresh,identitySource:src,
  });
  if(!v)return info('KOA_RECOVERY_EVIDENCE_MISSING');
  const checked=Date.parse(clean(v.checkedAt));
  const age=now-checked;
  const fresh=Number.isFinite(age)&&age>=-120000&&age<=36*3600000;
  if(v.configured!==true)return info('KOA_RECOVERY_TOKEN_UNCONFIGURED',false,false,fresh);
  const siteMatches=v.siteIdMatches===true&&clean(v.siteId)===clean(expectedSiteId)
    &&Boolean(clean(expectedSiteId));
  if(!siteMatches)return info('KOA_RECOVERY_SITE_MISMATCH',false,false,fresh);
  const authenticated=v.usable===true&&Number(v.siteHttpStatus)===200
    &&Number(v.deployListHttpStatus)===200;
  if(!authenticated)return info('KOA_RECOVERY_CREDENTIAL_UNUSABLE',false,false,fresh);
  if(!fresh)return info('KOA_RECOVERY_EVIDENCE_STALE',true,false,false);
  const commit=clean(productionCommit);
  if(commit){
    const match=clean(v.commit)===commit;
    return info(match?'KOA_RECOVERY_OK':'KOA_RECOVERY_RUNTIME_SHA_MISMATCH',true,match,true);
  }
  if(v.publishedDeployVerified!==true)
    return info('KOA_RECOVERY_PUBLISHED_PROOF_MISSING',true,false,true);
  const match=signedPublishedCredentialMatches({verification:v,servingDeployId});
  return info(match?'KOA_RECOVERY_OK':'KOA_RECOVERY_PUBLISHED_IDENTITY_MISMATCH',true,match,true);
}
