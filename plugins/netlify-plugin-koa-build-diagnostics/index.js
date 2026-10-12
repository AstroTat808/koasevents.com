import { readFile, rm } from 'node:fs/promises';
import { getDeployStore } from '@netlify/blobs';
import { normalizeBuildFailureDiagnostic } from '../../netlify/functions/_shared/build-failure-diagnostic.mjs';

const FAILURE_FILE='/tmp/koa-build-failure.json';

export const onPreBuild=async()=>{
  await rm(FAILURE_FILE,{force:true}).catch(()=>{});
};

export const onError=async({error}={})=>{
  let runner={};
  try{runner=JSON.parse(await readFile(FAILURE_FILE,'utf8'));}catch{}
  const diagnostic=normalizeBuildFailureDiagnostic({
    ...runner,
    source:runner?.source||'netlify-build-plugin',
    stage:runner?.stage||'netlify-build-or-deploy',
    message:runner?.message||error?.message||'Netlify build or deploy stage failed.',
    providerErrorMessage:error?.message||'',
    command:runner?.command||error?.command||'',
    exitCode:runner?.exitCode??error?.exitCode??error?.code,
    signal:runner?.signal||error?.signal||'',
    commit:runner?.commit||process.env.COMMIT_REF,
    deployId:runner?.deployId||process.env.DEPLOY_ID,
    buildId:runner?.buildId||process.env.BUILD_ID,
    context:runner?.context||process.env.CONTEXT,
    recordedAt:new Date().toISOString(),
  });
  try{
    const store=getDeployStore('koa-build-diagnostics');
    await store.setJSON('failure.json',diagnostic);
    console.error('[koa build diagnosis] persisted deploy-scoped failure · '+JSON.stringify({
      stage:diagnostic.stage,command:diagnostic.command,exitCode:diagnostic.exitCode,
      deployId:diagnostic.deployId,buildId:diagnostic.buildId,
    }));
  }catch(storeError){
    console.error('[koa build diagnosis] deploy-scoped persistence failed · '+String(storeError?.message||storeError));
  }
};
