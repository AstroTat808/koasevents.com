#!/usr/bin/env python3
from __future__ import annotations
import argparse, fnmatch, json, os, re, subprocess, sys, time
from collections import Counter
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

UTC=timezone.utc
SHA=re.compile(r"^[0-9a-f]{40}$")
DEFAULT_KEEP=["main","master","develop","development","staging","production","preview","gh-pages","release/*","backup/*","archive/*"]
MARKER="<!-- branch-hygiene:v1 -->"
TITLE="[Maintenance] Branch hygiene - seven-day review queue"

def dt(v):
    if not v:return None
    x=datetime.fromisoformat(str(v).replace("Z","+00:00"))
    if x.tzinfo is None: raise ValueError("timestamp must include timezone")
    return x.astimezone(UTC)
def iso(v): return v.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00","Z")
def git(*args):
    r=subprocess.run(["git",*args],text=True,capture_output=True,timeout=120)
    if r.returncode: raise RuntimeError("git failed: "+r.stderr.strip()[:500])
    return r.stdout.strip()

class Api:
    def __init__(self,repo,token):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+",repo): raise ValueError("repo must be owner/name")
        self.root="https://api.github.com/repos/"+repo; self.token=token
    def request(self,path,method="GET",data=None):
        if not path.startswith("/") or ".." in path: raise ValueError("invalid API path")
        body=None if data is None else json.dumps(data).encode()
        h={"Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","User-Agent":"branch-hygiene-audit"}
        if self.token:h["Authorization"]="Bearer "+self.token
        if body:h["Content-Type"]="application/json"
        for n in range(4):
            try:
                with urlopen(Request(self.root+path,data=body,headers=h,method=method),timeout=45) as r:return json.load(r)
            except HTTPError as e:
                if method=="GET" and e.code in (429,500,502,503,504) and n<3: time.sleep(2**(n+1)); continue
                raise RuntimeError(f"GitHub {method} {path}: HTTP {e.code}")
        raise RuntimeError("API retries exhausted")
    def pages(self,path):
        out=[]
        for page in range(1,101):
            rows=self.request(path+("&" if "?" in path else "?")+f"per_page=100&page={page}")
            if not isinstance(rows,list): raise RuntimeError("unexpected pagination response")
            out.extend(rows)
            if len(rows)<100:return out
        raise RuntimeError("pagination limit exceeded")

class Graph:
    def __init__(self,main):
        self.main=main; self.fp=git("rev-list","--first-parent","--reverse",main).splitlines()
    @lru_cache(maxsize=None)
    def ancestor(self,a,b):
        if not SHA.fullmatch(a) or not SHA.fullmatch(b):return False
        for x in (a,b):
            if subprocess.run(["git","cat-file","-e",x+"^{commit}"],capture_output=True).returncode:return False
        r=subprocess.run(["git","merge-base","--is-ancestor",a,b],capture_output=True)
        if r.returncode not in (0,1): raise RuntimeError("reachability check failed")
        return r.returncode==0
    @lru_cache(maxsize=None)
    def date(self,sha): return git("show","-s","--format=%cI",sha)
    def first_containing(self,sha,patch=False):
        lo,hi=0,len(self.fp)-1
        def contains(c):
            if not patch:return self.ancestor(sha,c)
            rows=git("cherry",c,sha).splitlines()
            return all(x.startswith("- ") for x in rows)
        if not self.fp or not contains(self.fp[-1]):return None
        while lo<hi:
            mid=(lo+hi)//2
            if contains(self.fp[mid]):hi=mid
            else:lo=mid+1
        return self.date(self.fp[lo])
    def evidence(self,sha):
        behind,ahead=map(int,git("rev-list","--left-right","--count",self.main+"..."+sha).split())
        contained=self.ancestor(sha,self.main)
        merges=int(git("rev-list","--count","--merges",self.main+".."+sha))
        cherry=[] if contained else git("cherry",self.main,sha).splitlines()
        equivalent=bool(cherry) and merges==0 and all(x.startswith("- ") for x in cherry)
        landed=self.first_containing(sha,patch=equivalent) if (contained or equivalent) else None
        return {"ahead":ahead,"behind":behind,"contained":contained,"patch_equivalent":equivalent,"unique_merge_commits":merges,"landed_at":landed}

def classify(branch,prs,policy,e,now,main_sha,default):
    name,sha=branch["name"],branch["commit"]["sha"]
    activity=[dt(branch["committed_at"])]
    for p in prs:
        for k in ("updated_at","merged_at","closed_at"):
            if p.get(k):activity.append(dt(p[k]))
    last=max(activity); anchor=last
    row={"branch":name,"sha":sha,"group":"needs-review","reason":"","ahead_of_main":e["ahead"],"behind_main":e["behind"],"pull_requests":[p["number"] for p in prs],"last_known_activity":iso(last),"eligible_at":None,"flag_after_7_days":False,"evidence":e}
    active=[p for p in prs if p["state"]=="open"]
    if branch.get("snapshot_changed"): row["reason"]="Branch moved during the scan; classification withheld until a consistent re-scan."
    elif name==default or branch.get("protected"): row["group"],row["reason"]="keep","Default branch or protected by GitHub."
    elif active: row["group"],row["reason"]="keep","Open PR dependency: "+", ".join("#"+str(p["number"]) for p in active)+"."
    elif any(fnmatch.fnmatchcase(name,p) for p in DEFAULT_KEEP+policy.get("keep",[])): row["group"],row["reason"]="keep","Reserved environment/release/backup branch or explicit keep policy."
    elif e["contained"]:
        row["group"]="safe-to-delete"; row["reason"]=f"Tip {sha[:12]} is reachable from main {main_sha[:12]}; no unique commit is lost."
        if e.get("landed_at"):anchor=max(anchor,dt(e["landed_at"]))
    else:
        merged=[p for p in prs if p.get("merged_at") and p.get("base",{}).get("ref")==default and p.get("head",{}).get("sha")==sha and p.get("merge_reachable")]
        if merged:
            p=max(merged,key=lambda x:x["merged_at"]); row["group"]="safe-to-delete"
            row["reason"]=f"Exact current tip {sha[:12]} was merged by PR #{p['number']}; merge result {p['merge_commit_sha'][:12]} is reachable from main."
            anchor=max(anchor,dt(p["merged_at"]))
        elif e["patch_equivalent"]:
            row["group"]="safe-to-delete"; row["reason"]=f"All {e['ahead']} unique non-merge commits have patch-equivalent changes in main; no unique merge commits."
            anchor=max(anchor,dt(e["landed_at"]))
        else:
            closed=[p for p in prs if p["state"]=="closed" and not p.get("merged_at")]
            refs=", ".join("#"+str(p["number"]) for p in closed)
            row["reason"]=f"{e['ahead']} commits are not reachable from main; full preservation is unproven. "+(("Closed without merge: "+refs+". ") if refs else "No exact merged-PR proof. ")+"Review or port unique work before deletion."
    if row["group"]!="keep" and not branch.get("snapshot_changed"):
        eligible=anchor+timedelta(days=7); row["eligible_at"]=iso(eligible); row["flag_after_7_days"]=now>=eligible
    return row

def collect(repo,policy,api):
    if git("rev-parse","--is-shallow-repository")!="false":raise RuntimeError("complete history required")
    meta=api.request("/"); default=meta["default_branch"]; branches=api.pages("/branches"); pulls=api.pages("/pulls?state=all&sort=updated&direction=desc")
    git("fetch","--prune","--no-tags","origin","+refs/heads/*:refs/remotes/origin/*")
    refs={}
    for line in git("for-each-ref","--format=%(refname)%09%(objectname)","refs/remotes/origin/").splitlines():
        ref,sha=line.split("\t"); refs[ref.removeprefix("refs/remotes/origin/")]=sha
    main=refs[default]; graph=Graph(main); now=datetime.now(UTC); rows=[]
    for b in sorted(branches,key=lambda x:x["name"]):
        if b["name"]==default:continue
        prs=[]
        for p in pulls:
            h=p.get("head",{}); same=(h.get("repo") or {}).get("full_name")==repo
            if (same and h.get("ref")==b["name"]) or (p.get("state")=="open" and p.get("base",{}).get("ref")==b["name"]):prs.append(p)
        for p in prs:
            mc=str(p.get("merge_commit_sha") or ""); p["merge_reachable"]=bool(p.get("merged_at") and SHA.fullmatch(mc) and graph.ancestor(mc,main))
        b["snapshot_changed"]=refs.get(b["name"])!=b["commit"]["sha"]; resolved=refs.get(b["name"],b["commit"]["sha"])
        b["committed_at"]=graph.date(resolved); e=graph.evidence(resolved)
        rows.append(classify(b,prs,policy,e,now,main,default))
    extra=set(refs)-{b["name"] for b in branches}-{"HEAD"}
    if extra:raise RuntimeError("branches appeared during scan: "+", ".join(sorted(extra)))
    return {"schema_version":1,"repository":repo,"generated_at":iso(now),"main_sha":main,"default_branch":default,"branches_total":len(branches),"non_main_total":len(rows),"counts":dict(Counter(r["group"] for r in rows)),"flagged":sum(r["flag_after_7_days"] for r in rows),"delete_branch_on_merge":meta.get("delete_branch_on_merge"),"rows":rows}

def esc(v):return str(v).replace("|","\\|").replace("<","&lt;").replace(">","&gt;").replace("\n"," ").replace(chr(96),"'")
def markdown(r):
    out=["# Branch inventory","",f"Repository: {r['repository']}",f"Generated: {r['generated_at']}",f"Main: {r['main_sha']}",f"Non-main branches: **{r['non_main_total']}**. Seven-day flags: **{r['flagged']}**.","","Safe-to-delete means preservation is proven at this snapshot; it does not bypass the seven-day grace.",""]
    for g in ("safe-to-delete","keep","needs-review"):
        rows=[x for x in r["rows"] if x["group"]==g]; out += [f"## {g} ({len(rows)})","","| Branch | Tip | Ahead / behind | PRs | Flag from (UTC) | Exact reason |","|---|---|---|---|---|---|"]
        for x in rows:out.append("| "+" | ".join(esc(v) for v in [x["branch"],x["sha"][:12],f"{x['ahead_of_main']} / {x['behind_main']}",", ".join("#"+str(n) for n in x["pull_requests"]) or "None",x["eligible_at"] or "Not eligible",x["reason"]])+" |")
        out.append("")
    return "\n".join(out)+"\n"

def publish(report,api):
    if os.environ.get("GITHUB_EVENT_NAME")=="pull_request":raise RuntimeError("PR events cannot publish")
    flagged=[r for r in report["rows"] if r["flag_after_7_days"]]
    existing=[i for i in api.pages("/issues?state=all&creator=github-actions%5Bbot%5D") if "pull_request" not in i and MARKER in str(i.get("body",""))]
    if len(existing)>1:raise RuntimeError("multiple hygiene tracking issues")
    issue=existing[0] if existing else None
    if not flagged and not issue:return
    run=f"https://github.com/{report['repository']}/actions/runs/{os.environ.get('GITHUB_RUN_ID','')}"
    body=MARKER+f"\n## Seven-day branch hygiene\n\nSnapshot: {report['generated_at']}; main {report['main_sha'][:12]}.\n\n**{len(flagged)} flagged / {report['non_main_total']} non-main branches.** No branches are deleted automatically.\n\nFull inventory: [workflow artifact]({run}).\n\n| Branch | Group | Reason |\n|---|---|---|\n"
    for r in flagged[:100]:body+="| "+" | ".join(esc(v) for v in [r["branch"],r["group"],r["reason"]])+" |\n"
    if len(flagged)>100:body+=f"\n{len(flagged)-100} more rows are in the artifact.\n"
    payload={"title":TITLE,"body":body,"state":"open" if flagged else "closed"}
    if issue:api.request("/issues/"+str(issue["number"]),"PATCH",payload)
    elif flagged:payload.pop("state");api.request("/issues","POST",payload)

def self_test():
    now=dt("2026-09-30T10:00:00Z"); tip="a"*40; main="b"*40
    base={"name":"feature/a","commit":{"sha":tip},"committed_at":"2026-09-01T00:00:00Z","protected":False}
    ev={"ahead":2,"behind":5,"contained":False,"patch_equivalent":False,"landed_at":None}
    assert classify(dict(base),[],{},dict(ev),now,main,"main")["group"]=="needs-review"
    b=dict(base);b["protected"]=True;assert classify(b,[],{},dict(ev),now,main,"main")["group"]=="keep"
    e=dict(ev);e.update(contained=True,ahead=0,landed_at="2026-09-20T00:00:00Z");assert classify(dict(base),[],{},e,now,main,"main")["group"]=="safe-to-delete"
    p={"number":1,"state":"open"};assert classify(dict(base),[p],{},e,now,main,"main")["group"]=="keep"
    b=dict(base);b["snapshot_changed"]=True;assert classify(b,[],{},e,now,main,"main")["group"]=="needs-review"
    print("branch hygiene safety tests passed")

def main():
    p=argparse.ArgumentParser();p.add_argument("--self-test",action="store_true");p.add_argument("--repo",default=os.environ.get("GITHUB_REPOSITORY",""));p.add_argument("--policy",default=".github/branch-hygiene-policy.json");p.add_argument("--out",default="branch-hygiene-report");p.add_argument("--publish-report");a=p.parse_args()
    if a.self_test:self_test();return
    api=Api(a.repo,os.environ.get("GH_TOKEN",""))
    if a.publish_report:
        r=json.loads(Path(a.publish_report).read_text());publish(r,api);return
    policy=json.loads(Path(a.policy).read_text()) if Path(a.policy).exists() else {}
    r=collect(a.repo,policy,api);out=Path(a.out);out.mkdir(parents=True,exist_ok=True);(out/"report.json").write_text(json.dumps(r,indent=2)+"\n");md=markdown(r);(out/"report.md").write_text(md);print(json.dumps({k:r[k] for k in ("generated_at","main_sha","non_main_total","counts","flagged")},indent=2))
    if os.environ.get("GITHUB_STEP_SUMMARY"):open(os.environ["GITHUB_STEP_SUMMARY"],"a").write(md)

if __name__=="__main__":
    try:main()
    except Exception as e:print("Branch hygiene failed closed: "+str(e),file=sys.stderr);sys.exit(1)
