#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildCertifiedReleaseExport, certifiedReleasePdf } from '../netlify/functions/_shared/release-attestation-export.mjs';
import { verifyCertifiedExportNegativeProbes } from '../netlify/functions/_shared/certified-export-security-probe.mjs';

const sha='a'.repeat(40),deploy='b'.repeat(24),runId='38761414583';
const screenshots=['light-phone','dark-phone','light-desktop','dark-desktop'].map(key=>({
  key,width:key.includes('phone')?390:1440,height:key.includes('phone')?844:900,
  browser:'chromium',contentType:'image/jpeg',
}));
const visualBrowser={browser:'chromium',routes:70,cases:287,failureCount:0,failedRouteCount:0,reportMissing:false};
const responsiveBrowser={browser:'chromium',cases:490,viewports:7,viewportNames:['phone-small','phone','tablet','tablet-wide','desktop-small','desktop','desktop-wide'],criticalCount:0,designCount:2,reportMissing:false};
const release={
  deployId:deploy,commit:sha,commitTitle:'PRIVATE_CLIENT_MARKER_EMAIL',
  publishedAt:'2026-10-15T15:34:34.524Z',pullRequestNumber:277,
  releaseAttestation:{
    status:'verified',verifiedAt:'2026-10-15T16:40:00.000Z',expectedSha:sha,deployId:deploy,liveDeployId:deploy,
    matchingDeployId:true,deployState:'ready',deployContext:'production',visualQaRunId:runId,
    visualQaConclusion:'success',responsiveQaConclusion:'success',
    systemHealth:{overall:'healthy',passed:83,failed:0,checkedAt:'2026-10-15T16:35:00.000Z'},
    productionGateState:'success',source:'github-actions-oidc',
  },
  visualQuality:{status:'passed',runId,checkedAt:'2026-10-15T16:15:00.000Z',commit:sha,deployId:deploy,
    chromium:visualBrowser,webkit:{...visualBrowser,browser:'webkit'},screenshots},
  responsiveQuality:{status:'passed',runId,checkedAt:'2026-10-15T16:25:00.000Z',commit:sha,deployId:deploy,
    chromium:responsiveBrowser,webkit:{...responsiveBrowser,browser:'webkit'}},
};
const newerPending={...release,deployId:'c'.repeat(24),releaseAttestation:null};
const exported=buildCertifiedReleaseExport([newerPending,release],{productionCommit:sha,productionDeployId:deploy});
assert.equal(exported.release.deployId,deploy,'Must choose latest fully certified release, not newest pending.');
assert.equal(exported.certification.status,'verified');
assert.equal(exported.certification.productionGate,'success');
assert.equal(exported.certification.systemHealth.failed,0);
assert.equal(exported.themeQA.chromium.routes,70);
assert.equal(exported.themeQA.webkit.failures,0);
assert.equal(exported.responsiveQA.chromium.viewports,7);
assert.equal(exported.responsiveQA.webkit.criticalFailures,0);
assert.equal(exported.screenshotReferences.length,4);
assert(exported.screenshotReferences.every(shot=>shot.recorded&&shot.protectedUrl.includes('dark-mode-qa-screenshot')));
assert.equal(exported.currentProduction.matchesCertifiedRelease,true);
assert(!JSON.stringify(exported).includes('PRIVATE_CLIENT_MARKER_EMAIL'),'Export cannot copy arbitrary commit titles or customer data.');
assert(!JSON.stringify(exported).includes('NETLIFY_AUTH_TOKEN'),'No credential names or values are exported.');
for(const modified of [
 {...release,releaseAttestation:{...release.releaseAttestation,status:'failed'}},
 {...release,releaseAttestation:{...release.releaseAttestation,systemHealth:{overall:'unhealthy',passed:82,failed:1}}},
 {...release,releaseAttestation:{...release.releaseAttestation,liveDeployId:'f'.repeat(24)}},
 {...release,responsiveQuality:{...release.responsiveQuality,webkit:{...responsiveBrowser,criticalCount:1}}},
 {...release,visualQuality:{...release.visualQuality,webkit:{...visualBrowser,reportMissing:true}}},
]){
 assert.throws(()=>buildCertifiedReleaseExport([modified]),/certified/,'Incomplete evidence must never export as certified.');
}
// Synthetic per-assertion evidence is retained in both formats only when it
// matches the exact signed release SHA, deploy and GitHub Actions run.
const proofCases=verifyCertifiedExportNegativeProbes();
assert.equal(proofCases.ok,true);
assert.equal(proofCases.cases.length,36);
assert.equal(new Set(proofCases.cases.map(row=>row.id)).size,36);
const signedSecurity={
  status:'passed',source:'github-actions-oidc',
  checkedAt:'2026-10-15T16:30:00.000Z',commit:sha,deployId:deploy,runId,
  expected:36,denied:36,formats:['pdf','json'],cases:proofCases.cases,
  byteVerified:true,byteVerifiedAt:'2026-10-15T16:41:00.000Z',byteVerifiedRunId:runId,
};
const signedRelease={...release,certifiedExportSecurity:signedSecurity};
const pendingSecurity={...signedSecurity,byteVerified:false};
assert.throws(
  ()=>buildCertifiedReleaseExport([{...release,certifiedExportSecurity:pendingSecurity}],{productionCommit:sha,productionDeployId:deploy}),
  /certified/,'Before the serialized-byte proof, an otherwise certified release must not be exportable.',
);
const internalDocument=buildCertifiedReleaseExport(
  [{...release,certifiedExportSecurity:pendingSecurity}],
  {productionCommit:sha,productionDeployId:deploy,allowPendingByteProof:true},
);
assert.equal(internalDocument.certifiedExportSecurity.cases.length,36);
const withSecurity=buildCertifiedReleaseExport([signedRelease],{productionCommit:sha,productionDeployId:deploy});
assert.equal(withSecurity.certifiedExportSecurity.status,'passed');
assert.equal(withSecurity.certifiedExportSecurity.signedEvidence,true);
assert.equal(withSecurity.certifiedExportSecurity.cases.length,36);
assert.equal(withSecurity.certifiedExportSecurity.runId,runId);
assert.equal(withSecurity.certifiedExportSecurity.commit,sha);
assert.equal(withSecurity.certifiedExportSecurity.deployId,deploy);
const securityPdf=new TextDecoder().decode(certifiedReleasePdf(withSecurity));
assert(securityPdf.includes('SIGNED RESULT: 36 / 36'));
for(const row of proofCases.cases)assert(securityPdf.includes(row.id),'PDF must retain every synthetic assertion name.');
assert.equal(exported.certifiedExportSecurity.status,'not-recorded','Historical evidence may not imply passed security probes.');
assert.equal(exported.certifiedExportSecurity.signedEvidence,false);
const historicalPdf=new TextDecoder().decode(certifiedReleasePdf(exported));
assert(historicalPdf.includes('HISTORICAL: Signed 36-case'));
assert(!historicalPdf.includes('SIGNED RESULT: 36 / 36'));
for(const broken of [
  {...signedSecurity,status:'failed'},
  {...signedSecurity,source:'untrusted'},
  {...signedSecurity,commit:'f'.repeat(40)},
  {...signedSecurity,deployId:'f'.repeat(24)},
  {...signedSecurity,runId:'other'},
  {...signedSecurity,denied:35},
  {...signedSecurity,expected:35},
  {...signedSecurity,checkedAt:'2026-10-16T16:30:00.000Z'},
  {...signedSecurity,cases:proofCases.cases.slice(1)},
  {...signedSecurity,cases:[proofCases.cases[0],...proofCases.cases.slice(0,35)]},
  {...signedSecurity,formats:['json']},
  {...signedSecurity,byteVerified:false},
  {...signedSecurity,byteVerifiedRunId:'other'},
  {...signedSecurity,byteVerifiedAt:'2026-10-01T00:00:00.000Z'},
])assert.throws(
  ()=>buildCertifiedReleaseExport([{...release,certifiedExportSecurity:broken}]),
  /certified/,'Forged, incomplete, or mismatched 36-test evidence must never export as certified.',
);
assert(!JSON.stringify(withSecurity).includes('PRIVATE_CLIENT_MARKER_EMAIL'));
assert(!securityPdf.includes('PRIVATE_CLIENT_MARKER_EMAIL'));

const pdf=certifiedReleasePdf(exported);
const text=new TextDecoder().decode(pdf);
assert(text.startsWith('%PDF-1.4\n'),'Must emit PDF bytes.');
assert(text.includes('%%EOF'),'Must emit a valid PDF trailer.');
assert(text.includes('CHROMIUM / WEBKIT THEME QA'));
assert(text.includes(sha));
assert(text.includes(deploy));
assert(text.includes('390x844'));
assert(!text.includes('PRIVATE_CLIENT_MARKER_EMAIL'));
const offset=Number(text.match(/startxref\n(\d+)\n/)?.[1]);
assert(Number.isFinite(offset)&&text.slice(offset).startsWith('xref\n'),'Cross-reference table must point to exact byte offset.');
const entries=[...text.matchAll(/^\d{10} 00000 n $/gm)].map(row=>Number(row[0].slice(0,10)));
for(let id=1;id<entries.length+1;id++)assert(text.slice(entries[id-1]).startsWith(id+' 0 obj'),'Every PDF xref points to the correct object.');
console.log('PASS | certified-only PDF/JSON export: exact identity, zero-failure evidence, protected screenshots, no PII, valid xref.');
