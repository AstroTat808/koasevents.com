/* Koa public-photo crop checks. No admin payloads, images, or customer data are uploaded.
 * Audits the actual public DOM in same-origin offscreen frames against saved
 * Gallery Admin focal points. This is browser evidence, not release certification.
 */
(() => {
  'use strict';

  const root = document.querySelector('[data-gallery-crop-health]');
  if (!root) return;
  const app = root.closest('[data-app]');
  const by = (key) => root.querySelector('[data-gallery-crop-' + key + ']');
  const status = by('status');
  const summary = by('summary');
  const progress = by('progress');
  const results = by('results');
  const runButton = by('run');
  const fullButton = by('full');
  const frameHost = by('frames');
  const lastCheck = by('checked-at');
  const raw = document.getElementById('koa-gallery-crop-health-placements')?.textContent || '[]';

  let placements = [];
  try {
    placements = JSON.parse(raw);
    if (!Array.isArray(placements)) throw new Error('Invalid crop placement manifest');
  } catch {
    status.textContent = 'Cannot check';
    summary.textContent = 'The built public placement inventory is missing or invalid.';
    return;
  }

  const routes = new Map();
  for (const record of placements) {
    const href = String(record?.href || '');
    if (!/^\/(?:[a-z0-9_-]+\/)*$/i.test(href) || href.startsWith('/admin/')) continue;
    if (!record?.src || !record?.placementId) continue;
    if (!routes.has(href)) routes.set(href, []);
    routes.get(href).push(record);
  }

  let running = false;
  let rerunRequested = false;
  let hasRun = false;
  const maxIssues = 18;

  const clamp = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 50;
  };

  const normalize = (rawSource, pageUrl = location.href) => {
    if (!rawSource) return '';
    try {
      const url = new URL(rawSource, pageUrl);
      if (url.origin !== location.origin) return '';
      if (url.pathname === '/.netlify/images') {
        const original = url.searchParams.get('url');
        return original ? new URL(original, pageUrl).pathname : '';
      }
      return url.pathname;
    } catch {
      return String(rawSource).split('?')[0].split('#')[0];
    }
  };

  const sameSource = (node, source, pageUrl) => {
    const attr = node.getAttribute('data-koa-focal-src')
      || node.getAttribute('src')
      || ((node?.tagName === 'IMG') ? node.currentSrc : '');
    return normalize(attr, pageUrl) === source;
  };

  const expectedFocal = (gallery, src, placementId) => {
    const override = gallery.placementCrops?.[src]?.[placementId];
    if (override && typeof override === 'object') {
      return { x: clamp(override.focalX), y: clamp(override.focalY), override: true };
    }
    const edit = gallery.curatedEdits?.[src]
      || (Array.isArray(gallery.uploads) ? gallery.uploads.find(item => item?.src === src) : null);
    if (!edit || (edit.focalX == null && edit.focalY == null)) return null;
    return { x: clamp(edit.focalX), y: clamp(edit.focalY), override: false };
  };

  const hasDestructiveCdnCrop = (image, pageUrl) => {
    if (!((image?.tagName === 'IMG'))) return false;
    const urls = [image.getAttribute('src') || '',
      ...(image.getAttribute('srcset') || '').split(',').map(item => item.trim().split(/\s+/)[0])];
    return urls.some((candidate) => {
      if (!candidate) return false;
      try {
        const url = new URL(candidate, pageUrl);
        return url.pathname === '/.netlify/images' && url.searchParams.has('h');
      } catch { return false; }
    });
  };

  const issue = (code, entry, detail = '') => ({
    code,
    route: entry.href,
    section: String(entry.section || ''),
    placement: String(entry.placementId || ''),
    image: String(entry.src || '').split('/').pop(),
    detail,
  });

  const inspectDocument = (childWindow, entries, gallery) => {
    const doc = childWindow.document;
    const pageUrl = childWindow.document.baseURI || childWindow.location.href;
    const nodes = [...doc.querySelectorAll(
      'img[src], img[data-koa-focal-src], [data-koa-focal-src]:not(img)'
    )];
    const failures = [];
    let checked = 0;
    for (const entry of entries) {
      const src = normalize(entry.src, pageUrl);
      const matches = nodes.filter(node => sameSource(node, src, pageUrl));
      const element = matches[Number(entry.occurrence || 0)];
      checked++;
      if (!element) {
        failures.push(issue('CROP_PLACEMENT_MISSING', entry));
        continue;
      }
      if (hasDestructiveCdnCrop(element, pageUrl)) {
        failures.push(issue('CROP_CDN_TRUNCATION', entry));
      }
      const saved = expectedFocal(gallery, src, entry.placementId);
      if (!saved) continue;
      const actual = (element?.tagName === 'IMG')
        ? childWindow.getComputedStyle(element).objectPosition
        : childWindow.getComputedStyle(element).backgroundPosition;
      const expected = saved.x + '% ' + saved.y + '%';
      if (actual !== expected) {
        failures.push(issue('CROP_POSITION_MISMATCH', entry, expected + ' vs ' + actual));
      }
      if (saved.override && element.dataset.koaPlacementCropApplied !== entry.placementId) {
        failures.push(issue('CROP_OVERRIDE_NOT_APPLIED', entry));
      }
    }
    return { failures, checked };
  };

  // Testable, read-only validator; never exposes private health or customer data.
  window.__koaGalleryCropHealthInspect = inspectDocument;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function awaitFrame(frame, href) {
    const url = href + (href.includes('?') ? '&' : '?') +
      'koa-crop-health=1&v=' + Date.now();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out loading public page')), 16000);
      frame.onload = () => { clearTimeout(timeout); resolve(); };
      frame.onerror = () => { clearTimeout(timeout); reject(new Error('Public page failed')); };
      frame.src = url;
    });
    const started = Date.now();
    while (Date.now() - started < 12000) {
      try {
        if (frame.contentWindow?.__koaGalleryCropHydrated === true) {
          await sleep(150);
          return;
        }
      } catch { /* A failed same-origin frame is handled below. */ }
      await sleep(140);
    }
    throw new Error('Gallery crop data did not hydrate on the public page');
  }

  const setStatus = (kind, message) => {
    status.textContent = message;
    status.dataset.state = kind;
    const tones = {
      idle: 'bg-slate-100 text-slate-700',
      running: 'bg-amber-100 text-amber-800',
      passed: 'bg-emerald-100 text-emerald-800',
      failed: 'bg-red-100 text-red-800',
      unknown: 'bg-amber-100 text-amber-800',
    };
    status.className = 'rounded-full px-3 py-2 text-[.58rem] font-black uppercase tracking-[.08em] ' +
      (tones[kind] || tones.unknown);
  };

  const displayFailures = (failures) => {
    results.replaceChildren();
    if (!failures.length) {
      const paragraph = document.createElement('p');
      paragraph.className = 'text-sm text-[var(--koa-ink)]/55';
      paragraph.textContent = 'No crop mismatches detected in the tested public pages.';
      results.append(paragraph);
      return;
    }
    const list = document.createElement('ol');
    list.className = 'grid gap-2';
    for (const failure of failures.slice(0, maxIssues)) {
      const item = document.createElement('li');
      item.className = 'rounded-xl border border-red-100 bg-red-50 p-3 text-xs leading-5';
      const heading = document.createElement('strong');
      heading.className = 'block break-all font-black text-red-900';
      heading.textContent = failure.code + ' · ' + failure.route;
      const body = document.createElement('span');
      body.className = 'block break-words text-red-800/80';
      body.textContent = [failure.section, failure.image, failure.detail].filter(Boolean).join(' · ');
      item.append(heading, body);
      list.append(item);
    }
    results.append(list);
    if (failures.length > maxIssues) {
      const remainder = document.createElement('p');
      remainder.className = 'mt-2 text-xs font-semibold text-red-800';
      remainder.textContent = (failures.length - maxIssues) +
        ' additional mismatches detected; use the complete CI report for full coverage.';
      results.append(remainder);
    }
  };

  async function runAudit(allPublicRoutes = false) {
    if (running || !app || app.classList.contains('hidden')) {
      if (running) rerunRequested = true;
      return;
    }
    running = true;
    runButton.disabled = true;
    fullButton.disabled = true;
    results.replaceChildren();
    setStatus('running', 'Checking');
    progress.textContent = 'Reading current saved Gallery Admin crops…';
    const failures = [];
    let checked = 0;
    let completed = 0;
    let total = 0;
    try {
      const response = await fetch('/api/gallery', {
        cache: 'no-store', headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Saved Gallery Admin crop data unavailable');
      const gallery = await response.json();
      if (!gallery || typeof gallery !== 'object') throw new Error('Invalid crop data');
      const selectedRoutes = [...routes.entries()].filter(([, records]) =>
        allPublicRoutes || records.some(record => record.impact === 'high')
      );
      if (!selectedRoutes.length) throw new Error('No public crop placements registered');
      total = selectedRoutes.length * 2;
      for (const width of [1440, 390]) {
        for (const [href, entries] of selectedRoutes) {
          progress.textContent = 'Checking ' + (completed + 1) + ' of ' + total +
            ' · ' + width + 'px · ' + href;
          const frame = document.createElement('iframe');
          frame.tabIndex = -1;
          frame.setAttribute('aria-hidden', 'true');
          frame.referrerPolicy = 'same-origin';
          frame.style.cssText = 'position:fixed;left:-20000px;top:0;border:0;visibility:hidden;' +
            'pointer-events:none;width:' + width + 'px;height:' +
            (width === 390 ? '844px' : '900px') + ';';
          frameHost.append(frame);
          try {
            await awaitFrame(frame, href);
            const outcome = inspectDocument(frame.contentWindow, entries, gallery);
            checked += outcome.checked;
            for (const failure of outcome.failures) {
              failures.push({ ...failure, viewport: width });
            }
          } catch (error) {
            failures.push({
              code: 'CROP_PAGE_UNVERIFIED', route: href, section: '', placement: '',
              image: '', detail: (error instanceof Error ? error.message : 'Unknown error').slice(0, 120),
              viewport: width,
            });
          } finally {
            frame.remove();
            completed++;
          }
        }
      }
      if (!checked) throw new Error('Zero public image placements were checked');
      displayFailures(failures);
      summary.textContent = completed + ' page/viewport checks · ' + checked +
        ' image placements · ' + failures.length + ' findings';
      setStatus(failures.length ? 'failed' : 'passed', failures.length ? 'Mismatch detected' : 'All matched');
      lastCheck.textContent = 'Last checked ' + new Date().toLocaleString() +
        (allPublicRoutes ? ' · all public pages' : ' · high-impact pages');
    } catch (error) {
      setStatus('unknown', 'Incomplete');
      summary.textContent = error instanceof Error ? error.message : 'Crop audit unavailable';
      progress.textContent = 'The check could not be completed; do not assume crops match.';
      displayFailures(failures);
    } finally {
      running = false;
      runButton.disabled = false;
      fullButton.disabled = false;
      if (completed) progress.textContent = 'Compared actual public-page CSS positions with saved gallery data.';
      if (rerunRequested) {
        rerunRequested = false;
        void runAudit(false);
      }
    }
  }

  runButton?.addEventListener('click', () => void runAudit(false));
  fullButton?.addEventListener('click', () => void runAudit(true));
  document.querySelector('[data-refresh]')?.addEventListener('click', () => void runAudit(false));

  window.addEventListener('storage', event => {
    if (event.key !== 'koa-gallery-crop-changed') return;
    setStatus('unknown', 'Crop changed');
    summary.textContent = 'A Gallery Admin crop changed in another tab; checking live pages…';
    void runAudit(false);
  });

  const autoStart = () => {
    if (hasRun || !app || app.classList.contains('hidden')) return;
    hasRun = true;
    void runAudit(false);
  };
  if (app) new MutationObserver(autoStart).observe(app, { attributes: true, attributeFilter: ['class'] });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoStart, { once: true });
  } else {
    autoStart();
  }
})();
