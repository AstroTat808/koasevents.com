// Read-only production-runtime attestation export negative probes.
// Synthetic release identities only. Never read production storage, secrets, clients or screenshots.
import { buildCertifiedReleaseExport, certifiedReleasePdf } from './release-attestation-export.mjs';

const COMMIT='a'.repeat(40);
const DEPLOY='b'.repeat(24);
const RUN='12345678901';
const browser={routes:70,cases:287,failureCount:0,failedRouteCount:0,reportMissing:false};
const responsive={cases:490,viewports:7,criticalCount:0,reportMissing:false};
const base={
  commit:COMMIT,deployId:DEPLOY,publishedAt:'2026-10-15T10:00:00.000Z',
  releaseAttestation:{
    status:'verified',productionGateState:'success',deployContext:'production',
    deployState:'ready',matchingDeployId:true,expectedSha:COMMIT,deployId:DEPLOY,
    liveDeployId:DEPLOY,visualQaConclusion:'success',responsiveQaConclusion:'success',
    visualQaRunId:RUN,verifiedAt:'2026-10-15T10:15:00.000Z',
    systemHealth:{overall:'healthy',passed:83,failed:0,checkedAt:'2026-10-15T10:14:00.000Z'},
  },
  visualQuality:{
    status:'passed',commit:COMMIT,deployId:DEPLOY,runId:RUN,
    chromium:{...browser},webkit:{...browser},
    screenshots:[],
  },
  responsiveQuality:{
    status:'passed',commit:COMMIT,deployId:DEPLOY,runId:RUN,
    chromium:{...responsive},webkit:{...responsive},
  },
};
const att=(change)=>({...base,releaseAttestation:{...base.releaseAttestation,...change}});
const vis=(change)=>({...base,visualQuality:{...base.visualQuality,...change}});
const resp=(change)=>({...base,responsiveQuality:{...base.responsiveQuality,...change}});

// Stable synthetic negative-case names: no data from production requests.
const CASE_IDS=[
  'NO_RELEASES','MISSING_ATTESTATION','ATTESTATION_FAILED','RELEASE_GATE_PENDING',
  'WRONG_DEPLOY_CONTEXT','DEPLOY_BUILDING','MISMATCHED_LIVE_DEPLOY',
  'MISMATCHED_EXPECTED_SHA','MISMATCHED_REPORTED_DEPLOY','VISUAL_QA_FAILED',
  'UNHEALTHY_SYSTEM','NONZERO_HEALTH_FAILURES','VISUAL_COMMIT_MISMATCH',
  'WEBKIT_VISUAL_REPORT_MISSING','RESPONSIVE_DEPLOY_MISMATCH',
  'WEBKIT_RESPONSIVE_FAILURE','QA_RUN_MISMATCH','MISSING_DEPLOY_ID',
];

function uncertifiedFixtures(){
  return [
    [],
    [{...base,releaseAttestation:null}],
    [att({status:'failed'})],
    [att({productionGateState:'pending'})],
    [att({deployContext:'deploy-preview'})],
    [att({deployState:'building'})],
    [att({matchingDeployId:false})],
    [att({expectedSha:'f'.repeat(40)})],
    [att({liveDeployId:'f'.repeat(24)})],
    [att({visualQaConclusion:'failure'})],
    [att({systemHealth:{overall:'unhealthy',passed:82,failed:1}})],
    [att({systemHealth:{overall:'healthy',passed:82,failed:1}})],
    [vis({commit:'f'.repeat(40)})],
    [vis({webkit:{...browser,reportMissing:true}})],
    [resp({deployId:'f'.repeat(24)})],
    [resp({webkit:{...responsive,criticalCount:1}})],
    [resp({runId:'other-run'})],
    [{...base,deployId:''}],
  ];
}

function encodeRelease(rows,format){
  const evidence=buildCertifiedReleaseExport(rows,{productionCommit:COMMIT,productionDeployId:DEPLOY});
  return format==='pdf' ? certifiedReleasePdf(evidence) : JSON.stringify(evidence);
}

// Run the exact exported gate + serializers bundled into the live production function.
// The routine accepts no request-supplied fixtures and has no external side effects.
export function verifyCertifiedExportNegativeProbes(){
  const formats=['json','pdf'];
  const fixtures=uncertifiedFixtures();
  const expected=formats.length*fixtures.length;
  if(fixtures.length!==CASE_IDS.length)return {ok:false,denied:0,expected,formats,cases:[]};
  const cases=[];
  for(const format of formats){
    for(const [index,rows] of fixtures.entries()){
      let rejected=false;
      try{
        encodeRelease(rows,format);
      }catch(error){
        rejected=error instanceof Error && /certified production release/i.test(error.message);
      }
      if(!rejected)return {ok:false,denied:cases.length,expected,formats,cases};
      cases.push({id:format.toUpperCase()+'_'+CASE_IDS[index],format,outcome:'denied'});
    }
  }
  const validJson=encodeRelease([base],'json');
  const validPdf=new TextDecoder().decode(encodeRelease([base],'pdf'));
  if(JSON.parse(validJson)?.certification?.status!=='verified'||!validPdf.startsWith('%PDF-1.4\\n'))
    return {ok:false,denied:cases.length,expected,formats,cases};
  return {ok:true,denied:cases.length,expected,formats,cases};
}
