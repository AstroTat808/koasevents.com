#!/usr/bin/env node
/**
 * Fail-closed Koa's Events release certification for each proposed PR HEAD.
 *
 * Uses current GitHub refs (not the PR's potentially stale base_sha), current
 * workflow runs, and Netlify's commit-bound deployment status. Netlify's own
 * preview build gate independently rejects COMMIT_REF != the live PR HEAD.
 *
 * When NETLIFY_AUTH_TOKEN is available, this additionally validates the
 * preview deploy's actual commit_ref directly through the Netlify API.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO=process.env.GITHUB_REPOSITORY||'AstroTat808/koasevents.com';
const PR_NUMBER=Number(process.env.RELEASE_PR_NUMBER||0);
const EXPECTED_HEAD=String(process.env.RELEASE_EXPECTED_HEAD||'').trim().toLowerCase();
const GITHUB_TOKEN=String(process.env.GITHUB_TOKEN||'').trim();
const NETLIFY_TOKEN=String(process.env.NETLIFY_AUTH_TOKEN||'').trim();
const NETLIFY_SITE_ID='d1f3ab06-be2a-41c4-b770-59e6a6acd1b9';
const NETLIFY_CONTEXT='netlify/koasevents-website/deploy-preview';
const REQUIRED_WORKFLOWS=['Production visual QA','Branch hygiene','VenueLoom tenant isolation CI'];
const OUT_DIR='release-certification';
const META_PATH=OUT_DIR+'/candidate.json';
const SHA=/^[a-f0-9]{40}$/i;
const mode=process.argv[2]||'--preflight';

function assert(test,message){if(!test)throw new Error(message);}
function assertSha(value,label){assert(SHA.test(String(value||'')),label+' must be a full SHA.');}
function state(run){
  if(!run)return {kind:'pending',reason:'No exact-head workflow run exists yet.'};
  if(run.status!=='completed')return {kind:'pending',reason:run.name+' is '+run.status+'.'};
  return run.conclusion==='success'
    ? {kind:'ok',reason:run.name+' passed.'}
    : {kind:'failure',reason:run.name+' finished '+String(run.conclusion||'unknown')+' in '+String(run.html_url||run.id||'unknown')+'.'};
}
function mostRecent(items){
  return [...items].sort((a,b)=>
    Number(b.run_number||0)-Number(a.run_number||0)
    || Number(b.run_attempt||0)-Number(a.run_attempt||0)
    || Date.parse(b.created_at||0)-Date.parse(a.created_at||0))[0]||null;
}
function validateEvidence(browser,report){
  assert(report&&report.browser===browser,'Missing or wrong '+browser+' report.');
  assert(Number.isInteger(report.routes)&&report.routes>0,'No '+browser+' routes.');
  assert(Number.isInteger(report.cases)&&report.cases>0,'No '+browser+' cases.');
  assert(Array.isArray(report.results)&&report.results.length===report.cases,browser+' results/cases mismatch.');
  assert(Array.isArray(report.failures)&&report.failures.length===0,browser+' has '+String(report.failures?.length??'missing')+' failures.');
  assert(report.results.every(row=>!row.failure),browser+' contains failing route results.');
  for(const [viewport,width,height] of [['phone',390,844],['desktop',1440,900]]){
    const matches=report.results.filter(row=>
      row.route==='/admin/platform/'&&row.preference==='dark'&&row.viewport===viewport
      &&row.width===width&&row.height===height&&row.failure==='');
    assert(matches.length===1,browser+' /admin/platform/ Dark Mode missing/failed at '+width+'x'+height+'.');
  }
  return {browser,routes:report.routes,cases:report.cases,failures:0,platform:{phone:'passed',desktop:'passed'}};
}
function assertHealthCode(){
  const code=readFileSync('netlify/functions/_shared/system-health.ts','utf8');
  const fn=code.slice(code.indexOf('export function classifyHealthIssue('),code.indexOf('export function classifyHealthIssue(')+1800);
  assert(fn.includes("id==='dark-mode-qa'")&&fn.includes("return 'Service Failure'"),
    'Dark Mode QA does not classify as Service Failure.');
  assert(fn.indexOf("id==='dark-mode-qa'")<fn.indexOf("return 'External Dependency Problem'"),
    'Dark Mode QA classification occurs after upstream error handling.');
  assert(code.includes('status:ok?200:mismatch?409:422'),
    'Dark Mode QA must use HTTP 422 on regression and 409 on mismatch, not a 5xx status.');
}
function selfTest(){
  assert(state({name:'QA',status:'completed',conclusion:'success'}).kind==='ok','CI pass test');
  assert(state({name:'QA',status:'completed',conclusion:'failure'}).kind==='failure','CI fail test');
  assert(state({name:'QA',status:'queued'}).kind==='pending','CI pending test');
  const row=(viewport,w,h)=>({route:'/admin/platform/',preference:'dark',viewport,width:w,height:h,failure:''});
  const ok={browser:'webkit',routes:1,cases:2,results:[row('phone',390,844),row('desktop',1440,900)],failures:[]};
  validateEvidence('webkit',ok);
  let caught=false;
  try{validateEvidence('webkit',{...ok,results:[row('phone',390,844),{...row('desktop',1440,900),failure:'contrast failed'}],failures:[{route:'/admin/platform/'}]});}
  catch{caught=true;}
  assert(caught,'Failed Dark Mode QA was not rejected.');
  caught=false;
  try{validateEvidence('webkit',{...ok,results:[row('phone',390,844),row('phone',390,844)]});}
  catch{caught=true;}
  assert(caught,'Missing desktop platform proof was not rejected.');
  console.log('PASS | release CI state and exact-browser-evidence negative tests.');
}
async function json(url,token){
  const response=await fetch(url,{
    headers:{
      Accept:'application/vnd.github+json',
      Authorization:'Bearer '+token,
      'X-GitHub-Api-Version':'2022-11-28',
      'User-Agent':'Koa-Release-Certification',
    },
    signal:AbortSignal.timeout(15000),
  });
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error('GET '+url+' returned HTTP '+response.status+' · '+String(body?.message||'').slice(0,300));
  return body;
}
async function github(path){return json('https://api.github.com/repos/'+REPO+path,GITHUB_TOKEN);}
async function netlifyDeploy(deployId){
  if(!NETLIFY_TOKEN)return null;
  const response=await fetch('https://api.netlify.com/api/v1/deploys/'+deployId,{
    headers:{Authorization:'Bearer '+NETLIFY_TOKEN,Accept:'application/json'},
    signal:AbortSignal.timeout(15000),
  });
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error('Netlify deploy '+deployId+' returned HTTP '+response.status+'.');
  return body;
}
async function snapshot(){
  const [pr,main]=await Promise.all([github('/pulls/'+PR_NUMBER),github('/branches/main')]);
  assert(pr.number===PR_NUMBER&&pr.state==='open'&&!pr.draft,'PR is no longer open and ready for review.');
  assert(pr.base?.ref==='main','PR does not target main.');
  assert(String(pr.head?.sha||'').toLowerCase()===EXPECTED_HEAD,'FAIL CLOSED: PR HEAD changed from '+EXPECTED_HEAD+' to '+pr.head?.sha+'.');
  const mainSha=String(main.commit?.sha||'').toLowerCase();
  assertSha(mainSha,'Current main');
  const compare=await github('/compare/'+mainSha+'...'+EXPECTED_HEAD);
  assert(compare.behind_by===0&&compare.ahead_by>0&&compare.merge_base_commit?.sha===mainSha,
    'FAIL CLOSED: PR is behind/diverged from current main '+mainSha+' (behind '+compare.behind_by+', ahead '+compare.ahead_by+').');
  const [runData,statusData]=await Promise.all([
    github('/actions/runs?head_sha='+EXPECTED_HEAD+'&event=pull_request&per_page=100'),
    github('/statuses/'+EXPECTED_HEAD+'?per_page=100'),
  ]);
  const runs=Array.isArray(runData.workflow_runs)?runData.workflow_runs:[];
  const checkMap={};
  for(const name of REQUIRED_WORKFLOWS){
    const run=mostRecent(runs.filter(r=>r.name===name&&r.head_sha===EXPECTED_HEAD&&r.event==='pull_request'));
    const result=state(run);
    checkMap[name]={...result,runId:run?.id||null,runUrl:run?.html_url||null};
  }
  const statuses=(Array.isArray(statusData)?statusData:[]).filter(x=>x.context===NETLIFY_CONTEXT);
  const latest=statuses[0];
  const deployId=statuses.map(x=>String(x.target_url||'').match(/\/deploys\/([a-f0-9]{24})(?:[/?#]|$)/i)?.[1]||'').find(Boolean);
  const preview=latest?.state==='success'&&deployId?{kind:'ok'}:
    latest?.state==='failure'||latest?.state==='error'
      ?{kind:'failure',reason:'Netlify Deploy Preview status '+latest.state+' for exact head.'}
      :{kind:'pending',reason:'Netlify Deploy Preview success/deploy ID not reported for exact head.'};
  if(preview.kind==='ok'&&NETLIFY_TOKEN){
    const deploy=await netlifyDeploy(deployId);
    assert(deploy.id===deployId&&deploy.site_id===NETLIFY_SITE_ID
       &&deploy.review_id===PR_NUMBER&&deploy.commit_ref===EXPECTED_HEAD
       &&deploy.context==='deploy-preview'&&deploy.state==='ready',
      'FAIL CLOSED: Netlify preview '+deployId+' metadata does not match exact PR HEAD/site/review or is not ready.');
  }
  return {
    pr:PR_NUMBER,head:EXPECTED_HEAD,main:mainSha,
    checks:checkMap,preview:{...preview,deployId:deployId||null,commitBinding:'GitHub Netlify status for exact HEAD',
      independentNetlifyCommitVerified:Boolean(NETLIFY_TOKEN&&preview.kind==='ok')},
    checkedAt:new Date().toISOString(),
  };
}
function failed(gate){
  return Object.entries(gate.checks).filter(([,value])=>value.kind==='failure').map(([name,x])=>name+': '+x.reason)
    .concat(gate.preview.kind==='failure'?[gate.preview.reason]:[]);
}
function pending(gate){
  return Object.entries(gate.checks).filter(([,value])=>value.kind==='pending').map(([name,x])=>name+': '+x.reason)
    .concat(gate.preview.kind==='pending'?[gate.preview.reason]:[]);
}
async function preflight(){
  const deadline=Date.now()+30*60*1000;
  for(;;){
    const gate=await snapshot();
    const bad=failed(gate);
    if(bad.length)throw new Error('Required exact-head checks failed: '+bad.join(' | '));
    const remaining=pending(gate);
    if(!remaining.length){
      const runId=gate.checks['Production visual QA'].runId;
      assert(Number.isInteger(runId)&&runId>0,'No valid exact-head Production Visual QA run ID.');
      mkdirSync(OUT_DIR,{recursive:true});
      writeFileSync(META_PATH,JSON.stringify(gate,null,2)+'\n');
      if(process.env.GITHUB_OUTPUT){
        appendFileSync(process.env.GITHUB_OUTPUT,'qa_run_id='+runId+'\npreview_deploy_id='+gate.preview.deployId+'\n');
      }
      console.log('PASS | current main '+gate.main+' is ancestor of exact PR HEAD '+gate.head+
        '; three CI checks and Netlify preview '+gate.preview.deployId+' passed.');
      return;
    }
    if(Date.now()>=deadline)throw new Error('Release certification timed out: '+remaining.join(' | '));
    console.log('Pending exact-head checks: '+remaining.join(' | '));
    await sleep(30000);
  }
}
function evidence(){
  const result=[];
  for(const browser of ['chromium','webkit']){
    const report=JSON.parse(readFileSync(OUT_DIR+'/theme-'+browser+'/report.json','utf8'));
    result.push(validateEvidence(browser,report));
  }
  assertHealthCode();
  const proof={browsers:result,verifiedAt:new Date().toISOString(),serviceFailure:true,failedQaStatus:422,mismatchStatus:409};
  writeFileSync(OUT_DIR+'/evidence.json',JSON.stringify(proof,null,2)+'\n');
  for(const r of result)console.log('PASS | '+r.browser+': '+r.routes+' routes, '+r.cases+' cases, 0 failures; /admin/platform/ Dark Mode passes 390x844 and 1440x900.');
  console.log('PASS | System Health Dark Mode QA classification is Service Failure with non-5xx 422.');
}
async function final(){
  const initial=JSON.parse(readFileSync(META_PATH,'utf8'));
  const proof=JSON.parse(readFileSync(OUT_DIR+'/evidence.json','utf8'));
  assert(proof.browsers?.length===2&&proof.serviceFailure===true,'Browser/System Health evidence missing.');
  const gate=await snapshot();
  assert(gate.head===initial.head&&gate.main===initial.main,'FAIL CLOSED: PR HEAD or main changed after initial certification.');
  assert(failed(gate).length===0&&pending(gate).length===0,'FAIL CLOSED: exact-head required checks changed status.');
  assert(gate.checks['Production visual QA'].runId===initial.checks['Production visual QA'].runId,
    'FAIL CLOSED: QA run was replaced after evidence download.');
  assert(gate.preview.deployId===initial.preview.deployId,'FAIL CLOSED: preview deployment changed after evidence check.');
  writeFileSync(OUT_DIR+'/final-attestation.json',JSON.stringify({...gate,evidence:proof},null,2)+'\n');
  console.log('PASS | FINAL exact-head release attestation for PR #'+gate.pr+': '+gate.head+
    ' based on main '+gate.main+', Netlify preview '+gate.preview.deployId+'.');
}
try{
  if(mode==='--self-test')selfTest();
  else{
    assert(Number.isInteger(PR_NUMBER)&&PR_NUMBER>0,'RELEASE_PR_NUMBER must be a positive PR number.');
    assertSha(EXPECTED_HEAD,'RELEASE_EXPECTED_HEAD');
    assert(GITHUB_TOKEN.length>0,'GITHUB_TOKEN is required; fail closed.');
    if(mode==='--preflight')await preflight();
    else if(mode==='--evidence')evidence();
    else if(mode==='--final')await final();
    else throw new Error('Unknown mode '+mode+'.');
  }
}catch(error){
  console.error('[release-certification] FAIL CLOSED: '+String(error?.message||error));
  process.exitCode=1;
}
