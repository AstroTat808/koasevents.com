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
