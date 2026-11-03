import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeFirstTouch, buildLeadOriginSnapshot } from '../netlify/functions/_shared/lead-provenance.mjs';

const code = readFileSync(new URL('../public/scripts/koa-first-touch.js', import.meta.url), 'utf8');
const persisted = new Map();
const storage = {
  getItem(key) { return persisted.get(key) ?? null; },
  setItem(key, value) { persisted.set(key, String(value)); },
  removeItem(key) { persisted.delete(key); },
};
function visit(href, referrer = '', navigator = {}, withStorage = storage) {
  const location = new URL(href);
  const window = { location, document: { referrer }, navigator, sessionStorage: withStorage };
  vm.runInNewContext(code, { window, URL, Date, JSON });
  return window.KoaFirstTouch?.get() ?? null;
}
const landing = visit(
  'https://koasevents.com/gallery/?utm_source=instagram&utm_medium=social&utm_campaign=aloha_2026&utm_content=flower&private_token=should-not-be-saved',
  'https://www.instagram.com/reel/?private_token=not-retained',
);
assert.equal(landing.entryPage, '/gallery/');
assert.equal(landing.referringHost, 'www.instagram.com');
assert.equal(landing.utmSource, 'instagram');
assert.equal(landing.utmCampaign, 'aloha_2026');
assert.equal(landing.utmMedium, 'social');
assert.equal(landing.schemaVersion, 1);
assert.equal(JSON.stringify(landing).includes('private_token'), false);
assert.equal(JSON.stringify(landing).includes('/reel/'), false);
const next = visit('https://koasevents.com/inquire/?utm_source=paid&utm_campaign=override', 'https://koasevents.com/gallery/');
assert.deepEqual(JSON.parse(JSON.stringify(next)), JSON.parse(JSON.stringify(landing)));
assert.equal(next.utmSource, 'instagram');
const nextStay = visit('https://koasevents.com/stay/', 'https://koasevents.com/inquire/');
assert.equal(nextStay.entryPage, '/gallery/');
const server = normalizeFirstTouch(next, Date.now());
assert.equal(server.entryPage, '/gallery/');
assert.equal(server.referringHost, 'www.instagram.com');
assert.equal(server.utmCampaign, 'aloha_2026');
const submitted = buildLeadOriginSnapshot({
  createdAt: new Date().toISOString(),
  source: 'koa-event-inquiry',
  customer: { eventDate: '2027-04-05' },
  inquiry: { formName: 'koa-event-inquiry', eventType: 'Wedding' },
}, { firstTouch: next, attribution: { pagePath: '/inquire/', utmSource: 'last-click' } });
assert.equal(submitted.firstTouch?.entryPage, '/gallery/');
assert.equal(submitted.firstTouch?.utmSource, 'instagram');
assert.equal(submitted.attribution.utmSource, 'last-click');
assert.equal(buildLeadOriginSnapshot({source:'crm-manual-entry',inquiry:{}},{mode:'manual',firstTouch:next}).firstTouch,null);

assert.equal(normalizeFirstTouch({...next,entryPage:'/admin/crm/'}, Date.now()),null);
assert.equal(normalizeFirstTouch({...next,capturedAt:'2020-01-01T00:00:00.000Z'},Date.now()),null);
assert.equal(normalizeFirstTouch({...next,capturedAt:new Date(Date.now()+4*60*60*1000).toISOString()},Date.now()),null);
assert.equal(normalizeFirstTouch({...next,referringHost:'evil.com/path?password=123'},Date.now())?.referringHost,'');
assert.equal(visit('https://koasevents.com/weddings/?utm_source=unapproved', '', {globalPrivacyControl:true}),null);
assert.equal(persisted.size,0);
const reenabled = visit('https://koasevents.com/about/', '');
assert.equal(reenabled.entryPage, '/about/');
persisted.set('koa-first-touch-v1','not-json');
assert.equal(visit('https://koasevents.com/photo-booth/', '').entryPage,'/photo-booth/');
const blockedStorage = {getItem(){throw Error('disabled')},setItem(){throw Error('disabled')},removeItem(){}};
assert.equal(visit('https://koasevents.com/inquire/?utm_source=direct', '', {},blockedStorage).utmSource,'direct');
assert.equal(visit('https://koasevents.com/admin/crm/', '', {},blockedStorage),null);

const paths=[
  'src/pages/inquire/index.astro',
  'src/pages/wedding-inquiry/index.astro',
  'src/pages/photo-booth/inquire/index.astro',
  'src/pages/stay/index.astro'
];
for(const path of paths) {
  const source=readFileSync(new URL('../'+path,import.meta.url),'utf8');
  assert.match(source,/firstTouch:\s*window\.KoaFirstTouch\?\.get\?\.\(\)/);
}
assert.match(readFileSync(new URL('../src/layouts/BaseLayout.astro',import.meta.url),'utf8'),/koa-first-touch\.js/);
console.log('PASS | first-touch persists across public routes, expires after session/TTL, honors privacy control, and is stored separately in CRM');
