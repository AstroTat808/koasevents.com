import { execFileSync } from 'node:child_process';

const REPOSITORY='AstroTat808/koasevents.com';
const REQUIRED_WORKFLOW='Production visual QA';
const REQUIRED_WORKFLOWS=[REQUIRED_WORKFLOW,'Branch hygiene','VenueLoom tenant isolation CI','Release Certification'];
const PREVIEW_CONTEXT='netlify/koasevents-website/deploy-preview';

function git(...args){
  return execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
}

function fail(message){
  console.error('[koa release gate] '+message);
  process.exit(1);
}

async function githubJson(path){
  const token=String(process.env.GITHUB_RELEASE_GATE_TOKEN||process.env.GITHUB_TOKEN||'').trim();
  const headers={
    Accept:'application/vnd.github+json',
    'User-Agent':'koasevents-netlify-release-gate',
    'X-GitHub-Api-Version':'2022-11-28',
  };
  if(token)headers.Authorization='Bearer '+token;

  let lastError=null;
  for(let attempt=1;attempt<=4;attempt+=1){
    try{
      const response=await fetch('https://api.github.com/repos/'+REPOSITORY+path,{
        headers,
        signal:AbortSignal.timeout(15_000),
      });
      const text=await response.text();
      let body={};
      try{body=text?JSON.parse(text):{};}catch{body={message:text};}
      if(response.ok)return body;

      const remaining=response.headers.get('x-ratelimit-remaining');
      const reset=response.headers.get('x-ratelimit-reset');
      const retryable=response.status===429
        ||response.status>=500
        ||(response.status===403&&remaining==='0');
      lastError=new Error(
        'GitHub API '+path+' returned HTTP '+response.status+
        (body?.message?' · '+String(body.message).slice(0,240):'')+
        (remaining!=null?' · rate remaining '+remaining:'')+
        (reset?' · reset '+reset:'')
      );
      if(!retryable||attempt===4)throw lastError;

      let delay=Math.min(1000*(2**(attempt-1)),5000);
      if(response.status===403&&remaining==='0'&&reset){
        const untilReset=(Number(reset)*1000)-Date.now();
        if(Number.isFinite(untilReset)&&untilReset>0&&untilReset<=10_000){
          delay=Math.max(delay,untilReset+250);
        }
      }
      console.warn('[koa release gate] GitHub API transient failure; retry '+attempt+'/4 in '+delay+'ms.');
      await new Promise((resolve)=>setTimeout(resolve,delay));
    }catch(error){
      lastError=error instanceof Error?error:new Error(String(error));
      const transient=error?.name==='TimeoutError'
        ||error?.name==='AbortError'
        ||error instanceof TypeError;
      if(!transient||attempt===4)throw lastError;
      const delay=Math.min(1000*(2**(attempt-1)),5000);
      console.warn('[koa release gate] GitHub API network failure; retry '+attempt+'/4 in '+delay+'ms.');
      await new Promise((resolve)=>setTimeout(resolve,delay));
    }
  }
  throw lastError||new Error('GitHub API request failed.');
}

function matchingMergedPulls(pulls,commit,headSha=''){
  const expectedCommit=String(commit||'').toLowerCase();
  const expectedHead=String(headSha||'').toLowerCase();
  return (Array.isArray(pulls)?pulls:[])
    .filter((pr)=>pr?.merged_at
      &&String(pr?.base?.ref||'')==='main'
      &&pr?.head?.sha
      &&String(pr?.merge_commit_sha||'').toLowerCase()===expectedCommit
      &&(!expectedHead||String(pr?.head?.sha||'').toLowerCase()===expectedHead))
    .sort((a,b)=>Date.parse(String(b?.merged_at||''))-Date.parse(String(a?.merged_at||'')));
}

async function resolvePullRequestHead(commit){
  const parentLine=git('rev-list','--parents','-n','1',commit);
  const parts=parentLine.split(/\s+/).filter(Boolean);
  const parents=parts.slice(1);
  const pulls=await githubJson('/commits/'+encodeURIComponent(commit)+'/pulls');

  if(parents.length>=2){
    const headSha=String(parents[1]||'');
    const candidates=matchingMergedPulls(pulls,commit,headSha);
    if(!candidates.length){
      throw new Error('Merge commit '+commit+' is not bound to a merged main pull request whose head is second parent '+headSha+'.');
    }
    return {
      headSha,
      source:'merge-second-parent+pull-request',
      prNumber:Number(candidates[0].number||0),
    };
  }

  const candidates=matchingMergedPulls(pulls,commit);
  if(!candidates.length){
    throw new Error('Production commit is not traceable to a merged pull request.');
  }

  return {
    headSha:String(candidates[0].head.sha),
    source:'associated-pull-request',
    prNumber:Number(candidates[0].number||0),
  };
}

function belongsToExactPullHead(run,headSha){
  // GitHub frequently returns pull_requests: [] for previously successful
  // workflow runs after their pull request is merged. The head_sha + event
  // fields remain authoritative, so do not depend on that mutable association.
  return String(run?.head_sha||'').toLowerCase()===String(headSha||'').toLowerCase()
    &&String(run?.event||'')==='pull_request';
}

function selfTest(){
  const sha='a'.repeat(40);
  const merge='c'.repeat(40);
  const associated={head_sha:sha,event:'pull_request',name:REQUIRED_WORKFLOW,status:'completed',
    conclusion:'success',pull_requests:[]};
  if(!belongsToExactPullHead(associated,sha))throw Error('An exact-head successful run with no PR association was rejected.');
  if(belongsToExactPullHead({...associated,head_sha:'b'.repeat(40)},sha))throw Error('A stale SHA was accepted.');
  if(belongsToExactPullHead({...associated,event:'push'},sha))throw Error('A push run was accepted as PR evidence.');
  if(belongsToExactPullHead({...associated,head_sha:''},sha))throw Error('A missing workflow SHA was accepted.');

  const mergedPr={number:251,merged_at:'2026-10-10T04:52:08Z',base:{ref:'main'},head:{sha},merge_commit_sha:merge};
  if(matchingMergedPulls([mergedPr],merge,sha).length!==1)throw Error('Exact merged-PR binding was rejected.');
  if(matchingMergedPulls([{...mergedPr,head:{sha:'b'.repeat(40)}}],merge,sha).length)throw Error('Wrong PR head was accepted.');
  if(matchingMergedPulls([{...mergedPr,merge_commit_sha:'d'.repeat(40)}],merge,sha).length)throw Error('Wrong merge commit was accepted.');
  if(matchingMergedPulls([{...mergedPr,base:{ref:'develop'}}],merge,sha).length)throw Error('Wrong base branch was accepted.');

  console.log('PASS | exact-head workflow provenance and merged-PR binding reject stale or mismatched release evidence.');
}

function newestRun(runs){
  return [...runs].sort((a,b)=>{
    const byNumber=Number(b?.run_number||0)-Number(a?.run_number||0);
    if(byNumber)return byNumber;
    return Date.parse(String(b?.created_at||''))-Date.parse(String(a?.created_at||''));
  })[0]||null;
}

async function assertHeadContainsLiveMain(headSha) {
  const latestMain=await githubJson('/branches/main');
  const mainSha=String(latestMain?.commit?.sha||'').toLowerCase();
  if(!/^[a-f0-9]{40}$/i.test(mainSha)) fail('Unable to resolve current main SHA.');
  const comparison=await githubJson('/compare/'+mainSha+'...'+encodeURIComponent(headSha));
  if(
    comparison?.behind_by!==0 ||
    Number(comparison?.ahead_by||0)<1 ||
    String(comparison?.merge_base_commit?.sha||'').toLowerCase()!==mainSha
  ){
    fail(
      'Branch is behind or diverged from current main '+mainSha+
      ' · behind '+String(comparison?.behind_by)+
      ' · ahead '+String(comparison?.ahead_by)+'.'
    );
  }
  return mainSha;
}

async function verifyDeployPreviewHead(commit){
  const reviewId=String(process.env.REVIEW_ID||'').trim();
  if(!/^\d+$/.test(reviewId)){
    fail('Deploy Preview is missing a valid REVIEW_ID; exact PR-head verification cannot run.');
  }
  if(!/^[a-f0-9]{40}$/i.test(commit)){
    fail('Deploy Preview COMMIT_REF is not a full commit SHA: '+commit+'.');
  }

  let pull;
  try{
    pull=await githubJson('/pulls/'+encodeURIComponent(reviewId));
  }catch(error){
    fail(error instanceof Error?error.message:String(error));
  }

  const headSha=String(pull?.head?.sha||'').trim();
  if(!/^[a-f0-9]{40}$/i.test(headSha)){
    fail('Unable to resolve the current head SHA for PR #'+reviewId+'.');
  }
  if(String(pull?.state||'')!=='open'){
    fail('PR #'+reviewId+' is not open; Deploy Preview blocked.');
  }
  if(commit.toLowerCase()!==headSha.toLowerCase()){
    fail(
      'Deploy Preview commit '+commit+
      ' does not exactly match current PR #'+reviewId+' head '+headSha+
      '. Stale preview blocked.'
    );
  }

  await assertHeadContainsLiveMain(headSha);

  console.log(
    '[koa release gate] PASS · Deploy Preview commit '+commit+
    ' exactly matches current PR #'+reviewId+' head.'
  );
}

async function main(){
  const context=String(process.env.CONTEXT||'').trim().toLowerCase();
  const commit=String(process.env.COMMIT_REF||'HEAD').trim()||'HEAD';

  if(context==='deploy-preview'){
    await verifyDeployPreviewHead(commit);
    return;
  }

  if(context!=='production'){
    console.log('[koa release gate] Non-production context; remote production gate not required.');
    return;
  }

  const actualMain=await githubJson('/branches/main');
  const latestMainSha=String(actualMain?.commit?.sha||'').toLowerCase();
  if(!/^[a-f0-9]{40}$/i.test(latestMainSha) || commit.toLowerCase()!==latestMainSha){
    fail('Production commit '+commit+' is not exact current main '+latestMainSha+'.');
  }
  let resolved;
  try{
    resolved=await resolvePullRequestHead(commit);
  }catch(error){
    fail(error instanceof Error?error.message:String(error));
  }

  const headSha=String(resolved?.headSha||'').trim();
  if(!/^[a-f0-9]{40}$/i.test(headSha)){
    fail('Unable to resolve the pull-request head SHA for production commit '+commit+'.');
  }
  // Preserve PR provenance through the merged PR object; individual Actions
  // run.pull_requests associations can legitimately be emptied post-merge.
  if(!Number.isInteger(resolved?.prNumber)||resolved.prNumber<=0){
    fail('Production commit '+commit+' is missing authoritative merged pull-request provenance.');
  }
  const merged=await githubJson('/pulls/'+resolved.prNumber);
  if(!merged?.merged_at
    ||String(merged?.base?.ref||'')!=='main'
    ||String(merged?.head?.sha||'').toLowerCase()!==headSha.toLowerCase()
    ||String(merged?.merge_commit_sha||'').toLowerCase()!==commit.toLowerCase()){
    fail('Merged PR #'+resolved.prNumber+' does not bind production commit '+commit+' to approved head '+headSha+'.');
  }

  let payload;
  try{
    payload=await githubJson(
      '/actions/runs?head_sha='+encodeURIComponent(headSha)+
      '&event=pull_request&per_page=50'
    );
  }catch(error){
    fail(error instanceof Error?error.message:String(error));
  }

  const runs=(Array.isArray(payload?.workflow_runs)?payload.workflow_runs:[])
    .filter((run)=>belongsToExactPullHead(run,headSha));
  const matching=runs.filter((run)=>String(run?.name||'')===REQUIRED_WORKFLOW);
  const latest=newestRun(matching);
  if(!latest){
    fail('No '+REQUIRED_WORKFLOW+' pull-request run exists for '+headSha+'. Production deploy blocked.');
  }
  if(String(latest?.status||'')!=='completed'||String(latest?.conclusion||'')!=='success'){
    fail(REQUIRED_WORKFLOW+' for '+headSha+' is '+
      String(latest?.status||'unknown')+'/'+String(latest?.conclusion||'none')+'. Production deploy blocked.');
  }
  for(const name of REQUIRED_WORKFLOWS.filter((value)=>value!==REQUIRED_WORKFLOW)){
    const run=newestRun(runs.filter((row)=>String(row?.name||'')===name));
    if(!run||run?.status!=='completed'||run?.conclusion!=='success'){
      fail('Required '+name+' is '+String(run?.status||'missing')+'/'+String(run?.conclusion||'none')+
        ' for PR head '+headSha+'. Production deploy blocked.');
    }
  }
  const allStatuses=await githubJson('/statuses/'+encodeURIComponent(headSha)+'?per_page=100');
  const previewStatus=(Array.isArray(allStatuses)?allStatuses:[]).find((row)=>row?.context===PREVIEW_CONTEXT);
  if(previewStatus?.state!=='success'){
    fail('Required Netlify preview for exact PR head '+headSha+' is not successful.');
  }

  console.log(
    '[koa release gate] PASS · '+REQUIRED_WORKFLOW+
    ' #'+String(latest?.run_number||'')+
    ' succeeded for PR head '+headSha+
    ' via '+String(resolved?.source||'unknown')+'.'
  );
}

if(process.argv.includes('--self-test')) selfTest();
else await main();
