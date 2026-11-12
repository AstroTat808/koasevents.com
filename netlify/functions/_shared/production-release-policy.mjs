const SHA=/^[a-f0-9]{40}$/i;

export function isSuccessfulNetlifyState(value){
  return ['ready','current'].includes(String(value||'').trim().toLowerCase());
}

export function productionDeployMatchesAttestation(input={}){
  const expectedSha=String(input.expectedSha||'').trim().toLowerCase();
  const deployId=String(input.deployId||'').trim();
  const deployState=String(input.deployState||'').trim().toLowerCase();
  const deployContext=String(input.deployContext||'').trim();
  const deployCommit=String(input.deployCommit||'').trim().toLowerCase();
  const publishedAt=String(input.publishedAt||'').trim();
  const liveCommit=String(input.liveCommit||'').trim().toLowerCase();
  const liveDeployId=String(input.liveDeployId||'').trim();

  return Boolean(
    SHA.test(expectedSha)
    && deployId
    && deployCommit===expectedSha
    && deployContext==='production'
    && isSuccessfulNetlifyState(deployState)
    && publishedAt
    && liveCommit===expectedSha
    && liveDeployId===deployId
  );
}

/**
 * GitHub Actions run IDs advance monotonically. Reject stale signed release
 * evidence without treating an older rerun attempt as a new release run.
 * A missing prior run permits a fresh valid run; invalid IDs fail closed.
 */
export function productionReleaseRunOrder(incomingRunId,recordedRunId=''){
  const incoming=String(incomingRunId??'').trim();
  const recorded=String(recordedRunId??'').trim();
  const valid=/^[1-9][0-9]{3,19}$/;
  if(!valid.test(incoming))return null;
  if(!recorded)return 1;
  if(!valid.test(recorded))return null;
  const a=BigInt(incoming),b=BigInt(recorded);
  return a===b?0:a>b?1:-1;
}

/** Browser results from a prior run never count for a new run. */
export function previousResponsiveForSameRun(previous,incomingRunId){
  return previous&&productionReleaseRunOrder(incomingRunId,previous.runId)===0
    ? previous : null;
}

export function productionWorkflowGatesSucceeded(results={}){
  const required=['pending','source','smoke','theme','admin','mobile','visual'];
  return required.every((name)=>String(results?.[name]||'')==='success');
}

export function healthySystemHealthSnapshot(input={},expectedSha=''){
  const sha=String(input.sha||'').trim().toLowerCase();
  const expected=String(expectedSha||'').trim().toLowerCase();
  return Boolean(
    SHA.test(expected)
    && sha===expected
    && input.ok===true
    && String(input.overall||'')==='healthy'
    && Number(input.failed)===0
    && Number.isInteger(Number(input.passed))
    && String(input.checkedAt||'').trim()
  );
}

export function evaluateProductionReleaseGate({expectedSha='',workflowResults={},netlify={},health={}}={}){
  const workflowOk=productionWorkflowGatesSucceeded(workflowResults);
  const netlifyOk=productionDeployMatchesAttestation({...netlify,expectedSha});
  const healthOk=healthySystemHealthSnapshot(health,expectedSha);
  const ok=workflowOk&&netlifyOk&&healthOk;
  return {
    ok,
    state:ok?'success':'failure',
    workflowOk,
    netlifyOk,
    healthOk,
  };
}


/**
 * Authoritative identity gate for GitHub OIDC signed production-only operations.
 * Netlify's COMMIT_REF is read-only BUILD metadata, not guaranteed in Functions.
 * Runtime deployment ID / site ID are obtained from Netlify Context, while the
 * deploy details are fetched from Netlify's authenticated deployment API.
 * The signed GitHub claim must match that exact ready, published deployment.
 */
export function verifiedSignedProductionDeploymentIdentity(input={}){
  const sha=String(input.expectedSha||'').trim().toLowerCase();
  const siteId=String(input.siteId||'').trim();
  const servingDeployId=String(input.servingDeployId||'').trim();
  const context=String(input.servingContext||'').trim();
  const runtimeCommit=String(input.runtimeCommit||'').trim().toLowerCase();
  const deploy=input.providerDeploy;
  if(!SHA.test(sha)||!siteId||!/^[a-f0-9]{24}$/.test(servingDeployId)
    ||context!=='production'||!deploy||typeof deploy!=='object'||Array.isArray(deploy)){
    return false;
  }
  const providerId=String(deploy.id||'').trim();
  const providerSiteId=String(deploy.site_id||'').trim();
  const providerCommit=String(deploy.commit_ref||deploy.commit||deploy.branch_commit||'').trim().toLowerCase();
  if(providerId!==servingDeployId||providerSiteId!==siteId
    ||(runtimeCommit&&runtimeCommit!==sha)){
    return false;
  }
  return productionDeployMatchesAttestation({
    expectedSha:sha,
    deployId:providerId,
    deployState:deploy.state,
    deployContext:deploy.context,
    deployCommit:providerCommit,
    publishedAt:deploy.published_at,
    liveCommit:runtimeCommit||providerCommit,
    liveDeployId:servingDeployId,
  });
}
