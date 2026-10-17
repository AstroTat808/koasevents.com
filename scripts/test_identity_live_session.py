#!/usr/bin/env python3
"""Provider-backed Netlify Identity browser checks; never print credentials, cookies or PII.

Run ONLY on a deployment matching an independently verified exact PR SHA.
Requires a dedicated, disposable Identity QA account scoped to synthetic data.
A Playwright WebKit iPhone viewport is NOT a physical iPhone Safari certification.
"""
from __future__ import annotations
import argparse
import os
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

def fail(code):
    print("FAIL | identity-live-session | " + code, flush=True)
    raise SystemExit(1)

def require(condition, code):
    if not condition:
        fail(code)

def cookies(context):
    return {row["name"]: row for row in context.cookies()}

def api(page, method="GET", path="/api/admin/session", payload=None):
    # Only numeric status and a bounded machine code return to test process.
    return page.evaluate("""async (args) => {
      const opt={method:args.method,cache:'no-store',credentials:'same-origin'};
      if(args.payload!==null){opt.headers={'Content-Type':'application/json'};opt.body=JSON.stringify(args.payload);}
      const r=await fetch(args.path,opt);
      const data=await r.json().catch(()=>({}));
      return {status:r.status,code:String(data.code||'').slice(0,48),
        accessBlocked:Boolean(data.accessBlocked),hasPermissions:Array.isArray(data.capabilities)&&data.capabilities.length>0};
    }""", {"method":method,"path":path,"payload":payload})

def wait_authenticated(page, deadline_seconds=25):
    end=time.monotonic()+deadline_seconds
    while time.monotonic()<end:
        try:
            result=api(page)
            if result["status"]==200 and not result["accessBlocked"] and result["hasPermissions"]:
                return
        except Exception:
            pass
        time.sleep(0.5)
    fail("identity_login_or_bound_session_unavailable")

def sign_in(page, email, password, remember, base):
    page.goto(base + "/admin/", wait_until="domcontentloaded", timeout=45000)
    form=page.locator("[data-login-form]")
    form.wait_for(state="visible",timeout=25000)
    form.locator('input[name="email"]').fill(email)
    form.locator('input[name="password"]').fill(password)
    if remember:
        form.locator('input[name="remember"]').check()
    form.locator('button[type="submit"],button:not([type])').first.click()
    wait_authenticated(page)

def get_session_handles(page):
    data=page.evaluate("""async () => {
      const r=await fetch('/api/account/security',{cache:'no-store'});
      if(!r.ok) return {status:r.status,sessions:[]};
      const x=await r.json();
      return {status:r.status,sessions:(x.sessionHealth?.sessions||[]).map(s=>({
        current:Boolean(s.current),handle:String(s.handle||'')
      }))};
    }""")
    require(data["status"]==200,"session_health_endpoint_unavailable")
    return data["sessions"]

def context_for(browser, name, base, restore=None):
    opts={"viewport":{"width":390,"height":844} if name=="webkit" else {"width":1440,"height":900},
          "device_scale_factor":2 if name=="webkit" else 1,
          "is_mobile":name=="webkit","has_touch":name=="webkit"}
    if restore is not None:
        opts["storage_state"]=restore
    ctx=browser.new_context(**opts)
    return ctx

def test_browser(playwright,name,base,email,password):
    browser=getattr(playwright,name).launch()
    contexts=[]
    def new(restore=None):
        ctx=context_for(browser,name,base,restore)
        contexts.append(ctx)
        return ctx
    try:
        primary=new()
        page=primary.new_page()
        response=page.goto(base+"/admin/",wait_until="domcontentloaded",timeout=45000)
        require(response is not None and response.status<400,"login_document_unavailable")
        require(api(page)["status"]==401,"unauthenticated_request_was_accepted")
        print("PASS | "+name+" | unauthenticated_rejected",flush=True)

        # Clock starts before hydration so the Identity auto-refresh timer can be advanced.
        page.clock.install(time=datetime.now(timezone.utc))
        sign_in(page,email,password,True,base)
        before=cookies(primary)
        for key in ("nf_jwt","nf_refresh","__Host-koa_admin_session"):
            require(key in before,"required_auth_cookie_missing")
        bound=before["__Host-koa_admin_session"]
        require(bool(bound.get("httpOnly")) and bool(bound.get("secure")) and bound.get("path")=="/",
                "bound_cookie_flags_invalid")
        require(float(bound.get("expires",0))>time.time()+28*86400,
                "remembered_bound_cookie_not_persistent")
        refresh=before["nf_refresh"]
        require(float(refresh.get("expires",0))>time.time()+28*86400,
                "identity_refresh_cookie_not_30day_persistent")
        print("PASS | "+name+" | persistent_cookie_attributes",flush=True)

        # Restore cookie jar into a new browser context. This simulates relaunch,
        # NOT a physical Safari process restart, which needs separate device QA.
        saved=primary.storage_state()
        reopened=new(saved)
        reopened_page=reopened.new_page()
        reopened_page.goto(base+"/admin/",wait_until="domcontentloaded",timeout=45000)
        wait_authenticated(reopened_page)
        print("PASS | "+name+" | restored_browser_state",flush=True)

        # Browser-side Identity refresh is scheduled before access-token expiry.
        # Advance only the browser clock; never forge or expose a JWT/refresh token.
        old_refresh=before["nf_refresh"]["value"]
        page.clock.fast_forward(61*60*1000)
        new_cookies=None
        until=time.monotonic()+30
        while time.monotonic()<until:
            current=cookies(primary)
            if current.get("nf_refresh",{}).get("value") not in ("",old_refresh):
                new_cookies=current
                break
            time.sleep(0.5)
        require(new_cookies is not None,"identity_refresh_not_rotated")
        require(new_cookies.get("nf_jwt",{}).get("value")!=before["nf_jwt"]["value"],
                "identity_access_token_not_rotated")
        print("PASS | "+name+" | provider_refresh_rotated",flush=True)

        # A separate real login creates a different server-bound session.
        remote=new()
        remote_page=remote.new_page()
        sign_in(remote_page,email,password,True,base)
        remote_handles=get_session_handles(remote_page)
        own=[x["handle"] for x in remote_handles if x["current"]]
        require(len(own)==1 and own[0],"remote_handle_missing")
        target=own[0]
        require(cookies(remote).get("__Host-koa_admin_session",{}).get("value")!=bound["value"],
                "separate_logins_reused_identical_binding")
        remote_saved=remote.storage_state()

        result=api(page,"POST","/api/account/security",{"action":"revoke-session","handle":target})
        require(result["status"]==200,"remote_session_revoke_failed")
        require(api(remote_page)["status"]==401,"remote_revocation_not_immediate")
        remote.clear_cookies(name="koa_sid")
        require(api(remote_page)["status"]==401,"deleting_koa_sid_bypassed_revocation")
        replay=new(remote_saved)
        replay_page=replay.new_page()
        replay_page.goto(base+"/admin/",wait_until="domcontentloaded",timeout=45000)
        require(api(replay_page)["status"]==401,"revoked_cookie_replay_accepted")
        print("PASS | "+name+" | immediate_revoke_koa_sid_deletion_replay",flush=True)

        # Signing out ends app authorization even if old provider cookies are restored.
        current_state=primary.storage_state()
        outcome=api(page,"POST","/api/auth/bound-logout",{})
        require(outcome["status"]==200,"server_logout_failed")
        require(api(page)["status"]==401,"logout_still_authorized")
        previous=new(current_state)
        old_page=previous.new_page()
        old_page.goto(base+"/admin/",wait_until="domcontentloaded",timeout=45000)
        require(api(old_page)["status"]==401,"restored_logout_cookie_accepted")
        print("PASS | "+name+" | server_logout_and_stolen_cookie_replay",flush=True)
    finally:
        # In-memory credentials/cookies and any browser sessions are destroyed.
        for ctx in contexts:
            try:ctx.close()
            except Exception:pass
        browser.close()

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--base-url",required=True)
    parser.add_argument("--expected-sha",required=True)
    args=parser.parse_args()
    u=urlparse(args.base_url)
    require(u.scheme=="https" and u.hostname and u.hostname.endswith(".netlify.app"),
            "preview_https_required")
    require(len(args.expected_sha)==40 and all(x in "0123456789abcdef" for x in args.expected_sha.lower()),
            "exact_sha_required")
    email=os.getenv("KOA_AUTH_QA_EMAIL","")
    password=os.getenv("KOA_AUTH_QA_PASSWORD","")
    require(bool(email and password),"dedicated_qa_credentials_not_configured")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        fail("playwright_dependency_missing")
    try:
        with sync_playwright() as pw:
            for browser in ("chromium","webkit"):
                try:test_browser(pw,browser,args.base_url,email,password)
                except SystemExit:raise
                except Exception:fail(browser+"_provider_integration_failure")
    finally:
        # Do not serialize any browser state, authenticated screenshots, or tokens.
        email=password=""
    print("PASS | provider-backed identity session tests | chromium + webkit",flush=True)

if __name__=="__main__":
    main()
