import { execFileSync } from 'node:child_process';

const REPOSITORY='AstroTat808/koasevents.com';
const REQUIRED_WORKFLOW='Production visual QA';

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
  const parentLine=git('rev-list','--parents','-n','1',commit);
  const parts=parentLine.split(/\s+/).filter(Boolean);
  const parents=parts.slice(1);

  if(parents.length>=2){
    return {
      headSha:parents[1],
      source:'merge-second-parent',
    };
  }

  const pulls=await githubJson('/commits/'+encodeURIComponent(commit)+'/pulls');
  const candidates=(Array.isArray(pulls)?pulls:[])
    .filter((pr)=>pr?.merged_at&&String(pr?.base?.ref||'')==='main'&&pr?.head?.sha)
    .sort((a,b)=>Date.parse(String(b?.merged_at||''))-Date.parse(String(a?.merged_at||'')));

  if(!candidates.length){
    throw new Error('Production commit is not traceable to a merged pull request.');
  }

  return {
    headSha:String(candidates[0].head.sha),
    source:'associated-pull-request',
    prNumber:Number(candidates[0].number||0),
  };
}

function newestRun(runs){
  return [...runs].sort((a,b)=>{
    const byNumber=Number(b?.run_number||0)-Number(a?.run_number||0);
    if(byNumber)return byNumber;
    return Date.parse(String(b?.created_at||''))-Date.parse(String(a?.created_at||''));
  })[0]||null;
}

async function main(){
  const context=String(process.env.CONTEXT||'').trim().toLowerCase();

  if(context!=='production'){
    console.log('[koa release gate] Non-production context; remote production gate not required.');
    return;
  }

  const commit=String(process.env.COMMIT_REF||'HEAD').trim()||'HEAD';
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

  let payload;
  try{
    payload=await githubJson(
      '/actions/runs?head_sha='+encodeURIComponent(headSha)+
      '&event=pull_request&per_page=50'
    );
  }catch(error){
    fail(error instanceof Error?error.message:String(error));
  }

  const matching=(Array.isArray(payload?.workflow_runs)?payload.workflow_runs:[])
    .filter((run)=>String(run?.name||'')===REQUIRED_WORKFLOW);
  const latest=newestRun(matching);

  if(!latest){
    fail(
      'No '+REQUIRED_WORKFLOW+' pull-request run exists for '+headSha+
      '. Production deploy blocked.'
    );
  }

  if(String(latest?.status||'')!=='completed'||String(latest?.conclusion||'')!=='success'){
    fail(
      REQUIRED_WORKFLOW+' for '+headSha+' is '+
      String(latest?.status||'unknown')+'/'+String(latest?.conclusion||'none')+
      '. Production deploy blocked.'
    );
  }

  console.log(
    '[koa release gate] PASS · '+REQUIRED_WORKFLOW+
    ' #'+String(latest?.run_number||'')+
    ' succeeded for PR head '+headSha+
    ' via '+String(resolved?.source||'unknown')+'.'
  );
}

await main();
