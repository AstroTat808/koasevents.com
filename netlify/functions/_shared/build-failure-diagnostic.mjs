const SHA=/^[a-f0-9]{40}$/i;

function clean(value,max=500){
  return String(value??'')
    .replace(/[\u0000-\u001f\u007f]+/g,' ')
    .replace(/\s+/g,' ')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi,'Bearer [redacted]')
    .replace(/\b(authorization|token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,'$1=[redacted]')
    .trim()
    .slice(0,max);
}

export function normalizeBuildFailureDiagnostic(input={}){
  const exitRaw=Number(input.exitCode);
  const commit=clean(input.commit,80).toLowerCase();
  return {
    schemaVersion:1,
    source:clean(input.source||'unknown',80),
    stage:clean(input.stage||'netlify-build-or-deploy',120),
    check:clean(input.check,160),
    command:clean(input.command,500),
    exitCode:Number.isInteger(exitRaw)?exitRaw:null,
    signal:clean(input.signal,60),
    message:clean(input.message||input.providerErrorMessage||'Production deployment failed.',800),
    providerErrorMessage:clean(input.providerErrorMessage,800),
    commit:SHA.test(commit)?commit:'',
    deployId:clean(input.deployId,120),
    buildId:clean(input.buildId,120),
    context:clean(input.context,60),
    recordedAt:clean(input.recordedAt,80)||new Date().toISOString(),
  };
}

export function buildFailureRootCause(input={}){
  const row=normalizeBuildFailureDiagnostic(input);
  if(row.command)return (row.stage?row.stage+' · ':'')+row.command;
  if(row.message)return row.message;
  return 'Unknown deployment failure';
}
