#!/usr/bin/env python3
"""Exercise the deployed/built Health UI using synthetic API responses only.

No login secrets, live health responses, real threshold writes, or customer data.
Screenshots are captured only after both mocked session and health routes fired.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect
from test_health_safe_controls_browser import fixture
from production_visual_qa import actionable_page_errors

ROOT = Path(__file__).resolve().parents[1]
PROVIDERS = [('resend', 'Resend'), ('quickbooks', 'QuickBooks'), ('microsoft-graph', 'Microsoft Graph'),
             ('github', 'GitHub'), ('netlify', 'Netlify'), ('signwell', 'SignWell'),
             ('turnstile', 'Cloudflare Turnstile')]
VIEWPORTS = [(320, 740), (390, 844), (768, 1024), (1440, 900), (1920, 1080)]
CARD = '[data-credential-provider]'
DETAIL = '[data-credential-provider-details]'
TOGGLE = '[data-credential-provider-toggle]'


def make_dashboard():
    session, dashboard = fixture()
    rows = []
    for key, label in PROVIDERS:
        warning = key == 'resend'
        rows.append({'id': key, 'label': label, 'severity': 'yellow' if warning else 'green',
                     'credentialCount': 2 if warning else 1, 'thresholdActive': True,
                     'minimumSamples': 24, 'firstVerifiedAt': '2026-09-27T12:00:00.000Z',
                     'thresholds': {'yellowBelow': 99, 'redBelow': 95},
                     'periods': {period: {'percentage': 98.8 if warning and period == '7d' else 100,
                                          'samples': 167 if period == '7d' else 574,
                                          'expectedSamples': hours}
                                 for period, hours in [('7d', 168), ('30d', 720), ('90d', 2160)]},
                     'recovery': {'healthySamplesToHealthy': 34 if warning else 0,
                                  'estimatedHealthyAt': '2026-10-22T21:07:36.000Z'}})
    dashboard['credentialHealth'] = {
        'overall': 'green', 'checkedAt': '2026-10-21T11:00:00.000Z', 'checks': [],
        'reliability': {'overall': 'yellow', 'note': 'Synthetic visual QA. Reliability uses observed hourly samples after the first successful verification. Warning below 99%; critical below 95%.', 'providers': rows}}
    return session, dashboard


def geometry(page):
    result = page.locator('[data-credential-layout]').evaluate('''panel => {
      const problems=[];
      const visible=el=>Boolean(el.getClientRects().length);
      for(const el of panel.querySelectorAll('[data-credential-periods] strong,input,button')) {
        if(!visible(el)) continue;
        const rect=el.getBoundingClientRect(), parent=el.parentElement.getBoundingClientRect();
        if(rect.left<parent.left-1||rect.right>parent.right+1) problems.push('element-outside-parent');
        if(el.matches('input,button')&&rect.height<43.5) problems.push('small-touch-target');
        if(el.matches('strong')) {
          const range=document.createRange(); range.selectNodeContents(el);
          const text=range.getBoundingClientRect();
          if(text.left<parent.left-1||text.right>parent.right+1||el.scrollWidth>el.clientWidth+1)
            problems.push('clipped-percentage');
        }
      }
      const box=panel.getBoundingClientRect();
      if(box.left< -1||box.right>document.documentElement.clientWidth+1) problems.push('panel-outside-viewport');
      const list=panel.querySelector('[data-credential-provider-group="healthy"] [data-credential-provider-grid]');
      return {problems, panelWidth:Math.round(box.width),
        healthyColumns:list?getComputedStyle(list).gridTemplateColumns.split(' ').length:0,
        visiblePercentages:[...panel.querySelectorAll('[data-credential-periods] strong')].filter(visible).length};
    }''')
    assert not result['problems'], 'Credential layout geometry: ' + ','.join(result['problems'])
    return result


def run_case(browser, browser_name, base_url, width, height, theme, out):
    session, dashboard = make_dashboard()
    state = {'session': 0, 'health': 0, 'saves': [], 'variant': 'default'}
    context = browser.new_context(viewport={'width': width, 'height': height},
                                  device_scale_factor=1, is_mobile=width < 768,
                                  has_touch=width < 768, reduced_motion='reduce',
                                  color_scheme='light' if theme == 'dark' else 'dark',
                                  service_workers='block')
    context.add_init_script("localStorage.setItem('koa-theme-preference', " + json.dumps(theme) + ");")
    # Every protected endpoint is intercepted before navigating, even on production.
    context.route('**/api/**', lambda r: r.fulfill(status=200, content_type='application/json', body='{}'))
    context.route('**/.netlify/functions/**', lambda r: r.fulfill(status=200, content_type='application/json', body='{}'))
    context.route('**/.netlify/identity/**', lambda r: r.fulfill(status=200, content_type='application/json', body='{}'))

    def session_route(route):
        state['session'] += 1
        route.fulfill(status=200, content_type='application/json', body=json.dumps(session))

    def health_route(route):
        state['health'] += 1
        if route.request.method == 'POST':
            payload = route.request.post_data_json
            assert payload.get('action') == 'save-credential-reliability-thresholds', 'Unexpected synthetic mutation'
            state['saves'].append(copy.deepcopy(payload))
            for row in dashboard['credentialHealth']['reliability']['providers']:
                if row['id'] in payload['providers']:
                    row['thresholds'] = copy.deepcopy(payload['providers'][row['id']])
            if state['variant'] == 'escalated':
                for row in dashboard['credentialHealth']['reliability']['providers']:
                    if row['id'] == 'github':
                        row['severity'] = 'red'
                        row['periods']['7d']['percentage'] = 94.2
                        row['recovery']['healthySamplesToExitCritical'] = 2
                    elif row['id'] == 'microsoft-graph':
                        row['severity'] = 'insufficient'
                        row['thresholdActive'] = False
                        row['periods']['7d']['percentage'] = None
                        row['recovery']['samplesUntilThresholdActive'] = 24
            elif state['variant'] == 'empty':
                dashboard['credentialHealth']['reliability']['providers'] = []
        route.fulfill(status=200, content_type='application/json', body=json.dumps(dashboard))

    context.route('**/api/admin/session**', session_route)
    context.route('**/api/admin/health**', health_route)
    page = context.new_page()
    page_errors = []
    page.on('pageerror', lambda error: page_errors.append(str(error)))
    try:
        response = page.goto(base_url + '/admin/health/', wait_until='domcontentloaded', timeout=45000)
        assert response and response.status == 200, 'Health HTML response'
        page.wait_for_selector('[data-app]:not(.hidden)', timeout=15000)
        page.wait_for_function("() => document.querySelectorAll('[data-credential-provider]').length===7", timeout=15000)
        assert state['session'] and state['health'], 'Synthetic session and health interception required before screenshots'
        parent = page.locator('[data-credential-reliability-grid]').locator('xpath=ancestor::*[@data-mobile-collapsible][1]')
        if parent.count() and parent.get_attribute('data-mobile-collapsed') == 'true':
            parent.locator('[data-mobile-collapse-toggle]').first.click()
        panel = page.locator('[data-credential-layout]')
        expect(panel).to_be_visible()
        page.wait_for_function('(theme) => document.documentElement.dataset.theme===theme', arg=theme, timeout=6000)
        page.evaluate('document.fonts.ready')
        expect(page.locator(CARD)).to_have_count(7)
        expect(page.locator(TOGGLE)).to_have_count(6)
        expect(page.locator(TOGGLE + '[aria-expanded="false"]')).to_have_count(6)
        assert page.locator(CARD).first.get_attribute('data-credential-provider') == 'resend', 'Warning first'
        expect(page.locator('[data-credential-provider="resend"] ' + DETAIL)).to_be_visible()
        first_geometry = geometry(page)
        assert first_geometry['visiblePercentages'] == 21, 'All three percentages stay visible on all seven cards'
        # Assert adaptive columns against the actual container, not an assumed viewport.
        content_width = panel.evaluate('el=>el.clientWidth-parseFloat(getComputedStyle(el).paddingLeft)-parseFloat(getComputedStyle(el).paddingRight)')
        root_font = panel.evaluate('()=>parseFloat(getComputedStyle(document.documentElement).fontSize)')
        expected_columns = 3 if content_width >= 66 * root_font else 2 if content_width >= 44 * root_font else 1
        assert first_geometry['healthyColumns'] == expected_columns, 'Container-aware healthy grid columns'
        screenshot = f'{browser_name}-{width}-{theme}-overview.png'
        panel.screenshot(path=str(out / screenshot), animations='disabled', timeout=15000)

        qb = page.locator('[data-credential-provider="quickbooks"]')
        button = qb.locator(TOGGLE)
        button.click()
        expect(button).to_have_attribute('aria-expanded', 'true')
        expect(qb.locator(DETAIL)).to_be_visible()
        assert button.get_attribute('aria-controls') == qb.locator(DETAIL).get_attribute('id'), 'Disclosure association'
        qb.locator('[data-credential-threshold-yellow]').fill('98.5')
        qb.locator('[data-credential-threshold-red]').fill('94')
        button.focus()
        page.keyboard.press('Space')
        expect(button).to_have_attribute('aria-expanded', 'false')
        expect(qb.locator(DETAIL)).to_be_hidden()
        assert qb.locator('[data-credential-threshold-yellow]').input_value() == '98.5', 'Collapse must retain edited input'
        save = page.locator('[data-save-credential-thresholds]')
        save.click()
        expect(page.locator('[data-credential-threshold-message]')).to_have_text('Thresholds saved.')
        assert len(state['saves']) == 1, 'One intercepted threshold save'
        payload = state['saves'][-1]['providers']
        assert set(payload) == {key for key, _ in PROVIDERS}, 'Hidden providers included in save'
        assert payload['quickbooks'] == {'yellowBelow': 98.5, 'redBelow': 94}, 'Edited thresholds saved unchanged'
        assert all(value == {'yellowBelow': 99, 'redBelow': 95} for key, value in payload.items() if key != 'quickbooks'), 'Other providers unchanged'
        expect(button).to_have_attribute('aria-expanded', 'false')
        button.focus()
        page.keyboard.press('Enter')
        expect(button).to_have_attribute('aria-expanded', 'true')
        # Saving re-renders the real component. Preserve user disclosure state.
        save.click()
        expect(page.locator('[data-credential-threshold-message]')).to_have_text('Thresholds saved.')
        expect(button).to_have_attribute('aria-expanded', 'true')
        expect(qb.locator(DETAIL)).to_be_visible()
        assert len(state['saves']) == 2, 'Second intercepted save'
        geometry(page)
        panel.screenshot(path=str(out / f'{browser_name}-{width}-{theme}-expanded.png'), animations='disabled', timeout=15000)
        qb.locator('[data-credential-threshold-red]').fill('100')
        save.click()
        expect(page.locator('[data-credential-threshold-message]')).to_contain_text('Red threshold must be lower')
        assert len(state['saves']) == 2, 'Invalid threshold never submitted'
        qb.locator('[data-credential-threshold-red]').fill('94')

        state['variant'] = 'escalated'
        save.click()
        expect(page.locator('[data-credential-threshold-message]')).to_have_text('Thresholds saved.')
        expect(page.locator('[data-credential-provider="github"]')).to_have_attribute('data-credential-severity', 'red')
        order = page.locator(CARD).evaluate_all('els=>els.map(el=>el.dataset.credentialProvider)')
        assert order[:3] == ['github', 'resend', 'microsoft-graph'], 'Critical, warning, building, then healthy'
        for key in ['github', 'resend', 'microsoft-graph']:
            row = page.locator(f'[data-credential-provider="{key}"]')
            expect(row.locator(DETAIL)).to_be_visible()
            expect(row.locator(TOGGLE)).to_have_count(0)
        geometry(page)
        state['variant'] = 'empty'
        save.click()
        expect(page.locator('[data-credential-threshold-message]')).to_have_text('Thresholds saved.')
        expect(page.locator(CARD)).to_have_count(0)
        expect(page.locator('[data-credential-reliability-grid]')).to_contain_text('will appear after the first hourly')
        assert not actionable_page_errors(page_errors, base_url), 'Application JavaScript errors remain blocking'
        return {'browser': browser_name, 'width': width, 'height': height, 'theme': theme,
                'passed': True, 'geometry': first_geometry, 'screenshot': screenshot,
                'syntheticOnly': True, 'interceptedSaves': len(state['saves'])}
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--browser', choices=['chromium', 'webkit'], required=True)
    parser.add_argument('--base-url', default='http://127.0.0.1:4180')
    parser.add_argument('--out', default='visual-results/credential-reliability')
    args = parser.parse_args()
    out = ROOT / args.out / args.browser
    out.mkdir(parents=True, exist_ok=True)
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    expected = os.environ.get('KOA_PR_HEAD_SHA') or os.environ.get('GITHUB_SHA')
    assert not expected or expected == sha, 'Browser QA checkout must equal expected commit SHA'
    results = []
    failed = False
    with sync_playwright() as playwright:
        browser = getattr(playwright, args.browser).launch()
        try:
            for width, height in VIEWPORTS:
                for theme in ['light', 'dark']:
                    try:
                        row = run_case(browser, args.browser, args.base_url.rstrip('/'), width, height, theme, out)
                        print(f'PASS | credential reliability | {args.browser} {width}x{height} {theme}')
                    except Exception as error:
                        failed = True
                        # Only controlled fixture assertion diagnostics; never response bodies.
                        row = {'browser': args.browser, 'width': width, 'theme': theme,
                               'passed': False, 'errorType': type(error).__name__, 'detail': str(error)[:1600], 'syntheticOnly': True}
                        print(f'FAIL | credential reliability | {args.browser} {width}x{height} {theme} | {type(error).__name__}: {str(error)[:1600]}')
                    results.append(row)
        finally:
            browser.close()
    report = {'sha': sha, 'baseUrl': args.base_url, 'syntheticOnly': True,
              'browser': args.browser, 'passed': sum(row['passed'] for row in results),
              'failed': sum(not row['passed'] for row in results), 'cases': results,
              'controllerSha256': hashlib.sha256((ROOT / 'public/credential-reliability-cards.js').read_bytes()).hexdigest()}
    (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    raise SystemExit(1 if failed else 0)

if __name__ == '__main__':
    main()
