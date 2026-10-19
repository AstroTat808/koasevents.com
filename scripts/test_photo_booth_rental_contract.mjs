#!/usr/bin/env node
/**
 * Mirror X rental contract regression. Keeps storefront copy, packages and the
 * secured inquiry-to-CRM pipeline in sync without storing customer information.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const exists = (path) => existsSync(new URL('../' + path, import.meta.url));
const packages = read('src/data/photoBooth.ts');
const page = read('src/pages/photo-booth/index.astro');
const inquiry = read('src/pages/inquire/index.astro');
const boothInquiry = read('src/pages/photo-booth/inquire/index.astro');
const crm = read('netlify/functions/crm-inquiries.mts');
const catalog = read('src/data/catalog.ts');
const layout = read('src/layouts/BaseLayout.astro');
const header = read('src/components/Header.astro');
const footer = read('src/components/Footer.astro');
const sitemap = read('src/pages/sitemap.xml.ts');
const homepage = read('src/pages/index.astro');
const rentalCatalogPage = read('src/pages/catalog/index.astro');

assert.equal(exists('public/media/koa/mirror-photo-booth.webp'), true, 'Booth image must exist');

const mirrorManifest = read('src/data/mirrorXPhotos.ts');
const mirrorGallery = read('src/pages/gallery/index.astro');
const mirrorPaths = [...mirrorManifest.matchAll(/src: '(\/media\/koa\/mirror-x-[^']+\.webp)'/g)].map((match) => match[1]);
assert.equal(mirrorPaths.length, 3, 'Mirror X image manifest must list three selected photos');
assert.equal(new Set(mirrorPaths).size, 3, 'Mirror X photo assets may not repeat');
assert.ok(!mirrorPaths.includes('/media/koa/mirror-photo-booth.webp'), 'New Mirror X photos must differ from the hero');
assert.match(page, /const boothImage = availableMirrorXPhotos\[0\] \?\? null/);
assert.match(page, /const extraMomentPhotos = availableMirrorXPhotos\.slice\(1\)/);
assert.match(mirrorGallery, /const mirrorXGalleryPhotos = mirrorXPhotos/);
assert.match(mirrorGallery, /!knownSources\.has\(photo\.src\)/);
assert.match(mirrorGallery, /category: 'Enhancements'/);
const committedMirrorPaths = mirrorPaths.filter((src) => exists('public' + src));
assert.ok(committedMirrorPaths.length === 0 || committedMirrorPaths.length === mirrorPaths.length,
  'Upload the full three-photo Mirror X pack together; partial uploads must fail QA');
if (committedMirrorPaths.length === 0) {
  console.warn('Mirror X image pack is pending: PR #297 must not merge before all three photos land.');
}

assert.match(page, /Foto Master Mirror X/);
assert.match(page, /<Header overlay=\{false\}/);
assert.match(page, /<Footer \/>/);
assert.match(page, /<h1 /);
assert.match(page, /href="#packages"/);
assert.match(page, /href=\{'\/photo-booth\/inquire\/\?package='/);
assert.match(page, /href="\/photo-booth\/inquire\/"/);
assert.match(page, /<details class="mirror-faq/);
assert.match(page, /shadow-/);
assert.doesNotMatch(page, /schema\.org\/InStock/);

for (const [id, hours, price] of [['moment', 2, 795], ['signature', 3, 1095], ['celebration', 4, 1395]]) {
  const expression = new RegExp("id: '" + id + "'[\\s\\S]*?hours: " + hours + ",[\\s\\S]*?price: " + price + ",");
  assert.match(packages, expression, id + ' must have the reviewed package price and duration');
}
assert.match(packages, /Additional service hour/);
assert.match(packages, /LED backdrop upgrade/);

assert.match(inquiry, /name="service" value="photo-booth"/);
assert.match(inquiry, /name="includePhotoBooth"/);
assert.match(inquiry, /name="photoBoothPackage"/);
assert.match(inquiry, /name="photoBoothEventLocation"/);
assert.match(inquiry, /name="photoBoothExtra"/);
assert.match(inquiry, /photoBoothFields\?\.classList\.toggle\('hidden', !photoBoothOn\)/);
assert.match(inquiry, /photoBoothRequested: data\.get\('service'\) === 'photo-booth'/);
assert.match(inquiry, /photoBoothExtras: data\.getAll\('photoBoothExtra'\)/);
assert.match(inquiry, /fetch\('\/api\/crm\/inquiries'/);
assert.match(inquiry, /turnstileToken/);
assert.match(boothInquiry, /name="photoBoothPackage"/);
assert.match(boothInquiry, /name="photoBoothEventLocation"/);
assert.match(boothInquiry, /name="photoBoothExtra"/);
assert.match(boothInquiry, /turnstileToken/);
assert.match(boothInquiry, /fetch\('\/api\/crm\/inquiries'/);
assert.match(boothInquiry, /formName: 'koa-event-inquiry'/);
assert.match(boothInquiry, /photoBoothRequested: true/);

assert.match(crm, /photoBoothRequested: Boolean\(payload\.inquiry\?\.photoBoothRequested\)/);
assert.match(crm, /photoBoothPackage: cleanText\(payload\.inquiry\?\.photoBoothPackage, 80\)/);
assert.match(crm, /photoBoothEventLocation: cleanText\(payload\.inquiry\?\.photoBoothEventLocation, 320\)/);
assert.match(crm, /photoBoothExtras: cleanStringList\(payload\.inquiry\?\.photoBoothExtras, 10, 160\)/);
assert.match(crm, /String\(entry\.inquiry\?\.service \|\| ''\) !== String\(record\.inquiry\.service \|\| ''\)/);
assert.match(crm, /Boolean\(entry\.inquiry\?\.photoBoothRequested\) !== Boolean\(record\.inquiry\.photoBoothRequested\)/);

assert.match(catalog, /name: 'Foto Master Mirror X Photo Booth'/);
assert.match(catalog, /photoBoothPackages\[0\]\.price/);
assert.match(catalog, /includedWith: \['Signature'\]/);
assert.match(header, /href: '\/photo-booth\/'/);
assert.match(footer, /href="\/photo-booth\/"/);
assert.match(sitemap, /path: '\/photo-booth\/'/);
assert.match(layout, /'\/photo-booth\/': \{/);
assert.match(layout, /photoBoothPackages\.map\(\(pkg\)/);

assert.match(homepage, /New · Foto Master Mirror X/);
assert.match(homepage, /href="\/photo-booth\/"/);
assert.match(rentalCatalogPage, /item\.id === 'photo-booth'/);
console.log('Mirror X packages, accessible site route, SEO and secure CRM inquiry contract: PASS');
