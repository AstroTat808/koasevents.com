#!/usr/bin/env node
// CI guard: all Koa's public logo placements retain the fixed light medallion.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SRC = path.join(ROOT, 'src');
const read = (relative) => readFile(path.join(ROOT, relative), 'utf8');
const failures = [];
const verify = (condition, message) => { if (!condition) failures.push(message); };

async function astroFiles(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await astroFiles(absolute));
    else if (entry.isFile() && absolute.endsWith('.astro')) results.push(absolute);
  }
  return results;
}

const [header, footer, css, layout, preview, email, tenant, favicon, iconBuilder] =
  await Promise.all([
    read('src/components/Header.astro'),
    read('src/components/Footer.astro'),
    read('src/styles/global.css'),
    read('src/layouts/BaseLayout.astro'),
    read('src/pages/admin/email-preview/index.astro'),
    read('netlify/functions/_shared/email-brand.ts'),
    read('src/data/tenants/koa-events.ts'),
    read('public/brand/koa-navbar-favicon.svg'),
    read('scripts/generate_brand_icons.mjs'),
  ]);

const logoImage = /<img\b[^>]*\bsrc\s*=\s*["']\/brand\/koa-mark\.png["'][^>]*>/gi;
const wrappedLogo = /<span\b[^>]*\bclass="[^"]*\bbrand-medallion\b[^"]*"[^>]*>\s*<img\b[^>]*\bsrc="\/brand\/koa-mark\.png"[^>]*>/gi;
const placements = [];
for (const absolute of await astroFiles(SRC)) {
  const relative = path.relative(ROOT, absolute).replaceAll(path.sep, '/');
  const markup = await readFile(absolute, 'utf8');
  const logos = [...markup.matchAll(logoImage)].length;
  if (!logos) continue;
  const wrapped = [...markup.matchAll(wrappedLogo)].length;
  placements.push({ relative, logos, wrapped });
  verify(
    relative === 'src/components/Header.astro' || relative === 'src/components/Footer.astro',
    'Unexpected direct Koa emblem in ' + relative + '; use the shared light medallion.'
  );
  verify(wrapped === logos, 'Emblem without light medallion in ' + relative);
}
verify(placements.length === 2, 'Canonical visible brand placements must be shared Header and Footer.');
verify(placements.find(x => x.relative === 'src/components/Header.astro')?.logos === 2,
  'Navbar and mobile menu must each contain one canonical emblem.');
verify(placements.find(x => x.relative === 'src/components/Footer.astro')?.logos === 1,
  'Footer must contain one canonical emblem.');
verify(footer.includes('class="brand-medallion footer-brand-medallion" data-footer-brand-medallion'),
  'Footer must reuse the shared invariant light medallion.');
verify(!/bg-\[var\(--koa-(?:ivory|surface|canvas|sand)\)\]/.test(footer),
  'Footer must not use a background utility recolored by dark mode.');

function cssBlock(selector) {
  const token = selector + ' {';
  const start = css.indexOf(token);
  return start < 0 ? '' : css.slice(start + token.length).split('}', 1)[0];
}
const gradient = 'background: linear-gradient(145deg, #fffdf8, #efe5d2)';
verify(cssBlock('.brand-medallion').includes(gradient),
  'Default navbar/menu/footer medallion must have the fixed light gradient.');
verify(cssBlock('html[data-theme="dark"] .brand-medallion').includes(gradient),
  'Dark Mode navbar/menu/footer medallion must keep the same light gradient.');
verify(!/\.footer-brand-medallion\s*\{[^}]*background\s*:/i.test(footer),
  'Footer sizing rules must never override the shared medallion background.');

verify(layout.includes('href="/brand/koa-navbar-favicon.svg"'), 'Missing canonical SVG favicon.');
verify(layout.includes('href="/brand/koa-navbar-favicon-32.png"'), 'Missing 32px PNG fallback.');
verify(layout.includes('href="/apple-touch-icon.png"'), 'Missing iPhone home-screen icon.');
verify(favicon.includes('fill="url(#ivory)"'), 'SVG favicon has lost the light medallion.');
verify(iconBuilder.includes("faviconSvg.includes('data:image/png;base64,' + logo.toString('base64'))"),
  'Favicon generator must enforce exact canonical mark artwork.');
verify(iconBuilder.includes("flatten({ background: '#fffdf8' })"),
  'Apple and PNG icons must keep opaque ivory corners.');

verify(preview.includes("const logo=()=>'/brand/koa-mark.png'"),
  'Email preview must use the canonical image.');
verify(preview.includes('background:#fbf8f2;border-radius:'),
  'Email preview must explicitly back its logo with ivory.');
verify(email.includes('bgcolor="#fbf8f2"') && email.includes('background-color:#fbf8f2'),
  'Outbound email logo header needs a light inline background.');
verify(email.includes("return 'cid:' + EMAIL_LOGO_CONTENT_ID"),
  'Outbound email emblem must remain CID-embedded for mail clients.');
verify(tenant.includes("logoPath: '/brand/koa-mark.png'"),
  'Koa tenant identity must retain the canonical mark.');

if (failures.length) {
  for (const failure of failures) console.error('FAIL | ' + failure);
  process.exitCode = 1;
} else {
  console.log('PASS | Shared navbar, mobile menu, and footer: canonical mark with white/ivory medallion.');
  console.log('PASS | Light/Dark themes, favicon, Apple icon, email preview, email header, tenant identity.');
  console.log('PASS | Every new literal public logo image must use the theme-invariant light medallion.');
}
