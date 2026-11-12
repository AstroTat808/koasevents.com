#!/usr/bin/env node
// Independent verification of the downloaded release PDF, JSON and .sig.json.
// Supply a *separately trusted* public key file, never the embedded key alone.
// Example: node scripts/verify_signed_certified_release_bundle.mjs \
//   --pdf release.pdf --json release.json --signature release.sig.json \
//   --public-key pinned-ed25519-public.pem
import {readFileSync} from 'node:fs';
import {verifySignedCertifiedReleaseArtifacts} from '../netlify/functions/_shared/release-export-signature.mjs';

const args=process.argv.slice(2);
const opts={};
for(let i=0;i<args.length;i+=2){
  if(!args[i]?.startsWith('--')||!args[i+1]){
    console.error('Usage: --pdf FILE --json FILE --signature FILE --public-key PEM');
    process.exit(2);
  }
  opts[args[i].slice(2)]=args[i+1];
}
for(const n of ['pdf','json','signature','public-key']){
  if(!opts[n]){
    console.error('Missing required --'+n+'.');
    process.exit(2);
  }
}
try{
  const verified=verifySignedCertifiedReleaseArtifacts({
    pdfBytes:readFileSync(opts.pdf),
    jsonBytes:readFileSync(opts.json),
    manifest:JSON.parse(readFileSync(opts.signature,'utf8')),
    trustedPublicKeyPem:readFileSync(opts['public-key'],'utf8'),
  });
  console.log(JSON.stringify({
    ...verified,
    verificationScope:'Cryptographically authentic archived artifacts; independently check current GitHub main and Netlify production deployment for live status.',
  },null,2));
}catch{
  console.error('INVALID: certificate bytes, signature, release identity or trusted signer failed verification.');
  process.exitCode=1;
}
