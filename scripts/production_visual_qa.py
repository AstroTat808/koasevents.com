# Visual refresh verification trigger 2026-09-18
#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, os, re, sys, time
from dataclasses import dataclass
from html import escape
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

BASE=os.environ.get("PRODUCTION_BASE_URL","https://koasevents.com").rstrip("/")
OUT=Path(os.environ.get("VISUAL_RESULTS","visual-results"))
ROOT=Path(__file__).resolve().parents[1]
SRC=ROOT/"src"

ROUTES=[
 ("home","/"),("weddings","/weddings/"),("signature","/signature-wedding/"),
 ("venue","/venue/"),("packages","/venue/packages/"),("venue-faq","/venue/faq/"),
 ("gallery","/gallery/"),("stay","/stay/"),("mobile-bar","/mobile-bar/"),
 ("mobile-bar-faq","/mobile-bar/faq/"),("private-events","/private-events/"),
 ("corporate","/corporate-events/"),("catalog","/catalog/"),("inquire","/inquire/"),
 ("wedding-inquiry","/wedding-inquiry/")
]
VIEWPORTS=[
 ("phone-small",320,568,2),("phone",390,844,2),("tablet",768,1024,2),
 ("desktop",1440,1000,1),("wide",1920,1080,1)
]
ADMIN_ROUTES=[
 ("admin-home","/admin/"),
 ("admin-business-crm","/admin/crm/"),
 ("admin-sales-crm","/admin/quotes/"),
 ("admin-catalog-manager","/admin/catalog/"),
 ("admin-wedding-profitability","/admin/profitability/"),
 ("admin-events","/admin/events/"),
 ("admin-calendar","/admin/calendar/"),
 ("admin-blog","/admin/blog/"),
 ("admin-staff","/admin/staff/"),
 ("admin-quickbooks","/admin/quickbooks/"),
 ("admin-gallery","/admin/gallery/"),
 ("admin-security","/admin/security/"),
 ("admin-seo","/admin/seo/"),
 ("admin-health","/admin/health/"),
 ("admin-platform","/admin/platform/"),
 ("admin-insurance","/admin/insurance/"),
 ("admin-vendors","/admin/vendors/")
]

PROTECTED_ADMIN_APIS=[
 ("user-management-api","/api/admin/staff"),
 ("custom-roles-api","/api/admin/custom-roles"),
 ("auth-security-api","/api/admin/auth-security"),
 ("business-crm-api","/api/admin/crm"),
 ("sales-crm-api","/api/admin/quotes"),
 ("catalog-manager-api","/api/admin/catalog"),
 ("wedding-profitability-api","/api/admin/profitability"),
 ("event-ops-api","/api/admin/events"),
 ("calendar-api","/api/admin/calendar"),
 ("quickbooks-api","/api/admin/quickbooks"),
 ("blog-admin-api","/api/blog?admin=1"),
 ("vendor-crm-api","/api/admin/vendors"),
 ("vendor-insurance-api","/api/admin/vendor-insurance-compliance"),
 ("security-api","/api/admin/security?days=7"),
 ("local-seo-api","/api/admin/local-seo"),
 ("system-health-api","/api/admin/health"),
 ("platform-admin-api","/api/admin/platform"),
]

# Hybrid APIs intentionally expose a public read surface while protecting mutations.
# /api/blog is also hybrid: GET /api/blog is public, while GET /api/blog?admin=1
# and all non-GET methods require blog permissions. The protected admin list above
# deliberately tests only the admin=1 variant.
HYBRID_PUBLIC_READ_APIS=[
 ("gallery-api","/api/gallery",{"action":"visibility","src":"/qa-security-check","hidden":False}),
]

@dataclass
class Finding:
 code:str
 severity:str
 message:str
 detail:object|None=None

def get(path,timeout=25):
 try:
  with urlopen(Request(BASE+path,headers={"User-Agent":"KoaEvents-Visual-QA/1.0","Cache-Control":"no-cache"}),timeout=timeout) as r:
   return r.status,{k.lower():v for k,v in r.headers.items()},r.read()
 except HTTPError as e:return e.code,{k.lower():v for k,v in e.headers.items()},e.read()
 except URLError as e:return 0,{},str(e).encode()

def post(path,data,content_type,headers=None,timeout=25):
 body=data.encode("utf-8") if isinstance(data,str) else data
 request_headers={
  "User-Agent":"KoaEvents-Security-QA/1.0",
  "Cache-Control":"no-cache",
  "Content-Type":content_type,
  **(headers or {})
 }
 try:
  with urlopen(Request(BASE+path,data=body,headers=request_headers,method="POST"),timeout=timeout) as r:
   return r.status,{k.lower():v for k,v in r.headers.items()},r.read()
 except HTTPError as e:return e.code,{k.lower():v for k,v in e.headers.items()},e.read()
 except URLError as e:return 0,{},str(e).encode()

def source_mode():
 OUT.mkdir(parents=True,exist_ok=True)
 failures=[];warnings=[]
 required=[
  SRC/"pages/index.astro",SRC/"pages/weddings/index.astro",SRC/"pages/signature-wedding/index.astro",
  SRC/"pages/venue/index.astro",SRC/"pages/gallery/index.astro",SRC/"pages/stay/index.astro",
  SRC/"pages/mobile-bar/index.astro",SRC/"pages/catalog/index.astro",SRC/"pages/inquire/index.astro",
  SRC/"pages/wedding-inquiry/index.astro",SRC/"components/Header.astro",SRC/"components/Footer.astro",
  SRC/"styles/global.css"
 ]
 for path in required:
  if not path.exists():failures.append("Missing required source file: "+str(path.relative_to(ROOT)))
 files=[p for p in SRC.rglob("*") if p.is_file() and p.suffix in {".astro",".ts",".js",".css"}]
 remote=[];placeholders=[];inline=[];media_refs=set();legacy_marketing_pages=[]
 for path in files:
  text=path.read_text(encoding="utf-8",errors="ignore")
  media_refs.update(ref.rstrip("\\") for ref in re.findall(r"""['"](/media/[^'")?#]+)['"]""",text) if not ref.rstrip("\\").endswith("/"))
  if path.name=="media.ts":
   for name in re.findall(r"""koaMarketing\(['"]([^'"]+)['"]""",text): media_refs.add("/media/koa/"+name)
   for name in re.findall(r"""koa\(\s*['"]([^'"]+)['"]""",text): media_refs.add("/media/koa/"+name)
   for name in re.findall(r"""editorial\(\s*['"]([^'"]+)['"]""",text): media_refs.add("/media/editorial/"+name)
   for name in re.findall(r"""['"](02b2df_[^'"]+~mv2\.jpg)['"]""",text): media_refs.add("/media/wix/"+name)
  rel=str(path.relative_to(ROOT))
  if path.suffix==".astro" and "/pages/" in ("/"+rel) and not rel.endswith("pages/gallery/index.astro") and not "/pages/admin/" in ("/"+rel):
   if "/media/editorial/" in text or "/media/wix/" in text:
    legacy_marketing_pages.append(rel)
  if "static.wixstatic.com" in text:remote.append(rel)
  if re.search(r'href=["\']#["\']',text):placeholders.append(str(path.relative_to(ROOT)))
  if text.count("style=")>8:inline.append(str(path.relative_to(ROOT)))
 if remote:warnings.append("Wix-hosted image dependencies remain in: "+", ".join(remote[:20]))
 if placeholders:warnings.append("Placeholder # links found in: "+", ".join(placeholders[:20]))
 if inline:warnings.append("Heavy inline styles found in: "+", ".join(inline[:20]))
 if legacy_marketing_pages:failures.append("Legacy editorial/Wix imagery remains on marketing pages: "+", ".join(sorted(set(legacy_marketing_pages))[:40]))
 missing_media=[ref for ref in sorted(media_refs) if not (ROOT/"public"/ref.lstrip("/")).is_file()]
 if missing_media:failures.append("Missing local media assets referenced by source: "+", ".join(missing_media[:40]))
 admin_quotes=(SRC/"pages/admin/quotes/index.astro").read_text(encoding="utf-8",errors="ignore")
 admin_quotes_api=(ROOT/"netlify/functions/admin-quotes.mts").read_text(encoding="utf-8",errors="ignore")
 profit_requirements={
  "margin health filter":"data-mobile-filter-margin",
  "margin health summary":"data-mobile-margin-health-summary",
  "automatic cost mode":"Automatic operating estimate",
  "ice cost field":"name=\"iceCost\"",
  "mixers cost field":"name=\"mixersCost\"",
  "garnishes cost field":"name=\"garnishesCost\"",
  "cups cost field":"name=\"cupsCost\"",
  "recommended price panel":"data-profit-price-recommendations",
  "recommended price calculator":"function recommendedPriceForValues",
  "profitability dashboard":"data-mobile-profitability-dashboard",
  "profitability scope":"data-mobile-profit-scope",
  "monthly profitability":"data-mobile-profit-monthly",
  "package profitability":"data-mobile-profit-packages",
  "add-on profitability":"data-mobile-profit-addons",
  "profit date range preset":"data-mobile-profit-period",
  "profit custom date start":"data-mobile-profit-from",
  "profit custom date end":"data-mobile-profit-to",
  "profit goal form":"data-mobile-profit-goal-form",
  "monthly profit goal projection":"data-goal-card=\"monthly\"",
  "quarterly profit goal projection":"data-goal-card=\"quarterly\"",
  "annual profit goal projection":"data-goal-card=\"annual\"",
  "recommended price apply action":"apply-mobile-bar-margin-target",
 }
 for label,needle in profit_requirements.items():
  if needle not in admin_quotes:failures.append("Mobile Bar profitability UI missing "+label+": "+needle)
 for label,needle in {
  "profit cost mode":"costMode: 'auto' | 'manual'",
  "persisted ice cost":"iceCost: number",
  "persisted mixers cost":"mixersCost: number",
  "persisted garnishes cost":"garnishesCost: number",
  "persisted cups cost":"cupsCost: number",
  "profit settings type":"type MobileBarProfitSettings",
  "profit settings storage":"settings/mobile-bar-profitability",
  "profit settings action":"update-mobile-bar-profit-settings",
  "quarterly profit target":"quarterlyGrossProfitTarget",
  "annual profit target":"annualGrossProfitTarget",
  "margin target action":"apply-mobile-bar-margin-target",
  "margin adjustment line":"margin-target-adjustment",
 }.items():
  if needle not in admin_quotes_api:failures.append("Mobile Bar profitability API missing "+label+": "+needle)

 protected_admin_pages=[
  SRC/"pages/admin/blog/index.astro",
  SRC/"pages/admin/calendar/index.astro",
  SRC/"pages/admin/events/index.astro",
  SRC/"pages/admin/gallery/index.astro",
  SRC/"pages/admin/quickbooks/index.astro",
  SRC/"pages/admin/quotes/index.astro",
  SRC/"pages/admin/catalog/index.astro",
  SRC/"pages/admin/profitability/index.astro",
  SRC/"pages/admin/security/index.astro",
  SRC/"pages/admin/seo/index.astro",
  SRC/"pages/admin/staff/index.astro",
  SRC/"pages/admin/health/index.astro",
  SRC/"pages/admin/platform/index.astro",
 ]
 for path in protected_admin_pages:
  text=path.read_text(encoding="utf-8",errors="ignore")
  if "@netlify/identity" in text:
   failures.append("Protected admin workspace directly imports @netlify/identity instead of the resilient server-backed session helper: "+str(path.relative_to(ROOT)))
  if "getAdminSession" not in text:
   failures.append("Protected admin workspace is missing getAdminSession startup authorization: "+str(path.relative_to(ROOT)))

 catalog_admin=(SRC/"pages/admin/catalog/index.astro").read_text(encoding="utf-8",errors="ignore")
 catalog_api=(ROOT/"netlify/functions/admin-catalog.mts").read_text(encoding="utf-8",errors="ignore")
 quickbooks_shared=(ROOT/"netlify/functions/_shared/quickbooks.ts").read_text(encoding="utf-8",errors="ignore")
 profitability_api=(ROOT/"netlify/functions/admin-profitability.mts").read_text(encoding="utf-8",errors="ignore")
 for label,needle,text in [
  ("Catalog live audit UI","data-run-audit",catalog_admin),
  ("Catalog safe reconciliation UI","data-reconcile-audit",catalog_admin),
  ("Catalog usage impact panel","data-item-usage",catalog_admin),
  ("Catalog pricing history UI","data-price-history",catalog_admin),
  ("Catalog usage API action","item-usage",catalog_api),
  ("Catalog live audit API action","run-audit",catalog_api),
  ("Catalog safe reconciliation API action","reconcile-safe-audit",catalog_api),
  ("Catalog QuickBooks price mismatch check","qbo_price_mismatch",catalog_api),
  ("Catalog price history storage","CatalogPriceHistoryEntry",quickbooks_shared),
  ("Catalog exact repriced proposal history","draftProposalIds",quickbooks_shared),
  ("Profitability exact repriced proposal annotation","draftProposalIds:repriced.ids",profitability_api),
 ]:
  if needle not in text:failures.append(label+" is missing: "+needle)
 gallery_admin=(SRC/"pages/admin/gallery/index.astro").read_text(encoding="utf-8",errors="ignore")
 gallery_api=(ROOT/"netlify/functions/gallery.mts").read_text(encoding="utf-8",errors="ignore")
 base_layout=(SRC/"layouts/BaseLayout.astro").read_text(encoding="utf-8",errors="ignore")
 system_health=(ROOT/"netlify/functions/_shared/system-health.ts").read_text(encoding="utf-8",errors="ignore")
 health_page=(SRC/"pages/admin/health/index.astro").read_text(encoding="utf-8",errors="ignore")
 for label,needle,text in [
  ("Gallery High Impact filter","data-impact-filter-value=\"high\"",gallery_admin),
  ("Gallery Standard filter","data-impact-filter-value=\"standard\"",gallery_admin),
  ("Gallery Lower Impact filter","data-impact-filter-value=\"low\"",gallery_admin),
  ("Gallery Unused filter","data-impact-filter-value=\"unused\"",gallery_admin),
  ("Gallery placement override editor","data-placement-override-options",gallery_admin),
  ("Gallery placement crop save action","update-placement-crop",gallery_api),
  ("Gallery placement crop reset action","reset-placement-crop",gallery_api),
  ("Sitewide placement crop runtime","applyPlacementCropOverrides",base_layout),
  ("Release policy skipped health state","release-policy-skipped",system_health),
  ("Release prefix health explanation","Commit skipped because it needs a [release] prefix",health_page),
 ]:
  if needle not in text:failures.append(label+" is missing: "+needle)

 crm_ingest=(ROOT/"netlify/functions/crm-inquiries.mts").read_text(encoding="utf-8",errors="ignore")
 turnstile_gate=crm_ingest.find("const expectedTurnstileAction")
 blocklist_lookup=crm_ingest.find("const activeBlock")
 if turnstile_gate<0 or blocklist_lookup<0 or turnstile_gate>blocklist_lookup:
  failures.append("CRM Turnstile verification must fail closed before storage-backed blocklist/security telemetry.")
 if "Turnstile rejection telemetry failed" not in crm_ingest or "context.waitUntil((async () => {" not in crm_ingest:
  failures.append("CRM Turnstile rejection telemetry must be best-effort and must not replace the intended HTTP 403.")
 quickbooks_admin=(SRC/"pages/admin/quickbooks/index.astro").read_text(encoding="utf-8",errors="ignore")
 if "'before GET':'after GET'" not in quickbooks_admin:
  failures.append("QuickBooks payment-rule simulator must label contract-value bases as before GET / after GET.")

 crm_page=(SRC/"pages/admin/crm/index.astro").read_text(encoding="utf-8",errors="ignore")
 if "@netlify/identity" in crm_page:
  failures.append("Business CRM must not depend on browser-side Netlify Identity during startup.")
 if "fetch('/api/admin/crm'" not in crm_page or "data-admin-ui" not in crm_page:
  failures.append("Business CRM startup contract is missing its protected API boot or visible app container.")

 report={"mode":"source","sourceFiles":len(files),"mediaReferences":len(media_refs),"legacyMarketingPages":sorted(set(legacy_marketing_pages)),"missingMedia":missing_media,"failures":failures,"warnings":warnings}
 (OUT/"source-audit.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
 print(json.dumps(report,indent=2));return 1 if failures else 0

def smoke_mode():
 OUT.mkdir(parents=True,exist_ok=True);checks=[];security=[];failures=[]
 for name,path in ROUTES:
  status,headers,body=get(path)
  ok=200<=status<400 and len(body)>250
  checks.append({"name":name,"path":path,"status":status,"bytes":len(body),"ok":ok})
  if not ok:failures.append(f"{path} returned {status} / {len(body)} bytes")
 status,headers,_=get("/")
 missing=[h for h in ("x-content-type-options","referrer-policy") if not headers.get(h)]
 if missing:failures.append("Homepage missing security headers: "+", ".join(missing))

 for path,action in (("/inquire/","event_inquiry"),("/wedding-inquiry/","wedding_inquiry")):
  status,_,body=get(path)
  html=body.decode("utf-8","ignore")
  ok=status==200 and "cf-turnstile" in html and "challenges.cloudflare.com/turnstile/v0/api.js" in html and f'data-action="{action}"' in html
  security.append({"check":"widget-present","path":path,"status":status,"action":action,"ok":ok})
  if not ok:failures.append(f"Turnstile widget/script/action missing from {path}")

 crm_payload=json.dumps({
  "formName":"koa-event-inquiry",
  "customer":{"email":"qa-turnstile@example.com"},
  "inquiry":{"service":"venue","eventType":"QA"}
 })
 status,_,body=post(
  "/api/crm/inquiries",
  crm_payload,
  "application/json",
  {"X-Koa-Inquiry-Capture":"1"}
 )
 blocked=status==403
 security.append({"check":"crm-missing-token-blocked","status":status,"ok":blocked})
 if not blocked:failures.append(f"CRM did not reject a protected submission without Turnstile: HTTP {status}")

 fake_payload=json.dumps({
  "formName":"koa-event-inquiry",
  "turnstileToken":"not-a-valid-turnstile-token",
  "customer":{"email":"qa-turnstile@example.com"},
  "inquiry":{"service":"venue","eventType":"QA"}
 })
 status,_,body=post(
  "/api/crm/inquiries",
  fake_payload,
  "application/json",
  {"X-Koa-Inquiry-Capture":"1"}
 )
 blocked=status==403
 security.append({"check":"crm-invalid-token-blocked","status":status,"ok":blocked})
 if not blocked:failures.append(f"CRM did not reject an invalid Turnstile token: HTTP {status}")

 for path,form_name in (("/thank-you/","koa-event-inquiry"),("/wedding-inquiry-thank-you/","koa-wedding-inquiry")):
  body=urlencode({"form-name":form_name,"email":"qa-turnstile@example.com"})
  status,_,response=post(path,body,"application/x-www-form-urlencoded")
  blocked=status==403 and b"Security verification failed" in response
  security.append({"check":"direct-netlify-post-blocked","path":path,"status":status,"ok":blocked})
  if not blocked:failures.append(f"Direct Netlify Forms POST bypass was not blocked at {path}: HTTP {status}")

 report={"mode":"smoke","baseUrl":BASE,"checks":checks,"security":security,"failures":failures}
 (OUT/"production-smoke.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
 print(json.dumps({"checks":len(checks),"security":security,"failures":failures},indent=2));return 1 if failures else 0

def wait_mode(seconds=600):
 deadline=time.time()+seconds
 expected=os.environ.get("EXPECTED_COMMIT","").strip().lower()
 deployed=""
 while time.time()<deadline:
  status,_,body=get("/signature-wedding/",20)
  html=body.decode("utf-8","ignore")
  commit_match=re.search(r'<meta\s+name=["\']koa-build-commit["\']\s+content=["\']([^"\']+)["\']',html,re.I)
  deployed=(commit_match.group(1).strip().lower() if commit_match else "")
  content_ready=status==200 and "Signature Wedding" in html
  commit_ready=(not expected) or deployed==expected
  if content_ready and commit_ready:
   print(json.dumps({"ready":True,"baseUrl":BASE,"status":status,"expectedCommit":expected,"deployedCommit":deployed},indent=2));return 0
  time.sleep(10)
 print(json.dumps({"ready":False,"baseUrl":BASE,"expectedCommit":expected,"lastDeployedCommit":deployed},indent=2));return 1

DOM=r"""() => {
 const vis=e=>{if(e.closest('details:not([open])'))return false;const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&+s.opacity!==0&&r.width>0&&r.height>0};
 const inIntentionalScroller=e=>{let p=e.parentElement;while(p){const s=getComputedStyle(p);if(['auto','scroll'].includes(s.overflowX)&&p.scrollWidth>p.clientWidth+2)return true;p=p.parentElement;}return false;};
 const label=e=>(e.getAttribute('aria-label')||e.getAttribute('title')||e.innerText||e.textContent||e.id||e.name||e.tagName).trim().slice(0,120);
 const rect=e=>{const r=e.getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}};
 const ids=[...document.querySelectorAll('[id]')].map(e=>e.id).filter(Boolean);
 const controls=[...document.querySelectorAll('a[href],button,summary,input:not([type=hidden]),select,textarea')].filter(vis);
 const textEls=[...document.querySelectorAll('h1,h2,h3,p,a,button,label,summary')].filter(vis);
 const h1s=[...document.querySelectorAll('h1')].filter(vis).map(label);
 const broken=[...document.images].filter(i=>vis(i)&&(!i.complete||i.naturalWidth===0)).map(i=>i.currentSrc||i.src);
 const missingAlt=[...document.images].filter(i=>vis(i)&&!i.hasAttribute('alt')).map(i=>i.currentSrc||i.src);
 const unlabeled=[...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(e=>vis(e)&&!(e.labels?.length||e.getAttribute('aria-label')||e.getAttribute('aria-labelledby')||e.title)).map(label);
 const tiny=controls.filter(e=>{if(e.closest('footer'))return false;const r=e.getBoundingClientRect();const buttonLike=['BUTTON','SUMMARY','INPUT','SELECT','TEXTAREA'].includes(e.tagName)||['flex','inline-flex','grid','inline-grid'].includes(getComputedStyle(e).display);return buttonLike&&(r.width<40||r.height<40)&&r.width>0&&r.height>0}).slice(0,25).map(e=>({label:label(e),...rect(e)}));
 const clipped=textEls.filter(e=>{const s=getComputedStyle(e);return(e.scrollWidth>e.clientWidth+2&&['hidden','clip'].includes(s.overflowX))||(e.scrollHeight>e.clientHeight+2&&['hidden','clip'].includes(s.overflowY))}).slice(0,25).map(e=>({label:label(e),...rect(e)}));
 const wrapped=controls.filter(e=>{if(e.closest('footer')||e.closest('[data-catalog-item]'))return false;const s=getComputedStyle(e),r=e.getBoundingClientRect(),fs=parseFloat(s.fontSize)||16;const text=(e.textContent||'').trim();return ['A','BUTTON','SUMMARY'].includes(e.tagName)&&r.height>fs*3.8&&r.height<140&&text.length>3&&text.length<90}).slice(0,20).map(e=>({label:label(e),...rect(e)}));
 const small=[...document.querySelectorAll('main p,main li,main label')].filter(e=>vis(e)&&!e.classList.contains('eyebrow')&&(e.textContent||'').trim().length>45&&parseFloat(getComputedStyle(e).fontSize)<11).slice(0,25).map(e=>({label:label(e),fontSize:getComputedStyle(e).fontSize,...rect(e)}));
 const wide=[...document.querySelectorAll('p,li')].filter(e=>{if(!vis(e)||(e.textContent||'').trim().length<140)return false;const s=getComputedStyle(e),fs=parseFloat(s.fontSize)||16;return e.getBoundingClientRect().width/fs>48}).slice(0,20).map(e=>({label:label(e),...rect(e)}));
 const offscreen=controls.filter(e=>{if(inIntentionalScroller(e))return false;const r=e.getBoundingClientRect();return r.right<-2||r.left>innerWidth+2}).slice(0,20).map(e=>({label:label(e),...rect(e)}));
 const overflowing=[...document.querySelectorAll('body *')].filter(e=>{if(!vis(e)||inIntentionalScroller(e))return false;const r=e.getBoundingClientRect();return r.right>innerWidth+2||r.left<-2}).slice(0,25).map(e=>({label:label(e),tag:e.tagName,...rect(e)}));
 const header=document.querySelector('header'),main=document.querySelector('main');
 const sections=[...document.querySelectorAll('main > section')].filter(vis).map((e,i)=>{const s=getComputedStyle(e);return{index:i,...rect(e),background:s.backgroundColor,textLength:(e.innerText||'').trim().length,imageCount:[...e.querySelectorAll('img')].filter(vis).length};});
 const headings=[...document.querySelectorAll('h1,h2,h3')].filter(vis).map(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return{tag:e.tagName,label:label(e),fontSize:parseFloat(s.fontSize)||0,lineHeight:parseFloat(s.lineHeight)||0,...rect(e)}});
 const paragraphs=[...document.querySelectorAll('main p')].filter(e=>vis(e)&&(e.textContent||'').trim().length>20).map(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return{chars:(e.textContent||'').trim().length,fontSize:parseFloat(s.fontSize)||0,lineHeight:parseFloat(s.lineHeight)||0,width:r.width,y:r.y,label:label(e),...rect(e)}}).slice(0,120);
 const images=[...document.images].filter(vis).map(i=>({src:i.currentSrc||i.src,alt:i.alt||'',...rect(i)}));
 const imageCounts={}; images.forEach(i=>imageCounts[i.src]=(imageCounts[i.src]||0)+1);
 const repeatedImages=Object.entries(imageCounts).filter(([src,n])=>n>1&&!src.includes('/brand/')).map(([src,count])=>({src,count}));
 const ctas=controls.filter(e=>{
   if(!['A','BUTTON'].includes(e.tagName)||!e.closest('main')) return false;
   if(e.closest('[data-catalog-item]')) return false;
   const text=(e.textContent||'').trim();
   const cls=(e.className||'').toString();
   const rect=e.getBoundingClientRect();
   const isAction=e.tagName==='BUTTON'||/rounded-full|link-arrow|site-nav-cta/.test(cls);
   const isCardLike=rect.height>140||text.length>90;
   return text.length>1&&isAction&&!isCardLike;
 }).map(e=>({label:label(e),tag:e.tagName,...rect(e)}));
 const formControls=[...document.querySelectorAll('form input:not([type=hidden]),form select,form textarea')].filter(vis).length;
 return{
  title:document.title,h1s,horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+2,
  scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,
  duplicateIds:[...new Set(ids.filter((x,i)=>ids.indexOf(x)!==i))],brokenImages:broken,missingAlt,
  unlabeledControls:unlabeled,tinyTargets:tiny,clippedText:clipped,wrappedButtons:wrapped,smallText:small,
  wideCopy:wide,offscreenInteractive:offscreen,overflowingElements:overflowing,headerRect:header&&vis(header)?rect(header):null,
  sections,headings,paragraphs,images,repeatedImages,ctas,formControls,
  documentHeight:document.documentElement.scrollHeight,viewportHeight:innerHeight,viewportWidth:innerWidth,
  mainTextLength:(main?.innerText||'').trim().length
 };
}"""

def expert_design_findings(dom, route, viewport):
 f=[]
 vw=dom.get("viewportWidth",0); vh=dom.get("viewportHeight",0)
 headings=dom.get("headings",[]); paragraphs=dom.get("paragraphs",[]); sections=dom.get("sections",[])
 images=dom.get("images",[]); ctas=dom.get("ctas",[]); repeated=dom.get("repeatedImages",[])
 h1=next((h for h in headings if h.get("tag")=="H1"),None)
 h2s=[h for h in headings if h.get("tag")=="H2"]

 def add(code,message,why,recommendation,detail=None):
  payload={"whyItMatters":why,"recommendation":recommendation}
  if detail is not None: payload["evidence"]=detail
  f.append(Finding(code,"design",message,payload))

 if h1:
  lines=(h1.get("h",0)/(h1.get("lineHeight") or max(h1.get("fontSize",1)*1.05,1))) if h1.get("h") else 0
  if vw>=1200 and h1.get("fontSize",0)<54:
   add("hero-hierarchy","Hero headline lacks premium-scale authority.","Luxury hospitality sites benefit from a decisive first visual anchor.","Increase the H1 scale or reduce competing elements so the headline clearly dominates the first viewport.",h1)
  if vw<500 and lines>4.2:
   add("hero-wrap","Hero headline is wrapping into too many lines on mobile.","Excessive wrapping slows comprehension and pushes the value proposition below the fold.","Shorten the mobile line length, slightly reduce display size, or introduce a deliberate mobile line break.",{"estimatedLines":round(lines,1),"heading":h1})

 long_mobile=[p for p in paragraphs if vw<500 and p.get("chars",0)>280]
 if long_mobile:
  add("mobile-copy-density","Long body-copy blocks are visually dense on mobile.","Luxury experiences should feel calm and easy to scan, especially on a phone.","Break long paragraphs into shorter editorial blocks, bullets, or a pull quote; keep one idea per paragraph.",long_mobile[:5])

 tiny_body=[p for p in paragraphs if p.get("chars",0)>90 and p.get("fontSize",99)<15]
 if tiny_body:
  add("body-copy-scale","Some substantive body copy is undersized.","Small text makes premium pages feel compressed and reduces reading comfort.","Raise long-form copy to roughly 15–18px depending on viewport and preserve generous line-height.",tiny_body[:5])

 if len(ctas)>12:
  add("cta-saturation","The page presents many simultaneous calls to action.","Too many equal-weight CTAs dilute the primary conversion path.","Choose one dominant action per section and demote secondary actions to text links or quieter buttons.",{"ctaCount":len(ctas),"examples":ctas[:12]})

 above_fold=[x for x in ctas if x.get("y",99999)<vh]
 if not above_fold and route not in ["/gallery/","/inquire/","/wedding-inquiry/"]:
  add("missing-above-fold-cta","No clear CTA appears in the initial viewport.","High-intent visitors should understand the next step without scrolling.","Place a single high-contrast primary CTA near the hero value proposition.",None)

 if repeated:
  add("repeated-page-imagery","The same image appears more than once on this page.","Repeated photography reduces the sense of editorial richness and can make a premium site feel templated.","Use each hero-quality image once per page unless repetition is intentional branding; replace repeats with complementary angles or detail shots.",repeated[:8])

 if len(images)<2 and dom.get("mainTextLength",0)>1600 and route not in ["/inquire/","/wedding-inquiry/","/venue/faq/","/mobile-bar/faq/"]:
  add("image-scarcity","A text-heavy marketing page has very little supporting photography.","For a venue and hospitality brand, imagery carries emotional proof that copy cannot.","Add one strong contextual image every 1–2 major content sections, favoring people, atmosphere, and spatial variety.",{"imageCount":len(images),"textLength":dom.get("mainTextLength",0)})

 if len(sections)>=5:
  backgrounds=[s.get("background") for s in sections]
  longest=1; cur=1
  for i in range(1,len(backgrounds)):
   if backgrounds[i]==backgrounds[i-1]: cur+=1; longest=max(longest,cur)
   else: cur=1
  if longest>=4:
   add("section-rhythm","Several consecutive sections use the same visual field.","Long stretches without a tonal or spatial change can flatten the page and make premium storytelling feel repetitive.","Alternate editorial treatments—image-led, ivory, sand, forest, full-bleed, split layout—while keeping the palette restrained.",{"longestSameBackgroundRun":longest})

 if h2s:
  body_sizes=[p.get("fontSize",0) for p in paragraphs if p.get("fontSize",0)>0]
  body=max(body_sizes) if body_sizes else 16
  weak=[h for h in h2s if h.get("fontSize",0)<body*1.65]
  if weak:
   add("weak-section-hierarchy","Some section headings are too close in scale to body copy.","Clear typographic hierarchy helps visitors understand the page architecture instantly.","Increase H2 contrast through size, spacing, or weight; keep display typography visibly distinct from explanatory copy.",weak[:5])

 if dom.get("formControls",0)>14:
  add("form-friction","The page asks for many inputs in a single visible form.","Long forms can feel like work before the visitor has committed to the conversation.","Group fields into logical stages, hide conditional questions until relevant, and keep the first step focused on date, event type, guest count, and contact information.",{"visibleControls":dom.get("formControls")})

 if vw<500 and dom.get("headerRect") and dom["headerRect"].get("h",0)>92:
  add("mobile-header-footprint","The mobile header consumes a large share of the first viewport.","A tall header competes with the hero and reduces visual drama.","Compress vertical padding and keep only logo + menu trigger visible until interaction.",dom["headerRect"])

 if dom.get("documentHeight",0)>vh*11 and vw<500:
  add("mobile-page-length","This page is exceptionally long on mobile.","Very long sales pages can work, but only when section variety and progress cues sustain momentum.","Audit for duplicate arguments, combine low-value sections, and vary layout every 2–3 sections to preserve pacing.",{"pageHeight":dom.get("documentHeight"),"viewportHeight":vh})

 return f

def findings(dom,console,page_errors,request_failed,asset_failed):
 f=[]
 filtered_page_errors=[
  message for message in page_errors
  if not (
   ("challenges.cloudflare.com" in message and "accessing a frame with origin" in message)
   or ("deploy-preview-" in BASE and message.strip()=="[Cloudflare Turnstile] Error: 110200.")
  )
 ]
 if filtered_page_errors:f.append(Finding("page-error","critical","JavaScript page errors detected",filtered_page_errors[:10]))
 if console:f.append(Finding("console-error","warning","Console errors detected",console[:10]))
 if request_failed:f.append(Finding("request-failed","critical","Same-origin requests failed",request_failed[:15]))
 if asset_failed:f.append(Finding("asset-http-error","critical","Document assets returned HTTP errors",asset_failed[:15]))
 if dom.get("horizontalOverflow"):f.append(Finding("horizontal-overflow","critical",f"Horizontal overflow: {dom.get('scrollWidth')}px in {dom.get('clientWidth')}px viewport",dom.get("overflowingElements",[])[:20]))
 if dom.get("brokenImages"):f.append(Finding("broken-image","critical","Visible images failed to load",dom["brokenImages"][:15]))
 if not dom.get("h1s"):f.append(Finding("missing-h1","critical","No visible H1 found"))
 elif len(dom["h1s"])>1:f.append(Finding("multiple-h1","warning","Multiple visible H1 elements",dom["h1s"]))
 if dom.get("duplicateIds"):f.append(Finding("duplicate-id","critical","Duplicate DOM ids found",dom["duplicateIds"][:20]))
 if dom.get("unlabeledControls"):f.append(Finding("unlabeled-control","critical","Visible form controls lack labels",dom["unlabeledControls"][:20]))
 if dom.get("missingAlt"):f.append(Finding("missing-alt","warning","Visible images lack alt attributes",dom["missingAlt"][:20]))
 if dom.get("clippedText"):f.append(Finding("clipped-text","critical","Text appears clipped by its container",dom["clippedText"][:20]))
 if dom.get("offscreenInteractive"):f.append(Finding("offscreen-control","critical","Interactive controls are outside the usable viewport",dom["offscreenInteractive"][:20]))
 if dom.get("tinyTargets"):f.append(Finding("small-touch-target","warning","Interactive targets smaller than 40px",dom["tinyTargets"][:20]))
 if dom.get("wrappedButtons"):f.append(Finding("wrapped-cta","design","CTA height suggests awkward text wrapping",dom["wrappedButtons"][:20]))
 if dom.get("smallText"):f.append(Finding("very-small-text","design","Text below 11px may feel cramped",dom["smallText"][:20]))
 if dom.get("wideCopy"):f.append(Finding("wide-copy","design","Long copy may be too wide for comfortable reading",dom["wideCopy"][:20]))
 if dom.get("headerRect") and dom["headerRect"]["h"]>135:f.append(Finding("oversized-header","design",f"Header is {dom['headerRect']['h']}px tall",dom["headerRect"]))
 if dom.get("mainTextLength",0)<120:f.append(Finding("thin-page","design","Page has very little visible main content",dom.get("mainTextLength")))
 return f

def html_report(results):
 counts={"critical":0,"warning":0,"design":0}
 cards=[]
 for r in results:
  items=[]
  for x in r["findings"]:
   counts[x["severity"]]=counts.get(x["severity"],0)+1
   detail="" if x.get("detail") is None else "<pre>"+escape(json.dumps(x["detail"],indent=2,ensure_ascii=False))+"</pre>"
   items.append(f"<li class='{x['severity']}'><strong>{escape(x['severity'].upper())}</strong> · {escape(x['code'])}<br>{escape(x['message'])}{detail}</li>")
  cards.append(f"<article><h2>{escape(r['route'])} · {escape(r['viewport'])}</h2><p><a href='{escape(r['screenshot'])}'>screenshot</a></p><ul>{''.join(items) or '<li class=pass><strong>PASS</strong> · No automated issues found.</li>'}</ul></article>")
 return f"""<!doctype html><html><head><meta charset='utf-8'><title>Koa visual QA</title><style>
 body{{font-family:system-ui;margin:0;background:#f6f1e7;color:#10261e}}main{{max-width:1200px;margin:auto;padding:32px}}article{{background:#fff;margin:20px 0;padding:24px;border-radius:18px;border:1px solid #dfd5c4}}.pill{{display:inline-block;background:#fff;border:1px solid #d8c7a9;border-radius:999px;padding:10px 14px;margin:4px}}li{{margin:12px 0;line-height:1.45}}.critical strong{{color:#a12626}}.warning strong{{color:#8a5b00}}.design strong{{color:#6a4c93}}.pass strong{{color:#276749}}pre{{white-space:pre-wrap;overflow:auto;background:#f7f7f5;padding:12px;border-radius:10px;font-size:12px}}</style></head><body><main><h1>Koa's Events production visual QA</h1><p>Automated heuristics surface pages and viewports that deserve human design review.</p><p><span class='pill'>Critical: {counts['critical']}</span><span class='pill'>Warnings: {counts['warning']}</span><span class='pill'>Design flags: {counts['design']}</span></p>{''.join(cards)}</main></body></html>"""


def admin_mode(browser_name):
 try:
  from playwright.sync_api import sync_playwright
 except ImportError:
  print("Install Playwright: pip install playwright && python -m playwright install chromium",file=sys.stderr);return 2

 root=OUT/("admin-"+browser_name);root.mkdir(parents=True,exist_ok=True)
 results=[];failures=[]
 with sync_playwright() as p:
  browser=getattr(p,browser_name).launch()
  ctx=browser.new_context(viewport={"width":1440,"height":1000},reduced_motion="reduce",color_scheme="light")

  # Authorized browser regressions load the production admin shell, whose global
  # auth guard redirects on any same-origin API 401. Register a generic 200 JSON
  # fallback first; page-specific mocks are registered afterward and therefore
  # take precedence. This keeps background nav/profile/alert fetches from turning
  # an otherwise-authorized QA page into a false session-expired redirect.
  def mock_authorized_shell(page):
   page.route("**/api/**",lambda route:route.fulfill(status=200,content_type="application/json",body="{}"))
  for name,path in ADMIN_ROUTES:
   page=ctx.new_page()
   page_errors=[];console_errors=[];request_failed=[]
   page.on("pageerror",lambda e,t=page_errors:t.append(str(e)))
   page.on("console",lambda m,t=console_errors:t.append(m.text) if m.type=="error" else None)
   page.on("requestfailed",lambda r,t=request_failed:t.append(r.url) if urlparse(r.url).netloc==urlparse(BASE).netloc else None)
   status=0;state={};detail=""
   try:
    response=page.goto(BASE+path,wait_until="domcontentloaded",timeout=45000)
    status=response.status if response else 0
    page.wait_for_timeout(800)
    if path=="/admin/crm/":
     try:
      page.wait_for_function(
       """() => {
         const visible=(el)=>{
           if(!el)return false;
           const s=getComputedStyle(el),r=el.getBoundingClientRect();
           return s.display!=='none'&&s.visibility!=='hidden'&&+s.opacity!==0&&r.width>0&&r.height>0;
         };
         return visible(document.querySelector('[data-unauthorized]')) ||
                visible(document.querySelector('[data-admin-ui]')) ||
                (visible(document.querySelector('[data-crm-status]')) &&
                 !String(document.querySelector('[data-crm-status-message]')?.textContent||'').includes('Loading client workspace'));
       }""",
       timeout=4000,
      )
     except Exception:
      pass
    state=page.evaluate("""() => {
      const visible=(el)=>{
        if(!el)return false;
        const s=getComputedStyle(el),r=el.getBoundingClientRect();
        return s.display!=='none'&&s.visibility!=='hidden'&&+s.opacity!==0&&r.width>0&&r.height>0;
      };
      const selectors=['[data-unauthorized]','[data-login-form]','[data-role-warning]','[data-denied]','[data-admin-ui]','[data-app]','[data-admin-links]'];
      const visibleSelectors=selectors.filter((selector)=>visible(document.querySelector(selector)));
      return {visibleSelectors,title:document.title,bodyText:(document.body.innerText||'').trim().slice(0,500)};
    }""")
    allowed_visible=bool(state.get("visibleSelectors"))
    if status>=400:
     detail=f"Document returned HTTP {status}"
    elif page_errors:
     detail="JavaScript page errors: "+" | ".join(page_errors[:5])
    elif not allowed_visible:
     detail="No visible admin UI, login, role-warning, or unauthorized state after startup."
    if detail:
     failures.append({"route":path,"detail":detail,"pageErrors":page_errors[:10],"consoleErrors":console_errors[:10]})
   except Exception as exc:
    detail=str(exc)
    failures.append({"route":path,"detail":detail,"pageErrors":page_errors[:10],"consoleErrors":console_errors[:10]})

   shot=root/f"{name}.png"
   try: page.screenshot(path=str(shot),full_page=True,animations="disabled",caret="hide")
   except Exception: pass
   results.append({
    "name":name,"path":path,"status":status,"state":state,"pageErrors":page_errors,
    "consoleErrors":console_errors,"requestFailed":request_failed,"failure":detail,"screenshot":str(shot)
   })
   page.close()

  # Authorized VenueLoom Super Admin startup regression. This proves the deployed
  # platform page can initialize its protected shell without touching production tenant data.
  page=ctx.new_page()
  page_errors=[];console_errors=[]
  page.on("pageerror",lambda e,t=page_errors:t.append(str(e)))
  page.on("console",lambda m,t=console_errors:t.append(m.text) if m.type=="error" else None)
  mock_authorized_shell(page)
  platform_session_fixture={
   "email":"qa-superadmin@koasevents.test","role":"admin","roles":["admin"],"isAdmin":True,
   "permissions":["admin"],"capabilities":["admin"],"accessBlocked":False,
   "app_metadata":{"roles":["admin"],"permissions":["admin"]},
   "appMetadata":{"roles":["admin"],"permissions":["admin"]}
  }
  platform_fixture={
   "generatedAt":"2026-09-29T00:00:00Z",
   "organizations":[],
   "supportSessions":[],
   "summary":{"organizations":0,"active":0,"trial":0,"attention":0,"subscriptionsActive":0}
  }
  page.route("**/api/admin/session**",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps(platform_session_fixture)))
  page.route("**/api/admin/platform**",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps(platform_fixture)))
  detail=""
  try:
   response=page.goto(BASE+"/admin/platform/",wait_until="domcontentloaded",timeout=45000)
   page.wait_for_selector("[data-app]:not(.hidden)",state="visible",timeout=8000)
   page.wait_for_selector("[data-create-sandbox]",state="visible",timeout=3000)
   document_title=page.title()
   heading=page.locator("h1").inner_text().strip()
   create_label=page.locator("[data-create-sandbox]").inner_text().strip()
   if "VenueLoom Super Admin" not in document_title or heading.strip().lower()!="super admin" or create_label.strip().lower()!="create safe sandbox tenant":
    detail="VenueLoom Super Admin did not reach its expected initialized state: title="+repr(document_title)+", heading="+repr(heading)+", createButton="+repr(create_label)
   elif page_errors:
    detail="VenueLoom Super Admin JavaScript page errors: "+" | ".join(page_errors[:5])
  except Exception as exc:
   detail="VenueLoom Super Admin startup regression: "+str(exc)
  shot=root/"platform-authorized-startup.png"
  try:page.screenshot(path=str(shot),full_page=True,animations="disabled",caret="hide")
  except Exception:pass
  results.append({"name":"platform-authorized-startup","path":"/admin/platform/","status":response.status if 'response' in locals() and response else 0,"state":{"visible":not bool(detail)},"pageErrors":page_errors,"consoleErrors":console_errors,"requestFailed":[],"failure":detail,"screenshot":str(shot)})
  if detail:failures.append({"route":"/admin/platform/","detail":detail,"pageErrors":page_errors[:10],"consoleErrors":console_errors[:10]})
  page.close()

  # Authorized-style Business CRM boot regression test. The protected API is mocked
  # so this catches client startup failures without storing production credentials in CI.
  page=ctx.new_page()
  page_errors=[];console_errors=[]
  page.on("pageerror",lambda e,t=page_errors:t.append(str(e)))
  page.on("console",lambda m,t=console_errors:t.append(m.text) if m.type=="error" else None)
  mock_authorized_shell(page)
  crm_session_fixture={
   "email":"qa-manager@koasevents.test","role":"manager","roles":["manager"],"isAdmin":False,
   "permissions":["crm.view","crm.manage","crm.destructive","crm.workflows","crm.templates","crm.cleanup_policy","sales.profit_settings"],
   "capabilities":["crm.view","crm.manage","crm.destructive","crm.workflows","crm.templates","crm.cleanup_policy","sales.profit_settings"],
   "accessBlocked":False,
   "app_metadata":{"roles":["manager"],"permissions":["crm.view","crm.manage","crm.destructive","crm.workflows","crm.templates","crm.cleanup_policy","sales.profit_settings"]},
   "appMetadata":{"roles":["manager"],"permissions":["crm.view","crm.manage","crm.destructive","crm.workflows","crm.templates","crm.cleanup_policy","sales.profit_settings"]}
  }
  page.route("**/api/admin/session**",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps(crm_session_fixture)))
  crm_fixture={
   "access":{"role":"manager","capabilities":["blog.manage","event_ops.manage","crm.destructive","crm.workflows","crm.templates","crm.cleanup_policy","sales.profit_settings"],"email":"qa-manager@koasevents.test"},
   "projects":[],"tasks":[],"appointments":[],"notes":[],"workflows":[],"enrollments":[],"templates":[],"activity":[],"messages":[],
   "trash":[],"trashGroups":[],"cleanupAudit":[],"cleanupAnalytics":{},"cleanupSettings":{"mode":"auto_trash","updatedAt":"","updatedBy":""}
  }
  page.route("**/api/admin/crm",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps(crm_fixture)))
  detail=""
  try:
   response=page.goto(BASE+"/admin/crm/",wait_until="domcontentloaded",timeout=45000)
   page.wait_for_selector("[data-admin-ui]:not(.hidden)",state="visible",timeout=8000)
   page.wait_for_selector("[data-stat-projects]",state="visible",timeout=3000)
   visible=page.locator("[data-admin-ui]").is_visible()
   project_stat=page.locator("[data-stat-projects]").inner_text().strip()
   if not visible or project_stat!="0":
    detail="Business CRM did not reach its expected visible initialized state."
   elif page_errors:
    detail="Business CRM JavaScript page errors: "+" | ".join(page_errors[:5])
  except Exception as exc:
   detail="Business CRM startup regression: "+str(exc)
  shot=root/"business-crm-authorized-startup.png"
  try:page.screenshot(path=str(shot),full_page=True,animations="disabled",caret="hide")
  except Exception:pass
  results.append({"name":"business-crm-authorized-startup","path":"/admin/crm/","status":response.status if 'response' in locals() and response else 0,"state":{"visible":not bool(detail)},"pageErrors":page_errors,"consoleErrors":console_errors,"requestFailed":[],"failure":detail,"screenshot":str(shot)})
  if detail:failures.append({"route":"/admin/crm/","detail":detail,"pageErrors":page_errors[:10],"consoleErrors":console_errors[:10]})
  page.close()

  # Live payment-rule UI regression test. This loads the deployed QuickBooks/Sales CRM
  # JavaScript but mocks protected API responses so no production records are changed.
  session_fixture={
   "email":"qa-admin@koasevents.test","role":"admin","roles":["admin"],"isAdmin":True,
   "permissions":["quickbooks.view","sales.view"],"capabilities":["quickbooks.view","sales.view"],
   "accessBlocked":False,
   "app_metadata":{"roles":["admin"],"permissions":["quickbooks.view","sales.view"]},
   "appMetadata":{"roles":["admin"],"permissions":["quickbooks.view","sales.view"]}
  }
  qbo_fixture={
   "configuration":{"configured":True,"environment":"production","productionCredentialsConfigured":True,"productionWebhookConfigured":True,"productionRedirectConfigured":True,"redirectUri":"https://koasevents.com/.netlify/functions/quickbooks-callback"},
   "connection":{"connected":True,"realmId":"qa","companyName":"QA Company","connectedAt":"2026-09-22T00:00:00Z"},
   "getSettings":{"customerRate":4.712,"label":"Hawaiʻi GET"},
   "depositSettings":{
    "venueWeddingPercent":10,"mobileBarPercent":10,"privateEventPercent":10,"defaultPercent":10,
    "venueWeddingMilestones":[{"label":"Final payment","dueDaysBefore":60,"percentOfRemaining":100}],
    "mobileBarMilestones":[{"label":"Final balance","dueDaysBefore":14,"percentOfRemaining":100}],
    "privateEventMilestones":[{"label":"Final balance","dueDaysBefore":30,"percentOfRemaining":100}],
    "defaultMilestones":[{"label":"Final balance","dueDaysBefore":30,"percentOfRemaining":100}],
    "customPresets":[],
    "autoRules":[
     {"id":"before-premium","name":"Before GET premium","category":"venueWedding","minLeadDays":0,"maxLeadDays":None,"minContractValue":10050,"maxContractValue":None,"contractValueBasis":"beforeGet","presetId":"builtin-extended-wedding","priority":10,"active":True},
     {"id":"after-premium","name":"After GET premium","category":"venueWedding","minLeadDays":0,"maxLeadDays":None,"minContractValue":10000,"maxContractValue":None,"contractValueBasis":"afterGet","presetId":"builtin-standard-wedding","priority":20,"active":True},
     {"id":"after-overlap","name":"After GET overlap","category":"venueWedding","minLeadDays":0,"maxLeadDays":None,"minContractValue":9000,"maxContractValue":15000,"contractValueBasis":"afterGet","presetId":"builtin-micro-wedding","priority":30,"active":True}
    ]
   },
   "catalog":[],"items":[],"diagnostics":{},"accountingAudit":{}
  }
  page=ctx.new_page()
  page_errors=[];console_errors=[]
  page.on("pageerror",lambda e,t=page_errors:t.append(str(e)))
  page.on("console",lambda m,t=console_errors:t.append(m.text) if m.type=="error" else None)
  mock_authorized_shell(page)
  page.route("**/api/admin/session**",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps(session_fixture)))
  page.route("**/api/admin/quickbooks",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps(qbo_fixture)))
  detail=""
  try:
   response=page.goto(BASE+"/admin/quickbooks/",wait_until="domcontentloaded",timeout=45000)
   page.wait_for_selector("[data-auto-rule]",state="visible",timeout=8000)
   page.locator("[data-rule-sim-category]").select_option("venueWedding")
   page.locator("[data-rule-sim-booking]").fill("2026-01-01")
   page.locator("[data-rule-sim-event]").fill("2026-07-01")
   page.locator("[data-rule-sim-value]").fill("10471.20")
   page.locator("[data-run-rule-simulator]").click()
   simulator=page.locator("[data-rule-simulator-result]").inner_text()
   conflicts=page.locator("[data-rule-conflicts]").inner_text()
   if "After GET premium" not in simulator or "after GET" not in simulator:
    detail="Rule simulator did not honor the after-GET threshold scenario. Result: "+simulator[:500]
   elif "rules matched" not in simulator:
    detail="Rule simulator did not report overlapping matches. Result: "+simulator[:500]
   elif "overlaps" not in conflicts or "Winner" not in conflicts:
    detail="Rule conflict detector did not identify a winner. Result: "+conflicts[:500]
   elif page_errors:
    detail="Payment-rule simulator JavaScript errors: "+" | ".join(page_errors[:5])
  except Exception as exc:
   detail="Payment-rule simulator regression: "+str(exc)
  results.append({"name":"payment-rule-live-simulator","path":"/admin/quickbooks/","status":response.status if 'response' in locals() and response else 0,"state":{"visible":not bool(detail)},"pageErrors":page_errors,"consoleErrors":console_errors,"requestFailed":[],"failure":detail,"screenshot":""})
  if detail:failures.append({"route":"/admin/quickbooks/","detail":detail,"pageErrors":page_errors[:10],"consoleErrors":console_errors[:10]})
  page.close()

  proposal_record={
   "id":"KEP-QA-RULE","kind":"proposal","stage":"proposal","status":"draft","packageId":"signature-wedding",
   "createdAt":"2026-09-22T00:00:00Z","updatedAt":"2026-09-22T00:00:00Z",
   "customer":{"name":"QA Rule Client","email":"qa@example.com","phone":"","eventDate":"2027-06-01","notes":""},
   "proposal":{
    "publicToken":"qa-token","status":"draft","expirationDate":"2026-10-06",
    "lineItems":[{"id":"collection","description":"Signature Wedding Experience","quantity":1,"unitPrice":10000,"amount":10000,"custom":False}],
    "subtotal":10000,"discountAmount":0,"taxRate":4.712,"taxAmount":471.2,"total":10471.2,
    "depositPercent":10,"depositAmount":1047.12,
    "paymentSchedule":[{"label":"Reservation deposit","dueDate":"","amount":1047.12},{"label":"Final payment","dueDate":"2027-04-02","amount":9424.08}],
    "paymentRuleDecision":{
     "ruleId":"after-premium","ruleName":"After GET premium","presetId":"builtin-standard-wedding","presetName":"Standard Wedding",
     "priority":20,"category":"venueWedding","leadDays":608,"contractValueBasis":"afterGet","contractValue":10471.2,
     "beforeGetValue":10000,"afterGetValue":10471.2,
     "matchedRuleIds":["after-premium","after-overlap"],"matchedRuleNames":["After GET premium","After GET overlap"],
     "explanation":["Event category matched venueWedding.","Contract-value basis was after Hawaiʻi GET at $10471.20 and was inside this rule’s range.","2 active rules matched; “After GET premium” won because it had the highest priority.","Preset “Standard Wedding” was selected."],
     "decidedAt":"2026-09-22T00:00:00Z"
    },
    "notesToClient":""
   }
  }
  sales_fixture={"quotes":[],"analytics":{},"funnel":[],"mobileBarAnalytics":{},"mobileBarProfitSettings":{},"conversions":{},"records":[proposal_record],"trash":[]}
  page=ctx.new_page()
  page_errors=[];console_errors=[]
  page.on("pageerror",lambda e,t=page_errors:t.append(str(e)))
  page.on("console",lambda m,t=console_errors:t.append(m.text) if m.type=="error" else None)
  mock_authorized_shell(page)
  page.route("**/api/admin/session**",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps(session_fixture)))
  page.route("**/api/admin/quotes**",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps(sales_fixture)))
  page.route("**/api/admin/quickbooks**",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps({"configuration":{"configured":False},"connection":{"connected":False},"catalog":[]})))
  sales_catalog_fixture={"catalog":[{
   "id":"qa-rental","name":"QA Rental","description":"QA catalog regression item","group":"rentals","category":"rental",
   "unitLabel":"each","unitPrice":125,"internalCost":40,"targetMargin":60,"active":True,"getExempt":False,
   "source":"catalog-manager","sourceRef":"qa","quickBooksItemId":"","quickBooksItemName":"","quickBooksType":"NonInventory",
   "incomeAccountId":"","incomeAccountName":"","updatedAt":"2026-09-27T00:00:00Z"
  }],"imports":[]}
  page.route("**/api/admin/catalog**",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps(sales_catalog_fixture)))
  detail=""
  try:
   response=page.goto(BASE+"/admin/quotes/",wait_until="domcontentloaded",timeout=45000)
   page.wait_for_selector("[data-admin-ui]:not(.hidden)",state="visible",timeout=8000)
   page.wait_for_function("() => document.body.innerText.includes('KEP-QA-RULE')",timeout=8000)
   buttons=page.get_by_role("button",name="Finalize proposal",exact=True)
   if buttons.count()<1:
    buttons=page.get_by_role("button",name="Review proposal",exact=True)
   if buttons.count()<1:
    raise RuntimeError("Proposal editor action was not rendered for QA record.")
   buttons.last.click()
   page.wait_for_selector("[data-rule-decision]:not(.hidden)",state="visible",timeout=5000)
   title=page.locator("[data-rule-decision-title]").inner_text()
   summary=page.locator("[data-rule-decision-summary]").inner_text()
   overlap=page.locator("[data-rule-decision-conflicts]").inner_text()
   if title!="After GET premium":
    detail="Proposal rule explanation title was incorrect: "+title
   elif "after Hawaiʻi GET" not in summary:
    detail="Proposal rule explanation did not display the GET basis. Summary: "+summary[:500]
   elif "2 rules matched" not in overlap or "highest priority" not in overlap:
    detail="Proposal overlap explanation was incomplete. Detail: "+overlap[:500]
   else:
    picker=page.locator("[data-catalog-picker]")
    if picker.count()!=1:
     detail="Sales CRM central catalog picker did not render."
    else:
     picker.select_option("qa-rental")
     page.wait_for_selector('[data-line-items] [data-catalog-item-id="qa-rental"]',state="attached",timeout=5000)
     added=page.locator('[data-line-items] [data-catalog-item-id="qa-rental"]')
     if added.count()!=1:
      detail="Sales CRM Add from catalog did not create exactly one catalog-backed proposal line."
     else:
      description=added.locator("[data-line-description]").input_value()
      price=added.locator("[data-line-price]").input_value()
      if description!="QA catalog regression item" or abs(float(price)-125)>0.001:
       detail="Sales CRM Add from catalog did not add the central catalog item at its current $125 price."
   if not detail and page_errors:
    detail="Sales CRM proposal explanation/catalog picker JavaScript errors: "+" | ".join(page_errors[:5])
  except Exception as exc:
   detail="Sales CRM payment-rule explanation regression: "+str(exc)
  results.append({"name":"sales-crm-payment-rule-explanation","path":"/admin/quotes/","status":response.status if 'response' in locals() and response else 0,"state":{"visible":not bool(detail)},"pageErrors":page_errors,"consoleErrors":console_errors,"requestFailed":[],"failure":detail,"screenshot":""})
  if detail:failures.append({"route":"/admin/quotes/","detail":detail,"pageErrors":page_errors[:10],"consoleErrors":console_errors[:10]})
  page.close()

  # Catalog Manager import/rollback regression test. The page uses the exact
  # production JavaScript while protected API writes are mocked in-browser.
  catalog_session_fixture={
   **session_fixture,
   "permissions":["sales.view","sales.profit_settings"],"capabilities":["sales.view","sales.profit_settings"],
   "app_metadata":{"roles":["admin"],"permissions":["sales.view","sales.profit_settings"]},
   "appMetadata":{"roles":["admin"],"permissions":["sales.view","sales.profit_settings"]}
  }
  catalog_base_item={
   "id":"gardenia","name":"Gardenia Wedding Collection","description":"QA seeded package","group":"packages","category":"service",
   "unitLabel":"package","unitPrice":5000,"internalCost":1800,"targetMargin":60,"active":True,"getExempt":False,
   "source":"website","sourceRef":"gardenia","quickBooksItemId":"","quickBooksItemName":"","quickBooksType":"Service",
   "incomeAccountId":"","incomeAccountName":"","updatedAt":"2026-09-27T00:00:00Z"
  }
  catalog_price_history=[{
   "id":"PRICE-QA","catalogItemId":"gardenia","itemName":"Gardenia Wedding Collection","changedAt":"2026-09-27T00:00:00Z",
   "changedBy":"qa-admin@koasevents.test","source":"catalog-manager","sourceRef":"gardenia","note":"QA price history",
   "oldPrice":4500,"newPrice":5000,"oldInternalCost":1700,"newInternalCost":1800,
   "oldTargetMargin":60,"newTargetMargin":60,"oldActualMargin":62.22,"newActualMargin":64,
   "draftProposalsUpdated":1,"draftProposalIds":["KEP-QA-DRAFT"]
  }]
  catalog_runtime={"catalog":[catalog_base_item.copy()],"imports":[],"priceHistory":catalog_price_history,"actions":[]}
  def catalog_api_mock(route):
   req=route.request
   if req.method=="GET":
    route.fulfill(status=200,content_type="application/json",body=json.dumps({"catalog":catalog_runtime["catalog"],"imports":catalog_runtime["imports"],"priceHistory":catalog_runtime["priceHistory"]}))
    return
   try: payload=json.loads(req.post_data or "{}")
   except Exception: payload={}
   action=str(payload.get("action") or "")
   catalog_runtime["actions"].append(action)
   if action=="item-usage":
    body={"ok":True,"usage":{
     "catalogItemId":"gardenia",
     "proposals":{"count":2,"statuses":{"draft":1,"sent":1},"samples":[{"id":"KEP-QA-DRAFT","client":"QA Couple","eventDate":"2027-09-18","status":"draft","total":5235.60}]},
     "website":{"count":3,"placements":[{"path":"/catalog/","label":"Rental + enhancement catalog"},{"path":"/venue/packages/","label":"Wedding packages"},{"path":"/weddings/","label":"Weddings overview"}]},
     "quickBooks":{"connected":True,"error":"","count":1,"samples":[{"entity":"Estimate","id":"901","docNumber":"EST-QA","txnDate":"2026-09-27","total":5235.60}]},
     "priceHistory":catalog_runtime["priceHistory"]
    }}
   elif action=="run-audit":
    body={"ok":True,"audit":{
     "checkedAt":"2026-09-27T00:10:00Z","qbo":{"connected":True,"error":""},
     "getPolicy":{"status":"source-not-itemized","detail":"QA GET policy source check."},
     "summary":{"total":1,"ok":1,"warnings":0,"errors":0,"publishedPriceMismatches":0,"categoryMismatches":0,"getExemptReview":0,"qboMapped":1,"qboUnmapped":0},
     "rows":[{"id":"gardenia","name":"Gardenia Wedding Collection","group":"packages","category":"service","unitPrice":5000,"getExempt":False,
              "quickBooksItemId":"44","quickBooksItemName":"Gardenia Wedding Collection","publicPrice":5000,"sourceExpected":True,
              "qboMatch":{"id":"44","name":"Gardenia Wedding Collection","type":"Service","active":True,"unitPrice":5000,"incomeAccountId":"1","incomeAccountName":"Venue Income"},
              "qboSuggestion":None,"issues":[],"status":"ok"}]
    }}
   elif action=="reconcile-safe-audit":
    audit={
     "checkedAt":"2026-09-27T00:11:00Z","qbo":{"connected":True,"error":""},
     "getPolicy":{"status":"source-not-itemized","detail":"QA GET policy source check."},
     "summary":{"total":1,"ok":1,"warnings":0,"errors":0,"publishedPriceMismatches":0,"quickBooksPriceMismatches":0,"categoryMismatches":0,"getExemptReview":0,"qboMapped":1,"qboUnmapped":0},
     "rows":[{"id":"gardenia","name":"Gardenia Wedding Collection","group":"packages","category":"service","unitPrice":5000,"getExempt":False,
              "quickBooksItemId":"44","quickBooksItemName":"Wedding Packages:Wedding Package-Gardenia","publicPrice":5000,"sourceExpected":True,
              "qboMatch":{"id":"44","name":"Wedding Package-Gardenia","fullyQualifiedName":"Wedding Packages:Wedding Package-Gardenia","type":"Service","active":True,"taxable":True,"unitPrice":5000,"incomeAccountId":"1","incomeAccountName":"Venue Income"},
              "qboSuggestion":None,"issues":[],"status":"ok"}]
    }
    catalog_runtime["catalog"][0]["quickBooksItemId"]="44"
    catalog_runtime["catalog"][0]["quickBooksItemName"]="Wedding Packages:Wedding Package-Gardenia"
    body={"ok":True,"catalog":catalog_runtime["catalog"],"actions":[{"catalogItemId":"gardenia","action":"mapped","detail":"Linked safe QA mapping."}],"audit":audit}
   elif action=="preview-import":
    body={
     "ok":True,
     "headers":["Name","Group","Price","Cost","Target Margin","GET Status"],
     "mapping":{"name":"Name","group":"Group","unitPrice":"Price","internalCost":"Cost","targetMargin":"Target Margin","getExempt":"GET Status"},
     "suggestedMapping":{"name":"Name","group":"Group","unitPrice":"Price","internalCost":"Cost","targetMargin":"Target Margin","getExempt":"GET Status"},
     "summary":{"rows":1,"valid":1,"new":1,"updates":0,"duplicates":0,"invalid":0},
     "rows":[{
      "rowNumber":2,"status":"new","duplicateId":"","errors":[],
      "item":{"id":"qa-imported-add-on","name":"QA Imported Add-on","description":"","group":"add-ons","category":"service",
       "unitLabel":"each","unitPrice":275,"internalCost":100,"targetMargin":60,"active":True,"getExempt":False}
     }]
    }
   elif action=="commit-import":
    imported={
     "id":"qa-imported-add-on","name":"QA Imported Add-on","description":"","group":"add-ons","category":"service",
     "unitLabel":"each","unitPrice":275,"internalCost":100,"targetMargin":60,"active":True,"getExempt":False,
     "source":"import","sourceRef":"CAT-QA","quickBooksItemId":"","quickBooksItemName":"","quickBooksType":"Service",
     "incomeAccountId":"","incomeAccountName":"","updatedAt":"2026-09-27T00:00:00Z"
    }
    catalog_runtime["catalog"]=[catalog_base_item.copy(),imported]
    entry={"id":"CAT-QA","filename":"qa-catalog-import.csv","createdAt":"2026-09-27T00:00:00Z","createdBy":"qa-admin@koasevents.test","imported":1,"newCount":1,"updatedCount":0,"duplicateMode":"update","rolledBackAt":""}
    catalog_runtime["imports"]=[entry]
    body={"ok":True,"catalog":catalog_runtime["catalog"],"imports":catalog_runtime["imports"],"import":entry,
          "summary":{"rows":1,"valid":1,"new":1,"updates":0,"duplicates":0,"invalid":0}}
   elif action=="rollback-import":
    catalog_runtime["catalog"]=[catalog_base_item.copy()]
    entry={**catalog_runtime["imports"][0],"rolledBackAt":"2026-09-27T00:05:00Z","rolledBackBy":"qa-admin@koasevents.test"}
    catalog_runtime["imports"]=[entry]
    body={"ok":True,"catalog":catalog_runtime["catalog"],"imports":catalog_runtime["imports"],"rollback":entry}
   else:
    body={"ok":True,"catalog":catalog_runtime["catalog"],"imports":catalog_runtime["imports"]}
   route.fulfill(status=200,content_type="application/json",body=json.dumps(body))

  page=ctx.new_page()
  page_errors=[];console_errors=[]
  page.on("pageerror",lambda e,t=page_errors:t.append(str(e)))
  page.on("console",lambda m,t=console_errors:t.append(m.text) if m.type=="error" else None)
  page.on("dialog",lambda dialog:dialog.accept())
  mock_authorized_shell(page)
  page.route("**/api/admin/session**",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps(catalog_session_fixture)))
  page.route("**/api/admin/catalog**",catalog_api_mock)
  detail=""
  shot=root/"admin-catalog-import-rollback.png"
  qa_csv=root/"qa-catalog-import.csv"
  qa_csv.write_text("Name,Group,Price,Cost,Target Margin,GET Status\nQA Imported Add-on,add-ons,275,100,60,taxable\n",encoding="utf-8")
  try:
   response=page.goto(BASE+"/admin/catalog/",wait_until="domcontentloaded",timeout=45000)
   page.wait_for_selector("[data-catalog-list]",state="visible",timeout=8000)
   if "Gardenia Wedding Collection" not in page.locator("[data-catalog-list]").inner_text():
    raise RuntimeError("Catalog Manager did not render its seeded catalog item.")
   if "$4,500" not in page.locator("[data-price-history]").inner_text() or "KEP-QA-DRAFT" not in page.locator("[data-price-history]").inner_text():
    raise RuntimeError("Catalog pricing history did not render old/new pricing and exact repriced proposal IDs.")
   page.locator("[data-run-audit]").click()
   page.wait_for_selector("[data-audit-list]:not(.hidden)",state="visible",timeout=5000)
   if "Gardenia Wedding Collection" not in page.locator("[data-audit-list]").inner_text() or "Gardenia Wedding Collection #44" not in page.locator("[data-audit-list]").inner_text():
    raise RuntimeError("Catalog live audit did not render the public-price and QuickBooks mapping result.")
   reconcile_button=page.locator("[data-reconcile-audit]")
   if reconcile_button.count()!=1 or not reconcile_button.is_visible():
    raise RuntimeError("Catalog safe reconciliation action was not available to an authorized pricing manager.")
   reconcile_button.click()
   page.wait_for_function("() => document.body.innerText.includes('Safe reconciliation complete')",timeout=5000)
   if "reconcile-safe-audit" not in catalog_runtime["actions"]:
    raise RuntimeError("Catalog safe reconciliation did not invoke the protected API action.")
   usage_button=page.get_by_role("button",name="Usage",exact=True).first
   usage_button.click()
   page.wait_for_selector("[data-item-usage]:not(.hidden)",state="visible",timeout=5000)
   usage_text=page.locator("[data-item-usage]").inner_text()
   if "2" not in usage_text or "3" not in usage_text or "1" not in usage_text or "EST-QA" not in usage_text:
    raise RuntimeError("Catalog usage impact did not render proposal, website and QuickBooks transaction usage.")
   page.locator("[data-close-item]").first.click()
   page.locator("[data-open-import]").click()
   page.locator("[data-import-file]").set_input_files(str(qa_csv))
   page.locator("[data-preview-import]").click()
   page.wait_for_selector("[data-preview-section]:not(.hidden)",state="visible",timeout=5000)
   preview_text=page.locator("[data-preview-section]").inner_text()
   if "QA Imported Add-on" not in preview_text or "1 rows" not in preview_text:
    raise RuntimeError("Catalog import preview did not render the mapped CSV row.")
   page.locator("[data-commit-import]").click()
   page.wait_for_function("() => document.body.innerText.includes('QA Imported Add-on')",timeout=5000)
   page.wait_for_timeout(1100)
   rollback_button=page.get_by_role("button",name="Rollback this import",exact=True)
   if rollback_button.count()!=1:
    raise RuntimeError("Committed import did not expose exactly one newest-first rollback action.")
   rollback_button.click()
   page.wait_for_function("() => document.body.innerText.includes('Rolled back')",timeout=5000)
   if "QA Imported Add-on" in page.locator("[data-catalog-list]").inner_text():
    detail="Catalog rollback did not restore the pre-import catalog state."
   elif catalog_runtime["actions"][:6]!=["run-audit","reconcile-safe-audit","item-usage","preview-import","commit-import","rollback-import"]:
    detail="Catalog Manager audit/reconciliation/usage/import action sequence was incorrect: "+repr(catalog_runtime["actions"])
   elif page_errors:
    detail="Catalog Manager import/rollback JavaScript errors: "+" | ".join(page_errors[:5])
  except Exception as exc:
   detail="Catalog Manager import/rollback regression: "+str(exc)
  try:page.screenshot(path=str(shot),full_page=True,animations="disabled",caret="hide")
  except Exception:pass
  results.append({"name":"catalog-manager-import-rollback","path":"/admin/catalog/","status":response.status if 'response' in locals() and response else 0,
                  "state":{"visible":not bool(detail),"actions":catalog_runtime["actions"]},"pageErrors":page_errors,
                  "consoleErrors":console_errors,"requestFailed":[],"failure":detail,"screenshot":str(shot)})
  if detail:failures.append({"route":"/admin/catalog/","detail":detail,"pageErrors":page_errors[:10],"consoleErrors":console_errors[:10]})
  page.close()

  # Wedding Profitability -> Catalog Manager publishing regression. This confirms
  # the deployed client invokes package and add-on approval actions in the intended
  # sequence without changing production financial records.
  profit_session_fixture={
   **session_fixture,
   "permissions":["sales.profit_settings","sales.view"],"capabilities":["sales.profit_settings","sales.view"],
   "app_metadata":{"roles":["admin"],"permissions":["sales.profit_settings","sales.view"]},
   "appMetadata":{"roles":["admin"],"permissions":["sales.profit_settings","sales.view"]}
  }
  zero_costs={"laborSetup":0,"flowers":0,"cake":0,"mobileBar":0,"cleaning":0,"cottage":0,"rentalsInventory":0,
              "coordination":0,"photoBooth":0,"lightingAv":0,"parkingStaffing":0,"otherDirect":0}
  package_costs={**zero_costs,"laborSetup":2400}
  profit_runtime={
   "actions":[],
   "state":{
    "packages":[{"id":"gardenia","name":"Gardenia Wedding Collection","price":5000,"includedGuests":30,"targetMargin":0.60,
                 "costs":package_costs,"catalogPrice":5000,"catalogInternalCost":2400,"catalogTargetMargin":0.60,"catalogActive":True}],
    "addOns":[{"id":"qa-addon","name":"QA Add-on","category":"Rentals","unit":"each","catalogItemId":"qa-addon",
               "directCost":100,"targetMargin":0.50,"sellPrice":150,"priceIncrement":25,"approved":False,"approvedAt":"","approvedBy":"",
               "catalogPrice":150,"catalogInternalCost":100,"catalogTargetMargin":0.50,"catalogActive":True}],
    "events":[],"performance":[],"leaders":{"mostPopular":None,"mostProfitable":None,"totalBookings":0,"bookingThreshold":5,"totalActualCostEvents":0,"actualCostThreshold":5},
    "crmSync":{"bookedWeddingCount":0,"syncedAt":"2026-09-27T00:00:00Z"},
    "catalogSync":{"packageCount":1,"addOnCount":1,"syncedAt":"2026-09-27T00:00:00Z"},
    "updatedAt":"2026-09-27T00:00:00Z","updatedBy":"qa-admin@koasevents.test"
   }
  }
  def profitability_api_mock(route):
   req=route.request
   if req.method=="GET":
    route.fulfill(status=200,content_type="application/json",body=json.dumps(profit_runtime["state"]))
    return
   try: payload=json.loads(req.post_data or "{}")
   except Exception: payload={}
   action=str(payload.get("action") or "")
   profit_runtime["actions"].append(action)
   state=profit_runtime["state"]
   if action=="save-packages":
    incoming=payload.get("packages") or []
    if incoming: state["packages"]=incoming
    state["packages"][0].update({"catalogPrice":5000,"catalogInternalCost":2400,"catalogTargetMargin":0.60,"catalogActive":True})
   elif action=="approve-package-price":
    state["packages"][0]["price"]=6000
    state["packages"][0]["catalogPrice"]=6000
   elif action=="save-addons":
    incoming=payload.get("addOns") or []
    if incoming: state["addOns"]=incoming
    state["addOns"][0].update({"catalogPrice":150,"catalogInternalCost":100,"catalogTargetMargin":0.50,"catalogActive":True})
   elif action=="approve-addon-price":
    state["addOns"][0]["sellPrice"]=200
    state["addOns"][0]["catalogPrice"]=200
    state["addOns"][0]["approved"]=True
    state["addOns"][0]["approvedAt"]="2026-09-27T00:10:00Z"
    state["addOns"][0]["approvedBy"]="qa-admin@koasevents.test"
   body={**state}
   if action=="approve-package-price":
    body["approvedPackage"]={"id":"gardenia","price":6000,"updatedDraftProposals":1}
   if action=="approve-addon-price":
    body["approved"]={"id":"qa-addon","catalogItemId":"qa-addon","price":200,"updatedDraftProposals":1}
   route.fulfill(status=200,content_type="application/json",body=json.dumps(body))

  page=ctx.new_page()
  page_errors=[];console_errors=[]
  page.on("pageerror",lambda e,t=page_errors:t.append(str(e)))
  page.on("console",lambda m,t=console_errors:t.append(m.text) if m.type=="error" else None)
  page.on("dialog",lambda dialog:dialog.accept())
  mock_authorized_shell(page)
  page.route("**/api/admin/session**",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps(profit_session_fixture)))
  page.route("**/api/admin/profitability**",profitability_api_mock)
  detail=""
  try:
   response=page.goto(BASE+"/admin/profitability/",wait_until="domcontentloaded",timeout=45000)
   page.wait_for_selector("[data-packages] [data-package-id=\"gardenia\"]",state="visible",timeout=8000)
   gardenia=page.locator('[data-package-id="gardenia"]')
   if "$6,000" not in gardenia.locator("[data-package-recommended]").inner_text():
    raise RuntimeError("Wedding Profitability package recommendation did not calculate the expected target-margin price.")
   gardenia.locator('[data-approve-package="gardenia"]').click()
   page.wait_for_function("() => document.body.innerText.includes('Catalog Manager: $6,000')",timeout=5000)
   addon=page.locator('[data-addon-id="qa-addon"]')
   addon.locator('[data-approve-addon="qa-addon"]').click()
   page.wait_for_function("() => document.body.innerText.includes('Catalog $200')",timeout=5000)
   expected=["save-packages","approve-package-price","save-addons","approve-addon-price"]
   if profit_runtime["actions"][:4]!=expected:
    detail="Wedding Profitability catalog publish sequence was incorrect: "+repr(profit_runtime["actions"])
   elif page_errors:
    detail="Wedding Profitability catalog publishing JavaScript errors: "+" | ".join(page_errors[:5])
  except Exception as exc:
   detail="Wedding Profitability catalog publishing regression: "+str(exc)
  results.append({"name":"profitability-catalog-publishing","path":"/admin/profitability/","status":response.status if 'response' in locals() and response else 0,
                  "state":{"visible":not bool(detail),"actions":profit_runtime["actions"]},"pageErrors":page_errors,
                  "consoleErrors":console_errors,"requestFailed":[],"failure":detail,"screenshot":""})
  if detail:failures.append({"route":"/admin/profitability/","detail":detail,"pageErrors":page_errors[:10],"consoleErrors":console_errors[:10]})
  page.close()

  # Live Gallery crop-impact regression test. The protected session and data APIs
  # are mocked in-browser so this exercises the exact production JavaScript without
  # reading or changing real gallery records.
  gallery_session_fixture={
   **session_fixture,
   "permissions":["gallery.view"],"capabilities":["gallery.view"],
   "app_metadata":{"roles":["admin"],"permissions":["gallery.view"]},
   "appMetadata":{"roles":["admin"],"permissions":["gallery.view"]}
  }
  gallery_fixture={
   "uploads":[],"hiddenUploads":[],"hiddenCurated":[],
   "curatedEdits":{
    "/media/koa/ceremony-vows-closeup.webp":{"category":"Ceremony","focalX":50,"focalY":50}
   },
   "categoryOrder":{},
   "placementCrops":{
    "/media/koa/ceremony-vows-closeup.webp":{
     "home__flagship-experience__4-3":{"focalX":28,"focalY":42,"updatedAt":"2026-09-25T00:00:00Z"}
    }
   }
  }
  page=ctx.new_page()
  page_errors=[];console_errors=[]
  page.on("pageerror",lambda e,t=page_errors:t.append(str(e)))
  page.on("console",lambda m,t=console_errors:t.append(m.text) if m.type=="error" else None)
  mock_authorized_shell(page)
  page.route("**/api/admin/session**",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps(gallery_session_fixture)))
  page.route("**/api/gallery",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps(gallery_fixture)) if route.request.method=="GET" else route.fulfill(status=200,content_type="application/json",body=json.dumps({"ok":True})))
  page.route("**/api/admin/vendors",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps({"vendors":[]})))
  detail=""
  shot=root/"admin-gallery-authorized-usage.png"
  try:
   response=page.goto(BASE+"/admin/gallery/",wait_until="domcontentloaded",timeout=45000)
   page.wait_for_selector("[data-admin-ui]:not(.hidden)",state="visible",timeout=8000)
   card=page.locator('[data-gallery-key="curated:/media/koa/ceremony-vows-closeup.webp"]')
   card.wait_for(state="visible",timeout=8000)

   high_filter=page.locator('[data-impact-filter-value="high"]')
   unused_filter=page.locator('[data-impact-filter-value="unused"]')
   all_filter=page.locator('[data-impact-filter-value="all"]')
   if not high_filter.locator('[data-impact-count="high"]').inner_text().strip():
    raise RuntimeError("High Impact Gallery filter did not render its photo count.")
   high_filter.click()
   card.wait_for(state="visible",timeout=5000)
   unused_filter.click()
   page.wait_for_function(
    """() => !document.querySelector('[data-gallery-key="curated:/media/koa/ceremony-vows-closeup.webp"]')""",
    timeout=5000,
   )
   all_filter.click()
   card.wait_for(state="visible",timeout=5000)

   usage_button=card.get_by_role("button",name=re.compile(r"^Used in \d+ places?$"))
   if usage_button.count()!=1:
    raise RuntimeError("Gallery usage badge did not render for the ceremony focal image.")
   usage_button.click()
   page.wait_for_function(
    """() => {
      const card=document.querySelector('[data-gallery-key="curated:/media/koa/ceremony-vows-closeup.webp"]');
      const text=(card?.textContent||'').toLowerCase();
      return text.includes('website placements') && text.includes('flagship experience');
    }""",
    timeout=5000,
   )
   card.get_by_role("button",name="Edit crop",exact=True).click()
   page.wait_for_selector("[data-crop-dialog][open]",state="visible",timeout=5000)
   page.wait_for_selector("[data-crop-impact]:not([hidden])",state="visible",timeout=5000)
   impact_title=page.locator("[data-crop-impact-title]").inner_text()
   preview_text=page.locator("[data-usage-previews]").inner_text()
   save_label=page.locator("[data-crop-save]").inner_text()
   override_options=page.locator("[data-placement-override-options]").inner_text()
   override_options_lower=override_options.lower()
   impact_title_lower=impact_title.lower()
   preview_text_lower=preview_text.lower()
   save_label_lower=save_label.lower()
   if "high-impact crop change" not in impact_title_lower:
    detail="Gallery crop warning did not identify the high-impact placement set. Title: "+impact_title
   elif "high impact" not in preview_text_lower:
    detail="Gallery placement previews did not visually label high-impact usage. Preview text: "+preview_text[:700]
   elif "lower impact" not in preview_text_lower:
    detail="Gallery placement previews did not distinguish lower-impact usage. Preview text: "+preview_text[:700]
   elif "save crop to" not in save_label_lower:
    detail="Gallery crop save button did not display the affected-placement count. Label: "+save_label
   elif "home · flagship experience" not in override_options_lower or "override saved" not in override_options_lower:
    detail="Gallery high-impact placement override controls did not show the saved Homepage placement. Options: "+override_options[:700]
   else:
    override_button=page.locator("[data-placement-override-options] button").filter(has_text="Home · Flagship experience")
    if override_button.count()!=1:
     detail="Gallery did not expose exactly one Homepage Flagship crop override control."
    else:
     override_button.click()
     override_title=page.locator("[data-crop-title]").inner_text()
     override_save=page.locator("[data-crop-save]").inner_text()
     remove_override=page.locator("[data-crop-use-global]")
     if "override crop" not in override_title.lower():
      detail="Placement-specific crop editor did not switch into override mode. Title: "+override_title
     elif "save override" not in override_save.lower():
      detail="Placement-specific crop editor did not expose its override save action. Label: "+override_save
     elif not remove_override.is_visible():
      detail="Saved placement override did not expose the Remove override action."
     elif page_errors:
      detail="Gallery usage/crop JavaScript errors: "+" | ".join(page_errors[:5])
  except Exception as exc:
   detail="Gallery usage/crop production regression: "+str(exc)
  try:page.screenshot(path=str(shot),full_page=True,animations="disabled",caret="hide")
  except Exception:pass
  results.append({"name":"gallery-usage-crop-impact","path":"/admin/gallery/","status":response.status if 'response' in locals() and response else 0,"state":{"visible":not bool(detail)},"pageErrors":page_errors,"consoleErrors":console_errors,"requestFailed":[],"failure":detail,"screenshot":str(shot)})
  if detail:failures.append({"route":"/admin/gallery/","detail":detail,"pageErrors":page_errors[:10],"consoleErrors":console_errors[:10]})
  page.close()

  # Prove that the saved per-placement focal point wins over the global focal point
  # on the real deployed Homepage JavaScript.
  page=ctx.new_page()
  page_errors=[];console_errors=[]
  page.on("pageerror",lambda e,t=page_errors:t.append(str(e)))
  page.on("console",lambda m,t=console_errors:t.append(m.text) if m.type=="error" else None)
  page.route("**/api/gallery",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps(gallery_fixture)))
  detail=""
  try:
   response=page.goto(BASE+"/",wait_until="domcontentloaded",timeout=45000)
   hero_usage=page.locator('img[data-koa-focal-src="/media/koa/ceremony-vows-closeup.webp"]')
   hero_usage.first.wait_for(state="visible",timeout=8000)
   page.wait_for_function(
    """() => {
      const img=document.querySelector('img[data-koa-focal-src="/media/koa/ceremony-vows-closeup.webp"]');
      return img && img.dataset.koaPlacementCropApplied === 'home__flagship-experience__4-3';
    }""",
    timeout=5000,
   )
   position=hero_usage.first.evaluate("(img) => img.style.objectPosition")
   if position!="28% 42%":
    detail="Homepage placement crop override did not win over the global focal point. object-position: "+str(position)
   elif page_errors:
    detail="Homepage placement crop runtime JavaScript errors: "+" | ".join(page_errors[:5])
  except Exception as exc:
   detail="Homepage placement crop runtime regression: "+str(exc)
  results.append({"name":"homepage-placement-crop-override","path":"/","status":response.status if 'response' in locals() and response else 0,"state":{"visible":not bool(detail)},"pageErrors":page_errors,"consoleErrors":console_errors,"requestFailed":[],"failure":detail,"screenshot":""})
  if detail:failures.append({"route":"/","detail":detail,"pageErrors":page_errors[:10],"consoleErrors":console_errors[:10]})
  page.close()

  ctx.close();browser.close()

 api_results=[]
 for name,path in PROTECTED_ADMIN_APIS:
  status,_,body=get(path)
  ok=status in {401,403}
  api_results.append({"name":name,"path":path,"status":status,"ok":ok})
  if not ok:
   failures.append({"route":path,"detail":f"Protected admin API expected 401/403 without authentication, got HTTP {status}.","pageErrors":[],"consoleErrors":[]})

 for name,path,payload in HYBRID_PUBLIC_READ_APIS:
  status,_,body=get(path)
  public_read_ok=(status==200)
  api_results.append({"name":name+"-public-read","path":path,"method":"GET","status":status,"ok":public_read_ok,"expected":"public read"})
  if not public_read_ok:
   failures.append({"route":path,"detail":f"Hybrid public-read API expected HTTP 200 for GET, got HTTP {status}.","pageErrors":[],"consoleErrors":[]})

  status,_,body=post(path,json.dumps(payload),"application/json")
  protected_write_ok=status in {401,403}
  api_results.append({"name":name+"-unauthenticated-write","path":path,"method":"POST","status":status,"ok":protected_write_ok,"expected":"401/403"})
  if not protected_write_ok:
   failures.append({"route":path,"detail":f"Hybrid API mutation expected 401/403 without authentication, got HTTP {status}.","pageErrors":[],"consoleErrors":[]})

 report={"mode":"admin","baseUrl":BASE,"browser":browser_name,"routes":results,"protectedApis":api_results,"failures":failures}
 (root/"report.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
 print(json.dumps({"baseUrl":BASE,"browser":browser_name,"checked":len(results),"failures":failures,"report":str(root/"report.json")},indent=2))
 return 1 if failures else 0


def health_mobile_mode(browser_name,health_payload_path):
 try:from playwright.sync_api import sync_playwright
 except ImportError:
  print("Install Playwright: pip install playwright && python -m playwright install chromium",file=sys.stderr);return 2

 payload_path=Path(health_payload_path)
 if not payload_path.is_file():
  print("System Health dashboard payload is missing: "+str(payload_path),file=sys.stderr);return 2
 envelope=json.loads(payload_path.read_text(encoding="utf-8"))
 dashboard=envelope.get("dashboard") if isinstance(envelope,dict) and isinstance(envelope.get("dashboard"),dict) else envelope
 current=dashboard.get("current") if isinstance(dashboard,dict) else None
 if not isinstance(current,dict):
  print("System Health dashboard payload has no current snapshot.",file=sys.stderr);return 2

 root=OUT/("health-mobile-"+browser_name);root.mkdir(parents=True,exist_ok=True)
 session_fixture={
  "email":"qa-system-health@koasevents.test",
  "displayName":"System Health QA",
  "jobTitle":"Release QA",
  "pronouns":"",
  "roleDescription":"Automated protected-workspace regression",
  "photoUrl":"",
  "signature":{"showTitle":True,"showTeamTitle":True,"showPronouns":False,"showRoleDescription":False},
  "role":"admin","roles":["admin"],"isAdmin":True,
  "permissions":["admin.dashboard.view","health.view","health.manage"],
  "capabilities":["admin.dashboard.view","health.view","health.manage"],
  "accessBlocked":False,"blockReason":"",
  "security":{"forcePasswordChange":False,"passwordChangedAt":"","passwordExpiresAt":"","passwordExpired":False,"passwordExpiryDays":180,"sessionVersion":0,"tokenSessionVersion":0,"sessionRevoked":False},
  "tenant":{"id":"koa","slug":"koa","displayName":"Koa's Events","locale":"en-US","currency":"USD","timezone":"Pacific/Honolulu"},
  "organization":None,"membership":None,
  "app_metadata":{"roles":["admin"],"permissions":["admin.dashboard.view","health.view","health.manage"],"tenantId":"koa","membershipId":"qa"},
  "appMetadata":{"roles":["admin"],"permissions":["admin.dashboard.view","health.view","health.manage"],"tenantId":"koa","membershipId":"qa"},
 }
 viewports=[("phone-small",320,568,2),("phone",390,844,2)]
 results=[];failures=[]
 with sync_playwright() as p:
  browser=getattr(p,browser_name).launch()
  for viewport_name,width,height,dpr in viewports:
   ctx=browser.new_context(
    viewport={"width":width,"height":height},
    device_scale_factor=dpr,
    is_mobile=True,
    has_touch=True,
    reduced_motion="reduce",
    color_scheme="light",
   )
   page=ctx.new_page();page_errors=[];console_errors=[];request_failed=[]
   page.on("pageerror",lambda e,t=page_errors:t.append(str(e)))
   page.on("console",lambda m,t=console_errors:t.append(m.text) if m.type=="error" else None)
   page.on("requestfailed",lambda r,t=request_failed:t.append(r.url) if urlparse(r.url).netloc==urlparse(BASE).netloc else None)

   # Load the real production document, CSS, and JavaScript while supplying an
   # authorized admin session and the signed live dashboard snapshot produced
   # immediately before this browser test. Background admin-shell APIs receive a
   # harmless empty JSON response so no human session secret is stored in CI.
   page.route("**/api/**",lambda route:route.fulfill(status=200,content_type="application/json",body="{}"))
   page.route("**/api/admin/session**",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps(session_fixture)))
   page.route("**/api/admin/health**",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps(dashboard)))

   detail=""
   metrics={}
   try:
    response=page.goto(BASE+"/admin/health/",wait_until="domcontentloaded",timeout=45000)
    if not response or response.status>=400:
     raise RuntimeError("System Health document returned HTTP "+str(response.status if response else 0))
    page.wait_for_selector("[data-app]:not(.hidden)",state="visible",timeout=10000)
    page.wait_for_function(
     """() => {
       const overall=String(document.querySelector('[data-overall]')?.textContent||'').trim();
       const checked=String(document.querySelector('[data-checked]')?.textContent||'').trim();
       return overall && overall!=='—' && overall!=='No data' && overall!=='Check failed' && checked && checked!=='—';
     }""",
     timeout=10000,
    )
    page.wait_for_timeout(350)

    expected_passed=int(current.get("passed") or 0)
    expected_failed=int(current.get("failed") or 0)
    metrics=page.evaluate("""() => {
      const visible=(el)=>{
        if(!el)return false;
        const style=getComputedStyle(el),rect=el.getBoundingClientRect();
        return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0&&rect.width>0&&rect.height>0;
      };
      const nav=document.querySelector('[data-workspace-nav]');
      const bottom=document.querySelector('[data-workspace-bottom-nav]');
      const main=document.querySelector('main[data-system-health-page]');
      const title=main?.querySelector('h1');
      const navRect=nav?.getBoundingClientRect();
      const bottomRect=bottom?.getBoundingClientRect();
      const titleRect=title?.getBoundingClientRect();
      const mainRect=main?.getBoundingClientRect();
      const tableCells=[...document.querySelectorAll('main[data-system-health-page] table.koa-mobile-card-table tbody td')];
      return {
        overall:String(document.querySelector('[data-overall]')?.textContent||'').trim(),
        passed:String(document.querySelector('[data-passed]')?.textContent||'').trim(),
        failed:String(document.querySelector('[data-failed]')?.textContent||'').trim(),
        checked:String(document.querySelector('[data-checked]')?.textContent||'').trim(),
        dashboardRefresh:String(document.querySelector('[data-dashboard-refresh-status]')?.textContent||'').trim(),
        headerPosition:nav?getComputedStyle(nav).position:'',
        headerVisible:visible(nav),
        headerBottom:navRect?.bottom??null,
        titleTop:titleRect?.top??null,
        mainTop:mainRect?.top??null,
        bottomPosition:bottom?getComputedStyle(bottom).position:'',
        bottomVisible:visible(bottom),
        bottomTop:bottomRect?.top??null,
        bottomBottom:bottomRect?.bottom??null,
        viewportHeight:innerHeight,
        viewportWidth:innerWidth,
        documentScrollWidth:document.documentElement.scrollWidth,
        mobileTableCells:tableCells.length,
        unlabeledMobileTableCells:tableCells.filter((cell)=>!String(cell.dataset.mobileLabel||'').trim()).length,
      };
    }""")

    checks=[
     (metrics.get("overall") not in {"","—","No data","Check failed"},"Overall is a real live health state"),
     (metrics.get("passed")==str(expected_passed),"Passed total matches the live production snapshot"),
     (metrics.get("failed")==str(expected_failed),"Failed total matches the live production snapshot"),
     (metrics.get("checked") not in {"","—"},"Last Checked is populated"),
     (metrics.get("headerVisible") is True,"Mobile workspace header is visible"),
     (metrics.get("headerPosition") not in {"fixed","sticky"},"Mobile workspace header remains in document flow"),
     (metrics.get("bottomVisible") is True,"Mobile bottom navigation is visible"),
     (metrics.get("bottomPosition")=="fixed","Mobile bottom navigation remains fixed to the viewport"),
     (float(metrics.get("titleTop") or -1)>=float(metrics.get("headerBottom") or 0)-1,"System Health title is not covered by the top header"),
     (float(metrics.get("bottomBottom") or 0)<=float(metrics.get("viewportHeight") or 0)+1,"Bottom navigation stays inside the viewport"),
     (float(metrics.get("documentScrollWidth") or 0)<=float(metrics.get("viewportWidth") or 0)+1,"System Health has no horizontal page overflow"),
     (int(metrics.get("unlabeledMobileTableCells") or 0)==0,"Converted mobile table cells retain labels"),
    ]
    failed_checks=[label for ok,label in checks if not ok]
    if failed_checks:
     detail="; ".join(failed_checks)

    top_shot=root/f"system-health-{viewport_name}-top.png"
    page.screenshot(path=str(top_shot),full_page=False,animations="disabled",caret="hide")

    # Exercise the same client interaction staff use. Both POST and follow-up GET
    # receive the signed production dashboard payload captured for this run.
    refresh_button=page.locator("[data-refresh]")
    refresh_button.click()
    page.wait_for_function(
     """() => {
       const button=document.querySelector('[data-refresh]');
       return button && !button.disabled && String(button.textContent||'').trim()==='Run checks now';
     }""",
     timeout=10000,
    )
    refreshed=page.evaluate("""() => ({
      overall:String(document.querySelector('[data-overall]')?.textContent||'').trim(),
      passed:String(document.querySelector('[data-passed]')?.textContent||'').trim(),
      failed:String(document.querySelector('[data-failed]')?.textContent||'').trim(),
      checked:String(document.querySelector('[data-checked]')?.textContent||'').trim(),
      dashboardRefresh:String(document.querySelector('[data-dashboard-refresh-status]')?.textContent||'').trim(),
    })""")
    metrics["afterRunChecksNow"]=refreshed
    expected_refresh="Partial" if dashboard.get("enrichmentWarnings") else "Current"
    if refreshed.get("passed")!=str(expected_passed) or refreshed.get("failed")!=str(expected_failed) or refreshed.get("checked") in {"","—"}:
     detail=(detail+"; " if detail else "")+"Run checks now did not preserve the live summary totals"
    if refreshed.get("dashboardRefresh")!=expected_refresh:
     detail=(detail+"; " if detail else "")+"Dashboard Refresh expected "+expected_refresh+" after Run checks now, got "+str(refreshed.get("dashboardRefresh"))

    bottom_metrics=page.evaluate("""async () => {
      const main=document.querySelector('main[data-system-health-page]');
      const bottom=document.querySelector('[data-workspace-bottom-nav]');
      if(!main||!bottom)return {ok:false,reason:'Missing System Health main or bottom navigation.'};
      let sentinel=document.querySelector('[data-health-mobile-qa-sentinel]');
      if(!sentinel){
        sentinel=document.createElement('div');
        sentinel.dataset.healthMobileQaSentinel='';
        sentinel.style.cssText='height:2px;width:2px;pointer-events:none;';
        main.appendChild(sentinel);
      }
      sentinel.scrollIntoView({block:'end'});
      await new Promise((resolve)=>setTimeout(resolve,250));
      const sentinelRect=sentinel.getBoundingClientRect();
      const bottomRect=bottom.getBoundingClientRect();
      const history=document.querySelector('[data-health-history]');
      const lastHistory=history?.lastElementChild;
      if(lastHistory instanceof HTMLElement){
        lastHistory.scrollIntoView({block:'end'});
        await new Promise((resolve)=>setTimeout(resolve,250));
      }
      const targetRect=(lastHistory instanceof HTMLElement?lastHistory:sentinel).getBoundingClientRect();
      const freshBottom=bottom.getBoundingClientRect();
      return {
        ok:true,
        sentinelBottom:sentinelRect.bottom,
        bottomTop:bottomRect.top,
        targetBottom:targetRect.bottom,
        targetTop:targetRect.top,
        freshBottomTop:freshBottom.top,
        targetHeight:targetRect.height,
        viewportHeight:innerHeight,
      };
    }""")
    if not bottom_metrics.get("ok"):
     detail=(detail+"; " if detail else "")+str(bottom_metrics.get("reason") or "Bottom-navigation geometry check failed")
    else:
     sentinel_clear=float(bottom_metrics.get("sentinelBottom") or 99999)<=float(bottom_metrics.get("bottomTop") or -1)-2
     target_clear=float(bottom_metrics.get("targetBottom") or 99999)<=float(bottom_metrics.get("freshBottomTop") or -1)-2
     if not sentinel_clear:
      detail=(detail+"; " if detail else "")+"Scroll targets can land behind the fixed bottom navigation"
     if not target_clear:
      detail=(detail+"; " if detail else "")+"Last Health history content is covered by the fixed bottom navigation"

    bottom_shot=root/f"system-health-{viewport_name}-bottom.png"
    page.screenshot(path=str(bottom_shot),full_page=False,animations="disabled",caret="hide")
    full_shot=root/f"system-health-{viewport_name}-full.png"
    page.screenshot(path=str(full_shot),full_page=True,animations="disabled",caret="hide")

    if page_errors:
     detail=(detail+"; " if detail else "")+"JavaScript errors: "+" | ".join(page_errors[:5])
   except Exception as exc:
    detail=(detail+"; " if detail else "")+str(exc)
    top_shot=root/f"system-health-{viewport_name}-top.png"
    bottom_shot=root/f"system-health-{viewport_name}-bottom.png"
    full_shot=root/f"system-health-{viewport_name}-full.png"
    try:page.screenshot(path=str(full_shot),full_page=True,animations="disabled",caret="hide")
    except Exception:pass

   result={
    "viewport":viewport_name,"width":width,"height":height,
    "expected":{"passed":int(current.get("passed") or 0),"failed":int(current.get("failed") or 0),"checkedAt":current.get("checkedAt"),"overall":current.get("overall")},
    "metrics":metrics,"failure":detail,
    "pageErrors":page_errors[:10],"consoleErrors":console_errors[:10],"requestFailed":request_failed[:10],
    "screenshots":{"top":str(top_shot),"bottom":str(bottom_shot),"full":str(full_shot)},
   }
   results.append(result)
   if detail:failures.append({"viewport":viewport_name,"detail":detail,"metrics":metrics})
   page.close();ctx.close()
  browser.close()

 report={
  "mode":"health-mobile","baseUrl":BASE,"browser":browser_name,
  "checkedAt":current.get("checkedAt"),"overall":current.get("overall"),
  "passed":current.get("passed"),"failed":current.get("failed"),
  "enrichmentWarnings":dashboard.get("enrichmentWarnings",[]) if isinstance(dashboard,dict) else [],
  "results":results,"failures":failures,
 }
 (root/"report.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
 print(json.dumps({
  "baseUrl":BASE,"browser":browser_name,"checked":len(results),
  "overall":current.get("overall"),"passed":current.get("passed"),"failed":current.get("failed"),"checkedAt":current.get("checkedAt"),
  "dashboardRefreshWarnings":report["enrichmentWarnings"],"failures":failures,"report":str(root/"report.json")
 },indent=2))
 return 1 if failures else 0


def browser_mode(browser_name):
 try:from playwright.sync_api import sync_playwright
 except ImportError:
  print("Install Playwright: pip install playwright && python -m playwright install chromium",file=sys.stderr);return 2
 root=OUT/("browser-"+browser_name);root.mkdir(parents=True,exist_ok=True);results=[]
 with sync_playwright() as p:
  browser=getattr(p,browser_name).launch()
  for vp,w,h,dpr in VIEWPORTS:
   ctx=browser.new_context(viewport={"width":w,"height":h},device_scale_factor=dpr,is_mobile=w<900,has_touch=w<900,reduced_motion="reduce",color_scheme="light")
   for name,path in ROUTES:
    page=ctx.new_page();page_errors=[];console=[];request_failed=[];asset_failed=[]
    page.on("pageerror",lambda e,t=page_errors:t.append(str(e)))
    page.on("console",lambda m,t=console:t.append(m.text) if m.type=="error" else None)
    page.on("requestfailed",lambda r,t=request_failed:t.append(r.url) if urlparse(r.url).netloc==urlparse(BASE).netloc else None)
    page.on("response",lambda r,t=asset_failed:t.append({"url":r.url,"status":r.status}) if r.status>=400 and r.request.resource_type in {"document","script","stylesheet","image","font"} else None)
    nav=None
    try:
     response=page.goto(BASE+path,wait_until="domcontentloaded",timeout=45000)
     if response and response.status>=400:nav=f"Document returned HTTP {response.status}"
     page.wait_for_timeout(700)
     page.evaluate("""async () => {
       const imgs=[...document.images];
       imgs.forEach(img=>{img.loading='eager';});
       const step=Math.max(500,Math.floor(innerHeight*.8));
       for(let y=0;y<document.documentElement.scrollHeight;y+=step){
         window.scrollTo(0,y);
         await new Promise(r=>setTimeout(r,35));
       }
       window.scrollTo(0,0);
       await Promise.all(imgs.map(img=>img.complete?Promise.resolve():new Promise(r=>{
         const done=()=>r();
         img.addEventListener('load',done,{once:true});
         img.addEventListener('error',done,{once:true});
         setTimeout(done,7000);
       })));
     }""")
     page.wait_for_timeout(150)
    except Exception as e:nav=str(e)
    dom={} if nav else page.evaluate(DOM)
    fs=[Finding("navigation-failed","critical",nav)] if nav else findings(dom,console,page_errors,request_failed,asset_failed)
    if not nav:
     fs.extend(expert_design_findings(dom,path,vp))
    shot=root/f"{name}-{vp}.png"
    try:page.screenshot(path=str(shot),full_page=True,animations="disabled",caret="hide")
    except Exception:shot=Path("")
    results.append({"route":path,"routeName":name,"viewport":vp,"width":w,"height":h,"dom":dom,"findings":[x.__dict__ for x in fs],"screenshot":str(shot)})
    page.close()
   ctx.close()
  browser.close()
 critical=[{"route":r["route"],"viewport":r["viewport"],"finding":x} for r in results for x in r["findings"] if x["severity"]=="critical"]
 design=[{"route":r["route"],"viewport":r["viewport"],"finding":x} for r in results for x in r["findings"] if x["severity"]=="design"]
 unique_design={}
 for item in design:
  key=(item["route"],item["finding"]["code"])
  if key not in unique_design:
   unique_design[key]={**item,"occurrences":1,"viewports":[item["viewport"]]}
  else:
   unique_design[key]["occurrences"]+=1
   if item["viewport"] not in unique_design[key]["viewports"]: unique_design[key]["viewports"].append(item["viewport"])
 prioritized=list(unique_design.values())
 priority_order={"hero-wrap":0,"hero-hierarchy":1,"mobile-header-footprint":2,"body-copy-scale":3,"mobile-copy-density":4,"cta-saturation":5,"section-rhythm":6,"weak-section-hierarchy":7,"image-scarcity":8,"repeated-page-imagery":9,"mobile-page-length":10}
 prioritized.sort(key=lambda x:(priority_order.get(x["finding"]["code"],50),-x["occurrences"],x["route"]))
 report={"mode":"browser","baseUrl":BASE,"browser":browser_name,"cases":len(results),"criticalCount":len(critical),"critical":critical,"designCount":len(design),"uniqueDesignCount":len(prioritized),"topDesignRecommendations":prioritized[:120],"results":results}
 (root/"report.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
 (root/"report.html").write_text(html_report(results),encoding="utf-8")
 print(json.dumps({"baseUrl":BASE,"cases":len(results),"criticalCount":len(critical),"critical":critical[:80],"designCount":len(design),"uniqueDesignCount":len(prioritized),"topDesignRecommendations":prioritized[:60],"report":str(root/"report.html")},indent=2))
 return 1 if critical else 0

def main():
 p=argparse.ArgumentParser(description="Koa's Events production visual QA")
 p.add_argument("--mode",choices=("source","wait","smoke","browser","admin","health-mobile"),required=True)
 p.add_argument("--browser",choices=("chromium","webkit"),default="chromium")
 p.add_argument("--base-url");p.add_argument("--wait-seconds",type=int,default=600);p.add_argument("--health-payload",default="visual-results/system-health-dashboard.json");a=p.parse_args()
 global BASE
 if a.base_url:BASE=a.base_url.rstrip("/")
 if a.mode=="source":return source_mode()
 if a.mode=="wait":return wait_mode(a.wait_seconds)
 if a.mode=="smoke":return smoke_mode()
 if a.mode=="admin":return admin_mode(a.browser)
 if a.mode=="health-mobile":return health_mobile_mode(a.browser,a.health_payload)
 return browser_mode(a.browser)

if __name__=="__main__":sys.exit(main())
