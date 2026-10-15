#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildCertifiedReleaseExport, certifiedReleasePdf } from '../netlify/functions/_shared/release-attestation-export.mjs';

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
