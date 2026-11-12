#!/usr/bin/env node
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {
  serializedCertifiedReleaseArtifacts,
  signCertifiedReleaseArtifacts,
  verifySignedCertifiedReleaseArtifacts,
} from '../netlify/functions/_shared/release-export-signature.mjs';

const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const privatePem=privateKey.export({format:'pem',type:'pkcs8'}).toString();
const publicPem=publicKey.export({format:'pem',type:'spki'}).toString();
const attacker=generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'}).toString();
const commit='a'.repeat(40),deployId='b'.repeat(24),runId='43130466854';
const doc={
  exportedAt:'2026-11-11T22:30:00.000Z',
  release:{commit,deployId},
  certification:{verifiedAt:'2026-11-11T22:30:00.000Z'},
  themeQA:{runId},
  currentProduction:{observedCommit:commit,observedDeployId:deployId,matchesCertifiedRelease:true},
};
const pdfRenderer=()=>new TextEncoder().encode('%PDF-1.4\n'+'Synthetic harmless test PDF content\n'.repeat(12)+'%%EOF\n');
const artifacts=serializedCertifiedReleaseArtifacts(doc,pdfRenderer);
const signed=signCertifiedReleaseArtifacts(artifacts,doc,privatePem);
assert.equal(signed.signatureAlgorithm,'Ed25519');
assert.equal(signed.release.commit,commit);
assert.equal(signed.release.deployId,deployId);
assert.equal(signed.release.githubRunId,runId);
assert.equal(signed.artifacts.pdf.name,'koa-certified-release-'+deployId+'.pdf');
assert.equal(signed.artifacts.json.name,'koa-certified-release-'+deployId+'.json');
const verified=verifySignedCertifiedReleaseArtifacts({
  ...artifacts,manifest:signed,trustedPublicKeyPem:publicPem,
});
assert.equal(verified.verified,true);
assert.equal(verified.requiresLiveProductionRecheck,true);
for(const invalid of [
 {pdfBytes:Buffer.concat([artifacts.pdfBytes,Buffer.from('altered')])},
 {jsonBytes:Buffer.concat([artifacts.jsonBytes,Buffer.from('altered')])},
 {manifest:{...signed,signatures:{...signed.signatures,pdf:'invalid'}}},
 {manifest:{...signed,signatures:{...signed.signatures,manifest:'invalid'}}},
 {manifest:{...signed,release:{...signed.release,commit:'c'.repeat(40)}}},
 {trustedPublicKeyPem:attacker},
]){
  assert.throws(()=>verifySignedCertifiedReleaseArtifacts({
    ...artifacts,manifest:signed,trustedPublicKeyPem:publicPem,...invalid,
  }),/CERTIFIED_EXPORT_/);
}
assert.throws(()=>signCertifiedReleaseArtifacts(artifacts,doc,''),/SIGNING_KEY_UNAVAILABLE/);
assert.throws(()=>signCertifiedReleaseArtifacts(artifacts,doc,'not a key'),/SIGNING_KEY_INVALID/);
assert.throws(()=>signCertifiedReleaseArtifacts(artifacts,{...doc,
  currentProduction:{...doc.currentProduction,matchesCertifiedRelease:false}},privatePem),/STALE_PRODUCTION/);
const data=new TextDecoder().decode(artifacts.jsonBytes);
assert.equal(JSON.parse(data).release.commit,commit);
assert(!JSON.stringify(signed).includes('PRIVATE KEY'),'Private key bytes are never part of signatures.');
console.log('PASS | Ed25519 detached signatures verify exact PDF/JSON bytes and manifest against a separately trusted public key; tampering, attacker key and missing key fail closed.');
