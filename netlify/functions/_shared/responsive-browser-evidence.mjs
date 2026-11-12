// Each browser writes its own durable key. A shared read-modify-write release
// JSON would lose either Chromium or WebKit under simultaneous requests.
// The composite is only eligible for Release History after two exact-run reads.
const VALID_SHA=/^[a-f0-9]{40}$/i;
const VALID_DEPLOY=/^[a-f0-9]{24}$/i;
const VALID_RUN=/^[1-9][0-9]{3,19}$/;
const BROWSERS=['chromium','webkit'];

export function responsiveBrowserEvidenceKey({deployId,commit,runId,browser}={}){
  if(!VALID_DEPLOY.test(String(deployId||''))
    ||!VALID_SHA.test(String(commit||''))
    ||!VALID_RUN.test(String(runId||''))
    ||!BROWSERS.includes(String(browser||''))){
    throw new Error('RESPONSIVE_EVIDENCE_IDENTITY_INVALID');
  }
  return ['deployments/releases/responsive-by-browser',
    String(deployId),String(commit).toLowerCase(),String(runId),String(browser)].join('/');
}

function matches(identity,row,browser){
  return Boolean(row
    &&row.deployId===identity.deployId
    &&row.commit===identity.commit
    &&row.runId===identity.runId
    &&row.browser===browser
    &&typeof row.checkedAt==='string'
    &&Number.isFinite(Date.parse(row.checkedAt))
    &&row.report?.browser===browser
    &&Number.isInteger(row.report?.cases)
    &&row.report.cases>0
    &&Number.isInteger(row.report?.viewports)
    &&row.report.viewports>0
    &&Array.isArray(row.report?.viewportNames)
    &&row.report.viewportNames.length>0
    &&Number.isInteger(row.report?.criticalCount)
    &&row.report.criticalCount>=0
    &&row.report.reportMissing===false);
}

/**
 * Adapter contract: store.setJSON(key, value), store.get(key, {type:'json',
 * consistency:'strong'}). Never writes a composite release record here.
 * Concurrent browser invocations can only write distinct keys.
 */
export async function persistIndependentResponsiveBrowserEvidence(store,input={}){
  const identity={
    deployId:String(input.deployId||''),
    commit:String(input.commit||'').toLowerCase(),
    runId:String(input.runId||''),
  };
  const browser=String(input.browser||'');
  const checkedAt=String(input.checkedAt||'');
  const report=input.report;
  const record={...identity,browser,checkedAt,report};
  const ownKey=responsiveBrowserEvidenceKey({...identity,browser});
  if(!matches(identity,record,browser))throw new Error('RESPONSIVE_EVIDENCE_REPORT_INVALID');

  await store.setJSON(ownKey,record);
  const own=await store.get(ownKey,{type:'json',consistency:'strong'});
  if(!matches(identity,own,browser)||own.checkedAt!==checkedAt
     ||JSON.stringify(own.report)!==JSON.stringify(report)){
    throw new Error('RESPONSIVE_EVIDENCE_DURABLE_READBACK_FAILED');
  }
  const [chromium,webkit]=await Promise.all(BROWSERS.map(async(name)=>{
    const key=responsiveBrowserEvidenceKey({...identity,browser:name});
    const value=await store.get(key,{type:'json',consistency:'strong'});
    return matches(identity,value,name)?value:null;
  }));
  const complete=Boolean(chromium&&webkit);
  const failed=complete&&(
    chromium.report.criticalCount>0||webkit.report.criticalCount>0
  );
  const lastCheckedAt=[chromium?.checkedAt,webkit?.checkedAt,checkedAt]
    .filter(Boolean).sort().at(-1);
  return {
    stored:true,
    complete,
    responsiveQuality:{
      checkedAt:lastCheckedAt,
      status:!complete?'partial':failed?'failed':'passed',
      source:'production-responsive-qa',
      ...identity,
      chromium:chromium?.report||null,
      webkit:webkit?.report||null,
    },
  };
}
