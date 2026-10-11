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
