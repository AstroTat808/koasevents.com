// Read-only proof of the commit actually serving the current Netlify production request.
// An omitted runtime COMMIT_REF is never itself evidence of a matching release.
const COMMIT_SHA = /^[a-f0-9]{40}$/i;
const clean = (value) => typeof value === 'string' ? value.trim() : '';
const unavailable = () => ({verified:false,commit:'',source:'unverified'});

export async function resolvePublishedDeployCommit({
  siteId = '',
  servingDeployId = '',
  token = '',
  fetchImpl = fetch,
} = {}) {
  siteId=clean(siteId);
  servingDeployId=clean(servingDeployId);
  token=clean(token);
  if (!siteId || !servingDeployId || !token || typeof fetchImpl !== 'function') {
    return unavailable();
  }
  const headers={Authorization:'Bearer '+token,'User-Agent':'KoaEvents-Health/1.0'};
  async function getJson(path) {
    const response=await fetchImpl('https://api.netlify.com/api/v1/'+path,{
      method:'GET',headers,signal:AbortSignal.timeout(12_000),
    });
    if (!response?.ok) return null;
    const value=await response.json();
    return value && typeof value==='object' && !Array.isArray(value) ? value : null;
  }
  try {
    const site=await getJson('sites/'+encodeURIComponent(siteId));
    const published=site?.published_deploy;
    if (!site || clean(site.id)!==siteId || clean(published?.id)!==servingDeployId) {
      return unavailable();
    }
    const deploy=await getJson('deploys/'+encodeURIComponent(servingDeployId));
    const commit=clean(deploy?.commit_ref);
    if (
      !deploy
      || clean(deploy.id)!==servingDeployId
      || clean(deploy.site_id)!==siteId
      || clean(deploy.context)!=='production'
      || !['ready','current'].includes(clean(deploy.state).toLowerCase())
      || !COMMIT_SHA.test(commit)
      || (published?.commit_ref && clean(published.commit_ref)!==commit)
      || (published?.state && !['ready','current'].includes(clean(published.state).toLowerCase()))
    ) return unavailable();
    return {verified:true,commit,source:'netlify-published-deploy'};
  } catch {
    // Fail closed: never infer identity from a missing provider response.
    return unavailable();
  }
}
