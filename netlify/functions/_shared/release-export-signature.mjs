// Detached, cryptographically verifiable PDF/JSON signatures.
// Ed25519 (RFC 8032) signs the actual serialized bytes with domain separation.
// A separately pinned public key is required for independent trust: a key
// bundled alongside an artifact is not an authenticity trust anchor.
import {
  createHash,createPrivateKey,createPublicKey,sign,verify
} from 'node:crypto';

const sha256=data=>createHash('sha256').update(data).digest('hex');
const domain=name=>Buffer.from('KOA_CERTIFIED_RELEASE_'+name+'_V1\0','utf8');
const serialize=doc=>Buffer.from(JSON.stringify(doc,null,2)+'\n','utf8');
const digest=(bytes)=>({sha256:sha256(bytes),size:bytes.length});

function requireEd25519Private(pem){
  if(!String(pem||'').trim())throw new Error('CERTIFIED_EXPORT_SIGNING_KEY_UNAVAILABLE');
  let key;
  try{key=createPrivateKey(pem);}catch{throw new Error('CERTIFIED_EXPORT_SIGNING_KEY_INVALID');}
  if(key.asymmetricKeyType!=='ed25519')throw new Error('CERTIFIED_EXPORT_SIGNING_KEY_INVALID');
  return key;
}

export function serializedCertifiedReleaseArtifacts(document,pdfRenderer){
  const jsonBytes=serialize(document);
  const pdfBytes=Buffer.from(pdfRenderer(document));
  if(!pdfBytes.subarray(0,8).toString('utf8').startsWith('%PDF-')
    ||jsonBytes.length<100||pdfBytes.length<100){
    throw new Error('CERTIFIED_EXPORT_SERIALIZATION_INVALID');
  }
  return {pdfBytes,jsonBytes};
}

export function signCertifiedReleaseArtifacts({pdfBytes,jsonBytes},document,privatePem){
  const key=requireEd25519Private(privatePem);
  const publicKey=createPublicKey(key);
  const spki=publicKey.export({format:'der',type:'spki'});
  const keyId='sha256:'+sha256(spki);
  const payload={
    schemaVersion:1,
    documentType:'koa-certified-production-release-detached-signature',
    signatureAlgorithm:'Ed25519',
    keyId,
    signedAt:document.exportedAt,
    release:{
      commit:document.release?.commit,
      deployId:document.release?.deployId,
      githubRunId:document.themeQA?.runId,
    },
    artifacts:{
      pdf:{name:'koa-certified-release-'+document.release.deployId+'.pdf',...digest(pdfBytes)},
      json:{name:'koa-certified-release-'+document.release.deployId+'.json',...digest(jsonBytes)},
    },
    // Signed status proves what the deployment was at issuance, not that it
    // remains deployed forever. Live/current status must be checked online.
    statusScope:'verified-current-production-at-export-time',
  };
  if(document.currentProduction?.matchesCertifiedRelease!==true
    ||!document.currentProduction?.observedCommit
    ||document.currentProduction.observedCommit!==payload.release.commit
    ||document.currentProduction.observedDeployId!==payload.release.deployId){
    throw new Error('CERTIFIED_EXPORT_STALE_PRODUCTION');
  }
  const signBytes=(name,bytes)=>sign(null,Buffer.concat([domain(name),bytes]),key).toString('base64');
  return {
    ...payload,
    signatures:{
      pdf:signBytes('PDF',pdfBytes),
      json:signBytes('JSON',jsonBytes),
      manifest:signBytes('MANIFEST',serialize(payload)),
    },
    publicKeySpkiBase64:spki.toString('base64'),
    verificationNote:'Verify with a separately trusted, pinned Ed25519 public key. A valid historical signature alone does not establish current deployment status.',
  };
}

export function verifySignedCertifiedReleaseArtifacts({pdfBytes,jsonBytes,manifest,trustedPublicKeyPem}={}){
  if(!trustedPublicKeyPem)throw new Error('CERTIFIED_EXPORT_TRUST_ANCHOR_REQUIRED');
  let pub;
  try{pub=createPublicKey(trustedPublicKeyPem);}catch{
    throw new Error('CERTIFIED_EXPORT_TRUST_ANCHOR_INVALID');
  }
  if(pub.asymmetricKeyType!=='ed25519')throw new Error('CERTIFIED_EXPORT_TRUST_ANCHOR_INVALID');
  const spki=pub.export({format:'der',type:'spki'});
  const expectedKey='sha256:'+sha256(spki);
  if(manifest?.keyId!==expectedKey||manifest?.signatureAlgorithm!=='Ed25519'
    ||manifest?.schemaVersion!==1)throw new Error('CERTIFIED_EXPORT_SIGNER_UNTRUSTED');

  const {signatures,publicKeySpkiBase64,verificationNote,...payload}=manifest;
  if(publicKeySpkiBase64!==spki.toString('base64')
    ||payload.documentType!=='koa-certified-production-release-detached-signature'){
    throw new Error('CERTIFIED_EXPORT_MANIFEST_INVALID');
  }
  const pdf=Buffer.from(pdfBytes),json=Buffer.from(jsonBytes);
  for(const [name,bytes] of [['pdf',pdf],['json',json]]){
    const row=payload.artifacts?.[name];
    if(row?.sha256!==sha256(bytes)||row?.size!==bytes.length)
      throw new Error('CERTIFIED_EXPORT_BYTES_MISMATCH');
    if(!verify(null,Buffer.concat([domain(name.toUpperCase()),bytes]),pub,
      Buffer.from(String(signatures?.[name]||''),'base64')))
      throw new Error('CERTIFIED_EXPORT_SIGNATURE_INVALID');
  }
  if(!verify(null,Buffer.concat([domain('MANIFEST'),serialize(payload)]),pub,
    Buffer.from(String(signatures?.manifest||''),'base64')))
    throw new Error('CERTIFIED_EXPORT_MANIFEST_SIGNATURE_INVALID');
  let document;
  try{document=JSON.parse(json.toString('utf8'));}catch{
    throw new Error('CERTIFIED_EXPORT_DOCUMENT_INVALID');
  }
  if(document.release?.commit!==payload.release.commit
    ||document.release?.deployId!==payload.release.deployId
    ||document.themeQA?.runId!==payload.release.githubRunId
    ||document.currentProduction?.matchesCertifiedRelease!==true
    ||document.exportedAt!==payload.signedAt
    ||!String(document.certification?.verifiedAt||'').trim()){
    throw new Error('CERTIFIED_EXPORT_DOCUMENT_IDENTITY_MISMATCH');
  }
  return {verified:true,keyId:expectedKey,
    release:payload.release,statusScope:payload.statusScope,
    requiresLiveProductionRecheck:true};
}
