#!/usr/bin/env python3
"""Synthetic CRM modal visual QA: no authenticated production traffic or PII."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

CUSTOMERS = [
    {"id": "CUST-111111111111111111111111", "name": "Synthetic Client",
     "email": "synthetic@example.test", "phone": "8085550101", "projectCount": 3},
    {"id": "CUST-222222222222222222222222", "name": "Another Client",
     "email": "another@example.test", "phone": "", "projectCount": 1},
]
PROJECTS = [
    {"id": "INQ-SYNTH-1", "kind": "inquiry", "customer": {"name": "Synthetic Client",
     "email": "synthetic@example.test", "eventDate": "2027-04-01"}},
    {"id": "INQ-SYNTH-2", "kind": "inquiry", "customer": {"name": "Synthetic Client",
     "email": "synthetic@example.test", "eventDate": "2028-05-01"}},
    {"id": "INQ-SYNTH-3", "kind": "lead", "customer": {"name": "Synthetic Client",
     "email": "synthetic@example.test", "eventDate": ""}},
    {"id": "INQ-SYNTH-4", "kind": "inquiry", "customer": {"name": "Another Client",
     "email": "another@example.test", "eventDate": ""}},
]

def audit(browser, browser_name, base, results_dir):
    instances = []
    for width, height in ((390, 844), (1440, 900)):
        for theme in ("light", "dark"):
            context = browser.new_context(viewport={"width":width, "height":height},
                                          service_workers="block", reduced_motion="reduce")
            context.add_init_script("localStorage.setItem('koa-theme-preference', " + json.dumps(theme) + ");")
            def route(request):
                url = urlsplit(request.request.url)
                origin = urlsplit(base)
                if (url.scheme, url.netloc) != (origin.scheme, origin.netloc):
                    request.abort()
                elif url.path == "/api/admin/session":
                    request.fulfill(content_type="application/json",body=json.dumps({
                        "isAdmin":True, "capabilities":["crm.view","crm.manage"]}))
                elif url.path.startswith("/api/") or url.path.startswith("/.netlify/"):
                    request.fulfill(status=403,content_type="application/json",body="{}")
                else:
                    request.continue_()
            context.route("**/*",route)
            page=context.new_page()
            result={"browser":browser_name,"width":width,"height":height,"theme":theme,"passed":False}
            instances.append(result)
            try:
                response=page.goto(base+"/admin/crm/",wait_until="domcontentloaded",timeout=20000)
                assert response is not None and response.status==200, "CRM route not served"
                page.wait_for_selector("[data-crm-record-dialog] form",timeout=15000)
                page.wait_for_timeout(700)
                page.evaluate("""([projects,customers])=>{
                  document.querySelector('[data-admin-ui]')?.classList.remove('hidden');
                  window.dispatchEvent(new CustomEvent('koa:crm-editor-context',{detail:{
                    projects,customers,canManage:true,selectedId:''}}));
                }""",[PROJECTS,CUSTOMERS])
                opener=page.locator('[data-crm-record-action="create-project"]')
                assert opener.is_visible(), "New project entry not visible"
                opener.click()
                modal=page.locator('[data-crm-record-dialog]')
                assert modal.is_visible(), "Project editor failed to open"
                options=page.locator('[name=existingCustomer] option')
                assert options.count()==3, f"Expected 1 placeholder + 2 customers, got {options.count()}"
                option_labels=options.all_text_contents()
                assert sum("Synthetic Client" in value for value in option_labels)==1
                assert all("2027-" not in value and "2028-" not in value for value in option_labels), "Project dates leaked into customer selector"
                assert "3 projects" in option_labels[1] or "3 projects" in option_labels[2]
                page.locator('[name=existingCustomer]').select_option(CUSTOMERS[0]['id'])
                assert page.locator('input[name=name]').input_value()=='Synthetic Client'
                assert page.locator('input[name=email]').input_value()=='synthetic@example.test'
                assert page.locator('input[name=eventDate]').input_value()==''
                search=page.locator('[data-crm-record-customer-search]')
                search.fill('another')
                assert options.count()==3 or options.count()==2, "Unexpected customer search result"
                values=page.locator('[name=existingCustomer] option').all_text_contents()
                assert sum("Another Client" in value for value in values)==1
                assert sum("Synthetic Client" in value for value in values)<=1, "Existing selection was duplicated"
                metrics=modal.evaluate("""el=>{const r=el.getBoundingClientRect();
                  return {width:r.width,left:r.left,right:r.right,viewport:innerWidth,
                    bg:getComputedStyle(el).backgroundColor,
                    overflow:el.scrollWidth>el.clientWidth+3};}""")
                assert metrics['left']>=-2 and metrics['right']<=metrics['viewport']+2, "Modal overflows viewport"
                assert not metrics['overflow'], "Modal has horizontal overflow"
                result['modalWidth']=round(metrics['width'])
                # Synthetic only, so screenshot artifacts can never contain customer PII.
                image_name=f"crm-modal-{browser_name}-{width}-{theme}.png"
                modal.screenshot(path=str(results_dir/image_name))
                result['screenshot']=image_name
                result['passed']=True
            finally:
                context.close()
    return instances

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--base-url',default='http://127.0.0.1:4173')
    args=parser.parse_args()
    base=args.base_url.rstrip('/')
    target=Path('visual-results/crm-editor')
    target.mkdir(parents=True,exist_ok=True)
    cases=[]
    try:
        with sync_playwright() as playwright:
            for browser_name in ('chromium','webkit'):
                browser=getattr(playwright,browser_name).launch()
                try:cases.extend(audit(browser,browser_name,base,target))
                finally:browser.close()
    finally:
        (target/'qa-summary.json').write_text(json.dumps({"cases":cases,"passed":all(c['passed'] for c in cases),"synthetic":True},indent=2)+'\n')
    assert len(cases)==8 and all(c['passed'] for c in cases)
    print('CRM editor visual QA passed: 8 synthetic Chromium/WebKit, desktop/iPhone, Light/Dark combinations.')

if __name__ == '__main__':
    main()
