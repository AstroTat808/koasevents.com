import type { DeployFailedEvent, DeploySucceededEvent } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { normalizeBuildFailureDiagnostic } from './_shared/build-failure-diagnostic.mjs';

const STORE='koa-deploy-diagnostics';

async function readPluginDiagnostic(deployId:string){
  try{
    const store=getDeployStore({name:'koa-build-diagnostics',deployID:deployId});
    return (await store.get('failure.json',{type:'json'}))||{};
  }catch{return {};}
}

export default {
  async deployFailed(event:DeployFailedEvent){
    if(String(event.deploy.context||'')!=='production')return;
    const deployId=String(event.deploy.id||'').trim();
    if(!deployId)return;
    try{
      const plugin:any=await readPluginDiagnostic(deployId);
      const diagnostic=normalizeBuildFailureDiagnostic({
        ...plugin,
        source:plugin?.command?'netlify-build-plugin+deployFailed':'netlify-deployFailed',
        deployId,buildId:event.deploy.buildId||plugin?.buildId,
        commit:event.deploy.commitRef||plugin?.commit,context:event.deploy.context,
        providerErrorMessage:event.deploy.errorMessage||plugin?.providerErrorMessage,
        message:plugin?.message||event.deploy.errorMessage||'Netlify production deploy failed.',
        recordedAt:new Date().toISOString(),
      });
      const store=getStore(STORE);
      await store.setJSON('by-deploy/'+deployId,diagnostic);
      await store.setJSON('latest',diagnostic);
      console.log('[koa deploy event] recorded production failure '+deployId+' · '+(diagnostic.command||diagnostic.message));
    }catch(error){
      console.error('[koa deploy event] unable to persist production failure · '+String(error instanceof Error?error.message:error));
    }
  },
  async deploySucceeded(event:DeploySucceededEvent){
    if(String(event.deploy.context||'')!=='production')return;
    try{
      const store=getStore(STORE);
      await store.setJSON('latest-success',{
        deployId:String(event.deploy.id||''),commit:String(event.deploy.commitRef||''),
        publishedAt:String(event.deploy.publishedAt||''),recordedAt:new Date().toISOString(),
      });
    }catch{}
  },
};
