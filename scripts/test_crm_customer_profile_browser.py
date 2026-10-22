#!/usr/bin/env python3
"""Synthetic customer-profile Chromium/WebKit visual QA without live CRM access."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

CUSTOMER_ID = 'CUST-111111111111111111111111'
PROFILE = {
    "ok": True,
    "customer": {"id": CUSTOMER_ID, "name": "Synthetic Client", "email": "synthetic@example.test",
        "phone": "8085550101", "projectCount": 2, "needsReview": False, "recordIds": ["INQ-SYNTH-1","INQ-SYNTH-2"], "leadIds":[]},
    "counts": {"booked":1, "quickBooksInvoices":1, "quickBooksPayments":1, "bookingPayments":1},
    "projects": [
        {"id":"INQ-SYNTH-1","name":"Synthetic Wedding", "eventDate":"2027-06-01",
         "businessLine":"events","stage":"booked","kind":"inquiry","noteCount":1,"openTaskCount":0,
         "booking":{"status":"booked","contractStatus":"signed","signWellStatus":"completed",
            "payments":[{"id":"P1","label":"Deposit","amount":500,"dueDate":"2027-01-01","status":"paid"}]},
         "accounting":{"customerLinked":True,"source":"QuickBooks",
            "invoices":[{"id":"I1","docNumber":"1001","amount":3000,"balance":2500,"status":"open","date":"2027-02-02"}],
            "payments":[{"id":"QP1","label":"Paid","amount":500,"date":"2027-02-10","status":"completed"}]}},
        {"id":"INQ-SYNTH-2","name":"Synthetic Reunion","eventDate":"2028-02-01",
         "businessLine":"events","stage":"proposal","kind":"inquiry","noteCount":0,"openTaskCount":2,
         "booking":{"status":"pending","contractStatus":"","signWellStatus":"","payments":[]},
         "accounting":{"customerLinked":False,"source":"QuickBooks","invoices":[],"payments":[]}},
    ],
}

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--base-url",default="http://127.0.0.1:4173")
    args=parser.parse_args()
    base=args.base_url.rstrip("/")
    output=Path("visual-results/crm-profile");output.mkdir(parents=True,exist_ok=True)
    cases=[]
    try:
        with sync_playwright() as pw:
            for browser_name in ("chromium","webkit"):
                browser=getattr(pw,browser_name).launch()
                try:
                    for width,height in ((390,844),(1440,900)):
                        for theme in ("light","dark"):
                            context=browser.new_context(viewport={"width":width,"height":height},service_workers="block",
                                reduced_motion="reduce")
                            context.add_init_script("localStorage.setItem('koa-theme-preference',"+json.dumps(theme)+");")
                            def route(request):
                                url=urlsplit(request.request.url);origin=urlsplit(base)
                                if (url.scheme,url.netloc)!=(origin.scheme,origin.netloc):
                                    request.abort()
                                elif url.path=="/api/admin/crm-customers":
                                    request.fulfill(status=200,content_type="application/json",body=json.dumps(PROFILE))
                                elif url.path.startswith("/api/") or url.path.startswith("/.netlify/"):
                                    request.fulfill(status=403,content_type="application/json",body="{}")
                                else:
                                    request.continue_()
                            context.route("**/*",route)
                            page=context.new_page()
                            case={"browser":browser_name,"width":width,"height":height,"theme":theme,"passed":False}
                            cases.append(case)
                            try:
                                response=page.goto(base+"/admin/clients/profile/?customerId="+CUSTOMER_ID,
                                    wait_until="domcontentloaded",timeout=20000)
                                assert response is not None and response.status==200
                                page.wait_for_function("""() => {
                                  const section=document.querySelector('[data-profile]');
                                  return section&&!section.classList.contains('hidden') &&
                                    document.querySelectorAll('[data-projects] article').length===2;
                                }""",timeout=15000)
                                assert page.locator("[data-name]").text_content()=="Synthetic Client"
                                assert page.locator("[data-projects] article").count()==2
                                assert page.locator("[data-stat-bookings]").text_content()=="1"
                                assert page.locator("[data-stat-invoices]").text_content()=="1"
                                assert page.locator("[data-stat-payments]").text_content()=="1"
                                assert page.get_by_text("QuickBooks payments").count()==2
                                assert page.get_by_text("$2,500.00 balance").count()==1
                                assert page.get_by_role("link",name="Open project workspace").count()==2
                                assert page.locator("[data-projects] article").first.is_visible()
                                overflow=page.evaluate("""() => ({
                                  page: document.documentElement.scrollWidth > innerWidth+3,
                                  cards:[...document.querySelectorAll('[data-projects] article')].some(x=>{
                                    const r=x.getBoundingClientRect();return r.left<-2||r.right>innerWidth+2;}),
                                })""")
                                assert not overflow["page"] and not overflow["cards"], "Page or cards overflow mobile viewport"
                                image_name=f"profile-{browser_name}-{width}-{theme}.png"
                                page.locator("[data-profile]").screenshot(path=str(output/image_name))
                                case["screenshot"]=image_name
                                case["passed"]=True
                            finally:context.close()
                finally:browser.close()
    finally:
        (output/"qa-summary.json").write_text(json.dumps({"cases":cases,
            "passed":all(c["passed"] for c in cases),"synthetic":True},indent=2)+"\n")
    assert len(cases)==8 and all(c["passed"] for c in cases)
    print("Customer profile Chromium/WebKit Light/Dark desktop/iPhone QA passed: 8 synthetic combinations.")

if __name__=="__main__":
    main()
