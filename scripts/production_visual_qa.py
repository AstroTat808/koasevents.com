# Visual refresh verification trigger 2026-09-18
#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, os, re, sys, time
from dataclasses import dataclass
from html import escape
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

BASE=os.environ.get("PRODUCTION_BASE_URL","https://koasevents.netlify.app").rstrip("/")
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
 remote=[];placeholders=[];inline=[];media_refs=set()
 for path in files:
  text=path.read_text(encoding="utf-8",errors="ignore")
  media_refs.update(ref for ref in re.findall(r"""['"](/media/[^'")?#]+)['"]""",text) if not ref.endswith("/"))
  if path.name=="media.ts":
   for name in re.findall(r"""koaMarketing\(['"]([^'"]+)['"]""",text): media_refs.add("/media/koa/"+name)
   for name in re.findall(r"""koa\(\s*['"]([^'"]+)['"]""",text): media_refs.add("/media/koa/"+name)
   for name in re.findall(r"""editorial\(\s*['"]([^'"]+)['"]""",text): media_refs.add("/media/editorial/"+name)
   for name in re.findall(r"""['"](02b2df_[^'"]+~mv2\.jpg)['"]""",text): media_refs.add("/media/wix/"+name)
  if "static.wixstatic.com" in text:remote.append(str(path.relative_to(ROOT)))
  if re.search(r'href=["\']#["\']',text):placeholders.append(str(path.relative_to(ROOT)))
  if text.count("style=")>8:inline.append(str(path.relative_to(ROOT)))
 if remote:warnings.append("Wix-hosted image dependencies remain in: "+", ".join(remote[:20]))
 if placeholders:warnings.append("Placeholder # links found in: "+", ".join(placeholders[:20]))
 if inline:warnings.append("Heavy inline styles found in: "+", ".join(inline[:20]))
 missing_media=[ref for ref in sorted(media_refs) if not (ROOT/"public"/ref.lstrip("/")).is_file()]
 if missing_media:failures.append("Missing local media assets referenced by source: "+", ".join(missing_media[:40]))
 report={"mode":"source","sourceFiles":len(files),"mediaReferences":len(media_refs),"missingMedia":missing_media,"failures":failures,"warnings":warnings}
 (OUT/"source-audit.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
 print(json.dumps(report,indent=2));return 1 if failures else 0

def smoke_mode():
 OUT.mkdir(parents=True,exist_ok=True);checks=[];failures=[]
 for name,path in ROUTES:
  status,headers,body=get(path)
  ok=200<=status<400 and len(body)>250
  checks.append({"name":name,"path":path,"status":status,"bytes":len(body),"ok":ok})
  if not ok:failures.append(f"{path} returned {status} / {len(body)} bytes")
 status,headers,_=get("/")
 missing=[h for h in ("x-content-type-options","referrer-policy") if not headers.get(h)]
 if missing:failures.append("Homepage missing security headers: "+", ".join(missing))
 report={"mode":"smoke","baseUrl":BASE,"checks":checks,"failures":failures}
 (OUT/"production-smoke.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
 print(json.dumps({"checks":len(checks),"failures":failures},indent=2));return 1 if failures else 0

def wait_mode(seconds=600):
 deadline=time.time()+seconds
 while time.time()<deadline:
  status,_,body=get("/signature-wedding/",20)
  if status==200 and b"Signature Wedding" in body:
   print(json.dumps({"ready":True,"baseUrl":BASE,"status":status},indent=2));return 0
  time.sleep(10)
 print(json.dumps({"ready":False,"baseUrl":BASE},indent=2));return 1

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
 if page_errors:f.append(Finding("page-error","critical","JavaScript page errors detected",page_errors[:10]))
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
     response=page.goto(BASE+path,wait_until="networkidle",timeout=45000)
     if response and response.status>=400:nav=f"Document returned HTTP {response.status}"
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
         setTimeout(done,2500);
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
 p.add_argument("--mode",choices=("source","wait","smoke","browser"),required=True)
 p.add_argument("--browser",choices=("chromium","webkit"),default="chromium")
 p.add_argument("--base-url");p.add_argument("--wait-seconds",type=int,default=600);a=p.parse_args()
 global BASE
 if a.base_url:BASE=a.base_url.rstrip("/")
 if a.mode=="source":return source_mode()
 if a.mode=="wait":return wait_mode(a.wait_seconds)
 if a.mode=="smoke":return smoke_mode()
 return browser_mode(a.browser)

if __name__=="__main__":sys.exit(main())
