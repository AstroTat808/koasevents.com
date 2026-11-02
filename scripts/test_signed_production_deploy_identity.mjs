import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedSignedProductionDeploymentIdentity as verify } from '../netlify/functions/_shared/production-release-policy.mjs';

const sha='a'.repeat(40);
const deployId='b'.repeat(24);
const siteId='d1f3ab06-be2a-41c4-b770-59e6a6acd1b9';
const providerDeploy={
  id:deployId,site_id:siteId,context:'production',state:'ready',
  commit_ref:sha,published_at:'2026-10-30T21:54:50.363Z',
};
const base={
  expectedSha:sha,siteId,servingDeployId:deployId,
  servingContext:'production',runtimeCommit:'',providerDeploy,
};
function rejects(title,overrides){
  test(title,()=>{
    assert.equal(verify({...base,...overrides}),false);
  });
}
test('signed audit accepts missing COMMIT_REF only when provider confirms exact live production deployment',()=>{
  assert.equal(verify(base),true);
  assert.equal(verify({...base,runtimeCommit:sha}),true);
});
rejects('reject stale signed GitHub commit',{expectedSha:'c'.repeat(40)});
rejects('reject invalid signed SHA',{expectedSha:'not-a-sha'});
rejects('reject a runtime commit that conflicts with the signed GitHub commit',{runtimeCommit:'c'.repeat(40)});
rejects('reject an incorrect live deploy id',{servingDeployId:'c'.repeat(24)});
rejects('reject an invalid live deploy id',{servingDeployId:'short'});
rejects('reject a provider deploy id mismatch',{providerDeploy:{...providerDeploy,id:'c'.repeat(24)}});
rejects('reject a provider from a foreign site',{providerDeploy:{...providerDeploy,site_id:'other-site'}});
rejects('reject a missing original site id',{siteId:''});
rejects('reject preview context even with otherwise matching commits',{servingContext:'deploy-preview'});
rejects('reject a provider preview',{providerDeploy:{...providerDeploy,context:'deploy-preview'}});
rejects('reject a provider branch deployment',{providerDeploy:{...providerDeploy,context:'branch-deploy'}});
rejects('reject an unpublished deployment',{providerDeploy:{...providerDeploy,published_at:null}});
rejects('reject a still-building production deploy',{providerDeploy:{...providerDeploy,state:'building'}});
rejects('reject a failed production deploy',{providerDeploy:{...providerDeploy,state:'error'}});
rejects('reject malformed provider payloads',{providerDeploy:null});
rejects('reject malformed provider arrays',{providerDeploy:[providerDeploy]});
test('a verified commit and serving deploy must correspond exactly, not just share a branch',()=>{
  const old={...providerDeploy,commit_ref:'d'.repeat(40)};
  assert.equal(verify({...base,providerDeploy:old}),false);
  assert.equal(verify({...base,runtimeCommit:sha,providerDeploy:old}),false);
});
