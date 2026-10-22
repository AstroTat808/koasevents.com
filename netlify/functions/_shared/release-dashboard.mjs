import { inflateRawSync } from 'node:zlib';

export const RELEASE_WORKFLOWS=[
  'Release Certification',
  'Production visual QA',
  'Branch hygiene',
  'VenueLoom tenant isolation CI',
];
// Historical merged certificates retain their original policy; new candidates
// must additionally carry the current safety/browser workflows.
export const CURRENT_RELEASE_WORKFLOWS=[...RELEASE_WORKFLOWS,
  'Critical Integrations rollback drill','Calendar contrast regression','CI privacy gate',
];
export const NETLIFY_SITE_ID='d1f3ab06-be2a-41c4-b770-59e6a6acd1b9';
export const RULESET_ID=23722583;

export function latestRun(runs,name,head){
  return (Array.isArray(runs)?runs:[])
    .filter(r=>r?.name===name&&String(r?.head_sha||'')===head&&r?.event==='pull_request')
    .sort((a,b)=>Number(b?.run_number||0)-Number(a?.run_number||0)
      ||Number(b?.run_attempt||0)-Number(a?.run_attempt||0)
      ||Date.parse(b?.created_at||0)-Date.parse(a?.created_at||0))[0]||null;
}
export function checkSummary(run){
  return {
    status:!run?'missing':run.status!=='completed'?'pending':run.conclusion==='success'?'passed':'failed',
    conclusion:run?.conclusion||null,runId:run?.id||null,
    url:run?.html_url||'',updatedAt:run?.updated_at||'',
  };
}
export function netlifyPreview(deploys,number,head){
  if(!Array.isArray(deploys))return {status:'unavailable',id:'',sha:'',url:'',exact:false};
  const options=deploys.filter(d=>d?.context==='deploy-preview'&&Number(d?.review_id)===Number(number));
  options.sort((a,b)=>Date.parse(b?.created_at||0)-Date.parse(a?.created_at||0));
  const d=options.find(d=>d?.commit_ref===head)||options[0];
  if(!d)return {status:'not-found',id:'',sha:'',url:'',exact:false};
  const exact=d.commit_ref===head&&d.state==='ready'&&Number(d.review_id)===Number(number);
  const status=exact?'ready':d.commit_ref!==head?'stale':d.state==='error'?'failed':'pending';
  return {status,id:String(d.id||''),sha:String(d.commit_ref||''),
    url:String(d.deploy_ssl_url||d.deploy_url||''),exact,
    error:d.state==='error'?'Netlify preview failed; inspect protected deployment diagnostics.':''};
}
export function extractAttestationZip(bytes){
  const zip=Buffer.from(bytes);
  if(zip.length>524288||zip.length<30)throw new Error('Release attestation ZIP size is unexpected.');
  let eocd=-1;
  for(let i=zip.length-22;i>=Math.max(0,zip.length-65557);i--){
    if(zip.readUInt32LE(i)===0x06054b50){eocd=i;break;}
  }
  if(eocd<0)throw new Error('ZIP central directory not found.');
  const count=zip.readUInt16LE(eocd+10),offset=zip.readUInt32LE(eocd+16);
  if(count>40||offset>=zip.length)throw new Error('Invalid attestation ZIP directory.');
  let cursor=offset;
  for(let i=0;i<count;i++){
    if(cursor+46>zip.length||zip.readUInt32LE(cursor)!==0x02014b50)throw new Error('Invalid central file header.');
    const method=zip.readUInt16LE(cursor+10);
    const compressed=zip.readUInt32LE(cursor+20),uncompressed=zip.readUInt32LE(cursor+24);
    const fileNameLen=zip.readUInt16LE(cursor+28),extra=zip.readUInt16LE(cursor+30),comment=zip.readUInt16LE(cursor+32);
    const local=zip.readUInt32LE(cursor+42);
    const name=zip.subarray(cursor+46,cursor+46+fileNameLen).toString('utf8');
    cursor+=46+fileNameLen+extra+comment;
    if(name!=='final-attestation.json')continue;
    if(uncompressed<1||uncompressed>150000||compressed>180000||local+30>zip.length||zip.readUInt32LE(local)!==0x04034b50)
      throw new Error('Invalid or oversized release attestation entry.');
    const start=local+30+zip.readUInt16LE(local+26)+zip.readUInt16LE(local+28);
    if(start+compressed>zip.length)throw new Error('Attestation exceeds archive boundaries.');
    const payload=zip.subarray(start,start+compressed);
    // ZIP headers are untrusted. Enforce the limit during inflation, not afterward.
    const decoded=method===8?inflateRawSync(payload,{maxOutputLength:uncompressed}):method===0?payload:null;
    if(!decoded||decoded.length!==uncompressed)throw new Error('Attestation decompression failed.');
    try{return JSON.parse(decoded.toString('utf8'));}
    catch{throw new Error('Release attestation JSON is malformed.');}
  }
  throw new Error('final-attestation.json is missing.');
}
export async function boundedArtifactBytes(response,limit=524288){
  if(!Number.isSafeInteger(limit)||limit<1||limit>524288)throw new Error('Invalid archive byte budget.');
  if(Number(response.headers.get('content-length')||0)>limit){
    await response.body?.cancel().catch(()=>{});
    throw new Error('Certification evidence exceeds size budget.');
  }
  if(!response.body)throw new Error('Certification evidence body is missing.');
  const reader=response.body.getReader(),chunks=[];
  let total=0,complete=false;
  try{
    for(;;){
      const {done,value}=await reader.read();
      if(done){complete=true;break;}
      if(!(value instanceof Uint8Array))throw new Error('Invalid archive byte stream.');
      total+=value.byteLength;
      if(total>limit)throw new Error('Certification evidence exceeds size budget.');
      chunks.push(value);
    }
    const bytes=new Uint8Array(total);
    let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return bytes;
  }finally{
    if(!complete)await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}
export function qaFromAttestation(attestation,head){
  const empty={status:'unknown',chromium:null,webkit:null,platform:'unknown'};
  if(!attestation||attestation.head!==head||!attestation.evidence)return empty;
  const b=attestation.evidence.browsers;
  if(!Array.isArray(b))return empty;
  const lookup=(name)=>b.find(x=>x.browser===name);
  const chromium=lookup('chromium'),webkit=lookup('webkit');
  if(!chromium||!webkit)return empty;
  const valid=(x)=>Number.isInteger(x.routes)&&x.routes>0&&Number.isInteger(x.cases)&&x.cases>0
    &&Number.isInteger(x.failures)&&x.failures>=0
    &&x.platform&&typeof x.platform.phone==='string'&&typeof x.platform.desktop==='string';
  if(!valid(chromium)||!valid(webkit))return empty;
  const pass=[chromium,webkit].every(x=>x.failures===0&&x.platform.phone==='passed'&&x.platform.desktop==='passed')
    &&attestation.evidence.serviceFailure===true
    &&attestation.evidence.failedQaStatus===422;
  const summarize=x=>({routes:x.routes,cases:x.cases,failures:x.failures,phone:x.platform.phone,desktop:x.platform.desktop});
  return {status:pass?'passed':'failed',chromium:summarize(chromium),webkit:summarize(webkit),
    platform:pass?'passed':'failed',certifiedMain:String(attestation.main||''),
    verifiedAt:String(attestation.checkedAt||attestation.evidence.verifiedAt||'')};
}
export function productionSummary(mainSha,deploys,health,publishedDeploy=null){
  const unavailable={status:'unavailable',mainSha,deployId:'',sha:'',publishedAt:'',health:null};
  // A historically published ready build is not proof that it is serving now.
  // Only the site's authoritative published_deploy record may select production.
  const prod=publishedDeploy;
  if(!prod||prod.site_id!==NETLIFY_SITE_ID||prod.context!=='production'
      ||!['ready','current'].includes(prod.state)||!Number.isFinite(Date.parse(prod.published_at||''))
      ||!/^[a-f0-9]{24}$/.test(String(prod.id||''))||!/^[a-f0-9]{40}$/.test(String(prod.commit_ref||'')))return unavailable;
  const checks=Array.isArray(health?.checks)?health.checks:[];
  const deploymentCheck=checks.find(x=>x?.id==='netlify-github-sync');
  const healthCommit=String(deploymentCheck?.deploymentDetails?.netlifyCommit||'');
  const healthDeploy=String(deploymentCheck?.deploymentDetails?.netlifyDeployId||'');
  const checkedAt=Number.isFinite(Date.parse(health?.checkedAt||''))?String(health.checkedAt):'';
  const healthAligned=Boolean(checkedAt&&healthCommit===prod.commit_ref&&healthDeploy===prod.id
    &&Date.parse(checkedAt)>=Date.parse(prod.published_at));
  const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
  const passed=count(health?.passed),failed=count(health?.failed);
  const known={
    'dark-mode-qa':'Dark Mode QA',
    'netlify-github-sync':'Netlify / GitHub synchronization',
  };
  // Release metadata must not republish arbitrary operational or accounting text.
  const unhealthy=checks.filter(x=>x?.ok===false||x?.severity==='red').slice(0,15).map((x,index)=>{
    const trusted=Object.hasOwn(known,x.id);
    return {id:trusted?x.id:'failed-check-'+(index+1),name:trusted?known[x.id]:'System Health check',
      detail:'Failed check; inspect the authorized System Health view for details.'};
  });
  return {
    status:prod.commit_ref===mainSha?'synced':'behind',
    mainSha,sha:String(prod.commit_ref),deployId:String(prod.id),
    publishedAt:String(prod.published_at),url:String(prod.deploy_ssl_url||prod.deploy_url||''),
    health:{
      checkedAt,aligned:healthAligned,status:!health?'unavailable':!healthAligned?'stale':health.overall==='healthy'&&failed===0&&passed!==null&&unhealthy.length===0?'healthy':'unhealthy',
      overall:['healthy','unhealthy','degraded','unknown'].includes(health?.overall)?health.overall:'unknown',passed,
      failed,unhealthy,
    },
  };
}
export function releaseRow({pr,runs,deploys,comparison,attestation,prod,certError}){
  const head=String(pr?.head?.sha||'');
  const number=Number(pr?.number||0),merged=Boolean(pr?.merged_at),isOpen=pr?.state==='open';
  const policy=isOpen?CURRENT_RELEASE_WORKFLOWS:RELEASE_WORKFLOWS;
  const checks=Object.fromEntries(policy.map(name=>[name,checkSummary(latestRun(runs,name,head))]));
  const preview=netlifyPreview(deploys,number,head);
  const qa=qaFromAttestation(attestation,head);
  const behind=isOpen?(comparison&&Number.isInteger(comparison.behind_by)?comparison.behind_by:null):null;
  const failing=Object.values(checks).some(c=>c.status==='failed')||preview.status==='failed'||qa.status==='failed';
  const checked=Object.values(checks).every(c=>c.status==='passed');
  const currentBase=Boolean(prod?.mainSha&&attestation?.main===prod.mainSha);
  const candidateAllowed=!pr?.draft&&pr?.base?.ref==='main'&&behind===0&&currentBase;
  const certified=checked&&preview.exact&&qa.status==='passed'&&!certError&&(isOpen?candidateAllowed:Boolean(attestation));
  const mergeSha=String(pr?.merge_commit_sha||'');
  const deployed=Boolean(merged&&mergeSha&&prod?.sha===mergeSha);
  const deployStatus=merged?(deployed?'live':prod?.mainSha===mergeSha?'awaiting-production':'superseded'):'not-merged';
  return {
    number,title:String(pr?.title||'Untitled pull request').slice(0,200),
    state:merged?'merged':String(pr?.state||'unknown'),draft:Boolean(pr?.draft),
    url:String(pr?.html_url||''),head,branch:String(pr?.head?.ref||''),
    author:String(pr?.user?.login||''),updatedAt:String(pr?.updated_at||''),
    behind,checks,preview,qa,certified,
    certificationStatus:!checked?'pending':!attestation?'unavailable':qa.status==='passed'?'passed':'failed',
    certError:String(certError||'').slice(0,220),
    releaseStatus:merged?'merged':failing?'blocked':certified?'ready':'pending',
    mergeSha,deployStatus,
  };
}
export function dashboardTotals(rows){
  return {shown:rows.length,open:rows.filter(x=>x.state==='open').length,
    merged:rows.filter(x=>x.state==='merged').length,
    certified:rows.filter(x=>x.certified).length,
    blocked:rows.filter(x=>x.releaseStatus==='blocked').length};
}
