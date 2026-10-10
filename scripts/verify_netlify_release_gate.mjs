const REPOSITORY='AstroTat808/koasevents.com';
const REQUIRED_WORKFLOW='Production visual QA';
const REQUIRED_WORKFLOWS=[REQUIRED_WORKFLOW,'Branch hygiene','VenueLoom tenant isolation CI','Release Certification'];
const PREVIEW_CONTEXT='netlify/koasevents-website/deploy-preview';

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
  const response=await fetch('https://api.github.com/repos/'+REPOSITORY+path,{
    headers,
    signal:AbortSignal.timeout(15_000),
  });
  const text=await response.text();
  let body={};
  try{body=text?JSON.parse(text):{};}catch{body={message:text};}
  if(!response.ok){
    const remaining=response.headers.get('x-ratelimit-remaining');
    const reset=response.headers.get('x-ratelimit-reset');
    throw new Error(
      'GitHub API '+path+' returned HTTP '+response.status+
      (body?.message?' · '+String(body.message).slice(0,240):'')+
      (remaining!=null?' · rate remaining '+remaining:'')+
      (reset?' · reset '+reset:'')
    );
  }
  return body;
}

async function resolvePullRequestHead(commit){
  // Netlify's checkout may be shallow: git rev-list --parents can return no
  // parents for a real merge. Resolve authoritative merge provenance via the
  // GitHub commit-to-PR association, not local Git graph completeness.
  const pulls=await githubJson('/commits/'+encodeURIComponent(commit)+'/pulls');
  const candidates=(Array.isArray(pulls)?pulls:[])
    .filter((pr)=>pr?.merged_at
      &&String(pr?.base?.ref||'')==='main'
      &&String(pr?.merge_commit_sha||'').toLowerCase()===commit.toLowerCase()
      &&/^[a-f0-9]{40}$/i.test(String(pr?.head?.sha||'')))
    .sort((a,b)=>Date.parse(String(b?.merged_at||''))-Date.parse(String(a?.merged_at||'')));

  if(candidates.length!==1){
    throw new Error(
      'Production commit '+commit+' has '+candidates.length+
      ' verified merged-main PR associations (exactly one required).'
    );
  }
  return {
    headSha:String(candidates[0].head.sha),
    source:'github-exact-merged-pull-request',
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
  const associated={head_sha:sha,event:'pull_request',name:REQUIRED_WORKFLOW,status:'completed',
    conclusion:'success',pull_requests:[]};
  if(!belongsToExactPullHead(associated,sha))throw Error('An exact-head successful run with no PR association was rejected.');
  if(belongsToExactPullHead({...associated,head_sha:'b'.repeat(40)},sha))throw Error('A stale SHA was accepted.');
  if(belongsToExactPullHead({...associated,event:'push'},sha))throw Error('A push run was accepted as PR evidence.');
  if(belongsToExactPullHead({...associated,head_sha:''},sha))throw Error('A missing workflow SHA was accepted.');
  console.log('PASS | exact-head GitHub workflow provenance is independent of empty post-merge pull_requests arrays.');
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
  console.log('[koa release gate] Inspecting production commit '+commit+' against verified current main '+latestMainSha+'.');
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
  if(resolved?.prNumber){
    const merged=await githubJson('/pulls/'+resolved.prNumber);
    if(!merged?.merged_at
      ||String(merged?.base?.ref||'')!=='main'
      ||String(merged?.head?.sha||'').toLowerCase()!==headSha.toLowerCase()
      ||String(merged?.merge_commit_sha||'').toLowerCase()!==commit.toLowerCase()){
      fail('Merged PR #'+resolved.prNumber+' does not bind production commit '+commit+' to approved head '+headSha+'.');
    }
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

  console.log('[koa release gate] Checking merged PR #'+resolved.prNumber+' exact head '+headSha+' and required GitHub evidence.');
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
