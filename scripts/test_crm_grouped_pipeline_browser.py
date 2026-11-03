#!/usr/bin/env python3
"""Synthetic CRM grouping and named-record-audit visual QA; no real customer data."""
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

CLIENT_A = "CUST-SYNTHETIC-1"
CLIENT_B = "CUST-SYNTHETIC-2"
def project(id, customer_id, email, title, stage, event_date):
    return {"id":id,"customerId":customer_id,"projectName":title,
        "kind":"inquiry" if stage!="proposal" else "proposal","stage":stage,
        "businessLine":"events","packageId":"hibiscus","createdAt":"2026-10-01T00:00:00Z",
        "customer":{"name":"Synthetic Client","email":email,"eventDate":event_date},
        "inquiry":{"eventType":"wedding"},"cleanup":{"disposition":"clean"}}
PROJECTS=[
    project("INQ-SYN-1",CLIENT_A,"first@example.test","Wedding", "inquiry","2027-03-01"),
    project("INQ-SYN-2",CLIENT_A,"first@example.test","Reunion", "proposal","2028-04-02"),
    project("INQ-SYN-3",CLIENT_A,"first@example.test","Converted history", "converted","2027-03-01"),
    project("INQ-SYN-4",CLIENT_B,"second@example.test","Separate identity", "inquiry","2027-03-01"),
]
CUSTOMERS=[
    {"id":CLIENT_A,"name":"Synthetic Client","email":"first@example.test","projectCount":3,
     "verified":True,"needsReview":False,"primaryRecordId":"INQ-SYN-1",
     "recordIds":["INQ-SYN-1","INQ-SYN-2","INQ-SYN-3"],"projects":[],"leadIds":[]},
    {"id":CLIENT_B,"name":"Synthetic Client","email":"second@example.test","projectCount":1,
     "verified":True,"needsReview":False,"primaryRecordId":"INQ-SYN-4",
     "recordIds":["INQ-SYN-4"],"projects":[],"leadIds":[]},
]
CRM={"access":{"role":"admin","capabilities":["crm.view","crm.manage","crm.destructive"]},
    "projects":PROJECTS,"customers":CUSTOMERS,
    "customerIdentityAudit":{"totals":{"uniqueCustomers":2,"projects":4,"reviewGroups":0},"reviewGroups":[]},
    "tasks":[],"appointments":[],"notes":[],"workflows":[],"enrollments":[],"templates":[],
    "activity":[],"messages":[],"trash":[],"trashGroups":[],"cleanupAudit":[],"cleanupAnalytics":{},
    "cleanupSettings":{"mode":"flag_only"},"duplicateBookingAudit":{"groups":[]},"integrations":{"signwell":{}}}
AUDIT={"name":"Synthetic Client","readOnly":True,
    "totals":{"active":4,"archived":0,"trash":0,"returned":4,"truncated":False},
    "auditScope":{"activeIndex":True,"archiveReadTruncated":False,"trashReadTruncated":False},
    "records":[{"id":"INQ-SYN-1","name":"Synthetic Client","classification":"possible_redundant_opportunity",
        "eventDate":"2027-03-01","businessLine":"events","stage":"inquiry","source":"koa-event-inquiry",
        "createdAt":"2026-10-01T00:00:00Z","location":"active","linkedLifecycleIds":[],
        "potentialDuplicateIds":["INQ-SYN-3"],"protectedLinks":{},"recommendation":"Review before merging."}]}

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--base-url",default="http://127.0.0.1:4173")
    args=parser.parse_args()
    base=args.base_url.rstrip("/")
    results_dir=Path("visual-results/crm-grouping")
    results_dir.mkdir(parents=True,exist_ok=True)
    cases=[]
    try:
        with sync_playwright() as pw:
            for browser_name in ("chromium","webkit"):
                browser=getattr(pw,browser_name).launch()
                try:
                    for width,height in ((390,844),(1440,900)):
                        for theme in ("light","dark"):
                            context=browser.new_context(viewport={"width":width,"height":height},
                                service_workers="block",reduced_motion="reduce")
                            context.add_init_script("localStorage.setItem('koa-theme-preference',"+json.dumps(theme)+");")
                            def route(router):
                                url=urlsplit(router.request.url)
                                origin=urlsplit(base)
                                if (url.scheme,url.netloc)!=(origin.scheme,origin.netloc):
                                    router.abort()
                                elif url.path=="/api/admin/session":
                                    router.fulfill(content_type="application/json",
                                        body=json.dumps({"isAdmin":True,"capabilities":["crm.view","crm.manage","crm.destructive"]}))
                                elif url.path=="/api/admin/crm":
                                    router.fulfill(content_type="application/json",body=json.dumps(AUDIT if url.query else CRM))
                                elif url.path=="/api/staff/directory":
                                    router.fulfill(content_type="application/json",body='{"staff":[]}')
                                elif url.path.startswith("/api/") or url.path.startswith("/.netlify/"):
                                    router.fulfill(status=403,content_type="application/json",body="{}")
                                else:
                                    router.continue_()
                            context.route("**/*",route)
                            page=context.new_page()
                            errors=[]
                            page.on("pageerror",lambda error: errors.append(str(error)))
                            case={"browser":browser_name,"viewport":str(width)+"x"+str(height),
                                "theme":theme,"passed":False}
                            cases.append(case)
                            try:
                                response=page.goto(base+"/admin/crm/",wait_until="domcontentloaded",timeout=25000)
                                assert response is not None and response.status==200
                                page.wait_for_function("""() => {
                                    const el=document.querySelector('[data-project-count]');
                                    return el && el.textContent.includes('2 clients');
                                }""",timeout=20000)
                                assert page.locator("[data-pipeline-customer]").count()==2, "Matching names with separate identities merged"
                                assert "3 records" in page.locator("[data-project-count]").text_content(), "Converted history leaked into active"
                                first=page.locator("[data-pipeline-customer]").first
                                first.locator("summary").click()
                                assert first.locator("[data-project]").count()>=1
                                assert page.locator("[data-project] a[data-client-workspace]").filter(has_text="Synthetic Client").count()==0
                                page.locator("[data-stage-filter]").select_option("converted")
                                assert "1 records" in page.locator("[data-project-count]").text_content()
                                page.locator("[data-stage-filter]").select_option("all")
                                page.locator("[data-client-name-audit-input]").fill("Synthetic Client")
                                page.get_by_role("button",name="Run read-only audit").click()
                                page.wait_for_function("""() => document.querySelector('[data-client-name-audit-results]')?.textContent.includes('INQ-SYN-1')""",timeout=10000)
                                assert "No records changed" in page.locator("[data-client-name-audit-status]").text_content()
                                overflow=page.evaluate("document.documentElement.scrollWidth > innerWidth + 4")
                                assert not overflow, "CRM overflows viewport"
                                assert not errors, "JavaScript errors: "+str(errors)
                                filename=f"pipeline-{browser_name}-{width}-{theme}.png"
                                page.locator("[data-project-list]").screenshot(path=str(results_dir/filename))
                                case["screenshot"]=filename
                                case["passed"]=True
                            finally:
                                context.close()
                finally:
                    browser.close()
    finally:
        (results_dir/"qa-summary.json").write_text(json.dumps({"cases":cases,
            "passed":len(cases)==8 and all(x["passed"] for x in cases),"synthetic":True},indent=2)+"\n")
    assert len(cases)==8 and all(x["passed"] for x in cases)
    print("CRM grouped pipeline: 8 Chromium/WebKit, iPhone/desktop, Light/Dark synthetic cases passed.")

if __name__=="__main__":
    main()
