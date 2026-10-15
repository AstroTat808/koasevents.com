// Privacy-safe, immutable production-release attestation exports.
// This module is side-effect-free and intentionally has no access to credentials.
const SHOTS=[
  ['light-phone','Light / iPhone 390x844'],
  ['dark-phone','Dark / iPhone 390x844'],
  ['light-desktop','Light / desktop 1440x900'],
  ['dark-desktop','Dark / desktop 1440x900'],
];
const sha40=/^[a-f0-9]{40}$/i;
const deploy24=/^[a-f0-9]{24}$/i;
const cleaned=(value,max=240)=>String(value??'').replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,max);
const nat=(value)=>Math.max(0,Math.floor(Number(value)||0));
const timestamp=(value)=>{const date=new Date(String(value||''));return Number.isFinite(date.getTime())?date.toISOString():'';};
const browserTheme=(value)=>({
  routes:nat(value?.routes),cases:nat(value?.cases),
  failures:nat(value?.failureCount),failedRoutes:nat(value?.failedRouteCount),
  reportMissing:value?.reportMissing===true,
});
const browserResponsive=(value)=>({
  cases:nat(value?.cases),viewports:nat(value?.viewports),
  viewportNames:(Array.isArray(value?.viewportNames)?value.viewportNames:[]).map(x=>cleaned(x,60)).filter(Boolean).slice(0,20),
  criticalFailures:nat(value?.criticalCount),designAdvisories:nat(value?.designCount),
  reportMissing:value?.reportMissing===true,
});
function isCertified(row){
  const a=row?.releaseAttestation||{},v=row?.visualQuality||{},r=row?.responsiveQuality||{};
  if(!sha40.test(String(row?.commit||''))||!deploy24.test(String(row?.deployId||'')))return false;
  if(a.status!=='verified'||a.productionGateState!=='success'||a.deployContext!=='production'
    ||a.deployState!=='ready'||a.matchingDeployId!==true
    ||a.expectedSha!==row.commit||a.deployId!==row.deployId||a.liveDeployId!==row.deployId
    ||a.visualQaConclusion!=='success'||a.responsiveQaConclusion!=='success'
    ||a.systemHealth?.overall!=='healthy'||nat(a.systemHealth?.failed)!==0
    ||!timestamp(a.verifiedAt))return false;
  if(v.status!=='passed'||v.commit!==row.commit||v.deployId!==row.deployId||r.status!=='passed'
    ||r.commit!==row.commit||r.deployId!==row.deployId||!v.runId||!r.runId
    ||v.runId!==a.visualQaRunId||r.runId!==a.visualQaRunId)return false;
  for(const browser of ['chromium','webkit']){
    const theme=browserTheme(v[browser]),responsive=browserResponsive(r[browser]);
    if(theme.reportMissing||!theme.routes||!theme.cases||theme.failures||theme.failedRoutes
      ||responsive.reportMissing||!responsive.cases||!responsive.viewports||responsive.criticalFailures)return false;
  }
  return true;
}
export function buildCertifiedReleaseExport(releases,options={}){
  const rows=Array.isArray(releases)?releases:[];
  const latest=rows.filter(isCertified).sort((a,b)=>
    Date.parse(b.releaseAttestation.verifiedAt)-Date.parse(a.releaseAttestation.verifiedAt)
  )[0];
  if(!latest)throw new Error('No complete, independently certified production release is available for export.');
  const a=latest.releaseAttestation,v=latest.visualQuality,r=latest.responsiveQuality;
  const deployId=latest.deployId,commit=latest.commit;
  const rawShots=new Map((Array.isArray(v.screenshots)?v.screenshots:[]).map(x=>[cleaned(x?.key,40),x]));
  const origin='https://koasevents.com';
  const screenshots=SHOTS.map(([key,title])=>{
    const shot=rawShots.get(key);
    return {key,title,recorded:Boolean(shot),
      protectedUrl:shot?origin+'/api/admin/health?action=dark-mode-qa-screenshot&deployId='+
        encodeURIComponent(deployId)+'&key='+encodeURIComponent(key):null,
      width:shot?nat(shot.width):null,height:shot?nat(shot.height):null,
      browser:shot?cleaned(shot.browser,16):null,contentType:shot?cleaned(shot.contentType,50):null,
    };
  });
  const productionCommit=cleaned(options.productionCommit,80);
  const productionDeployId=cleaned(options.productionDeployId,80);
  return {
    schemaVersion:1,
    documentType:'koa-certified-production-release',
    exportedAt:new Date().toISOString(),
    source:'System Health immutable certified release history',
    release:{
      commit,deployId,
      publishedAt:timestamp(latest.publishedAt||a.publishedAt),
      pullRequestNumber:latest.pullRequestNumber==null?null:nat(latest.pullRequestNumber),
    },
    certification:{
      status:'verified',verifiedAt:timestamp(a.verifiedAt),
      source:cleaned(a.source,60),expectedSha:cleaned(a.expectedSha,80),
      netlifyDeployId:cleaned(a.deployId,80),liveDeployId:cleaned(a.liveDeployId,80),
      deployState:cleaned(a.deployState,40),deployContext:cleaned(a.deployContext,40),
      deployMatchesLive:a.matchingDeployId===true,productionGate:'success',
      systemHealth:{overall:'healthy',passed:nat(a.systemHealth.passed),failed:0,
        checkedAt:timestamp(a.systemHealth.checkedAt)},
    },
    themeQA:{
      status:'passed',runId:cleaned(v.runId,40),checkedAt:timestamp(v.checkedAt),
      commit:cleaned(v.commit,80),deployId:cleaned(v.deployId,80),
      chromium:browserTheme(v.chromium),webkit:browserTheme(v.webkit),
    },
    responsiveQA:{
      status:'passed',runId:cleaned(r.runId,40),checkedAt:timestamp(r.checkedAt),
      commit:cleaned(r.commit,80),deployId:cleaned(r.deployId,80),
      chromium:browserResponsive(r.chromium),webkit:browserResponsive(r.webkit),
    },
    screenshotReferences:screenshots,
    currentProduction:{
      observedCommit:productionCommit||null,
      observedDeployId:productionDeployId||null,
      matchesCertifiedRelease:Boolean(productionCommit&&productionDeployId&&productionCommit===commit&&productionDeployId===deployId),
    },
    evidenceLinks:{
      githubRun:'https://github.com/AstroTat808/koasevents.com/actions/runs/'+encodeURIComponent(String(a.visualQaRunId||'')),
      netlifyDeploy:'https://app.netlify.com/projects/koasevents-website/deploys/'+encodeURIComponent(deployId),
    },
    privacy:'Only release metadata and authenticated screenshot references are exported; no screenshot pixels, token material, customer data, or production response payloads.',
  };
}

function ascii(value){
  return String(value??'').normalize('NFKD').replace(/[^\x20-\x7e]/g,'?');
}
function pdfEscape(value){
  return ascii(value).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
}
function wrap(value,length=91){
  const text=ascii(value);
  if(text.length<=length)return [text];
  const result=[];let remaining=text;
  while(remaining.length>length){
    let breakAt=remaining.lastIndexOf(' ',length);
    if(breakAt<Math.floor(length/2))breakAt=length;
    result.push(remaining.slice(0,breakAt));
    remaining=remaining.slice(breakAt).trimStart();
  }
  if(remaining)result.push(remaining);
  return result;
}
function pdfPages(document){
  const lines=[];
  const push=(text='',bold=false,size=10)=>{
    for(const part of wrap(text,size>12?67:91))lines.push({text:part,bold,size,height:size>12?22:14});
  };
  const heading=(title)=>{push('');push(title.toUpperCase(),true,12);};
  push("KOA'S EVENTS | PRODUCTION RELIABILITY",true,13);
  push('CERTIFIED RELEASE ATTESTATION',true,18);
  push('Immutable System Health evidence | Generated: '+document.exportedAt);
  heading('Release identity');
  push('GitHub commit: '+document.release.commit);
  push('Netlify deploy: '+document.release.deployId);
  push('Published: '+document.release.publishedAt);
  push('Current live production matches: '+(document.currentProduction.matchesCertifiedRelease?'YES':'NO / NOT VERIFIED'));
  heading('Final certification');
  push('Certification: VERIFIED | Final production gate: SUCCESS');
  push('Certified at: '+document.certification.verifiedAt);
  push('GitHub run: '+document.themeQA.runId+' | Source: '+document.certification.source);
  push('Live deploy matches certified deploy: YES | Context: production | State: ready');
  push('System Health: '+document.certification.systemHealth.overall.toUpperCase()+
       ' | Passed: '+document.certification.systemHealth.passed+
       ' | Failed: '+document.certification.systemHealth.failed);
  push('System Health checked: '+document.certification.systemHealth.checkedAt);
  heading('Chromium / WebKit Theme QA');
  push('Theme QA checked: '+document.themeQA.checkedAt);
  for(const name of ['chromium','webkit']){
    const b=document.themeQA[name];
    push(name.toUpperCase()+': '+b.routes+' routes | '+b.cases+' cases | '+
      b.failures+' failures | '+b.failedRoutes+' failed routes');
  }
  push('Theme QA commit: '+document.themeQA.commit);
  push('Theme QA deploy: '+document.themeQA.deployId);
  heading('Responsive browser QA');
  push('Responsive checked: '+document.responsiveQA.checkedAt);
  for(const name of ['chromium','webkit']){
    const b=document.responsiveQA[name];
    push(name.toUpperCase()+': '+b.viewports+' viewports | '+b.cases+' cases | '+
      b.criticalFailures+' critical | '+b.designAdvisories+' advisories');
    push('Viewports: '+b.viewportNames.join(', '));
  }
  push('Responsive commit: '+document.responsiveQA.commit);
  push('Responsive deploy: '+document.responsiveQA.deployId);
  heading('Protected screenshots');
  for(const shot of document.screenshotReferences){
    push(shot.title+': '+(shot.recorded?'RECORDED - authenticated URL below':'NOT RECORDED'),true);
    if(shot.protectedUrl)push(shot.protectedUrl);
  }
  heading('Evidence sources / privacy');
  push(document.evidenceLinks.githubRun);
  push(document.evidenceLinks.netlifyDeploy);
  push(document.privacy);
  push('Verification is an archived release assertion. Current production match is independently indicated above.');
  const pages=[[]];let y=737;
  for(const row of lines){
    if(y<65){pages.push([]);y=737;}
    pages[pages.length-1].push({...row,y});
    y-=row.height;
  }
  return pages;
}
export function certifiedReleasePdf(document){
  const pages=pdfPages(document),objects=[];
  objects[1]='<< /Type /Catalog /Pages 2 0 R >>';
  const references=pages.map((_,i)=>(5+i*2)+' 0 R').join(' ');
  objects[2]='<< /Type /Pages /Kids [ '+references+' ] /Count '+pages.length+' >>';
  objects[3]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objects[4]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';
  pages.forEach((rows,i)=>{
    const pageObject=5+i*2,streamObject=pageObject+1;
    const commands=rows.map(row=>{
      const font=row.bold?'F2':'F1';
      return 'BT /'+font+' '+row.size+' Tf 50 '+row.y+' Td ('+pdfEscape(row.text)+') Tj ET';
    });
    commands.push('BT /F1 8 Tf 50 37 Td (Koa Events | Certified release evidence | Page '+(i+1)+' of '+pages.length+') Tj ET');
    const stream=commands.join('\n')+'\n';
    objects[pageObject]='<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents '+streamObject+' 0 R >>';
    objects[streamObject]='<< /Length '+stream.length+' >>\nstream\n'+stream+'endstream';
  });
  let pdf='%PDF-1.4\n';
  const offsets=[0];
  for(let id=1;id<objects.length;id++){
    offsets[id]=pdf.length;
    pdf+=id+' 0 obj\n'+objects[id]+'\nendobj\n';
  }
  const xref=pdf.length;
  pdf+='xref\n0 '+objects.length+'\n0000000000 65535 f \n';
  for(let id=1;id<objects.length;id++){
    pdf+=String(offsets[id]).padStart(10,'0')+' 00000 n \n';
  }
  pdf+='trailer\n<< /Size '+objects.length+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';
  return new TextEncoder().encode(pdf);
}
