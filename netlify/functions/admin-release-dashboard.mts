import type { Config, Context } from '@netlify/functions';
import { requireCapability } from './_shared/admin';
import { runWithTenant } from './_shared/tenant';
import { readLatestHealth, readProductionReleases } from './_shared/system-health';
import {
  RELEASE_WORKFLOWS, NETLIFY_SITE_ID, RULESET_ID,
  latestRun, netlifyPreview, extractAttestationZip,
  productionSummary, releaseRow, dashboardTotals,
} from './_shared/release-dashboard.mjs';

const REPO='AstroTat808/koasevents.com';
const GH_ROOT='https://api.github.com/repos/'+REPO;
const NETLIFY_ROOT='https://api.netlify.com/api/v1';
const PER_PAGE=10;
const MAX_PAGES=100;

function errorText(error:unknown){
  return String(error instanceof Error?error.message:error||'Unavailable').slice(0,240);
}
async function getJson(url:string,token:string,provider:'GitHub'|'Netlify'){
  const headers:Record<string,string>={
    Accept:'application/json',
    'User-Agent':'KoaEvents-Release-Dashboard',
  };
  if(provider==='GitHub')headers['X-GitHub-Api-Version']='2022-11-28';
  if(token)headers.Authorization='Bearer '+token;
  const response=await fetch(url,{
    headers,signal:AbortSignal.timeout(12000),
  });
  const json:any=await response.json().catch(()=>({}));
  if(!response.ok){
    throw new Error(provider+' request failed (HTTP '+response.status+
      (response.status===403?' · permissions or rate limit':'')+').');
  }
  return json;
}
async function github(path:string,token:string){
  return getJson(GH_ROOT+path,token,'GitHub');
}
async function netlify(path:string,token:string){
  if(!token)throw new Error('NETLIFY_AUTH_TOKEN is unavailable to the release dashboard.');
  return getJson(NETLIFY_ROOT+path,token,'Netlify');
}
async function downloadAttestation(runId:number,expectedHead:string,githubToken:string){
  const listing=await github('/actions/runs/'+runId+'/artifacts?per_page=25',githubToken);
  const artifact=(Array.isArray(listing.artifacts)?listing.artifacts:[])
    .find((a:any)=>a?.name==='koa-release-certification-'+runId&&!a.expired&&a.size_in_bytes<=524288);
  if(!artifact)throw new Error('Exact-head certification evidence artifact is missing or expired.');
  const archiveHeaders:Record<string,string>={
    Accept:'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28',
  };
  if(githubToken)archiveHeaders.Authorization='Bearer '+githubToken;
  const response=await fetch(GH_ROOT+'/actions/artifacts/'+artifact.id+'/zip',{
    headers:archiveHeaders,redirect:'manual',signal:AbortSignal.timeout(12000),
  });
  let archive=response;
  if(response.status>=300&&response.status<400){
    const location=response.headers.get('location')||'';
    const url=new URL(location);
    if(url.protocol!=='https:'||(!url.hostname.endsWith('.blob.core.windows.net')&&!url.hostname.endsWith('.githubusercontent.com')&&!url.hostname.endsWith('.actions.githubusercontent.com'))){
      throw new Error('Artifact redirect host is not trusted.');
    }
    archive=await fetch(url,{headers:{Accept:'application/zip'},signal:AbortSignal.timeout(12000)});
  }
  if(!archive.ok)throw new Error('Release evidence artifact download HTTP '+archive.status+'.');
  if(Number(archive.headers.get('content-length')||0)>524288)throw new Error('Certification evidence exceeds size budget.');
  const data=new Uint8Array(await archive.arrayBuffer());
  const attestation=extractAttestationZip(data);
  if(attestation?.head!==expectedHead)throw new Error('Certification artifact belongs to a different commit SHA.');
  if(!attestation?.evidence?.browsers)throw new Error('Certification artifact lacks browser QA evidence.');
  return attestation;
}
async function pooled<T,R>(items:T[],limit:number,fn:(item:T)=>Promise<R>):Promise<R[]>{
  let cursor=0;
  const results:R[]=Array(items.length);
  await Promise.all(Array.from({length:Math.min(items.length,limit)},async()=>{
    while(cursor<items.length){
      const index=cursor++;
      results[index]=await fn(items[index]);
    }
  }));
  return results;
}
export default async(req:Request,context:Context)=>{
  const auth=await requireCapability('health.view',req,context);
  if(auth.response)return auth.response;
  const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
  if(!auth.tenant?.storage?.legacyDataBelongsToTenant){
    return Response.json({error:'Koa’s Events administrator tenant required.'},{status:403,headers});
  }
  if(req.method!=='GET')return Response.json({error:'Read-only dashboard.'},{status:405,headers});
  const u=new URL(req.url);
  const pageRaw=u.searchParams.get('page')||'1';
  if(!/^[1-9]\d{0,2}$/.test(pageRaw)||Number(pageRaw)>MAX_PAGES){
    return Response.json({error:'Page must be between 1 and '+MAX_PAGES+'.'},{status:400,headers});
  }
  const page=Number(pageRaw);
  const githubToken=String(Netlify.env.get('KOA_GITHUB_READ_TOKEN')||
    Netlify.env.get('GITHUB_RELEASE_GATE_TOKEN')||'').trim();
  const netlifyToken=String(Netlify.env.get('NETLIFY_AUTH_TOKEN')||'').trim();
  const warnings:string[]=[];
  try{
    const [prList,mainBranch,netlifyResponse,ruleSet,healthContext]=await Promise.all([
      github('/pulls?state=all&sort=updated&direction=desc&per_page='+PER_PAGE+'&page='+page,githubToken),
      github('/branches/main',githubToken),
      netlify('/sites/'+NETLIFY_SITE_ID+'/deploys?per_page=100',netlifyToken).catch((error)=>{
        warnings.push(errorText(error));return null;
      }),
      github('/rulesets/'+RULESET_ID,githubToken).catch((error)=>{
        warnings.push('Branch protection not verified: '+errorText(error));return null;
      }),
      runWithTenant(auth.tenant,async()=>{
        const [snapshot,releases]=await Promise.all([
          readLatestHealth(context).catch(()=>null),
          readProductionReleases(context,40).catch(()=>[]),
        ]);
        return {snapshot,releases};
      }),
    ]);
    const mainSha=String(mainBranch?.commit?.sha||'');
    if(!/^[a-f0-9]{40}$/i.test(mainSha))throw new Error('GitHub current main SHA is unavailable.');
    if(!Array.isArray(prList))throw new Error('GitHub pull request listing is unavailable.');
    const deploys=Array.isArray(netlifyResponse)?netlifyResponse:null;
    const production=productionSummary(mainSha,deploys,healthContext.snapshot);
    const rule=Array.isArray(ruleSet?.rules)
      ?ruleSet.rules.find((r:any)=>r.type==='required_status_checks'):null;
    const required=Array.isArray(rule?.parameters?.required_status_checks)
      ?rule.parameters.required_status_checks:[];
    const protection={
      nativeRequired:Boolean(required.some((c:any)=>c.context==='Exact-head release gate')),
      strict:Boolean(rule?.parameters?.strict_required_status_checks_policy),
      rulesetUrl:'https://github.com/'+REPO+'/rules/'+RULESET_ID,
      verified:Boolean(ruleSet),
    };
    const rows=await pooled(prList,3,async(pr:any)=>{
      const head=String(pr?.head?.sha||'');
      let runs:any[]=[];let comparison:any=null;let attestation:any=null;let certError='';
      try{
        const [runResp,compareResp]=await Promise.all([
          github('/actions/runs?head_sha='+encodeURIComponent(head)+'&event=pull_request&per_page=100',githubToken),
          pr.state==='open'
            ?github('/compare/'+mainSha+'...'+head,githubToken).catch((error)=>{
              warnings.push('PR #'+pr.number+' branch comparison: '+errorText(error));return null;
            }):Promise.resolve(null),
        ]);
        runs=Array.isArray(runResp?.workflow_runs)?runResp.workflow_runs:[];
        comparison=compareResp;
      }catch(error){
        certError='Workflow metadata unavailable: '+errorText(error);
      }
      const cert=latestRun(runs,'Release Certification',head);
      if(cert&&cert.status==='completed'&&cert.conclusion==='success'){
        try{attestation=await downloadAttestation(Number(cert.id),head,githubToken);}
        catch(error){certError='Certificate unreadable: '+errorText(error);}
      }
      const row=releaseRow({pr,runs,deploys,comparison,attestation,prod:production,certError});
      row.healthStatus=(row.deployStatus==='live'?production.health?.status
        :row.deployStatus==='awaiting-production'?'pending-deploy'
        :row.deployStatus==='superseded'?'historical':'not-applicable')||'unavailable';
      row.healthCheckedAt=row.deployStatus==='live'?(production.health?.checkedAt||''):'';
      row.healthPassed=row.deployStatus==='live'?Number(production.health?.passed||0):null;
      row.healthFailed=row.deployStatus==='live'?Number(production.health?.failed||0):null;
      if(row.qa.status==='unknown'&&row.state==='merged'){
        const history=healthContext.releases.find((release:any)=>
          release?.commit===row.mergeSha&&release?.visualQuality?.commit===row.mergeSha);
        const v:any=history?.visualQuality||null;
        if(v&&v.chromium&&v.webkit){
          const format=(b:any)=>({
            routes:Number(b.routes||0),cases:Number(b.cases||0),
            failures:Number(b.failureCount||0),
            phone:'not-attested',desktop:'not-attested',
          });
          row.qa={status:v.status==='passed'?'historical-passed':'historical-failed',
            chromium:format(v.chromium),webkit:format(v.webkit),
            platform:'not-attested',verifiedAt:String(v.checkedAt||'')} as any;
        }
      }
      return row;
    });
    const problems=warnings.slice(0,25);
    return Response.json({
      ok:true,page,perPage:PER_PAGE,hasMore:prList.length===PER_PAGE,
      updatedAt:new Date().toISOString(),
      repository:REPO,mainSha,production,protection,
      totals:dashboardTotals(rows),pullRequests:rows,warnings:problems,
      evidencePolicy:'Unknown/expired evidence is never counted as a pass.',
    },{status:200,headers});
  }catch(error){
    return Response.json({
      ok:false,error:'Release dashboard unavailable: '+errorText(error),
      note:'No release status is inferred without current source evidence.',
    },{status:503,headers});
  }
};
export const config:Config={path:'/api/admin/release-dashboard'};
