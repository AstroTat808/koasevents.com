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

export function productionWorkflowGatesSucceeded(results={}){
  const required=['pending','source','smoke','theme','admin','mobile','visual'];
  return required.every((name)=>String(results?.[name]||'')==='success');
}

export function healthySystemHealthSnapshot(input={},expectedSha='',expectedDeployId=''){
  const sha=String(input.sha||'').trim().toLowerCase();
  const expected=String(expectedSha||'').trim().toLowerCase();
  const deployId=String(input.deployId||'').trim();
  const checkedAt=Date.parse(String(input.checkedAt||''));
  const ageMs=Date.now()-checkedAt;
  return Boolean(
    SHA.test(expected)
    &&sha===expected
    &&String(expectedDeployId||'').trim()
    &&deployId===String(expectedDeployId||'').trim()
    &&input.ok===true
    &&input.source==='github-actions-oidc'
    &&input.overall==='healthy'
    &&typeof input.failed==='number'
    &&Number.isInteger(input.failed)
    &&input.failed===0
    &&typeof input.passed==='number'
    &&Number.isInteger(input.passed)
    &&input.passed>0
    &&Array.isArray(input.enrichmentWarnings)
    &&input.enrichmentWarnings.length===0
    &&Number.isFinite(checkedAt)
    &&ageMs>=-120_000
    &&ageMs<=20*60*1000
  );
}

export function evaluateProductionReleaseGate({expectedSha='',workflowResults={},netlify={},health={}}={}){
  const workflowOk=productionWorkflowGatesSucceeded(workflowResults);
  const netlifyOk=productionDeployMatchesAttestation({...netlify,expectedSha});
  const healthOk=healthySystemHealthSnapshot(health,expectedSha,netlify.deployId);
  const ok=workflowOk&&netlifyOk&&healthOk;
  return {
    ok,
    state:ok?'success':'failure',
    workflowOk,
    netlifyOk,
    healthOk,
  };
}
