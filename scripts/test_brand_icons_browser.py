#!/usr/bin/env python3
"""Verify Koa's favicon and opaque iPhone icon in Chromium + WebKit, light + dark."""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--base-url', default='http://127.0.0.1:4173')
parser.add_argument('--output', default='visual-results/brand-icons')
args = parser.parse_args()
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)
checks = []
JS_CHECK = """async (url) => {
  const response = await fetch(url, {cache:'no-store'});
  if (!response.ok) throw new Error(url + ': HTTP ' + response.status);
  const image = new Image(); image.src = url; await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d', {willReadFrequently: true});
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let dark = 0;
  for (let i = 0; i < pixels.length; i += 4)
    if (pixels[i]<160 && pixels[i+1]<160 && pixels[i+2]<160) dark++;
  return {width:image.naturalWidth, height:image.naturalHeight,
          corner:[...pixels.slice(0,4)], darkPixels:dark};
}"""

with sync_playwright() as playwright:
    for engine in ('chromium','webkit'):
        browser = getattr(playwright, engine).launch(headless=True)
        for mode in ('light','dark'):
            context = browser.new_context(viewport={'width':390,'height':844},
                                          device_scale_factor=2, color_scheme=mode)
            page = context.new_page()
            response = page.goto(args.base_url.rstrip('/')+'/', wait_until='domcontentloaded', timeout=45000)
            assert response and response.ok, (engine, mode, 'homepage')
            svg = page.locator('head link[rel="icon"][type="image/svg+xml"]').get_attribute('href')
            png = page.locator('head link[rel="icon"][type="image/png"]').get_attribute('href')
            apple = page.locator('head link[rel="apple-touch-icon"]').get_attribute('href')
            assert (svg,png,apple) == ('/brand/koa-navbar-favicon.svg',
                                        '/brand/koa-navbar-favicon-32.png',
                                        '/apple-touch-icon.png'), (svg,png,apple)
            page.evaluate('(mode) => document.documentElement.dataset.theme=mode',mode)
            for url,size,opaque in ((svg,128,False),(png,32,True),(apple,180,True)):
                result = page.evaluate(JS_CHECK,url)
                assert (result['width'],result['height']) == (size,size),(engine,mode,url,result)
                assert result['darkPixels'] > size*size*.02,(engine,mode,url,'brand mark missing')
                if opaque:
                    assert min(result['corner'][:3]) > 225 and result['corner'][3] == 255,(engine,mode,url,result)
                checks.append({'engine':engine,'theme':mode,'asset':url,'size':size,'result':result})
            # The footer must use the exact navbar emblem and light medallion,
            # regardless of color theme and viewport width.
            for viewport_name, viewport in (
                ('iphone', {'width':390,'height':844}),
                ('desktop', {'width':1440,'height':900}),
            ):
                page.set_viewport_size(viewport)
                page.evaluate('(theme) => document.documentElement.dataset.theme = theme', mode)
                footer_logo = page.locator('[data-footer-brand-medallion]')
                footer_logo.wait_for(state='visible')
                footer_logo.locator('img').evaluate('(img) => img.decode()')
                identity = page.evaluate("""() => {
                    const footer = document.querySelector('[data-footer-brand-medallion]');
                    const navbar = document.querySelector('.site-brand .brand-medallion');
                    if (!footer || !navbar) return null;
                    return {
                        footerImage: footer.querySelector('img')?.getAttribute('src'),
                        navbarImage: navbar.querySelector('img')?.getAttribute('src'),
                        footerBackground: getComputedStyle(footer).backgroundImage,
                        navbarBackground: getComputedStyle(navbar).backgroundImage,
                    };
                }""")
                assert identity is not None, (engine, mode, viewport_name, 'missing medallion')
                assert identity['footerImage'] == identity['navbarImage'] == '/brand/koa-mark.png', (engine, mode, identity)
                assert 'gradient' in identity['footerBackground'], (engine, mode, identity)
                assert identity['footerBackground'] == identity['navbarBackground'], (engine, mode, identity)
                footer_logo.screenshot(path=str(output/('footer-logo-'+engine+'-'+mode+'-'+viewport_name+'.png')))
                checks.append({'engine':engine,'theme':mode,'viewport':viewport_name,
                               'asset':'footer-logo','result':identity})
            page.set_viewport_size({'width':390,'height':844})
            page.evaluate("""() => {
              const layer = document.createElement('div'); layer.id='brand-icon-proof';
              layer.style.cssText='position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:var(--koa-surface,#ffffff)';
              const image = document.createElement('img'); image.src='/apple-touch-icon.png';
              image.style.cssText='width:180px;height:180px;object-fit:contain';
              layer.appendChild(image); document.body.appendChild(layer);
            }""")
            page.locator('#brand-icon-proof img').wait_for(state='visible')
            page.screenshot(path=str(output/(engine+'-'+mode+'-iphone.png')))
            context.close()
        browser.close()
(output/'results.json').write_text(json.dumps({'checks':checks,'total':len(checks),'passed':True},indent=2))
assert len(checks)==20
print("PASS: Koa's favicon, opaque Apple icon and identical light footer medallion, Chromium/WebKit light/dark + iPhone/desktop, 20 checks")
