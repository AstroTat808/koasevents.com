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

// Permanent security contract: both output formats share the same certified-only gate.
const handler=readFileSync(new URL('../netlify/functions/admin-health.mts',import.meta.url),'utf8');
const start=handler.indexOf("if(url.searchParams.get('export')==='certified-release')");
const end=handler.indexOf("if(url.searchParams.get('export')==='critical-integrations')",start);
assert(start>=0&&end>start,'Certified export handler must exist.');
const route=handler.slice(start,end);
assert(route.indexOf('if(!admin)')>=0&&route.indexOf('if(!admin)')<route.indexOf('readProductionReleases'),'Unauthorized access must be denied before reading release data.');
assert(route.includes('status:403'),'Unauthorized export must return 403.');
assert(route.includes("format!=='pdf'&&format!=='json'"),'Only PDF and JSON are supported.');
assert(route.includes('buildCertifiedReleaseExport(releases'),'Both formats must share certified-only evidence validation.');
assert(route.includes('status:409'),'Uncertified or missing evidence must return conflict, not certified output.');
assert(route.includes("private, no-store")&&route.includes('nosniff'),'Download cache and MIME sniffing must be disabled.');
assert(route.indexOf("if(format==='json')")>route.indexOf('buildCertifiedReleaseExport'),'JSON must not bypass validation.');
assert(route.indexOf('certifiedReleasePdf(attestation)')>route.indexOf('buildCertifiedReleaseExport'),'PDF must not bypass validation.');
for(const rows of [[],null,[newerPending]])assert.throws(()=>buildCertifiedReleaseExport(rows),/certified/,'Missing or pending evidence fails closed.');
for(const broken of [
 {...release,releaseAttestation:{...release.releaseAttestation,expectedSha:'f'.repeat(40)}},
 {...release,releaseAttestation:{...release.releaseAttestation,productionGateState:'pending'}},
 {...release,releaseAttestation:{...release.releaseAttestation,visualQaConclusion:'failure'}},
 {...release,releaseAttestation:{...release.releaseAttestation,deployContext:'deploy-preview'}},
 {...release,visualQuality:{...release.visualQuality,commit:'f'.repeat(40)}},
 {...release,responsiveQuality:{...release.responsiveQuality,deployId:'f'.repeat(24)}},
 {...release,releaseAttestation:{...release.releaseAttestation,systemHealth:{overall:'healthy',passed:82,failed:1}}},
])assert.throws(()=>buildCertifiedReleaseExport([broken]),/certified/,'Incomplete or mismatched release evidence must be rejected.');
const mismatch=buildCertifiedReleaseExport([release],{productionCommit:'f'.repeat(40),productionDeployId:'f'.repeat(24)});
assert.equal(mismatch.currentProduction.matchesCertifiedRelease,false,'Historical certified releases must never be described as live.');
assert.equal(JSON.parse(JSON.stringify(mismatch)).currentProduction.matchesCertifiedRelease,false);
const mismatchedPdf=new TextDecoder().decode(certifiedReleasePdf(mismatch));
assert(mismatchedPdf.includes('NO / NOT VERIFIED'),'PDF must disclose live deployment mismatch.');
assert(!mismatchedPdf.includes('PRIVATE_CLIENT_MARKER_EMAIL'),'PDF cannot leak customer-bearing commit titles.');

const healthControls={
 status:'passed',source:'github-actions-oidc',runId,chromium:'1440x900',webkit:'390x844',
 cases:["severity-filter","troubleshooting-accordion","keyboard-access","copy-code","clipboard-fallback","private-field-exclusion"]
};
const adminQa={
 status:'passed',source:'github-actions-oidc',browser:'chromium',
 checkedAt:'2026-10-15T16:36:00Z',commit:sha,deployId:deploy,runId,checkedCount:42,
 failureCount:0,failures:[],code:null
};
const adminControlRelease={...release,protectedAdminQa:adminQa,
 releaseAttestation:{...release.releaseAttestation,healthControlsQA:healthControls}};
const adminControlExport=buildCertifiedReleaseExport([adminControlRelease],{productionCommit:sha,productionDeployId:deploy});
assert.equal(adminControlExport.protectedAdminQA.status,'passed');
assert.equal(adminControlExport.protectedAdminQA.failureCount,0);
assert.equal(adminControlExport.protectedAdminQA.runId,runId);
assert.equal(adminControlExport.systemHealthControlsQA.status,'passed');
assert.equal(adminControlExport.systemHealthControlsQA.webkit,'390x844');
assert.equal(adminControlExport.systemHealthControlsQA.chromium,'1440x900');
assert.deepEqual(adminControlExport.systemHealthControlsQA.checks,healthControls.cases);
const adminControlPdf=new TextDecoder().decode(certifiedReleasePdf(adminControlExport));
assert(adminControlPdf.includes('PROTECTED ADMIN BROWSER QA'));
assert(adminControlPdf.includes('SYSTEM HEALTH DIAGNOSTIC CONTROLS'));
assert(adminControlPdf.includes('WEBKIT IPHONE 390X844')||adminControlPdf.includes('WebKit iPhone 390x844'));
assert(!JSON.stringify(adminControlExport).includes('PRIVATE_CLIENT_MARKER_EMAIL'));
for(const bad of [
 {...adminControlRelease,protectedAdminQa:{...adminQa,commit:'c'.repeat(40)}},
 {...adminControlRelease,protectedAdminQa:{...adminQa,status:'failed',failureCount:1,
  failures:[{route:'admin-health',code:'ADMIN_QA_CLIENT_EXCEPTION'}]}},
 {...adminControlRelease,protectedAdminQa:{...adminQa,failures:[{route:'CUSTOMER_EMAIL',code:'ADMIN_QA_TIMEOUT'}]}},
 {...adminControlRelease,releaseAttestation:{...adminControlRelease.releaseAttestation,
  healthControlsQA:{...healthControls,runId:'123'}}},
 {...adminControlRelease,releaseAttestation:{...adminControlRelease.releaseAttestation,
  healthControlsQA:{...healthControls,webkit:'unverified'}}},
 {...adminControlRelease,protectedAdminQa:undefined},
])assert.throws(()=>buildCertifiedReleaseExport([bad]),/certified/,
 'Unsafe, mismatched or missing protected-admin/control QA must never be exported as certified.');
assert.equal(exported.protectedAdminQA.status,'not-recorded');
assert.equal(exported.systemHealthControlsQA.status,'not-recorded');

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
