#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, re, sys
from pathlib import Path
from urllib.parse import urlparse

ROOT=Path(__file__).resolve().parents[1]
DIST=ROOT/"dist"
OUT=ROOT/"visual-results"

VIEWPORTS=[
 ("phone",390,844,2),
 ("desktop",1440,900,1),
]
THEMES=[
 ("light","light","dark"),
 ("dark","dark","light"),
]

def discover_routes():
 if not DIST.is_dir():
  raise RuntimeError("dist is missing; run npm run build before theme visual QA")
 routes=[]
 for file in sorted(DIST.rglob("*.html")):
  rel=file.relative_to(DIST).as_posix()
  if rel in {"404.html","500.html"}:
   continue
  if rel=="index.html":
   route="/"
  elif rel.endswith("/index.html"):
   route="/"+rel[:-10]
  else:
   route="/"+rel
  routes.append(route)
 return sorted(set(routes))

def rgb(value):
 nums=[float(v) for v in re.findall(r"[\d.]+",str(value))[:3]]
 return nums if len(nums)==3 else None

def luminance(rgb_value):
 if not rgb_value:return None
 r,g,b=[v/255 for v in rgb_value]
 return .2126*r+.7152*g+.0722*b

def main():
 p=argparse.ArgumentParser(description="Koa site-wide Light/Dark/System visual release gate")
 p.add_argument("--browser",choices=("chromium","webkit"),required=True)
 p.add_argument("--base-url",default="http://127.0.0.1:4173")
 a=p.parse_args()
 base=a.base_url.rstrip("/")
 routes=discover_routes()
 if not routes:
  print("No built HTML pages found.",file=sys.stderr);return 2

 try:
  from playwright.sync_api import sync_playwright
 except ImportError:
  print("Install Playwright before running theme visual QA.",file=sys.stderr);return 2

 root=OUT/("theme-"+a.browser);root.mkdir(parents=True,exist_ok=True)
 results=[];failures=[]
 session_fixture={
  "email":"qa-theme@koasevents.test","displayName":"Theme QA","role":"admin","roles":["admin"],"isAdmin":True,
  "permissions":["admin","admin.dashboard.view","health.view","health.manage","crm.view","crm.manage","sales.view","events.view","calendar.view","vendors.view","insurance.view","blog.view","gallery.view","seo.view","security.view","users.manage","quickbooks.view","email.view","sales.profit_settings"],
  "capabilities":["admin","admin.dashboard.view","health.view","health.manage","crm.view","crm.manage","sales.view","events.view","calendar.view","vendors.view","insurance.view","blog.view","gallery.view","seo.view","security.view","users.manage","quickbooks.view","email.view","sales.profit_settings"],
  "accessBlocked":False,"tenant":{"id":"koa","slug":"koa","displayName":"Koa's Events"},
  "app_metadata":{"roles":["admin"],"permissions":["admin"]},"appMetadata":{"roles":["admin"],"permissions":["admin"]},
 }

 with sync_playwright() as pw:
  browser=getattr(pw,a.browser).launch()
  for preference,expected,os_scheme in THEMES:
   for viewport,width,height,dpr in VIEWPORTS:
    ctx=browser.new_context(
     viewport={"width":width,"height":height},
     device_scale_factor=dpr,
     is_mobile=width<768,
     has_touch=width<768,
     reduced_motion="reduce",
     color_scheme=os_scheme,
    )
    ctx.add_init_script("localStorage.setItem('koa-theme-preference', "+json.dumps(preference)+");")
    ctx.route("**/api/**",lambda route:route.fulfill(status=200,content_type="application/json",body="{}"))
    ctx.route("**/api/admin/session**",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps(session_fixture)))
    ctx.route("**/api/account/security**",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps({"currentDevice":{"trusted":False,"device":"Theme QA browser"},"trustedDevices":[]})))

    for route in routes:
     page=ctx.new_page()
     detail=""
     metrics={}
     try:
      response=page.goto(base+route,wait_until="domcontentloaded",timeout=30000)
      status=response.status if response else 0
      if status>=400:raise RuntimeError("document returned HTTP "+str(status))
      page.wait_for_timeout(120)
      metrics=page.evaluate("""() => {
        const root=document.documentElement;
        const body=getComputedStyle(document.body);
        const themeMeta=document.querySelector('meta[name="theme-color"]')?.getAttribute('content')||'';
        const largeBright=[...document.querySelectorAll('body *')].filter((el)=>{
          if(el instanceof HTMLImageElement||el instanceof HTMLVideoElement||el instanceof HTMLCanvasElement||el instanceof HTMLIFrameElement)return false;
          const s=getComputedStyle(el),r=el.getBoundingClientRect();
          if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0||r.width*r.height<8000)return false;
          const m=s.backgroundColor.match(/rgba?\\(([^)]+)\\)/);
          if(!m)return false;
          const nums=m[1].split(/[ ,/]+/).map(Number);
          const alpha=nums.length>3?nums[3]:1;
          return alpha>.45&&nums[0]>246&&nums[1]>246&&nums[2]>246;
        }).slice(0,12).map((el)=>({
          tag:el.tagName.toLowerCase(),
          id:el.id||'',
          cls:String(el.className||'').slice(0,120),
        }));
        return {
          preference:root.dataset.themePreference||'',
          resolved:root.dataset.theme||'',
          colorScheme:getComputedStyle(root).colorScheme,
          themeMeta,
          bodyBackground:body.backgroundColor,
          scrollWidth:document.documentElement.scrollWidth,
          viewportWidth:innerWidth,
          largeBright,
        };
      }""")
      body_lum=luminance(rgb(metrics.get("bodyBackground")))
      checks=[
       (metrics.get("preference")==preference,"saved preference did not initialize"),
       (metrics.get("resolved")==expected,"resolved theme is not "+expected),
       (expected in str(metrics.get("colorScheme") or ""),"native color-scheme does not match"),
       (int(metrics.get("scrollWidth") or 0)<=int(metrics.get("viewportWidth") or 0)+1,"horizontal overflow"),
      ]
      if expected=="dark":
       checks.extend([
        (body_lum is not None and body_lum<.22,"dark canvas remained too bright"),
        (metrics.get("themeMeta")=="#0b1713","dark browser theme-color is incorrect"),
        (len(metrics.get("largeBright") or [])==0,"large near-white UI surfaces remain in dark mode"),
       ])
      else:
       checks.extend([
        (body_lum is not None and body_lum>.55,"light canvas became unexpectedly dark"),
        (metrics.get("themeMeta")=="#173d30","light browser theme-color is incorrect"),
       ])
      bad=[label for ok,label in checks if not ok]
      if bad:detail="; ".join(bad)
     except Exception as exc:
      detail=str(exc)
     safe=(route.strip("/").replace("/","-") or "home")
     shot=root/f"{preference}-{viewport}-{safe}.png"
     try:page.screenshot(path=str(shot),full_page=False,animations="disabled",caret="hide")
     except Exception:shot=Path("")
     row={"route":route,"preference":preference,"resolved":expected,"viewport":viewport,"width":width,"height":height,"metrics":metrics,"failure":detail,"screenshot":str(shot)}
     results.append(row)
     if detail:failures.append(row)
     page.close()
    ctx.close()

  # System preference is a behavioral gate: it must follow the OS while keeping
  # the stored preference as "system". Test both OS schemes on public and admin shells.
  system_routes=["/"]
  admin_route=next((route for route in routes if route.startswith("/admin/")),None)
  if admin_route:system_routes.append(admin_route)
  for os_scheme in ("light","dark"):
   expected=os_scheme
   ctx=browser.new_context(viewport={"width":390,"height":844},device_scale_factor=2,is_mobile=True,has_touch=True,reduced_motion="reduce",color_scheme=os_scheme)
   ctx.add_init_script("localStorage.setItem('koa-theme-preference','system');")
   ctx.route("**/api/**",lambda route:route.fulfill(status=200,content_type="application/json",body="{}"))
   ctx.route("**/api/admin/session**",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps(session_fixture)))
   for route in system_routes:
    page=ctx.new_page();detail=""
    try:
     response=page.goto(base+route,wait_until="domcontentloaded",timeout=30000)
     if response and response.status>=400:raise RuntimeError("document returned HTTP "+str(response.status))
     state=page.evaluate("() => ({preference:document.documentElement.dataset.themePreference,resolved:document.documentElement.dataset.theme})")
     if state.get("preference")!="system" or state.get("resolved")!=expected:
      detail="System preference did not resolve to "+expected+": "+json.dumps(state)
    except Exception as exc:detail=str(exc)
    row={"route":route,"preference":"system","osScheme":os_scheme,"resolved":expected,"viewport":"phone","failure":detail}
    results.append(row)
    if detail:failures.append(row)
    page.close()
   ctx.close()

  # Cross-device sync: an authenticated account preference must replace a stale
  # browser-local fallback while still keeping localStorage warm for pre-paint use.
  sync_route=next((route for route in routes if route.startswith("/admin/")),None)
  if sync_route:
   ctx=browser.new_context(viewport={"width":390,"height":844},device_scale_factor=2,is_mobile=True,has_touch=True,reduced_motion="reduce",color_scheme="light")
   ctx.add_init_script("localStorage.setItem('koa-theme-preference','light');")
   sync_session=dict(session_fixture)
   sync_session["appearancePreference"]="dark"
   ctx.route("**/api/**",lambda route:route.fulfill(status=200,content_type="application/json",body="{}"))
   ctx.route("**/api/admin/session**",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps(sync_session)))
   page=ctx.new_page();detail=""
   try:
    response=page.goto(base+sync_route,wait_until="domcontentloaded",timeout=30000)
    if response and response.status>=400:raise RuntimeError("document returned HTTP "+str(response.status))
    page.wait_for_timeout(450)
    state=page.evaluate("() => ({preference:document.documentElement.dataset.themePreference,resolved:document.documentElement.dataset.theme,saved:localStorage.getItem('koa-theme-preference')})")
    if state.get("preference")!="dark" or state.get("resolved")!="dark" or state.get("saved")!="dark":
     detail="Account preference did not override stale local Light preference: "+json.dumps(state)
   except Exception as exc:detail=str(exc)
   row={"route":sync_route,"preference":"account-dark","resolved":"dark","viewport":"phone","failure":detail}
   results.append(row)
   if detail:failures.append(row)
   page.close();ctx.close()

  browser.close()

 report={
  "mode":"theme","browser":a.browser,"baseUrl":base,"routes":len(routes),
  "viewports":[row[0] for row in VIEWPORTS],"cases":len(results),
  "failures":failures,"results":results,
 }
 (root/"report.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
 print(json.dumps({"browser":a.browser,"routes":len(routes),"cases":len(results),"failureCount":len(failures),"failures":failures[:30],"report":str(root/"report.json")},indent=2))
 return 1 if failures else 0

if __name__=="__main__":
 raise SystemExit(main())
