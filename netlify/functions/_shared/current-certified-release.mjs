// Online production identity proof, independent of the Release History row.
// Historical attestations remain archived but cannot be exported as "current"
// when GitHub main or the published Netlify deploy has changed.
const sha=/^[0-9a-f]{40}$/i;
const deploy=/^[0-9a-f]{24}$/i;
const fixedRepository='AstroTat808/koasevents.com';

class CurrentReleaseError extends Error {
  constructor(code){super(code);this.code=code;}
}

async function fetchJson(fetchImpl,url,token){
  let response;
  try{
    response=await fetchImpl(url,{
      headers:{
        Accept:'application/json',
        'Cache-Control':'no-cache',
        ...(token?{Authorization:'Bearer '+token}:{}),
      },
      signal:AbortSignal.timeout(12000),
    });
  }catch{throw new CurrentReleaseError('CURRENT_RELEASE_PROVIDER_UNAVAILABLE');}
  if(!response?.ok)throw new CurrentReleaseError('CURRENT_RELEASE_PROVIDER_UNAVAILABLE');
  try{return await response.json();}catch{
    throw new CurrentReleaseError('CURRENT_RELEASE_PROVIDER_INVALID');
  }
}

export async function verifyCurrentCertifiedProduction({
  fetchImpl=fetch,netlifyToken='',githubToken='',siteId='',servingDeployId='',
  runtimeCommit='',expectedCommit='',expectedDeployId='',
}={}){
  if(!netlifyToken||!siteId||!deploy.test(servingDeployId)
    ||!sha.test(expectedCommit)||!deploy.test(expectedDeployId)){
    throw new CurrentReleaseError('CURRENT_RELEASE_IDENTITY_UNAVAILABLE');
  }
  if(servingDeployId!==expectedDeployId
    ||(runtimeCommit&&runtimeCommit!==expectedCommit)){
    throw new CurrentReleaseError('CURRENT_RELEASE_STALE_DEPLOYMENT');
  }
  const [site,live,main]=await Promise.all([
    fetchJson(fetchImpl,'https://api.netlify.com/api/v1/sites/'+encodeURIComponent(siteId),netlifyToken),
    fetchJson(fetchImpl,'https://api.netlify.com/api/v1/deploys/'+encodeURIComponent(servingDeployId),netlifyToken),
    fetchJson(fetchImpl,'https://api.github.com/repos/'+fixedRepository+'/branches/main',githubToken),
  ]);
  const published=site?.published_deploy||null;
  if(site?.id!==siteId
    ||published?.id!==servingDeployId
    ||live?.id!==servingDeployId
    ||live?.site_id!==siteId
    ||live?.context!=='production'
    ||!['ready','current'].includes(live?.state)
    ||!live?.published_at
    ||String(live?.commit_ref||live?.commit||'')!==expectedCommit
    ||main?.name!=='main'||main?.commit?.sha!==expectedCommit){
    throw new CurrentReleaseError('CURRENT_RELEASE_STALE_DEPLOYMENT');
  }
  return {
    commit:expectedCommit,deployId:expectedDeployId,
    publishedAt:live.published_at,
    mainCommit:main.commit.sha,
    verifiedAgainst:'GitHub main + Netlify published production deployment',
  };
}
