#!/usr/bin/env python3
"""Synthetic browser-only System Health controls QA; never loads customer data."""
import argparse
import json
from playwright.sync_api import sync_playwright

def fixture():
    session={
        "email":"qa-system-health@koasevents.test","displayName":"Synthetic QA",
        "role":"admin","roles":["admin"],"isAdmin":True,"accessBlocked":False,
        "permissions":["admin.dashboard.view","health.view","health.manage"],
        "capabilities":["admin.dashboard.view","health.view","health.manage"],
        "tenant":{"id":"koa","slug":"koa","displayName":"Koa's Events"},
    }
    session["app_metadata"]={"roles":["admin"],"permissions":session["permissions"],"tenantId":"koa"}
    session["appMetadata"]=session["app_metadata"]
    checks=[
        {"id":"netlify-recovery-credential","name":"Synthetic deployment failure",
         "kind":"api","path":"Synthetic release check","severity":"red","ok":False,
         "status":503,"ms":4,"detail":"Synthetic test only: PRIVATE_CLIENT_FIXTURE"},
        {"id":"email-delivery","name":"Synthetic email warning",
         "kind":"api","path":"Synthetic integration check","severity":"yellow","ok":False,
         "status":422,"ms":3,"detail":"Synthetic test only"},
        {"id":"admin-home","name":"Synthetic healthy page",
         "kind":"page","path":"/admin/","severity":"green","ok":True,
         "status":200,"ms":2,"detail":"Synthetic test only"},
    ]
    dashboard={
        "current":{"overall":"unhealthy","passed":1,"failed":2,
                   "checkedAt":"2026-10-15T18:00:00.000Z","checks":checks},
        "coverage":{},"criticalIntegrations":{},"rollbackReady":{},
        "runtime":{},"deployments":{"releaseTimeline":[]},"office365":{},
        "emailHealth":{},"credentialHealth":{},"weeklyExecutiveSummary":{},
        "accountingHealth":{},"visualQuality":{"status":"unavailable"},
        "enrichmentWarnings":[],
    }
    return session,dashboard

def run(browser_name,base_url,width,height):
    session,dashboard=fixture()
    with sync_playwright() as p:
        browser=getattr(p,browser_name).launch()
        context=browser.new_context(viewport={"width":width,"height":height},
                                    is_mobile=width<768,has_touch=width<768,
                                    reduced_motion="reduce",color_scheme="light")
        page=context.new_page()
        # Every protected API response is synthetic, with no live customer queries.
        page.route("**/api/**",lambda r:r.fulfill(status=200,content_type="application/json",body="{}"))
        page.route("**/api/admin/session**",lambda r:r.fulfill(status=200,content_type="application/json",body=json.dumps(session)))
        page.route("**/api/admin/health**",lambda r:r.fulfill(status=200,content_type="application/json",body=json.dumps(dashboard)))
        try:
            response=page.goto(base_url+"/admin/health/",wait_until="domcontentloaded",timeout=45000)
            assert response and response.status==200,"Synthetic Health page must load"
            page.wait_for_selector("[data-app]:not(.hidden)",timeout=12000)
            page.wait_for_function("() => document.querySelectorAll('[data-results] button').length === 3",timeout=12000)
            container=page.locator("[data-results]").locator("xpath=ancestor::*[@data-mobile-collapsible][1]")
            if container.count() and container.get_attribute("data-mobile-collapsed")=="true":
                container.locator("[data-mobile-collapse-toggle]").first.click()
                page.wait_for_function("""() => {
                    const el=document.querySelector('[data-results]')?.closest('[data-mobile-collapsible]');
                    return el?.dataset.mobileCollapsed==='false';
                }""",timeout=5000)
            selector=page.locator("[data-health-severity-filter]")
            selector.select_option("critical")
            assert page.locator("[data-results] button").count()==1,"Critical filter count"
            card=page.locator("[data-results] button").first
            assert card.get_attribute("data-health-severity")=="critical","Critical severity card metadata"
            assert card.is_visible(),"Critical card must be visible after expanding Health section"
            page.locator("[data-results] button").first.click()
            dialog=page.locator("[data-health-detail-dialog]")
            assert dialog.evaluate("(el) => el.open"),"Diagnostic dialog must open"
            panel=page.locator("[data-health-safe-diagnostics]")
            assert not panel.evaluate("(el) => el.open"),"Troubleshooting panel must start collapsed"
            summary=panel.locator("summary")
            summary.click()
            assert panel.evaluate("(el) => el.open"),"Click must expand troubleshooting"
            summary.focus()
            page.keyboard.press("Enter")
            assert not panel.evaluate("(el) => el.open"),"Keyboard must collapse troubleshooting"
            page.keyboard.press("Enter")
            assert panel.evaluate("(el) => el.open"),"Keyboard must expand troubleshooting"
            safe=page.locator("[data-health-safe-code]").inner_text()
            assert "HEALTH_DEPLOYMENT_FAILED" in safe,"Fixed deployment error code"
            assert "PRIVATE_CLIENT_FIXTURE" not in safe,"Customer fixture not in safe code"
            copy=page.locator("[data-health-safe-copy-code]")
            assert copy.is_enabled(),"Copy action must be available for failed check"
            page.evaluate("""() => {
                window.__qaCopied='';
                Object.defineProperty(navigator,'clipboard',{configurable:true,
                    value:{writeText:async (text)=>{window.__qaCopied=text}}});
            }""")
            copy.click()
            page.wait_for_function("() => window.__qaCopied === 'HEALTH_DEPLOYMENT_FAILED'",timeout=5000)
            assert "copied" in page.locator("[data-health-safe-copy-status]").inner_text().lower(),"Accessible success notice"
            # Force the fallback path to exercise WebKit/iPhone clipboard restrictions.
            page.evaluate("""() => {
                window.__qaFallback='';
                Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});
                document.execCommand=(command)=>{
                    window.__qaFallback=command==='copy'?document.activeElement?.value:'';
                    return command==='copy';
                };
            }""")
            copy.click()
            page.wait_for_function("() => window.__qaFallback === 'HEALTH_DEPLOYMENT_FAILED'",timeout=5000)
            page.locator("[data-health-detail-close]").click()
            assert not dialog.evaluate("(el) => el.open"),"Dialog must close"
            selector.select_option("warning")
            assert page.locator("[data-results] button").count()==1,"Warning filter count"
            selector.select_option("healthy")
            assert page.locator("[data-results] button").count()==1,"Healthy filter count"
            selector.select_option("info")
            assert page.locator("[data-results] button").count()==0,"Info filter empty state"
            selector.select_option("")
            assert page.locator("[data-results] button").count()==3,"Clear severity filter"
            assert not page.locator("[data-health-safe-code]").inner_text().find("PRIVATE_CLIENT_FIXTURE")>=0
            print(f"PASS | synthetic System Health controls | {browser_name} {width}x{height} | filter, accordion, keyboard, clipboard, fallback, no copied customer data")
        finally:
            page.close()
            context.close()
            browser.close()

if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--browser",choices=["chromium","webkit"],required=True)
    parser.add_argument("--base-url",default="http://127.0.0.1:4173")
    parser.add_argument("--width",type=int,default=390)
    parser.add_argument("--height",type=int,default=844)
    args=parser.parse_args()
    run(args.browser,args.base_url.rstrip("/"),args.width,args.height)
