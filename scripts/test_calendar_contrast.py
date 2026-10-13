#!/usr/bin/env python3
"""Read-only Calendar contrast regression against a built loopback preview.

All API responses are synthetic and all off-origin traffic is blocked. Nothing
is submitted to production, and no screenshot, text content or API body is saved.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

SESSION = {
    "email": "calendar-qa@example.test", "displayName": "Calendar QA",
    "role": "admin", "roles": ["admin"], "isAdmin": True,
    "permissions": ["admin", "admin.dashboard.view", "calendar.view"],
    "capabilities": ["admin", "admin.dashboard.view", "calendar.view"],
    "accessBlocked": False,
    "app_metadata": {"roles": ["admin"], "permissions": ["admin"]},
    "appMetadata": {"roles": ["admin"], "permissions": ["admin"]},
}

MEASURE = r"""() => {
  const parse=(value)=>{
    const text=String(value||'').trim();
    let match=text.match(/^rgba?\(([^)]+)\)$/);
    if(match){
      const parts=match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      if(parts.length>=3&&parts.every(Number.isFinite))return [...parts.slice(0,3),parts[3]??1];
    }
    match=text.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/);
    if(match)return [+match[1]*255,+match[2]*255,+match[3]*255,match[4]===undefined?1:+match[4]];
    throw new Error('Unsupported computed color');
  };
  const over=(fg,bg)=>[0,1,2].map(i=>fg[i]*fg[3]+bg[i]*(1-fg[3]));
  const lum=(color)=>color.map(n=>{const v=n/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;})
    .reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
  const ratio=(fg,bg)=>{const a=lum(fg),b=lum(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
  const visible=(el)=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden';};
  const targets=[...document.querySelectorAll('.calendar-shell [data-month-title],.calendar-shell .calendar-date-number')].filter(visible);
  const results=targets.map(el=>{
    const ancestors=[];let current=el;
    while(current){ancestors.unshift(current);current=current.parentElement;}
    let bg=[255,255,255];
    for(const node of ancestors)bg=over(parse(getComputedStyle(node).backgroundColor),bg);
    const style=getComputedStyle(el),fg=over(parse(style.color),bg);
    const heading=el.hasAttribute('data-month-title');
    const size=parseFloat(style.fontSize),weight=parseInt(style.fontWeight,10)||400;
    const threshold=heading&&(size>=24||(size>=18.66&&weight>=700))?3:4.5;
    const day=el.closest('.calendar-day');
    return {heading,threshold,ratio:ratio(fg,bg),today:!!day?.classList.contains('is-today'),
      other:!!day?.classList.contains('is-other'),weekend:!!day?.classList.contains('is-weekend')};
  });
  return {resolved:document.documentElement.dataset.theme,
    titleCount:results.filter(r=>r.heading).length, dateCount:results.filter(r=>!r.heading).length,
    todayCount:results.filter(r=>r.today).length,otherCount:results.filter(r=>r.other).length,
    weekendCount:results.filter(r=>r.weekend).length, results};
}"""


def require_contrast(metrics: dict, theme: str, *, initial: bool) -> dict:
    assert metrics["resolved"] == theme, "Requested theme did not settle"
    assert metrics["titleCount"] == 1, "Calendar heading was not rendered"
    assert metrics["dateCount"] >= 28, "Calendar date grid was not rendered"
    assert metrics["otherCount"] > 0 and metrics["weekendCount"] > 0, "Calendar edge states missing"
    if initial:
        assert metrics["todayCount"] == 1, "Current date styling was not tested"
    if theme == "dark":
        assert all(row["ratio"] >= row["threshold"] for row in metrics["results"]), "Calendar text contrast below unchanged readability thresholds"
    return {
        "dateCount": metrics["dateCount"],
        "worstRatio": round(min(row["ratio"] for row in metrics["results"]), 3),
        "headingMinimum": next(row["threshold"] for row in metrics["results"] if row["heading"]),
        "dateMinimum": 4.5,
        "contrastEnforced": theme == "dark",
    }


def audit(playwright, browser_name: str, base: str) -> list:
    browser = getattr(playwright, browser_name).launch()
    results = []
    try:
        for width, height in ((390, 844), (1440, 900)):
            for theme in ("light", "dark"):
                context = browser.new_context(viewport={"width": width, "height": height},
                    reduced_motion="reduce", color_scheme="light", service_workers="block")
                context.add_init_script("localStorage.setItem('koa-theme-preference', " + json.dumps(theme) + ");")
                # Freeze the month/day without freezing timers or the browser event loop.
                context.add_init_script("""(() => {const RealDate=Date;const fixed=RealDate.parse('2026-10-13T22:00:00Z');
                  window.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}};})();""")
                def mock(route):
                    parsed = urlsplit(route.request.url)
                    if (parsed.scheme, parsed.netloc) != (urlsplit(base).scheme, urlsplit(base).netloc):
                        route.abort()
                    elif parsed.path.startswith("/api/") or parsed.path.startswith("/.netlify/"):
                        payload = SESSION if parsed.path == "/api/admin/session" else {}
                        route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))
                    else:
                        route.continue_()
                context.route("**/*", mock)
                page = context.new_page()
                case = {"browser": browser_name, "width": width, "height": height,
                    "theme": theme, "passed": False, "stage": "readiness"}
                results.append(case)
                try:
                    response = page.goto(base + "/admin/calendar/", wait_until="domcontentloaded", timeout=20000)
                    assert response and response.status == 200, "Built Calendar route was not served"
                    page.wait_for_function("""() => {
                      const app=document.querySelector('[data-app]');
                      const title=document.querySelector('[data-month-title]');
                      return app&&!app.classList.contains('hidden')&&title?.textContent?.trim()
                        &&document.querySelectorAll('.calendar-shell .calendar-date-number').length>=28;
                    }""", timeout=10000)
                    case["stage"] = "initial-contrast"
                    case["initialMetrics"] = page.evaluate(MEASURE)
                    initial = require_contrast(case["initialMetrics"], theme, initial=True)
                    # A later render must inherit the same semantic text colors.
                    previous_title = page.locator("[data-month-title]").inner_text()
                    page.locator("[data-next]").click(timeout=5000)
                    page.wait_for_function("(previous)=>{const title=document.querySelector('[data-month-title]')?.textContent?.trim();return Boolean(title&&title!==previous&&document.querySelectorAll('.calendar-shell .calendar-date-number').length>=28);}",
                        arg=previous_title.strip(), timeout=5000)
                    case["stage"] = "rerender-contrast"
                    case["rerenderMetrics"] = page.evaluate(MEASURE)
                    rerender = require_contrast(case["rerenderMetrics"], theme, initial=False)
                    negative_control = True
                    if theme == "dark":
                        case["stage"] = "negative-control"
                        # Prove the exact legacy ink regression cannot be masked by this test.
                        victim = page.locator(".calendar-day:not(.is-today):not(.is-other) .calendar-date-number").first
                        victim.evaluate("el=>el.style.setProperty('color','rgb(10, 33, 26)','important')")
                        negative_control = any(row["ratio"] < row["threshold"] for row in page.evaluate(MEASURE)["results"])
                        assert negative_control, "Contrast regression detector accepted the original low-contrast color"
                        victim.evaluate("el=>el.style.removeProperty('color')")
                        require_contrast(page.evaluate(MEASURE), theme, initial=False)
                    case.update(passed=True, stage="complete", initial=initial, rerender=rerender,
                        negativeControlPassed=negative_control)
                    print(f"PASS | Calendar contrast | {browser_name} {width}x{height} {theme}", flush=True)
                except Exception as exc:
                    case["errorType"] = type(exc).__name__
                    print(f"FAIL | Calendar contrast | {browser_name} {width}x{height} {theme} | {case['stage']}", flush=True)
                finally:
                    page.close()
                    context.close()
    finally:
        browser.close()
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--out", default="visual-results/calendar-contrast.json")
    args = parser.parse_args()
    base = args.base_url.rstrip("/")
    parsed = urlsplit(base)
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}
            or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment):
        raise ValueError("Calendar regression only accepts an unauthenticated loopback origin")
    results = []
    errors = []
    with sync_playwright() as playwright:
        for name in ("chromium", "webkit"):
            try:
                results.extend(audit(playwright, name, base))
            except Exception as exc:
                # Never print exception payloads, page text, API bodies or browser screenshots.
                errors.append({"browser": name, "errorType": type(exc).__name__})
    passed = not errors and len(results) == 8 and all(case["passed"] for case in results)
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"synthetic": True, "expectedCases": 8, "cases": results,
        "passed": passed, "browserErrors": errors}, indent=2) + "\n")
    if not passed:
        print("FAIL | Calendar contrast regression; see synthetic numeric evidence")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
